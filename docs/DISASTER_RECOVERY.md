# Domain-Monitor — Disaster Recovery

> Verified recovery procedures and honest status of each scenario (updated 2026-08-18 for v0.8.0).

## Status of protections (factual)

| Protection                                 | Status                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local backups (keep 14)                    | **NOT PRESENT in the current container** — the legacy script/cron documented in earlier handovers was not recreated after the Phase 9J redeploy; the only local snapshot is the manual pre-deploy backup `domain-monitor.db.9J-backup-20260818-044056` (next to the production DB, mode 600). Re-establishing scheduled backups is an operator decision. |
| **Off-site backup (R2, keep 30)**          | **IMPLEMENTED & VERIFIED 2026-08-16** in the original deployment — real upload to `domain-monitor-backups/daily/` succeeded, download-back + `integrity_check` + data verification passed. Still single-copy in R2 (no versioning yet).                                                                                                                  |
| Automatic restart on process crash         | domain-monitor is started by the container entrypoint in the current container; cloudflared is supervisor-managed. Crash restart behavior for the app depends on the entrypoint wrapper.                                                                                                                                                                 |
| Automatic restart on **container rebuild** | **NOT IMPLEMENTED** — platform limitation; after a rebuild services must be started manually, then verified                                                                                                                                                                                                                                              |
| Off-machine / second-region copy           | NOT IMPLEMENTED (same volume local + R2 single copy)                                                                                                                                                                                                                                                                                                     |

## 1. Production DB corruption (e.g. `SQLITE_CORRUPT`, failing integrity_check)

1. Stop the app (kill the `next-server` process; `supervisorctl` does not manage domain-monitor in this container)
2. Pick the newest backup: `ls -1t /tmp/domain-monitor/data/domain-monitor.db.*backup* | head -1`
3. Verify: `sqlite3 <backup> "PRAGMA integrity_check;"` → `ok`
4. Copy to a **temp path first**: `cp <backup> /tmp/restore-check.db`; verify domains count matches expectation
5. `cp <backup> /tmp/domain-monitor/data/domain-monitor.db` (explicit target; never overwrite with an unchecked file)
6. `chmod 600` the DB; start the app again (entrypoint / `next start`)
7. Verify local 200 + public 200

Human steps: choosing the backup, confirming the target path.

## 2. Entire /tmp/domain-monitor (code + data) lost

1. Recreate directories: `mkdir -p /tmp/domain-monitor/data`
2. Re-clone the repo (source of truth: GitHub `hxx0611/Domain-Monitor`), `pnpm install --frozen-lockfile`, restore `.env` (operator holds `ENCRYPTION_KEY`, `SESSION_SECRET`, `DATABASE_URL`), `pnpm build`
3. If R2 backups exist: download from R2 `rclone copyto r2:domain-monitor-backups/daily/<latest> /tmp/restored.db`; `sqlite3 /tmp/restored.db "PRAGMA integrity_check;"` → `ok`; copy to `/tmp/domain-monitor/data/domain-monitor.db`; `chmod 600`
4. Start the app; verify app + tunnel + public URL

## 3. Container fully rebuilt

1. Reinstall runtime: Node ≥22, pnpm (corepack), project checkout at the v0.8.0 release commit, `pnpm install --frozen-lockfile`, `pnpm build`
2. Recreate the entrypoint / service config for domain-monitor (it is **not** supervisor-managed in the current container; cloudflared is supervisor-managed)
3. Reinstall cloudflared; **restore Tunnel credentials** (`cert.pem` + `f24997a3-….json`) — these live in the container; a copy must be held by the human operator
4. Restore `.env` — **`ENCRYPTION_KEY` is mandatory** (without it, encrypted notification secrets cannot be decrypted; the app must still start but Telegram token resolution fails controlled)
5. Restore DB from R2 (procedure 2)
6. Recreate rclone config (credentials from human), start services, verify public URL

Mostly **manual**; the DB restore part is scriptable.

## 4. Git recovery

- Code source of truth: GitHub `hxx0611/Domain-Monitor`, main = v0.8.0 release commit (see `git rev-parse origin/main`). Re-clone, `pnpm install --frozen-lockfile`, `pnpm build`. No local-only code exists.

## 5. Tunnel recovery

- Tunnel `domain-monitor` (`f24997a3-…`) + CNAME `domain-monitor.snooze.eu.cc` live in the Cloudflare account (not in the container) — they survive container loss. Only the local credentials files need restoring (step 3).

## 6/7. DB / backup restore — key rules

- Always restore to a temp path, integrity-check, then copy to the production path (never copy over a live DB without stopping the app).
- Never restore a `/tmp` scratch DB or the Phase 5 test DB (`/tmp/dm-e2e.db`) as production.
- `chmod 600` after restore; verify `DATABASE_URL` still points at the production path.
- After restoring a DB that contains encrypted secrets, confirm `ENCRYPTION_KEY` matches the key that encrypted them (mismatch → controlled failure, never plaintext fallback).

## 8. Health verification after any recovery

```bash
ps aux | grep 'next-server'                 # app RUNNING (not supervisor-managed)
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/          # 307 → /login (auth active)
curl -s -o /dev/null -w "%{http_code}" https://domain-monitor.snooze.eu.cc/login  # 200
cloudflared tunnel info domain-monitor        # CONNECTIONS > 0
node -e "const D=require('better-sqlite3');const db=new D('/tmp/domain-monitor/data/domain-monitor.db',{readonly:true});console.log(db.pragma('integrity_check')[0].integrity_check)"
```

## v0.8.0 deployment order (release/deploy gate)

1. `pnpm build` (production build; never skip)
2. **Restart the app** (build without restart = runtime mismatch — never allowed)
3. HTTP smoke: `/` → 307, `/login` → 200, `/setup` → 200 (after admin exists)
4. Browserless / real-browser render check (no Application/Hydration/ChunkLoad errors)
5. Leakage audit (no token/password/recovery code/ENCRYPTION_KEY in HTML/RSC/bundles/logs)
6. DB read-only verification (integrity, counts, secrets present as `iv:tag:ciphertext` only)

## Honest gaps

- **Container rebuild auto-start: NOT IMPLEMENTED** (platform limitation; manual start required).
- **Scheduled local backups: NOT PRESENT** in the current container (operator decision needed).
- **R2 Object Versioning: NOT ENABLED** (recommended; protects against accidental deletion/overwrite of remote backups).
- **Backup failure alerting: NOT IMPLEMENTED**.
