# Relay Credential Broker

This Go service implements the account-free credential flow for the Volt-operated Iroh relay fleet. It is a credential broker, not a user account service.

The broker implements the accepted protocol in [Managed relay credentials production design](../../packages/coding-agent/docs/managed-relay-credentials-design.md):

- one daemon identity grant with one host endpoint and multiple app endpoints;
- client-generated pairing and refresh secrets, with only SHA-256 hashes sent during enrollment;
- separate node-bound host and app access JWTs;
- stable refresh secrets with a sliding inactivity expiry;
- endpoint-local, host-authorized app, and grant-wide revocation;
- short-lived Ed25519 JWTs bound to each endpoint's Iroh node ID;
- a public JWKS endpoint for active and retiring relay keys; and
- a pinned `iroh-relay 1.0.3` JWT `AccessControl` patch and reproducible canary build script.

## Persistence and production blockers

PostgreSQL is the broker's only state store. Embedded, checksummed migrations create `grants`, `endpoints`, `pairing_claims`, `consumed_app_check_tokens`, and `schema_migrations`. Approval consumes the verified App Check `jti`, creates or validates the grant and endpoints, and approves the claim in one transaction. Exchange, refresh throttling, expiry, and revocation use row locks, so replicas share one durable authority and restarts retain state.

Remaining production blockers:

- The private Cloud Run, Cloud SQL, KMS, and Secret Manager canary is deployed. It still needs the `credentials.volt-cli.dev` domain mapping, public request budgets, secret-free monitoring, backup/restore verification, and administrative procedures before public traffic.
- The multi-key relay binary is deployed and published. Relay rejection metrics and the complete enrollment/rotation/revocation acceptance run remain outstanding.

Do not expose the development App Check mode to the public internet or use its token in an app build.

## Grant model

A grant follows one persistent daemon Iroh identity:

```text
daemon identity grant
  host endpoint
  app endpoint A
  app endpoint B
```

Daemon restart, Volt upgrade, workspace changes, and pairing another phone retain the grant. Deleting the daemon identity/credential state creates a new grant.

Initial approval creates the grant, host endpoint, and first app endpoint atomically. Later claims authenticate with the existing host refresh secret and add only another app endpoint. The host endpoint remains unchanged.

Each app can revoke itself. The host can revoke one app endpoint or the complete grant. Revoking the host refresh secret also revokes the complete grant.

## Account-free flow

### Initial enrollment

1. The daemon generates and durably stores a `vpc_` claim secret and `vrr_` host refresh secret.
2. The daemon creates a bootstrap claim with its node ID and the SHA-256 hashes of those secrets. The broker returns only `claimId` and `expiresAt`.
3. The reviewed app-facing pairing payload carries `claimId`, never either plaintext daemon secret.
4. The app generates and stores its own `vrr_` refresh secret, obtains a limited-use App Check token, and approves the claim with its endpoint node ID and refresh-secret hash.
5. Approval creates one grant plus separate host/app endpoint records and returns only an app access JWT.
6. The daemon polls exchange with its claim secret and receives only a host access JWT. Its pre-persisted host refresh secret is now active, and it records the approved app node/endpoint.
7. The daemon consumes the pairing secret only from that broker-approved app node. Each endpoint presents its own access JWT to the relay, which requires JWT `sub` to equal the Iroh-handshake-proven endpoint ID.

### Later phone pairing

1. The daemon creates a claim authenticated by its existing host refresh secret.
2. The app approves with a new app endpoint node ID and app refresh-secret hash.
3. The broker adds the app endpoint to the existing grant.
4. Exchange returns the same host endpoint/grant IDs and identifies the newly approved app endpoint.

Refresh never returns or changes the refresh secret. It issues a new access JWT and extends the endpoint's inactivity expiry. Exact approval/exchange retries preserve endpoint and grant identity while issuing a fresh access JWT.

## Run locally

Go 1.23 or newer is required.

```sh
cd services/relay-credential-broker
export VOLT_CREDENTIAL_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/volt_credentials?sslmode=disable'
export VOLT_CREDENTIAL_SIGNING_MODE=local
export VOLT_APP_CHECK_MODE=development
export VOLT_DEVELOPMENT_APP_CHECK_TOKEN="$(openssl rand -base64 32)"
go run ./cmd/relay-credential-service
```

The database user must be able to create tables and use PostgreSQL advisory locks. Migrations run automatically before the listener starts. The default listener and issuer are local-only: `127.0.0.1:8085` and `http://127.0.0.1:8085`. Local signing mode creates `./data/relay-credential-signing-key` with mode `0600`.

After the broker is deployed at `https://credentials.volt-cli.dev` with the canary signing key and Firebase configuration, start a disposable daemon state directory against the canary relay:

```sh
VOLT_CODING_AGENT_DIR=/tmp/volt-relay-canary \
VOLT_IROH_RELAY_URLS=https://iroh-relay-us-central-canary.volt-cli.dev \
  ./volt-test.sh daemon start
VOLT_CODING_AGENT_DIR=/tmp/volt-relay-canary \
  ./volt-test.sh remote workspace add "$PWD" --name canary
VOLT_CODING_AGENT_DIR=/tmp/volt-relay-canary \
  ./volt-test.sh remote pair --workspace canary
```

The daemon recognizes the exact canary relay set, pre-persists its claim and host refresh secrets, creates the broker claim, and emits a normal reviewed ticket. Confirming that ticket in iOS obtains App Check, pre-persists the app refresh secret, approves the claim, and connects with the app access JWT. The daemon exchanges the same claim and installs its separate host JWT. No credential file or credential-specific launch argument is used.

Run unit validation, then PostgreSQL integration tests against a disposable database whose schemas may be created and dropped:

```sh
go test ./...
go vet ./...
VOLT_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable' go test ./...
```

Database-backed tests isolate each case in a random schema and cover migration idempotency, concurrent approval and refresh, App Check replay rollback, restart persistence, expiry, and refresh/revoke races.

## Exercise initial enrollment

The following commands print credentials and are only for an isolated local POC.

```sh
HOST_NODE_ID="$(printf 'a%.0s' $(seq 1 64))"
APP_NODE_ID="$(printf 'b%.0s' $(seq 1 64))"
CLAIM_SECRET="vpc_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
HOST_REFRESH_TOKEN="vrr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
APP_REFRESH_TOKEN="vrr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
BASE_URL="http://127.0.0.1:8085"

hash_secret() {
  printf '%s' "$1" | openssl dgst -sha256 -binary \
    | openssl base64 -A | tr '+/' '-_' | tr -d '='
}

CLAIM="$(curl -sS -X POST "$BASE_URL/v1/pairing-claims" \
  -H 'Content-Type: application/json' \
  -d "{\"hostNodeId\":\"$HOST_NODE_ID\",\"claimSecretHash\":\"$(hash_secret "$CLAIM_SECRET")\",\"hostRefreshTokenHash\":\"$(hash_secret "$HOST_REFRESH_TOKEN")\"}")"
CLAIM_ID="$(printf '%s' "$CLAIM" | jq -r .claimId)"

# Returns 202 until an attested app approves the claim.
curl -i -X POST "$BASE_URL/v1/pairing-claims/$CLAIM_ID/exchange" \
  -H "Authorization: Bearer $CLAIM_SECRET"

APP_CREDENTIAL="$(curl -sS -X POST "$BASE_URL/v1/pairing-claims/$CLAIM_ID/approve" \
  -H 'Content-Type: application/json' \
  -H "X-Firebase-AppCheck: $VOLT_DEVELOPMENT_APP_CHECK_TOKEN" \
  -d "{\"appNodeId\":\"$APP_NODE_ID\",\"appRefreshTokenHash\":\"$(hash_secret "$APP_REFRESH_TOKEN")\"}")"

HOST_CREDENTIAL="$(curl -sS -X POST "$BASE_URL/v1/pairing-claims/$CLAIM_ID/exchange" \
  -H "Authorization: Bearer $CLAIM_SECRET")"

printf '%s\n' "$APP_CREDENTIAL" | jq
printf '%s\n' "$HOST_CREDENTIAL" | jq

curl -sS -X POST "$BASE_URL/v1/tokens/refresh" \
  -H "Authorization: Bearer $HOST_REFRESH_TOKEN" | jq
curl -sS "$BASE_URL/.well-known/jwks.json" | jq
```

For Firebase-backed verification, omit the development token and configure the exact Firebase authority and allowlist:

```sh
export VOLT_CREDENTIAL_SIGNING_MODE=local
export VOLT_APP_CHECK_MODE=firebase
export VOLT_FIREBASE_PROJECT_NUMBER=546623825529
export VOLT_ALLOWED_FIREBASE_APP_IDS=1:546623825529:ios:9f5a707e3f4ef89154d6a8
go run ./cmd/relay-credential-service
```

Firebase mode uses Firebase Admin Go to verify limited-use tokens with a `jti`. The verifier returns only a SHA-256 `jti` digest to the broker; PostgreSQL consumes that digest in the approval transaction and provides the global replay barrier.

Production signing uses an exact active Cloud KMS `EC_SIGN_ED25519` key version and an optional bounded list of retiring versions:

```sh
export VOLT_CREDENTIAL_SIGNING_MODE=kms
export VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION=projects/volt/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/2
export VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS=projects/volt/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/1
unset VOLT_CREDENTIAL_SIGNING_KEY_FILE
```

The service uses Application Default Credentials. Its runtime identity needs permission to view every configured public key and to sign using the active version. All versions must belong to one CryptoKey, and the active version number must be newer than every retiring version. Startup verifies each resource name, algorithm, PEM checksum, unique derived `kid`, and an active-key readiness signature; signing verifies request and response CRC32C values plus the returned Ed25519 signature.

## HTTP contract

| Route | Authorization | Result |
| --- | --- | --- |
| `POST /v1/pairing-claims` | None for bootstrap | Creates a claim from `{hostNodeId,claimSecretHash,hostRefreshTokenHash}`. |
| `POST /v1/pairing-claims` | Host refresh bearer | Creates a later-pairing claim from `{claimSecretHash}` under the existing grant. |
| `POST /v1/pairing-claims/{id}/approve` | Exactly one App Check header | Approves with `{appNodeId,appRefreshTokenHash}` and returns app endpoint metadata plus an access JWT. |
| `POST /v1/pairing-claims/{id}/exchange` | Claim-secret bearer | Returns `202` while pending, then host/app endpoint metadata plus a host access JWT. |
| `POST /v1/tokens/refresh` | Endpoint refresh bearer | Extends inactivity and returns a new access JWT. Body must be empty. |
| `POST /v1/tokens/revoke` | Endpoint refresh bearer | Idempotently revokes that app endpoint; a host endpoint revokes the complete grant. |
| `POST /v1/grant/endpoints/revoke` | Host refresh bearer | Idempotently revokes one app `{endpointId}` in the host's grant. |
| `POST /v1/grant/revoke` | Host refresh bearer | Idempotently revokes the complete daemon identity grant. Body must be empty. |
| `GET /.well-known/jwks.json` | Public | Returns active and retiring Ed25519 public verification keys. |
| `GET /livez` | Public | Returns process liveness without checking dependencies. |
| `GET /readyz` | Public | Returns readiness only while PostgreSQL is reachable. |

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
  "grant_id": "<daemon-identity-grant-id>"
}
```

The JWT contains no user identity.

## Pairing-ticket boundary

A host credential is node-bound and must not be transferred to the app. Pipe any manually generated ticket through the stdin-only sanitizer before rendering or passing it to simulator tooling:

```sh
APP_TICKET="$(printf '%s' "$HOST_TICKET" | go run ./cmd/sanitize-pairing-ticket)"
```

The sanitizer preserves the existing one-time pairing secret and non-credential fields but removes `relayAuthToken`. Normal daemon tickets carry `relayCredentialClaim: { claimId, serviceUrl }`; iOS removes that complete one-time object when creating the saved reconnect ticket. Host access and refresh credentials are never serialized into app-facing tickets.

Do not pass unsanitized tickets or credentials as process arguments.

## Canary relay integration

The current relay canary is:

```text
https://iroh-relay-us-central-canary.volt-cli.dev
172.234.196.84
```

It runs the JWT-only custom binary built from upstream commit `f2eb930dda3779c6d852b72f3712aacd6e573ab1` (`v1.0.3`) plus `relay-patch/iroh-relay-1.0.3-jwt-access.patch`. Its configured audience is `volt-iroh-relay-canary`; production remains unchanged.

Build and validate the patch with pinned Rust, Zig, cargo-zigbuild, and LLVM versions:

```sh
./relay-patch/build.sh test
./relay-patch/build.sh linux-x86_64 /tmp/iroh-relay-1.0.3-volt-jwt
```

The Linux build writes a sidecar manifest containing source, patch/tool versions, and hashes. The deployed canary binary SHA-256 is `28eb14fbb323b0f74f8068317c263cb48fa19fe4c29dc834ceb397630e0e8cc8`. The binary and manifest are published in Artifact Registry package `iroh-relay`, version `1.0.3-volt-jwt-743a6202d57d`.

The relay access check requires one bearer JWT, selects one of at most eight configured Ed25519 keys by `kid`, validates issuer/audience/scope/time bounds, requires canonical `sub` equal to the proven endpoint ID, and enforces node/grant/global connection limits. It fails closed on malformed tokens, duplicate key IDs/public keys, or invalid access configuration. Configure rotation overlap with TOML array-of-table entries:

```toml
[access.jwt]
issuer = "https://credentials.volt-cli.dev"
audience = "volt-iroh-relay-canary"

[[access.jwt.keys]]
public_key = "<active-jwks-x>"

[[access.jwt.keys]]
public_key = "<retiring-jwks-x>"
```

The relay derives each `kid` from the public key using the broker's SHA-256 rule, preventing key-ID/public-key mismatches. The deployed canary uses this multi-key format with the active KMS public key.

Relays verify locally instead of calling the credential service for each connection. Short access-token lifetimes bound revocation delay and keep the broker out of the relay data path.

## Canary deployment

The canary deployment script is pinned to GCP project `volt-3fae7` (project number `546623825529`) and `us-central1`. It provisions one zonal `db-f1-micro` Cloud SQL instance with backups, a software-protected Ed25519 Cloud KMS key, a dedicated runtime service account, Secret Manager database authority, Artifact Registry, and a single-instance Cloud Run service:

```sh
cd services/relay-credential-broker
./deploy/canary.sh preflight
./deploy/canary.sh provision
./deploy/canary.sh build
./deploy/canary.sh deploy
./deploy/canary.sh describe
```

Cloud Run is private by default. Set `VOLT_CREDENTIAL_CANARY_PUBLIC=1` only after `credentials.volt-cli.dev` is mapped to the service and non-bypassable public request budgets are active. The script never deletes infrastructure, rotates database authority, or changes DNS.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `VOLT_CREDENTIAL_LISTEN` | `127.0.0.1:8085` | HTTP listen address. |
| `VOLT_CREDENTIAL_ISSUER` | `http://127.0.0.1:8085` | Exact JWT issuer expected by the relay. |
| `VOLT_CREDENTIAL_AUDIENCE` | `volt-iroh-relay` | Exact JWT audience expected by the relay. |
| `VOLT_CREDENTIAL_SIGNING_MODE` | required | `local` for development or `kms` for Cloud KMS signing; no production fallback. |
| `VOLT_CREDENTIAL_SIGNING_KEY_FILE` | `./data/relay-credential-signing-key` in local mode | Persistent mode-`0600` development Ed25519 seed file; forbidden in KMS mode. |
| `VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION` | required in KMS mode | Exact active `EC_SIGN_ED25519` CryptoKeyVersion resource name. |
| `VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS` | empty | Comma-separated retiring CryptoKeyVersion resource names published in JWKS. |
| `VOLT_CREDENTIAL_DATABASE_URL` | required | PostgreSQL connection URL. |
| `VOLT_APP_CHECK_MODE` | `development` | `development` or `firebase`. |
| `VOLT_DEVELOPMENT_APP_CHECK_TOKEN` | required in development | Constant-time local approval token, minimum 32 characters. |
| `VOLT_FIREBASE_PROJECT_NUMBER` | required in Firebase mode | Exact Firebase project authority. |
| `VOLT_ALLOWED_FIREBASE_APP_IDS` | required in Firebase mode | Comma-separated exact app-ID allowlist. |
| `VOLT_CREDENTIAL_CLAIM_TTL` | `10m` | Claim lifetime; hard maximum `30m`. |
| `VOLT_CREDENTIAL_ACCESS_TTL` | `15m` | Access JWT lifetime; hard maximum `1h`. |
| `VOLT_CREDENTIAL_REFRESH_INACTIVITY_TTL` | `2160h` | Sliding refresh inactivity lifetime; hard maximum 90 days. |
| `VOLT_CREDENTIAL_REFRESH_MIN_INTERVAL` | `5s` | Minimum access refresh interval per endpoint. |
| `VOLT_CREDENTIAL_MAX_CLAIMS` | `10000` | Database-wide active claim cap. |
| `VOLT_CREDENTIAL_MAX_ENDPOINTS` | `100000` | Database-wide endpoint/tombstone cap. |
| `VOLT_CREDENTIAL_MAX_APP_ENDPOINTS_PER_GRANT` | `8` | Active phone endpoint cap per daemon identity grant. |
| `VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS` | `64` | In-process HTTP concurrency cap; not an edge-control substitute. |
