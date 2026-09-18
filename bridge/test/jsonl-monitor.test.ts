import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonlMonitor } from "../src/jsonl-monitor.js";

const fixtures = path.dirname(fileURLToPath(import.meta.url));

const SENTINELS = ["DO_NOT_LEAK_PROMPT", "DO_NOT_LEAK_ARGS", "DO_NOT_LEAK_REPLY", "raw-session", "C:\\Users"];

test("emits project, context, and usage without sentinel fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-jsonl-"));
  await copyFile(path.join(fixtures, "fixtures", "session-sample.jsonl"), path.join(dir, "session.jsonl"));
  const monitor = createJsonlMonitor({ sessionsRoot: dir, salt: "test-salt" });
  const events = await monitor.poll();
  const serialized = JSON.stringify(events);
  for (const banned of SENTINELS) {
    assert.equal(serialized.includes(banned), false, `must not contain ${banned}`);
  }
  assert.ok(events.some((event) => event.project === "project"));
  assert.ok(events.some((event) => event.contextPercent === 25));
  const withUsage = events.find((event) => event.usage && event.usage.length >= 2);
  assert.ok(withUsage);
  assert.ok(withUsage.usage?.some((w) => w.windowDurationMins === 300 && w.remainingPercent === 80));
  assert.ok(withUsage.usage?.some((w) => w.windowDurationMins === 10080 && w.remainingPercent === 40));
  assert.equal(events.at(-1)?.status, "done");
  monitor.close();
});

test("tolerates partial final lines and later appended records", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-jsonl-partial-"));
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, [
    `{"timestamp":"2026-09-18T00:00:00Z","type":"session_meta","payload":{"id":"raw-session","cwd":"C:\\\\Users\\\\me\\\\project"}}`,
    `{"timestamp":"2026-09-18T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"DO_NOT_LEAK_PROMPT"}}`,
    `{"timestamp":"2026-09-18T00:00:02Z","type":"event_msg","payload":{"type":"task_started"}`,
  ].join("\n"));
  const monitor = createJsonlMonitor({ sessionsRoot: dir, salt: "test-salt" });
  const first = await monitor.poll();
  assert.ok(first.some((event) => event.event === "event_msg:user_message"));
  assert.equal(first.some((event) => event.event === "event_msg:task_started"), false);
  await appendFile(file, "}\n");
  const second = await monitor.poll();
  assert.ok(second.some((event) => event.event === "event_msg:task_started"));
  monitor.close();
});

test("incremental poll only reads appended bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-jsonl-inc-"));
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, `{"timestamp":"2026-09-18T00:00:00Z","type":"session_meta","payload":{"id":"raw-session","cwd":"C:\\\\Users\\\\me\\\\project"}}\n{"timestamp":"2026-09-18T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}\n`, "utf8");
  const monitor = createJsonlMonitor({ sessionsRoot: dir, salt: "test-salt" });
  const first = await monitor.poll();
  assert.equal(first.at(-1)?.status, "working");
  await appendFile(file, `{"timestamp":"2026-09-18T00:00:05Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"DO_NOT_LEAK_REPLY"}}\n`);
  const second = await monitor.poll();
  assert.equal(second.length, 1);
  assert.equal(second[0].status, "done");
  assert.equal(JSON.stringify(second).includes("DO_NOT_LEAK_REPLY"), false);
  monitor.close();
});
