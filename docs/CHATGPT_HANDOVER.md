# Domain-Monitor — ChatGPT Handover

> Top-level AI handover. Read this first, then the referenced docs. Updated 2026-08-20 for v0.8.8 from the workspace where the project was built, deployed, and tested end-to-end.

## 1. What you are taking over

**Domain-Monitor** — a self-hosted domain lifecycle monitoring platform (RDAP / DNS / SSL / HTTP monitoring, snapshot history, bilingual UI, notification pipeline with telegram/webhook/email delivery, error classification, admin authentication, encrypted secret storage, RDAP fallback ownership semantics, manual expiration & reminders, production worker watchdog). Built through released versions (v0.4.0 → v0.8.8), fully tested (849 tests), and **deployed to production** behind Cloudflare Tunnel on a container.

## 2. Code baseline

- Repository: `https://github.com/hxx0611/Domain-Monitor`
- main HEAD: the **v0.8.8 release commit** (see `git rev-parse origin/main`)
- Release: **v0.8.8 — Domain/DNS Action Coverage, Notification Timezone, Windows CI Fix** (tag `v0.8.8`); **v0.8.3 — Production Worker & Expiration Reminder** (tag `v0.8.3`, preserved); **v0.8.2 — Manual Expiration & Reminders** (tag `v0.8.2`, preserved); **v0.8.1 — RDAP Ownership & Expiration Fixes** (tag `v0.8.1`, preserved); **v0.8.0 — Admin Authentication, Telegram Notifications & Encrypted Secrets** (tag `v0.8.0`, preserved)
- Stack: Next.js 15.5.23 (App Router/Server Actions/RSC) · React 19 · Drizzle ORM 0.44.7 · better-sqlite3 13.0.3 · Node ≥22 · pnpm 11.2.2
- Docs: `docs/PROJECT_HANDOVER.md` (project), `docs/ARCHITECTURE_DECISIONS.md` (why), `docs/DATABASE.md`, `docs/MONITORING.md`, `docs/NOTIFICATIONS.md`, `docs/TESTING.md`

## 3. Production architecture (verified 2026-08-18)

```
Internet → Cloudflare (https://domain-monitor.snooze.eu.cc)
        → Tunnel `domain-monitor` (f24997a3-3ec4-4248-984f-d02ef6129477)
        → 127.0.0.1:3000 → next-server (entrypoint-started, NODE_ENV=production)
        → /tmp/domain-monitor/data/domain-monitor.db (DATABASE_URL)
        → /tmp/domain-monitor/.env (mode 600: DATABASE_URL, ENCRYPTION_KEY, SESSION_SECRET, TELEGRAM_BOT_TOKEN if any)
        → hourly watchdog scripts/worker-watchdog.sh (tsx worker tick, --limit 50)
cloudflared tunnel run domain-monitor (supervisor-managed)
```

- Host: Debian 12 container, **no systemd** — supervisor 4.2.5 manages cloudflared + system services; **domain-monitor itself is started by the container entrypoint** (not supervisor-managed).
- cloudflared 2026.8.2 (watchdog + supervisor dual coverage)
- Details: `docs/DEPLOYMENT_HANDOVER.md`, `docs/OPERATIONS.md`

## 4. Cloudflare architecture

- Zone `snooze.eu.cc`; one DNS record added: CNAME `domain-monitor.snooze.eu.cc` → tunnel
- Tunnel `domain-monitor` (dedicated, created 2026-08-16); **`time machine` tunnel (e71ffcb1-…) is off-limits — never modify it**
- R2 bucket `domain-monitor-backups` (off-site backups, rclone remote `r2`)

## 5. Database

- Production: `/tmp/domain-monitor/data/domain-monitor.db` — 13 tables, 8 migrations (0000–0007), FK on, busy_timeout 5000
- `admin_settings` (1 row, admin initialized), `notification_secrets` (1 row, encrypted Telegram token)
- 3 monitored domains: chatgpt.com, opusai.eu.cc (both `expiration_source = 'rdap'`), snooze.eu.cc (`expiration_source = 'manual'`, expiration 2027-07-14, reminder 60 days); 1 Telegram channel; **5 notification rules** (4 http/ssl + 1 expiration-reminder → Telegram); events/deliveries empty (no real notification has ever been sent); `expiration_reminders` 1 row (snooze.eu.cc / 60 days)
- **Worker enabled in production**: hourly watchdog `scripts/worker-watchdog.sh` (single instance, flock-guarded, direct `tsx` invocation; PID recorded in operations docs)
- Never treat any `/tmp` scratch DB or the repo `data/` DB as production
- Details: `docs/DATABASE.md`

## 6. Backups

- **Production backup IMPLEMENTED (Phase 13C/13C-1, 2026-08-20)**: `scripts/backup-db.js` uses the better-sqlite3 **SQLite online backup API** (consistent snapshot, read-only source) writing to an **NFS persistent directory** (outside the repo, survives container rebuild) with file mode **600**. **Daily schedule** via QwenPaw cron `domain-monitor-daily-backup` (`0 13 * * *` Asia/Shanghai, agent silent). **Retention 7 days** (auto-prune). **Failure** → exit 1 + `backup-failures.log` + **Telegram alert** (timestamp/exit/error only, no secrets). Restore drill PASS. **Backup ≠ primary DB persistence** — the production DB still lives on `/tmp` overlay and is lost on rebuild (restorable from NFS backup).
- Off-site: R2 `daily/` keep 30 — **implemented & verified 2026-08-16** (upload + download-back + integrity + data check all PASS) in the original deployment.
- **Do NOT move the primary DB to NFS** (Phase 13D blocked; NFSv3 `nolock` unsuitable for SQLite locking — see `DISASTER_RECOVERY.md`).
- Recovery: `docs/DISASTER_RECOVERY.md`

## 7. Test status

- **849 passed** (57 files) — includes admin auth (sessions, setup/login/logout/recovery, page/action guards), encrypted secret storage (AES-256-GCM round-trip/upsert/cascade/failure), Telegram token actions (getMe, encrypted save, edit keep-token), Telegram sender secret-resolution E2E (encrypted → env fallback → controlled failure, zero token leakage), **RDAP fallback + ownership** (exact/parent/no-object persistence, canonical-name mismatch, no fallback on network/timeout/429/500), **manual expiration & reminders** (source semantics, manual-vs-RDAP persistence, provider validation, reminder-day normalization, `expiration_reminder` event generation/dedup), **worker runtime + E2E** (barrel-import fix under react-server conditions, event→delivery generation, concurrent-tick dedup / CAS — at most one event, one delivery, one sender invocation), and **domain/DNS action coverage** (Phase 13B: create/update/refreshRdap/delete + admin guards)
- Plus worker CLI 7 + concurrency 15 + scripts smoke 40 + UI smoke + interactive i18n smoke (separate configs; the scripts configs require the `tsx` runtime, which is **installed** in this container since v0.8.3)
- CI: Ubuntu Node 22/24/26 + Windows Node 24 fresh-install guard
- Full commands: `docs/TESTING.md`

## 8. Secrets (v0.8.0 / v0.8.1 / v0.8.2 / v0.8.3 unchanged)

- **`ENCRYPTION_KEY`** (32-byte / 64 hex) — required in production; lives only in `/tmp/domain-monitor/.env` (mode 600). Without it, encrypted notification secrets cannot be decrypted (controlled failure; no plaintext fallback).
- Admin password + recovery code: created by the human operator via `/setup`; **never written to docs/Git/logs**.
- Telegram bot token: entered by the operator in the UI, verified via `getMe`, stored AES-256-GCM encrypted in `notification_secrets`; legacy `TELEGRAM_BOT_TOKEN` env fallback remains for existing deployments.
- Never print or commit any of these.

## 9. Known risks

- **P0**: container rebuild does not auto-start services (platform limitation) — long-term production should move to a persistent host; the Tunnel setup is portable
- **P1**: R2 single copy (no versioning); primary DB on `/tmp` overlay (lost on rebuild; mitigated by daily NFS backup — **backup ≠ persistence**)
- **P2**: `DNS_DOH_ENDPOINT` missing from `.env.example`
- **P3**: SQLite→NFS primary migration **blocked** (Phase 13D); future direction is PostgreSQL or a local persistent volume
- cloudflared token: working GitHub token is the `gh-token.txt`/credential-store pattern established with the operator (`.credentials/github.token` is 403)

## 10. Architecture that must NOT be casually changed

- i18n architecture: cookie `domain-monitor-locale` + Server Action + router.refresh(); no middleware/URL prefixes/next-intl
- Error classification boundary: machine codes only in UI/DB/actions; raw errors only in server logs; `blocked_redirect` never exposes IPs
- Notification semantics: at-least-once, **no automatic retry**, CAS claims, stale recovery, dedup, sender secret handling (encrypted → env fallback → controlled failure) — never weaken
- Auth boundary: scrypt password hashing, HMAC-signed sessions, unified non-enumerating errors; no plaintext secrets in DB
- Snapshot atomicity: DNS failure writes nothing; SSL/HTTP failure writes error snapshot
- SSRF guards in `http/client.ts` and webhook sender — never weaken
- better-sqlite3 v13 + `allowBuilds: false` in `pnpm-workspace.yaml` — do not regress the Windows-install fix
- `127.0.0.1:3000` binding; entrypoint start for the app; supervisor config for cloudflared; Tunnel/DNS for `domain-monitor`

## 11. Unfinished items

- ~~Re-establish scheduled local backups in the current container~~ → **DONE (Phase 13C/13C-1)** — daily NFS backup + retention + failure alert live
- R2 Object Versioning (recommended, dashboard action)
- ~~Backup failure alerting~~ → **DONE (Phase 13C-1)** — failure → Telegram alert
- Container-rebuild auto-start (needs platform support or host migration)
- `.env.example` should document `DNS_DOH_ENDPOINT` and `ENCRYPTION_KEY` (doc-only change, needs approval)
- **Migration journal bookkeeping for 0007 was repaired in v0.8.3 (Phase 11E)** — journal `idx: 7` + `0007_snapshot.json` + production `__drizzle_migrations` registration; no further journal work scheduled
- **Future DB persistence direction (Phase 13D)**: PostgreSQL or a local persistent volume; NFSv3 `nolock` is **not** suitable for the SQLite primary DB

## 12. Suggested next steps

1. Run the full test suite + CI check (see TESTING.md) to establish a fresh baseline
2. Re-establish scheduled backups; decide R2 versioning
3. If longer-term production is wanted, plan migration to a persistent VPS/host reusing the same Tunnel (cloudflared credentials must be copied by the human)

## 13. Common troubleshooting path

- Site down but local 200 → `cloudflared tunnel info domain-monitor`, tunnel logs
- Local down → check the `next-server` process (entrypoint-started), `/tmp/domain-monitor` logs
- `/setup` redirects when already configured → the app requires login; `admin_settings` has 1 row
- Telegram channel shows "Token not configured" → re-enter the token via the channel Edit form (getMe-verified, encrypted)
- Domain shows a monitoring error → read `[dns]/[ssl]/[http] check failed` line in the error log, map code via `docs/MONITORING.md`
- `ssl_dns_failed` / `http_dns_failed` → the domain doesn't resolve publicly (check with dig/DoH) — not an app bug
- Backup issues → R2/off-site logs (no scheduled local backup in current container)

---

## AI CONTINUATION RULES

1. **Do not guess production state.** Verify with commands (git, ps, ss, sqlite3) before claiming anything about the running system.
2. **Do not assume Cloudflare configuration.** Confirm with `cloudflared tunnel list/info` and never invent DNS/Tunnel facts.
3. **Never modify the `time machine` Tunnel** (`e71ffcb1-5756-44eb-a060-31e053bfbae3`) — no stop/delete/route/config changes, ever.
4. **Do not change the production DB schema or migrations** without explicit approval. Migration files 0000–0006 are frozen.
5. **Do not change notification semantics** (at-least-once, no auto-retry, CAS, stale recovery, dedup, sender secret handling) without explicit approval.
6. **Never leak secrets**: no tokens, keys, passwords, recovery codes, credentials in docs, terminal output, reports, or commits. Credentials map only as CONFIGURED/NOT CONFIGURED + file path.
7. **Audit before modifying.** For any feature work: read the affected modules + docs, produce a READ-ONLY audit, STOP, wait for approval.
8. **Production operations start READ ONLY.** Any change to running services/DB/Tunnel/DNS/backups requires explicit human approval first.
9. **Follow the Phase / STOP / GO protocol.** Every version and every deployment phase ends with STOP and a report; never skip gates.
10. **Git commits/tags/releases require human approval.** No commit, push, tag, or GitHub Release without explicit instruction.
11. **Never treat the test DB as production** (`/tmp/dm-e2e.db`, repo `data/`, any temp DB). Production is `/tmp/domain-monitor/data/domain-monitor.db`.
12. **Never treat the Cloudflare Tunnel as the application** — the app is next-server on 127.0.0.1:3000; the tunnel is transport.
13. **Never treat GitHub status as production status** — code green ≠ deployed green. Verify the running instance.
14. When in doubt: **STOP and ask** the human.
