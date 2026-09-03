/**
 * Interactive notification CRUD smoke (Phase 8C).
 *
 * Real end-to-end verification at the protocol level: starts a real
 * `next start` server against a TEMPORARY SQLite database (migrations +
 * seeded domains/channel/rule/event), then drives the CRUD server actions
 * over the exact wire protocol the browser uses (POST + next-action
 * header + text/plain JSON body). Every step is verified against the
 * temp DB afterwards. NO real Telegram / webhook / email is ever sent —
 * these actions only create/update/delete configuration rows.
 *
 * Run (after pnpm build):
 *   node scripts/interactive-crud-smoke.mjs
 *
 * Exit 0 = all checks passed. Temp DB + server are cleaned up.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const HOST = "127.0.0.1";
const PORT = 4277 + Math.floor(Math.random() * 200);
const BASE = `http://${HOST}:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

function* serverJsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* serverJsFiles(full);
    } else if (entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

function resolveActionId(actionName) {
  const serverDir = path.join(process.cwd(), ".next/server");
  for (const file of serverJsFiles(serverDir)) {
    const source = readFileSync(file, "utf8");
    const idx = source.indexOf(`"${actionName}"`);
    if (idx === -1) continue;
    // Multiple actions are registered on one line; take the LAST id
    // before the action name (the nearest one belongs to this action).
    const before = source.slice(Math.max(0, idx - 300), idx);
    const matches = [...before.matchAll(/(?:createServerReference\)\(\?"([a-f0-9]{40,})"|"([a-f0-9]{40,})",[a-zA-Z_$][\w$.]*callServer)/g)];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      return last[1] ?? last[2];
    }
  }
  throw new Error(`action id not found for ${actionName} — run pnpm build first`);
}

const ACTION_IDS = {
  createChannelAction: resolveActionId("createChannelAction"),
  updateChannelAction: resolveActionId("updateChannelAction"),
  setChannelEnabledAction: resolveActionId("setChannelEnabledAction"),
  deleteChannelAction: resolveActionId("deleteChannelAction"),
  createRuleAction: resolveActionId("createRuleAction"),
  updateRuleAction: resolveActionId("updateRuleAction"),
  setRuleEnabledAction: resolveActionId("setRuleEnabledAction"),
  deleteRuleAction: resolveActionId("deleteRuleAction"),
};

// ---------------------------------------------------------------------------
// Temp DB: migrations + seed
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(path.join(tmpdir(), "crud-smoke-"));
const dbPath = path.join(tmpDir, "crud.db");
const sqlite = new Database(dbPath);
const migrationsDir = path.join(process.cwd(), "src/db/migrations");
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}
sqlite.pragma("foreign_keys = ON");
const now = Math.floor(Date.now() / 1000);

const d1 = sqlite
  .prepare(`INSERT INTO domains (hostname, status, created_at, updated_at) VALUES ('a.example.com', 'active', ?, ?)`)
  .run(now, now);
const domainA = Number(d1.lastInsertRowid);
const d2 = sqlite
  .prepare(`INSERT INTO domains (hostname, status, created_at, updated_at) VALUES ('b.example.com', 'active', ?, ?)`)
  .run(now, now);
const domainB = Number(d2.lastInsertRowid);
const ch = sqlite
  .prepare(
    `INSERT INTO notification_channels (type, name, config, enabled, created_at)
     VALUES ('telegram', 'Seed TG', ?, 1, ?)`,
  )
  .run(JSON.stringify({ chatId: "100000001", secretRef: "TELEGRAM_BOT_TOKEN" }), now);
const channelId = Number(ch.lastInsertRowid);
const rule = sqlite
  .prepare(
    `INSERT INTO notification_rules (name, channel_id, source, event_type, domain_id, enabled, created_at)
     VALUES ('seed-rule', ?, 'http', 'http_status_changed', ?, 1, ?)`,
  )
  .run(channelId, domainA, now);
const ruleId = Number(rule.lastInsertRowid);
// One event + delivery for the delete-cascade verification.
const ev = sqlite
  .prepare(
    `INSERT INTO notification_events (domain_id, source, event_type, previous_state, current_state, dedup_key, occurred_at)
     VALUES (?, 'http', 'http_status_changed', '{"status":"ok"}', '{"status":"down"}', 'http:1:test', ?)`,
  )
  .run(domainA, now);
const eventId = Number(ev.lastInsertRowid);
sqlite
  .prepare(
    `INSERT INTO notification_deliveries (event_id, channel_id, status, attempts, created_at)
     VALUES (?, ?, 'sent', 1, ?)`,
  )
  .run(eventId, channelId, now);
sqlite.close();

// ---------------------------------------------------------------------------
// Start the server against the temp DB
// ---------------------------------------------------------------------------
const server = spawn(
  process.execPath,
  [
    path.join(process.cwd(), "node_modules/next/dist/bin/next"),
    "start",
    "-H",
    HOST,
    "-p",
    String(PORT),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: dbPath,
      NEXT_PUBLIC_APP_URL: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/notifications`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become ready");
}

async function postAction(actionName, args) {
  const res = await fetch(`${BASE}/notifications`, {
    method: "POST",
    headers: {
      "next-action": ACTION_IDS[actionName],
      "content-type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify([args]),
  });
  if (res.status !== 200) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  const text = await res.text();
  // Server action result is embedded in the RSC flight stream as a line
  // starting with `1:` followed by the JSON result.
  const match = text.match(/^1:(\{.*\})$/m);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      /* fall through */
    }
  }
  return { ok: false, error: `unparseable action response (${text.slice(0, 80)})` };
}

function readDb() {
  const db = new Database(dbPath, { readonly: true });
  const q = (sql) => db.prepare(sql).get();
  const all = (sql) => db.prepare(sql).all();
  const out = {
    channels: all("SELECT * FROM notification_channels ORDER BY id"),
    rules: all("SELECT * FROM notification_rules ORDER BY id"),
    events: q("SELECT COUNT(*) c FROM notification_events").c,
    deliveries: q("SELECT COUNT(*) c FROM notification_deliveries").c,
  };
  db.close();
  return out;
}

// ---------------------------------------------------------------------------
// Run the flows
// ---------------------------------------------------------------------------
try {
  await waitReady();
  console.log("server ready on", BASE);

  // --- Add Telegram channel ---
  console.log("== Add Telegram channel ==");
  const created = await postAction("createChannelAction", {
    type: "telegram",
    name: "New TG",
    config: JSON.stringify({ chatId: "100000001", secretRef: "TELEGRAM_BOT_TOKEN" }),
  });
  check("create ok", created.ok === true);
  let dbState = readDb();
  const newChannel = dbState.channels.find((c) => c.name === "New TG");
  check("channel inserted", !!newChannel && newChannel.type === "telegram" && newChannel.enabled === 1);
  check("config has chatId+secretRef only", JSON.parse(newChannel.config).chatId === "100000001" && JSON.parse(newChannel.config).secretRef === "TELEGRAM_BOT_TOKEN");
  const newChannelId = newChannel.id;

  // --- Edit Telegram channel ---
  console.log("== Edit Telegram channel ==");
  const edited = await postAction("updateChannelAction", {
    id: newChannelId,
    name: "Renamed TG",
    config: JSON.stringify({ chatId: "9988776655", secretRef: "TELEGRAM_BOT_TOKEN" }),
  });
  check("edit ok", edited.ok === true);
  dbState = readDb();
  const editedChannel = dbState.channels.find((c) => c.id === newChannelId);
  check("name updated", editedChannel.name === "Renamed TG");
  check("chatId updated", JSON.parse(editedChannel.config).chatId === "9988776655");
  check("type unchanged", editedChannel.type === "telegram");

  // --- Disable / Enable channel ---
  console.log("== Disable / Enable channel ==");
  check("disable ok", (await postAction("setChannelEnabledAction", { id: newChannelId, enabled: false })).ok === true);
  check("disabled in DB", readDb().channels.find((c) => c.id === newChannelId).enabled === 0);
  check("enable ok", (await postAction("setChannelEnabledAction", { id: newChannelId, enabled: true })).ok === true);
  check("enabled in DB", readDb().channels.find((c) => c.id === newChannelId).enabled === 1);

  // --- Add Rule ---
  console.log("== Add Rule ==");
  const ruleCreated = await postAction("createRuleAction", {
    name: "new-rule",
    channelId: newChannelId,
    source: "ssl",
    eventType: "ssl_status_changed",
    domainId: domainB,
    enabled: true,
  });
  check("rule create ok", ruleCreated.ok === true);
  dbState = readDb();
  const newRule = dbState.rules.find((r) => r.name === "new-rule");
  check("rule inserted", !!newRule && newRule.source === "ssl" && newRule.event_type === "ssl_status_changed" && newRule.domain_id === domainB && newRule.enabled === 1);
  const newRuleId = newRule.id;

  // --- Edit Rule ---
  console.log("== Edit Rule ==");
  const ruleEdited = await postAction("updateRuleAction", {
    id: newRuleId,
    name: "new-rule",
    channelId: newChannelId,
    source: null,
    eventType: null,
    domainId: null,
    enabled: true,
  });
  check("rule edit ok", ruleEdited.ok === true);
  dbState = readDb();
  const editedRule = dbState.rules.find((r) => r.id === newRuleId);
  check("rule filters nulled (All)", editedRule.source === null && editedRule.event_type === null && editedRule.domain_id === null);

  // --- Disable / Enable rule ---
  console.log("== Disable / Enable rule ==");
  check("rule disable ok", (await postAction("setRuleEnabledAction", { id: newRuleId, enabled: false })).ok === true);
  check("rule disabled in DB", readDb().rules.find((r) => r.id === newRuleId).enabled === 0);
  check("rule enable ok", (await postAction("setRuleEnabledAction", { id: newRuleId, enabled: true })).ok === true);
  check("rule enabled in DB", readDb().rules.find((r) => r.id === newRuleId).enabled === 1);

  // --- Validation error paths (controlled codes) ---
  console.log("== Validation ==");
  const badChat = await postAction("createChannelAction", {
    type: "telegram",
    name: "bad",
    config: JSON.stringify({ chatId: "not-a-number", secretRef: "TELEGRAM_BOT_TOKEN" }),
  });
  check("invalid chatId → controlled code", badChat.ok === false && /^[a-z_]+$/.test(badChat.error));
  const badRef = await postAction("createChannelAction", {
    type: "telegram",
    name: "bad",
    config: JSON.stringify({ chatId: "100000001", secretRef: "BAD REF!" }),
  });
  check("invalid secretRef → controlled code", badRef.ok === false && /^[a-z_]+$/.test(badRef.error));
  const badType = await postAction("createChannelAction", { type: "fax", name: "x", config: "{}" });
  check("invalid type → controlled code", badType.ok === false && badType.error === "invalid_channel_type");
  const missingChannel = await postAction("createRuleAction", {
    name: "x",
    channelId: 9999,
    source: null,
    eventType: null,
    domainId: null,
    enabled: true,
  });
  check("missing channel → controlled code", missingChannel.ok === false && missingChannel.error === "channel_not_found");
  const rdap = await postAction("createRuleAction", {
    name: "x",
    channelId,
    source: "rdap",
    eventType: "rdap_event",
    domainId: null,
    enabled: true,
  });
  check("RDAP blocked → controlled code", rdap.ok === false && rdap.error === "invalid_source");
  const afterFail = readDb();
  check("no row created by failed validations", afterFail.channels.length === 2 && afterFail.rules.length === 2);

  // --- Delete Rule ---
  console.log("== Delete Rule ==");
  check("rule delete ok", (await postAction("deleteRuleAction", { id: newRuleId })).ok === true);
  dbState = readDb();
  check("rule gone", dbState.rules.find((r) => r.id === newRuleId) === undefined);
  check("events untouched by rule delete", dbState.events === 1 && dbState.deliveries === 1);

  // --- Delete Channel (cascade) ---
  console.log("== Delete Channel (cascade) ==");
  check("channel delete ok", (await postAction("deleteChannelAction", { id: newChannelId })).ok === true);
  dbState = readDb();
  check("channel gone", dbState.channels.find((c) => c.id === newChannelId) === undefined);
  check("its rule cascade-deleted", dbState.rules.find((r) => r.name === "new-rule") === undefined);
  check("events retained", dbState.events === 1);
  check("seed channel + rule still present", dbState.channels.length === 1 && dbState.rules.length === 1);

  // --- No real sends happened ---
  check("no telegram/webhook/email traffic in logs", !/api\.telegram\.org|sendMessage/i.test(logs));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} catch (error) {
  console.error("SMOKE ERROR:", error.message);
  fail++;
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(fail === 0 ? 0 : 1);
