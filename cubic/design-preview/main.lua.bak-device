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
  weather = nil, -- Task 4：跟随 Cubic 系统天气设置
  usage = { five_hour = nil, seven_day = nil }, -- { remainingPercent, resetsAt }
  activities = {}, -- 最近 5 条 { stage, summary, at }
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

local function load_weather_city()
  local city = nil
  pcall(function()
    if settings ~= nil and type(settings.get) == "function" then
      city = settings.get("weather.city") or settings.get("city")
    elseif settings ~= nil and type(settings.city) == "string" then
      city = settings.city
    end
  end)
  if city == nil then
    local raw = read_text_file("/sd/apps/settings.json")
    if type(raw) == "string" then
      local okd, doc = pcall(sjson.decode, raw)
      if okd and type(doc) == "table" then
        city = doc.weather_city or doc.city_name or doc.city
      end
    end
  end
  if type(city) == "string" and #city > 0 then
    city = city:gsub("[%z\1-\31]", " "):gsub("^%s+", ""):gsub("%s+$", "")
    if #city > 40 then city = city:sub(1, 40) end
    app.state.weather = { city = city }
  else
    app.state.weather = { city = nil }
  end
end

-- ---------------------------------------------------------------------------
-- 页面布局与轮播：两页每 30 秒自动切换，手动切换后重计时
-- ---------------------------------------------------------------------------

local PAGE_COUNT = 2
local ROTATE_MS = 30000
local BAR_WIDTH = 10

app.page_index = 1
app.rotate_timer = nil
app.pages = nil
app.ui = {} -- 全部 LVGL 控件引用，退出时随 root 一起删除

-- 深色像素终端风配色（实机验证点：lv 颜色 API）
local COLOR_TEXT = 0xD5DBE5
local COLOR_DIM = 0x8A93A6
local COLOR_OK = 0x4ADE80
local COLOR_WARN = 0xFACC15
local COLOR_ERR = 0xF87171
local COLOR_OFFLINE = 0x555C6B

local STATUS_LABEL = {
  idle = "IDLE",
  working = "WORKING",
  needs_user = "NEEDS USER",
  done = "DONE",
  error = "ERROR",
  offline = "OFFLINE",
}

local function ui_color(hex)
  if lv_color_hex then return lv_color_hex(hex) end
  if lv and lv.color_hex then return lv.color_hex(hex) end
  return hex
end

local function set_text(ref, text)
  if ref == nil then return end
  pcall(function()
    if lv_label_set_text then lv_label_set_text(ref, text)
    elseif lv then lv.label_set_text(ref, text) end
  end)
end

local function set_color(ref, hex)
  if ref == nil then return end
  pcall(function()
    if lv_obj_set_style_text_color then lv_obj_set_style_text_color(ref, ui_color(hex), MAIN_STYLE)
    elseif lv then lv.obj_set_style_text_color(ref, ui_color(hex), 0) end
  end)
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

local function usage_bar_text(remaining)
  local filled = math.floor(remaining / 100 * BAR_WIDTH + 0.5)
  return string.rep("█", filled) .. string.rep("░", BAR_WIDTH - filled)
end

local function usage_color(remaining)
  if remaining == 0 then return COLOR_ERR end
  if remaining < 20 then return COLOR_WARN end
  return COLOR_OK
end

local function fmt_reset(ts)
  local ok, text = pcall(function() return os.date("%H:%M", ts) end) -- 实机验证点：os.date
  return ok and text or "--"
end

local function build_ui()
  local ui = app.ui
  app.pages = {}
  for i = 1, PAGE_COUNT do
    local page = nil
    if lv_obj_create then page = lv_obj_create(app.root)
    elseif lv and lv.obj then page = lv.obj(app.root) end
    pcall(function()
      if lv_obj_set_size then lv_obj_set_size(page, 320, 240)
      elseif lv then lv.obj_set_size(page, 320, 240) end
    end)
    app.pages[i] = page
  end

  -- 第 1 页：总览（左上 Codex / 右上天气 / 底部用量条）
  local p1 = app.pages[1]
  ui.status = make_label(p1, 4, 4, "CODEX · --")
  ui.task_title = make_label(p1, 4, 26, "--")
  ui.task_model = make_label(p1, 4, 66, "--")
  ui.task_context = make_label(p1, 4, 88, "--")
  ui.weather_city = make_label(p1, 164, 26, "--")
  ui.weather_temp = make_label(p1, 164, 48, "--")
  ui.weather_meta = make_label(p1, 164, 90, "--")
  ui.usage_5h = make_label(p1, 4, 170, "5H --")
  ui.usage_5h_reset = make_label(p1, 244, 170, "--")
  ui.usage_7d = make_label(p1, 4, 198, "7D --")
  ui.usage_7d_reset = make_label(p1, 244, 198, "--")

  -- 第 2 页：活动详情
  local p2 = app.pages[2]
  ui.details_title = make_label(p2, 4, 4, "ACTIVITIES")
  ui.activity_lines = {}
  for i = 1, 5 do
    ui.activity_lines[i] = make_label(p2, 4, 26 + (i - 1) * 22, "--")
  end
  ui.details_model = make_label(p2, 4, 150, "MODEL --")
  ui.details_context = make_label(p2, 4, 172, "CTX --")
  ui.details_badge = make_label(p2, 4, 194, "")
  ui.details_other = make_label(p2, 4, 216, "其他活动任务 0")
end

local function render_usage(bar_ref, reset_ref, prefix, win)
  if win == nil then
    set_text(bar_ref, prefix .. " " .. string.rep("░", BAR_WIDTH) .. " --")
    set_text(reset_ref, "--")
    set_color(bar_ref, COLOR_DIM)
    return
  end
  local remaining = win.remainingPercent
  set_text(bar_ref, prefix .. " " .. usage_bar_text(remaining) .. " " .. tostring(remaining) .. "%")
  set_text(reset_ref, fmt_reset(win.resetsAt))
  set_color(bar_ref, usage_color(remaining))
end

function CODEX_MONITOR_APP.render_overview()
  local ui, st = app.ui, app.state
  local dim = st.offline or not st.codex.connected
  apply_dim(false) -- 先恢复基色；离线判定通过则最后统一降暗
  if st.offline then
    set_text(ui.status, "CODEX · OFFLINE · " .. fmt_reset(st.last_update))
  else
    set_text(ui.status, "CODEX · " .. (STATUS_LABEL[st.codex.status] or "--"))
  end
  local pt = st.codex.primary_task
  set_text(ui.task_title, (pt ~= nil and pt.title) or "--")
  set_text(ui.task_model, "MODEL " .. ((pt ~= nil and pt.model) or "--"))
  if pt ~= nil and pt.contextPercent ~= nil then
    set_text(ui.task_context, "CTX " .. tostring(pt.contextPercent) .. "%")
  else
    set_text(ui.task_context, "CTX --")
  end
  -- 天气：只读取系统设置中的城市名；用量类指标在固件天气 API 未验证前保持 --
  set_text(ui.weather_city, (st.weather and st.weather.city) or "--")
  set_text(ui.weather_temp, "--")
  set_text(ui.weather_meta, "--")
  render_usage(ui.usage_5h, ui.usage_5h_reset, "5H", st.usage.five_hour)
  render_usage(ui.usage_7d, ui.usage_7d_reset, "7D", st.usage.seven_day)
  if dim then dim_label(ui) end -- 离线/断连：整体降暗，数据保留
end

function CODEX_MONITOR_APP.render_details()
  local ui, st = app.ui, app.state
  local dim = st.offline or not st.codex.connected
  apply_dim(false)
  for i = 1, 5 do
    local a = st.activities[#st.activities + 1 - i] -- 最新在前
    if a ~= nil then
      set_text(ui.activity_lines[i], a.summary)
    else
      set_text(ui.activity_lines[i], "--")
    end
  end
  local pt = st.codex.primary_task
  set_text(ui.details_model, "MODEL " .. ((pt ~= nil and pt.model) or "--"))
  if pt ~= nil and pt.contextPercent ~= nil then
    set_text(ui.details_context, "CTX " .. tostring(pt.contextPercent) .. "%")
  else
    set_text(ui.details_context, "CTX --")
  end
  if st.codex.status == "needs_user" then
    set_text(ui.details_badge, "● 需要处理")
    set_color(ui.details_badge, COLOR_WARN)
  else
    set_text(ui.details_badge, "")
  end
  set_text(ui.details_other, "其他活动任务 " .. tostring(st.codex.other_active_task_count))
  if dim then dim_label(ui) end
end

function CODEX_MONITOR_APP.render_page(index)
  app.page_index = index
  if app.pages ~= nil then
    for i = 1, PAGE_COUNT do set_page_visible(app.pages[i], i == index) end
  end
  if index == 1 then
    CODEX_MONITOR_APP.render_overview()
  elseif index == 2 then
    CODEX_MONITOR_APP.render_details()
  end
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
  codex.connected = body.codex_connected == true
  if not codex.connected then
    -- 桥接可达但 Codex 断开：保留最后数据，仅标记断开（界面降暗）
    st.offline = false
    st.fail_count = 0
    if type(body.last_updated_at) == "number" then st.last_update = body.last_updated_at end
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
  load_weather_city()

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
  restart_rotation()
  every(1000, function() CODEX_MONITOR_APP.tick() end) -- 1 秒轮询桥接状态
end

function CODEX_MONITOR_APP.tick()
  poll_bridge() -- 1 秒轮询；渲染层在 Task 3 读取 app.state
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
