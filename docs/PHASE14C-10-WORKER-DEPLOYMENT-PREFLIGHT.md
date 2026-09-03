# Phase 14C-10 — Cloudflare Production Worker Deployment Preflight

**Date:** 2026-08-28 (Asia/Shanghai)
**Mode:** Production Worker deploy preflight（允许 build/deploy/secrets/cron；禁止 domain-check/DNS/tunnel/真实通知/commit）
**FINAL STATUS: BLOCKED**

---

## 1. Executive Summary

本阶段目标是完成生产 Worker（`domain-monitor`）的部署前检查并执行部署。已按
STEP 1–5 顺序完成只读审计，**发现 4 个关键 blocker，未执行 STEP 6（deploy）**。

核心结论：**生产 D1（`domain-monitor`）已就绪且数据完整**，但**可部署的 Worker 产物
尚不存在**——`.open-next/worker.js` 缺失、`scheduled()` 未接入生产 Worker entry、
根 `wrangler.jsonc` 仍是 prototype 配置、生产 secrets 未提供。任何一个都足以阻止部署。

---

## 2. STEP 1 — Git / Worktree Audit ✅

| 项 | 值 |
|---|---|
| HEAD | `09e05237d75b8a4b88429747c02c2cf16184c15d` |
| branch | `main` |
| origin/main | `09e05237…`（与 HEAD 一致，无分叉）|
| package.json version | `0.8.9` |
| working tree | 非 clean：46 个 tracked 文件 M + 20 个 untracked docs + `prototype/` + `wrangler.jsonc` / `tsconfig.cf.json` / `open-next.config.ts` / `src/db/**` / `src/lib/runtime/**` 等 untracked |

- 未自行 commit / push / tag / release。✅
- 14C prototype / docs 全部保持 untracked，未进入 Git。✅

---

## 3. STEP 2 — OpenNext Final Build ❌ BLOCKED

### 3.1 可部署入口缺失（决定性 blocker）

| 期望产物 | 实际状态 |
|---|---|
| `.open-next/worker.js` | **不存在** |
| `.open-next/server-functions/default/handler.mjs` | **不存在** |

`.open-next/` 当前仅有 OpenNext 的**中间产物**（`open-next.output.json`、
`server-functions/default/index.mjs`、`assets/`、`middleware/`、
`image-optimization-function/`、`revalidation-function/`、`warmer-function/`），
但 `bundle-server` 步骤未产出最终的 `worker.js` + `handler.mjs`。

> 历史上 OpenNext build 在 `next build` 阶段多次因内存不足（约 3.8Gi 限制）
> `SIGKILL`，从未完整跑通到 `worker.js` 产出（14C-5/14C-6 已有记录）。

### 3.2 `scheduled()` 未接入生产 Worker

- OpenNext 生成的 `worker.js`（模板 `dist/cli/templates/worker.js`）**只暴露 `fetch`**，不含 `scheduled`。
- 生产 Worker 需要 `fetch`（OpenNext）+ `scheduled`（`runOnce`）合并入口。
- 现有 `scheduled()` 实现**仅存在于** `prototype/cloudflare/scheduled-worker.ts`
  （独立 prototype，`main: scheduled-worker.mjs`，明确标注 "Never deployed"）。
- `src/` 下**没有任何**生产 Worker entry（无 `ScheduledController` / `.scheduled` 引用）。

> 结论：没有一个生产 Worker 入口文件同时包含 `fetch` + `scheduled`。
> 需要先建立一个生产 entry（把 `scheduled-worker.ts` 的 pattern 并入 OpenNext
> worker），否则 cron `0 * * * *` 无法驱动 `runOnce`。

### 3.3 禁止项扫描（针对现有产物，未执行因产物缺失）

- 因 `.open-next/worker.js` 不存在，无法做最终 bundle 的
  `better-sqlite3` / `node:sqlite` / `new Database(` / `DATABASE_URL` 扫描。
- 前置机制已验证（14C-2C/14C-6）：`tsconfig.cf.json` 将 `@/db` → `cloudflare-stub.ts`、
  `@/db/node-singleton` → stub，D1 repository 通过 `Symbol.for("__cloudflare-context__")`
  检测 runtime 并经 `setRepositoryFactory` 注入。

---

## 4. STEP 3 — Wrangler Config Audit ❌ 不匹配

根 `wrangler.jsonc` 仍是 **prototype 配置**，不是生产配置：

| 项 | 期望（生产） | 实际（当前） |
|---|---|---|
| Worker name | `domain-monitor` | `domain-monitor-main-cf-prototype` ❌ |
| main | `.open-next/worker.js`（须存在）| 同，但目标文件不存在 ❌ |
| D1 binding `DB` | production `domain-monitor`（`4437f46a-…`）| `domain-monitor-prototype-main`（placeholder UUID `0000…0002`）❌ |
| ASSETS | `.open-next/assets` → `ASSETS` | 同 ✅ |
| CONFIG vars | 仅名称检查 | 含 prototype fake `ENCRYPTION_KEY` + fake Telegram endpoint ❌ |
| Cron | `0 * * * *` | 无 `triggers.crons` ❌ |

- 生产专用 wrangler 配置**不存在**（全仓库仅 prototype 三个 + 根 prototype 一个）。
- 14C-9A-2 用的 throwaway `/tmp/dm-prod-14c9a2/wrangler.jsonc` 已不存在。
- 未修改 `domain-check`（其 cron 为 `0 8 * * *`，KV + plain-text secrets，非本架构）。✅

---

## 5. STEP 4 — Production D1 Read-Only Check ✅ PASS

| 项 | 值 |
|---|---|
| D1 identity | `domain-monitor`（id `4437f46a-…`，region APAC）✅ |
| `d1_migrations` rows | **8**（0000–0007）✅ |
| business tables | **13** ✅ |
| num_tables | 14（13 业务 + `d1_migrations`）|

业务表 row counts（与 14C-9B PASS 完全一致）：

| table | count | table | count |
|---|---|---|---|
| domains | 3 | notification_deliveries | 7 |
| dns_records | 30 | notification_events | 7 |
| dns_snapshots | 5 | notification_rules | 5 |
| ssl_certificates | 3 | notification_secrets | 1 |
| ssl_snapshots | 4 | admin_settings | 1 |
| http_snapshots | 4 | expiration_reminders | 1 |
| notification_channels | 1 | | |

- 未重新 import，未修改业务数据。✅

---

## 6. STEP 5 — Secret Preflight ❌ BLOCKED

生产 Worker 所需 secrets 状态：

| secret | 状态 |
|---|---|
| ENCRYPTION_KEY | **missing** |
| SESSION_SECRET | **missing** |
| Telegram token | **missing** |

依据（只读，无值输出）：

- 源 SQLite `admin_settings` 行：`session_secret` 有值（DB 内持久化，len 64），
  `encryption_key = null`；`notification_secrets` 含 1 条 ciphertext（channel 1, key `token`）。
- 代码逻辑（`src/lib/auth/admin-db.ts`、`src/db/adapters/d1.ts`）：
  - `getSessionSecret()` / `getEncryptionKey()` **优先取 `process.env.SESSION_SECRET` /
    `process.env.ENCRYPTION_KEY`**，DB 值仅为 fallback。
  - 生产推荐用 env secret 保证跨重启稳定；`encryption_key` 为 null 时若 env 缺失则
    `getEncryptionKey()` 直接 throw。
- 未输出任何 secret value / ciphertext / Authorization / token。✅
- **未自行生成替代 production secret**（遵守裁决）。❌ → 因此 BLOCKED。

> 需要用户提供生产 `ENCRYPTION_KEY`、`SESSION_SECRET`、Telegram bot token（用于
> `wrangler secret put`），且 `ENCRYPTION_KEY` 必须与已迁移 ciphertext 的加密密钥一致，
> 否则 `getChannelSecret` 解密失败。

---

## 7. Token 权限边界（探测结果）

- `cf_d1_token.txt`（`cfat_…`，account-scoped）：
  - ✅ D1 read（`/d1/database` → 200，3 库）
  - ✅ D1 write（14C-9A-2 已证明 `wrangler d1 create` 成功）
  - ✅ Workers read（`/workers/scripts` → 200，4 worker；`/settings` → 200）
  - ⚠️ Worker **deploy（write）权限未确认**：`/user/tokens`、`/accounts/{id}/tokens` 均 403
    （`cfat_` token 不支持这些端点），无法自列 scope。
- 未执行任何写探测（避免留下非预期 deploy 副作用）。

---

## 8. STEP 6–9 — 未执行

因 STEP 2/3/5 均 BLOCKED，未执行 `wrangler deploy`、Worker smoke、scheduled 验证、
post-deploy safety。

---

## 9. Security

- 全程未打印 token / ENCRYPTION_KEY / SESSION_SECRET / ciphertext / Authorization。
- `domain-check` 的 `TGTOKEN` 等 plain-text secret 在只读 API 响应中出现，但**未转抄到本报告**。
- 0 remote write / 0 deploy / 0 DNS / 0 secret write / 0 real notification / 0 commit。

---

## 10. Rollback

未部署，无需回滚。生产 D1 `domain-monitor` 保持 14C-9B PASS 状态（13 表 72 行）。

---

## 11. FINAL STATUS

# BLOCKED

4 个 blocker（均需用户决策或提供，无法自行解决）：

1. **`.open-next/worker.js` 缺失** — OpenNext build 未完整跑通（历史内存不足 SIGKILL）。
2. **`scheduled()` 未接入生产 Worker entry** — 需建立 fetch+scheduled 合并的生产入口。
3. **根 `wrangler.jsonc` 是 prototype 配置** — 需一份生产配置（name/DB binding/cron）。
4. **生产 secrets 缺失** — ENCRYPTION_KEY / SESSION_SECRET / Telegram token 需用户提供，
   禁止自行生成。

**立即 STOP。** 等待用户就上述 4 项给出指示。
