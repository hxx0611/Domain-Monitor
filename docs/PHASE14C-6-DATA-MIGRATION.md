# Phase 14C-6 — SQLite → D1 Data Migration

**Purpose:** Define the exact schema + data mapping for moving a Node
better-sqlite3 (`./data/domain-monitor.db`) into a Cloudflare D1 database, and
the validation/failure/idempotency rules that guarantee a **lossless, faithful,
secret-safe** migration.

**Scope note:** Both engines are SQLite-flavored; the migrations
(`0000–0007`) are byte-identical SQL for both. The interesting work is **data
mapping fidelity**, **secret ciphertext preservation**, and **verification**.

---

## 1. Schema Mapping (13 business tables)

All 13 tables are created by the same migration files on both engines. Column
lists below come from `src/db/migrations/*.sql`.

| # | Table | Columns (from migrations) |
|---|-------|---------------------------|
| 1 | `domains` | id, hostname, status, created_at, updated_at, registrar, registration_date, expiration_date, updated_date, rdap_updated_at, nameservers, rdap_status, expiration_source, registration_provider, registration_provider_url |
| 2 | `dns_snapshots` | id, domain_id, checked_at |
| 3 | `dns_records` | id, snapshot_id, type, name, value, priority, ttl |
| 4 | `ssl_snapshots` | id, domain_id, checked_at, tls_version, cipher_name, status, error |
| 5 | `ssl_certificates` | id, snapshot_id, fingerprint256, subject, issuer, valid_from, valid_to, serial_number, san, is_self_signed, hostname_matched |
| 6 | `http_snapshots` | id, domain_id, checked_at, status, http_status, response_time_ms, redirected, redirect_count, final_url, error |
| 7 | `notification_channels` | id, type, name, config, enabled, created_at |
| 8 | `notification_rules` | id, name, channel_id, source, event_type, domain_id, enabled, created_at |
| 9 | `notification_events` | id, domain_id, source, event_type, previous_state, current_state, dedup_key, occurred_at |
| 10 | `notification_deliveries` | id, event_id, channel_id, status, attempts, error, created_at, claimed_at, delivered_at |
| 11 | `admin_settings` | id, password_hash, recovery_code_hash, session_secret, encryption_key, created_at, updated_at |
| 12 | `notification_secrets` | id, channel_id, key, encrypted_value, created_at, updated_at |
| 13 | `expiration_reminders` | id, domain_id, days_before, created_at |

> `expiration_source` / `registration_provider` / `registration_provider_url`
> come from migration `0007_manual_expiration.sql`; `expiration_reminders` is
> also added there.

---

## 2. Column Mapping (source → destination)

Mapping is **1:1 by column name**, with these guarantees:

- **IDs preserved** — `id`, and every FK column, are imported with the exact
  integer values. AUTOINCREMENT is not re-run; the next inserted row uses
  `MAX(id)+1` naturally.
- **Foreign keys preserved** — child rows keep their original parent `id`s.
  Import order in the tool is by table dependency (parents first) so that a
  fresh DB with `foreign_keys = ON` never rejects a child.
- **Timestamps preserved** — `created_at`, `updated_at`, `checked_at`,
  `occurred_at`, `claimed_at`, `delivered_at` are copied as integers (epoch ms,
  as the app stores them).
- **Enums / state strings preserved** — `status`, `source`, `event_type`,
  `has_channel_secret` etc. are plain text, copied verbatim.
- **Nullable columns preserved** — `null` stays `null`; no default is imposed.

No column needed a **transformation**; every field is `sourceColumn = targetColumn`.

The one place a transformation **must be explicitly disallowed** is the secret
columns (§4) — they must be copied **as-is**, never re-encrypted.

---

## 3. Unique & FK Indexes (re-verified)

These constraint indexes are created by the migrations and re-verified after
import (the migrate tool runs `verifyUnique` + `verifyFK`):

| Table | UNIQUE | FK |
|-------|--------|-----|
| `domains` | hostname | — |
| `dns_snapshots` | — | domain_id → domains.id |
| `dns_records` | — | snapshot_id → dns_snapshots.id |
| `ssl_snapshots` | — | domain_id → domains.id |
| `ssl_certificates` | — | snapshot_id → ssl_snapshots.id |
| `http_snapshots` | — | domain_id → domains.id |
| `expiration_reminders` | (domain_id, days_before) | domain_id → domains.id |
| `notification_events` | dedup_key | domain_id → domains.id |
| `notification_deliveries` | (event_id, channel_id) | event_id → notification_events.id; channel_id → notification_channels.id |
| `notification_secrets` | (channel_id, key) | channel_id → notification_channels.id |
| `notification_rules` | — | channel_id → notification_channels.id; domain_id → domains.id |

Note: FK columns may be **NULL** (e.g. `notification_rules.domain_id IS NULL`
means "any domain"); NULL children are valid and are NOT treated as orphans.

---

## 4. Secret Handling (AES-256-GCM)

- **Storage format:** `iv:tag:ciphertext`, each segment base64
  (`iv` = 12 bytes, `tag` = 16 bytes GCM auth tag, `ciphertext` = AES-256-GCM).
- **Migration rule:** `notification_secrets.encrypted_value` is migrated
  **as-is (byte-for-byte)**. **Never decrypt**, **never re-encrypt**, **never
  print plaintext** in the tool, logs, or output files.
- **Roundtrip verified in the drill:** the migrated ciphertext decrypts back to
  the original **fixture** value under the same key. In the real migration the
  app's `ENCRYPTION_KEY` is unchanged, so `getChannelSecret()` can decode every
  migrated ciphertext.
- **`admin_settings.session_secret` / `encryption_key`:**
  - `session_secret` is a plaintext TEXT column (the app stores the session
    secret for signing). It is **not** a ciphertext column and is migrated as-is.
  - `encryption_key` is the AES key source. It is **NOT a secret to migrate**
    in the sense of "protect during transit"; but the **actual value must not
    be committed / printed / logged**. In the drill it is a fake placeholder.
  - Both are treated as **sensitive** — the tool never echoes their values,
    only their presence/length.
- **Security invariant:** the migration tool must never output a secret
  plaintext. The drill's `migrate-d1-cli.ts` implements `verifyNoPlaintext`
  which asserts that every `notification_secrets.encrypted_value` matches the
  `iv:tag:ciphertext` format (contains `:`), and fails loudly otherwise.

---

## 5. Validation (post-import)

Run these after import (all part of `migrate-d1-cli.ts`):

1. **Row-count parity** — per table `COUNT(source) − COUNT(d1) = 0`.
2. **Rule-level parity** — for `notification_events` and
   `notification_deliveries`, compare every ordered field (event_id/channel_id/
   status/attempts/error/created_at/dedup_key/occurred_at).
3. **UNIQUE verification** — re-run the UNIQUE index group-by check; 0 duplicate
   groups.
4. **FK verification** — no orphaned child rows (excluding valid NULL children).
5. **Secret ciphertext check** — no plaintext in `notification_secrets`.
6. **Business smoke** — domain read/update, snapshots, reminder evaluation,
   event/delivery creation, CAS claim, dedup.

---

## 6. Failure Handling

The migration tool must be **fail-closed and atomic at each boundary**:

| Failure class | Detection | Recovery action |
|---------------|-----------|-----------------|
| **Schema migration failure** | migration SQL throws (e.g. duplicate table) | Discard the disposable D1; re-run from a clean source. No partial schema is used. |
| **Data import failure** | INSERT throws (FK/UNIQUE violation) with `foreign_keys = OFF` during import for order, but constraints re-checked after | Discard the D1; re-import from the same manifest. No half-imported state persists. |
| **Constraint violation** | FK / UNIQUE viol "threw" | Rejected; row count unchanged. Recovery = re-run. |
| **Verification mismatch** | parity/unique/FK/secret fail | The tool prints the mismatch report and exits non-zero; **no deploy happens**. |

**Key invariant:** the migration is **all-or-nothing per D1 database** — the
target D1 is always created fresh (schema + import), and if any step fails the
target is disposed and re-run. There is no "half-migrated" state that could be
mistaken for a valid D1.

---

## 7. Idempotency

The tool is idempotent in two ways:

- **Re-running against a fresh target** is always safe: the target is
  `rm`-ed and recreated, so the result is deterministic.
- **Re-running against an existing target** the tool files a "target exists"
  note; in the prototype the user chooses to overwrite. In production the
  migration is guarded: if the D1 already has the expected row count and the
  migrations journal is at `0007`, the tool is a no-op (this matches the
  `wrangler d1 migrations apply` idempotent behavior established in 14C-3).

---

## 8. Dry Run

`pnpm migrate:d1 --dry-run` (prototype: `node migrate-d1-cli.js <src> <d1> --dry-run`):

- Reports table list + row counts **without writing** the target D1.
- Reveals the plan (13 tables, N rows, target would be created fresh/overwritten).
- Mutates nothing.

---

## 9. Migration Tool Design (`prototype/cloudflare/14c6/migrate-d1-cli.ts`)

Requirements met: idempotency, dry-run, row count, FK verification, UNIQUE
verification, secret ciphertext preservation, failure report, **no plaintext
secrets**, **no production defaults**.

`migrate-d1-cli.ts` runs against a **better-sqlite3 file via the real
`D1BindingProxy` + `createD1Repository`**, so it exercises the exact adapter
code D1 uses — a faithful local stand-in for a real D1 binding.
