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
  fetchTelegramBotInfo,
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
  it("parses chatId without secretRef (9G config)", () => {
    expect(parseTelegramConfig(JSON.stringify({ chatId: "123456789" }))).toEqual({
      chatId: "123456789",
    });
  });
  it("rejects invalid JSON / missing fields", () => {
    expect(() => parseTelegramConfig("not json")).toThrow(TelegramError);
    expect(() => parseTelegramConfig("{}")).toThrow(TelegramError);
    expect(() => parseTelegramConfig(JSON.stringify({ chatId: 123 }))).toThrow(TelegramError);
    expect(() => parseTelegramConfig(JSON.stringify({ secretRef: "X" }))).toThrow(TelegramError);
    expect(() => parseTelegramConfig(JSON.stringify({ chatId: "x", secretRef: 7 }))).toThrow(
      TelegramError,
    );
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
    // missing token (env not configured): message never names the ref or a
    // value — 9G made the message fully secret-free.
    const sender = new TelegramSender({
      fetchFn: fakeFetch(jsonResponse(200, { ok: true })),
      env: {},
      resolveDomain: () => "x",
    });
    try {
      await sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("not configured");
      expect(msg).not.toContain("TELEGRAM_BOT_TOKEN");
      expect(msg).not.toContain(TEST_TOKEN);
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

describe("fetchTelegramBotInfo", () => {
  // Format-valid fake token (never a real Telegram token).
  const FAKE_BOT_TOKEN = "123456789:AAH_test_token_abcdefghijklmnopqrstuvwxyz";
  const FAKE_BOT = {
    id: 111222333,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
  };

  function botFetch(body: unknown, status = 200): typeof fetch {
    return fakeFetch(jsonResponse(status, body));
  }

  it("1. getMe success → public identity", async () => {
    const bot = await fetchTelegramBotInfo(FAKE_BOT_TOKEN, {
      fetchFn: botFetch({ ok: true, result: FAKE_BOT }),
    });
    expect(bot).toEqual({ username: "test_bot", firstName: "Test Bot" });
  });

  it("2. getMe success with null username → firstName fallback data", async () => {
    const bot = await fetchTelegramBotInfo(FAKE_BOT_TOKEN, {
      fetchFn: botFetch({
        ok: true,
        result: { id: 1, is_bot: true, first_name: "No Name Bot", username: null },
      }),
    });
    expect(bot).toEqual({ username: null, firstName: "No Name Bot" });
  });

  it("3. invalid token format → controlled invalid-config, no token in error", async () => {
    try {
      await fetchTelegramBotInfo("not-a-token", { fetchFn: botFetch({ ok: true }) });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("invalid-config");
      expect((e as Error).message).not.toContain("not-a-token");
    }
  });

  it.each([400, 401, 429, 500])(
    "HTTP %i → controlled rejected, no token in error",
    async (status) => {
      try {
        await fetchTelegramBotInfo(FAKE_BOT_TOKEN, {
          fetchFn: botFetch({ ok: false }, status),
        });
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(TelegramError);
        expect((e as TelegramError).code).toBe("rejected");
        const msg = (e as Error).message;
        expect(msg).not.toContain(FAKE_BOT_TOKEN);
        expect(msg).not.toContain("api.telegram.org");
      }
    },
  );

  it("Telegram ok:false → controlled rejected", async () => {
    try {
      await fetchTelegramBotInfo(FAKE_BOT_TOKEN, {
        fetchFn: botFetch({ ok: false, error_code: 401, description: "Unauthorized" }, 200),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("rejected");
      expect((e as Error).message).not.toContain(FAKE_BOT_TOKEN);
    }
  });

  it("malformed JSON → controlled invalid-response", async () => {
    try {
      await fetchTelegramBotInfo(FAKE_BOT_TOKEN, {
        fetchFn: fakeFetch(() => new Response("<html>bad</html>", { status: 200 })),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("invalid-response");
      expect((e as Error).message).not.toContain(FAKE_BOT_TOKEN);
    }
  });

  it("result missing → controlled invalid-response", async () => {
    try {
      await fetchTelegramBotInfo(FAKE_BOT_TOKEN, { fetchFn: botFetch({ ok: true }) });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("invalid-response");
    }
  });

  it("result field type error → controlled invalid-response", async () => {
    try {
      await fetchTelegramBotInfo(FAKE_BOT_TOKEN, {
        fetchFn: botFetch({ ok: true, result: { id: 1, is_bot: true, first_name: 42 } }),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("invalid-response");
    }
  });

  it("timeout → controlled timeout", async () => {
    const abortFetch = (async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }) as unknown as typeof fetch;
    try {
      await fetchTelegramBotInfo(FAKE_BOT_TOKEN, { fetchFn: abortFetch, timeoutMs: 5 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("timeout");
      expect((e as Error).message).not.toContain(FAKE_BOT_TOKEN);
    }
  });

  it("redirect 3xx → rejected, never followed", async () => {
    let followed = false;
    const redirectFetch = (async () => {
      followed = true;
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
    }) as unknown as typeof fetch;
    try {
      await fetchTelegramBotInfo(FAKE_BOT_TOKEN, { fetchFn: redirectFetch });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("redirect");
      expect((e as Error).message).not.toContain("evil.example");
      expect((e as Error).message).not.toContain(FAKE_BOT_TOKEN);
    }
    expect(followed).toBe(true); // the fake captured the attempt; real fetch uses redirect:"manual"
  });

  it("calls ONLY getMe — never sendMessage", async () => {
    const urls: string[] = [];
    const spyFetch = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, { ok: true, result: FAKE_BOT });
    }) as unknown as typeof fetch;
    await fetchTelegramBotInfo(FAKE_BOT_TOKEN, { fetchFn: spyFetch });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`https://api.telegram.org/bot${FAKE_BOT_TOKEN}/getMe`);
    expect(urls[0]).not.toContain("sendMessage");
  });

  it("never echoes the token in any failure path", async () => {
    const attempts: (() => Response | Promise<Response>)[] = [
      () => jsonResponse(200, { ok: false }),
      () => jsonResponse(400, {}),
      () => jsonResponse(401, {}),
      () => jsonResponse(429, {}),
      () => jsonResponse(500, {}),
      () => jsonResponse(200, { ok: true, result: null }),
      () => jsonResponse(200, { ok: true, result: { first_name: 1 } }),
      () => new Response("<html>x</html>", { status: 200 }),
      () => new Response(null, { status: 301 }),
    ];
    for (const make of attempts) {
      try {
        await fetchTelegramBotInfo(FAKE_BOT_TOKEN, { fetchFn: fakeFetch(make) });
        throw new Error("expected throw");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).not.toContain(FAKE_BOT_TOKEN);
        expect(msg).not.toContain("AAH_test_token");
        expect(msg).not.toContain("/bot");
      }
    }
  });
});

describe("TelegramSender.send — Phase 9H secret resolution", () => {
  // Format-valid FAKE tokens (never real): storage-secret vs env token.
  const STORAGE_TOKEN = "123456789:AAH_storage_token_abcdefghijklmnopqrst";
  const ENV_TOKEN = "987654321:AAH_env_token_abcdefghijklmnopqrstuvwxyz";
  const STORAGE_ENV = { TELEGRAM_BOT_TOKEN: ENV_TOKEN };
  const NINE_G_CONFIG = JSON.stringify({ chatId: "123456789" }); // no secretRef

  function capturingSender(
    fetchFn: typeof fetch,
    resolveSecret?: (channelId: number, key: string) => Promise<string | null>,
    env: Record<string, string | undefined> = {},
  ) {
    return new TelegramSender({ fetchFn, env, resolveDomain: () => "example.com", resolveSecret });
  }

  function captureUrl(fetchFn: typeof fetch): {
    fetch: typeof fetch;
    url: () => string | undefined;
  } {
    let lastUrl: string | undefined;
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      lastUrl = String(url);
      return fetchFn(url as never, init as never);
    }) as unknown as typeof fetch;
    return { fetch: wrapped, url: () => lastUrl };
  }

  it("A. encrypted secret → sendMessage success", async () => {
    const c = captureUrl(fakeFetch(jsonResponse(200, { ok: true })));
    const sender = capturingSender(c.fetch, async () => STORAGE_TOKEN);
    await expect(sender.send(1, EVENT, { id: 1, config: NINE_G_CONFIG })).resolves.toBeUndefined();
    expect(c.url()).toContain(`/bot${STORAGE_TOKEN}/sendMessage`);
  });

  it("B. encrypted secret → fake fetch sees the STORAGE token (not env)", async () => {
    const c = captureUrl(fakeFetch(jsonResponse(200, { ok: true })));
    const sender = capturingSender(
      c.fetch,
      async () => STORAGE_TOKEN,
      STORAGE_ENV, // env also has a token — must NOT be used
    );
    await expect(sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG })).resolves.toBeUndefined();
    expect(c.url()).toContain(`/bot${STORAGE_TOKEN}/sendMessage`);
    expect(c.url()).not.toContain(ENV_TOKEN);
  });

  it("C. secret missing → legacy env fallback success", async () => {
    const c = captureUrl(fakeFetch(jsonResponse(200, { ok: true })));
    const sender = capturingSender(
      c.fetch,
      async () => null, // no notification_secrets row
      STORAGE_ENV, // secretRef: "TELEGRAM_BOT_TOKEN" points at env
    );
    await expect(sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG })).resolves.toBeUndefined();
    expect(c.url()).toContain(`/bot${ENV_TOKEN}/sendMessage`);
  });

  it("D. storage + env both present → storage wins", async () => {
    const c = captureUrl(fakeFetch(jsonResponse(200, { ok: true })));
    const sender = capturingSender(c.fetch, async () => STORAGE_TOKEN, STORAGE_ENV);
    await expect(sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG })).resolves.toBeUndefined();
    expect(c.url()).toContain(`/bot${STORAGE_TOKEN}/sendMessage`);
    expect(c.url()).not.toContain(ENV_TOKEN);
  });

  it("E. neither exists → controlled failure, no token in error", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    const sender = capturingSender(
      fetchFn,
      async () => null,
      {}, // no env token
    );
    try {
      await sender.send(1, EVENT, { id: 1, config: NINE_G_CONFIG });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("invalid-config");
      const msg = (e as Error).message;
      // Error text never contains any token VALUE / URL / ciphertext.
      expect(msg).not.toContain(TEST_TOKEN);
      expect(msg).not.toContain(STORAGE_TOKEN);
      expect(msg).not.toContain(ENV_TOKEN);
      expect(msg).not.toContain("ciphertext");
      expect(msg).not.toContain("api.telegram.org");
      expect(msg).not.toContain("/bot");
    }
    expect(fetchCalled).toBe(false);
  });

  it("F. decryption failure → surfaced, NOT masked, NO env fallback", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    const sender = capturingSender(
      fetchFn,
      async () => {
        throw new Error("AES-GCM decryption failed"); // getChannelSecret throws
      },
      STORAGE_ENV, // env token exists — must NOT be used
    );
    try {
      await sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramError);
      expect((e as TelegramError).code).toBe("invalid-config");
      const msg = (e as Error).message;
      expect(msg).toContain("decryption failed");
      // no secret content leaks
      expect(msg).not.toContain(ENV_TOKEN);
      expect(msg).not.toContain(STORAGE_TOKEN);
      expect(msg).not.toContain("ciphertext");
      expect(msg).not.toContain("iv:");
    }
    expect(fetchCalled).toBe(false);
  });

  it("G. no resolveSecret injected → legacy env-only path still works", async () => {
    const c = captureUrl(fakeFetch(jsonResponse(200, { ok: true })));
    const sender = capturingSender(c.fetch, undefined, STORAGE_ENV);
    await expect(sender.send(1, EVENT, { id: 1, config: FAKE_CONFIG })).resolves.toBeUndefined();
    expect(c.url()).toContain(`/bot${ENV_TOKEN}/sendMessage`);
  });
});
