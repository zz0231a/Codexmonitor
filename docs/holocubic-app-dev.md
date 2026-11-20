# HoloCubic 应用开发要点（本项目整理版）

来源：[clocteck/holocubic-apps · 普通 app 开发参考](https://github.com/clocteck/holocubic-apps#%E6%99%AE%E9%80%9A-app-%E5%BC%80%E5%8F%91%E5%8F%82%E8%80%83)。底层 Lua 模块接口见该仓库 `README_LUA.md`，LVGL 绑定见 `README_LVGL.md`。本文只保留本项目（codex_monitor）用得上的要点与本机实测结论。

## 应用目录结构

每个 app 的 `package/` 即部署包，放到设备 `/sd/apps/<app-id>/` 后由 Launcher 重扫识别：

```
package/
├── app.info      # 元信息，必须（key = value 文本）
├── main.lua      # 入口脚本，必须，文件名由 app.info 的 entry 指定
├── main.png      # 图标，推荐
├── info.html     # Launcher 内介绍页，推荐
├── assets/       # 图片/GIF/音频等资源，可选
└── modules/      # .so 扩展模块，可选
```

本项目 `cubic/package/` 与此结构一致（另有 `main.html` 管理页，经 Cubic WebUI 读写配置）。

## app.info 关键字段

| 字段 | 说明 |
| --- | --- |
| `kind` | `app` / `service` / `launcher`（launcher 保留） |
| `catalog_scope` | `official` / `community`；社区应用用 `community` |
| `category` | `game` / `weather` / `clock` / `media` / `tool` |
| `entry` / `icon` / `name*` / `description*` / `version` | 常规元信息，名称与说明可带 `_zh_cn` `_zh_tw` `_en` `_ja` 语言后缀 |
| `allow_webui` | service 是否提供 WebUI |
| `autostart_service` | service 是否开机/重扫后自启动（仅 service 有效） |

开机自启普通 app 不需要 service：设备控制台「常用设置」里有「开机自启动应用」选项，直接选 `codex_monitor` 即可（本机固件 v1.212 已确认存在该设置）。

## 常用 Lua API 速查

- **app**：`app.exiting()`（长循环里判断退出）、`app.exit()`、`app.launch(id)`、`app.list()`、`app.rescan()`、`app.on("key"/"imu", fn)`
- **按键**：`key.on(code, fn)` / `key.off()`；键值 `key.LEFT/RIGHT/UP/DOWN/HOME`；事件 `key.START/SHORT/LONG_START/LONG_REPEAT/LONG_END`
- **定时器**：`tmr.create()` → `timer:alarm(ms, tmr.ALARM_AUTO/ALARM_SINGLE, fn)` → `timer:stop()` → `timer:unregister()`
- **文件**：`file.getcontents/putcontents/listdir/stat/open/mkdir/remove/rename`，路径显式写 `/sd/...`
- **LVGL**：全局 `lv_*` 函数 + `LV_*` 常量：`lv_scr_act()`、`lv_obj_clean`、`lv_obj_create`、`lv_label_create`、`lv_img_create`/`lv_img_set_src`、`lv_canvas_create`、`lv_obj_set_style_*`、`lv_anim_t` + `lv_anim_start()`
- **网络**：`http.get/post/request`、`wifi`、`httpd`（设备起 HTTP 服务）、`websocket`、`mqtt`、`net`
- **其他**：`sjson`（JSON）、`zlib`（gzip/crc32）、`time`、`sys`（亮度/CPU/RGB 灯）

## DIY 注意事项（官方原文要点）

- 退出/重载前释放资源：`timer:unregister()`、`key.off()`、`app.on(name, nil)`；字体 `lv_font_load()` 后退出时 `lv_font_free()`
- 回调里不要长时间阻塞；周期任务用 `tmr`，长循环里检查 `app.exiting()`
- 部署后资源路径用 `/sd/apps/<app-id>/...`
- 网络与文件 I/O 按 `value | nil, err` 风格处理失败

本项目 `main.lua` 的全局单例 `CODEX_MONITOR_APP` + `stop()/shutdown()` 完整释放定时器/按键/LVGL 对象，与该规范一致。

## 设备控制台 HTTP API（本机 v1.212 实测）

控制台页面 `http://<设备IP>/main#dashboard` 实际调用以下接口，可直接脚本化：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/system/fs/list?path=...` | 列目录（含文件大小，可用于增量对比） |
| POST | `/api/system/fs/mkdir?path=...` | 建目录 |
| PUT | `/api/system/fs/upload?path=...` | 上传文件（请求体即文件内容，固件原生，单文件上限 64MB） |
| GET/PUT | `/api/system/fs/file?path=...` | 读/写小文件 |
| DELETE | `/api/system/fs/remove?path=...` | 删除 |
| POST | `/api/system/launch?id=<app-id>` | 启动应用 |
| POST | `/api/system/exit` | 退出当前应用回 Launcher |

注意：未发现 HTTP 版「重扫应用列表」接口；新装 app 需在 Launcher 短按 `DOWN` 触发 `app.rescan()`（或重启设备）。已安装 app 只改文件则无需重扫，`exit` + `launch` 即生效。

## DevTools（开发期推荐）

设备自带 `devtools` 服务（本机 v1.0.3 运行中），浏览器打开 `http://<设备IP>/devtools/`：

- 文件管理：浏览 `/sd`、上传/下载/重命名/删除
- DevRun：在线编辑 `/sd/apps/devrun/main.lua`，「Run」即保存并 `app.launch("devrun")`，适合快速试错
- HTTP API 前缀 `/devtools/api`（`/info` `/list` `/read` `/upload` `/reload` 等）；上传建议直接用上面的固件原生 `PUT /api/system/fs/upload`，比 DevTools 的 Lua 通道快

## 本项目部署方式对比

| 场景 | 方式 |
| --- | --- |
| 开发期改 Lua/资源 | `node cubic/scripts/deploy-dev.mjs`（直传改动文件 + 重启应用，秒级） |
| 正式发布/首装 | `node cubic/scripts/build-package.mjs` 打包 → 控制台本地安装（tar + manifest）；注意此方式会清掉 `/sd/apps/codex_monitor/config.json`，装完需回写配置 |
