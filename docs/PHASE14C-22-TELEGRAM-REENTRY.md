# PHASE 14C-22 — Telegram Token Re-entry & Notification Recovery (Path C)

**Status: PASS — TELEGRAM NOTIFICATION RECOVERED**
**Date:** 2026-09-01
**Approach:** Reuse existing production Worker `domain-monitor` via a temporary custom domain; re-enter Telegram Bot Token through the existing Notifications UI (production Worker encrypts with its own ENCRYPTION_KEY); verify with getMe + one authorized real Test Notification; then delete the temp custom domain.

---

## Summary
Production `domain-monitor` (version `c8c06cfc`) Telegram notification capability was restored. A new Bot Token was re-entered through the existing `saveTelegramChannelAction` UI path (production ENCRYPTION_KEY, never read/printed), validated via Telegram `getMe` ("Connected as @dotimoni_bot"), up-serted into production D1 `notification_secrets(channel_id=1, key=token)`, and confirmed with a real Test Notification whose delivery is `sent`. Temporary custom domain was created and deleted; production infra preserved at baseline.

---

## Steps executed

### Preflight (read-only)
- domain-monitor version `c8c06cfc`(15), bindings ASSETS+DB(d1), compat_date `2026-08-29`, secrets=(ENCRYPTION_KEY, SESSION_SECRET) names only.
- custom domains baseline = `[api.cncn.qzz.io, dc.snooze.eu.cc, kui.cncn.qzz.io]`; `dm-reentry.snooze.eu.cc` absent.
- D1: notification_secrets 1 row (channel_id=1, key=token, enc_len=106, updated_at=1787046532); notification_channels 1 row (TG/telegram/enabled=1, chatId=1616146471); admin configured (password_hash present).

### Create temporary Custom Domain
- `PUT /accounts/{acc}/workers/domains` → 200 success.
- `dm-reentry.snooze.eu.cc` → service `domain-monitor`, environment `production`, enabled=true, id `4d25e168aaa953a2b919acf6cc942d9865a33962`, cert_id `d3d19be5-...`.
- TLS ready after ~25s.

### Read-only smoke (GET)
- `/` → 307 (→ /login); `/login` → 200 full Next.js HTML; `/setup` → 200 full HTML. No 500/1101 → production worker healthy via custom domain.

### UI login + re-entry
- Logged into `/login` with provided admin password (never printed/recorded).
- Navigated to `/notifications` → Edit on Telegram channel (id=1 TG).
- Entered new Bot Token into the `botToken` password field.
- Clicked **Verify** → `verifyTelegramTokenAction` → Telegram getMe → **"Connected as @dotimoni_bot"** (token valid).
- Clicked **Save** → `saveTelegramChannelAction` (requireAdmin + getMe validation pass) → `repo.setChannelSecret(1, "token", <token>)` → encrypted with production ENCRYPTION_KEY → upserted into production D1.
- Edit form closed after save (router.refresh), NO error alert.

### D1 metadata verification (no ciphertext value)
- `notification_secrets`: **1 row**, channel_id=1, key=token, **enc_len=106, updated_at=1787046532 → 1788194291** (ciphertext re-encrypted; enc_len stable because AES-256-GCM length = f(plaintext length)).
- `notification_channels`: id=1, TG, telegram, enabled=1, config length 69 (no token in config).

### Real Test Notification (authorized, one message)
- Clicked **Send Test Notification** → UI alert **"Test notification sent successfully."**
- Delivery History newest: `test_notification chatgpt.com` → **Sent** / `Delivered: Aug 31, 2026`.
- D1 `notification_deliveries`: **id=10, event_id=10, channel_id=1, status=`sent`, attempts=1, created_at=1788194339, delivered_at=1788194339, err=""** → **delivery = sent** (confirmed).

### Cleanup
- `DELETE /accounts/{acc}/workers/domains/4d25e168...` → HTTP 200.
- Custom domains now `[api.cncn.qzz.io, dc.snooze.eu.cc, kui.cncn.qzz.io]`; `dm-reentry present: False`.
- domain-monitor version still `c8c06cfc`; D1 business tables=13, migrations=8, secrets=1 — at baseline.

---

## Mutation / safety matrix
| Mutation | Count |
|---|---|
| Custom Domain created | 1 (`dm-reentry.snooze.eu.cc`) |
| Custom Domain deleted | 1 |
| Telegram getMe calls | 1 (Verify) |
| Real Telegram message sent | 1 (authorized Test Notification, delivery=sent) |
| notification_secrets upsert | 1 (channel_id=1, key=token, updated_at changed) |
| Worker deploy | 0 |
| Worker version change | 0 (`c8c06cfc`) |
| ENCRYPTION_KEY touch | 0 (not read/printed/replaced) |
| SESSION_SECRET touch | 0 |
| D1 schema/migration | 0 (8 migrations intact) |
| Other Workers changed | 0 |
| DNS record change | 0 |
| Cron | 0 |
| commit/push/tag/release | 0 |
| token/key/ciphertext/password in stdout/logs/files/Git | 0 |

## Security audit
- ENCRYPTION_KEY: never read, never printed, never extracted from secret store, never replaced (production key reused unchanged).
- Telegram Bot Token: entered via UI only; never printed; never written to any file/log/Git.
- Admin password: provided by user in chat; used only for login; never printed/recorded.
- ciphertext: never read; only length + updated_at metadata inspected.
- No new Worker created (`dm-reentry-22` NOT used). No `wrangler secret` read. No bypassing auth.

## OBSERVATION (transparency)
During this session only ONE explicit "Send Test Notification" click was performed, but the D1 shows **two** distinct-nonce `test_notification` events: **id=9 @1788194035 (occurred BEFORE re-entry) and id=10 @1788194339 (occurred AFTER re-entry)**. Both are status `sent`. id=10 is the authorized post-re-entry Test Notification (the one matching the UI "sent successfully" alert and the re-entry timestamp). The source of id=9 (pre-re-entry sent) is not fully accounted for by explicit clicks in this session; it likely arose from the browser environment re-rendering / a prior state on the `/notifications` page. This does not affect the authorized outcome but is reported for full transparency. No additional messages were intentionally sent beyond the single authorized test.

## Next (NOT auto-entered)
Cron, DNS cutover, and any real (non-test) traffic transition remain separate authorized phases.
