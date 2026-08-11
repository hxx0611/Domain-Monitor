# Domain Monitor

A lightweight, modern, self-hostable domain lifecycle monitoring platform.

## Features (Planned)

- Domain registration & expiration tracking
- DNS record monitoring
- SSL certificate expiration alerts
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
│   ├── components/     # Shared React components
│   ├── lib/            # Utility functions & shared logic
│   ├── db/             # Drizzle schema, migrations & DB connection
│   └── types/          # Shared TypeScript type definitions
├── docs/               # Project documentation
├── public/             # Static assets
├── .github/            # GitHub Actions workflows
└── data/               # SQLite database files (git-ignored)
```

## Roadmap

- [ ] **Phase 1:** Project foundation & dev environment
- [ ] **Phase 2:** Domain CRUD & RDAP integration
- [ ] **Phase 3:** DNS monitoring
- [ ] **Phase 4:** SSL certificate monitoring
- [ ] **Phase 5:** HTTP health checks
- [ ] **Phase 6:** Notification system

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
