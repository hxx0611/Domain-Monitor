# Phase 14C-9B — Production D1 Data Import & Parity

**FINAL STATUS = DATA MIGRATION PASS**

**日期**：2026-08-28（Asia/Shanghai）
**阶段**：Phase 14C-9B（生产 D1 数据导入与 parity 验证）

---

## 1. Source of Record

| 项 | 值 |
|---|---|
| 来源 | NFS 备份快照 |
| 文件 | `domain-monitor-backups/domain-monitor-2026-08-25T06-50-52-042Z.db` |
| 时间戳 | 2026-08-25 06:50:52 UTC |
| 大小 | 126,976 bytes |
| 只读确认 | 导入全程 `readonly: true` 打开；导入后 mtime 保持 `2026-08-25 06:50:52.072556468 +0000`，**未修改** |

用户已裁决：生产 Node 已停止。Source of Record = 2026-08-25 06:50 NFS backup。

---

## 2. Source Integrity（Step 1）

| 检查项 | 结果 |
|---|---|
| `PRAGMA integrity_check` | `ok` ✅ |
| `PRAGMA foreign_keys` | `1`（ON）✅ |
| `PRAGMA foreign_key_check`（13 表） | **0 violations** ✅ |
| migration 记录 | 8 条（drizzle `__drizzle_migrations`）✅ |
| schema | 0000–0007 全部覆盖 ✅ |
| 文件只读 | 全程 readonly，未写入 ✅ |

> 说明：source backup 的迁移追踪表是 drizzle 格式 `__drizzle_migrations`（含 8 条 hash 记录，非业务表）。该表**不导入**——生产 D1 使用 wrangler 的 `d1_migrations` 追踪（见 §7）。两者都对应 0000–0007 八个迁移。

---

## 3. D1 Identity（脱敏）

| 项 | 值 |
|---|---|
| database name | `domain-monitor` |
| account_id | `b9dd2cfe…`（已截断脱敏） |
| database_id | `4437f46a-…`（已截断脱敏） |
| 区域 | APAC |
| version | production |
| num_tables | 14（13 业务表 + `d1_migrations`） |

导入前确认（Step 2）：
- 0000–0007 migration **8/8 已应用** ✅
- 13 业务表**全部为空**（count = 0）✅
- schema 与 source **完全一致**（13 表全部列逐列比对）✅
- 无未知 migration / 无未知表结构 ✅

---

## 4. Import Method

- **复用已验证工具链**：`migrate.ts` 的 `exportAll` / `TABLES` 清单逻辑（Phase 14C-6/14C-3 验证），未重新设计第二套 importer。
- **导出**：`prototype/cloudflare/14c9b/dump-source.cjs` — 以 readonly 打开 source，`SELECT *` 导出 13 表全部行列到便携 manifest（`/tmp/14c9b-manifest.json`）。secret/ciphertext 值原样保留在 manifest 中，但**绝不打印**（仅输出 shape/length 元数据）。
- **导入**：`prototype/cloudflare/14c9b/import-d1.cjs` — 通过 Cloudflare D1 HTTP REST API，参数化（`?` 占位符）multi-row `INSERT`，按 **FK 拓扑顺序**（子表后于父表）导入。
- **关键安全设计**：
  - 参数化绑定（非字符串拼接）→ ciphertext / config 字符串 byte-for-byte 保留，无 SQL 注入。
  - FK 拓扑顺序 → 每条 INSERT 天然满足 D1 真实 FK 约束（D1 每 `/query` 独立会话，无法关闭 FK，拓扑顺序是更强的保证）。
  - D1 单条 SQL 变量上限 100（实测 100 OK / 120 FAIL），脚本按 `MAX_PARAMS=100` 分批。
- **dry-run**：导入前先 `--dry-run` 确认 13 表共 72 行、参数数正确。
- **幂等/回滚**：中途因变量超限失败，已用 FK 逆序 `DELETE FROM` 回滚至空库后完整重跑（目标 D1 本为空库，回滚=回到空库，安全）。

导入结果：13 表全部 `changes == source`，无 mismatch。

---

## 5. Per-Table Parity

| 表 | source | D1 | diff |
|---|---|---|---|
| domains | 3 | 3 | 0 |
| dns_records | 30 | 30 | 0 |
| dns_snapshots | 5 | 5 | 0 |
| ssl_certificates | 3 | 3 | 0 |
| ssl_snapshots | 4 | 4 | 0 |
| http_snapshots | 4 | 4 | 0 |
| notification_channels | 1 | 1 | 0 |
| notification_deliveries | 7 | 7 | 0 |
| notification_events | 7 | 7 | 0 |
| notification_rules | 5 | 5 | 0 |
| notification_secrets | 1 | 1 | 0 |
| admin_settings | 1 | 1 | 0 |
| expiration_reminders | 1 | 1 | 0 |
| **总计** | **72** | **72** | **0** |

**所有表 diff = 0** ✅

> 已知 baseline（domains=3, dns_records=30, dns_snapshots=5, ssl_certificates=3, ssl_snapshots=4, http_snapshots=4, notification_channels=1, notification_deliveries=7, notification_events=7, notification_rules=5, notification_secrets=1, admin_settings=1, expiration_reminders=1）与 source 实际值**完全一致**。

---

## 6. Key Business Field Parity

全部按 `ORDER BY id` 序列化比对，JSON 全等：

| 表 | 字段 | 结果 |
|---|---|---|
| domains | hostname, status, expiration_date, expiration_source, registration_provider, registration_provider_url | ✅ 3/3 全等 |
| dns_records | snapshot_id, name, type, value, ttl | ✅ 30/30 全等 |
| notification_channels | type, enabled, config（config 按 SHA-256 比对，不输出） | ✅ 1/1 全等 |
| notification_events | source, event_type, domain_id, dedup_key, occurred_at | ✅ 7/7 全等 |
| notification_deliveries | event_id, channel_id, status, attempts, error | ✅ 7/7 全等 |
| expiration_reminders | domain_id, days_before | ✅ 1/1 全等 |

> 补充：dns_records 用 snapshot_id（schema 实际列名）而非 domain_id——dns_records 通过 snapshot_id 关联 dns_snapshots 再关联 domains。

---

## 7. Migration Metadata

| 检查项 | 结果 |
|---|---|
| `d1_migrations` 计数 | 8 ✅ |
| 名称序列 | `0000_careless_penance.sql` → `0007_manual_expiration.sql` 全部存在，顺序正确 ✅ |
| migration SQL | **未修改、未重新执行**（沿用 Phase 14C-9A-2 已应用的 0000–0007）✅ |

---

## 8. Secret Ciphertext Parity（仅 PASS/FAIL，不显示值）

| 检查项 | 结果 |
|---|---|
| notification_secrets 行数 | source=1, D1=1 ✅ |
| id / channel_id / key | match ✅ |
| encrypted_value（AES-256-GCM `iv:tag:ciphertext`） | **SHA-256 全等 → byte-for-byte 一致** ✅ |
| 格式（3 段 base64，106 字符） | ok ✅ |
| 解密 | **未解密**（全程无 plaintext 输出）✅ |
| token / ENCRYPTION_KEY | **未输出** ✅ |
| 重新生成 secret | **未发生**（直接复制 ciphertext）✅ |

**Ciphertext parity = PASS**

---

## 9. FK / UNIQUE 完整性

**FK（D1 侧 12 条关系，孤儿检查）：0 violations** ✅

- dns_snapshots.domain_id → domains.id
- dns_records.snapshot_id → dns_snapshots.id
- ssl_snapshots.domain_id → domains.id
- ssl_certificates.snapshot_id → ssl_snapshots.id
- http_snapshots.domain_id → domains.id
- expiration_reminders.domain_id → domains.id
- notification_events.domain_id → domains.id
- notification_rules.channel_id → notification_channels.id
- notification_rules.domain_id → domains.id
- notification_deliveries.event_id → notification_events.id
- notification_deliveries.channel_id → notification_channels.id
- notification_secrets.channel_id → notification_channels.id

**UNIQUE（D1 侧 5 组约束，GROUP BY HAVING COUNT>1 检查）：0 violations** ✅

- domains(hostname)
- notification_events(dedup_key)
- notification_deliveries(event_id, channel_id)
- notification_secrets(channel_id, key)
- expiration_reminders(domain_id, days_before)

---

## 10. 全表 Byte-for-Byte Hash Parity（最强验证）

对 13 表**所有列**做确定性序列化（ORDER BY id）后 SHA-256 比对：

**ALL 13 TABLES BYTE-FOR-BYTE IDENTICAL** ✅

覆盖：ciphertext、password_hash、session_secret、timestamps、dedup_key、error 字符串等所有列，证明完整迁移无任何字段漂移。

---

## 11. Business Smoke（只读）

| 检查项 | 结果 |
|---|---|
| domains 可读取 | 3 条 ✅ |
| expiration/reminder 可读取 | 1 条（JOIN domains 成功）✅ |
| notification events 可读取 | 7 条 ✅ |
| notification deliveries 可读取 | 7 条 ✅ |
| secret 状态 | configured=1（仅确认存在，**未读取/未输出值**）✅ |
| Telegram 发送 | **未发送** ✅ |

---

## 12. Security

- ciphertext 全程以参数化方式传递，**零 plaintext 输出**。
- 无任何 token、bot token、ENCRYPTION_KEY、session_secret、password_hash 值进入日志/报告/源码。
- import/verify 脚本不打印任何行值、config 内容、secret 值。
- 报告仅输出 hash 比较结果（SHA-256），不显示值。
- 脚本位于 `prototype/cloudflare/14c9b/`（untracked），未进入 Git。

---

## 13. Production Safety（禁止项遵守）

| 禁止项 | 状态 |
|---|---|
| wrangler deploy | 未执行 ✅ |
| DNS 修改 | 未执行 ✅ |
| Worker 修改 | 未执行 ✅ |
| Cron Trigger | 未创建 ✅ |
| production secret 写入 | 未执行（仅 INSERT 既有 ciphertext）✅ |
| Telegram/Webhook/Email 发送 | 未发送 ✅ |
| domain-check 修改 | 完全未触碰 ✅ |
| 删除现有 Cloudflare 资源 | 未删除（仅 DELETE 自己的半迁移数据回滚至空库，目标本就是空库）✅ |
| commit / push / tag / release | 未执行 ✅ |

---

## 14. Rollback Status

- **导入失败回滚已验证**：变量超限时用 FK 逆序 `DELETE FROM` 成功回滚至空库。
- **当前状态**：13 表 72 行已完整导入并通过全部 parity 验证。
- **生产 Node 已停止**（用户裁决）→ rollback = 继续 Node production 的前提不复存在；当前 rollback 路径为：如需回退，可对 D1 执行 FK 逆序 `DELETE FROM` 回到空库（脚本逻辑已验证）。
- 本阶段**不部署 Worker、不配置 secrets、不切 DNS、不创建 Cron、不发通知**。

---

## 15. 最终判定

| 关键项 | 结果 |
|---|---|
| source integrity | PASS |
| schema parity | PASS |
| 13 表 count diff = 0 | PASS |
| key-field parity | PASS |
| FK violations = 0 | PASS |
| UNIQUE violations = 0 | PASS |
| migration state 0000–0007 | PASS |
| ciphertext byte-for-byte | PASS |
| business smoke | PASS |
| 全表 hash parity | PASS |

**FINAL STATUS = DATA MIGRATION PASS**

---

## 附：本阶段产物

- `prototype/cloudflare/14c9b/dump-source.cjs` — 只读导出 manifest（不打印 secret）
- `prototype/cloudflare/14c9b/import-d1.cjs` — 参数化分批导入（FK 拓扑顺序，--dry-run 支持）
- `prototype/cloudflare/14c9b/verify-parity.cjs` — 逐表 count / key-field / FK / UNIQUE / migration / ciphertext-hash / smoke
- `prototype/cloudflare/14c9b/verify-hash.cjs` — 13 表全列 byte-for-byte hash 比对
