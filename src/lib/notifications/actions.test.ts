/**
 * Server action CRUD tests (Phase 8B).
 *
 * The actions module talks to the production DB through the repository
 * singleton and to the network through webhook validators — both are
 * mocked here so no production data is ever touched and no DNS/network
 * call is made. parse* config functions stay REAL (they are pure), so
 * config validation is tested against the actual sender contracts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/notifications/senders/webhook", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    validateWebhookUrl: vi.fn(async (url: string) => {
      if (!url.startsWith("https://")) {
        throw new Error("blocked");
      }
      return url;
    }),
    defaultLookup: vi.fn(),
  };
});
vi.mock("@/lib/runtime/repository", () => ({
  getRepository: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import {
  createChannelAction,
  createRuleAction,
  deleteChannelAction,
  deleteRuleAction,
  getNotificationsOverviewAction,
  retryDeliveryAction,
  setChannelEnabledAction,
  setRuleEnabledAction,
  updateChannelAction,
  updateRuleAction,
} from "./actions";
import { requireAdmin } from "@/lib/auth/admin";
import { getRepository } from "@/lib/runtime/repository";

const m = {
  getChannel: vi.fn(),
  getChannels: vi.fn(),
  getDeliveriesWithDetails: vi.fn(),
  getRules: vi.fn(),
  retryDelivery: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  setChannelEnabled: vi.fn(),
  deleteChannel: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  setRuleEnabled: vi.fn(),
  deleteRule: vi.fn(),
  getDomainById: vi.fn(),
};
const mockedGetRepository = vi.mocked(getRepository);
const mockedRevalidatePath = vi.mocked(revalidatePath);
const mockedRequireAdmin = vi.mocked(requireAdmin);

const EMAIL_CONFIG = JSON.stringify({
  to: "a@b.c",
  from: "d@e.f",
  endpoint: "https://api.example.com/send",
  apiKeyRef: "EMAIL_API_KEY",
});
const WEBHOOK_CONFIG = JSON.stringify({
  url: "https://hooks.example.com/x",
  secretRef: "WEBHOOK_SECRET",
});
const TELEGRAM_CONFIG = JSON.stringify({ chatId: "100000001", secretRef: "TELEGRAM_BOT_TOKEN" });
const FAKE_SECRET = "TEST_TELEGRAM_BOT_TOKEN_FAKE_VALUE_123456";

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: "telegram",
    name: "TG",
    config: TELEGRAM_CONFIG,
    enabled: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetRepository.mockResolvedValue(m as never);
  mockedRequireAdmin.mockResolvedValue(true);
  m.getDomainById.mockResolvedValue({ id: 1, hostname: "example.com" } as never);
});

describe("authorization guard", () => {
  it("rejects CRUD actions with the unauthorized machine code when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);

    expect(
      await createChannelAction({ type: "telegram", name: "TG", config: TELEGRAM_CONFIG }),
    ).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(
      await createRuleAction({
        name: "R",
        channelId: 1,
        source: undefined,
        eventType: undefined,
        domainId: undefined,
        enabled: true,
      }),
    ).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(await updateChannelAction({ id: 1, name: "X" })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(await setChannelEnabledAction({ id: 1, enabled: false })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(await deleteChannelAction({ id: 1 })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(
      await updateRuleAction({
        id: 1,
        name: "R",
        channelId: 1,
        source: undefined,
        eventType: undefined,
        domainId: undefined,
        enabled: true,
      }),
    ).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(await setRuleEnabledAction({ id: 1, enabled: false })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(await deleteRuleAction({ id: 1 })).toEqual({
      ok: false,
      error: "unauthorized",
    });

    // None of the repository writes may run.
    expect(m.createChannel).not.toHaveBeenCalled();
    expect(m.createRule).not.toHaveBeenCalled();
    expect(m.updateChannel).not.toHaveBeenCalled();
    expect(m.deleteChannel).not.toHaveBeenCalled();
    expect(m.deleteRule).not.toHaveBeenCalled();
  });

  it("rejects read-only overview with a plain Unauthorized message when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    const result = await getNotificationsOverviewAction();
    expect(result).toEqual({ ok: false, error: "unauthorized" });
  });

  it("rejects retry with a plain Unauthorized message when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);
    const result = await retryDeliveryAction(1);
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(m.retryDelivery).not.toHaveBeenCalled();
  });
});

describe("channel CRUD actions", () => {
  it("creates a valid telegram channel and revalidates", async () => {
    const result = await createChannelAction({
      type: "telegram",
      name: "TG",
      config: TELEGRAM_CONFIG,
    });
    expect(result).toEqual({ ok: true });
    expect(m.createChannel).toHaveBeenCalledWith(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "100000001", secretRef: "TELEGRAM_BOT_TOKEN" }),
    );
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/notifications");
  });

  it("rejects an unknown channel type", async () => {
    const result = await createChannelAction({ type: "fax", name: "X", config: "{}" });
    expect(result).toEqual({ ok: false, error: "invalid_channel_type" });
    expect(m.createChannel).not.toHaveBeenCalled();
  });

  it("rejects an invalid telegram chatId", async () => {
    for (const config of [
      JSON.stringify({ chatId: "abc", secretRef: "TELEGRAM_BOT_TOKEN" }),
      JSON.stringify({ chatId: "12", secretRef: "TELEGRAM_BOT_TOKEN" }),
      JSON.stringify({ chatId: "-x", secretRef: "TELEGRAM_BOT_TOKEN" }),
    ]) {
      const result = await createChannelAction({ type: "telegram", name: "TG", config });
      expect(result).toEqual({ ok: false, error: "invalid_chat_id" });
    }
    // Empty chatId fails the parse itself → invalid_config.
    const empty = await createChannelAction({
      type: "telegram",
      name: "TG",
      config: JSON.stringify({ chatId: "", secretRef: "TELEGRAM_BOT_TOKEN" }),
    });
    expect(empty).toEqual({ ok: false, error: "invalid_config" });
    expect(m.createChannel).not.toHaveBeenCalled();
  });

  it("rejects an invalid secretRef (env var name required)", async () => {
    const bad = [
      {
        type: "telegram",
        name: "TG",
        config: JSON.stringify({ chatId: "100000001", secretRef: "BAD REF!" }),
      },
      {
        type: "email",
        name: "M",
        config: JSON.stringify({
          to: "a@b.c",
          from: "d@e.f",
          endpoint: "https://api.example.com/send",
          apiKeyRef: "1BAD",
        }),
      },
      {
        type: "webhook",
        name: "H",
        config: JSON.stringify({ url: "https://hooks.example.com/x", secretRef: "bad-ref" }),
      },
    ] as const;
    for (const input of bad) {
      const result = await createChannelAction(input);
      expect(result).toEqual({ ok: false, error: "invalid_secret_ref" });
    }
  });

  it("rejects an invalid webhook URL (SSRF validator applied)", async () => {
    const result = await createChannelAction({
      type: "webhook",
      name: "H",
      config: JSON.stringify({ url: "http://127.0.0.1/x", secretRef: "WEBHOOK_SECRET" }),
    });
    expect(result).toEqual({ ok: false, error: "invalid_config" });
    expect(m.createChannel).not.toHaveBeenCalled();
  });

  it("rejects an invalid email config (missing field)", async () => {
    const result = await createChannelAction({
      type: "email",
      name: "M",
      config: JSON.stringify({ to: "a@b.c" }),
    });
    expect(result).toEqual({ ok: false, error: "invalid_config" });
  });

  it("normalizes stored config and never persists extra secret values", async () => {
    const configWithExtra = JSON.stringify({
      chatId: "100000001",
      secretRef: "TELEGRAM_BOT_TOKEN",
      token: FAKE_SECRET,
    });
    await createChannelAction({ type: "telegram", name: "TG", config: configWithExtra });
    const stored = m.createChannel.mock.calls[0][2] as string;
    expect(stored).not.toContain(FAKE_SECRET);
    expect(JSON.parse(stored)).toEqual({ chatId: "100000001", secretRef: "TELEGRAM_BOT_TOKEN" });
  });

  it("updateChannelAction validates against the channel's own type", async () => {
    m.getChannel.mockResolvedValue(channelRow({ type: "email", config: EMAIL_CONFIG }));
    m.updateChannel.mockResolvedValue(true);
    const result = await updateChannelAction({ id: 1, name: "Mail2" });
    expect(result).toEqual({ ok: true });
    expect(m.updateChannel).toHaveBeenCalledWith(1, { name: "Mail2" });
  });

  it("updateChannelAction returns nothing_to_update when empty", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    const result = await updateChannelAction({ id: 1 });
    expect(result).toEqual({ ok: false, error: "nothing_to_update" });
  });

  it("updateChannelAction returns channel_not_found", async () => {
    m.getChannel.mockResolvedValue(undefined);
    const result = await updateChannelAction({ id: 999, name: "X" });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  it("setChannelEnabledAction requires a strict boolean", async () => {
    for (const enabled of ["true", "1", 1, 0, null]) {
      const result = await setChannelEnabledAction({ id: 1, enabled });
      expect(result).toEqual({ ok: false, error: "invalid_enabled" });
    }
    m.setChannelEnabled.mockResolvedValue(true);
    const ok = await setChannelEnabledAction({ id: 1, enabled: false });
    expect(ok).toEqual({ ok: true });
    expect(m.setChannelEnabled).toHaveBeenCalledWith(1, false);
  });

  it("setChannelEnabledAction returns channel_not_found when update misses", async () => {
    m.setChannelEnabled.mockResolvedValue(false);
    const result = await setChannelEnabledAction({ id: 1, enabled: true });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  it("deleteChannelAction returns channel_not_found", async () => {
    m.deleteChannel.mockResolvedValue(false);
    const result = await deleteChannelAction({ id: 1 });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    m.deleteChannel.mockResolvedValue(true);
    expect(await deleteChannelAction({ id: 1 })).toEqual({ ok: true });
  });
});

describe("rule CRUD actions", () => {
  const base = {
    name: "R",
    channelId: 1,
    source: "http",
    eventType: "http_status_changed",
    domainId: 1,
    enabled: true,
  };

  it("creates a valid rule", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    const result = await createRuleAction(base);
    expect(result).toEqual({ ok: true });
    expect(m.createRule).toHaveBeenCalledWith({
      ...base,
      name: "R",
      source: "http",
      eventType: "http_status_changed",
      domainId: 1,
      enabled: true,
    });
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/notifications");
  });

  it("allows null source/eventType/domainId (All semantics)", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    const result = await createRuleAction({
      ...base,
      source: null,
      eventType: null,
      domainId: null,
    });
    expect(result).toEqual({ ok: true });
    expect(m.createRule).toHaveBeenCalledWith(
      expect.objectContaining({ source: null, eventType: null, domainId: null }),
    );
  });

  it("rejects a missing channel", async () => {
    m.getChannel.mockResolvedValue(undefined);
    const result = await createRuleAction(base);
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  it("rejects a missing domain", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    m.getDomainById.mockResolvedValue(undefined);
    const result = await createRuleAction(base);
    expect(result).toEqual({ ok: false, error: "domain_not_found" });
  });

  it("rejects an invalid eventType (RDAP and others blocked)", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    for (const eventType of ["rdap_event", "ssl_expiring", "bogus"]) {
      const result = await createRuleAction({ ...base, eventType });
      expect(result).toEqual({ ok: false, error: "invalid_event_type" });
    }
    expect(m.createRule).not.toHaveBeenCalled();
  });

  it("rejects an invalid source", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    const result = await createRuleAction({ ...base, source: "rdap" });
    expect(result).toEqual({ ok: false, error: "invalid_source" });
  });

  it("updateRuleAction returns rule_not_found", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    m.updateRule.mockResolvedValue(false);
    const result = await updateRuleAction({ id: 999, ...base });
    expect(result).toEqual({ ok: false, error: "rule_not_found" });
  });

  it("setRuleEnabledAction / deleteRuleAction handle missing rules", async () => {
    m.setRuleEnabled.mockResolvedValue(false);
    expect(await setRuleEnabledAction({ id: 1, enabled: true })).toEqual({
      ok: false,
      error: "rule_not_found",
    });
    m.deleteRule.mockResolvedValue(false);
    expect(await deleteRuleAction({ id: 1 })).toEqual({ ok: false, error: "rule_not_found" });
    m.setRuleEnabled.mockResolvedValue(true);
    m.deleteRule.mockResolvedValue(true);
    expect(await setRuleEnabledAction({ id: 1, enabled: false })).toEqual({ ok: true });
    expect(await deleteRuleAction({ id: 1 })).toEqual({ ok: true });
  });
});

describe("secret boundary (Phase 8B)", () => {
  it("controlled errors never contain secret values", async () => {
    m.getChannel.mockResolvedValue(channelRow());
    const bad = await createChannelAction({
      type: "telegram",
      name: "TG",
      config: JSON.stringify({ chatId: "x", secretRef: "TELEGRAM_BOT_TOKEN", token: FAKE_SECRET }),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).not.toContain("TEST_TELEGRAM");
      expect(bad.error).not.toContain(FAKE_SECRET);
    }
    const rule = await createRuleAction({
      name: "R",
      channelId: 1,
      source: "http",
      eventType: "http_status_changed",
      domainId: 1,
      enabled: true,
    });
    expect(rule.ok).toBe(true);
    const storedRule = m.createRule.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(storedRule as unknown)).not.toContain(FAKE_SECRET);
  });
});

describe("toChannelView (Phase 8B telegram fix / Phase 9G legacy)", () => {
  it("renders telegram channels correctly (no longer configInvalid)", async () => {
    m.getChannels.mockResolvedValue([
      channelRow({ id: 1, type: "telegram", config: TELEGRAM_CONFIG }),
    ]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channels).toHaveLength(1);
      const view = result.channels[0];
      expect(view.configInvalid).toBe(false);
      // 9G: the env var NAME is hidden from the UI — legacy channels only
      // surface a neutral "legacy" marker (never TELEGRAM_BOT_TOKEN).
      expect(view.configFields.map((f) => [f.label, f.value])).toEqual([
        ["Chat ID", "100000001"],
        ["Language", "en"],
        ["Timezone", "UTC"],
        ["Legacy token", "configured via environment"],
      ]);
      expect(JSON.stringify(view)).not.toContain("TELEGRAM_BOT_TOKEN");
    }
  });

  it("renders 9G telegram config (chatId only) without legacy marker", async () => {
    m.getChannels.mockResolvedValue([
      channelRow({ id: 1, type: "telegram", config: JSON.stringify({ chatId: "100000001" }) }),
    ]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view = result.channels[0];
      expect(view.configInvalid).toBe(false);
      expect(view.configFields.map((f) => [f.label, f.value])).toEqual([
        ["Chat ID", "100000001"],
        ["Language", "en"],
        ["Timezone", "UTC"],
      ]);
    }
  });

  it("renders zh-CN language from telegram config (11I)", async () => {
    m.getChannels.mockResolvedValue([
      channelRow({
        id: 1,
        type: "telegram",
        config: JSON.stringify({ chatId: "100000001", language: "zh-CN" }),
      }),
    ]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view = result.channels[0];
      expect(view.configFields.map((f) => [f.label, f.value])).toEqual([
        ["Chat ID", "100000001"],
        ["Language", "zh-CN"],
        ["Timezone", "UTC"],
      ]);
    }
  });

  it("renders timezone from telegram config, defaulting to UTC (11J)", async () => {
    m.getChannels.mockResolvedValue([
      channelRow({
        id: 1,
        type: "telegram",
        config: JSON.stringify({
          chatId: "100000001",
          language: "en",
          timezone: "Asia/Shanghai",
        }),
      }),
    ]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view = result.channels[0];
      expect(view.configFields.map((f) => [f.label, f.value])).toEqual([
        ["Chat ID", "100000001"],
        ["Language", "en"],
        ["Timezone", "Asia/Shanghai"],
      ]);
    }
  });

  it("keeps webhook rendering correct", async () => {
    m.getChannels.mockResolvedValue([
      channelRow({ id: 1, type: "webhook", config: WEBHOOK_CONFIG }),
    ]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view = result.channels[0];
      expect(view.configInvalid).toBe(false);
      expect(view.configFields.map((f) => f.label)).toEqual(["URL", "Secret ref"]);
    }
  });

  it("keeps email rendering correct", async () => {
    m.getChannels.mockResolvedValue([channelRow({ id: 1, type: "email", config: EMAIL_CONFIG })]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view = result.channels[0];
      expect(view.configInvalid).toBe(false);
      expect(view.configFields.map((f) => f.label)).toEqual([
        "To",
        "From",
        "Endpoint",
        "API key ref",
      ]);
    }
  });

  it("rejects unknown channel types safely (never parsed as webhook)", async () => {
    m.getChannels.mockResolvedValue([channelRow({ id: 1, type: "fax", config: WEBHOOK_CONFIG })]);
    m.getRules.mockResolvedValue([]);
    m.getDeliveriesWithDetails.mockResolvedValue([]);
    const result = await getNotificationsOverviewAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view = result.channels[0];
      expect(view.configInvalid).toBe(true);
      expect(view.configFields).toEqual([]);
    }
  });
});
