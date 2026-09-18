# Codex Monitor 部署说明

本阶段把 Windows Bridge 接到 Codex Hook + session JSONL，并把 `codex_monitor` 打成 Cubic 控制台可安装的本地应用包。默认不改防火墙、不改 Codex 配置、不上传设备；这些步骤必须在动作发生时单独确认。

## 1. 本地构建与测试

```powershell
cd bridge
npm ci
npm test
npm run typecheck
npm run install:dry-run
cd ..\cubic
node --test test/*.test.mjs
node scripts/build-package.mjs
```

产物：`cubic/dist/codex_monitor.zip`。压缩包根目录应直接包含 `app.info`、`main.lua`、`main.html`、`info.html`、`main.png`、`assets/`。

Dry-run 只打印将要改动的路径和事件数量，不会写入 `%CODEX_HOME%`、`~/.codex`、注册表或启动文件夹。

## 2. 确认后安装 Hook 与登录启动

将改动这些位置：

- `%CODEX_HOME%\hooks.json`（若未设置 `CODEX_HOME`，则为 `%USERPROFILE%\.codex\hooks.json`）
- `%CODEX_HOME%\config.toml` 仅增加或更新 `[features] hooks = true`
- 当前用户启动文件夹中的 `Codex Monitor Bridge.lnk`

确认后再执行：

```powershell
cd bridge
npm run install:hooks
powershell -File scripts\install-startup.ps1
```

安装器会留下 `hooks.json.codex-monitor.bak` 与 `config.toml.codex-monitor.bak`（若目标原先存在）。若 Codex `/hooks` 弹出批准提示，只批准本应用的 `codex-monitor-hook` 命令。

回滚：

```powershell
cd bridge
npm run uninstall:hooks
powershell -File scripts\uninstall-startup.ps1
```

卸载只删除本应用创建的 Hook 条目和 `Codex Monitor Bridge.lnk`，不改其他 Hook，也不改防火墙。

## 3. 确认 Windows 局域网地址

在本机查看 IPv4 地址（不要把该地址提交进仓库）：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne "WellKnown" }
```

Bridge 示例配置监听 `0.0.0.0:8973`，白名单默认包含设备 `10.23.2.209`。Hook 入口只绑定 `127.0.0.1:8974`。

## 4. 先在本机验证 Bridge

```powershell
cd bridge
copy config.example.json config.json
npm run start
```

另开终端：

```powershell
curl http://127.0.0.1:8973/api/v1/health
curl http://127.0.0.1:8973/api/v1/status
```

确认：

- `/api/v1/status` 的 `schemaVersion` 为 `1`
- `/api/v1/health` 含 `sources.hook` 与 `sources.jsonl`
- 监听地址是 `0.0.0.0:8973`，Hook 入口不是局域网地址

触发一个可丢弃的 Codex 任务，确认状态能从 working 到 done。不要把 payload 正文贴到日志或工单里。

## 5. 确认后上传设备应用

上传 `cubic/dist/codex_monitor.zip` 会改 `10.23.2.209` 上的文件；打开应用会停止或切走当前正在运行的 `全息PC监控`。确认后再从 Cubic 控制台的本地应用安装入口上传、重新扫描并打开 `Codex Monitor`。

在应用管理页填写已核实的 Windows 局域网 IPv4 与端口 `8973`，保存，测试 `/api/v1/health`，然后核对：

- working、工具活动、needs_user、done、离线/恢复
- LEFT / RIGHT / HOME
- 两个用量窗口，或明确显示 `--`
- 320×240 下必要文字不被裁切
- 连续 30 分钟无卡死

不要把该应用设为开机自启动，除非另外确认。

## 6. 网络策略

本应用不修改 Windows 防火墙。若设备打不开 `8973`：

- Bridge 未启动或只绑在 `127.0.0.1`
- 白名单未包含当前设备 IP
- Windows 防火墙拦截了入站 8973

出现这些症状时，单独说明阻断点并取得授权后再改防火墙。

## 7. 不要提交的内容

不要提交生成的 ZIP、本机 IP、Codex Hook 配置、备份、设备导出、日志、session 数据或密钥。
