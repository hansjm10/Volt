# Firebase push relay and Iroh enrollment broker

This Firebase deployment contains three isolated HTTPS functions behind one protected edge:

- `pushRelayApi` stores raw FCM registration tokens in the named `volt-push-relay` Firestore database and gives the mobile app an opaque target id plus a target-scoped credential;
- `irohEnrollmentApi` stores relay admission state in the named `volt-iroh-enrollment` Firestore database and enrolls exact phone/desktop Iroh endpoint pairs without accounts or a client-visible infrastructure bearer; and
- `irohRelayAccess` authorizes bodyless managed-relay registrations against that shared enrollment state.

Each function has a distinct user-managed runtime service account. Database-conditioned IAM grants each identity access only to its named database; only the callback identity receives the relay callback secrets. Firestore Security Rules deny all mobile and web clients but are not the server-side isolation boundary. The legacy `pushRelay` and `irohEnrollment` exports exist only as temporary, unshipped rollback targets during edge rollout and must be retired after the recorded soak.

Neither service authorizes desktop RPC. Volt pairing, the authenticated Iroh transport, the host-observed client endpoint identity, and persisted RPC/tool grants remain the desktop-control boundary.

## Rollout status

This directory includes the backend and repository-owned Terraform for its pre-buffer admission boundary. Applying it still requires the ownership preflight, separate canary when that gate fails, additive function deployment, preview/final policy phases, dependency-ordered client cutover, and monitored soak in [`infra/README.md`](./infra/README.md). Checked-in code or a successful local plan does not imply that production traffic has moved.

## Security contract

- Registration requires an `X-Firebase-AppCheck` **limited-use** token. The function consumes the token, requires its one-time `jti`, and allowlists the Firebase app id. There is no embedded or shared app secret.
- One FCM token maps to one deterministic Firestore document. Re-registering rotates the target credential instead of growing an attacker-controlled collection.
- Target credentials are stored only as SHA-256 hashes. FCM tokens remain raw because Firebase Messaging needs them, so clients are denied and only the push runtime identity can access the `volt-push-relay` database.
- Targets expire after 30 days by default. Every delivery rejects an expired target immediately; the deployed Firestore TTL policy deletes expired documents asynchronously.
- The app validates a cached target through the credential-authenticated status route before reuse. A host-side revoke therefore causes fresh App Check registration instead of leaving the phone stuck on a dead credential.
- Before Functions Framework buffering, Cloud Armor requires POST, no query, exact JSON media type, no `Content-Encoding`, and canonical `Content-Length` from 1 through 16,384. Handler raw/parsed caps plus explicit field, UTF-8 string, object-depth, key-count, and array-count bounds remain defense in depth. Notification copy and metadata reject controls and path separators. FCM data is restricted to event, kind, workspace/session authority, and one navigation ID, so commands, diffs, and host paths cannot be forwarded.
- Each target reserves a delivery quota slot in a Firestore transaction before FCM is called. Failures consume the slot, preventing a failing send from creating a hot retry loop.
- Registration also has a per-instance burst cap. Bounded concurrency, instance count, memory, and request time are defense in depth, not substitutes for a project-level budget and edge rate limit.
- `relayUrl` is returned only from the validated `PUSH_RELAY_URL` setting (or the compiled production URL); request `Host` and forwarding headers are never reflected.
- Explicit revocation requires the target id and target credential. Desktop unpair is locally authoritative even if remote cleanup fails; the finite target TTL bounds its lifetime.

The functions retain public invokers because an unattached iOS app and the managed relay must reach them through the load balancer, but `ALLOW_INTERNAL_AND_GCLB` rejects direct Internet access to their generated URLs. Cloud Armor is the pre-buffer admission boundary. App Check attestation remains the registration authorization boundary, while notification and revoke routes use the random per-target credential.

## Iroh enrollment security contract

- A strict `volt+iroh://v2` QR contains a 10-minute claim ID and independent 256-bit claim secret, but no broker URL, durable pair secret, App Check token, or relay infrastructure bearer.
- The host and phone sign canonical, versioned request bytes with their Iroh Ed25519 endpoint keys. Signed timestamps accept at most ±2 minutes of skew.
- Claim approval is single-use and idempotent for the exact phone endpoint and phone-generated grant secret. The resulting deterministic pair grant lasts 30 days and renewal consumes another limited-use App Check token when seven days remain.
- Approval and renewal validate the schema and endpoint signature before reserving a dedicated salted source-IP slot, then consume and allowlist App Check, then reserve the signed client endpoint slot, and only then run the claim/grant transaction. Quota slots are never refunded. Rejected or replayed App Check traffic keeps only the source-IP slot; invalid signatures consume neither slot.
- Firestore transactions update claims, grants, both endpoint access maps, and durable quota windows in `volt-iroh-enrollment`. Empty unblocked endpoint documents are deleted, active endpoint documents are TTL eligible, and administrative blocks remain durable. Rules deny all direct client access, while database-conditioned IAM excludes the push runtime identity. Defaults cap pending claims, active endpoint grants, new-host approvals, renewals, generic endpoint-plus-salted-IP requests, and the separate App Check source-IP window.
- A managed relay calls `POST /v1/relay-access` with `X-Iroh-NodeId` and a server-to-server bearer. Only `200 text/plain` with exact body `true` permits registration. Current/next bearer overlap supports rotation. Unknown endpoint IDs do not create attacker-keyed quota documents, and the relay must enforce source-network, connection, and aggregate registration limits before invoking the callback.
- Approval derives and returns a public `grantGenerationId` from the endpoint pair and phone-generated grant secret. Revocation carries that generation plus an explicit host-or-phone revoker endpoint, contains no grant secret, and requires no App Check. Matching revocation is atomic; stale generations succeed without removing a replacement pair grant.
- This access hook runs when an endpoint registers. Revocation cannot interrupt an already-open registration and does not meter bytes per endpoint; relay-wide ceilings are separate deployment backstops.

The downstream daemon/app integration must persist revocation intents keyed by
`grantId` plus `grantGenerationId`; persisted intent state contains stable
canonical fields, not a reusable signature. Each attempt creates a fresh nonce,
timestamp, and signature, including after restart. When claim approval names
client endpoint A but the RPC connection authenticates endpoint B, the daemon
must atomically stage local rejection of B together with a host-signed broker
revocation intent for A, then drain that intent to broker acknowledgement across
restart. App Forget uses the same generation-keyed pattern with a client
signature.

This directory intentionally has no daemon or app implementation. The full
approve-A/connect-B/reject-B/revoke-A-across-restart scenario belongs to that
downstream integration slice; this broker suite verifies the contract and
transactional generation guard.

The normative ticket, canonical signing, persistence, and lifecycle contract is [Iroh relay enrollment design](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/iroh-relay-enrollment-design.md).

## Routes

- `POST /v1/push-targets`: mobile app registration with `X-Firebase-AppCheck`; body `{ provider:"fcm", platform:"ios", token, enabled }`; returns `{ pushTargetId, pushTargetAuthToken, relayUrl, tokenHash, expiresAtEpochSeconds }`.
- `POST /v1/push-targets/revoke`: app or host cleanup with `{ pushTargetId, pushTargetAuthToken }`; returns `revoked` or idempotent `already_revoked`.
- `POST /v1/push-targets/status`: credential-authenticated cache validation; returns `{ status:"active", expiresAtEpochSeconds }`, or `401`/`404`/`410` when the cached credential must be replaced.
- `POST /v1/notifications`: desktop delivery with `{ pushTargetId, pushTargetAuthToken, eventId, kind, title, body, workspaceName?, planId?, workflowId?, data }`.

Notification delivery accepts `conversation_completed`, `plan_ready`, `review_completed`, `action_completed`, and `host_notice`. `plan_ready` requires `planId`; `review_completed` requires `workflowId`; the navigation fields are mutually exclusive and forbidden on other kinds. Top-level and `data` values must agree. The bounded FCM data shape is forwarded unchanged:

```json
{
  "eventId": "plan:session-one:run-one:ready",
  "kind": "plan_ready",
  "sessionId": "session-one",
  "workspaceName": "volt-app",
  "planId": "plan-one"
}
```

`workflowId` replaces `planId` for review completion. Notification titles are limited to 128 UTF-8 bytes, bodies to 512, workspace/session/navigation values to 128, event IDs to 512, and kinds to 64. Unknown fields, mismatched metadata, unsafe characters, whitespace in identifiers, and path separators are rejected.

Volt host state stores only the opaque relay target id, target-scoped credential, and optional FCM token hash.

## Required Firebase setup

1. Register the production iOS app and include its generated `GoogleService-Info.plist` in the app target.
2. Enable Firebase App Check. Production devices use App Attest with DeviceCheck fallback. Simulator/debug builds use `AppCheckDebugProvider` and succeed only after their generated debug token is explicitly registered in Firebase Console.
3. Confirm the Firebase app id matches `ALLOWED_FIREBASE_APP_IDS`. Self-hosted and canary deployments must override the built-in production app id.
4. Enable replay protection for limited-use App Check tokens; approval and renewal request them with `consume: true`.
5. Configure APNs credentials in Firebase Console for ordinary FCM notifications.
6. Create `IROH_ENROLLMENT_IP_SALT`, `IROH_RELAY_ACCESS_SECRET_CURRENT`, and `IROH_RELAY_ACCESS_SECRET_NEXT` with `firebase functions:secrets:set`. Values are 32-512 printable non-space characters; keep `NEXT` set to an independently generated standby value even before rotation.
7. Create the `volt-push-relay` and `volt-iroh-enrollment` named Firestore databases in the same location, then deploy their separate deny-all client rules and index definitions. The checked-in field overrides enable TTL on each database's `expiresAt` fields; authorization never relies on asynchronous TTL deletion.
8. Use three distinct runtime identities: `volt-push-relay`, `volt-iroh-enrollment`, and `volt-iroh-relay-access`. Set their emails in `PUSH_RELAY_SERVICE_ACCOUNT`, `IROH_ENROLLMENT_SERVICE_ACCOUNT`, and `IROH_RELAY_ACCESS_SERVICE_ACCOUNT`. Deployment fails if an account is absent, malformed, or reused.
9. Apply the database-conditioned, secret-specific, logging, App Check, and FCM IAM grants through the checked-in Terraform. Remove basic roles and unconditional Datastore roles from all runtime identities. Configure the checked-in alerts and budget before canary traffic.

For an Internet-facing deployment, route app and relay enrollment traffic through the reviewed load-balanced broker URL. `PUSH_RELAY_URL` configures only the separately authorized push function and is not the enrollment broker URL. The Firebase command below does not provision the load balancer, Cloud Armor policy, service account, or IAM grants.

## Protected edge deployment runbook

[`infra/`](./infra/) is the only supported load-balancer/IAM deployment path. Its manifest-driven Terraform owns the HTTPS-only frontend, exact host/path URL map, three isolated serverless NEGs/backends, DNS-only records, certificate, generated forwarding header, immutable preview/final Cloud Armor policies, reject bucket, alerts, and budget wiring.

The ownership gate runs before mutation. If any active target, claim, grant, endpoint record, App Check debug token, relay registration, or traffic source is not operator-owned, stop and use a separate canary project. Deploy `irohEnrollmentApi`, `irohRelayAccess`, and `pushRelayApi` additively by explicit Firebase target while leaving rollback exports untouched. Terraform then verifies each deployed function's ingress, identity, concurrency, memory, and exact secret set before it can be routed.

Preview admission enforces an operator-source allowlist while projecting candidate contract/rate actions. Final admission requires canonical JSON framing or the exact zero-byte callback contract and defaults to deny. Function-prefixed, trailing-slash, unknown, and wrong-host paths always reach the 404 reject bucket; there is no compatibility route. Use Cloud Armor's observed `IP`, never a client forwarding header, for rate keys. Cloud Armor throttling remains an approximate compute-protection layer; Firestore windows are the durable exact application budget.

Do not cut clients over until the full HTTP/1.1/HTTP/2 matrix correlates every edge denial to a load-balancer log with no Cloud Run request/invocation. The exact bootstrap, import, preview/final apply, evidence, and rollback commands are in [`infra/README.md`](./infra/README.md).

## Configuration

- `ALLOWED_FIREBASE_APP_IDS`: comma-separated allowlist, 1-8 app ids.
- `PUSH_RELAY_URL`: canonical absolute HTTPS relay URL; credentials, query, and fragment are rejected.
- `PUSH_TARGET_TTL_DAYS`: 1-90, default 30.
- `DELIVERIES_PER_TARGET_PER_MINUTE`: 1-600, default 30.
- `REGISTRATIONS_PER_INSTANCE_PER_MINUTE`: 1-120, default 30.
- `FUNCTION_REGION`: deployment region, default `us-central1`.
- `PUSH_RELAY_SERVICE_ACCOUNT`: required dedicated user-managed push runtime service account email.
- `IROH_RELAY_ORIGINS`: comma-separated 1-8 canonical HTTPS origins returned to both endpoints; default `https://iroh-relay-us-central.volt-cli.dev`.
- `IROH_ENROLLMENT_SERVICE_ACCOUNT`: required dedicated enrollment API runtime service account email.
- `IROH_RELAY_ACCESS_SERVICE_ACCOUNT`: required dedicated relay callback runtime service account email.
- `IROH_ENROLLMENT_APP_CHECK_REQUESTS_PER_IP_PER_MINUTE`: durable salted source-IP quota charged before approval/renewal App Check replay protection, 1-600, default 30.
- `IROH_ENROLLMENT_REQUESTS_PER_ENDPOINT_PER_MINUTE`: durable endpoint quota, 1-600, default 60.
- `IROH_ENROLLMENT_REQUESTS_PER_IP_PER_MINUTE`: durable salted-IP quota, 1-3000, default 300.
- Secret Manager only (never `.env`): `IROH_ENROLLMENT_IP_SALT`, `IROH_RELAY_ACCESS_SECRET_CURRENT`, and `IROH_RELAY_ACCESS_SECRET_NEXT`.

Database IDs are intentionally fixed in code and `firebase.json`; making them environment-configurable would let deployment drift collapse the isolation boundary.

## Runtime IAM boundary

Terraform owns the runtime IAM boundary in [`infra/apis-iam.tf`](./infra/apis-iam.tf). The push identity receives only its named database, App Check verification, FCM, and logging grants. The enrollment API identity receives only the enrollment database, App Check verification, its IP-salt secret, and logging. The callback identity receives only the enrollment database, current/next callback secrets, and logging. The deployer separately needs permission to act as all three identities.

Do not reproduce these grants with unconditional project bindings. In particular, do not grant a runtime identity `roles/editor`, `roles/owner`, unconditional `roles/datastore.user`, the other service's secrets, or the other product's permissions. Firestore Admin SDK calls bypass Security Rules, so the Terraform-managed conditional IAM bindings are the enforced server-side boundary.

## Deploy

From this directory, create the databases once with deletion protection. Apply the Terraform IAM foundation, then deploy the three additive functions by explicit target while leaving the two rollback exports untouched:

```bash
firebase use volt-3fae7
firebase firestore:databases:create volt-push-relay --project volt-3fae7 --location nam5 --delete-protection ENABLED
firebase firestore:databases:create volt-iroh-enrollment --project volt-3fae7 --location nam5 --delete-protection ENABLED
firebase deploy --project volt-3fae7 --only firestore
firebase deploy --project volt-3fae7 \
  --only functions:volt-push-relay:irohEnrollmentApi,functions:volt-push-relay:irohRelayAccess,functions:volt-push-relay:pushRelayApi
```

Cloud Functions deployment requires the Blaze plan. All three functions use `ALLOW_INTERNAL_AND_GCLB`; only the protected edge should admit Internet traffic. Do not route canary or production traffic until App Check, the app-id allowlist, APNs, TTL, monitoring, budgets, exact runtime identities/secrets, preview policy, and relay-side limits are verified.

For a self-hosted relay, point the host at the same canonical URL configured in `PUSH_RELAY_URL`:

```bash
export VOLT_PUSH_RELAY_URL="https://push.example.com/"
volt daemon start
volt remote workspace add /path/to/Volt --name volt
```

## Emulator transaction tests

Install the Functions dependencies, then run the real Firestore transaction suite through the checked-in emulator configuration:

```bash
cd functions
npm ci
npm run test:emulator
```

The test refuses to run without `FIRESTORE_EMULATOR_HOST`, uses a `demo-*` project, and targets `volt-iroh-enrollment` through the single-database `firebase.emulator.json` so the emulator loads the intended deny-all rules instead of implicitly creating an open named database. It verifies real transactional create/approve/idempotency behavior, both revocation signers, both endpoint access maps, and stale-generation safety. The local script pins the Firebase CLI version and disables lifecycle scripts; CI instead verifies the published standalone CLI checksum before execution. The normal `npm test` suite remains fast and uses isolated adapters for strict-schema, signature, App Check, quota, and failure-path coverage.

## Real App Check canary

Use a separate Firebase canary project/app and the checked-in `canary.env.example`; never point a canary at production Firestore. Create both named databases and distinct canary runtime identities with the same conditional IAM boundary. Register the canary iOS bundle and its simulator debug token in Firebase App Check, set only the canary app id in `ALLOWED_FIREBASE_APP_IDS`, deploy both Firestore schemas and functions, and configure independently generated canary secrets. Build the app with the canary `GoogleService-Info.plist` and the reviewed fixed broker URL; do not accept a broker destination from a QR, launch argument, user default, or remote response.

Before promoting, verify each runtime identity can read and write only its named database and receives `PERMISSION_DENIED` from the other one. Also verify managed origins match exactly, revoke removes both endpoint access entries, an invalid relay callback bearer returns false, and broker outage still permits direct/LAN pairing.

The framing, App Check, and rate checks are a hard canary gate. Before the numbered durable-quota exercise, run the full edge matrix from an operator-allowed source: JSON lengths 1, 16,384, and 16,385; callback lengths 0 and 1; missing, duplicate, leading-zero, and non-numeric lengths; HTTP/1.1 chunked framing; `Content-Encoding`; declared/body mismatch over HTTP/1.1 and HTTP/2; wrong methods, media, query, trailing, prefixed, unknown, and wrong-host paths; forged forwarding headers; callback requests inside and outside the relay CIDR; all rate thresholds; and direct generated URLs. Every denial must correlate to a load-balancer log with no Cloud Run request/invocation. Require a successful canonical request on every route, a zero-byte callback, and 16,384-byte edge admission before final policy attachment.

Use three independently routed known sources so the edge-only, durable-limit, and unexhausted-source cases cannot share a source window. Run sequentially within one-minute windows. Do not add the raw source IP, forwarded headers, token, or salt to broker logs or retained evidence. Compute document IDs offline as
`BASE64URL(HMAC-SHA256(canary IP salt, UTF8(known source IP)))`; retain only the salted id, counts, request correlation ids, revisions, and status/error codes.

1. Keep the checked-in canary broker limit of 5 requests/minute and the Cloud Armor rule at 30 requests/60 seconds. Record the exact function, backend-service, and security-policy revisions.
2. While the Cloud Armor rule is in preview, send 31 requests from source A to one edge-covered expensive route using correctly bounded bodies with invalid endpoint signatures so the broker reserves no quota and never invokes App Check. Require all requests to reach the backend with `401 signature_invalid`, and require the over-threshold requests to carry the preview rule match in Cloud Armor logs. After a fresh 60-second edge window, repeat for the other expensive route. Require every function-prefixed path to reach the 404 reject bucket.
3. From source B, submit a valid signed approval or renewal with a rejected/replayed limited-use token. Read only the exact expected `voltIrohEnrollmentQuotaWindows/app-check-ip_<salted-id>` document and require count 1; require the client endpoint quota document to remain absent or unchanged. Repeat once with a forged `X-Forwarded-For` header. Require the same salted document id and count 2, proving the backend header replacement prevents spoofing from changing broker identity.
4. Continue valid signed requests with rejected/replayed App Check material from source B until the durable count is 5. Require the next request to return `429 {"error":"app_check_ip_rate_limited"}` without incrementing the document or the signed endpoint quota. Use broker outcome logs and exact Firestore document reads, never a raw-IP query.
5. Acquire a fresh real limited-use token and first submit it from exhausted source B. Require the same broker 429. Submit that exact token and valid signed operation from unexhausted source C; require success, the source-C salted document count to become 1, and the endpoint quota to increment. Success proves the exhausted-source request stopped before Firebase replay protection and that an unexhausted legitimate source remains admitted. Replay the now-consumed token once from source C and require App Check rejection plus a retained source-C slot but no additional endpoint slot.
6. Disable Cloud Armor preview without changing the path match or 30/60 threshold, then repeat the edge-threshold portion and require the 429 to be enforced before a serverless invocation. Archive redacted evidence for both Cloud Armor and durable broker limits.

Delete the simulator debug token and canary grants after the exercise.

## Secret rotation and incident revocation

Rotate relay callback authentication with overlap: set a new backend `NEXT`, deploy, replace and restart one managed relay credential at a time, verify each relay, then promote the new value to `CURRENT` and replace `NEXT` with a fresh standby. Never clear current and next together. The [self-hosted relay guide](../../../../../docs/self-hosted-relay.md) defines the pinned callback origin, root-owned relay credential, zero-byte framing proxy, service restart, health probe, and rollback procedure.

For a compromised endpoint, transactionally mark its endpoint-access document blocked or revoke its pair grants, then inspect grants for the peer endpoints. This denies the next relay registration but cannot interrupt an existing stock-relay registration. For a callback-secret incident, rotate with the shortest safe overlap, restart every relay, review callback denials/egress, and never restore the retired fleet credential.

## Error behavior

Invalid or expired push targets return `410`, prompting host-side target disabling. Other FCM send failures return `502 { error: "fcm_send_failed", code }`. Enrollment routes return bounded stable error codes and relay access returns false on denial. Cloud Logging records only bounded route/outcome/latency or safe error names, never endpoint IDs, claim/grant secrets, FCM tokens, target credentials, or callback bearers.
