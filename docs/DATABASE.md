# Domain-Monitor — Database

> SQLite via better-sqlite3 + Drizzle ORM. Schema source: `src/db/schema.ts`. Migrations: `src/db/migrations/0000…0007`.

## Locations

- Dev default: `./data/domain-monitor.db` (inside repo, git-ignored state)
- **Production: `/tmp/domain-monitor/data/domain-monitor.db`** (mode 600, outside the repo; set by `DATABASE_URL`)
- Override via `DATABASE_URL` env (the production entrypoint sets it).

## Tables (12) & relationships

| Table                     | Key columns                                                                                                                             | Relationships                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `domains`                 | id PK, hostname UNIQUE, status, created/updated_at, RDAP fields (registrar, dates, nameservers JSON, rdap_status JSON, rdap_updated_at) | parent of everything below (cascade delete) |
| `dns_snapshots`           | id PK, domain_id FK, checked_at                                                                                                         | 1:N per domain                              |
| `dns_records`             | id PK, snapshot_id FK, type, name, value, priority (MX), ttl                                                                            | N:1 snapshot                                |
| `ssl_snapshots`           | id PK, domain_id FK, checked_at, tls_version, cipher_name, status, error                                                                | 1:N per domain                              |
| `ssl_certificates`        | id PK, snapshot_id FK, fingerprint256, subject, issuer, valid_from/to, serial, san JSON, is_self_signed, hostname_matched               | 1:1 snapshot                                |
| `http_snapshots`          | id PK, domain_id FK, checked_at, status, http_status, response_time_ms, redirected, redirect_count, final_url, error                    | 1:N per domain                              |
| `notification_channels`   | id PK, type (telegram/email/webhook), name, config JSON (non-secret only), enabled                                                      | —                                           |
| `notification_rules`      | id PK, channel_id FK, source, event_type, domain_id FK, enabled                                                                         | N:1 channel                                 |
| `notification_events`     | id PK, domain_id FK, source, event_type, previous_state JSON, current_state JSON, dedup_key UNIQUE, occurred_at                         | —                                           |
| `notification_deliveries` | id PK, event_id FK, channel_id FK, status (pending/sending/sent/failed), attempts, error, claimed_at, delivered_at                      | UNIQUE(event_id, channel_id)                |
| `admin_settings`          | id PK (singleton), password_hash, recovery_code_hash, session_secret, encryption_key, created_at, updated_at                            | 1 row — admin auth                          |
| `notification_secrets`    | id PK, channel_id FK, key (e.g. `token`), encrypted_value, created_at, updated_at                                                       | UNIQUE(channel_id, key); encrypted at rest  |

## RDAP fields & ownership semantics (V0.8.1)

- `domains` RDAP fields (`registrar`, `registration_date`, `expiration_date`, `updated_date`, `nameservers` JSON, `rdap_status` JSON, `rdap_updated_at`) store data that belongs to the **monitored hostname itself** (`ownership = exact`).
- When a subdomain has no independent RDAP object (e.g. `opusai.eu.cc` → 404), the registered-domain fallback resolves the parent (`eu.cc`) with `ownership = parent`. Parent-derived data is **never** written to the child's fields: the child's RDAP fields are cleared (NULL / `[]`) and `rdap_status` is set to `["no-object"]`. The child's registration info is not invented; the UI shows `Unavailable`.
- No schema or migration change was needed for V0.8.1 (`updateDomainRdap(id, data, ownership)` requires an explicit ownership argument).

## Manual expiration & reminders (V0.8.2)

- `domains.expiration_source` — `'rdap'` (default; automatic RDAP data) or `'manual'` (dates/provider entered by hand). Manual source is a UI-level guarantee: RDAP refreshes never overwrite `registration_date` / `expiration_date` / `registration_provider` / `registration_provider_url` for a manual-source domain (refresh only updates RDAP metadata, or clears it for `no-object` / parent results).
- `domains.registration_provider` / `domains.registration_provider_url` — validated provider preset key (e.g. `gname`) or `custom` + HTTPS URL, displayed as a link on the detail page.
- `expiration_reminders` — per-domain reminder days: `(id, domain_id FK→domains CASCADE, days_before, created_at)` with UNIQUE `(domain_id, days_before)`. Used by `evaluateExpirationReminders()` (worker) to emit `expiration_reminder` events.

## Migration history

- `0000` — domains table (+ unique hostname index)
- `0001` — dns_snapshots + dns_records (+ indexes)
- `0002` — ssl_snapshots + ssl_certificates (+ indexes)
- `0003` — http_snapshots (+ index)
- `0004` — notification_channels + notification_rules (+ indexes)
- `0005` — notification_events + notification_deliveries (+ unique index on dedup_key and on (event_id, channel_id))
- `0006` — `admin_settings` + `notification_secrets` (+ unique index on (channel_id, key)) — pure CREATE, non-destructive
- `0007` — V0.8.2: `domains.expiration_source` (NOT NULL DEFAULT 'rdap'), `domains.registration_provider`, `domains.registration_provider_url`, `expiration_reminders` table + unique index — additive, non-destructive
- Journal: `__drizzle_migrations` (8 rows). Migrations are plain SQLite DDL — D1-compatible if ever needed.

## Connection & transaction semantics

- `src/db/index.ts`: `mkdirSync(dirname(url), {recursive})` unless `:memory:`; `new Database(url)`; `pragma("foreign_keys = ON")`; `pragma("busy_timeout = 5000")` (dual-writer: next server + worker).
- All multi-write operations are wrapped in a single drizzle transaction (`createDnsSnapshot`, `createSslSnapshot`, `createHttpSnapshot`, event insert + delivery generation) — atomic: snapshot + records + events commit or roll back together (verified by rollback tests).
- `claimPendingDelivery` is an atomic CAS: `UPDATE … SET status='sending', attempts=attempts+1, claimed_at=now WHERE id=? AND status='pending' RETURNING id`.

## Secret storage (V0.8)

- `notification_secrets.encrypted_value` = AES-256-GCM ciphertext `iv:tag:ciphertext` (base64 segments) encrypted with `ENCRYPTION_KEY` (32-byte / 64 hex). No plaintext secrets are stored.
- `admin_settings` stores only scrypt password hash + recovery code hash + session secret (for HMAC signing) — never plaintext.
- Channel `config` JSON contains non-secret settings only (e.g. `chatId`).

## Important indexes

- `domains_hostname_unique` (UNIQUE)
- `expiration_reminders_domain_days_unique` (UNIQUE(domain_id, days_before))
- `dns_snapshots_domain_id_idx`, `dns_records_snapshot_id_idx`
- `ssl_snapshots_domain_id_idx`, `ssl_certificates_snapshot_id_idx`
- `http_snapshots_domain_id_idx`
- `notification_events_dedup_key_unique` (UNIQUE)
- `notification_deliveries_event_channel_unique` (UNIQUE)
- `notification_deliveries_event_id_idx`
- `notification_secrets_channel_key_unique` (UNIQUE(channel_id, key))

## Foreign key behavior

- FKs enforced (pragma ON). `ON DELETE CASCADE` from `domains` → snapshots/records, from snapshots → child rows, from events → deliveries, from `notification_channels` → `notification_secrets` (and deliveries). Deleting a domain removes all its monitoring data and notification history; deleting a channel removes its stored secrets.

## Backup / recovery

- **Current container (as of v0.8.2)**: the production DB lives at `/tmp/domain-monitor/data/domain-monitor.db`. The legacy local-backup script (`/usr/local/bin/domain-monitor-backup`) and its cron entry documented in earlier handovers are **not present** in this container; the pre-deployment backup taken during Phase 9J is kept next to the DB as `domain-monitor.db.9J-backup-20260818-044056` (mode 600, integrity verified). A Phase 10E pre-repair backup is kept at `/tmp/domain-monitor-10E-backup-2026-08-18T12-47-09-880Z.db` (mode 600, integrity verified). A Phase 11A pre-deploy backup is kept at `/tmp/domain-monitor-11A-backup-2026-08-18T16-20-15-021539291Z.db` (mode 600, integrity verified). Re-establishing scheduled backups is an operator decision outside the release scope.
- Off-site: Cloudflare R2 `domain-monitor-backups/daily/` via rclone (keep 30) — implemented & verified 2026-08-16 in the original deployment.
- Restore procedure: see `DISASTER_RECOVERY.md` — always restore to a temp path first, verify integrity, then explicit target.

## Production DB handling (current state)

- Contains 3 monitored domains: `chatgpt.com`, `opusai.eu.cc`, `snooze.eu.cc` (added via the public UI during production setup; `example.com` was removed by the operator). As of v0.8.1 (Phase 10E data repair): `chatgpt.com` keeps its own exact RDAP data (expiration `2026-11-30`), while `opusai.eu.cc` has no independent RDAP object → its RDAP fields are NULL/`[]` and `rdap_status = ["no-object"]`; the UI shows `Unavailable`. As of **v0.8.2 (Phase 11A)**: chatgpt.com / opusai.eu.cc keep `expiration_source = 'rdap'` (migration 0007 applied in production during the v0.8.2 deploy). As of **v0.8.3**: `snooze.eu.cc` is `expiration_source = 'manual'` (expiration 2027-07-14, registration platform gname), with one `expiration_reminders` row (60 days before expiry); the migration journal was repaired (0007 registered — see `NOTIFICATIONS.md` / `CHANGELOG.md`).
- 1 Telegram channel (encrypted token in `notification_secrets`), 5 notification rules (chatgpt.com HTTP/SSL + opusai.eu.cc HTTP/SSL + snooze.eu.cc expiration-reminder → Telegram). `notification_events` / `notification_deliveries` are empty — no real sends ever happened.
- `admin_settings` has 1 row (admin initialized); `notification_secrets` has 1 row (encrypted bot token).
- Never treat `/tmp/dm-e2e.db` (Phase 5 test DB) or any `/tmp` scratch DB as production.
