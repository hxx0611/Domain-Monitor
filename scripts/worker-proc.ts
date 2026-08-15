/**
 * V0.7 Phase 2 — test-only worker subprocess.
 *
 * A real, isolated Node process (spawned by worker-concurrency.test.ts)
 * that exercises the delivery worker against a REAL SQLite file shared
 * with other worker processes. This is what proves the CAS single-winner
 * guarantee under true multi-process concurrency — something same-process
 * Promise.all cannot demonstrate (better-sqlite3 is synchronous).
 *
 * Modes (DM_MODE env):
 * - "normal"            runOnce() with a LocalSender that POSTs delivery
 *                       ids to the parent's local HTTP server (counted).
 * - "crash-after-claim" claim the first pending delivery, print it, then
 *                       exit(1) — simulating a worker crash mid-send
 *                       (the delivery is left `sending` with claimedAt).
 * - "hold-lock"         BEGIN EXCLUSIVE, hold the SQLite write lock for
 *                       DM_HOLD_MS, then COMMIT and exit — simulates a
 *                       competing writer so busy_timeout can be observed.
 *
 * Never touches production code paths other than runOnce/repository.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "../src/db/schema";
import { runOnce } from "../src/lib/notifications/worker";
import {
  claimPendingDelivery,
  getPendingDeliveries,
  type NotificationDb,
} from "../src/lib/notifications/repository";
import type { DeliverySender } from "../src/lib/notifications/types";

const MODE = process.env.DM_MODE ?? "normal";
const PORT = Number(process.env.DM_PORT ?? 0);
const LIMIT = process.env.DM_LIMIT ? Number(process.env.DM_LIMIT) : undefined;
const STALE_MS = process.env.DM_STALE_MS ? Number(process.env.DM_STALE_MS) : undefined;
const FAIL_IDS = new Set((process.env.DM_FAIL_IDS ?? "").split(",").filter(Boolean).map(Number));

function openDb(): { db: NotificationDb; sqlite: Database.Database } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required.");
  }
  const sqlite = new Database(url);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return { db: drizzle(sqlite, { schema }), sqlite };
}

/** Fake sender: POSTs delivery ids to the parent's local HTTP server. */
class LocalSender implements DeliverySender {
  readonly channelType = "webhook" as const;

  constructor(private readonly port: number) {}

  async send(deliveryId: number): Promise<void> {
    if (FAIL_IDS.has(deliveryId)) {
      throw new Error(`injected failure for delivery ${deliveryId}`);
    }
    const response = await fetch(`http://127.0.0.1:${this.port}/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryId }),
    });
    if (!response.ok) {
      throw new Error(`local sender HTTP ${response.status}`);
    }
  }
}

async function main(): Promise<void> {
  const { db, sqlite } = openDb();
  const proc = process.env.DM_PROC_ID ?? "worker";

  if (MODE === "crash-after-claim") {
    // Claim the first pending delivery, then die before send — leaving
    // status='sending' + claimedAt for a later worker to recover.
    const pending = getPendingDeliveries(1, db);
    const claimed = pending.length > 0 ? claimPendingDelivery(pending[0].id, db) : false;
    console.log(JSON.stringify({ mode: "crash-after-claim", proc, claimed }));
    process.exit(1); // simulated crash (non-zero exit, no markSent/markFailed)
  }

  if (MODE === "hold-lock") {
    const holdMs = Number(process.env.DM_HOLD_MS ?? 1500);
    sqlite.exec("BEGIN EXCLUSIVE");
    console.log(JSON.stringify({ mode: "hold-lock", holding: true }));
    setTimeout(() => {
      sqlite.exec("COMMIT");
      console.log(JSON.stringify({ mode: "hold-lock", released: true }));
      process.exit(0);
    }, holdMs);
    return;
  }

  const startedAt = Date.now();
  const result = await runOnce({
    db,
    limit: LIMIT,
    staleAfterMs: STALE_MS,
    senders: () => new LocalSender(PORT),
  });
  console.log(JSON.stringify({ proc, timingMs: Date.now() - startedAt, ...result }));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      proc: process.env.DM_PROC_ID ?? "worker",
      fatal: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
