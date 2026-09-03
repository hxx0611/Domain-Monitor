# Phase 14C-1 — D1 Repository Full Async Refactor: Pre-Refactor Inventory

- Date: 2026-08-24
- HEAD: `09e0523` (v0.8.9), working tree: `M tsconfig.json` (prototype exclude) + untracked 14B docs/prototype
- Baseline tests: **849/849 PASS** (vitest, 57 files)
- Production DB: zero-touch anchor (size 126976, mtime `2026-08-20 05:52:25.889245417 +0000`, integrity ok; counts: domains 3, channels 1, rules 5, events 7, deliveries 7, secrets 1, admin 1, reminders 1, dns_records 30, dns_snapshots 5, http_snapshots 4, ssl_certificates 3, ssl_snapshots 4, migrations 8)

---

## A. Repository modules

| Module | Responsibility | Sync API | Used by |
|---|---|---|---|
| `src/lib/domains/repository.ts` | Domains CRUD, RDAP persistence, expiration reminders | 12 fns | actions, pages, services, notifications (expiration, factory, actions) |
| `src/lib/dns/repository.ts` | DNS snapshots + records | 3 fns | dns/service |
| `src/lib/http/repository.ts` | HTTP snapshots | 3 fns | http/service |
| `src/lib/ssl/repository.ts` | SSL snapshots + certificates | 3 fns | ssl/service |
| `src/lib/notifications/repository.ts` | Events, channels, rules, deliveries, state machine | 25 fns | notifications actions/service/worker, dns/http/ssl repos |
| `src/lib/notifications/secrets.ts` | Encrypted channel secrets | 3 fns | notifications actions, senders/factory |
| `src/lib/auth/admin.ts` | Admin settings row + session key + flows | 11 fns | auth actions, guards |

## B. DB initialization

- `src/db/index.ts`: module-level singleton `db = drizzle(new Database(url), { schema })`.
  - `url = process.env.DATABASE_URL || "./data/domain-monitor.db"`.
  - PRAGMA `foreign_keys = ON`, `busy_timeout = 5000`.
  - `closeDb()` for tests (Windows temp-dir cleanup).
- No factory/instance API — the singleton is imported everywhere (`import { db } from "@/db"`).

## C. better-sqlite3 imports (8 files)

- `src/db/index.ts` — value import `Database` + `drizzle-orm/better-sqlite3`.
- Type-only `BetterSQLite3Database<Schema>` in: auth/admin.ts, dns/repository.ts, domains/repository.ts, http/repository.ts, notifications/repository.ts, notifications/secrets.ts, ssl/repository.ts.
- Test helper `test/helpers.ts` `createTestDb()`: `new Database(":memory:")` + migrations 0000–0007 + `drizzle(sqlite, { schema })` → returns `DnsDb` (`BetterSQLite3Database<Schema>`).

## D. Drizzle imports

- Value: `drizzle` from `drizzle-orm/better-sqlite3` (db/index.ts) and `drizzle-orm/d1` (NOT yet used in src — available in node_modules 0.44.7; d1 session supports **async transactions** BEGIN/COMMIT/ROLLBACK).
- Query helpers: `eq`, `and`, `desc`, `lt`, `inArray`, `isNotNull`, `sql`.

## E. Synchronous query methods

Every repository method is synchronous. Distinct shapes:
- `select().from().where().get()` → single row
- `select().from().where().orderBy().limit().all()` → rows
- `insert().values().returning().get()` → inserted row (lastInsertId)
- `insert().values().onConflictDoNothing().returning().all()` → inserted subset
- `insert().values().onConflictDoUpdate({target,set}).run()` → upsert
- `update().set().where().returning().get()` / `.run()` → affected row/count
- `delete().where().returning().get()` / `.run()` → affected row/count
- `result.changes` — better-sqlite3 `run()` shape (D1 returns `meta.changes` — **shape difference**).

## F. Synchronous transaction methods (4)

| # | Method | Purpose | Tables | Atomicity |
|---|---|---|---|---|
| 1 | `dns/repository.createDnsSnapshot` | snapshot + records + events→deliveries | dns_snapshots, dns_records, notification_events, notification_deliveries | All-or-nothing |
| 2 | `http/repository.createHttpSnapshot` | snapshot + events→deliveries | http_snapshots, notification_events, notification_deliveries | All-or-nothing |
| 3 | `ssl/repository.createSslSnapshot` | snapshot + cert + events→deliveries | ssl_snapshots, ssl_certificates, notification_events, notification_deliveries | All-or-nothing |
| 4 | `domains/repository.setExpirationReminders` | delete all + insert new (replace set) | expiration_reminders | All-or-nothing |

All use `target.transaction((tx) => {...})` with **sync callback** (better-sqlite3 transaction). Nested: `insertEventsAndGenerateDeliveries(tx, events)` runs inside the caller's tx handle — no nested transaction.

## G. Raw SQL

- **1 occurrence**: `src/lib/notifications/repository.ts:157` `attempts: sql\`${attempts} + 1\`` inside `claimPendingDelivery` (atomic increment on CAS claim). Portable SQLite SQL — D1 compatible.

## H. DB-dependent actions/services (callers)

| Caller | Repo functions used | Notes |
|---|---|---|
| `src/lib/domains/actions.ts` | createDomain, deleteDomain, getDomainById, setExpirationReminders, updateDomain, updateDomainRdap | server actions (async) |
| `src/lib/dns/service.ts` | getDomainById (barrel), getLatestDnsSnapshot, createDnsSnapshot | `checkDns` already async |
| `src/lib/http/service.ts` | getDomainById (barrel), getLatestHttpSnapshot, createHttpSnapshot | `checkHttp` already async |
| `src/lib/ssl/service.ts` | getDomainById (barrel), getLatestSslSnapshot, createSslSnapshot | `checkSsl` already async |
| `src/lib/notifications/actions.ts` | 20+ repo fns + `insertNotificationEvents(db, …)`, `createDelivery` (explicit global db) | server actions (async) |
| `src/lib/notifications/service.ts` | getEnabledRules, getChannel, createDelivery, insertNotificationEvents, claim/mark/retry/recover, getDelivery | deliverDelivery async; insertEventsAndGenerateDeliveries sync, takes `target: NotificationDb` |
| `src/lib/notifications/worker.ts` | recoverStaleSending, getPendingDeliveries, getEvent, getChannel + deliverDelivery + evaluateExpirationReminders | `runOnce` async; options.db is `NotificationDb` |
| `src/lib/notifications/expiration.ts` | getAllExpirationReminders (domains repo), direct `select domains where expirationDate IS NOT NULL`, insertEventsAndGenerateDeliveries | `evaluateExpirationReminders` sync |
| `src/lib/notifications/senders/factory.ts` | getDomainById (domains repo), getChannelSecret (secrets) | `resolveDomain` sync; `resolveSecret` async |
| `src/app/page.tsx` (RSC) | getDomains (barrel) | sync RSC |
| `src/app/domains/[id]/page.tsx` (RSC) | getDomainById, getExpirationReminders (barrel), getDnsSnapshots, getLatestDnsSnapshot, getSslHistory, getLatestSslSnapshot, getHttpHistory, getLatestHttpSnapshot | sync RSC |
| `src/app/notifications/page.tsx` (RSC) | getDomains (barrel) | sync RSC |
| `scripts/worker.ts` (CLI) | runOnce (default db) | already async |

## I. Notification DB paths

- `insertNotificationEvents(target, events)` — ON CONFLICT DO NOTHING + RETURNING; dedupKey→id map for positional alignment (no order guarantee).
- `insertEventsAndGenerateDeliveries(target, events)` — dedup-hit events never re-generate deliveries; runs inside caller's tx.
- `createDelivery` — UNIQUE(event_id, channel_id) + ON CONFLICT DO NOTHING.
- `claimPendingDelivery` — CAS UPDATE `WHERE status='pending'` + `attempts+1`; single statement, atomic.
- `markDeliverySent/Failed` — CAS UPDATE `WHERE status='sending'`.
- `retryDelivery` — CAS `WHERE status='failed'`.
- `recoverStaleSending` — CAS `WHERE status='sending' AND claimedAt < cutoff`; returns changes count.
- `getPendingDeliveries(limit)` — FIFO by id.
- State machine: pending → sending → sent / failed → pending (retry); sending → pending (stale recovery).

## J. Authentication DB paths

- `admin_settings` single row: getAdminRow (limit 1), insertAdminRow (setup), updateAdminRow (recovery rotates sessionSecret).
- `isAdminConfigured` — passwordHash presence.
- `getSessionSecret` — SESSION_SECRET env wins; else DB row sessionSecret.
- `getEncryptionKey` (admin) — ENCRYPTION_KEY env wins; else DB row encryptionKey. **NOTE**: separate from `notifications/encryption.ts` file-based key (that module never touches the DB).
- Session cookie signing uses getSessionSecret; guards: requireAdmin (cookie check), requirePageAccess (configured + authenticated).
- Flow functions: setupAdmin, loginAdmin, recoverAdmin (sync, DB-backed).

## Statistics

- **SELECT**: ~25 queries across repos (all via Drizzle builder).
- **INSERT**: domains, snapshots (dns/http/ssl), records, certs, events, deliveries, channels, rules, secrets, admin, reminders.
- **UPDATE**: domains (manual fields, RDAP, reminders via delete+insert), channels, rules, deliveries (state machine), admin, secrets (upsert).
- **DELETE**: domains (cascade), reminders, channels (cascade), rules, secrets.
- **transaction**: 4 (see F).
- **batch**: 0 (not currently used).
- **unique constraint handling**: domains.hostname (pre-check + insert), expiration_reminders UNIQUE(domain_id, days_before) (DB backstop), events.dedup_key (ON CONFLICT DO NOTHING), deliveries UNIQUE(event_id, channel_id) (ON CONFLICT DO NOTHING), secrets UNIQUE(channel_id, key) (ON CONFLICT DO UPDATE upsert).
- **CAS**: claim/sent/failed/retry/recover (5 conditional UPDATEs).
- **lastInsertId / returning**: `.returning().get()`/`.all()` everywhere for inserted ids; `result.changes` for counts.
- **SQLite-specific APIs**: better-sqlite3 transaction (sync), `result.changes`, `sql\`attempts+1\``, PRAGMAs (foreign_keys, busy_timeout). No `date()`, no window functions, no JSON1 — all portable SQLite SQL.

## Key design implications (inventory → architecture)

1. **Async facade over sync driver is viable**: all business callers are already async except the RSC pages (convertible to async RSC) and `evaluateExpirationReminders` (convert to async) and `resolveDomain` (accept Promise).
2. **Transaction scope is contained**: only 4 transaction methods; each is a repository-level operation. D1 can use drizzle's async D1 transaction (BEGIN/COMMIT/ROLLBACK) or batch.
3. **Notification CAS is single-statement**: portable to D1 unchanged (WHERE status = …).
4. **Driver type leakage**: `target: BetterSQLite3Database<Schema>` params and `options.db` (NotificationDb) must disappear from the business layer; move into adapter internals.
5. **`insertEventsAndGenerateDeliveries`** is the cross-cutting pipeline primitive: needs SQLite (sync, tx-scoped) and D1 (async, tx-scoped) implementations.
6. **`result.changes` vs `meta.changes`**: D1 run() result shape differs — adapter must normalize.
