# Firebase push relay and Iroh enrollment broker

This Firebase deployment contains two separate HTTPS functions:

- `pushRelay` stores raw FCM registration tokens in private Firestore state and gives the mobile app an opaque target id plus a target-scoped credential; and
- `irohEnrollment` enrolls exact phone/desktop Iroh endpoint pairs for the Volt-managed relay fleet without accounts or a client-visible infrastructure bearer.

Neither service authorizes desktop RPC. Volt pairing, the authenticated Iroh transport, the host-observed client endpoint identity, and persisted RPC/tool grants remain the desktop-control boundary.

## Rollout status

This directory provides the broker contract and deployable backend only. It does not change the current daemon, app, or relay configuration by itself. Managed relay callbacks, v2 pairing tickets, and app enrollment must land and be deployed together before this broker becomes the production admission boundary. Until then, the existing shared-token relay path remains in effect.

## Security contract

- Registration requires an `X-Firebase-AppCheck` **limited-use** token. The function consumes the token, requires its one-time `jti`, and allowlists the Firebase app id. There is no embedded or shared app secret.
- One FCM token maps to one deterministic Firestore document. Re-registering rotates the target credential instead of growing an attacker-controlled collection.
- Target credentials are stored only as SHA-256 hashes. FCM tokens remain raw because Firebase Messaging needs them, so Firestore access is denied to clients and project IAM must stay least-privilege.
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
- Firestore transactions update claims, grants, both endpoint access maps, and durable quota windows. Empty unblocked endpoint documents are deleted, active endpoint documents are TTL eligible, and administrative blocks remain durable. Rules deny all direct client access. Defaults cap pending claims, active endpoint grants, new-host approvals, renewals, and endpoint-plus-salted-IP request windows.
- A managed relay calls `POST /v1/relay-access` with `X-Iroh-NodeId` and a server-to-server bearer. Only `200 text/plain` with exact body `true` permits registration. Current/next bearer overlap supports rotation. Unknown endpoint IDs do not create attacker-keyed quota documents, and the relay must enforce source-network, connection, and aggregate registration limits before invoking the callback.
- Forget/revoke uses the pair secret plus the phone endpoint signature and is idempotent, allowing the app to retry a durable local obligation without App Check. Broker, Firestore, App Check, signature, origin, or callback-authentication failures fail closed.
- This access hook runs when an endpoint registers. Revocation cannot interrupt an already-open registration and does not meter bytes per endpoint; relay-wide ceilings are separate deployment backstops.

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
7. Deploy Firestore rules and indexes. Configure Firestore TTL on `expiresAt` for `voltPushTargets`, `voltIrohEnrollmentClaims`, `voltIrohEnrollmentGrants`, `voltIrohEndpointAccess`, and `voltIrohEnrollmentQuotaWindows`; authorization never relies on asynchronous TTL deletion.
8. Create a dedicated runtime service account, grant only the required App Check verification, Secret Manager access, logging, and enrollment-collection Firestore permissions, and set its email in `IROH_ENROLLMENT_SERVICE_ACCOUNT`.
9. Keep IAM least-privilege, enable audit logs and budget alerts, and monitor App Check failures, callback latency/denials, quota responses, active grant counts, and `5xx` responses.

For an Internet-facing deployment, put `irohEnrollment` behind an external Application Load Balancer with Cloud Armor (or an equivalent gateway). The function is declared with `ALLOW_INTERNAL_AND_GCLB`, so its generated direct URL is not an Internet ingress path. Route app and relay enrollment traffic through a reviewed load-balanced broker URL. `PUSH_RELAY_URL` configures only the separately authorized push function and is not the enrollment broker URL. The Firebase command below does not provision the load balancer, Cloud Armor policy, service account, or IAM grants.

## Configuration

- `ALLOWED_FIREBASE_APP_IDS`: comma-separated allowlist, 1-8 app ids.
- `PUSH_RELAY_URL`: canonical absolute HTTPS relay URL; credentials, query, and fragment are rejected.
- `PUSH_TARGET_TTL_DAYS`: 1-90, default 30.
- `DELIVERIES_PER_TARGET_PER_MINUTE`: 1-600, default 30.
- `REGISTRATIONS_PER_INSTANCE_PER_MINUTE`: 1-120, default 30.
- `FUNCTION_REGION`: deployment region, default `us-central1`.
- `IROH_RELAY_ORIGINS`: comma-separated 1-8 canonical HTTPS origins returned to both endpoints; default `https://iroh-relay-us-central.volt-cli.dev`.
- `IROH_ENROLLMENT_SERVICE_ACCOUNT`: required dedicated user-managed runtime service account email. Deployment fails when it is absent or malformed.
- `IROH_ENROLLMENT_REQUESTS_PER_ENDPOINT_PER_MINUTE`: durable endpoint quota, 1-600, default 60.
- `IROH_ENROLLMENT_REQUESTS_PER_IP_PER_MINUTE`: durable salted-IP quota, 1-3000, default 300.
- Secret Manager only (never `.env`): `IROH_ENROLLMENT_IP_SALT`, `IROH_RELAY_ACCESS_SECRET_CURRENT`, and `IROH_RELAY_ACCESS_SECRET_NEXT`.

## Deploy

From this directory:

```bash
firebase use volt-3fae7
firebase firestore:databases:create '(default)' --project volt-3fae7 --location nam5
firebase deploy --project volt-3fae7 --only firestore:rules,firestore:indexes,functions:volt-push-relay:pushRelay,functions:volt-push-relay:irohEnrollment
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

The test refuses to run without `FIRESTORE_EMULATOR_HOST`, uses a `demo-*` project, and verifies real transactional create/approve/idempotency/revoke behavior plus both endpoint access maps. The local script pins the Firebase CLI version and disables lifecycle scripts; CI instead verifies the published standalone CLI checksum before execution. The normal `npm test` suite remains fast and uses isolated adapters for strict-schema, signature, App Check, quota, and failure-path coverage.

## Real App Check canary

Use a separate Firebase canary project/app and the checked-in `canary.env.example`; never point a canary at production Firestore. Register the canary iOS bundle and its simulator debug token in Firebase App Check, set only the canary app id in `ALLOWED_FIREBASE_APP_IDS`, deploy the Firestore schema and both functions, and configure independently generated canary secrets. Build the app with the canary `GoogleService-Info.plist` and the reviewed fixed broker URL; do not accept a broker destination from a QR, launch argument, user default, or remote response.

Before promoting, verify one real limited-use token succeeds once and replay fails, managed origins match exactly, revoke removes both endpoint access entries, an invalid relay callback bearer returns false, and broker outage still permits direct/LAN pairing. Delete the simulator debug token and canary grants after the exercise.

## Secret rotation and incident revocation

Rotate relay callback authentication with overlap: set a new backend `NEXT`, deploy, replace and restart one managed relay credential at a time, verify each relay, then promote the new value to `CURRENT` and replace `NEXT` with a fresh standby. Never clear current and next together. The current [self-hosted relay guide](../../../../../docs/self-hosted-relay.md) documents the pre-enrollment shared-token path; it is not a managed-callback deployment procedure.

For a compromised endpoint, transactionally mark its endpoint-access document blocked or revoke its pair grants, then inspect grants for the peer endpoints. This denies the next relay registration but cannot interrupt an existing stock-relay registration. For a callback-secret incident, rotate with the shortest safe overlap, restart every relay, review callback denials/egress, and never restore the retired fleet credential.

## Error behavior

Invalid or expired push targets return `410`, prompting host-side target disabling. Other FCM send failures return `502 { error: "fcm_send_failed", code }`. Enrollment routes return bounded stable error codes and relay access returns false on denial. Cloud Logging records only bounded route/outcome/latency or safe error names, never endpoint IDs, claim/grant secrets, FCM tokens, target credentials, or callback bearers.
