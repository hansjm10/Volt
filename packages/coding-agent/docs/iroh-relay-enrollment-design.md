# Iroh relay enrollment design

Status: normative v1 enrollment contract for the v2 Volt pairing ticket.

Implementation status: the broker, daemon, app, managed-relay callback, and repository-owned protected edge are implemented as one dependency-ordered rollout. The legacy generated-function origins and multiplexed exports remain temporary rollback targets until the final policy and client cutover complete a monitored soak.

This document defines relay-infrastructure enrollment only. It does not grant a
phone permission to use Volt RPC. Desktop authorization remains the existing
short-lived pairing secret, the authenticated Iroh transport, the pinned host
endpoint ID, and the daemon's persisted client grant.

## Security boundary

- The official Volt relay never receives or distributes an endpoint bearer.
  It asks the fixed Volt broker whether the connecting endpoint ID is allowed.
- The QR carries one-time pairing and enrollment secrets. It never carries the
  broker URL, a Firebase credential, or a durable relay credential.
- The app sends Firebase App Check material only to the broker URL compiled into
  the official app.
- A pair grant authorizes exactly one host endpoint ID and one client endpoint
  ID to register with official relays. It cannot authenticate Volt RPC.
- Custom relays are owner-controlled, uncredentialed transport. They never
  receive App Check material from the official app.
- Enrollment state lives only in the fixed `volt-iroh-enrollment` named
  Firestore database. `irohEnrollmentApi` and `irohRelayAccess` use distinct
  runtime identities with database-conditioned IAM. Only the enrollment API
  receives the IP-salt secret and App Check verification grant; only the
  callback receives current/next relay secrets. Neither can access raw FCM token
  state in `volt-push-relay`, and the push identity cannot access enrollment
  state. Server SDK isolation relies on IAM, not Firestore Security Rules.

## v2 pairing ticket

The encoded ticket prefix is `volt+iroh://v2/`. Its payload is UTF-8 JSON
encoded with unpadded base64url. The Iroh ALPN remains `volt-rpc/0`.

```ts
type RelayDescriptor =
  | { kind: "volt-managed"; origins: string[] }
  | { kind: "custom-uncredentialed"; origins: string[] }
  | { kind: "n0-public" }
  | { kind: "disabled" };

type EnrollmentClaim = {
  version: 1;
  claimId: string;       // 16 random bytes, unpadded base64url
  claimSecret: string;   // 32 random bytes, unpadded base64url
};

type PairingTicketV2 = {
  alpn: "volt-rpc/0";
  expiresAt?: number;
  irohTicket: string;
  nodeId: string;        // 32-byte Ed25519 public key, lowercase hex
  relay: RelayDescriptor;
  enrollment?: EnrollmentClaim;
  secret?: string;       // existing Volt RPC pairing secret
  workspace: string;
};
```

Validation is strict:

- Unknown object keys are rejected.
- `volt-managed` requires a non-empty, normalized HTTPS origin list and an
  enrollment claim. Its origins must exactly equal the broker response after
  normalization and sorting.
- `custom-uncredentialed` requires non-empty normalized HTTPS origins and must
  not contain an enrollment claim.
- `n0-public` and `disabled` contain no origins or enrollment claim.
- `nodeId` is exactly 64 lowercase hexadecimal characters.
- Pairing expiry and the existing host-fingerprint confirmation are checked
  before app enrollment.

Saved reconnect payloads retain `alpn`, `irohTicket`, `nodeId`, `relay`, and
`workspace`. They remove `expiresAt`, `secret`, and `enrollment` in one
sanitization operation. v1 tickets and records are rejected rather than
silently upgraded.

## Encoding primitives

- Endpoint IDs: 32 raw Ed25519 public-key bytes rendered as lowercase hex. A
  grant's host and client endpoint IDs must be distinct.
- IDs, nonces, secrets, hashes, and signatures: unpadded RFC 4648 base64url.
- `claimId` and request `nonce`: exactly 16 decoded bytes.
- Claim and grant secrets: exactly 32 decoded bytes.
- Hashes: SHA-256 over the decoded raw secret bytes.
- Signatures: Ed25519 over the exact UTF-8 canonical message.
- `issuedAtMs`: a base-10 integer Unix timestamp in milliseconds. The broker
  accepts at most two minutes of absolute clock skew.

The pair grant ID is deterministic and contains no secret:

```text
grantId = BASE64URL(SHA256(
  UTF8("volt-iroh-enrollment-grant-v1\0") ||
  HOST_ENDPOINT_ID_RAW ||
  CLIENT_ENDPOINT_ID_RAW
))
```

Each approval creates a generation identifier derived from the pair and its
secret:

```text
grantGenerationId = BASE64URL(SHA256(
  UTF8("volt-iroh-enrollment-grant-generation-v1\0") ||
  HOST_ENDPOINT_ID_RAW ||
  CLIENT_ENDPOINT_ID_RAW ||
  GRANT_SECRET_RAW
))
```

`grantGenerationId` is public, domain-separated metadata rather than an
authorization secret. It distinguishes successive approvals for the same
`grantId` so a delayed revocation cannot remove a replacement generation.

## Canonical signatures

Every message ends in a final LF. Values may not contain control characters.
There is no whitespace trimming or Unicode normalization after validation.
Fields appear in exactly the listed order.

### Create, inspect, or cancel a claim

The host signs one of `create_claim`, `claim_status`, or `cancel_claim`:

```text
volt-iroh-enrollment-signature-v1
operation:<operation>
host_endpoint_id:<64 lowercase hex>
claim_id:<base64url>
claim_secret_sha256:<base64url>
issued_at_ms:<integer>
nonce:<base64url>
```

Create sends `claimSecretHash`; status and cancellation send the raw
`claimSecret`, from which the broker recomputes the signed hash.

### Approve a claim

The client signs:

```text
volt-iroh-enrollment-signature-v1
operation:approve_claim
host_endpoint_id:<64 lowercase hex>
client_endpoint_id:<64 lowercase hex>
claim_id:<base64url>
claim_secret_sha256:<base64url>
grant_secret_sha256:<base64url>
issued_at_ms:<integer>
nonce:<base64url>
```

The app generates `grantSecret` before its first request and retries with the
same value. This makes approval idempotent even if the successful response is
lost; the broker stores only its hash.

### Renew a grant

The client signs:

```text
volt-iroh-enrollment-signature-v1
operation:renew_grant
host_endpoint_id:<64 lowercase hex>
client_endpoint_id:<64 lowercase hex>
grant_id:<base64url>
grant_secret_sha256:<base64url>
issued_at_ms:<integer>
nonce:<base64url>
```

Renewal requires the grant secret and a consumed limited-use App Check token.
The broker derives `grantGenerationId` from the submitted secret and requires
it to match the current stored generation before extending access.

### Revoke a grant

Either endpoint signs as the explicit revoker:

```text
volt-iroh-enrollment-signature-v1
operation:revoke_grant
host_endpoint_id:<64 lowercase hex>
client_endpoint_id:<64 lowercase hex>
grant_id:<base64url>
grant_generation_id:<base64url>
revoker_endpoint_id:<64 lowercase hex>
issued_at_ms:<integer>
nonce:<base64url>
```

`revokerEndpointId` must equal the host or client endpoint ID, and the broker
verifies the signature with that endpoint's public key. Revoke contains no
grant secret and requires no App Check token, so either side can durably retry
a generation-scoped intent with a fresh signature after deleting the other
side's authority.

Normative vectors, including fixed test-only private keys, canonical bytes, and
signatures, are in
`test/fixtures/iroh-relay-enrollment-v1-vectors.json`. Production code must
never use those keys.

## Broker HTTP API

The daemon and app use the fixed protected origin
`https://iroh-enrollment-us-central.volt-cli.dev`; no broker override or
function-generated fallback exists. Before serverless buffering, JSON routes
require `POST`, no query, exact JSON media type, no `Content-Encoding`, and a
canonical decimal `Content-Length` from 1 through 16,384. Handler raw/parsed
bounds and exact keys remain defense in depth. JSON failures use a stable
`{ "error": "code" }` body without endpoint IDs or secrets.

### Admission and quota ordering

Approval and renewal have this normative order:

1. Parse and bound the JSON request.
2. Check signature freshness and verify the endpoint signature. Renewal also
   rejects a non-deterministic `grantId` here.
3. Reserve one fixed-window `app-check-ip_<HMAC>` slot using the source IP and
   the deployment's secret IP salt.
4. Consume the limited-use App Check token and check its app-id allowlist.
5. Reserve one `request-endpoint_<clientEndpointId>` slot.
6. Run the existing claim or grant transaction.

Quota reservations are never refunded. A rejected or replayed App Check token
keeps its source-IP slot but does not create or increment the signed endpoint's
slot. An invalid endpoint signature consumes neither slot. A state-transaction
failure after successful App Check keeps both slots. The dedicated source limit
returns `429 app_check_ip_rate_limited`; the post-App-Check endpoint limit
retains `429 endpoint_rate_limited`. Raw IP addresses are neither quota document
IDs nor logged fields.

Routes that do not require App Check retain their atomic generic
`request-ip_<HMAC>` plus `request-endpoint_<endpointId>` reservation after
signature validation. This keeps their existing semantics separate from the
expensive replay-protection admission path.

### `POST /v1/claims`

Host request:

```json
{
  "version": 1,
  "hostEndpointId": "...",
  "claimId": "...",
  "claimSecretHash": "...",
  "issuedAtMs": 0,
  "nonce": "...",
  "signature": "..."
}
```

A successful response is `201` (or `200` for an idempotent retry):

```json
{
  "status": "pending",
  "expiresAtEpochSeconds": 0,
  "relayOrigins": ["https://iroh-relay-us-central.volt-cli.dev"]
}
```

### `POST /v1/claims/status` and `/v1/claims/cancel`

Host requests replace `claimSecretHash` with `claimSecret` and use their
matching operation signature. Status returns `pending`, `approved`,
`cancelled`, or `expired`; approved status includes only `clientEndpointId`,
`grantGenerationId`, and `grantExpiresAtEpochSeconds`. Cancellation is
idempotent.

### `POST /v1/claims/approve`

The request requires `X-Firebase-AppCheck` containing a limited-use token:

```json
{
  "version": 1,
  "hostEndpointId": "...",
  "clientEndpointId": "...",
  "claimId": "...",
  "claimSecret": "...",
  "grantSecret": "...",
  "issuedAtMs": 0,
  "nonce": "...",
  "signature": "..."
}
```

The transactional response is:

```json
{
  "status": "approved",
  "grantId": "...",
  "grantGenerationId": "...",
  "expiresAtEpochSeconds": 0,
  "relayOrigins": ["https://iroh-relay-us-central.volt-cli.dev"]
}
```

Only the first client endpoint may consume a claim. The same client, claim, and
grant-secret hash may retry idempotently. Any conflicting retry is denied.

### `POST /v1/grants/renew`

The request contains `version`, both endpoint IDs, `grantId`, `grantSecret`,
`issuedAtMs`, `nonce`, and `signature`. It consumes a limited-use App Check
token and returns the fixed relay origins and a new 30-day expiry.

### `POST /v1/grants/revoke`

The request contains `version`, both endpoint IDs, `grantId`,
`grantGenerationId`, `revokerEndpointId`, `issuedAtMs`, `nonce`, and
`signature`. It contains no `grantSecret` and requires no App Check token. A
matching generation is atomically marked revoked and removed from both endpoint
access maps. Missing grants, already-revoked generations, and superseded
generations return idempotent success without deleting access belonging to a
different current generation.

### Relay authorization callback

The relay calls `POST /v1/relay-access` with:

- `Authorization: Bearer <server-to-server secret>`
- `X-Iroh-NodeId: <64 lowercase hex endpoint ID>`

The callback accepts the current or next rotation secret using timing-safe
comparison. It returns `200 text/plain` with the exact body `true` only when an
endpoint access document has at least one unexpired active grant and is not
administratively blocked. All other results are `false` or an HTTP error, both
of which iroh-relay denies. Unknown endpoint IDs do not create durable quota
state. Known endpoint callbacks retain a durable per-endpoint quota, while the
relay and edge gateway enforce source-network, connection, and aggregate
registration limits before broker work. Responses use `Cache-Control: no-store`;
any positive in-process cache is at most 30 seconds.

## Edge deployment boundary

The repository-owned Terraform under
`examples/remote/firebase-push-relay/infra/` provisions one HTTPS-only global
external Application Load Balancer with exact host/path routing to three
isolated Gen2 functions: `irohEnrollmentApi`, `irohRelayAccess`, and
`pushRelayApi`. Each has its own serverless NEG/backend and retains
`ALLOW_INTERNAL_AND_GCLB`, so generated function URLs reject ordinary Internet
traffic. Unknown hosts, trailing or function-prefixed paths, and all other path
variants reach an empty backend bucket whose edge policy returns 404.

Cloud Armor is a default-deny pre-buffer framing contract. Enrollment JSON uses
the canonical envelope above. The callback additionally requires the exact
`/v1/relay-access` path, `Content-Length: 0`, bounded bearer/node header shapes,
no query or encoding, and the managed relay's stable source CIDR. GCLB owns
declared/body-length consistency. Contract denial returns 403 and rate excess
returns 429. Initial per-IP rates are 30/60 seconds for approval and renewal,
300/60 seconds for other enrollment JSON, and 600/60 seconds for callback
traffic. Push registration independently uses 30/60 seconds and other push JSON
uses 300/60 seconds.

Backend services replace client forwarding content with
`X-Forwarded-For: {client_ip_address},{server_ip_address}`. Cloud Armor keys on
its observed `IP`, never that header. Preview policies project contract and rate
actions while an enforced operator-source allowlist/default deny limits canary
traffic. Separate immutable final policies admit only the public contract. The
full HTTP/1.1/HTTP/2 matrix must correlate every denial to a load-balancer log
with no Cloud Run request/invocation before final attachment. Cloud Armor is an
approximate compute-protection layer; Firestore windows remain the durable exact
application budget.

## Persistence and lifecycle

- Claims expire after 10 minutes and are Firestore-TTL eligible.
- Pair grants expire after 30 days. The app attempts renewal with seven days
  remaining before a relay-dependent reconnect.
- Endpoint access documents map active grant IDs to expiries. Approval,
  renewal, and revocation update both endpoint maps and the grant in one
  Firestore transaction. Expired map entries do not authorize and are cleaned
  opportunistically. Empty unblocked documents are deleted, non-empty unblocked
  documents are TTL eligible at their latest entry expiry, and blocked documents
  remain durable without a TTL.
- Defaults cap three pending claims per host, twenty active grants per endpoint,
  ten new host grants per client endpoint per day, and six renewals per grant
  per hour. One-minute request windows default to 60 per signed endpoint and
  300 per salted source IP for generic routes. Approval and renewal additionally
  use a strict 30-per-salted-IP App Check window before replay protection.
- If the broker is unavailable, relay registration fails closed. Existing
  paired devices may still connect directly or on the LAN.
- Forget writes a durable local revocation intent keyed by `grantId` and
  `grantGenerationId` before deleting peer authority. The intent stores the
  endpoint pair, grant ID, generation ID, and revoker endpoint ID, but no grant
  secret or reusable signature. Every attempt creates a fresh nonce, timestamp,
  and revoker signature, including retries after local expiry or process
  restart. The intent remains until the broker acknowledges it.
- The app derives and stages this generation-keyed obligation before dispatching
  approval because a committed response can be lost. A successfully committed
  saved-host grant protects its matching staged obligation by stable generation
  fields, independent of expiry drift.
- The daemon durably queues broker-claim cancellation before local cleanup. If
  claim approval names client endpoint A but the consumed RPC transport
  authenticates endpoint B, one local transaction stages rejection of B and a
  host-signed broker revocation intent for A before the pairing is rejected.
  Both queues drain across restart, re-signing every request, before their
  obligations are removed.
- Daemon/app integration owns the full approve-A/connect-B/reject-B/revoke-A
  across-restart test. This broker-only slice contains no daemon or app state
  implementation and verifies the generation-scoped wire and Firestore
  contract instead.
- On upgrade, the daemon immediately rewrites state that contains a deprecated
  top-level or `settings.relayAuthToken`; the app deletes its legacy static
  relay Keychain credential while rejecting v1 saved-host authority. Migration
  never converts a fleet credential into a pair grant.

## Relay limitation

The stock relay's HTTP decision occurs when an endpoint registers. Revocation
and connection-admission quotas therefore apply to the next registration, not
to bytes already flowing on an open registration. Volt applies relay-wide
concurrency/egress ceilings and alerts as a blast-radius backstop. Active-session
reauthorization or per-endpoint byte quotas require upstream relay support or a
separately reviewed Volt relay fork and are not properties of this protocol.
