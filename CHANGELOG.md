# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.8.3] — 2026-08-19

### Added

- **Production Worker watchdog** (Phase 11D): `scripts/worker-watchdog.sh` — a single-instance hourly scheduler (flock-guarded, self-contained, does not depend on `pnpm` being on `PATH`). Each tick runs the worker exactly once (`./node_modules/.bin/tsx --conditions=react-server scripts/worker.ts --limit 50`), the process exits naturally after the tick, and a non-zero tick exit is recorded and the loop continues to the next hour. `TERM` / `INT` exit cleanly.
- **Hourly expiration reminder processing**: the watchdog runs the worker every hour; `evaluateExpirationReminders()` emits one deduplicated `expiration_reminder` event per domain once the reminder day arrives, flowing through the existing rule → channel → delivery pipeline.
- **Expiration reminder → delivery pipeline** (Phase 11D): `insertEventsAndGenerateDeliveries` creates the event and its deliveries together; each delivery is claimed with a CAS (`UPDATE … WHERE status='pending'`), so concurrent ticks produce at most one event, one delivery and one sender invocation.
- **Migration journal repair** (Phase 11E): the manually-created migration `0007_manual_expiration` (Phase 11A) was not registered in the drizzle journal when it was authored. It was applied to the production database manually at deploy time, but `_journal.json` never contained an entry, so a fresh environment running `drizzle-kit migrate` would stop at `0006` and miss the 11A schema. This release closes the bookkeeping gap: `_journal.json` now contains `idx: 7` (`tag: 0007_manual_expiration`, `when: 1787063220000`), `0007_snapshot.json` was generated (13 tables, `expiration_reminders` included), and the production `__drizzle_migrations` table was registered with the migration's sha256 hash. A fresh `0000 → 0007` migration was verified end-to-end; the migration itself was **not** re-executed on any database.

### Fixed

- **Worker crash under react-server / production conditions** (Phase 11D): `senders/factory.ts` imported notification senders through the `@/lib/domains` barrel, which pulled in `next/cache` and crashed with `_react.default.createContext is not a function` when the worker ran under production conditions. The factory now imports from the repository module directly, bypassing the barrel.
- **Expiration reminder events never produced deliveries** (Phase 11D): the reminder pipeline emitted an `expiration_reminder` event but did not generate deliveries, so the event could never be sent. Events and deliveries are now created together via `insertEventsAndGenerateDeliveries`.
- **Expiration reminder dedup / delivery pipeline** (Phase 11D): concurrent tick E2E coverage (event `dedupKey` UNIQUE, delivery UNIQUE `(event_id, channel_id)`, CAS claim) guarantees at most one event / one delivery / one sender invocation per reminder per day.

### Changed

- Version bumped from v0.8.2 → **v0.8.3** (worker + release).
- `src/db/migrations/meta/_journal.json` now has 8 entries (0000–0007); `src/db/migrations/meta/0007_snapshot.json` is added.

### Compatibility

- **tsx@4.23.12** added as a development dependency (workspace and production directory).
- The worker invokes the bundled `tsx` executable directly (`./node_modules/.bin/tsx`), not a `pnpm`-based command.
- Legacy notification senders (Telegram / Webhook / Email) and their secret resolution remain unchanged.

### Notes

- The worker is **enabled in production**: the watchdog (`scripts/worker-watchdog.sh`) is running as a single instance and ticks hourly (`--limit 50`). Real notification delivery was not exercised as part of this release; the real-notification safety gate remains a separate approved exercise.
- The migration journal bookkeeping gap for `0007_manual_expiration` was **repaired in Phase 11E** (journal entry + snapshot + production `__drizzle_migrations` registration). No further journal changes are planned in this release.

## [v0.8.2] — 2026-08-18

### Added

- **Manual expiration** (Phase 11A): every domain now has an expiration source (`rdap` — automatic, the default — or `manual`). With `manual`, you can set the registration date, expiration date, registration platform (from validated presets or a custom provider + management URL) directly from the Add/Edit domain forms.
- **Manual dates are never overwritten by RDAP refreshes**: the Refresh RDAP flow only updates RDAP metadata (registrar / nameservers / status), or clears it for `no-object` / parent results; a manual expiration date, registration date and provider survive every refresh.
- **Registration platform presets**: validated, normalized provider URLs (GNAME, Alibaba Cloud, Tencent Cloud, Namecheap, Porkbun) with a `custom` fallback (HTTPS URL + display name), stored as `registration_provider` / `registration_provider_url`.
- **Expiration reminders**: per-domain reminder days (integer days before expiry, 1–3650, presets + custom), stored in the new `expiration_reminders` table; the detail page shows the reminder list.
- **`expiration_reminder` event type** (notification rule source `expiration`): the delivery worker's `evaluateExpirationReminders()` emits one deduplicated `expiration_reminder` event per domain per day once the reminder day arrives, flowing through the normal rule → delivery pipeline.
- **Migration 0007**: `domains.expiration_source`, `domains.registration_provider`, `domains.registration_provider_url`, and the `expiration_reminders` table (unique `(domain_id, days_before)`).
- **Worker summary field**: `runOnce` now also reports `expirationEvents` (count of reminder events emitted this tick).

### Changed

- Version bumped from v0.8.1 → **v0.8.2** (feature release).
- Server-Action input handling: reminder days may be passed as numbers (client checkboxes) or numeric strings; both normalize identically.

### Compatibility

- Schema change requires **migration 0007** (additive: new nullable columns with a default, new table, new unique index). Existing rows keep `expiration_source = 'rdap'` and their current RDAP data.
- The worker summary JSON gained the `expirationEvents` field (additive; existing consumers can ignore it).

### Notes

- **Automatic delivery is not yet enabled in production** (the `tsx` runtime required by the worker CLI is not installed there). The manual expiration / registration platform / reminder UI and rule configuration are fully live; reminder **delivery** activates once the worker runtime dependency is installed and `pnpm worker` is scheduled via cron.

## [v0.8.1] — 2026-08-18

### Fixed

- **RDAP fallback ownership** (Phase 10D): the registered-domain fallback previously treated parent-domain data as child-domain ownership. A query for a subdomain without its own RDAP object (e.g. `opusai.eu.cc` → 404) resolved to the parent (`eu.cc`) and the parent's expiration, registrar, nameservers and status were stored on the child row. RDAP results now carry explicit ownership detection (`exact` / `parent`), decided strictly from the RDAP object's canonical/LDH identity — never merely from "a fallback succeeded". Parent-derived data is **never** written to the child's own fields; the child is marked `rdap_status = ["no-object"]` and its expiration/registrar/dates/nameservers are cleared.
- **Expiration-date UI duplication** (Phase 10A): the detail page showed the expiration twice (`Expiration` heading plus an `Expires: …` prefix inside the row). The row now renders a plain date.
- **Production data repair** (Phase 10E): production records affected by the previous fallback behavior were corrected through the normal Refresh flow (subdomain RDAP fields cleared, parent data no longer displayed as the subdomain's expiration).
- **RDAP fallback safety net** (Phase 10A): fallback is allowed only for `not-found` (HTTP 404 / no domain object) or a successful response without an expiration date; network, timeout, 429, 500 and invalid responses are never masked by a parent query; a bare TLD is never queried.

### Changed

- Version bumped from v0.8.0 → **v0.8.1** (bugfix / stability release; v0.8.0 tag and release are preserved).

### Compatibility

- No schema changes; no migration added. `updateDomainRdap(id, data, ownership)` now requires an explicit ownership argument.

## [v0.8.0] — 2026-08-18

### Added

- **Admin authentication** (Phase 9E): one-time `/setup` wizard with a scrypt-hashed admin password, `/login` / `/logout`, and a one-time recovery code for password reset (recovery rotates the session secret so all old sessions are invalidated).
- **HMAC-signed admin session**: signed, HttpOnly, SameSite=Lax cookies with expiry + entropy (replay-resistant); no third-party auth dependency.
- **Protected pages and Server Actions**: `/`, `/domains/[id]`, `/notifications` and every mutating Server Action require an authenticated admin session.
- **Telegram notification channel** (Phase 9G): create/edit Telegram channels from the notification UI; the bot token is validated via Telegram `getMe` (server-side only) before saving.
- **Encrypted notification secret storage** (Phase 9F): AES-256-GCM encryption (`iv:tag:ciphertext`) for the Telegram bot token; `ENCRYPTION_KEY` is read from the environment (required in production).
- **Telegram sender secret resolution** (Phase 9H): the Telegram sender resolves the token from the encrypted store first, then falls back to the legacy `TELEGRAM_BOT_TOKEN` environment variable, and fails controlled when neither is available (decryption failure never falls back).
- **Notification configuration UI**: channel CRUD (create/edit/toggle/delete), rule CRUD, token configuration status (configured / not configured — never the value), delivery retry.
- **Migration 0006**: `admin_settings` and `notification_secrets` tables.

### Security

- **Secret isolation**: Telegram bot tokens are encrypted at rest and never rendered back into HTML/RSC/client bundles; only CONFIGURED/NOT CONFIGURED status is exposed.
- **Unified auth errors**: login/setup/recovery failures use identical, non-enumerating error messages.
- **SSRF protection** (existing, kept): outbound HTTP is HTTPS-only with per-redirect re-validation in the HTTP client and webhook sender.
- **No secret in logs**: tokens, passwords, recovery codes, and encryption keys never appear in application logs, worker output, or error messages.

### Changed

- Version bumped from v0.7.3 → **v0.8.0**.
- Notification channel types now include **Telegram** alongside Webhook and Email.
- Secret handling for notification channels moved from environment-variable references only to **encrypted storage with legacy env fallback**.

### Fixed

- Notification configuration pages were fully public before this release; they now require an authenticated admin session.
- Documentation was synchronized with the implemented feature set (README bilingual, docs, CHANGELOG).

### Compatibility

- Database: migration `0006` adds two tables (`admin_settings`, `notification_secrets`); existing data is preserved (no destructive changes).
- Configuration: production requires an `ENCRYPTION_KEY` (32-byte / 64 hex chars). Existing deployments that set `TELEGRAM_BOT_TOKEN` keep working through the legacy env fallback; entering a token via the UI migrates a channel to encrypted storage.
- Node.js >= 22 continues to be supported (22 / 24 / 26 CI-tested).

---

## Historical releases

> Entries below are historical and do not reflect the current release.

### Between v0.7.3 and v0.8.0 (commits on `main`, shipped in v0.8.0)

- `2093e91` feat: add Telegram notification channel (8/16)
- `f4b1250` feat: add notification configuration UI (8/17)
- `ce519fe` fix: clarify monitoring added semantics (8/16)

These commits landed on `main` after the v0.7.3 tag was created but were never
published on their own; they are included in v0.8.0.

### v0.7.3 — Monitoring Error Clarity (tag only; no GitHub Release was published)

- Stable machine error codes + localized messages for DNS/SSL/HTTP monitoring failures.
- Note: the v0.7.3 **git tag exists** (pointing at `fe4b704`) but a GitHub Release was never published. v0.7.3 does **not** include the v0.8.0 features above.

### v0.7.2 — Windows CI fix

- Windows fresh-install CI fix (`5834e99`): idempotent data-dir step.

### v0.7.1 — Bilingual UI / Simplified Chinese Support

- English / Simplified Chinese language switching, cookie-based locale.

### v0.6 / v0.7 — Notification system & delivery worker

- Event-driven notifications (events → rules → deliveries → senders), at-least-once delivery, CAS claim, stale recovery, one-shot CLI worker.
