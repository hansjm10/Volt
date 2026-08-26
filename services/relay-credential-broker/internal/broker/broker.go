package broker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
)

var (
	ErrClaimCapacity          = errors.New("pairing claim capacity reached")
	ErrEndpointCapacity       = errors.New("endpoint credential capacity reached")
	ErrAppEndpointCapacity    = errors.New("app endpoint capacity reached for grant")
	ErrInvalidHostNodeID      = errors.New("invalid host node ID")
	ErrInvalidAppNodeID       = errors.New("invalid app node ID")
	ErrInvalidSecretHash      = errors.New("invalid secret hash")
	ErrClaimNotFound          = errors.New("pairing claim not found")
	ErrClaimExpired           = errors.New("pairing claim expired")
	ErrClaimPending           = errors.New("pairing claim pending")
	ErrClaimUnauthorized      = errors.New("pairing claim unauthorized")
	ErrClaimConflict          = errors.New("pairing claim conflicts with existing approval")
	ErrRefreshHashConflict    = errors.New("refresh credential hash already exists")
	ErrRefreshInvalid         = errors.New("refresh credential invalid")
	ErrRefreshExpired         = errors.New("refresh credential expired")
	ErrRefreshThrottled       = errors.New("refresh credential used too frequently")
	ErrGrantRevoked           = errors.New("daemon identity grant revoked")
	ErrEndpointNotFound       = errors.New("endpoint credential not found")
	ErrEndpointForbidden      = errors.New("endpoint credential is outside host grant")
	ErrAppCheckInvalid        = errors.New("verified App Check token is invalid")
	ErrAppCheckReplay         = errors.New("Firebase App Check token was already consumed")
	ErrSubscriptionRequired   = errors.New("active Volt Pro subscription required")
	ErrSubscriptionConflict   = errors.New("subscription does not match daemon grant")
	ErrSubscriptionSuperseded = errors.New("pairing claim was superseded by a newer daemon")
	ErrAppStoreProofReplay    = errors.New("App Store approval proof was already used for another claim")
)

var (
	nodeIDPattern           = regexp.MustCompile(`^[0-9a-f]{64}$`)
	appTransactionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

const (
	claimSecretPrefix                   = "vpc_"
	refreshPrefix                       = "vrr_"
	secretByteCount                     = 32
	MaxClaimTTL                         = 30 * time.Minute
	MaxAccessTokenTTL                   = time.Hour
	MaxRefreshInactivityTTL             = 90 * 24 * time.Hour
	claimRetention                      = 24 * time.Hour
	endpointTombstoneRetention          = 30 * 24 * time.Hour
	appCheckPruneSkew                   = 30 * time.Second
	appStoreNotificationRetention       = 90 * 24 * time.Hour
	claimCapacityLockID           int64 = 8_606_146_524_991_413_122
	endpointCapacityLockID        int64 = 8_606_146_524_991_413_123
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
	pool   *pgxpool.Pool
	signer *credential.Signer
	config Config
	now    func() time.Time
}

type AppCheckProof struct {
	AppID           string
	JTIHash         SecretHash
	ExpiresAt       time.Time
	ReplayProtected bool
}

type pairingClaim struct {
	ID                       string
	SecretHash               SecretHash
	HostNodeID               string
	CreatedAt                time.Time
	ExpiresAt                time.Time
	GrantID                  string
	HasGrant                 bool
	BootstrapHostRefreshHash SecretHash
	HasBootstrapHostRefresh  bool
	ApprovedAppEndpointID    string
	ApprovedAt               pgtype.Timestamptz
}

type grantRecord struct {
	ID         string
	HostNodeID string
	RevokedAt  pgtype.Timestamptz
}

type entitlementRecord struct {
	AppTransactionID    string
	Environment         string
	ProductID           pgtype.Text
	SubscriptionGroupID pgtype.Text
	Status              string
	EntitledUntil       pgtype.Timestamptz
	SourceSignedAt      time.Time
	LastVerifiedAt      time.Time
}

type endpointRecord struct {
	ID                       string
	NodeID                   string
	Kind                     string
	GrantID                  string
	RefreshHash              SecretHash
	RefreshInactiveExpiresAt time.Time
	LastRefreshedAt          pgtype.Timestamptz
	RevokedAt                pgtype.Timestamptz
}

type PairingClaim struct {
	ClaimID   string    `json:"claimId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type EntitlementRefreshState struct {
	AppTransactionID string
	Environment      string
	Status           string
	EntitledUntil    pgtype.Timestamptz
	LastVerifiedAt   time.Time
}

func (state EntitlementRefreshState) Active(now time.Time) bool {
	return (state.Status == string(appstore.StatusActive) ||
		state.Status == string(appstore.StatusGrace)) &&
		state.EntitledUntil.Valid && now.Before(state.EntitledUntil.Time)
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

func New(pool *pgxpool.Pool, signer *credential.Signer, config Config, now func() time.Time) (*Broker, error) {
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
	if pool == nil {
		return nil, errors.New("PostgreSQL pool is required")
	}
	if now == nil {
		now = time.Now
	}
	return &Broker{pool: pool, signer: signer, config: config, now: now}, nil
}

func ValidNodeID(nodeID string) bool {
	return nodeIDPattern.MatchString(nodeID)
}

func ParseSecretHash(value string) (SecretHash, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return SecretHash{}, ErrInvalidSecretHash
	}
	return secretHashFromBytes(decoded)
}

func (b *Broker) CreateBootstrapPairingClaim(ctx context.Context, hostNodeID string, claimSecretHash, hostRefreshHash SecretHash) (PairingClaim, error) {
	if !ValidNodeID(hostNodeID) {
		return PairingClaim{}, ErrInvalidHostNodeID
	}
	if subtle.ConstantTimeCompare(claimSecretHash[:], hostRefreshHash[:]) == 1 {
		return PairingClaim{}, ErrClaimConflict
	}
	return b.createPairingClaim(ctx, hostNodeID, "", claimSecretHash, hostRefreshHash, true)
}

func (b *Broker) CreatePairingClaimForGrant(ctx context.Context, hostRefreshToken string, claimSecretHash SecretHash) (PairingClaim, error) {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PairingClaim{}, fmt.Errorf("begin create pairing claim: %w", err)
	}
	defer rollback(transaction)
	now := b.now().UTC()
	grant, host, _, err := b.lockEndpointForRefresh(ctx, transaction, hostRefreshToken)
	if err != nil {
		return PairingClaim{}, err
	}
	if host.Kind != "host" {
		return PairingClaim{}, ErrEndpointForbidden
	}
	if err := b.requireActiveEndpoint(ctx, transaction, grant, host, host, now, true); err != nil {
		if errors.Is(err, ErrRefreshExpired) {
			if commitErr := transaction.Commit(ctx); commitErr != nil {
				return PairingClaim{}, fmt.Errorf("commit host expiry: %w", commitErr)
			}
		}
		return PairingClaim{}, err
	}
	if subtle.ConstantTimeCompare(claimSecretHash[:], host.RefreshHash[:]) == 1 {
		return PairingClaim{}, ErrClaimConflict
	}
	claim, err := b.insertPairingClaim(ctx, transaction, now, host.NodeID, grant.ID, claimSecretHash, SecretHash{}, false)
	if err != nil {
		return PairingClaim{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return PairingClaim{}, fmt.Errorf("commit pairing claim: %w", err)
	}
	return claim, nil
}

func (b *Broker) createPairingClaim(
	ctx context.Context,
	hostNodeID string,
	grantID string,
	claimSecretHash SecretHash,
	hostRefreshHash SecretHash,
	bootstrap bool,
) (PairingClaim, error) {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PairingClaim{}, fmt.Errorf("begin create pairing claim: %w", err)
	}
	defer rollback(transaction)
	claim, err := b.insertPairingClaim(ctx, transaction, b.now().UTC(), hostNodeID, grantID, claimSecretHash, hostRefreshHash, bootstrap)
	if err != nil {
		return PairingClaim{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return PairingClaim{}, fmt.Errorf("commit pairing claim: %w", err)
	}
	return claim, nil
}

func (b *Broker) insertPairingClaim(
	ctx context.Context,
	transaction pgx.Tx,
	now time.Time,
	hostNodeID string,
	grantID string,
	claimSecretHash SecretHash,
	hostRefreshHash SecretHash,
	bootstrap bool,
) (PairingClaim, error) {
	if _, err := transaction.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", claimCapacityLockID); err != nil {
		return PairingClaim{}, fmt.Errorf("lock pairing claim capacity: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		DELETE FROM pairing_claims WHERE expires_at <= $1
	`, now.Add(-claimRetention)); err != nil {
		return PairingClaim{}, fmt.Errorf("delete retained pairing claims: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		DELETE FROM pairing_claims
		WHERE claim_secret_hash = $1 AND expires_at <= $2
	`, claimSecretHash[:], now); err != nil {
		return PairingClaim{}, fmt.Errorf("remove expired pairing claim conflict: %w", err)
	}
	var count int
	if err := transaction.QueryRow(ctx, `
		SELECT count(*) FROM pairing_claims WHERE expires_at > $1
	`, now).Scan(&count); err != nil {
		return PairingClaim{}, fmt.Errorf("count active pairing claims: %w", err)
	}
	if count >= b.config.MaxClaims {
		return PairingClaim{}, ErrClaimCapacity
	}
	claimID, err := randomIdentifier()
	if err != nil {
		return PairingClaim{}, err
	}
	expiresAt := now.Add(b.config.ClaimTTL)
	var grantValue any
	var bootstrapHashValue any
	if bootstrap {
		bootstrapHashValue = hostRefreshHash[:]
	} else {
		grantValue = grantID
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO pairing_claims (
			id, claim_secret_hash, host_node_id, grant_id,
			bootstrap_host_refresh_hash, created_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, claimID, claimSecretHash[:], hostNodeID, grantValue, bootstrapHashValue, now, expiresAt); err != nil {
		if isUniqueViolation(err) {
			return PairingClaim{}, ErrClaimConflict
		}
		return PairingClaim{}, fmt.Errorf("insert pairing claim: %w", err)
	}
	return PairingClaim{ClaimID: claimID, ExpiresAt: expiresAt}, nil
}

func (b *Broker) ApprovePairingClaim(
	ctx context.Context,
	claimID string,
	appCheck AppCheckProof,
	entitlement appstore.Entitlement,
	appNodeID string,
	appRefreshHash SecretHash,
) (Approval, error) {
	if strings.TrimSpace(appCheck.AppID) == "" {
		return Approval{}, ErrAppCheckInvalid
	}
	if !ValidNodeID(appNodeID) {
		return Approval{}, ErrInvalidAppNodeID
	}
	now := b.now().UTC()
	if appCheck.ReplayProtected && !now.Before(appCheck.ExpiresAt) {
		return Approval{}, ErrAppCheckInvalid
	}
	if !entitlement.Active(now) {
		return Approval{}, ErrSubscriptionRequired
	}

	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Approval{}, fmt.Errorf("begin pairing approval: %w", err)
	}
	defer rollback(transaction)
	if appCheck.ReplayProtected {
		if _, err := transaction.Exec(ctx, `
			DELETE FROM consumed_app_check_tokens WHERE expires_at <= $1
		`, now.Add(-appCheckPruneSkew)); err != nil {
			return Approval{}, fmt.Errorf("prune consumed App Check tokens: %w", err)
		}
		result, err := transaction.Exec(ctx, `
			INSERT INTO consumed_app_check_tokens (jti_hash, expires_at, consumed_at)
			VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING
		`, appCheck.JTIHash[:], appCheck.ExpiresAt, now)
		if err != nil {
			return Approval{}, fmt.Errorf("consume App Check token: %w", err)
		}
		if result.RowsAffected() != 1 {
			return Approval{}, ErrAppCheckReplay
		}
	}
	currentEntitlement, err := upsertAndLockEntitlement(
		ctx,
		transaction,
		entitlement,
		now,
	)
	if err != nil {
		return Approval{}, err
	}
	if !currentEntitlement.active(now) {
		return Approval{}, ErrSubscriptionRequired
	}

	claim, err := lockPairingClaim(ctx, transaction, claimID)
	if err != nil {
		return Approval{}, err
	}
	if !now.Before(claim.ExpiresAt) {
		return Approval{}, ErrClaimExpired
	}
	if err := consumeAppStoreApprovalProof(
		ctx,
		transaction,
		claim.ID,
		entitlement,
		now,
	); err != nil {
		return Approval{}, err
	}
	if claim.ApprovedAppEndpointID != "" {
		approval, app, err := b.retryApproval(
			ctx,
			transaction,
			claim,
			entitlement.AppTransactionID,
			appNodeID,
			appRefreshHash,
			now,
		)
		if err != nil {
			return Approval{}, err
		}
		if err := transaction.Commit(ctx); err != nil {
			return Approval{}, fmt.Errorf("commit pairing approval retry: %w", err)
		}
		access, err := b.issueAccessToken(ctx, app, now)
		if err != nil {
			return Approval{}, err
		}
		approval.Credential = access
		return approval, nil
	}
	if claim.HasBootstrapHostRefresh && subtle.ConstantTimeCompare(appRefreshHash[:], claim.BootstrapHostRefreshHash[:]) == 1 {
		return Approval{}, ErrRefreshHashConflict
	}

	neededEndpoints := 1
	if claim.HasBootstrapHostRefresh {
		neededEndpoints = 2
	}
	if err := b.ensureEndpointCapacity(ctx, transaction, neededEndpoints, now); err != nil {
		return Approval{}, err
	}

	var grant grantRecord
	var host endpointRecord
	if claim.HasBootstrapHostRefresh {
		if err := transaction.QueryRow(ctx, `
			INSERT INTO grants (host_node_id, created_at)
			VALUES ($1, $2)
			RETURNING id::text, host_node_id, revoked_at
		`, claim.HostNodeID, now).Scan(&grant.ID, &grant.HostNodeID, &grant.RevokedAt); err != nil {
			return Approval{}, fmt.Errorf("create grant: %w", err)
		}
		host, err = insertEndpoint(ctx, transaction, grant.ID, "host", claim.HostNodeID, claim.BootstrapHostRefreshHash, now, b.config.RefreshInactivityTTL)
		if err != nil {
			return Approval{}, mapEndpointInsertError(err)
		}
	} else {
		grant, err = lockGrant(ctx, transaction, claim.GrantID)
		if err != nil {
			return Approval{}, err
		}
		if grant.RevokedAt.Valid {
			return Approval{}, ErrGrantRevoked
		}
		host, err = lockHostEndpoint(ctx, transaction, grant.ID)
		if err != nil {
			return Approval{}, err
		}
		if host.RevokedAt.Valid {
			return Approval{}, ErrRefreshInvalid
		}
		if !now.Before(host.RefreshInactiveExpiresAt) {
			return Approval{}, ErrRefreshExpired
		}
		var appCount int
		if err := transaction.QueryRow(ctx, `
			SELECT count(*)
			FROM endpoints
			WHERE grant_id = $1 AND kind = 'app'
			  AND revoked_at IS NULL AND refresh_inactive_expires_at > $2
		`, grant.ID, now).Scan(&appCount); err != nil {
			return Approval{}, fmt.Errorf("count active app endpoints: %w", err)
		}
		if appCount >= b.config.MaxAppEndpointsPerGrant {
			return Approval{}, ErrAppEndpointCapacity
		}
	}

	if err := bindEntitlementToGrant(
		ctx,
		transaction,
		entitlement.AppTransactionID,
		grant.ID,
		claim.CreatedAt,
		now,
	); err != nil {
		return Approval{}, err
	}

	app, err := insertEndpoint(ctx, transaction, grant.ID, "app", appNodeID, appRefreshHash, now, b.config.RefreshInactivityTTL)
	if err != nil {
		return Approval{}, mapEndpointInsertError(err)
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE pairing_claims
		SET grant_id = $2, approved_app_endpoint_id = $3, approved_at = $4
		WHERE id = $1
	`, claim.ID, grant.ID, app.ID, now); err != nil {
		return Approval{}, fmt.Errorf("record pairing approval: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return Approval{}, fmt.Errorf("commit pairing approval: %w", err)
	}
	access, err := b.issueAccessToken(ctx, app, now)
	if err != nil {
		return Approval{}, err
	}
	return Approval{
		GrantID:    grant.ID,
		EndpointID: app.ID,
		HostNodeID: grant.HostNodeID,
		AppNodeID:  app.NodeID,
		Credential: access,
	}, nil
}

func (b *Broker) retryApproval(
	ctx context.Context,
	transaction pgx.Tx,
	claim pairingClaim,
	appTransactionID string,
	appNodeID string,
	appRefreshHash SecretHash,
	now time.Time,
) (Approval, endpointRecord, error) {
	grant, err := lockGrant(ctx, transaction, claim.GrantID)
	if err != nil {
		return Approval{}, endpointRecord{}, err
	}
	if grant.RevokedAt.Valid {
		return Approval{}, endpointRecord{}, ErrGrantRevoked
	}
	if err := requireGrantEntitlement(
		ctx,
		transaction,
		grant.ID,
		appTransactionID,
		now,
	); err != nil {
		return Approval{}, endpointRecord{}, err
	}
	host, err := lockHostEndpoint(ctx, transaction, grant.ID)
	if err != nil {
		return Approval{}, endpointRecord{}, err
	}
	if host.RevokedAt.Valid {
		return Approval{}, endpointRecord{}, ErrRefreshInvalid
	}
	if !now.Before(host.RefreshInactiveExpiresAt) {
		return Approval{}, endpointRecord{}, ErrRefreshExpired
	}
	app, err := lockEndpoint(ctx, transaction, claim.ApprovedAppEndpointID)
	if err != nil {
		return Approval{}, endpointRecord{}, err
	}
	if app.Kind != "app" || app.GrantID != grant.ID || app.NodeID != appNodeID || subtle.ConstantTimeCompare(app.RefreshHash[:], appRefreshHash[:]) != 1 {
		return Approval{}, endpointRecord{}, ErrClaimConflict
	}
	if app.RevokedAt.Valid || !now.Before(app.RefreshInactiveExpiresAt) {
		return Approval{}, endpointRecord{}, ErrRefreshInvalid
	}
	return Approval{
		GrantID:    grant.ID,
		EndpointID: app.ID,
		HostNodeID: grant.HostNodeID,
		AppNodeID:  app.NodeID,
	}, app, nil
}

func (b *Broker) ExchangePairingClaim(ctx context.Context, claimID, claimSecret string) (Exchange, error) {
	if !validSecret(claimSecret, claimSecretPrefix) {
		return Exchange{}, ErrClaimUnauthorized
	}
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Exchange{}, fmt.Errorf("begin pairing exchange: %w", err)
	}
	defer rollback(transaction)
	now := b.now().UTC()
	claim, err := lockPairingClaim(ctx, transaction, claimID)
	if err != nil {
		return Exchange{}, err
	}
	if !now.Before(claim.ExpiresAt) {
		return Exchange{}, ErrClaimExpired
	}
	providedHash := SecretHash(sha256.Sum256([]byte(claimSecret)))
	if subtle.ConstantTimeCompare(providedHash[:], claim.SecretHash[:]) != 1 {
		return Exchange{}, ErrClaimUnauthorized
	}
	if claim.ApprovedAppEndpointID == "" {
		return Exchange{}, ErrClaimPending
	}
	grant, err := lockGrant(ctx, transaction, claim.GrantID)
	if err != nil {
		return Exchange{}, err
	}
	host, err := lockHostEndpoint(ctx, transaction, grant.ID)
	if err != nil {
		return Exchange{}, err
	}
	if err := b.requireActiveEndpoint(ctx, transaction, grant, host, host, now, true); err != nil {
		if errors.Is(err, ErrRefreshExpired) {
			if commitErr := transaction.Commit(ctx); commitErr != nil {
				return Exchange{}, fmt.Errorf("commit host expiry: %w", commitErr)
			}
		}
		return Exchange{}, err
	}
	app, err := lockEndpoint(ctx, transaction, claim.ApprovedAppEndpointID)
	if err != nil {
		return Exchange{}, err
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE pairing_claims SET exchanged_at = $2 WHERE id = $1
	`, claim.ID, now); err != nil {
		return Exchange{}, fmt.Errorf("record pairing exchange: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return Exchange{}, fmt.Errorf("commit pairing exchange: %w", err)
	}
	access, err := b.issueAccessToken(ctx, host, now)
	if err != nil {
		return Exchange{}, err
	}
	return Exchange{
		GrantID:       grant.ID,
		EndpointID:    host.ID,
		HostNodeID:    host.NodeID,
		AppEndpointID: app.ID,
		AppNodeID:     app.NodeID,
		Credential:    access,
	}, nil
}

func (b *Broker) EntitlementForRefresh(
	ctx context.Context,
	refreshToken string,
) (EntitlementRefreshState, error) {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return EntitlementRefreshState{}, fmt.Errorf("begin entitlement lookup: %w", err)
	}
	defer rollback(transaction)
	grant, endpoint, host, err := b.lockEndpointForRefresh(
		ctx,
		transaction,
		refreshToken,
	)
	if err != nil {
		return EntitlementRefreshState{}, err
	}
	if grant.RevokedAt.Valid || endpoint.RevokedAt.Valid || host.RevokedAt.Valid {
		return EntitlementRefreshState{}, ErrRefreshInvalid
	}
	var state EntitlementRefreshState
	if err := transaction.QueryRow(ctx, `
		SELECT entitlement.app_transaction_id, entitlement.environment,
		       entitlement.status, entitlement.entitled_until,
		       entitlement.last_verified_at
		FROM grant_entitlements AS binding
		JOIN app_store_entitlements AS entitlement
		  ON entitlement.app_transaction_id = binding.app_transaction_id
		WHERE binding.grant_id = $1
	`, grant.ID).Scan(
		&state.AppTransactionID,
		&state.Environment,
		&state.Status,
		&state.EntitledUntil,
		&state.LastVerifiedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return EntitlementRefreshState{}, ErrSubscriptionRequired
	} else if err != nil {
		return EntitlementRefreshState{}, fmt.Errorf("read refresh entitlement: %w", err)
	}
	return state, nil
}

func (b *Broker) ApplyEntitlementReconciliation(
	ctx context.Context,
	entitlement appstore.Entitlement,
) error {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin App Store reconciliation: %w", err)
	}
	defer rollback(transaction)
	if _, err := upsertAndLockEntitlement(
		ctx,
		transaction,
		entitlement,
		b.now().UTC(),
	); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit App Store reconciliation: %w", err)
	}
	return nil
}

func (b *Broker) RefreshAccessToken(ctx context.Context, refreshToken string) (AccessToken, error) {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return AccessToken{}, fmt.Errorf("begin credential refresh: %w", err)
	}
	defer rollback(transaction)
	now := b.now().UTC()
	grant, endpoint, host, err := b.lockEndpointForRefresh(ctx, transaction, refreshToken)
	if err != nil {
		return AccessToken{}, err
	}
	if err := b.requireActiveEndpoint(ctx, transaction, grant, endpoint, host, now, true); err != nil {
		switch {
		case errors.Is(err, ErrSubscriptionRequired):
			if heartbeatErr := recordSubscriptionSuspensionHeartbeat(
				ctx,
				transaction,
				endpoint.ID,
				host.ID,
				now.Add(b.config.RefreshInactivityTTL),
			); heartbeatErr != nil {
				return AccessToken{}, heartbeatErr
			}
			if commitErr := transaction.Commit(ctx); commitErr != nil {
				return AccessToken{}, fmt.Errorf("commit subscription suspension heartbeat: %w", commitErr)
			}
		case errors.Is(err, ErrRefreshExpired):
			if commitErr := transaction.Commit(ctx); commitErr != nil {
				return AccessToken{}, fmt.Errorf("commit credential expiry: %w", commitErr)
			}
		}
		return AccessToken{}, err
	}
	if endpoint.LastRefreshedAt.Valid && now.Sub(endpoint.LastRefreshedAt.Time) < b.config.RefreshMinInterval {
		return AccessToken{}, ErrRefreshThrottled
	}
	endpoint.LastRefreshedAt = pgtype.Timestamptz{Time: now, Valid: true}
	endpoint.RefreshInactiveExpiresAt = now.Add(b.config.RefreshInactivityTTL)
	if _, err := transaction.Exec(ctx, `
		UPDATE endpoints
		SET last_refreshed_at = $2, refresh_inactive_expires_at = $3
		WHERE id = $1
	`, endpoint.ID, now, endpoint.RefreshInactiveExpiresAt); err != nil {
		return AccessToken{}, fmt.Errorf("update credential refresh: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return AccessToken{}, fmt.Errorf("commit credential refresh: %w", err)
	}
	return b.issueAccessToken(ctx, endpoint, now)
}

func (b *Broker) RevokeRefreshToken(ctx context.Context, refreshToken string) error {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin endpoint revocation: %w", err)
	}
	defer rollback(transaction)
	now := b.now().UTC()
	_, endpoint, _, err := b.lockEndpointForRefresh(ctx, transaction, refreshToken)
	if err != nil {
		return err
	}
	if endpoint.Kind == "host" {
		if err := revokeGrant(ctx, transaction, endpoint.GrantID, now); err != nil {
			return err
		}
	} else if _, err := transaction.Exec(ctx, `
		UPDATE endpoints SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1
	`, endpoint.ID, now); err != nil {
		return fmt.Errorf("revoke endpoint: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit endpoint revocation: %w", err)
	}
	return nil
}

func (b *Broker) RevokeAppEndpoint(ctx context.Context, hostRefreshToken, appEndpointID string) error {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin app endpoint revocation: %w", err)
	}
	defer rollback(transaction)
	now := b.now().UTC()
	grant, host, _, err := b.lockEndpointForRefresh(ctx, transaction, hostRefreshToken)
	if err != nil {
		return err
	}
	if host.Kind != "host" {
		return ErrEndpointForbidden
	}
	if err := b.requireActiveEndpoint(ctx, transaction, grant, host, host, now, true); err != nil {
		if errors.Is(err, ErrRefreshExpired) {
			if commitErr := transaction.Commit(ctx); commitErr != nil {
				return fmt.Errorf("commit host expiry: %w", commitErr)
			}
		}
		return err
	}
	var targetGrantID string
	var targetKind string
	err = transaction.QueryRow(ctx, `
		SELECT grant_id::text, kind FROM endpoints WHERE id = $1
	`, appEndpointID).Scan(&targetGrantID, &targetKind)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrEndpointNotFound
	}
	if err != nil {
		return fmt.Errorf("find app endpoint: %w", err)
	}
	if targetKind != "app" || targetGrantID != grant.ID {
		return ErrEndpointForbidden
	}
	app, err := lockEndpoint(ctx, transaction, appEndpointID)
	if err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE endpoints SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1
	`, app.ID, now); err != nil {
		return fmt.Errorf("revoke app endpoint: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit app endpoint revocation: %w", err)
	}
	return nil
}

func (b *Broker) RevokeGrant(ctx context.Context, hostRefreshToken string) error {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin grant revocation: %w", err)
	}
	defer rollback(transaction)
	grant, host, _, err := b.lockEndpointForRefresh(ctx, transaction, hostRefreshToken)
	if err != nil {
		return err
	}
	if host.Kind != "host" {
		return ErrEndpointForbidden
	}
	if err := revokeGrant(ctx, transaction, grant.ID, b.now().UTC()); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit grant revocation: %w", err)
	}
	return nil
}

func (b *Broker) ensureEndpointCapacity(ctx context.Context, transaction pgx.Tx, needed int, now time.Time) error {
	if _, err := transaction.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", endpointCapacityLockID); err != nil {
		return fmt.Errorf("lock endpoint capacity: %w", err)
	}
	var count int
	if err := transaction.QueryRow(ctx, "SELECT count(*) FROM endpoints").Scan(&count); err != nil {
		return fmt.Errorf("count endpoints: %w", err)
	}
	if count+needed <= b.config.MaxEndpoints {
		return nil
	}
	if err := cleanupRetainedState(ctx, transaction, now); err != nil {
		return err
	}
	if err := transaction.QueryRow(ctx, "SELECT count(*) FROM endpoints").Scan(&count); err != nil {
		return fmt.Errorf("count endpoints after cleanup: %w", err)
	}
	if count+needed > b.config.MaxEndpoints {
		return ErrEndpointCapacity
	}
	return nil
}

func cleanupRetainedState(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	grantRows, err := transaction.Query(ctx, `
		SELECT id FROM grants ORDER BY id FOR UPDATE
	`)
	if err != nil {
		return fmt.Errorf("lock grants for retained state cleanup: %w", err)
	}
	for grantRows.Next() {
		var grantID pgtype.UUID
		if err := grantRows.Scan(&grantID); err != nil {
			grantRows.Close()
			return fmt.Errorf("read grant during retained state cleanup: %w", err)
		}
	}
	if err := grantRows.Err(); err != nil {
		grantRows.Close()
		return fmt.Errorf("lock grants for retained state cleanup: %w", err)
	}
	grantRows.Close()

	if _, err := transaction.Exec(ctx, `
		UPDATE endpoints
		SET revoked_at = $1
		WHERE kind = 'app' AND revoked_at IS NULL
		  AND refresh_inactive_expires_at <= $1
	`, now); err != nil {
		return fmt.Errorf("expire inactive app endpoints: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE grants
		SET revoked_at = $1
		WHERE revoked_at IS NULL AND EXISTS (
			SELECT 1 FROM endpoints
			WHERE endpoints.grant_id = grants.id
			  AND endpoints.kind = 'host'
			  AND endpoints.refresh_inactive_expires_at <= $1
		)
	`, now); err != nil {
		return fmt.Errorf("expire inactive grants: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE endpoints
		SET revoked_at = $1
		WHERE revoked_at IS NULL AND grant_id IN (
			SELECT id FROM grants WHERE revoked_at IS NOT NULL
		)
	`, now); err != nil {
		return fmt.Errorf("cascade expired grants: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		DELETE FROM pairing_claims WHERE expires_at <= $1
	`, now.Add(-claimRetention)); err != nil {
		return fmt.Errorf("delete retained pairing claims: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		DELETE FROM endpoints WHERE revoked_at <= $1
	`, now.Add(-endpointTombstoneRetention)); err != nil {
		return fmt.Errorf("delete endpoint tombstones: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		DELETE FROM grants
		WHERE revoked_at <= $1
		  AND NOT EXISTS (SELECT 1 FROM endpoints WHERE endpoints.grant_id = grants.id)
		  AND NOT EXISTS (SELECT 1 FROM pairing_claims WHERE pairing_claims.grant_id = grants.id)
	`, now.Add(-endpointTombstoneRetention)); err != nil {
		return fmt.Errorf("delete grant tombstones: %w", err)
	}
	return nil
}

func (b *Broker) lockEndpointForRefresh(
	ctx context.Context,
	transaction pgx.Tx,
	refreshToken string,
) (grantRecord, endpointRecord, endpointRecord, error) {
	if !validSecret(refreshToken, refreshPrefix) {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, ErrRefreshInvalid
	}
	hash := SecretHash(sha256.Sum256([]byte(refreshToken)))
	var endpointID string
	var grantID string
	if err := transaction.QueryRow(ctx, `
		SELECT id::text, grant_id::text
		FROM endpoints
		WHERE refresh_token_hash = $1
	`, hash[:]).Scan(&endpointID, &grantID); errors.Is(err, pgx.ErrNoRows) {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, ErrRefreshInvalid
	} else if err != nil {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, fmt.Errorf("find refresh credential: %w", err)
	}
	grant, err := lockGrant(ctx, transaction, grantID)
	if err != nil {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, err
	}
	host, err := lockHostEndpoint(ctx, transaction, grant.ID)
	if errors.Is(err, ErrEndpointNotFound) {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, ErrRefreshInvalid
	}
	if err != nil {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, err
	}
	if endpointID == host.ID {
		return grant, host, host, nil
	}
	endpoint, err := lockEndpoint(ctx, transaction, endpointID)
	if errors.Is(err, ErrEndpointNotFound) {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, ErrRefreshInvalid
	}
	if err != nil {
		return grantRecord{}, endpointRecord{}, endpointRecord{}, err
	}
	return grant, endpoint, host, nil
}

func (b *Broker) requireActiveEndpoint(
	ctx context.Context,
	transaction pgx.Tx,
	grant grantRecord,
	endpoint endpointRecord,
	host endpointRecord,
	now time.Time,
	recordExpiry bool,
) error {
	if grant.RevokedAt.Valid || host.RevokedAt.Valid || endpoint.RevokedAt.Valid {
		return ErrRefreshInvalid
	}
	if err := requireActiveGrantEntitlement(
		ctx,
		transaction,
		grant.ID,
		now,
	); err != nil {
		return err
	}
	if !now.Before(host.RefreshInactiveExpiresAt) {
		if recordExpiry {
			if err := revokeGrant(ctx, transaction, grant.ID, now); err != nil {
				return err
			}
		}
		return ErrRefreshExpired
	}
	if now.Before(endpoint.RefreshInactiveExpiresAt) {
		return nil
	}
	if recordExpiry {
		if _, err := transaction.Exec(ctx, `
			UPDATE endpoints SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1
		`, endpoint.ID, now); err != nil {
			return fmt.Errorf("expire endpoint: %w", err)
		}
	}
	return ErrRefreshExpired
}

func recordSubscriptionSuspensionHeartbeat(
	ctx context.Context,
	transaction pgx.Tx,
	endpointID string,
	hostEndpointID string,
	expiresAt time.Time,
) error {
	if _, err := transaction.Exec(ctx, `
		UPDATE endpoints
		SET refresh_inactive_expires_at = $3
		WHERE id IN ($1, $2) AND revoked_at IS NULL
	`, endpointID, hostEndpointID, expiresAt); err != nil {
		return fmt.Errorf("record subscription suspension heartbeat: %w", err)
	}
	return nil
}

func (record entitlementRecord) active(now time.Time) bool {
	return (record.Status == string(appstore.StatusActive) ||
		record.Status == string(appstore.StatusGrace)) &&
		record.EntitledUntil.Valid && now.Before(record.EntitledUntil.Time)
}

func consumeAppStoreApprovalProof(
	ctx context.Context,
	transaction pgx.Tx,
	claimID string,
	entitlement appstore.Entitlement,
	now time.Time,
) error {
	var zeroHash [sha256.Size]byte
	if entitlement.ApprovalProofHash == zeroHash ||
		entitlement.ProofCreatedAt.IsZero() ||
		entitlement.ProofCreatedAt.Before(now.Add(-10*time.Minute)) ||
		entitlement.ProofCreatedAt.After(now.Add(time.Minute)) {
		return ErrSubscriptionRequired
	}
	result, err := transaction.Exec(ctx, `
		INSERT INTO app_store_approval_proofs (
			proof_identity_hash, claim_id, app_transaction_id,
			proof_created_at, consumed_at
		)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT DO NOTHING
	`, entitlement.ApprovalProofHash[:], claimID,
		entitlement.AppTransactionID, entitlement.ProofCreatedAt, now)
	if err != nil {
		return fmt.Errorf("consume App Store approval proof: %w", err)
	}
	if result.RowsAffected() == 1 {
		return nil
	}
	var existingClaimID string
	var existingAppTransactionID string
	if err := transaction.QueryRow(ctx, `
		SELECT claim_id, app_transaction_id
		FROM app_store_approval_proofs
		WHERE proof_identity_hash = $1
	`, entitlement.ApprovalProofHash[:]).Scan(
		&existingClaimID,
		&existingAppTransactionID,
	); err != nil {
		return fmt.Errorf("read App Store approval proof: %w", err)
	}
	if existingClaimID != claimID ||
		existingAppTransactionID != entitlement.AppTransactionID {
		return ErrAppStoreProofReplay
	}
	return nil
}

func upsertAndLockEntitlement(
	ctx context.Context,
	transaction pgx.Tx,
	entitlement appstore.Entitlement,
	now time.Time,
) (entitlementRecord, error) {
	if !appTransactionIDPattern.MatchString(entitlement.AppTransactionID) ||
		(entitlement.Environment != "Production" && entitlement.Environment != "Sandbox") ||
		entitlement.SourceSignedAt.IsZero() || entitlement.VerifiedAt.IsZero() {
		return entitlementRecord{}, ErrSubscriptionRequired
	}
	switch entitlement.Status {
	case appstore.StatusActive, appstore.StatusGrace:
		if entitlement.EntitledUntil.IsZero() {
			return entitlementRecord{}, ErrSubscriptionRequired
		}
	case appstore.StatusBillingRetry, appstore.StatusExpired,
		appstore.StatusRevoked, appstore.StatusInactive:
	default:
		return entitlementRecord{}, ErrSubscriptionRequired
	}
	var entitledUntil any
	if !entitlement.EntitledUntil.IsZero() {
		entitledUntil = entitlement.EntitledUntil.UTC()
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO app_store_entitlements (
			app_transaction_id, environment, product_id,
			subscription_group_id, status, entitled_until,
			source_signed_at, last_verified_at, updated_at
		)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, $8, $8)
		ON CONFLICT (app_transaction_id) DO UPDATE SET
			environment = EXCLUDED.environment,
			product_id = EXCLUDED.product_id,
			subscription_group_id = EXCLUDED.subscription_group_id,
			status = EXCLUDED.status,
			entitled_until = EXCLUDED.entitled_until,
			source_signed_at = EXCLUDED.source_signed_at,
			last_verified_at = EXCLUDED.last_verified_at,
			updated_at = EXCLUDED.updated_at
		WHERE EXCLUDED.source_signed_at > app_store_entitlements.source_signed_at
		   OR (
		       EXCLUDED.source_signed_at = app_store_entitlements.source_signed_at
		       AND EXCLUDED.last_verified_at >= app_store_entitlements.last_verified_at
		   )
	`, entitlement.AppTransactionID, entitlement.Environment,
		entitlement.ProductID, entitlement.SubscriptionGroupID,
		string(entitlement.Status), entitledUntil,
		entitlement.SourceSignedAt.UTC(), entitlement.VerifiedAt.UTC()); err != nil {
		return entitlementRecord{}, fmt.Errorf("upsert App Store entitlement: %w", err)
	}
	var record entitlementRecord
	if err := transaction.QueryRow(ctx, `
		SELECT app_transaction_id, environment, product_id,
		       subscription_group_id, status, entitled_until,
		       source_signed_at, last_verified_at
		FROM app_store_entitlements
		WHERE app_transaction_id = $1
		FOR UPDATE
	`, entitlement.AppTransactionID).Scan(
		&record.AppTransactionID,
		&record.Environment,
		&record.ProductID,
		&record.SubscriptionGroupID,
		&record.Status,
		&record.EntitledUntil,
		&record.SourceSignedAt,
		&record.LastVerifiedAt,
	); err != nil {
		return entitlementRecord{}, fmt.Errorf("lock App Store entitlement: %w", err)
	}
	if record.Environment != entitlement.Environment {
		return entitlementRecord{}, ErrSubscriptionConflict
	}
	return record, nil
}

func bindEntitlementToGrant(
	ctx context.Context,
	transaction pgx.Tx,
	appTransactionID string,
	grantID string,
	claimCreatedAt time.Time,
	now time.Time,
) error {
	var previousGrantID string
	var previousClaimCreatedAt time.Time
	err := transaction.QueryRow(ctx, `
		SELECT grant_id::text, bound_claim_created_at
		FROM grant_entitlements
		WHERE app_transaction_id = $1
		FOR UPDATE
	`, appTransactionID).Scan(&previousGrantID, &previousClaimCreatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock subscription grant binding: %w", err)
	}
	if err == nil && previousGrantID != grantID {
		if previousClaimCreatedAt.After(claimCreatedAt) {
			return ErrSubscriptionSuperseded
		}
		if err := revokeGrant(ctx, transaction, previousGrantID, now); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `
			DELETE FROM grant_entitlements WHERE grant_id = $1
		`, previousGrantID); err != nil {
			return fmt.Errorf("release previous subscription grant: %w", err)
		}
	}

	var targetAppTransactionID string
	err = transaction.QueryRow(ctx, `
		SELECT app_transaction_id
		FROM grant_entitlements
		WHERE grant_id = $1
		FOR UPDATE
	`, grantID).Scan(&targetAppTransactionID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock target subscription grant: %w", err)
	}
	if err == nil && targetAppTransactionID != appTransactionID {
		return ErrSubscriptionConflict
	}
	if err == nil {
		return nil
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO grant_entitlements (
			grant_id, app_transaction_id, bound_claim_created_at, bound_at
		)
		VALUES ($1, $2, $3, $4)
	`, grantID, appTransactionID, claimCreatedAt, now); err != nil {
		if isUniqueViolation(err) {
			return ErrSubscriptionConflict
		}
		return fmt.Errorf("bind subscription to grant: %w", err)
	}
	return nil
}

func requireGrantEntitlement(
	ctx context.Context,
	transaction pgx.Tx,
	grantID string,
	expectedAppTransactionID string,
	now time.Time,
) error {
	var record entitlementRecord
	if err := transaction.QueryRow(ctx, `
		SELECT entitlement.app_transaction_id, entitlement.status,
		       entitlement.entitled_until
		FROM grant_entitlements AS binding
		JOIN app_store_entitlements AS entitlement
		  ON entitlement.app_transaction_id = binding.app_transaction_id
		WHERE binding.grant_id = $1
	`, grantID).Scan(
		&record.AppTransactionID,
		&record.Status,
		&record.EntitledUntil,
	); errors.Is(err, pgx.ErrNoRows) {
		return ErrSubscriptionRequired
	} else if err != nil {
		return fmt.Errorf("read grant subscription: %w", err)
	}
	if expectedAppTransactionID != "" && record.AppTransactionID != expectedAppTransactionID {
		return ErrSubscriptionConflict
	}
	if !record.active(now) {
		return ErrSubscriptionRequired
	}
	return nil
}

func requireActiveGrantEntitlement(
	ctx context.Context,
	transaction pgx.Tx,
	grantID string,
	now time.Time,
) error {
	return requireGrantEntitlement(ctx, transaction, grantID, "", now)
}

func (b *Broker) ApplyEntitlementNotification(
	ctx context.Context,
	notification appstore.Notification,
) error {
	transaction, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin App Store notification: %w", err)
	}
	defer rollback(transaction)
	now := b.now().UTC()
	if _, err := upsertAndLockEntitlement(
		ctx,
		transaction,
		notification.Entitlement,
		now,
	); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		DELETE FROM app_store_notifications WHERE received_at <= $1
	`, now.Add(-appStoreNotificationRetention)); err != nil {
		return fmt.Errorf("prune App Store notifications: %w", err)
	}
	result, err := transaction.Exec(ctx, `
		INSERT INTO app_store_notifications (
			notification_uuid, app_transaction_id,
			source_signed_at, received_at
		)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT DO NOTHING
	`, notification.UUID, notification.Entitlement.AppTransactionID,
		notification.Entitlement.SourceSignedAt, now)
	if err != nil {
		return fmt.Errorf("record App Store notification: %w", err)
	}
	if result.RowsAffected() == 0 {
		return transaction.Commit(ctx)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit App Store notification: %w", err)
	}
	return nil
}

func lockPairingClaim(ctx context.Context, transaction pgx.Tx, claimID string) (pairingClaim, error) {
	var claim pairingClaim
	var secretHash []byte
	var grantID pgtype.Text
	var bootstrapHash []byte
	var approvedEndpointID pgtype.Text
	err := transaction.QueryRow(ctx, `
		SELECT id, claim_secret_hash, host_node_id, created_at, expires_at,
		       grant_id::text, bootstrap_host_refresh_hash,
		       approved_app_endpoint_id::text, approved_at
		FROM pairing_claims
		WHERE id = $1
		FOR UPDATE
	`, claimID).Scan(
		&claim.ID,
		&secretHash,
		&claim.HostNodeID,
		&claim.CreatedAt,
		&claim.ExpiresAt,
		&grantID,
		&bootstrapHash,
		&approvedEndpointID,
		&claim.ApprovedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return pairingClaim{}, ErrClaimNotFound
	}
	if err != nil {
		return pairingClaim{}, fmt.Errorf("lock pairing claim: %w", err)
	}
	claim.SecretHash, err = secretHashFromBytes(secretHash)
	if err != nil {
		return pairingClaim{}, fmt.Errorf("read pairing claim secret hash: %w", err)
	}
	if grantID.Valid {
		claim.GrantID = grantID.String
		claim.HasGrant = true
	}
	if bootstrapHash != nil {
		claim.BootstrapHostRefreshHash, err = secretHashFromBytes(bootstrapHash)
		if err != nil {
			return pairingClaim{}, fmt.Errorf("read bootstrap refresh hash: %w", err)
		}
		claim.HasBootstrapHostRefresh = true
	}
	if approvedEndpointID.Valid {
		claim.ApprovedAppEndpointID = approvedEndpointID.String
	}
	return claim, nil
}

func lockGrant(ctx context.Context, transaction pgx.Tx, grantID string) (grantRecord, error) {
	var grant grantRecord
	err := transaction.QueryRow(ctx, `
		SELECT id::text, host_node_id, revoked_at
		FROM grants
		WHERE id = $1
		FOR UPDATE
	`, grantID).Scan(&grant.ID, &grant.HostNodeID, &grant.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return grantRecord{}, ErrGrantRevoked
	}
	if err != nil {
		return grantRecord{}, fmt.Errorf("lock grant: %w", err)
	}
	return grant, nil
}

func lockHostEndpoint(ctx context.Context, transaction pgx.Tx, grantID string) (endpointRecord, error) {
	return scanEndpoint(transaction.QueryRow(ctx, `
		SELECT id::text, node_id, kind, grant_id::text, refresh_token_hash,
		       refresh_inactive_expires_at, last_refreshed_at, revoked_at
		FROM endpoints
		WHERE grant_id = $1 AND kind = 'host'
		FOR UPDATE
	`, grantID))
}

func lockEndpoint(ctx context.Context, transaction pgx.Tx, endpointID string) (endpointRecord, error) {
	return scanEndpoint(transaction.QueryRow(ctx, `
		SELECT id::text, node_id, kind, grant_id::text, refresh_token_hash,
		       refresh_inactive_expires_at, last_refreshed_at, revoked_at
		FROM endpoints
		WHERE id = $1
		FOR UPDATE
	`, endpointID))
}

func scanEndpoint(row pgx.Row) (endpointRecord, error) {
	var endpoint endpointRecord
	var refreshHash []byte
	err := row.Scan(
		&endpoint.ID,
		&endpoint.NodeID,
		&endpoint.Kind,
		&endpoint.GrantID,
		&refreshHash,
		&endpoint.RefreshInactiveExpiresAt,
		&endpoint.LastRefreshedAt,
		&endpoint.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return endpointRecord{}, ErrEndpointNotFound
	}
	if err != nil {
		return endpointRecord{}, fmt.Errorf("lock endpoint: %w", err)
	}
	endpoint.RefreshHash, err = secretHashFromBytes(refreshHash)
	if err != nil {
		return endpointRecord{}, fmt.Errorf("read endpoint refresh hash: %w", err)
	}
	return endpoint, nil
}

func insertEndpoint(
	ctx context.Context,
	transaction pgx.Tx,
	grantID string,
	kind string,
	nodeID string,
	refreshHash SecretHash,
	now time.Time,
	inactivityTTL time.Duration,
) (endpointRecord, error) {
	endpoint := endpointRecord{
		NodeID:                   nodeID,
		Kind:                     kind,
		GrantID:                  grantID,
		RefreshHash:              refreshHash,
		RefreshInactiveExpiresAt: now.Add(inactivityTTL),
	}
	err := transaction.QueryRow(ctx, `
		INSERT INTO endpoints (
			grant_id, kind, node_id, refresh_token_hash,
			refresh_inactive_expires_at, created_at
		) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id::text
	`, grantID, kind, nodeID, refreshHash[:], endpoint.RefreshInactiveExpiresAt, now).Scan(&endpoint.ID)
	if err != nil {
		return endpointRecord{}, err
	}
	return endpoint, nil
}

func revokeGrant(ctx context.Context, transaction pgx.Tx, grantID string, now time.Time) error {
	if _, err := transaction.Exec(ctx, `
		UPDATE grants SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1
	`, grantID, now); err != nil {
		return fmt.Errorf("revoke grant: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE endpoints SET revoked_at = COALESCE(revoked_at, $2) WHERE grant_id = $1
	`, grantID, now); err != nil {
		return fmt.Errorf("cascade grant revocation: %w", err)
	}
	return nil
}

func (b *Broker) issueAccessToken(ctx context.Context, endpoint endpointRecord, now time.Time) (AccessToken, error) {
	jwtID, err := randomIdentifier()
	if err != nil {
		return AccessToken{}, err
	}
	accessToken, expiresAt, err := b.signer.Issue(
		ctx,
		endpoint.NodeID,
		endpoint.Kind,
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

func mapEndpointInsertError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		if postgresError.ConstraintName == "endpoints_refresh_token_hash_key" {
			return ErrRefreshHashConflict
		}
		return ErrClaimConflict
	}
	return fmt.Errorf("insert endpoint: %w", err)
}

func isUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

func secretHashFromBytes(value []byte) (SecretHash, error) {
	if len(value) != sha256.Size {
		return SecretHash{}, ErrInvalidSecretHash
	}
	var result SecretHash
	copy(result[:], value)
	return result, nil
}

func rollback(transaction pgx.Tx) {
	_ = transaction.Rollback(context.Background())
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
