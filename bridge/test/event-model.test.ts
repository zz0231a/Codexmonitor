import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBridgeEvent } from "../src/event-model.js";
import { createStateStore } from "../src/state-store.js";

test("normalizes hook fields without retaining raw identifiers or cwd", () => {
  const event = normalizeBridgeEvent({
    hook_event_name: "PreToolUse",
    cwd: "C:\\Users\\me\\secret-project",
    session_id: "raw-session-id",
    tool_name: "exec_command",
    model: "gpt-6-astra",
  }, "hook", 1_700_000_000_000, "test-salt");
  assert.equal(event.status, "working");
  assert.equal(event.project, "secret-project");
  assert.equal(event.toolCategory, "terminal");
  assert.match(event.sessionKey, /^[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(event).includes("raw-session-id"), false);
  assert.equal(JSON.stringify(event).includes("C:\\Users"), false);
});

test("maps PermissionRequest to needs_user and failed PostToolUse to error", () => {
  assert.equal(normalizeBridgeEvent({ hook_event_name: "PermissionRequest" }, "hook", 1, "s").status, "needs_user");
  assert.equal(normalizeBridgeEvent({ hook_event_name: "PostToolUse", tool_response: { is_error: true } }, "hook", 1, "s").status, "error");
});

test("does not copy arbitrary tool names onto the event", () => {
  const event = normalizeBridgeEvent({
    hook_event_name: "PreToolUse",
    tool_name: "totally_unknown_tool",
  }, "hook", 1, "s");
  assert.equal(event.toolCategory, "other");
  assert.equal(JSON.stringify(event).includes("totally_unknown_tool"), false);
});

test("source health updates are immutable and do not change snapshot semantics", () => {
  const store = createStateStore(() => 42);
  assert.equal(store.current(), null);
  assert.equal(store.lastUpdatedAt(), 0);
  store.updateSourceHealth("hook", { connected: true, lastEventAt: 10 });
  const first = store.sourceHealth();
  first.hook.connected = false;
  first.jsonl.fileFound = true;
  const second = store.sourceHealth();
  assert.equal(second.hook.connected, true);
  assert.equal(second.hook.lastEventAt, 10);
  assert.equal(second.jsonl.fileFound, false);
  assert.equal(store.current(), null);
  assert.equal(store.lastUpdatedAt(), 0);
});
