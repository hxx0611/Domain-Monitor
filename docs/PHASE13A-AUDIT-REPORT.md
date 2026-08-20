# Phase 13A — 全面代码审计报告

- **审计日期**: 2026-08-20
- **审计范围**: Domain-Monitor 仓库（HEAD `28499d1` = v0.8.8）+ 生产实例（`/tmp/domain-monitor`）
- **方式**: 只读审计（源码通读 + 生产对照 + 双子代理独立安全/测试审计）+ 本地验证（813/813 测试全绿）
- **结论**: 代码质量高、安全面干净、文档基本准确。发现 3 项高价值待办（补测试、恢复备份、文档漂移）与若干低危卫生项。

---

## STEP 1 · 版本与部署状态

| 项                     | 状态                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 仓库 HEAD              | `28499d1` (chore: release v0.8.8) ✅                                                                  |
| CHANGELOG 版本         | v0.8.0 → v0.8.8 共 9 个条目 ✅                                                                        |
| Git tags               | v0.5.0 → v0.8.8 全齐 ✅                                                                               |
| GitHub open issues/PRs | 0 ✅                                                                                                  |
| 生产 next-server       | PID 88981，启动 2026-08-20 05:28（v0.8.8 部署后）✅                                                   |
| 生产 BUILD/RUNTIME     | 已对齐（记忆：build v-M2WlDkau1KzS8cxthNS）✅                                                         |
| 生产进程拓扑           | supervisord(PID1) / cloudflared 12064 + watchdog 12031 / worker-watchdog 65004 / next-server 88981 ✅ |
| CI 最新 run            | `32341126438` (28499d1) success ✅                                                                    |

## STEP 2 · 源码盘点

- **规模**: 150 个 TS/TSX 文件（26,639 行）+ 55 个测试文件（813 测试）
- **lib 模块 (10)**: auth / dns / domains / format / http / i18n / monitoring / notifications / rdap / ssl
- **路由 (6)**: `/` `/domains/[id]` `/notifications` `/login` `/setup` `/recover`
- **组件 (21)**，**Server Action 模块 (7)**，**脚本 (17)** 含 watchdog 与 worker CLI

## STEP 3 · 生产对照

- 生产 `.env`：存在，权限 `600 root:root` ✅（291B，不含明文 token/ENCRYPTION_KEY 泄露到任何其他位置）
- 生产 DB：`/tmp/domain-monitor/data/domain-monitor.db`（124KB）
- 生产数据目录含 5 个 `.next.v0*` 预发布备份目录（磁盘堆积，非安全问题）
- **发现**: 生产 DB 文件权限 `644 root:root`（见 TOP-5 #4）

## STEP 4 · Worker / Service / Expiration 状态机

**runOnce 链路（worker.ts）**：`evaluateExpirationReminders` → `recoverStaleSending` → `getPendingDeliveries` (FIFO, limit 50) → 每 delivery `getEvent` → `getChannel` → `createSender` → `deliverDelivery`。**无 auto-retry、无调度、单 tick、不接触 secrets**（在 sender 内 send-time 读取）。

**deliverDelivery 状态机（service.ts）** — 严谨 ✅：

- 原子 CAS `claimPendingDelivery`：并发 worker 竞争只有 1 个赢家，输家 `skipped`，绝不双发
- channel 缺失/disabled → `markDeliveryFailed`（不卡在 sending）
- sender 类型不匹配 → `markDeliveryFailed`（类型安全）
- sender 抛错 → 捕获后 `markDeliveryFailed`（错误消息保证无 secret）
- **只有 send() 成功解析才 `markDeliverySent`**（at-least-once 语义）
- 外层 backstop catch：单个 delivery 失败绝不影响批内其余

**验证**: 无直接测试产出（此前 Phase 11A/11G 已验证），本地 813/813 全绿含 worker/repository/delivery 状态机测试。

## STEP 5 · RDAP / 域名 Service

此前 Phase 10A/10C/10D 已审计验收：`queryRdapWithFallback`（not-found/无日期 → parent，其余错误不 fallback，不查裸 TLD）、ownership 判定（对象 LDH identity，canonical mismatch → parent）、`updateDomainRdap` 全链路。本阶段复核无新增问题。
**已知未处理（记录于 backlog，非本次新增）**: opusai.eu.cc 污染数据（10C）；RDAP fallback 语义 bug（10C 推荐方案 K）。

## STEP 6 · 安全审计（子代理独立执行）— 全 PASS

| 审计区                                          | 结果                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram token / AAH_ 模式扫描                  | src 仅测试 fixture（5 文件，内容含 test/fake 字样，fetch 全 stub）；`.next`（工作区+生产+5 个旧 build）0 匹配；生产日志 0；git 全历史 0；客户端 bundle/RSC payload 0；DB 仅密文（AES-256-GCM iv:tag:ct 三段）；delivery.error 已脱敏；进程 env 无 TELEGRAM_BOT_TOKEN |
| ENCRYPTION_KEY / SESSION_SECRET / recovery code | ENCRYPTION_KEY 仅存在于生产 `.env`（600）；SESSION_SECRET 按设计明文存 `admin_settings`（schema 注释说明，recovery 时轮换）；recovery code 仅 scrypt hash；git/build/logs/client 0 匹配                                                                              |
| Server Action 授权                              | 7 个 action 模块全部审计：**所有 mutating 动作首行 `requireAdmin()`** ✅；auth/actions（setup/login/logout/recover）与 i18n setLocale 为有意公开 ✅                                                                                                                  |
| Secret 仓库                                     | AES-256-GCM 随机 IV + tag 验证；`timingSafeEqual` 用于 scrypt/HMAC；错误全泛化无 key/ciphertext/plaintext；`server-only` 双模块不可进 client bundle；prod 缺 ENCRYPTION_KEY 即抛错                                                                                   |
| 错误路径泄漏                                    | Telegram sender `sanitizeTelegramDescription` 脱敏 token/URL 形子串+200 截断；解密失败 → `"Telegram token decryption failed."` 不 fallback env；Email/Webhook 只报 env ref 名；overview 只返回 ref 名布尔                                                            |
| **结论**                                        | **无真实 secret 泄漏**。唯一 matches 是正确位置的密文/哈希/测试 fixture                                                                                                                                                                                              |

**附带观察（非发现）**: start.log 有一条 Next.js "Failed to find Server Action" 旧 bundle 部署残留错误，无泄漏。

## STEP 7 · DB Migration / Schema 审计

- **migration journal**: 生产 `__drizzle_migrations` 8 条 = 仓库 8 个文件（0000_careless_penance → 0007_manual_expiration）✅
- **表**: 生产 14 tables 与 `schema.ts` 一致 ✅
- **domains 列**: 15 列含 0007 的 `expiration_source` / `registration_provider` / `registration_provider_url` ✅
- **notification_channels 列**: 无独立 timezone 列——符合 11J 设计（timezone 在 `config` JSON，零迁移）✅
- **FK**: `PRAGMA foreign_key_check` 0 违反 ✅
- **indexes**: 12 个（unique: domains_hostname / events_dedup / deliveries_event_channel / secrets_channel_key / reminders_domain_days）✅

## STEP 8 · 测试覆盖审计（子代理独立执行）

- **执行**: `vitest run` 55 files / 813 tests / 37.7s / 全绿，无 skip/pending
- **覆盖结构**: notifications 31%、senders 14%、ssl 11%、dns 10%、http 10%、rdap 7%、auth 6%、i18n 5%、domains 5%、monitoring 1%
- **优点**: 20/55 为 DB 集成测试（real better-sqlite3 :memory: + 全 migration 0000-0007 + FK 强制）；SSRF 矩阵 38 测试；rdap-link 用真实文件 DB；默认套件零真实网络

### 测试缺口（按优先级）

| 优先级 | 缺口                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 高  | **`src/lib/domains/actions.ts`（248 行）无测试** — create/update/refreshRdap/delete 四大 action，最大未测业务面；`src/lib/dns/actions.ts`（39 行）同                                                 |
| 🟠 中  | `domains/repository.ts`（284 行）无专门测试；`senders/factory.ts`（含真实 getChannelSecret 接线，11D 文档化的 react-server barrel bug 类无回归测试）；`domain-form-labels.ts`、`format.ts` 未直接测  |
| 🟡 低  | `src/db/index.ts` bootstrap（mkdir/busy_timeout/多进程）未测；**无 schema-drift 测试**（schema.ts 与 SQL migrations 漂移只能运行时爆炸）；7 个 `scripts/*.test.ts` smoke（真实网络）被 CI 排除成孤儿 |

### 测试套件自身卫生问题

- `test-notification-integration.test.ts` 模块级设 `process.env.ENCRYPTION_KEY` 无 restore
- `createTestDb()` 从不关闭 better-sqlite3 handle（~200+ in-memory DB/run，watch 模式累积）
- 负测试的 service 错误日志打印 stderr 噪音，易误读为失败
- Windows EPERM 只在 rdap-link 处理（db/index.ts 同类 bug 未测）；Vite config ESM-in-CJS 警告

## STEP 9 · CI 审计

- **workflow**: `ci.yml` 两个 job — `build-and-lint` Node 22/24/26 矩阵（`pnpm install --frozen-lockfile` → lint → test → format:check → build）+ `windows-fresh-install` Node 24（fresh install 守卫，防 node-gyp 源码编译）
- **最新 run** `32341126438` success ✅（v0.8.8）
- 历史 failure（4f310fb/ed2c912/d89caf1）均已由后续 commit 修复（6cca1f7 Windows EPERM 修复 → 28499d1 绿）
- 设计合理：CI 是纯净环境基线，真实网络 smoke 有意排除（手动）

## STEP 10 · 文档审计

- README 部署模型与生产一致（watchdog 启用、worker CLI、at-least-once 语义）✅
- CHANGELOG 9 个版本条目准确 ✅
- docs/ 12 个文件 + screenshots ✅
- Handover "AI CONTINUATION RULES" 14 条与当前执行纪律一致 ✅
- **发现（文档漂移）**: README Roadmap 只列到 v0.8.3，未含 v0.8.4–v0.8.8（11G-A send test / 11J timezone / 12A Windows 修复）；`.env.example` 未记录 `DNS_DOH_ENDPOINT` 与 `ENCRYPTION_KEY`（handover §11 已知项，doc-only 改动需批准）

## STEP 11 · UI / UX 审计

- **Dashboard**: domain 表 + manual badge + provider 管理链接 + 空状态 ✅
- **Domain 详情**: RDAP 区（expirationSource manual badge、provider 链接、reminders 内联）、DNS 区（snapshot diff、按类型分组记录、10 条历史）、SSL 区（badge + 证书详情 + 指纹 break-all + 历史）、HTTP 区（状态/重定向/finalUrl + 历史）✅
- **Edit form**: expirationSource 切换 / manual 日期 / provider preset+custom / reminders preset+custom 删除 chips ✅
- **Notifications**: Channels / Rules / Deliveries 三表 + test-notification 按钮 ✅
- **发现（低）**: domain status badge 恒绿（status 仅 active 一种值，可接受）；无分页（deliveries 随事件增长——需确认 repository limit，未阻断）；导航为原生页面切换（无 skeleton）

## STEP 12 · Backlog / 已知项

- **GitHub**: 0 open issues
- **Handover §11 未完成项**: ① 定期本地备份未恢复（operator decision）② R2 Object Versioning（推荐）③ 备份失败告警 ④ 容器重建自动启动 next-server（需平台支持/迁移）⑤ `.env.example` 补文档（doc-only）
- **已知风险（记忆，未处理）**: opusai.eu.cc 污染数据（10C）；RDAP fallback 语义 bug（推荐方案 K）
- **本阶段新增**: 生产 DB 文件 644 权限；`.next.v0*` 旧 build 目录 ×5 堆积；无 schema-drift 测试

---

## STEP 13 · TOP 5 推荐（按价值/成本比）

### 1. 🔴 补 `domains/actions.ts` + `dns/actions.ts` 测试（约 0.5–1 天）

最大未测业务面（287 行），其他所有 action 层都有测试。照 `http/actions.test.ts` 模式：mock service/`requireAdmin`/`next/cache`。直接消除"业务核心逻辑无回归保护"的最大漏洞。

### 2. 🔴 恢复定期备份 + 备份失败告警（约 0.5 天 + 运维决定）

Handover 未完成项 #1。当前生产**零定期备份**（仅 1 个 9J 阶段手动备份 `domain-monitor.db.9J-backup-*`）。DB 是全部状态（domains/events/deliveries/secrets 密文）。建议：cron + `sqlite3 .backup` 或 `cp` 到 `/tmp/domain-monitor/backups/` 并 rsync 到 R2（配合 R2 versioning），失败时发通知。

### 3. 🟡 修复文档漂移：README Roadmap → v0.8.8 + `.env.example` 补键（约 15 分钟）

README 落后 5 个版本，未来 agent/读者会误判版本状态。`.env.example` 补 `DNS_DOH_ENDPOINT` / `ENCRYPTION_KEY`（handover 已列为 doc-only 待批）。低风险纯文档 commit。

### 4. 🟡 生产 DB 文件权限 `644 → 600`（约 1 分钟）

与 `.env` 对齐。DB 内 secrets 虽加密，但域名/快照数据对同机其他用户不应可读。`chmod 600 /tmp/domain-monitor/data/domain-monitor.db`（需批准——属于生产变更）。

### 5. 🟡 卫生项打包（约 1–2 小时）

- **schema-drift 测试**: 防 schema.ts 与 migrations 漂移运行时爆炸（低成本高长期价值）
- **清理 5 个 `.next.v0*` 旧 build 目录**（磁盘卫生）
- **测试卫生**: `test-notification-integration` env restore、`createTestDb` 生命周期
- 可选: 把 `scripts/*smoke.test.ts` 纳入 CI 可选 job 或文档化（避免孤儿）

---

## 附录 · 审计方法

- 本地验证: `vitest run` 55 files/813 tests 全绿（子代理执行）
- 双子代理并行: 安全审计（token/key/action 授权/secret 仓库/错误路径扫描）+ 测试覆盖审计
- 生产只读检查: 进程/PID、.env 权限、DB schema/journal/FK、migration 文件、CI 状态、git 历史
- 所有 secret 值未在任何输出中出现；AAH_ 测试 fixture 已确认为伪造（内容含 test/fake 字样）
- 全程零写入生产、零真实网络调用、零 secret 接触

---

## Post-Audit Status

> 追加于 2026-08-20（Phase 13E 归档时）。本附录记录 13A 审计之后各后续 Phase 的真实状态。
> 上文的原始审计结论与历史事实未作任何修改；下文仅记录后续已发生的事实与当前仍有效的 backlog。

### 已完成（审计后）

1. **Domain / DNS action test coverage**
   - Phase 13B（2026-08-20）
   - `src/lib/domains/actions.test.ts`（31 tests）+ `src/lib/dns/actions.test.ts`（5 tests）= **36 tests**
   - 消除 13A TOP-5 #1（最大未测业务面 `domains/actions.ts` + `dns/actions.ts`）
   - 全量测试达到 **849/849**（13A 时 813/813）；tsc / lint / prettier 0；业务代码零修改
   - commit `a6be6b6`（`test: expand domain and dns action coverage`）已 push

2. **Production backup（恢复定期备份 + 失败告警）**
   - Phase 13C + 13C-1（2026-08-20）
   - 采用 **better-sqlite3 官方 SQLite online backup API**（在线一致性快照，只读源 DB）
   - backup 脚本 `/tmp/domain-monitor/scripts/backup-db.js`（权限 600）
   - backup 目录：NFS 持久路径（工作区外，跨容器持久，非 /tmp overlay）
   - backup 文件权限 = 600；不进入 Git
   - 保留策略：**7 天**（自动清理超过 7 天的 backup，不删生产 DB、不删非 backup 文件）
   - **每日自动调度**：QwenPaw cron `domain-monitor-daily-backup`（`0 13 * * *` Asia/Shanghai，agent 类型 silent）
   - **失败告警**：backup 失败 → exit 1 + `backup-failures.log` → Telegram 告警（仅 timestamp / exit / 简短错误摘要，无 secret）
   - **restore drill PASS**（恢复演练通过）；备份可恢复、integrity ok
   - 已关闭 13A Handover §11 未完成项 ①（定期本地备份）与 ③（备份失败告警）

3. **SQLite → NFS migration preflight**
   - Phase 13D（2026-08-20）
   - **FINAL STATUS = STOP / Migration blocked**
   - 原因：当前 **NFSv3 + `nolock`** mount 不适合作为 SQLite production DB 存储（SQLite locking 语义、网络文件系统可靠性、fsync/write-cache 语义、hard mount 挂起行为）
   - 因此 **没有迁移 production DB**

### 当前生产策略（截至归档时的实际状态）

- **Production SQLite remains:**
  `/tmp/domain-monitor/data/domain-monitor.db`
- **Production backup remains on NFS persistent storage.**
- 未执行 SQLite → NFS 迁移；本地 DB persistence 风险（容器重建丢失）由每日 NFS backup 缓解，**并未消除**。

### 后续建议（未实施）

- **PostgreSQL 是长期持久化数据库的推荐方向**（消除 SQLite-on-NFS 的 locking / fsync 风险）
- 或使用**支持可靠 SQLite locking 语义的本地持久卷**（非 NFSv3/nolock）
- **当前不推荐将 SQLite DB 直接放在现有 NFSv3/nolock mount**
