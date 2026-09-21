import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("token page ranks four dynamic slots and shows remaining reset windows", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /PAGE_COUNT\s*=\s*1/);
  assert.match(lua, /TOOL_SLOTS\s*=\s*8/);
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_tokens\b/);
  assert.match(lua, /token_monitor/);
  assert.match(lua, /remainingPercent/);
  assert.match(lua, /tm_slots/);
});

test("poll refresh does not restyle hidden pages or reload unchanged logos", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /last_img\[ref\]\s*==\s*src/);
  assert.match(lua, /switched\s*=\s*app\.page_index\s*~=\s*index/);
  assert.match(lua, /set_visible\(app\.pages\[i\]/);
  assert.equal((lua.match(/apply_dim\(false\)/g) || []).length, 0);
});

test("token page formats compact totals and keeps ASCII tool labels", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /function\s+compact_num\b/);
  assert.match(lua, /function\s+compact_money\b/);
  assert.match(lua, /TOOL_LABEL/);
  assert.match(lua, /CODEX/);
  assert.match(lua, /WBUDDY/);
  assert.equal(/[\u4e00-\u9fff]/.test(lua.match(/TOOL_LABEL\s*=\s*\{[\s\S]*?\}/)?.[0] ?? "汉"), false);
});

test("top label shows the highest-usage tool name and falls back to CODEX", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /function\s+tm_top_tool_label\b/);
  assert.match(lua, /set_text\(ui\.codex_label, top_tool\)/);
  assert.match(lua, /todayTokens/);
  assert.match(lua, /return "CODEX"/);
});
