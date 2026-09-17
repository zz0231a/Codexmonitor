-- Codex Monitor 设备端应用
-- 320x240 Cubic Lua + LVGL 应用，轮询 Windows 桥接程序只读接口。
--
-- 生命周期约定：全局 CODEX_MONITOR_APP 拥有全部定时器、按键回调与
-- LVGL 对象；stop(reason) 必须释放所有资源并清除全局引用，
-- 保证反复退出 / 重载不产生泄漏。

local APP_ID = "codex_monitor"
local APP_DIR = "/sd/apps/codex_monitor/"

-- 稳定的全局入口：系统加载 / 重载本文件时重新取得同一对象。
CODEX_MONITOR_APP = {
  root = nil,
  timers = {},
  key_registered = false,
  running = false,
}
local app = CODEX_MONITOR_APP

-- ---------------------------------------------------------------------------
-- 设备 API 边界：tmr / key / LVGL 的具体签名以实机 Cubic 运行时为准，
-- 全部调用点集中在这一段，实机联调时只需核对这里。
-- ---------------------------------------------------------------------------

local function stop_timers()
  for _, t in ipairs(app.timers) do
    pcall(function() tmr.stop(t) end)
  end
  app.timers = {}
end

local function every(interval_ms, fn)
  local timer = tmr.start(interval_ms, fn) -- 实机验证点：tmr 启动签名
  table.insert(app.timers, timer)
  return timer
end

local function unregister_keys()
  if app.key_registered then
    pcall(function() key.off() end) -- 实机验证点：key 注销签名
    app.key_registered = false
  end
end

local function clear_root()
  if app.root ~= nil then
    pcall(function() lv.obj_del(app.root) end) -- 实机验证点：LVGL 删除对象
    app.root = nil
  end
end

-- ---------------------------------------------------------------------------
-- 配置与状态模型
-- ---------------------------------------------------------------------------

local DEFAULT_HOST = "192.168.1.10"
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

local function load_config()
  -- 实机验证点：Cubic file API 读取本应用目录配置（WebUI 在 Task 4 写入）
  local ok, raw = pcall(function() return file.read(APP_DIR .. "bridge.cfg") end)
  if not ok or type(raw) ~= "string" then return end
  for line in raw:gmatch("[^\r\n]+") do
    local k, v = line:match("^%s*(%w+)%s*=%s*(.-)%s*$")
    if k == "host" and v and #v > 0 then
      app.config.host = v
    elseif k == "port" then
      app.config.port = tonumber(v) or app.config.port
    end
  end
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
end

local function on_bridge_failure()
  local st = app.state
  st.fail_count = st.fail_count + 1
  if st.fail_count >= OFFLINE_AFTER_FAILURES then
    st.offline = true -- 进入离线：保留最后非敏感数据并整体降暗
  end
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
  local url = "http://" .. app.config.host .. ":" .. tostring(app.config.port) .. "/api/v1/status"
  local ok = pcall(function()
    http.get(url, { timeout = HTTP_TIMEOUT_MS }, function(code, body) -- 实机验证点：http 异步签名
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

  app.root = lv.obj(nil) -- 实机验证点：根屏幕创建
  lv.obj_set_size(app.root, 320, 240)

  key.on("left", function() CODEX_MONITOR_APP.on_key("left") end) -- 实机验证点：按键注册
  key.on("right", function() CODEX_MONITOR_APP.on_key("right") end)
  key.on("home", function() CODEX_MONITOR_APP.on_key("home") end)
  app.key_registered = true

  every(1000, function() CODEX_MONITOR_APP.tick() end) -- 1 秒轮询桥接状态（Task 2 实现）
end

function CODEX_MONITOR_APP.tick()
  poll_bridge() -- 1 秒轮询；渲染层在 Task 3 读取 app.state
end

function CODEX_MONITOR_APP.on_key(name)
  -- Task 2+：LEFT/RIGHT 切页，HOME 退出
  if name == "home" then
    CODEX_MONITOR_APP.stop("home")
  end
end

function CODEX_MONITOR_APP.stop(reason)
  stop_timers()
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
