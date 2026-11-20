import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTokenMonitorReader, projectTokenMonitor } from "../src/token-monitor.js";

const NOW = Date.parse("2026-09-21T03:00:00.000Z");
const FIXTURE_URL = new URL("./fixtures/token-monitor-hub.json", import.meta.url);

async function loadHub(): Promise<unknown> {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("ranks the top eight clients by all-time tokens and uses the next reset window", async () => {
  const hub = await loadHub();
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.stale, false);
  assert.deepEqual(snapshot.tools.map((tool) => tool.id), ["codex", "cursor", "workbuddy", "kimi", "grok", "claude"]);
  assert.deepEqual(snapshot.tools.map((tool) => tool.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(snapshot.tools[0]?.remainingPercent, 82);
  assert.equal(snapshot.tools[0]?.window, "5H");
  assert.equal(snapshot.tools[0]?.fiveHourPercent, 82);
  assert.equal(snapshot.tools[0]?.sevenDayPercent, 78);
  assert.equal(snapshot.tools[1]?.remainingPercent, 85);
  assert.equal(snapshot.tools[1]?.window, "7D");
  assert.equal(snapshot.tools[1]?.fiveHourPercent, null);
  assert.equal(snapshot.tools[1]?.sevenDayPercent, 85);
  assert.equal(snapshot.tools[2]?.remainingPercent, null);
  assert.equal(snapshot.tools[2]?.window, "--");
  assert.equal(snapshot.tools[2]?.fiveHourPercent, null);
  assert.equal(snapshot.tools[2]?.sevenDayPercent, null);
  assert.equal(snapshot.tools[3]?.remainingPercent, null);
  // 今日 per-client tokens：fixture today clients = codex/cursor/grok，其余为 null
  assert.equal(snapshot.tools[0]?.todayTokens, 598305);
  assert.equal(snapshot.tools[1]?.todayTokens, 1207535);
  assert.equal(snapshot.tools[2]?.todayTokens, null);
  assert.equal(snapshot.tools[4]?.todayTokens, 11083421);
});

test("skips unused 100% windows when a tighter quota exists", async () => {
  const hub = clone(await loadHub()) as {
    devices: { aipc: { limits: { providers: Array<Record<string, unknown>> } } };
  };
  hub.devices.aipc.limits.providers.push({
    provider: "kimi",
    status: "ok",
    updatedAt: "2026-09-21T03:00:00.000Z",
    windows: [
      { kind: "session", remainingPercent: 100, resetsAt: "2026-09-21T06:00:00.000Z", showMeter: true, windowMinutes: 300 },
      { kind: "weekly", remainingPercent: 100, resetsAt: "2026-09-28T02:00:00.000Z", showMeter: true, windowMinutes: 10080 },
      { kind: "billing", remainingPercent: 73, resetsAt: "2026-10-20T00:00:00.000Z", showMeter: true },
    ],
  });
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  const kimi = snapshot.tools.find((tool) => tool.id === "kimi");
  assert.equal(kimi?.remainingPercent, 73);
  assert.equal(kimi?.window, "MO");
  assert.equal(kimi?.fiveHourPercent, 100);
  assert.equal(kimi?.sevenDayPercent, 100);
});

test("replaces a lower slot when another client overtakes it", async () => {
  const hub = clone(await loadHub()) as { devices: { aipc: { periods: { allTime: { clients: Record<string, number> } } } } };
  hub.devices.aipc.periods.allTime.clients.claude = 200000000;
  hub.devices.aipc.periods.allTime.clients.kimi = 1000;
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  assert.deepEqual(snapshot.tools.map((tool) => tool.id), ["codex", "cursor", "workbuddy", "claude", "grok", "kimi"]);
  assert.equal(snapshot.tools[3]?.id, "claude");
  assert.equal(snapshot.tools[3]?.window, "--");
});

test("does not leak account identity into the projection", async () => {
  const hub = await loadHub();
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("hidden@example.com"), false);
  assert.equal(serialized.includes("secret-account-key"), false);
  assert.equal(serialized.toLowerCase().includes("email"), false);
});

test("sums the last seven calendar days and ignores older history rows", async () => {
  const hub = await loadHub();
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  assert.equal(snapshot.last7?.tokens, 170874580);
  assert.ok((snapshot.last7?.costUsd ?? 0) < 200);
  assert.equal(snapshot.today?.tokens, 12889261);
  assert.equal(snapshot.allTime?.tokens, 2235547008);
});

test("aggregates allTime today and clients across hub devices", async () => {
  const hub = clone(await loadHub()) as {
    devices: Record<string, {
      periods: {
        today: { totalTokens: number; costUsd: number; clients: Record<string, number> };
        allTime: { totalTokens: number; costUsd: number; clients: Record<string, number> };
      };
    }>;
  };
  hub.devices.home = {
    periods: {
      today: { totalTokens: 1000, costUsd: 1, clients: { kimi: 1000 } },
      allTime: { totalTokens: 400000000, costUsd: 40, clients: { kimi: 400000000 } },
    },
  };
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  assert.equal(snapshot.allTime?.tokens, 2235547008 + 400000000);
  assert.equal(snapshot.today?.tokens, 12889261 + 1000);
  assert.equal(snapshot.tools.find((tool) => tool.id === "kimi")?.todayTokens, 1000);
  assert.equal(snapshot.tools[0]?.remainingPercent, 82);
});

test("marks a snapshot stale after twelve minutes", async () => {
  const hub = await loadHub();
  const { snapshot } = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW + 13 * 60 * 1000);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.stale, true);
});

test("computes burn rate then idles after twenty seconds without growth", async () => {
  const hub = clone(await loadHub()) as { devices: { aipc: { periods: { today: { totalTokens: number } } } } };
  const first = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  hub.devices.aipc.periods.today.totalTokens += 2400;
  const second = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW + 60_000, first.rateState);
  assert.equal(second.snapshot.rate.idle, false);
  assert.equal(second.snapshot.rate.tokensPerMin, 2400);
  const third = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW + 60_000 + 21_000, second.rateState);
  assert.equal(third.snapshot.rate.idle, true);
  assert.equal(third.snapshot.rate.tokensPerMin, null);
});

test("tracks the tool whose daily tokens grow and clears it after sixty idle seconds", async () => {
  const hub = clone(await loadHub()) as {
    devices: { aipc: { periods: { today: { totalTokens: number; clients: Record<string, number> } } } };
  };
  const first = projectTokenMonitor(hub, { deviceId: "aipc" }, NOW);
  assert.equal(first.snapshot.activeToolId, null);

  hub.devices.aipc.periods.today.totalTokens += 900;
  hub.devices.aipc.periods.today.clients.cursor += 900;
  const second = projectTokenMonitor(
    hub,
    { deviceId: "aipc" },
    NOW + 10_000,
    first.rateState,
    first.activityState,
  );
  assert.equal(second.snapshot.activeToolId, "cursor");

  const stillActive = projectTokenMonitor(
    hub,
    { deviceId: "aipc" },
    NOW + 69_999,
    second.rateState,
    second.activityState,
  );
  assert.equal(stillActive.snapshot.activeToolId, "cursor");

  const expired = projectTokenMonitor(
    hub,
    { deviceId: "aipc" },
    NOW + 70_000,
    stillActive.rateState,
    stillActive.activityState,
  );
  assert.equal(expired.snapshot.activeToolId, null);
});

test("reader returns an empty snapshot when the hub file is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-empty-"));
  const reader = createTokenMonitorReader({ dir, now: () => NOW });
  const snapshot = reader.poll();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.tools.length, 0);
});

test("reader loads hub-devices.json from the given directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-dir-"));
  await writeFile(path.join(dir, "hub-devices.json"), await readFile(FIXTURE_URL));
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ deviceId: "aipc" }));
  const reader = createTokenMonitorReader({ dir, now: () => NOW });
  const snapshot = reader.poll();
  assert.equal(snapshot.tools[0]?.id, "codex");
  assert.equal(snapshot.tools[0]?.remainingPercent, 82);
});
