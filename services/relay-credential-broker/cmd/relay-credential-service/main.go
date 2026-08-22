package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/database"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/httpapi"
)

const (
	defaultListenAddress = "127.0.0.1:8085"
	defaultIssuer        = "http://127.0.0.1:8085"
	defaultAudience      = "volt-iroh-relay"
	defaultSigningKey    = "./data/relay-credential-signing-key"
)

type config struct {
	ListenAddress              string
	Issuer                     string
	Audience                   string
	SigningMode                string
	SigningKeyPath             string
	KMSActiveKeyVersion        string
	KMSRetiringKeyVersions     []string
	DatabaseURL                string
	AppCheckMode               string
	DevAppCheck                string
	FirebaseProjectNumber      string
	AllowedFirebaseAppIDs      []string
	ClaimTTL                   time.Duration
	AccessTTL                  time.Duration
	RefreshInactivityTTL       time.Duration
	RefreshMinInterval         time.Duration
	MaxClaims                  int
	MaxEndpoints               int
	MaxAppEndpointsPerGrant    int
	MaxConcurrentRequests      int
	MaxBootstrapRequestsPerMin int
	MaxApprovalRequestsPerMin  int
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	configuration, err := loadConfig()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}

	var signer *credential.Signer
	switch configuration.SigningMode {
	case "local":
		signer, err = credential.LoadOrCreateSigner(
			configuration.Issuer,
			configuration.Audience,
			configuration.SigningKeyPath,
		)
	case "kms":
		kmsContext, cancelKMS := context.WithTimeout(context.Background(), 30*time.Second)
		signer, err = credential.NewKMSSigner(
			kmsContext,
			configuration.Issuer,
			configuration.Audience,
			configuration.KMSActiveKeyVersion,
			configuration.KMSRetiringKeyVersions,
		)
		cancelKMS()
	default:
		err = fmt.Errorf("unsupported credential signing mode %q", configuration.SigningMode)
	}
	if err != nil {
		logger.Error("configure credential signer", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := signer.Close(); err != nil {
			logger.Error("close credential signer", "error", err)
		}
	}()
	var appCheck httpapi.AppCheckVerifier
	switch configuration.AppCheckMode {
	case "development":
		appCheck, err = httpapi.NewDevelopmentAppCheckVerifier(
			configuration.DevAppCheck,
		)
	case "firebase":
		appCheck, err = httpapi.NewFirebaseAppCheckVerifier(
			httpapi.FirebaseAppCheckConfig{
				ProjectNumber: configuration.FirebaseProjectNumber,
				AllowedAppIDs: configuration.AllowedFirebaseAppIDs,
			},
		)
	default:
		err = fmt.Errorf("unsupported App Check mode %q", configuration.AppCheckMode)
	}
	if err != nil {
		logger.Error("configure App Check verifier", "error", err)
		os.Exit(2)
	}
	databaseConfig, err := pgxpool.ParseConfig(configuration.DatabaseURL)
	if err != nil {
		logger.Error("invalid PostgreSQL configuration")
		os.Exit(2)
	}
	startupContext, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStartup()
	pool, err := pgxpool.NewWithConfig(startupContext, databaseConfig)
	if err != nil {
		logger.Error("open PostgreSQL", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := pool.Ping(startupContext); err != nil {
		logger.Error("connect to PostgreSQL", "error", err)
		os.Exit(1)
	}
	if err := database.Migrate(startupContext, pool); err != nil {
		logger.Error("migrate PostgreSQL", "error", err)
		os.Exit(1)
	}

	brokerService, err := broker.New(pool, signer, broker.Config{
		ClaimTTL:                configuration.ClaimTTL,
		AccessTokenTTL:          configuration.AccessTTL,
		RefreshInactivityTTL:    configuration.RefreshInactivityTTL,
		RefreshMinInterval:      configuration.RefreshMinInterval,
		MaxClaims:               configuration.MaxClaims,
		MaxEndpoints:            configuration.MaxEndpoints,
		MaxAppEndpointsPerGrant: configuration.MaxAppEndpointsPerGrant,
	}, time.Now)
	if err != nil {
		logger.Error("configure credential broker", "error", err)
		os.Exit(2)
	}
	handler, err := httpapi.NewServer(brokerService, signer, appCheck, httpapi.Config{
		MaxConcurrentRequests:         configuration.MaxConcurrentRequests,
		RefreshMinInterval:            configuration.RefreshMinInterval,
		MaxBootstrapRequestsPerMinute: configuration.MaxBootstrapRequestsPerMin,
		MaxApprovalRequestsPerMinute:  configuration.MaxApprovalRequestsPerMin,
		ReadinessCheck:                pool.Ping,
	}, logger)
	if err != nil {
		logger.Error("configure HTTP server", "error", err)
		os.Exit(2)
	}

	server := &http.Server{
		Addr:              configuration.ListenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	shutdownSignals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info(
			"relay credential service listening",
			"address", configuration.ListenAddress,
			"issuer", configuration.Issuer,
			"audience", configuration.Audience,
			"keyId", signer.KeyID(),
			"acceptedKeyIds", signer.KeyIDs(),
			"signingMode", configuration.SigningMode,
			"appCheckMode", configuration.AppCheckMode,
		)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-shutdownSignals.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			logger.Error("HTTP server shutdown failed", "error", err)
			os.Exit(1)
		}
		logger.Info("relay credential service stopped")
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server failed", "error", err)
			os.Exit(1)
		}
	}
}

func loadConfig() (config, error) {
	claimTTL, err := durationEnv("VOLT_CREDENTIAL_CLAIM_TTL", 10*time.Minute)
	if err != nil {
		return config{}, err
	}
	accessTTL, err := durationEnv("VOLT_CREDENTIAL_ACCESS_TTL", 15*time.Minute)
	if err != nil {
		return config{}, err
	}
	refreshInactivityTTL, err := durationEnv("VOLT_CREDENTIAL_REFRESH_INACTIVITY_TTL", 90*24*time.Hour)
	if err != nil {
		return config{}, err
	}
	refreshMinInterval, err := durationEnv("VOLT_CREDENTIAL_REFRESH_MIN_INTERVAL", 5*time.Second)
	if err != nil {
		return config{}, err
	}
	maxClaims, err := positiveIntEnv("VOLT_CREDENTIAL_MAX_CLAIMS", 10_000)
	if err != nil {
		return config{}, err
	}
	maxEndpoints, err := positiveIntEnv("VOLT_CREDENTIAL_MAX_ENDPOINTS", 100_000)
	if err != nil {
		return config{}, err
	}
	maxAppEndpointsPerGrant, err := positiveIntEnv("VOLT_CREDENTIAL_MAX_APP_ENDPOINTS_PER_GRANT", 8)
	if err != nil {
		return config{}, err
	}
	maxConcurrentRequests, err := positiveIntEnv("VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS", 64)
	if err != nil {
		return config{}, err
	}
	maxBootstrapRequestsPerMin, err := positiveIntEnv("VOLT_CREDENTIAL_MAX_BOOTSTRAP_REQUESTS_PER_MINUTE", 60)
	if err != nil {
		return config{}, err
	}
	maxApprovalRequestsPerMin, err := positiveIntEnv("VOLT_CREDENTIAL_MAX_APPROVAL_REQUESTS_PER_MINUTE", 120)
	if err != nil {
		return config{}, err
	}
	databaseURL := strings.TrimSpace(os.Getenv("VOLT_CREDENTIAL_DATABASE_URL"))
	if databaseURL == "" {
		return config{}, errors.New("VOLT_CREDENTIAL_DATABASE_URL is required")
	}
	appCheckMode := stringEnv("VOLT_APP_CHECK_MODE", "development")
	devAppCheck := os.Getenv("VOLT_DEVELOPMENT_APP_CHECK_TOKEN")
	firebaseProjectNumber := strings.TrimSpace(
		os.Getenv("VOLT_FIREBASE_PROJECT_NUMBER"),
	)
	allowedFirebaseAppIDs := commaSeparatedEnv(
		os.Getenv("VOLT_ALLOWED_FIREBASE_APP_IDS"),
	)
	signingMode := strings.TrimSpace(os.Getenv("VOLT_CREDENTIAL_SIGNING_MODE"))
	if signingMode == "" {
		return config{}, errors.New("VOLT_CREDENTIAL_SIGNING_MODE is required")
	}
	signingKeyPath := strings.TrimSpace(os.Getenv("VOLT_CREDENTIAL_SIGNING_KEY_FILE"))
	kmsActiveKeyVersion := strings.TrimSpace(os.Getenv("VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION"))
	kmsRetiringValue := strings.TrimSpace(os.Getenv("VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS"))
	kmsRetiringKeyVersions, err := keyVersionsEnv(kmsRetiringValue)
	if err != nil {
		return config{}, err
	}
	switch signingMode {
	case "local":
		if kmsActiveKeyVersion != "" || kmsRetiringValue != "" {
			return config{}, errors.New("Cloud KMS key versions require VOLT_CREDENTIAL_SIGNING_MODE=kms")
		}
		if signingKeyPath == "" {
			signingKeyPath = defaultSigningKey
		}
	case "kms":
		if signingKeyPath != "" {
			return config{}, errors.New("VOLT_CREDENTIAL_SIGNING_KEY_FILE cannot be used in kms signing mode")
		}
		if kmsActiveKeyVersion == "" {
			return config{}, errors.New("VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION is required in kms signing mode")
		}
	default:
		return config{}, fmt.Errorf("unsupported credential signing mode %q", signingMode)
	}
	if appCheckMode == "development" && len(devAppCheck) < 32 {
		return config{}, errors.New("VOLT_DEVELOPMENT_APP_CHECK_TOKEN must contain at least 32 characters in development mode")
	}
	if appCheckMode == "firebase" && (firebaseProjectNumber == "" || len(allowedFirebaseAppIDs) == 0) {
		return config{}, errors.New("VOLT_FIREBASE_PROJECT_NUMBER and VOLT_ALLOWED_FIREBASE_APP_IDS are required in firebase mode")
	}

	return config{
		ListenAddress:              stringEnv("VOLT_CREDENTIAL_LISTEN", defaultListenAddress),
		Issuer:                     stringEnv("VOLT_CREDENTIAL_ISSUER", defaultIssuer),
		Audience:                   stringEnv("VOLT_CREDENTIAL_AUDIENCE", defaultAudience),
		SigningMode:                signingMode,
		SigningKeyPath:             signingKeyPath,
		KMSActiveKeyVersion:        kmsActiveKeyVersion,
		KMSRetiringKeyVersions:     kmsRetiringKeyVersions,
		DatabaseURL:                databaseURL,
		AppCheckMode:               appCheckMode,
		DevAppCheck:                devAppCheck,
		FirebaseProjectNumber:      firebaseProjectNumber,
		AllowedFirebaseAppIDs:      allowedFirebaseAppIDs,
		ClaimTTL:                   claimTTL,
		AccessTTL:                  accessTTL,
		RefreshInactivityTTL:       refreshInactivityTTL,
		RefreshMinInterval:         refreshMinInterval,
		MaxClaims:                  maxClaims,
		MaxEndpoints:               maxEndpoints,
		MaxAppEndpointsPerGrant:    maxAppEndpointsPerGrant,
		MaxConcurrentRequests:      maxConcurrentRequests,
		MaxBootstrapRequestsPerMin: maxBootstrapRequestsPerMin,
		MaxApprovalRequestsPerMin:  maxApprovalRequestsPerMin,
	}, nil
}

func stringEnv(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func commaSeparatedEnv(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func keyVersionsEnv(value string) ([]string, error) {
	if value == "" {
		return nil, nil
	}
	parts := strings.Split(value, ",")
	if len(parts) > 7 {
		return nil, errors.New("VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS cannot contain more than seven versions")
	}
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		name := strings.TrimSpace(part)
		if name == "" {
			return nil, errors.New("VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS contains an empty version")
		}
		result = append(result, name)
	}
	return result, nil
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("%s must be a positive Go duration", name)
	}
	return duration, nil
}

func positiveIntEnv(name string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}
