/**
 * Phase 10A + 10D — full fake-RDAP link for the production-reported bug:
 *
 *   opusai.eu.cc → not-found → eu.cc → expirationDate
 *   → updateDomainRdap → getDomainById → homepage data has the date
 *
 * Phase 10D ownership fix: the eu.cc object belongs to the PARENT, so its
 * expiration / registrar / nameservers / status must NEVER be persisted on
 * the opusai.eu.cc row. The child's own fields stay null / empty and its
 * `rdapStatus` is marked `["no-object"]`. An EXACT object (chatgpt.com)
 * still saves its own data.
 *
 * Uses a temp-file SQLite DB (migrations applied) and the real
 * `domains/repository` module. `DATABASE_URL` must be set before the
 * repository module is first imported, so it is imported dynamically.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildSuffixMap } from "./bootstrap";
import { queryRdapWithFallback } from "./service";

const BOOTSTRAP_MAP = buildSuffixMap({
  services: [
    ["cc", ["https://rdap.cc/"]],
    ["com", ["https://rdap.verisign.com/com/v1/"]],
  ],
});

let dir: string;
let repository: typeof import("@/lib/domains/repository");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "dm-rdap-link-"));
  process.env.DATABASE_URL = path.join(dir, "test.db");

  // db/index.ts opens the file but never runs migrations — pre-create the
  // schema exactly like production (0000–0006 in order).
  const sqlite = new Database(process.env.DATABASE_URL);
  const migrationsDir = path.join(process.cwd(), "src/db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();

  repository = await import("@/lib/domains/repository");
});

afterAll(async () => {
  // Phase 12A: close the module-level SQLite connection BEFORE removing the
  // temp directory. The dynamic import in beforeAll loads @/lib/domains/
  // repository, which triggers @/db's module-level `new Database()` — a
  // singleton that never closes until the process exits. On Linux, unlink
  // succeeds on open files, but on Windows the file handle keeps the file
  // locked, so rmSync fails with EPERM. Close the connection first, then
  // clean up with retries for any residual native lock.
  const { closeDb } = await import("@/db");
  closeDb();
  delete process.env.DATABASE_URL;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** RDAP response that carries registrar + status + nameservers + expiration. */
function richResponse(ldhName: string, expiration: string): Response {
  return new Response(
    JSON.stringify({
      ldhName,
      events: [
        { eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" },
        { eventAction: "expiration", eventDate: expiration },
        { eventAction: "last changed", eventDate: "2024-01-01T00:00:00Z" },
      ],
      status: ["active"],
      nameservers: [{ ldhName: "a.iana-servers.net" }, { ldhName: "b.iana-servers.net" }],
      entities: [
        {
          roles: ["registrar"],
          vcardArray: ["vcard", [["fn", {}, "text", "Gname.com Pte. Ltd."]]],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/rdap+json" } },
  );
}

function rdapFetch(routes: Record<string, Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    const hostname = decodeURIComponent((url.split("/domain/")[1] ?? "").replace(/\/+$/, ""));
    return routes[hostname] ?? new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Phase 10D — ownership-aware persistence", () => {
  it("PARENT: opusai.eu.cc → fallback eu.cc → parent data is NOT stored on the child", async () => {
    const fetchFn = rdapFetch({
      "opusai.eu.cc": new Response("{}", { status: 404 }),
      "eu.cc": richResponse("eu.cc", "2031-03-26T00:00:00Z"),
    });

    const { data, ownership, matchedHostname } = await queryRdapWithFallback("opusai.eu.cc", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });

    // fallback resolved at the registered domain, reported as parent
    expect(data.domainName).toBe("eu.cc");
    expect(data.expirationDate).toBe("2031-03-26T00:00:00.000Z");
    expect(data.registrar).toBe("Gname.com Pte. Ltd.");
    expect(data.nameservers).toEqual(["a.iana-servers.net", "b.iana-servers.net"]);
    expect(data.status).toEqual(["active"]);
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("eu.cc");
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // persistence keeps the monitored hostname; parent fields must NOT leak
    const created = repository.createDomain("opusai.eu.cc");
    expect(created).toBeDefined();
    repository.updateDomainRdap(created!.id, data, ownership);

    const stored = repository.getDomainById(created!.id);
    expect(stored?.hostname).toBe("opusai.eu.cc");
    // The bug-fixing assertions: parent-derived data never lands on the child.
    expect(stored?.expirationDate).toBeNull();
    expect(stored?.registrar).toBeNull();
    expect(stored?.registrationDate).toBeNull();
    expect(stored?.updatedDate).toBeNull();
    expect(stored?.nameservers).toEqual([]);
    expect(stored?.rdapStatus).toEqual(["no-object"]);
  });

  it("EXACT: chatgpt.com → saves its own expiration / registrar / nameservers", async () => {
    const fetchFn = rdapFetch({
      "chatgpt.com": richResponse("chatgpt.com", "2026-11-30T00:00:00Z"),
    });

    const { data, ownership, matchedHostname } = await queryRdapWithFallback("chatgpt.com", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });

    expect(ownership).toBe("exact");
    expect(matchedHostname).toBe("chatgpt.com");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const created = repository.createDomain("chatgpt.com");
    expect(created).toBeDefined();
    repository.updateDomainRdap(created!.id, data, ownership);

    const stored = repository.getDomainById(created!.id);
    expect(stored?.hostname).toBe("chatgpt.com");
    expect(stored?.expirationDate).toBe("2026-11-30T00:00:00.000Z");
    expect(stored?.registrar).toBe("Gname.com Pte. Ltd.");
    expect(stored?.nameservers).toEqual(["a.iana-servers.net", "b.iana-servers.net"]);
    expect(stored?.rdapStatus).toEqual(["active"]);
  });

  it("NO_OBJECT: all candidates 404 → nothing persisted, expiration remains null", async () => {
    const fetchFn = rdapFetch({
      "opusai.eu.cc": new Response("{}", { status: 404 }),
      "eu.cc": new Response("{}", { status: 404 }),
    });

    await expect(
      queryRdapWithFallback("opusai.eu.cc", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "not-found" });

    // refresh-style failure path: no update call → row keeps nulls
    const created = repository.createDomain("missing.example");
    expect(created).toBeDefined();
    const stored = repository.getDomainById(created!.id);
    expect(stored?.expirationDate).toBeNull();
    expect(stored?.registrar).toBeNull();
    expect(stored?.nameservers).toEqual([]);
  });

  it("PARENT on first candidate via canonical mismatch → still treated as parent", async () => {
    // Registry answers opusai.eu.cc with an object whose LDH name is eu.cc
    // — ownership must be parent, never exact.
    const fetchFn = rdapFetch({
      "opusai.eu.cc": richResponse("eu.cc", "2031-03-26T00:00:00Z"),
    });

    const { data, ownership, matchedHostname } = await queryRdapWithFallback("opusai.eu.cc", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });

    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("eu.cc");
    expect(data.domainName).toBe("eu.cc");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const created = repository.createDomain("mismatch.example");
    expect(created).toBeDefined();
    repository.updateDomainRdap(created!.id, data, ownership);
    const stored = repository.getDomainById(created!.id);
    expect(stored?.expirationDate).toBeNull();
    expect(stored?.rdapStatus).toEqual(["no-object"]);
  });
});
