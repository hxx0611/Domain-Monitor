# PHASE 14C-21 — Custom Domain Runtime Smoke (Path A)

**Status: PASS — CUSTOM DOMAIN RUNTIME VERIFIED**
**Date:** 2026-08-31
**Goal:** Create temporary `dm-smoke.snooze.eu.cc` bound to production Worker `domain-monitor`, verify the Worker runtime actually executes via a custom domain (bypassing the account-level workers.dev 1101 fault), then delete the temp custom domain. **Achieved.**

---

## Summary
The production Worker `domain-monitor` (version `c8c06cfc`) **executes correctly** via the custom domain `dm-smoke.snooze.eu.cc`: `/` → 307 (→ /login), `/login` → 200, `/setup` → 200, all returning real Next.js HTML. Meanwhile `workers.dev` for the **same worker** still returns **500 / error code 1101**. This conclusively demonstrates the workers.dev fault is a **subdomain/entry-layer issue**, while the production Worker runtime itself is healthy. The temporary custom domain was created, verified, and deleted. Worker version / D1 / bindings / secrets / existing infrastructure all unchanged.

---

## Steps executed

### Permission preflight
- Corrected API: official is **PUT `/accounts/{account_id}/workers/domains`** (required permission: **Workers Scripts Write**). POST returns 405 (method misuse).
- Probe with invalid hostname → **10082** ("can't infer zone"); illegal-hostname + zone_id → **100113** ("hostname invalid"). Both are parameter/validation errors (NOT 405/403), confirming the token **has** Custom Domain write permission. No resource created.

### Create custom domain (PUT)
- `PUT /accounts/{acc}/workers/domains` → **200**, success.
- `dm-smoke.snooze.eu.cc` → service `domain-monitor`, environment `production`, **enabled = true**.
- id `100e6e5f3d2ef3f5c66163634eaad4e583ad5c33`, cert_id `3a6de09e-5c78-400d-9abe-d2ba74b01020`, zone `snooze.eu.cc`.

### Certificate/TLS readiness
- Waited ~25s. TLS provisioned automatically by Cloudflare (universal cert).
- `https://dm-smoke.snooze.eu.cc/` responded with Cloudflare edge (`CF-Ray ...-SIN`), server `cloudflare` → TLS ready.

### Runtime smoke (read-only GET)
| Path | HTTP | CF-Ray | Content | Verdict |
|---|---|---|---|---|
| `/` | **307** (→ `Location: /login`) | a33cfdd32e41f8c6-SIN | Next.js HTML (`__next_error__` + `/_next/static/chunks/...`) | ✅ normal |
| `/login` | **200** | a33cfe1ffd2780fe-GRU | full Next.js HTML (`<html lang="en">...`) | ✅ normal |
| `/setup` | **200** | a33cfe3e5bf10290-GRU | full Next.js HTML | ✅ normal |
- **No 5xx / 1101 / 1102 / 500.** Worker genuinely executing (rendering real pages).

### workers.dev comparison
- `https://domain-monitor.1439343758.workers.dev/` → **HTTP 500 / error code: 1101**
- `https://domain-monitor.1439343758.workers.dev/login` → **HTTP 500 / error code: 1101**
- → Same worker: custom domain = healthy (200/307), workers.dev = 1101. **Workers.dev fault is entry-layer; Worker runtime is healthy.**

### D1 integrity (read-only)
- migrations = 8, domains = 3, notification_events = 7, notification_deliveries = 7, notification_rules = 5, notification_secrets = 1, business tables = 13. Matches 14C-9B baseline; `changed_db` = false; nothing mutated (all requests were read-only).

### Worker metadata unchanged
- version = `c8c06cfc` (number 15), bindings = ASSETS + DB(d1), compat_date `2026-08-29`, nodejs_compat, secrets = ENCRYPTION_KEY + SESSION_SECRET (names only).

### Cleanup (DELETE)
- `DELETE /accounts/{acc}/workers/domains/100e6e5f...` → success (204-style empty body).
- Confirmed: custom domains now = `[api.cncn.qzz.io, dc.snooze.eu.cc, kui.cncn.qzz.io]`; **`dm-smoke present: false`**; `dc.snooze.eu.cc` (domain-check) intact.

---

## Final gate
| Counter | Value |
|---|---|
| Custom Domain create | 1 (`dm-smoke.snooze.eu.cc`) |
| Custom Domain delete | 1 |
| Worker deploy | 0 |
| Worker version change | 0 (still `c8c06cfc`) |
| D1 writes | 0 |
| D1 migration | 0 |
| Secrets writes | 0 |
| DNS record changes | 0 |
| Route changes | 0 |
| Cron changes | 0 |
| Telegram/Webhook/Email | 0 |
| Existing Workers changed | 0 (domain-check/kui/mydoh/odd-bonus-eae5 unchanged) |
| Git changes | 0 |

## FINAL STATUS: **PASS — CUSTOM DOMAIN RUNTIME VERIFIED**
> "workers.dev 故障已被 Custom Domain 路径绕过验证，production Worker runtime 本身可执行。"

## Safety / boundary honored
- No `wrangler deploy`. No Worker version/code change. No D1 data/schema/migration change. No secret read/printed. No Telegram re-entry/send. No Cron. No DNS/route change. No modification to domain-check/kui/mydoh/odd-bonus-eae5. No commit/push/tag/release. No token value output. domain-monitor preserved at `c8c06cfc`.

## Next (NOT auto-entered)
Telegram Token re-entry, Notification Test, Cron, and DNS cutover remain separate authorized phases.
