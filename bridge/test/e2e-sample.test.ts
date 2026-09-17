import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCodexSnapshot } from "../src/normalizer.js";
import { buildPublicSnapshot } from "../src/server.js";
import { createStateStore } from "../src/state-store.js";
import { createStatusServer } from "../src/server.js";

/** 读取协议样本文件并产出设备端公开 JSON（与 main.ts 的 fixture 模式同路径）。 */
async function runNormalizerFixture(path: string) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return buildPublicSnapshot(normalizeCodexSnapshot(raw), 1760000042);
}

test("sample app-server snapshot becomes the documented public JSON", async () => {
  const snapshot = await runNormalizerFixture("test/fixtures/app-server-snapshot.json");
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(JSON.stringify(snapshot).includes("command"), false);
  assert.ok(snapshot.usage.windows.some((w: { windowDurationMins: number }) => w.windowDurationMins === 300));
  assert.ok(snapshot.usage.windows.some((w: { windowDurationMins: number }) => w.windowDurationMins === 10080));
  assert.equal(snapshot.codex_connected, true);
});

test("fixture snapshot is served end-to-end over HTTP", async () => {
  const raw = JSON.parse(await readFile("test/fixtures/app-server-snapshot.json", "utf8"));
  const store = createStateStore();
  store.update(normalizeCodexSnapshot(raw));
  const server = await createStatusServer(store, { host: "127.0.0.1", port: 0 });
  const body = await (await fetch(`${server.url}/api/v1/status`)).json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.codex_connected, true);
  assert.equal(body.status, "needs_user");
  assert.equal(body.other_active_task_count, 2);
  assert.equal(body.activities.length, 5);
  assert.ok(body.usage.windows.some((w: { windowDurationMins: number }) => w.windowDurationMins === 300));
  assert.ok(body.usage.windows.some((w: { windowDurationMins: number }) => w.windowDurationMins === 10080));
  await server.close();
});
