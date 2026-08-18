# Domain-Monitor — Notifications & Delivery Worker

> V0.6 pipeline (events → rules → deliveries → senders) + V0.7 worker + V0.8 (Telegram channel, notification configuration UI, encrypted secret storage, sender secret resolution). Core guarantee: **at-least-once, no automatic retry**.

## Events

- Unified stream derived from snapshot diffs: `dns_record_added`, `dns_record_removed`, `ssl_cert_replaced`, `ssl_status_changed`, `http_status_changed`.
- Each event has a **`dedupKey`** (e.g. `dns:5:RECORD_ADDED:A:1.2.3.4`) — the events table has a UNIQUE index on it, so the same state transition is recorded once. Recurrence of the same transition later is deliberately deduplicated.
- `previousState` / `currentState` are JSON snapshots of the transition (never include error messages or secrets).

## Rules

- `notification_rules`: channel_id + optional filters (source / event_type / domain_id) + enabled.
- Matching is at insertion time: when a snapshot writes events, `insertEventsAndGenerateDeliveries` creates deliveries for every enabled matching rule (inside the same transaction as the snapshot — **event→delivery atomicity**).
- Rules are managed from the notification configuration UI (rule CRUD).

## Deliveries

- Status machine: `pending → sending → sent | failed`; `attempts` counts claims; `claimed_at` for stale recovery.
- UNIQUE(event_id, channel_id) prevents duplicate deliveries for the same event+channel even if multiple rules match.

## CAS (claim)

`claimPendingDelivery` is a single atomic UPDATE guarded by `status='pending'` with `RETURNING` — concurrent workers racing for the same delivery: exactly one winner. Combined with the UNIQUE index this guarantees **no double send**.

## Stale recovery

`recoverStaleSending(cutoff)` flips `sending` rows older than the threshold (default 5 min) back to `pending` so the next tick re-attempts them — this is how a crashed worker's in-flight deliveries survive (at-least-once).

## Worker

- `pnpm worker [--limit N]` runs **one** `runOnce` tick and exits (no daemon, no HTTP endpoint, no scheduler).
- Tick order: `recoverStaleSending` → oldest-first `pending` batch (default limit 50) → per delivery: load event + channel → `deliverDelivery` (claim → send → mark sent/failed). One failing delivery never blocks the batch.
- Scheduling is external (operator cron / system scheduler).

## Retry policy

- **No automatic retry**: failed deliveries stay `failed`; retry is **explicit** (UI `retryDeliveryAction`). No backoff, no max-attempts, no scheduler, no exactly-once.

## Channels & configuration UI (V0.8)

- Channel types: **telegram**, **webhook**, **email**.
- The notification page (`/notifications`, admin-authenticated) provides channel CRUD (create / edit / toggle / delete) and rule CRUD.
- **Telegram token setup**: the bot token is entered in the channel form and validated via the Telegram `getMe` API **server-side only** (the client never calls Telegram). On success the UI shows the bot username (e.g. `Connected as @bot_username`). Token values are never rendered back.
- Editing an existing channel shows token status (configured / not configured) and leaves the field blank to **keep the existing token**.

## Secret storage & resolution (V0.8)

- **Encrypted at rest**: the Telegram bot token is encrypted with **AES-256-GCM** (`iv:tag:ciphertext`, base64) using `ENCRYPTION_KEY` (32-byte key, 64 hex chars; required in production, dev falls back to a persisted dev key). Ciphertext lives in `notification_secrets` (`channel_id` + `key` = `token`), never in channel `config`.
- Channel `config` contains **non-secret** settings only (e.g. `chatId`).
- **Sender secret resolution** (`resolveSecret`): the Telegram sender resolves the token in this order —
  1. encrypted secret from `notification_secrets` (decrypted with `ENCRYPTION_KEY`),
  2. legacy `TELEGRAM_BOT_TOKEN` environment variable (fallback),
  3. controlled failure when neither is available (a decryption failure never falls back to the env token — it fails closed).

## Senders

- **Webhook** (`webhook.ts`): https-only, SSRF-validated URL + every redirect hop, manual redirects (≤5), 8 s timeout, POST application/json with `eventId` + `deliveryId` (receiver-side dedup), body never read, `secretRef` is a reference only — secret never in payload/errors/logs.
- **Email** (`email.ts`): same SSRF guard for the endpoint; `apiKeyRef` resolved from env at send time; Authorization header never re-attached across origins; secret never in payload/errors/logs.
- **Telegram** (`telegram.ts`): posts to the Telegram Bot API (`sendMessage` on delivery); token resolved via the encrypted-store → env fallback chain; the token and the full API URL are never logged (errors show a controlled message only).
- Factory: `senders/factory.ts` maps `channel.type` → sender; `channel.type` `telegram` requires a resolved token before sending.

## at-least-once semantics

- Crash mid-send leaves the delivery `sending` → next tick recovers it to `pending` → sent again. Receivers dedupe via stable `eventId`/`deliveryId`. Duplicate sends are possible by design; **double _claims_ are impossible** (CAS).

## Current production state

- Production has **1 Telegram channel** (`chatId` configured by the operator) and **4 notification rules** (chatgpt.com HTTP/SSL + opusai.eu.cc HTTP/SSL → Telegram). `notification_secrets` holds the encrypted bot token.
- `notification_events` / `notification_deliveries` are empty — **no real message has ever been sent** (no event has been recorded).
- Notification semantics (at-least-once, no auto-retry, CAS, stale recovery, dedup, secret handling) are deliberately stable; change them only with explicit approval.
