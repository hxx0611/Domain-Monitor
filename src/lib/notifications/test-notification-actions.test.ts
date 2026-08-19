/**
 * Phase 11G-A — sendTestNotificationAction unit tests.
 *
 * Action-level contract with the repository / secrets / domains boundaries
 * mocked and a stubbed global fetch for the REAL TelegramSender (which the
 * factory instantiates). Real Telegram API is NEVER called; tokens are
 * obvious fake fixtures.
 *
 * Covers (Phase 11G-A §10):
 *   A unauthorized, B channel missing, C disabled, D non-Telegram,
 *   E no secret, F sender called, G no direct fetch, H/I/J no secret
 *   leakage in the action response, M sender failure, N sender success.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/domains", () => ({ getDomainById: vi.fn(), getDomains: vi.fn() }));
vi.mock("@/lib/domains/repository", () => ({ getDomainById: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/notifications/repository", () => ({
  getChannel: vi.fn(),
  getEvent: vi.fn(),
  insertNotificationEvents: vi.fn(),
  createDelivery: vi.fn(),
  getDelivery: vi.fn(),
  claimPendingDelivery: vi.fn(),
  markDeliverySent: vi.fn(),
  markDeliveryFailed: vi.fn(),
}));
vi.mock("@/lib/notifications/secrets", () => ({
  hasChannelSecret: vi.fn(),
  getChannelSecret: vi.fn(),
}));

import { sendTestNotificationAction } from "./actions";
import { requireAdmin } from "@/lib/auth/admin";
import * as repository from "@/lib/notifications/repository";
import * as secrets from "@/lib/notifications/secrets";
import * as domains from "@/lib/domains";

const mRepo = {
  getChannel: vi.mocked(repository.getChannel),
  getEvent: vi.mocked(repository.getEvent),
  insertNotificationEvents: vi.mocked(repository.insertNotificationEvents),
  createDelivery: vi.mocked(repository.createDelivery),
  getDelivery: vi.mocked(repository.getDelivery),
  claimPendingDelivery: vi.mocked(repository.claimPendingDelivery),
  markDeliverySent: vi.mocked(repository.markDeliverySent),
  markDeliveryFailed: vi.mocked(repository.markDeliveryFailed),
};
const mSecrets = {
  hasChannelSecret: vi.mocked(secrets.hasChannelSecret),
  getChannelSecret: vi.mocked(secrets.getChannelSecret),
};
const mDomains = {
  getDomains: vi.mocked(domains.getDomains),
};
const mockedRequireAdmin = vi.mocked(requireAdmin);

// Format-valid fake token — NEVER a real Telegram token.
const FAKE_TOKEN = "123456789:AAH_test_token_abcdefghijklmnopqrstuvwxyz";
const FAKE_BOT = { ok: true, result: { message_id: 123 } };

function telegramChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    type: "telegram",
    name: "tg",
    config: JSON.stringify({ chatId: "1616146471" }),
    enabled: 1,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    ...overrides,
  };
}

function eventRow() {
  return {
    id: 42,
    domainId: 5,
    source: "test",
    eventType: "test_notification",
    previousState: null,
    currentState: JSON.stringify({ kind: "test_notification", channelId: 7 }),
    dedupKey: "test-notification:7:nonce-1",
    occurredAt: new Date("2026-08-19T00:00:00.000Z"),
  };
}

/** Stub global fetch for the REAL TelegramSender. Returns the fake response. */
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

function happyPath() {
  mRepo.getChannel.mockReturnValue(telegramChannel() as never);
  mRepo.getEvent.mockReturnValue(eventRow() as never);
  mRepo.insertNotificationEvents.mockReturnValue([42]);
  mRepo.createDelivery.mockReturnValue(77);
  mRepo.getDelivery.mockReturnValue({ channelId: 7 } as never);
  mRepo.claimPendingDelivery.mockReturnValue(true);
  mRepo.markDeliverySent.mockReturnValue(true);
  mRepo.markDeliveryFailed.mockReturnValue(true);
  mSecrets.hasChannelSecret.mockReturnValue(true);
  mSecrets.getChannelSecret.mockResolvedValue(FAKE_TOKEN);
  mDomains.getDomains.mockReturnValue([{ id: 5, hostname: "example.com" }] as never);
  mockedRequireAdmin.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  happyPath();
});

describe("sendTestNotificationAction — authorization", () => {
  it("A: unauthenticated admin → unauthorized", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    const result = await sendTestNotificationAction(7);
    expect(result).toEqual({ ok: false, error: "unauthorized", code: "unauthorized" });
  });

  it("R: does not touch channels/events when unauthenticated", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    await sendTestNotificationAction(7);
    expect(mRepo.getChannel).not.toHaveBeenCalled();
    expect(mRepo.insertNotificationEvents).not.toHaveBeenCalled();
  });
});

describe("sendTestNotificationAction — channel validation", () => {
  it("B: missing channel → channel_not_found", async () => {
    mRepo.getChannel.mockReturnValue(undefined);
    const result = await sendTestNotificationAction(7);
    expect(result).toEqual({
      ok: false,
      error: "Channel not found.",
      code: "channel_not_found",
    });
  });

  it("C: disabled channel → channel_disabled", async () => {
    mRepo.getChannel.mockReturnValue(telegramChannel({ enabled: 0 }) as never);
    const result = await sendTestNotificationAction(7);
    expect(result).toEqual({ ok: false, error: "Channel is disabled.", code: "channel_disabled" });
  });

  it("D: non-Telegram channel → unsupported_channel", async () => {
    mRepo.getChannel.mockReturnValue(
      telegramChannel({ type: "email", config: JSON.stringify({ to: "a@b.c" }) }) as never,
    );
    const result = await sendTestNotificationAction(7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_channel");
    }
    expect(mRepo.insertNotificationEvents).not.toHaveBeenCalled();
  });

  it("E: Telegram channel without configured secret → secret_not_configured", async () => {
    mSecrets.hasChannelSecret.mockReturnValue(false);
    const result = await sendTestNotificationAction(7);
    expect(result).toEqual({
      ok: false,
      error: "Telegram token is not configured for this channel.",
      code: "secret_not_configured",
    });
    expect(mRepo.insertNotificationEvents).not.toHaveBeenCalled();
  });
});

describe("sendTestNotificationAction — happy path through existing pipeline", () => {
  it("F/N: sender is invoked once and success returns sent", async () => {
    const fetchCalls: string[] = [];
    stubTelegramFetch(() => FAKE_BOT, fetchCalls);

    const result = await sendTestNotificationAction(7);

    expect(result).toEqual({ ok: true, status: "sent", eventId: 42, deliveryId: 77 });
    // Existing factory + sender were used: exactly one Telegram API call
    // through the sender (never a direct fetch in the action).
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatch(/^https:\/\/api\.telegram\.org\/bot/);
    expect(fetchCalls[0]).toContain("/sendMessage");
    // The factory resolver (getChannelSecret) supplied the token to the sender.
    expect(mSecrets.getChannelSecret).toHaveBeenCalledWith(7, "token");
    expect(mRepo.markDeliverySent).toHaveBeenCalledTimes(1);
    expect(mRepo.markDeliveryFailed).not.toHaveBeenCalled();
  });

  it("G: action never fetches Telegram directly (only the sender does)", async () => {
    const fetchCalls: string[] = [];
    stubTelegramFetch(() => FAKE_BOT, fetchCalls);
    await sendTestNotificationAction(7);
    // Exactly ONE fetch, and it is the sender's sendMessage call.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("api.telegram.org");
  });

  it("H/I/J: response leaks no token, ciphertext, or secretRef", async () => {
    stubTelegramFetch(() => FAKE_BOT);
    const result = await sendTestNotificationAction(7);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("secretRef");
    expect(serialized).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(serialized).not.toContain("ENCRYPTION_KEY");
  });

  it("M: sender failure → controlled send_failed error", async () => {
    stubTelegramFetch(() => ({ ok: false, description: "Unauthorized" }));
    const result = await sendTestNotificationAction(7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("send_failed");
      // Controlled user-safe message — no token, no raw API details.
      expect(result.error).not.toContain(FAKE_TOKEN);
      expect(result.error).not.toContain("api.telegram.org");
    }
    expect(mRepo.markDeliveryFailed).toHaveBeenCalledTimes(1);
    expect(mRepo.markDeliverySent).not.toHaveBeenCalled();
  });

  it("duplicate same-nonce request (dedup hit) → duplicate_request, no second send", async () => {
    const fetchCalls: string[] = [];
    stubTelegramFetch(() => FAKE_BOT, fetchCalls);

    mRepo.insertNotificationEvents.mockReturnValueOnce([42]);
    const first = await sendTestNotificationAction(7);
    expect(first.ok).toBe(true);

    // Replay of the same invocation: the UNIQUE dedupKey absorbs it.
    mRepo.insertNotificationEvents.mockReturnValueOnce([null]);
    const second = await sendTestNotificationAction(7);
    expect(second).toEqual({
      ok: false,
      error: "Test notification was already sent.",
      code: "duplicate_request",
    });

    // Exactly one sendMessage happened despite the two invocations.
    expect(fetchCalls).toHaveLength(1);
    expect(mRepo.createDelivery).toHaveBeenCalledTimes(1);
  });

  it("no domain available → no_domain, nothing is sent", async () => {
    mDomains.getDomains.mockReturnValue([]);
    const result = await sendTestNotificationAction(7);
    expect(result).toEqual({
      ok: false,
      error: "No domain available for test notification.",
      code: "no_domain",
    });
    expect(mRepo.insertNotificationEvents).not.toHaveBeenCalled();
  });
});
