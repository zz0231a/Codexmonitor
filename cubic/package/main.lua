-- Codex Monitor 设备端应用
-- 320x240 Cubic Lua + LVGL 应用，轮询 Windows 桥接程序只读接口。
--
-- 生命周期约定：全局 CODEX_MONITOR_APP 拥有全部定时器、按键回调与
-- LVGL 对象；stop(reason) 必须释放所有资源并清除全局引用，
-- 保证反复退出 / 重载不产生泄漏。

local APP_ID = "codex_monitor"
local APP_DIR = "/sd/apps/codex_monitor/"

local prev = rawget(_G, "CODEX_MONITOR_APP")
if prev and prev.stop then
  pcall(function() prev.stop("reload") end)
end

-- 稳定的全局入口：系统加载 / 重载本文件时重新取得同一对象。
CODEX_MONITOR_APP = {
  root = nil,
  timers = {},
  key_registered = false,
  running = false,
  owns_screen = false,
}
local app = CODEX_MONITOR_APP

-- ---------------------------------------------------------------------------
-- 设备 API 边界：固件 1.212 使用 tmr.create / lv_* 全局函数。
-- ---------------------------------------------------------------------------

local MAIN_STYLE = (rawget(_G, "LV_PART_MAIN") or 0)
local HIDDEN_FLAG = rawget(_G, "LV_OBJ_FLAG_HIDDEN")

local function stop_timers()
  for _, t in ipairs(app.timers) do
    pcall(function()
      if type(t) == "table" then
        if t.stop then t:stop() end
        if t.unregister then t:unregister() end
      end
      if tmr and tmr.stop then tmr.stop(t) end
    end)
  end
  app.timers = {}
end

local function every(interval_ms, fn)
  if tmr and tmr.create then
    local timer = tmr.create()
    timer:alarm(interval_ms, tmr.ALARM_AUTO, fn)
    table.insert(app.timers, timer)
    return timer
  end
  local timer = tmr.start(interval_ms, fn)
  table.insert(app.timers, timer)
  return timer
end

local function cancel_timer(timer)
  if timer == nil then return end
  pcall(function()
    if type(timer) == "table" then
      if timer.stop then timer:stop() end
      if timer.unregister then timer:unregister() end
    end
    if tmr and tmr.stop then tmr.stop(timer) end
  end)
  for i, t in ipairs(app.timers) do
    if t == timer then table.remove(app.timers, i) break end
  end
end

local function unregister_keys()
  if app.key_registered then
    pcall(function() key.off() end)
    app.key_registered = false
  end
end

local function clear_root()
  if app.root == nil then return end
  if app.owns_screen then
    pcall(function()
      if lv and lv.obj_del then lv.obj_del(app.root)
      elseif lv_obj_del then lv_obj_del(app.root) end
    end)
  elseif lv_obj_clean then
    pcall(lv_obj_clean, app.root)
  end
  app.root = nil
  app.owns_screen = false
end

local function read_text_file(path)
  if file and file.getcontents then
    local ok, raw = pcall(file.getcontents, path)
    if ok and type(raw) == "string" then return raw end
  end
  if file and file.read then
    local ok, raw = pcall(file.read, path)
    if ok and type(raw) == "string" then return raw end
  end
  return nil
end

local function decode_json(raw)
  if type(raw) ~= "string" or #raw == 0 then return nil end
  if sjson and sjson.decode then
    local ok, doc = pcall(sjson.decode, raw)
    if ok and type(doc) == "table" then return doc end
  end
  if json and json.decode then
    local ok, doc = pcall(json.decode, raw)
    if ok and type(doc) == "table" then return doc end
  end
  return nil
end

local function gunzip_body(body)
  if type(body) ~= "string" then return body end
  if zlib and zlib.isgzip and zlib.isgzip(body) and zlib.gunzip then
    local ok, plain = pcall(zlib.gunzip, body)
    if ok and type(plain) == "string" then return plain end
  end
  return body
end

local function url_encode(s)
  return (tostring(s):gsub("[^%w%-_%.~]", function(ch)
    return string.format("%%%02X", string.byte(ch))
  end))
end

-- ---------------------------------------------------------------------------
-- 配置与状态模型
-- ---------------------------------------------------------------------------

local DEFAULT_HOST = ""
local DEFAULT_PORT = 8973
local HTTP_TIMEOUT_MS = 2000
local OFFLINE_AFTER_FAILURES = 3
local MAX_ACTIVITY_LABEL = 80

app.config = { host = DEFAULT_HOST, port = DEFAULT_PORT }

-- 设备端唯一状态模型；渲染层只读取这里，不做网络与解析。
-- offline       设备无法连接桥接程序
-- codex.connected 桥接程序无法连接 Codex（保留最后非敏感数据并降暗）
-- last_update   最近一次成功快照的服务器时间
app.state = {
  offline = true,
  last_update = 0,
  fail_count = 0,
  codex = {
    connected = false,
    status = "offline",
    primary_task = nil, -- { title, status, model, contextPercent, lastActiveAt }
    other_active_task_count = 0,
  },
  weather = { city = nil, temp = nil, text = nil }, -- 固件 cubicserver /v1/weather/now
  usage = { five_hour = nil, seven_day = nil }, -- { remainingPercent, resetsAt }
  activities = {}, -- 最近 5 条 { stage, summary, at }
  token_monitor = {
    available = false,
    stale = true,
    active_tool_id = nil,
    tools = {}, -- 最多 8 条 { id, rank, remainingPercent, window, fiveHourPercent, sevenDayPercent }
    rate = nil,
    rate_idle = true,
    today_tokens = nil, today_cost = nil,
    last7_tokens = nil, last7_cost = nil,
    all_tokens = nil, all_cost = nil,
  },
}

local VALID_STATUS = { idle = true, working = true, needs_user = true, done = true, error = true, offline = true }

local function valid_host(host)
  if type(host) ~= "string" or #host == 0 then return false end
  if host:find("[%s/?#]") or host:find("%c") then return false end
  if host:match("^%d+%.%d+%.%d+%.%d+$") then
    for octet in host:gmatch("%d+") do
      local n = tonumber(octet)
      if n == nil or n < 0 or n > 255 then return false end
    end
    return true
  end
  if host:match("^[%a%d]$") or host:match("^[%a%d][%a%d%-%.]*[%a%d]$") then return true end
  return false
end

local function valid_port(port)
  local n = tonumber(port)
  if n == nil or n ~= math.floor(n) then return false end
  return n >= 1 and n <= 65535
end

local function load_config()
  local raw = read_text_file(APP_DIR .. "config.json")
  if type(raw) ~= "string" then return end
  local okd, cfg = pcall(sjson.decode, raw)
  if not okd or type(cfg) ~= "table" then return end
  if valid_host(cfg.host) then
    app.config.host = cfg.host
  end
  if valid_port(cfg.port) then
    app.config.port = tonumber(cfg.port)
  end
end

-- 天气：走固件 http.cubicserver（与系统天气应用同一通道），lang=en 以便 ASCII 显示。
-- 优先用 settings.json 里缓存的 QWeather location id，没有则按城市名 lookup。
app.weather = { location_id = nil, query = nil, city_label = nil, inflight = false }

local function pick_ascii_city(doc)
  if type(doc) ~= "table" then return nil end
  for _, key in ipairs({ "weather_address", "weather_location_address", "weatherAddress" }) do
    local v = doc[key]
    if type(v) == "string" and v:match("^[%a][%a%s%-]*$") then return v end
  end
  return nil
end

local function load_weather_settings()
  local location_id, query, city_label = nil, nil, nil
  pcall(function()
    if settings ~= nil and type(settings.get) == "function" then
      query = settings.get("weather.city") or settings.get("city")
    elseif settings ~= nil and type(settings.city) == "string" then
      query = settings.city
    end
  end)
  local doc = decode_json(read_text_file("/sd/apps/settings.json"))
  if type(doc) == "table" then
    local id = doc.weather_location_id
    if type(id) == "string" and id:match("^%d+$") then location_id = id end
    if type(id) == "number" then location_id = tostring(math.floor(id)) end
    query = doc.weather_address or doc.weatherAddress or doc.weather_city or doc.city_name or doc.city or query
    city_label = pick_ascii_city(doc)
  end
  if type(query) == "string" then
    query = query:gsub("[%z\1-\31]", " "):gsub("^%s+", ""):gsub("%s+$", "")
    if #query == 0 then query = nil end
  else
    query = nil
  end
  app.weather.location_id = location_id
  app.weather.query = query
  app.weather.city_label = city_label
  app.state.weather = {
    city = city_label,
    temp = app.state.weather and app.state.weather.temp or nil,
    text = app.state.weather and app.state.weather.text or nil,
  }
end

local request_weather -- 前向声明，实现在 HTTP 段（ascii_only 之后）

-- ---------------------------------------------------------------------------
-- 页面布局：第 1 页深色驾驶舱总览；第 2 页 Agent Tank 水族箱（tools 前六为鱼）。
-- ---------------------------------------------------------------------------

local PAGE_COUNT = 2
local TOOL_SLOTS = 8

app.page_index = 1
app.page_shown = false
app.pages = nil
app.ui = {} -- 全部 LVGL 控件引用，退出时随 root 一起删除
app.aq = { tick = 0, fish = {}, bubbles = {} } -- 水族箱游动状态（非 LVGL 对象）

-- 深色驾驶舱 / Dashboard 配色（全息透明屏：深色底≈透明，靠亮色元素显示）
local COLOR_BG = 0x0A0E17          -- 页面底
local COLOR_CARD = 0x141A28        -- 卡片微弱提亮
local COLOR_CARD_BORDER = 0x222A3A -- 卡片细边框
local COLOR_TRACK = 0x232B3D       -- 环形/进度条轨道
local COLOR_TEXT = 0xD5DBE5        -- 主文字
local COLOR_BRIGHT = 0xE8ECF5      -- 亮文字（数值/标题）
local COLOR_DIM = 0x8A93A6         -- 辅助文字
local COLOR_OK = 0x4ADE80          -- 绿（working/idle/done）
local COLOR_INFO = 0x60A5FA        -- 蓝（用量余额 50-80 档）
local COLOR_WARN = 0xFACC15        -- 琥珀（needs_user）
local COLOR_ERR = 0xF87171         -- 红（error）
local COLOR_OFFLINE = 0x6B7484     -- 离线灰（透明屏上要比普通灰亮）

-- Montserrat 内置字体（仅 ASCII 字形；常量缺失则静默保持默认字体）
local FONT_8 = rawget(_G, "LV_FONT_MONTSERRAT_8")
local FONT_10 = rawget(_G, "LV_FONT_MONTSERRAT_10")
local FONT_12 = rawget(_G, "LV_FONT_MONTSERRAT_12")
local FONT_14 = rawget(_G, "LV_FONT_MONTSERRAT_14")
local FONT_16 = rawget(_G, "LV_FONT_MONTSERRAT_16")
local FONT_24 = rawget(_G, "LV_FONT_MONTSERRAT_24")

local STATUS_LABEL = {
  idle = "IDLE",
  working = "WORKING",
  needs_user = "NEEDS USER",
  done = "DONE",
  error = "ERROR",
  offline = "OFFLINE",
}

local STATUS_SUB = {
  idle = "standing by",
  working = "task running",
  needs_user = "waiting for input",
  done = "task complete",
  error = "something failed",
  offline = "bridge offline",
}

-- Token Monitor 工具短名（固件仅 ASCII）
local TOOL_LABEL = {
  claude = "CLAUDE",
  codex = "CODEX",
  opencode = "OPENC",
  hermes = "HERMES",
  openclaw = "CLAW",
  cursor = "CURSOR",
  antigravity = "ANTIG",
  cline = "CLINE",
  amp = "AMP",
  droid = "DROID",
  kimi = "KIMI",
  deepseek = "DSEEK",
  dsh = "DSEEK", -- real DeepSeek id in hub data
  qwen = "QWEN",
  grok = "GROK",
  copilot = "COPLT",
  pi = "PI",
  zed = "ZED",
  kilo = "KILO",
  commandcode = "CMD",
  micode = "MIMO",
  zcode = "ZCODE",
  kiro = "KIRO",
  codebuddy = "CBUDDY",
  workbuddy = "WBUDDY",
  proma = "PROMA",
  qodercn = "QODER",
  reasonix = "REASON",
  dsh = "DSH",
  cherrystudio = "CHERRY",
  lmstudio = "LMST",
  unsloth = "UNSLT",
}

-- 活动图标：stage -> ASCII 字母（固件字体无图形字形）
local STAGE_ICON = {
  tool = "$", analysis = ">", reading = "R", responding = "~",
  done = "+", error = "!", needs_user = "?", processing = "*",
}

local STAGE_TONE = {
  tool = "green", done = "green", processing = "green",
  analysis = "blue", reading = "blue", responding = "blue",
  needs_user = "amber", error = "red",
}

-- 图标方块底色（暗色调）与字母色（亮色）
local ICON_TONE = {
  green = { bg = 0x14301F, fg = 0x4ADE80 },
  blue = { bg = 0x16202F, fg = 0x60A5FA },
  amber = { bg = 0x2E2408, fg = 0xFACC15 },
  red = { bg = 0x301514, fg = 0xF87171 },
}

local function ui_color(hex)
  if lv_color_hex then return lv_color_hex(hex) end
  if lv and lv.color_hex then return lv.color_hex(hex) end
  return hex
end

-- 值不变则跳过 LVGL 写操作：每秒轮询 + 光标闪烁下避免全屏重复重绘（实机闪烁根因）
local last_text = setmetatable({}, { __mode = "k" })
local last_color = setmetatable({}, { __mode = "k" })

local function set_text(ref, text)
  if ref == nil then return end
  if last_text[ref] == text then return end
  last_text[ref] = text
  pcall(function()
    if lv_label_set_text then lv_label_set_text(ref, text)
    elseif lv then lv.label_set_text(ref, text) end
  end)
end

local function set_color(ref, hex)
  if ref == nil then return end
  if last_color[ref] == hex then return end
  last_color[ref] = hex
  pcall(function()
    if lv_obj_set_style_text_color then lv_obj_set_style_text_color(ref, ui_color(hex), MAIN_STYLE)
    elseif lv then lv.obj_set_style_text_color(ref, ui_color(hex), 0) end
  end)
end

-- 字体切换：常量缺失或 API 不可用时静默保持默认字体
local function set_font(ref, font)
  if ref == nil or font == nil then return end
  pcall(function()
    if lv_obj_set_style_text_font then lv_obj_set_style_text_font(ref, font, MAIN_STYLE)
    elseif lv then lv.obj_set_style_text_font(ref, font, 0) end
  end)
end

-- 字距（CODEX / CTX / MODEL 等小标签的疏排大写感）
local function set_letter_space(ref, px)
  if ref == nil then return end
  pcall(function()
    if lv_obj_set_style_text_letter_space then lv_obj_set_style_text_letter_space(ref, px, MAIN_STYLE)
    elseif lv then lv.obj_set_style_text_letter_space(ref, px, 0) end
  end)
end

local TEXT_ALIGN_RIGHT = rawget(_G, "LV_TEXT_ALIGN_RIGHT")
local TEXT_ALIGN_CENTER = rawget(_G, "LV_TEXT_ALIGN_CENTER")

-- 文本对齐：需要先给 label 设定宽度才生效
local function set_align(ref, align)
  if ref == nil or align == nil then return end
  pcall(function()
    if lv_obj_set_style_text_align then lv_obj_set_style_text_align(ref, align, MAIN_STYLE)
    elseif lv then lv.obj_set_style_text_align(ref, align, 0) end
  end)
end

local function set_width(ref, w)
  if ref == nil then return end
  pcall(function()
    if lv_obj_set_width then lv_obj_set_width(ref, w)
    elseif lv_obj_set_size then lv_obj_set_size(ref, w, 10)
    elseif lv then lv.obj_set_width(ref, w) end
  end)
end

-- 位置移动：水族箱鱼等高频调用；不在动画帧内创建闭包或坐标表，避免 Lua GC 卡顿。
local last_pos_x = setmetatable({}, { __mode = "k" })
local last_pos_y = setmetatable({}, { __mode = "k" })
local function apply_pos(ref, x, y)
  if lv_obj_set_pos then lv_obj_set_pos(ref, x, y)
  elseif lv then lv.obj_set_pos(ref, x, y) end
end
local function set_pos(ref, x, y)
  if ref == nil then return end
  if last_pos_x[ref] == x and last_pos_y[ref] == y then return end
  local ok = pcall(apply_pos, ref, x, y)
  if ok then
    last_pos_x[ref] = x
    last_pos_y[ref] = y
  end
end

local LONG_CLIP = rawget(_G, "LV_LABEL_LONG_CLIP") or rawget(_G, "LV_LABEL_LONG_DOT")
  or (lv and (lv.LABEL_LONG_CLIP or lv.LABEL_LONG_DOT))

local function set_clip(ref)
  if ref == nil or LONG_CLIP == nil then return end
  pcall(function()
    if lv_label_set_long_mode then lv_label_set_long_mode(ref, LONG_CLIP)
    elseif lv and lv.label_set_long_mode then lv.label_set_long_mode(ref, LONG_CLIP) end
  end)
end

local OPA_COVER = (rawget(_G, "LV_OPA_COVER") or (lv and lv.OPA_COVER) or 255)
local SCROLLABLE_FLAG = (rawget(_G, "LV_OBJ_FLAG_SCROLLABLE") or (lv and lv.OBJ_FLAG_SCROLLABLE))
local PART_INDICATOR = (rawget(_G, "LV_PART_INDICATOR") or (lv and lv.PART_INDICATOR))
local PART_KNOB = (rawget(_G, "LV_PART_KNOB") or (lv and lv.PART_KNOB))
local ANIM_OFF = (rawget(_G, "LV_ANIM_OFF") or (lv and lv.ANIM_OFF) or 0)

local last_bg = setmetatable({}, { __mode = "k" })
local last_ind = setmetatable({}, { __mode = "k" })
local last_value = setmetatable({}, { __mode = "k" })

-- 不透明底色（值不变不重绘）：卡片铺底、状态圆点、图标方块
local function set_bg(ref, hex)
  if ref == nil then return end
  if last_bg[ref] == hex then return end
  last_bg[ref] = hex
  pcall(function()
    if lv_obj_set_style_bg_color then
      lv_obj_set_style_bg_color(ref, ui_color(hex), MAIN_STYLE)
      lv_obj_set_style_bg_opa(ref, OPA_COVER, MAIN_STYLE)
    elseif lv then
      lv.obj_set_style_bg_color(ref, ui_color(hex), 0)
      lv.obj_set_style_bg_opa(ref, OPA_COVER, 0)
    end
  end)
end

-- 卡片边框色（值不变不重绘：边框是大面积重绘）
local function set_border_color(ref, hex)
  if ref == nil then return end
  if last_color[ref] == hex then return end
  last_color[ref] = hex
  pcall(function()
    if lv_obj_set_style_border_color then lv_obj_set_style_border_color(ref, ui_color(hex), MAIN_STYLE)
    elseif lv then lv.obj_set_style_border_color(ref, ui_color(hex), 0) end
  end)
end

-- bar 指示条颜色（INDICATOR 部分，值不变不重绘）
local function set_indicator_color(ref, hex)
  if ref == nil or PART_INDICATOR == nil then return end
  if last_ind[ref] == hex then return end
  last_ind[ref] = hex
  pcall(function()
    if lv_obj_set_style_bg_color then
      lv_obj_set_style_bg_color(ref, ui_color(hex), PART_INDICATOR)
      lv_obj_set_style_bg_opa(ref, OPA_COVER, PART_INDICATOR)
    elseif lv then
      lv.obj_set_style_bg_color(ref, ui_color(hex), PART_INDICATOR)
      lv.obj_set_style_bg_opa(ref, OPA_COVER, PART_INDICATOR)
    end
  end)
end

-- arc 指示弧颜色（INDICATOR 部分，值不变不重绘）
local function set_arc_color(ref, hex)
  if ref == nil or PART_INDICATOR == nil then return end
  if last_ind[ref] == hex then return end
  last_ind[ref] = hex
  pcall(function()
    if lv_obj_set_style_arc_color then lv_obj_set_style_arc_color(ref, ui_color(hex), PART_INDICATOR)
    elseif lv and lv.obj_set_style_arc_color then lv.obj_set_style_arc_color(ref, ui_color(hex), PART_INDICATOR) end
  end)
end

-- arc / bar 数值（值不变不重绘，否则每秒轮询会触发持续重绘）
local function arc_set_value(ref, v)
  if ref == nil then return end
  if last_value[ref] == v then return end
  last_value[ref] = v
  pcall(function()
    if lv_arc_set_value then lv_arc_set_value(ref, v)
    elseif lv and lv.arc_set_value then lv.arc_set_value(ref, v) end
  end)
end

local function bar_set_value(ref, v)
  if ref == nil then return end
  if last_value[ref] == v then return end
  last_value[ref] = v
  pcall(function()
    if lv_bar_set_value then lv_bar_set_value(ref, v, ANIM_OFF)
    elseif lv and lv.bar_set_value then lv.bar_set_value(ref, v, ANIM_OFF) end
  end)
end

-- 可见性切换（值不变不重绘）：NEED INPUT 药丸等
local last_vis = setmetatable({}, { __mode = "k" })
local set_visible -- 前向声明，实现在 set_page_visible 之后

-- 圆角卡片 / 小块面板：radius 默认 7，border 默认 1px 细边框
local function make_panel(parent, x, y, w, h, radius, border)
  local ref = nil
  if lv_obj_create then ref = lv_obj_create(parent)
  elseif lv and lv.obj then ref = lv.obj(parent) end
  pcall(function()
    if lv_obj_set_pos then lv_obj_set_pos(ref, x, y)
    elseif lv then lv.obj_set_pos(ref, x, y) end
    if lv_obj_set_size then lv_obj_set_size(ref, w, h)
    elseif lv then lv.obj_set_size(ref, w, h) end
    if lv_obj_set_style_border_width then lv_obj_set_style_border_width(ref, border == nil and 1 or border, MAIN_STYLE)
    elseif lv then lv.obj_set_style_border_width(ref, border == nil and 1 or border, 0) end
    if lv_obj_set_style_radius then lv_obj_set_style_radius(ref, radius or 7, MAIN_STYLE)
    elseif lv then lv.obj_set_style_radius(ref, radius or 7, 0) end
    if lv_obj_set_style_pad_all then lv_obj_set_style_pad_all(ref, 0, MAIN_STYLE)
    elseif lv then lv.obj_set_style_pad_all(ref, 0, 0) end
    if SCROLLABLE_FLAG ~= nil then
      if lv_obj_clear_flag then lv_obj_clear_flag(ref, SCROLLABLE_FLAG)
      elseif lv and lv.obj_clear_flag then lv.obj_clear_flag(ref, SCROLLABLE_FLAG) end
    end
  end)
  set_bg(ref, COLOR_CARD)
  if border == nil or border > 0 then set_border_color(ref, COLOR_CARD_BORDER) end
  return ref
end

-- 透明外框。水族箱不要把鱼放进外框再移动：外框每帧会连带重绘
-- 放大裁圆的 logo 和百分比，320×240 上会把游动打成一跳一跳。
local function make_float(parent, w, h)
  local ref = nil
  if lv_obj_create then ref = lv_obj_create(parent)
  elseif lv and lv.obj then ref = lv.obj(parent) end
  pcall(function()
    if lv_obj_set_pos then lv_obj_set_pos(ref, 0, 0)
    elseif lv then lv.obj_set_pos(ref, 0, 0) end
    if lv_obj_set_size then lv_obj_set_size(ref, w, h)
    elseif lv then lv.obj_set_size(ref, w, h) end
    if lv_obj_set_style_border_width then lv_obj_set_style_border_width(ref, 0, MAIN_STYLE)
    elseif lv then lv.obj_set_style_border_width(ref, 0, 0) end
    if lv_obj_set_style_radius then lv_obj_set_style_radius(ref, 0, MAIN_STYLE)
    elseif lv then lv.obj_set_style_radius(ref, 0, 0) end
    if lv_obj_set_style_pad_all then lv_obj_set_style_pad_all(ref, 0, MAIN_STYLE)
    elseif lv then lv.obj_set_style_pad_all(ref, 0, 0) end
    if lv_obj_set_style_bg_opa then lv_obj_set_style_bg_opa(ref, 0, MAIN_STYLE)
    elseif lv then lv.obj_set_style_bg_opa(ref, 0, 0) end
    if SCROLLABLE_FLAG ~= nil then
      if lv_obj_clear_flag then lv_obj_clear_flag(ref, SCROLLABLE_FLAG)
      elseif lv and lv.obj_clear_flag then lv.obj_clear_flag(ref, SCROLLABLE_FLAG) end
    end
  end)
  return ref
end

-- CTX 环形仪表：360° 暗淡轨道 + 状态色指示弧，去掉 knob；失败返回 nil 走文本降级
local function make_arc(parent, x, y, size, width)
  local ref = nil
  local ok = pcall(function()
    if lv_arc_create then ref = lv_arc_create(parent)
    elseif lv and lv.arc then ref = lv.arc(parent) end
    if ref == nil then error("arc unavailable") end
    if lv_obj_set_pos then lv_obj_set_pos(ref, x, y)
    elseif lv then lv.obj_set_pos(ref, x, y) end
    if lv_obj_set_size then lv_obj_set_size(ref, size, size)
    elseif lv then lv.obj_set_size(ref, size, size) end
    if lv_arc_set_range then lv_arc_set_range(ref, 0, 100)
    elseif lv and lv.arc_set_range then lv.arc_set_range(ref, 0, 100) end
    if lv_arc_set_bg_angles then lv_arc_set_bg_angles(ref, 0, 360)
    elseif lv and lv.arc_set_bg_angles then lv.arc_set_bg_angles(ref, 0, 360) end
    local arc_w = width or 4
    if lv_obj_set_style_arc_width then
      lv_obj_set_style_arc_width(ref, arc_w, MAIN_STYLE)
      if PART_INDICATOR ~= nil then lv_obj_set_style_arc_width(ref, arc_w, PART_INDICATOR) end
    elseif lv and lv.obj_set_style_arc_width then
      lv.obj_set_style_arc_width(ref, arc_w, 0)
      if PART_INDICATOR ~= nil then lv.obj_set_style_arc_width(ref, arc_w, PART_INDICATOR) end
    end
    if lv_obj_set_style_arc_color then
      lv_obj_set_style_arc_color(ref, ui_color(COLOR_TRACK), MAIN_STYLE)
    elseif lv and lv.obj_set_style_arc_color then
      lv.obj_set_style_arc_color(ref, ui_color(COLOR_TRACK), 0)
    end
    if PART_KNOB ~= nil then
      if lv_obj_set_style_bg_opa then lv_obj_set_style_bg_opa(ref, 0, PART_KNOB)
      elseif lv and lv.obj_set_style_bg_opa then lv.obj_set_style_bg_opa(ref, 0, PART_KNOB) end
    end
    if SCROLLABLE_FLAG ~= nil then
      if lv_obj_clear_flag then lv_obj_clear_flag(ref, SCROLLABLE_FLAG)
      elseif lv and lv.obj_clear_flag then lv.obj_clear_flag(ref, SCROLLABLE_FLAG) end
    end
    if lv_arc_set_value then lv_arc_set_value(ref, 0)
    elseif lv and lv.arc_set_value then lv.arc_set_value(ref, 0) end
  end)
  if not ok then return nil end
  set_arc_color(ref, COLOR_OK)
  return ref
end

local function make_img(parent, x, y, w, h)
  local ref = nil
  local ok = pcall(function()
    if lv_img_create then ref = lv_img_create(parent)
    elseif lv and lv.img then ref = lv.img(parent) end
    if ref == nil then error("img unavailable") end
    if lv_obj_set_pos then lv_obj_set_pos(ref, x, y)
    elseif lv then lv.obj_set_pos(ref, x, y) end
    if lv_obj_set_size then lv_obj_set_size(ref, w, h)
    elseif lv then lv.obj_set_size(ref, w, h) end
  end)
  if not ok then return nil end
  return ref
end

local last_img = setmetatable({}, { __mode = "k" })
local function set_img_src(ref, src)
  if ref == nil or type(src) ~= "string" then return false end
  if last_img[ref] == src then return true end
  local ok = pcall(function()
    if lv_img_set_src then lv_img_set_src(ref, src)
    elseif lv and lv.img_set_src then lv.img_set_src(ref, src) end
  end)
  if ok then last_img[ref] = src end
  return ok
end

-- 圆角进度条：暗淡轨道 + 变色指示条
local function make_bar(parent, x, y, w, h)
  local ref = nil
  local ok = pcall(function()
    if lv_bar_create then ref = lv_bar_create(parent)
    elseif lv and lv.bar then ref = lv.bar(parent) end
    if ref == nil then error("bar unavailable") end
    if lv_obj_set_pos then lv_obj_set_pos(ref, x, y)
    elseif lv then lv.obj_set_pos(ref, x, y) end
    if lv_obj_set_size then lv_obj_set_size(ref, w, h)
    elseif lv then lv.obj_set_size(ref, w, h) end
    if lv_bar_set_range then lv_bar_set_range(ref, 0, 100)
    elseif lv and lv.bar_set_range then lv.bar_set_range(ref, 0, 100) end
    if lv_obj_set_style_radius then
      lv_obj_set_style_radius(ref, 4, MAIN_STYLE)
      if PART_INDICATOR ~= nil then lv_obj_set_style_radius(ref, 4, PART_INDICATOR) end
    elseif lv and lv.obj_set_style_radius then
      lv.obj_set_style_radius(ref, 4, 0)
      if PART_INDICATOR ~= nil then lv.obj_set_style_radius(ref, 4, PART_INDICATOR) end
    end
    if lv_obj_set_style_bg_color then
      lv_obj_set_style_bg_color(ref, ui_color(COLOR_TRACK), MAIN_STYLE)
      lv_obj_set_style_bg_opa(ref, OPA_COVER, MAIN_STYLE)
    elseif lv then
      lv.obj_set_style_bg_color(ref, ui_color(COLOR_TRACK), 0)
      lv.obj_set_style_bg_opa(ref, OPA_COVER, 0)
    end
  end)
  if not ok then return nil end
  set_indicator_color(ref, COLOR_OK)
  bar_set_value(ref, 0)
  return ref
end

-- 离线或 Codex 断开时整体降暗；恢复后由 render 重新上色
local function paint_labels(ref, hex)
  if type(ref) == "table" then
    for _, child in pairs(ref) do paint_labels(child, hex) end
  elseif ref ~= nil then
    set_color(ref, hex)
  end
end

local function dim_label(ref)
  paint_labels(ref, COLOR_OFFLINE)
end

-- dim=false 时把所有标签恢复基色（恢复路径），dim=true 时整体降暗
local function apply_dim(dim)
  paint_labels(app.ui, dim and COLOR_OFFLINE or COLOR_TEXT)
end

local function make_label(parent, x, y, text)
  local ref = nil
  if lv_label_create then ref = lv_label_create(parent)
  elseif lv and lv.label then ref = lv.label(parent) end
  pcall(function()
    if lv_obj_set_pos then lv_obj_set_pos(ref, x, y)
    elseif lv then lv.obj_set_pos(ref, x, y) end
    set_text(ref, text)
    set_color(ref, COLOR_TEXT)
  end)
  return ref
end

local function set_page_visible(page, visible)
  pcall(function()
    local flag = HIDDEN_FLAG or (lv and lv.OBJ_FLAG_HIDDEN)
    if flag and lv_obj_add_flag and lv_obj_clear_flag then
      if visible then lv_obj_clear_flag(page, flag) else lv_obj_add_flag(page, flag) end
    elseif lv then
      if visible then lv.obj_clear_flag(page, lv.OBJ_FLAG_HIDDEN) else lv.obj_add_flag(page, lv.OBJ_FLAG_HIDDEN) end
    end
  end)
end

-- 值不变不重绘的可见性切换（NEED INPUT 药丸等随状态显隐的控件）
set_visible = function(ref, visible)
  if ref == nil then return end
  if last_vis[ref] == visible then return end
  last_vis[ref] = visible
  set_page_visible(ref, visible)
end

-- 用量余额四档配色：>=80 绿，50-80 蓝（50 归蓝档），20-50 黄（20 归黄档），<20 红
local function usage_color(remaining)
  if remaining >= 80 then return COLOR_OK end
  if remaining >= 50 then return COLOR_INFO end
  if remaining >= 20 then return COLOR_WARN end
  return COLOR_ERR
end

local function compact_num(n)
  if type(n) ~= "number" then return "--" end
  local v, suffix, decimals
  if n >= 1e9 then v, suffix, decimals = n / 1e9, "B", 2
  elseif n >= 1e6 then v, suffix, decimals = n / 1e6, "M", 1
  elseif n >= 1e3 then v, suffix, decimals = n / 1e3, "K", 1
  else return tostring(math.floor(n + 0.5)) end
  local text = string.format("%." .. decimals .. "f", v)
  if text:sub(-3) == ".00" then text = text:sub(1, -4)
  elseif text:sub(-2) == ".0" then text = text:sub(1, -3) end
  return text .. suffix
end

local function compact_money(n)
  if type(n) ~= "number" then return "--" end
  if n >= 100 then return string.format("$%d", math.floor(n + 0.5)) end
  if n >= 10 then return string.format("$%.1f", n) end
  return string.format("$%.2f", n)
end

local function tool_label(id)
  if type(id) ~= "string" or #id == 0 then return "--" end
  local mapped = TOOL_LABEL[id]
  if mapped then return mapped end
  local upper = string.upper(id):gsub("[^A-Z0-9]", "")
  if #upper == 0 then return "--" end
  if #upper > 6 then upper = upper:sub(1, 6) end
  return upper
end

-- ---------------------------------------------------------------------------
-- Agent Tank 水族箱（第 2 页）：总用量前六的工具各为一条鱼。
-- 体型按排名固定；颜色走与圆环同一套余额档；主角鱼（codex，缺席时第一名）
-- 演绎全局状态：working 游动 / needs_user 贴玻璃吐泡 / error 翻白肚 / idle 沉底。
-- ---------------------------------------------------------------------------

local AQ_FISH_COUNT = 6
local AQ_LOGO_SIZE = 17
-- 鱼、水草、虾、气泡、logo 和百分比画进一块不透明画布，一帧只刷这一块。
-- 分开移动透明 PNG 时，LVGL 会把多块脏区并成大半个鱼缸，每帧重解码、重混合。
-- 画布创建失败时才退回：只动画鱼身，logo 和百分比按 4px 一档跟着走。
local FISH_SIZE = { { 56, 28 }, { 48, 24 }, { 38, 22 }, { 34, 16 }, { 30, 14 }, { 26, 12 } }
local AQ_TANK_TOP = 30      -- HUD 之下
local AQ_BED_Y = 186        -- 缸底沙床上沿
local AQ_CANVAS_Y = 28      -- 画布上沿，避开 HUD，下沿接到 y=208 的底栏
local AQ_CANVAS_H = 180
local AQ_TICK_MS = 40       -- 画布约 115KB，40ms 一帧比追不上一拍的 32ms 更稳
local aq_canvas_ok
local aq_paint

-- 工作态起始摆位（错开层次，避免标签互叠）
local AQ_SWIM = {
  { x = 36, y = 50 },
  { x = 168, y = 76 },
  { x = 210, y = 102 },
  { x = 92, y = 128 },
  { x = 250, y = 150 },
  { x = 24, y = 172 },
}
local AQ_REST_X = { 8, 64, 120, 176, 232, 282 } -- idle 沉底位

-- 鱼头顶双字母标签（固件仅 ASCII）；缺席时取工具短名前两位
local AQ_TAG = {
  claude = "CL", codex = "CX", cursor = "CR", kimi = "KM", grok = "GK",
  dsh = "DS", deepseek = "DS", workbuddy = "WB", hermes = "HR", opencode = "OC",
}

local function fish_tint(remaining)
  if remaining == nil then return "gray" end
  if remaining >= 80 then return "green" end
  if remaining >= 50 then return "blue" end
  if remaining >= 20 then return "amber" end
  return "red"
end

-- dir: 1 朝右（默认素材），-1 朝左（_left 素材；dead 姿态不游动，无左变体）
local function fish_src(rank, tint, dead, dir)
  local s = FISH_SIZE[rank]
  local name = "fish_" .. s[1] .. "x" .. s[2] .. "_" .. tint
  if dead then name = name .. "_dead"
  elseif dir == -1 then name = name .. "_left" end
  return APP_DIR .. "assets/" .. name .. ".png"
end

-- 有圆形 logo 素材的工具（tm_<id>.png，20px 源图）；与第一页圆环槽共用
local TM_ICON_IDS = {
  codex = true, cursor = true, workbuddy = true, kimi = true,
  claude = true, grok = true, zcode = true, dsh = true, -- DeepSeek 在 hub 数据里的真实 id 是 dsh
}

local function tm_has_icon(id)
  return type(id) == "string" and TM_ICON_IDS[id] == true
end

local function aq_tag(id)
  local mapped = AQ_TAG[id]
  if mapped then return mapped end
  local short = tool_label(id)
  if short == "--" then return "??" end
  return short:sub(1, 2)
end

-- 顶部标签：本日用量最高工具的短名大写（ASCII）。
-- 桥接快照暂无每工具"今日 tokens"字段：优先按 todayTokens 取最大值（字段出现时自动生效），
-- 否则 fallback 取槽位列表第一个工具；无数据保持 CODEX。
local function tm_top_tool_label()
  local tm = app.state.token_monitor
  local tools = tm and tm.tools
  if type(tools) ~= "table" or #tools == 0 then return "CODEX" end
  local best, best_tokens = nil, nil
  for _, tool in ipairs(tools) do
    local t = tool.todayTokens
    if type(t) == "number" and t >= 0 and (best_tokens == nil or t > best_tokens) then
      best, best_tokens = tool, t
    end
  end
  if best == nil then best = tools[1] end
  return tool_label(best.id)
end

local WEEKDAY_ASCII = { "SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT" }

local function local_time_offset()
  -- 固件无 os.date；epoch2cal 返回 UTC，cal2epoch 把输入当本地时间。
  if not (time and time.get and time.epoch2cal and time.cal2epoch) then return 0, nil end
  local ok1, sec = pcall(time.get)
  if not ok1 or type(sec) ~= "number" then return 0, nil end
  local ok2, utc_cal = pcall(time.epoch2cal, sec)
  if not ok2 or type(utc_cal) ~= "table" then return 0, sec end
  local ok3, back = pcall(time.cal2epoch, utc_cal)
  if not ok3 or type(back) ~= "number" then return 0, sec end
  return sec - back, sec
end

local function read_local_cal()
  if time and time.getlocal then
    local ok, loc = pcall(time.getlocal)
    if ok and type(loc) == "table" and loc.hour ~= nil then
      local epoch = nil
      if time.cal2epoch then
        local ok2, wall = pcall(time.cal2epoch, loc)
        if ok2 and type(wall) == "number" then epoch = wall end
      end
      return loc, epoch
    end
  end
  local offset, sec = local_time_offset()
  if time and time.epoch2cal then
    local src = sec
    if type(src) ~= "number" and time.get then
      local ok, now = pcall(time.get)
      if ok and type(now) == "number" then src = now end
    end
    if type(src) == "number" then
      local ok, cal = pcall(time.epoch2cal, src + offset)
      if ok and type(cal) == "table" then return cal, src + offset end
    end
  end
  local ok, t = pcall(os.date, "*t")
  if ok and type(t) == "table" then
    local epoch_ok, epoch = pcall(os.time)
    return t, epoch_ok and epoch or nil
  end
  return nil, nil
end

local function weekday_name(cal, local_epoch)
  if type(local_epoch) == "number" then
    -- Unix 1970-01-01 是周四；WEEKDAY_ASCII[1] = SUN
    return WEEKDAY_ASCII[((math.floor(local_epoch / 86400) + 4) % 7) + 1]
  end
  local w = cal and cal.wday
  if type(w) == "number" then
    if w >= 1 and w <= 7 then return WEEKDAY_ASCII[w] end
    if w >= 0 and w <= 6 then return WEEKDAY_ASCII[w + 1] end
  end
  return "---"
end

local function fmt_reset(ts)
  local offset = local_time_offset()
  if time and time.epoch2cal and type(ts) == "number" then
    local ok, cal = pcall(time.epoch2cal, ts + offset)
    if ok and type(cal) == "table" then
      return string.format("%02d:%02d", cal.hour or 0, cal.min or 0)
    end
  end
  local ok, text = pcall(function() return os.date("%H:%M", ts) end)
  return ok and text or "--"
end

local function build_ui()
  local ui = app.ui
  set_bg(app.root, COLOR_BG)
  app.pages = {}
  for i = 1, PAGE_COUNT do
    local page = nil
    if lv_obj_create then page = lv_obj_create(app.root)
    elseif lv and lv.obj then page = lv.obj(app.root) end
    pcall(function()
      if lv_obj_set_pos then lv_obj_set_pos(page, 0, 0)
      elseif lv then lv.obj_set_pos(page, 0, 0) end
      if lv_obj_set_size then lv_obj_set_size(page, 320, 240)
      elseif lv then lv.obj_set_size(page, 320, 240) end
      if lv_obj_set_style_pad_all then lv_obj_set_style_pad_all(page, 0, MAIN_STYLE)
      elseif lv then lv.obj_set_style_pad_all(page, 0, 0) end
      if lv_obj_set_style_border_width then lv_obj_set_style_border_width(page, 0, MAIN_STYLE)
      elseif lv then lv.obj_set_style_border_width(page, 0, 0) end
      if SCROLLABLE_FLAG ~= nil then
        if lv_obj_clear_flag then lv_obj_clear_flag(page, SCROLLABLE_FLAG)
        elseif lv and lv.obj_clear_flag then lv.obj_clear_flag(page, SCROLLABLE_FLAG) end
      end
    end)
    set_bg(page, COLOR_BG)
    app.pages[i] = page
  end

  -- ================= 第 1 页：深色驾驶舱总览 =================
  local p1 = app.pages[1]

  -- 顶部：状态圆点 + 工具名疏排小字（渲染时动态取本日用量最高工具，默认 CODEX）；右上天气卡片（占位）
  ui.status_dot = make_panel(p1, 8, 11, 8, 8, 4, 0)
  ui.codex_label = make_label(p1, 22, 9, "CODEX")
  set_font(ui.codex_label, FONT_10)
  set_letter_space(ui.codex_label, 2)

  ui.card_weather = make_panel(p1, 234, 8, 78, 58, 7)
  ui.weather_city = make_label(p1, 242, 13, "--")
  set_font(ui.weather_city, FONT_8)
  set_width(ui.weather_city, 62)
  set_align(ui.weather_city, TEXT_ALIGN_RIGHT)
  ui.weather_temp = make_label(p1, 242, 24, "--")
  set_font(ui.weather_temp, FONT_16)
  set_width(ui.weather_temp, 62)
  set_align(ui.weather_temp, TEXT_ALIGN_RIGHT)
  ui.weather_note = make_label(p1, 242, 47, "--")
  set_font(ui.weather_note, FONT_8)
  set_width(ui.weather_note, 62)
  set_align(ui.weather_note, TEXT_ALIGN_RIGHT)

  -- 状态大字 + dim 副标题（宽度避开中间时钟卡）
  ui.state_big = make_label(p1, 8, 26, "--")
  set_font(ui.state_big, FONT_24)
  set_width(ui.state_big, 118)
  set_clip(ui.state_big)
  ui.state_sub = make_label(p1, 8, 56, "--")
  set_font(ui.state_sub, FONT_10)
  set_width(ui.state_sub, 118)
  set_clip(ui.state_sub)

  -- 顶部中间：本地日期 / 时间 / 星期（ASCII，与天气卡等高）
  ui.card_clock = make_panel(p1, 128, 8, 100, 58, 7)
  ui.clock_dow = make_label(p1, 132, 13, "---")
  set_font(ui.clock_dow, FONT_8)
  set_width(ui.clock_dow, 92)
  set_align(ui.clock_dow, TEXT_ALIGN_CENTER)
  ui.clock_time = make_label(p1, 132, 22, "--:--")
  set_font(ui.clock_time, FONT_24)
  set_width(ui.clock_time, 92)
  set_align(ui.clock_time, TEXT_ALIGN_CENTER)
  ui.clock_date = make_label(p1, 132, 48, "--")
  set_font(ui.clock_date, FONT_8)
  set_width(ui.clock_date, 92)
  set_align(ui.clock_date, TEXT_ALIGN_CENTER)

  -- 任务卡片：左侧圆角色条 + 标题
  ui.card_task = make_panel(p1, 8, 72, 304, 26, 7)
  ui.task_ticon = make_panel(p1, 16, 78, 4, 14, 2, 0)
  ui.task_title = make_label(p1, 28, 78, "--")
  set_font(ui.task_title, FONT_12)
  set_width(ui.task_title, 276)
  set_clip(ui.task_title)

  -- 中部：总用量前八，两行四列小圆环
  ui.tm_board = make_panel(p1, 8, 102, 304, 104, 7)
  ui.tm_slots = {}
  for i = 1, TOOL_SLOTS do
    local col = (i - 1) % 4
    local row = math.floor((i - 1) / 4)
    local x = 8 + col * 76
    local y = 102 + row * 52
    local slot = {}
    slot.arc = make_arc(p1, x + 22, y + 2, 30, 3)
    slot.letter = make_label(p1, x + 22, y + 9, "-")
    set_font(slot.letter, FONT_12)
    set_width(slot.letter, 30)
    set_align(slot.letter, TEXT_ALIGN_CENTER)
    -- 图标再收至 17px 并做圆形裁切：19px 方形四角半径约 13.4px 超过圆环内半径 12px 会压弧。
    -- LVGL auto_size 锚左上角，左上角取 (x+28, y+8) 使视觉圆心保持 (x+37, y+17)（偏差 <1px）
    slot.img = make_img(p1, x + 28, y + 8, 17, 17)
    -- 20px 源图缩到 17px：LVGL zoom 256=1:1，17/20*256=218
    if slot.img ~= nil then
      pcall(function()
        if lv_img_set_zoom then lv_img_set_zoom(slot.img, 218)
        elseif lv and lv.img_set_zoom then lv.img_set_zoom(slot.img, 218) end
      end)
      -- 圆形裁切四角（固件缺 API 时 17px 方形四角半径 12.02 也已在弧内）
      pcall(function()
        local circle = rawget(_G, "LV_RADIUS_CIRCLE") or 0x7FFF
        if lv_obj_set_style_radius then lv_obj_set_style_radius(slot.img, circle, MAIN_STYLE)
        elseif lv and lv.obj_set_style_radius then lv.obj_set_style_radius(slot.img, circle, 0) end
        if lv_obj_set_style_clip_corner then lv_obj_set_style_clip_corner(slot.img, true, MAIN_STYLE)
        elseif lv and lv.obj_set_style_clip_corner then lv.obj_set_style_clip_corner(slot.img, true, 0) end
      end)
    end
    slot.pct = make_label(p1, x, y + 32, "--")
    set_font(slot.pct, FONT_8)
    set_width(slot.pct, 76)
    set_align(slot.pct, TEXT_ALIGN_CENTER)
    slot.name = make_label(p1, x, y + 42, "--")
    set_font(slot.name, FONT_8)
    set_width(slot.name, 76)
    set_align(slot.name, TEXT_ALIGN_CENTER)
    ui.tm_slots[i] = slot
  end

  -- 底部：全机 RATE / TODAY / 7D / ALL
  ui.tm_stats = make_panel(p1, 8, 208, 304, 28, 7)
  ui.tm_stat_labels = {}
  ui.tm_stat_values = {}
  local stat_heads = { "RATE", "TODAY", "7D", "ALL" }
  for i = 1, 4 do
    local x = 8 + (i - 1) * 76
    ui.tm_stat_labels[i] = make_label(p1, x, 210, stat_heads[i])
    set_font(ui.tm_stat_labels[i], FONT_8)
    set_width(ui.tm_stat_labels[i], 76)
    set_align(ui.tm_stat_labels[i], TEXT_ALIGN_CENTER)
    ui.tm_stat_values[i] = make_label(p1, x, 220, "--")
    set_font(ui.tm_stat_values[i], FONT_8)
    set_width(ui.tm_stat_values[i], 76)
    set_align(ui.tm_stat_values[i], TEXT_ALIGN_CENTER)
  end

  -- ================= 第 2 页：Agent Tank 水族箱 =================
  local p2 = app.pages[2]
  if p2 ~= nil then
    -- 水体：深蓝渐变底（渐变 API 缺失时退化为纯色，不影响使用）
    set_bg(p2, 0x08202C)
    pcall(function()
      if lv_obj_set_style_bg_grad_color then
        lv_obj_set_style_bg_grad_color(p2, ui_color(0x050D14), MAIN_STYLE)
        local ver = rawget(_G, "LV_GRAD_DIR_VER")
        if ver ~= nil and lv_obj_set_style_bg_grad_dir then
          lv_obj_set_style_bg_grad_dir(p2, ver, MAIN_STYLE)
        end
      end
    end)

    -- 水体画布放在 HUD 之后创建的药丸、底栏下面；鱼的控件若走画布则隐藏。
    ui.aq_canvas = nil
    if lv_canvas_create ~= nil and lv_canvas_frame_begin ~= nil and lv_canvas_frame_end ~= nil
      and lv_canvas_fill_bg ~= nil and lv_canvas_draw_img ~= nil then
      local fmt = rawget(_G, "LV_IMG_CF_TRUE_COLOR")
      local ok, cvs = pcall(lv_canvas_create, p2, 320, AQ_CANVAS_H, fmt)
      if (not ok or cvs == nil or cvs == 0) and fmt ~= nil then
        ok, cvs = pcall(lv_canvas_create, p2, 320, AQ_CANVAS_H)
      end
      if ok and cvs ~= nil and cvs ~= 0 then
        pcall(function()
          if lv_obj_set_pos then lv_obj_set_pos(cvs, 0, AQ_CANVAS_Y)
          elseif lv then lv.obj_set_pos(cvs, 0, AQ_CANVAS_Y) end
          if lv_obj_set_style_pad_all then lv_obj_set_style_pad_all(cvs, 0, MAIN_STYLE) end
          if lv_obj_set_style_border_width then lv_obj_set_style_border_width(cvs, 0, MAIN_STYLE) end
          if SCROLLABLE_FLAG ~= nil and lv_obj_clear_flag then lv_obj_clear_flag(cvs, SCROLLABLE_FLAG) end
        end)
        if lv_obj_move_background ~= nil then pcall(lv_obj_move_background, cvs) end
        ui.aq_canvas = cvs
      end
    end

    -- HUD：状态点 + 本日最高工具 + 状态 + 时钟
    ui.aq_dot = make_panel(p2, 8, 11, 8, 8, 4, 0)
    ui.aq_brand = make_label(p2, 22, 9, "CODEX")
    set_font(ui.aq_brand, FONT_10)
    set_letter_space(ui.aq_brand, 2)
    ui.aq_sub = make_label(p2, 96, 10, "--")
    set_font(ui.aq_sub, FONT_8)
    set_letter_space(ui.aq_sub, 1)
    ui.aq_clock = make_label(p2, 252, 10, "--:--")
    set_font(ui.aq_clock, FONT_8)
    set_width(ui.aq_clock, 60)
    set_align(ui.aq_clock, TEXT_ALIGN_RIGHT)
    ui.aq_legend = make_label(p2, 198, 10, "5H/7D")
    set_font(ui.aq_legend, FONT_8)
    set_color(ui.aq_legend, COLOR_DIM)

    -- NEED INPUT 药丸（needs_user 时显示）
    ui.aq_pill = make_panel(p2, 110, 30, 100, 16, 8)
    set_bg(ui.aq_pill, 0x2E2408)
    set_border_color(ui.aq_pill, COLOR_WARN)
    ui.aq_pill_text = make_label(p2, 110, 34, "NEED INPUT")
    set_font(ui.aq_pill_text, FONT_8)
    set_color(ui.aq_pill_text, COLOR_WARN)
    set_width(ui.aq_pill_text, 100)
    set_align(ui.aq_pill_text, TEXT_ALIGN_CENTER)
    set_visible(ui.aq_pill, false)
    set_visible(ui.aq_pill_text, false)

    -- 缸底沙床
    ui.aq_bed = make_panel(p2, 0, AQ_BED_Y, 320, 22, 0, 0)
    set_bg(ui.aq_bed, 0x0B151E)

    -- 水草先于鱼创建，鱼从草前游过。摆动在第 2 页的定时器里做，不另开逐帧动画。
    ui.aq_deco = {}
    ui.aq_weeds = {}
    local weed_defs = {
      { "weed_a", 16, 36, 6 }, { "weed_b", 12, 26, 58 }, { "weed_c", 10, 18, 138 },
      { "weed_c", 10, 18, 228 }, { "weed_b", 12, 26, 262 }, { "weed_a", 16, 36, 298 },
    }
    for i, wd in ipairs(weed_defs) do
      local wy = AQ_BED_Y - wd[3] + 2
      local ref = make_img(p2, wd[4], wy, wd[2], wd[3])
      if ref ~= nil then
        set_img_src(ref, APP_DIR .. "assets/" .. wd[1] .. ".png")
        if lv_img_set_pivot ~= nil then
          pcall(lv_img_set_pivot, ref, math.floor(wd[2] / 2), wd[3] - 1)
        end
      end
      ui.aq_deco[i] = ref
      ui.aq_weeds[i] = {
        img = ref, x = wd[4], y = wy, w = wd[2], h = wd[3], ang = 0, dx = 0,
        src = APP_DIR .. "assets/" .. wd[1] .. ".png",
      }
    end
    local shrimp_defs = { { "shrimp", 96, 3 }, { "shrimp_left", 176, 6 }, { "shrimp", 244, 2 } }
    ui.aq_shrimp = {}
    for i, sd in ipairs(shrimp_defs) do
      local ref = make_img(p2, sd[2], AQ_BED_Y - 9 + sd[3], 12, 8)
      if ref ~= nil then set_img_src(ref, APP_DIR .. "assets/" .. sd[1] .. ".png") end
      ui.aq_deco[#ui.aq_deco + 1] = ref
      ui.aq_shrimp[i] = {
        src = APP_DIR .. "assets/" .. sd[1] .. ".png",
        x = sd[2], y = AQ_BED_Y - 9 + sd[3], w = 12, h = 8,
      }
    end

    -- 吐泡：活动工具鱼持续吐泡；needs_user 时优先由主角鱼吐泡
    ui.aq_bubbles = {}
    for i = 1, 4 do
      local sz = (i % 2 == 0) and 5 or 3
      local b = make_panel(p2, 0, 0, sz, sz, math.floor(sz / 2), 0)
      set_bg(b, (i % 2 == 0) and 0xE0F2FE or 0x7DD3FC)
      set_visible(b, false)
      ui.aq_bubbles[i] = b
    end

    -- 六条鱼：体型按排名固定，颜色/姿态渲染时按数据切换；logo 圆牌跟在尾巴后
    ui.aq_fish = {}
    for i = 1, AQ_FISH_COUNT do
      local s = FISH_SIZE[i]
      local slotf = {}
      -- 鱼身、logo、百分比都直接挂在页面上。移动鱼身时不要带动一块透明外框。
      slotf.img = make_img(p2, 0, 0, s[1], s[2])
      slotf.logo_px = AQ_LOGO_SIZE
      slotf.logo = make_img(p2, 0, 0, slotf.logo_px, slotf.logo_px)
      slotf.logo_visible = false
      if slotf.logo ~= nil then
        -- 20px 源图缩放到鱼高 62%；圆形裁切四角
        pcall(function()
          local zoom = math.floor(slotf.logo_px / 20 * 256 + 0.5)
          if lv_img_set_zoom then lv_img_set_zoom(slotf.logo, zoom)
          elseif lv and lv.img_set_zoom then lv.img_set_zoom(slotf.logo, zoom) end
        end)
        pcall(function()
          local circle = rawget(_G, "LV_RADIUS_CIRCLE") or 0x7FFF
          if lv_obj_set_style_radius then lv_obj_set_style_radius(slotf.logo, circle, MAIN_STYLE)
          elseif lv and lv.obj_set_style_radius then lv.obj_set_style_radius(slotf.logo, circle, 0) end
          if lv_obj_set_style_clip_corner then lv_obj_set_style_clip_corner(slotf.logo, true, MAIN_STYLE)
          elseif lv and lv.obj_set_style_clip_corner then lv.obj_set_style_clip_corner(slotf.logo, true, 0) end
        end)
        set_visible(slotf.logo, false)
      end
      -- 短名 + 5小时 + / + 7天。挂在外框里，跟着鱼走，不再各开一段动画。
      local function make_tag_part(w, text)
        local ref = make_label(p2, 0, 0, text)
        set_font(ref, FONT_8)
        set_width(ref, w)
        set_align(ref, TEXT_ALIGN_CENTER)
        set_clip(ref)
        return ref
      end
      slotf.tag = make_tag_part(16, "--")
      slotf.tag_h5 = make_tag_part(20, "--")
      slotf.tag_slash = make_tag_part(8, "/")
      slotf.tag_d7 = make_tag_part(20, "--")
      slotf.zzz = make_label(p2, 0, 0, "z")
      set_font(slotf.zzz, FONT_8)
      set_color(slotf.zzz, COLOR_DIM)
      set_visible(slotf.zzz, false)
      slotf.bang = make_label(p2, 0, 0, "!")
      set_font(slotf.bang, FONT_12)
      set_color(slotf.bang, COLOR_WARN)
      set_visible(slotf.bang, false)
      ui.aq_fish[i] = slotf
    end

    -- 底部：与第 1 页相同的 RATE / TODAY / 7D / ALL
    ui.aq_stats = make_panel(p2, 8, 208, 304, 28, 7)
    ui.aq_stat_labels = {}
    ui.aq_stat_values = {}
    for i = 1, 4 do
      local x = 8 + (i - 1) * 76
      ui.aq_stat_labels[i] = make_label(p2, x, 210, stat_heads[i])
      set_font(ui.aq_stat_labels[i], FONT_8)
      set_width(ui.aq_stat_labels[i], 76)
      set_align(ui.aq_stat_labels[i], TEXT_ALIGN_CENTER)
      ui.aq_stat_values[i] = make_label(p2, x, 220, "--")
      set_font(ui.aq_stat_values[i], FONT_8)
      set_width(ui.aq_stat_values[i], 76)
      set_align(ui.aq_stat_values[i], TEXT_ALIGN_CENTER)
    end
  end
end

-- 显示层截断：按字节截断但不切断 UTF-8 多字节字符
local function utf8_trunc(text, max_bytes)
  if type(text) ~= "string" then return "--" end
  if #text <= max_bytes then return text end
  local cut = max_bytes
  while cut > 1 do
    local b = string.byte(text, cut + 1)
    if b == nil or b < 0x80 or b >= 0xC0 then break end
    cut = cut - 1
  end
  return text:sub(1, cut)
end

-- 固件字体只覆盖 ASCII（实机字形探测确认）：剥离非 ASCII；empty 为剥空后的占位
local function ascii_only(text, empty)
  if type(text) ~= "string" then return empty or "--" end
  local s = text:gsub("[\128-\255]+", " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  if #s == 0 then return empty or "[zh]" end
  return s
end

local function cubicserver_get(url, callback)
  if not http or not http.cubicserver or not http.cubicserver.get then return false end
  local ok = pcall(function()
    http.cubicserver.get(url, "Accept-Encoding: gzip\r\n", callback)
  end)
  return ok
end

local function apply_weather_now(now)
  if type(now) ~= "table" then return end
  local temp = tonumber(now.temp)
  local text = ascii_only(tostring(now.text or ""), "--")
  if text == "[zh]" then text = "--" end
  local city = app.weather.city_label
  if city == nil then
    city = ascii_only(tostring(now.name or ""), nil)
    if city == "[zh]" then city = nil end
  end
  app.state.weather = { city = city, temp = temp, text = text }
  if CODEX_MONITOR_APP.refresh then CODEX_MONITOR_APP.refresh() end
end

local function request_weather_now(location)
  if type(location) ~= "string" or #location == 0 then return end
  if app.weather.inflight then return end
  app.weather.inflight = true
  local url = "/v1/weather/now?location=" .. url_encode(location) .. "&unit=m&lang=en"
  local ok = cubicserver_get(url, function(code, body)
    app.weather.inflight = false
    if not app.running then return end
    if code ~= 200 then return end
    local doc = decode_json(gunzip_body(body))
    if type(doc) == "table" and tostring(doc.code) == "200" and type(doc.now) == "table" then
      apply_weather_now(doc.now)
    end
  end)
  if not ok then app.weather.inflight = false end
end

request_weather = function()
  if not app.running then return end
  local id = app.weather.location_id
  if type(id) == "string" and id:match("^%d+$") then
    request_weather_now(id)
    return
  end
  local q = app.weather.query
  if type(q) ~= "string" or #q == 0 then return end
  if q:match("^%d+$") then
    request_weather_now(q)
    return
  end
  local url = "/v1/weather/cities?location=" .. url_encode(q) .. "&number=1&lang=en"
  cubicserver_get(url, function(code, body)
    if not app.running then return end
    local doc = decode_json(gunzip_body(body))
    local locs = type(doc) == "table" and (doc.location or doc.locations) or nil
    local first = type(locs) == "table" and locs[1] or nil
    if type(first) == "table" and first.id ~= nil then
      app.weather.location_id = tostring(first.id)
      if type(first.name) == "string" then
        local name = ascii_only(first.name, nil)
        if name ~= nil and name ~= "[zh]" then app.weather.city_label = name end
      end
      request_weather_now(app.weather.location_id)
    end
  end)
end

-- 状态着色：working/idle/done 磷光绿，needs_user 琥珀，error 红，offline 灰
local function status_color(status)
  if status == "needs_user" then return COLOR_WARN end
  if status == "error" then return COLOR_ERR end
  if status == "offline" then return COLOR_OFFLINE end
  return COLOR_OK
end

-- 用量行：lv_bar 指示条按四档余额配色（>=80 绿 / >=50 蓝 / >=20 黄 / <20 红）；无窗口数据时置 0 + "--"
local function render_usage_bar(label_ref, bar_ref, pct_ref, reset_ref, prefix, win, dim)
  set_text(label_ref, prefix)
  set_color(label_ref, COLOR_DIM)
  if win == nil or bar_ref == nil then
    if bar_ref ~= nil then
      bar_set_value(bar_ref, 0)
      set_indicator_color(bar_ref, COLOR_DIM)
    end
    set_text(pct_ref, "--")
    set_color(pct_ref, COLOR_DIM)
    set_text(reset_ref, "RST --")
    set_color(reset_ref, COLOR_DIM)
    return
  end
  local remaining = win.remainingPercent
  bar_set_value(bar_ref, remaining)
  set_indicator_color(bar_ref, dim and COLOR_OFFLINE or usage_color(remaining))
  set_text(pct_ref, tostring(remaining) .. "%")
  set_color(pct_ref, COLOR_BRIGHT)
  set_text(reset_ref, "RST " .. fmt_reset(win.resetsAt))
  set_color(reset_ref, COLOR_DIM)
end

function CODEX_MONITOR_APP.render_overview()
  local ui, st = app.ui, app.state
  local dim = st.offline or not st.codex.connected

  local status = st.offline and "offline" or st.codex.status
  local accent = dim and COLOR_OFFLINE or status_color(status)

  -- 顶部：状态圆点 + 本日用量最高工具名小字
  -- 桥接快照无每工具"今日 tokens"字段，fallback 取槽位列表第一个工具；无数据保持 CODEX
  set_bg(ui.status_dot, accent)
  local top_tool = tm_top_tool_label()
  set_text(ui.codex_label, top_tool)
  set_color(ui.codex_label, COLOR_DIM)

  -- 状态大字 + 副标题
  set_text(ui.state_big, STATUS_LABEL[status] or "--")
  set_color(ui.state_big, accent)
  set_text(ui.state_sub, STATUS_SUB[status] or "--")
  set_color(ui.state_sub, COLOR_DIM)

  -- 天气卡片：固件 cubicserver 实况；城市优先 ASCII 地址，温度/概况 lang=en
  local w = st.weather
  set_text(ui.weather_city, ascii_only((w and w.city) or "--", "--"))
  set_color(ui.weather_city, COLOR_DIM)
  if w ~= nil and type(w.temp) == "number" then
    set_text(ui.weather_temp, string.format("%dC", math.floor(w.temp + 0.5)))
  else
    set_text(ui.weather_temp, "--")
  end
  set_color(ui.weather_temp, COLOR_BRIGHT)
  set_text(ui.weather_note, ascii_only(utf8_trunc((w and w.text) or "--", 12), "--"))
  set_color(ui.weather_note, COLOR_DIM)

  -- 任务卡片：英文状态 + 最近活动；固件无 CJK 字形
  set_bg(ui.task_ticon, accent)
  set_border_color(ui.card_task, status == "needs_user" and COLOR_WARN or COLOR_CARD_BORDER)
  local detail = STATUS_SUB[status] or "--"
  local acts = st.activities
  if type(acts) == "table" and #acts > 0 then
    local last = acts[#acts]
    if type(last) == "table" then
      local summary = ascii_only(last.summary, "")
      if summary ~= nil and summary ~= "" then detail = summary end
    end
  end
  set_text(ui.task_title, ascii_only((STATUS_LABEL[status] or "--") .. "  ·  " .. detail, "--"))
  set_color(ui.task_title, COLOR_BRIGHT)

  CODEX_MONITOR_APP.render_tokens()
  if dim then dim_label(ui) end -- 离线/断连：整体降暗，数据保留
  CODEX_MONITOR_APP.render_clock() -- 本地时钟不随桥接离线降暗
end

function CODEX_MONITOR_APP.render_clock()
  local ui = app.ui
  if ui == nil or ui.clock_time == nil then return end
  local cal, epoch = read_local_cal()
  if cal == nil then
    set_text(ui.clock_dow, "---")
    set_text(ui.clock_time, "--:--")
    set_text(ui.clock_date, "--")
    set_color(ui.clock_dow, COLOR_DIM)
    set_color(ui.clock_time, COLOR_BRIGHT)
    set_color(ui.clock_date, COLOR_DIM)
    set_text(ui.aq_clock, "--:--")
    set_color(ui.aq_clock, COLOR_DIM)
    return
  end
  local month = cal.month or cal.mon or 0
  local day = cal.day or 0
  set_text(ui.clock_dow, weekday_name(cal, epoch))
  set_text(ui.clock_time, string.format("%02d:%02d", cal.hour or 0, cal.min or 0))
  set_text(ui.clock_date, string.format("%02d-%02d", month, day))
  set_color(ui.clock_dow, COLOR_DIM)
  set_color(ui.clock_time, COLOR_BRIGHT)
  set_color(ui.clock_date, COLOR_DIM)
  -- 第 2 页水族箱 HUD 时钟同步
  set_text(ui.aq_clock, string.format("%02d:%02d", cal.hour or 0, cal.min or 0))
  set_color(ui.aq_clock, COLOR_DIM)
end

function CODEX_MONITOR_APP.render_details()
end

function CODEX_MONITOR_APP.render_tokens()
  local ui, st = app.ui, app.state
  local dim = st.offline
  local tm = st.token_monitor

  for i = 1, TOOL_SLOTS do
    local slot = ui.tm_slots[i]
    local tool = tm.tools[i]
    if tool == nil then
      if slot.arc ~= nil then
        arc_set_value(slot.arc, 0)
        set_arc_color(slot.arc, COLOR_TRACK)
      end
      set_text(slot.letter, "-")
      set_color(slot.letter, COLOR_DIM)
      set_visible(slot.letter, true)
      if slot.img ~= nil then set_visible(slot.img, false) end
      set_text(slot.pct, "--")
      set_color(slot.pct, COLOR_DIM)
      set_text(slot.name, "--")
      set_color(slot.name, COLOR_DIM)
    else
      local remaining = tool.remainingPercent
      local accent = remaining == nil and COLOR_DIM or (dim and COLOR_OFFLINE or usage_color(remaining))
      if slot.arc ~= nil then
        arc_set_value(slot.arc, remaining or 0)
        set_arc_color(slot.arc, remaining == nil and COLOR_TRACK or accent)
      end
      local name = tool_label(tool.id)
      local shown_img = false
      local has_icon = tm_has_icon(tool.id)
      if slot.img ~= nil and has_icon then
        shown_img = set_img_src(slot.img, APP_DIR .. "assets/tm_" .. tool.id .. ".png")
      end
      if shown_img then
        set_visible(slot.img, true)
        set_visible(slot.letter, false)
      else
        if slot.img ~= nil then set_visible(slot.img, false) end
        set_visible(slot.letter, true)
        set_text(slot.letter, name:sub(1, 1))
        set_color(slot.letter, COLOR_BRIGHT)
      end
      if remaining == nil then
        set_text(slot.pct, "--")
        set_color(slot.pct, COLOR_DIM)
      else
        set_text(slot.pct, tostring(remaining) .. "%")
        set_color(slot.pct, accent)
      end
      set_text(slot.name, name)
      set_color(slot.name, COLOR_DIM)
    end
  end

  local rate_text = "--"
  if tm.rate ~= nil and tm.rate_idle ~= true then
    rate_text = compact_num(tm.rate) .. "/m"
  end
  local stats = {
    { "RATE", rate_text },
    { "TODAY", compact_num(tm.today_tokens) },
    { "7D", compact_num(tm.last7_tokens) },
    { "ALL", compact_num(tm.all_tokens) },
  }
  for i = 1, 4 do
    set_text(ui.tm_stat_labels[i], stats[i][1])
    set_color(ui.tm_stat_labels[i], COLOR_DIM)
    set_text(ui.tm_stat_values[i], stats[i][2])
    set_color(ui.tm_stat_values[i], COLOR_BRIGHT)
  end
end

-- 主角鱼：codex 在场则由它演绎全局状态，否则用量第一名
local function aq_hero_index()
  local tools = app.state.token_monitor.tools
  for i = 1, AQ_FISH_COUNT do
    local tool = tools[i]
    if tool == nil then break end
    if tool.id == "codex" then return i end
  end
  return 1
end

local function aq_active_tool_index()
  local active_id = app.state.token_monitor.active_tool_id
  if active_id == nil then return nil end
  for i = 1, AQ_FISH_COUNT do
    local tool = app.state.token_monitor.tools[i]
    if tool == nil then break end
    if tool.id == active_id then return i end
  end
  return nil
end

-- 游速挂钩全机速率（像素/秒）。步长按真实经过的毫秒算，不假设定时器准时。
local function aq_px_s()
  local tm = app.state.token_monitor
  local rate = (tm ~= nil and tm.rate_idle ~= true) and tm.rate or 0
  if type(rate) ~= "number" then rate = 0 end
  if rate > 6000 then rate = 6000 end
  return 7 + rate / 6000 * 31
end

local function aq_swim_step(dt_ms)
  return aq_px_s() * dt_ms / 1000
end

-- tmr.now 是微秒，约 71 分钟回绕。迟到的一拍最多补 48ms，避免卡顿后瞬移。
local function aq_elapsed_ms()
  local now = (tmr and tmr.now) and tmr.now() or nil
  if type(now) ~= "number" then return AQ_TICK_MS end
  local prev = app.aq.last_us
  app.aq.last_us = now
  if type(prev) ~= "number" then return AQ_TICK_MS end
  local d = now - prev
  if d < 0 then d = d + 4294967296 end
  d = d / 1000
  if d > 48 then d = 48 end
  if d < 0 then d = 0 end
  return d
end

local function aq_ensure_fish(i)
  local f = app.aq.fish[i]
  if f == nil then
    f = { x = AQ_SWIM[i].x, y = AQ_SWIM[i].y, base_y = AQ_SWIM[i].y, dir = (i % 2 == 0) and -1 or 1 }
    app.aq.fish[i] = f
  end
  return f
end

local function aq_stop_swim(slotf)
  if slotf == nil then return end
  slotf.swim_key = nil
  slotf.leg_us = nil
  slotf.anim_checked = nil
  if lv_anim_del == nil or slotf.img == nil then return end
  pcall(lv_anim_del, slotf.img, nil)
end

local function aq_apply_sprite(slotf, i, f)
  if slotf.img ~= nil and f.tint ~= nil then
    set_img_src(slotf.img, fish_src(i, f.tint, f.dead, f.dir))
  end
end

local AQ_TAG_W = 64

local function aq_pct_text(pct)
  if pct == nil then return "--" end
  return tostring(math.floor(pct + 0.5))
end

-- 百分比用屏幕上的 FONT_8 标签横排。画布上的字会按窄宽度换行，比例就乱了。
local function aq_place_followers(slotf, i, f, fx, fy)
  local w, h = FISH_SIZE[i][1], FISH_SIZE[i][2]
  local lp = slotf.logo_px or AQ_LOGO_SIZE
  if slotf.logo_visible and slotf.logo ~= nil then
    local lx = (f.dir == -1) and (fx + w + 2) or (fx - lp - 2)
    set_pos(slotf.logo, lx, fy + math.floor((h - lp) / 2))
  end
  local x = fx + math.floor(w / 2) - math.floor(AQ_TAG_W / 2)
  local y = fy - 11
  set_pos(slotf.tag, x, y)
  set_pos(slotf.tag_h5, x + 16, y)
  set_pos(slotf.tag_slash, x + 36, y)
  set_pos(slotf.tag_d7, x + 44, y)
end

local function aq_follow(slotf, i, f, x, fy)
  local px = math.floor(x / 4) * 4
  local logo = (slotf.logo_visible and slotf.logo ~= nil) and 1 or 0
  if slotf.follow_q == px and slotf.follow_dir == f.dir and slotf.follow_logo == logo then return end
  slotf.follow_q = px
  slotf.follow_dir = f.dir
  slotf.follow_logo = logo
  aq_place_followers(slotf, i, f, px, fy)
end

local function aq_place_fish(slotf, i, f, fx, fy)
  set_pos(slotf.img, fx, fy)
  aq_place_followers(slotf, i, f, fx, fy)
  slotf.follow_q = math.floor(fx / 4) * 4
  slotf.follow_dir = f.dir
  slotf.follow_logo = (slotf.logo_visible and slotf.logo ~= nil) and 1 or 0
end

local function aq_show_tag(slotf, shown)
  set_visible(slotf.tag, shown)
  set_visible(slotf.tag_h5, shown)
  set_visible(slotf.tag_slash, shown)
  set_visible(slotf.tag_d7, shown)
end

local function aq_anim_x(obj, x0, x1, ms, ready)
  if obj == nil or lv_anim_t == nil or lv_anim_init == nil or lv_anim_set_var == nil
    or lv_anim_set_exec_cb == nil or lv_anim_set_values == nil or lv_anim_set_time == nil
    or lv_anim_start == nil or lv_obj_set_x == nil then
    return false
  end
  -- 有的固件 lv_anim_start 成功也不返回对象。失败会抛错；返回 nil 不能当成没启动，
  -- 否则定时器会再去挪同一条鱼，两套位置叠在一起就是卡顿。
  local ok = pcall(function()
    local a = lv_anim_t()
    lv_anim_init(a)
    lv_anim_set_var(a, obj)
    lv_anim_set_exec_cb(a, lv_obj_set_x)
    lv_anim_set_values(a, x0, x1)
    lv_anim_set_time(a, ms)
    if lv_anim_path_linear ~= nil and lv_anim_set_path_cb ~= nil then
      lv_anim_set_path_cb(a, lv_anim_path_linear)
    end
    if lv_anim_set_early_apply ~= nil then lv_anim_set_early_apply(a, true) end
    if ready ~= nil and lv_anim_set_ready_cb ~= nil then lv_anim_set_ready_cb(a, ready) end
    lv_anim_start(a)
  end)
  return ok
end

local aq_start_leg -- 前向声明：到边回调里再开下一段

local function aq_leg_done(i)
  if app.aq == nil or not app.running or app.page_index ~= 2 then return end
  local f = app.aq.fish[i]
  local slotf = app.ui.aq_fish and app.ui.aq_fish[i]
  if f == nil or slotf == nil or slotf.swim_key == nil then return end
  local w = FISH_SIZE[i][1]
  f.x = (f.dir == 1) and (312 - w) or 8
  f.dir = -f.dir
  slotf.swim_key = nil
  aq_start_leg(i)
end

-- 一条直线游到对面缸壁。只动画鱼身，Lua 在调头时换图。
aq_start_leg = function(i)
  local f = app.aq.fish[i]
  local slotf = app.ui.aq_fish and app.ui.aq_fish[i]
  if f == nil or slotf == nil or slotf.img == nil then return false end
  local w = FISH_SIZE[i][1]
  local x_min, x_max = 8, 312 - w
  local from = math.floor(f.x)
  if from < x_min then from = x_min end
  if from > x_max then from = x_max end
  local to = (f.dir == 1) and x_max or x_min
  if to == from then
    f.dir = -f.dir
    to = (f.dir == 1) and x_max or x_min
  end
  local dist = to - from
  if dist < 0 then dist = -dist end
  local spd = f.spd or 7
  local ms = math.floor(dist / spd * 1000)
  if ms < 16 then ms = 16 end
  f.x = from
  local fy = math.floor(f.base_y)
  f.y = fy
  aq_apply_sprite(slotf, i, f)
  aq_place_fish(slotf, i, f, from, fy)
  slotf.leg_id = (slotf.leg_id or 0) + 1
  local leg_id = slotf.leg_id
  if not aq_anim_x(slotf.img, from, to, ms, function()
    if slotf.leg_id ~= leg_id then return end
    aq_leg_done(i)
  end) then
    slotf.swim_key = nil
    slotf.leg_us = nil
    return false
  end
  slotf.leg_from = from
  slotf.leg_to = to
  slotf.leg_ms = ms
  slotf.leg_us = (tmr and tmr.now) and tmr.now() or nil
  slotf.anim_checked = nil
  slotf.swim_key = "swim:" .. tostring(f.dir) .. ":" .. tostring(spd)
  return true
end

local function aq_place_still(i, mode)
  local slotf = app.ui.aq_fish[i]
  local f = aq_ensure_fish(i)
  local w, h = FISH_SIZE[i][1], FISH_SIZE[i][2]
  aq_stop_swim(slotf)
  if mode == "rest" then
    f.x = AQ_REST_X[i]
    f.y = AQ_BED_Y - h
  elseif mode == "knock" then
    f.dir = 1
    f.x = 312 - w - 4
    f.y = 84 + (app.aq.tick % 2) * 2
  end
  local fx, fy = math.floor(f.x), math.floor(f.y)
  aq_apply_sprite(slotf, i, f)
  aq_place_fish(slotf, i, f, fx, fy)
  if mode == "rest" then set_pos(slotf.zzz, fx + w - 6, fy - 11) end
  if mode == "knock" then set_pos(slotf.bang, fx + w + 1, fy - 13) end
end

local function aq_mode(i, status, dim, hero, sleeping)
  if sleeping then return "rest" end
  if status == "needs_user" and i == hero then return "knock" end
  if status == "error" and i == hero then return "dead" end
  return "swim"
end

-- 只改姿态和是否在游。已经在游的同一段不重启动画，避免每秒快照把鱼拽回起点。
local function aq_refresh_motion()
  local ui, st = app.ui, app.state
  if ui.aq_fish == nil then return end
  local dim = st.offline or not st.codex.connected
  local status = st.offline and "offline" or st.codex.status
  local hero = aq_hero_index()
  local sleeping = dim or status == "idle" or status == "offline"
  local spd_now = math.floor(aq_px_s() + 0.5)
  for i = 1, AQ_FISH_COUNT do
    local slotf = ui.aq_fish[i]
    if slotf ~= nil and st.token_monitor.tools[i] ~= nil then
      local f = aq_ensure_fish(i)
      local mode = aq_mode(i, status, dim, hero, sleeping)
      if mode == "swim" and app.page_index == 2 then
        if f.spd == nil or math.abs(f.spd - spd_now) >= 3 then f.spd = spd_now end
        if aq_canvas_ok ~= nil and aq_canvas_ok() then
          -- 画布贴 PNG 在这台固件上不显示。鱼和 logo 仍用图片控件，只是不再开 lv_anim。
          aq_stop_swim(slotf)
          aq_place_fish(slotf, i, f, math.floor(f.x), math.floor(f.base_y or f.y))
        else
        local key = "swim:" .. tostring(f.dir) .. ":" .. tostring(f.spd)
        if slotf.swim_key ~= key then
          if slotf.img ~= nil and lv_obj_get_x ~= nil and slotf.swim_key ~= nil then
            local ok, x = pcall(lv_obj_get_x, slotf.img)
            if ok and type(x) == "number" then f.x = x end
          end
          aq_stop_swim(slotf)
          aq_start_leg(i)
        end
        end
      else
        aq_place_still(i, mode)
      end
    elseif slotf ~= nil then
      aq_stop_swim(slotf)
    end
  end
end

-- 吐泡用这段动画的起点和时长推算嘴的位置，定时器不再逐条去读控件坐标。
local function aq_predict_x(slotf, f)
  local us = slotf.leg_us
  if type(us) ~= "number" or type(slotf.leg_ms) ~= "number" or slotf.leg_ms <= 0 then return f.x end
  if not (tmr and tmr.now) then return f.x end
  local now = tmr.now()
  if type(now) ~= "number" then return f.x end
  local d = now - us
  if d < 0 then d = d + 4294967296 end
  local t = (d / 1000) / slotf.leg_ms
  if t < 0 then t = 0 end
  if t > 1 then t = 1 end
  return slotf.leg_from + (slotf.leg_to - slotf.leg_from) * t
end

-- 水草左右 2 像素。旋转贴图会在游动刷新里整块重绘，鱼会跟着顿。
local function aq_sway_weeds()
  local weeds = app.ui and app.ui.aq_weeds
  if weeds == nil then return end
  local now = (tmr and tmr.now and tmr.now()) or (app.aq.tick * AQ_TICK_MS * 1000)
  if type(now) ~= "number" then return end
  for i, w in ipairs(weeds) do
    if w.img ~= nil then
      local period = 2400 + (i - 1) * 350
      local s = math.sin((now / 1000 % period) / period * 6.28318530718)
      local dx = math.floor(s * 2 + 0.5)
      if w.dx ~= dx then
        w.dx = dx
        set_pos(w.img, w.x + dx, w.y)
      end
    end
  end
end

-- 动画若没真正在改坐标，交给定时器。慢速 7px/s 时 280ms 至少应走出 1px。
local function aq_anim_stalled(slotf)
  if slotf.anim_checked or slotf.img == nil or lv_obj_get_x == nil then return false end
  local us = slotf.leg_us
  if type(us) ~= "number" or not (tmr and tmr.now) then return false end
  local now = tmr.now()
  if type(now) ~= "number" then return false end
  local d = now - us
  if d < 0 then d = d + 4294967296 end
  if d / 1000 < 280 then return false end
  slotf.anim_checked = true
  if type(slotf.leg_ms) == "number" and slotf.leg_ms < 500 then return false end
  local ok, x = pcall(lv_obj_get_x, slotf.img)
  if not ok or type(x) ~= "number" then return false end
  return math.abs(x - slotf.leg_from) < 1
end

local function aq_lerp(a, b, t)
  local function ch(c, shift)
    return math.floor(c / shift) % 256
  end
  local function mix(u, v)
    return math.floor(u + (v - u) * t + 0.5)
  end
  local r = mix(ch(a, 65536), ch(b, 65536))
  local g = mix(ch(a, 256), ch(b, 256))
  local bl = mix(a % 256, b % 256)
  return r * 65536 + g * 256 + bl
end

-- 水面只画一次。这台固件的画布贴不上 PNG，鱼和 logo 用图片控件。
local function aq_paint_frame()
  local cvs = app.ui.aq_canvas
  local y0 = AQ_CANVAS_Y
  lv_canvas_frame_begin(cvs)
  lv_canvas_fill_bg(cvs, 0x08202C, 255)
  local bed = AQ_BED_Y - y0
  if lv_canvas_draw_rect ~= nil and bed > 0 then
    local bands = 8
    local bh = math.floor(bed / bands)
    for i = 0, bands - 1 do
      local y = i * bh
      local h = (i == bands - 1) and (bed - y) or bh
      local color = aq_lerp(0x08202C, 0x050D14, (i + 0.5) / bands)
      lv_canvas_draw_rect(cvs, 0, y, 320, h, { bg_color = color, bg_opa = 255 })
    end
    lv_canvas_draw_rect(cvs, 0, bed, 320, AQ_CANVAS_H - bed, { bg_color = 0x0B151E, bg_opa = 255 })
  end
  lv_canvas_frame_end(cvs)
  if lv_obj_move_background ~= nil then pcall(lv_obj_move_background, cvs) end
end

aq_canvas_ok = function()
  local c = app.ui and app.ui.aq_canvas
  return c ~= nil and c ~= 0 and app.aq ~= nil and app.aq.canvas_dead ~= true
end

local function aq_release_canvas()
  app.aq.canvas_dead = true
  local ui = app.ui
  if ui == nil then return end
  set_visible(ui.aq_bed, true)
  for _, ref in ipairs(ui.aq_deco or {}) do set_visible(ref, true) end
  for _, slotf in ipairs(ui.aq_fish or {}) do
    set_visible(slotf.img, true)
    if slotf.logo_visible then set_visible(slotf.logo, true) end
    aq_show_tag(slotf, true)
  end
  aq_refresh_motion()
end

aq_paint = function()
  if not aq_canvas_ok() then return end
  local ok = pcall(aq_paint_frame)
  if not ok then aq_release_canvas() end
end

-- 定时器只在第 2 页可见时推进。有画布时鱼的坐标在这里走，画面一次画完。
local function aq_tick()
  if not app.running or app.page_index ~= 2 then
    app.aq.last_us = nil
    return
  end
  local ui, st = app.ui, app.state
  if ui.aq_fish == nil then return end
  app.aq.tick = app.aq.tick + 1
  local dim = st.offline or not st.codex.connected
  local status = st.offline and "offline" or st.codex.status
  local hero = aq_hero_index()
  local sleeping = dim or status == "idle" or status == "offline"
  local dt = aq_elapsed_ms()

  for i = 1, AQ_FISH_COUNT do
    local slotf = ui.aq_fish[i]
    if slotf ~= nil and st.token_monitor.tools[i] ~= nil then
      local f = aq_ensure_fish(i)
      local mode = aq_mode(i, status, dim, hero, sleeping)
      local w = FISH_SIZE[i][1]
      if mode == "swim" and slotf.swim_key ~= nil then
        if aq_anim_stalled(slotf) then
          aq_stop_swim(slotf)
        else
          f.x = aq_predict_x(slotf, f)
          aq_follow(slotf, i, f, f.x, f.base_y)
        end
      end
      if mode == "swim" and slotf.swim_key == nil then
        -- 固件没有 lv_anim 时，按真实间隔挪鱼身，游到缸边调头
        local step = aq_swim_step(dt)
        f.x = f.x + f.dir * step
        if f.x <= 8 then f.x = 8; f.dir = 1 end
        if f.x >= 312 - w then f.x = 312 - w; f.dir = -1 end
        f.y = f.base_y
        local fx, fy = math.floor(f.x), math.floor(f.y)
        if f.lay_dir ~= f.dir then
          aq_apply_sprite(slotf, i, f)
          f.lay_dir = f.dir
        end
        set_pos(slotf.img, fx, fy)
        aq_follow(slotf, i, f, fx, fy)
      elseif mode == "knock" then
        f.dir = 1
        f.x = 312 - w - 4
        f.y = 84 + (app.aq.tick % 2) * 2
        local fx, fy = math.floor(f.x), math.floor(f.y)
        set_pos(slotf.img, fx, fy)
        aq_place_followers(slotf, i, f, fx, fy)
        set_pos(slotf.bang, fx + w + 1, fy - 13)
      end
    end
  end

  aq_sway_weeds()

  -- 吐泡：needs_user 优先主角鱼；否则由最近仍在产出 token 的上榜工具鱼吐泡。
  local bubble_fish = (status == "needs_user") and hero or aq_active_tool_index()
  local bubble_on = not dim and bubble_fish ~= nil and st.token_monitor.tools[bubble_fish] ~= nil
  if bubble_on then
    local slotf = ui.aq_fish[bubble_fish]
    local f = aq_ensure_fish(bubble_fish)
    if slotf ~= nil and slotf.swim_key ~= nil then f.x = aq_predict_x(slotf, f) end
  end
  for i, bref in ipairs(ui.aq_bubbles or {}) do
    local b = app.aq.bubbles[i]
    if b == nil then b = {}; app.aq.bubbles[i] = b end
    if bubble_on then
      local f = aq_ensure_fish(bubble_fish)
      local fish_w = FISH_SIZE[bubble_fish][1]
      if b.y == nil or b.y < AQ_TANK_TOP + 4 or b.fish ~= bubble_fish then
        local mouth_x = (f.dir == 1) and (math.floor(f.x) + fish_w - 3) or (math.floor(f.x) - 2)
        b.x = mouth_x + ((i % 2 == 0) and 3 or -2)
        if b.x < 2 then b.x = 2 end
        if b.x > 314 then b.x = 314 end
        b.y = math.floor(f.y) + 7 - (i - 1) * 9
        b.fish = bubble_fish
      else
        b.y = b.y - 2 - (i % 2)
      end
      set_pos(bref, b.x, b.y)
      set_visible(bref, true)
    else
      b.y = nil
      b.fish = nil
      set_visible(bref, false)
    end
  end
end

function CODEX_MONITOR_APP.render_aquarium()
  local ui, st = app.ui, app.state
  if ui.aq_fish == nil then return end
  local dim = st.offline or not st.codex.connected
  local status = st.offline and "offline" or st.codex.status
  local tm = st.token_monitor
  local hero = aq_hero_index()
  local sleeping = dim or status == "idle" or status == "offline"

  -- HUD：状态点 + 本日用量最高工具 + 状态字
  set_bg(ui.aq_dot, dim and COLOR_OFFLINE or status_color(status))
  set_text(ui.aq_brand, tm_top_tool_label())
  set_color(ui.aq_brand, COLOR_DIM)
  set_text(ui.aq_sub, STATUS_LABEL[status] or "--")
  set_color(ui.aq_sub, dim and COLOR_OFFLINE or status_color(status))
  set_color(ui.aq_legend, dim and COLOR_OFFLINE or COLOR_DIM)

  local pill_on = status == "needs_user" and not dim
  set_visible(ui.aq_pill, pill_on)
  set_visible(ui.aq_pill_text, pill_on)

  for i = 1, AQ_FISH_COUNT do
    local slotf = ui.aq_fish[i]
    local tool = tm.tools[i]
    if slotf == nil then break end
    if tool == nil then
      aq_stop_swim(slotf)
      set_visible(slotf.img, false)
      set_visible(slotf.logo, false)
      slotf.logo_visible = false
      aq_show_tag(slotf, false)
      set_visible(slotf.zzz, false)
      set_visible(slotf.bang, false)
      app.aq.fish[i] = nil -- 槽位空了重置游动状态
    else
      local is_hero = i == hero
      local dead = is_hero and status == "error" and not dim
      local h5 = tool.fiveHourPercent
      local d7 = tool.sevenDayPercent
      local tint = (dim or h5 == nil) and "gray" or fish_tint(h5)
      local f = aq_ensure_fish(i)
      f.tint, f.dead = tint, dead -- aq_tick 调头换图时要用
      if slotf.img ~= nil then
        set_img_src(slotf.img, fish_src(i, tint, dead, f.dir))
        set_visible(slotf.img, true)
        if lv_obj_move_foreground ~= nil then pcall(lv_obj_move_foreground, slotf.img) end
      end
      -- 尾巴后的 agent logo 圆牌（无素材的工具隐藏）
      if slotf.logo ~= nil then
        local shown = false
        if tm_has_icon(tool.id) then
          shown = set_img_src(slotf.logo, APP_DIR .. "assets/tm_" .. tool.id .. ".png")
        end
        set_visible(slotf.logo, shown)
        slotf.logo_visible = shown
        if shown and lv_obj_move_foreground ~= nil then pcall(lv_obj_move_foreground, slotf.logo) end
      end
      local tag = aq_tag(tool.id)
      local offline = dim and COLOR_OFFLINE or nil
      set_text(slotf.tag, tag)
      set_text(slotf.tag_h5, aq_pct_text(h5))
      set_text(slotf.tag_d7, aq_pct_text(d7))
      set_color(slotf.tag, offline or COLOR_TEXT)
      set_color(slotf.tag_h5, offline or (h5 == nil and COLOR_DIM or usage_color(h5)))
      set_color(slotf.tag_slash, offline or COLOR_DIM)
      set_color(slotf.tag_d7, offline or (d7 == nil and COLOR_DIM or usage_color(d7)))
      aq_show_tag(slotf, true)
      set_visible(slotf.zzz, sleeping)
      set_visible(slotf.bang, pill_on and is_hero)
    end
  end

  -- 底栏：与第 1 页一致的 RATE / TODAY / 7D / ALL
  local rate_text = "--"
  if tm.rate ~= nil and tm.rate_idle ~= true then
    rate_text = compact_num(tm.rate) .. "/m"
  end
  local stats = {
    { "RATE", rate_text },
    { "TODAY", compact_num(tm.today_tokens) },
    { "7D", compact_num(tm.last7_tokens) },
    { "ALL", compact_num(tm.all_tokens) },
  }
  for i = 1, 4 do
    set_text(ui.aq_stat_labels[i], stats[i][1])
    set_color(ui.aq_stat_labels[i], COLOR_DIM)
    set_text(ui.aq_stat_values[i], stats[i][2])
    set_color(ui.aq_stat_values[i], dim and COLOR_OFFLINE or COLOR_BRIGHT)
  end

  aq_refresh_motion() -- 开/停游动段；不在这里按定时器节拍再推进一步
  if app.aq.bg_painted ~= true then
    aq_paint()
    app.aq.bg_painted = true
  end
end

function CODEX_MONITOR_APP.render_page(index)
  local switched = app.page_index ~= index or app.page_shown ~= true
  app.page_index = index
  app.page_shown = true
  if switched and app.pages ~= nil then
    for i = 1, PAGE_COUNT do set_visible(app.pages[i], i == index) end
  end
  if index ~= 2 and app.ui ~= nil and app.ui.aq_fish ~= nil then
    for i = 1, AQ_FISH_COUNT do aq_stop_swim(app.ui.aq_fish[i]) end
    if app.aq ~= nil then app.aq.last_us = nil end
  end
  if index == 2 then
    CODEX_MONITOR_APP.render_aquarium()
  else
    CODEX_MONITOR_APP.render_overview()
  end
end

-- 不自动轮播：仅 LEFT/RIGHT 手动切页
function CODEX_MONITOR_APP.switch_page(index, manual)
  if index < 1 then index = PAGE_COUNT end
  if index > PAGE_COUNT then index = 1 end
  CODEX_MONITOR_APP.render_page(index)
end

function CODEX_MONITOR_APP.refresh()
  CODEX_MONITOR_APP.render_page(app.page_index)
end

-- ---------------------------------------------------------------------------
-- 快照归一化：只接受白名单字段，逐字段降级，不阻塞 UI 回调
-- ---------------------------------------------------------------------------

local function trunc_label(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("[%z\1-\31]", " "):gsub("^%s+", ""):gsub("%s+$", "")
  if #text > MAX_ACTIVITY_LABEL then text = text:sub(1, MAX_ACTIVITY_LABEL) end
  if #text == 0 then return nil end
  return text
end

local function coerce_number(value)
  if type(value) == "number" then
    if value ~= value then return nil end
    return value
  end
  if type(value) == "string" then
    local n = tonumber(value)
    if n == nil or n ~= n then return nil end
    return n
  end
  return nil
end

local function valid_number(value, lo, hi)
  local n = coerce_number(value)
  if n == nil then return nil end
  if lo ~= nil and n < lo then return nil end
  if hi ~= nil and n > hi then return nil end
  return n
end

local function valid_status(value)
  if type(value) == "string" and VALID_STATUS[value] then return value end
  return nil
end

-- allTime 已超过 2^31-1。桥接会改发字符串；若固件仍解成 32 位溢出负数，这里还原。
local function parse_count(value)
  local n = coerce_number(value)
  if n == nil then return nil end
  if n < 0 and n >= -2147483648 then n = n + 4294967296.0 end
  if n < 0 then return nil end
  return n
end

local function parse_totals(raw)
  if type(raw) ~= "table" then return nil, nil end
  return parse_count(raw.tokens), valid_number(raw.costUsd, 0)
end

local function normalize_token_monitor(raw)
  local tm = app.state.token_monitor
  if type(raw) ~= "table" then
    tm.available = false
    tm.stale = true
    tm.tools = {}
    tm.active_tool_id = nil
    tm.rate = nil
    tm.rate_idle = true
    tm.today_tokens, tm.today_cost = nil, nil
    tm.last7_tokens, tm.last7_cost = nil, nil
    tm.all_tokens, tm.all_cost = nil, nil
    return
  end
  tm.available = raw.available == true
  tm.stale = raw.stale == true or not tm.available
  tm.active_tool_id = nil
  if type(raw.activeToolId) == "string" then
    local active_id = string.lower(raw.activeToolId):gsub("[^a-z0-9_-]", "")
    if #active_id > 24 then active_id = active_id:sub(1, 24) end
    if #active_id > 0 then tm.active_tool_id = active_id end
  end
  tm.tools = {}
  if type(raw.tools) == "table" then
    for _, item in ipairs(raw.tools) do
      if type(item) == "table" and type(item.id) == "string" then
        local id = string.lower(item.id):gsub("[^a-z0-9_-]", "")
        if #id > 24 then id = id:sub(1, 24) end
        if #id > 0 then
          table.insert(tm.tools, {
            id = id,
            rank = valid_number(item.rank, 1, TOOL_SLOTS) or (#tm.tools + 1),
            remainingPercent = valid_number(item.remainingPercent, 0, 100),
            window = trunc_label(item.window) or "--",
            fiveHourPercent = valid_number(item.fiveHourPercent, 0, 100),
            sevenDayPercent = valid_number(item.sevenDayPercent, 0, 100),
            todayTokens = valid_number(item.todayTokens, 0), -- 桥接暂未输出，预留
          })
        end
      end
      if #tm.tools >= TOOL_SLOTS then break end
    end
  end
  local rate = raw.rate
  if type(rate) == "table" then
    tm.rate = valid_number(rate.tokensPerMin, 0)
    tm.rate_idle = rate.idle == true or tm.rate == nil
  else
    tm.rate = nil
    tm.rate_idle = true
  end
  tm.today_tokens, tm.today_cost = parse_totals(raw.today)
  tm.last7_tokens, tm.last7_cost = parse_totals(raw.last7)
  tm.all_tokens, tm.all_cost = parse_totals(raw.allTime)
end

local function find_window(windows, duration)
  if type(windows) ~= "table" then return nil end
  for _, w in ipairs(windows) do
    if type(w) == "table" and w.windowDurationMins == duration then
      local remaining = valid_number(w.remainingPercent, 0, 100)
      local resets = valid_number(w.resetsAt, 0)
      if remaining ~= nil and resets ~= nil then
        return { remainingPercent = remaining, resetsAt = resets }
      end
      return nil -- 窗口字段非法按缺失处理
    end
  end
  return nil
end

local function normalize_body(body)
  local st = app.state
  local codex = st.codex
  normalize_token_monitor(body.token_monitor)
  codex.connected = body.codex_connected == true
  if not codex.connected then
    -- 桥接可达但 Codex 断开：保留最后数据，仅标记断开（界面降暗）
    st.offline = false
    st.fail_count = 0
    if type(body.last_updated_at) == "number" then st.last_update = body.last_updated_at end
    CODEX_MONITOR_APP.refresh()
    return
  end

  codex.status = valid_status(body.status) or "idle"

  local pt = body.primary_task
  if type(pt) == "table" then
    codex.primary_task = {
      title = trunc_label(pt.title),
      status = valid_status(pt.status) or "idle",
      model = trunc_label(pt.model),
      contextPercent = valid_number(pt.contextPercent, 0, 100),
      lastActiveAt = valid_number(pt.lastActiveAt, 0),
    }
  else
    codex.primary_task = nil
  end

  codex.other_active_task_count = valid_number(body.other_active_task_count, 0) or 0

  local activities = {}
  if type(body.activities) == "table" then
    for _, item in ipairs(body.activities) do
      if type(item) == "table" then
        local summary = trunc_label(item.summary)
        if summary ~= nil then
          table.insert(activities, {
            stage = trunc_label(item.stage) or "processing",
            summary = summary,
            at = valid_number(item.at, 0) or 0,
          })
        end
      end
    end
  end
  table.sort(activities, function(a, b) return a.at < b.at end)
  while #activities > 5 do table.remove(activities, 1) end
  st.activities = activities

  local windows = (type(body.usage) == "table") and body.usage.windows or nil
  st.usage.five_hour = find_window(windows, 300)
  st.usage.seven_day = find_window(windows, 10080)

  st.last_update = valid_number(body.server_time, 0) or st.last_update
  st.offline = false
  st.fail_count = 0
  CODEX_MONITOR_APP.refresh()
end

local function on_bridge_failure()
  local st = app.state
  st.fail_count = st.fail_count + 1
  if st.fail_count >= OFFLINE_AFTER_FAILURES then
    st.offline = true -- 进入离线：保留最后非敏感数据并整体降暗
  end
  CODEX_MONITOR_APP.refresh()
end

local function on_bridge_response(code, body)
  if code ~= 200 or type(body) ~= "string" then
    on_bridge_failure()
    return
  end
  local ok, decoded = pcall(sjson.decode, body) -- 实机验证点：JSON 库名
  if not ok or type(decoded) ~= "table" then
    on_bridge_failure()
    return
  end
  normalize_body(decoded)
end

local function poll_bridge()
  if not app.running then return end
  if not valid_host(app.config.host) or not valid_port(app.config.port) then
    on_bridge_failure()
    return
  end
  local url = "http://" .. app.config.host .. ":" .. tostring(app.config.port) .. "/api/v1/status"
  local ok = pcall(function()
    http.get(url, {
      timeout = HTTP_TIMEOUT_MS,
      headers = { Accept = "application/json", ["Accept-Encoding"] = "identity", Connection = "close" },
    }, function(code, body)
      on_bridge_response(code, body)
    end)
  end)
  if not ok then on_bridge_failure() end
end

-- ---------------------------------------------------------------------------
-- 生命周期
-- ---------------------------------------------------------------------------

function CODEX_MONITOR_APP.start()
  if app.running then return end
  app.running = true
  load_config()
  load_weather_settings()

  if lv_scr_act then
    app.root = lv_scr_act()
    app.owns_screen = false
    if lv_obj_clean then pcall(lv_obj_clean, app.root) end
  elseif lv and lv.obj then
    app.root = lv.obj(nil)
    app.owns_screen = true
  end
  pcall(function()
    if lv_obj_set_size then lv_obj_set_size(app.root, 320, 240)
    elseif lv then lv.obj_set_size(app.root, 320, 240) end
  end)

  build_ui()

  if key and key.on then
    key.on(key.LEFT, function(evt_type)
      if evt_type == nil or evt_type == key.SHORT then CODEX_MONITOR_APP.on_key("left") end
    end)
    key.on(key.RIGHT, function(evt_type)
      if evt_type == nil or evt_type == key.SHORT then CODEX_MONITOR_APP.on_key("right") end
    end)
    key.on(key.HOME, function(evt_type)
      if evt_type == nil or evt_type == key.SHORT then CODEX_MONITOR_APP.on_key("home") end
    end)
    app.key_registered = true
  end

  CODEX_MONITOR_APP.render_page(1)
  every(1000, function() CODEX_MONITOR_APP.tick() end) -- 1 秒轮询桥接状态
  every(AQ_TICK_MS, function() aq_tick(false) end) -- 水族箱游动动画（仅第 2 页可见时推进）
  if request_weather then
    request_weather()
    every(60000, function() request_weather() end)
  end
end

function CODEX_MONITOR_APP.tick()
  CODEX_MONITOR_APP.render_clock()
  poll_bridge()
end

function CODEX_MONITOR_APP.on_key(name)
  if name == "left" then
    CODEX_MONITOR_APP.switch_page(app.page_index - 1, true)
  elseif name == "right" then
    CODEX_MONITOR_APP.switch_page(app.page_index + 1, true)
  elseif name == "home" then
    -- 实机验证点：Cubic 系统退出 API；不可用时回退到自身 stop
    if _G.app ~= nil and type(_G.app.exit) == "function" then
      _G.app.exit()
    else
      CODEX_MONITOR_APP.stop("home")
    end
  end
end

function CODEX_MONITOR_APP.stop(reason)
  stop_timers()
  unregister_keys()
  clear_root()
  app.pages = nil
  app.ui = {}
  app.aq = nil
  app.page_shown = false
  app.running = false
  CODEX_MONITOR_APP = nil
end

function CODEX_MONITOR_APP.shutdown()
  CODEX_MONITOR_APP.stop("shutdown")
end

-- 系统注册钩子（实机验证点：Cubic 应用注册约定）。
if app_register ~= nil and type(app_register.reg) == "function" then
  app_register.reg(APP_ID, { start = CODEX_MONITOR_APP.start, stop = CODEX_MONITOR_APP.stop })
end

if CODEX_MONITOR_APP and not CODEX_MONITOR_APP.running then
  pcall(CODEX_MONITOR_APP.start)
end
