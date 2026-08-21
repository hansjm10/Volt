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
	ErrClaimCapacity       = errors.New("pairing claim capacity reached")
	ErrEndpointCapacity    = errors.New("endpoint credential capacity reached")
	ErrAppEndpointCapacity = errors.New("app endpoint capacity reached for grant")
	ErrInvalidHostNodeID   = errors.New("invalid host node ID")
	ErrInvalidAppNodeID    = errors.New("invalid app node ID")
	ErrInvalidSecretHash   = errors.New("invalid secret hash")
	ErrClaimNotFound       = errors.New("pairing claim not found")
	ErrClaimExpired        = errors.New("pairing claim expired")
	ErrClaimPending        = errors.New("pairing claim pending")
	ErrClaimUnauthorized   = errors.New("pairing claim unauthorized")
	ErrClaimConflict       = errors.New("pairing claim conflicts with existing approval")
	ErrRefreshHashConflict = errors.New("refresh credential hash already exists")
	ErrRefreshInvalid      = errors.New("refresh credential invalid")
	ErrRefreshExpired      = errors.New("refresh credential expired")
	ErrRefreshThrottled    = errors.New("refresh credential used too frequently")
	ErrGrantRevoked        = errors.New("daemon identity grant revoked")
	ErrEndpointNotFound    = errors.New("endpoint credential not found")
	ErrEndpointForbidden   = errors.New("endpoint credential is outside host grant")
)

var nodeIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

const (
	claimSecretPrefix          = "vpc_"
	refreshPrefix              = "vrr_"
	secretByteCount            = 32
	MaxClaimTTL                = 30 * time.Minute
	MaxAccessTokenTTL          = time.Hour
	MaxRefreshInactivityTTL    = 90 * 24 * time.Hour
	endpointTombstoneRetention = 30 * 24 * time.Hour
)

type SecretHash [sha256.Size]byte

type Config struct {
	ClaimTTL                time.Duration
	AccessTokenTTL          time.Duration
	RefreshInactivityTTL    time.Duration
	RefreshMinInterval      time.Duration
	MaxClaims               int
	MaxEndpoints            int
	MaxAppEndpointsPerGrant int
}

type Broker struct {
	mu             sync.Mutex
	signer         *credential.Signer
	config         Config
	now            func() time.Time
	claims         map[string]*pairingClaim
	claimSecrets   map[SecretHash]string
	grants         map[string]*grantRecord
	endpoints      map[string]*endpointRecord
	grantEndpoints map[string]map[string]*endpointRecord
	refresh        map[SecretHash]*endpointRecord
}

type pairingClaim struct {
	ID                       string
	SecretHash               SecretHash
	HostNodeID               string
	ExpiresAt                time.Time
	GrantID                  string
	BootstrapHostRefreshHash SecretHash
	HasBootstrapHostRefresh  bool
	ApprovedAppID            string
	ApprovedAppNodeID        string
	ApprovedAppRefreshHash   SecretHash
	ApprovedAppEndpointID    string
	ApprovedAt               time.Time
	ExchangedAt              time.Time
}

type grantRecord struct {
	ID             string
	HostNodeID     string
	HostEndpointID string
	CreatedAt      time.Time
	RevokedAt      time.Time
}

type endpointRecord struct {
	ID                       string
	Subject                  string
	EndpointKind             string
	GrantID                  string
	RefreshHash              SecretHash
	RefreshInactiveExpiresAt time.Time
	LastRefresh              time.Time
	CreatedAt                time.Time
	RevokedAt                time.Time
}

type PairingClaim struct {
	ClaimID   string    `json:"claimId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type AccessToken struct {
	AccessToken          string    `json:"accessToken"`
	AccessTokenExpiresAt time.Time `json:"accessTokenExpiresAt"`
	TokenType            string    `json:"tokenType"`
}

type Approval struct {
	GrantID    string      `json:"grantId"`
	EndpointID string      `json:"endpointId"`
	HostNodeID string      `json:"hostNodeId"`
	AppNodeID  string      `json:"appNodeId"`
	Credential AccessToken `json:"credential"`
}

type Exchange struct {
	GrantID       string      `json:"grantId"`
	EndpointID    string      `json:"endpointId"`
	HostNodeID    string      `json:"hostNodeId"`
	AppEndpointID string      `json:"appEndpointId"`
	AppNodeID     string      `json:"appNodeId"`
	Credential    AccessToken `json:"credential"`
}

func New(signer *credential.Signer, config Config, now func() time.Time) (*Broker, error) {
	if signer == nil {
		return nil, errors.New("signer is required")
	}
	if config.ClaimTTL <= 0 || config.AccessTokenTTL < time.Second || config.RefreshInactivityTTL <= 0 || config.RefreshMinInterval <= 0 {
		return nil, errors.New("credential TTLs and refresh interval are invalid")
	}
	if config.ClaimTTL > MaxClaimTTL || config.AccessTokenTTL > MaxAccessTokenTTL || config.RefreshInactivityTTL > MaxRefreshInactivityTTL {
		return nil, errors.New("credential TTL exceeds its hard safety maximum")
	}
	if config.RefreshMinInterval >= config.AccessTokenTTL {
		return nil, errors.New("refresh interval must be shorter than the access token TTL")
	}
	if config.RefreshInactivityTTL < config.ClaimTTL || config.RefreshInactivityTTL < config.AccessTokenTTL {
		return nil, errors.New("refresh inactivity TTL must cover the claim and access token TTLs")
	}
	if config.MaxClaims <= 0 || config.MaxEndpoints <= 0 || config.MaxAppEndpointsPerGrant <= 0 {
		return nil, errors.New("claim and endpoint capacities must be positive")
	}
	if now == nil {
		now = time.Now
	}
	return &Broker{
		signer:         signer,
		config:         config,
		now:            now,
		claims:         make(map[string]*pairingClaim),
		claimSecrets:   make(map[SecretHash]string),
		grants:         make(map[string]*grantRecord),
		endpoints:      make(map[string]*endpointRecord),
		grantEndpoints: make(map[string]map[string]*endpointRecord),
		refresh:        make(map[SecretHash]*endpointRecord),
	}, nil
}

func ValidNodeID(nodeID string) bool {
	return nodeIDPattern.MatchString(nodeID)
}

func ParseSecretHash(value string) (SecretHash, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return SecretHash{}, ErrInvalidSecretHash
	}
	var result SecretHash
	copy(result[:], decoded)
	return result, nil
}

func (b *Broker) CreateBootstrapPairingClaim(hostNodeID string, claimSecretHash, hostRefreshHash SecretHash) (PairingClaim, error) {
	if !ValidNodeID(hostNodeID) {
		return PairingClaim{}, ErrInvalidHostNodeID
	}
	if subtle.ConstantTimeCompare(claimSecretHash[:], hostRefreshHash[:]) == 1 {
		return PairingClaim{}, ErrClaimConflict
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	return b.createPairingClaimLocked(hostNodeID, "", claimSecretHash, hostRefreshHash, true)
}

func (b *Broker) CreatePairingClaimForGrant(hostRefreshToken string, claimSecretHash SecretHash) (PairingClaim, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	host, err := b.activeEndpointLocked(hostRefreshToken, now)
	if err != nil {
		return PairingClaim{}, err
	}
	if host.EndpointKind != "host" {
		return PairingClaim{}, ErrEndpointForbidden
	}
	if subtle.ConstantTimeCompare(claimSecretHash[:], host.RefreshHash[:]) == 1 {
		return PairingClaim{}, ErrClaimConflict
	}
	return b.createPairingClaimLocked(host.Subject, host.GrantID, claimSecretHash, SecretHash{}, false)
}

func (b *Broker) createPairingClaimLocked(
	hostNodeID string,
	grantID string,
	claimSecretHash SecretHash,
	hostRefreshHash SecretHash,
	bootstrap bool,
) (PairingClaim, error) {
	now := b.now().UTC()
	if len(b.claims) >= b.config.MaxClaims {
		b.cleanupClaimsLocked(now)
		if len(b.claims) >= b.config.MaxClaims {
			return PairingClaim{}, ErrClaimCapacity
		}
	}
	if existingID, exists := b.claimSecrets[claimSecretHash]; exists {
		existing := b.claims[existingID]
		if existing != nil && now.Before(existing.ExpiresAt) {
			return PairingClaim{}, ErrClaimConflict
		}
		delete(b.claims, existingID)
		delete(b.claimSecrets, claimSecretHash)
	}

	claimID, err := randomIdentifier()
	if err != nil {
		return PairingClaim{}, err
	}
	expiresAt := now.Add(b.config.ClaimTTL)
	b.claims[claimID] = &pairingClaim{
		ID:                       claimID,
		SecretHash:               claimSecretHash,
		HostNodeID:               hostNodeID,
		ExpiresAt:                expiresAt,
		GrantID:                  grantID,
		BootstrapHostRefreshHash: hostRefreshHash,
		HasBootstrapHostRefresh:  bootstrap,
	}
	b.claimSecrets[claimSecretHash] = claimID
	return PairingClaim{ClaimID: claimID, ExpiresAt: expiresAt}, nil
}

func (b *Broker) ApprovePairingClaim(claimID, appID, appNodeID string, appRefreshHash SecretHash) (Approval, error) {
	if strings.TrimSpace(appID) == "" {
		return Approval{}, errors.New("verified app ID is required")
	}
	if !ValidNodeID(appNodeID) {
		return Approval{}, ErrInvalidAppNodeID
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	claim, err := b.activeClaimLocked(claimID, now)
	if err != nil {
		return Approval{}, err
	}
	if claim.ApprovedAppEndpointID != "" {
		if claim.ApprovedAppNodeID != appNodeID || claim.ApprovedAppID != appID || subtle.ConstantTimeCompare(claim.ApprovedAppRefreshHash[:], appRefreshHash[:]) != 1 {
			return Approval{}, ErrClaimConflict
		}
		app := b.endpoints[claim.ApprovedAppEndpointID]
		if app == nil || !app.RevokedAt.IsZero() || !now.Before(app.RefreshInactiveExpiresAt) {
			return Approval{}, ErrRefreshInvalid
		}
		access, err := b.issueAccessToken(app, now)
		if err != nil {
			return Approval{}, err
		}
		return approvalFor(claim, app, access), nil
	}
	if _, exists := b.refresh[appRefreshHash]; exists {
		return Approval{}, ErrRefreshHashConflict
	}
	if claim.HasBootstrapHostRefresh && subtle.ConstantTimeCompare(appRefreshHash[:], claim.BootstrapHostRefreshHash[:]) == 1 {
		return Approval{}, ErrRefreshHashConflict
	}

	grantID := claim.GrantID
	neededEndpoints := 1
	if claim.HasBootstrapHostRefresh {
		neededEndpoints = 2
	} else {
		grant := b.grants[grantID]
		if grant == nil || !grant.RevokedAt.IsZero() {
			return Approval{}, ErrGrantRevoked
		}
		host := b.endpoints[grant.HostEndpointID]
		if host == nil || !host.RevokedAt.IsZero() {
			return Approval{}, ErrRefreshInvalid
		}
		if !now.Before(host.RefreshInactiveExpiresAt) {
			b.revokeGrantLocked(grantID, now)
			return Approval{}, ErrRefreshExpired
		}
		if b.endpointForGrantNodeLocked(grantID, "app", appNodeID) != nil {
			return Approval{}, ErrClaimConflict
		}
		if b.activeAppEndpointCountLocked(grantID, now) >= b.config.MaxAppEndpointsPerGrant {
			return Approval{}, ErrAppEndpointCapacity
		}
	}
	if !b.ensureEndpointCapacityLocked(neededEndpoints, now) {
		return Approval{}, ErrEndpointCapacity
	}

	if claim.HasBootstrapHostRefresh {
		if _, exists := b.refresh[claim.BootstrapHostRefreshHash]; exists {
			return Approval{}, ErrRefreshHashConflict
		}
		grantID, err = randomIdentifier()
		if err != nil {
			return Approval{}, err
		}
	}
	appEndpointID, err := randomIdentifier()
	if err != nil {
		return Approval{}, err
	}
	var hostEndpointID string
	if claim.HasBootstrapHostRefresh {
		hostEndpointID, err = randomIdentifier()
		if err != nil {
			return Approval{}, err
		}
	}
	app := &endpointRecord{
		ID:                       appEndpointID,
		Subject:                  appNodeID,
		EndpointKind:             "app",
		GrantID:                  grantID,
		RefreshHash:              appRefreshHash,
		RefreshInactiveExpiresAt: now.Add(b.config.RefreshInactivityTTL),
		CreatedAt:                now,
	}
	access, err := b.issueAccessToken(app, now)
	if err != nil {
		return Approval{}, err
	}

	if claim.HasBootstrapHostRefresh {
		host := &endpointRecord{
			ID:                       hostEndpointID,
			Subject:                  claim.HostNodeID,
			EndpointKind:             "host",
			GrantID:                  grantID,
			RefreshHash:              claim.BootstrapHostRefreshHash,
			RefreshInactiveExpiresAt: now.Add(b.config.RefreshInactivityTTL),
			CreatedAt:                now,
		}
		b.grants[grantID] = &grantRecord{
			ID:             grantID,
			HostNodeID:     claim.HostNodeID,
			HostEndpointID: hostEndpointID,
			CreatedAt:      now,
		}
		b.registerEndpointLocked(host)
	}
	b.registerEndpointLocked(app)
	claim.GrantID = grantID
	claim.ApprovedAppID = appID
	claim.ApprovedAppNodeID = appNodeID
	claim.ApprovedAppRefreshHash = appRefreshHash
	claim.ApprovedAppEndpointID = app.ID
	claim.ApprovedAt = now
	return approvalFor(claim, app, access), nil
}

func (b *Broker) ExchangePairingClaim(claimID, claimSecret string) (Exchange, error) {
	if !validSecret(claimSecret, claimSecretPrefix) {
		return Exchange{}, ErrClaimUnauthorized
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	claim, err := b.activeClaimLocked(claimID, now)
	if err != nil {
		return Exchange{}, err
	}
	providedHash := SecretHash(sha256.Sum256([]byte(claimSecret)))
	if subtle.ConstantTimeCompare(providedHash[:], claim.SecretHash[:]) != 1 {
		return Exchange{}, ErrClaimUnauthorized
	}
	if claim.ApprovedAppEndpointID == "" {
		return Exchange{}, ErrClaimPending
	}
	grant := b.grants[claim.GrantID]
	if grant == nil || !grant.RevokedAt.IsZero() {
		return Exchange{}, ErrGrantRevoked
	}
	host := b.endpoints[grant.HostEndpointID]
	if host == nil || !host.RevokedAt.IsZero() {
		return Exchange{}, ErrRefreshInvalid
	}
	if !now.Before(host.RefreshInactiveExpiresAt) {
		b.revokeGrantLocked(grant.ID, now)
		return Exchange{}, ErrRefreshExpired
	}
	access, err := b.issueAccessToken(host, now)
	if err != nil {
		return Exchange{}, err
	}
	claim.ExchangedAt = now
	return Exchange{
		GrantID:       grant.ID,
		EndpointID:    host.ID,
		HostNodeID:    host.Subject,
		AppEndpointID: claim.ApprovedAppEndpointID,
		AppNodeID:     claim.ApprovedAppNodeID,
		Credential:    access,
	}, nil
}

func (b *Broker) RefreshAccessToken(refreshToken string) (AccessToken, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	endpoint, err := b.activeEndpointLocked(refreshToken, now)
	if err != nil {
		return AccessToken{}, err
	}
	if !endpoint.LastRefresh.IsZero() && now.Sub(endpoint.LastRefresh) < b.config.RefreshMinInterval {
		return AccessToken{}, ErrRefreshThrottled
	}
	previousRefresh := endpoint.LastRefresh
	previousExpiry := endpoint.RefreshInactiveExpiresAt
	endpoint.LastRefresh = now
	endpoint.RefreshInactiveExpiresAt = now.Add(b.config.RefreshInactivityTTL)
	access, err := b.issueAccessToken(endpoint, now)
	if err != nil {
		endpoint.LastRefresh = previousRefresh
		endpoint.RefreshInactiveExpiresAt = previousExpiry
		return AccessToken{}, err
	}
	return access, nil
}

func (b *Broker) RevokeRefreshToken(refreshToken string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	endpoint, err := b.endpointForRefreshTokenLocked(refreshToken)
	if err != nil {
		return err
	}
	if endpoint.EndpointKind == "host" {
		b.revokeGrantLocked(endpoint.GrantID, now)
		return nil
	}
	if endpoint.RevokedAt.IsZero() {
		endpoint.RevokedAt = now
	}
	return nil
}

func (b *Broker) RevokeAppEndpoint(hostRefreshToken, appEndpointID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	host, err := b.activeEndpointLocked(hostRefreshToken, now)
	if err != nil {
		return err
	}
	if host.EndpointKind != "host" {
		return ErrEndpointForbidden
	}
	app := b.endpoints[appEndpointID]
	if app == nil {
		return ErrEndpointNotFound
	}
	if app.EndpointKind != "app" || app.GrantID != host.GrantID {
		return ErrEndpointForbidden
	}
	if app.RevokedAt.IsZero() {
		app.RevokedAt = now
	}
	return nil
}

func (b *Broker) RevokeGrant(hostRefreshToken string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	endpoint, err := b.endpointForRefreshTokenLocked(hostRefreshToken)
	if err != nil {
		return err
	}
	if endpoint.EndpointKind != "host" {
		return ErrEndpointForbidden
	}
	b.revokeGrantLocked(endpoint.GrantID, b.now().UTC())
	return nil
}

func approvalFor(claim *pairingClaim, app *endpointRecord, access AccessToken) Approval {
	return Approval{
		GrantID:    claim.GrantID,
		EndpointID: app.ID,
		HostNodeID: claim.HostNodeID,
		AppNodeID:  app.Subject,
		Credential: access,
	}
}

func (b *Broker) issueAccessToken(endpoint *endpointRecord, now time.Time) (AccessToken, error) {
	jwtID, err := randomIdentifier()
	if err != nil {
		return AccessToken{}, err
	}
	accessToken, expiresAt, err := b.signer.Issue(
		endpoint.Subject,
		endpoint.EndpointKind,
		endpoint.GrantID,
		jwtID,
		now,
		b.config.AccessTokenTTL,
	)
	if err != nil {
		return AccessToken{}, err
	}
	return AccessToken{AccessToken: accessToken, AccessTokenExpiresAt: expiresAt, TokenType: "Bearer"}, nil
}

func (b *Broker) activeClaimLocked(claimID string, now time.Time) (*pairingClaim, error) {
	claim, ok := b.claims[claimID]
	if !ok {
		return nil, ErrClaimNotFound
	}
	if !now.Before(claim.ExpiresAt) {
		b.deleteClaimLocked(claimID, claim)
		return nil, ErrClaimExpired
	}
	return claim, nil
}

func (b *Broker) activeEndpointLocked(refreshToken string, now time.Time) (*endpointRecord, error) {
	endpoint, err := b.endpointForRefreshTokenLocked(refreshToken)
	if err != nil {
		return nil, err
	}
	grant := b.grants[endpoint.GrantID]
	if grant == nil || !grant.RevokedAt.IsZero() || !endpoint.RevokedAt.IsZero() {
		return nil, ErrRefreshInvalid
	}
	if !now.Before(endpoint.RefreshInactiveExpiresAt) {
		if endpoint.EndpointKind == "host" {
			b.revokeGrantLocked(endpoint.GrantID, now)
		} else {
			endpoint.RevokedAt = now
		}
		return nil, ErrRefreshExpired
	}
	return endpoint, nil
}

func (b *Broker) endpointForRefreshTokenLocked(refreshToken string) (*endpointRecord, error) {
	if !validSecret(refreshToken, refreshPrefix) {
		return nil, ErrRefreshInvalid
	}
	hash := SecretHash(sha256.Sum256([]byte(refreshToken)))
	endpoint := b.refresh[hash]
	if endpoint == nil {
		return nil, ErrRefreshInvalid
	}
	return endpoint, nil
}

func (b *Broker) endpointForGrantNodeLocked(grantID, endpointKind, nodeID string) *endpointRecord {
	for _, endpoint := range b.grantEndpoints[grantID] {
		if endpoint.EndpointKind == endpointKind && endpoint.Subject == nodeID {
			return endpoint
		}
	}
	return nil
}

func (b *Broker) activeAppEndpointCountLocked(grantID string, now time.Time) int {
	count := 0
	for _, endpoint := range b.grantEndpoints[grantID] {
		if endpoint.EndpointKind == "app" && endpoint.RevokedAt.IsZero() && now.Before(endpoint.RefreshInactiveExpiresAt) {
			count++
		}
	}
	return count
}

func (b *Broker) registerEndpointLocked(endpoint *endpointRecord) {
	b.endpoints[endpoint.ID] = endpoint
	b.refresh[endpoint.RefreshHash] = endpoint
	grantEndpoints := b.grantEndpoints[endpoint.GrantID]
	if grantEndpoints == nil {
		grantEndpoints = make(map[string]*endpointRecord)
		b.grantEndpoints[endpoint.GrantID] = grantEndpoints
	}
	grantEndpoints[endpoint.ID] = endpoint
}

func (b *Broker) ensureEndpointCapacityLocked(needed int, now time.Time) bool {
	if len(b.endpoints)+needed <= b.config.MaxEndpoints {
		return true
	}
	b.cleanupEndpointsLocked(now)
	return len(b.endpoints)+needed <= b.config.MaxEndpoints
}

func (b *Broker) revokeGrantLocked(grantID string, now time.Time) {
	grant := b.grants[grantID]
	if grant == nil || !grant.RevokedAt.IsZero() {
		return
	}
	grant.RevokedAt = now
	for _, endpoint := range b.grantEndpoints[grantID] {
		if endpoint.RevokedAt.IsZero() {
			endpoint.RevokedAt = now
		}
	}
}

func (b *Broker) deleteClaimLocked(claimID string, claim *pairingClaim) {
	delete(b.claims, claimID)
	if b.claimSecrets[claim.SecretHash] == claimID {
		delete(b.claimSecrets, claim.SecretHash)
	}
}

func (b *Broker) cleanupClaimsLocked(now time.Time) {
	for claimID, claim := range b.claims {
		if !now.Before(claim.ExpiresAt) {
			b.deleteClaimLocked(claimID, claim)
		}
	}
}

func (b *Broker) cleanupEndpointsLocked(now time.Time) {
	expiredGrants := make(map[string]struct{})
	for _, endpoint := range b.endpoints {
		if !endpoint.RevokedAt.IsZero() || now.Before(endpoint.RefreshInactiveExpiresAt) {
			continue
		}
		if endpoint.EndpointKind == "host" {
			expiredGrants[endpoint.GrantID] = struct{}{}
		} else {
			endpoint.RevokedAt = now
		}
	}
	for grantID := range expiredGrants {
		b.revokeGrantLocked(grantID, now)
	}
	for endpointID, endpoint := range b.endpoints {
		if endpoint.RevokedAt.IsZero() || now.Before(endpoint.RevokedAt.Add(endpointTombstoneRetention)) {
			continue
		}
		delete(b.endpoints, endpointID)
		delete(b.refresh, endpoint.RefreshHash)
		grantEndpoints := b.grantEndpoints[endpoint.GrantID]
		delete(grantEndpoints, endpointID)
		if len(grantEndpoints) == 0 {
			delete(b.grantEndpoints, endpoint.GrantID)
			if grant := b.grants[endpoint.GrantID]; grant != nil && !grant.RevokedAt.IsZero() {
				delete(b.grants, endpoint.GrantID)
			}
		}
	}
}

func validSecret(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	encoded := strings.TrimPrefix(value, prefix)
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(decoded) == secretByteCount && base64.RawURLEncoding.EncodeToString(decoded) == encoded
}

func randomIdentifier() (string, error) {
	value := make([]byte, 18)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate random identifier: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
