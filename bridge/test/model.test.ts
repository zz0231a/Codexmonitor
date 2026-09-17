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
