package appstore

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testBundleID            = "com.hansjm10.volt"
	testAppAppleID          = int64(1234567890)
	testSubscriptionGroupID = "group-volt-pro"
	testAnnualProductID     = "com.hansjm10.volt.pro.annual"
)

type appleTestAuthority struct {
	rootCertificate *x509.Certificate
	rootDER         []byte
	intermediateDER []byte
	leafDER         []byte
	leafKey         *ecdsa.PrivateKey
	apiKey          *ecdsa.PrivateKey
}

func TestAppleVerifierAcceptsDeviceBoundActiveSubscription(t *testing.T) {
	now := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	authority := newAppleTestAuthority(t, now)
	appTransactionID := "app-transaction-one"
	deviceID := "11111111-1111-4111-8111-111111111111"
	nonce := "22222222-2222-4222-8222-222222222222"
	deviceDigest := sha512.Sum384([]byte(nonce + deviceID))
	appTransaction := authority.sign(t, map[string]any{
		"receiptType":             "Sandbox",
		"appAppleId":              testAppAppleID,
		"bundleId":                testBundleID,
		"appTransactionId":        appTransactionID,
		"deviceVerification":      base64.StdEncoding.EncodeToString(deviceDigest[:]),
		"deviceVerificationNonce": nonce,
		"receiptCreationDate":     now.UnixMilli(),
	})
	transaction := authority.sign(t, map[string]any{
		"appTransactionId":            appTransactionID,
		"originalTransactionId":       "original-one",
		"transactionId":               "transaction-one",
		"bundleId":                    testBundleID,
		"productId":                   testAnnualProductID,
		"subscriptionGroupIdentifier": testSubscriptionGroupID,
		"environment":                 "Sandbox",
		"inAppOwnershipType":          "PURCHASED",
		"expiresDate":                 now.Add(24 * time.Hour).UnixMilli(),
		"signedDate":                  now.UnixMilli(),
	})
	statusServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/inApps/v1/subscriptions/"+appTransactionID {
			t.Fatalf("unexpected App Store status path %q", request.URL.Path)
		}
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
			t.Fatal("missing App Store API authorization")
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"environment": "Sandbox",
			"bundleId":    testBundleID,
			"appAppleId":  testAppAppleID,
			"data": []any{map[string]any{
				"subscriptionGroupIdentifier": testSubscriptionGroupID,
				"lastTransactions": []any{map[string]any{
					"status":                1,
					"originalTransactionId": "original-one",
					"signedTransactionInfo": transaction,
					"signedRenewalInfo":     "",
				}},
			}},
		})
	}))
	defer statusServer.Close()
	verifier := authority.verifier(t, now, statusServer.URL)

	entitlement, err := verifier.VerifyEntitlement(context.Background(), Proof{
		SignedAppTransaction: appTransaction,
		DeviceVerificationID: strings.ToUpper(deviceID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if entitlement.AppTransactionID != appTransactionID ||
		entitlement.Status != StatusActive ||
		!entitlement.EntitledUntil.Equal(now.Add(24*time.Hour)) {
		t.Fatalf("unexpected entitlement: %+v", entitlement)
	}
}

func TestAppleVerifierRejectsProofFromAnotherDevice(t *testing.T) {
	now := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	authority := newAppleTestAuthority(t, now)
	deviceID := "11111111-1111-4111-8111-111111111111"
	nonce := "22222222-2222-4222-8222-222222222222"
	deviceDigest := sha512.Sum384([]byte(nonce + deviceID))
	appTransaction := authority.sign(t, map[string]any{
		"receiptType":             "Sandbox",
		"appAppleId":              testAppAppleID,
		"bundleId":                testBundleID,
		"appTransactionId":        "app-transaction-one",
		"deviceVerification":      base64.StdEncoding.EncodeToString(deviceDigest[:]),
		"deviceVerificationNonce": nonce,
		"receiptCreationDate":     now.UnixMilli(),
	})
	verifier := authority.verifier(t, now, "http://127.0.0.1")

	_, err := verifier.VerifyEntitlement(context.Background(), Proof{
		SignedAppTransaction: appTransaction,
		DeviceVerificationID: "33333333-3333-4333-8333-333333333333",
	})
	if err != ErrDeviceInvalid {
		t.Fatalf("wrong-device error = %v, want %v", err, ErrDeviceInvalid)
	}
}

func TestAppleVerifierRejectsStaleAppTransactionProof(t *testing.T) {
	now := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	authority := newAppleTestAuthority(t, now)
	deviceID := "11111111-1111-4111-8111-111111111111"
	nonce := "22222222-2222-4222-8222-222222222222"
	deviceDigest := sha512.Sum384([]byte(nonce + deviceID))
	appTransaction := authority.sign(t, map[string]any{
		"receiptType":             "Sandbox",
		"appAppleId":              testAppAppleID,
		"bundleId":                testBundleID,
		"appTransactionId":        "app-transaction-stale",
		"deviceVerification":      base64.StdEncoding.EncodeToString(deviceDigest[:]),
		"deviceVerificationNonce": nonce,
		"receiptCreationDate":     now.Add(-11 * time.Minute).UnixMilli(),
	})
	verifier := authority.verifier(t, now, "http://127.0.0.1")

	_, err := verifier.VerifyEntitlement(context.Background(), Proof{
		SignedAppTransaction: appTransaction,
		DeviceVerificationID: deviceID,
	})
	if err != ErrProofInvalid {
		t.Fatalf("stale proof error = %v, want %v", err, ErrProofInvalid)
	}
}

func TestAppleVerifierReconcilesSignedNotification(t *testing.T) {
	now := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	authority := newAppleTestAuthority(t, now)
	appTransactionID := "app-transaction-notification"
	transaction := authority.sign(t, map[string]any{
		"appTransactionId":            appTransactionID,
		"originalTransactionId":       "original-notification",
		"transactionId":               "transaction-notification",
		"bundleId":                    testBundleID,
		"productId":                   testAnnualProductID,
		"subscriptionGroupIdentifier": testSubscriptionGroupID,
		"environment":                 "Sandbox",
		"inAppOwnershipType":          "PURCHASED",
		"expiresDate":                 now.Add(48 * time.Hour).UnixMilli(),
		"signedDate":                  now.UnixMilli(),
	})
	statusServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"environment": "Sandbox",
			"bundleId":    testBundleID,
			"appAppleId":  testAppAppleID,
			"data": []any{map[string]any{
				"subscriptionGroupIdentifier": testSubscriptionGroupID,
				"lastTransactions": []any{map[string]any{
					"status":                1,
					"originalTransactionId": "original-notification",
					"signedTransactionInfo": transaction,
					"signedRenewalInfo":     "",
				}},
			}},
		})
	}))
	defer statusServer.Close()
	verifier := authority.verifier(t, now, statusServer.URL)
	signedNotification := authority.sign(t, map[string]any{
		"notificationType": "DID_RENEW",
		"notificationUUID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"signedDate":       now.UnixMilli(),
		"data": map[string]any{
			"appAppleId":            testAppAppleID,
			"bundleId":              testBundleID,
			"environment":           "Sandbox",
			"status":                1,
			"signedTransactionInfo": transaction,
			"signedRenewalInfo":     "",
		},
	})

	notification, err := verifier.VerifyNotification(
		context.Background(),
		signedNotification,
	)
	if err != nil {
		t.Fatal(err)
	}
	if notification.UUID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" ||
		notification.Entitlement.AppTransactionID != appTransactionID ||
		notification.Entitlement.Status != StatusActive {
		t.Fatalf("unexpected notification: %+v", notification)
	}
}

func TestAppleVerifierAcceptsSignedTestNotification(t *testing.T) {
	now := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	authority := newAppleTestAuthority(t, now)
	verifier := authority.verifier(t, now, "http://127.0.0.1")
	signedNotification := authority.sign(t, map[string]any{
		"notificationType": "TEST",
		"notificationUUID": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		"signedDate":       now.UnixMilli(),
		"data": map[string]any{
			"appAppleId":  testAppAppleID,
			"bundleId":    testBundleID,
			"environment": "Sandbox",
		},
	})

	notification, err := verifier.VerifyNotification(
		context.Background(),
		signedNotification,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !notification.Test || notification.UUID != "cccccccc-cccc-4ccc-8ccc-cccccccccccc" {
		t.Fatalf("unexpected test notification: %+v", notification)
	}
}

func (authority appleTestAuthority) verifier(
	t *testing.T,
	now time.Time,
	sandboxBaseURL string,
) *AppleVerifier {
	t.Helper()
	privateKey, err := x509.MarshalPKCS8PrivateKey(authority.apiKey)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewAppleVerifier(AppleConfig{
		RootCertificates: []*x509.Certificate{authority.rootCertificate},
		SigningPrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{
			Type:  "PRIVATE KEY",
			Bytes: privateKey,
		})),
		KeyID:               "KEY123",
		IssuerID:            "issuer-one",
		BundleID:            testBundleID,
		AppAppleID:          testAppAppleID,
		SubscriptionGroupID: testSubscriptionGroupID,
		ProductIDs:          []string{testAnnualProductID},
		AllowedEnvironments: []string{"Sandbox"},
		SandboxBaseURL:      sandboxBaseURL,
		Now:                 func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return verifier
}

func (authority appleTestAuthority) sign(t *testing.T, payload any) string {
	t.Helper()
	header := map[string]any{
		"alg": "ES256",
		"x5c": []string{
			base64.StdEncoding.EncodeToString(authority.leafDER),
			base64.StdEncoding.EncodeToString(authority.intermediateDER),
			base64.StdEncoding.EncodeToString(authority.rootDER),
		},
	}
	encodedHeader, err := encodeJSONSegment(header)
	if err != nil {
		t.Fatal(err)
	}
	encodedPayload, err := encodeJSONSegment(payload)
	if err != nil {
		t.Fatal(err)
	}
	signingInput := encodedHeader + "." + encodedPayload
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, authority.leafKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func newAppleTestAuthority(t *testing.T, now time.Time) appleTestAuthority {
	t.Helper()
	rootKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	intermediateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	apiKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rootTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Apple test root"},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	rootCertificate, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}
	intermediateTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "Apple test intermediate"},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(180 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtraExtensions:       []pkix.Extension{{Id: appleIntermediateOID, Value: []byte{0x05, 0x00}}},
	}
	intermediateDER, err := x509.CreateCertificate(
		rand.Reader,
		intermediateTemplate,
		rootCertificate,
		&intermediateKey.PublicKey,
		rootKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	intermediateCertificate, err := x509.ParseCertificate(intermediateDER)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(3),
		Subject:               pkix.Name{CommonName: "Apple test signing leaf"},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(30 * 24 * time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtraExtensions:       []pkix.Extension{{Id: appleLeafOID, Value: []byte{0x05, 0x00}}},
	}
	leafDER, err := x509.CreateCertificate(
		rand.Reader,
		leafTemplate,
		intermediateCertificate,
		&leafKey.PublicKey,
		intermediateKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	return appleTestAuthority{
		rootCertificate: rootCertificate,
		rootDER:         rootDER,
		intermediateDER: intermediateDER,
		leafDER:         leafDER,
		leafKey:         leafKey,
		apiKey:          apiKey,
	}
}
