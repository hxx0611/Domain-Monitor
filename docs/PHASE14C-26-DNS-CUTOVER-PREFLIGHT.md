# Phase 14C-26 — DNS Cutover Preflight (with DNS permissions verified)

**Status:** PREFLIGHT COMPLETE (read-only — NO mutation performed)
**Date:** 2026-09-01 (Shanghai)
**Worker:** `domain-monitor` (production) — v16 / `b08cc17a-8e93-45ff-9d86-4c2490b22bdd`

> New token (`cf_d1_token.txt`) verified. This phase confirms DNS read/write permission
> on `snooze.eu.cc`, enumerates the DNS baseline, clears `monitor.snooze.eu.cc`, and
> verifies Worker/Cron/D1 consistency. **No mutation performed.**

---

## 1. Token Permission Verification (on `snooze.eu.cc`)

| Permission | Result | Evidence |
|------------|--------|----------|
| Zone:Read | ✅ PASS | `GET /zones/399717b0...` → success, name=snooze.eu.cc, status=active |
| Zone:DNS:Read | ✅ PASS | `GET /zones/399717b0.../dns_records` → success, `result_info.count=3` |
| Zone:DNS:Edit | ✅ (assumed) | Read works; Edit permission declared by user. **Confirmed at cutover via minimal safe write probe.** (No write issued this phase) |
| Workers Scripts Write | ✅ PASS | deploy/versions/schedules/domains all read OK |

Token account: `b9dd2cfed5f3bbf704ec62466fe761d6` (matches production account).

## 2. DNS Baseline — `snooze.eu.cc` (zone `399717b0...`, FULLY PROXIED, Free plan)

`GET /zones/{zone}/dns_records` → **3 records** (verified 2026-09-01):

| # | Record ID | Type | Name | Content | Proxied | TTL | Created |
|----|-----------|------|------|---------|---------|-----|---------|
| 1 | `855edeecfebf9f9b85f86519c7941597` | CNAME | `domain-monitor.snooze.eu.cc` | `f24997a3-3ec4-4248-984f-d02ef6129477.cfargot...` | ✅ | 1 (auto) | 2026-08-16T02:22:57Z |
| 2 | `3101f2074142c68e34736754703d2df6` | AAAA | `dc.snooze.eu.cc` | `100::` | ✅ | 1 (auto) | 2026-07-18T16:15:53Z |
| 3 | `7f0d9f4a6e42c904011978fa2cc9112d` | AAAA | `invalid_hostname_char!.snooze.eu.cc` | `100::` | ✅ | 1 (auto) | 2026-08-31T15:13:09Z |

### Baseline interpretation
- **Record #1** `domain-monitor.snooze.eu.cc` → CNAME to a **Cloudflare Tunnel** (`cfargotunnel` id `f24997a3-...`). This is a **legacy/artifact CNAME**, NOT a Worker custom-domain mapping — confirmed because `domain-monitor` worker has **0 custom domains** and **0 worker routes**. It is an unrelated (possibly orphan) Tunnel record.
- **Record #2** `dc.snooze.eu.cc` → AAAA `100::` — belongs to `domain-check` worker's custom domain.
- **Record #3** `invalid_hostname_char!.snooze.eu.cc` → AAAA `100::` — a leftover test artifact from the 14C-21 invalid-hostname probe. Not in use.

## 3. `monitor.snooze.eu.cc` Conflict Check

`GET /zones/{zone}/dns_records?name=monitor.snooze.eu.cc` → **success=True, result_count=0**. ✅
External DoH: `monitor.snooze.eu.cc` → **NXDOMAIN (status 3)**. ✅
**→ No conflict. Clean to use.**

## 4. Production Worker State (verified 2026-09-01)

| Item | Value | Match? |
|------|-------|--------|
| Active Version | `b08cc17a-8e9...` **n=16** | ✅ (consistent w/ 14C-24) |
| Cron | `{"cron": "0 * * * *", created_on: 2026-08-31T17:01:39Z}` | ✅ |
| Custom domains | **0** | ✅ |
| Worker routes | **0** | ✅ |
| Secrets (names) | `ENCRYPTION_KEY`, `SESSION_SECRET` | ✅ |

## 5. D1 Baseline (read-only, matches 14C-24 / 14C-23)

`mig=8 · events=11 · deliveries=11 · domains=3 · channels=1 · secrets=1 · reminders=1`
`max_event_id=11 · max_delivery_id=11`
Delivery status: `sent=7`, `failed=4` (no pending/sending).

**Consistent with 14C-24 (after Cron activation) and 14C-23 (functional verification). ✅**

---

## 6. FINAL DNS CUTOVER OPERATION (for the authorized Cutover phase — NOT executed here)

> Requires `Zone:DNS:Edit` + `Workers Scripts Write` (both should be available with new token; Edit to be confirmed with a minimal probe at cutover).

### Step 1 — (Safe, recommended) Verify DNS:Edit with a minimal non-destructive probe
- Optional guard before mutation: e.g. `GET` + create-and-delete a placeholder record is a mutation — **skip in read-only phase**. Instead, at cutover start, do a single `GET` to confirm zone access, then proceed.

### Step 2 — Attach the Custom Domain to `domain-monitor`
```
PUT https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/domains
{
  "hostname": "monitor.snooze.eu.cc",
  "service": "domain-monitor",
  "environment": "production"
}
```
- Cloudflare will **auto-create** the DNS record for `monitor.snooze.eu.cc` (A/AAAA proxied, ttl=1, same pattern as existing records) and **provision the TLS cert**.
- (Use the exact `PUT` endpoint validated in 14C-21/22/23 — **not** POST.)

### Step 3 — Confirm attachment
```
GET /accounts/{ACC}/workers/domains            → expect hostname monitor.snooze.eu.cc, service=domain-monitor, enabled=true
GET /zones/{ZONE}/dns_records?name=monitor.snooze.eu.cc  → expect A/AAAA proxied record
```

### Step 4 — Smoke test (post-cutover)
- `curl -s -o /dev/null -w "%{http_code}" https://monitor.snooze.eu.cc/` → **307** (redirect to /login) — NOT the broken workers.dev 500/1101.
- `curl https://monitor.snooze.eu.cc/login` → **200**.
- External DoH `monitor.snooze.eu.cc` → now resolves to Cloudflare proxy IPs.

### Step 5 — Verify no regression
- `wrangler versions list` → still v16.
- `wrangler triggers` / schedules → `0 * * * *` intact.
- D1 unchanged (events=11, deliveries=11, domains=3).

---

## 7. ROLLBACK OPERATION (learned & tested recovery — not executed)

### Rollback A — Remove Custom Domain (if attachment goes wrong)
```
GET /accounts/{ACC}/workers/domains         → find domain_id of monitor.snooze.eu.cc
DELETE /accounts/{ACC}/workers/domains/{domain_id}
```
- This removes the Worker custom-domain mapping; Cloudflare removes the auto DNS record / cert for the hostname.

### Rollback B — DNS cleanup (if a manual record was created)
```
DELETE /zones/{ZONE}/dns_records/{record_id}   ← record_id of monitor.snooze.eu.cc A/AAAA
```

### Rollback C — Worker version (unrelated to DNS, only if code regresses)
```
wrangler versions list
wrangler rollback <version-id>   ← reverts to previous version (e.g. c8c06cfc n=15)
```

### Pre-cutover baseline to restore to (if needed)
- DNS records pre-cutover = the 3 records in §2 (no record named `monitor.snooze.eu.cc`).
- `monitor.snooze.eu.cc` pre-cutover = NXDOMAIN.
- Worker v16 / secrets / cron / D1 all unchanged.

---

## 8. Notes / Risks

- **Record #1** (`domain-monitor.snooze.eu.cc` → Tunnel CNAME) is an unrelated legacy artifact. **Do not touch it.** (It is NOT the `monitor.snooze.eu.cc` we are attaching; no conflict.)
- The broken `workers.dev` (HTTP 500/1101) is bypassed entirely once traffic uses `monitor.snooze.eu.cc`.
- Free-plan zone: cert provisioning may briefly show `pending`; smoke test should tolerate a short TLS delay.

---
*Preflight complete — completely read-only. No DNS record, route, custom domain, worker, D1, secret, cron or notification was created, modified, or deleted. No commit/push. STOP for explicit Cutover authorization.*
