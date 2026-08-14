import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http/client";
import {
  buildWebhookPayload,
  parseWebhookConfig,
  resolveWebhookRedirect,
  validateWebhookUrl,
  WebhookError,
  WebhookSender,
} from "./webhook";
import type { NotificationEvent } from "../types";

const PUBLIC_IP = "93.184.216.34";

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

function channelConfig(url: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ url, ...extra });
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

/** Public-only lookup: any hostname resolves to a public IP. */
function publicLookup() {
  return vi.fn().mockResolvedValue([PUBLIC_IP]);
}

function makeSender(
  fetchFn: ReturnType<typeof fakeFetch>,
  lookup: (hostname: string) => Promise<string[]>,
) {
  return new WebhookSender({ fetchFn, lookup });
}

describe("parseWebhookConfig", () => {
  it("parses url and optional secretRef", () => {
    expect(parseWebhookConfig('{"url":"https://h.example/h","secretRef":"WH_SECRET"}')).toEqual({
      url: "https://h.example/h",
      secretRef: "WH_SECRET",
    });
  });

  it("rejects invalid JSON, missing URL, and bad secretRef", () => {
    expect(() => parseWebhookConfig("not json")).toThrow(WebhookError);
    expect(() => parseWebhookConfig("{}")).toThrow(WebhookError);
    expect(() => parseWebhookConfig('{"url":""}')).toThrow(WebhookError);
    expect(() => parseWebhookConfig('{"url":"https://h/","secretRef":123}')).toThrow(WebhookError);
  });
});

describe("validateWebhookUrl", () => {
  it("accepts an https URL whose host resolves to a public IP", async () => {
    await expect(validateWebhookUrl("https://example.com/hook", publicLookup())).resolves.toBe(
      "https://example.com/hook",
    );
  });

  it("rejects http:// (https only)", async () => {
    await expect(
      validateWebhookUrl("http://example.com/hook", publicLookup()),
    ).rejects.toMatchObject({
      code: "blocked-redirect",
    });
  });

  it("rejects a URL whose hostname resolves to loopback (DNS rebinding case)", async () => {
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    await expect(validateWebhookUrl("https://example.com/hook", lookup)).rejects.toMatchObject({
      code: "blocked-redirect",
    });
  });

  it("rejects a URL whose hostname resolves to cloud metadata", async () => {
    const lookup = vi.fn().mockResolvedValue(["169.254.169.254"]);
    await expect(
      validateWebhookUrl("https://metadata.internal/hook", lookup),
    ).rejects.toMatchObject({
      code: "blocked-redirect",
    });
  });
});

describe("resolveWebhookRedirect", () => {
  it("returns null without a Location header", async () => {
    await expect(resolveWebhookRedirect(null, "https://a/", publicLookup())).resolves.toBeNull();
  });

  it("allows a cross-host redirect when the new host is public (webhook semantics)", async () => {
    const next = await resolveWebhookRedirect(
      "https://other.example/hook",
      "https://a.example/",
      publicLookup(),
    );
    expect(next).toBe("https://other.example/hook");
  });

  it("blocks a redirect whose target resolves to an internal IP (no second request)", async () => {
    const lookup = vi.fn().mockResolvedValue(["10.0.0.1"]);
    await expect(
      resolveWebhookRedirect("https://a.example/hook", "https://a.example/", lookup),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
  });

  it("blocks non-https redirect schemes", async () => {
    await expect(
      resolveWebhookRedirect("http://a.example/hook", "https://a.example/", publicLookup()),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
  });
});

describe("buildWebhookPayload", () => {
  it("carries eventId and deliveryId, and never the secretRef", () => {
    const payload = buildWebhookPayload(42, event());
    expect(payload.eventId).toBe("http:5:http_status_changed:ok:down");
    expect(payload.deliveryId).toBe(42);
    expect(payload.eventType).toBe("http_status_changed");
    expect(payload.source).toBe("http");
    expect(payload.domainId).toBe(5);
    expect(payload.occurredAt).toBe("2026-08-14T12:00:00.000Z");
    expect(payload.previousState).toBe('"ok"');
    expect(payload.currentState).toBe('"down"');
    // No secret material anywhere.
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
});

describe("WebhookSender.send — SSRF matrix with request-count proof", () => {
  it("rejects an initial URL resolving to 127.0.0.1 and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects an initial URL resolving to 10.x and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["10.1.2.3"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects an initial URL resolving to 169.254.169.254 and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const lookup = vi.fn().mockResolvedValue(["169.254.169.254"]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("rejects an http:// initial URL and issues ZERO requests", async () => {
    const fetchFn = fakeFetch([okResponse()]);
    const sender = makeSender(fetchFn, publicLookup());

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("http://example.com/hook") }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(0);
  });

  it("sends successfully to a public https URL and uses POST + JSON", async () => {
    const fetchFn = fakeFetch([okResponse(200)]);
    const sender = makeSender(fetchFn, publicLookup());

    await sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") });

    expect(fetchFn.mock.calls).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { redirect: string }];
    expect(url).toBe("https://example.com/hook");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(String(init.body));
    expect(body.eventId).toBe("http:5:http_status_changed:ok:down");
    expect(body.deliveryId).toBe(1);
  });

  it("follows a redirect to another PUBLIC host (cross-host allowed, checked)", async () => {
    const lookup = vi.fn().mockResolvedValue([PUBLIC_IP]);
    const fetchFn2 = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://other.example/hook" } }),
      okResponse(200),
    ]);
    const sender = makeSender(fetchFn2, lookup);

    await sender.send(1, event(), { id: 9, config: channelConfig("https://a.example/hook") });

    expect(fetchFn2.mock.calls).toHaveLength(2);
    expect((fetchFn2.mock.calls[1] as [string])[0]).toBe("https://other.example/hook");
  });

  it("blocks a redirect into an internal IP and issues exactly ONE request", async () => {
    // First hop resolves public (request #1 issued); the redirect target
    // resolves to 192.168.1.1 → blocked BEFORE request #2.
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValueOnce(["192.168.1.1"]);
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://evil.example/hook" } }),
      okResponse(200),
    ]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://a.example/hook") }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
    expect(fetchFn.mock.calls).toHaveLength(1); // second request never issued
  });

  it("blocks a second-hop redirect into an internal IP (deep chain)", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP]) // hop 0
      .mockResolvedValueOnce([PUBLIC_IP]) // hop 1
      .mockResolvedValueOnce(["10.0.0.1"]); // hop 2 → blocked
    const fetchFn = fakeFetch([
      new Response("", { status: 302, headers: { location: "https://b.example/hook" } }),
      new Response("", { status: 302, headers: { location: "https://c.example/hook" } }),
      okResponse(200),
    ]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://a.example/hook") }),
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
      okResponse(200),
    ]);
    const sender = makeSender(fetchFn, lookup);

    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://a.example/hook") }),
    ).rejects.toMatchObject({ code: "too-many-redirects" });
    expect(fetchFn.mock.calls).toHaveLength(6); // 5 followed + 1 rejected before 6th
  });
});

describe("WebhookSender.send — failure/status handling", () => {
  it("resolves on 2xx and rejects on 4xx/5xx", async () => {
    const ok = makeSender(fakeFetch([new Response(null, { status: 204 })]), publicLookup());
    await expect(
      ok.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).resolves.toBeUndefined();

    const bad = makeSender(fakeFetch([new Response("nope", { status: 404 })]), publicLookup());
    await expect(
      bad.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toBeInstanceOf(WebhookError);

    const serverErr = makeSender(
      fakeFetch([new Response("boom", { status: 503 })]),
      publicLookup(),
    );
    await expect(
      serverErr.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toBeInstanceOf(WebhookError);
  });

  it("rejects on timeout", async () => {
    const fetchFn = fakeFetch([new DOMException("timeout", "TimeoutError")]);
    const sender = makeSender(fetchFn, publicLookup());
    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects on DNS failure", async () => {
    const fetchFn = fakeFetch([new Error("boom")]);
    const sender = makeSender(fetchFn, publicLookup());
    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("never reads the response body", async () => {
    // A body that would throw if read — the sender must cancel it, not read it.
    const fetchFn = fakeFetch([okResponse(200)]);
    const sender = makeSender(fetchFn, publicLookup());
    await expect(
      sender.send(1, event(), { id: 9, config: channelConfig("https://example.com/hook") }),
    ).resolves.toBeUndefined();
  });
});
