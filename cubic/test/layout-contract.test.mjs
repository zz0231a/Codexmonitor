import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("layout contract defines two pages and 30-second rotation", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /PAGE_COUNT\s*=\s*2/);
  assert.match(lua, /30000/);
  assert.match(lua, /key\.LEFT/);
  assert.match(lua, /key\.RIGHT/);
  assert.match(lua, /key\.HOME/);
});

test("layout exposes the documented renderer entry points", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_page\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_overview\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_details\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.switch_page\b/);
});

test("overview page shows 5H and 7D usage bars and degrades to dashes", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /"5H"/);
  assert.match(lua, /"7D"/);
  assert.match(lua, /"--"/);
});

test("usage bars warn below 20 percent and error at zero", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /remaining\s*<\s*20/);
  assert.match(lua, /remaining\s*==\s*0/);
});

test("manual switch restarts the rotation timer and HOME exits the app", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /restart_rotation/);
  const switchBody = (lua.split(/function\s+CODEX_MONITOR_APP\.switch_page\b/)[1] ?? "").split(/function\s+CODEX_MONITOR_APP\.\w+/)[0];
  assert.match(switchBody, /manual/);
  assert.match(switchBody, /restart_rotation/);
  assert.match(lua, /app\.exit/);
});

test("weather panel follows the system settings placeholder", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /weather/);
});
