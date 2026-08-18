# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
