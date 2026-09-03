# Phase 14C-9A-2 — Production D1 Greenfield Provisioning

**Date:** 2026-08-28 (Asia/Shanghai)
**Mode:** Authorized production provisioning (D1 create + migrations 0000–0007 + read-only schema verify only)
**Final Status:** **D1 PROVISIONED**

---

## Source of Record

- Source snapshot: `domain-monitor-backups/domain-monitor-2026-08-25T06-50-52-042Z.db`
- **`SOURCE OF RECORD = 2026-08-25 06:50 NFS BACKUP`** (last known consistent snapshot; live-DB parity is NOT claimed, per 14C-9A-2 ruling §3)
- Snapshot pre-flight (read-only): integrity `ok`, FK violations `0`, migrations `8`, counts baseline confirmed (3 domains / 30 dns_records / 1 channel / 7 deliveries / 7 events / 5 rules / 1 secret / 1 admin / 1 reminder). Backup untouched.

---

## D1 Identity

| Field | Value |
| --- | --- |
| Name | `domain-monitor` |
| Database ID | `4437f46a-632d-4dfa-aba0-4c5bc41fa64d` (masked in reports) |
| Region | APAC |
| Account | `b9dd2c…61d6` (masked) |

Name-collision check (read-only `wrangler d1 list`) before creation: only pre-existing `kui-db` and `misub` present; `domain-monitor` did not exist. No existing DB reused or modified.

---

## Creation

`wrangler d1 create domain-monitor` → **success**, region APAC.

This was the only production resource created this phase.

Auth: `wrangler whoami` → logged in with `CLOUDFLARE_API_TOKEN` (account-scoped). D1 create succeeded, confirming the credential has D1 write/edit scope (no permission error encountered).

---

## Migration 0000–0007

`wrangler d1 migrations apply domain-monitor --remote` (against a throwaway `/tmp/dm-prod-14c9a2/wrangler.jsonc` pointing at the new DB + project `src/db/migrations`).

| Migration | Status |
| --- | --- |
| 0000_careless_penance.sql | ✅ |
| 0001_bright_old_lace.sql | ✅ |
| 0002_thin_slipstream.sql | ✅ |
| 0003_greedy_goblin_queen.sql | ✅ |
| 0004_dazzling_ender_wiggin.sql | ✅ |
| 0005_equal_medusa.sql | ✅ |
| 0006_black_bloodscream.sql | ✅ |
| 0007_manual_expiration.sql | ✅ |

`d1_migrations` table rows = **8** (ids 1–8), all project migrations only; no foreign migration present.

---

## Schema Verification

- **Business tables = 13** ✅ (admin_settings, dns_records, dns_snapshots, domains, expiration_reminders, http_snapshots, notification_channels, notification_deliveries, notification_events, notification_rules, notification_secrets, ssl_certificates, ssl_snapshots)
- **Indexes = 12** ✅
- **0007 columns present** ✅: `expiration_source`, `registration_provider`, `registration_provider_url` all in `domains`.
- **FK cascade** ✅: `expiration_reminders.domain_id → domains.id` with `on_delete = CASCADE`.
- **UNIQUE** ✅: `expiration_reminders_domain_days_unique` on `(domain_id, days_before)`.

---

## Empty DB Verification

All 13 business tables row count = **0**. Only migration metadata present. No business data imported (import is explicitly deferred to a later phase).

---

## Security

- No Telegram token / ENCRYPTION_KEY / SESSION_SECRET / ciphertext / Authorization header printed.
- Credentials recorded only as `configured` (CLOUDFLARE_API_TOKEN env var).
- Database ID / account ID masked in this report.

---

## Safety

| Gate | Result |
| --- | --- |
| D1 creation | 1 (new `domain-monitor` only) |
| Migration writes | expected migration DDL only |
| Business data import | 0 |
| Worker deploy | 0 |
| DNS change | 0 |
| secret writes | 0 |
| domain-check changes | 0 |
| Telegram / Webhook / Email | 0 |
| commit / push / tag / release | 0 |

---

## Rollback

Rollback = delete the newly created empty `domain-monitor` D1 (no data loss; migrations only). This is a greenfield DB with zero business data, so dropping it would cleanly revert provisioning. Not performed — awaiting user instruction.

---

## FINAL STATUS

# D1 PROVISIONED

D1 `domain-monitor` created (APAC), migrations 0000–0007 applied successfully, schema (13 tables / 12 indexes / FK cascade / UNIQUE / 0007 columns) verified, and empty DB confirmed. Business data import was **not** performed, Worker not deployed, secrets/DNS/Cron/Telegram untouched, nothing committed.

**Immediately STOP. Next phase (data import) requires a new explicit authorization.**