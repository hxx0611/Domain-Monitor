# Domain-Monitor — Deployment Handover

> Deployment facts as verified 2026-08-16. Credentials are reported only as CONFIGURED / NOT CONFIGURED — never values.
>
> ⚠️ **As of v0.8.0 (Phase 9J redeploy, 2026-08-18) this file describes the ORIGINAL deployment.** In the current container the app is started by the container **entrypoint** (supervisor only manages cloudflared/system services), the production DB is `/tmp/domain-monitor/data/domain-monitor.db`, and the scheduled backup cron/script is not present. Current facts: `docs/PROJECT_HANDOVER.md`, `docs/DATABASE.md`, `docs/DISASTER_RECOVERY.md`.

## Topology

```
Internet → Cloudflare DNS/HTTPS → Tunnel `domain-monitor` (f24997a3-…)
        → 127.0.0.1:3000 → next-server (supervisor: domain-monitor)
        → /workspace/domain-monitor-data/domain-monitor.db
cloudflared tunnel run domain-monitor (supervisor: cloudflared-domain-monitor)
```

## Verified environment facts (2026-08-16)

| Item            | Value                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OS              | Debian 12 (bookworm), Linux 6.8.0 x86_64, container (PID 1 = docker-init, **no systemd**)                                                                                                                                                        |
| Node version    | v24.16.0 at `/usr/local/bin/node` (≥22; 22 LTS recommended, 22/24/26 CI-verified)                                                                                                                                                                |
| pnpm version    | 11.2.2 at `/usr/local/bin/pnpm`                                                                                                                                                                                                                  |
| supervisor      | 4.2.5 (apt), config `/etc/supervisor/conf.d/domain-monitor.conf`                                                                                                                                                                                 |
| cloudflared     | 2026.8.2 at `/usr/local/bin/cloudflared`                                                                                                                                                                                                         |
| Tunnel name     | `domain-monitor`                                                                                                                                                                                                                                 |
| Tunnel ID       | `f24997a3-3ec4-4248-984f-d02ef6129477`                                                                                                                                                                                                           |
| Public hostname | `https://domain-monitor.snooze.eu.cc`                                                                                                                                                                                                            |
| Local binding   | `127.0.0.1:3000` (explicit `next start -H 127.0.0.1 -p 3000`; do NOT bind 0.0.0.0)                                                                                                                                                               |
| Production DB   | `/workspace/domain-monitor-data/domain-monitor.db` (106 KB, mode 600, 2 domains, 6 migrations, 10 tables)                                                                                                                                        |
| Backup dir      | `/workspace/domain-monitor-backups/` (mode 750)                                                                                                                                                                                                  |
| Off-site backup | Cloudflare R2 bucket `domain-monitor-backups` (rclone remote `r2`, daily/ prefix)                                                                                                                                                                |
| cron            | `/etc/cron.d/domain-monitor-backup`: `30 3 * * * root /usr/local/bin/domain-monitor-backup`                                                                                                                                                      |
| Backup script   | `/usr/local/bin/domain-monitor-backup` (mode 750)                                                                                                                                                                                                |
| Log paths       | `/var/log/domain-monitor.log`, `/var/log/domain-monitor-error.log`, `/var/log/cloudflared-domain-monitor.log`, `/var/log/cloudflared-domain-monitor-error.log`, `/var/log/domain-monitor-backup.log`, `/var/log/domain-monitor-backup-error.log` |
| Filesystem      | `/workspace` and `/tmp` share xfs `/dev/sdb` (10 GB, ~3.7 GB free); `/workspace` is the platform persistent volume                                                                                                                               |

## Credentials map (presence only)

| Credential                     | Status                      | Location (never values)                                                                                                      |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GitHub fine-grained PAT        | CONFIGURED                  | `/workspace/gh-token.txt/` (directory name holds the token) — note `/workspace/.credentials/github.token` is **expired/403** |
| Cloudflare Tunnel origin cert  | CONFIGURED                  | `/root/.cloudflared/cert.pem` (mode 600)                                                                                     |
| Tunnel credentials JSON        | CONFIGURED                  | `/root/.cloudflared/f24997a3-….json` (mode 600)                                                                              |
| R2 S3 credentials              | CONFIGURED                  | `/root/.config/rclone/rclone.conf` (mode 600)                                                                                |
| cloudflare.token (API)         | CONFIGURED but empty-policy | `/workspace/.credentials/cloudflare.token` — effectively unusable                                                            |
| EMAIL_API_KEY / WEBHOOK_SECRET | NOT CONFIGURED              | not set (no notification channels configured)                                                                                |

## Startup architecture

- `supervisord` (system service) manages two programs:
  - `domain-monitor`: `node …/next/dist/bin/next start -H 127.0.0.1 -p 3000`, `NODE_ENV=production`, `DATABASE_URL=/workspace/domain-monitor-data/domain-monitor.db`, `NEXT_PUBLIC_APP_URL=https://domain-monitor.snooze.eu.cc`; autorestart, startsecs 5.
  - `cloudflared-domain-monitor`: `cloudflared tunnel run domain-monitor` (uses `/root/.cloudflared/config.yml` + credentials JSON); autorestart.

## Restart procedure

```bash
supervisorctl status
supervisorctl restart domain-monitor
supervisorctl restart cloudflared-domain-monitor
```

After restart, verify: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/` and `curl -s -o /dev/null -w "%{http_code}" https://domain-monitor.snooze.eu.cc/` → 200.

## Health check

- Local: `curl http://127.0.0.1:3000/`
- Public: `curl https://domain-monitor.snooze.eu.cc/` and `/notifications`
- Tunnel: `cloudflared tunnel info domain-monitor` → CONNECTIONS > 0

## Don't-touch list

- Tunnel `time machine` (ID `e71ffcb1-5756-44eb-a060-31e053bfbae3`) — pre-existing, never modify.
- Cloudflare DNS records for the zone (only the one CNAME `domain-monitor.snooze.eu.cc` → tunnel was added).
- Production DB contents (2 test domains currently: opusai.eu.cc, apitoken.indevs.in — pending user decision).
