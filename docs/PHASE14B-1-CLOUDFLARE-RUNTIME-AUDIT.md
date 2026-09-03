# Phase 14B-1 — Cloudflare Runtime Compatibility Preflight Audit

> **Scope**: Domain-Monitor v0.8.9 (commit `09e0523`). Assess whether the project
> has the *foundation* to migrate to **Cloudflare Workers + OpenNext + D1**.
> **This phase is STRICTLY READ-ONLY.** No source/config/package/lockfile was
> modified; no npm/pnpm install; no migration; no wrangler; no Cloudflare/D1
> resource; no Git mutation; no production restart; no secret read; no
> Telegram/Webhook/Email send; no temporary production resource.
>
> **Generated**: 2026-08-24 (UTC). **Report file is intentionally `untracked`.**
>
> **Verification (run after generation):** `git status --short` clean,
> `git diff --check` clean (no tracked modification), HEAD unchanged
> (`09e0523`), production processes/DB/Cloudflare untouched, no real outbound
> request executed.

---

## A. Next.js / OpenNext

| Item | Finding |
|---|---|
| Framework | **Next.js `^15.5.23`** + React `^19.2.8` |
| App Router | ✅ Yes — `src/app/` with `layout.tsx` + page routes |
| Route Handlers | ❌ None (`src/app` contains **no** `route.ts`) |
| Middleware | ❌ None |
| Server Components | ✅ Used throughout pages |
| Server Actions | ✅ Yes — `"use server"` in 8 action modules (auth/dns/domains/http/i18n/notifications/ssl) |
| Runtime markers | All pages `export const dynamic = "force-dynamic"` (6/6). **No** `export const runtime = "nodejs"` / `"edge"` declared anywhere → currently runs on **default Node.js runtime** in OpenNext parity terms. |
| next.config.ts | `reactStrictMode: true` + `outputFileTracingRoot: path.join(__dirname)` (imports `node:path` at **build-time** only, not runtime) |
| Cloudflare/OpenNext config | ❌ None — no `wrangler.toml` / `wrangler.jsonc` / `open-next.config.*` |
| Node compat flag | ❌ Not configured (`nodejs_compat` not declared; no tailwind/turbopack concerns) |

**A-conclusion:** The App-Router + Server-Actions + `force-dynamic` shape is the
*best-case* surface for OpenNext — no Edge-middleware, no route handlers, no
client-heavy ISR. Build-time `node:path` in `next.config.ts` is fine. **The
framework layer is OpenNext-compatible by design.**

---

## B. Database

The D1 migration is the **largest single obstacle**, and it is architectural.

| Item | Finding |
|---|---|
| Driver | `better-sqlite3 ^13.0.3` (native Node addon) bound via `drizzle-orm/better-sqlite3` |
| Drizzle | `drizzle-orm ^0.44.7`, `drizzle-kit ^0.31.2`, dialect `sqlite` |
| Schema module | `src/db/schema.ts` — uses `drizzle-orm/sqlite-core` (`sqliteTable`, `integer`, `text`, `index`, `uniqueIndex`). ✅ **Primitives are D1-compatible.** |
| DB init | `src/db/index.ts` — imports `node:path` (dirname) + `node:fs` (mkdirSync), opens a **local file** `process.env.DATABASE_URL \|\| "./data/domain-monitor.db"`, sets `.pragma("foreign_keys = ON")` and `.pragma("busy_timeout = 5000")` |
| Direct `better-sqlite3` imports (non-test) | `src/db/index.ts` + 7 repository modules (`auth/admin`, `dns/repository`, `domains/repository`, `http/repository`, `notifications/repository`, `notifications/secrets`, `ssl/repository`) |
| `BetterSQLite3Database<Schema>` type used | **8 non-test files** (same set as above) |
| Synchronous Drizzle calls (`.get`/`.run`/`.all`/`.transaction`/`.returning`) in non-test src | **~93 call sites** |
| Synchronous `db.transaction(...)` callbacks | 4 non-test modules (`dns`, `domains`, `http`, `ssl` repositories) |
| `import { db } from "@/db"` consumers (non-test) | 9 files |

**Key incompatibility:** `drizzle-orm/better-sqlite3` + `better-sqlite3` are
**synchronous** (returns values, not Promises), and `db.transaction(cb)` uses a
**synchronous callback**. Cloudflare **D1** exposes an **async** driver
(`drizzle-orm/d1`, `D1Database`) where every query is `await`ed and
`transaction` is callback-based-but-async (via `batch()` semantics). The
**entire repository layer plus every caller** would need to become async.

**Drizzle D1 compatibility of migrations:**
- Migration files use `integer PRIMARY KEY AUTOINCREMENT NOT NULL` (✅ D1 supports
  `AUTOINCREMENT`), `ALTER TABLE ADD COLUMN` (✅ supported), `--> statement-breakpoint`
  (✅ Drizzle D1 convention), and Drizzle `onConflictDoUpdate` / `.returning()`
  (✅ supported by D1).
- **No** `datetime()` / `strftime()` / `BLOB` / `REGEXP` / `VACUUM` / `ATTACH`
  / exotic SQLite extensions found in migrations → **no obvious D1-unfriendly
  SQLite feature**.
- Drizzle `onConflictDoUpdate` in `secrets.ts` (`notificationSecrets`) maps to
  D1 `ON CONFLICT DO UPDATE` (✅).
- SQLite `mode: "timestamp"` integers for `createdAt/updatedAt` (✅ D1 stores
  integers fine).

**B-conclusion:** Schema and migrations are D1-friendly. The **blocker is the
driver/runtime model** — `better-sqlite3` (native node module + local file +
sync API + sync transaction) must be replaced by `drizzle-orm/d1`, and the
synchronous repository API (≈93 call sites + 4 sync transactions) must be
awaited across the whole callgraph. This is a **large refactor**, not a
find-and-replace.

---

## C. Worker / scheduled()

| Item | Finding |
|---|---|
| CLI entry | `scripts/worker.ts` (Node process, parses `process.argv`, calls `runOnce`, `console.log(JSON.stringify(...))`, `process.exit`) |
| Worker core | `src/lib/notifications/worker.ts` — exports **`runOnce(options)`**; injectable `{ db, limit, staleAfterMs, now, senders }`; returns `WorkerRunResult`; never touches `process`/fs/CLI directly |
| Decoupling | ✅ **`runOnce` is already scheduler-agnostic** — it takes the DB and sender-factory as injectable options. The only Node-specific parts are the **CLI wrapper** (`scripts/worker.ts`) and the **watchdog shell** (`scripts/worker-watchdog.sh`) |
| Watchdog | `scripts/worker-watchdog.sh` — bash loop, `flock`, `sleep 3600`, invokes `tsx scripts/worker.ts`. **Node/process/filesystem-only**; not portable |
| Notifications worker DB | `src/lib/notifications/repository.ts` — sync better-sqlite3 (subject to §B) |
| Sender factory | `createSender` in `senders/factory.ts` → maps channel types; loads secrets from `secrets.ts` (which reads `getEncryptionKey()` from `process.env`/fs) |
| In-flight guard | `http/service.ts` uses an **in-process `Set<number>`** (per-isolate). Works on a single Worker isolate, but breaks across multiple instances / D1's shared backends (cross-isolate dedup is not a thing). |

**C-conclusion:** The **core business logic of `runOnce` is already decoupled
from the Node CLI** — it can be adapted to a Cloudflare **`scheduled()`**
handler with minimal logic change. **What must be rebuilt:** the scheduling
layer (`scripts/worker.ts` + `scripts/worker-watchdog.sh` → `scheduled()` /
Cron Trigger), the DB driver (§B), and the in-process dedup (→ D1-backed or
durable-object dedup). The `expiration`, `deliverDelivery`, and sender-loop
logic is portable. **C is the easiest part to adapt.**

---

## D. External network

| Egress client | Mechanism | Workers `fetch`? | Note |
|---|---|---|---|
| RDAP | `src/lib/rdap/client.ts` + `bootstrap.ts` — `fetch` of `IANA_BOOTSTRAP_URL` + registry endpoints | ✅ Yes | SSRF-guarded via bootstrap (registry URLs from IANA, not user input) |
| DNS (DoH) | `src/lib/dns/client.ts` — `fetch` of Cloudflare/Google DoH | ✅ Yes | `DNS_DOH_ENDPOINT` injectable |
| HTTP monitor | `src/lib/http/client.ts` — `fetch` + **manually-resolved DNS** | ⚠️ Partly | Uses `node:dns/promises.lookup` to pre-resolve IPs for SSRF guard (token from §A — DNS rebinding defense) |
| SSL monitor | `src/lib/ssl/client.ts` — **`node:tls` raw socket** | ❌ **NO** | `tls.connect` + `getPeerX509Certificate` — **Workers cannot do raw TCP/TLS**, nor read a peer X.509 cert |
| Telegram | `src/lib/notifications/senders/telegram.ts` — `fetch` | ✅ Yes | Fixed `api.telegram.org` endpoint, no user URL |
| Webhook | `src/lib/notifications/senders/webhook.ts` — `fetch` + SSRF DNS guard | ⚠️ Partly | Uses `node:dns/promises.lookup` via `@/lib/http/client` |
| Email | `src/lib/notifications/senders/email.ts` — `fetch` to HTTPS Email API (NOT SMTP) | ✅ Yes | Good — **no SMTP/TCP**; `node:dns/promises.lookup` only for SSRF guard |

**D-conclusion:**
- **Good for Workers:** RDAP, DoH DNS, Telegram, Webhook, Email (all `fetch`-based;
  Email uses an HTTPS API endpoint, not SMTP — no raw TCP).
- **Not Workers-compatible:** `src/lib/ssl/client.ts` (`node:tls` raw socket +
  X.509 read) — **hard BLOCKER**.
- **Needs rework:** The **SSRF DNS pre-resolution** in `http/client.ts`
  (`node:dns/promises.lookup`) is used by HTTP/Webhook/Email senders as the
  DNS-rebinding defense. Worklers do offer `fetch`, but the project's
  "resolve every IP and reject reserved ranges" model cannot run on Workers as
  written (no arbitrary DNS resolver enumeration API in the standard runtime;
  `fetch` resolves internally). This must be adapted (rely on Cloudflare's
  egress-only-fetch network isolation, drop the manual IP enumeration, or
  outsource resolution to a DoH fetch).

---

## E. Secrets

| Secret / path | Read mechanism | Workers Secrets? | Note |
|---|---|---|---|
| `ENCRYPTION_KEY` | `src/lib/notifications/encryption.ts` `getEncryptionKey()` — `process.env.ENCRYPTION_KEY` (production requires it); dev falls back to `data/encryption.key` via `node:fs`/`node:path` | ✅ Yes | Prefer **Workers Secrets (`env.ENCRYPTION_KEY`)**. The **dev file** fallback (`fs` write) is dev-only and not portable |
| `SESSION_SECRET` | `src/lib/auth/admin.ts` `getSessionSecret()` — `process.env.SESSION_SECRET` else **DB row** (`admin.sessionSecret`) | ✅ Yes | Prefer Workers Secret; the DB fallback is already the recovery/rotation path |
| Telegram bot token | `secrets.ts` → AES-256-GCM blob in `notification_secrets` table, decrypted at send; legacy `secretRef` → `process.env[name]` | ⚠️ Hybrid | Encrypted-at-rest token in DB survives → **can stay in D1**; `secretRef` env fallback → Workers Secrets |
| Webhook/Email API key | `secretRef` / `apiKeyRef` → `process.env` at send time | ✅ Yes | Map to Workers Secrets |
| `notification_secrets` encryption | AES-256-GCM via `node:crypto` (`createCipheriv`/`createDecipheriv`/`createHash`/`randomBytes`) | ⚠️ | Web Crypto API (`crypto.subtle`) offers AES-GCM + SHA-256 + `getRandomValues`; **needs an adapter** (sync→async, `Buffer`→`Uint8Array`) |
| `Buffer` usage | `src/lib/auth/password.ts`, `session.ts`, `notifications/encryption.ts` | ⚠️ | Workers aligns to `Uint8Array`; minor adapter |

**E-conclusion:** **No secret value was read or printed.** All secrets are
already read through env-var or an encrypted DB blob — no hardcoded secrets,
no `secret` leaked into source/Git. Workers Secrets + keeping the encrypted
`notification_secrets` blob in D1 is a clean fit. Only the **`node:crypto`
sync primitives** (AES-GCM/HMAC/scrypt/randomBytes) and **`Buffer`** need
Web-Crypto wrappers. `password.ts` uses **`scryptSync`** (Node-only) — Workers
Web Crypto offers `PBKDF2`, not `scrypt`; the hash format
(`scrypt$N$r$p$saltHex$derivedHex`) would need a `scrypt`-capable runtime or
a migration to PBKDF2/argon2.

---

## F. Filesystem

The project assumes a **persistent local filesystem** in several places. Under
Workers/OpenNext, local fs is **read-only, per-isolate, ephemeral, bundled** —
the opposite of a stateful DB/secret store.

| Location | Behavior | Workers impact |
|---|---|---|
| `src/db/index.ts` | `mkdirSync(dirname(DATABASE_URL))` then `new Database(file)` | ❌ — no local SQLite file; D1 is remote. **Eliminated by D1.** |
| `src/lib/notifications/encryption.ts` | dev fallback `data/encryption.key` created via `writeFileSync`/`readFileSync`/`existsSync` | ❌ dev-only; prod requires `ENCRYPTION_KEY` env. Remove or gate |
| `scripts/worker-watchdog.sh` | `$APP_DIR`, `.worker-watchdog.lock`, `worker.log`, `flock` | ❌ not portable → `scheduled()` |
| `scripts/backup-db.js` (Phase 13C) | `better-sqlite3` online backup → NFS dir | ❌ entirely Node/fs-based. D1 has native `D1 export`/backup; this script is superseded |
| `.next/`, `/tmp`, NFS paths | build artifacts + backup target | Build artifacts handled by OpenNext; backup target → D1/Workers-native, not NFS mount |

**F-conclusion:** The two fs-coupled production files are **DB init** and the
**dev encryption key file** (prod-gated). Both need to disappear for Workers.
The backup script and watchdog are Node/orchestration concerns that D1 +
Cron Triggers replace. There is **no assumption that must be preserved** — all
fs usage is replaceable by D1 + Workers Secrets + Workers-native scheduling.

---

## G. Runtime boundary table

Legend: **WA** = Workers-runtime (aka "Workers-compatible") · **Node-only** = cannot run natively in a Workers isolate · **Compat** = runs under `nodejs_compat` (with caveats) · **Adapter** = requires a wrapper to Web/Workers APIs.

| Module | Current Runtime | Node-only? | Workers Feasibility | D1 Impact | Refactor Level |
|---|---|---|---|---|---|
| `src/app/*` (pages, layout) | Node App Router | No | ✅ (OpenNext) | none | **LOW** (already compatible) |
| `src/lib/*/actions.ts` (Server Actions) | Node App Router | No | ✅ (OpenNext) | none | **LOW** |
| `src/db/schema.ts` | build-time/Drizzle | No | ✅ | ✅ (primitives OK) | **LOW** |
| `src/db/index.ts` | Node | **Yes** (`better-sqlite3`, `node:fs`, `node:path`) | ❌ → D1 | **High** (driver + sync→async) | **HIGH** |
| `dns/repository.ts` | Node | **Yes** (better-sqlite3) | ❌ → D1 | **High** | **HIGH** |
| `domains/repository.ts` | Node | **Yes** (better-sqlite3) | ❌ → D1 | **High** | **HIGH** |
| `http/repository.ts` | Node | **Yes** (better-sqlite3) | ❌ → D1 | **High** | **HIGH** |
| `ssl/repository.ts` | Node | **Yes** (better-sqlite3) | ❌ → D1 | **High** | **HIGH** |
| `notifications/repository.ts` | Node | **Yes** (better-sqlite3) | ❌ → D1 | **High** | **HIGH** |
| `notifications/secrets.ts` | Node | **Yes** (better-sqlite3 + crypto) | ⚠️ → D1+WebCrypto | **High** | **HIGH** |
| `auth/admin.ts` | Node | **Yes** (better-sqlite3) | ⚠️ → D1 | **High** | **HIGH** |
| `http/client.ts` | Node | **Yes** (`node:dns/promises`) | ⚠️ | none | **MEDIUM** (SSRF adapter) |
| `notifications/senders/webhook.ts` | Node | **Yes** (`node:dns/promises` via http) | ⚠️ | none | **MEDIUM** |
| `notifications/senders/email.ts` | Node | **Yes** (`node:dns/promises`) | ✅ (fetch, no SMTP) | none | **LOW–MEDIUM** |
| `notifications/senders/telegram.ts` | Node | No | ✅ | none | **LOW** |
| `rdap/client.ts` + `bootstrap.ts` | Node | No | ✅ | none | **LOW** |
| `rdap/service.ts` | Node | No | ✅ | none | **LOW** |
| `dns/client.ts` (DoH) | Node | No | ✅ | none | **LOW** |
| `http/service.ts` | Node | No | ✅ (logic) | some (repo) | **MEDIUM** |
| `ssl/client.ts` | Node | **Yes** (`node:tls` raw socket) | ❌ **NO** | none | **CRITICAL — BLOCKER** |
| `ssl/service.ts` | Node | **Yes** (uses tls client) | ❌ (calls ssl/client) | none | **HIGH** |
| `notifications/worker.ts` (`runOnce`) | Node | No | ✅ (logic decoupled) | some (repo) | **MEDIUM** (adapter to `scheduled`) |
| `notifications/expiration.ts` | Node | No | ✅ | some (repo) | **MEDIUM** |
| `notifications/encryption.ts` | Node | **Yes** (`node:crypto`,`node:fs`) | ⚠️ → WebCrypto | none | **MEDIUM** |
| `auth/password.ts` | Node | **Yes** (`scryptSync`, `node:crypto`) | ⚠️ (PBKDF2 only) | none | **HIGH** (hash algo) |
| `auth/session.ts` | Node | **Yes** (`node:crypto`,`Buffer`) | ⚠️ → WebCrypto | none | **MEDIUM** |
| `dns/normalize.ts` | Node | **Yes** (`node:net` `isIP`) | ⚠️ → pure JS | none | **LOW** (pure function rewrite) |
| `scripts/worker.ts` (CLI) | Node | **Yes** (`process.argv`/`exit`) | ❌ → `scheduled()` | some | **MEDIUM** |
| `scripts/worker-watchdog.sh` | shell | **Yes** (`flock`/`sleep`) | ❌ → Cron Trigger | none | **HIGH** (replace) |
| `scripts/backup-db.js` (13C) | Node | **Yes** (`better-sqlite3`, fs, NFS) | ❌ → D1 backup | some | **HIGH** (replace) |

---

## H. Final conclusion

### 1. Cloudflare Workers compatibility estimate (architecture estimate, NOT a precise coverage number)

This is an **architectural readiness estimate**, not a measured test. Roughly:

- **~55–65%** of the *business logic* (validation, normalization, SSRF policy,
  event/state machine, sender composition, RDAP/DoH/Telegram/Webhook/Email
  transport, App-Router UI + Server Actions) **maps cleanly** to Workers/OpenNext
  because it is `fetch`-based and scheduler-agnostic.
- **~35–45%** requires **adaptation/rewrite**, dominated by (a) the entire
  **synchronous better-sqlite3 → async D1** repository layer, (b) the
  **`node:tls` SSL certificate reader**, (c) the **`node:crypto` sync**
  primitives + `Buffer`, (d) the **SSRF DNS pre-resolution** model, and (e) the
  **Node scheduler/watchdog/backup** orchestration.

Do **not** read the number as a coverage guarantee — it is a directional
estimate from static inspection.

### 2. BLOCKERs (cannot run on Workers as-is)
1. **`src/lib/ssl/client.ts`** — raw `node:tls` socket + X.509 peer-certificate
   read. Workers has no raw TCP/TLS socket API → **certificate monitoring is
   unimplementable in a plain Worker**. (Needs an external cert-observation
   service, or accepting the loss of TLS cert checks, or a Worker-side
   `fetch`-only "is it https & what's the TLS version" approximation — but the
   actual cert *contents* cannot be read by Worker `fetch`.)
2. **`better-sqlite3` + `drizzle-orm/better-sqlite3`** — native Node addon,
   **synchronous**, local-file DB. Cannot run in a Worker. **Must be replaced
   by `drizzle-orm/d1` + Cloudflare D1**, converting ~93 sync call sites + 4
   sync transactions to async.

### 3. Risk list
- **HIGH**
  - `node:crypto` sync primitives (`createCipheriv/Decipheriv`, `createHmac`,
    `scryptSync`, `randomBytes`, `timingSafeEqual`) and `Buffer` → Web Crypto
    async adapter. **`password.ts` hash (`scrypt`) has no WebCrypto equivalent** → hash-algo decision.
  - SSRF DNS pre-resolution (`node:dns/promises.lookup`) in `http/client.ts`
    (also used by webhook/email) — Workers model differs (egress-only fetch).
  - Scheduler/watchdog/backup orchestration (shell + tsx + better-sqlite3
    backup) → Cloudflare Cron Trigger + D1 backup/export.
- **MEDIUM**
  - `node:net` `isIP` (pure) → implement as pure JS (trivial but must be done).
  - In-process `Set<number>` in-flight dedup (per-isolate).
  - Server-Action auth/session cookies (e.g. `session.ts` Node crypto/Buffer).
  - D1 vs SQLite concurrency semantics (D1 detached, eventual, no `busy_timeout`;
    `foreign_keys` pragma per-connection).
- **LOW**
  - `trace`/`debug` logs, `next.config.ts` build-time `path` (build-time only).
  - Drizzle `onConflictDoUpdate`/`.returning()` (supported by D1).

### 4. Directly reusable modules
- `src/app/*`, all `src/lib/*/actions.ts`, `src/lib/*/service.ts` (thin logic).
- `src/lib/rdap/*`, `src/lib/dns/client.ts` (DoH), `src/lib/notifications/senders/telegram.ts`.
- `src/lib/notifications/i18n.ts`, `timezone.ts`, `types.ts`, `events.ts`,
  `rules.ts`, `expiration.ts` (pure logic).
- `src/lib/http/normalize.ts`, `src/lib/ssl/normalize.ts`,
  `src/lib/monitoring/error-classifier.ts` (pure).
- `src/db/schema.ts` (unchanged, primitives are D1-compatible), migration files
  (already D1-friendly).

### 5. Must be adapter-ized
- **DB**: all `*repository.ts` + `notifications/secrets.ts` + `auth/admin.ts` +
  `src/db/index.ts` → `drizzle-orm/d1` + async.
- **Crypto**: `password.ts` (scrypt→PBKDF2/argon2), `session.ts`,
  `notifications/encryption.ts` (sync→WebCrypto async).
- **SSL**: `ssl/client.ts` + `ssl/service.ts` → external cert observer (or drop
  cert-content checks).
- **SSRF guard**: `http/client.ts` DNS resolution model.
- **Scheduler**: `scripts/worker.ts` + `worker-watchdog.sh` → `scheduled()`.
- **Dev key file + DB dir creation**: `notifications/encryption.ts`,
  `db/index.ts` → remove local-fs assumptions.

### 6. Suggested minimal migration path (proposal only — NOT executed)
1. **DB first (highest risk)**: swap driver to `drizzle-orm/d1`; make all
   repository functions `async`; add `nodejs_compat` + wrangler; create a
   read-verify D1 shim that reproduces the schema via the existing (already
   D1-friendly) migrations. Keep behavior identical behind an interface so
   Server Actions and sender logic do not change.
2. **SSL BLOCKER**: decide externally — either (a) accept losing raw cert
   reading, or (b) add a cert-observation adapter. This is the one genuine
   "cannot port" and must be decided **before** prototype.
3. **Secrets**: map `ENCRYPTION_KEY` / `SESSION_SECRET` / Email/Webhook
   `*Ref` to **Workers Secrets**; keep the `notification_secrets` encrypted
   blob in D1. Replace dev fs key file.
4. **Crypto**: wrap AES-GCM/HMAC/HKDF via `crypto.subtle`; re-key
   `password.ts` to a Workers-supported KDF (with migration of existing hashes).
5. **Scheduling**: wrap `runOnce` in a `scheduled()` export; replace
   `worker-watchdog.sh` with a Cron Trigger; replace `backup-db.js` with D1
   export/backup.
6. **SSRF model**: adapt DNS pre-resolution to Workers semantics.

### 7. Is the current project ready to proceed to Phase 14B-2 Prototype?

**Qualified yes — proceed**, *provided* the two hard blockers are explicitly
accepted as scope for the prototype:

- ✅ **Condition A** — The framework layer (App Router, Server Actions,
  `force-dynamic`) is genuinely OpenNext-compatible; the pure logic and
  `fetch`-based senders are reusable. Good foundation.
- ⚠️ **Condition B (CRITICAL) — `node:tls` SSL monitoring.** This is a real
  architectural blocker, not a refactor. If certificate-content monitoring
  must be preserved, a plain Worker **cannot** do it; the prototype would
  either (a) drop cert-content checks, or (b) introduce an external cert
  observer. **This must be agreed before 14B-2.**
- ⚠️ **Condition C (LARGE) — synchronous `better-sqlite3` → async D1.** This is
  a substantial, all-layer refactor (~93 call sites + 4 sync transactions).
  It is well-understood and isolated, but it **is** the bulk of the migration
  effort and should be the first prototype deliverable.

**Verdict: Suitable to continue to Phase 14B-2 Prototype**, with **Condition B**
(the `node:tls` SSL read) explicitly flagged as a scope decision to make first,
and **Condition C** (D1 driver refactor) as the primary prototype focus. A
prototype that first validates the D1 async-refactor + OpenNext build of the
App Router on a *subset* of modules (e.g. domains + RDAP + DoH + Telegram) is
the value-maximizing next step.

---

## FINAL STATUS: PASS

- Audit is complete; evidence gathered by static read-only inspection of
  v0.8.9 (`09e0523`).
- **Read-only verification** (performed after generation):
  - `git status --short` → **clean**
  - `git diff --check` → **clean** (this report is untracked; no tracked diff)
  - `HEAD` → **unchanged** (`09e0523`); no commit/push/tag/release
  - production next-server / worker / DB / Cloudflare resources → **untouched**
  - no real Telegram/Webhook/Email sent; no secret read or printed
- Report written to `docs/PHASE14B-1-CLOUDFLARE-RUNTIME-AUDIT.md` and left
  **untracked** (no Git commit).

> **Next phase gate:** Do **not** auto-advance to Phase 14B-2. Await explicit
> user approval. The `node:tls` SSL-monitor blocker (Condition B) must be
> resolved as a scope decision before any prototype.
