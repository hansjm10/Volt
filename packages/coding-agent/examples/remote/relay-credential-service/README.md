# Relay Credential Service POC

This Go service proves the account-free credential flow for the Volt-operated iroh relay fleet. It is a credential broker, not a user account service.

The POC:

- creates short-lived pairing claims for daemon Iroh node IDs;
- requires an app-attestation check before a phone can approve a claim;
- gives the app and daemon separate credentials;
- issues short-lived Ed25519 JWT access tokens bound to each endpoint's Iroh node ID;
- stores opaque refresh credentials only as SHA-256 hashes after claim delivery;
- supports refresh and endpoint-local revocation;
- publishes the relay verification key as JWKS;
- includes a pinned `iroh-relay 1.0.3` JWT `AccessControl` patch and reproducible canary build script; and
- uses only the Go standard library in the credential-service runtime.

## Status and production blockers

This is intentionally not production-ready:

- Firebase mode verifies limited-use App Check tokens against Firebase's cached RS256 JWKS, exact project authority, and an explicit app-ID allowlist, then consumes each `jti` once. The replay store is in memory and therefore is neither durable nor shared across service instances; production must make limited-use-token consumption atomic across the deployment.
- Pairing approval quotas need a pseudonymous, scarce app-install or device abuse principal; a Firebase app ID alone is not sufficient. This is abuse control, not a user account.
- Pairing claims and refresh records are in memory. A restart invalidates refresh credentials. Production storage must be durable, transactional across service instances, and continue storing refresh secrets only as hashes.
- Refresh credentials rotate when a claim response is redelivered, but ordinary refresh does not rotate. Production refresh should rotate on every use and reject reuse.
- The service needs edge rate limits, request budgets, audit events, and grant-wide administrative revocation. Its in-process concurrency and per-refresh limits are only defense in depth.
- The app and daemon must refresh before expiry and atomically update the relay bearer credential on their live Iroh endpoint, or rebind while preserving the endpoint identity. This capability must be verified in both current Iroh bindings before short-lived tokens can replace the static token.
- Signing-key custody and rotation need KMS/HSM-backed storage, overlapping current and previous keys in JWKS, and a documented compromise-recovery path.
- The stock `iroh-relay` binary cannot use these JWTs through `access.shared_token`. The canary patch adds a custom `AccessControl`, but production still needs reviewed key rotation, metrics, rollout, and artifact publication.

Do not expose this POC to the public internet or use its development App Check token in an app build.

## Account-free flow

1. The daemon creates a claim for its persistent Iroh node ID. It retains `claimSecret`; the QR contains `claimId`, not `claimSecret`.
2. The app scans the QR, generates and retains a 32-byte `deliverySecret`, then approves `claimId` with that secret, a limited-use App Check token, and its persistent Iroh node ID.
3. The app receives an app-bound access/refresh credential pair.
4. The daemon polls the claim exchange endpoint using `claimSecret` and receives a different host-bound access/refresh pair.
5. Each endpoint presents its access JWT to the relay as the existing relay bearer token.
6. The relay validates the JWT and requires JWT `sub` to equal the cryptographically proven Iroh endpoint ID.
7. App and daemon refresh their own access JWTs over HTTPS without user interaction.

Repeating approval or exchange rotates that endpoint's previously delivered refresh credential instead of replaying the same plaintext secret. App redelivery requires the original client-generated `deliverySecret`; host redelivery requires `claimSecret`. A prior access JWT remains usable by its same bound node until its short expiry. Production delivery should additionally use a client-bound encrypted envelope so reliable retries never depend on returning plaintext from durable state.

Possession of a JWT or refresh credential for one endpoint does not authorize another endpoint because the relay enforces the node-ID binding.

## Run locally

Go 1.23 or newer is required.

```sh
cd packages/coding-agent/examples/remote/relay-credential-service
export VOLT_APP_CHECK_MODE=development
export VOLT_DEVELOPMENT_APP_CHECK_TOKEN="$(openssl rand -base64 32)"
go run ./cmd/relay-credential-service
```

The default listener and issuer are local-only: `127.0.0.1:8085` and `http://127.0.0.1:8085`. The service creates `./data/relay-credential-signing-key` with mode `0600`.

Run the test suite:

```sh
go test ./...
go vet ./...
```

## Exercise the flow

This example uses placeholder canonical node IDs. Keep the development App Check token in the shell that started the service.

```sh
HOST_NODE_ID="$(printf 'a%.0s' $(seq 1 64))"
APP_NODE_ID="$(printf 'b%.0s' $(seq 1 64))"
APP_DELIVERY_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
BASE_URL="http://127.0.0.1:8085"

CLAIM="$({ curl -sS -X POST "$BASE_URL/v1/pairing-claims" \
  -H 'Content-Type: application/json' \
  -d "{\"hostNodeId\":\"$HOST_NODE_ID\"}"; })"
CLAIM_ID="$(printf '%s' "$CLAIM" | jq -r .claimId)"
CLAIM_SECRET="$(printf '%s' "$CLAIM" | jq -r .claimSecret)"

# Returns 202 until an attested app approves the claim.
curl -i -X POST "$BASE_URL/v1/pairing-claims/$CLAIM_ID/exchange" \
  -H "Authorization: Bearer $CLAIM_SECRET"

APP_CREDENTIALS="$({ curl -sS -X POST "$BASE_URL/v1/pairing-claims/$CLAIM_ID/approve" \
  -H 'Content-Type: application/json' \
  -H "X-Firebase-AppCheck: $VOLT_DEVELOPMENT_APP_CHECK_TOKEN" \
  -d "{\"appNodeId\":\"$APP_NODE_ID\",\"deliverySecret\":\"$APP_DELIVERY_SECRET\"}"; })"

HOST_CREDENTIALS="$({ curl -sS -X POST "$BASE_URL/v1/pairing-claims/$CLAIM_ID/exchange" \
  -H "Authorization: Bearer $CLAIM_SECRET"; })"

printf '%s\n' "$APP_CREDENTIALS" | jq
printf '%s\n' "$HOST_CREDENTIALS" | jq
curl -sS "$BASE_URL/.well-known/jwks.json" | jq
```

Do not print credentials in production logs. The commands above are only for an isolated local POC.

For Firebase-backed verification, omit the development token and configure the exact Firebase authority and allowlist:

```sh
export VOLT_APP_CHECK_MODE=firebase
export VOLT_FIREBASE_PROJECT_NUMBER=546623825529
export VOLT_ALLOWED_FIREBASE_APP_IDS=1:546623825529:ios:9f5a707e3f4ef89154d6a8
go run ./cmd/relay-credential-service
```

Firebase mode requires limited-use tokens with a `jti`, caches bounded JWKS responses, throttles attacker-triggered unknown-key refreshes, and rejects replayed `jti` values. The production service still requires HTTPS and a durable shared replay store.

## App-facing pairing tickets

A daemon credential is node-bound and must not be transferred to the app, including through process launch arguments. Pipe a locally generated pairing ticket through the stdin-only sanitizer before rendering a QR or launching the Debug simulator:

```sh
APP_TICKET="$(printf '%s' "$HOST_TICKET" | go run ./cmd/sanitize-pairing-ticket)"
```

The sanitizer preserves the one-time pairing secret and all non-credential fields but removes `relayAuthToken`. Managed-credential daemons now omit their host JWT from generated pairing tickets directly; the sanitizer remains a fail-closed boundary for older/manual ticket sources. The app obtains its own node-bound JWT before binding Iroh. Do not pass an unsanitized ticket as a command argument because process inspection can expose it.

To start a daemon with the complete host exchange response, keep the response in a mode-`0600` file and configure both values together:

```sh
export VOLT_IROH_RELAY_CREDENTIAL_FILE="$HOME/.volt/canary-poc/host-credential.json"
export VOLT_IROH_RELAY_CREDENTIAL_SERVICE=http://127.0.0.1:18085
unset VOLT_IROH_RELAY_AUTH_TOKEN
```

The daemon verifies that the credential's node ID matches its persistent Iroh identity, refreshes before access-token expiry, replaces each live relay configuration with `Endpoint.insertRelay`, and persists the refreshed credential in its mode-`0600` state. Revoke it explicitly with `volt remote credential revoke`; normal daemon shutdown intentionally preserves it for restart.

## HTTP contract

| Route | Authorization | Result |
| --- | --- | --- |
| `POST /v1/pairing-claims` | Public, edge-rate-limited in production | Creates `{claimId, claimSecret, expiresAt}` for `{hostNodeId}`. |
| `POST /v1/pairing-claims/{id}/approve` | Exactly one `X-Firebase-AppCheck` header | Approves with `{appNodeId,deliverySecret}` and returns app credentials. A retry requires the same delivery secret and rotates the prior app refresh credential. |
| `POST /v1/pairing-claims/{id}/exchange` | Exactly one bearer `claimSecret` header | Returns `202` while pending, then host credentials. A retry rotates the prior host refresh credential. |
| `POST /v1/tokens/refresh` | Exactly one bearer refresh-credential header | Returns a new access JWT, subject to a per-credential minimum interval. Body must be empty. |
| `POST /v1/tokens/revoke` | Exactly one bearer refresh-credential header | Revokes that endpoint's future refreshes. Body must be empty. |
| `GET /.well-known/jwks.json` | Public | Returns the Ed25519 public verification key. |
| `GET /healthz` | Public | Liveness response. |

Access JWT claims:

```json
{
  "iss": "https://credentials.example.com",
  "aud": "volt-iroh-relay-canary",
  "sub": "<64-character-lowercase-hex-iroh-node-id>",
  "exp": 1787314500,
  "iat": 1787313600,
  "jti": "<random-id>",
  "scope": "relay:connect",
  "endpoint_kind": "app",
  "grant_id": "<anonymous-pairing-grant-id>"
}
```

The JWT contains no user identity.

## Canary relay integration

The current canary is:

```text
https://iroh-relay-us-central-canary.volt-cli.dev
172.234.196.84
```

The canary now runs the JWT-only custom binary built from upstream commit `f2eb930dda3779c6d852b72f3712aacd6e573ab1` (`v1.0.3`) plus `relay-patch/iroh-relay-1.0.3-jwt-access.patch`. Its configured audience is `volt-iroh-relay-canary`; production remains unchanged.

Build and validate the patch with pinned Rust, Zig, cargo-zigbuild, and LLVM versions:

```sh
./relay-patch/build.sh test
./relay-patch/build.sh linux-x86_64 /tmp/iroh-relay-1.0.3-volt-jwt
```

The Linux build writes a sidecar manifest containing the source commit, patch/tool versions, and hashes, and atomically publishes a stripped glibc-2.28-compatible binary. The current canary binary SHA-256 is `7917f468dd81dee9c412eaf99de9cd35df75e5efd04d4e06091c695af234fc11`.

The canary patch also fails closed on missing, misspelled, unknown, or explicitly open non-development access configuration. It caps pending TLS/upgrade/authentication work at 64 connections with a 10-second deadline, caps HTTP establishment headers/buffering, and independently caps concurrent JWT verification plus admitted global/node/grant connections.

Recent `iroh-relay` exposes `iroh_relay::server::AccessControl`. Its `ClientRequest` provides raw request headers plus the Iroh-handshake-proven `endpoint_id()`. The relay fork's access check:

1. Inspect raw headers and require exactly one `Authorization: Bearer <JWT>` header. Reject duplicate/comma-combined authorization fields and every `token` query parameter; do not use the permissive `auth_token()` fallback.
2. Select an allowlisted Ed25519 key by `kid`; reject unknown algorithms and keys.
3. Verify the signature locally using a bounded, cached JWKS key set with last-known-good rotation behavior.
4. Require the configured `iss`, `aud`, `scope == "relay:connect"`, mandatory `iat`/`exp`, bounded clock skew, and `exp - iat <= 1 hour` even when a correctly signed token claims a longer lifetime.
5. Require canonical JWT `sub == request.endpoint_id().to_string()`.
6. Require `endpoint_kind` to be `app` or `host`.
7. Enforce mandatory per-node, per-grant, and global concurrent-connection limits, keyed by the relay `ConnectionId`, and decrement them in `on_disconnect`.
8. Denies closed on malformed tokens, stale verification configuration, or exhausted limits.

The configured canary access table is:

```toml
[access.jwt]
public_key = "<JWKS x>"
key_id = "<JWKS kid>"
issuer = "https://iroh-credentials-canary.volt-cli.dev"
audience = "volt-iroh-relay-canary"
max_token_lifetime_seconds = 3600
clock_skew_seconds = 30
max_global_connections = 1024
max_node_connections = 8
max_grant_connections = 16
max_concurrent_verifications = 32
```

Live canary probes verify that a fresh Go-issued token is admitted only for its bound Iroh endpoint ID; missing credentials and reuse from a different proven endpoint ID are denied. A Debug-only iOS simulator bootstrap has also obtained a real limited-use Firebase App Check token, had it verified by the local Firebase-mode service, received an app-node-bound JWT plus refresh credential, bound to the canary relay, and reconnected from saved-host state while preserving its endpoint identity. Both clients refresh through bounded no-redirect requests and replace live relay configuration without changing endpoint keys; explicit daemon revocation and app Forget revoke the refresh credential. Release/TestFlight and physical-device use still require an HTTPS credential-service deployment.

The relay verifies locally rather than calling the credential service for every connection. Short access-token lifetimes bound revocation delay and keep the credential service out of the relay data path.

See the upstream [`AccessControl` API](https://docs.rs/iroh-relay/latest/iroh_relay/server/trait.AccessControl.html) and [`ClientRequest`](https://docs.rs/iroh-relay/latest/iroh_relay/server/struct.ClientRequest.html).

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `VOLT_CREDENTIAL_LISTEN` | `127.0.0.1:8085` | HTTP listen address. Put TLS at a trusted reverse proxy for the POC. |
| `VOLT_CREDENTIAL_ISSUER` | `http://127.0.0.1:8085` | Exact JWT issuer expected by the relay. |
| `VOLT_CREDENTIAL_AUDIENCE` | `volt-iroh-relay` | Exact JWT audience expected by the relay. |
| `VOLT_CREDENTIAL_SIGNING_KEY_FILE` | `./data/relay-credential-signing-key` | Persistent mode-`0600` Ed25519 seed file. |
| `VOLT_APP_CHECK_MODE` | `development` | `development` for a constant-time local token or `firebase` for limited-use Firebase App Check JWTs. |
| `VOLT_DEVELOPMENT_APP_CHECK_TOKEN` | required in development mode | Development-only app approval token, minimum 32 characters. |
| `VOLT_FIREBASE_PROJECT_NUMBER` | required in Firebase mode | Decimal Firebase project number used for exact issuer and audience checks. |
| `VOLT_ALLOWED_FIREBASE_APP_IDS` | required in Firebase mode | Comma-separated exact Firebase app IDs allowed to approve claims. |
| `VOLT_CREDENTIAL_CLAIM_TTL` | `10m` | Pairing claim lifetime; hard maximum `30m`. |
| `VOLT_CREDENTIAL_ACCESS_TTL` | `15m` | Relay access JWT lifetime; hard maximum `1h`. |
| `VOLT_CREDENTIAL_REFRESH_TTL` | `720h` | Refresh credential lifetime; hard maximum `2160h` (90 days). |
| `VOLT_CREDENTIAL_REFRESH_MIN_INTERVAL` | `5s` | Minimum interval between access-token refreshes for one credential. |
| `VOLT_CREDENTIAL_MAX_CLAIMS` | `10000` | In-memory pending/retained claim cap. |
| `VOLT_CREDENTIAL_MAX_CREDENTIALS` | `100000` | In-memory refresh-record cap. |
| `VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS` | `64` | In-process HTTP concurrency cap; not a substitute for edge controls. |
