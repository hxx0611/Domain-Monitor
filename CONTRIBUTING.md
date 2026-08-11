# Contributing to Domain Monitor

Thank you for considering contributing to Domain Monitor!

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `pnpm install`
3. Copy env file: `cp .env.example .env`
4. Start dev server: `pnpm dev`

## Branch Naming

- `feat/xxx` — new feature
- `fix/xxx` — bug fix
- `docs/xxx` — documentation
- `chore/xxx` — maintenance tasks

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add domain list page`
- `fix: resolve DNS query timeout`
- `docs: update README setup instructions`
- `chore: update dependencies`

## Code Style

- TypeScript strict mode
- ESLint + Prettier enforced
- Run `pnpm lint:fix && pnpm format` before committing

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure `pnpm build` passes
4. Ensure `pnpm lint` passes
5. Open a PR with a clear description

## Questions?

Open a [GitHub Issue](https://github.com/hxx0611/Domain-Monitor/issues) for discussions.
