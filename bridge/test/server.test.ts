import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStateStore } from "../src/state-store.js";
import { createStatusServer } from "../src/server.js";
import { normalizeCodexSnapshot } from "../src/normalizer.js";
import { projectTokenMonitor } from "../src/token-monitor.js";

async function createTestServer(seed?: unknown) {
  const store = createStateStore();
  if (seed !== undefined) store.update(normalizeCodexSnapshot(seed));
  const server = await createStatusServer(store, { host: "127.0.0.1", port: 0 });
  return { store, ...server };
}

test("serves status but rejects mutating routes", async () => {
  const server = await createTestServer({ tasks: [], rateLimits: [] });
  const status = await fetch(`${server.url}/api/v1/status`);
  assert.equal(status.status, 200);
  const post = await fetch(`${server.url}/api/v1/status`, { method: "POST" });
  assert.equal(post.status, 405);
  await server.close();
});

test("status includes an empty token_monitor block by default", async () => {
  const server = await createTestServer({ tasks: [] });
  const body = await (await fetch(`${server.url}/api/v1/status`)).json();
  assert.equal(body.token_monitor.available, false);
  assert.equal(body.token_monitor.stale, true);
  assert.deepEqual(body.token_monitor.tools, []);
  await server.close();
});

test("status token_monitor projection omits account identity", async () => {
  const hub = JSON.parse(await readFile(new URL("./fixtures/token-monitor-hub.json", import.meta.url), "utf8"));
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, Date.parse("2026-09-21T03:00:00.000Z"));
  const store = createStateStore();
  store.updateTokenMonitor(snapshot);
  const server = await createStatusServer(store, { host: "127.0.0.1", port: 0 });
  const body = await (await fetch(`${server.url}/api/v1/status`)).json();
  const serialized = JSON.stringify(body);
  assert.equal(body.token_monitor.available, true);
  assert.equal(body.token_monitor.tools[0].id, "codex");
  assert.equal(body.token_monitor.tools[0].todayTokens, 598305);
  assert.equal(serialized.includes("hidden@example.com"), false);
  assert.equal(serialized.includes("secret-account-key"), false);
  await server.close();
});

test("status body carries the documented public shape", async () => {
  const server = await createTestServer({
    tasks: [{ id: "t1", title: "write docs", status: "running", lastActiveAt: 42, model: "gpt-5.2-codex" }],
    rateLimits: [{ windowDurationMins: 300, usedPercent: 27, resetsAt: 1760003300 }],
  });
  const res = await fetch(`${server.url}/api/v1/status`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.codex_connected, true);
  assert.equal(body.status, "working");
  assert.equal(body.primary_task.title, "write docs");
  assert.equal(body.usage.windows.length, 1);
  assert.equal(body.usage.windows[0].remainingPercent, 73);
  assert.equal(body.other_active_task_count, 0);
  assert.equal(typeof body.server_time, "number");
  assert.equal(typeof body.last_updated_at, "number");
  await server.close();
});

test("stale snapshot stays readable with codex_connected false after disconnect", async () => {
  const server = await createTestServer({ tasks: [{ id: "t1", title: "old task", status: "running", lastActiveAt: 1 }] });
  await fetch(`${server.url}/api/v1/status`);
  server.store.markDisconnected();
  const res = await fetch(`${server.url}/api/v1/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.codex_connected, false);
  assert.equal(body.primary_task.title, "old task");
  assert.ok(body.last_updated_at > 0);
  await server.close();
});

test("health reports bridge and codex connectivity separately", async () => {
  const server = await createTestServer({ tasks: [] });
  const ok = await fetch(`${server.url}/api/v1/health`);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.bridge, "up");
  assert.equal(okBody.codex_connected, true);
  assert.equal(okBody.sources.hook.connected, false);
  assert.equal(okBody.sources.jsonl.available, false);
  server.store.markDisconnected();
  const bad = await fetch(`${server.url}/api/v1/health`);
  assert.equal(bad.status, 503);
  const badBody = await bad.json();
  assert.equal(badBody.bridge, "up");
  assert.equal(badBody.codex_connected, false);
  await server.close();
});

test("health stays 200 when a source is available even if snapshot is disconnected", async () => {
  const store = createStateStore();
  store.markDisconnected();
  store.updateSourceHealth("jsonl", { available: true, fileFound: true, lastRecordAt: 9 });
  const server = await createStatusServer(store, { host: "127.0.0.1", port: 0 });
  const res = await fetch(`${server.url}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.codex_connected, false);
  assert.equal(body.sources.jsonl.available, true);
  assert.equal(body.sources.jsonl.file_found, true);
  assert.equal(body.sources.jsonl.last_record_at, 9);
  await server.close();
});

test("unknown routes return 404 and non-GET methods return 405", async () => {
  const server = await createTestServer({ tasks: [] });
  assert.equal((await fetch(`${server.url}/api/v1/nope`)).status, 404);
  assert.equal((await fetch(`${server.url}/`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${server.url}/api/v1/health`, { method: "PUT" })).status, 405);
  await server.close();
});

test("status response contains no restricted fields", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/app-server-snapshot.json", import.meta.url), "utf8"));
  const server = await createTestServer(raw);
  const body = await (await fetch(`${server.url}/api/v1/status`)).json();
  const serialized = JSON.stringify(body);
  for (const banned of ["command", "sk-ant", "C:\\Users", "prompt", "api_key", "apikey"]) {
    assert.equal(serialized.toLowerCase().includes(banned.toLowerCase()), false, `response must not contain ${banned}`);
  }
  await server.close();
});

test("allowlist blocks clients that are not the configured device", async () => {
  const store = createStateStore();
  store.update(normalizeCodexSnapshot({ tasks: [] }));
  const allowed = await createStatusServer(store, { host: "127.0.0.1", port: 0, allow: ["192.168.1.50"] });
  assert.equal((await fetch(`${allowed.url}/api/v1/status`)).status, 403);
  await allowed.close();
  const open = await createStatusServer(store, { host: "127.0.0.1", port: 0, allow: ["127.0.0.1"] });
  assert.equal((await fetch(`${open.url}/api/v1/status`)).status, 200);
  await open.close();
});

test("read-only API allows browser origins whose host is in the device allowlist", async () => {
  const store = createStateStore();
  store.update(normalizeCodexSnapshot({ tasks: [] }));
  const server = await createStatusServer(store, { host: "127.0.0.1", port: 0, allow: ["127.0.0.1"] });

  const allowed = await fetch(`${server.url}/api/v1/health`, {
    headers: { Origin: "http://127.0.0.1" },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1");
  assert.equal(allowed.headers.get("vary"), "Origin");

  const blocked = await fetch(`${server.url}/api/v1/health`, {
    headers: { Origin: "http://192.168.1.99" },
  });
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  await server.close();
});
