package appstore

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

type DevelopmentVerifier struct {
	proofHash [sha256.Size]byte
	now       func() time.Time
}

func NewDevelopmentVerifier(proof string, now func() time.Time) (*DevelopmentVerifier, error) {
	if len(strings.TrimSpace(proof)) < 32 {
		return nil, errors.New("development App Store proof must contain at least 32 characters")
	}
	if now == nil {
		now = time.Now
	}
	return &DevelopmentVerifier{
		proofHash: sha256.Sum256([]byte(proof)),
		now:       now,
	}, nil
}

func (v *DevelopmentVerifier) VerifyEntitlement(
	_ context.Context,
	proof Proof,
) (Entitlement, error) {
	nonceText, secret, ok := strings.Cut(proof.SignedAppTransaction, ".")
	if !ok || len(nonceText) != 2*sha256.Size {
		return Entitlement{}, ErrProofInvalid
	}
	nonce, err := hex.DecodeString(nonceText)
	if err != nil || hex.EncodeToString(nonce) != nonceText {
		return Entitlement{}, ErrProofInvalid
	}
	provided := sha256.Sum256([]byte(secret))
	if !equalBytes(provided[:], v.proofHash[:]) {
		return Entitlement{}, ErrProofInvalid
	}
	now := v.now().UTC()
	identityHash := sha256.Sum256([]byte(proof.DeviceVerificationID))
	// A proof instance is stable across retries, but independent of its destination claim.
	proofIdentity := append([]byte("volt-development-app-store-approval\x00"), provided[:]...)
	proofIdentity = append(proofIdentity, identityHash[:]...)
	proofIdentity = append(proofIdentity, nonce...)
	return Entitlement{
		AppTransactionID:    base64.RawURLEncoding.EncodeToString(identityHash[:]),
		ApprovalProofHash:   sha256.Sum256(proofIdentity),
		ProofCreatedAt:      now,
		Environment:         "Sandbox",
		ProductID:           "com.hansjm10.volt.pro.annual",
		SubscriptionGroupID: "development",
		Status:              StatusActive,
		EntitledUntil:       now.Add(24 * time.Hour),
		SourceSignedAt:      now,
		VerifiedAt:          now,
	}, nil
}

func (v *DevelopmentVerifier) ReconcileEntitlement(
	_ context.Context,
	appTransactionID string,
	environment string,
) (Entitlement, error) {
	if !identifierPattern.MatchString(appTransactionID) || environment != "Sandbox" {
		return Entitlement{}, ErrProofInvalid
	}
	now := v.now().UTC()
	return Entitlement{
		AppTransactionID:    appTransactionID,
		Environment:         "Sandbox",
		ProductID:           "com.hansjm10.volt.pro.annual",
		SubscriptionGroupID: "development",
		Status:              StatusActive,
		EntitledUntil:       now.Add(24 * time.Hour),
		SourceSignedAt:      now,
		VerifiedAt:          now,
	}, nil
}

func (v *DevelopmentVerifier) VerifyNotification(
	_ context.Context,
	_ string,
) (Notification, error) {
	return Notification{}, ErrProofInvalid
}
