# Codex Monitor Bridge

Windows 桥接程序：接收本机 Codex Hook 事件，并用 session JSONL 元数据兜底，把任务状态与用量归一化后通过**只读** HTTP JSON 接口提供给 Cubic 副屏设备。设备公开模型保持 `schemaVersion: 1`。

## 快速开始

```powershell
cd bridge
npm install
copy config.example.json config.json
npm run start
```

样本数据模式（不启动 Hook / JSONL，用于联调设备端）：

```powershell
npm run start -- --fixture test/fixtures/app-server-snapshot.json
```

## 配置（config.json）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 设备 API 监听地址。局域网访问需显式改为 `0.0.0.0` |
| `port` | `8973` | 设备 API 端口 |
| `allow` | `[]` | 允许访问的设备 IP 列表；为空不限制，非空时白名单外一律 403 |
| `hookHost` | `127.0.0.1` | Hook 接收口，仅允许回环 |
| `hookPort` | `8974` | Hook 接收口端口 |
| `jsonlPollIntervalMs` | `1200` | JSONL 增量扫描间隔 |
| `pollIntervalMs` | `5000` | fixture 模式快照轮询间隔 |

示例配置把设备 `10.23.2.209` 列入白名单，并把设备 API 绑到 `0.0.0.0:8973`。Hook 入口始终只绑 `127.0.0.1:8974`。

## 登录启动（当前用户，无需管理员）

```powershell
powershell -File scripts/install-startup.ps1    # 创建启动文件夹快捷方式
powershell -File scripts/uninstall-startup.ps1  # 只移除本应用创建的快捷方式
```

Codex Hook 安装（会改 `hooks.json` / `config.toml`，执行前需确认）：

```powershell
npm run install:dry-run
npm run install:hooks
npm run uninstall:hooks
```

## 接口

- `GET /api/v1/status` — 设备端单一快照（`schemaVersion: 1`），数据过期也保持 200，并带 `codex_connected`、`last_updated_at` 与 `token_monitor.activeToolId`。后者表示最近一次采样中当日 Token 增长最多的工具，连续 60 秒无增长后为 `null`
- `GET /api/v1/health` — 安装与故障检查；分别报告 Bridge、Codex、Hook、JSONL。任一数据源可用时返回 200，两个来源都无法提供 Codex 状态时返回 503
- `POST http://127.0.0.1:8974/internal/event` — 仅本机 Hook 入口，单事件不超过 64 KiB，不在局域网暴露

只读约束：设备 API 任何非 GET 方法返回 405；响应带 `Cache-Control: no-store`。程序不会修改 Windows 防火墙。

## 隐私保证

- 响应与日志不含完整提示词、回复正文、命令参数、文件内容、账户 ID、API Key 或令牌
- session / 子代理标识只发送单向短哈希；项目路径只保留末级目录名
- 活动摘要经 `normalizer.sanitizeLabel` 处理：剥离绝对路径与密钥形态内容、去换行、截断 80 字符
- 不提供任何写操作，不调用额度消费或重置接口，不替用户批准 `PermissionRequest`

## 开发

```powershell
npm test           # node:test + tsx
npm run typecheck  # tsc --noEmit
```
