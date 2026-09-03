# PHASE 14C-11A — ENCRYPTION_KEY Continuity Investigation

**Status: COMPLETED (investigation only)**
**Date:** 2026-08-29
**Scope:** KEY PROVENANCE / CONTINUITY 调查 — only read-only analysis. No D1/DB writes, no secret provisioning, no deploy.

---

## 0. Executive Summary

Production D1 (`domain-monitor`) was populated in Phase 14C-9B, carrying one
`notification_secrets` ciphertext (channel 1, key `token`), byte-for-byte
identical to the 2026-08-25 source backup. The investigation set out to answer:
**what ENCRYPTION_KEY encrypted that ciphertext, and can continuity be proven?**

**Verdict: KEY CONTINUITY = UNPROVEN (CASE B).**

- The ciphertext **cannot** have been encrypted with `admin_settings.encryption_key`
  — that column is `NULL` in every historical backup.
- The ciphertext **was** encrypted by the `notifications/encryption.ts` key path,
  which reads **only** `process.env.ENCRYPTION_KEY` (production REQUIRED) or the
  dev file fallback.
- Therefore the key is **operator-provided and operator-held**, stored in the
  production `/tmp/domain-monitor/.env` (mode 600), which is **not accessible**
  from this workspace.
- A key source **exists** and is documented, but **cannot be proven** (from the
  codespace) to be the exact key that produced the current ciphertext, because
  the value lives outside the reachable environment.

**The HARD STOP is upheld: no random key was generated, no ciphertext was
re-encrypted, no secret was written. Nothing was changed.**

---

## 1. Evidence Sources

| # | Source | Type | What it establishes |
|---|--------|------|---------------------|
| E1 | `src/lib/notifications/encryption.ts` | source | The AES-256-GCM key resolution logic for notification secrets |
| E2 | `src/lib/notifications/secrets.ts` | source | `setChannelSecret`/`getChannelSecret` use `notifications/encryption.ts` key, NOT DB |
| E3 | `src/db/adapters/d1.ts` (lines ~751, 770, 813) | source | D1 repository secret path uses `notifications/encryption.ts` `getEncryptionKey()` |
| E4 | `src/db/adapters/sqlite.ts` (lines ~210, 236) | source | SQLite path delegates to `secretsRepo` (also `notifications/encryption.ts`) |
| E5 | `src/db/repository.ts` (line ~168) | source | Documented: admin `getEncryptionKey` is a SEPARATE path |
| E6 | `src/lib/auth/admin-db.ts` | source | admin `getEncryptionKey()` — env wins, else DB row; different consumer (admin), not notification secrets |
| E7 | `6× docs/` (DEPLOYMENT_HANDOVER, DISASTER_RECOVERY, CHATGPT_HANDOVER, DATABASE, NOTIFICATIONS, PHASE13A, PHASE14C-10) | docs | Production key lives in `/tmp/domain-monitor/.env`, operator-held, 64-hex, REQUIRED |
| E8 | `domain-monitor-backups/*.db` (7 files) | DB | `admin_settings.encryption_key` = NULL in all 7 backups; ciphertext identical across all |
| E9 | Git history (v0.8.0 `9816178`) | git | `encryption.ts`/`secrets.ts` introduced as env-based; no secret value ever committed |
| E10 | `.env.example` | config | Documents `ENCRYPTION_KEY="<64 hex chars>"` REQUIRED in production |
| E11 | Full-workspace search | env | No real `ENCRYPTION_KEY` value found in any reachable file (only fakes/keys in tests, prototype fake) |

---

## 2. Database Provenance

**Backups inspected (read-only):** `domain-monitor-backups/` — 7 files,
2026-08-20T09:48 through 2026-08-25T06:50.

| Field | Result |
|-------|--------|
| `admin_settings` row count | 1 (setup completed) |
| `admin_settings.password_hash` | PRESENT (len 114) |
| `admin_settings.recovery_code_hash` | PRESENT |
| `admin_settings.session_secret` | PRESENT (len 64, persisted in DB) |
| **`admin_settings.encryption_key`** | **ABSENT / NULL in ALL 7 backups** |
| `notification_secrets` row | 1 row (channel_id=1, key=`token`) |
| `notification_secrets.encrypted_value` | ciphertext len 106, **identical prefix `vZfO+m` / suffix `hg==` across ALL 7 backups** |
| `notification_channels` | 1 row (id=1, type=telegram, name=TG, enabled=1) |

**Conclusion (STEP 2/4):** The ciphertext has been **exactly the same** in every
backup since the first (2026-08-20), and `admin_settings.encryption_key` has
**always** been NULL. Therefore:

> **KEY MATERIAL NOT PRESENT IN DATABASE** — `admin_settings.encryption_key` has
> never held a value, so it could not have produced the stored ciphertext.

---

## 3. Git History Findings (STEP 3)

- `ENCRYPTION_KEY` first appears in **v0.8.0 (`9816178`)**, which added
  `src/lib/notifications/encryption.ts` and `src/lib/notifications/secrets.ts`.
- `git log -S "ENCRYPTION_KEY"` hits only: v0.8.0, v0.8.4, v0.8.5, v0.8.6,
  v0.8.7, `feat: add notification configuration UI`, `feat: add Telegram
  notification channel`. All are **code/doc additions**; **no commit ever
  introduced a real key value**.
- `git ls-files` shows **only `.env.example`** is tracked (no `.env`, no
  `data/encryption.key`). The `data/` directory is gitignored.
- **REAL SECRET FOUND IN HISTORY = NO.** No ENCRYPTION_KEY value, session secret,
  password hash, or recovery code ever entered the repository.
- **No key rotation procedure exists** in code or docs. The only mention of
  rotation risk is in `encryption.ts` comments ("existing encrypted secrets
  become undecryptable if the key changes") and DISASTER_RECOVERY.md (confirm
  key matches after restore).

---

## 4. Application Key Flow (STEP 5)

There are **two distinct key systems**. They must not be conflated.

### 4.1 Notification secrets real path (what encrypted the ciphertext)

`notifications/encryption.ts` → `getEncryptionKey()`:

1. **`process.env.ENCRYPTION_KEY`** — if non-empty, wins.
   - A 64-hex string → used verbatim as 32 bytes.
   - Any other non-empty string → SHA-256 derived to 32 bytes.
2. **Production (`NODE_ENV=production`)** without env → **THROW**
   (`ENCRYPTION_KEY is required in production`).
3. **Development** without env → fallback to a **persistent key file**
   `data/encryption.key` (mode 0600, random 32 bytes, created once, reused forever).

**This module NEVER reads the database.** `setChannelSecret` (secrets.ts:51) and
the D1 adapter (d1.ts:751) call `encryptSecretWithKey(value, getEncryptionKey())`
where `getEncryptionKey` comes from `notifications/encryption.ts`.

### 4.2 Admin settings key (separate, NOT the source)

`auth/admin-db.ts` → `getEncryptionKey()`:

1. `process.env.ENCRYPTION_KEY` — if set, wins.
2. Else `admin_settings.encryption_key` DB row.
3. Else THROW (`Encryption key is not initialized. Set ENCRYPTION_KEY (or run setup).`).

**This path is used for admin flows, and its DB fallback is documented as
"reserved for 9F" but is not the consumer of `notification_secrets`.** The
`repository.ts` contract comment (line ~168) explicitly states the admin
`getEncryptionKey` is *"separated from `notifications/encryption.ts` file-based
key (that module never touches the DB)"*.

### Answers to STEP 5 questions

1. **Where is ENCRYPTION_KEY read?** `process.env.ENCRYPTION_KEY` (in both modules).
2. **DB fallback allowed?** For **notification secrets: NO** — the encryption.ts
   module never touches the DB. For **admin**: YES (but the admin consumer is
   not the one that wrote `notification_secrets`).
3. **Env fallback?** Yes — env var wins in both.
4. **How is first-setup key established?** Operator sets `ENCRYPTION_KEY` env in
   production (`.env`, mode 600). Dev auto-creates `data/encryption.key`.
5. **When was the ciphertext produced?** Between initial deployment and the first
   backup (2026-08-20); stable thereafter. It used the **env key** (production),
   not a dev file and not a DB value.
6. **Key identifier/version?** None. Format is `iv:tag:ciphertext` (3 base64
   parts). No key id, no version, no salt stored alongside.
7. **Rotation mechanism?** None. Changing the key invalidates existing secrets
   (documented as controlled failure).

---

## 5. Backup Findings (STEP 4)

- **7/7 backups** → `admin_settings.encryption_key` = **NULL**.
- **7/7 backups** → `notification_secrets` ciphertext **identical** (len 106,
  prefix `vZfO+m`, suffix `hg==`).
- No backup ever recorded a non-NULL `encryption_key`, and the ciphertext never
  changed. This is consistent with: the ciphertext was produced once under a
  stable external env key and never re-encrypted.

**KEY MATERIAL NOT PRESENT IN DATABASE** — confirmed.

---

## 6. Key Continuity Classification (STEP 6)

Evidence-based classification:

| Element | Proven? |
|---------|---------|
| A key source exists (operator `ENCRYPTION_KEY` env, in `/tmp/domain-monitor/.env`) | **YES** (documented in E7) |
| The key source is exactly the one that produced the current ciphertext | **NOT PROVEN** — the value is outside the reachable workspace (`/tmp/domain-monitor/.env` is inaccessible) |
| The DB holds any key material | **NO** (NULL in all backups) |
| Any real key value appears in reachable files/repo | **NO** |

This is **CASE B**:

> **CASE B — Historical key source exists, but cannot be proven to correspond to
> the current ciphertext. → KEY CONTINUITY = UNPROVEN.**

(Not CASE A "verified", because the value is unreachable and unprovable from the
codespace. Not CASE C "unknown", because a source and a documented procedure
clearly exist. Not CASE D "broken", because there is no evidence the key is
unrecoverable — it is held by the operator.)

---

## 7. Security Findings

- No real `ENCRYPTION_KEY`, session secret, password hash, recovery code, token,
  or `iv:tag:ciphertext` value was printed anywhere during this investigation.
- `notification_secrets.ciphertext` examined only by structural metadata
  (length, first-4/last-4 base64 chars) — the full value was never output.
- `.tmp/private.key` found during the scan is an **EC private key**
  (`BEGIN EC PARAMETERS`), unrelated to domain-monitor's notification encryption.
- Git history is clean: **0 real secrets ever committed**.
- Production `.env` (the only place the key plausibly lives) is **not accessible**
  from this environment — by design (NFS-restricted `/tmp`).

---

## 8. Recommended Recovery Path (to achieve KEY CONTINUITY = VERIFIED)

To move from CASE B → CASE A, one of the following is REQUIRED. **None has been
performed in this phase.** They require operator action / explicit approval.

1. **Operator supplies the production `ENCRYPTION_KEY`** (from
   `/tmp/domain-monitor/.env`). Then in a controlled step, verify it decrypts the
   ciphertext (e.g. via a dry-run that reports `decrypts=true/false` WITHOUT
   printing the plaintext or key). If it decrypts → continuity VERIFIED.
2. **Operator confirms the key was never rotated** since the ciphertext was
   created (docs claim no rotation mechanism exists). Combined with (1).
3. If the key is truly lost/unrecoverable → the Telegram token is effectively
   lost; the operator would need to re-enter the bot token via the notification
   UI (which re-encrypts with a new key). **This changes data** and is out of
   scope for this phase. It is documented here only as context, NOT executed.

**No action was taken.** The block for 14C-11 STEP 6 remains: `ENCRYPTION_KEY`
continuity is **UNPROVEN**, and the existing ciphertext is left **untouched**.

---

## 9. Final Status

**FINAL STATUS = BLOCKED — KEY CONTINUITY UNPROVEN (CASE B)**

Because we **cannot prove** (from the reachable environment) that the
existing `ENCRYPTION_KEY` corresponds to the historical encryption of the current
`notification_secrets` ciphertext, the 14C-11 pipeline does **NOT** proceed to
Worker deploy.

**HARD STOP upheld:** No new ENCRYPTION_KEY generated. No `notification_secrets`,
`admin_settings`, or Production D1 modified. No Worker secret written. No
`wrangler secret put`. No ciphertext decrypted. No plaintext output. No brute
force. No business data changed. No deploy. No DNS. No Telegram/Webhook/Email.
No commit/push/tag/release.

---

*This document contains no secret values, no complete ciphertext, no tokens, and
no ENCRYPTION_KEY content.*


---

## 10. PHASE 14C-11B — KEY CONTINUITY VERIFICATION (2026-08-29)

**Result: STOPPED at STEP 1 — ORIGINAL KEY SOURCE = NOT ACCESSIBLE (HARD STOP upheld)**

Phase 14C-11B's single goal was to prove whether the operator-held original
production `ENCRYPTION_KEY` decrypts the Production D1 `notification_secrets`
ciphertext. This requires the original key value.

### STEP 1 — Locate original key

| Location checked | Presence |
|------------------|----------|
| `/tmp/domain-monitor/.env` | **NOT FOUND / NOT ACCESSIBLE** |
| `/workspace/domain-monitor/.env` | NOT FOUND |
| `/workspace/.env` | NOT FOUND |
| `/root/.env` | NOT FOUND |
| `/tmp/.env` | NOT FOUND |

The documented production key source (`/tmp/domain-monitor/.env`, mode 600) is
**not reachable** from the current sandboxed workspace (the `/tmp` production
mount is not exposed; the path does not exist here). No `.env` file is present
in any accessible location.

### Action taken

Per the Phase 14C-11B HARD STOP: *"If the path is not accessible: STOP. Report
ORIGINAL KEY SOURCE = NOT ACCESSIBLE. Do not ask to generate a new key."*

- ✅ **STOPPED immediately.** Did not proceed to STEP 2–8 (which all require the
  original key).
- ✅ Did **not** generate a new key.
- ✅ Did **not** attempt any decryption, re-encryption, rotation, or DB read/write.
- ✅ Did **not** attempt a brute-force or fallback key.
- ✅ Did **not** write any secret/ciphertext/plaintext to stdout/logs/Git.
- ✅ Did **not** touch Production D1, `notification_secrets`, `admin_settings`,
  any Worker, DNS, Cron, Telegram/Webhook/Email.
- ✅ Did **not** commit/push/tag/release.

### Key continuity classification

| Element | Result |
|---------|--------|
| Original production key source located | **NO** (unreachable in sandbox) |
| Key format check (STEP 2) | **NOT PERFORMED** (requires key) |
| Production D1 read (STEP 3) | **NOT PERFORMED** (blocked before key) |
| Controlled decryption (STEP 4) | **NOT PERFORMED** (blocked before key) |
| Round-trip (STEP 5) | **NOT PERFORMED** |
| Continuity determination (STEP 6) | **NOT DETERMINED** |

**KEY CONTINUITY = UNPROVEN (CASE B)** — unchanged from Phase 14C-11A.

**ORIGINAL KEY SOURCE = NOT ACCESSIBLE.**

### Final status

**FINAL STATUS = BLOCKED — KEY CONTINUITY UNPROVEN**

The operator must make the original production `ENCRYPTION_KEY` available (e.g.
run the verification step from the production host, or expose `/tmp/domain-monitor/.env`
to a reachable location / provide the key through a secure channel) before
Phase 14C-11B can proceed. Until then, the 14C-11 Worker deploy pipeline remains
**blocked**. **No deploy, no secret write, no DNS cutover, no commit/push/release.**
