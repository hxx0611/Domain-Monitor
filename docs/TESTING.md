# Domain-Monitor — Testing

> Baseline: **501 passed** (34 files) as of v0.7.3. Commands below assume `cd /workspace/Domain-Monitor`.

## Unit & integration tests (501)

```bash
pnpm test                          # vitest run — src/**/*.test.ts (501 tests / 34 files)
```

Covers: domains, RDAP, DNS/SSL/HTTP clients+normalize+diff+service+actions, error classifier, i18n (incl. dictionary symmetry + machine-value rules), notifications (events/rules/repository/delivery/worker), HTTP SSRF predicates.

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
node scripts/ui-smoke.mjs               # 109 assertions: bilingual render, HTTP 200, no secrets in HTML/logs, machine values
node scripts/interactive-switch-smoke.mjs # 22 assertions: real Server Action wire protocol for locale switching
```

Both spin up their own `next start` against a temp SQLite DB and clean up after themselves.

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

## V0.7.3 error-classifier tests

- Every transport code → prefixed monitoring code; unknown/non-client errors → `*_unknown`; **leakage assertions** (blocked-redirect raw message with internal IP never surfaces as a code); legacy/unknown dictionary values → `undefined` fallback.

## How to run the full suite

```bash
pnpm test && pnpm lint && pnpm format:check && npx tsc --noEmit && pnpm build
pnpm exec vitest run --config scripts/vitest.phase2.config.ts
pnpm exec vitest run --config scripts/vitest.phase3.config.ts
pnpm exec vitest run --config scripts/vitest.smoke.config.ts
node scripts/ui-smoke.mjs && node scripts/interactive-switch-smoke.mjs
```

Expected: 501 + 15 + 7 + 40 + UI smoke + interactive smoke all green.
