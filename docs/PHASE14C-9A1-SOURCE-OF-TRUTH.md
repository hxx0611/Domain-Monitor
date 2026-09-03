# Phase 14C-9A.1 — Source-of-Truth & Production State Verification

**Date:** 2026-08-28 (Asia/Shanghai)
**Mode:** STRICT READ-ONLY — zero side effects
**Final Status:** **BLOCKED** (CASE E — Node state UNKNOWN)

---

## §1 Production Process State

### Observed (read-only)

| Check item | Result |
| --- | --- |
| next-server PID | **not present** in this execution environment |
| worker-watchdog PID | **not present** |
| cloudflared PID | **not present** |
| domain-monitor working dir | `/tmp/domain-monitor` **does not exist** |
| process cmdline | no `next-server` / `cloudflared` / `domain-monitor` / watchdog process |
| process start time | N/A — no matching process |

### Environment identity (decisive context)

- Current execution environment is a **Kubernetes pod**: hostname `qwenpaw-sbs-prod-dmwqj`, `/proc/1/cgroup` shows `kubepods/poduid/…`.
- PID 1 = `supervisord` running only QwenPaw platform components (`dbus` / `app` / `xvfb` / `xfce4`). The supervisor config contains **no** cloudflared / next-server / domain-monitor program.
- `/etc/cloudflared/`, `/usr/local/bin/cloudflared`, `/var/log/cloudflared.log` — **all absent**.
- This sandbox is **isolated from the production host** (mounts are NFS workspace/secrets/backups/providers only).

### Classification

**UNKNOWN** — cannot observe production host processes from this isolated sandbox. No local production process exists.

*Indirect signals consistently point to production being down* (public 530 tunnel disconnect + daily backups stopped after 08-25), but this cannot be proven from inside the sandbox, so the state is recorded as UNKNOWN rather than STOPPED.

---

## §2 Production SQLite Access

`/tmp/domain-monitor/data/domain-monitor.db` → **NOT ACCESSIBLE**.

- `ls /tmp/domain-monitor` → `No such file or directory`
- `stat` on the db path → `ENOENT`
- No host filesystem mount exposing `/tmp/domain-monitor`

> **Production live SQLite is inaccessible from the current execution environment.** No data inferred from it.

---

## §3 Backup Inventory

Location: `domain-monitor-backups/` (NFS-backed, workspace root)

| Snapshot | Size | Perm | MD5 |
| --- | --- | --- | --- |
| 2026-08-20 09:48 | 126976 | 600 root:root | `d2ede0310e…` |
| 2026-08-20 11:01 | 126976 | 600 root:root | `d2ede0310e…` |
| 2026-08-21 05:00 | 126976 | 600 root:root | `d2ede0310e…` |
| 2026-08-22 05:00 | 126976 | 600 root:root | `d2ede0310e…` |
| 2026-08-23 05:00 | 126976 | 600 root:root | `d2ede0310e…` |
| 2026-08-24 05:00 | 126976 | 600 root:root | `d2ede0310e…` |
| **2026-08-25 06:50** | 126976 | 600 root:root | `d2ede0310e…` |

- **Count:** 7 snapshots
- **Latest timestamp:** 2026-08-25 06:50:52
- **All 7 MD5 identical** (`d2ede0310ea16ae856e508d1356123e4`) and SHA256 identical (`d58b7abc…49ab`) → data fully static 08-20 → 08-25.
- **Integrity:** `integrity_check = ok`, `foreign_keys = 1`, FK violations = **0**
- **Schema:** 13 business tables + `__drizzle_migrations` (+ `sqlite_sequence`) — 12 indexes
- **Migrations:** 8 rows (0000→0007), last hash `f4c068aa1d31…` = 0007
- **Row counts:** domains=3, dns_records=30, dns_snapshots=5, ssl_certificates=3, ssl_snapshots=4, http_snapshots=4, notification_channels=1, notification_deliveries=7, notification_events=7, notification_rules=5, notification_secrets=1, admin_settings=1, expiration_reminders=1

**No backups deleted or modified.**

---

## §4 Source Parity

Live SQLite: **NOT ACCESSIBLE**. Therefore:

> **LATEST BACKUP = LAST KNOWN GOOD SNAPSHOT** (NOT claimed as current).

Live-vs-backup parity comparison is **impossible** in this environment.

---

## §5 Production Availability

`https://domain-monitor.snooze.eu.cc/` → **HTTP 530** (Argo Tunnel disconnected).
`https://domain-monitor.snooze.eu.cc/login` → **HTTP 530**.

> **PUBLIC SERVICE = UNAVAILABLE.** No tunnel/DNS modification performed.

---

## §6 Migration Source Decision

| Input | Value |
| --- | --- |
| Node state | **UNKNOWN** (isolated sandbox, cannot observe host) |
| Live DB | **NOT ACCESSIBLE** |
| Latest backup integrity | **PASS** |
| Backup == live? | **cannot verify** |

Live DB is unreadable AND Node state cannot be confirmed as STOPPED. Per the decision matrix this is **CASE E**.

> **STATUS = BLOCKED** — cannot prove the 08-25 backup is current. Do not migrate.

---

## §7 D1 Credential Capability

- Token type: `cfat_…` (new-format account-scoped OAuth token) — valid.
- `/user` and `/user/tokens` → HTTP 403 (token is account-scoped, not user-scoped; not a legacy API token).
- `GET /accounts/{acc}/d1/database` → **HTTP 200** → D1 **Read** scope confirmed.
- `GET /accounts/{acc}/workers/scripts` → **HTTP 200** → Workers **Read** scope confirmed.
- D1 **Edit/Write** scope: **NOT verifiable via read-only probes**. No D1 created (forbidden this phase).

> **D1 WRITE AUTHORIZATION = NOT AVAILABLE (unconfirmed).** Token exhibits read scope only. Write scope cannot be conclusively proven or disproven without a write operation, which is prohibited this phase.

---

## §8 Security

No sensitive material emitted. Only existence / permission-category / masked identifiers shown:
- Token → `cfat_…` (masked), scope category only
- Account id → `b9dd2c…61d6` (masked)
- D1 database ids → first-8-chars only where referenced

No Telegram token, ENCRYPTION_KEY, SESSION_SECRET, ciphertext, Authorization, full account_id, or full database_id was printed at any point.

---

## §9 Production Safety (all zero)

- D1 created = **0**
- D1 remote write = **0**
- Worker deploy = **0**
- DNS change = **0**
- process restart = **0**
- database mutation = **0**
- secret write = **0**
- Telegram send = **0**
- Webhook send = **0**
- Email send = **0**

---

## FINAL STATUS

# BLOCKED

**Reason (CASE E):** Production Node state is UNKNOWN from this isolated sandbox; live SQLite is NOT ACCESSIBLE; therefore the 08-25 NFS backup is only a *last-known-good snapshot*, not a *verified current* snapshot. Per §4, it must not be claimed as current, and per §6 CASE E, migration must not proceed.

**No D1 created. No migration. No deploy. No production change. No commit/push/release.**

### To unblock (requires user decision)

1. Confirm production host state: is the Node/domain-monitor instance stopped?
2. If stopped → the 08-25 backup is the authoritative source (CASE A path).
3. If running elsewhere → provide live DB access or a fresh live copy; otherwise blocker stands.
4. Confirm whether the `cfat_…` token has D1 **Edit** (write) scope, or provide a write-scoped credential for future D1 provisioning.