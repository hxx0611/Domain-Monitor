# Phase 14C-25 — Formal DNS / Traffic Cutover Preflight

**Status:** PREFLIGHT (read-only audit only — NO mutation performed)
**Date:** 2026-09-01 (Shanghai)
**Worker:** `domain-monitor` (production) — v16 / `b08cc17a-8e93-45ff-9d86-4c2490b22bdd`

> ⚠️ **BLOCKER — DNS Read Permission Missing**
> The current token (`cf_d1_token.txt`) has **no `Zone:DNS:Read`** permission.
> `GET /zones/{zone}/dns_records` returns `Authentication error (code 10000)` on
> every zone (`snooze.eu.cc`, `cncn.qzz.io`, `opusai.eu.cc` all tested).
> **Consequence:** Existing DNS records inside the zone **cannot be read** via API.
> This phase therefore:
>   - CANNOT fully audit internal DNS-record conflict (only external DoH was used as
>     a partial substitute — see Section 5).
>   - CANNOT enumerate records that need to be changed.
>   - No DNS records were created / modified / deleted (read-only respected).

---

## 1. Account / Identity

| Item | Value |
|------|-------|
| Account ID | `b9dd2cfed5f3bbf704ec62466fe761d6` |
| Workers.dev subdomain | `1439343758` |
| Production token | `cf_d1_token.txt` (Workers Scripts Write + Zone read-partial; **no DNS read**) |
| Token status | `active` (verified via `/tokens/verify`) |

## 2. Worker Inventory (5 workers in account)

| Worker | Modified | Custom Domains | Cron Schedules |
|--------|----------|----------------|----------------|
| `domain-monitor` | 2026-08-31T17:01Z | **0** | `0 * * * *` |
| `domain-check`    | 2026-07-18T16:33Z | `dc.snooze.eu.cc` | `0 8 * * *` |
| `kui`             | 2026-08-01T06:42Z | `kui.cncn.qzz.io` | — |
| `mydoh`           | 2026-07-07T16:07Z | `api.cncn.qzz.io` | — |
| `odd-bonus-eae5`  | 2026-03-28T04:43Z | — | — |

**Key:** `domain-monitor` currently has **ZERO custom domains** — only the
`workers.dev` subdomain (`domain-monitor.1439343758.workers.dev`), which is
**broken at the account entry layer** (HTTP 500 / error 1101, observed in prior phases).

## 3. Production `domain-monitor` — Current State

| Item | Value | Source |
|------|-------|--------|
| Worker version (active) | `b08cc17a-8e93-45ff-9d86-4c2490b22bdd` (**v16**) | versions API |
| Version history | n=16 (b08cc17a), n=15 (c8c06cfc), n=14 (4607714e) | versions API |
| Cron trigger | `{"cron": "0 * * * *", created_on: 2026-08-31T17:01:39Z}` | schedules API |
| D1 binding | `domain-monitor` (id `4437f46a-632d-4dfa-aba0-4c5bc41fa64d`) | wrangler.prod.jsonc |
| Secrets (names only) | `ENCRYPTION_KEY`, `SESSION_SECRET` | `wrangler secret list` |
| Observability | enabled | wrangler.prod.jsonc |
| Migration | 0000–0007 (mig count=8) | D1 read |
| Runtime isolation | Cloudflare=D1Repository, Node=SQLiteRepository | code audit |

### D1 baseline (read-only, 2026-09-01 06:52 UTC)
`mig=8 · events=11 · deliveries=11 · domains=3 · channels=1 · secrets=1 · reminders=1`

Delivery status distribution: `sent=7`, `failed=4` — no pending/sending rows.

## 4. Zone Candidates (account has 10 zones, 3 relevant)

| Zone | ID | Status | Plan | Type | NS (Cloudflare?) |
|------|-----|--------|------|------|------------------|
| `snooze.eu.cc` | `399717b0e94a897342e00d204f3e616e` | active | Free | full | `fiona.cloudflare / venkat.cloudflare` ✅ |
| `cncn.qzz.io` | `064c506f5477c2d4c869daa4d70ff1c6` | active | Free | full | — |
| `opusai.eu.cc` | `947a78e4a9a51d7300f6ed85e301b8c3` | active | Free | full | — |

**`snooze.eu.cc` is fully-proxied to Cloudflare (NS = Cloudflare), type=full, plan=Free, not paused.**
→ No external nameserver change needed — Workers Custom Domain will manage DNS + certificate.

## 5. External DoH DNS Reality Check (since internal DNS read is blocked)

Queried via public Cloudflare DoH (`https://cloudflare-dns.com/dns-query`):

| Hostname | Result |
|----------|--------|
| `snooze.eu.cc` (apex) | No A record (status 0, count 0) |
| `dc.snooze.eu.cc` | **IN USE** — 2 A records (172.67.216.48, 104.21.43.23) — bound `domain-check` |
| `monitor.snooze.eu.cc` | **NXDOMAIN** (status 3) — free / clean |
| `dm.snooze.eu.cc` | **NXDOMAIN** (status 3) — free / clean |

## 6. Recommended Formal Hostname

**`monitor.snooze.eu.cc`** — rationale:
- Located in `snooze.eu.cc` (the zone already used by `domain-monitor` in 14C-21/22/23 smoke tests).
- **NXDOMAIN today (status 3)** → no conflict with any existing record we can observe.
- Distinct from `dc.snooze.eu.cc` (already taken by `domain-check`).
- Within a Cloudflare-full, active, Free-plan zone → zero external nameserver changes.

**Fallback candidates:** `dm.snooze.eu.cc` (also NXDOMAIN) — but `monitor.` is more semantic.

## 7. Recommended Cloudflare Attachment Method

**Workers Custom Domain** — `PUT /accounts/{acc}/workers/domains` (already validated PASS in 14C-21/22/23):
- Cloudflare auto-creates the DNS record + issues/provisions the certificate (TLS).
- No manual DNS edit, no external nameserver change (zone already on Cloudflare NS).
- Requires token permission `Workers Scripts Write` (available) + **`Zone:DNS:Edit`** (MUST be granted — see blocker).

## 8. DNS / Route / Custom Domain Change Items (FOR THE CUTOVER PHASE — NOT DONE HERE)

> Requires `Zone:DNS:Edit` permission added to the token first. Listed as the plan.

1. **Add Custom Domain** on the production `domain-monitor` worker:
   `PUT /accounts/{acc}/workers/domains` → `{hostname: "monitor.snooze.eu.cc", service: "domain-monitor", environment: "production"}`
2. Cloudflare will **auto-create** the DNS record for `monitor.snooze.eu.cc` (A/AAAA proxied) + issue TLS cert.
3. (Optional / recommended) **Delete the lingering broken workers.dev entry** — not required; do NOT delete anything unless authorized.
4. **No change** to outside nameservers (snooze.eu.cc already full-proxied).
5. **No change** to existing `dc.snooze.eu.cc` (belongs to `domain-check`), `api.cncn.qzz.io` (mydoh), `kui.cncn.qzz.io` (kui).

## 9. Complete Rollback Method

If the Custom Domain cutover fails / must be reverted (only to be executed on Cutover authorization):

1. **Remove the Custom Domain:**
   `DELETE /accounts/{acc}/workers/domains/{domain_id}` (where `domain_id` = the id of the newly attached `monitor.snooze.eu.cc`).
   - This deletes the Worker custom-domain mapping. Cloudflare will remove the auto-created DNS record + the cert stays valid until re-issued (associated cert may be cleaned up).
2. **DNS rollback (if a manual record was created):** delete the A/AAAA record created by Cloudflare for `monitor.snooze.eu.cc`:
   `DELETE /zones/{zone_id}/dns_records/{record_id}` — requires `Zone:DNS:Edit`.
3. **Worker version rollback (no runtime change):** the Worker code/version is NOT changed by a custom-domain attach. The v16 bundle remains. If a *code* issue arises unrelated to DNS, use `wrangler versions list` + `wrangler rollback <version-id>` — but this is a separate concern.
4. **Everything else stays untouched:** D1 schema/data, secrets, cron, other workers.

**Pre-Cutover snapshot to restore from (if needed):**
- Custom domains BEFORE cutover = `api.cncn.qzz.io`, `dc.snooze.eu.cc`, `kui.cncn.qzz.io` (none bound to `domain-monitor`).
- `monitor.snooze.eu.cc` was NXDOMAIN before cutover.

## 10. Post-Cutover Smoke Checklist

After the Custom Domain is attached (Cutover phase):

- [ ] `wrangler domains` / `GET /accounts/{acc}/workers/domains` shows `monitor.snooze.eu.cc` bound to `service=domain-monitor`, `enabled=true`.
- [ ] TLS certificate provisioned: `cert_id` present, no `pending` state.
- [ ] External DoH: `monitor.snooze.eu.cc` resolves to Cloudflare proxy IPs (no longer NXDOMAIN).
- [ ] `curl https://monitor.snooze.eu.cc/` → HTTP 307 (redirect to /login) — NOT the broken workers.dev 500/1101.
- [ ] `curl https://monitor.snooze.eu.cc/login` → HTTP 200 (renders login).
- [ ] `curl https://monitor.snooze.eu.cc/setup` → reachable (or appropriate response).
- [ ] Admin login flow works (POST credentials — verify after auth, no secrets in URIs).
- [ ] `/notifications` returns 307 → /login when unauthenticated.
- [ ] Authenticated `/notifications`, `/domains` render without 500.
- [ ] Cron `0 * * * *` still scheduled, `outcome=ok` in tail (no regression).
- [ ] D1 baseline unchanged (events=11, deliveries=11, domains=3) after smoke (no unexpected mutations).
- [ ] Any warm-up HTTP request against the custom domain does **not** produce an expiration event (no fabrication).
- [ ] Confirm the `workers.dev` 500/1101 is bypassed (traffic now via custom domain, not workers.dev).

## 11. Known Blockers / Risks To Flag

1. **BLOCKER (critical): `Zone:DNS:Read` + `Zone:DNS:Edit` are missing** from the token.
   - Without DNS Read: cannot audit internal DNS conflicts / enumerate existing records.
   - Without DNS Edit: **cannot attach a Custom Domain** (Workers Custom Domain requires DNS permission) and **cannot rollback** a DNS record.
   - → **The Cutover phase (14C-26+) cannot proceed until the token is granted `Zone:DNS:Edit` (and ideally `Zone:DNS:Read`).** Recommend rotating/regenerating the token with the required scopes well before cutover.

2. **workers.dev is broken** (account-level entry error, HTTP 500 / 1101). All public access must go through a Custom Domain; the broken workers.dev should not be used as a fallback.

3. **`snooze.eu.cc` is a Free plan zone** — no guaranteed SLA / no advanced features. Acceptable for monitoring tool, but note plan limits.

4. **Custom Domain cert provisioning** on Free plan may take a short time; smoke test should tolerate a brief `pending` TLS state.

---
*Preflight complete — read-only only. No DNS record, route, custom domain, worker, D1, secret, or notification was created/modified/deleted. STOP for explicit Cutover authorization.*
