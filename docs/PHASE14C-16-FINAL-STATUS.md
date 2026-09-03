# Phase 14C-16 — Production Worker + Secret Init — FINAL STATUS

Date: 2026-08-30
Result: **PARTIAL — Worker created & secrets initialized, runtime smoke BLOCKED by account-level workers.dev failure**

## Account / Environment
- Account ID: `b9dd2cfed5f3bbf704ec62466fe761d6`
- Account workers.dev subdomain: `1439343758`
- D1 `domain-monitor` database_id: `4437f46a-632d-4dfa-aba0-4c5bc41fa64d` (region APAC)
- Zone `snooze.eu.cc` id: `399717b0e94a897342e00d204f3e616e`
- Worker name: `domain-monitor`
- Deployed Version ID: `c8c06cfc-90ba-434d-9b38-f25bd6d7329c`

## Step Results
- STEP 1 prod config: PASS — `wrangler.prod.jsonc` (name=domain-monitor, D1 DB binding, ASSETS, nodejs_compat, observability, NO crons)
- STEP 2 source: PASS — `custom-worker.ts` (fetch from `.open-next/worker.js` + scheduled→runOnce via D1)
- STEP 3 bundle safety: PASS (verified via `--tsconfig tsconfig.cf.json`) — `new Database`=0, `node:sqlite`=0, `DATABASE_URL`=0, `require('better-sqlite3')`=0 (150 `better-sqlite3` matches all pnpm path strings, not runtime)
- STEP 4 secrets: PASS — ENCRYPTION_KEY + SESSION_SECRET injected (never printed/committed)
- STEP 5 deploy: PASS — version `c8c06cfc`, **no Cron trigger created** (`schedules=[]`)
- STEP 6 worker exists: PASS — script GET 200, bindings DB(`4437f46a...`)+ASSETS, compat_date `2026-08-29`, secrets present (ENCRYPTION_KEY+SESSION_SECRET names only)
- STEP 7 D1 safety: PASS — migrations=8, business tables=13, domains=3, notification_events=7, notification_deliveries=7, notification_rules=5, notification_secrets=1 (all `changed_db:false`; matches 14C-9B baseline)
- STEP 8 runtime smoke: **BLOCKED** — account-level workers.dev failure: ALL workers (domain-monitor + pre-existing domain-check/kui/mydoh/odd-bonus) return HTTP 500 / `error code: 1101` on workers.dev
- STEP 9 security audit: not fully verifiable (Step 8 blocked), but deploy-side leakage confirmed 0
- STEP 10 git: custom-worker.ts / wrangler.prod.jsonc / open-next.config.ts untracked; next.config.ts modified
- STEP 11 final status: **BLOCKED** (Step 8/9 incomplete)

## BLOCKED on account-level workers.dev fault
- Decisive evidence: brand-new minimal plain worker (`dm-diag`, `dm-diag2`, no nodejs_compat, no assets, trivial handler) ALSO returned 1101.
- Pre-existing workers domain-check / kui / mydoh / odd-bonus ALSO return 500/1101 on workers.dev.
- `cf-ray: a3311924cdc31f9f-SIN` confirms Cloudflare edge actually executed (not cache). `subdomain.enabled: true`.
- Not compat_date (2025-03-01 also 1101), not code/config, not worker-specific. **This is a Cloudflare account / Workers runtime issue on the `1439343758` workers.dev subdomain.**
- Recommended: escalate to Cloudflare / confirm account Workers Runtime health or use a custom-domain route for the runtime smoke.

## Reusable commands
- Deploy (with CF tsconfig for bundle safety): `wrangler deploy --config wrangler.prod.jsonc --tsconfig tsconfig.cf.json`
- D1 read-only check: `wrangler d1 execute domain-monitor --remote --config wrangler.prod.jsonc --command "SELECT ..."`
- Secrets list (names only): `curl .../workers/scripts/domain-monitor/secrets`

## Next phase (deferred)
- UI Telegram Token re-entry + Notification Test (explicitly not allowed in 14C-16).
- Re-verify runtime smoke once account workers.dev fault is resolved (also consider custom-domain route).


---

## 14C-17 — Runtime Smoke Recovery (2026-08-30)

### FINAL STATUS: **BLOCKED — CLOUDFLARE WORKERS.DEV RUNTIME**

### Step results
- STEP 1 preserve worker: PASS — domain-monitor exists, active version `c8c06cfc-90ba-434d-9b38-f25bd6d7329c` (number 15, 100%), no rollback/delete.
- STEP 2 workers.dev smoke: `/`, `/login`, `/setup` all **HTTP 500 / `error code: 1101`**; CF-Ray `a33209...-SIN`; category = `1101 Worker threw exception`. No business mutation.
- STEP 3 control test: brand-new minimal plain worker (`dm-ctrl-17`, no nodejs_compat/assets, compat_date `2024-09-23`) → first probe `1042`, stable after → **HTTP 500 / `1101`** (3/3 samples). Pre-existing `kui` also 500/1101.
  → **Workers.dev / runtime / account-level issue** confirmed. NOT domain-monitor-specific.
- STEP 4 bundle diagnosis: NOT NEEDED (control worker also 1101 rules out domain-monitor bundle/runtime specificity).
- STEP 5 custom domain: NOT attempted. Recorded `WORKERS_DEV_RUNTIME = BLOCKED`. No DNS/route change.
- STEP 6 D1 integrity: PASS — migrations=8, domains=3, notification_events=7, notification_deliveries=7, notification_rules=5, notification_secrets=1, business tables=13. `changed_db:false` (read-only).
- STEP 7 verdict: **BLOCKED — CLOUDFLARE WORKERS.DEV RUNTIME**.

### Evidence
- Every worker on account subdomain `1439343758` (domain-monitor + pre-existing domain-check/kui/mydoh/odd-bonus + brand-new minimal plain worker) returns HTTP 500 / `error code: 1101` on workers.dev.
- `cf-ray ...-SIN` = Cloudflare edge executed (not cache). `subdomain.enabled: true`.
- Not compat_date (2024-09-23/2025-03-01/2026-08-29 all 1101), not code, not config, not worker-specific.
- → **Cloudflare account Workers Runtime / workers.dev subdomain-layer fault.** Escalate to Cloudflare or route via custom domain (outside this phase).

### Post-conditions
- domain-monitor Worker retained (do NOT delete). version `c8c06cfc` intact.
- ENCRYPTION_KEY / SESSION_SECRET / D1 / Cron / DNS / Telegram / other Workers: untouched.
- Control worker `dm-ctrl-17` deleted (self-created for control test).


---

## 14C-19 — Authorized Custom Domain Runtime Smoke (2026-08-30)

### FINAL STATUS: **BLOCKED — CUSTOM DOMAIN PROVISIONING**

### Step results
- STEP 1 pre-create final check: PASS — domain-monitor active, version `c8c06cfc`(15) intact; `dm-smoke.snooze.eu.cc` NOT bound to any worker; no hostname conflict; `dc.snooze.eu.cc` untouched.
- STEP 2 create custom domain: **BLOCKED** — every custom-domain write endpoint returns **405 / code 10405 "Method not allowed for this authentication scheme"**:
  - `POST /accounts/{acc}/workers/scripts/domain-monitor/domains` → 405
  - `POST /accounts/{acc}/workers/domains` → 405
  - `POST /accounts/{acc}/workers/services/domain-monitor/environments/production/domains` → 405
  - (GET on these endpoints WORKS: `workers/domains` returns 3 existing domains — dc.snooze.eu.cc / kui.cncn.qzz.io / api.cncn.qzz.io — confirming reads work but write/POST is denied.)
- STEP 3+ not reached (custom domain could not be provisioned).
- `/user/tokens/verify` → `Invalid API Token` (code 1000). No wrangler OAuth store; only `cf_d1_token.txt`. Authentication entirely via the scoped API token.

### Root cause
The `cf_d1_token.txt` API token is **read-capable** on account resources (zones, worker scripts, worker domains, D1) and **can upload worker scripts** (wrangler deploy succeeded in 14C-16), but **does NOT have the permission/scheme required to create Workers Custom Domains** — every `workers/domains`/`workers/services` POST returns 405. wrangler has no standalone custom-domain command (it requires `wrangler deploy` with a `custom_domain` route, which is forbidden this phase).

### Resolution needed (NOT performed — outside boundary)
Provide a token with **Workers Custom Domains write** permission (`workers_domains:edit` / `Zone.Workers`), OR authorize `wrangler deploy` with a `custom_domain = true` route for `dm-smoke.snooze.eu.cc`.

### Post-conditions
- domain-monitor Worker still `domain-monitor` / version `c8c06cfc`(15) intact. NOT deleted, NOT modified.
- No custom domain created. No DNS/route/cron change. No secret/value touched. No D1 mutation. No commit/push.
- Control/other workers (domain-check/kui/mydoh/odd-bonus-eae5) untouched.


---

## 14C-20 — Resolve Custom Domain Write Permission (2026-08-30)

### FINAL STATUS: **PASS — PERMISSION REQUIREMENT IDENTIFIED**

### Token capability matrix (cf_d1_token.txt, no token value output)
| Capability | Status |
|---|---|
| Workers Scripts Read | ✅ GET scripts/settings 200 |
| Workers Scripts Edit | ✅ (wrangler deploy succeeded in 14C-16) |
| Workers Custom Domains Read | ✅ GET workers/domains → 3 domains |
| Workers Custom Domains Edit | ⛔ POST → 405 / 10405 |
| Zone Read | ✅ GET zone success |
| Workers Routes / Zone Workers | ⛔ GET routes → 10000 auth error (read denied) |
| Auth scheme (`/user/tokens/verify`) | ⚠️ Invalid API Token (1000) |

### Auth scheme interpretation
- GET on custom-domain endpoints works; POST uniformly returns **405 / 10405 "Method not allowed for this authentication scheme"**.
- This is a **scoped API token**: read-capable on account resources (zones/scripts/domains/D1) and able to `PUT` worker scripts (wrangler deploy), but **NOT granted the custom-domain write permission** nor Worker-routes permission.
- `/user/tokens/verify` returning Invalid further indicates a non-standard / limited token type; all auth rides on `cf_d1_token.txt` (no wrangler OAuth store found).

### STEP 3 — wrangler custom_domain support
- wrangler **4.125.0**.
- config-schema.json defines `custom_domain` (boolean) on `ZoneIdRoute`, `ZoneNameRoute`, `CustomDomainRoute`; `routes` = array of `Route`.
- So `custom_domain = true` route IS supported by wrangler config. **But creating one requires `wrangler deploy`** (forbidden this phase).

### STEP 4 — Minimum permission requirement (Do NOT expand to Account Admin / unrelated)
- **Required minimal permission: `Workers Custom Domains Edit`** (`workers_domains:edit`).
- If Cloudflare's model for the custom hostname also requires `Zone.Workers`/route permission, that too — but `workers_domains:edit` is the primary gap.
- Current token: keep unchanged.

### STEP 5 — Two paths (only analyze, do NOT execute B this phase)
- **Path A (recommended)**: Supply a token with `Workers Custom Domains Edit` → next phase `POST /accounts/{acc}/workers/domains` to create `dm-smoke.snooze.eu.cc`.
- **Path B**: Authorize `wrangler deploy` + `custom_domain = true`. ⚠️ Expected to fail with current token too, because wrangler routes custom-domain creation through the same `workers/domains` POST which is 405-denied. Only viable if token actually has custom-domain write (unproven). Not executed this phase.

### STEP 6 — Final safety gate (all unchanged)
Worker version `c8c06cfc` / D1 / DNS / custom domains / secrets / Cron / other workers / Git: all unchanged. No custom domain created. No mutation. No token value output.


---

## 14C-21 — Custom Domain Permission & Runtime Smoke (2026-08-30)

### FINAL STATUS: **BLOCKED — CUSTOM DOMAIN PERMISSION**

### Preflight (STEP 1) — no custom-domain-edit credential available
- **No new credential found**: workspace only contains `cf_d1_token.txt` (`cfat_` prefix, mtime 2026-08-27) — the SAME scoped token confirmed in 14C-19/20 to lack Custom Domain write permission.
- Env vars: no Cloudflare-related creds. No new `.txt/.env/token` files.
- **Re-verified** `POST /accounts/{acc}/workers/domains` → **405 / 10405 "Method not allowed for this authentication scheme"** (custom domain write still denied).
- So STEP 1 (permission preflight) fails → **STOP**.

### Post-conditions (all unchanged)
- domain-monitor Worker version `c8c06cfc-90ba-434d-9b38-f25bd6d7329c` intact; 0 custom domains.
- D1 notifications baseline untouched (not re-queried since no mutation possible).
- No custom domain created, no DNS/route/cron change, no secret touched, no deploy, no other worker touched, no Telegram/Webhook/Email, no Git change.
- No token value output.

### Next action required (deferred to a later approved phase)
Supply a credential with **`Workers Custom Domains Edit`** permission (e.g. a token with `workers_domains:edit`), or authorize a `wrangler deploy` carrying a `custom_domain = true` route. Only then can `dm-smoke.snooze.eu.cc` be created and the runtime smoke executed.
