# Firebase Push Relay

This deploys Volt's managed push relay contract to Firebase Cloud Functions. The relay stores the raw FCM registration token in private Firestore state and gives the mobile app an opaque target id plus a target-scoped credential. A paired desktop host can send to that target without receiving the FCM token.

## Security contract

- Registration requires an `X-Firebase-AppCheck` **limited-use** token. The function verifies it with replay consumption, rejects an already-consumed token, requires its one-time `jti`, and allowlists the Firebase app id. There is no embedded or shared app secret.
- One FCM token maps to one deterministic Firestore document. Re-registering rotates the target credential instead of growing an attacker-controlled collection.
- Target credentials are stored only as SHA-256 hashes. FCM tokens remain raw because Firebase Messaging needs them, so Firestore access is denied to clients and project IAM must stay least-privilege.
- Targets expire after 30 days by default. Every delivery rejects an expired target immediately; the deployed Firestore TTL policy deletes expired documents asynchronously.
- The app validates a cached target through the credential-authenticated status route before reuse. A host-side revoke therefore causes fresh App Check registration instead of leaving the phone stuck on a dead credential.
- Registration, notification, Live Activity, and revocation bodies have a 16 KiB total cap plus explicit field, UTF-8 string, object-depth, key-count, array-count, and timestamp bounds. Notification copy and metadata reject controls and path separators; FCM data is restricted to event, kind, workspace/session authority, and one navigation ID, so commands, diffs, and host paths cannot be forwarded.
- Each target reserves a delivery quota slot in a Firestore transaction before FCM is called. Failures consume the slot, so a failing send cannot create a hot retry loop.
- Registration also has a per-instance burst cap. The function has bounded concurrency, instance count, memory, and request time. These are defense-in-depth controls, not substitutes for a project-level budget and edge rate limit.
- `relayUrl` is returned only from the validated `PUSH_RELAY_URL` setting (or the compiled production URL); request `Host` and forwarding headers are never reflected.
- Explicit revocation requires the target id and target credential. Desktop unpair is locally authoritative even if this remote cleanup fails; the failure is audited and the finite target TTL bounds its lifetime.
- Turning off both notification and Live Activity delivery emits one disabled host registration, revokes the current and bounded pending relay credentials best-effort, deletes the FCM token, and clears the Keychain cache.

The function remains publicly invokable because an unattached iOS app must reach the registration endpoint. App Check attestation is the registration authorization boundary. Notification, Live Activity, and revoke routes use the random per-target credential.

## Routes

- `POST /v1/push-targets`: mobile app registration with `X-Firebase-AppCheck`; body `{ provider:"fcm", platform:"ios", token, enabled }`; returns `{ pushTargetId, pushTargetAuthToken, relayUrl, tokenHash, expiresAtEpochSeconds }`.
- `POST /v1/push-targets/revoke`: app or host cleanup with `{ pushTargetId, pushTargetAuthToken }`; returns `revoked` or idempotent `already_revoked`.
- `POST /v1/push-targets/status`: credential-authenticated cache validation; returns `{ status:"active", expiresAtEpochSeconds }`, or `401`/`404`/`410` when the cached credential must be replaced.
- `POST /v1/notifications`: desktop delivery with `{ pushTargetId, pushTargetAuthToken, eventId, kind, title, body, workspace?, planId?, workflowId?, data }`.
- `POST /v1/live-activities`: desktop delivery with `{ pushTargetId, pushTargetAuthToken, activityId, activityPushToken, tokenEnvironment?, eventId, kind, contentState, activityEvent?, staleDateEpochSeconds?, dismissalDateEpochSeconds? }`.

Notification delivery accepts `conversation_completed`, `plan_ready`, `review_completed`, `action_completed`, and `host_notice` kinds. `plan_ready` requires `planId`; `review_completed` requires `workflowId`; the two navigation fields are mutually exclusive and forbidden on other kinds. The relay requires top-level and `data` values to agree, then forwards this bounded FCM data shape unchanged:

```json
{
  "eventId": "plan:session-one:run-one:ready",
  "kind": "plan_ready",
  "sessionId": "session-one",
  "workspace": "volt-app",
  "planId": "plan-one"
}
```

`workflowId` replaces `planId` for review completion. Notification titles are limited to 128 UTF-8 bytes, bodies to 512, workspace/session/navigation values to 128, event IDs to 512, and kinds to 64. Unknown FCM data fields, mismatched metadata, control/format/surrogate characters, whitespace in identifiers, and path separators are rejected. The host uses the same bounded title, body, workspace/session authority, navigation ID, and stable event ID for managed push and JSONL fallback. Plan-ready copy is `Your plan is ready` / `Open Volt to review and approve it.` Review copy is `Your review is ready` with a safe host-produced target and zero/one/many/unknown findings wording.

The Live Activity `contentState` is the exact semantic ActivityKit state:

```json
{
  "operationKind": "planCreation",
  "operationID": "session-one",
  "status": "running",
  "subject": "Implement semantic Live Activities",
  "sessionID": "session-one",
  "workspaceName": "volt",
  "operationStartedAtEpochSeconds": 1785312000,
  "updatedAtEpochSeconds": 1785312060
}
```

`operationKind` is `conversation`, `planCreation`, or `review`; `status` is `running`, `completed`, `failed`, or `cancelled`. Every identity field is required. `subject` is optional, limited to 256 UTF-8 bytes, and accepted only for `planCreation`; conversation and review subjects remain private. The operation start must not follow the update timestamp, and update timestamps outside the relay freshness window are rejected. Unknown fields and the former tool-oriented state are rejected. The bounded content state remains well below ActivityKit's 4 KiB payload limit.

Volt host state stores only the opaque relay target id, the target-scoped credential, and optional token hashes.

## Required Firebase setup

1. Register the production iOS app and include its generated `GoogleService-Info.plist` in the app target.
2. Enable Firebase App Check for that iOS app. Production builds should use App Attest with DeviceCheck fallback. Simulator/debug tokens are development-only and must never be enabled for the production Beta build.
3. Confirm that the Firebase app id in App Check matches `ALLOWED_FIREBASE_APP_IDS`. The built-in default is Volt's production iOS app id; self-hosted deployments must override it.
4. Enable replay protection support for limited-use App Check tokens. Registration intentionally performs the extra consumption network call and rejects ordinary reusable App Check tokens.
5. Configure APNs credentials in Firebase Console for FCM and Live Activities.
6. Deploy Firestore rules **and indexes** so the `expiresAt` TTL field override is active. Verify the TTL policy in the Firestore console after deployment.
7. Keep the function service account and Firestore project IAM least-privilege, enable Cloud Audit Logs, set project budget alerts, and monitor App Check invalid/replay metrics plus `429`/`5xx` responses.

For an Internet-facing production deployment, put the Gen 2 function behind an external Application Load Balancer with Cloud Armor (or an equivalent API gateway) and apply IP/bot/rate policies there. If the direct `cloudfunctions.net` URL remains reachable, edge policies can be bypassed; restrict ingress to the load balancer after verifying iOS and host traffic through the canonical `PUSH_RELAY_URL`.

## Configuration

All limits have safe defaults and bounded override ranges:

- `ALLOWED_FIREBASE_APP_IDS`: comma-separated allowlist, 1-8 app ids.
- `PUSH_RELAY_URL`: canonical absolute HTTPS relay URL; credentials, query, and fragment are rejected.
- `PUSH_TARGET_TTL_DAYS`: 1-90, default 30. Changing the value does not renew existing targets.
- `DELIVERIES_PER_TARGET_PER_MINUTE`: 1-600, default 30.
- `REGISTRATIONS_PER_INSTANCE_PER_MINUTE`: 1-120, default 30. This local burst control is supplemented by App Check replay protection and should be backed by an edge/global quota.
- `FUNCTION_REGION`: deployment region, default `us-central1`.
- `LIVE_ACTIVITY_APNS_TOPIC`: default `com.hansjm10.volt.push-type.liveactivity`.
- `LIVE_ACTIVITY_ALLOW_DEVELOPMENT=1`: development-only escape hatch described below.

## Deploy

From this directory:

```bash
firebase use volt-3fae7
firebase firestore:databases:create '(default)' --project volt-3fae7 --location nam5
firebase deploy --project volt-3fae7 --only firestore:rules,firestore:indexes,functions:volt-push-relay:pushRelay
```

Use a different Firestore location if `nam5` is not intended. Cloud Functions deployment requires the Blaze plan so Firebase can enable Cloud Build and Artifact Registry APIs. Do not deploy until App Check, the app-id allowlist, APNs, TTL, monitoring, budget, and edge controls above are verified.

The official Volt host defaults to the managed relay URL. For a self-hosted relay, point the host at the same canonical URL configured in `PUSH_RELAY_URL`:

```bash
export VOLT_PUSH_RELAY_URL="https://push.example.com/"
volt remote host --mobile --workspace volt=/path/to/Volt
```

## Error behavior

FCM send failures return `502 { error: "fcm_send_failed", code }` with the FCM error code. Cloud Logging receives the server error plus event id and kind, never the FCM token or target credential.

Live Activity updates with `tokenEnvironment: "development"` return `422 { error: "live_activity_environment_unsupported" }` before FCM. FCM delivers `live_activity_token` pushes through production APNs, so a sandbox ActivityKit token from an Xcode-installed build is not reachable. Hosts treat this as a permanently invalid channel. `LIVE_ACTIVITY_ALLOW_DEVELOPMENT=1` attempts delivery only for controlled development testing.
