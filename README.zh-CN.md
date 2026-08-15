# Domain Monitor

[English](README.md) | [简体中文](README.zh-CN.md)

一个轻量、可自托管的域名生命周期监控平台，用于 RDAP、DNS 与域名状态跟踪。

[![CI](https://github.com/hxx0611/Domain-Monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/hxx0611/Domain-Monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hxx0611/Domain-Monitor?sort=semver)](https://github.com/hxx0611/Domain-Monitor/releases)

Domain Monitor 帮助你跟踪自己拥有的域名：在本地存储域名、通过 RDAP 查询注册信息，并运行 DNS 检查以观察记录随时间的变化。

## 截图

域名详情视图，包含 RDAP 信息、DNS 记录与 DNS 变更历史。

![域名详情视图](docs/screenshots/domain-details.png)

## 功能

### 域名管理

- 添加并管理被监控的域名
- 域名规范化与校验（接受 `https://example.com/path`，存储为 `example.com`）
- 自托管本地存储（SQLite）
- 域名详情页

### RDAP 信息

- 域名创建时自动执行 RDAP 查询
- IANA bootstrap 路由（590+ TLD）
- 注册商信息
- 注册 / 到期 / 最后更新时间
- 名称服务器与 RDAP 状态
- 手动 RDAP 刷新

### DNS 监控

- 基于 DNS-over-HTTPS 的监控（Cloudflare DoH）
- A / AAAA / CNAME / MX / NS / TXT / CAA 记录
- 历史 DNS 快照
- 新增 / 移除记录检测
- 仅 TTL 变化被忽略
- 原子化失败检查处理（部分失败绝不会删除旧数据）
- 手动 DNS 检查

### SSL 证书监控

- TLS 证书检查（Node.js 原生 TLS）
- 证书到期 / 状态跟踪（有效、即将到期、已过期）
- 主机名不匹配检测（SAN 与查询域名对比）
- 证书指纹 / 替换检测
- TLS 版本与加密套件信息
- SSL 检查历史
- 手动 SSL 检查

### HTTP 健康检查

- HTTP 状态监控（状态码分类）
- 响应时间跟踪
- 重定向跟踪（次数与最终 URL）
- 连接失败检测（down）
- HTTP 检查历史
- 手动 HTTP 检查

### 通知系统

- 域名生命周期事件（DNS / SSL / HTTP 检查事件）
- 通知渠道：**Email API** 与 **Webhook**
- 基于规则的投递匹配（全局或按域名规则）
- 投递历史与状态跟踪（pending / sending / sent / failed）
- 失败投递的手动重试
- SSRF 防护的出站请求（仅 HTTPS，逐跳重定向复查）

### 投递 Worker

- 一次性 CLI Worker（`pnpm worker`），消费 `pending` 投递
- **检查事务内自动生成 Event → Delivery**
  （DNS / SSL / HTTP 检查原子地创建对应的投递）
- 过期 `sending` 恢复（崩溃安全，默认阈值 5 分钟）
- 通过原子 claim 实现并发 Worker 安全（SQLite CAS）
- 多进程 SQLite 写入启用 `busy_timeout = 5000`

### 双语 UI

- Header 支持 **English / 简体中文** 语言切换
- 语言感知的 UI 字典（所有用户可见文本均支持翻译）
- 语言偏好存储在 `domain-monitor-locale` cookie 中
  （`en` / `zh-CN`，默认 `en`）
- Cookie + Server Action + `router.refresh()` —— 无 URL 前缀、无 middleware、
  无第三方 i18n 依赖
- 机器值（投递状态、事件类型、来源）绝不翻译

## 当前状态

**当前版本：v0.7.1 — 双语 UI / 简体中文支持**

当前支持：

- 域名管理
- RDAP 信息
- DNS 监控
- SSL 证书监控
- HTTP 健康检查
- 通知系统（email / webhook 渠道、规则、投递历史、手动重试）
- 投递 Worker（自动 Event → Delivery → Send 管道，一次性 CLI + 外部 cron）
- 双语 UI（English / 简体中文，基于 cookie 的语言切换）

DNS、SSL 与 HTTP 检查目前均为手动触发；自动调度计划在未来的版本中提供。

通知管道已完全闭环：一次检查在**同一个事务**中写入其快照、事件与匹配的 pending 投递；投递 Worker 消费这些 pending 投递并调用发送器。从 UI 重试失败的投递可端到端工作。

## 通知 Worker（V0.7）

投递 Worker 是一个**一次性 CLI 进程**，消费通知管道记录的 `pending` 投递。它是在自托管部署上运行通知的推荐方式。

### 运行方式

```bash
pnpm worker             # 一个 tick，最多 50 个 pending 投递
pnpm worker --limit 10  # 将本次 tick 限制为 10 个投递
pnpm worker --limit=10  # 同上
```

Worker **运行一个 tick 后退出** —— 它从不常驻内存、不启动任何 interval、不开放 HTTP endpoint、不保留后台定时器。它向 stdout 打印一行 JSON 摘要（exit 0），或向 stderr 打印清晰的错误（参数错误或未捕获异常时 exit 1）。

摘要格式（稳定）：

```json
{ "recovered": 0, "attempted": 0, "sent": 0, "failed": 0, "skipped": 0 }
```

- `recovered` — 被移回 `pending` 的过期 `sending` 投递（崩溃恢复）
- `attempted` — 本次 tick 尝试投递的数量
- `sent` / `failed` / `skipped` — 结果（`skipped` = 并发 Worker 先 claim 了它）

Worker 从不打印密钥：不打印 API key、不打印 `Authorization`/`Bearer` 值、不打印渠道配置 JSON、不打印 endpoint 查询字符串。

### 使用 cron 调度

推荐：CLI Worker 加外部调度器（系统 cron 或等效方案）。crontab 示例条目 —— 请按你的部署调整路径：

```cron
* * * * * cd /path/to/Domain-Monitor && pnpm worker >> /var/log/domain-monitor-worker.log 2>&1
```

- 每分钟运行一次；每次运行都是全新的一次性进程。
- 空队列立即退出。
- 默认上限：每个 tick 最多 50 个 pending 投递。
- **不新增任何公网 HTTP endpoint** —— 调度完全保持外部化（无 webhook 调度 endpoint、无 serverless cron）。
- 重叠的 cron 实例是安全的：SQLite CAS 保证同一投递只会被一个 Worker claim。建议保持每分钟一次，避免额外的数据库争用。

### 运行时语义

- **Check → Event** — 由 V0.6 管道记录（每次检查一个事务，已去重）。
- **Event → Delivery** — 自 V0.7 起自动：检查事务为每个新记录的事件创建匹配的 pending 投递（按规则匹配、按渠道去重）。重复事件（相同 dedup key）绝不会重新生成投递。
- **Delivery → Send** — Worker 原子 claim `pending` 投递（CAS）并调用现有发送器。
- **failed** — Worker **不会**自动重试失败的投递；无 backoff、无 max-attempts。
- **retry** — 仅显式操作：`retryDelivery()` / 通知 UI。
- **过期 sending** — Worker 在每个 tick 开始时运行 `recoverStaleSending()`；默认过期阈值为 **5 分钟**。
- **至少一次投递（at-least-once）** — 发送中途崩溃会留下 `sending`，下个 tick 会恢复并再次发送，因此同一投递可能被发送多次。接收方必须使用 payload 中稳定的 `eventId` + `deliveryId` 去重。这是 at-least-once，**不是** exactly-once。
- **历史事件** — V0.7 不会为升级前记录的事件回溯生成投递；Worker 只消费当前的 `pending` 队列。
- SQLite `busy_timeout = 5000` 已启用，Worker 与 Web 应用可并发写入而不会立即出现 `SQLITE_BUSY` 失败。
- 无 daemon、无自动重试、无 backoff、无 max-attempts、无分布式队列（Redis/Kafka）、无 HTTP 调度 endpoint、无 serverless 调度器、无 SLA/可用性监控。

## 快速开始

```bash
git clone https://github.com/hxx0611/Domain-Monitor.git
cd Domain-Monitor
pnpm install
cp .env.example .env
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。

需要 Node.js >= 18 与 [pnpm](https://pnpm.io/)。支持 Linux、macOS 与 Windows。

## 测试

```bash
pnpm test
```

当前测试套件：**488 个测试**，覆盖域名校验、RDAP 解析、DNS 规范化与 diff、SSL 证书解析与 diff、HTTP 状态分类与 SSRF 防护抓取、DNS/SSL/HTTP 服务、通知事件/规则/投递状态机、SSRF 防护的 webhook 与 email 发送器、自动 Event → Delivery 生成、投递 Worker、语言感知的 i18n 核心（字典、cookie 回退、客户端/服务端边界）与数据仓库。

推送改动前还需运行：

```bash
pnpm lint
pnpm format:check
pnpm build
```

## 架构

```
UI (Next.js App Router)
        ↓
Server Actions
        ↓
Domain / RDAP / DNS services
        ↓
Repository
        ↓
SQLite
```

- **Next.js App Router** + Server Actions
- **Drizzle ORM** + **SQLite**（migrations 位于 `src/db/migrations/`）
- **Cloudflare DoH** 用于 DNS 查询（可通过 `DNS_DOH_ENDPOINT` 更换解析器）
- **IANA RDAP bootstrap** 用于注册信息

详细开发说明见 [docs/development.md](docs/development.md)。

## 数据库

通过 Drizzle ORM 使用 SQLite。使用内置命令管理 schema：

```bash
pnpm db:generate   # 生成 migration 文件
pnpm db:migrate    # 运行 migrations
pnpm db:studio     # 打开可视化数据库浏览器
```

## Roadmap

- [x] **V0.1** — 域名管理
- [x] **V0.2** — RDAP / WHOIS 集成
- [x] **V0.3** — DNS 监控
- [x] **V0.4** — SSL 证书监控
- [x] **V0.5** — HTTP 健康检查
- [x] **V0.6** — 通知系统
- [x] **V0.7** — 通知投递 Worker

## 参与贡献

欢迎贡献。

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

完整贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
