# Phase 14C-7 — Production Migration Review

**Status: STRICT READ-ONLY — 未执行任何 production / remote 写操作**
**Date: 2026-08-27**
**FINAL STATUS: NOT READY**

---

## 1. Executive Summary

本次为 Cloudflare 生产迁移前的最终只读审查。审查期间未执行任何 production
deployment、remote migration、写 SQL、DNS 修改、secret 写入、真实通知发送、
commit/push/tag/release。

核心结论：

- **本环境未认证 Cloudflare 身份**（`wrangler whoami` = "not authenticated"，
  无 `~/.wrangler`，无 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 环境变量）。
- 因此 **production Cloudflare identity = UNKNOWN**，**production D1 状态 = UNKNOWN**，
  无法执行只读 remote metadata/schema 查询（无凭据，无法触及远端）。
- 本地迁移机制已充分验证（13 表契约、0000–0007 迁移、secret 密文保留、
  幂等性、回滚、scheduled() 链路），但**本地验证 ≠ production 状态**。
- 存在至少 6 个未解决的生产前置项（见 §15 / §19）。
- 结论：**NOT READY**。等待明确批准，且需先补齐生产身份、D1 备份与生产侧只读验证，
  才可进入真正的 Production Migration。

---

## 2. Production Identity

| 项 | 状态 | 证据 |
|---|---|---|
| Cloudflare account | **UNKNOWN** | `wrangler whoami` → "You are not authenticated" |
| API token / account auth | **UNKNOWN / absent** | 无 `~/.wrangler` 目录；无 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 环境变量 |
| Worker name | prototype only | `domain-monitor-main-cf-prototype`（repo root `wrangler.jsonc`）、`domain-monitor-cf-scheduled-proto`（`prototype/cloudflare/wrangler.scheduled.jsonc`）|
| D1 database name | prototype only | `domain-monitor-prototype-main`（root）、`domain-monitor-prototype`（scheduled prototype）|
| D1 database_id | placeholder only | `00000000-0000-0000-0000-000000000002`（root）、`00000000-0000-0000-0000-000000000001`（scheduled）——均为占位 UUID，非真实 ID |
| zone / custom domain | **UNKNOWN** | 无任何真实 zone/域名引用 |

**注意**：repo 内出现的真实格式 UUID 均来自 `src/db/migrations/meta/0000..0007_snapshot.json`，
为 **Drizzle 迁移快照的内部 ID**，不是 Cloudflare database_id / account_id。已确认无真实
Cloudflare 身份泄露。

> 结论：**production identity 完全 UNKNOWN**。按 §2 规则不得猜测，不得自行 `wrangler login`。

---

## 3. Production D1 Read-Only Audit

| 项 | 状态 |
|---|---|
| 能否读取 production D1 | **UNKNOWN** — 无认证凭据，无法执行任何 remote 查询 |
| tables / indexes / FKs (production) | **UNKNOWN** |
| d1_migrations (production) | **UNKNOWN** |
| 0000–0007 是否已存在于 production D1 | **UNKNOWN** |

**本地可丢弃 D1（local disposable）审计结果**（`/tmp/d1-migration-14c6/migrated-d1.sqlite`，只读）：

- **13 tables** 齐全：`domains`, `dns_records`, `dns_snapshots`, `ssl_certificates`,
  `ssl_snapshots`, `http_snapshots`, `notification_channels`, `notification_deliveries`,
  `notification_events`, `notification_rules`, `admin_settings`, `notification_secrets`,
  `expiration_reminders`。
- 索引：5 个 UNIQUE（hostname、event+channel、dedup_key、channel+key、domain+days）+
  7 个非唯一 FK/查询索引 = 12 个，与迁移契约一致。
- 外键：`dns_records→dns_snapshots`、`dns_snapshots→domains`、`ssl_certificates→ssl_snapshots`、
  `ssl_snapshots→domains`、`http_snapshots→domains`、`notification_deliveries→events/channels`、
  `notification_events→domains`、`notification_rules→channels/domains`、
  `notification_secrets→channels`、`expiration_reminders→domains`，均 `ON DELETE cascade`。
- 迁移顺序本地验证：`wrangler d1 migrations list --local` → "No migrations to apply"
  （0000–0007 已在本地原型 D1 上 state 化，幂等）。

> 结论：本地 D1 状态完整，但 **production D1 状态无法确认**（EMPTY 或已有 schema/data 均不可断言）。
> 按 §3 规则判为 **UNKNOWN**，不写、不改、不猜。

---

## 4. D1 Migration Safety

根据实际 production D1 状态判定 `wrangler d1 migrations apply --remote` 是否安全。

| 检查项 | 结果 |
|---|---|
| production D1 实际状态 | **UNKNOWN**（无凭据无法读取） |
| 是否存在非项目 migration | **UNKNOWN** |
| 是否存在未知 migration | **UNKNOWN** |
| 是否存在 schema drift | **UNKNOWN** |
| 0007 是否已存在（production）| **UNKNOWN** |
| tracking 是否冲突 | **UNKNOWN** |

**本地已确认（非 production）**：
- 0000–0007 连续、带 tag、带 hash、带 snapshot（`src/db/migrations/meta/_journal.json`，version=7）。
- 0007 full SHA256 = `f4c068aa1d31314bfa6457decfd0d039ed63eb910faec760cc8c075af6e3d4d7`（14C-3 已验证）。
- 幂等：重复 apply / no-op 自愈安全（14C-3 / 14C-6 已验证）。

> **MIGRATION SAFETY = UNKNOWN**（不可在无 production 状态的前提下断言 READY/BLOCKED）。

---

## 5. Pre-Migration Backup

| 项 | 状态 |
|---|---|
| production D1 backup | **NOT ESTABLISHED** |
| production D1 export | **NOT ESTABLISHED** |
| production D1 snapshot | **NOT ESTABLISHED** |
| 本地一次性导出工具 | 存在（`migrate-d1-cli` / `source-fixture`，仅本地原型） |

> 按 §5 要求：**D1 PRE-MIGRATION BACKUP = NOT ESTABLISHED**，本阶段不自行创建 production backup。

---

## 6. Data Migration

SQLite → D1 mapping 审查（基于 `src/db/migrations/0000..0007` + 本地 disposable 验证）：

| 项 | 结果 |
|---|---|
| 13 tables | ✅ 契约一致 |
| IDs | ✅ `integer PRIMARY KEY AUTOINCREMENT NOT NULL` |
| timestamps | ✅ `integer`（epoch ms，`created_at`/`updated_at`/`checked_at`/`occurred_at`/`claimed_at`/`delivered_at`）|
| foreign keys | ✅ 全部 `ON DELETE cascade`，方向一致 |
| unique constraints | ✅ hostname / event+channel / dedup_key / channel+key / domain+days |
| dedup keys | ✅ `notification_events.dedup_key` UNIQUE；`notification_deliveries(event_id,channel_id)` UNIQUE |
| notification state | ✅ `notification_deliveries.status`(pending/claimed/sent/failed) + attempts + error，CAS claim 已单测 |
| expiration reminders | ✅ `expiration_reminders(domain_id, days_before)` UNIQUE + `domains.expiration_source` 默认 `'rdap'` |
| **notification_secrets** | ✅ `encrypted_value` 为 `iv:tag:ciphertext`，密文原样保留，迁移工具含无明文检测 |

**secret 处理（§6 特别要求）**：
- 迁移全程**不解密、不导出明文**。
- 14C-6 §3b 已验证：ciphertext iv/tag/ct 长度合法，roundtrip 明文为**明显 FAKE**（19 字符），
  绝非真实 secret。
- Repository 契约维持 `hasChannelSecret()` / `getChannelSecret()` 边界，plaintext 从不序列化。

---

## 7. Production Data Baseline

| 项 | 状态 |
|---|---|
| 本工作区 Node SQLite | `./data/domain-monitor.db` = **0 bytes（空）** |
| 真实生产 Node SQLite | `/tmp/domain-monitor` —— **本沙箱不可访问**（14B/14C 约束已记录）|
| source of truth | **Node SQLite**（better-sqlite3，第一等 runtime）|
| production row counts / schema version / business object counts | **UNKNOWN**（不可读生产库）|

> 结论：**source of truth = Node SQLite**（未变）。本环境无法读取真实生产库的 business 计数，
> 不读 secret values。

---

## 8. Worker Deployment

| 项 | 状态 |
|---|---|
| OpenNext artifact | ✅ 可部署产物 `server-functions/default/index.mjs`（exports `handler`，OpenNext v4.1.0 + Next 15.5.23）+ `middleware/handler.mjs` |
| Worker entry | ⚠️ root `wrangler.jsonc` `main = ".open-next/worker.js"`；当前 `.open-next/` **无顶层 worker.js**（v4.1.0 由 `@opennextjs/cloudflare` 打包步骤产出，本阶段未重跑打包，14C-6 的 `open-next build` 只产出 index.mjs）|
| ASSETS binding | ✅ root `wrangler.jsonc` 定义 `assets.directory = ".open-next/assets"`、`binding = "ASSETS"` |
| D1 binding | ✅ `binding = "DB"`（root）+ `DB`（scheduled prototype）|
| CONFIG binding | ✅ `CONFIG_TELEGRAM_ENDPOINT`（假端点 `http://127.0.0.1:8788`）|
| scheduled() | ✅ 代码链：`scheduled() → getRepository({ d1: env.DB }) → runOnce({ repo, senders }) → createSender(type, repo, env)`，与 §8 要求逐字一致 |

**注意**：worker.js 尚未随本次 open-next build 重新产出，root wrangler.jsonc 的 `main` 指向敞口。
真正部署前需由 `@opennextjs/cloudflare` 打包步骤产出并确认 main 指向正确路径。本阶段**不部署**。

---

## 9. Cron

| 项 | 状态 |
|---|---|
| cron 表达式 | ✅ `0 * * * *`（`prototype/cloudflare/wrangler.scheduled.jsonc` triggers.crons）|
| prototype | ✅ **PASS** — `wrangler dev --local` + `--test-scheduled` 复验，`runOnce done in 976ms` |
| production trigger | **UNKNOWN / NOT DEPLOYED** |

> 不创建 production trigger。

---

## 10. SSL

| 项 | 结论 |
|---|---|
| Node SSL | **FULL**（better-sqlite3 + node:tls，Node self-hosted 保留）|
| Cloudflare SSL | **PARTIAL** |
| 原因 | Worker 运行时无 `node:tls` / `getPeerX509Certificate`，无法直接读取 peer certificate 完整内容 |
| 处理 | 保留 Node SSL monitor；完整证书内容取证留给未来 **external certificate observer**（本阶段不实现）|

---

## 11. Secrets

生产 secret 需求清单（只确认存在/缺失，不读值）：

| secret | 生产状态 |
|---|---|
| ENCRYPTION_KEY | **UNKNOWN**（生产值未确认；工作区仅见 `prototype-e2e-key-...` 假值 + test fixture）|
| SESSION_SECRET | **UNKNOWN** |
| Telegram bot token | **UNKNOWN**（真值未确认；fixture 用 `AAH_TEST_TOKEN_ONLY`）|
| 其他 CONFIG secrets | **UNKNOWN** |

已确认 **0 leakage**（§18）：真实 TG id `1616146471` = 0、真实 token = 0、
硬编码 ENCRYPTION_KEY/SESSION_SECRET/DATABASE_URL（≥16 字符真实值）= 0（唯一命中为
`test-notification-integration.test.ts` 的 `test-encryption-key-11ga-...` 测试 fixture）、
ciphertext 特征串 = 0、`bot<id>:` 特征串 = 0。

---

## 12. Cutover（制定，不执行）

```
Node production
        ↓
D1 迁移/导入（本地验证工具 + production D1 事务）
        ↓
Worker deployment（前置：产出 worker.js + 生产身份）
        ↓
Cloudflare HTTP smoke
        ↓
business smoke
        ↓
fake notification（不真实发送）
        ↓
parallel observation（Node + Cloudflare 并行观察）
        ↓
DNS cutover
```

**Rollback**：Cloudflare failure → DNS 保持指向 Node → Node 继续服务。不设置 production 一键切换。

---

## 13. Newbie Deployment

| 分类 | 判定 |
|---|---|
| ONE_CLICK | ❌ 不成立（本阶段未自动化）|
| CLI_REQUIRED | ✅（`wrangler d1 migrations apply`、`wrangler deploy` 必经 CLI）|
| MANUAL_ENV | ✅（生产 ENCRYPTION_KEY/SESSION_SECRET/token 需手动注入）|
| MANUAL_DB | ✅（SQLite→D1 数据迁移需手动运行迁移 CLI）|

> 真实状态：**CLI_REQUIRED + MANUAL_ENV + MANUAL_DB**，无一键部署。不虚构自动化。

---

## 14. Risk Matrix

| 项 | 状态 |
|---|---|
| D1 identity | **UNKNOWN**（无 Cloudflare 认证）|
| D1 schema | **PARTIAL**（本地 13 表契约已验证，production 未确认）|
| D1 migration | **UNKNOWN**（production 状态不可读）|
| D1 backup | **BLOCKED**（NOT ESTABLISHED，且本阶段禁止创建）|
| Data migration | **PASS**（本地 disposable 全门通过，密文保留）|
| Secrets | **UNKNOWN**（生产值未确认；泄漏扫描 = 0）|
| Worker | **PARTIAL**（scheduled() 原型通过；worker.js 尚未随本次 build 产出）|
| Scheduler | **PARTIAL**（原型 PASS；production cron NOT DEPLOYED）|
| SSL | **PARTIAL**（Node FULL，Cloudflare PARTIAL，已文档化）|
| DNS | **UNKNOWN**（无生产 zone/域名信息）|
| Rollback | **PARTIAL**（策略已文档化，未在生产演练）|
| Newbie deployment | **BLOCKED**（CLI+MANUAL_ENV+MANUAL_DB，无一键）|

---

## 15. Final Decision

**存在 production prerequisite 为 UNKNOWN 或 BLOCKED**：

1. Cloudflare identity = UNKNOWN（无认证）
2. production D1 状态 = UNKNOWN（不可读）
3. D1 PRE-MIGRATION BACKUP = NOT ESTABLISHED（BLOCKED）
4. production Secrets 值 = UNKNOWN
5. DNS / zone = UNKNOWN
6. Newbie deployment = BLOCKED（无自动化）

> **FINAL STATUS = NOT READY**

注：`NOT READY` ≠ 否定方案；仅表示生产前置项尚未满足/尚未可测。
即便未来全部满足而变为 `READY FOR PRODUCTION DEPLOYMENT REVIEW`，也**不等于**
`APPROVED FOR PRODUCTION DEPLOYMENT`。真正生产迁移需另行明确批准。

---

## 16. Security（§18）

| 扫描项 | 结果 |
|---|---|
| 真实 Telegram id `1616146471`（git tracked src/scripts）| **0** |
| 真实 bot token | **0** |
| 硬编码 ENCRYPTION_KEY/SESSION_SECRET/DATABASE_URL 真实值 | **0**（唯一命中为 test fixture）|
| ciphertext 特征串（iv:tag:ct）| **0** |
| `bot<id>:` 特征串 | **0** |
| Authorization（Bearer 长 base64）| **0** |
| 真实 database_id / account_id | **0**（均为占位 UUID 或 Drizzle snapshot id）|

---

## 17. Production Safety（§19）— 证明

| 项 | 计数 |
|---|---|
| production D1 writes | **0** |
| production Worker deploy | **0** |
| DNS changes | **0** |
| secret writes | **0** |
| real Telegram | **0** |
| real Webhook | **0** |
| real Email | **0** |
| commit / push / tag / release | **0** |

---

## 18. STOP

审查完成。

**FINAL STATUS: NOT READY**

**Blockers（按优先级）：**
1. Cloudflare 生产身份未建立/未认证（identity UNKNOWN）——需单独授权登录 + 提供 account/worker/D1 id。
2. D1 生产备份未建立（BACKUP NOT ESTABLISHED）——需在 migration 前完成。
3. production D1 状态未做只读审计——需认证后先 `--remote` 只读核对 0000–0007 是否存在、有无 drift/未知 migration。
4. 生产 secrets 值未配置/未确认（ENCRYPTION_KEY / SESSION_SECRET / Telegram token）。
5. worker.js 未随最新 OpenNext build 产出，需补 `@opennextjs/cloudflare` 打包步骤并核对 main 指向。
6. 生产 cron trigger、DNS/zone 未部署（scheduled() 仅原型通过）。

**Recommended Next Phase：**
生产身份与安全通道建立 → 生产 D1 只读审计 + 备份 → secret 配置 → worker 打包产物核对 →
（获得明确批准后）真正执行 SQLite→D1 Production Migration。