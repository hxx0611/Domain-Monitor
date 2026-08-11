# Domain Monitor

## Architecture

See [README.md](../README.md) for project overview.

## Development

### Local Development

```bash
pnpm install
pnpm dev
```

### Database

Drizzle ORM is used with SQLite. Schema is defined in `src/db/schema.ts`.

```bash
pnpm db:generate   # Generate migration files
pnpm db:migrate    # Run migrations
pnpm db:studio     # Open visual DB browser
pnpm db:push       # Push schema changes directly (dev only)
```
