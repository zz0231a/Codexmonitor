# Codex Monitor Cubic App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the Lua/LVGL Cubic app package with two 320×240 pages, real Codex status and usage windows, Cubic system weather, and 30-second rotation.

**Architecture:** The app is a small stateful Lua UI. It polls the bridge snapshot once per second, reads weather through Cubic's existing system settings/data path, and renders a compact two-page dashboard. All timers, key handlers, fonts, and image sources are owned by one app lifecycle object and released on exit/reload.

**Tech Stack:** Lua, Cubic Lua runtime, LVGL, Cubic `file`, `http`, `tmr`, `key`, `app` APIs, PNG/GIF/font assets only when needed.

**Spec:** `docs/superpowers/specs/2026-09-17-codex-cubic-monitor-design.md`

## Global Constraints

- Target 320×240 and keep text readable at the device's actual pixel density.
- Page 1 combines Codex status, Cubic system weather, and 5-hour/7-day remaining usage.
- Page 2 shows five safe activity summaries, model, context, and user-action state.
- `LEFT`/`RIGHT` changes page immediately; `HOME` short press exits; manual changes restart the 30-second timer.
- Poll bridge status every 1 second; display `--` for unavailable values and visibly mark stale/offline data.
- Use explicit `/sd/apps/codex_monitor/...` paths and release every resource during `APP.stop`.

### Task 1: Create package metadata and lifecycle scaffold

**Files:**
- Create: `cubic/package/app.info`
- Create: `cubic/package/main.lua`
- Create: `cubic/package/info.html`
- Create: `cubic/package/main.png`
- Test: `cubic/test/manifest.test.mjs`

**Interfaces:**
- Produces app ID `codex_monitor`, entry `main.lua`, and lifecycle object `CODEX_MONITOR_APP` with `start`, `stop`, and `shutdown`.

- [x] **Step 1: Write failing manifest test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest declares a community regular app", async () => {
  const raw = await readFile("package/app.info", "utf8");
  assert.match(raw, /kind\s*=\s*app/);
  assert.match(raw, /entry\s*=\s*main\.lua/);
  assert.match(raw, /catalog_scope\s*=\s*community/);
});
```

- [x] **Step 2: Run and verify failure**

Run: `cd cubic; node --test test/manifest.test.mjs`

Expected: FAIL because the package files do not exist.

- [x] **Step 3: Implement metadata and lifecycle scaffold**

Create bilingual metadata, use a stable global key for reload cleanup, create the root screen, and implement `APP.stop(reason)` to stop/unregister timers, call `key.off()`, unregister app events, clear the root, and remove the global reference.

- [x] **Step 4: Run manifest and Lua structure checks**

Run: `cd cubic; node --test test/manifest.test.mjs`

Expected: PASS. Also verify the package contains `app.info`, `main.lua`, `main.png`, and `info.html`.

- [x] **Step 5: Commit**

```text
git add cubic/package cubic/test
git commit -m "设备端：建立 Codex Monitor 应用骨架"
```

### Task 2: Add bridge snapshot client and safe state model

**Files:**
- Modify: `cubic/package/main.lua`
- Create: `cubic/test/fixtures/status-working.json`
- Create: `cubic/test/fixtures/status-offline.json`
- Test: `cubic/test/status-contract.test.mjs`

**Interfaces:**
- Consumes bridge `GET /api/v1/status` JSON.
- Produces Lua `APP.state` with `codex`, `weather`, `usage`, `activities`, `last_update`, and `offline` fields.

- [x] **Step 1: Write failing contract tests against fixtures**

```js
test("working fixture includes both usage durations and safe activity labels", async () => {
  const status = JSON.parse(await readFile("test/fixtures/status-working.json", "utf8"));
  assert.ok(status.usage.windows.some((w) => w.windowDurationMins === 300));
  assert.ok(status.usage.windows.some((w) => w.windowDurationMins === 10080));
  assert.equal(JSON.stringify(status).includes("command"), false);
});
```

- [x] **Step 2: Run and verify failure**

Run: `cd cubic; node --test test/status-contract.test.mjs`

Expected: FAIL because fixtures and parser contract are absent.

- [x] **Step 3: Implement polling and normalization**

Use `http.get` asynchronously with a timeout, parse `sjson` inside `pcall`, locate usage windows by duration, calculate remaining percentages only from valid values, and preserve a timestamped last-good snapshot. Never block the UI callback.

- [x] **Step 4: Run contract checks**

Run: `cd cubic; node --test test/status-contract.test.mjs`

Expected: PASS for working, missing-window, malformed-response, and offline fixtures.

- [x] **Step 5: Commit**

```text
git add cubic/package/main.lua cubic/test
git commit -m "设备端：接入桥接状态与用量快照"
```

### Task 3: Implement two-page LVGL layout and interactions

**Files:**
- Modify: `cubic/package/main.lua`
- Create: `cubic/package/assets/usage_5h.png`
- Create: `cubic/package/assets/usage_7d.png`
- Test: `cubic/test/layout-contract.test.mjs`

**Interfaces:**
- Consumes `APP.state` from Task 2.
- Produces `render_page(index)`, `render_overview()`, `render_details()`, and `switch_page(index, manual)`.

- [x] **Step 1: Write failing layout contract tests**

```js
test("layout contract defines two pages and 30-second rotation", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /PAGE_COUNT\s*=\s*2/);
  assert.match(lua, /30000/);
  assert.match(lua, /key\.LEFT/);
  assert.match(lua, /key\.RIGHT/);
  assert.match(lua, /key\.HOME/);
});
```

- [x] **Step 2: Run and verify failure**

Run: `cd cubic; node --test test/layout-contract.test.mjs`

Expected: FAIL because the page renderers and interaction constants are absent.

- [x] **Step 3: Implement overview page**

Render the Codex state/task panel on the left, Cubic system weather summary on the right, and two bottom usage bars labelled `5H` and `7D` with remaining percentage and reset time. Use `--` for unavailable values and warning/error colors below 20% or at zero.

- [x] **Step 4: Implement details page and input/timer behavior**

Render the latest five safe activity summaries, model, context, and action-needed badge. Register `key.on` handlers for `LEFT`, `RIGHT`, and `HOME`; create a repeating 30,000 ms timer; restart that timer after a manual switch; call `app.exit()` on HOME short press.

- [x] **Step 5: Run layout contract tests**

Run: `cd cubic; node --test test/layout-contract.test.mjs`

Expected: PASS.

- [x] **Step 6: Commit**

```text
git add cubic/package/main.lua cubic/package/assets cubic/test
git commit -m "设备端：完成两页 Codex 仪表界面"
```

### Task 4: Add configuration WebUI, offline rendering, and device QA harness

**Files:**
- Create: `cubic/package/main.html`
- Modify: `cubic/package/main.lua`
- Create: `cubic/test/status-offline.json`
- Create: `cubic/test/long-run-check.mjs`

**Interfaces:**
- Produces a WebUI to configure bridge IP/port and test `/api/v1/health`.
- Consumes the same saved config path from the Lua app.

- [x] **Step 1: Write failing offline and configuration tests**

```js
test("offline fixture causes an explicit offline marker", async () => {
  const status = JSON.parse(await readFile("status-offline.json", "utf8"));
  assert.equal(status.codex_connected, false);
  assert.ok(status.last_updated_at);
});
```

- [x] **Step 2: Run and verify failure**

Run: `cd cubic; node --test test/long-run-check.mjs`

Expected: FAIL until the offline renderer and WebUI configuration are present.

- [x] **Step 3: Implement WebUI and offline state**

Create `main.html` with bridge host/port fields and a read-only health test. Store only host, port, and optional allowed-device label in `/sd/apps/codex_monitor/config.json`. Dim stale data, show `OFFLINE`, and recover automatically on the next successful poll.

- [x] **Step 4: Run static checks and package inspection**

Run: `cd cubic; node --test test/*.test.mjs`; verify no restricted field names occur in UI source; verify all paths are under `/sd/apps/codex_monitor/`.

Expected: PASS.

- [ ] **Step 5: Run the 30-minute device QA**

Deploy `package/` to `/sd/apps/codex_monitor/`, rescan apps, run the app for 30 minutes, switch pages repeatedly, disconnect/reconnect the bridge, and exit/reload at least ten times.

Expected: no UI lockup, no timer accumulation, no stale callbacks after reload, correct 30-second rotation, and correct `HOME` exit.

- [x] **Step 6: Commit**

```text
git add cubic/package cubic/test
git commit -m "设备端：完成配置页与离线降级"
```

## Verification Checklist

- [x] `node --test test/*.test.mjs` passes.
- [x] Package contains required metadata, entry, icon, and description.
- [x] Both usage windows render by duration and show reset times.
- [x] Two pages rotate every 30 seconds and manual key switches restart the timer.
- [x] Offline, malformed, and partial snapshots do not crash the app.
- [x] Repeated exit/reload releases timers, key handlers, app events, fonts, and image sources.
- [ ] 320×240 real-device QA is complete.
