import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("working fixture includes both usage durations and safe activity labels", async () => {
  const status = JSON.parse(await readFile("test/fixtures/status-working.json", "utf8"));
  assert.ok(status.usage.windows.some((w) => w.windowDurationMins === 300));
  assert.ok(status.usage.windows.some((w) => w.windowDurationMins === 10080));
  assert.equal(JSON.stringify(status).includes("command"), false);
});

test("offline fixture keeps the stale task but marks codex disconnected", async () => {
  const status = JSON.parse(await readFile("test/fixtures/status-offline.json", "utf8"));
  assert.equal(status.codex_connected, false);
  assert.equal(status.status, "offline");
  assert.ok(status.primary_task, "stale primary task must be preserved");
  assert.equal(status.usage.windows.length, 0);
});

test("missing-window fixture degrades to a single window", async () => {
  const status = JSON.parse(await readFile("test/fixtures/status-missing-window.json", "utf8"));
  assert.equal(status.usage.windows.length, 1);
  assert.equal(status.usage.windows[0].windowDurationMins, 300);
});

test("malformed fixture is not valid JSON and must be rejected by the Lua parser", async () => {
  const raw = await readFile("test/fixtures/status-malformed.json", "utf8");
  assert.throws(() => JSON.parse(raw));
});

test("main.lua owns a safe state model with offline and last_update", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /app\.state\s*=\s*\{/);
  assert.match(lua, /offline/);
  assert.match(lua, /last_update/);
  assert.match(lua, /usage\s*=\s*\{/);
  assert.match(lua, /five_hour/);
  assert.match(lua, /seven_day/);
  assert.match(lua, /weather/);
  assert.match(lua, /activities/);
});

test("main.lua locates usage windows by duration, not by order", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /windowDurationMins\s*==\s*duration/);
  assert.match(lua, /find_window\(windows,\s*300\)/);
  assert.match(lua, /find_window\(windows,\s*10080\)/);
});

test("main.lua parses JSON inside pcall and never blocks the UI callback", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /pcall\(sjson\.decode|pcall\(function\(\).*sjson/s);
  assert.match(lua, /http\.get/);
  assert.match(lua, /timeout/);
});

test("main.lua keeps a timestamped last-good snapshot across failures", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /fail_count/);
  assert.match(lua, /last_update\s*=/);
});
