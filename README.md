# Codex Monitor for Cubic

把 Windows 上的 Codex CLI 实时状态与 Token Monitor 的多工具用量，经隐私过滤后以只读 HTTP JSON 推给 320×240 的 HoloCubic 副屏。

屏幕共两页，左右键手动切换：

- **第 1 页 用量驾驶舱**：Codex 运行状态、任务摘要、本地时钟与天气、8 个工具用量环（按额度余量四档配色）、底部 RATE / TODAY / 7D / ALL 汇总。
- **第 2 页 Agent Tank 水族箱**：总用量前 6 名工具各一条鱼，working 时按 token 速率游动，idle / 离线沉底，等待输入时主角贴玻璃并提示 `NEED INPUT`。

## 架构

```
Codex CLI Hook（SessionStart / PreToolUse / PermissionRequest / Stop 等）
        │  POST http://127.0.0.1:8974/internal/event（仅回环，≤64KiB）
        ▼
Codex session JSONL（~/.codex/sessions/**/*.jsonl）── 约 1.2s 增量 tail
        │
        ▼  normalizeBridgeEvent → SourceArbiter → BridgeSnapshot
Token Monitor 本地库（%APPDATA%\Token Monitor\hub-devices.json）── 每 5s 读盘
        │
        ▼
GET /api/v1/status + /api/v1/health（0.0.0.0:8973，IP 白名单，只读 GET）
        │  Cubic 每秒轮询
        ▼
Cubic Lua 应用 codex_monitor（固件目标 v1.212）
```

## 仓库结构

| 目录 | 说明 |
| --- | --- |
| `bridge/` | Windows 桥接服务（TypeScript）：Hook 接收、JSONL 监控、Token Monitor 聚合、只读状态 API |
| `cubic/` | 设备端 Lua 应用包、资源贴图、构建与开发部署脚本、设备端测试 |
| `docs/` | 项目解读报告、部署说明、HoloCubic 开发要点 |
| `mockups/` | 界面状态设计稿 |

## 快速开始

桥接端（Windows，需 Node.js ≥ 22.15）：

```powershell
cd bridge
npm ci
copy config.example.json config.json   # 按需修改 host / port / allow 白名单
npm test                               # node:test，60+ 用例
npm run start
```

样本数据联调（不依赖 Codex，用于设备端开发）：

```powershell
npm run start -- --fixture test/fixtures/app-server-snapshot.json
```

设备端开发与打包：

```powershell
cd cubic
node --test test/*.test.mjs
node scripts/build-package.mjs          # 产物 dist/codex_monitor.zip
node scripts/deploy-dev.mjs             # 开发期直传设备，保留设备上 config.json
```

Hook 注册、登录自启、白名单与设备上传的完整步骤见 [docs/deployment.md](docs/deployment.md)。

## 隐私约束

- 响应与日志不含提示词、回复正文、命令参数、文件内容、账户 ID 或令牌
- session / 子代理标识只发单向短哈希，项目路径只保留末级目录名
- 活动摘要剥离路径与密钥形态、截断 80 字符
- 设备 API 只读：非 GET 一律 405，不提供任何写操作

## 文档

- [项目解读报告](docs/项目解读报告.md) — 现行架构、数据流与故障修复记录
- [部署说明](docs/deployment.md) — 构建、Hook 安装、白名单、设备上传
- [HoloCubic 应用开发要点](docs/holocubic-app-dev.md) — 固件 Lua / LVGL 接口实测笔记
- [bridge/README.md](bridge/README.md) — 桥接端配置与接口细节

## License

MIT
