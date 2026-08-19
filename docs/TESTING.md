# Domain-Monitor — Testing

> Baseline: **763 passed** (51 files) as of v0.8.3. Commands below assume `cd /workspace/Domain-Monitor`.

## Unit & integration tests (763)

```bash
pnpm test                          # vitest run — src/**/*.test.ts (763 tests / 51 files)
```

Covers: domains, RDAP, DNS/SSL/HTTP clients+normalize+diff+service+actions, error classifier, i18n (incl. dictionary symmetry + machine-value rules), notifications (events/rules/repository/delivery/worker), HTTP SSRF predicates, **admin authentication** (sessions, setup/login/logout/recovery, page & Server Action access guards), **encrypted secret storage** (AES-256-GCM round-trip, upsert, cascade, decrypt failure), **Telegram token actions** (getMe verification, encrypted save, edit keep-token semantics), **Telegram sender secret resolution** (encrypted → env fallback → controlled failure) including a real-network-mocked E2E (`telegram-sender-e2e.test.ts`), **RDAP fallback + ownership semantics** (`fallback.test.ts`, `rdap-link.test.ts`: exact / parent / no-object persistence, canonical-name mismatch, no fallback on network/timeout/429/500).

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

## V0.8.1 RDAP fallback & ownership tests

- Fallback candidate generation: full hostname first, then parent labels; bare TLD never queried; case normalization.
- Ownership semantics: `exact` when the RDAP object's canonical identity equals the queried hostname; `parent` when the object belongs to a parent label (including canonical-name mismatch on the first candidate); **parent data (expiration/registrar/nameservers/status) is never persisted on the child row** — the child is cleared and marked `rdap_status = ["no-object"]`.
- No-object / error paths: all candidates 404 → nothing persisted (expiration stays null); network / timeout / 429 / 500 / invalid-response never fall back to a parent query.

## How to run the full suite

```bash
pnpm test && pnpm lint && pnpm format:check && npx tsc --noEmit && pnpm build
pnpm exec vitest run --config scripts/vitest.phase2.config.ts
pnpm exec vitest run --config scripts/vitest.phase3.config.ts
pnpm exec vitest run --config scripts/vitest.smoke.config.ts
node scripts/ui-smoke.mjs && node scripts/interactive-switch-smoke.mjs
```

Expected: 763 + 15 + 7 + 40 + UI smoke + interactive smoke all green.

> Note (v0.8.3): the worker CLI / concurrency / scripts smoke configs (`vitest.phase2/phase3/smoke.config.ts`) require the `tsx` runtime — installed as a devDependency since v0.8.3 (workspace and production directory), so those configs are runnable here. The default `pnpm test` (763/51) is the release gate.
