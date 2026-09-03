# Phase 14C-5 — D1 Backup / Recovery

## Purpose
Define the safe, non-destructive backup/restore procedure for the D1 database
before applying migrations, with a hard guarantee that AES-256-GCM ciphertext
in `notification_secrets.encrypted_value` is **preserved byte-for-byte and never
decrypted or re-encrypted**.

The mechanism is validated on a **local/disposable D1** (never production).

## Backup format
- **Format**: `domain-monitor-d1-backup@1` — a gzip'd tar with three sections:
  1. `===SCHEMA===` — `CREATE TABLE` DDL (drift inspection)
  2. `===DATA===` — per-table `INSERT ... VALUES (...)` statements (data payload)
  3. `===MANIFEST===` — JSON metadata
- **Manifest fields**: `format`, `created` (UTC ISO), `tables[]`, `rowCounts{}`,
  `dumpSha256` (SHA-256 of the DATA section for integrity), `secretColumns`
  (`["encrypted_value"]`), `ciphertextPreserved` (count of secret rows).
- **Ciphertext handling**: the `notification_secrets.encrypted_value` column is
  copied **verbatim** in the INSERT. It is NEVER decrypted, NEVER re-encrypted,
  NEVER printed in the manifest.

## Storage & permission
- Write to a **persistent directory outside the repo** (survives container
  rebuild), matching the existing `backup-db.js` convention.
- Backup tarball file mode **0400** (read-only, immutable). Manifest also 0400.
- Retention: **7 days** auto-prune (matches existing production backup policy).
- Never stored in the Git repo.

## Integrity verification
- `dumpSha256` (SHA-256 of the data dump) is re-computed on restore and MUST
  match the manifest — detects silent truncation/corruption.
- `PRAGMA foreign_key_check` must return 0 rows (FK integrity preserved).

## Restore procedure
1. Fresh disposable D1.
2. Apply migrations 0000-0007 (build schema) — mirrors `wrangler d1 migrations
   apply`.
3. Load the DATA INSERT statements from the backup (with `PRAGMA
   foreign_keys=OFF` during bulk load, then re-enable).
4. Re-run `PRAGMA foreign_key_check` — must be clean.

## Rollback
- The backup is **taken before the migration**. If the migration fails or
  corrupts data, the production DB is restored from the last immutable backup
  (restore procedure above), then re-verified. No migration is ever applied
  without a verifiable backup first.

## Secret handling (hard rules)
- `notification_secrets.encrypted_value` is **never** decrypted during backup.
- **Never** print: token, `ENCRYPTION_KEY`, `SESSION_SECRET`, or plaintext
  secret value.
- The only fake token used in validation is
  `AAH_TEST_TOKEN_ONLY_14C5_backup` (a placeholder, never a real credential),
  and it is confirmed **absent** from the ciphertext after encryption.
- The validation asserts: ciphertext has `iv:tag:ciphertext` shape, is preserved
  byte-for-byte, and does NOT contain the plaintext.

## Failure modes & handling
| Failure | Detection | Handling |
|---|---|---|
| Source unreachable | export throws | STOP; do not apply migration |
| Backup truncated | manifest `dumpSha256` mismatch on restore | abort restore; re-export |
| FK violations after restore | `foreign_key_check` non-empty | abort; re-export / fix ordering |
| Migration fails on restored copy | `wrangler d1 migrations apply` error | rollback to backup; investigate |
| Secret decryption failure | encrypted_value unreadable | never emitted; preserve ciphertext |

## Validation result (local/disposable, 2026-08-27)
`prototype/backup/d1-backup-restore.js` — all 10 assertions PASS:
- schema verified (13 tables + `d1_migrations`), key columns present
- row counts match source
- ciphertext `preservedByteForByte: true`, `hasIvTagCtShape: true`,
  `doesNotContainPlaintext: true`
- no FK violations after restore
- business smoke: secret present as ciphertext, delivery CAS-claimable,
  event-join query works
- immutable backup tarball non-empty

**This is a rehearsal on a disposable/local D1. No production D1 was exported,
migrated, or touched.**
