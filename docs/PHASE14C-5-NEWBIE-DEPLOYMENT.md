# Phase 14C-5 — Item 8: Newbie "One-Click" Deployment Design

## Target persona
A non-technical operator who should NOT need: SSH, Linux shell, SQLite CLI,
`wrangler` CLI, or a manually-authored `.env`. They want a browser-first
onboarding: **GitHub → Deploy to Cloudflare → OAuth → create D1 → apply
migrations → deploy Worker → visit /setup**.

## Current friction (what exists TODAY)

| Step | Today | What's missing |
|---|---|---|
| Provision app code | clone repo + `npm install` | No Deploy-to-Cloudflare button wired |
| Database | `DATABASE_URL=./data/domain-monitor.db` (SQLite file) | No D1 provisioning; SQLite is local-file only in Node self-hosted |
| Migrations | `npm run db:migrate` (Drizzle) | No automatic `wrangler d1 migrations apply` on deploy |
| Secrets | `ENCRYPTION_KEY` must be set (prod) | No OAuth-scoped secret provisioning |
| Auth | `/setup` wizard records recovery code ✓ | ✓ exists (good) |
| Worker deploy | `.open-next/worker.js` + wrangler | No CI/CD pipeline wired |

**CURRENT SCORE /10 = 3** (setup wizard exists; everything before it is manual.)

**TARGET SCORE /10 = 8** (browser-only: GitHub OAuth → auto-provision D1 →
auto-migrate → auto-deploy → /setup; manual secret provisioning optional).

## Designed flow (target, NOT yet implemented)

```
GitHub (fork + click Deploy)
   └─ Deploy to Cloudflare (Workers)
        ├─ OAuth: Cloudflare account scope (Workers + D1)
        ├─ provision D1 database (creates `domain-monitor`)
        ├─ write migrations (0000-0007) to this new D1
        ├─ generate ENCRYPTION_KEY + SESSION_SECRET (server-side, stored as
        │     Worker secrets, NEVER committed, shown to user once)
        ├─ deploy Worker (OpenNext build + wrangler deploy)
        └─ open /setup → admin creates recovery code, adds Telegram channel
```

## Automatable vs. must-be-user-input

### Automatable (no user action, platform does it)
- Create D1 database binding (Cloudflare API)
- Apply migrations 0000-0007 (`wrangler d1 migrations apply --remote`)
- Build OpenNext worker + deploy `.open-next/worker.js`
- Generate `ENCRYPTION_KEY` / `SESSION_SECRET` (server-side, stored as secrets)
- Wire `CONFIG_TELEGRAM_ENDPOINT` (default to api.telegram.org or a placeholder)

### Must-be-user-INPUT (authorized, secret-bearing)
- **Cloudflare account + OAuth consent** (Workers, D1, scripts permissions)
- **Telegram Bot Token** (entered in the notification UI; stored only as
  AES-256-GCM ciphertext via `/setup` — never in env/Git)

### Cloudflare permissions that must be authorized
- `Workers Scripts:Edit`
- `Workers Scripts:Read`
- `D1:Edit` (create/storage)
- `Workers R2/KV` if using R2 for backups (optional)

### Steps that STILL need CLI (cannot be fully one-click)
- None strictly, IF a "Deploy to Cloudflare" template + GitHub Action is wired.
  Without it, the operator must run `wrangler login` (OAuth once) + `wrangler
  deploy` + `wrangler d1 migrations apply`. These are the residual CLI steps
  that a GitHub-magic-template collapses into one click.

## Honesty note
None of the target automation is implemented yet. A "Deploy to Cloudflare"
button, GitHub Action, and automatic D1 provisioning are DESIGNS. The only
browser-first piece that exists today is the `/setup` wizard and the
`ENCRYPTION_KEY` isolation (no secret in source). Do NOT claim the one-click
flow is shipped.

## Readiness flags
- **CLI_REQUIRED** = true today (wrangler/deploy) → target false (GitHub magic)
- **MANUAL_ENV** = true today (ENCRYPTION_KEY) → target false (auto-generated secret)
- **MANUAL_DB** = true today (SQLite path) → target false (D1 provisioned)
- **ONE_CLICK_DEPLOY** = false today → target true (not yet shipped)
