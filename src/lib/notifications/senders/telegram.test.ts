/**
 * Telegram sender tests — fake fetch, NO real Telegram API, no real token.
 * Token leakage is asserted across every failure path.
 */

import { describe, expect, it } from "vitest";

import {
  TelegramSender,
  TelegramError,
  parseTelegramConfig,
  buildTelegramMessage,
  TELEGRAM_API_BASE,
} from "./telegram";
import type { NotificationEvent } from "../types";

const TEST_TOKEN = "TEST_TELEGRAM_BOT_TOKEN";
const FAKE_CONFIG = JSON.stringify({ chatId: "123456789", secretRef: "TELEGRAM_BOT_TOKEN" });
const FAKE_ENV = { TELEGRAM_BOT_TOKEN: TEST_TOKEN };

const EVENT: NotificationEvent = {
  domainId: 42,
  source: "http",
  eventType: "http_status_changed",
  previousState: JSON.stringify({ status: "ok", httpStatus: 200 }),
  currentState: JSON.stringify({ status: "server_error", httpStatus: 500 }),
  dedupKey: "http:42:http_status_changed:ok:server_error",
  occurredAt: new Date("2026-08-16T12:00:00.000Z"),
};

function makeSender(fetchFn: typeof fetch) {
  return new TelegramSender({
    fetchFn,
    env: FAKE_ENV,
    resolveDomain: () => "example.com",
  });
}

function fakeFetch(
  response: Partial<Response> | (() => Response | Promise<Response>),
): typeof fetch {
  return (async () => {
    if (typeof response === "function") {
      return response();
    }
    return response as Response;
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseTelegramConfig", () => {
  it("parses chatId + secretRef", () => {
    expect(parseTelegramConfig(FAKE_CONFIG)).toEqual({
      chatId: "123456789",
      secretRef: "TELEGRAM_BOT_TOKEN",
    });
  });
  it("rejects invalid JSON / missing fields", () => {
    expect(() => parseTelegramConfig("not json")).toThrow(TelegramError);
    expect(() => parseTelegramConfig("{}")).toThrow(TelegramError);
    expect(() => parseTelegramConfig(JSON.stringify({ chatId: "x" }))).toThrow(TelegramError);
    expect(() => parseTelegramConfig(JSON.stringify({ secretRef: "X" }))).toThrow(TelegramError);
  });
});

describe("TelegramSender.send", () => {
  it("1. HTTP 200 + {ok:true} → success", async () => {
    let called = false;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      called = true;
      expect(String(url)).toContain(`${TELEGRAM_API_BASE}/bot${TEST_TOKEN}/sendMessage`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body.chat_id).toBe("123456789");
      expect(body.text).toContain("example.com");
      expect(body.text).toContain("HTTP status changed");
      expect(body.text).toContain("ok (200) → server_error (500)");
      expect(body.text).toContain("http:42:http_status_changed:ok:server_error");
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    await expect(
      makeSender(fetchFn).send(1, EVENT, { id: 1, config: FAKE_CONFIG }),
    ).resolves.toBeUndefined();
    expect(called).toBe(true);
  });

  it("2. HTTP 400 → rejected", async () => {
    await expect(
      makeSender(fakeFetch(jsonResponse(400, { ok: false }))).send(1, EVENT, {
        id: 1,
        config: FAKE_CONFIG,
      }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "rejected" });
  });

  it("3. HTTP 401 → rejected", async () => {
    await expect(
      makeSender(fakeFetch(jsonResponse(401, { ok: false }))).send(1, EVENT, {
        id: 1,
        config: FAKE_CONFIG,
      }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "rejected" });
  });

  it("4. HTTP 429 → rejected", async () => {
    await expect(
      makeSender(fakeFetch(jsonResponse(429, { ok: false }))).send(1, EVENT, {
        id: 1,
        config: FAKE_CONFIG,
      }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "rejected" });
  });

  it("5. HTTP 500 → rejected", async () => {
    await expect(
      makeSender(fakeFetch(jsonResponse(500, {}))).send(1, EVENT, { id: 1, config: FAKE_CONFIG }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "rejected" });
  });

  it("6. HTTP 200 + {ok:false} → rejected (never trust HTTP 200 alone)", async () => {
    await expect(
      makeSender(fakeFetch(jsonResponse(200, { ok: false, description: "Unauthorized" }))).send(
        1,
        EVENT,
        { id: 1, config: FAKE_CONFIG },
      ),
    ).rejects.toMatchObject({ name: "TelegramError", code: "rejected" });
  });

  it("7. malformed JSON → invalid-response", async () => {
    const res = new Response("<html>oops</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    await expect(
      makeSender(fakeFetch(res)).send(1, EVENT, { id: 1, config: FAKE_CONFIG }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "invalid-response" });
  });

  it("8. timeout / AbortError → timeout", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchFn = (async () => {
      throw err;
    }) as unknown as typeof fetch;
    await expect(
      makeSender(fetchFn).send(1, EVENT, { id: 1, config: FAKE_CONFIG }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "timeout" });
  });

  it("9. redirect response → redirect (never followed)", async () => {
    const res = new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/x" },
    });
    await expect(
      makeSender(fakeFetch(res)).send(1, EVENT, { id: 1, config: FAKE_CONFIG }),
    ).rejects.toMatchObject({ name: "TelegramError", code: "redirect" });
  });

  it("10. token leakage → zero across errors", async () => {
    const attempts: Array<() => Response> = [
      () => jsonResponse(500, {}),
      () => jsonResponse(400, { ok: false }),
      () => jsonResponse(200, { ok: false, description: "bad token" }),
      () => new Response("<html>x</html>", { status: 200 }),
    ];
    for (const make of attempts) {
      const sender = makeSender(fakeFetch(make));
      try {
        await sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).not.toContain(TEST_TOKEN);
        expect(msg).not.toContain("TEST_TELEGRAM");
      }
    }
    // missing token (env not configured) error names only the ref, never a value
    const sender = new TelegramSender({
      fetchFn: fakeFetch(jsonResponse(200, { ok: true })),
      env: {},
      resolveDomain: () => "x",
    });
    try {
      await sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("TELEGRAM_BOT_TOKEN");
      expect(msg).not.toContain("TEST_TELEGRAM");
    }
  });

  it("11. chatId passed correctly", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).chat_id).toBe("123456789");
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    await makeSender(fetchFn).send(1, EVENT, { id: 1, config: FAKE_CONFIG });
  });

  it("12. text passed correctly", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const text = JSON.parse(String(init?.body)).text as string;
      expect(text).toContain("Domain Monitor");
      expect(text).toContain("example.com");
      expect(text).not.toContain(TEST_TOKEN);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    await makeSender(fetchFn).send(1, EVENT, { id: 1, config: FAKE_CONFIG });
  });

  it("15. request URL uses the fixed Telegram API endpoint", async () => {
    const fetchFn = (async (url: string) => {
      expect(String(url)).toMatch(
        new RegExp(`^${TELEGRAM_API_BASE.replace(/\//g, "\\/")}/bot[^/]+/sendMessage$`),
      );
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    await makeSender(fetchFn).send(1, EVENT, { id: 1, config: FAKE_CONFIG });
  });

  it("rejects when token env is not configured", async () => {
    const sender = new TelegramSender({
      fetchFn: fakeFetch(jsonResponse(200, { ok: true })),
      env: {},
      resolveDomain: () => "x",
    });
    await expect(sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG })).rejects.toMatchObject({
      name: "TelegramError",
      code: "invalid-config",
    });
  });
});

describe("buildTelegramMessage", () => {
  it("renders domain, event, states, time and event id as plain text", () => {
    const msg = buildTelegramMessage(EVENT, "example.com");
    expect(msg).toContain("Domain: example.com");
    expect(msg).toContain("Event: HTTP status changed");
    expect(msg).toContain("Status: ok (200) → server_error (500)");
    expect(msg).toContain("Time: 2026-08-16T12:00:00.000Z");
    expect(msg).toContain("Event ID: http:42:http_status_changed:ok:server_error");
    expect(msg).not.toMatch(/\*\*|__|`/); // no markdown
  });

  it("falls back to domain id when hostname is unavailable", () => {
    expect(buildTelegramMessage(EVENT, undefined)).toContain("Domain: #42");
  });
});
