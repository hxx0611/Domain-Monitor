/**
 * Phase 9G — Telegram token UI server actions.
 *
 * Real `fetchTelegramBotInfo` (getMe) with a stubbed global fetch — every
 * Telegram HTTP path is fake; the real Telegram API is NEVER called and no
 * real token is used. The secret repository is mocked at the action
 * boundary (its own encryption guarantees are covered by secrets.test.ts).
 * Asserts: getMe-gated saves, encrypted-secret writes, edit semantics,
 * legacy compatibility, unauthorized guards, and zero token leakage into
 * return values / DB writes / fetch URLs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/domains", () => ({ getDomainById: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/notifications/repository", () => ({
  getChannel: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  setChannelEnabled: vi.fn(),
  deleteChannel: vi.fn(),
}));
vi.mock("@/lib/notifications/secrets", () => ({
  hasChannelSecret: vi.fn(),
  setChannelSecret: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import {
  verifyTelegramTokenAction,
  saveTelegramChannelAction,
  getChannelSecretStatusAction,
} from "./actions";
import { requireAdmin } from "@/lib/auth/admin";
import * as repository from "@/lib/notifications/repository";
import * as secrets from "@/lib/notifications/secrets";

const mRepo = {
  getChannel: vi.mocked(repository.getChannel),
  createChannel: vi.mocked(repository.createChannel),
  updateChannel: vi.mocked(repository.updateChannel),
  setChannelEnabled: vi.mocked(repository.setChannelEnabled),
  deleteChannel: vi.mocked(repository.deleteChannel),
};
const mSecrets = {
  hasChannelSecret: vi.mocked(secrets.hasChannelSecret),
  setChannelSecret: vi.mocked(secrets.setChannelSecret),
};
const mockedRequireAdmin = vi.mocked(requireAdmin);
const mockedRevalidatePath = vi.mocked(revalidatePath);

// Format-valid fake token (never a real Telegram token).
const FAKE_TOKEN = "123456789:AAH_test_token_abcdefghijklmnopqrstuvwxyz";
const FAKE_BOT = { id: 111222333, is_bot: true, first_name: "Test Bot", username: "test_bot" };

function telegramChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    type: "telegram",
    name: "tg",
    config: JSON.stringify({ chatId: "1616146471" }),
    enabled: 1,
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
    ...overrides,
  };
}

function legacyTelegramChannel() {
  return telegramChannel({
    config: JSON.stringify({ chatId: "1616146471", secretRef: "TELEGRAM_BOT_TOKEN" }),
  });
}

/** Stub global fetch so the REAL fetchTelegramBotInfo uses the fake. */
function stubGetMe(response: () => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return response();
    }),
  );
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockedRequireAdmin.mockResolvedValue(true);
  mockedRevalidatePath.mockImplementation(() => undefined);
});

describe("verifyTelegramTokenAction", () => {
  it("returns public bot identity on getMe success — never the token", async () => {
    const calls = stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    const result = await verifyTelegramTokenAction({ token: FAKE_TOKEN });
    expect(result).toEqual({ ok: true, bot: { username: "test_bot", firstName: "Test Bot" } });
    expect(calls[0]).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getMe`);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("invalid token format → invalid_token, no fetch", async () => {
    const calls = stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    const result = await verifyTelegramTokenAction({ token: "not-a-token" });
    expect(result).toEqual({ ok: false, error: "invalid_token" });
    expect(calls).toHaveLength(0);
  });

  it("HTTP 401 → telegram_rejected (machine code only)", async () => {
    stubGetMe(() => jsonResponse(401, { ok: false }));
    const result = await verifyTelegramTokenAction({ token: FAKE_TOKEN });
    expect(result).toEqual({ ok: false, error: "telegram_rejected" });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("does not write the DB", async () => {
    stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    await verifyTelegramTokenAction({ token: FAKE_TOKEN });
    expect(mRepo.createChannel).not.toHaveBeenCalled();
    expect(mRepo.updateChannel).not.toHaveBeenCalled();
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
  });

  it("unauthorized → unauthorized, no fetch", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    const calls = stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    const result = await verifyTelegramTokenAction({ token: FAKE_TOKEN });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(calls).toHaveLength(0);
  });
});

describe("saveTelegramChannelAction", () => {
  it("create: getMe success → channel saved with non-secret config + encrypted secret", async () => {
    stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    mRepo.createChannel.mockReturnValue(42);

    const result = await saveTelegramChannelAction({
      channelId: null,
      name: "My Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(mRepo.createChannel).toHaveBeenCalledWith(
      "telegram",
      "My Bot",
      JSON.stringify({ chatId: "1616146471", language: "en" }),
    );
    // token lands in the encrypted secret store — never in the config.
    const configArg = mRepo.createChannel.mock.calls[0][2];
    expect(configArg).not.toContain(FAKE_TOKEN);
    expect(configArg).not.toContain("secretRef");
    expect(mSecrets.setChannelSecret).toHaveBeenCalledWith(42, "token", FAKE_TOKEN);
    expect(mRepo.setChannelEnabled).not.toHaveBeenCalled(); // enabled default true
  });

  it("create with language=zh-CN persists language in config (11I)", async () => {
    stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    mRepo.createChannel.mockReturnValue(43);

    const result = await saveTelegramChannelAction({
      channelId: null,
      name: "My Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
      language: "zh-CN",
    });

    expect(result).toEqual({ ok: true });
    expect(mRepo.createChannel).toHaveBeenCalledWith(
      "telegram",
      "My Bot",
      JSON.stringify({ chatId: "1616146471", language: "zh-CN" }),
    );
  });

  it("create with invalid language → invalid_language (11I)", async () => {
    stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    const result = await saveTelegramChannelAction({
      channelId: null,
      name: "My Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
      language: "fr",
    } as never);
    expect(result).toEqual({ ok: false, error: "invalid_language" });
    expect(mRepo.createChannel).not.toHaveBeenCalled();
  });

  it("create with enabled=false disables the channel", async () => {
    stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    mRepo.createChannel.mockReturnValue(42);
    await saveTelegramChannelAction({
      channelId: null,
      name: "Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: false,
    });
    expect(mRepo.setChannelEnabled).toHaveBeenCalledWith(42, false);
  });

  it("create without token → token_required, nothing written", async () => {
    const calls = stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    const result = await saveTelegramChannelAction({
      channelId: null,
      name: "Bot",
      chatId: "1616146471",
      token: "",
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: "token_required" });
    expect(mRepo.createChannel).not.toHaveBeenCalled();
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("invalid token → no DB mutation at all", async () => {
    stubGetMe(() => jsonResponse(401, { ok: false }));
    const result = await saveTelegramChannelAction({
      channelId: null,
      name: "Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: "telegram_rejected" });
    expect(mRepo.createChannel).not.toHaveBeenCalled();
    expect(mRepo.updateChannel).not.toHaveBeenCalled();
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
  });

  it("edit with blank token keeps the existing secret", async () => {
    mRepo.getChannel.mockReturnValue(telegramChannel());
    mSecrets.hasChannelSecret.mockReturnValue(true);

    const result = await saveTelegramChannelAction({
      channelId: 7,
      name: "Renamed",
      chatId: "1616146471",
      token: "",
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(mRepo.updateChannel).toHaveBeenCalledWith(7, {
      name: "Renamed",
      config: JSON.stringify({ chatId: "1616146471", language: "en" }),
    });
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
  });

  it("edit with blank token and no secret/legacy → token_required", async () => {
    mRepo.getChannel.mockReturnValue(telegramChannel());
    mSecrets.hasChannelSecret.mockReturnValue(false);

    const result = await saveTelegramChannelAction({
      channelId: 7,
      name: "Bot",
      chatId: "1616146471",
      token: "",
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: "token_required" });
    expect(mRepo.updateChannel).not.toHaveBeenCalled();
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
  });

  it("edit legacy channel (secretRef) with blank token stays valid (ref preserved)", async () => {
    mRepo.getChannel.mockReturnValue(legacyTelegramChannel());
    mSecrets.hasChannelSecret.mockReturnValue(false);

    const result = await saveTelegramChannelAction({
      channelId: 7,
      name: "Bot",
      chatId: "1616146471",
      token: "",
      enabled: true,
    });
    expect(result).toEqual({ ok: true });
    // The legacy env ref NAME is preserved so the channel keeps working.
    expect(mRepo.updateChannel).toHaveBeenCalledWith(7, {
      name: "Bot",
      config: JSON.stringify({
        chatId: "1616146471",
        secretRef: "TELEGRAM_BOT_TOKEN",
        language: "en",
      }),
    });
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
  });

  it("edit with new token replaces the encrypted secret", async () => {
    mRepo.getChannel.mockReturnValue(telegramChannel({ enabled: 0 }));
    stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));

    const result = await saveTelegramChannelAction({
      channelId: 7,
      name: "Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(mSecrets.setChannelSecret).toHaveBeenCalledWith(7, "token", FAKE_TOKEN);
    expect(mRepo.setChannelEnabled).toHaveBeenCalledWith(7, true);
    // config never carries the token
    const configArg = mRepo.updateChannel.mock.calls[0][1].config;
    expect(configArg).not.toContain(FAKE_TOKEN);
  });

  it("edit non-telegram channel → invalid_channel_type", async () => {
    mRepo.getChannel.mockReturnValue({
      id: 7,
      type: "email",
      name: "mail",
      config: "{}",
      enabled: 1,
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
    });
    const result = await saveTelegramChannelAction({
      channelId: 7,
      name: "Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: "invalid_channel_type" });
  });

  it("unauthorized → unauthorized, nothing written, no Telegram call", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    const calls = stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    const result = await saveTelegramChannelAction({
      channelId: null,
      name: "Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mRepo.createChannel).not.toHaveBeenCalled();
    expect(mSecrets.setChannelSecret).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("only getMe is ever called — sendMessage count = 0", async () => {
    const calls = stubGetMe(() => jsonResponse(200, { ok: true, result: FAKE_BOT }));
    mRepo.createChannel.mockReturnValue(42);
    await saveTelegramChannelAction({
      channelId: null,
      name: "Bot",
      chatId: "1616146471",
      token: FAKE_TOKEN,
      enabled: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/getMe");
    expect(calls[0]).not.toContain("/sendMessage");
  });
});

describe("getChannelSecretStatusAction", () => {
  it("returns boolean only — never ciphertext/ref", async () => {
    mRepo.getChannel.mockReturnValue(telegramChannel());
    mSecrets.hasChannelSecret.mockReturnValue(true);
    const result = await getChannelSecretStatusAction({ channelId: 7 });
    expect(result).toEqual({ ok: true, hasToken: true });
    expect(JSON.stringify(result)).not.toContain("token:");
    expect(JSON.stringify(result)).not.toContain("secretRef");
  });

  it("hasToken=false when no secret", async () => {
    mRepo.getChannel.mockReturnValue(telegramChannel());
    mSecrets.hasChannelSecret.mockReturnValue(false);
    const result = await getChannelSecretStatusAction({ channelId: 7 });
    expect(result).toEqual({ ok: true, hasToken: false });
  });

  it("unauthorized → unauthorized", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    const result = await getChannelSecretStatusAction({ channelId: 7 });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
  });

  it("missing channel → channel_not_found", async () => {
    mRepo.getChannel.mockReturnValue(undefined);
    const result = await getChannelSecretStatusAction({ channelId: 7 });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });
});
