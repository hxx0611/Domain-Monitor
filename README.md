# Domain Monitor

A lightweight, self-hostable domain lifecycle monitoring platform for RDAP, DNS, and domain status tracking.

[![CI](https://github.com/hxx0611/Domain-Monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/hxx0611/Domain-Monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hxx0611/Domain-Monitor?sort=semver)](https://github.com/hxx0611/Domain-Monitor/releases)

Domain Monitor helps you keep track of the domains you own: it stores them locally, looks up registration data via RDAP, and lets you run DNS checks to see how your records evolve over time.

## Screenshots

Domain details view with RDAP information, DNS records, and DNS change history.

![Domain details view](docs/screenshots/domain-details.png)

## Features

### Domain Management

- Add and manage monitored domains
- Domain normalization and validation (accepts `https://example.com/path`, stores `example.com`)
- Self-hosted local storage (SQLite)
- Domain detail pages

### RDAP Information

- Automatic RDAP lookup on domain creation
- IANA bootstrap routing (590+ TLDs)
- Registrar information
- Registration / expiration / last-updated dates
- Nameservers and RDAP status
- Manual RDAP refresh

### DNS Monitoring

- DNS-over-HTTPS based monitoring (Cloudflare DoH)
- A / AAAA / CNAME / MX / NS / TXT / CAA records
- Historical DNS snapshots
- Added / removed record detection
- TTL-only changes ignored
- Atomic failed-check handling (a partial failure never deletes old data)
- Manual DNS checks

## Current Status

**Current release: v0.3.0**

Supported today:

- Domain management
- RDAP information
- DNS monitoring

DNS checks are currently manual; automatic scheduling is planned for a future release.

## Quick Start

```bash
git clone https://github.com/hxx0611/Domain-Monitor.git
cd Domain-Monitor
pnpm install
cp .env.example .env
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Requires Node.js >= 18 and [pnpm](https://pnpm.io/). Works on Linux, macOS, and Windows.

## Testing

```bash
pnpm test
```

Current test suite: **115 tests**, covering domain validation, RDAP parsing, DNS normalization, DNS diffing, the DNS service, and the data repositories.

Also run before pushing changes:

```bash
pnpm lint
pnpm format:check
pnpm build
```

## Architecture

```
UI (Next.js App Router)
        ↓
Server Actions
        ↓
Domain / RDAP / DNS services
        ↓
Repository
        ↓
SQLite
```

- **Next.js App Router** + Server Actions
- **Drizzle ORM** with **SQLite** (migrations in `src/db/migrations/`)
- **Cloudflare DoH** for DNS queries (resolver swappable via `DNS_DOH_ENDPOINT`)
- **IANA RDAP bootstrap** for registration data

See [docs/development.md](docs/development.md) for detailed development notes.

## Database

SQLite via Drizzle ORM. Manage the schema with the built-in commands:

```bash
pnpm db:generate   # Generate migration files
pnpm db:migrate    # Run migrations
pnpm db:studio     # Open the visual database browser
```

## Roadmap

- [x] **V0.1** — Domain management
- [x] **V0.2** — RDAP / WHOIS integration
- [x] **V0.3** — DNS monitoring
- [ ] **V0.4** — SSL certificate monitoring
- [ ] **V0.5** — HTTP health checks
- [ ] **V0.6** — Notification system

## Contributing

Contributions are welcome.

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution guide.

## License

[MIT](LICENSE)
