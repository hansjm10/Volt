# Iroh relay enrollment design

Status: normative v1 enrollment contract for the v2 Volt pairing ticket.

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

- Endpoint IDs: 32 raw Ed25519 public-key bytes rendered as lowercase hex.
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

### Renew or revoke a grant

The client signs `renew_grant` or `revoke_grant`:

```text
volt-iroh-enrollment-signature-v1
operation:<operation>
host_endpoint_id:<64 lowercase hex>
client_endpoint_id:<64 lowercase hex>
grant_id:<base64url>
grant_secret_sha256:<base64url>
issued_at_ms:<integer>
nonce:<base64url>
```

Renewal additionally requires a consumed limited-use App Check token. Revoke
requires the pair secret plus endpoint signature so it can be durably retried
after local Forget even when App Check is temporarily unavailable.

Normative vectors, including fixed test-only private keys, canonical bytes, and
signatures, are in
`test/fixtures/iroh-relay-enrollment-v1-vectors.json`. Production code must
never use those keys.

## Broker HTTP API

The daemon and app use the fixed HTTPS `irohEnrollment` function. JSON routes
accept only `POST`, `Content-Type: application/json`, bounded bodies, and exact
keys. JSON failures use a stable `{ "error": "code" }` body without endpoint
IDs or secrets.

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
`cancelled`, or `expired`; approved status includes only `clientEndpointId` and
`grantExpiresAtEpochSeconds`. Cancellation is idempotent.

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
  "expiresAtEpochSeconds": 0,
  "relayOrigins": ["https://iroh-relay-us-central.volt-cli.dev"]
}
```

Only the first client endpoint may consume a claim. The same client, claim, and
grant-secret hash may retry idempotently. Any conflicting retry is denied.

### `POST /v1/grants/renew` and `/v1/grants/revoke`

Both requests contain `version`, both endpoint IDs, `grantId`, `grantSecret`,
`issuedAtMs`, `nonce`, and `signature`. Renewal consumes a limited-use App Check
token. It returns the fixed relay origins and a new 30-day expiry. Revoke is
idempotent and removes this grant from both endpoint access maps.

### Relay authorization callback

The relay calls `POST /v1/relay-access` with:

- `Authorization: Bearer <server-to-server secret>`
- `X-Iroh-NodeId: <64 lowercase hex endpoint ID>`

The callback accepts the current or next rotation secret using timing-safe
comparison. It returns `200 text/plain` with the exact body `true` only when an
endpoint access document has at least one unexpired active grant and is not
administratively blocked. All other results are `false` or an HTTP error, both
of which iroh-relay denies. Responses use `Cache-Control: no-store`; any
positive in-process cache is at most 30 seconds.

## Persistence and lifecycle

- Claims expire after 10 minutes and are Firestore-TTL eligible.
- Pair grants expire after 30 days. The app attempts renewal with seven days
  remaining before a relay-dependent reconnect.
- Endpoint access documents map active grant IDs to expiries. Approval,
  renewal, and revocation update both endpoint maps and the grant in one
  Firestore transaction. Expired map entries do not authorize and are cleaned
  opportunistically.
- Defaults cap three pending claims per host, twenty active grants per endpoint,
  ten new host grants per client endpoint per day, six renewals per grant per
  hour, and durable endpoint-plus-salted-IP request windows.
- If the broker is unavailable, relay registration fails closed. Existing
  paired devices may still connect directly or on the LAN.
- Forget writes a durable local revocation intent before deleting endpoint
  authority. A retry worker keeps submitting the signed pair-scoped revoke,
  including after local expiry, until the broker acknowledges it. Intent
  deduplication includes the grant secret so one generation cannot erase
  another generation's cleanup authority.
- The app stages revocation authority before dispatching approval because a
  committed response can be lost. A successfully committed saved-host grant
  protects a matching staged obligation by stable grant authority fields,
  independent of expiry drift.
- The daemon durably queues broker-claim cancellation before local cleanup.
  It also queues client revocation before rejecting any pairing whose consumed
  RPC endpoint differs from the broker-approved endpoint; both queues drain
  across restart before their obligations are removed.
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
