import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("layout contract defines two pages with rotation", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /PAGE_COUNT\s*=\s*2/);
  assert.match(lua, /TOOL_SLOTS\s*=\s*8/);
  assert.match(lua, /key\.HOME/);
});

test("layout exposes the documented renderer entry points", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_page\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_overview\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_details\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_tokens\b/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.switch_page\b/);
});

test("overview page shows eight token rings and degrades to dashes", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /TOOL_SLOTS\s*=\s*8/);
  assert.match(lua, /tm_slots/);
  assert.match(lua, /"--"/);
});

test("usage colors follow four remaining-percent tiers", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /COLOR_INFO\s*=\s*0x60A5FA/);
  assert.match(lua, /remaining\s*>=\s*80\s+then\s+return\s+COLOR_OK/);
  assert.match(lua, /remaining\s*>=\s*50\s+then\s+return\s+COLOR_INFO/);
  assert.match(lua, /remaining\s*>=\s*20\s+then\s+return\s+COLOR_WARN/);
  assert.match(lua, /return\s+COLOR_ERR/);
});

test("tool icons shrink to 17px with circular corner clipping to avoid covering the ring", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /make_img\(p1, x \+ 28, y \+ 8, 17, 17\)/);
  assert.match(lua, /lv_img_set_zoom\(slot\.img, 218\)/);
  assert.match(lua, /lv_obj_set_style_clip_corner\(slot\.img, true/);
  assert.match(lua, /LV_RADIUS_CIRCLE/);
});

test("pages switch manually via keys only, no auto rotation; HOME exits", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /不自动轮播/);
  assert.equal((lua.match(/restart_rotation/g) || []).length, 0);
  assert.equal((lua.match(/ROTATE_MS/g) || []).length, 0);
  const switchBody = (lua.split(/function\s+CODEX_MONITOR_APP\.switch_page\b/)[1] ?? "").split(/function\s+CODEX_MONITOR_APP\.\w+/)[0];
  assert.match(switchBody, /render_page\(index\)/);
  assert.match(lua, /key\.LEFT/);
  assert.match(lua, /key\.RIGHT/);
  assert.match(lua, /app\.exit/);
});

test("weather panel follows the system settings placeholder", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /weather/);
});

test("overview clock shows ASCII weekday date and local time in the header gap", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_clock\b/);
  assert.match(lua, /card_clock/);
  assert.match(lua, /WEEKDAY_ASCII/);
  assert.match(lua, /"SUN"/);
  assert.match(lua, /clock_time/);
  assert.match(lua, /render_clock\(\)/);
  assert.equal(/[\u4e00-\u9fff]/.test(lua.match(/WEEKDAY_ASCII\s*=\s*\{[\s\S]*?\}/)?.[0] ?? "汉"), false);
});

test("weather uses firmware cubicserver now API and settings location id", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /http\.cubicserver/);
  assert.match(lua, /\/v1\/weather\/now/);
  assert.match(lua, /weather_location_id/);
  assert.match(lua, /lang=en/);
});

test("task bar shows English status and latest activity instead of CJK titles", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /STATUS_LABEL\[status\].*detail/);
  assert.match(lua, /st\.activities/);
  assert.equal(lua.includes("utf8_trunc((pt ~= nil and pt.title)"), false);
});

test("device-facing status labels stay ASCII because firmware fonts have no CJK glyphs", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  const labels = lua.match(/STATUS_LABEL\s*=\s*\{[\s\S]*?\}/)?.[0] ?? "";
  const subs = lua.match(/STATUS_SUB\s*=\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(labels, /WORKING/);
  assert.equal(/[\u4e00-\u9fff]/.test(labels), false);
  assert.equal(/[\u4e00-\u9fff]/.test(subs), false);
  assert.match(lua, /function\s+ascii_only\b/);
});
