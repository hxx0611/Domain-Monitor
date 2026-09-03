# Phase 14C-5 — Node → Cloudflare Parity Matrix

Legend: **PASS** = implemented & verified on the Cloudflare path (local/dev or
correctness-verified prototype). **PARTIAL** = works for some sub-capability,
not a drop-in for the full Node capability. **BLOCKED** = cannot be implemented
or verified under current constraints. **NODE_ONLY** = only available via the
Node self-hosted runtime.

| # | Capability | Node (source of truth) | Cloudflare Worker | Status |
|---|-----------|------------------------|-------------------|--------|
| 1 | Domains (CRUD + list) | better-sqlite3 repo | D1 repo (getRepository → D1 adapter) | **PASS** |
| 2 | RDAP lookup (expiration/registrar/nameservers) | node fetch + RDAP | fetch works in Worker | **PASS** |
| 3 | Manual expiration (override) | repo update / 0007 | D1 adapter | **PASS** |
| 4 | DNS snapshots + records | node:dns + snapshots | fetch-in-Worker; dns records via external? | **PARTIAL** |
| 5 | HTTP snapshots (status/availability) | node fetch | fetch works in Worker | **PASS** |
| 6 | SSL certificate monitoring | node:tls + getPeerX509Certificate | **NOT possible** (getPeerX509Certificate not implemented) | **PARTIAL (TLS reachability only)** |
| 7 | Reminders (scheduled evaluation) | Node cron/scheduler | Cloudflare `scheduled()` prototype | **PASS (prototype)** |
| 8 | Events (dedup + persistence) | repo event insert + dedup_key | D1 repo | **PASS** |
| 9 | Deliveries (status, attempts, CAS claim) | repo delivery + CAS | D1 repo + CAS | **PASS** |
| 10 | CAS (claim-once concurrency) | repo transaction | D1 batch/atomic | **PASS** |
| 11 | Dedup (dedup_key, no duplicate events) | repo unique constraint | D1 UNIQUE | **PASS** |
| 12 | Telegram send (bot API) | fetch → api.telegram.org | fetch → endpoint (fake in prototype) | **PASS** |
| 13 | Webhook send | fetch | fetch | **PASS** |
| 14 | Email send (SMTP) | smtp client | **NO SMTP (limited)** — external service req | **NODE_ONLY** |
| 15 | Admin (auth/session, settings) | Node session + admin-db | Worker (D1 admin_settings) | **PARTIAL** |
| 16 | Secrets (AES-256-GCM encryption) | crypto in Node | Web Crypto (AES-GCM) in Worker | **PASS** |
| 17 | Scheduler (cron trigger) | Node cron | Cloudflare Cron Trigger | **PASS (prototype) / Production Cron NOT DEPLOYED** |

## Detailed notes

### SSL (item 6) — PARTIAL
Empirically verified in workerd `nodejs_compat`:
- `tls.connect(host, 443)` **completes** the TLS handshake (`secureConnect: true`,
  `encrypted: true`) — so the Worker CAN report TLS **reachability**.
- `socket.getPeerX509Certificate()` **throws** `TLSSocket.getPeerX509Certificate
  is not implemented`.
- `socket.getProtocol()` returns `"n/a"` (not implemented).
- `rejectUnauthorized` option **throws** `... is not implemented`.

Therefore: certificate `subject`, `issuer`, `validTo` (**expiry**), `validFrom`,
`serialNumber`, `subjectAltName` (SAN), `fingerprint256`, `ca` (self-signed),
`checkHost()` (hostname mismatch) are **ALL UNAVAILABLE** in the Worker.

**Decision: SSL Worker capability = PARTIAL** (TLS reachability only). The Node
SSL monitor is NOT deleted and remains the source of truth for certificate
validity classification (expired / expires_soon / mismatch / self-signed).

### Scheduler (item 17) — PASS (prototype) / Production Cron NOT DEPLOYED
The `scheduled()` prototype (verified in the 14C-5 scheduled gate) calls
`runOnce` with the D1 repo and an explicit `senders: (type) => createSender(type,
repo, env)` factory. Repeated ticks produce NO duplicate event/delivery. The
Worker `scheduled()` shape is validated in workerd.

However the **production Cron Trigger is NOT DEPLOYED** (14C-5 HARD STOP forbids
deployment). So:
- `Cloudflare scheduled() = PASS (prototype)`
- `Production Cron Trigger = NOT DEPLOYED`
Do NOT conflate these.

### Email (item 14) — NODE_ONLY
The Worker runtime has no built-in SMTP client that can reliably connect and
authenticate to arbitrary SMTP providers with TLS the way `nodemailer`/SMTP
does in Node. Email delivery on Cloudflare requires an external email service
(Resend, SendGrid, MailChannels, etc.) via fetch. The Node SMTP path remains
the local/self-hosted source of truth.

### Admin (item 15) — PARTIAL
The D1 `admin_settings` table and session/auth repository are implemented
(verified in 14C-3), but full admin flows (session signing secret rotation,
cookie handling, rate-limit, CSRF) that rely on Node's `crypto`/session runtime
need to be re-validated end-to-end on the Worker. Marked PARTIAL, not BLOCKED.

### DNS (item 4) — PARTIAL
DNS record snapshotting in Node uses `node:dns` (resolve4/6, NS, MX, TXT) and
stores snapshots. In a Worker, DNS resolution against the public resolver is
limited; doh/DoH-over-HTTPS would be needed. Marked PARTIAL.
