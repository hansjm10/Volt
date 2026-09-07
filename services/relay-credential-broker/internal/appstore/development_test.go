package appstore

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

const developmentTestSecret = "development-app-store-proof-at-least-32-bytes"

func TestDevelopmentVerifierRejectsInvalidProofs(t *testing.T) {
	verifier, err := NewDevelopmentVerifier(developmentTestSecret, nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce := strings.Repeat("ab", 32)
	for name, signed := range map[string]string{
		"empty":             "",
		"bare secret":       developmentTestSecret,
		"missing nonce":     "." + developmentTestSecret,
		"missing secret":    nonce + ".",
		"missing period":    nonce + developmentTestSecret,
		"wrong secret":      nonce + "." + strings.Repeat("x", 32),
		"extra suffix":      nonce + "." + developmentTestSecret + ".extra",
		"short nonce":       nonce[:62] + "." + developmentTestSecret,
		"long nonce":        nonce + "ab." + developmentTestSecret,
		"odd nonce":         nonce[:63] + "." + developmentTestSecret,
		"nonhex nonce":      strings.Repeat("gg", 32) + "." + developmentTestSecret,
		"uppercase nonce":   strings.ToUpper(nonce) + "." + developmentTestSecret,
		"nonce whitespace":  " " + nonce[1:] + "." + developmentTestSecret,
		"secret whitespace": nonce + ". " + developmentTestSecret,
	} {
		t.Run(name, func(t *testing.T) {
			entitlement, err := verifier.VerifyEntitlement(context.Background(), Proof{
				SignedAppTransaction: signed,
				DeviceVerificationID: "11111111-1111-4111-8111-111111111111",
			})
			if !errors.Is(err, ErrProofInvalid) || entitlement != (Entitlement{}) {
				t.Fatalf("invalid proof returned entitlement=%+v, error=%v", entitlement, err)
			}
		})
	}
}

func TestDevelopmentVerifierAcceptsVerbatimSecretAndPreservesEntitlement(t *testing.T) {
	now := time.Date(2026, time.September, 5, 12, 0, 0, 0, time.UTC)
	secret := " " + developmentTestSecret + ".with.periods "
	verifier, err := NewDevelopmentVerifier(secret, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	deviceID := "11111111-1111-4111-8111-111111111111"
	entitlement, err := verifier.VerifyEntitlement(context.Background(), Proof{
		SignedAppTransaction: strings.Repeat("01", 32) + "." + secret,
		DeviceVerificationID: deviceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	deviceHash := sha256.Sum256([]byte(deviceID))
	if entitlement.AppTransactionID != base64.RawURLEncoding.EncodeToString(deviceHash[:]) ||
		entitlement.ApprovalProofHash == ([sha256.Size]byte{}) ||
		entitlement.Environment != "Sandbox" ||
		entitlement.ProductID != "com.hansjm10.volt.pro.annual" ||
		entitlement.SubscriptionGroupID != "development" ||
		entitlement.Status != StatusActive || !entitlement.Active(now) ||
		!entitlement.EntitledUntil.Equal(now.Add(24*time.Hour)) ||
		!entitlement.ProofCreatedAt.Equal(now) ||
		!entitlement.SourceSignedAt.Equal(now) || !entitlement.VerifiedAt.Equal(now) {
		t.Fatalf("unexpected development entitlement: %+v", entitlement)
	}
	reconciled, err := verifier.ReconcileEntitlement(context.Background(), entitlement.AppTransactionID, "Sandbox")
	if err != nil {
		t.Fatal(err)
	}
	wantReconciled := entitlement
	wantReconciled.ApprovalProofHash = [sha256.Size]byte{}
	wantReconciled.ProofCreatedAt = time.Time{}
	if reconciled != wantReconciled {
		t.Fatalf("reconciliation = %+v, want %+v", reconciled, wantReconciled)
	}
	if _, err := verifier.VerifyNotification(context.Background(), "notification"); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("development notification error = %v, want %v", err, ErrProofInvalid)
	}
}

func TestDevelopmentVerifierProofIdentitySurvivesRetriesAndRecreation(t *testing.T) {
	now := time.Date(2026, time.September, 5, 12, 0, 0, 0, time.UTC)
	verifier, err := NewDevelopmentVerifier(developmentTestSecret, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	proof := Proof{
		SignedAppTransaction: strings.Repeat("ab", 32) + "." + developmentTestSecret,
		DeviceVerificationID: "11111111-1111-4111-8111-111111111111",
	}
	first, err := verifier.VerifyEntitlement(context.Background(), proof)
	if err != nil {
		t.Fatal(err)
	}
	for _, recreate := range []bool{false, true} {
		now = now.Add(time.Minute)
		if recreate {
			verifier, err = NewDevelopmentVerifier(developmentTestSecret, func() time.Time { return now })
			if err != nil {
				t.Fatal(err)
			}
		}
		retry, err := verifier.VerifyEntitlement(context.Background(), proof)
		if err != nil {
			t.Fatal(err)
		}
		if retry.ApprovalProofHash != first.ApprovalProofHash || retry.AppTransactionID != first.AppTransactionID {
			t.Fatalf("retry changed proof or subscription identity (recreate=%v)", recreate)
		}
		if !retry.ProofCreatedAt.Equal(now) {
			t.Fatalf("retry proof time = %v, want %v", retry.ProofCreatedAt, now)
		}
	}
}

func TestDevelopmentVerifierDistinguishesProofInstances(t *testing.T) {
	now := time.Date(2026, time.September, 5, 12, 0, 0, 0, time.UTC)
	firstDevice := "11111111-1111-4111-8111-111111111111"
	secondDevice := "22222222-2222-4222-8222-222222222222"
	firstNonce := strings.Repeat("ab", 32)
	seen := make(map[[sha256.Size]byte]bool)
	var firstAppTransactionID string
	for _, test := range []struct {
		name   string
		secret string
		device string
		nonce  string
	}{
		{"first", developmentTestSecret, firstDevice, firstNonce},
		{"fresh nonce", developmentTestSecret, firstDevice, strings.Repeat("cd", 32)},
		{"different device", developmentTestSecret, secondDevice, firstNonce},
		{"different configured secret", developmentTestSecret + "-other", firstDevice, firstNonce},
	} {
		t.Run(test.name, func(t *testing.T) {
			verifier, err := NewDevelopmentVerifier(test.secret, func() time.Time { return now })
			if err != nil {
				t.Fatal(err)
			}
			entitlement, err := verifier.VerifyEntitlement(context.Background(), Proof{
				SignedAppTransaction: test.nonce + "." + test.secret,
				DeviceVerificationID: test.device,
			})
			if err != nil {
				t.Fatal(err)
			}
			if entitlement.ApprovalProofHash == ([sha256.Size]byte{}) || seen[entitlement.ApprovalProofHash] {
				t.Fatal("distinct proof instance did not produce a unique nonzero identity")
			}
			seen[entitlement.ApprovalProofHash] = true
			if test.name == "first" {
				firstAppTransactionID = entitlement.AppTransactionID
			} else if (entitlement.AppTransactionID == firstAppTransactionID) != (test.device == firstDevice) {
				t.Fatal("subscription identity must depend only on device identity")
			}
		})
	}
}
