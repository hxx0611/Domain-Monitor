/**
 * Phase 11G-A — sendTestNotificationAction integration tests.
 *
 * Full pipeline against a real in-memory DB with the REAL factory, REAL
 * TelegramSender and REAL encrypted notification_secrets resolution. The
 * only thing faked is the outbound Telegram HTTP call (stubbed global
 * fetch) — the real Telegram API is never touched.
 *
 * Covers (Phase 11G-A §10 / §16):
 *   F  sender invoked through the existing pipeline
 *   K  same-test dedup produces no duplicate event
 *   L  same-test dedup produces no duplicate delivery
 *   O  attempts = 1
 *   P  error = null on success
 *   M  sender failure → controlled error + failed delivery
 *   +  encrypted-secret chain: notification_secrets → getChannelSecret →
 *      decryptSecret → TelegramSender → send
 *   +  domains / reminders / rules are never modified
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
  notificationSecrets,
} from "@/db/schema";

// Partially mock node:crypto so tests can pin the test-notification nonce
// (the dedup key depends on it). Everything else stays real.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: vi.fn(() => "00000000-0000-4000-8000-0000000000ff"),
  };
});

// Point every "@/db" consumer (repository, secrets, domains, actions) at a
// dedicated in-memory DB with the full migration history applied. The async
// factory runs inside vite-node (aliases resolved) and caches the instance
// on globalThis so the test body can seed/assert against the same DB.
vi.mock("@/db", async () => {
  const g = globalThis as { __qwpTestDb?: unknown };
  if (!g.__qwpTestDb) {
    const { createTestDb } = await import("../../../test/helpers");
    g.__qwpTestDb = createTestDb();
  }
  return { db: g.__qwpTestDb };
});
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn(() => Promise.resolve(true)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { sendTestNotificationAction } from "./actions";
import { setChannelSecret } from "./secrets";
import { randomUUID } from "node:crypto";
import type { NotificationDb } from "./repository";

const testDb = (globalThis as { __qwpTestDb?: NotificationDb }).__qwpTestDb as NotificationDb;

// Fake encryption key + fake token — NEVER real values.
process.env.ENCRYPTION_KEY = "test-encryption-key-11ga-0000000000000000000000000";
const FAKE_TOKEN = "123456789:AAH_test_token_abcdefghijklmnopqrstuvwxyz";
const FAKE_OK = { ok: true, result: { message_id: 123 } };

let channelId = 0;

function seed(db: NotificationDb): number {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  const ch = db
    .insert(notificationChannels)
    .values({
      type: "telegram",
      name: "tg",
      config: JSON.stringify({ chatId: "1616146471" }),
      enabled: 1,
    })
    .returning({ id: notificationChannels.id })
    .get();
  channelId = ch.id;
  // Encrypted storage — the action must never read the plaintext itself.
  setChannelSecret(channelId, "token", FAKE_TOKEN);
  return ch.id;
}

function stubTelegramFetch(response: () => unknown, calls: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function rows<T>(table: T) {
  return testDb
    .select()
    .from(table as never)
    .all() as unknown as Array<Record<string, unknown>>;
}

beforeEach(() => {
  testDb.delete(notificationDeliveries).run();
  testDb.delete(notificationEvents).run();
  testDb.delete(notificationChannels).run();
  testDb.delete(notificationRules).run();
  testDb.delete(domains).run();
  channelId = seed(testDb);
  vi.unstubAllGlobals();
});

describe("sendTestNotificationAction — real pipeline", () => {
  it("F/O/P: sends exactly once through the encrypted secret chain", async () => {
    const calls: string[] = [];
    stubTelegramFetch(() => FAKE_OK, calls);

    const result = await sendTestNotificationAction(channelId);

    expect(result).toEqual({
      ok: true,
      status: "sent",
      eventId: expect.any(Number),
      deliveryId: expect.any(Number),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/api\.telegram\.org\/bot/);
    expect(calls[0]).toContain("/sendMessage");
    // The sendMessage body carries the test-identifying message text.
    const body = (vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(String(body)).toContain("Test Notification");

    const events = rows(notificationEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "test",
      eventType: "test_notification",
    });
    expect(String(events[0].dedupKey)).toMatch(/^test-notification:\d+:[0-9a-f-]{36}$/);

    const deliveries = rows(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channelId,
      status: "sent",
      attempts: 1,
      error: null,
    });
  });

  it("K/L: same-nonce replay creates no duplicate event/delivery/message", async () => {
    const calls: string[] = [];
    stubTelegramFetch(() => FAKE_OK, calls);

    // Pin the nonce so the second invocation replays the exact same request.
    vi.mocked(randomUUID)
      .mockReturnValueOnce("00000000-0000-4000-8000-0000000000aa")
      .mockReturnValueOnce("00000000-0000-4000-8000-0000000000aa");

    const first = await sendTestNotificationAction(channelId);
    expect(first.ok).toBe(true);

    const second = await sendTestNotificationAction(channelId);
    expect(second).toEqual({
      ok: false,
      error: "Test notification was already sent.",
      code: "duplicate_request",
    });

    expect(rows(notificationEvents)).toHaveLength(1);
    expect(rows(notificationDeliveries)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("M: sender failure → controlled error + failed delivery with attempts=1", async () => {
    stubTelegramFetch(() => ({ ok: false, description: "Unauthorized" }));

    const result = await sendTestNotificationAction(channelId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("send_failed");
      expect(result.error).not.toContain(FAKE_TOKEN);
      expect(result.error).not.toContain("api.telegram.org");
    }
    const deliveries = rows(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ channelId, status: "failed", attempts: 1 });
    expect(deliveries[0].error).toBeTruthy();
    // Failed message error must not contain the token either.
    expect(String(deliveries[0].error)).not.toContain(FAKE_TOKEN);
  });

  it("does not modify domains / reminders / rules", async () => {
    stubTelegramFetch(() => FAKE_OK);
    testDb
      .insert(notificationRules)
      .values({
        name: "existing-rule",
        channelId,
        source: "expiration",
        eventType: null,
        domainId: null,
        enabled: 1,
      })
      .run();
    const domainsBefore = rows(domains).length;
    const rulesBefore = rows(notificationRules).length;

    await sendTestNotificationAction(channelId);

    expect(rows(domains).length).toBe(domainsBefore);
    expect(rows(notificationRules).length).toBe(rulesBefore);
    // A test event must not match the expiration rule: only the direct
    // test delivery exists (no rule-driven second delivery).
    expect(rows(notificationDeliveries)).toHaveLength(1);
  });

  it("no encrypted secret → secret_not_configured, nothing sent", async () => {
    const calls: string[] = [];
    stubTelegramFetch(() => FAKE_OK, calls);
    testDb.delete(notificationSecrets).run();

    const result = await sendTestNotificationAction(channelId);
    expect(result).toEqual({
      ok: false,
      error: "Telegram token is not configured for this channel.",
      code: "secret_not_configured",
    });
    expect(calls).toHaveLength(0);
    expect(rows(notificationEvents)).toHaveLength(0);
    expect(rows(notificationDeliveries)).toHaveLength(0);
  });
});
