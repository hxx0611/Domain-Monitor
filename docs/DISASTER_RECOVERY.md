# Domain-Monitor — Disaster Recovery

> Verified recovery procedures and honest status of each scenario (as of 2026-08-16).

## Status of protections (factual)

| Protection | Status |
|---|---|
| Local backups (keep 14) | IMPLEMENTED & VERIFIED (2026-08-16, integrity + restore drill PASS) |
| **Off-site backup (R2, keep 30)** | **IMPLEMENTED & VERIFIED 2026-08-16** — real upload to `domain-monitor-backups/daily/` succeeded, download-back + `integrity_check` + data verification passed. NOTE: earlier drafts of the plan said "not implemented"; the 6M phase completed it. Still single-copy in R2 (no versioning yet). |
| Automatic restart on process crash | IMPLEMENTED (supervisor autorestart) & VERIFIED (restart tests) |
| Automatic restart on **container rebuild** | **NOT IMPLEMENTED** — platform limitation; after a rebuild supervisor must be started manually (`supervisord -c /etc/supervisor/supervisord.conf`), then verify services |
| Off-machine / second-region copy | NOT IMPLEMENTED (same volume local + R2 single copy) |

## 1. Production DB corruption (e.g. `SQLITE_CORRUPT`, failing integrity_check)

1. `supervisorctl stop domain-monitor` (brief outage, seconds)
2. Pick the newest backup: `ls -1t /workspace/domain-monitor-backups/domain-monitor-*.db | head -1`
3. Verify: `sqlite3 <backup> "PRAGMA integrity_check;"` → `ok`
4. Copy to a **temp path first**: `cp <backup> /tmp/restore-check.db`; verify domains count matches expectation
5. `cp <backup> /workspace/domain-monitor-data/domain-monitor.db` (explicit target; never overwrite with an unchecked file)
6. `chmod 600` the DB; `supervisorctl start domain-monitor`
7. Verify local 200 + public 200

Human steps: choosing the backup, confirming the target path. Automatable: steps 1–7 via a script with explicit `--target` + integrity gate.

## 2. Entire /workspace lost

1. Recreate directories: `mkdir -p /workspace/domain-monitor-data /workspace/domain-monitor-backups` (750)
2. Download from R2: `rclone copyto r2:domain-monitor-backups/daily/<latest> /tmp/restored.db`
3. `sqlite3 /tmp/restored.db "PRAGMA integrity_check;"` → `ok`
4. `cp /tmp/restored.db /workspace/domain-monitor-data/domain-monitor.db`; `chmod 600`
5. Start supervisor; verify app + tunnel + public URL

Human steps: R2 download command (or full automation), target confirmation.

## 3. Container fully rebuilt

1. Reinstall runtime: Node ≥22, pnpm (corepack), project checkout at `fe4b704`, `pnpm install --frozen-lockfile`, `pnpm build`
2. Install supervisor + cron (as in Phase 6C), recreate `/etc/supervisor/conf.d/domain-monitor.conf` and `/etc/cron.d/domain-monitor-backup` (templates in `docs/DEPLOYMENT_HANDOVER.md`)
3. Reinstall cloudflared; **restore Tunnel credentials** (`cert.pem` + `f24997a3-….json`) — these live in the container; a copy must be held by the human operator (credentials map in `DEPLOYMENT_HANDOVER.md`)
4. Restore DB from R2 (procedure 2)
5. Recreate rclone config (credentials from human), start supervisor, verify public URL

Mostly **manual**; the DB restore part is scriptable.

## 4. Git recovery

- Code source of truth: GitHub `hxx0611/Domain-Monitor`, main = `fe4b704` (v0.7.3). Re-clone, `pnpm install --frozen-lockfile`, `pnpm build`. No local-only code exists.

## 5. Tunnel recovery

- Tunnel `domain-monitor` (`f24997a3-…`) + CNAME `domain-monitor.snooze.eu.cc` live in the Cloudflare account (not in the container) — they survive container loss. Only the local credentials files need restoring (step 3).

## 6/7. DB / backup restore — key rules

- Always restore to a temp path, integrity-check, then copy to the production path (never copy over a live DB without stopping the app).
- Never restore a `/tmp` DB or the Phase 5 test DB (`/tmp/dm-e2e.db`) as production.
- `chmod 600` after restore; verify `DATABASE_URL` still points at the production path.

## 8. Health verification after any recovery

```bash
supervisorctl status                          # both RUNNING
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/          # 200
curl -s -o /dev/null -w "%{http_code}" https://domain-monitor.snooze.eu.cc/  # 200
cloudflared tunnel info domain-monitor        # CONNECTIONS > 0
```

## Honest gaps

- **Container rebuild auto-start: NOT IMPLEMENTED** (platform limitation; manual supervisor start required).
- **R2 Object Versioning: NOT ENABLED** (recommended; protects against accidental deletion/overwrite of remote backups).
- **Backup failure alerting: NOT IMPLEMENTED** (errors go to `/var/log/domain-monitor-backup-error.log` only).
