# Domain-Monitor — Notifications & Delivery Worker

> V0.6 pipeline (events → rules → deliveries → senders) + V0.7 worker. Core guarantee: **at-least-once, no automatic retry**.

## Events

- Unified stream derived from snapshot diffs: `dns_record_added`, `dns_record_removed`, `ssl_cert_replaced`, `ssl_status_changed`, `http_status_changed`.
- Each event has a **`dedupKey`** (e.g. `dns:5:RECORD_ADDED:A:1.2.3.4`) — the events table has a UNIQUE index on it, so the same state transition is recorded once. Recurrence of the same transition later is deliberately deduplicated.
- `previousState` / `currentState` are JSON snapshots of the transition (never include error messages or secrets).

## Rules

- `notification_rules`: channel_id + optional filters (source / event_type / domain_id) + enabled.
- Matching is at insertion time: when a snapshot writes events, `insertEventsAndGenerateDeliveries` creates deliveries for every enabled matching rule (inside the same transaction as the snapshot — **event→delivery atomicity**).

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

## Senders

- **Webhook** (`webhook.ts`): https-only, SSRF-validated URL + every redirect hop, manual redirects (≤5), 8 s timeout, POST application/json with `eventId` + `deliveryId` (receiver-side dedup), body never read, `secretRef` is a reference only — secret never in payload/errors/logs.
- **Email** (`email.ts`): same SSRF guard for the endpoint; `apiKeyRef` resolved from env at send time; Authorization header never re-attached across origins; secret never in payload/errors/logs.
- Factory: `senders/factory.ts` maps `channel.type` → sender.

## at-least-once semantics

- Crash mid-send leaves the delivery `sending` → next tick recovers it to `pending` → sent again. Receivers dedupe via stable `eventId`/`deliveryId`. Duplicate sends are possible by design; **double *claims* are impossible** (CAS).

## Current production state

- No channels, no rules, no deliveries configured (production DB) — nothing external is ever contacted.
- Notification code is **frozen**: do not change sender/worker/service/repository semantics without explicit approval.
