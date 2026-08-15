/**
 * V0.7 worker CLI — runs ONE `runOnce` tick and exits.
 *
 * Usage:
 *   pnpm worker            # one tick, default limit 50
 *   pnpm worker --limit 10 # cap this tick at 10 deliveries
 *   pnpm worker --limit=10 # same
 *
 * No daemon, no interval, no cron, no HTTP endpoint — the process runs
 * once, prints the tick summary as JSON, and exits (0 on success).
 * Scheduling is left to the operator (e.g. a system cron job).
 */

import { runOnce } from "../src/lib/notifications/worker";

function parseLimit(argv: string[]): number | undefined {
  const index = argv.findIndex((arg) => arg === "--limit" || arg.startsWith("--limit="));
  if (index === -1) {
    return undefined;
  }
  const raw = argv[index].startsWith("--limit=")
    ? argv[index].slice("--limit=".length)
    : argv[index + 1];
  if (raw === undefined) {
    throw new Error("--limit requires a positive integer value.");
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }
  return limit;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  const result = await runOnce(limit !== undefined ? { limit } : {});
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error("worker failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
