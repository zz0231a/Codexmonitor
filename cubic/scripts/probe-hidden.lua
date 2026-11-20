-- 隐藏标志与渐变背景探测：结果写入 probe.log 供电脑端读取
local L = {}
local function w(s) L[#L + 1] = s end

w("LV_OBJ_FLAG_HIDDEN=" .. tostring(rawget(_G, "LV_OBJ_FLAG_HIDDEN")))
w("LV_GRAD_DIR_VER=" .. tostring(rawget(_G, "LV_GRAD_DIR_VER")))
w("lv_obj_add_flag=" .. tostring(type(rawget(_G, "lv_obj_add_flag"))))
w("lv_obj_clear_flag=" .. tostring(type(rawget(_G, "lv_obj_clear_flag"))))
w("lv_obj_has_flag=" .. tostring(type(rawget(_G, "lv_obj_has_flag"))))
w("lv_obj_set_style_bg_grad_color=" .. tostring(type(rawget(_G, "lv_obj_set_style_bg_grad_color"))))
w("lv_obj_set_style_bg_grad_dir=" .. tostring(type(rawget(_G, "lv_obj_set_style_bg_grad_dir"))))
w("lv_obj_set_style_bg_opa=" .. tostring(type(rawget(_G, "lv_obj_set_style_bg_opa"))))

-- 功能验证：建一个对象，加/清 HIDDEN 标志后读回状态
local ok, err = pcall(function()
  local root = lv_scr_act()
  lv_obj_clean(root)
  local o = lv_obj_create(root)
  lv_obj_set_pos(o, 0, 0)
  lv_obj_set_size(o, 50, 50)
  local flag = rawget(_G, "LV_OBJ_FLAG_HIDDEN")
  if flag ~= nil and lv_obj_add_flag and lv_obj_has_flag then
    w("has_flag(before)=" .. tostring(lv_obj_has_flag(o, flag)))
    lv_obj_add_flag(o, flag)
    w("has_flag(after_add)=" .. tostring(lv_obj_has_flag(o, flag)))
    lv_obj_clear_flag(o, flag)
    w("has_flag(after_clear)=" .. tostring(lv_obj_has_flag(o, flag)))
  end
  lv_obj_del(o)
end)
w("functional=" .. tostring(ok) .. " " .. tostring(err or ""))

file.putcontents("/sd/apps/codex_monitor/probe.log", table.concat(L, "\n"))
