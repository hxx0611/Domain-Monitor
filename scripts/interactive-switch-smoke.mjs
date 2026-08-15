/**
 * Interactive language switch smoke (V0.7.x — Phase 4).
 *
 * Simulates the REAL click flow at the protocol level:
 *   click → setLocaleAction (Server Action POST, same wire protocol the
 *           browser uses) → router.refresh() (new GET with the cookie) →
 *           page re-renders in the new locale.
 *
 * Browser automation is unavailable in this container (no local Chromium),
 * so the click is emulated with the exact Server Action request Next.js
 * generates — the cookie write + re-render are real. We also verify the
 * URL never changes and html lang follows the cookie.
 *
 * Run (after pnpm build):
 *   node scripts/interactive-switch-smoke.mjs
 *
 * Exit 0 = all checks passed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const HOST = "127.0.0.1";
const PORT = 4177 + Math.floor(Math.random() * 200);
const BASE = `http://${HOST}:${PORT}`;

/**
 * Resolve the wire ID of the setLocaleAction server action from the build
 * output. The ID is regenerated on every `next build`, so it must be
 * discovered at runtime instead of hard-coded.
 */
function resolveActionId() {
  const chunksDir = path.join(process.cwd(), ".next/server/chunks");
  const files = readdirSync(chunksDir).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const source = readFileSync(path.join(chunksDir, file), "utf8");
    // …createServerReference)("<id>", callServer, …, "setLocaleAction")
    const idx = source.indexOf('"setLocaleAction"');
    if (idx === -1) continue;
    const before = source.slice(Math.max(0, idx - 400), idx);
    const match = before.match(/createServerReference\)\(?"([a-f0-9]{40,})"/);
    if (match) return match[1];
  }
  throw new Error(
    "setLocaleAction action id not found in .next build — run pnpm build first",
  );
}

const ACTION_ID = resolveActionId();

// ---------------------------------------------------------------------------
// Temp DB (minimal seed: one domain)
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(path.join(tmpdir(), "switch-smoke-"));
const dbPath = path.join(tmpDir, "switch.db");
const sqlite = new Database(dbPath);
const migrationsDir = path.join(process.cwd(), "src/db/migrations");
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}
const now = Math.floor(Date.now() / 1000);
sqlite
  .prepare(`INSERT INTO domains (hostname, status, created_at, updated_at) VALUES (?, 'active', ?, ?)`)
  .run("switch.example.com", now, now);
sqlite.close();

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", HOST],
  { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbPath }, stdio: ["ignore", "pipe", "pipe"] },
);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitForServer(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

/** Invoke the locale server action exactly like the browser does. */
async function invokeSetLocale(locale, cookieHeader) {
  const res = await fetch(`${BASE}/`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "next-action": ACTION_ID,
      "content-type": "text/plain;charset=UTF-8",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify([locale]),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  // Server Actions reply with a set-cookie header and a flight payload.
  return res;
}

async function run() {
  console.log(`switch smoke on ${BASE}`);
  await waitForServer();
  console.log("server ready\n");

  console.log("1. default open (no cookie) → English");
  {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("English UI", html.includes("Monitored domains"));
    check("html lang=en", html.includes('<html lang="en"'));
    check("URL has no /en or /zh-CN prefix", res.url === `${BASE}/`);
  }

  console.log("2. click 简体中文 (server action POST, no cookie)");
  let setCookie;
  {
    const res = await invokeSetLocale("zh-CN", undefined);
    setCookie = res.headers.get("set-cookie") ?? "";
    check("server action responded", res.status === 200);
    check(
      "cookie written: domain-monitor-locale=zh-CN",
      setCookie.includes("domain-monitor-locale=zh-CN"),
      setCookie,
    );
    check("cookie path=/", setCookie.includes("Path=/"));
    check("cookie SameSite=lax", /SameSite=lax/i.test(setCookie));
    check("no HttpOnly (UI preference cookie)", !/httponly/i.test(setCookie));
  }

  console.log("3. router.refresh() → re-fetch with cookie → Chinese");
  {
    const cookieValue = setCookie.split(";")[0];
    const res = await fetch(`${BASE}/`, {
      headers: { cookie: cookieValue },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("Chinese UI now", html.includes("受监控域名"));
    check("English gone", !html.includes("Monitored domains"));
    check("html lang=zh-CN", html.includes('<html lang="zh-CN"'));
    check("URL unchanged", res.url === `${BASE}/`);
  }

  console.log("4. click English (server action POST with zh-CN cookie)");
  let enCookie;
  {
    const res = await invokeSetLocale("en", "domain-monitor-locale=zh-CN");
    enCookie = res.headers.get("set-cookie") ?? "";
    check("server action responded", res.status === 200);
    check("cookie switched to en", enCookie.includes("domain-monitor-locale=en"), enCookie);
  }

  console.log("5. refresh → English restored");
  {
    const cookieValue = enCookie.split(";")[0];
    const res = await fetch(`${BASE}/`, {
      headers: { cookie: cookieValue },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("English restored", html.includes("Monitored domains"));
    check("Chinese gone", !html.includes("受监控域名"));
    check("html lang=en", html.includes('<html lang="en"'));
  }

  console.log("6. invalid locale through the action is rejected");
  {
    const res = await invokeSetLocale("fr", undefined);
    const setCookie = res.headers.get("set-cookie") ?? "";
    check("no cookie written for 'fr'", !setCookie.includes("domain-monitor-locale=fr"));
    // Still renders English with no cookie.
    const page = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(10000) });
    const html = await page.text();
    check("page stays English", html.includes("Monitored domains"));
  }

  console.log("\n--- summary ---");
  if (failures === 0) console.log("ALL INTERACTIVE SWITCH CHECKS PASSED");
  else console.error(`${failures} INTERACTIVE SWITCH CHECK(S) FAILED`);

  server.kill("SIGTERM");
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("switch smoke failed:", err.message);
  server.kill("SIGTERM");
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
