# Codex Monitor Bridge

Windows 桥接程序：连接本机 Codex `app-server`，把任务状态与用量归一化后通过**只读** HTTP JSON 接口提供给 Cubic 副屏设备。协议隔离层设计：Codex 升级导致协议变化时，只改 `src/codex-protocol.ts`。

## 快速开始

```powershell
cd bridge
npm install
copy config.example.json config.json
npm run start
```

样本数据模式（无真实 Codex 连接，用于联调设备端）：

```powershell
npm run start -- --fixture test/fixtures/app-server-snapshot.json
```

## 配置（config.json）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址。默认仅回环；局域网访问需显式改为 `0.0.0.0` |
| `port` | `8973` | 监听端口 |
| `allow` | `[]` | 允许访问的设备 IP 列表；为空不限制，非空时白名单外一律 403 |
| `pollIntervalMs` | `5000` | fixture 模式快照轮询间隔 |

## 登录启动（当前用户，无需管理员）

```powershell
powershell -File scripts/install-startup.ps1    # 创建启动文件夹快捷方式
powershell -File scripts/uninstall-startup.ps1  # 只移除本应用创建的快捷方式
```

## 接口

- `GET /api/v1/status` — 设备端单一快照（`schemaVersion: 1`），数据过期也保持 200，并带 `codex_connected` 与 `last_updated_at`
- `GET /api/v1/health` — 安装与故障检查；桥接正常返回 200，Codex 断连返回 503（`bridge` 与 `codex_connected` 分开报告）

只读约束：任何非 GET 方法返回 405；响应带 `Cache-Control: no-store`。

## 隐私保证

- 响应与日志不含完整提示词、回复正文、命令参数、文件内容、账户 ID、API Key 或令牌
- 活动摘要经 `normalizer.sanitizeLabel` 处理：剥离绝对路径与密钥形态内容、去换行、截断 80 字符
- 不提供任何写操作，不调用额度消费或重置接口

## 开发

```powershell
npm test           # node:test + tsx，覆盖归一化、隐私过滤、HTTP 行为与 e2e 样本
npx tsc --noEmit   # 类型检查
```

## 状态

实时 `app-server` 传输边界已在 `src/codex-protocol.ts` 定义（`connectCodex()`），接入真实 Codex Desktop 后替换 `src/main.ts` 中的 fixture 轮询循环即可。
