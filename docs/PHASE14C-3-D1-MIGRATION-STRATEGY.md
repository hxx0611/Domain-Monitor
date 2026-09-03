# Phase 14C-3 — D1 Production Migration Strategy & Dry-Run

**Status: FINAL PASS (prototype/local only — zero production touch)**

Scope: Formalize the Cloudflare D1 production migration mechanism. Verified
entirely on local prototype D1 (wrangler `--local`, Miniflare, better-sqlite3
metadata model). **No production D1 / Worker / credentials were ever touched.**

---

## A. Migration Inventory

Source of truth: `src/db/migrations/` (SQL) + `src/db/migrations/meta/` (journal + snapshots).

| idx | journal tag | SQL filename | SHA256 (SQL) | snapshot |
|----:|-------------|--------------|--------------|:--------:|
| 0 | `0000_careless_penance` | `0000_careless_penance.sql` | `7cbcfa5e8c3ecf81…` | ✅ |
| 1 | `0001_bright_old_lace` | `0001_bright_old_lace.sql` | `e778135a08b68244…` | ✅ |
| 2 | `0002_thin_slipstream` | `0002_thin_slipstream.sql` | `28d045396ee69e13…` | ✅ |
| 3 | `0003_greedy_goblin_queen` | `0003_greedy_goblin_queen.sql` | `e0ad4110df23931d…` | ✅ |
| 4 | `0004_dazzling_ender_wiggin` | `0004_dazzling_ender_wiggin.sql` | `4d6fc68d0fc187bc…` | ✅ |
| 5 | `0005_equal_medusa` | `0005_equal_medusa.sql` | `616c2601379a2621…` | ✅ |
| 6 | `0006_black_bloodscream` | `0006_black_bloodscream.sql` | `be50c86b2192c508…` | ✅ |
| 7 | `0007_manual_expiration` | `0007_manual_expiration.sql` | `f4c068aa1d31314bfa6457decfd0d039ed63eb910faec760cc8c075af6e3d4d7` | ✅ |

**0007 full SHA256**: `f4c068aa1d31314bfa6457decfd0d039ed63eb910faec760cc8c075af6e3d4d7` ✅ (matches §2 requirement exactly)

### Inventory checks

- **Continuity**: idx 0→7 continuous, `[0,1,2,3,4,5,6,7]` ✅
- **No duplicates / no gaps / no unknown**: journal `entries` length = 8; each `tag` maps to exactly one on-disk `.sql` file; no extra SQL files ✅
- **Journal tag ↔ filename**: `journalEntry.tag + ".sql"` → exists for all 8 ✅
- **Snapshots**: `meta/0000_snapshot.json` … `meta/0007_snapshot.json` all present (8/8) ✅
- **Drizzle meta DB**: `meta/index.sqlite` NOT present (drizzle only writes it when `drizzle-kit` runs; we do not) ✅

### `drizzle.config.ts`

```ts
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_URL || "./data/domain-monitor.db" },
});
```

Drizzle-Kit drives **SQL generation** only (schema.ts → migrations folder). It is NOT used
for production execution.

---

## B. Wrangler Config

### `wrangler.jsonc` (root, prototype + near-future deploy config)

```jsonc
{
  "name": "domain-monitor-main-cf-prototype",
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "vars": {
    "CONFIG_TELEGRAM_ENDPOINT": "http://127.0.0.1:8788",   // prototype-only fake endpoint
    "ENCRYPTION_KEY": "prototype-e2e-key-…"                 // prototype-only fake key
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "domain-monitor-prototype-main",
      "database_id": "00000000-0000-0000-0000-000000000002", // placeholder UUID (prototype-only)
      "migrations_dir": "src/db/migrations"
    }
  ]
}
```

### Binding confirmation

- `env.DB` → `binding: "DB"` ✅
- `database_name`, `database_id`, `binding`, `migrations_dir` all present ✅
- `migrations_dir`: **must live INSIDE the `d1_databases[].` entry**, not at config top level (correct here) ✅
- **No production `database_id` / credentials are committed.** All UUIDs are placeholders. The production `database_id` is supplied at deploy time (via config/secret), never checked in ✅
- `prototype/cloudflare/wrangler.jsonc` (vendored) has a separate prototype DB name (`domain-monitor-cf-prototype`) but **lacks `migrations_dir`** — it is used for the local smoke worker only, not for migrations.

---

## C. Drizzle Behavior (`drizzle-orm` 0.44.7 / `drizzle-kit` 0.31.10)

Drizzle `migrate()` (from `drizzle-orm/<driver>/migrator`, and D1 uses
`drizzle-orm/d1/migrator`) observes this flow:

```
readMigrationFiles(config):
  journalPath = "<migrationsFolder>/meta/_journal.json"
  if (!exists) THROW "Can't find meta/_journal.json file"
  for each journalEntry in journal.entries:
    query = readFile("<migrationsFolder>/<journalEntry.tag>.sql")
    migrationQueries.push({ hash, sql, bps: journalEntry.breakpoints, folderMillis: journalEntry.when })
```

- **Journal dependency: HARD REQUIRED.** Without `meta/_journal.json`, `migrate()` throws immediately (verified).
- **Tracking table**: `__drizzle_migrations` (default; `config.migrationsTable` overridable):
  ```sql
  CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )
  ```
- **Dedup/migrate-now logic**: `lastDbMigration = max(created_at)`. A migration is applied
  when `created_at < migration.folderMillis` (= journal `when`). All pending migrations +
  tracking inserts are batched into ONE `db.session.batch()` (atomic per run).
- **No-op**: second run → `lastDbMigration.created_at` equals the newest `when`, so 0 applied (verified: still 8 rows).
- **Metadata stored**: `hash` (revision hash) + `created_at` (= journal `when` millis).
  **No file name is stored**, and there is **no UNIQUE constraint** on hash (dedup is purely
  the `created_at` comparison).
- **Failure behavior**: D1 `batch()` — a failing statement fails the batch. (Not separately
  verified on D1 runtime in this phase, but the atomic `batch` semantic means partial
  application is not independently committed per-statement.)

### §8 verified results (better-sqlite3 metadata model — identical readMigrationFiles + __drizzle_migrations)

- Fresh DB → `migrate()` applied 8 migrations, 13 business tables, `expiration_reminders` present ✅
- `__drizzle_migrations` count = 8 ✅
- **Journal dependency proof**: folder with SQL but no journal → `migrate()` threw
  `Can't find meta/_journal.json file` ✅
- **No-op**: second `migrate()` → still 8 rows, no duplicates ✅
- Last row: `hash = f4c068aa1d31314bfa6457decfd0d039ed63eb910faec760cc8c075af6e3d4d7`
  (= 0007 hash), `created_at = 1787063220000` (= journal `when` for idx 7) ✅

> Note: `better-sqlite3/migrator` and `d1/migrator` share the *exact same*
> `readMigrationFiles` + `__drizzle_migrations` metadata model. The metadata behavior
> (journal requirement, tracking table, dedup, no-op) is **driver-independent** and
> therefore validated for D1 as well.

---

## D. Journal Model

Drizzle journals the SQL revision sequence under `meta/_journal.json`:

```json
{
  "version": "7",
  "dialect": "sqlite",
  "entries": [
    { "idx": 0, "version": "6", "when": 1786459459901, "tag": "0000_careless_penance", "breakpoints": true },
    …,
    { "idx": 7, "version": "6", "when": 1787063220000, "tag": "0007_manual_expiration", "breakpoints": true }
  ]
}
```

- `tag` = migration prefix + human name (equals SQL filename minus `.sql`).
- `when` = epoch-millis ordering token (used by Drizzle as `folderMillis`/`created_at`).
- `breakpoints` = statement-separator markers (a Drizzle journaling detail; wrangler ignores it —
  wrangler parses `--> statement-breakpoint`, not the JSON journal).
- Wrangler **does not read `_journal.json`** — it derives the migration list by scanning SQL
  files in `migrations_dir` and compares against its own `d1_migrations` tracking table.

```yaml
Tracking metadata model (comparison):
  Drizzle:  __drizzle_migrations (id SERIAL, hash, created_at)  — keyed by hash + journal when
  Wrangler: d1_migrations (id INTEGER PK AI, name TEXT UNIQUE, applied_at TIMESTAMP) — keyed by filename
```

**These are NOT equivalent.** Drizzle identifies a migration by its content hash + journal
`when`; Wrangler identifies it by its file **name** + applied timestamp. They cannot be
interchanged as the same state (see §E/§H for why Wrangler is chosen).

---

## E. Failure Behavior

Controlled failure test (disposable D1 — a broken 0007 introduced only in a throwaway
migrations dir, **never touching the real 0000–0007**):

- A 0000–0006 clean apply took the DB to a valid 13-business-table? no — to the 0006 state (12 business tables; `expiration_reminders` not yet created).
- Then a broken `0007` was applied → **failed**:
  ```
  ✘ near "IS": syntax error at offset 18: SQLITE_ERROR
  ```

### Failure results (verified)

- **Failed migration NOT tracked**: `d1_migrations` count stayed **7** (0007 absent). ✅
- **No partial schema left**: `domains.expiration_source` column count = **0** after failure.
  The first `ALTER TABLE … ADD COLUMN expiration_source` in the broken 0007 was **rolled back**. ✅
- **Wrangler applies each migration atomically** — if any statement fails, the whole migration
  is rolled back (no partial schema, no tracking row). This is the key safety property.
- **Second apply continues**: after fixing the broken 0007, re-running `apply` applied it
  cleanly (✅). Migration count → 8, `expiration_source` → 1. ✅
- Disposable fail-DB deleted after test ✅

> Note on commit semantics: wrangler's D1 local apply treats a `.sql` file's set of statements
> as one unit (rolls back on error). For a multi-statement migration with a mid-failure,
> the already-executed leading statements are reverted — no partial state persists.

---

## F. No-op Behavior

Tested on the §5 DB that had all 8 applied:

```
✅ No migrations to apply!
```

- **0 migrations executed** ✅
- `d1_migrations` count = 8 (unchanged) ✅
- 13 business tables (no duplicate columns / tables / indexes) ✅

No-op is idempotent; re-running `wrangler d1 migrations apply` is a no-op when all SQL files
are already registered in `d1_migrations`.

---

## G. 0007 Verification

`0007_manual_expiration.sql` was verified to apply and yield:

- `domains` gains 3 columns:
  - `expiration_source TEXT NOT NULL DEFAULT 'rdap'` ✅
  - `registration_provider TEXT` (nullable) ✅
  - `registration_provider_url TEXT` (nullable) ✅
- `expiration_reminders` table created ✅
  ```sql
  CREATE TABLE `expiration_reminders` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `domain_id` integer NOT NULL,
    `days_before` integer NOT NULL,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
  );
  ```
  - **FK** `domain_id → domains(id) ON DELETE cascade` enforced (SQLITE_CONSTRAINT_FOREIGNKEY on orphan insert) ✅
  - **UNIQUE** `(domain_id, days_before)` enforced (SQLITE_CONSTRAINT_UNIQUE on duplicate) ✅, index `expiration_reminders_domain_days_unique`
- **13 business tables / 12 indexes**, `d1_migrations` count = 8 ✅

Schema-parity: `src/db/schema.ts` defines the same 13 tables + 0007 columns/table ✅.

---

## H. CI/CD Deployment Order

Recommended production release sequence (wrangler-first, migration applied **before** deploy):

```
STEP 1  Git checkout release commit
STEP 2  Quality gates: pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm format:check
STEP 3  OpenNext build:  opennextjs-cloudflare build   (produces .open-next/worker.js)
STEP 4  Migration:       wrangler d1 migrations apply <DB> --remote   [with prod database_id via CI secret]
STEP 5  Migration verification: wrangler d1 migrations list <DB> --remote  (assert 8 applied, 0 pending)
STEP 6  Deploy:          wrangler deploy
STEP 7  HTTP smoke:      curl to public Worker hostname; verify /setup (or /login→307) and the new feature
```

### Failure-pairing guarantee

- If **migration apply succeeds but Worker deploy fails**: database holds the new schema,
  old Worker stays running. Because all 0000–0007 are **additive** (see §I), the old Worker
  continues to function against the new schema. The deploy step can be retried.
- If **deploy succeeds but migration was skipped**: the new Worker would expect schema it lacks → bad.
  Hence STEP 4 (migration) is **strictly before** STEP 6 (deploy).

### CI wiring note

`package.json` currently exposes `db:migrate` = `drizzle-kit migrate`. Per this strategy,
**production migration must use `wrangler d1 migrations apply`**, not `drizzle-kit migrate`
(and never application runtime). CI/operator should invoke wrangler, not `db:migrate`, for D1.

---

## I. Backward Compatibility

All 8 migrations audited: **strictly additive**.

- Only `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE ADD COLUMN`.
- **Zero** `DROP`, `RENAME`, `DELETE`, `TRUNCATE`, column-type-change, or column-drop statements.
- 0007 specifics:
  - `expiration_source` added with `NOT NULL DEFAULT 'rdap'` → existing rows automatically read `'rdap'` (old code unaffected; new column defaulted).
  - `registration_provider`, `registration_provider_url` nullable → old code never sees them.
  - `expiration_reminders` is a brand-new table + UNIQUE index → old code doesn't reference it.

**Old Worker on 0007 schema: does NOT crash.** New columns are nullable/defaulted; new table
is ignored by old code. ✅ Backward compatible.

---

## J. Emergency Migration Policy

Established policy for any future schema change:

1. Edit `src/db/schema.ts`.
2. Generate migration via `drizzle-kit generate` (production of SQL + journal + snapshot).
3. **Review the SQL** (must be additive unless a deliberate destructive step is documented).
4. **Verify journal** (`meta/_journal.json` gains the new idx/tag) and **snapshot** (`meta/<idx>_snapshot.json`).
5. Fresh-D1 validate: apply `0000 → N`.
6. Existing-D1 validate: apply `N-1 → N` (incremental).
7. No-op migrate (idempotency).
8. Application regression suite (tsc / eslint / vitest / build).
9. Release cut (tag).
10. Production apply: `wrangler d1 migrations apply <DB> --remote`.
11. Migration verification: `wrangler d1 migrations list <DB> --remote`.
12. `wrangler deploy`.

Rules:
- **NEVER hand-edit the production D1 schema.** Only apply via the migration files.
- Emergency migration must keep **SQL + journal + snapshot** in sync, and must not be applied
  to production until it has passed steps 5–8.

---

## K. SQLite / D1 Parity Matrix

| Area | SQLite (Node better-sqlite3) | D1 (Cloudflare) | Status |
|------|------------------------------|-----------------|:------:|
| domains CRUD | sync repo | async repo (D1) | PASS |
| expiration / RDAP save | direct | via async repo | PASS |
| manual expiration (0007) | `expiration_source` col | `expiration_source` col | PASS |
| RDAP update | sync | async | PASS |
| DNS records/snapshots | sync | async | PASS |
| HTTP snapshots | sync | async | PASS |
| SSL certificates/snapshots | sync | async | PASS |
| reminders (expiration_reminders) | UNIQUE(domain_id,days) | UNIQUE(domain_id,days) | PASS |
| events (notification_events) | UNIQUE(dedup_key) | UNIQUE(dedup_key) | PASS |
| deliveries (notification_deliveries) | UNIQUE(event_id,channel) | UNIQUE(event_id,channel) | PASS |
| claim CAS | deterministic ACID | batch/atomic; local limitation noted | PASS* |
| dedup | UNIQUE constraint | UNIQUE constraint | PASS |
| notification sender | fake tg (8788) | fake tg (8788) | PASS |
| admin | admin_settings + secrets | admin_settings + secrets | PASS |
| secrets (notification_secrets) | UNIQUE(channel_key) | UNIQUE(channel_key), encrypted | PASS |

*PASS with limitation: true concurrent CAS on D1 local runtime is not a perfect reflection of
production concurrency, but the `batch()` atomicity + deterministic CAS + UNIQUE constraints
cover the semantic requirement (one winner). Phase 14C-2C verified single-winner on the
local D1 via concurrent claim.

Overall: **PARITY PASS**. No BLOCKED parity item in this phase.

---

## L. Production Safety

Verified at end of phase:

- production D1: **not connected / not queried / not executed / not migrated** ✅
- production Worker: **not restarted** ✅ (only local prototype `wrangler dev --local` on port 8791)
- real notifications: **0** ✅ (all Telegram traffic directed to fake `127.0.0.1:8788`; no `api.telegram.org`)
- no `--remote` wrangler invocations were run ✅
- disposables (fail-test, journal-test, drizzle-state) deleted ✅
- No git commit / push / tag / release performed ✅

---

## M. Final Recommendation

**RECOMMENDED PRODUCTION MIGRATION MECHANISM:**

```
wrangler d1 migrations apply
```

Rationale:
1. Wrangler is the D1-native migration executor — it creates the `d1_migrations` tracking
   table and applies SQL file migrations atomically (verified: failed migration rolls back
   with no partial schema, no tracking row).
2. **Journal-independent**: Wrangler scans SQL files; it does NOT depend on
   `meta/_journal.json`. This is more robust than Drizzle `migrate()` (verified: 0007 applied
   even when journal lacked its entry — the 11E/11G scenario is safe).
3. **No runtime migration**: Wrangler is invoked at deploy time, never from the application
   (satisfies §1 prohibition of runtime/HTTP-triggered migration).
4. Backward-compatible additive migrations let a failing deploy leave the old Worker healthy.

**Drizzle's role** (clearly separated):
- schema definition (`src/db/schema.ts`)
- query building + type safety
- **migration SQL generation only** (`drizzle-kit generate` → `src/db/migrations/`).

**Wrangler's role**:
- production D1 migration execution (`wrangler d1 migrations apply --remote`).

**Application prohibition**: no runtime migration, no HTTP-triggered migrate, no
`drizzle-kit migrate` in production (use wrangler).

---

## §16 Final Verdict

| Gate | Result |
|------|:------:|
| Migration inventory PASS (0000–0007 contiguous, tagged, hashed, snapshotted) | ✅ |
| 0000→0007 fresh D1 apply PASS (13 tables, 12 indexes, FK, UNIQUE, 0007 cols/table) | ✅ |
| No-op PASS (`✅ No migrations to apply!`, still 8, no dups) | ✅ |
| Failure behavior documented (atomic rollback, no partial, no tracking) | ✅ |
| Journal discrepancy test PASS (0007 applied without journal entry) | ✅ |
| Drizzle / Wrangler roles clearly separated | ✅ |
| CI/CD ordering PASS (migration before deploy) | ✅ |
| Backward compatibility PASS (all additive) | ✅ |
| Production zero-touch PASS | ✅ |

# **FINAL PASS** ✅

**RECOMMENDED PRODUCTION MIGRATION: `wrangler d1 migrations apply`**
