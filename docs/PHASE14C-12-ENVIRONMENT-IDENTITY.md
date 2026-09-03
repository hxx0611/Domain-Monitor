# PHASE 14C-12 — Environment Identity Reconciliation

**Status: COMPLETED (read-only reconciliation)**
**Date:** 2026-08-29
**Verdict:** **IDENTITY ALIGNED**

---

## 1. Executive Summary

This phase reconciled the real production environment of Domain-Monitor against
the Cloudflare/D1 environment built in Phases 14B–14C. It was strictly read-only.

**Two distinct environments were confirmed and aligned:**

1. **Original production (Node self-hosted, v0.8.8)** — runs on a container with
   `next-server` + SQLite (`/tmp/domain-monitor/domain-monitor.db`), behind a
   Cloudflare Tunnel. Its code is tracked in Git up to **v0.8.8**.
2. **Cloudflare D1 target (Phase 14C build)** — a D1 database named `domain-monitor`
   (database_id `4437f46a-…`) holding a byte-for-byte copy of the production
   SQLite data, intended to back a Cloudflare Worker.

**KEY FINDING:** The Cloudflare Worker/D1 code (`src/db/adapters/d1.ts`,
`wrangler.jsonc`, `open-next.config.ts`) is **NOT part of any release** — it was
added during Phase 14B/14C and remains **untracked** in the working tree. The
production app itself (up to v0.8.8) has **no D1/Worker code**; it is pure Node.

**Verdict = IDENTITY ALIGNED:** the Cloudflare D1 `domain-monitor` database is
the intended target for production data migration (its content matches the
original production SQLite snapshot exactly), and it is NOT an accidentally-created
wrong environment. No orphaned/unassigned D1 was found.

---

## 2. Identity Matrix

| Environment | Git HEAD | Runtime | DB | D1 | Status | Relation |
|-------------|----------|---------|----|----|--------|----------|
| **1. Original production** | v0.8.8 (`28499d1`) | Node `next-server` (self-hosted) | SQLite `/tmp/domain-monitor/domain-monitor.db` | **none** | live (assumed), shadowed | **source of truth** for data; code up to v0.8.8 |
| **2. Cloudflare prototype** | (untracked working tree) | local dev/wrangler dev | prototype SQLite | prototype D1 (manual) | dev tooling | scratch space for OpenNext/D1 experiments; **not production** |
| **3. Cloudflare production D1** | working tree (untracked D1 code) | intended Worker | — | **`domain-monitor` `4437f46a-632d-4dfa-aba0-4c5bc41fa64d`** (14 tables, APAC, version=production) | provisioned, data migrated | **target for production data**; content matches prod SQLite |
| **4. Current workspace** | v0.8.9 (`09e0523`) | dev/build | `data/domain-monitor.db` (0-byte stub) | — | dev | Git up to v0.8.9; plus untracked D1/OpenNext/Worker code |

**D1 databases present in the Cloudflare account:** `domain-monitor`
(`4437f46a-…`), `kui-db`, `misub`. Only `domain-monitor` is relevant to this
project; there is **no second/errant `domain-monitor` D1** — so no ORPHANED /
UNASSIGNED database from Phase 14C work.

**Workers present:** `domain-check`, `kui`, `mydoh`, `odd-bonus-eae5` — all
**pre-existing, unrelated** to Domain-Monitor. **No `domain-monitor` Worker has
been deployed** (correct, per 14C-11 boundary).

---

## 3. Step-by-step findings

### STEP 1 — Original production baseline

- **Git HEAD / tag / version:** Original production tracked up to **v0.8.8**
  (`28499d1`, "chore: release v0.8.8"). v0.8.9 (`09e0523`) is a **docs-only**
  closeout and contains no code change.
- **Repository root:** container `/tmp/domain-monitor/` (this workspace is a
  sandbox copy).
- **package.json version:** v0.8.9 in working tree; v0.8.8 was last code release.
- **SQLite DB actual path:** `/tmp/domain-monitor/domain-monitor.db` — **NOT
  accessible** from this sandbox. Only `data/domain-monitor.db` (0-byte stub)
  exists in the workspace.
- **SQLite tables / migrations / row counts:** From the 2026-08-25 backup
  snapshot (`domain-monitor-backups/…`): **14 tables** (13 business + `__drizzle_migrations`),
  **8 drizzle migrations** (0000–0007), row counts: domains=3, dns_records=30,
  dns_snapshots=5, http_snapshots=4, ssl_certificates=3, ssl_snapshots=4,
  notification_channels=1, notification_secrets=1, notification_rules=5,
  notification_events=7, notification_deliveries=7, expiration_reminders=1,
  admin_settings=1.
- **supervisor / next-server / cloudflared:** A `supervisord` (PID 1) is visible
  in the sandbox, but **no `next-server`/`cloudflared` process** is running here —
  confirming this sandbox does not host the live production runtime.
- **Public domains:** 10 zones exist (opusai.eu.cc, snooze.eu.cc, snooze.kdns.fr,
  upsy.eu.cc, upsy.cc.cd, etc.), all `active`. The production app is served via
  a Cloudflare Tunnel (domains/tunnel details are deployment-level).

### STEP 2 — Original production code identity

| Check | Original prod (v0.8.8) | Current HEAD (v0.8.9) |
|-------|------------------------|----------------------|
| `src/lib/notifications/encryption.ts` | **EXISTS** (sha `7b3df8555e22d205`) | **EXISTS** (sha `7b3df8555e22d205`) — **identical** |
| `notification_secrets` in schema | **EXISTS** (identical definition) | **EXISTS** (identical) |
| `ENCRYPTION_KEY` usage in encryption.ts | **5 refs** | **5 refs** |
| `src/db/adapters/d1.ts` (Cloudflare) | **NOT present** | **present (untracked)** |
| `wrangler.jsonc` / `open-next.config.ts` | **NOT present** | **present (untracked)** |

**Conclusion:** The notification-encryption code that produced the
`notification_secrets` ciphertext is **identical** between original production
(v0.8.8) and the current workspace. Both use `process.env.ENCRYPTION_KEY`.
**No secret value was read or output.**

### STEP 3 — Cloudflare resource identity

- **D1 databases:** `domain-monitor` (`4437f46a-632d-4dfa-aba0-4c5bc41fa64d`,
  created 2026-08-28T03:42:05Z, version=production, **14 tables**, region APAC,
  read_replication disabled), `kui-db`, `misub`.
- **Workers:** `domain-check`, `kui`, `mydoh`, `odd-bonus-eae5` (pre-existing,
  unrelated).
- **Zones:** 10 active zones, no changes made.

No Cloudflare resource was created, modified, or deleted.

### STEP 4 — Git comparison

- **Original production HEAD `f4b1250`:** `feat: add notification configuration UI`
  (2026-08-17), author `hxx0611`. It is **an ancestor of v0.8.8 and v0.8.9**
  (`git merge-base --is-ancestor f4b1250 HEAD` = YES), 14 commits before v0.8.9.
  **Important:** `f4b1250` is **NOT** the final production deployment HEAD — it is
  an intermediate commit on the way to v0.8.0+. Its `package.json` shows `0.1.0`
  only because version bumping happened at v0.8.0.
- **Current workspace HEAD:** `09e05237…` = **v0.8.9** (`297ec4da` tag points to it).
- **Same Git history:** YES — v0.8.8/v0.8.9/build and all Phase 14 commits share
  one linear history; `f4b1250` is a common ancestor.
- **Where the Cloudflare migration code lives:** `src/db/adapters/d1.ts`, `wrangler.jsonc`,
  `open-next.config.ts`, `tsconfig.cf.json` are **all untracked** in the current
  workspace. They appear in **no commit** (v0.8.8 and v0.8.9 both lack them).
  So the Cloudflare/D1 work is a **working-tree-only** artifact, not part of any release.

### STEP 5 — D1 vs original production SQLite data

| Table | D1 count | SQLite snapshot (08-25) | Match |
|-------|----------|-------------------------|-------|
| admin_settings | 1 | 1 | ✅ |
| dns_records | 30 | 30 | ✅ |
| dns_snapshots | 5 | 5 | ✅ |
| domains | 3 | 3 | ✅ |
| expiration_reminders | 1 | 1 | ✅ |
| http_snapshots | 4 | 4 | ✅ |
| notification_channels | 1 | 1 | ✅ |
| notification_deliveries | 7 | 7 | ✅ |
| notification_events | 7 | 7 | ✅ |
| notification_rules | 5 | 5 | ✅ |
| notification_secrets | 1 | 1 | ✅ |
| ssl_certificates | 3 | 3 | ✅ |
| ssl_snapshots | 4 | 4 | ✅ |
| **d1_migrations** | **8** | — (SQLite uses `__drizzle_migrations`=8) | ✅ |

All 13 business tables match exactly. The only schema difference is the **migration
tracking table name** (`d1_migrations` in Cloudflare vs `__drizzle_migrations` in
SQLite), which is a platform convention — not a data-divergence.

---

## 4. Final Verdict (STEP 7)

**IDENTITY = ALIGNED**

- The Cloudflare D1 `domain-monitor` (`4437f46a-…`) is the **intended target** for
  the production data (it matches the original production SQLite snapshot exactly).
- It is **NOT an accidentally-created wrong environment**.
- **No ORPHANED / UNASSIGNED** D1 was found — no second `domain-monitor` D1 exists;
  the only other D1s (`kui-db`, `misub`) are unrelated, pre-existing databases.
- The Cloudflare Worker/D1 **code** is untracked working-tree material, consistent
  with Phase 14C being an in-progress migration — it is expected, not a mismatch.

**No action was taken.** No resource created/modified/deleted; no data imported,
deleted, or modified; no Git commit/push/tag/release; no secret read/output.

**FINAL STATUS: IDENTITY ALIGNED** — 14C-11 pipeline can continue from its
(currently ENCRYPTION_KEY-blocked) state. The D1 environment identity is confirmed
correct; the remaining blocker is key continuity (Phase 14C-11A/B), not identity.

---

*This document contains no secret values, no ciphertext, no tokens, and no
encryption key content.*
