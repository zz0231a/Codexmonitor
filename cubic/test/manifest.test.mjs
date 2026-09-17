import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest declares a community regular app", async () => {
  const raw = await readFile("package/app.info", "utf8");
  assert.match(raw, /kind\s*=\s*app/);
  assert.match(raw, /entry\s*=\s*main\.lua/);
  assert.match(raw, /catalog_scope\s*=\s*community/);
});

test("package contains the required files", async () => {
  for (const file of ["package/app.info", "package/main.lua", "package/main.png", "package/info.html"]) {
    const content = await readFile(file);
    assert.ok(content.length > 0, `${file} must not be empty`);
  }
});

test("main.lua owns one lifecycle object with start/stop/shutdown", async () => {
  const raw = await readFile("package/main.lua", "utf8");
  assert.match(raw, /CODEX_MONITOR_APP\s*=/);
  assert.match(raw, /function\s+CODEX_MONITOR_APP\.start\b/);
  assert.match(raw, /function\s+CODEX_MONITOR_APP\.stop\b/);
  assert.match(raw, /function\s+CODEX_MONITOR_APP\.shutdown\b/);
});

test("stop releases timers, key handlers, and the global reference", async () => {
  const raw = await readFile("package/main.lua", "utf8");
  const stopBody = raw.split(/function\s+CODEX_MONITOR_APP\.stop\b/)[1] ?? "";
  const untilNextFn = stopBody.split(/function\s+CODEX_MONITOR_APP\.\w+/)[0];
  assert.match(untilNextFn, /tmr\.stop|stop_timer/i);
  assert.match(untilNextFn, /key\.off|unregister_keys/i);
  assert.match(untilNextFn, /CODEX_MONITOR_APP\s*=\s*nil/);
});

test("app uses explicit sd paths and stable app id", async () => {
  const raw = await readFile("package/main.lua", "utf8");
  assert.match(raw, /\/sd\/apps\/codex_monitor\//);
  const info = await readFile("package/app.info", "utf8");
  assert.match(info, /id\s*=\s*codex_monitor/);
});
