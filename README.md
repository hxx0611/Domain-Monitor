# Domain Monitor

A lightweight, modern, self-hostable domain lifecycle monitoring platform.

## Features

### V0.1 — Domain Management

- Add domains with automatic normalization (`https://example.com/path` → `example.com`)
- List all monitored domains
- View per-domain detail pages (with placeholders for upcoming monitoring modules)
- Delete domains with confirmation

### V0.2 — RDAP / WHOIS Integration

- Live RDAP enrichment via the IANA bootstrap registry (590+ TLDs)
  - Registrar, registration / expiration / last-updated dates
  - Nameservers and domain status codes
- Best-effort enrichment on domain creation (a failing RDAP query never blocks adding a domain)
- Manual "Refresh RDAP" button on the detail page
- Resilient fallbacks: RDAP-unavailable domains stay usable with a manual retry path

### V0.3 — DNS Monitoring (current)

- Manual DNS checks (no automatic scheduling in this version)
- Atomic snapshots: a check stores the full DNS state at one point in time
- Record types monitored: A, AAAA, CNAME, MX, NS, TXT, CAA
- Change detection between snapshots (added / removed records)
- DNS history with per-check change counts
- DNS-over-HTTPS via the public Cloudflare DoH JSON endpoint
  (resolver is abstracted and swappable via `DNS_DOH_ENDPOINT`)
- Resilient behavior: a failed or partial query never deletes old data
  and never produces false "removed" events

### Planned

- SSL certificate expiry tracking
- HTTP health checks
- Notification integrations
- Dashboard with overview of all monitored domains

## Tech Stack

| Layer        | Technology       |
| ------------ | ---------------- |
| Framework    | Next.js 15       |
| Language     | TypeScript       |
| Styling      | Tailwind CSS     |
| ORM          | Drizzle ORM      |
| Database     | SQLite           |
| Package Mgr  | pnpm             |

## Getting Started

### Prerequisites

- Node.js >= 18
- pnpm (recommended)

### Install

```bash
pnpm install
```

### Setup Environment

```bash
cp .env.example .env
```

### Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Database

Generate migration files:

```bash
pnpm db:generate
```

Run migrations:

```bash
pnpm db:migrate
```

Open Drizzle Studio (visual DB browser):

```bash
pnpm db:studio
```

### Build

```bash
pnpm build
```

### Lint & Format

```bash
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

## Project Structure

```
Domain Monitor/
├── src/
│   ├── app/            # Next.js App Router pages
│   │   └── domains/[id]/  # Domain detail page
│   ├── components/     # React components (client & server)
│   ├── lib/
│   │   ├── domains/    # Domain feature: validation, repository, server actions
│   │   └── format.ts   # Shared formatting helpers
│   ├── db/             # Drizzle schema, migrations & DB connection
│   └── types/          # Shared TypeScript type definitions
├── docs/               # Project documentation
├── public/             # Static assets
├── .github/            # GitHub Actions workflows
└── data/               # SQLite database files (git-ignored)
```

## Roadmap

- [x] **V0.1:** Domain management (add / list / view / delete)
- [x] **V0.2:** RDAP / WHOIS integration
- [x] **V0.3:** DNS monitoring
- [ ] **V0.4:** SSL certificate monitoring
- [ ] **V0.5:** HTTP health checks
- [ ] **V0.6:** Notification system

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
