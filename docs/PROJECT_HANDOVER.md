# Domain-Monitor — Project Handover

> AI-to-AI handover. Updated 2026-08-19 for v0.8.3. GitHub `hxx0611/Domain-Monitor` is the **source of truth for code**; this document describes the project, its architecture, and how to continue working on it safely.

## Project overview

**Domain-Monitor** is a self-hosted domain lifecycle monitoring platform:

- Manage monitored domains in one place (self-hosted, local SQLite storage)
- RDAP enrichment on creation (registrar, expiry, nameservers, status; IANA bootstrap, 590+ TLDs)
- **DNS monitoring** via DNS-over-HTTPS (7 record types: A/AAAA/CNAME/MX/NS/TXT/CAA)
- **SSL/TLS monitoring** (leaf certificate extraction, expiry/hostname classification)
- **HTTP health checks** (status code, response time, redirects, SSRF-guarded)
- **Snapshot history** per module with change detection
- **Notification pipeline** (V0.6+): events → rules → deliveries → telegram/webhook/email senders, at-least-once
- **Delivery worker** (V0.7): single-tick `runOnce` CLI, CAS-claimed deliveries, stale recovery
- **Bilingual UI** (V0.7.1): English / Simplified Chinese, cookie-based locale
- **Monitoring error classification** (V0.7.3): stable machine codes + localized messages
- **Admin authentication** (V0.8.0 / Phase 9E): setup wizard, login/logout, recovery code, protected pages & Server Actions
- **Encrypted secret storage** (V0.8.0 / Phase 9F): AES-256-GCM encrypted notification secrets (`ENCRYPTION_KEY`)
- **Telegram channel + configuration UI** (V0.8.0 / Phases 9G–9H): channel/rule CRUD, getMe token verification, sender secret resolution with legacy env fallback
- **RDAP fallback + ownership semantics** (V0.8.1 / Phases 10A–10E): registered-domain fallback only on `not-found` / no-expiration (never on network/timeout/429/500), bare TLD never queried; results carry `ownership` (`exact`/`parent`) decided from the RDAP object's canonical identity; parent data is never stored on the child's fields (child marked `rdap_status = ["no-object"]`, UI shows `Unavailable`); production data affected by the old fallback was repaired through the normal Refresh flow
- **Manual expiration & reminders** (V0.8.2 / Phase 11A): `expiration_source` (`rdap` default / `manual`), manual registration date / expiration date / registration platform (validated presets + custom HTTPS URL) / management URL; manual dates are never overwritten by RDAP refreshes; per-domain `expiration_reminders` (unique domain+days) evaluated by the worker as `expiration_reminder` events (source `expiration`)
- **Production Worker enablement** (V0.8.3 / Phase 11D): hourly watchdog (`scripts/worker-watchdog.sh`, single-instance flock, direct `tsx` invocation) runs the worker every hour; two worker runtime defects fixed (senders factory barrel import crashed under react-server/production conditions; `expiration_reminder` events did not generate deliveries — now `insertEventsAndGenerateDeliveries` creates event+deliveries together); concurrent-tick E2E (dedup key UNIQUE, delivery UNIQUE(event_id, channel_id), CAS) guarantees at most one event / delivery / sender invocation per reminder per day
- **Migration journal repair** (V0.8.3 / Phase 11E): `0007_manual_expiration` (Phase 11A) was applied to production manually but never registered in `_journal.json`; Phase 11E repaired the bookkeeping — journal `idx: 7` added, `0007_snapshot.json` generated, production `__drizzle_migrations` registered with the migration hash, and a fresh `0000 → 0007` migration verified (no re-execution of 0007)

## Current version

- **v0.8.3 — Production Worker & Expiration Reminder** (release over v0.8.2)
- Git commit: see `git rev-parse HEAD` / `origin/main` (release commit for v0.8.3)
- GitHub Release: **v0.8.3** (tag `v0.8.3`); **v0.8.2 / v0.8.1 / v0.8.0 tags and releases preserved**
- The `v0.7.3` tag still points at `fe4b704` (never moved); **no v0.7.3 GitHub Release was ever published** — the v0.7.2/v0.7.3 eras exist only as git tags/commits.

## Tech stack

| Layer     | Choice                                                               | Notes                                                               |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Framework | Next.js **^15.5.23**                                                 | App Router, Server Actions, RSC, `force-dynamic` pages              |
| UI        | React ^19.2.8                                                        | Client components only where needed (buttons, language switcher)    |
| ORM       | drizzle-orm **^0.44.7**                                              | better-sqlite3 driver (sync); `drizzle-kit` ^0.31.10 for migrations |
| DB        | **better-sqlite3 ^13.0.3**                                           | N-API prebuilds, no node-gyp; SQLite file                           |
| Runtime   | Node **>=22** (22/24/26 CI-verified; pnpm 11.2.2 via packageManager) | engines in package.json                                             |
| i18n      | Hand-rolled dictionary + cookie                                      | No next-intl, no middleware, no URL prefixes                        |
| Auth      | Node built-in `crypto` (scrypt + HMAC-SHA256)                        | Signed session cookie, no third-party auth                          |
| Secrets   | AES-256-GCM via Node `crypto`                                        | `ENCRYPTION_KEY` env; `iv:tag:ciphertext` in DB                     |
| Tests     | vitest ^4.1.10                                                       | 763 tests / 51 files                                                |

## Directory structure (src/)

```
src/
  app/                    # App Router pages (/, /domains/[id], /notifications, /setup, /login, /recover)
  components/             # Server + client components (buttons, language switcher, tables, auth forms, channel/rule forms)
  db/                     # schema.ts, index.ts (better-sqlite3 init), migrations/ (0000-0007)
  lib/
    auth/                 # session signing/verification, scrypt password hashing, recovery codes, page/action guards
    domains/              # domain CRUD + RDAP enrichment (actions/repository/validation)
    dns/                  # DoH client, normalize, diff, repository, service, actions
    ssl/                  # tls client, normalize, diff, repository, service, actions
    http/                 # fetch client + SSRF guards, normalize, repository, service, actions
    rdap/                 # IANA bootstrap + RDAP client
    i18n/                 # config (cookie/locale), en.ts, zh-CN.ts, index (server), display (client-safe), actions
    monitoring/           # error-classifier.ts (V0.7.3) — pure mapping to machine codes
    notifications/        # events, rules, repository, service, worker, senders (telegram/webhook/email), encryption.ts, secrets.ts, telegram-actions.ts
    format.ts             # locale-aware date formatting
scripts/                  # worker.ts (CLI), worker-proc.ts (test helper), smoke tests, vitest phase configs
test/                     # vitest helpers, server-only stub
```

## Core modules

- **RDAP**: fetched once at domain creation (best-effort; failure never blocks creation), stored on `domains` row; manual refresh available.
- **DNS**: 7 record types queried in parallel over DoH (`DNS_DOH_ENDPOINT` or default Cloudflare). Any type failure fails the whole check and **writes no snapshot** (atomicity). NXDOMAIN (DoH status 3) is a _successful_ query returning zero/partial records — never an error.
- **SSL**: `tls.connect(host, 443, {rejectUnauthorized:false})`, reads leaf X509 certificate, normalizes (fingerprint/subject/issuer/SAN/validity), classifies ok / expires_soon / expired / mismatch / error. TLS failure writes an **error snapshot** (preserves prior certificate).
- **HTTP**: GET `https://<host>/` with manual redirects; every hop re-validated (DNS resolve → IP classification); SSRF guards in `src/lib/http/client.ts` (blocked IP ranges incl. loopback/private/CGNAT/link-local/cloud-metadata). Failure writes an **error snapshot**.
- **Notifications** (V0.6–V0.8): unified event stream with dedup keys; rules map events → channels; deliveries claim via CAS (`pending→sending`); senders are webhook (SSRF-guarded, secretRef), email (apiKeyRef), and **telegram** (token resolved from encrypted store → `TELEGRAM_BOT_TOKEN` env fallback → controlled failure); at-least-once, **no automatic retry**.
- **Admin auth** (V0.8.0): `/setup` creates the scrypt-hashed password + one-time recovery code; sessions are HMAC-SHA256 signed cookies; password recovery rotates the session secret; `requirePageAccess` / `requireAdmin` guard pages and Server Actions.
- **Secret storage** (V0.8.0): `encryptSecret`/`decryptSecret` (AES-256-GCM, `iv:tag:ciphertext`); `upsertSecret` per `(channel_id, key)` with FK cascade; `ENCRYPTION_KEY` env required in production (dev persists a generated key).
- **Telegram token UI** (V0.8.0): `verifyTelegramTokenAction` calls Telegram `getMe` server-side; `saveTelegramChannelAction` encrypts the token into `notification_secrets`; edit mode keeps the existing token when the field is left blank.
- **Delivery worker** (V0.7 / V0.8.3): `pnpm worker` runs one `runOnce` tick (limit 50), recovers stale `sending` rows, claims pending deliveries, sends, marks sent/failed. No daemon. Scheduling is external: `scripts/worker-watchdog.sh` (V0.8.3) runs it hourly in production (flock-guarded single instance, direct `./node_modules/.bin/tsx --conditions=react-server scripts/worker.ts --limit 50`, no `pnpm`-on-`PATH` dependency; failure of one tick is logged and the loop continues; `TERM`/`INT` exit cleanly).
- **i18n** (V0.7.1): cookie `domain-monitor-locale` (en/zh-CN, default en) + Server Action `setLocaleAction` + `router.refresh()`. Machine values are never translated; display layer maps codes → labels.
- **Error classification** (V0.7.3): `error-classifier.ts` maps transport codes → prefixed stable codes; raw messages stay in server logs only.

## Server Actions

`src/lib/{auth,domains,dns,ssl,http,notifications,i18n}/actions.ts` — `"use server"` modules:

- `setupAdminAction` / `loginAction` / `logoutAction` / `recoverAction` (auth)
- `createDomainAction` / `deleteDomainAction` / `refreshRdapAction`
- `checkDnsAction` / `checkSslAction` / `checkHttpAction` (return `{ok, error?, errorCode?}`)
- `createChannelAction` / `updateChannelAction` / `deleteChannelAction` / `toggleChannelAction` / `createRuleAction` / `updateRuleAction` / `deleteRuleAction` / `toggleRuleAction` / `verifyTelegramTokenAction` / `retryDeliveryAction`
- `setLocaleAction`
- All mutating actions require an authenticated admin session; actions revalidate `/`, `/domains/[id]`, `/notifications`; errors are user-safe strings + machine `errorCode`.

## Database

- SQLite file (default `./data/domain-monitor.db`, overridable via `DATABASE_URL`; production = `/tmp/domain-monitor/data/domain-monitor.db`).
- 13 tables, 8 migrations (`src/db/migrations/0000…0007`), drizzle `__drizzle_migrations` journal (8 rows — including 0007, registered during Phase 11E journal repair).
- FK constraints ON (`ON DELETE CASCADE` for snapshots/records, channels → secrets); `busy_timeout = 5000` for the dual-process (server + worker) writes.
- See `DATABASE.md`.

## Monitoring details

- See `MONITORING.md` for per-module semantics and the full V0.7.3 error-code table.

## SSRF security model

- HTTP client: hostname only from stored domains; `assertSafeHost` resolves DNS and blocks any reserved/private/loopback/CGNAT/link-local/metadata IP on the initial hop **and every redirect hop**; manual redirects (max 5); https-only; same-host redirect policy.
- Webhook sender reuses the same guards for user-configured URLs.
- `blocked_redirect` surfaces only the machine code to clients; the raw message (which may contain a resolved address) stays in server logs.

## Test architecture

- 763 unit/integration tests (vitest, Node env, `src/**/*.test.ts`); worker CLI (7), worker concurrency (15), scripts smoke (40) run via separate configs; UI smoke and interactive i18n smoke run against a real `next start` + temp DB.
- CI (GitHub Actions): Ubuntu matrix Node 22/24/26 (install/lint/test/format/build) + `windows-fresh-install` job (Node 24) guarding against native-build regressions.

## Known limitations

- Container has **no systemd** (PID 1 = docker-init); supervisor manages cloudflared and system services, but **domain-monitor is started by the container entrypoint** (not supervisor-managed in the current container — `supervisorctl` cannot restart it; restart = `kill` + entrypoint/manual `next start` or a full container restart).
- The scheduled backup cron/script from earlier handovers is **not present** in the current container (see `DATABASE.md`).
- Production DB and backups live under `/tmp/domain-monitor` (current container); `DATABASE_URL` points there.
- `DNS_DOH_ENDPOINT` is read from env but not listed in `.env.example` (doc gap).
- Node 25 is not an officially supported version (works via N-API prebuilds, but CI tests 22/24/26 only).
