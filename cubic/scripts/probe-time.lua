local L = {}
local function w(s) L[#L + 1] = s end
w("time=" .. tostring(type(time)))
if type(time) == "table" then
  w("get=" .. tostring(type(time.get)) .. " getlocal=" .. tostring(type(time.getlocal))
    .. " epoch2cal=" .. tostring(type(time.epoch2cal)) .. " cal2epoch=" .. tostring(type(time.cal2epoch)))
  local ok1, sec = pcall(function() return time.get() end)
  w("get ok=" .. tostring(ok1) .. " sec=" .. tostring(sec))
  if ok1 and type(sec) == "number" and type(time.epoch2cal) == "function" then
    local ok2, cal = pcall(function() return time.epoch2cal(sec) end)
    w("e2c ok=" .. tostring(ok2) .. " type=" .. type(cal))
    if ok2 and type(cal) == "table" then
      w("utc hour=" .. tostring(cal.hour) .. " min=" .. tostring(cal.min))
    end
  end
  if type(time.getlocal) == "function" then
    local ok3, loc = pcall(function() return time.getlocal() end)
    w("getlocal ok=" .. tostring(ok3) .. " type=" .. type(loc))
    if ok3 and type(loc) == "table" then
      w("local hour=" .. tostring(loc.hour) .. " min=" .. tostring(loc.min))
      if type(time.cal2epoch) == "function" then
        local ok4, wall = pcall(function() return time.cal2epoch(loc) end)
        w("cal2epoch ok=" .. tostring(ok4) .. " val=" .. tostring(wall))
      end
    end
  end
end
local wok, werr = file.putcontents("/sd/apps/codex_monitor/time.log", table.concat(L, "\n"))
if not wok then
  -- 兜底：写到 devrun 目录
  pcall(function() file.putcontents("/sd/apps/devrun/time.log", table.concat(L, "\n")) end)
end
