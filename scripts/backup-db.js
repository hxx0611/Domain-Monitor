#!/usr/bin/env node
/**
 * Domain-Monitor 生产数据库备份脚本 (backup-db.js)
 *
 * 用法: node scripts/backup-db.js
 *
 * 行为:
 *   - 使用 SQLite `VACUUM INTO` 对生产 D1 数据库做事务性一致性快照
 *     (会包含 WAL 中所有已提交但未 checkpoint 的数据, 比单纯 cp 主文件安全)
 *   - 备份输出到持久卷目录(容器重建不丢失):
 *       默认 /run/csi/mount-root/nas/4079184d856ecc166ed19d4887083405/workspaces/default/domain-monitor-backups/
 *   - 文件名格式: domain-monitor-<UTC时间戳>.db
 *   - 保留最近 7 天, 自动清理更早的备份
 *   - 备份文件模式 0400 (只读, 防篡改)
 *
 * 安全约束:
 *   - 仅做文件级复制, 绝不读取/解密/打印数据库中的任何密文或密钥。
 *   - 不打印 token, ENCRYPTION_KEY, SESSION_SECRET, 密文等敏感内容。
 *
 * 退出码:
 *   0 = 成功
 *   1 = 失败 (源数据库不可读 / 输出目录不可写 / VACUUM INTO 失败)
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// ---- 可配置(可用环境变量覆盖) ----
// 生产 D1 数据库路径 (wrangler 本地镜像, WAL 模式下以 .wrangler/state/v3/d1 为准)
const DB_PATH =
  process.env.DOMAIN_MONITOR_DB ||
  path.join(
    __dirname, "..",
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
    "3dd27f64a8e6b7092b4dc42ea2a5f93d01d65d27a0f4927b2e4bc344a6a2f6f6.sqlite",
  );

// 备份输出目录 (持久卷)
const BACKUP_DIR =
  process.env.DOMAIN_MONITOR_BACKUP_DIR ||
  "/run/csi/mount-root/nas/4079184d856ecc166ed19d4887083405/workspaces/default/domain-monitor-backups";

// 保留天数
const RETENTION_DAYS = Number(process.env.DOMAIN_MONITOR_RETENTION_DAYS || 7);

// ---- 辅助: 生成 UTC 文件名时间戳 (与旧备份格式一致: domain-monitor-YYYY-MM-DDTHH-MM-SS-<3位>.db) ----
function utcTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}` +
    `-${pad(Math.floor(d.getUTCMilliseconds() / 10))}Z`
  );
}

// ---- 辅助: 安全执行 VACUUM INTO (用 better-sqlite3 从项目 node_modules 加载) ----
function runVacuumInto(srcDb, destFile) {
  // 从项目根 node_modules 解析 better-sqlite3
  const betterSqlite3 = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new betterSqlite3(srcDb, { readonly: false });
  try {
    // 先把 WAL 数据 checkpoint 落盘, 确保快照包含全部已提交数据
    db.pragma("wal_checkpoint(TRUNCATE)");
    // VACUUM INTO 生成一致性快照 (路径需单引号包裹)
    const sql = `VACUUM INTO '${destFile.replace(/'/g, "''")}'`;
    db.exec(sql);
  } finally {
    db.close();
  }
}

// ---- 辅助: 清理过期备份 ----
function pruneOldBackups(dir, keepDays) {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("domain-monitor-") || !name.endsWith(".db")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        pruned++;
      }
    } catch (_) {
      /* ignore */
    }
  }
  return pruned;
}

// ---- 主流程 ----
function main() {
  // 0. 前置检查
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backup-db] ERROR: 源数据库不存在: ${DB_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    console.error(`[backup-db] ERROR: 备份目录不存在: ${BACKUP_DIR}`);
    process.exit(1);
  }

  const destFile = path.join(BACKUP_DIR, `domain-monitor-${utcTimestamp()}.db`);

  try {
    // 1. 事务性快照
    runVacuumInto(DB_PATH, destFile);
  } catch (err) {
    console.error(`[backup-db] ERROR: 备份失败 (VACUUM INTO): ${err.message}`);
    process.exit(1);
  }

  // 2. 验证产物
  if (!fs.existsSync(destFile) || fs.statSync(destFile).size === 0) {
    console.error(`[backup-db] ERROR: 备份产物为空: ${destFile}`);
    process.exit(1);
  }

  // 3. 设为只读(0400), 防篡改
  fs.chmodSync(destFile, 0o400);

  // 4. 清理过期备份
  const pruned = pruneOldBackups(BACKUP_DIR, RETENTION_DAYS);

  console.log(
    `[backup-db] OK: ${destFile} (${fs.statSync(destFile).size} bytes, pruned ${pruned})`,
  );
}

main();
