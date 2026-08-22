package pairingticket

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	Prefix        = "volt+iroh://v1/"
	MaxTicketSize = 64 << 10
)

// SanitizeForApp removes the daemon's relay bearer credential while retaining
// the one-time pairing secret and all other ticket fields. The app replaces
// the removed credential with its own node-bound token before binding Iroh.
func SanitizeForApp(ticket string) (string, error) {
	if len(ticket) > MaxTicketSize {
		return "", errors.New("pairing ticket is too large")
	}
	if !strings.HasPrefix(ticket, Prefix) {
		return "", fmt.Errorf("pairing ticket must start with %q", Prefix)
	}

	encoded := strings.TrimPrefix(ticket, Prefix)
	if encoded == "" {
		return "", errors.New("pairing ticket payload is empty")
	}
	payloadBytes, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return "", errors.New("pairing ticket payload is not canonical base64url")
	}

	var payload map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	if err := decoder.Decode(&payload); err != nil {
		return "", errors.New("pairing ticket payload is not a JSON object")
	}
	if payload == nil {
		return "", errors.New("pairing ticket payload is not a JSON object")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", errors.New("pairing ticket payload has trailing data")
	}

	for _, field := range []string{"alpn", "irohTicket", "secret", "workspace"} {
		value, ok := payload[field]
		if !ok || !isNonEmptyJSONString(value) {
			return "", fmt.Errorf("pairing ticket %s must be a non-empty string", field)
		}
	}
	delete(payload, "relayAuthToken")

	sanitized, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode sanitized pairing ticket: %w", err)
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(sanitized), nil
}

func isNonEmptyJSONString(value json.RawMessage) bool {
	var decoded string
	return json.Unmarshal(value, &decoded) == nil && decoded != ""
}
