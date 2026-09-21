-- 一次性诊断：请求 bridge 状态接口，把结果写到 /sd/apps/codex_monitor/debug.log，然后回到监控应用
local LOG = "/sd/apps/codex_monitor/debug.log"
local lines = { "diag start" }

local function dump(s)
  lines[#lines + 1] = s
  pcall(function() file.putcontents(LOG, table.concat(lines, "\n")) end)
end

dump("sjson=" .. tostring(type(sjson)) .. " sjson.decode=" .. tostring(sjson and type(sjson.decode)))
dump("http=" .. tostring(type(http)) .. " http.get=" .. tostring(http and type(http.get)))

local ok, err = pcall(function()
  http.get("http://10.23.2.0:8973/api/v1/status", {
    timeout = 2000,
    headers = { Accept = "application/json", ["Accept-Encoding"] = "identity", Connection = "close" },
  }, function(code, body)
    pcall(function()
      dump("callback code=" .. tostring(code) .. " body_type=" .. type(body) .. " len=" .. tostring(body and #body or 0))
      if type(body) == "string" then
        local ok2, dec = pcall(sjson.decode, body)
        dump("decode_ok=" .. tostring(ok2) .. " decoded_type=" .. type(dec))
        if ok2 and type(dec) == "table" then
          dump("status=" .. tostring(dec.status) .. " conn=" .. tostring(dec.codex_connected)
            .. " activities=" .. tostring(type(dec.activities) == "table" and #dec.activities or -1))
          local pt = dec.primary_task
          if type(pt) == "table" then dump("title=" .. tostring(pt.title) .. " model=" .. tostring(pt.model)) end
        else
          dump("decode_err=" .. tostring(dec))
        end
        dump("head=" .. body:sub(1, 200))
      end
    end)
    pcall(function()
      if app and app.launch then app.launch("codex_monitor") end
    end)
  end)
end)
dump("http.get pcall=" .. tostring(ok) .. " err=" .. tostring(err))
