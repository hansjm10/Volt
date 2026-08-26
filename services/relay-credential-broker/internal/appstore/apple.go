package appstore

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maximumStatusResponseBytes = 64 * 1024

type AppleConfig struct {
	RootCertificates     []*x509.Certificate
	SigningPrivateKeyPEM string
	KeyID                string
	IssuerID             string
	BundleID             string
	AppAppleID           int64
	SubscriptionGroupID  string
	ProductIDs           []string
	AllowedEnvironments  []string
	HTTPClient           *http.Client
	ProductionBaseURL    string
	SandboxBaseURL       string
	Now                  func() time.Time
}

type AppleVerifier struct {
	signedData          *signedDataVerifier
	privateKey          *ecdsa.PrivateKey
	keyID               string
	issuerID            string
	bundleID            string
	appAppleID          int64
	subscriptionGroupID string
	productIDs          map[string]bool
	httpClient          *http.Client
	productionBaseURL   string
	sandboxBaseURL      string
	now                 func() time.Time
}

type statusResponse struct {
	Environment string `json:"environment"`
	BundleID    string `json:"bundleId"`
	AppAppleID  int64  `json:"appAppleId"`
	Data        []struct {
		SubscriptionGroupID string `json:"subscriptionGroupIdentifier"`
		LastTransactions    []struct {
			Status                int    `json:"status"`
			OriginalTransactionID string `json:"originalTransactionId"`
			SignedTransactionInfo string `json:"signedTransactionInfo"`
			SignedRenewalInfo     string `json:"signedRenewalInfo"`
		} `json:"lastTransactions"`
	} `json:"data"`
}

func NewAppleVerifier(config AppleConfig) (*AppleVerifier, error) {
	if strings.TrimSpace(config.KeyID) == "" || strings.TrimSpace(config.IssuerID) == "" ||
		strings.TrimSpace(config.SubscriptionGroupID) == "" || len(config.ProductIDs) == 0 {
		return nil, errors.New("App Store API authority is incomplete")
	}
	privateKey, err := parsePrivateKey(config.SigningPrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	signedData, err := newSignedDataVerifier(
		config.RootCertificates,
		config.BundleID,
		config.AppAppleID,
		config.AllowedEnvironments,
		config.Now,
	)
	if err != nil {
		return nil, err
	}
	products := make(map[string]bool, len(config.ProductIDs))
	for _, productID := range config.ProductIDs {
		productID = strings.TrimSpace(productID)
		if !productIDPattern.MatchString(productID) {
			return nil, fmt.Errorf("invalid App Store product ID %q", productID)
		}
		products[productID] = true
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 10 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	productionBaseURL := strings.TrimRight(config.ProductionBaseURL, "/")
	if productionBaseURL == "" {
		productionBaseURL = "https://api.storekit.apple.com"
	}
	sandboxBaseURL := strings.TrimRight(config.SandboxBaseURL, "/")
	if sandboxBaseURL == "" {
		sandboxBaseURL = "https://api.storekit-sandbox.apple.com"
	}
	return &AppleVerifier{
		signedData:          signedData,
		privateKey:          privateKey,
		keyID:               strings.TrimSpace(config.KeyID),
		issuerID:            strings.TrimSpace(config.IssuerID),
		bundleID:            config.BundleID,
		appAppleID:          config.AppAppleID,
		subscriptionGroupID: strings.TrimSpace(config.SubscriptionGroupID),
		productIDs:          products,
		httpClient:          httpClient,
		productionBaseURL:   productionBaseURL,
		sandboxBaseURL:      sandboxBaseURL,
		now:                 config.Now,
	}, nil
}

func (v *AppleVerifier) VerifyEntitlement(
	ctx context.Context,
	proof Proof,
) (Entitlement, error) {
	verificationStartedAt := v.now().UTC()
	appTransaction, proofHash, err := v.signedData.verifyAppTransaction(
		proof.SignedAppTransaction,
		proof.DeviceVerificationID,
	)
	if err != nil {
		return Entitlement{}, err
	}
	entitlement, err := v.resolveEntitlement(
		ctx,
		appTransaction.AppTransactionID,
		appTransaction.ReceiptType,
		verificationStartedAt,
	)
	if err != nil {
		return Entitlement{}, err
	}
	entitlement.ApprovalProofHash = proofHash
	entitlement.ProofCreatedAt = time.UnixMilli(
		appTransaction.ReceiptCreationDate,
	).UTC()
	return entitlement, nil
}

func (v *AppleVerifier) ReconcileEntitlement(
	ctx context.Context,
	appTransactionID string,
	environment string,
) (Entitlement, error) {
	return v.resolveEntitlement(
		ctx,
		appTransactionID,
		environment,
		v.now().UTC(),
	)
}

func (v *AppleVerifier) VerifyNotification(
	ctx context.Context,
	signedPayload string,
) (Notification, error) {
	verificationStartedAt := v.now().UTC()
	envelope, transaction, err := v.signedData.verifyNotificationEnvelope(
		signedPayload,
	)
	if err != nil {
		return Notification{}, err
	}
	if envelope.NotificationType == "TEST" {
		return Notification{
			UUID: envelope.NotificationUUID,
			Test: true,
		}, nil
	}
	entitlement, err := v.resolveEntitlement(
		ctx,
		transaction.AppTransactionID,
		envelope.Data.Environment,
		verificationStartedAt,
	)
	if err != nil {
		return Notification{}, err
	}
	return Notification{UUID: envelope.NotificationUUID, Entitlement: entitlement}, nil
}

func (v *AppleVerifier) resolveEntitlement(
	ctx context.Context,
	appTransactionID string,
	environment string,
	verificationStartedAt time.Time,
) (Entitlement, error) {
	response, err := v.fetchSubscriptionStatus(ctx, appTransactionID, environment)
	if err != nil {
		return Entitlement{}, err
	}
	if response.BundleID != v.bundleID ||
		(environment == "Production" && response.AppAppleID != v.appAppleID) ||
		(response.AppAppleID != 0 && response.AppAppleID != v.appAppleID) {
		return Entitlement{}, ErrAppIdentifierInvalid
	}
	if response.Environment != environment || !v.signedData.allowedEnvironments[environment] {
		return Entitlement{}, ErrEnvironmentInvalid
	}

	var selected *Entitlement
	for _, group := range response.Data {
		if group.SubscriptionGroupID != v.subscriptionGroupID {
			continue
		}
		for _, latest := range group.LastTransactions {
			transaction, err := v.signedData.verifyTransaction(
				latest.SignedTransactionInfo,
				environment,
			)
			if err != nil {
				return Entitlement{}, err
			}
			if transaction.AppTransactionID != appTransactionID ||
				transaction.SubscriptionGroupID != v.subscriptionGroupID ||
				!v.productIDs[transaction.ProductID] ||
				transaction.InAppOwnershipType != "PURCHASED" {
				continue
			}
			candidate, err := v.entitlementFromStatus(
				latest.Status,
				transaction,
				latest.SignedRenewalInfo,
				environment,
			)
			if err != nil {
				return Entitlement{}, err
			}
			if selected == nil || entitlementIsNewer(candidate, *selected) {
				copy := candidate
				selected = &copy
			}
		}
	}
	if selected == nil {
		return Entitlement{
			AppTransactionID: appTransactionID,
			Environment:      environment,
			Status:           StatusInactive,
			SourceSignedAt:   verificationStartedAt,
			VerifiedAt:       verificationStartedAt,
		}, nil
	}
	selected.VerifiedAt = verificationStartedAt
	return *selected, nil
}

func (v *AppleVerifier) entitlementFromStatus(
	rawStatus int,
	transaction transactionPayload,
	signedRenewalInfo string,
	environment string,
) (Entitlement, error) {
	signedAt, ok := millisecondsDate(transaction.SignedDate)
	if !ok {
		return Entitlement{}, ErrProofInvalid
	}
	entitlement := Entitlement{
		AppTransactionID:    transaction.AppTransactionID,
		Environment:         environment,
		ProductID:           transaction.ProductID,
		SubscriptionGroupID: transaction.SubscriptionGroupID,
		SourceSignedAt:      signedAt,
	}
	switch rawStatus {
	case 1:
		entitlement.Status = StatusActive
		expiry, valid := millisecondsDate(transaction.ExpiresDate)
		if !valid || transaction.RevocationDate != 0 || transaction.IsUpgraded {
			entitlement.Status = StatusInactive
			return entitlement, nil
		}
		entitlement.EntitledUntil = expiry
	case 2:
		entitlement.Status = StatusExpired
	case 3:
		entitlement.Status = StatusBillingRetry
	case 4:
		entitlement.Status = StatusGrace
		if signedRenewalInfo == "" {
			return Entitlement{}, ErrProofInvalid
		}
		renewal, err := v.signedData.verifyRenewal(signedRenewalInfo, environment)
		if err != nil {
			return Entitlement{}, err
		}
		if renewal.AppTransactionID != transaction.AppTransactionID ||
			renewal.AutoRenewProductID != transaction.ProductID {
			return Entitlement{}, ErrProofInvalid
		}
		graceExpiry, valid := millisecondsDate(renewal.GracePeriodExpiresDate)
		if !valid {
			return Entitlement{}, ErrProofInvalid
		}
		entitlement.EntitledUntil = graceExpiry
		if renewalDate, valid := millisecondsDate(renewal.SignedDate); valid && renewalDate.After(entitlement.SourceSignedAt) {
			entitlement.SourceSignedAt = renewalDate
		}
	case 5:
		entitlement.Status = StatusRevoked
	default:
		entitlement.Status = StatusInactive
	}
	return entitlement, nil
}

func entitlementIsNewer(candidate, current Entitlement) bool {
	candidateActive := candidate.Status == StatusActive || candidate.Status == StatusGrace
	currentActive := current.Status == StatusActive || current.Status == StatusGrace
	if candidateActive != currentActive {
		return candidateActive
	}
	if candidate.SourceSignedAt.Equal(current.SourceSignedAt) {
		return candidate.EntitledUntil.After(current.EntitledUntil)
	}
	return candidate.SourceSignedAt.After(current.SourceSignedAt)
}

func (v *AppleVerifier) fetchSubscriptionStatus(
	ctx context.Context,
	appTransactionID string,
	environment string,
) (statusResponse, error) {
	if !identifierPattern.MatchString(appTransactionID) {
		return statusResponse{}, ErrProofInvalid
	}
	baseURL := v.productionBaseURL
	if environment == "Sandbox" {
		baseURL = v.sandboxBaseURL
	} else if environment != "Production" {
		return statusResponse{}, ErrEnvironmentInvalid
	}
	token, err := v.authorizationToken()
	if err != nil {
		return statusResponse{}, err
	}
	endpoint := baseURL + "/inApps/v1/subscriptions/" + url.PathEscape(appTransactionID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return statusResponse{}, fmt.Errorf("create App Store status request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := v.httpClient.Do(request)
	if err != nil {
		return statusResponse{}, fmt.Errorf("%w: request App Store status", ErrSubscriptionUnavailable)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumStatusResponseBytes+1))
	if err != nil {
		return statusResponse{}, fmt.Errorf("%w: read App Store status", ErrSubscriptionUnavailable)
	}
	if len(body) > maximumStatusResponseBytes {
		return statusResponse{}, ErrSubscriptionUnavailable
	}
	if response.StatusCode != http.StatusOK ||
		!strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "application/json") {
		return statusResponse{}, ErrSubscriptionUnavailable
	}
	var decoded statusResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return statusResponse{}, ErrSubscriptionUnavailable
	}
	return decoded, nil
}

func (v *AppleVerifier) authorizationToken() (string, error) {
	now := v.now().UTC()
	header := map[string]string{
		"alg": "ES256",
		"kid": v.keyID,
		"typ": "JWT",
	}
	payload := struct {
		Issuer   string `json:"iss"`
		IssuedAt int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Audience string `json:"aud"`
		BundleID string `json:"bid"`
	}{
		Issuer:   v.issuerID,
		IssuedAt: now.Unix(),
		Expires:  now.Add(5 * time.Minute).Unix(),
		Audience: "appstoreconnect-v1",
		BundleID: v.bundleID,
	}
	encodedHeader, err := encodeJSONSegment(header)
	if err != nil {
		return "", err
	}
	encodedPayload, err := encodeJSONSegment(payload)
	if err != nil {
		return "", err
	}
	signingInput := encodedHeader + "." + encodedPayload
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, v.privateKey, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign App Store authorization token: %w", err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func encodeJSONSegment(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func parsePrivateKey(value string) (*ecdsa.PrivateKey, error) {
	block, rest := pem.Decode([]byte(value))
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("App Store signing private key is not one PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse App Store signing private key: %w", err)
	}
	privateKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || privateKey.Curve.Params().Name != "P-256" {
		return nil, errors.New("App Store signing private key must use P-256")
	}
	return privateKey, nil
}
