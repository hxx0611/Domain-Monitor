# Domain-Monitor — Architecture Decisions

> Recorded rationale for the significant decisions, in chronological order. Read this before proposing changes.

## Why Node + SQLite

- Single-user, self-hosted tool: a file-based SQLite database is the simplest reliable storage (zero ops, backup = copy, transactions, FK, full-text-free queries).
- Node.js gives native `tls`, `dns`, `fetch` for monitoring without extra services.
- No external database to provision; `DATABASE_URL` override keeps deployments flexible.

## Why better-sqlite3 13.0.3

- V0.7.2 fix: better-sqlite3 ≤11.x shipped per-ABI prebuilds (Node 18/20/22/23 only) → Node 24/25/26 fresh installs fell back to node-gyp → failed on Windows without Python/VS Build Tools.
- v13.x is N-API: prebuilt binaries ship inside the npm package (incl. win32-x64), no install script, works across Node 22/24/25/26.
- `pnpm-workspace.yaml` sets `allowBuilds: better-sqlite3: false` so pnpm never injects `node-gyp rebuild` (pnpm ignores npm's `gypfile: false` and unconditionally builds when `binding.gyp` exists and builds are allowed).

## Why Node >=22

- engines was `>=18` but pnpm 11.2.2 itself requires Node ≥22.13 — the README claim was already false.
- Node 22 LTS is the recommended baseline; 24/26 are CI-tested; Node 25 works via N-API prebuilds but is not officially supported (EOL 2026-06).

## Why not Cloudflare Workers + D1 (audited 2026-08-16)

- better-sqlite3 is a native C++ addon — cannot run in workerd; D1 would require replacing the driver and async-ifying the whole data layer (~15-20 files).
- D1 has **no SQL transactions** (batch only): the event→delivery atomicity (snapshot id → records → events dependency chain) can't be expressed in a batch — needs session transactions (unverified).
- `node:dns.lookup` and `node:tls` are only partially supported in Workers (lookup throws "Not implemented"; `tls.connect` partial, `getPeerX509Certificate()` unlisted) — SSL monitoring semantics at risk.
- Verdict: not worth it for a single-user self-hosted tool. If ever revisited, run P0/P1 spikes first (D1 session transactions, workerd TLS).

## Why Cloudflare Tunnel (instead of exposing :3000)

- No public inbound to the container; Tunnel gives a stable public HTTPS hostname with Cloudflare TLS, hiding the origin, no open firewall ports, free.
- CNAME `domain-monitor.snooze.eu.cc` → tunnel; ingress `http://127.0.0.1:3000`.
- Dedicated tunnel `domain-monitor`; pre-existing `time machine` tunnel is **never modified**.

## Why supervisor

- Container has no systemd (PID 1 = docker-init). supervisor (apt) manages two long-running programs with autorestart + logging.
- Known limitation: container rebuild by the platform does not restart supervisord (P0, documented).

## Why production DB is outside the repository

- `data/` inside the repo would risk committing live data and mixing code with state.
- Production DB lives at `/workspace/domain-monitor-data/domain-monitor.db` (platform persistent volume, mode 600); it is not tracked by Git.

## Why DNS failure does not persist a snapshot

- Atomicity: if any of the 7 record-type queries fails, a partial snapshot could look like records were deleted. Design: all-or-nothing — on failure write nothing, preserve previous snapshot, produce no events.
- Consequence: a failed DNS check is only visible transiently (button error + logs); there is no DNS error snapshot row (no `error` column on `dns_snapshots`).

## Why monitoring errors use machine codes (V0.7.3)

- Users got only generic "…monitoring unavailable."; real errors lived in logs.
- Stable prefixed codes (`dns_timeout`, `ssl_dns_failed`, `http_blocked_redirect`, …) are stored in snapshots and returned by actions; UI maps code → localized message; unknown/legacy values fall back to the generic message.

## Why raw errors stay server-side

- Raw messages may contain hostnames or resolved IPs (e.g. SSRF block message) and Node error details — never user-safe.
- Boundary: raw errors → `console.error` server logs only; actions/snapshots/HTML carry only machine codes; DB `error` columns store codes only.

## Why blocked_redirect never exposes raw IP

- `HttpError("Blocked address 10.x …")` would leak internal topology. The classifier maps it to `http_blocked_redirect` (code only); the message stays in the log. Verified by leakage tests.

## Notification semantics

- at-least-once, **no automatic retry** (failed deliveries stay failed; retry is explicit via UI), no backoff/max-attempts/scheduler; dedup via `dedupKey` UNIQUE + `(event_id, channel_id)` UNIQUE; CAS claim (`pending→sending`) prevents double send; stale recovery un-sticks `sending` rows after threshold.
- Senders use `secretRef`/`apiKeyRef` (env variable names) — secrets never stored in DB, never in payloads/errors/logs.

## Backup architecture

- Local: `sqlite3 .backup` → `PRAGMA integrity_check` → atomic `mv` → keep 14.
- Off-site (V0.7.3, 6M): rclone → Cloudflare R2 (`domain-monitor-backups/daily/`), upload to `.uploading` key → byte-size verification → `moveto` publish → remote keep 30. Upload failure never affects local backup or app.
- Recovery: restore to temp path → integrity check → explicit target + `--force` semantics to avoid overwriting the wrong DB.
- **Current production (Phase 13C/13C-1, 2026-08-20)**: `scripts/backup-db.js` uses the **better-sqlite3 official online backup API** (read-only source, consistent snapshot while next-server/worker write) to an **NFS persistent directory** (mode 600, survives container rebuild). Daily QwenPaw cron `domain-monitor-daily-backup` (`0 13 * * *` Asia/Shanghai), retention 7 days, failure → `backup-failures.log` + Telegram alert. Restore drill PASS. **Backup ≠ primary DB persistence** — the DB stays on `/tmp` overlay (Phase 13D blocked SQLite-on-NFS migration: NFSv3 `nolock` unsuitable for SQLite locking; PostgreSQL or a local persistent volume is the future direction).

## Environment facts that shape decisions

- `/workspace` and `/tmp` share xfs `/dev/sdb` (same persistent volume) — local backups are same-volume (not off-site).
- Container has no cron originally (installed), no systemd, no pm2/docker.
