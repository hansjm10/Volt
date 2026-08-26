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

## Managed deployment authority

Each Volt-managed relay set is bound to one exact broker origin and JWT issuer:

| Deployment | Exact relay set | Exact broker origin / JWT issuer |
| --- | --- | --- |
| Production | `https://iroh-relay-us-central.volt-cli.dev` | `https://credentials.volt-cli.dev` |
| Canary | `https://iroh-relay-us-central-canary.volt-cli.dev` | `https://credentials-canary.volt-cli.dev` |

Daemon and app clients reject cross-deployment broker overrides for these built-in relay sets. Custom relay sets remain self-managed and do not acquire a broker automatically. Both authority pairs are separately deployed as of 2026-08-23; managed credential client code remains unreleased until the normal product release workflow completes.

## Persistence and production blockers

PostgreSQL is the broker's only state store. Embedded, checksummed migrations create grants, endpoints, pairing claims, App Check replay records, App Store entitlements and notifications, grant-entitlement bindings, and migration history. Migration 0002 explicitly revokes every pre-entitlement grant; there are no users to grandfather, and development pairings must bootstrap again. Approval consumes the verified App Check `jti`, locks the Apple `appTransactionID`, revokes any older daemon grant bound to that subscription, and creates the replacement grant and endpoints in one transaction. Exchange, refresh throttling, subscription suspension, expiry, and revocation use the same durable authority across replicas and restarts.

Remaining production blockers:

- Canary and production now use separate Cloud Run, Cloud SQL, Secret Manager, KMS, issuer, audience, JWKS, and relay authority. Production uses a Cloud Armor-protected external HTTPS load balancer, private-ingress Cloud Run, regional-HA PostgreSQL with point-in-time recovery, and a successful pre-admission restore drill. Production alert policies, secret-free operator dashboards, and administrative runbooks remain outstanding.
- Both managed relays now run the published strict-expiry artifact with SHA-256 `e7dff08edd35abc7d66244682d3136e2cb4c3288ac455a2b424435646fe3e1ca`, a 900-second maximum token lifetime, and 30-second clock skew. The pinned relay tests cover idle and sustained established connections plus blocked writes at expiry. Relay rejection metrics and crash, replay, key-rotation, and log-redaction drills remain outstanding.
- Bounded daemon re-registration after relay restart is implemented behind a native-version safety gate, but remains blocked until `@hansjm10/volt-iroh` publishes the watcher runtime fix merged in [iroh-ffi #281](https://github.com/n0-computer/iroh-ffi/pull/281). Unsafe 1.0.0/1.1.0 watcher APIs are never called.

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
4. The app generates and stores its own `vrr_` refresh secret, obtains a limited-use App Check token, obtains an App Store-signed device-bound AppTransaction, and approves the claim with its endpoint node ID, refresh-secret hash, signed AppTransaction, and device-verification ID.
5. The broker verifies Apple's certificate chain, recent receipt creation time, and device digest; consumes the semantic proof identity for this claim; queries the App Store Server API; and accepts only configured Volt Pro products in active or billing-grace state. Approval atomically moves the subscription to this daemon, revoking every refresh key on the previously bound daemon, then returns only the new app access JWT.
6. The daemon polls exchange with its claim secret and receives only a host access JWT. Its pre-persisted host refresh secret is now active, and it records the approved app node/endpoint.
7. The daemon consumes the pairing secret only from that broker-approved app node. Each endpoint presents its own access JWT to the relay, which requires JWT `sub` to equal the Iroh-handshake-proven endpoint ID.

### Later phone pairing

1. The daemon creates a claim authenticated by its existing host refresh secret.
2. The app approves with a new app endpoint node ID and app refresh-secret hash.
3. The broker adds the app endpoint to the existing grant.
4. Exchange returns the same host endpoint/grant IDs and identifies the newly approved app endpoint.

Refresh never returns or changes the refresh secret. It issues a new access JWT and extends the endpoint's inactivity expiry. Suspended subscriptions record a no-JWT heartbeat so a running daemon does not lose pairing authority during a long lapse. Refresh also reconciles cached Apple status at a bounded interval, recovering missed renewal, refund, or revocation notifications without putting Apple in the relay data path. Exact approval/exchange retries preserve endpoint and grant identity while issuing a fresh access JWT.

## Run locally

Go 1.23 or newer is required.

```sh
cd services/relay-credential-broker
export VOLT_CREDENTIAL_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/volt_credentials?sslmode=disable'
export VOLT_CREDENTIAL_SIGNING_MODE=local
export VOLT_APP_CHECK_MODE=development
export VOLT_DEVELOPMENT_APP_CHECK_TOKEN="$(openssl rand -base64 32)"
export VOLT_APP_STORE_MODE=development
export VOLT_DEVELOPMENT_APP_STORE_PROOF="$(openssl rand -base64 32)"
go run ./cmd/relay-credential-service
```

The database user must be able to create tables and use PostgreSQL advisory locks. Migrations run automatically before the listener starts. The default listener and issuer are local-only: `127.0.0.1:8085` and `http://127.0.0.1:8085`. Local signing mode creates `./data/relay-credential-signing-key` with mode `0600`.

After DNS and certificate readiness and the coordinated canary issuer cutover deploy the broker at `https://credentials-canary.volt-cli.dev` with the canary signing key and Firebase configuration, then start a disposable daemon state directory against the canary relay:

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

`VOLT_IROH_RELAY_URLS` selects the canary for the first start. After a managed claim or credential is persisted, later daemon starts derive the relay origins from that authority when no explicit relay configuration is present. Explicit configuration and environment values still take precedence and fail closed if they conflict with the credential scope.

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
  -d "{\"appNodeId\":\"$APP_NODE_ID\",\"appRefreshTokenHash\":\"$(hash_secret "$APP_REFRESH_TOKEN")\",\"signedAppTransaction\":\"$VOLT_DEVELOPMENT_APP_STORE_PROOF\",\"appStoreDeviceVerificationId\":\"11111111-1111-4111-8111-111111111111\"}")"

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
| `POST /v1/pairing-claims/{id}/approve` | Exactly one App Check header plus Apple proof | Approves with `{appNodeId,appRefreshTokenHash,signedAppTransaction,appStoreDeviceVerificationId}` and returns app endpoint metadata plus an access JWT. A newer daemon claim moves the subscription and revokes the previous grant. |
| `POST /v1/pairing-claims/{id}/exchange` | Claim-secret bearer | Returns `202` while pending, then host/app endpoint metadata plus a host access JWT. |
| `POST /v1/app-store/notifications` | Apple-signed V2 payload | Verifies `{signedPayload}`, reconciles current Apple status, and durably updates the entitlement. Configure this as the App Store Server Notifications V2 URL. |
| `POST /v1/tokens/refresh` | Endpoint refresh bearer | Extends inactivity and returns a new access JWT only while the bound subscription is active or in billing grace. Inactive subscriptions return `402 subscription_inactive` without deleting refresh authority. Body must be empty. |
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

## Managed relay integration

The managed relays are:

```text
https://iroh-relay-us-central.volt-cli.dev
172.233.223.84
https://iroh-relay-us-central-canary.volt-cli.dev
172.234.196.84
```

Both run the JWT-only custom binary built from upstream commit `f2eb930dda3779c6d852b72f3712aacd6e573ab1` (`v1.0.3`) plus `relay-patch/iroh-relay-1.0.3-jwt-access.patch`. Production accepts only issuer `https://credentials.volt-cli.dev` and audience `volt-iroh-relay`; canary accepts only issuer `https://credentials-canary.volt-cli.dev` and audience `volt-iroh-relay-canary`.

Build and validate the patch with pinned Rust, Zig, cargo-zigbuild, and LLVM versions:

```sh
./relay-patch/build.sh test
./relay-patch/build.sh linux-x86_64 /tmp/iroh-relay-1.0.3-volt-jwt
```

The Linux build writes a sidecar manifest containing source, patch/tool versions, and hashes. The deployed production and canary binary SHA-256 is `e7dff08edd35abc7d66244682d3136e2cb4c3288ac455a2b424435646fe3e1ca`. The binary and manifest are published in Artifact Registry package `iroh-relay`, version `1.0.3-volt-jwt-f9462fa6ac39`.

The relay access check requires one bearer JWT, selects one of at most eight configured Ed25519 keys by `kid`, validates issuer/audience/scope/time bounds, requires canonical `sub` equal to the proven endpoint ID, and enforces node/grant/global connection limits. It fails closed on malformed tokens, duplicate key IDs/public keys, or invalid access configuration. Configure rotation overlap with TOML array-of-table entries:

```toml
[access.jwt]
issuer = "https://credentials-canary.volt-cli.dev"
audience = "volt-iroh-relay-canary"

[[access.jwt.keys]]
public_key = "<active-jwks-x>"

[[access.jwt.keys]]
public_key = "<retiring-jwks-x>"
```

The relay derives each `kid` from the public key using the broker's SHA-256 rule, preventing key-ID/public-key mismatches. The deployed canary uses this multi-key format with the active KMS public key.

Relays built from the current patch verify locally instead of calling the credential service for each connection. At the verified JWT `exp` plus configured clock skew, the relay cancels the connection's complete traffic operation—including already-selected frame handling, queued or keepalive writes, and flushes—and drops the stream without a final flush, including under sustained traffic and backpressure. Ordinary shutdowns before that deadline still flush cleanly. Refreshing a token does not extend an existing connection. Short access-token lifetimes bound revocation delay and keep the broker out of the relay data path. The exact strict-expiry artifact above is deployed to both managed relays.

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

Cloud Run is private by default. The deployed canary uses `VOLT_CREDENTIAL_CANARY_PUBLIC=1` after the original custom domain became certificate-ready and the single-instance public request budgets were active. Normal confirmed simulator enrollment, broker approval/exchange, relayed reconnect after app cold start, app endpoint revocation, and host grant revocation have passed against the deployed stack. The script never deletes infrastructure, rotates database authority, or changes DNS.

`credentials-canary.volt-cli.dev` maps to the canary Cloud Run service. Authoritative DNS for `credentials.volt-cli.dev` points to the separate production HTTPS load balancer. Cloud Run retains a dormant production-hostname mapping to the canary service as rollback metadata, but it is not in the authoritative DNS path. Each broker revision still has one scalar `VOLT_CREDENTIAL_ISSUER` and one scalar `VOLT_CREDENTIAL_AUDIENCE`; request hostname does not select claims, and dual issuer/audience operation is unsupported.

The canary authority cutover completed on 2026-08-23:

- Cloud Run mapping and TLS health became ready for `credentials-canary.volt-cli.dev`.
- On-demand Cloud SQL backup `1787455783441` completed before mutation. Public invocation was blocked, then all 3 historical grants and 7 endpoints were revoked and 11 pairing claims were removed.
- Revision `relay-credential-broker-canary-issuer-20260823033559` was built from the unchanged image digest `sha256:269bfa2b58c9d48a18fd94e78de3afe0e22f7c7116e73cf77774a9524559b1b2`; its only authority change from the prior revision was `VOLT_CREDENTIAL_ISSUER=https://credentials-canary.volt-cli.dev`. Audience, active/retiring KMS versions, Firebase allowlist, database authority, service account, and scaling remained unchanged.
- The canary relay retained the published binary and public keys, changed only `access.jwt.issuer`, and restarted from `/etc/iroh-relay/config.toml`. The prior config is `/etc/iroh-relay/config.toml.pre-issuer-cutover-20260823T033700Z`.
- Fresh simulator enrollment passed App Check approval, broker exchange, node-bound 900-second EdDSA host JWT verification, explicit refresh, cold app reconnect, and grant revocation. The reset ended with zero active grants and endpoints.

A canary token-authority rollback still requires both sides of the authority pair: restore Cloud Run traffic to `relay-credential-broker-canary-kms-v2-retry-20260822`, restore the relay's backed-up issuer config, restart the relay, and reset credentials created after the rollback point. The dormant production-hostname Cloud Run mapping is not a valid production rollback after production grants exist.

### Production authority cutover

The production authority cutover completed on 2026-08-23:

- Cloud Run revision `relay-credential-broker-production-prod-20260823044141` runs pinned image digest `sha256:c2914acca78db7adf5e92f081a7bb5b23f40b5a7e5a8c45e6852f72dac5380fe` with exact issuer `https://credentials.volt-cli.dev`, audience `volt-iroh-relay`, KMS version `relay-production/signing/1`, and numeric database secret version `1`.
- Cloud SQL instance `volt-relay-credentials-production` is regional HA with point-in-time recovery, 14 retained backups, seven transaction-log days, and deletion protection. A point-in-time restore drill passed before admission; post-acceptance backup `1787464174160` completed with zero active grants and endpoints.
- `credentials.volt-cli.dev` is a DNS-only A record to the Cloud Armor-protected external HTTPS load balancer at `34.13.74.69`. Its managed certificate is active, unknown hosts/routes/methods fail closed, direct `run.app` ingress is blocked, and the certificate DNS authorization remains for renewal.
- The production relay runs strict-expiry artifact SHA-256 `e7dff08edd35abc7d66244682d3136e2cb4c3288ac455a2b424435646fe3e1ca` with only production issuer, audience, and KMS public key. Its prior binary and config are backed up with suffix `pre-production-authority-20260823T051350Z`.
- Fresh simulator enrollment passed explicit identity confirmation, temporary App Check debug-token approval and revocation, broker approval/exchange, independently verified node-bound 900-second EdDSA JWT claims, explicit refresh, cold app relaunch with fresh authenticated RPC connections, app endpoint revocation, host grant revocation, revoked-refresh denial, and local authority cleanup.

Production rollback must retain the production database and key authority. DNS rollback to the canary service or restoring the pre-strict relay binary is invalid after production grants exist.

### Canary monitoring

Deploy or update the checked-in Cloud Monitoring dashboard and its bounded-cardinality pairing request metric:

```sh
cd services/relay-credential-broker
./deploy/monitoring.sh
```

The dashboard covers pairing outcomes and logs, broker status and latency, Cloud Run capacity, Cloud KMS request results, and Cloud SQL CPU, disk, and connection health. The deployment is idempotent and pinned to project `volt-3fae7`; it does not create alert policies or notification channels. Log-based metric data begins at metric creation and is not backfilled.

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
| `VOLT_APP_STORE_MODE` | `development` | `development` for a private local broker or `apple` for App Store verification. Public deployments must use `apple`. |
| `VOLT_DEVELOPMENT_APP_STORE_PROOF` | required in development | Constant-time local entitlement proof, minimum 32 characters. Never expose this mode publicly. |
| `VOLT_APP_STORE_PRIVATE_KEY` | required in Apple mode | App Store Server API `.p8` private key from Secret Manager. Never log it. |
| `VOLT_APP_STORE_KEY_ID` | required in Apple mode | App Store Server API key ID. |
| `VOLT_APP_STORE_ISSUER_ID` | required in Apple mode | App Store Connect issuer ID. |
| `VOLT_APP_STORE_BUNDLE_ID` | `com.hansjm10.volt` | Exact bundle identifier accepted in Apple-signed data. |
| `VOLT_APP_STORE_APP_APPLE_ID` | required in Apple mode | Numeric App Store app identifier. |
| `VOLT_APP_STORE_SUBSCRIPTION_GROUP_ID` | required in Apple mode | Exact Volt Pro subscription-group identifier. |
| `VOLT_APP_STORE_PRODUCT_IDS` | Volt Pro monthly and annual IDs | Comma-separated allowed subscription products. |
| `VOLT_APP_STORE_ENVIRONMENTS` | `Production` | Accepted Apple environments. Canary explicitly uses `Sandbox`; the production issuer refuses mixed or Sandbox authority. Xcode and local receipts are always rejected. |
| `VOLT_APP_STORE_RECONCILE_INTERVAL` | `24h` | Maximum age of cached Apple status while a daemon is refreshing. Active cached service continues through transient Apple failures; inactive service fails closed until reconciliation succeeds. |
| `VOLT_APP_STORE_ROOT_CERTIFICATES_BASE64` | required in Apple mode | Comma-separated DER Apple root certificates encoded as standard base64 and loaded from reviewed Apple PKI artifacts. The JWS-provided root is never trusted. |
| `VOLT_CREDENTIAL_CLAIM_TTL` | `10m` | Claim lifetime; hard maximum `30m`. |
| `VOLT_CREDENTIAL_ACCESS_TTL` | `15m` | Access JWT lifetime; hard maximum `1h`. |
| `VOLT_CREDENTIAL_REFRESH_INACTIVITY_TTL` | `2160h` | Sliding refresh inactivity lifetime; hard maximum 90 days. |
| `VOLT_CREDENTIAL_REFRESH_MIN_INTERVAL` | `5s` | Minimum access refresh interval per endpoint. |
| `VOLT_CREDENTIAL_MAX_CLAIMS` | `10000` | Database-wide active claim cap. |
| `VOLT_CREDENTIAL_MAX_ENDPOINTS` | `100000` | Database-wide endpoint/tombstone cap. |
| `VOLT_CREDENTIAL_MAX_APP_ENDPOINTS_PER_GRANT` | `8` | Active phone endpoint cap per daemon identity grant. |
| `VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS` | `64` | In-process HTTP concurrency cap; not an edge-control substitute. |
| `VOLT_CREDENTIAL_MAX_BOOTSTRAP_REQUESTS_PER_MINUTE` | `60` | Process-wide unauthenticated bootstrap budget; canary runs one broker instance so direct Cloud Run traffic cannot bypass it. |
| `VOLT_CREDENTIAL_MAX_APPROVAL_REQUESTS_PER_MINUTE` | `120` | Process-wide App Check approval budget applied before verification and database work. |
| `VOLT_CREDENTIAL_MAX_EXCHANGE_REQUESTS_PER_MINUTE` | `600` | Process-wide claim exchange budget applied before database work. |
