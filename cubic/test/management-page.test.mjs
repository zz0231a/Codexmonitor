import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadManagementPage(fetchImpl) {
  const html = await readFile("package/main.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "management page script must exist");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "",
        textContent: "",
        className: "",
        addEventListener() {},
      });
    }
    return elements.get(id);
  };
  const context = {
    console,
    Promise,
    JSON,
    Number,
    Error,
    fetch: fetchImpl,
    window: {},
    document: { getElementById: element },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context;
}

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

test("management page persists config through the Cubic 1.212 filesystem HTTP API", async () => {
  const requests = [];
  const page = await loadManagementPage(async (url, init = {}) => {
    requests.push({ url, init });
    return { ok: true, text: async () => "" };
  });

  await page.writeConfigFile('{"host":"10.23.2.0","port":8973}');

  const write = requests.find((request) => request.init.method === "PUT");
  assert.equal(write.url, "/api/system/fs/upload?path=%2Fsd%2Fapps%2Fcodex_monitor%2Fconfig.json");
  assert.equal(write.init.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(write.init.body, '{"host":"10.23.2.0","port":8973}');
});
