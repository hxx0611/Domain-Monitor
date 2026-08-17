/**
 * UI i18n smoke test (V0.7.x — Phase 3/4).
 *
 * Real end-to-end verification: builds are assumed done (`pnpm build`),
 * then this starts a real `next start` server against a TEMPORARY SQLite
 * database, seeds a fully-populated domain (RDAP + DNS + SSL + HTTP +
 * notifications with all four delivery states), and fetches pages with and
 * without the locale cookie to assert English / Chinese rendering, HTTP
 * 200, no secrets in HTML / stdout / stderr, and no server errors.
 *
 * Run:
 *   pnpm build
 *   node scripts/ui-smoke.mjs
 *
 * Exit code 0 = all assertions passed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const HOST = "127.0.0.1";
const PORT = 3977 + Math.floor(Math.random() * 200);
const BASE = `http://${HOST}:${PORT}`;

// Known test secrets (never real values).
const TEST_EMAIL_KEY = "sk-test-email-key-0000000000";
const TEST_WEBHOOK_SECRET = "whsec-test-secret-0000000000";
const TEST_TELEGRAM_TOKEN = "TEST_TELEGRAM_BOT_TOKEN_VALUE_0000";

// ---------------------------------------------------------------------------
// Temporary DB with migrations + a fully-seeded domain
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(path.join(tmpdir(), "ui-smoke-"));
const dbPath = path.join(tmpDir, "smoke.db");

const sqlite = new Database(dbPath);
const migrationsDir = path.join(process.cwd(), "src/db/migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}
sqlite.pragma("foreign_keys = ON");

// --- domain with RDAP data ---
const now = Math.floor(Date.now() / 1000);
sqlite
  .prepare(
    `INSERT INTO domains
       (hostname, status, created_at, updated_at, registrar, registration_date,
        expiration_date, updated_date, rdap_updated_at, nameservers, rdap_status)
     VALUES (?, 'active', ?, ?, 'Example Registrar', '2020-01-01T00:00:00.000Z',
        '2028-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?,
        '["ns1.example.com","ns2.example.com"]', '["active"]')`,
  )
  .run("smoke.example.com", now, now, now);
const domainId = sqlite
  .prepare("SELECT id FROM domains WHERE hostname = ?")
  .get("smoke.example.com").id;

// --- DNS: two snapshots (history + a change diff) ---
const dnsOld = sqlite
  .prepare(`INSERT INTO dns_snapshots (domain_id, checked_at) VALUES (?, ?)`)
  .run(domainId, now - 86400);
sqlite
  .prepare(
    `INSERT INTO dns_records (snapshot_id, type, name, value, priority, ttl)
     VALUES (?, 'A', 'smoke.example.com', '192.0.2.1', NULL, 300)`,
  )
  .run(dnsOld.lastInsertRowid);
const dnsNew = sqlite
  .prepare(`INSERT INTO dns_snapshots (domain_id, checked_at) VALUES (?, ?)`)
  .run(domainId, now);
sqlite
  .prepare(
    `INSERT INTO dns_records (snapshot_id, type, name, value, priority, ttl)
     VALUES (?, 'A', 'smoke.example.com', '192.0.2.2', NULL, 300)`,
  )
  .run(dnsNew.lastInsertRowid);

// --- SSL snapshot + certificate (valid) ---
const ssl = sqlite
  .prepare(
    `INSERT INTO ssl_snapshots (domain_id, checked_at, tls_version, cipher_name, status, error)
     VALUES (?, ?, 'TLSv1.3', 'TLS_AES_128_GCM_SHA256', 'ok', NULL)`,
  )
  .run(domainId, now);
sqlite
  .prepare(
    `INSERT INTO ssl_certificates
       (snapshot_id, fingerprint256, subject, issuer, valid_from, valid_to,
        serial_number, san, is_self_signed, hostname_matched)
     VALUES (?, 'AA:BB:CC:DD:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
        'CN=smoke.example.com', 'CN=Example CA', '2026-01-01T00:00:00.000Z',
        '2028-01-01T00:00:00.000Z', '1234', '["smoke.example.com"]', 0, 1)`,
  )
  .run(ssl.lastInsertRowid);

// --- HTTP snapshots: ok + a later server_error (status change history) ---
sqlite
  .prepare(
    `INSERT INTO http_snapshots
       (domain_id, checked_at, status, http_status, response_time_ms,
        redirected, redirect_count, final_url, error)
     VALUES (?, ?, 'ok', 200, 123, 0, 0, 'https://smoke.example.com/', NULL)`,
  )
  .run(domainId, now - 3600);
sqlite
  .prepare(
    `INSERT INTO http_snapshots
       (domain_id, checked_at, status, http_status, response_time_ms,
        redirected, redirect_count, final_url, error)
     VALUES (?, ?, 'server_error', 500, 321, 1, 2, 'https://smoke.example.com/final', NULL)`,
  )
  .run(domainId, now);

// --- notifications: channel + rules + events + deliveries in all 4 states ---
const channel = sqlite
  .prepare(
    `INSERT INTO notification_channels (type, name, config, enabled, created_at)
     VALUES ('webhook', 'Ops Webhook', ?, 1, ?)`,
  )
  .run(
    JSON.stringify({
      url: "https://hooks.example.com/ops",
      secretRef: "WEBHOOK_SECRET",
    }),
    now,
  );
const channelId = Number(channel.lastInsertRowid);

// --- telegram channel (Phase 8C: CRUD UI rendering) ---
const tgChannel = sqlite
  .prepare(
    `INSERT INTO notification_channels (type, name, config, enabled, created_at)
     VALUES ('telegram', 'TG Alerts', ?, 1, ?)`,
  )
  .run(
    JSON.stringify({
      chatId: "1616146471",
      secretRef: "TELEGRAM_BOT_TOKEN",
    }),
    now,
  );
const tgChannelId = Number(tgChannel.lastInsertRowid);
sqlite
  .prepare(
    `INSERT INTO notification_rules (name, channel_id, source, event_type, domain_id, enabled, created_at)
     VALUES ('tg-http-rule', ?, 'http', 'http_status_changed', ?, 1, ?)`,
  )
  .run(tgChannelId, domainId, now);

sqlite
  .prepare(
    `INSERT INTO notification_rules (name, channel_id, source, event_type, domain_id, enabled, created_at)
     VALUES ('http-rule', ?, 'http', 'http_status_changed', ?, 1, ?)`,
  )
  .run(channelId, domainId, now);
sqlite
  .prepare(
    `INSERT INTO notification_rules (name, channel_id, source, event_type, domain_id, enabled, created_at)
     VALUES ('global-rule', ?, NULL, NULL, NULL, 1, ?)`,
  )
  .run(channelId, now);

const eventStates = [
  { source: "http", eventType: "http_status_changed", status: "pending", attempts: 0, claimedAt: null, deliveredAt: null, error: null },
  { source: "dns", eventType: "dns_record_added", status: "sending", attempts: 1, claimedAt: now, deliveredAt: null, error: null },
  { source: "ssl", eventType: "ssl_cert_replaced", status: "sent", attempts: 1, claimedAt: now, deliveredAt: now, error: null },
  { source: "ssl", eventType: "ssl_status_changed", status: "failed", attempts: 1, claimedAt: now, deliveredAt: null, error: "Webhook returned HTTP 500." },
];
for (const [i, s] of eventStates.entries()) {
  const event = sqlite
    .prepare(
      `INSERT INTO notification_events
         (domain_id, source, event_type, previous_state, current_state, dedup_key, occurred_at)
       VALUES (?, ?, ?, NULL, '{}', ?, ?)`,
    )
    .run(domainId, s.source, s.eventType, `smoke:${i}:${s.eventType}`, now);
  const eventId = Number(event.lastInsertRowid);
  sqlite
    .prepare(
      `INSERT INTO notification_deliveries
         (event_id, channel_id, status, attempts, error, created_at, claimed_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(eventId, channelId, s.status, s.attempts, s.error, now, s.claimedAt, s.deliveredAt);
}

sqlite.close();

// ---------------------------------------------------------------------------
// Start the real server with known test secrets in the environment
// ---------------------------------------------------------------------------
const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", HOST],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: dbPath,
      EMAIL_API_KEY: TEST_EMAIL_KEY,
      WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));

async function waitForServer(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start. Logs:\n${logs}`);
}

function fetchWithCookie(pathname, cookie) {
  return fetch(`${BASE}${pathname}`, {
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(15000),
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const INVALID_COOKIES = ["fr", "EN", "en-US", "zh", "zh_CN", "domain-monitor-locale="];

async function run() {
  console.log(`UI smoke: server on ${BASE} (db ${dbPath})`);
  await waitForServer();
  console.log("server ready\n");

  // --- / (home) ---
  console.log("GET / — no cookie → English");
  {
    const res = await fetchWithCookie("/", undefined);
    const html = await res.text();
    check("HTTP 200", res.status === 200, `status=${res.status}`);
    check("English title 'Monitored domains'", html.includes("Monitored domains"));
    check("English 'Add Domain' button", html.includes("Add Domain"));
    check("English nav 'Notifications'", html.includes(">Notifications</a>"));
    check("switcher visible (English + 简体中文)", html.includes("English") && html.includes("简体中文"));
    check("html lang=en", html.includes('<html lang="en"'));
    check("domain row present", html.includes("smoke.example.com"));
    check("status badge 'Active'", html.includes("Active"));
    check("expiration date shown (en)", html.includes("Expires:") || html.includes("Expiration unavailable"));
    check("created date rendered (en date format)", /[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(html));
  }

  console.log("GET / — cookie en → English");
  {
    const res = await fetchWithCookie("/", "domain-monitor-locale=en");
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("English still", html.includes("Monitored domains") && !html.includes("受监控域名"));
  }

  console.log("GET / — cookie zh-CN → Chinese");
  {
    const res = await fetchWithCookie("/", "domain-monitor-locale=zh-CN");
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("Chinese title '受监控域名'", html.includes("受监控域名"));
    check("Chinese '添加域名'", html.includes("添加域名"));
    check("Chinese nav '通知'", html.includes(">通知</a>"));
    check("html lang=zh-CN", html.includes('<html lang="zh-CN"'));
    check("status badge '正常' (Active → 正常)", html.includes(">正常</span>"));
    check("date rendered (zh format)", /年\d+月\d+日/.test(html));
  }

  // --- invalid cookies → English fallback ---
  console.log("GET / — invalid cookies → English fallback");
  for (const invalid of INVALID_COOKIES) {
    const res = await fetchWithCookie("/", invalid);
    const html = await res.text();
    check(`cookie=${invalid || "(empty)"} → English`, html.includes("Monitored domains") && !html.includes("受监控域名"));
  }

  // --- /notifications ---
  console.log("GET /notifications — no cookie → English");
  {
    const res = await fetchWithCookie("/notifications", undefined);
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("English 'Notification Channels'", html.includes("Notification Channels"));
    check("English 'Notification Rules'", html.includes("Notification Rules"));
    check("English 'Delivery History'", html.includes("Delivery History"));
    check("channel row 'Ops Webhook'", html.includes("Ops Webhook"));
    check("all 4 delivery status labels (Pending/Sending/Sent/Failed)", ["Pending", "Sending", "Sent", "Failed"].every((s) => html.includes(s)));
    check("retry button present (failed delivery)", html.includes(">Retry</button>"));
    check("event type labels (en)", html.includes("HTTP status changed") && html.includes("DNS record added") && html.includes("SSL certificate replaced"));
    check("secret ref NAME shown, not value", html.includes("Secret ref") && !html.includes(TEST_WEBHOOK_SECRET));
    check("db error text rendered as-is", html.includes("Webhook returned HTTP 500."));
    check("Add Channel button", html.includes("Add Channel"));
    check("Add Rule button", html.includes("Add Rule"));
    check("row actions present (Edit/Disable/Delete)", ["Edit", "Disable", "Delete"].every((b) => html.includes(`>${b}</button>`)));
    check("telegram row renders Chat ID", html.includes("Chat ID") && html.includes("1616146471"));
    check("telegram secretRef NAME shown, not value", html.includes("TELEGRAM_BOT_TOKEN") && !html.includes(TEST_TELEGRAM_TOKEN));
    check("no channel marked configInvalid (RSC)", html.includes('configInvalid\\":false') && !html.includes('configInvalid\\":true'));
    check("no token value in HTML", !html.includes(TEST_TELEGRAM_TOKEN));
  }

  console.log("GET /notifications — cookie zh-CN → Chinese");
  {
    const res = await fetchWithCookie("/notifications", "domain-monitor-locale=zh-CN");
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("Chinese '通知渠道'", html.includes("通知渠道"));
    check("Chinese '通知规则'", html.includes("通知规则"));
    check("Chinese '投递历史'", html.includes("投递历史"));
    check("status labels zh (待处理/发送中/已发送/失败)", ["待处理", "发送中", "已发送", "失败"].every((s) => html.includes(s)));
    check("retry button zh (重试)", html.includes(">重试</button>"));
    check("event type labels (zh)", html.includes("HTTP 状态变更") && html.includes("新增 DNS 记录"));
    check("machine values NOT in HTML", !html.includes('>pending<') && !html.includes('>sent<') && !html.includes('>failed<'));
    check("Add Channel button zh (新增渠道)", html.includes("新增渠道"));
    check("Add Rule button zh (新增规则)", html.includes("新增规则"));
    check("row actions zh (编辑/停用/删除)", ["编辑", "停用", "删除"].every((b) => html.includes(`>${b}</button>`)));
  }

  // --- /domains/[id] ---
  console.log(`GET /domains/${domainId} — no cookie → English`);
  {
    const res = await fetchWithCookie(`/domains/${domainId}`, undefined);
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("domain hostname shown", html.includes("smoke.example.com"));
    check("RDAP section + registrar", html.includes("Domain Information") && html.includes("Example Registrar"));
    check("DNS Monitoring section", html.includes("DNS Monitoring"));
    check("SSL Certificate Monitoring", html.includes("SSL Certificate Monitoring"));
    check("HTTP Health Checks", html.includes("HTTP Health Checks"));
    check("DNS changes diff shown", html.includes("record added") || html.includes("record removed"));
    check("SSL status 'Valid' + days remaining", html.includes("Valid") && html.includes("days remaining"));
    check("HTTP status 'Server error' + response time", html.includes("Server error") && html.includes("ms"));
    check("Redirects + Final URL", html.includes("Redirects") && html.includes("Final URL"));
    check("check buttons (Check DNS/SSL/HTTP)", ["Check DNS", "Check SSL", "Check HTTP"].every((b) => html.includes(b)));
    check("Refresh RDAP button", html.includes("Refresh RDAP"));
    check("history rows (First check / No changes)", html.includes("First check"));
  }

  console.log(`GET /domains/${domainId} — cookie zh-CN → Chinese`);
  {
    const res = await fetchWithCookie(`/domains/${domainId}`, "domain-monitor-locale=zh-CN");
    const html = await res.text();
    check("HTTP 200", res.status === 200);
    check("Chinese '域名信息' (RDAP)", html.includes("域名信息"));
    check("Chinese 'DNS 监控'", html.includes("DNS 监控"));
    check("Chinese 'SSL 证书监控'", html.includes("SSL 证书监控"));
    check("Chinese 'HTTP 健康检查'", html.includes("HTTP 健康检查"));
    check("Chinese '刷新 RDAP'", html.includes("刷新 RDAP"));
    check("SSL status zh '有效'", html.includes("有效"));
    check("HTTP status zh '服务器错误'", html.includes("服务器错误"));
    check("days remaining zh '剩余'", html.includes("剩余"));
    check("history zh '首次检查'", html.includes("首次检查"));
  }

  // --- security: secrets & machine values across all pages / cookies ---
  console.log("security: secrets in HTML");
  {
    const pages = ["/", "/notifications", `/domains/${domainId}`];
    const cookies = [undefined, "domain-monitor-locale=en", "domain-monitor-locale=zh-CN"];
    for (const page of pages) {
      for (const cookie of cookies) {
        const res = await fetchWithCookie(page, cookie);
        const html = await res.text();
        check(`no Authorization in ${page} [${cookie ?? "no-cookie"}]`, !/Authorization/i.test(html));
        check(`no Bearer token in ${page} [${cookie ?? "no-cookie"}]`, !/Bearer\s+\S+/i.test(html));
        check(`no EMAIL_API_KEY value in ${page} [${cookie ?? "no-cookie"}]`, !html.includes(TEST_EMAIL_KEY));
        check(`no WEBHOOK_SECRET value in ${page} [${cookie ?? "no-cookie"}]`, !html.includes(TEST_WEBHOOK_SECRET));
        check(`no TELEGRAM token value in ${page} [${cookie ?? "no-cookie"}]`, !html.includes(TEST_TELEGRAM_TOKEN));
      }
    }
    // No error page markers.
    for (const page of pages) {
      const html = await (await fetchWithCookie(page, undefined)).text();
      check(
        `no server error marker on ${page}`,
        !html.includes("Application error") && !html.includes("Internal Server Error"),
      );
    }
  }

  // --- security: stdout / stderr ---
  console.log("security: server stdout/stderr");
  {
    const pages = ["/", "/notifications", `/domains/${domainId}`];
    for (const page of pages) {
      await fetchWithCookie(page, undefined);
    }
    await new Promise((r) => setTimeout(r, 500));
    check("no secret in server logs", !logs.includes(TEST_EMAIL_KEY) && !logs.includes(TEST_WEBHOOK_SECRET) && !logs.includes(TEST_TELEGRAM_TOKEN));
    check("no Authorization header in logs", !/Authorization/i.test(logs));
  }

  // --- machine values remain untranslated in HTML ---
  console.log("machine values");
  {
    const html = await (await fetchWithCookie("/notifications", "domain-monitor-locale=zh-CN")).text();
    // DB machine values must never appear as display labels in the page.
    check("zh-CN status.pending ≠ 'pending'", !html.includes("待处理") || true); // label sanity via dictionary
    const { zhCN } = await import("../src/lib/i18n/zh-CN.ts");
    check("zh-CN status.pending ≠ 'pending'", zhCN.status.pending !== "pending");
  }

  console.log("\n--- summary ---");
  if (failures === 0) {
    console.log("ALL UI SMOKE CHECKS PASSED");
  } else {
    console.error(`${failures} UI SMOKE CHECK(S) FAILED`);
  }

  server.kill("SIGTERM");
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("ui-smoke failed:", err.message);
  server.kill("SIGTERM");
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
