# PHASE 14B-3 — OpenNext / Wrangler Compatibility Gate

- **日期**：2026-08-24
- **目标**：在完全隔离的 prototype 环境中验证 `Next.js + OpenNext + Cloudflare Workers + D1 + Drizzle + Domains / RDAP / DoH / Telegram fake` 能否真正走完 `source → OpenNext build → Workers bundle → wrangler dev → Worker runtime → D1 prototype → 核心请求成功`。
- **最终状态**：**PASS**
- **说明**：本阶段 STRICTLY PROTOTYPE ONLY。零 deploy、零 commit、零 push、零 tag、零 production 触碰。

---

## 0. STOP / SAFETY 合规确认

| 禁止项 | 是否触碰 |
|---|---|
| wrangler deploy | ✅ 未执行（仅 `wrangler dev --local`） |
| Cloudflare production deployment | ✅ 未执行 |
| 修改 production Worker / D1 / DNS / R2 / secrets / DATABASE_URL | ✅ 未执行 |
| 修改 `/tmp/domain-monitor/data/domain-monitor.db` | ✅ 未执行（全程只读打开） |
| restart next-server / worker-watchdog / cloudflared | ✅ 未执行（本容器看不到生产 host 进程，也未做任何 restart） |
| 修改生产 QwenPaw cron | ✅ 未执行 |
| 真实 Telegram / Webhook / Email | ✅ 未执行（Telegram 只打到本地 mock 8788） |
| commit / push / tag / GitHub Release | ✅ 未执行（HEAD 仍 09e0523，tag 仍 v0.8.9） |

无需 production credentials 的任何操作，因此没有"误指向 production account"的风险。

---

## 1. BASELINE（已记录）

| 项 | 值 |
|---|---|
| git HEAD | `09e05237d75b8a4b88429747c02c2cf16184c15d` |
| origin/main | 同上 |
| branch | `main` |
| package.json version | `0.8.9` |
| working tree | `M tsconfig.json`＋untracked `docs/PHASE14B-1*`、`docs/PHASE14B-2*`、`prototype/` |
| Node | `v25.6.0` |
| pnpm | `11.2.2` |
| npm prefix | `/app/user-packages/node` |
| Next.js | `15.5.23` |
| 14B-2 prototype | `prototype/d1/`（untracked，未 commit） |

**生产运行时**：`next-server` / `worker-watchdog` / `cloudflared` 进程不在本容器可见域（生产 server 在独立主机，本 workspace 是 NAS 挂载）。因此进程级 PID 无法在容器内观测——作为替代，以生产 DB 的 mtime/size/integrity/counts 作为零接触验证锚点（见 §16）。

**生产 DB baseline（只读）**：
- `size=126976`，`mtime=2026-08-20 05:52:25.889245417 +0000`
- `integrity_check=ok`
- counts：`__drizzle_migrations 8 · admin_settings 1 · dns_records 30 · dns_snapshots 5 · domains 3 · expiration_reminders 1 · http_snapshots 4 · notification_channels 1 · notification_deliveries 7 · notification_events 7 · notification_rules 5 · notification_secrets 1 · sqlite_sequence 13 · ssl_certificates 3 · ssl_snapshots 4`

---

## 2. Prototype isolation

建立独立原型目录 `prototype/cloudflare/`，与生产完全隔离：

- **复用禁止**：不引入 `production DATABASE_URL`、生产 DB 路径、生产 Cloudflare 资源、生产 secrets。
- **本地 D1** 由 wrangler 在 `prototype/cloudflare/.wrangler/state/` 生成（SQLite 文件，只属于 prototype）。
- **Telegram** 只打 `http://127.0.0.1:8788`（本地 mock），绝不打真实 Telegram。
- **不指向** `/tmp/domain-monitor/data/domain-monitor.db`。

---

## 3. Wrangler / OpenNext 依赖

直接在 prototype 内安装，标记为 **PROTOTYPE DEPENDENCY CHANGE**（不改生产依赖树，不 commit）：

| 包 | 版本 | 说明 |
|---|---|---|
| `@opennextjs/cloudflare` | `1.20.2` | peer: `next >=15.5.21 <16`（生产 15.5.23 满足）、`wrangler ^4.86.0`、`rclone.js`(optional) |
| `wrangler` | `4.125.0` | 满足 `^4.86.0`；**不同于** 14B-2 失败的 `4.20260708.0` |
| `next` / `react` / `react-dom` | `15.5.23` / `19.2.8` / `19.2.8` | |
| `drizzle-orm` | `0.44.7` | |
| `typescript` | `5.9.3` | |

**环境注意（非架构 blocker，已绕过）**：
- 容器内 `NPM_CONFIG_GLOBAL=true`（npm 默认走 global）；改用 `NPM_CONFIG_GLOBAL=false` 强制本地安装。
- `NODE_ENV=production` 使 npm 默认跳过 devDependencies；用 `--include=dev` 安装 wrangler/opennext/types 等 devDeps。
- 父仓库存在 `pnpm-workspace.yaml`，直接 `pnpm install` 会被 workspace 吞掉；改用 npm 本地安装。

**未换架构**：无 BLOCKER，wrangler 4.125.0 与 opennext 1.20.2 均成功安装。

---

## 4. OpenNext configuration

`prototype/cloudflare/open-next.config.ts`：

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
export default defineCloudflareConfig({});
```

- **最小配置**，未加 R2 / KV / Queues / Durable Objects / Workers AI（模板默认带 R2 incremental cache，按阶段规则去掉；用默认 dummy incremental cache）。
- `wrangler.jsonc`：`main: .open-next/worker.js`，`assets: {directory, binding: ASSETS}`，`d1_databases → binding DB`，`vars → CONFIG_TELEGRAM_ENDPOINT=http://127.0.0.1:8788`。
- `compatibility_flags: ["nodejs_compat"]`（OpenNext 在 Workers 运行 Next 所需）。
- 刻意**不加** `global_fetch_strictly_public`，以允许 worker fetch 本地 mock Telegram 端点。
- `next.config.mjs` 设 `outputFileTracingRoot` 指向本 prototype 目录，避免 OpenNext/Next 追踪到父仓库 `node_modules`（会引入 better-sqlite3/node:tls 及 pnpm-store 的 eslint 插件）。生产 repo 的 `tsconfig.json` exclude 已含 `"prototype"`。

**Cleanliness 关键点**：`outputFileTracingRoot` 已正确写入 bundle（可在 handler.mjs 看到 `outputFileTracingRoot:"...prototype/cloudflare"`）。

---

## 5. D1 binding

- 本地 D1 名 `domain-monitor-prototype`，binding `DB`，`database_id` 为占位 UUID（仅用于本地模拟，不部署故不会创建真实 D1）。
- wrangler dev 输出确认：`env.DB (domain-monitor-prototype)  D1 Database  local`。
- **未修改**任何正式 migration。prototype 用独立的 prototype-only DDL（见 §6），保证不污染生产 migration。

> 注：生产 migrations 0000–0007 未在 D1 上直接重放——本阶段目标是验证*管线*（build→bundle→wrangler→D1），而非把生产 migration 逐条搬进 D1。Drizzle D1 adapter 对核心表结构已验证兼容。

---

## 6. Seed

`prototype/cloudflare/src/db/seed.ts` 写入最小 fixture：

- **domains**：`chatgpt.com`（EXACT，exp `2026-11-30`，MarkMonitor）、`opusai.eu.cc`（PARENT，exp 不写 child）、`nonexistent-hopefully.example`（NO_OBJECT，exp null）、`manual-proto.example.com`（MANUAL，exp `2027-06-30`）。
- **notification**：一个 fake Telegram channel + 一条规则。config：`{ "chat_id": "100000001", "token": "AAH_TEST_TOKEN_ONLY" }`。

**token 合规**：全部为明显 fake fixture（`AAH_TEST_TOKEN_ONLY`）；无任何 production secret。**chat_id 修正**：初版 fixture 误用了生产聊天 ID `1616146471`，已改为 `100000001` 并重建 bundle（见 §15 复扫 `1616146471=0`）。

---

## 7. OpenNext build

| 项 | 结果 |
|---|---|
| build command | `opennextjs-cloudflare build`（内部先 `next build`） |
| next build | ✅ exit 0（`Compiled successfully in 3.1s`，类型检查通过） |
| OpenNext build | ✅ exit 0（`Worker saved in .open-next/worker.js 🚀`，`OpenNext build complete.`） |
| BUILD_ID | `4Y37c3O401TVoDAvOwvHP` |
| output directory | `prototype/cloudflare/.open-next/` |
| Worker bundle | `.open-next/worker.js`（2.2 KB 入口 shim）＋ `server-functions/default/handler.mjs` |
| asset count | `.open-next/assets/` = 2 个文件 |
| warnings / errors | 无错误；无编译 warning 阻塞 |

### Bundle 的 Node-only 依赖扫描（§7 核心要求）

| 关键字 | 命中**数量（.open-next 全量）** | 判定 |
|---|---|---|
| `better-sqlite3` | 0 | ✅ 业务 bundle 无 |
| `node:tls` | 0 | ✅ 业务 bundle 无 |
| `node:net` | 1（`next/dist/compiled/@edge-runtime/primitives/load.js`） | ⚠️ Next 自身 edge runtime 静态文件，非业务路径 |
| `node:fs` | 7（均在 `next/dist/build|lib|compiled`） | ⚠️ Next build/tooling 产物，非业务路径 |
| `node:dns` | 0 | ✅ |
| `child_process` | 12（均在 `next/dist`） | ⚠️ Next build 工具产物，非业务路径 |
| `node:http` | 1（在 `handler.mjs`） | ✅ 由 `nodejs_compat` polyfill，OpenNext 设计内路径 |
| `node:crypto` | 0（业务层） | ✅ |

**关键结论**：实际执行的服务 handler（`server-functions/default/handler.mjs`）中，`better-sqlite3=0`、`node:tls=0`、`node:net=0`、`node:fs=0`、`node:dns=0`、`child_process=0`，仅 `node:http=1`，属于 OpenNext/AWS runtime 依赖 `nodejs_compat` 提供的标准 polyfill。**没有 Node-only blocker 进入业务 Worker runtime。**

---

## 8. Wrangler dev

- 命令：`wrangler dev --port 8787 --local`（**仅 local**，无 `--remote`）。
- 输出：
  - `bindings: env.DB (D1, local) · env.ASSETS (local) · env.CONFIG_TELEGRAM_ENDPOINT (env var)`。
  - `Ready on http://localhost:8787`。
- Worker 可正常启动，无 console runtime 错误。

---

## 9. HTTP smoke

| 端到端 | 状态 |
|---|---|
| `GET /` | `200`（渲染 `<h1>Domain Monitor — Cloudflare Prototype</h1>`） |
| `GET /login` | `200` |
| `GET /dashboard` | `200`（读 D1 渲染） |

无 Worker exception，无 Node API unsupported error。

---

## 10. D1 runtime test（真实 Worker runtime，非 Node test）

`GET /api/db` 执行 READ→WRITE→READ→DELETE→READ：

```json
{
  "ok": true,
  "readListCount": 4,
  "write": { "id": 5, "hostname": "proto-test-1787559989410.example.com" },
  "readVerify": { "id": 5, "hostname": "proto-test-...", "expirationDate": "2028-01-01T00:00:00.000Z" },
  "delete": { "deleted": true, "stillPresent": false },
  "sample": [ /* chatgpt.com, opusai.eu.cc, nonexistent...example, manual-proto.example.com */ ]
}
```

- READ list：4 条（fixture 齐全）。
- WRITE：创建 `id=5` 测试记录。
- READ 确认：读到该记录。
- DELETE：删除成功，`stillPresent=false`。
- 生产 DB 全程零触碰。

> 已修复一个 D1 兼容点：`d1.exec()` 对多行/多语句 DDL 抛 `incomplete input: SQLITE_ERROR`，改为逐条 `prepare(...).run()` 执行 CREATE TABLE（D1/miniflare 最稳）。这是 prototype 内的 adapter 写法调整，非 production migration 改动。

---

## 11. RDAP runtime test（真实网络 fetch）

在 Worker runtime 内用 `fetch`：

| hostname | 结果 | 类型 |
|---|---|---|
| `chatgpt.com` | `ownership=exact, matchedHostname=chatgpt.com, expirationDate=2026-11-30T23:59:19Z, registrar=MarkMonitor Inc., nameservers=[HASSAN/SAVANNA.NS.CLOUDFLARE.COM]` | EXACT（REAL FETCH） |
| `opusai.eu.cc` | `ownership=parent, matchedHostname=eu.cc, expirationDate=2031-03-26T04:00:00Z`（父域 `eu.cc` 过期时间，**不写 child**） | PARENT（REAL FETCH） |
| `nonexistent-hopefully.example` | `notFound=true, ownership=null, expirationDate=null` | NO_OBJECT（REAL FETCH） |

由于 prototype 是隔离的 fetch-only 实现，且沙箱网络允许 egress，**三路径全部走真实 IANA/RDAP fetch**（无需 mock）。

---

## 12. DoH runtime test

在 Worker runtime 内用 `fetch` 到公共 DoH（`cloudflare-dns.com/dns-query`）：

| 查询 | 结果 |
|---|---|
| `chatgpt.com A` | `104.18.32.47`, `172.64.155.209`（REAL FETCH） |
| `chatgpt.com AAAA` | `2a06:98c1:3101::6812:202f`, `2606:4700:4408::ac40:9bd1`（REAL FETCH） |
| `nonexistent-hopefully.invalid A` | `[]`（NXDOMAIN/无记录，空回） |

未使用 `node:dns/promises`；解析与超时/异常路径由 fetch 正确处理。

---

## 13. Telegram fake runtime test

`GET /api/telegram`（成功）与 `GET /api/telegram?fail=1`（失败）在 Worker runtime 内完成 event→delivery→CAS→fake endpoint→结果：

| 路径 | delivery | attempts | error | token 泄漏 |
|---|---|---|---|---|
| 成功（mock 200） | `status=sent` | `1` | `null` | 无 |
| 失败（mock 401） | `status=failed` | `1` | `Telegram unauthorized (401).` | 无（token 已 redact） |

`event=1, delivery=1, attempts=1, error=null`（成功）与 `failed / attempts=1 / error 无 token`（失败）均验证。

**mock 日志**确认（本地 `127.0.0.1:8788`，非真实 Telegram）：
```
[mock-telegram] POST /sendMessage body={"chat_id":"100000001","text":"prototype test deliver #1"}   -> 200
[mock-telegram] POST /fail/sendMessage body={"chat_id":"100000001","text":"prototype test deliver #2"} -> 401
```
- 无任何真实 Telegram API 请求；日志/错误/响应中均未出现 token。

---

## 14. Node compatibility regression

Cloudflare prototype 过程中未破坏 Node 版本；生产回归全绿：

| 检查 | 结果 |
|---|---|
| `vitest run` | ✅ **849/849 passed**（57 files，37.79s） |
| `tsc --noEmit` | ✅ exit 0 |
| `prettier --check` | ✅ `All matched files use Prettier code style!` |
| `next lint` | ✅ `No ESLint warnings or errors` |

测试数量未变化（仍是 849），`prototype/` 在生产 tsconfig exclude 内，因此 prototype 不影响生产 tsc。

---

## 15. Bundle security audit

扫描 `.open-next/` 与 `.wrangler/`（wrangler 生成物）；只统计命中/位置，不输出值。

| 模式 | `.open-next` | `.wrangler` | 判定 |
|---|---|---|---|
| `ENCRYPTION_KEY=` | 0 | 0 | ✅ |
| `SESSION_SECRET=` | 0 | 0 | ✅ |
| `DATABASE_URL` | 0 | 0 | ✅ |
| 生产 DB 路径 `/tmp/domain-monitor/data/domain-monitor.db` | 0 | 0 | ✅ |
| 真实 Telegram `api.telegram.org` | 0 | 0 | ✅ |
| `AAH_TEST_TOKEN_ONLY` | 4 | 3 | ⚠️ 预期存在的 **fake fixture token**（阶段 §6 明确要求） |
| `chat_id` | 4 | 3 | ⚠️ fixture 的 chat_id（已改为 fake `100000001`） |
| `Authorization:` | 1 | 2 | ⚠️ 捆绑库中通用的 header 名引用（非存储的 credentials） |
| `1616146471`（初版误入的生产 chat_id） | **0** | 0 | ✅ 已消除 |

**生产 secret = 0**（真实 ENCRYPTION_KEY / SESSION_SECRET / DATABASE_URL / 生产 token / 生产 chat_id 均不存在）。发现的 `AAH_TEST_TOKEN_ONLY` 是阶段规定的 fake fixture；`Authorization:` 是库代码里的 header 名，非泄密值。

---

## 16. Production zero-touch gate

完成后重查生产 DB（只读）并比对 baseline：

| 项 | baseline | 完成后 | 一致 |
|---|---|---|---|
| size | 126976 | 126976 | ✅ |
| mtime | `2026-08-20 05:52:25.889245417 +0000` | 同 | ✅ |
| `integrity_check` | `ok` | `ok` | ✅ |
| counts（14 表） | 见 §1 | 逐表相同（migrations 8 / admin_settings 1 / dns_records 30 / dns_snapshots 5 / domains 3 / expiration_reminders 1 / http_snapshots 4 / notification_channels 1 / notifications_deliveries 7 / events 7 / rules 5 / secrets 1 / sqlite_sequence 13 / ssl_certificates 3 / ssl_snapshots 4） | ✅ |

- **Telegram real sends = 0**（仅本地 mock）。
- **Webhook real sends = 0** / **Email real sends = 0**（prototype 未实现/未调用生产 webhook/email 路径）。
- **Cloudflare production resources unchanged**（未 deploy，无 wrangler 访问远程 account）。
- 生产进程（next-server / worker-watchdog / cloudflared）不在容器可见域，未执行任何 restart；已用 DB 零接触作为核心证据。

---

## 17. Git

本阶段禁止 commit / push / tag / release；动作未做（HEAD 仍 `09e0523`，tag 仍 `v0.8.9`）。

**git status --short（过滤 node_modules/.next/.open-next/.wrangler）**：
```
 M tsconfig.json                                   (14B-2 已有：exclude 增加 "prototype")
?? docs/PHASE14B-1-CLOUDFLARE-RUNTIME-AUDIT.md     (14B-2 已有 untracked)
?? docs/PHASE14B-2-D1-PROTOTYPE.md                 (14B-2 已有 untracked)
?? prototype/                                      (新增：prototype/cloudflare)
```

本阶段新增/变更文件（均为 untracked，未 commit）：
- `prototype/cloudflare/` 全部（含 `package.json`、`package-lock.json`、`open-next.config.ts`、`wrangler.jsonc`、`next.config.mjs`、`tsconfig.json`、`src/**`、`mock-telegram.cjs`）。其中 `package.json`/`package-lock.json` 为 **PROTOTYPE DEPENDENCY CHANGE**（新增 wrangler/opennext 等 devDeps），未 commit。

---

## 18. Final assessment — 逐项回答

| # | 问题 | 答案 |
|---|---|---|
| 1 | OpenNext build 是否成功？ | ✅ 成功，exit 0，`Worker saved in .open-next/worker.js` |
| 2 | Worker bundle 是否成功？ | ✅ `.open-next/` 生成，资产 2 个，BUILD_ID `4Y37c3O401TVoDAvOwvHP` |
| 3 | wrangler dev 是否启动？ | ✅ `Ready on http://localhost:8787`，bindings 就绪 |
| 4 | D1 binding 是否工作？ | ✅ `env.DB`（local）绑定成功 |
| 5 | Worker runtime 是否能读写 D1？ | ✅ READ 4 → WRITE id=5 → READ → DELETE → 确认消失 |
| 6 | RDAP 是否工作？ | ✅ exact / parent / NO_OBJECT 三路径（真实 fetch） |
| 7 | DoH 是否工作？ | ✅ A/AAAA 解析 + NXDOMAIN（真实 fetch） |
| 8 | Telegram fake E2E 是否工作？ | ✅ sent（attempts=1, error=null）与 failed（attempts=1, error 无 token） |
| 9 | Node 849/849 是否仍通过？ | ✅ vitest 849/849、tsc、prettier、lint 全过 |
| 10 | bundle 是否存在 Node-only blocker？ | ❌ 无。handler 无 better-sqlite3/node:tls/node:net；仅 `node:http` 由 nodejs_compat polyfill |
| 11 | production 是否完全 untouched？ | ✅ DB counts/integrity/mtime/size 与 baseline 完全一致；零真实发送；无 deploy |
| 12 | Cloudflare full migration 是否值得继续？ | ✅ **值得。** 管线已被证明可用：Next+OpenNext+Wrangler+D1+Drizzle+RDAP+DoH+Telegram(fake) 在真实 workerd 运行时端到端跑通 |

### 最终状态：**PASS**

---

## 附加说明：environment vs architecture blocker

按要求区分：

- **ENVIRONMENT（非架构 blocker，均已绕过）**：`NPM_CONFIG_GLOBAL=true` / `NODE_ENV=production` 需在 prototype 安装时覆盖（`NPM_CONFIG_GLOBAL=false`、`--include=dev`）；父 `pnpm-workspace.yaml` 吞并 pnpm 安装 → 改用 npm 本地安装。这些只影响原型依赖安装，不影响架构结论。沙箱网络**允许** worker egress（故 RDAP/DoH 走真实 fetch，优于 mock，消除网络不确定性）。
- **ARCHITECTURE**：未出现"Worker bundle 无法运行 / D1 runtime incompatibility / OpenNext+Next.js 架构不兼容 / Node-only 依赖进入 Worker runtime"。故**非 ARCHITECTURE BLOCKED**。

## Deferred（与 14B-2 一致，不扩大范围）

- **生产应用全量迁移**不在本阶段：SSL certificate content monitoring、Email、Webhook、better-sqlite3→D1 全层 async 重构、auth/session 状态机、migrations 0000–0007 精确实跑、备份脚本 worker-watchdog/backup-db.js、生产部署/生产 D1/生产 Cloudflare account 均不迁移。
- **OpenNext 里未直接重放生产 migration**（用 prototype 级 DDL 替代）；Drizzle D1 adapter 核心表结构已验证兼容。
- 本阶段完成后立即 STOP，不自动进入 14C。

---

## 结论

Phase 14B-3 达成 Runtime / Build Compatibility Gate 目标：**PASS**。

完整链条 `source → opennextjs-cloudflare build → .open-next Worker bundle → wrangler dev (local) → workerd runtime → D1 (Drizzle) → RDAP/DoH/Telegram-fake/E2E` 全部验证通过；生产 DB 完全零接触；生产回归 849/849 保持；bundle 无业务路径 Node-only 依赖。证明 **OpenNext + Wrangler + D1 + Drizzle 的 Cloudflare 迁移管线可行**。
