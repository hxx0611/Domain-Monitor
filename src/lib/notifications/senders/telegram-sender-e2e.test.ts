/**
 * Phase 9H — Telegram sender secret-resolution E2E against the REAL
 * dependency chain (no mocks of the repository/secrets/encryption layers):
 *
 *   createTestDb (real migrations) → setChannelSecret (AES-256-GCM)
 *   → getChannelSecret → TelegramSender.send (real 9H priority logic)
 *   → worker.runOnce (real service + repository state machine)
 *
 * Only `fetch` is faked — the network boundary. Everything else is the
 * production code path. Asserts:
 *   - encrypted secret (A) drives the worker end-to-end
 *   - legacy env fallback (B) still works for old configs
 *   - controlled failure (C) when neither source exists
 *   - decryption failure is surfaced, never masked, never falls back
 *   - token NEVER lands in SQLite, delivery.error, or error messages
 */

import { createSQLiteRepository } from "@/db/adapters/sqlite";
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../../test/helpers";
import { runOnce } from "../worker";
import type { NotificationDb } from "../repository";
import { TelegramSender } from "./telegram";
import { ENCRYPTION_KEY_ENV } from "../encryption";
import { getChannelSecret, setChannelSecret } from "../secrets";
import type { ChannelType, DeliverySender } from "../types";

const TEST_KEY_HEX = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00";
// Format-valid FAKE tokens (never real).
const STORAGE_TOKEN = "1122334455:AAH_e2e_storage_token_abcdefghijklmnopqrst";
const ENV_TOKEN = "5544332211:AAH_e2e_env_token_abcdefghijklmnopqrstuvwxyz";

const db: NotificationDb = createTestDb();

let fetchCalls = 0;

function rejectFetch(): typeof fetch {
  return (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: false }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function senderFactory(fetchFn: typeof fetch): (type: ChannelType) => DeliverySender {
  return (type: ChannelType) => {
    if (type !== "telegram") {
      throw new Error("E2E sender factory: unexpected type");
    }
    return new TelegramSender({
      fetchFn,
      env: { TELEGRAM_BOT_TOKEN: ENV_TOKEN },
      resolveDomain: () => "example.com",
      resolveSecret: (channelId, key) => Promise.resolve(getChannelSecret(channelId, key, db)),
    });
  };
}

function seedTelegramChannel(config: string): number {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  const channelId = db
    .insert(notificationChannels)
    .values({ type: "telegram", name: "tg", config, enabled: 1 })
    .returning({ id: notificationChannels.id })
    .get().id;
  db.insert(notificationRules)
    .values({
      name: "rule-tg",
      channelId,
      source: "http",
      eventType: null,
      domainId: null,
      enabled: 1,
    })
    .run();
  const eventId = db
    .insert(notificationEvents)
    .values({
      domainId: 5,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      dedupKey: `http:5:http_status_changed:ok:down:${channelId}`,
      occurredAt: new Date("2026-08-18T00:00:00.000Z"),
    })
    .returning({ id: notificationEvents.id })
    .get().id;
  const deliveryId = db
    .insert(notificationDeliveries)
    .values({ eventId, channelId, status: "pending", attempts: 0 })
    .returning({ id: notificationDeliveries.id })
    .get().id;
  return deliveryId;
}

/** Scan every text column of the seeded tables for the token substring. */
function scanDbForToken(token: string): string[] {
  const hits: string[] = [];
  const tables: Array<{ table: string; cols: string[] }> = [
    { table: "notification_channels", cols: ["name", "config"] },
    { table: "notification_events", cols: ["previous_state", "current_state", "dedup_key"] },
    { table: "notification_deliveries", cols: ["error"] },
    { table: "notification_secrets", cols: ["encrypted_value"] },
  ];
  for (const { table, cols } of tables) {
    for (const col of cols) {
      const rows = db.all(`SELECT ${col} AS v FROM ${table}`) as Array<{ v: string | null }>;
      for (const r of rows) {
        if (r.v !== null && r.v !== undefined && String(r.v).includes(token)) {
          hits.push(`${table}.${col}`);
        }
      }
    }
  }
  return hits;
}

beforeAll(() => {
  vi.stubEnv(ENCRYPTION_KEY_ENV, TEST_KEY_HEX);
});

beforeEach(() => {
  fetchCalls = 0;
});

afterEach(() => {
  db.delete(notificationDeliveries).run();
  db.delete(notificationEvents).run();
  db.delete(notificationRules).run();
  db.delete(notificationChannels).run();
  db.delete(domains).run();
});

describe("Phase 9H E2E — real chain", () => {
  it("A. encrypted secret drives the worker end-to-end (no env fallback)", async () => {
    const deliveryId = seedTelegramChannel(JSON.stringify({ chatId: "123456789" }));
    // Store the token encrypted in notification_secrets via the real repo.
    const channelId = db.select().from(notificationChannels).all()[0].id;
    setChannelSecret(channelId, "token", STORAGE_TOKEN, db);

    const fetchFn = (async (url: string) => {
      fetchCalls++;
      expect(String(url)).toContain(`/bot${STORAGE_TOKEN}/sendMessage`);
      expect(String(url)).not.toContain(ENV_TOKEN);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await runOnce({
      repo: createSQLiteRepository(db),
      senders: senderFactory(fetchFn),
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(fetchCalls).toBe(1);

    const row = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get()!;
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1); // CAS claim + one send attempt
    expect(row.error).toBeNull();

    // No plaintext token anywhere in SQLite.
    expect(scanDbForToken(STORAGE_TOKEN)).toEqual([]);
    expect(scanDbForToken(ENV_TOKEN)).toEqual([]);
  });

  it("B. legacy env fallback works for old configs (no secret row)", async () => {
    const deliveryId = seedTelegramChannel(
      JSON.stringify({ chatId: "123456789", secretRef: "TELEGRAM_BOT_TOKEN" }),
    );

    const fetchFn = (async (url: string) => {
      fetchCalls++;
      expect(String(url)).toContain(`/bot${ENV_TOKEN}/sendMessage`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await runOnce({
      repo: createSQLiteRepository(db),
      senders: senderFactory(fetchFn),
    });
    expect(result.sent).toBe(1);
    expect(fetchCalls).toBe(1);
    const row = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get()!;
    expect(row.status).toBe("sent");
    expect(scanDbForToken(ENV_TOKEN)).toEqual([]);
  });

  it("C. neither source → controlled failure, delivery.error has no token", async () => {
    const deliveryId = seedTelegramChannel(JSON.stringify({ chatId: "123456789" }));
    // No secret row, no secretRef, env has no TELEGRAM_BOT_TOKEN for this
    // factory? It DOES — the factory env includes ENV_TOKEN, but a 9G+
    // config without secretRef must NOT resolve env directly.
    const result = await runOnce({
      repo: createSQLiteRepository(db),
      senders: senderFactory(rejectFetch()),
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(fetchCalls).toBe(0); // never reached the network

    const row = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get()!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Telegram token is not configured");
    expect(row.error).not.toContain(ENV_TOKEN);
    expect(row.error).not.toContain(STORAGE_TOKEN);
    expect(scanDbForToken(ENV_TOKEN)).toEqual([]);
  });

  it("D. decryption failure (wrong key) → surfaced, no env fallback, no ciphertext leak", async () => {
    const deliveryId = seedTelegramChannel(JSON.stringify({ chatId: "123456789" }));
    const channelId = db.select().from(notificationChannels).all()[0].id;
    // Encrypt with key A.
    setChannelSecret(channelId, "token", STORAGE_TOKEN, db);
    // Rotate the encryption key → decryption of the stored blob now fails.
    vi.stubEnv(
      ENCRYPTION_KEY_ENV,
      "ffeeddccbbaa99887766554433221100fedcba9876543210fedcba9876543210",
    );

    const result = await runOnce({
      repo: createSQLiteRepository(db),
      senders: senderFactory(rejectFetch()),
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(fetchCalls).toBe(0); // decryption failure is not masked by env fallback

    const row = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get()!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("decryption failed");
    expect(row.error).not.toContain(ENV_TOKEN);
    expect(row.error).not.toContain(STORAGE_TOKEN);
    expect(scanDbForToken(STORAGE_TOKEN)).toEqual([]);
    expect(scanDbForToken(ENV_TOKEN)).toEqual([]);
  });

  it("E. API rejection → failed delivery, error has no token", async () => {
    const deliveryId = seedTelegramChannel(JSON.stringify({ chatId: "123456789" }));
    const channelId = db.select().from(notificationChannels).all()[0].id;
    setChannelSecret(channelId, "token", STORAGE_TOKEN, db);

    const result = await runOnce({
      repo: createSQLiteRepository(db),
      senders: senderFactory(rejectFetch()),
    });
    expect(result.failed).toBe(1);
    expect(fetchCalls).toBe(1);

    const row = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get()!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Telegram API returned HTTP 400");
    expect(row.error).not.toContain(STORAGE_TOKEN);
    expect(scanDbForToken(STORAGE_TOKEN)).toEqual([]);
  });

  it("F. scanDbForToken sanity — it actually detects stored tokens", () => {
    // Guard against false-empty scans: plant a known marker in a delivery
    // error and assert the scanner finds it.
    const deliveryId = seedTelegramChannel(JSON.stringify({ chatId: "123456789" }));
    db.update(notificationDeliveries)
      .set({ status: "failed", error: `planted ${ENV_TOKEN} marker` })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
    expect(scanDbForToken(ENV_TOKEN)).toContain("notification_deliveries.error");
    expect(scanDbForToken("planted")).toContain("notification_deliveries.error");
  });
});
