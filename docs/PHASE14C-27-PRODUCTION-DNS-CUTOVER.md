# Phase 14C-27 — Production DNS Cutover (EXECUTED)

**Status:** ✅ PASS — formal production hostname attached and verified
**Date:** 2026-09-01 (Shanghai)
**Worker:** `domain-monitor` (production) — v16 / `b08cc17a-8e93-45ff-9d86-4c2490b22bdd`

> Formal production Cutover executed per explicit authorization. Custom Domain
> `monitor.snooze.eu.cc` attached to production `domain-monitor`. Smoke passed.
> **Rollback NOT executed** (cutover succeeded — hostname kept).

---

## 1. Pre-Cutover Baseline (re-verified read-only, no mutation)

| Item | Value |
|------|-------|
| Worker active version | `b08cc17a-8e93-45ff-9d86-4c2490b22bdd` (v16) |
| Cron | `0 * * * *` (created 2026-08-31T17:01:39Z) |
| D1 | mig=8, ev=11, deliv=11, doms=3, chans=1, secs=1, rems=1, maxev=11, maxdel=11 |
| DNS records | 3 (domain-monitor CNAME, dc AAAA, invalid_hostname AAAA) |
| Custom domains | 3 (api.cncn→mydoh, dc.snooze→domain-check, kui.cncn→kui) |
| `monitor.snooze.eu.cc` conflict | count=0 (none) |

## 2. Custom Domain Creation

```
PUT /accounts/{ACC}/workers/domains
{"hostname":"monitor.snooze.eu.cc","service":"domain-monitor","environment":"production"}
```
**Result:** `success: true`, `errors: []`
- **id:** `0a0f07668ad01cb42a81fe699ffe787d470c0011`
- **hostname:** `monitor.snooze.eu.cc`
- **service:** `domain-monitor` · **environment:** `production` · **enabled:** `true`
- **cert_id:** `288f425f-4797-4d4f-bdb3-e2fe0bc90954` (TLS assigned)

## 3. DNS / TLS State

- **DNS records** in `snooze.eu.cc`: 3 → **4**. Cloudflare **auto-created**:
  - `AAAA monitor.snooze.eu.cc -> 100::, proxied=True, ttl=1` (same placeholder pattern as dc/others — managed by the Custom Domain mechanism, `proxied`).
  - The 3 pre-existing records (`domain-monitor` CNAME, `dc` AAAA, `invalid_hostname` AAAA) **UNCHANGED** — not edited/deleted.
- **TLS**: Custom Domain cert assigned (`cert_id` `288f425f-...`), `enabled=true`. All HTTPS smoke requests returned `ssl_verify_result=0` (certificate validation **successful**).
- **External resolution**: `monitor.snooze.eu.cc` now resolves to Cloudflare proxy IPs:
  - `2606:4700:3032::ac43:d830`, `2606:4700:3031::6815:2b17` (AAAA) — no longer NXDOMAIN.

## 4. Live Smoke Results (against `https://monitor.snooze.eu.cc`)

| Endpoint | HTTP | TLS verify | Result |
|----------|------|-----------|--------|
| `/` | **307** | 0 | redirect → `https://monitor.snooze.eu.cc/login` ✔ |
| `/login` | **200** | 0 | HTML page ✔ |
| `/setup` | **200** | 0 | HTML page ✔ |

> The broken account-level `workers.dev` (HTTP 500 / error 1101) is fully **bypassed** — traffic now serves correctly via the custom domain.

## 5. Worker / Cron / D1 Post-Cutover (unchanged — read-only check)

| Item | Value | Change? |
|------|-------|---------|
| Worker active version | `b08cc17a` **v16** | **none** (not re-deployed) |
| Cron | `0 * * * *` | **none** |
| D1 | mig=8 · ev=11 · deliv=11 · doms=3 · chans=1 · secs=1 · rems=1 · maxev=11 · maxdel=11 | **none** |
| Delivery status | sent=7, failed=4 | **none** |
| Secrets | ENCRYPTION_KEY, SESSION_SECRET | **none** (not read/modified) |

**No unexpected D1 mutation.** `domains/events/deliveries/rules/channels/secrets/reminders` identical to pre-cutover.

## 6. Other Workers / DNS / Custom Domains — Unchanged

- `domain-check` + `dc.snooze.eu.cc` — untouched.
- `kui` + `kui.cncn.qzz.io` — untouched.
- `mydoh` + `api.cncn.qzz.io` — untouched.
- Existing 3 DNS records + the legacy `domain-monitor.snooze.eu.cc` Tunnel CNAME and `invalid_hostname_char!.snooze.eu.cc` — **NOT cleaned up** (left as-is per authorization; separate mutation only with future approval).

## 7. Rollback

**NOT executed.** Cutover succeeded; `monitor.snooze.eu.cc` retained as the formal production hostname. (Documented rollback paths remain available if ever needed.)

## 8. Final Matrix

**Custom Domain creation:** ✅ `monitor.snooze.eu.cc` → `domain-monitor` (production), id `0a0f0766...`, enabled=true
**hostname:** `monitor.snooze.eu.cc`
**TLS status:** ✅ certificate active (cert_id `288f425f-...`; TLS verify pass)
**DNS status:** ✅ AAAA proxied created, resolves to Cloudflare IPs; other 3 records untouched
**`/` HTTP:** 307 → `/login`
**`/login` HTTP:** 200
**`/setup` HTTP:** 200
**Worker version:** v16 (`b08cc17a-...`) — unchanged
**Cron:** `0 * * * *` — unchanged
**D1 mutation:** **0** (no unexpected change)
**Other Worker/DNS:** unchanged (mydoh / domain-check / kui / 3 existing DNS records)
**Rollback executed:** NO (success → hostname kept)

---
*Cutover complete. STOP — no automatic advance to the next phase.*
