package appstore

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"
)

var (
	ErrProofInvalid            = errors.New("App Store proof invalid")
	ErrEnvironmentInvalid      = errors.New("App Store environment invalid")
	ErrAppIdentifierInvalid    = errors.New("App Store app identifier invalid")
	ErrDeviceInvalid           = errors.New("App Store device verification invalid")
	ErrSubscriptionInactive    = errors.New("App Store subscription inactive")
	ErrSubscriptionUnavailable = errors.New("App Store subscription status unavailable")
)

var (
	identifierPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	productIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,255}$`)
	uuidPattern          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	appleLeafOID         = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 11, 1}
	appleIntermediateOID = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 2, 1}
)

const maximumSignedDataBytes = 48 * 1024

type Status string

const (
	StatusActive       Status = "active"
	StatusGrace        Status = "grace"
	StatusBillingRetry Status = "billing_retry"
	StatusExpired      Status = "expired"
	StatusRevoked      Status = "revoked"
	StatusInactive     Status = "inactive"
)

type Proof struct {
	SignedAppTransaction string
	DeviceVerificationID string
}

type Entitlement struct {
	AppTransactionID    string
	ApprovalProofHash   [sha256.Size]byte
	ProofCreatedAt      time.Time
	Environment         string
	ProductID           string
	SubscriptionGroupID string
	Status              Status
	EntitledUntil       time.Time
	SourceSignedAt      time.Time
	VerifiedAt          time.Time
}

func (e Entitlement) Active(now time.Time) bool {
	return (e.Status == StatusActive || e.Status == StatusGrace) && now.Before(e.EntitledUntil)
}

type Notification struct {
	UUID        string
	Test        bool
	Entitlement Entitlement
}

type Verifier interface {
	VerifyEntitlement(ctx context.Context, proof Proof) (Entitlement, error)
	ReconcileEntitlement(ctx context.Context, appTransactionID, environment string) (Entitlement, error)
	VerifyNotification(ctx context.Context, signedPayload string) (Notification, error)
}

type signedDataVerifier struct {
	roots               *x509.CertPool
	rootDigests         map[[sha256.Size]byte]struct{}
	bundleID            string
	appAppleID          int64
	allowedEnvironments map[string]bool
	now                 func() time.Time
}

type appTransactionPayload struct {
	ReceiptType             string `json:"receiptType"`
	AppAppleID              int64  `json:"appAppleId"`
	BundleID                string `json:"bundleId"`
	AppTransactionID        string `json:"appTransactionId"`
	DeviceVerification      string `json:"deviceVerification"`
	DeviceVerificationNonce string `json:"deviceVerificationNonce"`
	ReceiptCreationDate     int64  `json:"receiptCreationDate"`
}

type transactionPayload struct {
	AppTransactionID      string `json:"appTransactionId"`
	OriginalTransactionID string `json:"originalTransactionId"`
	TransactionID         string `json:"transactionId"`
	BundleID              string `json:"bundleId"`
	ProductID             string `json:"productId"`
	SubscriptionGroupID   string `json:"subscriptionGroupIdentifier"`
	Environment           string `json:"environment"`
	InAppOwnershipType    string `json:"inAppOwnershipType"`
	ExpiresDate           int64  `json:"expiresDate"`
	RevocationDate        int64  `json:"revocationDate"`
	SignedDate            int64  `json:"signedDate"`
	IsUpgraded            bool   `json:"isUpgraded"`
}

type renewalPayload struct {
	AppTransactionID       string `json:"appTransactionId"`
	OriginalTransactionID  string `json:"originalTransactionId"`
	Environment            string `json:"environment"`
	GracePeriodExpiresDate int64  `json:"gracePeriodExpiresDate"`
	SignedDate             int64  `json:"signedDate"`
}

type notificationPayload struct {
	NotificationType string `json:"notificationType"`
	Subtype          string `json:"subtype"`
	NotificationUUID string `json:"notificationUUID"`
	SignedDate       int64  `json:"signedDate"`
	Data             struct {
		AppAppleID            int64  `json:"appAppleId"`
		BundleID              string `json:"bundleId"`
		Environment           string `json:"environment"`
		Status                int    `json:"status"`
		SignedTransactionInfo string `json:"signedTransactionInfo"`
		SignedRenewalInfo     string `json:"signedRenewalInfo"`
	} `json:"data"`
}

type jwsHeader struct {
	Algorithm string   `json:"alg"`
	Chain     []string `json:"x5c"`
}

func newSignedDataVerifier(
	roots []*x509.Certificate,
	bundleID string,
	appAppleID int64,
	allowedEnvironments []string,
	now func() time.Time,
) (*signedDataVerifier, error) {
	if len(roots) == 0 || strings.TrimSpace(bundleID) == "" || appAppleID <= 0 {
		return nil, errors.New("App Store verifier authority is incomplete")
	}
	pool := x509.NewCertPool()
	digests := make(map[[sha256.Size]byte]struct{}, len(roots))
	for _, certificate := range roots {
		if certificate == nil || !certificate.IsCA {
			return nil, errors.New("App Store root certificate is invalid")
		}
		pool.AddCert(certificate)
		digests[sha256.Sum256(certificate.Raw)] = struct{}{}
	}
	allowed := make(map[string]bool, len(allowedEnvironments))
	for _, environment := range allowedEnvironments {
		if environment != "Production" && environment != "Sandbox" {
			return nil, fmt.Errorf("unsupported App Store environment %q", environment)
		}
		allowed[environment] = true
	}
	if len(allowed) == 0 {
		return nil, errors.New("at least one App Store environment is required")
	}
	if now == nil {
		now = time.Now
	}
	return &signedDataVerifier{
		roots:               pool,
		rootDigests:         digests,
		bundleID:            bundleID,
		appAppleID:          appAppleID,
		allowedEnvironments: allowed,
		now:                 now,
	}, nil
}

func (v *signedDataVerifier) verifyAppTransaction(
	signed string,
	deviceVerificationID string,
) (appTransactionPayload, [sha256.Size]byte, error) {
	var payload appTransactionPayload
	if err := v.verifySignedData(signed, "receiptCreationDate", &payload); err != nil {
		return appTransactionPayload{}, [sha256.Size]byte{}, err
	}
	if payload.BundleID != v.bundleID || (payload.AppAppleID != 0 && payload.AppAppleID != v.appAppleID) {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrAppIdentifierInvalid
	}
	if !v.allowedEnvironments[payload.ReceiptType] {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrEnvironmentInvalid
	}
	if !identifierPattern.MatchString(payload.AppTransactionID) {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrProofInvalid
	}
	createdAt, ok := millisecondsDate(payload.ReceiptCreationDate)
	if !ok || createdAt.Before(v.now().UTC().Add(-10*time.Minute)) {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrProofInvalid
	}
	deviceID, ok := canonicalUUID(deviceVerificationID)
	if !ok {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrDeviceInvalid
	}
	nonce, ok := canonicalUUID(payload.DeviceVerificationNonce)
	if !ok {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrDeviceInvalid
	}
	verification, err := decodeStandardBase64(payload.DeviceVerification)
	if err != nil || len(verification) != sha512.Size384 {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrDeviceInvalid
	}
	digest := sha512.Sum384([]byte(nonce + deviceID))
	if !equalBytes(verification, digest[:]) {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrDeviceInvalid
	}
	segments := strings.Split(signed, ".")
	payloadBytes, err := decodeBase64URL(segments[1], 32*1024)
	if err != nil {
		return appTransactionPayload{}, [sha256.Size]byte{}, ErrProofInvalid
	}
	return payload, sha256.Sum256(payloadBytes), nil
}

func (v *signedDataVerifier) verifyTransaction(
	signed string,
	environment string,
) (transactionPayload, error) {
	var payload transactionPayload
	if err := v.verifySignedData(signed, "signedDate", &payload); err != nil {
		return transactionPayload{}, err
	}
	if payload.BundleID != v.bundleID {
		return transactionPayload{}, ErrAppIdentifierInvalid
	}
	if payload.Environment != environment || !v.allowedEnvironments[payload.Environment] {
		return transactionPayload{}, ErrEnvironmentInvalid
	}
	if !identifierPattern.MatchString(payload.AppTransactionID) ||
		!identifierPattern.MatchString(payload.TransactionID) ||
		!identifierPattern.MatchString(payload.OriginalTransactionID) {
		return transactionPayload{}, ErrProofInvalid
	}
	return payload, nil
}

func (v *signedDataVerifier) verifyRenewal(
	signed string,
	environment string,
) (renewalPayload, error) {
	var payload renewalPayload
	if err := v.verifySignedData(signed, "signedDate", &payload); err != nil {
		return renewalPayload{}, err
	}
	if payload.Environment != environment || !v.allowedEnvironments[payload.Environment] {
		return renewalPayload{}, ErrEnvironmentInvalid
	}
	if !identifierPattern.MatchString(payload.AppTransactionID) ||
		!identifierPattern.MatchString(payload.OriginalTransactionID) {
		return renewalPayload{}, ErrProofInvalid
	}
	return payload, nil
}

func (v *signedDataVerifier) verifyNotificationEnvelope(
	signed string,
) (notificationPayload, transactionPayload, error) {
	var payload notificationPayload
	if err := v.verifySignedData(signed, "signedDate", &payload); err != nil {
		return notificationPayload{}, transactionPayload{}, err
	}
	if payload.Data.BundleID != v.bundleID ||
		(payload.Data.Environment == "Production" &&
			payload.Data.AppAppleID != v.appAppleID) ||
		(payload.Data.AppAppleID != 0 &&
			payload.Data.AppAppleID != v.appAppleID) {
		return notificationPayload{}, transactionPayload{}, ErrAppIdentifierInvalid
	}
	if !v.allowedEnvironments[payload.Data.Environment] {
		return notificationPayload{}, transactionPayload{}, ErrEnvironmentInvalid
	}
	uuid, ok := canonicalUUID(payload.NotificationUUID)
	if !ok {
		return notificationPayload{}, transactionPayload{}, ErrProofInvalid
	}
	payload.NotificationUUID = uuid
	if payload.NotificationType == "TEST" &&
		payload.Data.SignedTransactionInfo == "" {
		return payload, transactionPayload{}, nil
	}
	if payload.Data.SignedTransactionInfo == "" {
		return notificationPayload{}, transactionPayload{}, ErrProofInvalid
	}
	transaction, err := v.verifyTransaction(
		payload.Data.SignedTransactionInfo,
		payload.Data.Environment,
	)
	if err != nil {
		return notificationPayload{}, transactionPayload{}, err
	}
	return payload, transaction, nil
}

func (v *signedDataVerifier) verifySignedData(
	signed string,
	effectiveDateField string,
	destination any,
) error {
	if len(signed) == 0 || len(signed) > maximumSignedDataBytes {
		return ErrProofInvalid
	}
	segments := strings.Split(signed, ".")
	if len(segments) != 3 {
		return ErrProofInvalid
	}
	headerBytes, err := decodeBase64URL(segments[0], 16*1024)
	if err != nil {
		return ErrProofInvalid
	}
	payloadBytes, err := decodeBase64URL(segments[1], 32*1024)
	if err != nil {
		return ErrProofInvalid
	}
	signature, err := decodeBase64URL(segments[2], 128)
	if err != nil || len(signature) != 64 {
		return ErrProofInvalid
	}
	var header jwsHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil ||
		header.Algorithm != "ES256" || len(header.Chain) != 3 {
		return ErrProofInvalid
	}
	certificates := make([]*x509.Certificate, 0, len(header.Chain))
	for _, encoded := range header.Chain {
		raw, err := decodeStandardBase64(encoded)
		if err != nil || len(raw) > 8*1024 {
			return ErrProofInvalid
		}
		certificate, err := x509.ParseCertificate(raw)
		if err != nil {
			return ErrProofInvalid
		}
		certificates = append(certificates, certificate)
	}
	if _, trusted := v.rootDigests[sha256.Sum256(certificates[2].Raw)]; !trusted {
		return ErrProofInvalid
	}
	if !hasExtension(certificates[0], appleLeafOID) ||
		!hasExtension(certificates[1], appleIntermediateOID) ||
		!certificates[1].IsCA {
		return ErrProofInvalid
	}
	var dates map[string]json.RawMessage
	if err := json.Unmarshal(payloadBytes, &dates); err != nil {
		return ErrProofInvalid
	}
	var milliseconds int64
	if raw := dates[effectiveDateField]; len(raw) == 0 || json.Unmarshal(raw, &milliseconds) != nil {
		return ErrProofInvalid
	}
	effectiveDate, ok := millisecondsDate(milliseconds)
	if !ok || effectiveDate.After(v.now().UTC().Add(time.Minute)) {
		return ErrProofInvalid
	}
	intermediates := x509.NewCertPool()
	intermediates.AddCert(certificates[1])
	if _, err := certificates[0].Verify(x509.VerifyOptions{
		Roots:         v.roots,
		Intermediates: intermediates,
		CurrentTime:   effectiveDate,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		return ErrProofInvalid
	}
	publicKey, ok := certificates[0].PublicKey.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve.Params().Name != "P-256" {
		return ErrProofInvalid
	}
	digest := sha256.Sum256([]byte(segments[0] + "." + segments[1]))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if r.Sign() <= 0 || s.Sign() <= 0 || !ecdsa.Verify(publicKey, digest[:], r, s) {
		return ErrProofInvalid
	}
	if err := json.Unmarshal(payloadBytes, destination); err != nil {
		return ErrProofInvalid
	}
	return nil
}

func decodeBase64URL(value string, maximum int) ([]byte, error) {
	if value == "" || len(value) > maximum*2 {
		return nil, ErrProofInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) > maximum || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, ErrProofInvalid
	}
	return decoded, nil
}

func decodeStandardBase64(value string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err == nil {
		return decoded, nil
	}
	return base64.RawStdEncoding.DecodeString(value)
}

func canonicalUUID(value string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized, uuidPattern.MatchString(normalized)
}

func millisecondsDate(value int64) (time.Time, bool) {
	if value <= 0 {
		return time.Time{}, false
	}
	date := time.UnixMilli(value).UTC()
	if date.Year() < 2000 || date.Year() > 2100 {
		return time.Time{}, false
	}
	return date, true
}

func hasExtension(certificate *x509.Certificate, oid asn1.ObjectIdentifier) bool {
	for _, extension := range certificate.Extensions {
		if extension.Id.Equal(oid) {
			return true
		}
	}
	return false
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var different byte
	for index := range left {
		different |= left[index] ^ right[index]
	}
	return different == 0
}
