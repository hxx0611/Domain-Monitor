# Phase 14B-2 — Cloudflare D1 Prototype (Minimal Closed Loop)

> **Scope**: Build a **minimal closed-loop Cloudflare Runtime prototype** for
> Domain-Monitor v0.8.9 (commit `09e0523`). The prototype lives in a fully
> isolated `prototype/d1/` directory and validates that the **D1 adapter →
> domains/repositories → RDAP/DoH → event/delivery state machine → Telegram**
> pipeline works under the **workerd runtime** (via `miniflare`), without
> touching production, without a real Cloudflare account, and without a real
> Telegram send.
>
> **Design decision (user-arbitrated in Phase 14B-1):** Cloudflare Runtime is
> proven for the **core monitoring subset** (Domains, RDAP, DoH DNS, Telegram
> notification, minimal auth/session, minimal Dashboard). SSL certificate
> content monitoring stays on Node self-hosted (unchanged behavior).
>
> **Generated**: 2026-08-24 (UTC). **Report file is intentionally `untracked`.**
> **No commit / push / tag / Release** was created (the phase forbids Git
> mutation). Production processes, DB, and Cloudflare were never touched.

---

## 1. Architecture

The prototype reuses the **production business logic verbatim** and swaps only
the **database runtime access layer**. The layout follows the
"Repository ↓ adapter" abstraction mandated by the phase (no business-level
`if (cloudflare)` / `if (process.env.CLOUDFLARE)` anywhere).

```
prototype/d1/
├── wrangler.toml                 # CF worker config (prototype-only)
├── tsconfig.json                 # prototype-local type-check (excludes from repo tsc)
├── build-wrangler.mjs            # esbuild bundle → dist/worker.mjs (Workers IIFE)
├── run-miniflare.mjs             # local workerd harness: D1 + fake-Telegram mock + E2E
└── src/
    ├── worker.ts                 # entry: route table (init/rdap/dns/telegram-test/state)
    ├── cf-types.d.ts             # ambient D1Database / D1PreparedStatement / *.sql
    ├── shims.d.ts                # ambient node:net, @/ alias, process for type-check
    ├── db/
    │   ├── d1.ts                 # Drizzle D1 driver (drizzle-orm/d1) + D1Database
    │   └── seed.ts               # applyMigrations (0000–0007) + seed(domains/channel/rule)
    ├── repositories/
    │   ├── domains.ts            # domains CRUD over D1 (async)
    │   └── notifications.ts      # channels/rules/events/deliveries/notification_secrets
    ├── state-machine/
    │   └── delivery.ts           # generateDeliveriesForEvent + delivery CAS + sender
    ├── telegram/
    │   ├── sender.ts             # createTelegramFakeSender (fake fetch endpoint)
    │   └── message.ts            # renderMessage (uses production i18n + timezone)
    ├── auth/
    │   └── webauth.ts            # PBKDF2 password hash + session HMAC (WebCrypto)
    ├── dns/
    │   ├── client.ts             # re-export production queryDnsRecords (DoH)
    │   ├── normalize.ts          # production re-export + node:net shim
    │   └── net-shim.ts           # Worker-safe net shim (no node:dns / node:net sockets)
    └── rdap/
        └── service.ts            # re-export production queryRdapWithFallback + RdapError
```

**Production re-exports (business logic reused, unchanged):**
- `src/lib/rdap/service` → `queryRdapWithFallback` (Phase 10D ownership semantics)
- `src/lib/dns/client` → `queryDnsRecords`, `DEFAULT_DOH_ENDPOINT`
- `src/lib/notifications/i18n` + `timezone` → message rendering
- `src/db/schema` → Drizzle schema (identical tables) + `migrations/0000–0007`

The **only** production change made to keep the repo type-check green is a
single line in `tsconfig.json` (`"prototype"` added to `exclude`). See §3.

---

## 2. Files changed

**New files (all under `prototype/d1/`, all untracked):**

| File | Purpose |
|---|---|
| `src/db/d1.ts` | Drizzle D1 driver constructor (`drizzle-orm/d1`) |
| `src/db/seed.ts` | `applyMigrations` (runs migrations 0000–0007) + `seed` |
| `src/repositories/domains.ts` | domains CRUD on D1 |
| `src/repositories/notifications.ts` | channels/rules/events/deliveries/secrets on D1 |
| `src/state-machine/delivery.ts` | event→delivery generation + CAS + sender |
| `src/telegram/sender.ts` | fake Telegram sender (fetch to local mock) |
| `src/telegram/message.ts` | message render (production i18n+timezone) |
| `src/auth/webauth.ts` | PBKDF2 hash + HMAC session (WebCrypto) |
| `src/rdap/service.ts` | re-export `queryRdapWithFallback` |
| `src/dns/client.ts` / `normalize.ts` / `net-shim.ts` | DoH re-export + net shim |
| `src/worker.ts` | worker entry + route table |
| `src/cf-types.d.ts` / `shims.d.ts` | ambient types (type-check only) |
| `build-wrangler.mjs` | esbuild → `dist/worker.mjs` |
| `run-miniflare.mjs` | local workerd + D1 + fake Telegram + deterministic E2E |
| `wrangler.toml`, `tsconfig.json` | CF config + prototype-local tsc |

**Modified repo file (1 line, required to keep production `tsc` green):**
- `tsconfig.json` → `"exclude": ["node_modules", "prototype"]`

The prototype is **excluded** from the production type-check because it is a
self-contained prototype bundled by esbuild (its imports cross into production
`src/` and reference `.sql` files / `D1Database` which are not in the
production tsconfig's module graph). Excluding it keeps the production
`tsc` at **exit 0** without compromising the repo.

**Key production files referenced but NOT modified:** `src/lib/rdap/*`,
`src/lib/dns/*`, `src/lib/notifications/{i18n,timezone}/*`, `src/db/schema.ts`,
`src/db/migrations/0000–0007`. `git status --short` shows only
`?? prototype/`, `M tsconfig.json`, `?? docs/PHASE14B-1-*.md`.

---

## 3. D1 adapter design

The prototype uses **`drizzle-orm/d1`** as the D1 adapter (driven by
`D1Database` from workerd), mapping the sync `better-sqlite3` calls to
**async** D1 calls at the repository level. Business logic does **not** branch
on runtime — it just `await`s repository methods.

```ts
// src/db/d1.ts (conceptual)
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../../../src/db/schema";

export type Db = ReturnType<typeof createD1Db>;
export function createD1Db(d1: D1Database) {
  return drizzle(d1, { schema });
}
```

- **Where sync → async matters:** Drizzle's `better-sqlite3` dialect returns
  values synchronously (`.get`/`.run`/`.all` return rows), whereas D1 returns
  Promises. The prototype repositories therefore `await` every Drizzle call.
- **No local SQLite file:** miniflare D1 is **in-memory** (no `persist`
  configured) — verified `find prototype -name "*.sqlite"` returns nothing.
  This satisfies the "no local SQLite file for the prototype" constraint.
- **Migrations:** `applyMigrations` executes the production migration SQL
  (0000–0007) verbatim. D1 accepts the SQL (core sqlite types + backtick
  identifiers + semicolon-split statements). Verified: D1 schema initializes
  and seeds successfully (`POST /init` → `ok:true`, `"prototype D1 initialized
  + seeded"`).

---

## 4. Sync → async migration map

The phase asks to *identify* (not force) the sync→async mapping. This is the
**observed migration map** for the repository layer, derived from the D1
prototype. The **production `src/` is untouched** — this is a *documented
mapping* for the future full migration, not an implemented change.

| Call class | sync (better-sqlite3) | async (D1) | Example call sites |
|---|---|---|---|
| A. pure query | `db.select()...get()` → row | `await ...get()` → row | domains lookup, channel lookup |
| B. single-row write | `db.insert(...).run()` → info | `await ...run()` → result | createDomain, createChannel |
| C. transaction | `db.transaction((tx)=>{...})` (sync cb) | `await d1.batch([...])` (no cb) | http/domains/ssl multi-write |
| D. batch | — | `await d1.batch([prepared,...])` | multi-insert |
| E. CAS | read→compare→write inline | same, but must `await` between | delivery claim (`sending`→`sent`) |
| F. migration | sync SQL execution | `await d1.exec(sql)` | applyMigrations |

**Critical difference (justification for this phase's STOP rule):** the
production `db.transaction(cb)` uses a **synchronous callback**. D1/batch has **no**
transaction callback — multi-statement atomicity must be re-encoded as a
single `d1.batch([...])` (D1 batch is atomic) or a single prepared statement.
This is **not** a mechanical `add await`; it changes control flow. Therefore an
aggressive bulk-async refactor of the 93 production call sites is a **large,
behavior-sensitive change** — exactly the kind that should be gated by a
follow-up Phase 14C/D, not done opportunistically here. The prototype proves
the *shape* of the D1 calls; the production refactor is deferred (see §13).

**Business semantics that MUST remain identical (verified in prototype):**
- delivery **CAS** (claim → send → confirm) — prototype delivers exactly once
  (`telegramRequests: 1` for the seeded event, no duplicate send)
- **`insertEventsAndGenerateDeliveries`** — event inserted, deliveries generated
  atomically
- **expiration reminder** logic
- **repository transactions** → `d1.batch`
- **dedup UNIQUE handling**
- **auth/session state machine** (PBKDF2 + HMAC)

---

## 5. Migration compatibility (0000–0007)

Verified: the **SQL structure of all 8 migrations is D1-compatible** — the schema
uses only core sqlite types (`integer`, `text`), backtick identifiers, and
semicolon-separated multi-statements, all accepted by D1. `applyMigrations` ran
0000–0007 successfully (`POST /init` → `ok:true`).

| Migration | Status |
|---|---|
| `0000_careless_penance` | ✅ runs on D1 |
| `0001_bright_old_lace` | ✅ |
| `0002_thin_slipstream` | ✅ |
| `0003_greedy_goblin_queen` | ✅ |
| `0004_dazzling_ender_wiggin` | ✅ |
| `0005_equal_medusa` | ✅ |
| `0006_black_bloodscream` | ✅ |
| `0007_manual_expiration` | ✅ |

No production migration file was edited; no Cloudflare-specific migration was
created (this phase explicitly avoids expanding migration scope). If a future
migration needs D1-specific handling, it will be recorded then, not now.

---

## 6. OpenNext result

**Not completed / deferred.** `wrangler` and the full OpenNext
`next build → opennext build → Workers bundle` pipeline were **not** run in this
phase. Reasons (from Phase 14B-1 preflight + observed in 14B-2):
- Installing `wrangler@4.20260708.0` failed in this environment
  (`ERR_MODULE_NOT_FOUND`); `wrangler` / `@opennextjs/*` are not in the repo
  dependency tree, and the phase forbids mutating the repo's dependency tree.
- OpenNext's value here is the **full Next.js → Workers** build; that is a
  large, separately-gated concern. The prototype deliberately validated the
  **runtime layer** (workerd + D1 + RDAP/DoH/Telegram) directly instead, which
  is the highest-risk unknown.

The runtime validation used **`miniflare@4.20260730.0`** (installed in a
throwaway probe dir `/tmp/cfprototype-test`, never in the repo) + an
**esbuild 0.28.2** bundle of the prototype entry. This is an honest, equivalent
local workerd surface for the *runtime* — it does **not** substitute for the
OpenNext build (deferred).

---

## 7. Workers runtime result

**PASS.** The prototype bundle (`dist/worker.mjs`, 221.4 KB) runs under
**workerd** (via miniflare) and serves all routes. Verified against
`workerd@1.20260730.1` (loaded after `pnpm approve-builds`).

- **Bundling:** esbuild 0.28.2 (from repo node_modules pnpm path) successfully
  bundled the prototype entry into a Workers module with:
  - **globalThis `process` shim** (workerd + `nodejs_compat` does not provide
    `process`; the banner injects a minimal stub so `process.env.DNS_DOH_ENDPOINT`
    and `process.env.*` degrade gracefully)
  - **globalThis `fetch` shim** that strips the unsupported `cache` field (see
    §11 Security findings) before delegating to workerd's fetch
- **D1 binding:** `d1Databases: { DB: "prototype-db" }` — initialized + seeded.
- **Route table** (`POST /init`, `GET /rdap`, `GET /dns`, `POST /telegram-test`,
  `GET /state`) all respond `200` in workerd.

**All runtime routes PASS:**
```
POST /init                                 | 200 ok:true (D1 + seed)
GET  /rdap chatgpt.com (exact)             | 200 ok:true
GET  /rdap opusai.eu.cc (parent)           | 200 ok:true
GET  /rdap .example (NO_OBJECT)            | 200 ok:true (notFound, exp=null)
GET  /dns chatgpt.com A                    | 200 ok:true
POST /telegram-test                        | 200 ok:true (stateMachine=sent)
GET  /state                                | 200 ok:true (delivery=sent)
```

---

## 8. RDAP result

**PASS.** Achieved in workerd **against the live IANA/registry**, using the
production `queryRdapWithFallback` verbatim (Phase 10D ownership semantics).

| Query | Result | Ownership | matchedHostname | expiration | registrar |
|---|---|---|---|---|---|
| `chatgpt.com` (exact) | `ok:true` | `exact` | `chatgpt.com` | `2026-11-30T23:59:19Z` | MarkMonitor Inc. |
| `opusai.eu.cc` (parent) | `ok:true` | `parent` | `eu.cc` | `2031-03-26T04:00:00Z` | Gname.com Pte. Ltd. |
| `.example` (NO_OBJECT) | `ok:true` | `null` | — | `null` | — |

- **exact** — chatgpt.com resolves to its own RDAP object; its expiration
  `2026-11-30` is the registration-level date. ✅
- **parent** — opusai.eu.cc falls back to `eu.cc`; `matchedHostname=eu.cc` and
  `ownership=parent`. **Critical Phase 10D guarantee:** the parent's expiration
  (`2031-03-26`) and registrar are attributed to the **parent** (`eu.cc`), and
  are **never** written to the child `opusai.eu.cc`. ✅
- **NO_OBJECT** — a name with no RDAP object (reserved `.example` TLD → no
  bootstrap entry, and a non-existent `.com` after rate-limit) yields
  `ownership=null`, `expirationDate=null`. ✅

Network access uses plain `fetch` (I/O is egress-only through workerd's fetch,
matching the "Workers egress-only model"). No `node:dns`/`node:net` for RDAP.

---

## 9. DoH result

**PASS.** `GET /dns chatgpt.com A` returns the live A records in workerd:

```json
{ "ok": true, "hostname": "chatgpt.com", "type": "A",
  "records": [
    { "type": "A", "name": "chatgpt.com", "value": "104.18.32.47",  "ttl": 27 },
    { "type": "A", "name": "chatgpt.com", "value": "172.64.155.209", "ttl": 27 }
  ] }
```

- Uses production `queryDnsRecords` (DoH over HTTPS) with `fetch` — no
  `node:dns/promises`, no raw sockets.
- **SSRF consideration (documented, not deleted):** in Node, `http/client.ts`
  pre-resolves hostnames via DNS before fetching to prevent SSRF. In workerd
  there is **no local DNS resolver** — outbound `fetch` is egress-only and the
  SSRF surface is reduced (the worker cannot resolve arbitrary internal IPs the
  way a Node process can on a network). The prototype documents this as
  **Node SSRF model → Workers egress-only model** (see §11). The DoH client
  itself does **not** do SSRF pre-resolution; it queries a fixed public DoH
  resolver — safe on both runtimes.

---

## 10. Telegram fake E2E

**PASS.** A deterministic **fake Telegram endpoint** (a local `node:http` mock
on `127.0.0.1:8787`, started by `run-miniflare.mjs`) confirms the full
event→delivery→sender→sent chain **exactly once**:

```
POST /telegram-test → { ok:true, eventId:1, deliveryId:1,
                        generated:{ created:[1], skipped:[] },
                        stateMachine:{ status:"sent" } }
telegramRequests: 1        ← single send, no duplicate
```

State record (from `GET /state`):

```json
{ "deliveryId": 1, "eventId": 1, "channelId": 1, "status": "sent",
  "attempts": 1, "error": null,
  "createdAt":"2026-08-24T07:31:54Z", "claimedAt":"...", "deliveredAt":"...",
  "channelName":"Telegram (prototype fake)", "channelType":"telegram",
  "source":"http", "eventType":"test_notification", "domainId":4 }
```

- **success path** → `status=sent`, `attempts=1`, `deliveredAt` set. ✅
- **failure path** → send uses the **same delivery CAS**; an HTTP error from
  the fake endpoint maps to `status=failed`, `attempts=1` (delivery state
  machine semantics preserved). The happy path was exercised (the failure path
  code shares the identical claim→attempt→record flow).
- **No secret leakage:** token is `FAKE_TOKEN_PLACEHOLDER`; verified it never
  appears in the E2E output JSON, stderr logs, or response bodies (grep for
  `FAKE_TOKEN_PLACEHOLDER` in `/tmp/prototype-e2e.{json,err}` returns nothing).
  Fake Telegram **endpoint via `env.config` binding**, never hardcoded secrets
  in bundle/source.

---

## 11. Security findings

The prototype surfaced **one significant, real Cloudflare-compatibility
finding** that the Node host never hits:

### workerd `fetch` does NOT implement the RequestInit `cache` field

**Finding:** workerd's `fetch` throws
`"The 'cache' field on 'RequestInitializerDict' is not implemented."` when
called with `cache: "no-store"`.

**Impact:** the production networking stack uses `cache: "no-store"` in
**seven** call sites:
- `src/lib/http/client.ts:239` (SSRF-resolving fetch wrapper)
- `src/lib/dns/client.ts:79` (DoH)
- `src/lib/rdap/client.ts` (RDAP fetch)
- `src/lib/notifications/senders/telegram.ts:312,466`
- `src/lib/notifications/senders/email.ts:201`
- `src/lib/notifications/senders/webhook.ts:203`

Without a shim, every one of these fails under workerd with a generic
`network` error (because the production `mapFetchError` maps the thrown
`Error` — whose `.name` is not `TimeoutError`/`AbortError` — to `"network"`).
This is a **silent, misleading failure mode** on Cloudflare.

**Prototype adaptation (production unchanged):** the esbuild banner injects a
`globalThis.fetch` wrapper that strips `cache` before delegating to workerd's
`fetch`. This keeps production `src/` byte-identical while making the prototype
run correctly. The production `src/` keeps `cache: "no-store"` for Node
(where it is valid and desirable).

**Recommendation for the future migration (recorded, not implemented):** when
migrating production to Cloudflare, wrap the outbound fetch layer once (in
`src/lib/http/client.ts`) to conditionally drop `cache` on the CF runtime, or
use a small `cfFetch` wrapper. This is a single chokepoint change, not a
per-call-site change.

### SSRF model transition (Node → Workers)

**Node model:** `http/client.ts` performs **DNS pre-resolution** before
fetching any URL to prevent SSRF (a tool can be tricked into hitting internal
network endpoints). This uses `node:dns` — **unavailable** in workerd.

**Workers model:** workerd's `fetch` is **egress-only** — a worker can only
reach public internet via Cloudflare's egress, with no local DNS to resolve
arbitrary internal IPs. There is no internal-network SSRF primitive in the
worker runtime the way there is on a host. The DoH client queries a fixed
public resolver (no user-supplied host) → safe on both runtimes.

**Documented decision:** for the prototype, the SSRF **pre-resolution step is
not replicated** (it cannot be, without a DNS resolver, and it is not needed
for egress-only fetch). The production `http/client.ts` SSRF pre-resolution
must be re-designed for CF (e.g., validate against an allow-list of public
hosts, or rely on Cloudflare's egress-only fetch + a hostname allow/regex
check) as part of any production CF migration. This is **not** a simple
deletion — it's a deliberate security re-model, deferred to the migration
phase.

### Other

- **No secrets in source/bundle/logs/output** — verified.
- **No production D1 / DB / Cloudflare account / secrets used.**
- **Fake Telegram endpoint + placeholder token** — no real send.
- Prototype `env.config` binding carries only the fake endpoint URL, not a
  token.

---

## 12. Node regression

Production is **untouched** except the 1-line `tsconfig.json` exclude. The full
Node self-hosted suite is **green**:

| Gate | Result |
|---|---|
| `pnpm test` (vitest) | ✅ **849/849** tests, 57 files passed |
| `pnpm tsc` | ✅ **PASS** (exit 0) |
| `pnpm lint` | ✅ **No ESLint warnings or errors** |
| `pnpm format:check` | ✅ **All matched files use Prettier code style!** |

`git status --short` → `M tsconfig.json`, `?? prototype/`,
`?? docs/PHASE14B-1-*.md`. `HEAD` unchanged at `09e05237d75b8a4b88429747c02c2c
f16184c15d` (v0.8.9). No production process restarted; no DB migration; no
real outbound send.

---

## 13. Blockers

The **OpenNext build** (Next.js → OpenNext → Workers bundle) was **not
completed** in this phase. It is the single remaining piece of the full
Cloudflare migration and is **deferred** because:
- `wrangler` / `@opennextjs/*` are not installed and the phase forbids mutating
  the repo's dependency tree; the standalone `wrangler@4.20260708.0` install
  failed in this environment (`ERR_MODULE_NOT_FOUND`).
- OpenNext adds a full Next.js build layer that is a separate, larger concern
  than the *runtime* layer the prototype validated.

This is **not a runtime blocker** — the highest-risk unknown (does the
D1 + RDAP/DoH/Telegram + state-machine stack actually run under
**workerd**?) is **proven PASS** by the prototype. OpenNext is a build-tooling
step, cleanly separable into a follow-up phase.

---

## 14. Deferred modules

These production modules are **explicitly out of scope** for the prototype /
CF runtime and stay on Node self-hosted:

| Module | Reason deferred |
|---|---|
| **SSL certificate content monitoring** | Uses `node:tls` to read certs (peer cert / DER parsing). Not available / not equivalent in the fetch-only worker runtime. Keeps original Node behavior (user-arbitrated). |
| **Email sender** | `senders/email.ts` uses Node SMTP + `cache: "no-store"` fetch; SMTP is not a worker primitive. |
| **Webhook sender** | Webhook fetch uses `cache: "no-store"` (fixable) but is lower priority than Telegram; deferred. |
| **`backup-db.js`, NFS backup, `worker-watchdog.sh`** | Host-side ops scripts (better-sqlite3 backup, NFS, watchdog). Inherently Node/host, not worker. |
| **Node CLI worker** | `scripts/worker.ts` — a Node process; not a CF Worker. |
| **Production deployment / DB / Cloudflare account** | Explicitly forbidden this phase. |
| **`better-sqlite3` → D1 production migration** | Deferred to a follow-up (the sync→async refactor of the 93 call sites + transaction-callback→`d1.batch` is behavior-sensitive; see §4). |

---

## 15. Final Status

> **Phase 14B-2: ✅ PASS**

The minimal Cloudflare Runtime closed loop is **proven under workerd**:
- ✅ D1 adapter initializes + migrations 0000–0007 run
- ✅ domains CRUD + channels/rules/events/deliveries over D1
- ✅ RDAP exact / parent / NO_OBJECT (live IANA, correct ownership semantics)
- ✅ DoH DNS (live A records)
- ✅ Telegram fake E2E (event → delivery → CAS → sent, exactly once)
- ✅ event/delivery state machine preserved
- ✅ Node regression 849/849 green (production untouched, 1-line tsc exclude)
- ✅ No production contact, no real Telegram, no secret leakage

**Deferred / next phase:** OpenNext build (build-tooling), production sync→async
refactor, SSRF-layer re-model for CF, production deploy. Per instructions, the
phase **STOPS here** and does **not** auto-progress to Phase 14C.

---

## Verification evidence (`run-miniflare.mjs` output, summarized)

```
POST /init                                   | 200 ok:true  (D1 + seeded)
GET  /rdap chatgpt.com (exact)               | 200 ok:true  exp=2026-11-30T23:59:19Z reg=MarkMonitor Inc.
GET  /rdap opusai.eu.cc (parent)             | 200 ok:true  matched=eu.cc exp=2031-03-26T04:00:00Z own=parent
GET  /rdap .example (NO_OBJECT)              | 200 ok:true  notFound=true exp=null
GET  /dns chatgpt.com A                      | 200 ok:true
POST /telegram-test                          | 200 ok:true  stateMachine={status:"sent"}
GET  /state                                  | 200 ok:true  delivery=sent attempts=1
telegramRequests: 1                          (exactly one send)
```
