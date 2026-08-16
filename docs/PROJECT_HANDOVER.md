# Domain-Monitor — Project Handover

> AI-to-AI handover. Written 2026-08-16. GitHub `hxx0611/Domain-Monitor` is the **source of truth for code**; this document describes the project, its architecture, and how to continue working on it safely.

## Project overview

**Domain-Monitor** is a self-hosted domain lifecycle monitoring platform:
- Manage monitored domains in one place (self-hosted, local SQLite storage)
- RDAP enrichment on creation (registrar, expiry, nameservers, status; IANA bootstrap, 590+ TLDs)
- **DNS monitoring** via DNS-over-HTTPS (7 record types: A/AAAA/CNAME/MX/NS/TXT/CAA)
- **SSL/TLS monitoring** (leaf certificate extraction, expiry/hostname classification)
- **HTTP health checks** (status code, response time, redirects, SSRF-guarded)
- **Snapshot history** per module with change detection
- **Notification pipeline** (V0.6+): events → rules → deliveries → webhook/email senders, at-least-once
- **Delivery worker** (V0.7): single-tick `runOnce` CLI, CAS-claimed deliveries, stale recovery
- **Bilingual UI** (V0.7.1): English / Simplified Chinese, cookie-based locale
- **Monitoring error classification** (V0.7.3): stable machine codes + localized messages

## Current version

- **v0.7.3 — Monitoring Error Clarity** (latest release)
- Git commit: `fe4b70450c9c9e701eca982ab93a5b1798837a16` (main HEAD == tag v0.7.3)
- GitHub Release: `V0.7.3 — Monitoring Error Clarity`

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js **^15.5.23** | App Router, Server Actions, RSC, `force-dynamic` pages |
| UI | React ^19.2.8 | Client components only where needed (buttons, language switcher) |
| ORM | drizzle-orm **^0.44.7** | better-sqlite3 driver (sync); `drizzle-kit` ^0.31.10 for migrations |
| DB | **better-sqlite3 ^13.0.3** | N-API prebuilds, no node-gyp; SQLite file |
| Runtime | Node **>=22** (22/24/26 CI-verified; pnpm 11.2.2 via packageManager) | engines in package.json |
| i18n | Hand-rolled dictionary + cookie | No next-intl, no middleware, no URL prefixes |
| Tests | vitest ^4.1.10 | 501 tests |

## Directory structure (src/)

```
src/
  app/                    # App Router pages (/, /domains/[id], /notifications)
  components/             # Server + client components (buttons, language switcher, tables)
  db/                     # schema.ts, index.ts (better-sqlite3 init), migrations/ (0000-0005)
  lib/
    domains/              # domain CRUD + RDAP enrichment (actions/repository/validation)
    dns/                  # DoH client, normalize, diff, repository, service, actions
    ssl/                  # tls client, normalize, diff, repository, service, actions
    http/                 # fetch client + SSRF guards, normalize, repository, service, actions
    rdap/                 # IANA bootstrap + RDAP client
    i18n/                 # config (cookie/locale), en.ts, zh-CN.ts, index (server), display (client-safe), actions
    monitoring/           # error-classifier.ts (V0.7.3) — pure mapping to machine codes
    notifications/        # events, rules, repository, service, worker, senders (email/webhook)
    format.ts             # locale-aware date formatting
scripts/                  # worker.ts (CLI), worker-proc.ts (test helper), smoke tests, vitest phase configs
test/                     # vitest helpers, server-only stub
```

## Core modules

- **RDAP**: fetched once at domain creation (best-effort; failure never blocks creation), stored on `domains` row; manual refresh available.
- **DNS**: 7 record types queried in parallel over DoH (`DNS_DOH_ENDPOINT` or default Cloudflare). Any type failure fails the whole check and **writes no snapshot** (atomicity). NXDOMAIN (DoH status 3) is a *successful* query returning zero/partial records — never an error.
- **SSL**: `tls.connect(host, 443, {rejectUnauthorized:false})`, reads leaf X509 certificate, normalizes (fingerprint/subject/issuer/SAN/validity), classifies ok / expires_soon / expired / mismatch / error. TLS failure writes an **error snapshot** (preserves prior certificate).
- **HTTP**: GET `https://<host>/` with manual redirects; every hop re-validated (DNS resolve → IP classification); SSRF guards in `src/lib/http/client.ts` (blocked IP ranges incl. loopback/private/CGNAT/link-local/cloud-metadata). Failure writes an **error snapshot**.
- **Notifications** (V0.6): unified event stream with dedup keys; rules map events → channels; deliveries claim via CAS (`pending→sending`); senders are webhook (SSRF-guarded, secretRef) and email (apiKeyRef); at-least-once, **no automatic retry**.
- **Delivery worker** (V0.7): `pnpm worker` runs one `runOnce` tick (limit 50), recovers stale `sending` rows, claims pending deliveries, sends, marks sent/failed. No daemon; scheduling is external (cron).
- **i18n** (V0.7.1): cookie `domain-monitor-locale` (en/zh-CN, default en) + Server Action `setLocaleAction` + `router.refresh()`. Machine values are never translated; display layer maps codes → labels.
- **Error classification** (V0.7.3): `error-classifier.ts` maps transport codes → prefixed stable codes; raw messages stay in server logs only.

## Server Actions

`src/lib/{domains,dns,ssl,http,notifications,i18n}/actions.ts` — `"use server"` modules:
- `createDomainAction` / `deleteDomainAction` / `refreshRdapAction`
- `checkDnsAction` / `checkSslAction` / `checkHttpAction` (return `{ok, error?, errorCode?}`)
- `retryDeliveryAction`, `setLocaleAction`
- Actions revalidate `/` and `/domains/[id]`; errors are user-safe strings + machine `errorCode`.

## Database

- SQLite file (default `./data/domain-monitor.db`, overridable via `DATABASE_URL`).
- 10 tables, 6 migrations (`src/db/migrations/0000…0005`), drizzle `__drizzle_migrations` journal.
- FK constraints ON (`ON DELETE CASCADE` for snapshots/records); `busy_timeout = 5000` for the dual-process (server + worker) writes.
- See `DATABASE.md`.

## Monitoring details

- See `MONITORING.md` for per-module semantics and the full V0.7.3 error-code table.

## SSRF security model

- HTTP client: hostname only from stored domains; `assertSafeHost` resolves DNS and blocks any reserved/private/loopback/CGNAT/link-local/metadata IP on the initial hop **and every redirect hop**; manual redirects (max 5); https-only; same-host redirect policy.
- Webhook sender reuses the same guards for user-configured URLs.
- `blocked_redirect` surfaces only the machine code to clients; the raw message (which may contain a resolved address) stays in server logs.

## Test architecture

- 501 unit/integration tests (vitest, Node env, `src/**/*.test.ts`); worker CLI (7), worker concurrency (15), scripts smoke (40) run via separate configs; UI smoke (109 assertions) and interactive i18n smoke run against a real `next start` + temp DB.
- CI (GitHub Actions): Ubuntu matrix Node 22/24/26 (install/lint/test/format/build) + `windows-fresh-install` job (Node 24) guarding against native-build regressions.

## Known limitations

- Container has **no systemd** (PID 1 = docker-init); supervisor manages production processes; container rebuild does not auto-start services (platform limitation).
- Production DB and backups live under `/workspace` (platform persistent volume, xfs `/dev/sdb`).
- `DNS_DOH_ENDPOINT` is read from env but not listed in `.env.example` (doc gap).
- Node 25 is not an officially supported version (works via N-API prebuilds, but CI tests 22/24/26 only).
