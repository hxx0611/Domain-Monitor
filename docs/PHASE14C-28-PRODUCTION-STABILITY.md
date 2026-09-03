# Phase 14C-28 — Production Stability / Observability

**Status:** COMPLETE (read-only observation — NO mutation performed)
**Observation window:** 2026-09-01 → 2026-09-03 (incl. one full natural cron cycle)
**Worker:** `domain-monitor` (production) — v16 / `b08cc17a-8e93-45ff-9d86-4c2490b22bdd`
**Production hostname:** `https://monitor.snooze.eu.cc` (attached in 14C-27)
**Cron:** `0 * * * *`

> This phase observed stability of the production entry point **without changing anything**.
> No code, deploy, config, DNS, route, custom domain, D1 data, secrets, cron, Telegram,
> test data, or other worker was modified. No secrets/tokens/ciphertext were output.

---

## PRODUCTION_STABILITY = **PASS**

### 1. HTTP
`monitor.snooze.eu.cc` returned stable responses across repeated probes (verified pre-window and again at end):
- `/` → **307** (redirect to `/login`)
- `/login` → **200**
- `/setup` → **200**
- No 5xx observed on any probe. Repeated 3× across time were stable (307/200/200).
- `https://monitor.snooze.eu.cc` **bypasses** the broken account-level `workers.dev` (500/1101) — the production hostname serves correctly.

### 2. TLS
- All HTTPS probes returned `ssl_verify_result=0` (certificate validation **successful**).
- Tail captured real user HTTP requests via **TLSv1.3** (`AEAD-AES128-GCM-SHA256`) on the hostname.
- **TLS = PASS.**

### 3. Worker runtime
- `wrangler tail` captured **10 invocations** (during observation window): **all `outcome: ok`, `exceptions: []`.**
- Breakdown: **1 scheduled (cron) event** + **9 HTTP fetch requests** — every one `outcome=ok`, zero exceptions.
- **Runtime = PASS** (no errors, no exception frequency).

### 4. Cron
- Cron **still `0 * * * *`** (schedules API: created `2026-08-31T17:01:39Z`, modified same — unchanged).
- **No schedule added or removed.**
- Worker **version still v16** (`b08cc17a-8e93-45ff-9d86-4c2490b22bdd`).
- Latest scheduled invocation (captured in tail): **`outcome=ok`, `exceptions: []`, scriptVersion=`b08cc17a`, event=`{"cron":"0 * * * *","scheduledTime":1788285648000}`**.
  - `scheduledTime = 2026-09-01 18:00:48 UTC` (= Shanghai 09-02 02:00:48), the `0 * * * *` top-of-hour (UTC 18:00).
  - **Cron = PASS.**

### 5. D1 integrity (read-only, post-cron)
Counts **identical to the 14C-24/23/26/27 baseline** (no unauthorized growth):

| Table | Value |
|-------|-------|
| migrations | 8 |
| domains | 3 |
| events | 11 |
| deliveries | 11 |
| rules | 5 |
| channels | 1 |
| notification_secrets | 1 |
| reminders | 1 |
| MAX(events.id) | 11 |
| MAX(deliveries.id) | 11 |

- **No unauthorized event/delivery growth.**
- **No duplicate events/deliveries** (latest event/delivery ids still 11; no re-insertions).
- **No pending/sending backlog** (pending+sending+scheduled count = **0**).
- **D1 = PASS.**

### 6. Notification health
- Delivery status: **`sent = 7`, `failed = 4`** — unchanged from baseline.
- **pending/sending = 0** (no stuck messages).
- **No Telegram/Webhook/Email test message was sent** (this phase did not send any).
- **Notification = PASS.**

### 7. Unauthorized mutation
- **None.** No code/deploy/config/DNS/route/custom-domain/D1/schema/migration/secret/cron change was made.
- DNS records in `snooze.eu.cc` remain 4; custom domains remain 4 (mydoh/domain-check/kui/domain-monitor).
- Other workers (`mydoh`, `domain-check`, `kui`) untouched.
- Secrets only confirmed **presence** (names `ENCRYPTION_KEY`, `SESSION_SECRET`); values never read/output.
- **No mutation = PASS.**

### 8. Observation limitations (honest)

**Verified:**
- The production custom domain serves HTTP/TLS correctly; D1 is stable; cron fires on `0 * * * *`; worker v16 unchanged; one scheduled invocation was captured with `outcome=ok`, `exceptions=[]`.

**Not observable / not yet occurred (therefore cannot be verified in this phase):**
- **Reminder-window business event.** The only expiration reminder (`snooze.eu.cc`, expiration `2027-07-14`, `days_before=60`) has target date **`2027-05-15`** — **not yet reached** (today is 2026-09). So the natural `Cron → scheduled() → runOnce() → event → delivery → Telegram` chain has **NOT produced a real business event** this phase.
  - The `runOnce` scheduled invocation was **observed as `outcome=ok` with ZERO D1 writes** (`changes=0`, counts unchanged) → **genuine empty run**, no fabricated event.
  - Per the constraint, this is recorded as a **real empty run**, NOT manufactured success.
- **Dedup/idempotency under real reminder load** cannot be demonstrated without a business event; the dedupKey+CAS mechanism was verified in prior prototype testing (14C-23 §10/§12).

---

## 🔒 Step 6 — Cron → runOnce behavior

Natural cron invocation observed (captured by `wrangler tail`):
```
event: {"cron": "0 * * * *", "scheduledTime": 1788285648000}
outcome: ok
exceptions: []
scriptVersion: b08cc17a-8e93-45ff-9d86-4c2490b22bdd
```
- The scheduled handler ran to completion with no exception.
- D1 read-only check immediately after: **counts unchanged** (mig=8, doms=3, ev=11, deliv=11, rules=5, chans=1, secs=1, rems=1, maxev=11, maxdel=11); `changes=0`; delivery `sent=7/failed=4`; pending/sending=0.
- **Conclusion:** `scheduled() → runOnce()` executed as a **genuine empty run** because no domain is inside the current reminder window. No reminder/event was fabricated. When a real reminder becomes due (`2027-05-15`), the chain will be re-evaluated.
- **runOnce = PASS (outcome ok, zero mutation).**

---

## Final Verdict

`PRODUCTION_STABILITY = PASS`

| # | Check | Result |
|---|-------|--------|
| 1 | HTTP (`/`, `/login`, `/setup`) | PASS (307 / 200 / 200, no 5xx) |
| 2 | TLS | PASS (ssl_verify_result=0, TLSv1.3) |
| 3 | Worker runtime | PASS (all invocations outcome=ok, 0 exceptions) |
| 4 | Cron | PASS (`0 * * * *`, v16, no schedule change; scheduled outcome=ok) |
| 5 | D1 | PASS (counts identical to baseline, no growth/dup/backlog) |
| 6 | Notification | PASS (sent=7, failed=4, pending=0, no test sent) |
| 7 | Unauthorized mutation | PASS (none) |
| 8 | Observation limits | Honest: reminder business event NOT yet occurred (empty run only) |

---
*Observation complete — fully read-only. No mutation performed. Documented, then STOP. No automatic advance to any next phase.*
