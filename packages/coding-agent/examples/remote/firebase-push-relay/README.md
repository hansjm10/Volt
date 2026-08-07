# Firebase push relay and Iroh enrollment broker

This Firebase deployment contains two separate HTTPS functions:

- `pushRelay` stores raw FCM registration tokens in the named `volt-push-relay` Firestore database and gives the mobile app an opaque target id plus a target-scoped credential; and
- `irohEnrollment` stores relay admission state in the named `volt-iroh-enrollment` Firestore database and enrolls exact phone/desktop Iroh endpoint pairs without accounts or a client-visible infrastructure bearer.

The functions require distinct user-managed runtime service accounts. Database-conditioned IAM grants each identity access only to its own named database; Firestore Security Rules deny all mobile and web clients but are not the server-side isolation boundary.

Neither service authorizes desktop RPC. Volt pairing, the authenticated Iroh transport, the host-observed client endpoint identity, and persisted RPC/tool grants remain the desktop-control boundary.

## Rollout status

This directory provides the broker contract and deployable backend only. It does not change the current daemon, app, or relay configuration by itself. Managed relay callbacks, v2 pairing tickets, and app enrollment must land and be deployed together before this broker becomes the production admission boundary. Until then, the existing shared-token relay path remains in effect.

## Security contract

- Registration requires an `X-Firebase-AppCheck` **limited-use** token. The function consumes the token, requires its one-time `jti`, and allowlists the Firebase app id. There is no embedded or shared app secret.
- One FCM token maps to one deterministic Firestore document. Re-registering rotates the target credential instead of growing an attacker-controlled collection.
- Target credentials are stored only as SHA-256 hashes. FCM tokens remain raw because Firebase Messaging needs them, so clients are denied and only the push runtime identity can access the `volt-push-relay` database.
- Targets expire after 30 days by default. Every delivery rejects an expired target immediately; the deployed Firestore TTL policy deletes expired documents asynchronously.
- The app validates a cached target through the credential-authenticated status route before reuse. A host-side revoke therefore causes fresh App Check registration instead of leaving the phone stuck on a dead credential.
- Registration, notification, and revocation bodies have a 16 KiB total cap plus explicit field, UTF-8 string, object-depth, key-count, and array-count bounds. Notification copy and metadata reject controls and path separators. FCM data is restricted to event, kind, workspace/session authority, and one navigation ID, so commands, diffs, and host paths cannot be forwarded.
- Each target reserves a delivery quota slot in a Firestore transaction before FCM is called. Failures consume the slot, preventing a failing send from creating a hot retry loop.
- Registration also has a per-instance burst cap. Bounded concurrency, instance count, memory, and request time are defense in depth, not substitutes for a project-level budget and edge rate limit.
- `relayUrl` is returned only from the validated `PUSH_RELAY_URL` setting (or the compiled production URL); request `Host` and forwarding headers are never reflected.
- Explicit revocation requires the target id and target credential. Desktop unpair is locally authoritative even if remote cleanup fails; the finite target TTL bounds its lifetime.

The function remains publicly invokable because an unattached iOS app must reach registration. App Check attestation is the registration authorization boundary. Notification and revoke routes use the random per-target credential.

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
8. Create distinct `volt-push-relay` and `volt-iroh-enrollment` runtime service accounts. Apply the database-conditioned and product-specific IAM grants below, then set their emails in `PUSH_RELAY_SERVICE_ACCOUNT` and `IROH_ENROLLMENT_SERVICE_ACCOUNT`. Deployment fails if either account is absent, malformed, or reused for both functions.
9. Remove basic roles and unconditional Datastore roles from both runtime identities. Enable audit logs and budget alerts, and monitor App Check failures, callback latency/denials, quota responses, active grant counts, and `5xx` responses.

For an Internet-facing deployment, route app and relay enrollment traffic through the reviewed load-balanced broker URL. `PUSH_RELAY_URL` configures only the separately authorized push function and is not the enrollment broker URL. The Firebase command below does not provision the load balancer, Cloud Armor policy, service account, or IAM grants.

## Enrollment edge deployment runbook

This example owns Firebase configuration but no load-balancer IaC. The operator must provision and review the following resources in the deployment's infrastructure repository or change-management system:

1. Create a **global external Application Load Balancer** with an HTTPS frontend and a serverless NEG that targets the deployed `irohEnrollment` Cloud Run function. Keep the function's checked-in `ALLOW_INTERNAL_AND_GCLB` ingress setting. Confirm the generated function URL rejects ordinary Internet requests so Cloud Armor cannot be bypassed.
2. Attach a Cloud Armor policy to the enrollment backend service. Add a per-source-IP `throttle` rule with a 30-request/60-second threshold, `allow` conform action, and `deny-429` exceed action. Match only `POST /v1/claims/approve` and `POST /v1/grants/renew`. If the URL map also exposes the function-prefixed forms, include `POST /irohEnrollment/v1/claims/approve` and `POST /irohEnrollment/v1/grants/renew`; otherwise reject every `/irohEnrollment/...` path at the URL map. Use the `IP` key observed by Cloud Armor, not client-supplied `XFF_IP`.
3. Replace all incoming `X-Forwarded-For` content at the backend service instead of accepting the load balancer's default append behavior. Configure the custom request header as `x-forwarded-for:{client_ip_address},{server_ip_address}`. Do not preserve the client-supplied value in another backend-visible identity header. The broker's salted IP quota must resolve from this provider-generated chain.
4. Enable load-balancer and Cloud Armor request logging. Create the throttle rule in preview, exercise both canonical expensive paths and any intentionally accepted prefixed paths, and review matched-rule, source-key, projected-429, and backend invocation data. Fix missing or over-broad matches before proceeding.
5. Run the real canary gate below while the rule is still in preview. Then disable preview without changing its match or 30/60 threshold, rerun the edge-limit checks, and retain the Cloud Armor rule revision, backend-service revision, canary function revision, and redacted query results as release evidence.

Cloud Armor throttling is an approximate first layer that protects serverless compute. The Firestore `app-check-ip_<HMAC>` window is the durable exact budget before App Check replay protection. Both layers are required. See the official [serverless NEG](https://cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts), [Cloud Armor rate limiting](https://cloud.google.com/armor/docs/rate-limiting-overview), and [external Application Load Balancer](https://cloud.google.com/load-balancing/docs/https) documentation before changing this boundary.

## Configuration

- `ALLOWED_FIREBASE_APP_IDS`: comma-separated allowlist, 1-8 app ids.
- `PUSH_RELAY_URL`: canonical absolute HTTPS relay URL; credentials, query, and fragment are rejected.
- `PUSH_TARGET_TTL_DAYS`: 1-90, default 30.
- `DELIVERIES_PER_TARGET_PER_MINUTE`: 1-600, default 30.
- `REGISTRATIONS_PER_INSTANCE_PER_MINUTE`: 1-120, default 30.
- `FUNCTION_REGION`: deployment region, default `us-central1`.
- `PUSH_RELAY_SERVICE_ACCOUNT`: required dedicated user-managed push runtime service account email.
- `IROH_RELAY_ORIGINS`: comma-separated 1-8 canonical HTTPS origins returned to both endpoints; default `https://iroh-relay-us-central.volt-cli.dev`.
- `IROH_ENROLLMENT_SERVICE_ACCOUNT`: required dedicated user-managed runtime service account email. Deployment fails when it is absent or malformed.
- `IROH_ENROLLMENT_APP_CHECK_REQUESTS_PER_IP_PER_MINUTE`: durable salted source-IP quota charged before approval/renewal App Check replay protection, 1-600, default 30.
- `IROH_ENROLLMENT_REQUESTS_PER_ENDPOINT_PER_MINUTE`: durable endpoint quota, 1-600, default 60.
- `IROH_ENROLLMENT_REQUESTS_PER_IP_PER_MINUTE`: durable salted-IP quota, 1-3000, default 300.
- Secret Manager only (never `.env`): `IROH_ENROLLMENT_IP_SALT`, `IROH_RELAY_ACCESS_SECRET_CURRENT`, and `IROH_RELAY_ACCESS_SECRET_NEXT`.

Database IDs are intentionally fixed in code and `firebase.json`; making them environment-configurable would let deployment drift collapse the isolation boundary.

## Runtime IAM boundary

Provision the runtime identities once. The deployer separately needs permission to act as both service accounts.

```bash
PROJECT_ID=volt-3fae7
PUSH_SERVICE_ACCOUNT="volt-push-relay@${PROJECT_ID}.iam.gserviceaccount.com"
ENROLLMENT_SERVICE_ACCOUNT="volt-iroh-enrollment@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create volt-push-relay --project "$PROJECT_ID"
gcloud iam service-accounts create volt-iroh-enrollment --project "$PROJECT_ID"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PUSH_SERVICE_ACCOUNT}" \
  --role=roles/datastore.user \
  --condition="expression=resource.name==\"projects/${PROJECT_ID}/databases/volt-push-relay\",title=push-relay-database,description=Push_runtime_database_only"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${ENROLLMENT_SERVICE_ACCOUNT}" \
  --role=roles/datastore.user \
  --condition="expression=resource.name==\"projects/${PROJECT_ID}/databases/volt-iroh-enrollment\",title=iroh-enrollment-database,description=Enrollment_runtime_database_only"

for SERVICE_ACCOUNT in "$PUSH_SERVICE_ACCOUNT" "$ENROLLMENT_SERVICE_ACCOUNT"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role=roles/firebaseappcheck.tokenVerifier \
    --condition=None
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role=roles/logging.logWriter \
    --condition=None
done

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PUSH_SERVICE_ACCOUNT}" \
  --role=roles/firebasecloudmessaging.admin \
  --condition=None

for SECRET in IROH_ENROLLMENT_IP_SALT IROH_RELAY_ACCESS_SECRET_CURRENT IROH_RELAY_ACCESS_SECRET_NEXT; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project "$PROJECT_ID" \
    --member="serviceAccount:${ENROLLMENT_SERVICE_ACCOUNT}" \
    --role=roles/secretmanager.secretAccessor
done
```

Do not grant either runtime identity `roles/editor`, `roles/owner`, `roles/datastore.user` without a database condition, or access to the other identity's product permissions. Firestore Admin SDK calls bypass Security Rules, so the conditional IAM bindings are the enforced server-side boundary.

## Deploy

From this directory, create the databases once with deletion protection, then deploy both database configurations and functions:

```bash
firebase use volt-3fae7
firebase firestore:databases:create volt-push-relay --project volt-3fae7 --location nam5 --delete-protection ENABLED
firebase firestore:databases:create volt-iroh-enrollment --project volt-3fae7 --location nam5 --delete-protection ENABLED
firebase deploy --project volt-3fae7 --only firestore,functions:volt-push-relay:pushRelay,functions:volt-push-relay:irohEnrollment
```

Cloud Functions deployment requires the Blaze plan. The enrollment function is not Internet-reachable until the load-balanced broker URL exists. Do not route production traffic to it until App Check, the app-id allowlist, APNs, TTL, monitoring, budgets, the dedicated runtime identity, Cloud Armor policy, and relay-side rate limits are verified.

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

The App Check and edge checks below are a hard canary gate. Use three independently routed known sources so the edge-only, durable-limit, and unexhausted-source cases cannot share a source window. Run sequentially within one-minute windows. Do not add the raw source IP, forwarded headers, token, or salt to broker logs or retained evidence. Compute document IDs offline as
`BASE64URL(HMAC-SHA256(canary IP salt, UTF8(known source IP)))`; retain only the salted id, counts, request correlation ids, revisions, and status/error codes.

1. Keep the checked-in canary broker limit of 5 requests/minute and the Cloud Armor rule at 30 requests/60 seconds. Record the exact function, backend-service, and security-policy revisions.
2. While the Cloud Armor rule is in preview, send 31 requests from source A to one edge-covered route using correctly bounded bodies with invalid endpoint signatures so the broker reserves no quota and never invokes App Check. Require all requests to reach the backend with `401 signature_invalid`, and require the over-threshold requests to carry the preview rule match in Cloud Armor logs. After a fresh 60-second edge window, repeat for the other expensive route and every intentionally accepted `/irohEnrollment/...` prefixed route; if prefixed routes are rejected by the URL map, require that rejection instead.
3. From source B, submit a valid signed approval or renewal with a rejected/replayed limited-use token. Read only the exact expected `voltIrohEnrollmentQuotaWindows/app-check-ip_<salted-id>` document and require count 1; require the client endpoint quota document to remain absent or unchanged. Repeat once with a forged `X-Forwarded-For` header. Require the same salted document id and count 2, proving the backend header replacement prevents spoofing from changing broker identity.
4. Continue valid signed requests with rejected/replayed App Check material from source B until the durable count is 5. Require the next request to return `429 {"error":"app_check_ip_rate_limited"}` without incrementing the document or the signed endpoint quota. Use broker outcome logs and exact Firestore document reads, never a raw-IP query.
5. Acquire a fresh real limited-use token and first submit it from exhausted source B. Require the same broker 429. Submit that exact token and valid signed operation from unexhausted source C; require success, the source-C salted document count to become 1, and the endpoint quota to increment. Success proves the exhausted-source request stopped before Firebase replay protection and that an unexhausted legitimate source remains admitted. Replay the now-consumed token once from source C and require App Check rejection plus a retained source-C slot but no additional endpoint slot.
6. Disable Cloud Armor preview without changing the path match or 30/60 threshold, then repeat the edge-threshold portion and require the 429 to be enforced before a serverless invocation. Archive redacted evidence for both Cloud Armor and durable broker limits.

Delete the simulator debug token and canary grants after the exercise.

## Secret rotation and incident revocation

Rotate relay callback authentication with overlap: set a new backend `NEXT`, deploy, replace and restart one managed relay credential at a time, verify each relay, then promote the new value to `CURRENT` and replace `NEXT` with a fresh standby. Never clear current and next together. The current [self-hosted relay guide](../../../../../docs/self-hosted-relay.md) documents the pre-enrollment shared-token path; it is not a managed-callback deployment procedure.

For a compromised endpoint, transactionally mark its endpoint-access document blocked or revoke its pair grants, then inspect grants for the peer endpoints. This denies the next relay registration but cannot interrupt an existing stock-relay registration. For a callback-secret incident, rotate with the shortest safe overlap, restart every relay, review callback denials/egress, and never restore the retired fleet credential.

## Error behavior

Invalid or expired push targets return `410`, prompting host-side target disabling. Other FCM send failures return `502 { error: "fcm_send_failed", code }`. Enrollment routes return bounded stable error codes and relay access returns false on denial. Cloud Logging records only bounded route/outcome/latency or safe error names, never endpoint IDs, claim/grant secrets, FCM tokens, target credentials, or callback bearers.
