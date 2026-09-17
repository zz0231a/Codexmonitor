import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("offline fixture causes an explicit offline marker", async () => {
  const status = JSON.parse(await readFile("test/status-offline.json", "utf8"));
  assert.equal(status.codex_connected, false);
  assert.ok(status.last_updated_at);
});

test("main.lua renders an explicit OFFLINE marker and dims stale data", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /OFFLINE/);
  assert.match(lua, /apply_dim/);
  // 恢复路径：成功快照后必须清掉离线标记
  assert.match(lua, /st\.offline\s*=\s*false/);
});

test("main.html configures bridge host/port with a read-only health test", async () => {
  const html = await readFile("package/main.html", "utf8");
  assert.match(html, /id="host"/);
  assert.match(html, /id="port"/);
  assert.match(html, /\/api\/v1\/health/);
  assert.match(html, /config\.json/);
  assert.match(html, /\/sd\/apps\/codex_monitor\//);
});

test("Lua app consumes the same config path as the WebUI", async () => {
  const lua = await readFile("package/main.lua", "utf8");
  const html = await readFile("package/main.html", "utf8");
  assert.match(lua, /config\.json/);
  assert.match(lua, /APP_DIR\s*=\s*"\/sd\/apps\/codex_monitor\/"/);
  assert.ok(html.includes("/sd/apps/codex_monitor/config.json"));
});

test("no restricted field names occur in UI or Lua source", async () => {
  for (const file of ["package/main.html", "package/main.lua"]) {
    const src = await readFile(file, "utf8");
    for (const banned of ["api_key", "apikey", "sk-ant", "prompt_text", "access_token"]) {
      assert.equal(src.includes(banned), false, `${file} must not contain ${banned}`);
    }
  }
});

test("all resource paths stay under /sd/apps/codex_monitor/", async () => {
  for (const file of ["package/main.html", "package/main.lua"]) {
    const src = await readFile(file, "utf8");
    assert.equal(/[A-Za-z]:\\/.test(src), false, `${file} must not reference Windows paths`);
    assert.equal(src.includes("/home/"), false, `${file} must not reference Unix home paths`);
  }
});

test("package inspection: metadata, entry, icon, description, and assets", async () => {
  const files = await readdir("package");
  for (const required of ["app.info", "main.lua", "main.png", "info.html", "main.html"]) {
    assert.ok(files.includes(required), `package must contain ${required}`);
  }
  const assets = await readdir("package/assets");
  assert.ok(assets.includes("usage_5h.png"));
  assert.ok(assets.includes("usage_7d.png"));
});
