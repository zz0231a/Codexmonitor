import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("management page renders source status fields", async () => {
  const html = await readFile("package/main.html", "utf8");
  assert.match(html, /Bridge/);
  assert.match(html, /Codex/);
  assert.match(html, /Hook/);
  assert.match(html, /JSONL/);
  assert.match(html, /最后更新/);
  assert.match(html, /\/api\/v1\/health/);
});

test("management page validates port range and refuses empty host before file APIs", async () => {
  const html = await readFile("package/main.html", "utf8");
  assert.match(html, /validPort/);
  assert.match(html, /65535/);
  assert.match(html, /validHost/);
  assert.match(html, /if \(!cfg\.host\)/);
  const saveHandler = html.slice(html.indexOf('getElementById("save")'));
  assert.match(saveHandler, /validateConfig/);
  assert.equal(saveHandler.includes("writeConfigFile") && saveHandler.indexOf("validateConfig") < saveHandler.indexOf("writeConfigFile"), true);
});

test("package host default is empty and port default remains 8973", async () => {
  const html = await readFile("package/main.html", "utf8");
  const lua = await readFile("package/main.lua", "utf8");
  assert.match(lua, /DEFAULT_HOST\s*=\s*""/);
  assert.match(lua, /DEFAULT_PORT\s*=\s*8973/);
  assert.match(html, /placeholder="8973"/);
  assert.equal(/value="192\.168\.\d+\.\d+"/.test(html), false);
});
