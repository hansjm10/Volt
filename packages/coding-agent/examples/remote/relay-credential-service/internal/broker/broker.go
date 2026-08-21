package broker

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/credential"
)

var (
	ErrClaimCapacity         = errors.New("pairing claim capacity reached")
	ErrCredentialCapacity    = errors.New("refresh credential capacity reached")
	ErrInvalidHostNodeID     = errors.New("invalid host node ID")
	ErrInvalidAppNodeID      = errors.New("invalid app node ID")
	ErrInvalidDeliverySecret = errors.New("invalid app delivery secret")
	ErrDeliveryUnauthorized  = errors.New("app delivery secret unauthorized")
	ErrClaimNotFound         = errors.New("pairing claim not found")
	ErrClaimExpired          = errors.New("pairing claim expired")
	ErrClaimPending          = errors.New("pairing claim pending")
	ErrClaimUnauthorized     = errors.New("pairing claim unauthorized")
	ErrClaimConflict         = errors.New("pairing claim already approved for another app endpoint")
	ErrRefreshInvalid        = errors.New("refresh credential invalid")
	ErrRefreshExpired        = errors.New("refresh credential expired")
	ErrRefreshThrottled      = errors.New("refresh credential used too frequently")
)

var nodeIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

const (
	claimSecretPrefix  = "vpc_"
	refreshPrefix      = "vrr_"
	MaxClaimTTL        = 30 * time.Minute
	MaxAccessTokenTTL  = time.Hour
	MaxRefreshTokenTTL = 90 * 24 * time.Hour
)

type Config struct {
	ClaimTTL           time.Duration
	AccessTokenTTL     time.Duration
	RefreshTokenTTL    time.Duration
	RefreshMinInterval time.Duration
	MaxClaims          int
	MaxCredentials     int
}

type Broker struct {
	mu      sync.Mutex
	signer  *credential.Signer
	config  Config
	now     func() time.Time
	claims  map[string]*pairingClaim
	refresh map[[sha256.Size]byte]*refreshRecord
}

type pairingClaim struct {
	ID                    string
	SecretHash            [sha256.Size]byte
	HostNodeID            string
	ExpiresAt             time.Time
	ApprovedAppID         string
	ApprovedAppNodeID     string
	AppDeliverySecretHash [sha256.Size]byte
	GrantID               string
	AppRefreshHash        [sha256.Size]byte
	HasAppRefreshHash     bool
	HostRefreshHash       [sha256.Size]byte
	HasHostRefreshHash    bool
}

type refreshRecord struct {
	Subject      string
	EndpointKind string
	GrantID      string
	ExpiresAt    time.Time
	LastRefresh  time.Time
	Revoked      bool
}

type PairingClaim struct {
	ClaimID     string    `json:"claimId"`
	ClaimSecret string    `json:"claimSecret"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

type EndpointCredential struct {
	AccessToken           string    `json:"accessToken"`
	AccessTokenExpiresAt  time.Time `json:"accessTokenExpiresAt"`
	RefreshToken          string    `json:"refreshToken"`
	RefreshTokenExpiresAt time.Time `json:"refreshTokenExpiresAt"`
	TokenType             string    `json:"tokenType"`
}

type Approval struct {
	GrantID    string             `json:"grantId"`
	AppNodeID  string             `json:"appNodeId"`
	Credential EndpointCredential `json:"credential"`
}

type Exchange struct {
	GrantID    string             `json:"grantId"`
	HostNodeID string             `json:"hostNodeId"`
	Credential EndpointCredential `json:"credential"`
}

type AccessToken struct {
	AccessToken          string    `json:"accessToken"`
	AccessTokenExpiresAt time.Time `json:"accessTokenExpiresAt"`
	TokenType            string    `json:"tokenType"`
}

func New(signer *credential.Signer, config Config, now func() time.Time) (*Broker, error) {
	if signer == nil {
		return nil, errors.New("signer is required")
	}
	if config.ClaimTTL <= 0 || config.AccessTokenTTL < time.Second || config.RefreshTokenTTL <= 0 || config.RefreshMinInterval <= 0 {
		return nil, errors.New("credential TTLs and refresh interval are invalid")
	}
	if config.ClaimTTL > MaxClaimTTL || config.AccessTokenTTL > MaxAccessTokenTTL || config.RefreshTokenTTL > MaxRefreshTokenTTL {
		return nil, errors.New("credential TTL exceeds its hard safety maximum")
	}
	if config.RefreshMinInterval >= config.AccessTokenTTL {
		return nil, errors.New("refresh interval must be shorter than the access token TTL")
	}
	if config.MaxClaims <= 0 || config.MaxCredentials <= 0 {
		return nil, errors.New("claim and credential capacities must be positive")
	}
	if now == nil {
		now = time.Now
	}
	return &Broker{
		signer:  signer,
		config:  config,
		now:     now,
		claims:  make(map[string]*pairingClaim),
		refresh: make(map[[sha256.Size]byte]*refreshRecord),
	}, nil
}

func ValidNodeID(nodeID string) bool {
	return nodeIDPattern.MatchString(nodeID)
}

func (b *Broker) CreatePairingClaim(hostNodeID string) (PairingClaim, error) {
	if !ValidNodeID(hostNodeID) {
		return PairingClaim{}, ErrInvalidHostNodeID
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	if len(b.claims) >= b.config.MaxClaims {
		b.cleanupLocked(now)
		if len(b.claims) >= b.config.MaxClaims {
			return PairingClaim{}, ErrClaimCapacity
		}
	}

	claimID, err := randomToken("", 18)
	if err != nil {
		return PairingClaim{}, err
	}
	claimSecret, err := randomToken(claimSecretPrefix, 32)
	if err != nil {
		return PairingClaim{}, err
	}
	expiresAt := now.Add(b.config.ClaimTTL)
	b.claims[claimID] = &pairingClaim{
		ID:         claimID,
		SecretHash: sha256.Sum256([]byte(claimSecret)),
		HostNodeID: hostNodeID,
		ExpiresAt:  expiresAt,
	}
	return PairingClaim{ClaimID: claimID, ClaimSecret: claimSecret, ExpiresAt: expiresAt}, nil
}

func (b *Broker) ApprovePairingClaim(claimID, appID, appNodeID, deliverySecret string) (Approval, error) {
	if strings.TrimSpace(appID) == "" {
		return Approval{}, errors.New("verified app ID is required")
	}
	if !ValidNodeID(appNodeID) {
		return Approval{}, ErrInvalidAppNodeID
	}
	decodedDeliverySecret, err := base64.RawURLEncoding.DecodeString(deliverySecret)
	if err != nil || len(decodedDeliverySecret) != 32 || base64.RawURLEncoding.EncodeToString(decodedDeliverySecret) != deliverySecret {
		return Approval{}, ErrInvalidDeliverySecret
	}
	deliverySecretHash := sha256.Sum256([]byte(deliverySecret))

	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	claim, err := b.activeClaimLocked(claimID, now)
	if err != nil {
		return Approval{}, err
	}
	grantID := claim.GrantID
	if claim.ApprovedAppNodeID != "" {
		if claim.ApprovedAppNodeID != appNodeID || claim.ApprovedAppID != appID {
			return Approval{}, ErrClaimConflict
		}
		if subtle.ConstantTimeCompare(deliverySecretHash[:], claim.AppDeliverySecretHash[:]) != 1 {
			return Approval{}, ErrDeliveryUnauthorized
		}
		if claim.HasAppRefreshHash {
			delete(b.refresh, claim.AppRefreshHash)
			claim.HasAppRefreshHash = false
		}
	} else {
		var err error
		grantID, err = randomToken("", 18)
		if err != nil {
			return Approval{}, err
		}
	}
	if !b.ensureCredentialCapacityLocked(1, now) {
		return Approval{}, ErrCredentialCapacity
	}
	appCredential, appRefreshHash, err := b.issueEndpointCredentialLocked(appNodeID, "app", grantID, now)
	if err != nil {
		return Approval{}, err
	}

	claim.ApprovedAppID = appID
	claim.ApprovedAppNodeID = appNodeID
	claim.AppDeliverySecretHash = deliverySecretHash
	claim.GrantID = grantID
	claim.AppRefreshHash = appRefreshHash
	claim.HasAppRefreshHash = true
	return Approval{GrantID: grantID, AppNodeID: appNodeID, Credential: appCredential}, nil
}

func (b *Broker) ExchangePairingClaim(claimID, claimSecret string) (Exchange, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	claim, err := b.activeClaimLocked(claimID, now)
	if err != nil {
		return Exchange{}, err
	}
	providedHash := sha256.Sum256([]byte(claimSecret))
	if subtle.ConstantTimeCompare(providedHash[:], claim.SecretHash[:]) != 1 {
		return Exchange{}, ErrClaimUnauthorized
	}
	if claim.ApprovedAppNodeID == "" {
		return Exchange{}, ErrClaimPending
	}
	if claim.HasHostRefreshHash {
		delete(b.refresh, claim.HostRefreshHash)
		claim.HasHostRefreshHash = false
	}
	if !b.ensureCredentialCapacityLocked(1, now) {
		return Exchange{}, ErrCredentialCapacity
	}
	hostCredential, hostRefreshHash, err := b.issueEndpointCredentialLocked(claim.HostNodeID, "host", claim.GrantID, now)
	if err != nil {
		return Exchange{}, err
	}
	claim.HostRefreshHash = hostRefreshHash
	claim.HasHostRefreshHash = true
	return Exchange{
		GrantID:    claim.GrantID,
		HostNodeID: claim.HostNodeID,
		Credential: hostCredential,
	}, nil
}

func (b *Broker) RefreshAccessToken(refreshToken string) (AccessToken, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	record, err := b.activeRefreshLocked(refreshToken, now)
	if err != nil {
		return AccessToken{}, err
	}
	if !record.LastRefresh.IsZero() && now.Sub(record.LastRefresh) < b.config.RefreshMinInterval {
		return AccessToken{}, ErrRefreshThrottled
	}
	previousRefresh := record.LastRefresh
	record.LastRefresh = now
	accessToken, expiresAt, err := b.issueAccessToken(record.Subject, record.EndpointKind, record.GrantID, now)
	if err != nil {
		record.LastRefresh = previousRefresh
		return AccessToken{}, err
	}
	return AccessToken{AccessToken: accessToken, AccessTokenExpiresAt: expiresAt, TokenType: "Bearer"}, nil
}

func (b *Broker) RevokeRefreshToken(refreshToken string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	record, err := b.activeRefreshLocked(refreshToken, now)
	if err != nil {
		return err
	}
	record.Revoked = true
	return nil
}

func (b *Broker) issueEndpointCredentialLocked(subject, endpointKind, grantID string, now time.Time) (EndpointCredential, [sha256.Size]byte, error) {
	refreshToken, err := randomToken(refreshPrefix, 32)
	if err != nil {
		return EndpointCredential{}, [sha256.Size]byte{}, err
	}
	refreshExpiresAt := now.Add(b.config.RefreshTokenTTL)
	refreshHash := sha256.Sum256([]byte(refreshToken))
	b.refresh[refreshHash] = &refreshRecord{
		Subject:      subject,
		EndpointKind: endpointKind,
		GrantID:      grantID,
		ExpiresAt:    refreshExpiresAt,
	}

	accessToken, accessExpiresAt, err := b.issueAccessToken(subject, endpointKind, grantID, now)
	if err != nil {
		delete(b.refresh, refreshHash)
		return EndpointCredential{}, [sha256.Size]byte{}, err
	}
	return EndpointCredential{
		AccessToken:           accessToken,
		AccessTokenExpiresAt:  accessExpiresAt,
		RefreshToken:          refreshToken,
		RefreshTokenExpiresAt: refreshExpiresAt,
		TokenType:             "Bearer",
	}, refreshHash, nil
}

func (b *Broker) issueAccessToken(subject, endpointKind, grantID string, now time.Time) (string, time.Time, error) {
	jwtID, err := randomToken("", 18)
	if err != nil {
		return "", time.Time{}, err
	}
	return b.signer.Issue(subject, endpointKind, grantID, jwtID, now, b.config.AccessTokenTTL)
}

func (b *Broker) activeClaimLocked(claimID string, now time.Time) (*pairingClaim, error) {
	claim, ok := b.claims[claimID]
	if !ok {
		return nil, ErrClaimNotFound
	}
	if !now.Before(claim.ExpiresAt) {
		delete(b.claims, claimID)
		return nil, ErrClaimExpired
	}
	return claim, nil
}

func (b *Broker) activeRefreshLocked(refreshToken string, now time.Time) (*refreshRecord, error) {
	if !strings.HasPrefix(refreshToken, refreshPrefix) || len(refreshToken) > 256 {
		return nil, ErrRefreshInvalid
	}
	hash := sha256.Sum256([]byte(refreshToken))
	record, ok := b.refresh[hash]
	if !ok || record.Revoked {
		return nil, ErrRefreshInvalid
	}
	if !now.Before(record.ExpiresAt) {
		delete(b.refresh, hash)
		return nil, ErrRefreshExpired
	}
	return record, nil
}

func (b *Broker) ensureCredentialCapacityLocked(needed int, now time.Time) bool {
	if len(b.refresh)+needed <= b.config.MaxCredentials {
		return true
	}
	b.cleanupLocked(now)
	return len(b.refresh)+needed <= b.config.MaxCredentials
}

func (b *Broker) cleanupLocked(now time.Time) {
	for claimID, claim := range b.claims {
		if !now.Before(claim.ExpiresAt) {
			delete(b.claims, claimID)
		}
	}
	for hash, record := range b.refresh {
		if record.Revoked || !now.Before(record.ExpiresAt) {
			delete(b.refresh, hash)
		}
	}
}

func randomToken(prefix string, byteCount int) (string, error) {
	value := make([]byte, byteCount)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value), nil
}
