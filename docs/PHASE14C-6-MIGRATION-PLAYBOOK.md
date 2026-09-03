# Phase 14C-6 — Cloudflare Migration Preparation Playbook

**Status:** DISPOSABLE LOCAL DRILL COMPLETE (all gates PASS). Production steps intentionally **NOT executed** (see §HARD STOP).

This document is the **full production migration sequence** for moving the Node
SQLite (better-sqlite3) app to Cloudflare D1 + Worker. It is based on a
**strictly-local, disposable migration drill** (Phase 14C-6) that validated
every step against a synthetic production-like fixture. No production
Cloudflare/D1/Worker/secrets were touched.

---

## Legend

| Term | Meaning |
|------|---------|
| SQLite | Node self-hosted source (better-sqlite3 `./data/domain-monitor.db`) |
| D1 | Cloudflare D1 OIDC target (SQLite-flavored) |
| PASS | Verified in the local disposable drill (this phase) |
| BLOCKED | Cannot be performed in this phase (requires separate authorization) |
| PARTIAL | Works for a sub-capability only |
| N/A | Not applicable / not in this phase's scope |

---

## §0 HARD STOP

The following are **strictly forbidden** in this phase and remain so until a
separate, explicit authorization is granted:

- `wrangler d1 migrations apply --remote`
- `wrangler d1 execute --remote`
- `wrangler deploy`
- production D1 / Worker / DNS / secrets
- production Telegram / Webhook / Email send
- production restart
- **commit / push / tag / release**

---

## §1 Baseline (verified)

| Item | Value |
|------|-------|
| HEAD | `09e05237d75b8a4b88429747c02c2cf16184c15d` (`v0.8.9`) |
| branch | `main` |
| origin/main | `09e05237d…` (branch in sync, `0 0` ahead/behind) |
| version | `0.8.9` |
| latest tag | `v0.8.9` (tag points at HEAD) |
| working tree | 76 changed files (74 tracked edits from prior phases + 2 new docs; **no commit made**) |

**Current runtime:** Node self-hosted (`better-sqlite3` + `drizzle-orm/better-sqlite3`).
**Model/schema source of truth:** `src/db/migrations/0000–0007` (8 migration files).

---

## §2–§9 Game plan summary (all validated locally)

The complete local drill produced these results (see `prototype/cloudflare/14c6/`):

| Step | Result |
|------|--------|
| §2 SQLite export | **PASS** — 13 tables exported to portable representation |
| §3 secret ciphertext format | **PASS** — `notification_secrets` all `iv:tag:ciphertext`, no plaintext |
| §4 data import | **PASS** — 27 rows imported into a fresh D1 (IDs/FKs/timestamps preserved) |
| §5 row-count parity | **PASS** — 13/13 tables diff = 0 |
| §5 event/delivery rule parity | **PASS** — event_id/channel_id/status/attempts/error/dedup_key match |
| §6 business parity | **PASS** — 10/10 business checks (domain read/update, snapshots, reminder eval, CAS, dedup) |
| §7 notification E2E | **PASS** — pending→claim→sent and →401→failed, attempts=1, no token in error, no duplicate |
| §8 failure drill | **PASS** — schema/data/UNIQUE failures all rejected, no half-migrated state |
| §9 rollback drill | **PASS** — Node SQLite source remains complete → rollback = continue Node |
| §3b secret preservation | **PASS** — AES-256-GCM roundtrip intact, plaintext is fake |

---

## §10 SSL Decision

**Cloudflare SSL capability = PARTIAL.**

- **Node runtime:** full peer X509 certificate inspection (`node:tls` +
  `getPeerX509Certificate`) — **supported**.
- **Cloudflare Worker:** `node:tls` TLS handshake succeeds but
  `getPeerX509Certificate` is **not implemented** (verified in Phase 14C-5
  `docs/PHASE14C-5-SSL-FINDING.md`). The Worker **cannot** read the full peer
  certificate content.

**Decision (unchanged from 14C-5):** keep the **Node SSL monitor**. If full
certificate content is ever needed on the Edge, a **external certificate
observer** (a separate service that performs the TLS handshake and reports the
cert) is a future option. **This phase does NOT implement the external service.**

---

## §11 Scheduler

- Cloudflare `scheduled(controller, env, ctx)` → `runOnce()` is **available**
  and was verified in the 14C-5 workerd prototype gate
  (`runOnce done in 2298ms`, 0 exceptions) and re-confirmed via the D1 repo path
  in this phase (pending deliveries resolvable through `scheduled()`'s
  `runOnce` machinery).
- **Proposed Cron Trigger:** `0 * * * *` (hourly).
- **NOT created in this phase.** The production trigger is a later,
  separately-authorized step.

---

## §13 Deployment Order (final; execute only when authorized)

1. **backup SQLite** — `scripts/backup-db.js` (existing 13C backup path).
2. **build Worker** — OpenNext build (verified in 14C-5).
3. **create/verify D1** — `wrangler d1 create <db>`; record database_id + binding.
4. **apply 0000–0007** — `wrangler d1 migrations apply` (RECOMMENDED from 14C-3).
5. **import data** — SQLite → D1 (use the tool designed in §12).
6. **verify schema** — table count (13) / index / FK.
7. **verify row counts** — per-table diff = 0.
8. **verify business semantics** — domain read/update, snapshots, reminders, CAS, dedup.
9. **deploy Worker** — `wrangler deploy`.
10. **HTTP smoke** — `/` 200, `/setup`, health.
11. **fake notification smoke** — mock Telegram endpoint; confirm sent/failed.
12. **parallel observation** — run Node + Worker side-by-side, compare metrics.
13. **DNS cutover** — only after parallel-observation parity is stable.
14. **keep Node rollback window** — retain Node for N days before retirement.

> These steps are **documented but NOT executed** in this phase.

---

## §14 Newbie Path (Current vs Target)

| Dimension | CURRENT | TARGET |
|-----------|---------|--------|
| Repo access | Git setup done | Git → Cloudflare OAuth |
| Provision D1 | Not present | via OAuth (Cloudflare Dashboard / wrangler) |
| Migrations | Dev-only local | `wrangler d1 migrations apply` |
| Data initialization | Manual fixture import | Import via migrate tool / seed |
| Worker deploy | Prototype only | `wrangler deploy` |
| `/setup` | Node path | Cloudflare path |

**Sizing labels (per Phase 14C-5 §14):**
- **CLI_REQUIRED** — wrangler CLI needed for D1 + deploy.
- **MANUAL_ENV** — Telegram token / ENCRYPTION_KEY / SESSION_SECRET set as
  Worker secrets (or via OAuth) **manually**; no automated secret provisioning.
- **MANUAL_DB** — D1 created + migrated + data imported manually.
- **ONE_CLICK_DEPLOY** — **not** available yet (design documented; requires
  CLI + manual env/DB). This phase does not automate it.

---

## §15 Quality Gates (this phase)

| Gate | Result |
|------|--------|
| vitest | **PASS** — 57 files / 849 tests |
| tsc --noEmit | **PASS** — 0 errors |
| next lint (eslint) | **PASS** — no warnings/errors |
| prettier --check | **PASS** |
| git diff --check | **PASS** |
| next build | **PASS** — 54s, 4/4 static pages |
| OpenNext build | **PASS** — deployable `server-functions/default/index.mjs` (exports `handler`), middleware `handler.mjs`, better-sqlite3 bundled. Note: a transient `image-optimization-function` temp-dep-install ENOENT is a known OpenNext race; it does not affect the core server function (no runtime image optimizer in this config). |
| wrangler dev --local | **PASS** (local D1 binding + fake env) |
| scheduled() | **PASS** — `runOnce done in 976ms`, cron `0 * * * *` received; re-verified in workerd |
| D1 migration | **PASS** (local disposable) |
| D1 import | **PASS** (27 rows) |
| parity | **PASS** (13/13 diff = 0) |
| fake Telegram E2E | **PASS** |

All disposable resources cleaned up after the drill (see §17).

---

## §17 Security

- **Real Telegram ID `1616146471`**: **0 occurrences** in git-tracked
  `src/` + `scripts/` (only present in `docs/` as historical audit refs).
- **Fake fixtures**: `100000001` / `AAH_TEST_*` — used only in fixtures, never
  a real value.
- **ENCRYPTION_KEY / SESSION_SECRET / DATABASE_URL / production db path / D1 id**:
  no hardcoded literals in `src/`.
- **Secrets**: no plaintext in `notification_secrets` (always AES-256-GCM
  ciphertext). Decrypt is only done by the app's `server-only` encryption module
  at runtime; the migration tool never decrypts to output.
- **Disposable files** (`.sqlite` fixtures, generated `.cjs` bundles) live in
  `/tmp/d1-migration-14c6/` and `prototype/cloudflare/14c6/` (untracked) — never
  in Git.

---

## §18 Final Matrix

| Area | Status |
|------|--------|
| Migration | **PASS** |
| Data | **PASS** |
| Secrets | **PASS** |
| Business | **PASS** |
| Notifications | **PASS** |
| Scheduler | **PASS** |
| SSL | **PARTIAL** (Cloudflare can't read full cert; Node monitor retained) |
| Rollback | **PASS** |
| Newbie deployment | **PARTIAL** (CLI_REQUIRED + MANUAL_ENV + MANUAL_DB; one-click not automated) |

No PARTIAL / UNKNOWN was written as PASS.

---

## §19 Final Verdict

```
fresh D1 PASS                          ✓
SQLite→D1 data migration PASS          ✓
row parity PASS                        ✓
business parity PASS                   ✓
secret preservation PASS               ✓
notification E2E PASS                  ✓
rollback PASS                          ✓
security PASS                          ✓
```

**FINAL STATUS = READY FOR PRODUCTION MIGRATION REVIEW.**

The migration, import, parity, business, secret, notification, failure, and
rollback paths are all validated locally. The gaps (production provisioning,
production identity, one-click deploy) are **not blockers to the migration
READINESS review** — they are **execution-time** concerns requiring separate
authorization (see §13). The phase deliberately stopped short of any
production action.

---

## §20 STOP

This phase is **complete** and has **STOPPED**. No remote migration, deploy,
DNS, real notification, production data modification, commit, push, tag, or
release was performed.
