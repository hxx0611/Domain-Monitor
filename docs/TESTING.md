# Domain-Monitor — Testing

> Baseline: **687 passed** (44 files) as of v0.8.0. Commands below assume `cd /workspace/Domain-Monitor`.

## Unit & integration tests (687)

```bash
pnpm test                          # vitest run — src/**/*.test.ts (687 tests / 44 files)
```

Covers: domains, RDAP, DNS/SSL/HTTP clients+normalize+diff+service+actions, error classifier, i18n (incl. dictionary symmetry + machine-value rules), notifications (events/rules/repository/delivery/worker), HTTP SSRF predicates, **admin authentication** (sessions, setup/login/logout/recovery, page & Server Action access guards), **encrypted secret storage** (AES-256-GCM round-trip, upsert, cascade, decrypt failure), **Telegram token actions** (getMe verification, encrypted save, edit keep-token semantics), **Telegram sender secret resolution** (encrypted → env fallback → controlled failure) including a real-network-mocked E2E (`telegram-sender-e2e.test.ts`).

## Worker CLI & concurrency (separate configs)

```bash
pnpm exec vitest run --config scripts/vitest.phase3.config.ts   # worker-cli: 7 tests
pnpm exec vitest run --config scripts/vitest.phase2.config.ts   # worker-concurrency: 15 tests
pnpm exec vitest run --config scripts/vitest.smoke.config.ts    # scripts/*.test.ts: 40 tests
```

Concurrency suite covers CAS races, stale recovery, busy_timeout under a real competing writer, crash semantics.

## UI smoke (real server, temp DB)

```bash
pnpm build
node scripts/ui-smoke.mjs               # renders pages against a real next start; asserts bilingual render, HTTP 200, no secrets in HTML/logs, machine values
node scripts/interactive-switch-smoke.mjs # real Server Action wire protocol for locale switching
```

Both spin up their own `next start` against a temp SQLite DB and clean up after themselves. Assertion counts are printed at runtime; note that v0.8.0 added admin auth, so an unauthenticated smoke run only exercises pages that are reachable pre-login (see `docs/NOTIFICATIONS.md` for the authenticated UI surface).

## Notification regression

```bash
pnpm exec vitest run src/lib/notifications/integration.test.ts \
  src/lib/notifications/events-to-delivery.test.ts \
  src/lib/notifications/delivery.test.ts \
  src/lib/notifications/worker.test.ts    # 60 tests
```

## Static & build gates

```bash
pnpm lint             # next lint — zero warnings/errors expected
pnpm format:check     # prettier — src/**/*.{ts,tsx,md,json,css}
npx tsc --noEmit      # strict typecheck
pnpm build            # next build — 3/3 static pages (all dynamic)
```

## CI (GitHub Actions, `.github/workflows/ci.yml`)

- `build-and-lint` matrix: **Node 22 / 24 / 26 on ubuntu-latest** — install (frozen lockfile), lint, mkdir data, test, format:check, build.
- `windows-fresh-install`: **windows-latest + Node 24** — install (frozen lockfile), build, mkdir data (PowerShell-safe `New-Item -Force`), test. Guards against native-build regressions (better-sqlite3 prebuilds, no Python/node-gyp).

## V0.8.0 auth & secrets tests

- Admin auth: session signing/verification, expiry/entropy, setup/login/logout/recovery flows, page guard redirects, Server Action guard rejection (all 401/403-style paths covered), unified non-enumerating errors.
- Secret storage: encrypt → `iv:tag:ciphertext` round-trip; upsert per `(channel_id, key)`; FK cascade on channel delete; decrypt with wrong key fails loudly.
- Token UI: `getMe` success/failure paths; token only ever written via the server action to the encrypted store; edit mode keeps the existing token when the field is blank.
- Sender resolution E2E (mocked network): encrypted secret used → env fallback used when no secret → controlled failure when neither; token never leaks into logs/errors/payloads.

## How to run the full suite

```bash
pnpm test && pnpm lint && pnpm format:check && npx tsc --noEmit && pnpm build
pnpm exec vitest run --config scripts/vitest.phase2.config.ts
pnpm exec vitest run --config scripts/vitest.phase3.config.ts
pnpm exec vitest run --config scripts/vitest.smoke.config.ts
node scripts/ui-smoke.mjs && node scripts/interactive-switch-smoke.mjs
```

Expected: 687 + 15 + 7 + 40 + UI smoke + interactive smoke all green.
