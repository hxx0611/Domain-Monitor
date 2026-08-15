/**
 * V0.7 Phase 3 — CLI integration & operational evidence.
 *
 * Phase 2 already proved multi-process CAS, busy_timeout, stale/crash
 * recovery and batch limits with real processes. Phase 3 does NOT repeat
 * that — it locks down the CLI contract itself:
 *
 *   1. stdout is exactly ONE JSON line with the stable summary schema
 *   2. the process exits naturally (no lingering timers/handles)
 *   3. the README cron example matches the actual package.json script
 *   4. no secret material ever reaches stdout/stderr
 *
 * Run with:
 *   pnpm vitest run --config scripts/vitest.phase3.config.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(ROOT, "scripts", "worker.ts");

// SSRF-blocked locally (loopback) → the real sender fails without any
// network traffic; perfect for CLI-level tests that must stay offline.
const WEBHOOK_CONFIG = JSON.stringify({ url: "https://127.0.0.1/wh" });
const SECRET_VALUE = "***";

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(env: Record<string, string>, args: string[] = []): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ["--conditions=react-server", CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out (still running = lingering handle):\n${stdout}\n${stderr}`));
    }, 15_000);
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

/** Seed one domain + webhook channel + rule + event + one pending delivery. */
function seedOnePending(dbFile: string, channelConfig = WEBHOOK_CONFIG): void {
  const db = createFileDb(dbFile);
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  const ch = db
    .insert(notificationChannels)
    .values({ type: "webhook", name: "wh", config: channelConfig, enabled: 1 })
    .returning({ id: notificationChannels.id })
    .get();
  db.insert(notificationRules)
    .values({ name: "r", channelId: ch.id, source: null, eventType: null, domainId: null, enabled: 1 })
    .run();
  const ev = db
    .insert(notificationEvents)
    .values({
      domainId: 5,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      dedupKey: "http:5:http_status_changed:ok:down",
      occurredAt: new Date(),
    })
    .returning({ id: notificationEvents.id })
    .get();
  db.insert(notificationDeliveries)
    .values({ eventId: ev.id, channelId: ch.id, status: "pending", attempts: 0 })
    .run();
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "phase3-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("V0.7 CLI contract (scripts/worker.ts)", () => {
  it("stdout is exactly one JSON line with the stable summary schema", async () => {
    const dbFile = path.join(dir, "schema.db");
    seedOnePending(dbFile);

    const r = await runCli({ DATABASE_URL: dbFile });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const result = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "attempted",
      "failed",
      "recovered",
      "sent",
      "skipped",
    ]);
    for (const key of Object.keys(result)) {
      expect(typeof result[key]).toBe("number");
    }
    // The real sender hits the SSRF guard (127.0.0.1) → attempted = 1,
    // failed = 1, no network traffic.
    expect(result).toMatchObject({ recovered: 0, attempted: 1, failed: 1, sent: 0, skipped: 0 });
  });

  it("empty queue: exit 0, zero summary, no output noise", async () => {
    const dbFile = path.join(dir, "empty.db");
    createFileDb(dbFile);

    const r = await runCli({ DATABASE_URL: dbFile });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const result = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    expect(result).toEqual({ recovered: 0, attempted: 0, sent: 0, failed: 0, skipped: 0 });
  });

  it("--limit 3 and --limit=3 both cap the tick at 3", async () => {
    for (const args of [["--limit", "3"], ["--limit=3"]]) {
      const dbFile = path.join(dir, `lim-${args.join("")}.db`);
      const db = createFileDb(dbFile);
      db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
      const channelIds = Array.from({ length: 5 }, (_, i) =>
        db
          .insert(notificationChannels)
          .values({ type: "webhook", name: `wh-${i}`, config: WEBHOOK_CONFIG, enabled: 1 })
          .returning({ id: notificationChannels.id })
          .get().id,
      );
      const ev = db
        .insert(notificationEvents)
        .values({
          domainId: 5,
          source: "http",
          eventType: "http_status_changed",
          previousState: '"ok"',
          currentState: '"down"',
          dedupKey: "http:5:http_status_changed:ok:down",
          occurredAt: new Date(),
        })
        .returning({ id: notificationEvents.id })
        .get();
      for (const c of channelIds) {
        db.insert(notificationDeliveries)
          .values({ eventId: ev.id, channelId: c, status: "pending", attempts: 0 })
          .run();
      }

      const r = await runCli({ DATABASE_URL: dbFile }, args);
      expect(r.code).toBe(0);
      const result = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      expect(result.attempted).toBe(3);
      expect(result.failed).toBe(3);
      const pending = db
        .select()
        .from(notificationDeliveries)
        .all()
        .filter((d) => d.status === "pending");
      expect(pending).toHaveLength(2);
    }
  });

  it("invalid limits exit 1 with a clear, safe error", async () => {
    const dbFile = path.join(dir, "bad.db");
    createFileDb(dbFile);

    for (const args of [["--limit", "abc"], ["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"]]) {
      const r = await runCli({ DATABASE_URL: dbFile }, args);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--limit must be a positive integer/);
      // No deliveries are created by a failed argument parse (reopen
      // WITHOUT migrations — schema already applied).
      const db = drizzle(new Database(dbFile), { schema });
      expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
    }
  });

  it("process exits naturally — no lingering timer/handle keeps it alive", async () => {
    const dbFile = path.join(dir, "exit.db");
    seedOnePending(dbFile);

    const r = await runCli({ DATABASE_URL: dbFile });
    // runCli resolves on the close event WITHOUT killing the child; the
    // 15s timer only fires if the process failed to exit on its own. A
    // resolved close with code 0 is the natural-exit proof.
    expect(r.code).toBe(0);
  });

  it("no secret material in stdout or stderr (real key in env)", async () => {
    const dbFile = path.join(dir, "secret.db");
    seedOnePending(dbFile, JSON.stringify({
      to: "ops@example.com",
      from: "monitor@example.com",
      endpoint: "https://127.0.0.1/send?token=should-never-leak",
      apiKeyRef: "EMAIL_API_KEY",
    }));

    const r = await runCli({ DATABASE_URL: dbFile, EMAIL_API_KEY: SECRET_VALUE });
    expect(r.code).toBe(0);
    const output = r.stdout + r.stderr;
    expect(output).not.toContain(SECRET_VALUE);
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("sk-");
    expect(output).not.toContain("should-never-leak");
    expect(output).not.toContain("EMAIL_API_KEY");
  });
});

describe("README operational documentation", () => {
  it("cron example matches the actual package.json worker script", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    // The documented cron line invokes `pnpm worker`…
    const cronLine = readme
      .split("\n")
      .find((line) => line.trim().startsWith("* * * * *"));
    expect(cronLine).toBeTruthy();
    expect(cronLine).toContain("pnpm worker");

    // …which resolves to the real package.json script.
    expect(typeof pkg.scripts.worker).toBe("string");
    expect(pkg.scripts.worker).toContain("scripts/worker.ts");

    // README must state the limits honestly — as NEGATIVE claims ("not
    // exactly-once", "no backoff") — and must never positively claim
    // capabilities V0.7 does not have.
    expect(readme).toContain("at-least-once");
    expect(readme).toContain("not** exactly-once");
    expect(readme).toContain("no backoff");
    expect(readme).toContain("no distributed queue");
    expect(readme).not.toContain("guarantees exactly-once");
    expect(readme).not.toContain("automatic retry of failed");
  });
});
