# PHASE 14C-15 — Production Secret Initialization (Preflight)

**Status: STOPPED — PREFLIGHT BLOCKED**
**Date:** 2026-08-29
**Verdict:** **BLOCKED — Production Worker `domain-monitor` does not exist; cannot
`wrangler secret put` without deploying, which is HARD-STOP forbidden.**

---

## 0. Summary

This phase was to initialize a **new** `ENCRYPTION_KEY` (and `SESSION_SECRET`) for
the Cloudflare production Worker, following Phase 14C-14 recommended Strategy A.
The intent was secret-only setup **before** Worker deploy.

**BLOCKER found during STEP 1 verification:** the target production Worker has
**never been created**. `wrangler secret put` only operates on an **existing**
Worker, and the only way to create it is `wrangler deploy` — which is explicitly
forbidden by this phase's HARD STOP. Therefore the secret-initialization steps
(STEP 4/5) cannot be executed under the current constraints.

---

## STEP 1 — Production identity (verified, metadata only)

| Item | Value |
|------|-------|
| Cloudflare account | `b9dd2cfed5f3bbf704ec62466fe761d6` (associated `1439343758@qq.com`'s Account) |
| Production D1 name | `domain-monitor` |
| Production D1 database_id | `4437f46a-632d-4dfa-aba0-4c5bc41fa64d` |
| Production zone | `snooze.eu.cc` (id `399717b0e94a897342e00d204f3e616e`, active) |
| **Worker target name** | **`domain-monitor` → NOT FOUND** (no such Worker exists) |
| Other Workers present | `domain-check`, `kui`, `mydoh`, `odd-bonus-eae5` (all unrelated, pre-existing) |

`wrangler whoami` (with the D1 API token) confirms correct account. `wrangler secret
list --name domain-monitor` (and `domain-monitor-main`, `domain-monitor-main-cf`)
returns:

```
✘ Worker "domain-monitor" not found.
  If this is a new Worker, run `wrangler deploy` first to create it.
```

**No credentials were printed** — only metadata and a boolean existence check.

---

## STEP 2 — Secret requirements (from current code)

| Requirement | Value |
|-------------|-------|
| `ENCRYPTION_KEY` | 64-hex (32 bytes) used verbatim as AES-256 key; production missing → **throws**; `notifications/encryption.ts` |
| `SESSION_SECRET` | 64-hex (`/^[0-9a-f]{64}$/`), env preferred, fallback to DB `admin_settings.session_secret` (rotated on recovery); `auth/admin-db.ts` |
| Telegram token storage path | D1 `notification_secrets` (channel_id=1, key=`token`), AES-256-GCM encrypted via `ENCRYPTION_KEY` |
| `saveTelegramChannelAction` depends on `ENCRYPTION_KEY`? | **YES** — it encodes/reads the secret through `getEncryptionKey()` |
| `SESSION_SECRET` needed to access UI/login? | **YES** — `getSessionSecret()` signs/verifies the session cookie (`dm_admin_session`) |

---

## STEP 3–5 — Execution blocked

### Step 3 (generate `ENCRYPTION_KEY`) — NOT EXECUTED

**Deliberately skipped**, because:

- Generating a 64-hex master key **only makes sense if it can be immediately and
  securely stored** on the target Worker.
- That storage requires `wrangler secret put` (STEP 4), which **requires the Worker
  to already exist**.
- Since the Worker does not exist, the key would have to be held in memory beyond
  this session (lost) or persisted to disk (forbidden by HARD STOP). Holding a
  transiently-created, un-placeable master secret is a **security anti-pattern**.

Therefore the key was **not generated** until the deploy/secret injection can be
done as one atomic, authorized step.

### Step 4 (`wrangler secret put ENCRYPTION_KEY`) — NOT EXECUTED

- Target Worker `domain-monitor` does **not exist** → `secret put` fails with
  `Worker not found`.
- No valid target Worker exists. Nothing written.

### Step 5 (`SESSION_SECRET`) — NOT EXECUTED

Same blocker as Step 4. No Worker to attach the secret to.

---

## STEP 6 — Secret presence verification

| Secret | Presence |
|--------|----------|
| `ENCRYPTION_KEY` | **NOT CONFIGURED** (no Worker to hold it) |
| `SESSION_SECRET` | **NOT CONFIGURED** (no Worker to hold it) |

Verified by `wrangler secret list --name domain-monitor` → Worker not found.

---

## STEP 7 — D1 safety check (read-only)

**Performed during STEP 1/14C-14D, no modification.**

| Item | Status |
|------|--------|
| `notification_secrets` rows | **1** (channel_id=1, key=`token`) |
| old ciphertext | **RETAINED** (untouched) |
| row count | unchanged |
| D1 migrations | **8** (`d1_migrations`) |
| business row counts | unchanged (domains=3, dns_records=30, events=7, deliveries=7, rules=5, etc.) |

**No D1 data modified.**

---

## STEP 8 — Secret continuity status

| Item | Value |
|------|-------|
| OLD ENCRYPTION_KEY | UNAVAILABLE |
| NEW ENCRYPTION_KEY | **NOT CONFIGURED** (blocked by missing Worker) |
| OLD CIPHERTEXT | RETAINED |
| REINITIALIZATION | PENDING (needs Worker + key + UI re-entry) |

This phase does **not** claim the old ciphertext is decryptable.

---

## STEP 9 — Final security scan

| Vector | Count |
|--------|-------|
| secret leakage | **0** |
| Git change | **0** (no commit/push/tag/release) |
| D1 mutation | **0** |
| Worker deploy | **0** |
| DNS change | **0** |
| Telegram send | **0** |

No value was printed, logged, shell-historied, committed, or written to disk.

---

## Final Status

**FINAL STATUS = BLOCKED — PREFLIGHT: PRODUCTION WORKER MISSING**
**(reported as DESIGN/BLOCKED; secret initialization not performed)**

### Root cause

`wrangler secret put` requires an **already-created** Worker. The production
Worker `domain-monitor` has never been deployed (only unrelated Workers
`domain-check`/`kui`/`mydoh`/`odd-bonus-eae5` exist). Creating the Worker requires
`wrangler deploy`, which is **forbidden** by this phase's HARD STOP ("不 deploy
Worker"). Hence secrets cannot be initialized ahead of deploy in the current
architecture.

### Recommended correct ordering (to be authorized as one Production Deployment step)

1. **Create the production wrangler config** — `wrangler.jsonc` pointed at
   `name=domain-monitor`, production D1 binding (`4437f46a-…`), `ASSETS → .open-next/assets`,
   migration dir, Cron `0 * * * *`. (Currently `wrangler.jsonc` is prototype-only.)
2. **`wrangler deploy --secrets-file <tmp>`** — this both **creates** the Worker and
   **injects** `ENCRYPTION_KEY` + `SESSION_SECRET` in one atomic, authorized step.
   The secrets file is written to a transient tmp file, piped, then deleted; the
   value never appears in `argv`, shell history, Git, or logs.
3. **UI re-entry of the Telegram token** (`saveTelegramChannelAction` → encrypt with
   new key → upsert D1) — Strategy A.
4. Read-only D1 verification → Test Notification → Cron → DNS cutover.

**This phase performs none of the above** and generates no key, to avoid holding a
place-holder master secret. The key must be generated **at deploy time** (step 2),
inside the same authorized action that creates the Worker.

---

*This document contains no secret values, no complete ciphertext, no tokens, and no
encryption key content. No production resource was modified.*
