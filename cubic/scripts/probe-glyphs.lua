-- 字形探测：把候选字符画到屏幕上，截屏后用肉眼确认哪些字形存在
local root = lv_scr_act()
lv_obj_clean(root)
lv_obj_set_style_bg_color(root, 0x040805, LV_PART_MAIN)
lv_obj_set_style_bg_opa(root, 255, LV_PART_MAIN)

local rows = {
  "A: █████░░░░░ blocks",   -- U+2588 / U+2591 用量条
  "B: ▊ cursor",           -- U+258A 光标
  "C: · · · middot",       -- U+00B7 间隔点
  "D: -> ~ | [] # _ =",    -- ASCII 候选
  "E: ● ○ ◆ dots",         -- 几何图形
  "F: ● [!] ° deg",        -- 温度符号等
}
for i, t in ipairs(rows) do
  local lb = lv_label_create(root)
  lv_label_set_text(lb, t)
  lv_obj_set_pos(lb, 6, 4 + (i - 1) * 22)
  lv_obj_set_style_text_color(lb, 0x4DFF88, LV_PART_MAIN)
end

local t = tmr.create()
t:alarm(1500, tmr.ALARM_SINGLE, function()
  pcall(function()
    local snap = lv_snapshot_take(root)
    if snap ~= nil then
      lv_snapshot_save_to_png(snap, "/sd/apps/codex_monitor/glyphs.png")
      lv_snapshot_free(snap)
    end
  end)
  pcall(function() app.launch("codex_monitor") end)
end)
