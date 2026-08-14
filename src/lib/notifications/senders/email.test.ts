import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http/client";
import { buildEmailContent, EmailError, EmailSender, parseEmailConfig, readApiKey } from "./email";
import type { NotificationEvent } from "../types";

const PUBLIC_IP = "93.184.216.34";
const API_KEY = "sk_test_super_secret_123";

function event(): NotificationEvent {
  return {
    domainId: 5,
    source: "http",
    eventType: "http_status_changed",
    previousState: '"ok"',
    currentState: '"down"',
    occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    dedupKey: "http:5:http_status_changed:ok:down",
  };
}

function channelConfig(endpoint: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    to: "ops@example.com",
    from: "monitor@example.com",
    endpoint,
    apiKeyRef: "EMAIL_API_KEY",
    ...extra,
  });
}

function envWithKey(): Record<string, string> {
  return { EMAIL_API_KEY: API_KEY };
}

function okResponse(status = 200): Response {
  return new Response("{}", { status });
}

/** A fetch spy that records every call and returns queued responses. */
function fakeFetch(sequence: Array<Response | Error>) {
  const fn = vi.fn();
  for (const item of sequence) {
    fn.mockImplementationOnce(() =>
      item instanceof Error ? Promise.reject(item) : Promise.resolve(item),
    );
  }
  return fn as unknown as typeof fetch & { mock: ReturnType<typeof vi.fn>["mock"] };
}

function makeSender(
  fetchFn: ReturnType<typeof fakeFetch>,
  lookup: (hostname: string) => Promise<string[]>,
  env: Record<string, string | undefined> = envWithKey(),
) {
  return new EmailSender({ fetchFn, lookup, env });
}

function publicLookup() {
  return vi.fn().mockResolvedValue([PUBLIC_IP]);
}

const GOOD_URL = "https://api.email.example/v1/send";

describe("parseEmailConfig", () => {
  it("parses to/from/endpoint/apiKeyRef", () => {
    expect(
      parseEmailConfig(
        '{"to":"a@b.c","from":"m@b.c","endpoint":"https://api.example/send","apiKeyRef":"K"}',
      ),
    ).toEqual({
      to: "a@b.c",
      from: "m@b.c",
      endpoint: "https://api.example/send",
      apiKeyRef: "K",
    });
  });

  it("rejects invalid JSON and missing fields", () => {
    expect(() => parseEmailConfig("nope")).toThrow(EmailError);
    expect(() => parseEmailConfig("{}")).toThrow(EmailError);
    expect(() =>
      parseEmailConfig(
        '{"to":"a@b.c","from":"m@b.c","endpoint":"https://x/"}', // no apiKeyRef
      ),
    ).toThrow(/apiKeyRef/);
    expect(() =>
      parseEmailConfig(
        '{"to":"","from":"m@b.c","endpoint":"https://x/","apiKeyRef":"K"}', // empty to
      ),
    ).toThrow(/to/);
  });
});

describe("readApiKey", () => {
  it("returns the key from the env by ref", () => {
    expect(readApiKey("EMAIL_API_KEY", envWithKey())).toBe(API_KEY);
  });

  it("throws naming only the ref, never a value", () => {
    try {
      readApiKey("EMAIL_API_KEY", {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError);
      expect((error as EmailError).message).toContain("EMAIL_API_KEY");
      expect((error as EmailError).message).not.toContain(API_KEY);
    }
  });
});

describe("buildEmailContent", () => {
  it("carries eventId and deliveryId in the body (at-least-once dedup)", () => {
    const { subject, text } = buildEmailContent(42, event());
    expect(subject).toContain("http");
    expect(subject).toContain("http_status_changed");
    expect(subject).toContain("domain #5");
    expect(text).toContain("Event ID: http:5:http_status_changed:ok:down");
    expect(text).toContain("Delivery ID: 42");
    expect(text).toContain('Previous state: "ok"');
    expect(text).toContain('Current state: "down"');
    expect(text).not.toContain("secret");
  });
});

describe("EmailSender.send — SSRF matrix with request-count proof", () => {
  it("rejects an endpoint resolving to 127.0.0.1 and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects an endpoint resolving to 10.x and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["10.1.2.3"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects an endpoint resolving to 169.254.169.254 and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["169.254.169.254"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects a public hostname resolving to loopback (DNS rebinding) with ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), {
        id: 9,
        config: channelConfig("https://api.email.example/v1/send"),
      }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects an http:// endpoint and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const sender = makeSender(fetchFn, publicLookup());

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("http://api.email.example/v1/send") }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("blocks a redirect into an internal IP and issues exactly ONE request", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce(["192.168.1.1"]);
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://evil.example/hook" } }),
      okResponse(),
    ]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(1); // second request never issued
  });

  it("blocks a second-hop redirect into an internal IP (deep chain)", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce(["10.0.0.1"]);
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://b.example/hook" } }),
      new Response("", { status: 302, headers: { location: "https://c.example/hook" } }),
      okResponse(),
    ]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(2); // hop 2 request never issued
  });

  it("rejects a 6-hop redirect chain (max 5)", async () => {
    const lookup = publicLookup();
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://a.example/1" } }),
      new Response("", { status: 302, headers: { location: "https://a.example/2" } }),
      new Response("", { status: 302, headers: { location: "https://a.example/3" } }),
      new Response("", { status: 302, headers: { location: "https://a.example/4" } }),
      new Response("", { status: 302, headers: { location: "https://a.example/5" } }),
      new Response("", { status: 302, headers: { location: "https://a.example/6" } }),
      okResponse(),
    ]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "too-many-redirects" });
    expect(fetchFn.mock.calls).toHaveLength(6); // 5 followed + 1 rejected before 6th
  });
});

describe("EmailSender.send — request shape & key handling", () => {
  it("POSTs JSON with to/from/subject/text and Authorization: Bearer", async () => {
    const fetchFn = fakeFetch([okResponse(200)]);
    const sender = makeSender(fetchFn, publicLookup());

    await sender.send(7, event(), { id: 9, config: channelConfig(GOOD_URL) });

    expect(fetchFn.mock.calls).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { redirect: string }];
    expect(url).toBe(GOOD_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.to).toBe("ops@example.com");
    expect(body.from).toBe("monitor@example.com");
    expect(body.subject).toContain("http_status_changed");
    expect(body.text).toContain("Delivery ID: 7");
    expect(body.text).toContain("Event ID: http:5:http_status_changed:ok:down");
    // The key is in the header, never in the payload.
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("never leaks the API key into error messages", async () => {
    const fetchFn = fakeFetch([new Response("nope", { status: 500 })]);
    const sender = makeSender(fetchFn, publicLookup());

    try {
      await sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError);
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain("Bearer");
    }
  });
});

describe("Phase 5A-1 — cross-origin redirect credential scoping", () => {
  function headersOf(call: unknown[]): Record<string, string> {
    return (call[1] as RequestInit & { headers: Record<string, string> }).headers;
  }

  it("same-origin redirect keeps Authorization on every hop", async () => {
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://api.email.example/v2/send" } }),
      okResponse(200),
    ]);
    const sender = makeSender(fetchFn, publicLookup());

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).resolves.toBeUndefined();

    expect(fetchFn.mock.calls).toHaveLength(2);
    expect(headersOf(fetchFn.mock.calls[0])["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headersOf(fetchFn.mock.calls[1])["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("cross-origin redirect strips Authorization on the second request", async () => {
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://other.example/hook" } }),
      okResponse(200),
    ]);
    const lookup = vi.fn().mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce([PUBLIC_IP]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).resolves.toBeUndefined();

    expect(fetchFn.mock.calls).toHaveLength(2);
    // First hop carries the key; the cross-origin hop must not.
    expect(headersOf(fetchFn.mock.calls[0])["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headersOf(fetchFn.mock.calls[1])["Authorization"]).toBeUndefined();
    // Still a valid JSON POST to the new origin.
    expect(headersOf(fetchFn.mock.calls[1])["Content-Type"]).toBe("application/json");
    const url2 = fetchFn.mock.calls[1][0];
    expect(url2).toBe("https://other.example/hook");
  });

  it("cross-origin redirect still runs the SSRF check (blocked, ONE request)", async () => {
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://evil.example/hook" } }),
      okResponse(),
    ]);
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce(["192.168.1.1"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(1); // never fetched the internal target
  });

  it("cross-origin second hop into an internal IP: blocked, no third request, hop-2 has no key", async () => {
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://b.example/hook" } }),
      new Response("", { status: 302, headers: { location: "https://c.example/hook" } }),
      okResponse(),
    ]);
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce(["10.0.0.1"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });

    expect(fetchFn.mock.calls).toHaveLength(2);
    // The cross-origin hop (api.email.example → b.example) carried NO key.
    expect(headersOf(fetchFn.mock.calls[0])["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headersOf(fetchFn.mock.calls[1])["Authorization"]).toBeUndefined();
  });

  it("API key never enters error/payload/logs on a blocked cross-origin chain", async () => {
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://evil.example/hook" } }),
      okResponse(),
    ]);
    const lookup = vi.fn().mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce(["127.0.0.1"]);
    const sender = makeSender(fetchFn, lookup);

    let caught: unknown;
    try {
      await sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("Bearer");
    // Payloads (bodies) sent so far never contained the key — the header on
    // hop 1 legitimately does, so assert on the body only.
    for (const call of fetchFn.mock.calls) {
      expect(String((call[1] as RequestInit).body)).not.toContain(API_KEY);
    }
  });
});

describe("EmailSender.send — status handling", () => {
  it("resolves on 2xx and rejects on 4xx/5xx", async () => {
    const ok = makeSender(fakeFetch([okResponse(200)]), publicLookup());
    await expect(
      ok.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).resolves.toBeUndefined();

    const notFound = makeSender(fakeFetch([new Response("x", { status: 404 })]), publicLookup());
    await expect(
      notFound.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toBeInstanceOf(EmailError);

    const serverErr = makeSender(fakeFetch([new Response("x", { status: 503 })]), publicLookup());
    await expect(
      serverErr.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toBeInstanceOf(EmailError);
  });

  it("rejects on timeout with code=timeout", async () => {
    const fetchFn = fakeFetch([new DOMException("timeout", "TimeoutError")]);
    const sender = makeSender(fetchFn, publicLookup());
    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects on DNS failure", async () => {
    const fetchFn = fakeFetch([new Error("boom")]);
    const sender = makeSender(fetchFn, publicLookup());
    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws invalid-config when the apiKeyRef is missing from env (0 requests)", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const sender = makeSender(fetchFn, publicLookup(), {}); // no EMAIL_API_KEY

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig(GOOD_URL) }),
    ).rejects.toMatchObject({ code: "invalid-config" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });
});
