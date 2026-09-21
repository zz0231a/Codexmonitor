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
    tools = {}, -- 最多 4 条 { id, rank, remainingPercent, window }
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
-- 页面布局：仅第 1 页。圆环为总用量前八，尺寸缩小以便两行放下。
-- ---------------------------------------------------------------------------

local PAGE_COUNT = 1
local TOOL_SLOTS = 8
local ROTATE_MS = 30000

app.page_index = 1
app.page_shown = false
app.rotate_timer = nil
app.pages = nil
app.ui = {} -- 全部 LVGL 控件引用，退出时随 root 一起删除

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
  local v, suffix
  if n >= 1e9 then v, suffix = n / 1e9, "B"
  elseif n >= 1e6 then v, suffix = n / 1e6, "M"
  elseif n >= 1e3 then v, suffix = n / 1e3, "K"
  else return tostring(math.floor(n + 0.5)) end
  local text = string.format("%.1f", v)
  if text:sub(-2) == ".0" then text = text:sub(1, -3) end
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

local function fmt_reset(ts)
  -- 实机确认：固件无 os.date；time.epoch2cal 返回 UTC，time.cal2epoch 把输入当本地时间。
  -- 偏移 = time.get() - cal2epoch(epoch2cal(get()))，每次现算，NTP 同步后自动正确。
  if time and time.epoch2cal then
    local offset = 0
    if time.get and time.cal2epoch then
      local ok1, sec = pcall(time.get)
      local ok2, utc_cal = false, nil
      if ok1 and type(sec) == "number" then
        ok2, utc_cal = pcall(time.epoch2cal, sec) -- 不能用 and 连乘：会砍掉 pcall 的第二返回值
      end
      if ok2 and type(utc_cal) == "table" then
        local ok3, back = pcall(time.cal2epoch, utc_cal)
        if ok3 and type(back) == "number" and type(sec) == "number" then
          offset = sec - back
        end
      end
    end
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

  -- 状态大字 + dim 副标题（宽度避开右上天气卡）
  ui.state_big = make_label(p1, 8, 26, "--")
  set_font(ui.state_big, FONT_24)
  set_width(ui.state_big, 220)
  set_clip(ui.state_big)
  ui.state_sub = make_label(p1, 8, 56, "--")
  set_font(ui.state_sub, FONT_10)
  set_width(ui.state_sub, 220)
  set_clip(ui.state_sub)

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
    -- 图标缩小 20% 防遮环：显示 19.2px（24*0.8），LVGL auto_size 锚左上角，
    -- 左上角取 (x+27, y+7) 使视觉圆心保持 (x+37, y+17)
    slot.img = make_img(p1, x + 27, y + 7, 19, 19)
    -- 20px 源图缩到 19.2px：LVGL zoom 256=1:1，307*0.8=246
    if slot.img ~= nil then
      pcall(function()
        if lv_img_set_zoom then lv_img_set_zoom(slot.img, 246)
        elseif lv and lv.img_set_zoom then lv.img_set_zoom(slot.img, 246) end
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

  -- 任务卡片：needs_user 时边框与色条变琥珀
  local pt = st.codex.primary_task
  set_bg(ui.task_ticon, accent)
  set_border_color(ui.card_task, status == "needs_user" and COLOR_WARN or COLOR_CARD_BORDER)
  set_text(ui.task_title, ascii_only(utf8_trunc((pt ~= nil and pt.title) or "--", 42)))
  set_color(ui.task_title, COLOR_BRIGHT)

  CODEX_MONITOR_APP.render_tokens()
  if dim then dim_label(ui) end -- 离线/断连：整体降暗，数据保留
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
      local has_icon = type(tool.id) == "string" and (
        tool.id == "codex" or tool.id == "cursor" or tool.id == "workbuddy"
        or tool.id == "kimi" or tool.id == "claude" or tool.id == "grok"
        or tool.id == "deepseek"
      )
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

function CODEX_MONITOR_APP.render_page(index)
  local switched = app.page_index ~= index or app.page_shown ~= true
  app.page_index = index
  app.page_shown = true
  if switched and app.pages ~= nil then
    for i = 1, PAGE_COUNT do set_visible(app.pages[i], i == index) end
  end
  CODEX_MONITOR_APP.render_overview()
end

local function restart_rotation()
  if app.rotate_timer ~= nil then cancel_timer(app.rotate_timer) end
  app.rotate_timer = every(ROTATE_MS, function()
    CODEX_MONITOR_APP.switch_page(app.page_index % PAGE_COUNT + 1, false)
  end)
end

function CODEX_MONITOR_APP.switch_page(index, manual)
  if index < 1 then index = PAGE_COUNT end
  if index > PAGE_COUNT then index = 1 end
  CODEX_MONITOR_APP.render_page(index)
  if manual then restart_rotation() end -- 手动切换后重计 30 秒
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

local function valid_number(value, lo, hi)
  if type(value) ~= "number" or value ~= value then return nil end
  if lo ~= nil and value < lo then return nil end
  if hi ~= nil and value > hi then return nil end
  return value
end

local function valid_status(value)
  if type(value) == "string" and VALID_STATUS[value] then return value end
  return nil
end

local function parse_totals(raw)
  if type(raw) ~= "table" then return nil, nil end
  return valid_number(raw.tokens, 0), valid_number(raw.costUsd, 0)
end

local function normalize_token_monitor(raw)
  local tm = app.state.token_monitor
  if type(raw) ~= "table" then
    tm.available = false
    tm.stale = true
    tm.tools = {}
    tm.rate = nil
    tm.rate_idle = true
    tm.today_tokens, tm.today_cost = nil, nil
    tm.last7_tokens, tm.last7_cost = nil, nil
    tm.all_tokens, tm.all_cost = nil, nil
    return
  end
  tm.available = raw.available == true
  tm.stale = raw.stale == true or not tm.available
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
  if PAGE_COUNT > 1 then restart_rotation() end
  every(1000, function() CODEX_MONITOR_APP.tick() end) -- 1 秒轮询桥接状态
  if request_weather then
    request_weather()
    every(60000, function() request_weather() end)
  end
end

function CODEX_MONITOR_APP.tick()
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
  app.rotate_timer = nil
  unregister_keys()
  clear_root()
  app.pages = nil
  app.ui = {}
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
