/**
 * V0.7 Phase 2 — worker concurrency / crash recovery / SQLite stress.
 *
 * The PRIMARY concurrency evidence here is REAL independent Node
 * processes: each spawned worker-proc.ts opens its own connection to the
 * SAME SQLite file, races through claimPendingDelivery (CAS), and reports
 * sends to a local HTTP server that counts every delivery id. Same-process
 * Promise.all tests (already in worker.test.ts) are only a supplement.
 *
 * Run with:
 *   pnpm vitest run --config scripts/vitest.phase2.config.ts
 *
 * Everything stays local: in-memory HTTP server on 127.0.0.1, SQLite files
 * under os.tmpdir(), fake LocalSender — no real third parties, no
 * production DB, no production processes.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "@/db/schema";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import type { NotificationDb } from "@/lib/notifications/repository";
import { createHttpSnapshot } from "@/lib/http/repository";
import type { NotificationEvent } from "@/lib/notifications/types";

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const PROC = path.join(ROOT, "scripts", "worker-proc.ts");
const CLI = path.join(ROOT, "scripts", "worker.ts");

const WEBHOOK_CONFIG = JSON.stringify({ url: "https://127.0.0.1/wh" });
const NOW = new Date("2026-08-14T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn one real Node process via tsx. */
function runProc(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
  timeoutMs = 30_000,
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ["--conditions=react-server", script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`subprocess timed out after ${timeoutMs}ms: ${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parse the JSON summary line a worker-proc/CLI prints. */
function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

/** Real SQLite file with the full migration history applied. */
function createFileDb(file: string): NotificationDb {
  const sqlite = new Database(file);
  const migrationsDir = path.join(ROOT, "src/db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.exec(readFileSync(path.join(migrationsDir, f), "utf8"));
  }
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

/** Seed domain + N webhook channels + rules + one event. */
function seedChannels(
  db: NotificationDb,
  count: number,
): { channelIds: number[]; eventId: number } {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  const channelIds = Array.from(
    { length: count },
    (_, i) =>
      db
        .insert(notificationChannels)
        .values({ type: "webhook", name: `wh-${i}`, config: WEBHOOK_CONFIG, enabled: 1 })
        .returning({ id: notificationChannels.id })
        .get().id,
  );
  for (const id of channelIds) {
    db.insert(notificationRules)
      .values({
        name: `rule-${id}`,
        channelId: id,
        source: null,
        eventType: null,
        domainId: null,
        enabled: 1,
      })
      .run();
  }
  const eventId = db
    .insert(notificationEvents)
    .values({
      domainId: 5,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      dedupKey: "http:5:http_status_changed:ok:down",
      occurredAt: NOW,
    })
    .returning({ id: notificationEvents.id })
    .get().id;
  return { channelIds, eventId };
}

function insertPendingDelivery(db: NotificationDb, eventId: number, channelId: number): number {
  return db
    .insert(notificationDeliveries)
    .values({ eventId, channelId, status: "pending", attempts: 0 })
    .returning({ id: notificationDeliveries.id })
    .get().id;
}

function setSending(db: NotificationDb, deliveryId: number, claimedAt: Date): void {
  db.update(notificationDeliveries)
    .set({ status: "sending", claimedAt, attempts: 1 })
    .where(eq(notificationDeliveries.id, deliveryId))
    .run();
}

interface DeliverServer {
  port: number;
  hits: Map<number, number>;
  order: number[];
  close: () => Promise<void>;
}

/** Local HTTP server counting every /deliver POST by delivery id. */
function startServer(): Promise<DeliverServer> {
  const hits = new Map<number, number>();
  const order: number[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/deliver") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { deliveryId } = JSON.parse(body) as { deliveryId: number };
        hits.set(deliveryId, (hits.get(deliveryId) ?? 0) + 1);
        order.push(deliveryId);
        res.writeHead(200);
        res.end("ok");
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        hits,
        order,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Sum a worker's counts across a batch of results. */
function sumCounts(results: Array<Record<string, unknown>>, key: string): number {
  return results.reduce((acc, r) => acc + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "phase2-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Two real workers, one pending delivery
// ---------------------------------------------------------------------------

describe("real multi-process concurrency", () => {
  it("auto-generated pending (check transaction) raced by two workers: one send, attempts = 1", async () => {
    const dbFile = path.join(dir, "autogen.db");
    const db = createFileDb(dbFile);
    // Seed domain + webhook channel + rule, then run the REAL check
    // transaction so the pending delivery is auto-generated by
    // Event → Delivery (V0.7 Phase 4): snapshot + event + delivery commit
    // together inside createHttpSnapshot.
    db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
    const ch = db
      .insert(notificationChannels)
      .values({ type: "webhook", name: "wh", config: WEBHOOK_CONFIG, enabled: 1 })
      .returning({ id: notificationChannels.id })
      .get();
    db.insert(notificationRules)
      .values({
        name: "r",
        channelId: ch.id,
        source: "http",
        eventType: null,
        domainId: null,
        enabled: 1,
      })
      .run();
    const event: NotificationEvent = {
      domainId: 5,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      occurredAt: new Date(),
      dedupKey: "http:5:http_status_changed:ok:down:autogen",
    };
    createHttpSnapshot(
      { domainId: 5, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    const pending = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, "pending"))
      .all();
    expect(pending).toHaveLength(1); // auto-generated by the check transaction

    const server = await startServer();
    const [a, b] = await Promise.all([
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "G1", DM_PORT: String(server.port) }),
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "G2", DM_PORT: String(server.port) }),
    ]);
    await server.close();

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const ra = parseJsonLines(a.stdout)[0] ?? {};
    const rb = parseJsonLines(b.stdout)[0] ?? {};
    expect(sumCounts([ra, rb], "sent")).toBe(1);
    expect(server.hits.size).toBe(1);
    expect(server.hits.get(server.order[0]) ?? 0).toBe(1);

    const rows = db.select().from(notificationDeliveries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending[0].id);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].attempts).toBe(1);
  });

  it("two workers racing on one delivery: exactly one send, attempts = 1, final sent", async () => {
    const dbFile = path.join(dir, "race.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 1);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);
    const server = await startServer();

    const [a, b] = await Promise.all([
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "A", DM_PORT: String(server.port) }),
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "B", DM_PORT: String(server.port) }),
    ]);
    await server.close();

    const ra = parseJsonLines(a.stdout)[0] ?? {};
    const rb = parseJsonLines(b.stdout)[0] ?? {};
    // Both processes must exit cleanly.
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    // Exactly one actual send.
    expect(server.hits.get(deliveryId) ?? 0).toBe(1);

    // Exactly one winner. The loser either saw the delivery claimed
    // (skipped=1) or its batch query no longer saw it as pending
    // (attempted=0) — both mean it did NOT send.
    const sentTotal = sumCounts([ra, rb], "sent");
    const attemptedTotal = sumCounts([ra, rb], "attempted");
    expect(sentTotal).toBe(1);
    expect(attemptedTotal).toBeGreaterThanOrEqual(1);
    expect(attemptedTotal).toBeLessThanOrEqual(2);
    if (attemptedTotal === 2) {
      // Both read `pending` before either claimed → CAS decided: one sent,
      // the other skipped. This is the key CAS proof.
      expect(sumCounts([ra, rb], "skipped")).toBe(1);
    }

    // Final DB state: single delivery, sent, attempts = 1, no `sending` left.
    const rows = db.select().from(notificationDeliveries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(deliveryId);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].attempts).toBe(1);
  });

  it("ten deliveries, three workers: each delivered exactly once, all sent, attempts = 1", async () => {
    const dbFile = path.join(dir, "ten.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 10);
    const deliveryIds = channelIds.map((c) => insertPendingDelivery(db, eventId, c));
    const server = await startServer();

    const results = await Promise.all([
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "W1", DM_PORT: String(server.port) }),
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "W2", DM_PORT: String(server.port) }),
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "W3", DM_PORT: String(server.port) }),
    ]);
    await server.close();

    for (const r of results) {
      expect(r.code).toBe(0);
    }

    // Every delivery sent exactly once.
    const totalSent = sumCounts(
      results.map((r) => parseJsonLines(r.stdout)[0] ?? {}),
      "sent",
    );
    expect(totalSent).toBe(10);
    for (const id of deliveryIds) {
      expect(server.hits.get(id) ?? 0).toBe(1);
    }

    // Final state: 10 sent rows, no duplicates, no stuck `sending`.
    const rows = db.select().from(notificationDeliveries).all();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(1);
    }
  });

  it("re-entry: two workers on the same DB/pending/deliveries never double-send", async () => {
    const dbFile = path.join(dir, "reentry.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 4);
    const deliveryIds = channelIds.map((c) => insertPendingDelivery(db, eventId, c));
    const server = await startServer();

    const [a, b] = await Promise.all([
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "R1", DM_PORT: String(server.port) }),
      runProc(PROC, { DATABASE_URL: dbFile, DM_PROC_ID: "R2", DM_PORT: String(server.port) }),
    ]);
    await server.close();

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    for (const id of deliveryIds) {
      expect(server.hits.get(id) ?? 0).toBe(1);
    }
    const rows = db.select().from(notificationDeliveries).all();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SQLite busy_timeout under a real competing writer
// ---------------------------------------------------------------------------

describe("SQLite busy_timeout", () => {
  it("worker waits for a competing EXCLUSIVE lock and succeeds (no SQLITE_BUSY)", async () => {
    const dbFile = path.join(dir, "busy.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 1);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);
    const server = await startServer();

    // Holder grabs the write lock for ~1.5s.
    const holder = runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_MODE: "hold-lock",
      DM_HOLD_MS: "1500",
    });
    await new Promise((r) => setTimeout(r, 500));

    // Worker starts while the lock is held; busy_timeout=5000 must make it
    // WAIT (not fail with SQLITE_BUSY), then deliver after the release.
    const worker = runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "BUSY-WORKER",
      DM_PORT: String(server.port),
    });
    const [h, w] = await Promise.all([holder, worker]);
    await server.close();

    expect(h.code).toBe(0);
    expect(w.code).toBe(0);
    const result = parseJsonLines(w.stdout)[0] ?? {};
    expect(result.sent).toBe(1);

    // No fatal SQLITE_BUSY on stderr.
    expect(w.stderr).not.toContain("SQLITE_BUSY");
    expect(w.stderr).not.toContain("database is locked");

    const rows = db.select().from(notificationDeliveries).all();
    expect(rows[0].status).toBe("sent");
    expect(server.hits.get(deliveryId) ?? 0).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Stale sending recovery & crash recovery (real processes)
// ---------------------------------------------------------------------------

describe("stale + crash recovery", () => {
  it("multiple stale sending deliveries: all recovered, attempts 1→2, no new rows", async () => {
    const dbFile = path.join(dir, "stale.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 3);
    const deliveryIds = channelIds.map((c) => insertPendingDelivery(db, eventId, c));
    for (const id of deliveryIds) {
      setSending(db, id, new Date(NOW.getTime() - 10 * 60_000)); // old → stale
    }
    const eventCountBefore = db.select().from(notificationEvents).all().length;
    const server = await startServer();

    const r = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "STALE",
      DM_PORT: String(server.port),
      DM_STALE_MS: "1000",
    });
    await server.close();

    expect(r.code).toBe(0);
    const result = parseJsonLines(r.stdout)[0] ?? {};
    expect(result.recovered).toBe(3);
    expect(result.sent).toBe(3);

    const rows = db.select().from(notificationDeliveries).all();
    expect(rows).toHaveLength(3); // E: no new delivery rows
    expect(rows.map((row) => row.id).sort()).toEqual([...deliveryIds].sort()); // G: ids unchanged
    for (const row of rows) {
      expect(row.status).toBe("sent"); // A: stale → pending → sent
      expect(row.attempts).toBe(2); // D: attempts 1 → 2
    }
    // F: no new events.
    expect(db.select().from(notificationEvents).all()).toHaveLength(eventCountBefore);
  });

  it("fresh sending is NOT recovered by a real worker process", async () => {
    const dbFile = path.join(dir, "fresh.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 1);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);
    setSending(db, deliveryId, new Date()); // fresh claim (real clock)
    const server = await startServer();

    const r = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "FRESH",
      DM_PORT: String(server.port),
      DM_STALE_MS: "1000",
    });
    await server.close();

    expect(r.code).toBe(0);
    const result = parseJsonLines(r.stdout)[0] ?? {};
    expect(result.recovered).toBe(0);
    expect(result.attempted).toBe(0);
    const rows = db.select().from(notificationDeliveries).all();
    expect(rows[0].status).toBe("sending");
    expect(rows[0].attempts).toBe(1);
    expect(server.hits.size).toBe(0);
  });

  it("crash after claim: delivery left `sending`, second worker recovers and sends (attempts 1→2)", async () => {
    const dbFile = path.join(dir, "crash.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 1);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);
    const server = await startServer();

    // 1) Worker claims then dies before send.
    const crashed = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_MODE: "crash-after-claim",
      DM_PROC_ID: "CRASH",
    });
    expect(crashed.code).toBe(1);
    const crashLog = parseJsonLines(crashed.stdout)[0] ?? {};
    expect(crashLog.claimed).toBe(true);

    let row = db.select().from(notificationDeliveries).all()[0];
    expect(row.status).toBe("sending");
    expect(row.claimedAt).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(server.hits.size).toBe(0); // nothing was sent

    // 2) Age the claim past the stale threshold (simulates wall-clock
    //    passing; the subprocess uses DM_STALE_MS=1000).
    setSending(db, deliveryId, new Date(NOW.getTime() - 60_000));

    // 3) A fresh worker recovers it and delivers.
    const recovered = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "RECOVER",
      DM_PORT: String(server.port),
      DM_STALE_MS: "1000",
    });
    await server.close();

    expect(recovered.code).toBe(0);
    const result = parseJsonLines(recovered.stdout)[0] ?? {};
    expect(result.recovered).toBe(1);
    expect(result.sent).toBe(1);
    expect(server.hits.get(deliveryId) ?? 0).toBe(1);

    row = db.select().from(notificationDeliveries).all()[0];
    expect(row.id).toBe(deliveryId); // delivery id unchanged
    expect(row.eventId).toBe(eventId); // event id unchanged
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2); // 1 (crash claim) → 2 (recovery claim)
  });
});

// ---------------------------------------------------------------------------
// 6. Sender failure isolation (real process)
// ---------------------------------------------------------------------------

describe("sender failure isolation", () => {
  it("first of five fails; the other four still deliver; worker exits 0", async () => {
    const dbFile = path.join(dir, "failiso.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 5);
    const deliveryIds = channelIds.map((c) => insertPendingDelivery(db, eventId, c));
    const server = await startServer();

    const r = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "ISO",
      DM_PORT: String(server.port),
      DM_FAIL_IDS: String(deliveryIds[0]),
    });
    await server.close();

    expect(r.code).toBe(0);
    const result = parseJsonLines(r.stdout)[0] ?? {};
    expect(result.attempted).toBe(5);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(4);

    // The failed one never sent; the rest sent exactly once.
    expect(server.hits.has(deliveryIds[0])).toBe(false);
    for (const id of deliveryIds.slice(1)) {
      expect(server.hits.get(id) ?? 0).toBe(1);
    }

    const rows = db.select().from(notificationDeliveries).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(deliveryIds[0])!.status).toBe("failed");
    expect(byId.get(deliveryIds[0])!.attempts).toBe(1);
    for (const id of deliveryIds.slice(1)) {
      expect(byId.get(id)!.status).toBe("sent");
      expect(byId.get(id)!.attempts).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Batch limit across real worker processes (FIFO, no permanent omission)
// ---------------------------------------------------------------------------

describe("batch limit (real processes)", () => {
  it("--limit 3: first pass delivers 3, second pass delivers the rest, FIFO order", async () => {
    const dbFile = path.join(dir, "batch.db");
    const db = createFileDb(dbFile);
    const { channelIds, eventId } = seedChannels(db, 10);
    const deliveryIds = channelIds.map((c) => insertPendingDelivery(db, eventId, c));
    const server = await startServer();

    const first = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "B1",
      DM_PORT: String(server.port),
      DM_LIMIT: "3",
    });
    await server.close();

    expect(first.code).toBe(0);
    const r1 = parseJsonLines(first.stdout)[0] ?? {};
    expect(r1.attempted).toBe(3);
    expect(r1.sent).toBe(3);

    // FIFO: the first pass delivered the three lowest ids, in order.
    expect(server.order).toEqual(deliveryIds.slice(0, 3));
    const pendingAfter = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, "pending"))
      .all();
    expect(pendingAfter.map((row) => row.id)).toEqual(deliveryIds.slice(3)); // F: ids 4..10, ASC

    // Second pass (new process): remaining 7.
    const server2 = await startServer();
    const second = await runProc(PROC, {
      DATABASE_URL: dbFile,
      DM_PROC_ID: "B2",
      DM_PORT: String(server2.port),
    });
    await server2.close();

    expect(second.code).toBe(0);
    const r2 = parseJsonLines(second.stdout)[0] ?? {};
    expect(r2.sent).toBe(7);
    expect(server2.order).toEqual(deliveryIds.slice(3));

    const rows = db.select().from(notificationDeliveries).all();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.status).toBe("sent"); // nothing permanently omitted
    }
  });
});

// ---------------------------------------------------------------------------
// 9 + 10. Real CLI: empty queue & argument handling
// ---------------------------------------------------------------------------

describe("real CLI (scripts/worker.ts)", () => {
  it("empty queue: exit 0, attempted = 0, no rows created, no error output", async () => {
    const dbFile = path.join(dir, "empty.db");
    createFileDb(dbFile);

    const r = await runProc(CLI, { DATABASE_URL: dbFile });
    expect(r.code).toBe(0);
    const result = parseJsonLines(r.stdout)[0] ?? {};
    expect(result).toMatchObject({ recovered: 0, attempted: 0, sent: 0, failed: 0, skipped: 0 });
    expect(r.stderr).toBe("");

    // Reopen WITHOUT migrations (schema already applied) to verify nothing
    // was created.
    const db = drizzle(new Database(dbFile), { schema });
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
    expect(db.select().from(notificationChannels).all()).toHaveLength(0);
    expect(db.select().from(domains).all()).toHaveLength(0);
  });

  it("valid limits: --limit 1 / --limit 5 / --limit=3 / --limit 999999 cap the pass", async () => {
    const cases: Array<{ args: string[]; expected: number }> = [
      { args: ["--limit", "1"], expected: 1 },
      { args: ["--limit", "5"], expected: 5 },
      { args: ["--limit=3"], expected: 3 },
      { args: ["--limit", "999999"], expected: 6 },
    ];
    for (const { args, expected } of cases) {
      const dbFile = path.join(dir, `lim-${args.join("-")}.db`);
      const db = createFileDb(dbFile);
      const { channelIds, eventId } = seedChannels(db, 6);
      for (const c of channelIds) {
        insertPendingDelivery(db, eventId, c);
      }
      const r = await runProc(CLI, { DATABASE_URL: dbFile }, args);
      expect(r.code).toBe(0);
      const result = parseJsonLines(r.stdout)[0] ?? {};
      // The CLI uses the REAL senders, so these deliveries fail at the
      // SSRF guard (URL is https://127.0.0.1 — blocked locally, zero
      // network). What matters for limit semantics is `attempted`.
      expect(result.attempted).toBe(expected);
      expect(result.failed).toBe(expected);
    }
  });

  it("invalid limits (abc, 0, -1, 1.5) exit non-zero with a clear error", async () => {
    for (const args of [
      ["--limit", "abc"],
      ["--limit", "0"],
      ["--limit", "-1"],
      ["--limit", "1.5"],
    ]) {
      const dbFile = path.join(dir, `bad-${args.join("-")}.db`);
      createFileDb(dbFile);
      const r = await runProc(CLI, { DATABASE_URL: dbFile }, args);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--limit must be a positive integer/);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Secret hygiene in real worker output
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
  it("real CLI output never contains the api key, its value, Authorization, or Bearer", async () => {
    const dbFile = path.join(dir, "secret.db");
    const db = createFileDb(dbFile);
    db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
    const channelId = db
      .insert(notificationChannels)
      .values({
        type: "email",
        name: "mail",
        config: JSON.stringify({
          to: "ops@example.com",
          from: "monitor@example.com",
          endpoint: "https://127.0.0.1/send",
          apiKeyRef: "EMAIL_API_KEY",
        }),
        enabled: 1,
      })
      .returning({ id: notificationChannels.id })
      .get().id;
    db.insert(notificationRules)
      .values({ name: "r", channelId, source: null, eventType: null, domainId: null, enabled: 1 })
      .run();
    const eventId = db
      .insert(notificationEvents)
      .values({
        domainId: 5,
        source: "http",
        eventType: "http_status_changed",
        previousState: '"ok"',
        currentState: '"down"',
        dedupKey: "http:5:http_status_changed:ok:down",
        occurredAt: NOW,
      })
      .returning({ id: notificationEvents.id })
      .get().id;
    insertPendingDelivery(db, eventId, channelId);

    const r = await runProc(CLI, {
      DATABASE_URL: dbFile,
      EMAIL_API_KEY: "***",
    });

    // The key is present in the env (proving the send path could read it),
    // but must never appear in any worker output. The CLI prints only the
    // summary JSON — no error details, no ref names, nothing secret.
    expect(r.code).toBe(0);
    const output = r.stdout + r.stderr;
    expect(output).not.toContain("***");
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("sk-");
    expect(output).not.toContain("EMAIL_API_KEY");
    expect(output).toMatch(/\{"recovered":0,"attempted":1,"sent":0,"failed":1,"skipped":0\}/);
  });
});

// ---------------------------------------------------------------------------
// 12. State machine integrity (Phase 2 adds no states)
// ---------------------------------------------------------------------------

describe("state machine integrity", () => {
  it("repository only writes the five guarded transitions, no max-attempts", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/notifications/repository.ts"), "utf8");
    // The five allowed guarded transitions (all WHERE status=<source> CAS):
    //   pending→sending (claim), sending→sent, sending→failed,
    //   failed→pending (retry), sending→pending (stale recovery).
    for (const needle of [
      'eq(notificationDeliveries.status, "pending")',
      'eq(notificationDeliveries.status, "sending")',
      'eq(notificationDeliveries.status, "failed")',
    ]) {
      expect(source).toContain(needle);
    }
    // Phase 2 adds no auto-retry / backoff / max-attempts.
    expect(source).not.toContain("maxAttempts");
    expect(source).not.toContain("backoff");
  });
});
