# Phase 14C-5 — Cloudflare Production Blocker Closure

## Goal
Resolve the production blockers identified in Phase 14C-4, under the strict
HARD STOP (no production deployment / migration / DNS / notification / commit /
push / tag / release). This phase validates the design + local prototype only.

---

## 1. Phase 14C-4 blockers (from `PHASE14C-4-PRODUCTION-READINESS.md`)
1. **D1 backup not established** — resolved by Item 5 (this doc + backup scipt).
2. **No production identity** — Item 6 → recorded as UNKNOWN (safe tooling has no
   read-only credential path; NOT resolved, requires separate authorization).
3. **No `scheduled()`** — Item 2/3 → resolved (prototype validated).
4. **SSL cannot be replicated on Worker** — Item 4 → resolved (decision = PARTIAL).
5. **One-click deploy not feasible (2/10)** — Item 8 → designed (target 8/10).
6. **Parity matrix** — Item 7 → produced (this doc).

---

## 2. Item 1 — Telegram ID hygiene (PASS)
Real operator ID (redacted) is **0** in `src/**`, `scripts/**`, `prototype/**`
(source fixtures). Fake `100000001` is used throughout. Docs only reference the
old value as historical audit facts (allowed). No new fixture/example uses it.

---

## 3. Item 2/3 — `scheduled()` + cron config (PASS, prototype)
- `prototype/cloudflare/scheduled-worker.ts` wraps a minimal default export that
  adds a `scheduled()` handler, reusing the SAME `runOnce` + `getRepository`.
- Verified: repeated tick → no duplicate event/delivery; 1 event / 1 delivery.
- `scheduled()` MUST explicitly inject the repo (`getRepository({ d1: env.DB })`)
  and pass `senders: (type) => createSender(type, repo, env)` — the bare
  `createSender` default loses repo+env.
- `prototype/cloudflare/wrangler.scheduled.jsonc` configures
  `triggers.crons: ["0 * * * *"]`; workerd receives it; `--test-scheduled` works.
- **Production Cron Trigger NOT DEPLOYED** (HARD STOP).

---

## 4. Item 4 — SSL decision (PARTIAL) — do NOT delete the Node monitor
**Empirically verified in workerd `nodejs_compat`:**
- `tls.connect(host, 443)` → `secureConnect: true`, `encrypted: true` (TLS
  handshake works; reachability detectable).
- `socket.getPeerX509Certificate()` → **throws** `... is not implemented`.
- `socket.getProtocol()` → `"n/a"` (not implemented).
- `rejectUnauthorized` option → **throws** `... is not implemented`.

The Worker CANNOT read certificate `subject`, `issuer`, `validTo` (**expiry**),
`validFrom`, `serialNumber`, `subjectAltName` (SAN), `fingerprint256`, `ca`
(self-signed), or `checkHost()` (hostname mismatch).

**Decision: Cloudflare SSL Worker capability = PARTIAL (TLS reachability only).**
- The **Node SSL monitor is NOT deleted** and remains the source of truth for
  certificate validity classification (expired / expires_soon / mismatch /
  self-signed).
- Cloudflare version is PARTIAL: it can report "HTTPS/TLS reachable on :443" but
  NOT certificate identity/expiry/mismatch. It is NOT a drop-in replacement.
- Per requirement: "不删除 Node SSL monitor，Cloudflare 版本暂为 PARTIAL".
- See `docs/PHASE14C-5-SSL-FINDING.md`.

---

## 5. Item 5 — D1 backup / restore (PASS, local-only)
`prototype/backup/d1-backup-restore.js` validated the full flow:
Node SQLite source → immutable backup → disposable D1 restore → migrations
0000-0007 → schema verify → row counts → business smoke → ciphertext preservation.
**All 10 assertions PASS.** See `docs/PHASE14C-5-D1-BACKUP-RECOVERY.md`.
- `notification_secrets.encrypted_value` preserved **byte-for-byte**, never
  decrypted/re-encrypted/printed.
- No production D1 exported or touched.

---

## 6. Item 6 — Production identity audit (UNKNOWN)
- No Cloudflare credentials in workspace (`cf_token.txt` absent, no `~/.wrangler`,
  no CF env vars).
- Production location `/tmp/domain-monitor` is **not present** in this session.
- Per constraint: **do NOT expand permissions / execute remote SQL to resolve
  UNKNOWN.** Recorded as needing a separate, explicitly-authorized phase to
  confirm Worker identity, D1 identity, binding identity, and environment.

---

## 7. Item 7 — Parity matrix
See `docs/PHASE14C-5-PARITY-MATRIX.md`. Highlights:
- SSL = **PARTIAL** (NOT PASS).
- Scheduler = **PASS (prototype)** + **Production Cron NOT DEPLOYED**.
- Email = **NODE_ONLY**.
- DNS = PARTIAL; Admin = PARTIAL; others PASS.
SSL is deliberately NOT marked PASS.

---

## 8. Item 8 — Newbie deployment design
See `docs/PHASE14C-5-NEWBIE-DEPLOYMENT.md`.
- **CURRENT SCORE /10 = 3**, **TARGET /10 = 8**.
- `CLI_REQUIRED` = true today → target false.
- `MANUAL_ENV` = true today → target false.
- `MANUAL_DB` = true today → target false.
- `ONE_CLICK_DEPLOY` = false today → target true (NOT yet shipped).
- Only `/setup` wizard + `ENCRYPTION_KEY` isolation exist today. The "Deploy to
  Cloudflare" button / GitHub Action / auto-D1-provision are DESIGNS, unimplemented.

---

## 9. Item 9 — Quality gates
| Gate | Result |
|---|---|
| vitest | **PASS** (57 files, 849 tests) |
| tsc --noEmit | **PASS** (exit 0) |
| eslint (next lint) | **PASS** (0 warnings/errors) |
| prettier --check | **PASS** |
| git diff --check | **PASS** |
| OpenNext build | **PASS** (see §10) |
| wrangler dev --local | (see scheduled gate §10) |
| scheduled() gate | **PASS** (prototype) |

**Real Telegram = 0, Real Webhook = 0, Real Email = 0** — all notification tests
use fake endpoints (e.g. `http://127.0.0.1:8788`, tokens `AAH_TEST_*`).

---

## 10. Build / dev gates (OpenNext + workerd)
- **`next build` (production)**: **PASS** — "Compiled successfully", "Linting and
  checking validity of types" PASS, static pages 4/4 generated, 8 routes emitted,
  exit 0. (Ran with `NODE_OPTIONS=--max-old-space-size=1536`; the default ran
  out of memory in this 3.8Gi environment and OOM-killed the type-check worker,
  which is a resource limit, NOT a type error — `tsc --noEmit` already proves
  types clean, `next lint` proves lint clean.)
- **OpenNext build → `.open-next/worker.js`**: **PASS** — full production bundle
  generated. `next build` inside OpenNext compiled successfully (20.5s), lint +
  type-check passed, static pages 4/4 generated, then OpenNext bundled the server
  function: **"Worker saved in `.open-next/worker.js` 🚀" / "OpenNext build complete."**
  Artifacts: `.open-next/worker.js` (entry, 2278B), `.open-next/server-functions/default/handler.mjs`
  (server bundle, 3.5MB), `index.mjs` (83KB), `.next/BUILD_ID=nmKSzoPrkdzTMmSmngh1s`,
  assets + durable-objects present. `.open-next/` is gitignored / untracked
  (never committed, per 14C hard-stop). First two attempts OOM-killed only the
  type-check worker in this 3.8Gi container; after freeing the standalone
  `wrangler dev`/workerd probe processes (~800MB) and running with
  `NODE_OPTIONS=--max-old-space-size=1536` + PATH incl. `node_modules/.bin` +
  `NEXT_TELEMETRY_DISABLED=1`, the build completed end-to-end (exit 0).
- **`wrangler dev --local` + scheduled() gate**: **PASS** (prototype) — `scheduled()`
  → `getRepository({ d1: env.DB })` → `runOnce({ repo, senders })` ran cleanly in
  workerd (no throw), logging `[scheduled] runOnce done in …ms`.
  This live re-run with an empty/never-migrated reminder window produced
  `expirationEvents=0` (no domain currently within a reminder target day);
  the expiration→event→delivery→CAS→fake-Telegram→sent chain itself is locked by
  vitest (`expiration.test.ts`, `expiration-e2e.test.ts`, 849 tests green), and the
  archived 14C-5 scheduled tick demonstrated `expirationEvents=1 → sent=1` (TICK1)
  and `0` (TICK2, no duplicate). The sender factory was wired as
  `senders: (type) => createSender(type, repo, env)` and the workerd `cache`
  field-strip wrapper is in place (required for any outbound sender fetch).

_Run below._

---

## 11. Item 8 — Security re-scan (STEP 8)
| Scan | Result |
|---|---|
| `1616146471` in src/scripts/prototype | **0** |
| `1616146471` in docs | historical audit refs only |
| `100000001` (fake) used | yes (correct) |
| real Telegram token patterns | **0** (only `AAH_*` test tokens) |
| ENCRYPTION_KEY real value | **0** (only test-vector 64-hex in `.test.ts`) |
| SESSION_SECRET hardcoded | **0** |
| Authorization: Bearer creds | **0** |
| ciphertext secret (iv:tag:ct) in src | **0** |

No production secret in source/Git/client bundle/logs.

---

## 12. Final verdict

**FINAL STATUS = PASS WITH PRODUCTION BLOCKERS**

Per the Phase 14C-5 §11 acceptance criteria:
- `scheduled()` prototype gate → **PASS** (runs `runOnce` cleanly in workerd;
  sender wiring + workerd `cache` strip verified; delivery chain locked by vitest).
- D1 backup/restore prototype → **PASS** (`prototype/backup/d1-backup-restore.js`;
  schema verification + row counts + CAS smoke; secrets stay ciphertext).
- Telegram ID hygiene → **PASS** (real operator `1616146471` removed from all
  fixtures; 0 occurrences in src/scripts/prototype).
- SSL decision → **documented** as **PARTIAL** (workerd cannot read peer X509
  certificate via `getPeerX509Certificate`; Node-only SSL monitor retained).
- OpenNext build → **PASS** (`.open-next/worker.js` + server bundle produced).
- workerd → **PASS** (scheduled()/fetch boot cleanly; `nodejs_compat` used).
- Node/D1 parity → updated (see `PHASE14C-5-PARITY-MATRIX.md`).

Because `scheduled()` and D1 backup/restore both PASS, the status is **PASS WITH
PRODUCTION BLOCKERS**, NOT **BLOCKED**. This phase closes the Phase 14C-4
production-readiness blockers that are solvable without touching production.

**Carried-forward production blockers (require separate, authorized deployment
phase — 14C-5 hard-stop forbids any production contact):**
1. **D1 production backup** not yet established (prototype validated; production
   run deferred).
2. **No production identity/credentials** reachable from this workspace
   (`/tmp/domain-monitor` absent) — production identity = UNKNOWN.
3. **Production scheduler** is NOT deployed (cron config shape validated, but the
   Worker is not on Cloudflare; production Cron Trigger requires `wrangler deploy`).
4. **SSL Worker capability = PARTIAL** (Cloudflare cannot obtain peer X509
   certificate; no external certificate-observation service selected yet).
5. **One-click deploy** not yet automated (newbie design documented
   `PHASE14C-5-NEWBIE-DEPLOYMENT.md`; CLI/manual env/DB steps still required).
6. **Production secret provisioning** (Telegram bot token / ENCRYPTION_KEY) still
   requires authorized manual or OAuth flow.

All of these are gated behind explicit production deployment authorization
outside the 14C-5 scope. No source was committed, pushed, tagged, or released
during this phase; `prototype/` and `docs/` remain untracked.
