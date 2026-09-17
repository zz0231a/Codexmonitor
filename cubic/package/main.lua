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
-- 生命周期
-- ---------------------------------------------------------------------------

function CODEX_MONITOR_APP.start()
  if app.running then return end
  app.running = true

  app.root = lv.obj(nil) -- 实机验证点：根屏幕创建
  lv.obj_set_size(app.root, 320, 240)

  key.on("left", function() CODEX_MONITOR_APP.on_key("left") end) -- 实机验证点：按键注册
  key.on("right", function() CODEX_MONITOR_APP.on_key("right") end)
  key.on("home", function() CODEX_MONITOR_APP.on_key("home") end)
  app.key_registered = true

  every(1000, function() CODEX_MONITOR_APP.tick() end) -- 1 秒轮询桥接状态（Task 2 实现）
end

function CODEX_MONITOR_APP.tick()
  -- Task 2：请求桥接快照并刷新界面
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
