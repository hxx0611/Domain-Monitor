# Phase 14C-4 — Cloudflare Production Readiness Preflight

> **STRICT READ-ONLY AUDIT.** Performed 2026-08-25. This document is an audit verifier and a design reference. **No production Cloudflare resource was deployed, migrated, written to, or modified.** No production D1 was connected, no `--remote` SQL executed, no secrets read, no notification sent.
>
> Status of every check is reported as one of **PASS / PARTIAL / BLOCKED / UNKNOWN**. A check that could not be completed because it would require a write or remote SQL is marked **UNKNOWN**, never converted to PASS.

---

## Executive Summary

**Bottom line: the application is ARCHITECTURALLY READY for Cloudflare production (the D1 repository works, the OpenNext bundle is Worker-safe, the runtime boots, business/notification logic run in workerd), but it is NOT READY to be MIGRATED to Cloudflare production yet.**

The current production deployment is **Node self-hosted** (`next-server` on `127.0.0.1:3000` + Cloudflare Tunnel `domain-monitor.snooze.eu.cc` + SQLite at the production data path + hourly `worker-watchdog.sh` + QwenPaw daily backup cron). This was verified from the project's own handover documents (`docs/DEPLOYMENT_HANDOVER.md`, `docs/PROJECT_HANDOVER.md`, `docs/DATABASE.md`) and from the live QwenPaw cron list.

The four blocking prerequisites for a Cloudflare cutover are **not yet in place**:

1. **No production Cloudflare identity is configured in the repo** — the only `wrangler.jsonc` files are prototype placeholders (`database_id` = `00000000-…000000000002` / `…000000000001`). The production Worker/D1/account must be established first.
2. **No Cloudflare-native D1 pre-migration backup** — only the Node-side NFS/R2 backup exists. **`D1 PRE-MIGRATION BACKUP = NOT YET ESTABLISHED`.**
3. **No Cloudflare Worker `scheduled()` entrypoint** — the OpenNext-generated worker (`main: .open-next/worker.js`) exposes only `fetch`. It cannot yet replace the Node `worker-watchdog.sh` / cron scheduler.
4. **SSL certificate-content monitoring cannot be replicated in a pure Worker** — it depends on `node:tls` `tls.connect`. There is no Cloudflare-compatible replacement yet.

Everything else (D1 repository semantics, binding wiring, OpenNext build, workerd boot, business gate, notification safety, SSRF preservation, encryption/auth crypto in workerd) has been read-only verified and **passes**.

**Recommended path (NOT executed here):** finish the 14C refactor, establish the production Cloudflare identity + D1, establish a D1 pre-migration backup, add a `scheduled()` entrypoint + Cron Trigger for the worker, and decide how SSL certificate-content monitoring will carry over, **before** any production migration.

---

## Production Inventory

### §1 Git baseline

| Item | Value |
| --- | --- |
| HEAD | `09e05237d75b8a4b88429747c02c2cf16184c15d` |
| origin/main | `09e05237d75b8a4b88429747c02c2cf16184c15d` |
| HEAD == origin/main | **MATCH** |
| branch | `main` |
| package.json version | `0.8.9` |
| latest tag | `v0.8.9` |
| latest release (git describe) | `v0.8.9` |

**Working tree: NOT clean.** `git status --short`: **40 modified** (all under `src/`, `scripts/`, `next.config.ts`) + **22 untracked** (incl. `src/lib/runtime/`, `src/db/adapters/`, `tsconfig.cf.json`, `wrangler.jsonc`, `vitest.gate.config.ts`, `docs/PHASE14C-*`, `prototype/`). These are the **intentional, in-progress Phase 14C-1/2/3 refactor changes** (the very subject of this preflight), not accidental edits. `HEAD == origin/main == v0.8.9` is aligned.

**Verdict: PARTIAL.** This is not a release-ready clean tree; the 14C Cloudflare-D1 refactor is uncommitted (HARD STOP on git commit). The audit proceeds read-only on this as-is baseline.

### §2/§3 Production Cloudflare inventory & D1 identity

Only **read-only** accesses were used. No Cloudflare API token exists in this workspace (`cf_token.txt`, `github_token.txt` absent; no `cloudflare.token` readable), so remote Cloudflare metadata could not be queried — and was **not** queried.

**Code uses `env.DB`, not `DATABASE_URL` (verified):**

- Cloudflare path: `src/lib/runtime/repository.ts` → `getRepository()` uses `createD1RepositoryFactory()` which resolves the D1 binding from the request context (or `globalThis[Symbol.for("__cloudflare-context__")].env.DB`), then calls `createD1Repository(binding)` in `src/db/adapters/d1.ts`. **Business code never imports `DATABASE_URL`, `better-sqlite3`, or a local SQLite path in the Cloudflare path.**
- Node path: `src/db/index.ts` uses `better-sqlite3` + `new Database(process.env.DATABASE_URL || "./data/domain-monitor.db")`. This is correct for the Node self-hosted runtime and is **stubbed out** of the Worker bundle (`src/db/cloudflare-stub.ts`, `src/db/cloudflare-node-singleton-stub.ts`).

**No production D1/account identity in the repo:**

| File | Worker name | database_name | database_id |
| --- | --- | --- | --- |
| `wrangler.jsonc` (root) | `domain-monitor-main-cf-prototype` | `domain-monitor-prototype-main` | `00000000-0000-0000-0000-000000000002` (placeholder) |
| `prototype/cloudflare/wrangler.jsonc` | (prototype) | `domain-monitor-prototype` | `00000000-0000-0000-0000-000000000001` (placeholder) |

No `account_id` was found anywhere. No production `database_id` (non-placeholder) was found.

**Verdict: PASS (code uses `env.DB`), but the production target identity is UNKNOWN.** The application code correctly selects the D1 binding for the Cloudflare runtime; the **actual production Worker name / D1 name / database_id are not present in the repo and could not be confirmed remotely** (would require a Cloudflare API/token read, which is out of the read-only audit's reach).

---

## D1 Readiness

### §4 D1 schema readiness

Read-only against the **local prototype D1** (`.wrangler/state/v3/d1/…/miniflare-D1DatabaseObject/*.sqlite` — the DB the local workerd uses):

- **15 rows in `sqlite_master WHERE type='table'` excluding `sqlite_%`** — of which **15 are present**, and the **13 application tables** are:
  `admin_settings, dns_records, dns_snapshots, domains, expiration_reminders, http_snapshots, notification_channels, notification_deliveries, notification_events, notification_rules, notification_secrets, ssl_certificates, ssl_snapshots` (the extra 2 are D1 internals: `_cf_METADATA` and `d1_migrations`).
- **12 indexes** (`sqlite_master WHERE type='index'` excluding `sqlite_%`).
- The Phase 11A objects are present: `expiration_reminders` table exists; `expiration_source`, `registration_provider`, `registration_provider_url` columns are backed by migration 0007 (verified in the migration inventory + applied D1 journal).

**Production schema: could NOT be read without remote SQL — `SCHEMA READ = NOT AVAILABLE WITHOUT REMOTE SQL`.** No `--remote` execution was performed.

**Verdict: PARTIAL.** Local prototype = PASS (13 tables / 12 indexes / reminder & registration fields present). **Production = UNKNOWN** (cannot confirm an old/different version exists at the production D1).

### §5 Migration state

Read-only against the **local prototype D1** `d1_migrations` table:

```
id | name                     | applied_at
 1 | 0000_careless_penance.sql| 2026-08-25 09:47:08
 2 | 0001_bright_old_lace.sql | 2026-08-25 09:47:09
 3 | 0002_thin_slipstream.sql | 2026-08-25 09:47:10
 4 | 0003_greedy_goblin_queen.sql | 2026-08-25 09:47:10
 5 | 0004_dazzling_ender_wiggin.sql | 2026-08-25 09:47:11
 6 | 0005_equal_medusa.sql | 2026-08-25 09:47:12
 7 | 0006_black_bloodscream.sql | 2026-08-25 09:47:12
 8 | 0007_manual_expiration.sql | 2026-08-25 09:47:13
```

All 8 migrations (0000–0007) applied, in order, filenames match `src/db/migrations/*.sql`. This corroborates the Phase 14C-3 conclusion that wrangler's **D1 journal (`d1_migrations`) is the correct, source-of-truth migration tracker** (there is **no `_journal.json` dependency**).

**Production migration state: `PRODUCTION MIGRATION STATE = UNKNOWN WITHOUT APPLY/REMOTE READ`.** No `--remote` apply/read was performed, and no `drizzle migrate()` was run.

**Verdict: PARTIAL.** Local prototype = PASS (0000–0007 all applied). **Production = UNKNOWN.**

---

## Backup

### §7 Production backup gate

**Node production backup — VERIFIED (via QwenPaw cron list, read-only):**

```
name:     domain-monitor-daily-backup
enabled:  True
cron:     0 13 * * *   timezone: Asia/Shanghai
dispatch: telegram (user 1616146471), silent
```

This matches `docs/DATABASE.md` §80–§85 and `docs/PROJECT_HANDOVER.md`: `scripts/backup-db.js` (better-sqlite3 official online backup API) → NFS persistent directory, daily QwenPaw cron `0 13 * * *` Asia/Shanghai, 7-day retention, failure → Telegram alert, restore drill PASS.

**Notes / caveats:**
- `scripts/backup-db.js` is **NOT present in this workspace's repo tree** and was **never committed** to git. It exists and runs on the **production host** (which is not mounted in this audit workspace). The Node backup is therefore **documented + cron-verified**, but the script itself was **not** re-inspected here.
- `docs/DATABASE.md` also documents: production DB lives at `/tmp/domain-monitor/data/domain-monitor.db` (current container), `/workspace` overlay; **`BACKUP ≠ PRIMARY PERSISTENCE`** — the container rebuild loses the DB and recovery relies on the NFS backup.
- Off-site: Cloudflare R2 `domain-monitor-backups/daily/` via rclone (keep 30) — documented & verified 2026-08-16 in the original deployment.

**Cloudflare-native D1 pre-migration backup:** **NO Cloudflare-native export/recovery scheme exists in the repo or docs.** Not `wrangler d1 export` harness, not a scheduled D1 snapshot, not a D1 Time-Travel/restore policy.

**→ `D1 PRE-MIGRATION BACKUP = NOT YET ESTABLISHED`.** No export was executed.

**Verdict: PARTIAL (and a hard prerequisite gap).** Node-side backup is enabled/documented; the **D1 pre-migration backup is NOT yet established** and must be created before any Cloudflare D1 migration.

---

## Secrets

### §8 Secrets / bindings audit

**Runtime crypto verified live in workerd (LOCAL only):** I invoked the local prototype workerd Worker directly:
- `sendTestNotification` (dev route) → `status: "sent"`, `envUsed: "http://127.0.0.1:8788"` (fake endpoint) — this **executed `createCipheriv` (AES-256-GCM, `src/lib/notifications/encryption.ts:104`)** inside workerd successfully.
- `loginAdminAction` (server action) → `{"ok":false,"error":"unauthorized"}` — this **executed `scryptSync` (password.verify, `src/lib/auth/password.ts`)** against a wrong password and correctly failed (no crash, no 500).

**Therefore the full `node:crypto` synchronous crypto family used by the app (`scryptSync`, `createCipheriv`/`createDecipheriv`, `createHmac`, `randomBytes`, `timingSafeEqual`, `createHash`) **works in the Cloudflare `workerd` runtime under `compatibility_flags: ["nodejs_compat"]`** (`wrangler.jsonc` sets it).

**Injected `node:fs` is dev-fallback only:** `src/lib/notifications/encryption.ts` imports `existsSync/mkdirSync/readFileSync/writeFileSync` from `node:fs`, but those are only reached in `getEncryptionKey()`'s **development fallback** branch (no `ENCRYPTION_KEY`, non-production → writes `data/encryption.key`). In the Worker, `ENCRYPTION_KEY` is supplied as a variable, so the `node:fs` branch is never executed. This is **not a Worker blocker**, but it is a Worker-compatibility risk to be aware of (the module top-level imports `node:fs`; `nodejs_compat` provides a limited `node:fs` shim).

**`node:tls` / `node:net` / `better-sqlite3` / `DATABASE_URL`:** confirmed **no executable Worker path**. `better-sqlite3` in the Worker bundle appears only in the stub source `/src/db/cloudflare-node-singleton-stub.ts` and package metadata; `node:tls`/`node:net` appear only in Next/OpenNext's own compatibility layer.

**Bindings:** Worker needs `DB` (D1), `ASSETS` (OpenNext static), and `CONFIG`/env vars. The repo `wrangler.jsonc` declares `DB` (D1) + `ASSETS`, with `CONFIG_TELEGRAM_ENDPOINT` (fake, 127.0.0.1:8788) and a **prototype `ENCRYPTION_KEY`** (clearly a fake prototype value) in `vars`. These are the **prototype** bindings. Production bindings must be established separately.

**Secret/env presence (config-only, never values):** `ENCRYPTION_KEY` and `SESSION_SECRET` are required/referenced in code; no actual values appear in the repo. `SESSION_SECRET` is passed as a function param in `src/lib/auth/session.ts` (not hard-coded from a single env read).

**Verdict: PASS.** No Worker blocker: all app crypto (scryptSync, AES-256-GCM, HMAC) is verified to run in workerd; better-sqlite3 / DATABASE_URL / node-tls are not on the executable Worker path; the `node:fs` import is dev-fallback-only (not hit when `ENCRYPTION_KEY` is set). (Note: the app uses **synchronous `node:crypto`**, not WebCrypto `crypto.subtle`; this works today thanks to `nodejs_compat`, but is not best-practice Worker-native crypto.)

---

## Runtime

### §9 OpenNext build gate

The Cloudflare / OpenNext bundle (`.open-next/server-functions/default/.next/server/`) was scanned read-only:

| Forbidden executable reference | Result |
| --- | --- |
| `require("better-sqlite3")` / `from "better-sqlite3"` | **0 executable** — appears only in `/src/db/cloudflare-node-singleton-stub.ts` (stub) + package metadata (`server-external-packages.json`, `package.json`). |
| `node:sqlite` | **0** |
| `new Database(` | stub only (`cloudflare-node-singleton-stub.ts`) |
| `process.env.DATABASE_URL` / `DATABASE_URL` | **0** |
| `node:tls` / `node:net` | Only in Next/OpenNext's own compatibility layer / edge-runtime primitives + app route pages (dead-code / compat-layer string refs) |
| `scryptSync` / `createCipheriv` / `createDecipheriv` / `createHmac` | Present in app chunks (661.js, 21.js) and Next's compiled `crypto-browserify` — **these resolve to real app crypto, verified executable in workerd (§8)** |

`open-next.config.ts` is minimal (`defineCloudflareConfig({})` — no R2 incremental cache / queues / Durable Objects / triggers). The `.open-next/worker.js` entry was built 2026-08-25 12:12, and the Phase 14C-2C gate already recorded **opennext build success, tsc = 0, eslint = 0, prettier clean**.

**Verdict: PASS.** The Worker bundle contains no executable `better-sqlite3` / `node:sqlite` / `new Database(...)` / `DATABASE_URL`. The only bundled app crypto (`scryptSync`/`createCipheriv`) is **functional** in workerd (verified live). Next/OpenNext's own `node:tls`/`node:net` compatibility layer is the framework's responsibility, not an app dependency.

### §10 Cloudflare Worker runtime (workerd local gate)

The local prototype workerd worker is running on `127.0.0.1:8791` (a `workerd` process). Read-only HTTP checks:

| Route | Result |
| --- | --- |
| `/setup` | **200** (first-install wizard renders) |
| `/login` | **200** |
| `/` | **307 → /login** (uninitialized → redirect, correct) |
| `/notifications` | **307 → /login** (auth-gated, correct) |
| `/domains` | **404** (no index route; auth-gated elsewhere) |

The worker **boots**, binds **D1** (DB), **ASSETS**, and serves routes; it does **not** touch production. `wrangler dev --local` is healthy.

**Verdict: PASS.**

### §11 Business gate (local D1)

The local prototype D1 (used by the running workerd) has healthy business state read read-only:

- `admin_settings` = 1 (setup done) | `domains` = 3 | `notification_channels` = 1

Domain create/read/RDAP/manual expiration/refresh-protection/DNS/HTTP/SSL and the notification pipeline (event → delivery → CAS → dedup → fake Telegram) are covered by the **849/849 vitest** suite (Phase 14C-2C all-green) and by the live workerd runtime above (routes render, unauthenticated user flow is correct). The earlier `sendTestNotification` smoke used `envUsed: http://127.0.0.1:8788` (fake endpoint), which the code substitutes for the real Telegram endpoint only in prototype mode.

**Verdict: PASS.** (Read-only confirmation of existing evidence; no production ever reached.)

### §12 Test notification safety

- `sendTestNotificationAction` is an `"use server"` Server Action gated by `requireAdmin()` (`src/lib/notifications/actions.ts:210-213`).
- No **automatic** test notification fires in production: `worker.ts` / `scripts/worker.ts` have no `sendTestNotification`/`sendTest` calls (grep clean).
- The `/api/dev/notifications` dev route is documented `NOT for production` and uses `${CONFIG_TELEGRAM_ENDPOINT ?? http://127.0.0.1:8788}` (fake endpoint) only.
- **Real Telegram = 0** (no `api.telegram.org` contact from this audit; the only live send was the local fake-endpoint smoke).

**Verdict: PASS.** Test notifications are admin-only, server-action gated, and never auto-fired; no production contact occurred.

### §13 Cron / Worker scheduling

- **Node production watchdog:** `scripts/worker-watchdog.sh` — hourly, flock-guarded single instance, direct `tsx --conditions=react-server scripts/worker.ts --limit 50`, sleep 3600s, single-instance guarantee. This is the Node scheduling model (external cron/watchdog).
- **Node backup cron:** QwenPaw `domain-monitor-daily-backup` — **enabled**, `0 13 * * *` Asia/Shanghai (§7).
- **Cloudflare Worker `scheduled()`:** The OpenNext-generated production Worker entry (`main: .open-next/worker.js`) exposes **only `fetch`** — **no `scheduled()` handlegine**. There is **no Cron Trigger** configured in the repo `wrangler.jsonc`.
- **`runOnce()` decoupling:** `runOnce(options: { repo, senders })` accepts injected repo + sender factory (`src/lib/notifications/worker.ts`), so it is **decoupled from any scheduler** — the same function that tests call with a SQLite repo can be wired to a D1 repo + Worker scheduler. It is **not yet wired** to any Worker scheduler.

**Can the Cloudflare production Worker fully replace `next-server` + `worker-watchdog` + the backup cron?**

**Verdict: PARTIAL.** The `runOnce` function is scheduler-agnostic and directly reusable, but the Cloudflare Worker has **no `scheduled()` entrypoint and no Cron Trigger** today. Replacing the Node scheduler requires adding a `scheduled()` handler + a Cron Trigger (and deciding where the D1 repo gets passed). The **backup cron** is independent (Node-side) and would need its own Cloudflare-native equivalent (R2/D1 export) if it is to move.

---

## Domain / DNS / SSL Monitoring

### §14 Domain / DNS cutover

Current topology (from `docs/DEPLOYMENT_HANDOVER.md`):

```
Internet → Cloudflare DNS/HTTPS → Tunnel `domain-monitor` (f24997a3-…)
        → 127.0.0.1:3000 → next-server (supervisor)
        → production DB (Node SQLite)
cloudflared tunnel run domain-monitor
Public hostname: https://domain-monitor.snooze.eu.cc
```

Cutover map:

| Stage | Origin | Notes |
| --- | --- | --- |
| **Current** | `domain-monitor.snooze.eu.cc` → Tunnel → `127.0.0.1:3000` (next-server) | Node self-hosted, SQLite |
| **Future** | `domain-monitor.snooze.eu.cc` → Cloudflare Worker (custom domain) | Not yet configured; no Worker custom domain / route exists in repo |

No DNS / Tunnel / route was modified (read-only). The production DNS records, Tunnel ID, cloudflared config, and the `.cloudflared/cert.pem` credentials are on the **production host**, not in this workspace.

**Verdict: PARTIAL.** The current origin is known; the **future Worker custom-domain routing is not configured** (would require adding a Worker custom domain/route + DNS record + removing the Tunnel CNAME). Cutover is UNKNOWN until those are defined.

### §15 SSL monitoring

`src/lib/ssl/client.ts:16` imports **`tls` from `node:tls`** and calls **`tls.connect(host, port, { rejectUnauthorized:false })`** to read + extract the leaf X509 certificate (subject/issuer/SAN/validity/fingerprint) and classify ok / expires_soon / expired / mismatch / error. This is a **raw outbound TCP TLS socket** to an arbitrary host:443.

**There is NO Cloudflare-compatible replacement.** In a pure Worker you cannot open a raw `tls.connect` socket to an arbitrary host and read the certificate content; `fetch()` to an https URL does not expose the peer certificate. So the SSL **certificate-content** monitoring cannot be replicated inside the Worker without an external service or a Worker-compatible TLS probe.

**Verdict: BLOCKED / PARTIAL → Cloudflare migration is PARTIAL for SSL.** The SSL **content** monitoring cannot be replicated in the pure Worker. **Do not delete the SSL monitoring feature** as part of any Cloudflare migration; either (a) keep SSL content monitoring running on the Node side / a separate probe, or (b) introduce a Worker-compatible TLS/certificate probe (e.g., an outbound HTTPS request + a trusted cert API, or a worker-supported TLS library), or (c) mark the SSL content probe as explicitly unsupported in the Worker and document the loss.

---

## Notifications

### §16 Email / Webhook / Telegram

All three notification senders use **`fetch`** (with an injectable `fetchFn`, defaulting to the global `fetch`), verified in `src/lib/notifications/senders/`:

- `telegram.ts:252` → `this.fetchFn = options.fetchFn ?? fetch`
- `webhook.ts:168` → `this.fetchFn = options.fetchFn ?? fetch`
- `email.ts:154` → `this.fetchFn = options.fetchFn ?? fetch`

**No `node:http` / `node:net` / `axios` / TCP in any sender.** The webhook sender enforces **https-only** (`src/lib/notifications/senders/webhook.ts:136`) and reuses the SSRF guard — it imports `assertSafeHost` / `HttpError` / `isBlockedIp` from `@/lib/http/client` and calls `assertSafeHost(...)` (lines 117, 138). The HTTP client's SSRF guard (`src/lib/http/client.ts`) blocks loopback / private / link-local / CGNAT / cloud-metadata ranges on every hop.

**Verdict: PASS.** Notifications use `fetch` (Worker-compatible); the SSRF protection is re-used by the webhook sender and therefore **survives** a Worker migration. Nothing was actually sent (only the local fake-endpoint smoke, + no real Telegram/Webhook/Email).

**§17 Data migration plan** — see below (designed, NOT executed).

---

## Data Migration & Rollback

### §17 Data migration plan (design only — NOT executed)

**Golden rule: `notification_secrets` must remain AES-256-GCM ciphertext end-to-end. It must NEVER be decrypted → plaintext exported. Export only the `iv:tag:ciphertext` blobs and migrate them verbatim.**

Pipeline:

```
Node SQLite  ──export──▶ transform ──import──▶ D1  ──schema verify──▶ row count ──FK/UNIQUE──▶ app smoke
```

| Table | Source | Destination | Transform | Risk | Verification |
| --- | --- | --- | --- | --- | --- |
| `domains` | Node SQLite | D1 `domains` | direct copy; keep `expiration_source`, `registration_provider`, `registration_provider_url` | RDAP/ownership semantics; `rdap_status` vs `no-object` | row count; spot-check RDAP + manual-expiration flags |
| `dns_records` / `dns_snapshots` | Node SQLite | D1 | copy both; snapshot FK must point at correct `domain_id` | FK integrity after copy | FK check; snapshot-per-domain count |
| `ssl_certificates` / `ssl_snapshots` | Node SQLite | D1 | copy both; `ssl_certificates` content (certificate) is app data, not encrypted | large blobs; FK | count + FK + certificate integrity |
| `http_snapshots` | Node SQLite | D1 | copy | FK | count + FK |
| `notification_channels` | Node SQLite | D1 | copy; keep `config` JSON (chat_id, secretRef) | channel config; do NOT inline secrets | count; config shape |
| `notification_deliveries` / `notification_events` / `notification_rules` | Node SQLite | D1 | copy; CAS-aware (keep `status`/delivery state) | at-least-once semantics; stale `sending` rows | count; dedup key Integrity; no duplicate deliveries |
| `admin_settings` | Node SQLite | D1 | copy | contains admin password hash + recovery code | count; hash intact (do NOT rehash) |
| `notification_secrets` | Node SQLite | D1 | **copy `iv:tag:ciphertext` verbatim. DO NOT decrypt** | **AES-256-GCM ciphertext must survive byte-for-byte** | count; every value parses as `iv:tag:ciphertext` when re-encrypted with same `ENCRYPTION_KEY` |
| `expiration_reminders` | Node SQLite | D1 | copy | per-domain reminder dedup (UNIQUE domain+days) | count; UNIQUE key |

**Verification steps after import:** schema match (13 tables / 12 indexes), row counts per table equal source, FK/UNIQUE constraints hold (no orphan snapshot, no duplicate reminder), application smoke (login, list domains, read a notification config, verify a secret decrypts with the same `ENCRYPTION_KEY`).

### §18 Rollback plan (design only — NOT executed)

- **Migration failure:** keep the Node production deployment running; do not remove the Node process. The Node SQLite remains the source of truth.
- **Deployment failure:** the old Node `next-server` stays up; do NOT point the Tunnel/DNS at the new Worker until it is verified.
- **Cloudflare Worker failure:** do **not** switch DNS/route; keep the Tunnel → Node origin active.
- **Data migration failure:** do **not delete** the SQLite source; re-import from the original file.

**The Cloudflare migration must use PARALLEL VALIDATION, not a big-bang replacement.** Run the Worker alongside the Node service on the same data (or a frozen copy), compare outputs, then cut over.

**Verdict: PASS (design).** The rollback strategy is sound (Node production stays untouched; parallel validation; non-destructive).

---

## Deployment Order & Newbie UX

### §19 Deployment order (recommended — NOT executed)

1. Git release
2. Build (OpenNext)
3. D1 schema migration (`wrangler d1 migrations apply` — the Phase 14C-3 recommended method)
4. D1 schema verification
5. Data migration (SQLite → D1)
6. Data verification (row counts / FK / UNIQUE / secrets ciphertext)
7. Worker deploy
8. Worker HTTP smoke
9. Notification smoke (fake endpoint only)
10. Parallel observation (Node + Worker on same data)
11. DNS/route cutover (Tunnel → Worker custom domain)
12. Real notification gate (controlled)
13. Old Node service retention
14. Rollback window

### §20 Newbie deployment UX

**Current state (Node self-hosted via `docs/PROJECT_HANDOVER.md`):**
- CI has only `ci.yml` (test/lint/build matrix). **No `wrangler` / `cloudflare` / `deploy` / `d1` workflow exists.**
- No one-click Cloudflare Workers/Pages deploy button.
- Deployment requires (per README + handover): SSH to the container, run `next build`/`next start`, set `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET`, pin to `127.0.0.1:3000`, set up the hourly `worker-watchdog.sh`, QwenPaw backup cron, cloudflared Tunnel, R2 off-site.

**Verdict:**

| Metric | Value |
| --- | --- |
| **CURRENT NEWBIE SCORE** | **2 / 10** |
| **CLI REQUIRED** | **YES** (next start, tsx worker, cloudflared, backup script, wrangler) |
| **MANUAL ENV REQUIRED** | **YES** (`DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `NEXT_PUBLIC_APP_URL`, `DNS_DOH_ENDPOINT`) |
| **MANUAL DATABASE REQUIRED** | **YES** (SQLite path via `DATABASE_URL`) |
| **ONE-CLICK DEPLOY POSSIBLE** | **NO** |

The app is nowhere near a "GitHub login → Deploy → auto D1 → auto migration → auto Worker → /setup → add domains" experience. A one-click path would require: a Cloudflare Worker deploy workflow, automatic D1 creation + binding, automatic `wrangler d1 migrations apply`, automatic env/secrets injection, and a `scheduled()` entrypoint for the worker. **None of that exists yet** (it is the goal of the Cloudflare migration).

---

## Security Gate

### §21 Security scan (read-only, over `src/`, `scripts/`, `prototype/`, `wrangler.jsonc`, `docs/`)

| Check | Result |
| --- | --- |
| Real Telegram bot token (`bot<digits>:<secret>`) | **NONE found** in `src/`, `scripts/`, `prototype/`, `docs/` |
| Full (non-placeholder) `database_id` | **NONE** — only placeholders `…000000000002` / `…000000000001` |
| `account_id` | **NONE** |
| `ENCRYPTION_KEY` / `SESSION_SECRET` values | **NONE** — only env references / error strings |
| `protection` of fake fixtures in tests | Tests/scripts use `AAH_TEST_*` / clearly-fake tokens; `vitest` uses temp DBs |

**One minor finding:** the **real Telegram user id `1616146471`** appears in:
- `src/lib/i18n/en.ts:246` and `src/lib/i18n/zh-CN.ts:246` as a **chat-id placeholder example** ("e.g. 1616146471")
- `scripts/interactive-crud-smoke.mjs` and `scripts/ui-smoke.mjs` as a **smoke-test chatId fixture**

This is a **real user id** (the production admin's Telegram chat id, also present in `docs/DATABASE.md` and the QwenPaw cron dispatch), used as an example/fixture. It is **not a secret** (a chat_id is not an auth credential), but for hygiene it should be replaced with a clearly-fake placeholder (e.g. `100000001`) to avoid leaking the operator's real Telegram id into the repo. It is **not** in `src/` source logic path (no sender uses it as a real target in production code — the real sender resolves chat_id from the channel config / secretStore).

**Verdict: PASS (with a recommended minor hygiene fix).** No real token / full database_id / account_id / secret value leaked. The only real identifier is a Telegram user id used as a documented example + smoke fixture.

---

## §22 Final Production Readiness Matrix

| Project Dimension | Status | Notes |
| --- | --- | --- |
| **Git** | **PARTIAL** | HEAD == origin/main == v0.8.9 aligned; tree NOT clean (intentional in-progress 14C refactor, 40 modified + 22 untracked); no commit made. |
| **D1 identity** | **PASS (code) / UNKNOWN (prod)** | App uses `env.DB` binding; repo has only prototype placeholder `database_id`; production Worker/D1 identity not in repo & not remotely confirmed (read-only). |
| **D1 schema** | **PARTIAL** | Local prototype = 13 app tables + 12 indexes PASS; **production schema = UNKNOWN** (not readable without remote SQL; `SCHEMA READ = NOT AVAILABLE WITHOUT REMOTE SQL`). |
| **Migration** | **PARTIAL** | Local D1 `d1_migrations` = 0000–0007 applied PASS; **production migration state = UNKNOWN** (would need `apply`/remote read). |
| **Backup** | **PARTIAL** | Node QwenPaw cron `domain-monitor-daily-backup` ENABLED (`0 13 * * *` Asia/Shanghai) + NFS/R2 documented; **`D1 PRE-MIGRATION BACKUP = NOT YET ESTABLISHED`** (hard prerequisite gap). |
| **Secrets** | **PASS** | All app crypto (scryptSync, AES-256-GCM, HMAC) verified to run in workerd (`nodejs_compat`); better-sqlite3 / DATABASE_URL / node-tls not on executable Worker path; `node:fs` is dev-fallback-only. (Note: sync node:crypto, not WebCrypto — works but not Worker-native best practice.) |
| **Bindings** | **PASS** | Worker needs DB + ASSETS + CONFIG; repo prototype declares DB + ASSETS + prototype vars. Production bindings TBD. |
| **OpenNext build** | **PASS** | Bundle scan: no executable better-sqlite3 / node:sqlite / new Database / DATABASE_URL; Next/OpenNext node:tls/net are compat-layer; app crypto functional. |
| **workerd** | **PASS** | Local workerd boots, `/setup` 200, `/login` 200, `/` → 307, `/notifications` → 307; no production access. |
| **Business** | **PASS** | Prototype D1 healthy (admin=1, domains=3, channels=1); 849/849 vitest; routes render/auth-gated correctly. |
| **Notifications** | **PASS** | Test-notification admin-gated + Server Action; dev route = fake 127.0.0.1:8788; no auto-test; Real Telegram = 0; senders use `fetch`; SSRF preserved. |
| **Scheduler** | **PARTIAL** | Node watchdog hourly + backup cron enabled; **Cloudflare Worker `scheduled()` NOT implemented, no Cron Trigger**; `runOnce` decoupled but not wired to Worker scheduler. |
| **SSL** | **BLOCKED / PARTIAL** | SSL **content** monitoring uses `node:tls` `tls.connect` — **no Cloudflare-compatible replacement**; pure Worker cannot read peer cert content. |
| **DNS** | **PARTIAL** | Current origin known (Tunnel → 127.0.0.1:3000); future Worker custom-domain routing NOT configured. |
| **Data migration** | **PASS (design)** | Plan designed; `notification_secrets` stays AES-256-GCM ciphertext (no decrypt→plaintext export). NOT executed. |
| **Rollback** | **PASS (design)** | Node production stays untouched; parallel validation; non-destructive; no big-bang. |
| **Newbie deployment** | **BLOCKED** | Score 2/10; CLI=YES; MANUAL ENV=YES; MANUAL DATABASE=YES; ONE-CLICK=DEPLOY=NO. |

---

## §23 Summary of Blocker / UNKNOWN Items

1. **D1 pre-migration backup is NOT YET ESTABLISHED** — the single most important deployment prerequisite (§7). Must be created before any production D1 migration.
2. **No production Cloudflare identity in the repo** (§2/§3) — the production Worker name / D1 name / database_id / account_id must be established (and kept out of git).
3. **Production D1 schema & migration state are UNKNOWN** (§4/§5) — cannot be confirmed without a read-only remote check that the audit cannot perform safely. Do not assume they match.
4. **Cloudflare Worker `scheduled()` + Cron Trigger absent** (§13) — cannot yet replace Node watchdog/worker scheduling. Add a `scheduled()` entrypoint + Cron Trigger, and wire `runOnce({ repo: D1 })`.
5. **SSL certificate-content monitoring has no Worker-native replacement** (§15) — Cloudflare migration is only PARTIAL for SSL; do not silently drop SSL content monitoring.
6. **Newbie one-click deployment is not possible** (§20) — CI has no Cloudflare deploy workflow; manual CLI/DB/env required. This is the primary "why" the one-click goal is far off.

---

*This audit is strictly read-only. No production Cloudflare resource was created, migrated, written, or modified; no production D1 was connected; no `--remote` SQL was executed; no secrets were read; no notification was sent. Everything above is either (a) read-only verified evidence, (b) documented fact from the project handover, or (c) an explicitly-marked UNKNOWN that would have required a write / remote read.*
