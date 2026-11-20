import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("aquarium page renders top-six tools as ranked fish with tier colors", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /function\s+CODEX_MONITOR_APP\.render_aquarium\b/);
  assert.match(lua, /AQ_FISH_COUNT\s*=\s*6/);
  assert.match(lua, /FISH_SIZE\s*=\s*\{\s*\{\s*56,\s*28\s*\},\s*\{\s*48,\s*24\s*\},\s*\{\s*38,\s*22\s*\},\s*\{\s*34,\s*16\s*\},\s*\{\s*30,\s*14\s*\},\s*\{\s*26,\s*12\s*\}\s*\}/);
  assert.ok((lua.match(/for i = 1, AQ_FISH_COUNT do/g) || []).length >= 3);
  assert.match(lua, /function\s+fish_tint\b/);
  assert.match(lua, /remaining\s*>=\s*80\s+then\s+return\s+"green"/);
  assert.match(lua, /remaining\s*>=\s*50\s+then\s+return\s+"blue"/);
  assert.match(lua, /remaining\s*>=\s*20\s+then\s+return\s+"amber"/);
  assert.match(lua, /return\s+"red"/);
});

test("aquarium maps status to fish poses and keeps ASCII labels", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /aq_hero_index/); // codex 优先，缺席时第一名
  assert.match(lua, /tool\.id\s*==\s*"codex"/);
  assert.match(lua, /NEED INPUT/); // needs_user 药丸
  assert.match(lua, /_dead/); // error 翻白肚素材
  assert.match(lua, /AQ_REST_X/); // idle 沉底位
  assert.match(lua, /aq_bubbles/); // 贴玻璃吐泡
  const tags = lua.match(/AQ_TAG\s*=\s*\{[\s\S]*?\}/)?.[0] ?? "汉";
  assert.match(tags, /claude\s*=\s*"CL"/);
  assert.match(tags, /codex\s*=\s*"CX"/);
  assert.equal(/[一-龥]/.test(tags), false);
  assert.match(lua, /fiveHourPercent/);
  assert.match(lua, /sevenDayPercent/);
  assert.match(lua, /5H\/7D/);
  assert.match(lua, /tag_h5/);
  assert.match(lua, /tag_d7/);
});

test("aquarium bottom bar reuses RATE TODAY 7D ALL stats", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /aq_stat_labels/);
  assert.match(lua, /aq_stat_values/);
  const body = lua.split(/function\s+CODEX_MONITOR_APP\.render_aquarium\b/)[1] ?? "";
  assert.match(body, /"RATE"/);
  assert.match(body, /"TODAY"/);
  assert.match(body, /"7D"/);
  assert.match(body, /"ALL"/);
});

test("aquarium animation uses a smooth cadence only while page 2 is visible", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  const tickMs = Number(lua.match(/AQ_TICK_MS\s*=\s*(\d+)/)?.[1]);
  assert.ok(tickMs > 0 && tickMs <= 40, `animation cadence is too slow: ${tickMs} ms`);
  assert.match(lua, /app\.page_index\s*~=\s*2\s+then/);
  assert.match(lua, /every\(AQ_TICK_MS/);
  assert.match(lua, /lv_anim_set_exec_cb\(a,\s*lv_obj_set_x\)/);
  assert.match(lua, /lv_anim_path_linear/);
  assert.match(lua, /aq_refresh_motion\(\)/);
  assert.match(lua, /lv_canvas_frame_begin\(cvs\)/);
  assert.match(lua, /lv_canvas_frame_end\(cvs\)/);
  assert.match(lua, /LV_IMG_CF_TRUE_COLOR/);
  assert.doesNotMatch(lua, /aq_tick\(true\)/);
});

test("aquarium keeps fractional motion and image sources use the shared cache", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  const stepBody = (lua.split(/local function\s+aq_swim_step\b/)[1] ?? "").split(/local function\s+\w+/)[0];
  assert.match(stepBody, /aq_px_s\(\)\s*\*\s*dt_ms\s*\/\s*1000/);
  assert.doesNotMatch(stepBody, /math\.floor|math\.max/);
  assert.match(lua, /tmr\.now/);
  assert.match(lua, /if d > 48 then d = 48 end/);
  assert.match(lua, /if\s+last_img\[ref\]\s*==\s*src\s+then\s+return\s+true\s+end/);
  const posBody = (lua.split(/local function\s+set_pos\b/)[1] ?? "").split(/local LONG_CLIP/)[0];
  assert.match(lua, /last_pos_x\s*=\s*setmetatable/);
  assert.match(lua, /last_pos_y\s*=\s*setmetatable/);
  assert.match(posBody, /pcall\(apply_pos,\s*ref,\s*x,\s*y\)/);
  assert.doesNotMatch(posBody, /pcall\(function|\{\s*x\s*=/);
});

test("all ranked fish use the same 17px logo size and zcode has an icon", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  const assets = await readdir("package/assets");
  assert.match(lua, /AQ_LOGO_SIZE\s*=\s*17/);
  assert.match(lua, /slotf\.logo_px\s*=\s*AQ_LOGO_SIZE/);
  assert.doesNotMatch(lua, /slotf\.logo_px\s*=\s*math\.(?:max|floor)/);
  assert.match(lua, /zcode\s*=\s*true/);
  assert.match(lua, /slotf\.logo_visible\s*=\s*shown/);
  assert.match(lua, /if\s+slotf\.logo_visible\s+and\s+slotf\.logo/);
  assert.ok(assets.includes("tm_zcode.png"), "missing tm_zcode.png");
});

test("swimming fish stay on a fixed vertical lane instead of toggling up and down", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  const tickBody = (lua.split(/local function\s+aq_tick\b/)[1] ?? "").split(/function\s+CODEX_MONITOR_APP\.render_aquarium/)[0];
  assert.match(tickBody, /f\.y\s*=\s*f\.base_y/);
  assert.doesNotMatch(tickBody, /f\.base_y\s*\+\s*\(\(app\.aq\.tick/);
});

test("six ranked fish sizes have every tint and pose sprite", async () => {
  const assets = await readdir("package/assets");
  const sizes = ["56x28", "48x24", "38x22", "34x16", "30x14", "26x12"];
  const tints = ["green", "blue", "amber", "red", "gray"];
  for (const size of sizes) {
    for (const tint of tints) {
      assert.ok(assets.includes(`fish_${size}_${tint}.png`), `missing fish_${size}_${tint}.png`);
      assert.ok(assets.includes(`fish_${size}_${tint}_dead.png`), `missing fish_${size}_${tint}_dead.png`);
      assert.ok(assets.includes(`fish_${size}_${tint}_left.png`), `missing fish_${size}_${tint}_left.png`);
    }
  }
});

test("aquarium decor sprites (weeds and shrimp) exist and are placed", async () => {
  const assets = await readdir("package/assets");
  for (const name of ["weed_a", "weed_b", "weed_c", "shrimp", "shrimp_left"]) {
    assert.ok(assets.includes(`${name}.png`), `missing ${name}.png`);
  }
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /weed_a/);
  assert.match(lua, /shrimp_left/);
  assert.match(lua, /aq_deco/);
  assert.match(lua, /aq_sway_weeds/);
  assert.match(lua, /lv_img_set_pivot/);
  assert.match(lua, /w\.dx/);
});

test("fish turn around at tank edges and logo trails the tail", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /f\.dir\s*=\s*1\s*end/); // 左边缘调头朝右
  assert.match(lua, /f\.dir\s*=\s*-1\s*end/); // 右边缘调头朝左
  assert.match(lua, /_left/); // 左朝向素材
  assert.match(lua, /fish_src\(i,\s*f\.tint,\s*f\.dead,\s*f\.dir\)/); // 游动中按朝向换图
  assert.match(lua, /slotf\.logo/); // 尾巴后的 logo 圆牌
  assert.match(lua, /tm_has_icon/);
  assert.match(lua, /aq_swim_step/); // 游速挂钩全机速率
  assert.match(lua, /rate\s*\/\s*6000\s*\*\s*31/);
  assert.match(lua, /aq_anim_x\(slotf\.img,\s*from,\s*to,\s*ms/); // 只动画鱼身
  assert.match(lua, /math\.floor\(x\s*\/\s*4\)\s*\*\s*4/); // logo 和百分比按 4px 跟随
  assert.match(lua, /make_float/);
  assert.doesNotMatch(lua, /aq_anim_tag/);
});

test("the active ranked tool emits bubbles while needs-user keeps hero priority", async () => {
  const lua = await readFile(new URL("../package/main.lua", import.meta.url), "utf8");
  assert.match(lua, /active_tool_id\s*=\s*nil/);
  assert.match(lua, /raw\.activeToolId/);
  assert.match(lua, /aq_active_tool_index/);
  assert.match(lua, /status\s*==\s*"needs_user"[\s\S]*?or\s+aq_active_tool_index\(\)/);
  assert.match(lua, /bubble_fish/);
});
