import { test } from "node:test";
import assert from "node:assert/strict";
import { createStateStore } from "../src/state-store.js";
import { createSourceArbiter } from "../src/source-arbiter.js";
import { normalizeBridgeEvent, type BridgeEvent } from "../src/event-model.js";

function hookEvent(status: BridgeEvent["status"], at: number, extra: Record<string, unknown> = {}): BridgeEvent {
  return normalizeBridgeEvent({ status, event: extra.event ?? "UserPromptSubmit", at, session_id: extra.session_id ?? "s1", ...extra }, "hook", at, "test-salt");
}

function jsonlEvent(status: BridgeEvent["status"], at: number, extra: Record<string, unknown> = {}): BridgeEvent {
  return normalizeBridgeEvent({ status, event: extra.event ?? "event_msg:task_complete", at, session_id: extra.session_id ?? "s1", ...extra }, "jsonl", at, "test-salt");
}

test("hook wins for ten seconds, then jsonl may advance state", () => {
  let now = 100_000;
  const store = createStateStore();
  const arbiter = createSourceArbiter(store, { hookPriorityMs: 10_000, now: () => now });
  arbiter.accept(hookEvent("working", now));
  now += 5_000;
  assert.equal(arbiter.accept(jsonlEvent("done", now)), false);
  now += 6_000;
  assert.equal(arbiter.accept(jsonlEvent("done", now)), true);
  assert.equal(store.current()?.status, "done");
});

test("older working event cannot regress a newer terminal event", () => {
  const store = createStateStore();
  const arbiter = createSourceArbiter(store, { hookPriorityMs: 10_000, now: () => 1_000 });
  arbiter.accept(jsonlEvent("done", 200));
  assert.equal(arbiter.accept(jsonlEvent("working", 199)), false);
  assert.equal(store.current()?.status, "done");
});

test("projects sanitized project name and caps activities at five", () => {
  const store = createStateStore();
  const arbiter = createSourceArbiter(store, { now: () => 50 });
  for (let i = 1; i <= 6; i += 1) {
    arbiter.accept(hookEvent("working", i, { event: "PreToolUse", project: "secret-project" }));
  }
  const snapshot = store.current();
  assert.equal(snapshot?.primaryTask?.title, "secret-project");
  assert.equal(snapshot?.activities.length, 5);
  assert.equal(JSON.stringify(snapshot).includes("C:\\"), false);
});
