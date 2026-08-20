# Domain-Monitor — Operations Runbook

> Operational procedures for the production deployment. No credentials here.
>
> ⚠️ **As of v0.8.0 (Phase 9J redeploy, 2026-08-18) this runbook describes the ORIGINAL deployment only** (v0.8.2 / v0.8.3 do not change it). In the current container the app is started by the **container entrypoint** (not supervisor-managed), the production DB is `/tmp/domain-monitor/data/domain-monitor.db`, and **scheduled backup is implemented via Phase 13C** (QwenPaw cron `domain-monitor-daily-backup`; NFS persistent backup dir; see `docs/PROJECT_HANDOVER.md`, `docs/DATABASE.md`, and `docs/DISASTER_RECOVERY.md` for the current facts; keep this file for reference to the original supervisor-based setup).

## Status

```bash
supervisorctl status
# domain-monitor                  RUNNING …
# cloudflared-domain-monitor      RUNNING …
ss -tlnp | grep :3000            # expect 127.0.0.1:3000 only
cloudflared tunnel info domain-monitor   # expect CONNECTIONS > 0
```

## Restart

```bash
supervisorctl restart domain-monitor
supervisorctl restart cloudflared-domain-monitor
```

After restart, verify:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
curl -s -o /dev/null -w "%{http_code}\n" https://domain-monitor.snooze.eu.cc/
curl -s -o /dev/null -w "%{http_code}\n" https://domain-monitor.snooze.eu.cc/notifications
```

## Logs

| Log                                             | Content                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/var/log/domain-monitor.log`                   | app stdout (next server)                                                               |
| `/var/log/domain-monitor-error.log`             | app stderr — **monitoring raw errors live here** (`[dns]/[ssl]/[http] check failed …`) |
| `/var/log/cloudflared-domain-monitor.log`       | tunnel stdout                                                                          |
| `/var/log/cloudflared-domain-monitor-error.log` | tunnel stderr                                                                          |
| `/var/log/domain-monitor-backup.log`            | backup successes                                                                       |
| `/var/log/domain-monitor-backup-error.log`      | backup/R2 failures                                                                     |

Tail: `tail -f /var/log/domain-monitor-error.log`

## Health checks

- Public: `curl -I https://domain-monitor.snooze.eu.cc/` → 200
- Dashboard/notifications: both 200; HTML contains "Domain Monitor"; zh-CN via cookie `domain-monitor-locale=zh-CN`
- Tunnel: `cloudflared tunnel info domain-monitor` → CONNECTIONS ≥ 1

## Backup

```bash
/usr/local/bin/domain-monitor-backup     # manual run (local + R2 upload)
ls /workspace/domain-monitor-backups/    # local: keep 14
rclone lsl r2:domain-monitor-backups/daily/   # off-site: keep 30
```

Cron: `/etc/cron.d/domain-monitor-backup` → `30 3 * * * root /usr/local/bin/domain-monitor-backup`.

## Restore

See `DISASTER_RECOVERY.md`. Golden rule: restore to a **temp path** first, `PRAGMA integrity_check`, then copy to the production path with correct owner/mode (600) and restart the app.

## Failure diagnosis

| Symptom                                                | Check                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Public site down, local 200                            | `cloudflared tunnel info domain-monitor` (connectors); `tail /var/log/cloudflared-domain-monitor-error.log`                        |
| Local 3000 down                                        | `supervisorctl status domain-monitor`; `tail /var/log/domain-monitor-error.log`                                                    |
| "…monitoring unavailable." on a domain                 | Read the `[dns]/[ssl]/[http] check failed` line in `/var/log/domain-monitor-error.log`; map to error code via `docs/MONITORING.md` |
| Domain fails with `ssl_dns_failed` / `http_dns_failed` | Domain does not resolve (public DNS) — check `dig`/DoH for the hostname                                                            |
| 502/503 from Cloudflare                                | Origin unreachable: local 3000 down or cloudflared connector lost                                                                  |
| Backup failing                                         | `tail /var/log/domain-monitor-backup-error.log`                                                                                    |

## Common problems & invariants

- **Never bind 3000 to 0.0.0.0** — production supervisor config uses `-H 127.0.0.1`.
- **Never point DATABASE_URL at /tmp** — production is `/workspace/domain-monitor-data/domain-monitor.db`.
- **Never modify the `time machine` tunnel** (`e71ffcb1-…`).
- **No systemd** — use supervisorctl, not systemctl/journalctl.
- Container rebuild does not restart supervisor (platform limitation) — after a rebuild, re-run `supervisord -c /etc/supervisor/supervisord.conf` and verify services.
