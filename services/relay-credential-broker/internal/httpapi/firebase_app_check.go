package httpapi

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/appcheck"
)

const (
	maxAppCheckTokenBytes    = 8 * 1024
	maxAppCheckTokenLifetime = 7 * 24 * time.Hour
)

type FirebaseAppCheckConfig struct {
	ProjectNumber string
	AllowedAppIDs []string
	Now           func() time.Time
}

type firebaseAppCheckTokenVerifier interface {
	VerifyToken(token string) (*appcheck.DecodedAppCheckToken, error)
}

type FirebaseAppCheckVerifier struct {
	issuer        string
	audience      string
	allowedAppIDs map[string]struct{}
	tokenVerifier firebaseAppCheckTokenVerifier
	now           func() time.Time
}

func NewFirebaseAppCheckVerifier(config FirebaseAppCheckConfig) (*FirebaseAppCheckVerifier, error) {
	return newFirebaseAppCheckVerifier(context.Background(), config, nil)
}

func newFirebaseAppCheckVerifier(
	ctx context.Context,
	config FirebaseAppCheckConfig,
	tokenVerifier firebaseAppCheckTokenVerifier,
) (*FirebaseAppCheckVerifier, error) {
	projectNumber := strings.TrimSpace(config.ProjectNumber)
	if projectNumber == "" || strings.Trim(projectNumber, "0123456789") != "" || len(projectNumber) > 32 {
		return nil, errors.New("Firebase project number must be decimal digits")
	}
	allowedAppIDs := make(map[string]struct{}, len(config.AllowedAppIDs))
	for _, value := range config.AllowedAppIDs {
		appID := strings.TrimSpace(value)
		if appID == "" || len(appID) > 256 || strings.ContainsAny(appID, "\r\n\x00") {
			return nil, errors.New("Firebase app ID allowlist contains an invalid value")
		}
		allowedAppIDs[appID] = struct{}{}
	}
	if len(allowedAppIDs) == 0 || len(allowedAppIDs) > 8 {
		return nil, errors.New("Firebase app ID allowlist must contain between one and eight entries")
	}
	if tokenVerifier == nil {
		if ctx == nil {
			return nil, errors.New("Firebase App Check initialization context is required")
		}
		// App Check audiences use projects/<project-number>, which the Go SDK
		// compares against Config.ProjectID.
		app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectNumber})
		if err != nil {
			return nil, fmt.Errorf("initialize Firebase Admin: %w", err)
		}
		tokenVerifier, err = app.AppCheck(ctx)
		if err != nil {
			return nil, fmt.Errorf("initialize Firebase Admin App Check: %w", err)
		}
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &FirebaseAppCheckVerifier{
		issuer:        "https://firebaseappcheck.googleapis.com/" + projectNumber,
		audience:      "projects/" + projectNumber,
		allowedAppIDs: allowedAppIDs,
		tokenVerifier: tokenVerifier,
		now:           now,
	}, nil
}

func (v *FirebaseAppCheckVerifier) Verify(request *http.Request) (VerifiedAppCheck, error) {
	token, ok := singleHeaderValue(request.Header, "X-Firebase-AppCheck")
	if !ok || token == "" || len(token) > maxAppCheckTokenBytes {
		return VerifiedAppCheck{}, errors.New("exactly one Firebase App Check token is required")
	}
	return v.verifyToken(token)
}

func (v *FirebaseAppCheckVerifier) verifyToken(token string) (verified VerifiedAppCheck, err error) {
	defer func() {
		if recover() != nil {
			verified = VerifiedAppCheck{}
			err = errors.New("Firebase Admin App Check verification failed")
		}
	}()

	decoded, err := v.tokenVerifier.VerifyToken(token)
	if err != nil || decoded == nil {
		return VerifiedAppCheck{}, errors.New("Firebase App Check token is invalid")
	}
	if decoded.Issuer != v.issuer || !slices.Contains(decoded.Audience, v.audience) {
		return VerifiedAppCheck{}, errors.New("Firebase App Check authority is invalid")
	}
	if _, ok := v.allowedAppIDs[decoded.AppID]; !ok || decoded.Subject != decoded.AppID {
		return VerifiedAppCheck{}, errors.New("Firebase App Check app is not allowed")
	}
	now := v.now().UTC()
	if !decoded.ExpiresAt.After(now) || decoded.IssuedAt.After(now) {
		return VerifiedAppCheck{}, errors.New("Firebase App Check token is outside its validity window")
	}
	lifetime := decoded.ExpiresAt.Sub(decoded.IssuedAt)
	if lifetime <= 0 || lifetime > maxAppCheckTokenLifetime {
		return VerifiedAppCheck{}, errors.New("Firebase App Check token lifetime is invalid")
	}
	jti, ok := decoded.Claims["jti"].(string)
	if !ok || len(jti) < 16 || len(jti) > 512 || strings.ContainsAny(jti, "\x00\r\n \t") {
		return VerifiedAppCheck{}, errors.New("limited-use Firebase App Check token jti is required")
	}
	jtiHash := sha256.Sum256([]byte(jti))
	return VerifiedAppCheck{
		AppID:           decoded.AppID,
		JTIHash:         jtiHash,
		ExpiresAt:       decoded.ExpiresAt.UTC(),
		ReplayProtected: true,
	}, nil
}
