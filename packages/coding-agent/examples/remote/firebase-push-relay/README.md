# Firebase Push Relay

This deploys Volt's managed FCM notification relay contract to Firebase Cloud Functions. The relay stores the raw FCM registration token in private Firestore state and gives the mobile app an opaque target id plus a target-scoped credential. A paired desktop host can notify that target without receiving the FCM token.

## Security contract

- Registration requires an `X-Firebase-AppCheck` **limited-use** token. The function consumes the token, requires its one-time `jti`, and allowlists the Firebase app id. There is no embedded or shared app secret.
- One FCM token maps to one deterministic Firestore document. Re-registering rotates the target credential instead of growing an attacker-controlled collection.
- Target credentials are stored only as SHA-256 hashes. FCM tokens remain raw because Firebase Messaging needs them, so Firestore access is denied to clients and project IAM must stay least-privilege.
- Targets expire after 30 days by default. Every delivery rejects an expired target immediately; the deployed Firestore TTL policy deletes expired documents asynchronously.
- The app validates a cached target through the credential-authenticated status route before reuse. A host-side revoke therefore causes fresh App Check registration instead of leaving the phone stuck on a dead credential.
- Registration, notification, and revocation bodies have a 16 KiB total cap plus explicit field, UTF-8 string, object-depth, key-count, and array-count bounds. Notification copy and metadata reject controls and path separators. FCM data is restricted to event, authoritative host identity, kind, workspace/session authority, and one navigation ID, so commands, diffs, and host paths cannot be forwarded.
- Each target reserves a delivery quota slot in a Firestore transaction before FCM is called. Failures consume the slot, preventing a failing send from creating a hot retry loop.
- Registration also has a per-instance burst cap. Bounded concurrency, instance count, memory, and request time are defense in depth, not substitutes for a project-level budget and edge rate limit.
- `relayUrl` is returned only from the validated `PUSH_RELAY_URL` setting (or the compiled production URL); request `Host` and forwarding headers are never reflected.
- Explicit revocation requires the target id and target credential. Desktop unpair is locally authoritative even if remote cleanup fails; the finite target TTL bounds its lifetime.

The function remains publicly invokable because an unattached iOS app must reach registration. App Check attestation is the registration authorization boundary. Notification and revoke routes use the random per-target credential.

## Routes

- `POST /v1/push-targets`: mobile app registration with `X-Firebase-AppCheck`; body `{ provider:"fcm", platform:"ios", token, enabled }`; returns `{ pushTargetId, pushTargetAuthToken, relayUrl, tokenHash, expiresAtEpochSeconds }`.
- `POST /v1/push-targets/revoke`: app or host cleanup with `{ pushTargetId, pushTargetAuthToken }`; returns `revoked` or idempotent `already_revoked`.
- `POST /v1/push-targets/status`: credential-authenticated cache validation; returns `{ status:"active", expiresAtEpochSeconds }`, or `401`/`404`/`410` when the cached credential must be replaced.
- `POST /v1/notifications`: desktop delivery with `{ pushTargetId, pushTargetAuthToken, eventId, hostNodeId, kind, title, body, workspaceName?, planId?, workflowId?, data }`.

Notification delivery accepts `conversation_completed`, `plan_ready`, `review_completed`, `action_completed`, and `host_notice`. `plan_ready` requires `planId`; `review_completed` requires `workflowId`; the navigation fields are mutually exclusive and forbidden on other kinds. Top-level and `data` values must agree. The bounded FCM data shape is forwarded unchanged:

```json
{
  "eventId": "plan:session-one:run-one:ready",
  "hostNodeId": "<authoritative-host-node-id>",
  "kind": "plan_ready",
  "sessionId": "session-one",
  "workspaceName": "volt-app",
  "planId": "plan-one"
}
```

`hostNodeId` is required at both the top level and in FCM `data`, must be the canonical lowercase 64-hex Iroh host identity, and must match exactly. `workflowId` replaces `planId` for review completion. Notification titles are limited to 128 UTF-8 bytes, bodies to 512, workspace/session/navigation values to 128, event IDs to 512, and kinds to 64. Unknown fields, mismatched metadata, unsafe characters, whitespace in identifiers, and path separators are rejected.

Volt host state stores only the opaque relay target id, target-scoped credential, and optional FCM token hash.

## Required Firebase setup

1. Register the production iOS app and include its generated `GoogleService-Info.plist` in the app target.
2. Enable Firebase App Check. Production builds should use App Attest with DeviceCheck fallback; simulator/debug tokens are development-only.
3. Confirm the Firebase app id matches `ALLOWED_FIREBASE_APP_IDS`. Self-hosted deployments must override the built-in production app id.
4. Enable replay protection for limited-use App Check tokens.
5. Configure APNs credentials in Firebase Console for ordinary FCM notifications.
6. Deploy Firestore rules and indexes, then verify the `expiresAt` TTL policy.
7. Keep IAM least-privilege, enable audit logs and budget alerts, and monitor App Check failures plus `429`/`5xx` responses.

For an Internet-facing deployment, put the Gen 2 function behind an external Application Load Balancer with Cloud Armor (or an equivalent gateway), then restrict direct function ingress after verifying traffic through `PUSH_RELAY_URL`.

## Configuration

- `ALLOWED_FIREBASE_APP_IDS`: comma-separated allowlist, 1-8 app ids.
- `PUSH_RELAY_URL`: canonical absolute HTTPS relay URL; credentials, query, and fragment are rejected.
- `PUSH_TARGET_TTL_DAYS`: 1-90, default 30.
- `DELIVERIES_PER_TARGET_PER_MINUTE`: 1-600, default 30.
- `REGISTRATIONS_PER_INSTANCE_PER_MINUTE`: 1-120, default 30.
- `FUNCTION_REGION`: deployment region, default `us-central1`.

## Deploy

From this directory:

```bash
firebase use volt-3fae7
firebase firestore:databases:create '(default)' --project volt-3fae7 --location nam5
firebase deploy --project volt-3fae7 --only firestore:rules,firestore:indexes,functions:volt-push-relay:pushRelay
```

Cloud Functions deployment requires the Blaze plan. Do not deploy until App Check, the app-id allowlist, APNs, TTL, monitoring, budget, and edge controls are verified.

For a self-hosted relay, point the host at the same canonical URL configured in `PUSH_RELAY_URL`:

```bash
export VOLT_PUSH_RELAY_URL="https://push.example.com/"
volt remote host --mobile --workspace volt=/path/to/Volt
```

## Error behavior

Invalid or expired targets return `410`, prompting host-side target disabling. Other FCM send failures return `502 { error: "fcm_send_failed", code }`. Cloud Logging receives the server error plus event id and kind, never the FCM token or target credential.
