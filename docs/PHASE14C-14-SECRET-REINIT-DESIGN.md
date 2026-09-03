# PHASE 14C-14 — Notification Secret Reinitialization: Design & Preflight

**Status: COMPLETED (design + preflight only — NO production mutation)**
**Date:** 2026-08-29
**Verdict:** **DESIGN PASS** — reinitialization is SUPPORTED with the recommended
re-entry (upsert) strategy; requires **no code change** for the core flow.

---

## 0. Context

The original production `ENCRYPTION_KEY` is unavailable/inaccessible
(Phase 14C-13 = KEY CONTINUITY UNPROVEN). The existing `notification_secrets`
ciphertext in Cloudflare D1 `domain-monitor` (1 row, channel 1, key `token`,
ciphertext len 106) cannot be proven decryptable by any currently-available key.
This phase **designs** the safe path to reinitialize the notification secret,
leaving production data untouched. Only design + preflight. No mutation.

---

## STEP 1 — Current D1 notification state (read-only, metadata only)

| Item | Result |
|------|--------|
| `notification_secrets` table exists | ✅ YES |
| Row count | **1** (channel_id=1, key=`token`) |
| Columns / schema | `id` INTEGER PK, `channel_id` INTEGER, `key` TEXT, `encrypted_value` TEXT, `created_at` INTEGER, `updated_at` INTEGER |
| configured status | **present** (1 row) |
| ciphertext length | **106** |
| algorithm / version metadata column | **None** — no separate algorithm/version column; only `encrypted_value` |
| `notification_channels` | 1 row (id=1, type=telegram, name=TG, enabled=1) |
| `notification_rules` | 5 rows, all channel_id=1 (names "1"–"4", "expiration-reminder") |
| `notification_events` | 7 |
| `notification_deliveries` | 7 |

**No ciphertext, plaintext, token, secretRef, or key value was read or output.**

---

## STEP 2 — Current encryption implementation

### 2A. Key format requirements (`encryption.ts`)

- `ENCRYPTION_KEY` env var, trimmed; **64-hex chars → used verbatim as 32 bytes**;
  any other non-empty string → **SHA-256 derived to 32 bytes**.
- Production (`NODE_ENV=production`) with missing/empty env → **THROWS**.
- Dev → persistent `data/encryption.key` (0600, random 32 bytes).
- AES-256-GCM; `iv:tag:ciphertext` (3 base64 segments); random 12-byte IV per
  encryption; 16-byte GCM tag.

### 2B. How a new token is written

**`saveTelegramChannel` server action** (`notifications/actions.ts`):
- Edit mode, if `token.length > 0` → validates via `getMe` (`fetchTelegramBotInfo`)
  FIRST (no write on failure), then:
  `repo.setChannelSecret(channelId, TELEGRAM_TOKEN_SECRET_KEY, token)`.
- `setChannelSecret` (`secrets.ts`) is an **upsert**:
  `INSERT … ON CONFLICT(channel_id, key) DO UPDATE SET encrypted_value=…, updated_at=…`.
  → New token **atomically replaces** the old secret for that (channel_id, key).
- Empty token on edit → **preserves** existing secret (controlled path).

### 2C. Decrypt failure behavior

- `getChannelSecret` → `decryptSecretWithKey` **throws** on wrong key/tampering.
- `TelegramSender` (factory-injected `resolveSecret`) catches and **rethrows**
  `TelegramError("Telegram token decryption failed.", "invalid-config")` — **never
  masked as "no secret", never falls back to env** (no accidental use of a stale
  legacy token).
- This failure is **channel-scoped**: a broken Telegram secret does not affect
  email/webhook channels or the rest of the app.

### 2D. Coexistence of old + new ciphertext

- The schema key is `(channel_id, key)`. Re-entry **replaces the same key**.
  There is **no mechanism for two ciphertexts under the same (channel_id, key)**.
- **Coexistence is NOT supported** — but that is fine because re-entry overwrites.

### 2E. Need to delete/replace old row?

- **Replace (upsert)** is sufficient. `setChannelSecret` with a new value overwrites
  the encrypted_value for `(1, "token")`. **No manual DELETE required.**

### 2F. UI re-entry support

- ✅ **Fully supported.** `ChannelForm` (edit mode) loads `hasToken` (boolean only),
  has a **password input** for the Telegram token, and submits through
  `saveTelegramChannelAction`. The token stays in client state, never rendered back,
  never written to HTML/RSC. Validated server-side via `getMe` before any save.

---

## STEP 3 — Reinitialization strategy (compare A vs B)

### Strategy A — Re-entry (replace) the secret via UI/action

Keep the channel, rules, events, deliveries untouched. Operator opens
Notifications → TG channel → Edit → enters new Bot Token → save. The action
**re-encrypts with the new `ENCRYPTION_KEY`** and upserts the secret row.

### Strategy B — Delete old secret, then re-enter

First `DELETE` the `(1,"token")` row (or clear it), then re-enter.

| Criterion | A — replace (recommended) | B — delete then re-enter |
|-----------|---------------------------|--------------------------|
| Data safety | High — atomic upsert, old value replaced in one op | Medium — temporary missing secret between delete & re-enter |
| Rollback | Easier — channel/rules unchanged; only secret changed | Harder — risk of a lingering tokenless state |
| UI compatibility | ✅ Native edit flow, no extra step | Needs a delete path (not natively exposed) |
| Migration requirement | **None** | None (still relies on existing upsert) |
| Downtime | None | Brief window where token is absent |
| Secret rotation risk | Low | Higher (transient missing state) |
| Impact on channel/rules/events/deliveries | **None** — these reference channel_id, not the secret value | None — but deliveries during the gap may fail |

**Decision: Strategy A** (re-entry/replace). It preserves all business data
(channel, 5 rules, 7 events, 7 deliveries) and is the least disruptive, most
rollback-friendly path. **No manual DELETE is needed** — `setChannelSecret`
upsert handles replacement atomically.

---

## STEP 4 — Key generation design (design only, NOT executed)

- **Generation:** `node:crypto` `randomBytes(32)` → hex.
- **Length / encoding:** 64 hex chars (32 bytes). Matches `normalizeEncryptionKey`
  verbatim branch.
- **Randomness:** CSPRNG (`crypto.randomBytes`). Must NOT be a guessable/passphrase
  value in production.
- **Worker Secret storage:** Cloudflare **Workers Secret** (`wrangler secret put
  ENCRYPTION_KEY`) or a Wrangler `secret` variable — **never** in `wrangler.jsonc`
  `vars[]` (that is committed config, not a secret), never in Git.
- **Node ⇄ Cloudflare shared?** YES — the SAME value must be used by both the Node
  self-hosted app (if still running) and the Cloudflare Worker, so the same
  ciphertext stays decryptable across runtimes. It is a **single shared master key**,
  not two keys.
- **Key rotation documentation:** Recommended to add a small `KEY ROTATION` note
  (in `docs/NOTIFICATIONS.md` or `OPERATIONS.md`) describing: rotate → invalidates
  old secrets → operators must re-enter tokens → no automatic migration of old
  ciphertext. **Documentation only in this phase; no file written.**

> **KEY NOT GENERATED IN THIS PHASE.** No key value created or held.

---

## STEP 5 — Existing ciphertext handling

- **Can it be safely retained?** Yes — leaving the old ciphertext in place does
  NOT break anything (the row is simply replaced on re-entry).
- **Does the new key make old ciphertext permanently undecryptable?** YES — but
  that is **by design** and acceptable: the old token is unusable anyway (the
  original key is lost). Once re-entered, the old ciphertext is overwritten.
- **Does the app break when it encounters the old ciphertext?** NO — it surfaces a
  controlled `invalid-config` error on that channel only, nothing else. But after
  re-entry with the new key + new token, the channel works again.
- **Need a disabled/stale marker?** NO, because the old row is simply overwritten;
  no stale state lingers. The schema needs **no change**.
- **Minimal schema/API change?** **None required.** The existing `(channel_id, key)`
  upsert already supports clean replacement.

> **No D1 modification performed.** `notification_secrets` row left exactly as is.

---

## STEP 6 — UI re-entry path validation

After the Worker is deployed, the flow:

```
Notifications
  → Telegram channel
    → Edit / Configure
      → enter new Bot Token (password input)
        → Server Action (saveTelegramChannelAction)
          → getMe validation (server-side)
          → encrypt with new ENCRYPTION_KEY (upsert)
          → D1 notification_secrets (channel_id=1, key=token)
```

| Requirement | Supported? |
|-------------|------------|
| Edit Telegram channel | ✅ (`ChannelForm` mode="edit") |
| New token input field | ✅ password field, token in client state only |
| Server action validates getMe then saves | ✅ (`saveTelegramChannelAction`) |
| Encrypt with current `ENCRYPTION_KEY` | ✅ (`setChannelSecret` → `getEncryptionKey()`) |
| Upsert into D1 | ✅ (`onConflictDoUpdate` on (channel_id,key)) |

**Conclusion: fully supported — NO code change required.** No token was submitted.

---

## STEP 7 — Rollback design

| Scenario | Behavior | Reversible? |
|----------|----------|-------------|
| New key config fails (secret not set) | Worker won't start/send; Node still uses its own env (if unchanged). No data changed. | ✅ Fully reversible — nothing was written |
| Re-entry of token fails at getMe | Nothing written to D1 (validate-before-write). | ✅ Fully reversible |
| Re-entry succeeds but new key later lost | New ciphertext becomes undecryptable → controlled `invalid-config` on channel. | ⚠️ Partially — token must be re-entered again; no data corruption |
| Old ciphertext accidentally deleted | Only the secret row gone; channel/rules/events/deliveries unaffected. | ⚠️ Irreversible for the old token value (already unreadable), but recoverable by re-entering a new token |
| Wrong key set at deploy | Same as key loss — channel controlled-fails until re-entered with correct key. | ✅ Recoverable (fix secret + re-enter token) |

**Irreversible actions:** overwriting the old ciphertext (it cannot be recovered if
the old key is lost). **Reversible:** key config, token re-entry, D1 secret row
(given a known key). The recommended sequence (set key first, then re-enter token)
means no step leaves the channel in an un-sendable state for longer than a re-entry.

---

## STEP 8 — Production deployment ordering (DESIGN ONLY — nothing executed)

Deferred to an authorized Production Deployment phase. Recommended strict order:

1. **Generate new `ENCRYPTION_KEY`** (CSPRNG, 64-hex) ← future phase, operator/approved
2. **`wrangler secret put ENCRYPTION_KEY "<value>"`** (secure channel; never echo)
3. **Configure `SESSION_SECRET`** (Worker secret)
4. **Re-enter Telegram token via UI** → encrypt with new key → upsert D1
5. **Deploy Worker** (domain-monitor; NOT domain-check/kui/mydoh/odd-bonus-eae5)
6. **Read-only D1 verification** (counts, FK=0, `notification_secrets` re-encrypted)
7. **UI test notification** (sendTestNotificationAction, source=test; no real rules)
8. **Cron Trigger** (scheduled → runOnce; `0 * * * *`)
9. **DNS cutover** (last step; when ready)

> **THIS PHASE DOES NOT EXECUTE ANY OF THE ABOVE.**

---

## STEP 9 — Security review

Potential leak vectors and mitigation:

| Vector | Risk | Mitigation |
|--------|------|------------|
| `ENCRYPTION_KEY` in Git | High | Never commit; use Worker secret; `wrangler.jsonc` has only `vars` (non-secret), never the key |
| `wrangler secret put` echoing value | High | Pass value via stdin / env, never as an inline shell arg printed to history; verify with `wrangler secret list` (names only) |
| Token in logs/error | Medium | `console.error` in actions is generic; `TelegramError` messages are secret-free by design; `readTelegramDescription` redacts token/URL-shaped substrings |
| Ciphertext in logs | Medium | Never log `encrypted_value`; only log presence/boolean via `getChannelSecretStatusAction` |
| Shell history leak | Medium | Avoid `ENCRYPTION_KEY=...` inline; use env injection / `wrangler secret put` from a file that is deleted after |
| CI artifact leak | Medium | Build output must not embed `process.env.ENCRYPTION_KEY` (it's server-side only, `server-only` guard, never in client bundle) |
| Wrangler output leak | Low | Wrangler may print var names; never use `--json` on a secret put; use `secret list` for presence only |

**Safest execution pattern:** generate key in a memory-only step → pipe directly
into `wrangler secret put` via stdin/stdout redirection → confirm with a boolean
status → never print/echo the value → never persist to disk/Git/logs.

---

## STEP 10 — Final decision

| Item | Value |
|------|-------|
| OLD KEY | **UNAVAILABLE** |
| OLD CIPHERTEXT | **PRESENT** |
| REINITIALIZATION | **SUPPORTED** (UI + server action upsert, no code change) |
| RECOMMENDED STRATEGY | **A** (re-entry/replace via upsert) |
| PRODUCTION WRITE | **0** |
| TELEGRAM SEND | **0** |

**FINAL STATUS = DESIGN PASS**

Reinitialization of the notification secret is fully supported by the existing
code (UI edit → `saveTelegramChannelAction` → `setChannelSecret` upsert → AES-256-GCM
with the current `ENCRYPTION_KEY`). The recommended strategy is **A** (replace via
re-entry), which preserves all channel/rules/events/deliveries data and requires
**no schema or API change**. The only prerequisite is a new `ENCRYPTION_KEY`, which
is **not** generated in this phase (deferred to a future, explicitly-authorized
Production Deployment + key-provisioning step).

---

*This document contains no secret values, no complete ciphertext, no tokens, and no
encryption key content. No production resource was modified.*
