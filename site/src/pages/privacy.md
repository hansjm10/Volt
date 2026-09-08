---
layout: ../layouts/LegalShell.astro
title: Privacy Policy
description: How Volt handles device connections, subscriptions, notifications, and support information.
canonicalPath: /privacy/
updated: "September 7, 2026"
---

Jordan Hans operates Volt, including the Volt-CLI iOS app, the Volt-managed connectivity and notification services, and this website. In this policy, “we” means Jordan Hans. Contact us at [jordan.hans@volt-cli.dev](mailto:jordan.hans@volt-cli.dev).

## Your computer, your providers

Volt runs the coding agent and its tools on your computer. Conversation history, source files, configuration, and provider credentials are stored or accessed there; the iOS app also stores connection information, settings, and cached conversation content on your device.

Your phone and computer communicate over an end-to-end encrypted Iroh connection. A relay can carry that encrypted traffic without decrypting its conversation contents. This does **not** mean that all information stays on your computer: prompts, selected files, images, and tool inputs may be sent to the AI providers, websites, code hosts, extensions, or other services you choose to use. Those recipients process data under their own terms and privacy policies. Review their settings and retention practices before sending confidential material.

The managed connectivity service is not a cloud transcript backup. We do not receive your provider API keys through normal managed pairing. Do not include keys or other secrets in feedback or exported logs.

## Information used by managed services

### Connections and security

To establish and protect connections, we process device and host endpoint identifiers, pairing claims, authorization grants, timestamps, token-verification information, and hashes of refresh and pairing secrets. Network infrastructure also processes IP addresses and connection/request metadata, such as request time, status, and latency, for routing, security, and troubleshooting.

The app uses Firebase App Check with Apple App Attest or DeviceCheck to verify legitimate app/device requests and prevent abuse. Apple and Google process the associated attestation or device-verification information. Firebase also processes app, SDK, operating-system, and device metadata to operate its services. Its Firebase user-agent information is not associated with a user or device identifier and is used to understand platform/version adoption and inform Firebase product improvements. This SDK analytics use is separate from advertising or tracking.

### Volt Pro purchases

Apple handles subscription payment and billing. We receive and verify Apple-signed transaction information and subscription status to authorize managed access. This includes an app transaction identifier, product and subscription-group identifiers, receipt environment, entitlement status and dates, device-bound verification information, and subscription notification identifiers. These records connect a subscription to the authorized computer and phone endpoints, including when access moves to another computer.

We do not receive your payment-card details through StoreKit. Apple retains its own purchase and billing records under its policies.

### Notifications

Firebase Cloud Messaging (FCM) and Apple Push Notification service (APNs) deliver notifications. This involves APNs/FCM registration tokens and installation identifiers. Our managed push service stores an FCM token, a target identifier, a hash of the target credential, expiry and delivery-quota information, and the authorized host-grant binding. It also retains last-delivery event and message identifiers, event kind, and timestamps; delivery-error logs can include event identifiers, kind, and error information. The push-target database does not store notification titles or bodies.

Notification titles, bodies, event kinds, and routing identifiers are sent through the managed push service, Google, and Apple. Routing data can identify the host, workspace, session, plan, or review involved. Notifications are separate from the end-to-end encrypted conversation connection; do not assume their contents have the same confidentiality boundary. You can disable notifications and control lock-screen previews in iOS Settings.

## Support, diagnostics, and the website

If you contact us or send beta feedback, we receive the contact information and content you provide, potentially including screenshots, logs, device details, or code. The app's log-export and Send Logs features let you share diagnostics or send them to your paired computer; that does not automatically send the complete log to the developer. Review exported material before forwarding it to us. Logs can contain identifying information and are not guaranteed to be anonymous.

Apple may make TestFlight feedback, screenshots, and crash or usage reports available to us under its beta-testing services and your settings. We use support and diagnostic information to respond to requests, investigate failures, and maintain the service.

Our website and hosting providers process ordinary web-request information, including IP addresses and browser/request metadata, to deliver and secure the website. Our service infrastructure includes Google Cloud/Firebase; the website is hosted through Cloudflare. Network hosting providers process traffic and operational metadata needed to run the relays.

## Purposes and sharing

We use this information to provide requested features, verify subscriptions, authenticate connections, prevent fraud and abuse, deliver notifications, maintain reliability, and provide support. Where applicable law requires a legal basis, we rely on performing our agreement with you, legitimate interests in operating and securing the service, compliance with legal obligations, or consent where required.

We do not sell personal information or use it for cross-app targeted advertising. The app does not include advertising or the Firebase Analytics or Crashlytics SDKs. This does not eliminate operational logging, Firebase SDK metadata, or reports provided through Apple's services.

We share information with service providers as needed for these purposes, with recipients you choose, when reasonably necessary to comply with law or protect rights and safety, or in connection with a lawful transfer of the service subject to appropriate privacy protections. Your independently selected AI and tool providers have separate data-handling practices.

## Retention

Local files and conversation caches remain under the control of your devices and their backup systems. Deleting the app does not delete the computer's files, cancel an Apple subscription, or automatically erase managed-service records.

Managed push targets normally expire 30 days after registration or re-registration; re-registering renews that period. Expired targets are rejected immediately and removed asynchronously by the database TTL process. Revoking a managed relay grant prevents new credentials from being issued, but previously issued short-lived credentials can remain usable until their bounded expiry. Revocation and expiry do not promise immediate deletion of every related record.

Pairing, endpoint, subscription, and anti-replay records have different lifetimes. Some cleanup is triggered by later requests or capacity pressure rather than a scheduled purge. In particular, the subscription entitlement record does not currently have an automatic deletion deadline. We retain records as needed to operate access, reconcile purchases, prevent replay and abuse, resolve disputes, and meet legal obligations. Operational logs and backup copies follow their respective retention and rotation schedules and may outlast active records.

Firebase-managed records have separate retention periods. [Firebase documents](https://firebase.google.com/support/privacy) that FCM installation IDs are retained until the Firebase customer requests deletion through its API, with removal from live and backup systems within 180 days after that request. App Check tokens used for replay protection can be retained for up to 30 days. Deleting a Volt push-target record is not the same as deleting its Firebase installation ID.

You may request deletion at the email below. We will review records held by us and by providers processing data on our behalf, including Firebase-managed records, and explain any information that must be retained and why. Apple and other providers may also hold independent records under their own policies; your computer and chosen AI providers have their own deletion controls. Unpairing or uninstalling does not automatically remove all of these records.

## Your choices and rights

You can manage connections and notifications in the app and iOS Settings, revoke managed connections, manage or cancel subscriptions through Apple, and choose the services and repositories your computer accesses.

Depending on your location, you may have rights to access, correct, delete, or receive a copy of your personal information, object to or restrict processing, withdraw consent, or complain to a data-protection authority. Email [jordan.hans@volt-cli.dev](mailto:jordan.hans@volt-cli.dev) to make a request. We may need proportionate verification so that we do not disclose or delete another person's records. Please do not email passwords, payment-card details, provider keys, or pairing/refresh tokens.

## International processing, children, and security

Service providers may process information in the United States and other countries, which can have different privacy laws. Where required, applicable safeguards must be used for international transfers. Volt is a developer tool and is not directed to children under 13. Contact us if you believe a child has provided personal information to us.

We use encrypted transport and access controls, but no software or service is completely secure. You are responsible for protecting your devices, choosing trusted repositories and extensions, and reviewing agent actions. End-to-end encryption does not protect data from a compromised endpoint or a recipient to which you deliberately send it.

## Changes and contact

We will update this page when our practices change and provide additional notice where required by law. The date above identifies the latest revision.

**Jordan Hans**\
[jordan.hans@volt-cli.dev](mailto:jordan.hans@volt-cli.dev)

See also our [Terms of Use](/terms).
