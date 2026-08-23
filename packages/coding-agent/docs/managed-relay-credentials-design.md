# Managed relay credentials production design

- Status: Accepted; PostgreSQL broker, Firebase Admin verification, Cloud KMS signing, and normal daemon/iOS clients implemented
- Workspaces: `Volt` broker/daemon/relay integration and `volt-app` iOS client
- Broker: `services/relay-credential-broker`

## Decision

Volt will keep the managed relay credential system account-free and operate it as one control-plane service:

```text
iOS / voltd
    -> HTTPS edge
    -> one stateless Go credential broker
    -> one Cloud SQL PostgreSQL database
    -> one Cloud KMS Ed25519 signing key ring

Iroh relays verify short-lived JWTs locally from a deployment-managed public key set.
```

Managed deployment authority is an exact pair, not a shared Volt-wide broker allowlist:

| Deployment | Exact relay set | Exact broker origin / JWT issuer |
| --- | --- | --- |
| Production | `https://iroh-relay-us-central.volt-cli.dev` | `https://credentials.volt-cli.dev` |
| Canary | `https://iroh-relay-us-central-canary.volt-cli.dev` | `https://credentials-canary.volt-cli.dev` |

Built-in clients reject a production/canary cross-binding or any other explicit broker origin. A custom relay set has no managed broker authority and remains self-managed. These are the target release bindings; production managed credentials remain disabled and unreleased until `credentials.volt-cli.dev` serves a separately configured production broker.

The production design deliberately does not add accounts, OAuth, Redis, queues, token introspection, per-relay broker calls, device fingerprinting, or separate pairing, refresh, and signing services.

The protocol is replaced in place before production. There are no users and no compatibility path is required for the POC exchange files or Debug-only canary bootstrap.

## Goals

1. A phone and daemon receive separate credentials bound to their persistent Iroh endpoint node IDs.
2. The broker never stores a plaintext refresh or pairing secret.
3. Approval replay protection and credential state are atomic across every broker replica.
4. Clients can refresh, restart, and revoke without changing their Iroh endpoint identity.
5. Relays remain available without a live broker request in the connection path.
6. The initial deployment costs roughly $10-15/month and can move to regional HA without a protocol change.

## Security invariants

- The relay requires JWT `sub` to equal the endpoint ID proven by the Iroh handshake.
- Host and app endpoints never share refresh authority.
- The host relay token is never serialized into an app-facing pairing ticket.
- Refresh and claim tokens are random 256-bit prefixed values. PostgreSQL stores only SHA-256 hashes of the complete prefixed token.
- App approval requires a valid allowlisted Firebase App Check limited-use token.
- App Check `jti` consumption commits in the same database transaction as approval.
- Credential-bearing HTTP requests require HTTPS, reject redirects, bound request and response sizes, and never place secrets in URLs or logs.
- Revocation stops future refreshes. Already issued access JWTs remain valid only through the short access-token TTL.
- Relay key rotation always has an overlap period in which both active and retiring public keys are accepted.

## Simplifying decisions

### Stable refresh secrets in v1

Refresh secrets do not rotate on every access-token refresh. A successful refresh extends a 90-day inactivity expiry while retaining the same secret. A device that has not refreshed for 90 days must pair again.

This avoids successor-token delivery, crash journals, token-family reuse detection, and ambiguous client promotion. The tradeoff is that the broker cannot detect copied refresh-secret reuse. That risk is bounded because a refresh secret can mint access JWTs only for its recorded node ID, and the relay separately requires possession of that node's Iroh private key. A copied refresh secret can still cause denial of service through revocation, so it remains a protected credential.

Per-use rotation is a later hardening option only if the threat model requires copied-refresh detection. It must not be partially added without an idempotent successor protocol and durable client journal.

### Client-generated secrets

The daemon generates and durably stores its claim and refresh secrets before creating a bootstrap claim. The app generates and stores its candidate refresh secret in this-device-only Keychain before approval. Requests send hashes; responses never deliver plaintext refresh secrets.

The app's refresh secret also supplies retry identity, replacing the POC's separate `deliverySecret` and server-generated refresh response.

### One daemon identity grant

A grant represents one persistent daemon identity, not one pairing attempt or software installation event. It has exactly one host endpoint and zero or more app endpoints. Daemon restart, Volt upgrade, workspace changes, and movement of preserved daemon state retain the grant; deleting the daemon identity/credential state creates a new grant.

- Initial enrollment creates the grant, host endpoint, and first app endpoint atomically.
- Later pairings authenticate claim creation with the existing host refresh secret and add only another app endpoint.
- App Forget revokes that app endpoint.
- The host can revoke one app endpoint without affecting its peers.
- Host or operator grant revocation cascades to every endpoint in the grant.
- Loss of the daemon endpoint identity creates a new grant; no recovery or merge path is provided.

This matches the daemon's single persistent Iroh endpoint and single active managed host credential.

## PostgreSQL schema

PostgreSQL is the only durable application store. The initial schema has four state tables plus the migration table.

### `grants`

| Column | Contract |
| --- | --- |
| `id` | UUID primary key generated by PostgreSQL |
| `host_node_id` | Canonical 64-character lowercase Iroh node ID |
| `created_at` | Creation timestamp |
| `revoked_at` | Nullable grant-wide revocation timestamp |

Multiple historical grants may have the same host node ID. This avoids public bootstrap claim squatting becoming a uniqueness denial of service. Only a grant whose host refresh secret is held by the real daemon remains useful.

### `endpoints`

| Column | Contract |
| --- | --- |
| `id` | UUID primary key |
| `grant_id` | Foreign key to `grants` |
| `kind` | `host` or `app` |
| `node_id` | Canonical endpoint Iroh node ID |
| `refresh_token_hash` | 32-byte SHA-256 digest, globally unique |
| `refresh_inactive_expires_at` | Server-authoritative sliding inactivity expiry |
| `last_refreshed_at` | Nullable refresh throttle timestamp |
| `created_at` | Creation timestamp |
| `revoked_at` | Nullable endpoint revocation timestamp |

Constraints:

- unique `(grant_id, kind, node_id)`;
- at most one `host` endpoint per grant through a partial unique index;
- unique `refresh_token_hash`;
- revoked or expired endpoints remain as tombstones for a bounded retention period rather than being immediately deleted.

### `pairing_claims`

| Column | Contract |
| --- | --- |
| `id` | Random public claim identifier primary key |
| `claim_secret_hash` | 32-byte SHA-256 digest |
| `host_node_id` | Host identity frozen into the reviewed pairing ticket |
| `grant_id` | Existing grant for an authenticated later pairing; nullable for bootstrap |
| `bootstrap_host_refresh_hash` | Initial host refresh hash; bootstrap only |
| `approved_app_endpoint_id` | Nullable endpoint created by approval |
| `created_at` | Creation timestamp |
| `expires_at` | Hard claim expiry, at most 30 minutes |
| `approved_at` | Nullable approval timestamp |
| `exchanged_at` | Nullable host-observation timestamp |

Expired claims are deleted after a short operational retention window. A bootstrap host refresh hash is promoted into an endpoint only in the successful approval transaction.

### `consumed_app_check_tokens`

| Column | Contract |
| --- | --- |
| `jti_hash` | SHA-256 digest primary key |
| `expires_at` | Verified App Check expiry |
| `consumed_at` | Approval transaction timestamp |

The primary key is the global replay barrier. Rows can be pruned after `expires_at` plus clock skew.

### What is not stored

PostgreSQL never stores plaintext refresh tokens, claim secrets, Iroh private keys, JWT signing private keys, access JWTs, request bodies, IP addresses, or metrics.

## HTTP protocol

All responses use bounded JSON with stable machine-readable error codes. Secrets appear only in authorization headers or request-body hashes, never in paths or query strings.

### Create bootstrap claim

`POST /v1/pairing-claims`

Unauthenticated but edge-rate-limited body:

```json
{
  "hostNodeId": "<node-id>",
  "claimSecretHash": "<base64url-sha256>",
  "hostRefreshTokenHash": "<base64url-sha256>"
}
```

Returns `claimId` and `expiresAt`. The daemon includes this one-time object in the reviewed pairing payload and retains both plaintext secrets locally:

```json
{
  "relayCredentialClaim": {
    "claimId": "<public-claim-id>",
    "serviceUrl": "https://credentials-canary.volt-cli.dev"
  }
}
```

The example is for the canary relay set. The service origin is deployment metadata constrained by the exact relay-to-broker pair above, not ticket-provided authority. iOS accepts only the broker origin paired with the selected built-in relay set (plus the exact local Debug POC origin for local testing); sanitized reconnect tickets remove the complete claim object.

### Create claim for an existing grant

`POST /v1/pairing-claims`

Authenticated with the existing host refresh secret. The broker derives the grant and host node ID from the endpoint record. The body contains only `claimSecretHash`. No new host endpoint or host refresh secret is created.

### Approve claim

`POST /v1/pairing-claims/{claimId}/approve`

Requires exactly one limited-use Firebase App Check token. Body:

```json
{
  "appNodeId": "<node-id>",
  "appRefreshTokenHash": "<base64url-sha256>"
}
```

The approval transaction:

1. inserts the verified App Check `jti` hash;
2. locks and validates the unexpired claim;
3. for bootstrap, creates the grant and host endpoint;
4. creates the app endpoint, or accepts an exact retry with the same node and refresh hash;
5. records approval.

A reused App Check `jti` fails the entire transaction. A retry after response loss obtains a fresh App Check token and sends the same app refresh hash. After commit, KMS signs an app access JWT. If signing fails, committed approval remains retryable and no secret is lost.

The response includes `grantId`, `endpointId`, `hostNodeId`, the app access JWT, and its expiry. The app requires `hostNodeId` to equal the host identity in the confirmed pairing ticket before using or persisting the credential.

### Observe/exchange approved claim

`POST /v1/pairing-claims/{claimId}/exchange`

Authenticated with the daemon-generated claim secret. Returns `202` while pending. After approval it returns the grant and host endpoint identifiers plus a host access JWT. It never returns a refresh secret.

The daemon treats a successful response as the point at which the pre-persisted bootstrap refresh secret becomes active. It durably records the approved app node/endpoint and refuses to consume the Iroh pairing secret from any other node. Later-pairing exchange only reports approval and refreshes the existing host access JWT.

### Refresh

`POST /v1/tokens/refresh`

Authenticated with an endpoint refresh secret and an empty body. One database transaction locks the endpoint, rejects revoked or inactive-expired records, applies the minimum refresh interval, extends the 90-day inactivity expiry, and records the refresh. KMS signs the access JWT after commit.

The response contains only the access JWT and access expiry. The refresh secret is unchanged. Database acceptance is the linearization point: a concurrent revoke that commits later does not invalidate an access JWT already accepted for issuance.

### Revoke endpoint

`POST /v1/tokens/revoke`

Authenticated with the endpoint refresh secret and an empty body. It idempotently sets `revoked_at` and returns `204`. Clients remove local relay admission immediately and keep a bounded durable revocation outbox until the broker confirms revocation or reports the endpoint already terminal.

### Host-revoke app endpoint

`POST /v1/grant/endpoints/revoke`

Authenticated with the host refresh secret and body `{ "endpointId": "<app-endpoint-id>" }`. It requires the target to be an app endpoint in the host's grant, idempotently sets its `revoked_at`, and returns `204`. This is the broker counterpart of host-side paired-client revocation.

### Revoke grant

`POST /v1/grant/revoke`

Authenticated with the host refresh secret and an empty body. It idempotently revokes the grant and every host/app endpoint under it, then returns `204`. Operator emergency revocation uses the same database transition through a private administrative path; no unauthenticated grant-wide route exists.

## Client lifecycle

Each client has one managed-credential controller with these durable concepts:

```text
candidate -> active -> revoked locally
                    -> revocation outbox -> remotely revoked
```

There is no pending refresh-token rotation state in v1.

Required behavior:

- Candidate refresh authority is persisted before approval.
- A candidate is promoted only after the expected host authenticates over Iroh.
- Access refresh updates the live relay configuration without replacing the endpoint key.
- A daemon restart falls back to the relay origins in persisted managed authority when no explicit relay configuration is supplied; an explicit origin mismatch still fails closed.
- After a previously-online endpoint loses every connected home relay, a safe native home-relay watcher triggers bounded live relay-map recycling with the current credential without replacing the endpoint key. Native releases with the known watcher runtime crash remain gated off.
- Relay-origin rotation replaces the complete authenticated origin set; retired origins are removed before future refreshes.
- Local Forget always commits even if another revocation remains pending.
- App and daemon revocation outboxes are keyed by endpoint ID rather than represented by one global tombstone; replacing a saved host durably queues the retired endpoint before discarding its refresh authority.
- Normal confirmed pairing, not Debug launch arguments, owns claim approval and credential promotion.

The daemon owns claim creation and exchange directly. The built-in production and canary relay sets resolve only to their exact broker origins above and reject an explicit conflicting origin; custom relay sets remain self-managed with no broker. The normal path has removed `VOLT_IROH_RELAY_CREDENTIAL_FILE`, `VOLT_IROH_RELAY_CREDENTIAL_SERVICE`, and the source-file-removal state used by the old canary bootstrap.

## Signing and relay verification

The broker signs Ed25519 JWTs with Cloud KMS. The KMS resource name for the active key version is deployment configuration, not database state or secret material.

Relays receive a deployment-managed set of accepted public keys and verify JWTs locally. They do not call PostgreSQL, KMS, or the broker for a connection.

Rotation procedure:

1. Create a new disabled or non-active KMS key version and obtain its public key.
2. Deploy the old and new public keys to every relay.
3. Verify relay uptake, then switch the broker's active signing version.
4. Verify already-running endpoints recover from any relay process restart without an endpoint restart, then wait at least access-token TTL plus relay rollout time and clock skew.
5. Remove the retiring key from relays, repeat the live recovery gate, and disable it in KMS.

The broker's JWKS endpoint publishes the same active and retiring public set for inspection. Asymmetric rotation is an explicit operator workflow; no separate key service or automatic rotation controller is introduced.

## Deployment and operations

### Canary

- Cloud Run request-based billing, minimum instances `0`.
- Native Cloud Run HTTPS endpoint.
- Single-zone Cloud SQL `db-f1-micro`, 10-20 GiB SSD, automated backups.
- Software-protected KMS signing key.
- Broker-level request caps and a low Cloud Run maximum-instance limit.
- Expected fixed cost: approximately $10-15/month in `us-central1`.

### Production

- External HTTPS load balancer and Cloud Armor Standard in front of private-ingress Cloud Run.
- Cloud SQL Enterprise regional HA with point-in-time recovery.
- Software-protected KMS key with active/retiring overlap.
- Expected low-traffic fixed cost: approximately $135-160/month in `us-central1`.

Staging remains canary-sized. It does not duplicate production HA infrastructure.

### Canary authority cutover

The canary authority cutover completed on 2026-08-23. `credentials-canary.volt-cli.dev` is certificate-ready, and the broker and relay now use that exact issuer with audience `volt-iroh-relay-canary`. Disposable old authority was reset before the switch. Fresh simulator enrollment, App Check approval, broker exchange, exact node-bound JWT claims, explicit refresh, cold reconnect, and grant revocation passed.

Both `credentials.volt-cli.dev` and `credentials-canary.volt-cli.dev` still map to one canary Cloud Run service. A broker revision has one scalar `VOLT_CREDENTIAL_ISSUER` and one scalar `VOLT_CREDENTIAL_AUDIENCE`; it does not select claims by request hostname. Dual issuer/audience operation is unsupported. Therefore the old hostname currently emits canary tokens and is only a temporary rollback HTTP alias, not production authority.

Rollback requires both sides of the authority pair: route Cloud Run back to `relay-credential-broker-canary-kms-v2-retry-20260822`, restore the relay's pre-cutover issuer config, restart the relay, and reset any credentials created after the rollback point. Remove the temporary shared-service alias only after the client rollout, at least one 15-minute access-token lifetime plus the configured 30-second relay skew, and the agreed rollback window.

Keep production managed credentials disabled and unreleased. Before enabling them, deploy a separately configured production broker, remap `credentials.volt-cli.dev` to it, and verify that origin emits only the exact production issuer/audience and connects only to the production relay set.

### Minimum abuse controls

- Edge rate limits for claim creation and approval, with stricter budgets than refresh.
- Cloud Run maximum instances and request concurrency.
- Database limits for active claims per host/grant, app endpoints per grant, and refresh frequency per endpoint.
- App Check validation before approval transaction work.
- Global emergency disable and grant-revocation operator procedures.

IP addresses, app IDs, and caller-supplied node IDs are not treated as durable identity or strong scarce principals. Device reputation and fingerprinting are explicitly deferred.

### Minimum monitoring

Emit secret-free counters and latency for:

- requests by route and status class;
- App Check invalid and replayed tokens;
- claim approval conflicts and quota denial;
- refresh denial, expiry, and revocation;
- PostgreSQL and KMS errors;
- active signing `kid`; and
- relay JWT rejection by reason.

Alert only on sustained 5xx responses, database/KMS unavailability, unexpected signing-key state, elevated replay/conflict rates, and exhausted capacity. Logs use 30-day default retention and never include bearer values, request bodies, raw node IDs, or unbounded metric labels.

## Implementation order

1. **Completed:** accept this contract and update the POC protocol/tests to client-generated stable refresh secrets and daemon-identity grants, including host-authorized app revocation.
2. **Completed:** wire durable daemon claim creation/exchange and normal confirmed iOS approval; remove file/Debug bootstrap paths.
3. **Completed:** replace in-memory broker state with PostgreSQL transactions and migrations.
4. **Completed:** replace custom Firebase signature verification with the Firebase Admin Go verifier while retaining PostgreSQL `jti` consumption.
5. **Completed:** add KMS signing and multi-key relay configuration.
6. Deploy the canary to Cloud Run and single-zone Cloud SQL, then run crash, replay, rotation, revocation, and log-redaction tests.
7. Add the production HTTPS edge, Cloud Armor, regional HA, alerts, and operator runbooks.

Infrastructure provisioning does not begin before steps 1 and 2 freeze the protocol clients must support.

## Non-goals

- User accounts, login, recovery, or cross-daemon identity.
- Refresh-token rotation or reuse detection in v1.
- Multi-region PostgreSQL or active-active broker state.
- Redis, queues, event buses, or a generic storage framework.
- Relay-side token introspection.
- Immediate revocation of already issued access JWTs.
- Automated asymmetric key rotation.
- Long-term storage of request-level security events in PostgreSQL.
