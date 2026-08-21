package httpapi

import (
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
	"time"

	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/broker"
	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/credential"
)

const maxRequestBodyBytes = 4 * 1024

type AppCheckVerifier interface {
	Verify(request *http.Request) (appID string, err error)
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

func (v *DevelopmentAppCheckVerifier) Verify(request *http.Request) (string, error) {
	token, ok := singleHeaderValue(request.Header, "X-Firebase-AppCheck")
	if !ok || token == "" || len(token) > 8192 {
		return "", errors.New("exactly one App Check token is required")
	}
	digest := sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare(digest[:], v.tokenHash[:]) != 1 {
		return "", errors.New("App Check token invalid")
	}
	return v.appID, nil
}

type Config struct {
	MaxConcurrentRequests int
	RefreshMinInterval    time.Duration
}

type Server struct {
	broker            *broker.Broker
	signer            *credential.Signer
	appCheck          AppCheckVerifier
	logger            *slog.Logger
	requestSemaphore  chan struct{}
	refreshRetryAfter string
	handler           http.Handler
}

type createClaimRequest struct {
	HostNodeID string `json:"hostNodeId"`
}

type approveClaimRequest struct {
	AppNodeID      string `json:"appNodeId"`
	DeliverySecret string `json:"deliverySecret"`
}

type pendingResponse struct {
	Status            string `json:"status"`
	RetryAfterSeconds int    `json:"retryAfterSeconds"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func NewServer(brokerService *broker.Broker, signer *credential.Signer, appCheck AppCheckVerifier, config Config, logger *slog.Logger) (*Server, error) {
	if brokerService == nil || signer == nil || appCheck == nil {
		return nil, errors.New("broker, signer, and App Check verifier are required")
	}
	if config.MaxConcurrentRequests <= 0 || config.RefreshMinInterval <= 0 {
		return nil, errors.New("HTTP concurrency and refresh interval must be positive")
	}
	if logger == nil {
		logger = slog.Default()
	}

	refreshRetryAfterSeconds := int((config.RefreshMinInterval + time.Second - 1) / time.Second)
	server := &Server{
		broker:            brokerService,
		signer:            signer,
		appCheck:          appCheck,
		logger:            logger,
		requestSemaphore:  make(chan struct{}, config.MaxConcurrentRequests),
		refreshRetryAfter: strconv.Itoa(refreshRetryAfterSeconds),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.handleHealth)
	mux.HandleFunc("GET /.well-known/jwks.json", server.handleJWKS)
	mux.HandleFunc("POST /v1/pairing-claims", server.handleCreateClaim)
	mux.HandleFunc("POST /v1/pairing-claims/{claimID}/approve", server.handleApproveClaim)
	mux.HandleFunc("POST /v1/pairing-claims/{claimID}/exchange", server.handleExchangeClaim)
	mux.HandleFunc("POST /v1/tokens/refresh", server.handleRefresh)
	mux.HandleFunc("POST /v1/tokens/revoke", server.handleRevoke)
	server.handler = server.securityHeaders(server.limitConcurrency(mux))
	return server, nil
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.handler.ServeHTTP(writer, request)
}

func (s *Server) handleHealth(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleJWKS(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(writer, http.StatusOK, s.signer.JWKS())
}

func (s *Server) handleCreateClaim(writer http.ResponseWriter, request *http.Request) {
	var body createClaimRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	claim, err := s.broker.CreatePairingClaim(body.HostNodeID)
	if err != nil {
		if errors.Is(err, broker.ErrClaimCapacity) {
			writeError(writer, http.StatusTooManyRequests, "claim_capacity_reached")
			return
		}
		if errors.Is(err, broker.ErrInvalidHostNodeID) {
			writeError(writer, http.StatusBadRequest, "invalid_host_node_id")
			return
		}
		s.internalError(writer, "create pairing claim", err)
		return
	}
	writeJSON(writer, http.StatusCreated, claim)
}

func (s *Server) handleApproveClaim(writer http.ResponseWriter, request *http.Request) {
	appID, err := s.appCheck.Verify(request)
	if err != nil {
		writeError(writer, http.StatusUnauthorized, "app_check_invalid")
		return
	}
	var body approveClaimRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	approval, err := s.broker.ApprovePairingClaim(request.PathValue("claimID"), appID, body.AppNodeID, body.DeliverySecret)
	if err != nil {
		s.writeBrokerError(writer, err, "invalid_app_node_id")
		return
	}
	writeJSON(writer, http.StatusOK, approval)
}

func (s *Server) handleExchangeClaim(writer http.ResponseWriter, request *http.Request) {
	claimSecret, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "claim_secret_required")
		return
	}
	exchange, err := s.broker.ExchangePairingClaim(request.PathValue("claimID"), claimSecret)
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
	accessToken, err := s.broker.RefreshAccessToken(refreshToken)
	if err != nil {
		if errors.Is(err, broker.ErrRefreshExpired) {
			writeError(writer, http.StatusGone, "refresh_token_expired")
			return
		}
		if errors.Is(err, broker.ErrRefreshInvalid) {
			writeError(writer, http.StatusUnauthorized, "refresh_token_invalid")
			return
		}
		if errors.Is(err, broker.ErrRefreshThrottled) {
			writer.Header().Set("Retry-After", s.refreshRetryAfter)
			writeError(writer, http.StatusTooManyRequests, "refresh_rate_limited")
			return
		}
		s.internalError(writer, "refresh access token", err)
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
	if err := s.broker.RevokeRefreshToken(refreshToken); err != nil {
		if errors.Is(err, broker.ErrRefreshExpired) {
			writeError(writer, http.StatusGone, "refresh_token_expired")
			return
		}
		if errors.Is(err, broker.ErrRefreshInvalid) {
			writeError(writer, http.StatusUnauthorized, "refresh_token_invalid")
			return
		}
		s.internalError(writer, "revoke refresh token", err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeBrokerError(writer http.ResponseWriter, err error, invalidCode string) {
	switch {
	case errors.Is(err, broker.ErrClaimNotFound):
		writeError(writer, http.StatusNotFound, "claim_not_found")
	case errors.Is(err, broker.ErrClaimExpired):
		writeError(writer, http.StatusGone, "claim_expired")
	case errors.Is(err, broker.ErrClaimUnauthorized):
		writeError(writer, http.StatusUnauthorized, "claim_secret_invalid")
	case errors.Is(err, broker.ErrClaimConflict):
		writeError(writer, http.StatusConflict, "claim_already_approved")
	case errors.Is(err, broker.ErrCredentialCapacity):
		writeError(writer, http.StatusTooManyRequests, "credential_capacity_reached")
	case errors.Is(err, broker.ErrInvalidAppNodeID):
		writeError(writer, http.StatusBadRequest, invalidCode)
	case errors.Is(err, broker.ErrInvalidDeliverySecret):
		writeError(writer, http.StatusBadRequest, "invalid_delivery_secret")
	case errors.Is(err, broker.ErrDeliveryUnauthorized):
		writeError(writer, http.StatusUnauthorized, "delivery_secret_invalid")
	default:
		s.internalError(writer, "pairing claim operation", err)
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
