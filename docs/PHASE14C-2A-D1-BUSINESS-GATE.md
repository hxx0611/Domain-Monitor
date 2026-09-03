# Phase 14C-2A — Cloudflare D1 Business Gate Audit Report

**Scope**: Validate the full business closed loop on a **local prototype D1** (miniflare workerd) via the real
`createD1Repository` adapter + the real business functions. Strictly local/prototype-only.

**Date**: 2026-08-24
**Verdict**: **D1 ARCHITECTURE BLOCKER** — the D1 adapter cannot preserve business semantics because drizzle-orm/d1's
`db.transaction()` emits SQL `BEGIN TRANSCATION`, which the Cloudflare D1 API explicitly rejects.

---

## 0. Hard-Stop compliance (all LOCAL/PROTOTYPE)

- Wrangler local only, `--local` / miniflare workerd on a fresh persist dir `/tmp/d1-14C2A-harness`.
- **No** `wrangler deploy`, no `--remote`, no production credentials/DATABASE_URL/.env, no production D1.
- **No** real Telegram/Webhook/Email (stubbed `fetch` + fake sender).
- **No** git commit / push / tag / release.
- Migration files 0000–0007: **git diff = 0** (untouched).
- Production resources: **never touched**.

---

## A. Baseline

| Item | Value |
|---|---|
| Git HEAD | `09e0523` (09e05237d75b8a4b88429747c02c2cf16184c15d) |
| package.json version | `0.8.9` |
| Working tree | pre-existing 14C-1 refactor mods (untracked `src/db/adapters`, `src/db/repository.ts`, etc.); **no new mods from this phase** |
| Node version | `v25.6.0` |
| Wrangler version | `4.125.0` (prototype) |
| Prototype D1 path | `/tmp/d1-14C2A-harness` (fresh, migrations re-applied) |
| Migration count | 8 (0000–0007) |
| Table count | 13 |
| Index count | 12 |

Production read-only record:

| Item | Value |
|---|---|
| DB path | `/tmp/domain-monitor/data/domain-monitor.db` |
| mtime / size | `Aug 20 05:52` / `126976` |
| sha256 | `a495cf44d23747f1d701fff5ad0cb417ce212d48862e7817d715402e61ee652d` |
| integrity | `ok` |
| counts | domains=3, events=7, deliveries=7, channels=1 |
| next-server / worker / cloudflared PID | **none running** (no production process active at baseline) |

Production is currently NOT running, so "PID unchanged" holds trivially.

---

## B. D1 repository boot

`createD1Repository(d1)` instantiates and performs a real READ against miniflare workerd D1.

- ✅ `createDomain` + `getDomainById` + hostname-uniqueness read return correct values.
- ✅ **No Node-only DB dependency in the D1 path**: `src/db/adapters/d1.ts` value-imports only
  `drizzle-orm`, `drizzle-orm/d1`, `@/db/schema`, `@/lib/notifications/rules`. It does **NOT** value-import
  `better-sqlite3`, `node:sqlite`, `node:fs`, or the `@/db/repository` module-level SQLite singleton (`Repository`
  is a `type`-only import). No `Cannot access 'SQLiteRepository' before initialization`.
- ⚠️ `wrangler dev --local` full-worker boot of the main app was **not** run because the main app's Cloudflare
  runtime switch is still incomplete (the module-level `createSQLiteRepository(db)` singleton remains — an open
  14C-1 item). Booting the full OpenNext worker would pull in the singleton → better-sqlite3.

---

## C. Domain flow (D1)

- ✅ Create + read `prototype.example.com`, `status=active`, `expirationSource=rdap` all correct.
- ✅ Duplicate hostname → `createDomain` returns `undefined` (no throw).
- ✅ `sqlite`-style `UNIQUE` on hostname enforced by D1 (managed by the adapter's pre-check, no exception).

---

## D. RDAP exact (D1, real public fetch)

Live `queryRdapWithFallback("chatgpt.com")`:

- `ownership=exact`
- expiration saved → **`2026-11-30T23:59:19.000Z`**
- `rdapStatus` populated.

✅ EXACT path works on D1.

---

## E. RDAP parent (D1, real public fetch)

Live `queryRdapWithFallback("opusai.eu.cc")`:

- `ownership=parent`
- **Child expiration stays `null`** (`rdapStatus=no-object`, `source=rdap`).
- Parent metadata is NOT written into the child's expiration.

✅ Parent semantics preserved on D1 (canonical mismatch → parent → no child expiry write).

---

## F. RDAP no-object

- Fixture `nonexistent-hopefully.example` did NOT trigger the no-object path — `.example` has **no RDAP bootstrap
  entry**, so `queryRdapWithFallback` **throws** `"No RDAP bootstrap entry found for .example"`.
- The no-object fixture needs a TLD that HAS an RDAP bootstrap but returns no object (a real 404). Not exercised.
- ⚠️ **Fixture limitation**, not a code defect. Marked as PARTIAL/not-verified.

---

## G. Manual expiration (D1)

- ✅ Manual domain created + read: `expirationSource=manual`, `expirationDate=2035-06-15`,
  `registrationProvider=gname`, `registrationProviderUrl=https://www.gname.com/` — all correct.
- ✅ RDAP refresh with `rdapStatus=["no-object"]` did **not** overwrite the manual expiration/source.
- ❌ `setExpirationReminders(domainId, [30])` — **FAILS**: `D1_ERROR ... SQL BEGIN TRANSACTION`.

---

## H. Reminder (D1)

- ❌ `evaluateExpirationReminders(now, repoD1)` — **FAILS** (it calls `getAllExpirationReminders` + generates a
  reminder event via `insertEventsAndGenerateDeliveries`, which uses `db.transaction()` → SQL `BEGIN`).
- Root cause identical to G: transactional reminder/event pipeline is rejected by D1.

---

## I. Event generation (D1)

- ❌ `insertEventsAndGenerateDeliveries([event])` — **FAILS** with `D1_ERROR ... SQL BEGIN TRANSACTION`.

---

## J. Delivery generation (D1)

- ❌ Same root cause as I — deliveries are generated inside the same transacted pipeline. Cannot proceed past event
  generation.

---

## K. CAS (D1)

- Not reached on D1 (the pending delivery could not be created because event→delivery generation is transactional
  and fails first).
- ⚠️ `claimPendingDelivery` itself is a single conditional UPDATE (not transacted); it could not be exercised
  end-to-end on D1 due to J. Marked NOT-verified on D1.

---

## L. Fake Telegram success (D1)

- Not reached on D1 — the delivery could not be created (J blocks). The real `TelegramSender`
  was constructed against a stubbed `fetch` returning `{ok:true, result:{message_id:10001}}`, but the delivery
  row never exists on D1. Marked NOT-verified on D1.

---

## M. Fake Telegram failure (D1)

- Same as L — the 401 path (`{ok:false, error_code:401}`) could not be exercised on D1 because no delivery exists.
- The sender's secret-free error guarantee is unit-tested elsewhere in the 849 baseline; not re-verified here.

---

## N. Dedup (D1)

- ❌ Dedup for reminder events relies on `evaluateExpirationReminders` event insertion (transactional) — FAILS with
  `SQL BEGIN`.
- The `dedup_key` member `UNIQUE` constraint is present in D1, but the transacted insert rejects before it can be
  exercised.

---

## O. Disabled rule (D1)

- ❌ `insertEventsAndGenerateDeliveries` with a disabled rule — FAILS on D1 (transactional), so `delivery=0`
  semantics could not be confirmed live on D1.

---

## P. Test notification (D1)

- ❌ The test-notification event → delivery path (`test_notification` rule) uses
  `insertEventsAndGenerateDeliveries` → FAILS on D1.
- The same-nonce dedup (`UNIQUE dedup_key`) could not be exercised on D1.

---

## Q. UI / Action gate

- The main app's HTTP → Next.js Action → Repository → D1 closed loop was **not exercised** because:
  1. The Cloudflare runtime switch (resolve `getRepository()` to `createD1Repository(env.DB)`) is **not wired**;
     the module-level `createSQLiteRepository(db)` singleton remains (open 14C-1 item).
  2. Even if wired, the D1 adapter's transactional methods (H/I/J) fail on D1.
- Per the §12 allowance, a server-side integration harness was used instead and *did* call the real
  `Repository → D1` (miniflare workerd) for the non-transactional parts (B/C/D/E/G). This is the intended
  fallback and was followed.

---

## R. Data parity (SQLite vs D1)

- ✅ For non-transactional rows (domain create/read: hostname/status/expirationSource/expirationDate/
  registrationProvider) D1 and SQLite agree.
- ❌ Reminder parity via `setExpirationReminders` — FAILS on D1 (transactional). Could not complete the full
  parity matrix.
- ⚠️ **Recording**: the parity that IS reachable matches. The transactional portions remain unverified on D1.

---

## S. Cascade / delete

- ❌ `setExpirationReminders` (needed to set up the reminder) FAILS on D1, so the delete→reminder-cascade path
  could not be set up. `deleteDomain` itself is a single FK-cascade delete (not transacted) but the test setup
  could not reach it. Marked NOT-verified on D1.

---

## T. OpenNext

- ✅ Main app `next build` **succeeds** (BUILD_ID present, route table generated).
- ✅ Prototype `opennext:build` (`opennextjs-cloudflare build`) exits **0** (`Worker saved in .open-next/worker.js`).
- ⚠️ The OpenNext worker uses the prototype's own simplified schema; it does **not** exercise the main
  `createD1Repository` business loop.

---

## U. Security

- Harness/prototype use only fake secrets: token `AAH_TEST_TOKEN_ONLY`, chatId `100000001`, encryption key
  `"a".repeat(64)`.
- No production token/chatId/ENCRYPTION_KEY/SESSION_SECRET/DATABASE_URL in any added file.
- No real Telegram/Webhook/Email — senders and `fetch` are stubbed.
- ✅ No secrets leaked in the failure path plan (see M — sender error message is secret-free).

---

## V. Node regression

- ✅ `tsc --noEmit` → 0 errors.
- ✅ `eslint "src/**/*.ts"` → 0 errors / 0 warnings.
- ✅ `prettier --check "src/**/*.ts"` → clean.
- ✅ `git diff --check` → clean.
- ✅ `vitest run` → **849 / 849 passed (57 files)** — unchanged baseline (no existing expectation modified).
- ✅ `next build` → PASS.
- No source file was modified by this phase (only untracked `prototype/d1/*` + `vitest.gate.config.ts` added for the
  harness).

---

## W. Production safety

- Production DB: mtime/size/sha256/integrity/counts **unchanged** from baseline.
- No production processes (none were running; none spawned).
- Real Telegram = 0, Webhook = 0, Email = 0.
- Production Cloudflare resources: **untouched** (never invoked `wrangler deploy`/remote).

---

## X. Remaining blockers

1. **D1 ARCHITECTURE BLOCKER (primary, decisive)**
   `src/db/adapters/d1.ts` uses `this.db.transaction(async (tx) => ...)` at **5 call sites**:
   - `setExpirationReminders` (L229)
   - `createDnsSnapshot` (L257)
   - `createHttpSnapshot` (L333)
   - `createSslSnapshot` (L378)
   - `insertEventsAndGenerateDeliveries` (L466)
   drizzle-orm/d1's `transaction` emits raw `BEGIN TRANSACTION`/`COMMIT` SQL, which the Cloudflare D1 API rejects:
   > `D1_ERROR: To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.`
   This breaks the core atomicity the business layer relies on (event+delivery pipeline, reminder inserts).
   The correct D1 mechanism is `env.DB.batch([...])` (native atomic batch) — **not** SQL `BEGIN`. This was an
   unresolved 14C-1 open item ("§6 transaction 策略"), and this gate confirms the chosen drizzle `transaction`
   approach is INVALID on real D1.

2. **Cloudflare runtime switch not wired** (14C-1 open item): module-level `createSQLiteRepository(db)`
   singleton remains; no request-scoped `createD1Repository(env.DB)` wiring. Blocks `wrangler dev --local` of the
   main app (§2/Q).

3. **RDAP no-object fixture** could not be triggered (see F).

4. **Production migration strategy decision** remains out-of-scope (user-required).

---

## Y. Recommendation

- **Do NOT proceed to production D1.** This gate returns **BLOCKED (D1 Architecture)**, not PASS.
- **Priority fix**: replace the 5 `this.db.transaction(...)` calls in `src/db/adapters/d1.ts` with the D1-native
  atomic mechanism (`env.DB.batch([...])`, or a `state.storage.transaction()` wrapper) so the event→delivery
  pipeline and reminder inserts stay atomic under D1 semantics. Re-run this gate after the refactor.
- Wire the Cloudflare runtime switch (request-scoped `createD1Repository(env.DB)`, remove the module-level SQLite
  singleton from the Cloudflare path) to unblock §2/Q boot + HTTP→Next→D1 loop.
- Pick a TLD with an RDAP bootstrap but a genuinely unregistered domain to exercise the no-object path.
- Re-run 14C-2A once the above are addressed; expect the full closed loop (event=1, delivery=1, attempts=1,
  sent, error=null; second tick dedup) on D1 before any production consideration.

---

## 21/22. Final checklist

| § | Item | Result |
|---|---|---|
| 2 | D1 boot / no Node-only deps | ✅ (miniflare D1) |
| 3 | Domain flow | ✅ |
| 4 | RDAP exact | ✅ |
| 4 | RDAP parent | ✅ |
| 4 | RDAP no-object | ⚠️ fixture-not-triggered |
| 5 | Manual expiration create/read | ✅ |
| 5 | Manual refresh not overwrite | ✅ (until reminder step) |
| 5 | Reminder create | ❌ (transaction) |
| 6 | Reminder + dedup | ❌ (transaction) |
| 7 | Event generation | ❌ (transaction) |
| 8 | Delivery generation | ❌ (transaction) |
| 9 | CAS | ⚠️ not-reached-on-D1 |
| 10 | Fake Telegram success | ⚠️ not-reached-on-D1 |
| 10 | Fake Telegram failure | ⚠️ not-reached-on-D1 |
| 11 | Dedup | ❌ (transaction) |
| 12 | Disabled rule | ❌ (transaction) |
| 13 | Test notification | ❌ (transaction) |
| 14 | UI/Action gate | ❌ (runtime switch not wired) |
| 15 | Data parity | ⚠️ partial (transaction portion unverified) |
| 16 | Cascade/delete | ⚠️ setup blocked |
| 17 | OpenNext | ✅ build exit 0 (prototype) |
| 18 | Security | ✅ |
| 19 | Node regression | ✅ 849/849, tsc/eslint/prettier/git clean |
| 20 | Production zero-touch | ✅ |
| 21 | Git (migrations diff 0, no commit) | ✅ |

**Migration files modified = 0** · **Production DB modified = NO** · **Production Cloudflare resources modified = NO** ·
**Real Telegram = 0** · **Real Webhook = 0** · **Real Email = 0**

### Verdict: **BLOCKED — D1 ARCHITECTURE BLOCKER**

The D1 adapter cannot preserve transactional business semantics because drizzle-orm/d1 `db.transaction()` emits
forbidden SQL `BEGIN TRANSACTION` on Cloudflare D1. The business closed loop is NOT yet runnable on D1. Per the
phase instructions I am **STOPPING** here — **not** deploying, **not** touching production D1, **not** deciding the
production migration strategy, **not** committing/pushing/releasing.
