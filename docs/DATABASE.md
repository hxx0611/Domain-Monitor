# Domain-Monitor — Database

> SQLite via better-sqlite3 + Drizzle ORM. Schema source: `src/db/schema.ts`. Migrations: `src/db/migrations/0000…0005`.

## Locations

- Dev default: `./data/domain-monitor.db` (inside repo, git-ignored state)
- **Production: `/workspace/domain-monitor-data/domain-monitor.db`** (mode 600, outside the repo)
- Override via `DATABASE_URL` env (supervisor sets it for production).

## Tables (10) & relationships

| Table | Key columns | Relationships |
|---|---|---|
| `domains` | id PK, hostname UNIQUE, status, created/updated_at, RDAP fields (registrar, dates, nameservers JSON, rdap_status JSON, rdap_updated_at) | parent of everything below (cascade delete) |
| `dns_snapshots` | id PK, domain_id FK, checked_at | 1:N per domain |
| `dns_records` | id PK, snapshot_id FK, type, name, value, priority (MX), ttl | N:1 snapshot |
| `ssl_snapshots` | id PK, domain_id FK, checked_at, tls_version, cipher_name, status, error | 1:N per domain |
| `ssl_certificates` | id PK, snapshot_id FK, fingerprint256, subject, issuer, valid_from/to, serial, san JSON, is_self_signed, hostname_matched | 1:1 snapshot |
| `http_snapshots` | id PK, domain_id FK, checked_at, status, http_status, response_time_ms, redirected, redirect_count, final_url, error | 1:N per domain |
| `notification_channels` | id PK, type (email/webhook), name, config JSON, enabled | — |
| `notification_rules` | id PK, channel_id FK, source, event_type, domain_id FK, enabled | N:1 channel |
| `notification_events` | id PK, domain_id FK, source, event_type, previous_state JSON, current_state JSON, dedup_key UNIQUE, occurred_at | — |
| `notification_deliveries` | id PK, event_id FK, channel_id FK, status (pending/sending/sent/failed), attempts, error, claimed_at, delivered_at | UNIQUE(event_id, channel_id) |

## Migration history

- `0000` — domains table (+ unique hostname index)
- `0001` — dns_snapshots + dns_records (+ indexes)
- `0002` — ssl_snapshots + ssl_certificates (+ indexes)
- `0003` — http_snapshots (+ index)
- `0004` — notification_channels + notification_rules (+ indexes)
- `0005` — notification_events + notification_deliveries (+ unique index on dedup_key and on (event_id, channel_id))
- Journal: `__drizzle_migrations` (6 rows). Migrations are plain SQLite DDL — D1-compatible if ever needed.

## Connection & transaction semantics

- `src/db/index.ts`: `mkdirSync(dirname(url), {recursive})` unless `:memory:`; `new Database(url)`; `pragma("foreign_keys = ON")`; `pragma("busy_timeout = 5000")` (dual-writer: next server + worker).
- All multi-write operations are wrapped in a single drizzle transaction (`createDnsSnapshot`, `createSslSnapshot`, `createHttpSnapshot`, event insert + delivery generation) — atomic: snapshot + records + events commit or roll back together (verified by rollback tests).
- `claimPendingDelivery` is an atomic CAS: `UPDATE … SET status='sending', attempts=attempts+1, claimed_at=now WHERE id=? AND status='pending' RETURNING id`.

## Important indexes

- `domains_hostname_unique` (UNIQUE)
- `dns_snapshots_domain_id_idx`, `dns_records_snapshot_id_idx`
- `ssl_snapshots_domain_id_idx`, `ssl_certificates_snapshot_id_idx`
- `http_snapshots_domain_id_idx`
- `notification_events_dedup_key_unique` (UNIQUE)
- `notification_deliveries_event_channel_unique` (UNIQUE)
- `notification_deliveries_event_id_idx`

## Foreign key behavior

- FKs enforced (pragma ON). `ON DELETE CASCADE` from `domains` → snapshots/records, from snapshots → child rows, from events → deliveries. Deleting a domain removes all its monitoring data and notification history.

## Backup / recovery

- Local: `/workspace/domain-monitor-backups/` — `sqlite3 .backup` + `integrity_check` + atomic mv, keep 14 (script `/usr/local/bin/domain-monitor-backup`, cron 03:30).
- Off-site: Cloudflare R2 `domain-monitor-backups/daily/` via rclone (keep 30) — implemented & verified 2026-08-16.
- Restore procedure: see `DISASTER_RECOVERY.md` — always restore to a temp path first, verify integrity, then explicit target.

## Production DB handling (current state)

- Contains 2 verification domains: `opusai.eu.cc`, `apitoken.indevs.in` (added via the public UI during production E2E; user has not yet decided whether to keep them).
- No notification channels/rules configured → no real webhook/email sends possible.
- Never treat `/tmp/dm-e2e.db` (Phase 5 test DB) or any `/tmp` DB as production.
