import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsageWindow } from "../src/model.js";

test("normalizes used percentage into remaining percentage", () => {
  assert.deepEqual(normalizeUsageWindow({ usedPercent: 27, windowDurationMins: 300, resetsAt: 1700000000 }), {
    remainingPercent: 73, windowDurationMins: 300, resetsAt: 1700000000,
  });
});

test("returns null when usage window is absent", () => {
  assert.equal(normalizeUsageWindow(null), null);
});

test("accepts official Codex snake_case usage window objects", () => {
  assert.deepEqual(normalizeUsageWindow({ used_percent: 31, window_minutes: 300, resets_at: 1789885315 }), {
    remainingPercent: 69, windowDurationMins: 300, resetsAt: 1789885315,
  });
});
