package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
)

const maxRequestBodyBytes = 64 * 1024

type VerifiedAppCheck struct {
	AppID           string
	JTIHash         broker.SecretHash
	ExpiresAt       time.Time
	ReplayProtected bool
}

type AppCheckVerifier interface {
	Verify(request *http.Request) (VerifiedAppCheck, error)
}

type DevelopmentAppCheckVerifier struct {
	tokenHash [sha256.Size]byte
	appID     string
}

func NewDevelopmentAppCheckVerifier(token string) (*DevelopmentAppCheckVerifier, error) {
	if len(token) < 32 {
		return nil, errors.New("development App Check token must be at least 32 characters")
	}
	digest := sha256.Sum256([]byte(token))
	return &DevelopmentAppCheckVerifier{
		tokenHash: digest,
		appID:     "development:" + base64.RawURLEncoding.EncodeToString(digest[:12]),
	}, nil
}

func (v *DevelopmentAppCheckVerifier) Verify(request *http.Request) (VerifiedAppCheck, error) {
	token, ok := singleHeaderValue(request.Header, "X-Firebase-AppCheck")
	if !ok || token == "" || len(token) > 8192 {
		return VerifiedAppCheck{}, errors.New("exactly one App Check token is required")
	}
	digest := sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare(digest[:], v.tokenHash[:]) != 1 {
		return VerifiedAppCheck{}, errors.New("App Check token invalid")
	}
	return VerifiedAppCheck{AppID: v.appID}, nil
}

type Config struct {
	MaxConcurrentRequests         int
	RefreshMinInterval            time.Duration
	EntitlementReconcileInterval  time.Duration
	MaxBootstrapRequestsPerMinute int
	MaxApprovalRequestsPerMinute  int
	MaxExchangeRequestsPerMinute  int
	ReadinessCheck                func(context.Context) error
	Now                           func() time.Time
}

type requestBudget struct {
	mutex       sync.Mutex
	limit       int
	windowStart time.Time
	count       int
	now         func() time.Time
}

type Server struct {
	broker                       *broker.Broker
	signer                       *credential.Signer
	appCheck                     AppCheckVerifier
	appStore                     appstore.Verifier
	logger                       *slog.Logger
	requestSemaphore             chan struct{}
	refreshRetryAfter            string
	entitlementReconcileInterval time.Duration
	readinessCheck               func(context.Context) error
	now                          func() time.Time
	bootstrapBudget              *requestBudget
	approvalBudget               *requestBudget
	exchangeBudget               *requestBudget
	handler                      http.Handler
}

type createBootstrapClaimRequest struct {
	HostNodeID           string `json:"hostNodeId"`
	ClaimSecretHash      string `json:"claimSecretHash"`
	HostRefreshTokenHash string `json:"hostRefreshTokenHash"`
}

type createExistingClaimRequest struct {
	ClaimSecretHash string `json:"claimSecretHash"`
}

type approveClaimRequest struct {
	AppNodeID                    string `json:"appNodeId"`
	AppRefreshTokenHash          string `json:"appRefreshTokenHash"`
	SignedAppTransaction         string `json:"signedAppTransaction"`
	AppStoreDeviceVerificationID string `json:"appStoreDeviceVerificationId"`
}

type appStoreNotificationRequest struct {
	SignedPayload string `json:"signedPayload"`
}

type revokeAppEndpointRequest struct {
	EndpointID string `json:"endpointId"`
}

type pendingResponse struct {
	Status            string `json:"status"`
	RetryAfterSeconds int    `json:"retryAfterSeconds"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func NewServer(
	brokerService *broker.Broker,
	signer *credential.Signer,
	appCheck AppCheckVerifier,
	appStore appstore.Verifier,
	config Config,
	logger *slog.Logger,
) (*Server, error) {
	if brokerService == nil || signer == nil || appCheck == nil || appStore == nil {
		return nil, errors.New("broker, signer, App Check, and App Store verifiers are required")
	}
	if config.MaxConcurrentRequests <= 0 || config.RefreshMinInterval <= 0 ||
		config.EntitlementReconcileInterval <= 0 {
		return nil, errors.New("HTTP concurrency and refresh intervals must be positive")
	}
	if config.MaxBootstrapRequestsPerMinute <= 0 || config.MaxApprovalRequestsPerMinute <= 0 || config.MaxExchangeRequestsPerMinute <= 0 {
		return nil, errors.New("enrollment request budgets must be positive")
	}
	if config.ReadinessCheck == nil {
		return nil, errors.New("readiness check is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if config.Now == nil {
		config.Now = time.Now
	}

	refreshRetryAfterSeconds := int((config.RefreshMinInterval + time.Second - 1) / time.Second)
	server := &Server{
		broker:                       brokerService,
		signer:                       signer,
		appCheck:                     appCheck,
		appStore:                     appStore,
		logger:                       logger,
		requestSemaphore:             make(chan struct{}, config.MaxConcurrentRequests),
		refreshRetryAfter:            strconv.Itoa(refreshRetryAfterSeconds),
		entitlementReconcileInterval: config.EntitlementReconcileInterval,
		readinessCheck:               config.ReadinessCheck,
		now:                          config.Now,
		bootstrapBudget:              newRequestBudget(config.MaxBootstrapRequestsPerMinute, config.Now),
		approvalBudget:               newRequestBudget(config.MaxApprovalRequestsPerMinute, config.Now),
		exchangeBudget:               newRequestBudget(config.MaxExchangeRequestsPerMinute, config.Now),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /livez", server.handleLive)
	mux.HandleFunc("GET /readyz", server.handleReady)
	mux.HandleFunc("GET /.well-known/jwks.json", server.handleJWKS)
	mux.HandleFunc("POST /v1/pairing-claims", server.handleCreateClaim)
	mux.HandleFunc("POST /v1/pairing-claims/{claimID}/approve", server.handleApproveClaim)
	mux.HandleFunc("POST /v1/pairing-claims/{claimID}/exchange", server.handleExchangeClaim)
	mux.HandleFunc("POST /v1/app-store/notifications", server.handleAppStoreNotification)
	mux.HandleFunc("POST /v1/tokens/refresh", server.handleRefresh)
	mux.HandleFunc("POST /v1/tokens/revoke", server.handleRevoke)
	mux.HandleFunc("POST /v1/grant/endpoints/revoke", server.handleRevokeAppEndpoint)
	mux.HandleFunc("POST /v1/grant/revoke", server.handleRevokeGrant)
	server.handler = server.securityHeaders(server.limitConcurrency(mux))
	return server, nil
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.handler.ServeHTTP(writer, request)
}

func newRequestBudget(limit int, now func() time.Time) *requestBudget {
	return &requestBudget{limit: limit, now: now}
}

func (b *requestBudget) take() (bool, int) {
	now := b.now()
	b.mutex.Lock()
	defer b.mutex.Unlock()
	if b.windowStart.IsZero() || now.Before(b.windowStart) || !now.Before(b.windowStart.Add(time.Minute)) {
		b.windowStart = now
		b.count = 0
	}
	if b.count >= b.limit {
		remaining := b.windowStart.Add(time.Minute).Sub(now)
		retryAfter := int((remaining + time.Second - 1) / time.Second)
		if retryAfter < 1 {
			retryAfter = 1
		}
		return false, retryAfter
	}
	b.count++
	return true, 0
}

func enforceRequestBudget(writer http.ResponseWriter, budget *requestBudget) bool {
	allowed, retryAfter := budget.take()
	if allowed {
		return true
	}
	writer.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	writeError(writer, http.StatusTooManyRequests, "request_rate_limited")
	return false
}

func (s *Server) handleLive(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReady(writer http.ResponseWriter, request *http.Request) {
	if err := s.readinessCheck(request.Context()); err != nil {
		s.logger.Error("credential service readiness failed", "error", err)
		writeError(writer, http.StatusServiceUnavailable, "service_unavailable")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleJWKS(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(writer, http.StatusOK, s.signer.JWKS())
}

func (s *Server) handleCreateClaim(writer http.ResponseWriter, request *http.Request) {
	authorizationValues := request.Header.Values("Authorization")
	if len(authorizationValues) == 0 {
		if !enforceRequestBudget(writer, s.bootstrapBudget) {
			return
		}
		var body createBootstrapClaimRequest
		if err := decodeJSON(writer, request, &body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		claimSecretHash, err := broker.ParseSecretHash(body.ClaimSecretHash)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_claim_secret_hash")
			return
		}
		hostRefreshHash, err := broker.ParseSecretHash(body.HostRefreshTokenHash)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_host_refresh_token_hash")
			return
		}
		claim, err := s.broker.CreateBootstrapPairingClaim(request.Context(), body.HostNodeID, claimSecretHash, hostRefreshHash)
		if err != nil {
			s.writeClaimCreationError(writer, err)
			return
		}
		writeJSON(writer, http.StatusCreated, claim)
		return
	}

	hostRefreshToken, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "host_refresh_token_required")
		return
	}
	var body createExistingClaimRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	claimSecretHash, err := broker.ParseSecretHash(body.ClaimSecretHash)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_claim_secret_hash")
		return
	}
	claim, err := s.broker.CreatePairingClaimForGrant(request.Context(), hostRefreshToken, claimSecretHash)
	if err != nil {
		s.writeAuthenticatedError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, claim)
}

func (s *Server) handleApproveClaim(writer http.ResponseWriter, request *http.Request) {
	if !enforceRequestBudget(writer, s.approvalBudget) {
		return
	}
	var body approveClaimRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	verifiedAppCheck, err := s.appCheck.Verify(request)
	if err != nil {
		writeError(writer, http.StatusUnauthorized, "app_check_invalid")
		return
	}
	appRefreshHash, err := broker.ParseSecretHash(body.AppRefreshTokenHash)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_app_refresh_token_hash")
		return
	}
	entitlement, err := s.appStore.VerifyEntitlement(
		request.Context(),
		appstore.Proof{
			SignedAppTransaction: body.SignedAppTransaction,
			DeviceVerificationID: body.AppStoreDeviceVerificationID,
		},
	)
	if err != nil {
		s.writeAppStoreError(writer, err)
		return
	}
	approval, err := s.broker.ApprovePairingClaim(request.Context(), request.PathValue("claimID"), broker.AppCheckProof{
		AppID:           verifiedAppCheck.AppID,
		JTIHash:         verifiedAppCheck.JTIHash,
		ExpiresAt:       verifiedAppCheck.ExpiresAt,
		ReplayProtected: verifiedAppCheck.ReplayProtected,
	}, entitlement, body.AppNodeID, appRefreshHash)
	if err != nil {
		s.writeBrokerError(writer, err, "invalid_app_node_id")
		return
	}
	writeJSON(writer, http.StatusOK, approval)
}

func (s *Server) handleAppStoreNotification(
	writer http.ResponseWriter,
	request *http.Request,
) {
	var body appStoreNotificationRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	notification, err := s.appStore.VerifyNotification(
		request.Context(),
		body.SignedPayload,
	)
	if err != nil {
		s.writeAppStoreError(writer, err)
		return
	}
	if notification.Test {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	if err := s.broker.ApplyEntitlementNotification(
		request.Context(),
		notification,
	); err != nil {
		s.internalError(writer, "apply App Store notification", err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleExchangeClaim(writer http.ResponseWriter, request *http.Request) {
	claimSecret, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "claim_secret_required")
		return
	}
	if !enforceRequestBudget(writer, s.exchangeBudget) {
		return
	}
	exchange, err := s.broker.ExchangePairingClaim(request.Context(), request.PathValue("claimID"), claimSecret)
	if errors.Is(err, broker.ErrClaimPending) {
		writer.Header().Set("Retry-After", "1")
		writeJSON(writer, http.StatusAccepted, pendingResponse{Status: "pending", RetryAfterSeconds: 1})
		return
	}
	if err != nil {
		s.writeBrokerError(writer, err, "invalid_claim")
		return
	}
	writeJSON(writer, http.StatusOK, exchange)
}

func (s *Server) handleRefresh(writer http.ResponseWriter, request *http.Request) {
	if err := requireEmptyBody(request); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	refreshToken, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "refresh_token_required")
		return
	}
	refreshEntitlement, err := s.broker.EntitlementForRefresh(
		request.Context(),
		refreshToken,
	)
	if err != nil {
		s.writeAuthenticatedError(writer, err)
		return
	}
	now := s.now().UTC()
	if !refreshEntitlement.Active(now) ||
		now.Sub(refreshEntitlement.LastVerifiedAt) >= s.entitlementReconcileInterval {
		entitlement, reconcileErr := s.appStore.ReconcileEntitlement(
			request.Context(),
			refreshEntitlement.AppTransactionID,
			refreshEntitlement.Environment,
		)
		if reconcileErr != nil {
			if !refreshEntitlement.Active(now) {
				if _, heartbeatErr := s.broker.RefreshAccessToken(
					request.Context(),
					refreshToken,
				); heartbeatErr != nil &&
					!errors.Is(heartbeatErr, broker.ErrSubscriptionRequired) {
					s.writeAuthenticatedError(writer, heartbeatErr)
					return
				}
			}
			if !refreshEntitlement.Active(now) ||
				!errors.Is(reconcileErr, appstore.ErrSubscriptionUnavailable) {
				s.writeAppStoreError(writer, reconcileErr)
				return
			}
		} else if err := s.broker.ApplyEntitlementReconciliation(
			request.Context(),
			entitlement,
		); err != nil {
			s.internalError(writer, "apply App Store reconciliation", err)
			return
		}
	}
	accessToken, err := s.broker.RefreshAccessToken(request.Context(), refreshToken)
	if err != nil {
		if errors.Is(err, broker.ErrRefreshThrottled) {
			writer.Header().Set("Retry-After", s.refreshRetryAfter)
			writeError(writer, http.StatusTooManyRequests, "refresh_rate_limited")
			return
		}
		s.writeAuthenticatedError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, accessToken)
}

func (s *Server) handleRevoke(writer http.ResponseWriter, request *http.Request) {
	if err := requireEmptyBody(request); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	refreshToken, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "refresh_token_required")
		return
	}
	if err := s.broker.RevokeRefreshToken(request.Context(), refreshToken); err != nil {
		s.writeAuthenticatedError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRevokeAppEndpoint(writer http.ResponseWriter, request *http.Request) {
	hostRefreshToken, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "host_refresh_token_required")
		return
	}
	var body revokeAppEndpointRequest
	if err := decodeJSON(writer, request, &body); err != nil || strings.TrimSpace(body.EndpointID) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	if err := s.broker.RevokeAppEndpoint(request.Context(), hostRefreshToken, body.EndpointID); err != nil {
		s.writeAuthenticatedError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRevokeGrant(writer http.ResponseWriter, request *http.Request) {
	if err := requireEmptyBody(request); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	hostRefreshToken, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "host_refresh_token_required")
		return
	}
	if err := s.broker.RevokeGrant(request.Context(), hostRefreshToken); err != nil {
		s.writeAuthenticatedError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeAppStoreError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, appstore.ErrProofInvalid),
		errors.Is(err, appstore.ErrEnvironmentInvalid),
		errors.Is(err, appstore.ErrAppIdentifierInvalid),
		errors.Is(err, appstore.ErrDeviceInvalid):
		writeError(writer, http.StatusUnauthorized, "app_store_proof_invalid")
	case errors.Is(err, appstore.ErrSubscriptionInactive):
		writeError(writer, http.StatusPaymentRequired, "subscription_inactive")
	case errors.Is(err, appstore.ErrSubscriptionUnavailable):
		writer.Header().Set("Retry-After", "3600")
		writeError(writer, http.StatusServiceUnavailable, "app_store_unavailable")
	default:
		s.internalError(writer, "verify App Store entitlement", err)
	}
}

func (s *Server) writeClaimCreationError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, broker.ErrClaimCapacity):
		writeError(writer, http.StatusTooManyRequests, "claim_capacity_reached")
	case errors.Is(err, broker.ErrInvalidHostNodeID):
		writeError(writer, http.StatusBadRequest, "invalid_host_node_id")
	case errors.Is(err, broker.ErrClaimConflict):
		writeError(writer, http.StatusConflict, "claim_conflict")
	default:
		s.internalError(writer, "create pairing claim", err)
	}
}

func (s *Server) writeBrokerError(writer http.ResponseWriter, err error, invalidCode string) {
	switch {
	case errors.Is(err, broker.ErrAppCheckInvalid), errors.Is(err, broker.ErrAppCheckReplay):
		writeError(writer, http.StatusUnauthorized, "app_check_invalid")
	case errors.Is(err, broker.ErrClaimNotFound):
		writeError(writer, http.StatusNotFound, "claim_not_found")
	case errors.Is(err, broker.ErrClaimExpired):
		writeError(writer, http.StatusGone, "claim_expired")
	case errors.Is(err, broker.ErrClaimUnauthorized):
		writeError(writer, http.StatusUnauthorized, "claim_secret_invalid")
	case errors.Is(err, broker.ErrClaimConflict), errors.Is(err, broker.ErrRefreshHashConflict):
		writeError(writer, http.StatusConflict, "claim_conflict")
	case errors.Is(err, broker.ErrEndpointCapacity):
		writeError(writer, http.StatusTooManyRequests, "endpoint_capacity_reached")
	case errors.Is(err, broker.ErrAppEndpointCapacity):
		writeError(writer, http.StatusTooManyRequests, "grant_endpoint_capacity_reached")
	case errors.Is(err, broker.ErrInvalidAppNodeID):
		writeError(writer, http.StatusBadRequest, invalidCode)
	case errors.Is(err, broker.ErrRefreshExpired):
		writeError(writer, http.StatusGone, "credential_expired")
	case errors.Is(err, broker.ErrSubscriptionRequired):
		writeError(writer, http.StatusPaymentRequired, "subscription_inactive")
	case errors.Is(err, broker.ErrSubscriptionConflict):
		writeError(writer, http.StatusConflict, "subscription_conflict")
	case errors.Is(err, broker.ErrSubscriptionSuperseded):
		writeError(writer, http.StatusConflict, "subscription_pairing_superseded")
	case errors.Is(err, broker.ErrAppStoreProofReplay):
		writeError(writer, http.StatusConflict, "app_store_proof_replayed")
	case errors.Is(err, broker.ErrGrantRevoked), errors.Is(err, broker.ErrRefreshInvalid):
		writeError(writer, http.StatusUnauthorized, "credential_invalid")
	default:
		s.internalError(writer, "pairing claim operation", err)
	}
}

func (s *Server) writeAuthenticatedError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, broker.ErrRefreshExpired):
		writeError(writer, http.StatusGone, "refresh_token_expired")
	case errors.Is(err, broker.ErrRefreshInvalid), errors.Is(err, broker.ErrGrantRevoked):
		writeError(writer, http.StatusUnauthorized, "refresh_token_invalid")
	case errors.Is(err, broker.ErrSubscriptionRequired):
		writer.Header().Set("Retry-After", "3600")
		writeError(writer, http.StatusPaymentRequired, "subscription_inactive")
	case errors.Is(err, broker.ErrSubscriptionConflict):
		writeError(writer, http.StatusConflict, "subscription_conflict")
	case errors.Is(err, broker.ErrEndpointNotFound):
		writeError(writer, http.StatusNotFound, "endpoint_not_found")
	case errors.Is(err, broker.ErrEndpointForbidden):
		writeError(writer, http.StatusForbidden, "endpoint_forbidden")
	case errors.Is(err, broker.ErrClaimCapacity):
		writeError(writer, http.StatusTooManyRequests, "claim_capacity_reached")
	case errors.Is(err, broker.ErrClaimConflict):
		writeError(writer, http.StatusConflict, "claim_conflict")
	default:
		s.internalError(writer, "authenticated credential operation", err)
	}
}

func (s *Server) internalError(writer http.ResponseWriter, operation string, err error) {
	s.logger.Error("credential service request failed", "operation", operation, "error", err)
	writeError(writer, http.StatusInternalServerError, "internal_error")
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) limitConcurrency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case s.requestSemaphore <- struct{}{}:
			defer func() { <-s.requestSemaphore }()
			next.ServeHTTP(writer, request)
		default:
			writer.Header().Set("Retry-After", "1")
			writeError(writer, http.StatusServiceUnavailable, "service_busy")
		}
	})
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return fmt.Errorf("content type must be application/json")
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON value")
	}
	return nil
}

func requireEmptyBody(request *http.Request) error {
	if request.Body == nil {
		return nil
	}
	defer request.Body.Close()
	body, err := io.ReadAll(io.LimitReader(request.Body, 1))
	if err != nil {
		return err
	}
	if len(body) != 0 {
		return errors.New("request body must be empty")
	}
	return nil
}

func bearerToken(request *http.Request) (string, bool) {
	authorization, ok := singleHeaderValue(request.Header, "Authorization")
	if !ok {
		return "", false
	}
	scheme, token, ok := strings.Cut(authorization, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.ContainsAny(token, " \t\r\n") || len(token) > 8192 {
		return "", false
	}
	return token, true
}

func singleHeaderValue(headers http.Header, name string) (string, bool) {
	values := headers.Values(name)
	if len(values) != 1 {
		return "", false
	}
	value := values[0]
	if value != strings.TrimSpace(value) || strings.ContainsAny(value, ",\r\n") {
		return "", false
	}
	return value, true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, errorResponse{Error: code})
}
