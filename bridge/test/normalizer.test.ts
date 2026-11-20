import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCodexSnapshot, sanitizeLabel, sanitizeTitle, selectPrimaryTask } from "../src/normalizer.js";

test("prioritizes a task needing user action over a running task", () => {
  const selected = selectPrimaryTask([
    { id: "run", status: "working", lastActiveAt: 30, title: "run" },
    { id: "ask", status: "needs_user", lastActiveAt: 10, title: "ask" },
  ]);
  assert.equal(selected?.id, "ask");
});

test("prioritizes a running task over idle tasks and sorts by recency within a tier", () => {
  const selected = selectPrimaryTask([
    { id: "old-run", status: "working", lastActiveAt: 5, title: "old" },
    { id: "new-run", status: "working", lastActiveAt: 50, title: "new" },
    { id: "idle-1", status: "idle", lastActiveAt: 99, title: "idle" },
  ]);
  assert.equal(selected?.id, "new-run");
});

test("falls back to the most recently active task and returns null for no tasks", () => {
  const selected = selectPrimaryTask([
    { id: "a", status: "done", lastActiveAt: 1, title: "a" },
    { id: "b", status: "done", lastActiveAt: 9, title: "b" },
  ]);
  assert.equal(selected?.id, "b");
  assert.equal(selectPrimaryTask([]), null);
});

test("drops sensitive fields from activity summaries", () => {
  const snapshot = normalizeCodexSnapshot({
    tasks: [{ id: "x", status: "working", title: "Task", lastActiveAt: 1, activities: [{ kind: "tool", text: "run", command: "secret" }] }],
  });
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});

test("identifies usage windows by windowDurationMins regardless of ordering", () => {
  const snapshot = normalizeCodexSnapshot({
    tasks: [],
    rateLimits: [
      { windowDurationMins: 10080, usedPercent: 62, resetsAt: 1760600000 },
      { windowDurationMins: 300, usedPercent: 27, resetsAt: 1760003000 },
    ],
  });
  assert.equal(snapshot.usage.length, 2);
  assert.ok(snapshot.usage.some((w) => w.windowDurationMins === 300 && w.remainingPercent === 73));
  assert.ok(snapshot.usage.some((w) => w.windowDurationMins === 10080 && w.remainingPercent === 38));
});

test("degrades per-field when data is missing", () => {
  const snapshot = normalizeCodexSnapshot({ tasks: [{ id: "x" }] });
  assert.equal(snapshot.codexConnected, true);
  assert.equal(snapshot.primaryTask?.title, "");
  assert.equal(snapshot.usage.length, 0);
  assert.equal(snapshot.status, "idle");
});

test("maps task status and counts other active tasks", () => {
  const snapshot = normalizeCodexSnapshot({
    tasks: [
      { id: "main", status: "needs_user", lastActiveAt: 5 },
      { id: "w1", status: "working", lastActiveAt: 4 },
      { id: "w2", status: "working", lastActiveAt: 3 },
      { id: "done", status: "done", lastActiveAt: 2 },
    ],
  });
  assert.equal(snapshot.status, "needs_user");
  assert.equal(snapshot.primaryTask?.id, "main");
  assert.equal(snapshot.otherActiveTaskCount, 2);
});

test("strips paths, secrets, CJK, and non-ASCII from labels", () => {
  assert.equal(sanitizeLabel("open C:\\Users\\me\\secret\\app.ts"), "open [path]");
  assert.equal(sanitizeLabel("token=abc123xyz"), "[secret]");
  assert.equal(sanitizeLabel("重构协议适配器"), "");
  assert.equal(sanitizeLabel("fix 登录 bug"), "fix bug");
});

test("task titles keep CJK but still strip paths and later prompt lines", () => {
  assert.equal(sanitizeTitle("红框处显示任务名称"), "红框处显示任务名称");
  assert.equal(sanitizeTitle("Add the clock\nsecret body"), "Add the clock");
  assert.equal(sanitizeTitle("open C:\\Users\\me\\secret\\app.ts"), "open [path]");
});

test("truncates labels to 80 chars and strips newlines", () => {
  const long = "a".repeat(200);
  const snapshot = normalizeCodexSnapshot({
    tasks: [{ id: "x", status: "working", title: long, lastActiveAt: 1, activities: [{ kind: "tool", text: "line1\nline2", at: 1 }] }],
  });
  assert.ok(snapshot.primaryTask && snapshot.primaryTask.title.length <= 80);
  assert.ok(snapshot.primaryTask && !snapshot.primaryTask.title.includes("\n"));
  assert.ok(!snapshot.activities[0].summary.includes("\n"));
});

test("classifies activity stages, skips token counts, and caps activities at five", () => {
  const acts = [
    { kind: "user_message", at: 1 },
    { kind: "tool", text: "读取项目文件", at: 2 },
    { kind: "token_count", at: 3 },
    { kind: "tool", text: "执行测试", at: 4 },
    { kind: "agent_message", at: 5 },
    { kind: "tool", text: "第六个", at: 6 },
  ];
  const snapshot = normalizeCodexSnapshot({ tasks: [{ id: "x", status: "working", lastActiveAt: 6, activities: acts }] });
  assert.equal(snapshot.activities.length, 5);
  assert.equal(snapshot.activities[0].stage, "analysis");
  assert.equal(snapshot.activities.at(-1)?.at, 6);
});

test("sample app-server fixture produces a privacy-safe snapshot", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/app-server-snapshot.json", import.meta.url), "utf8"));
  const snapshot = normalizeCodexSnapshot(raw);
  assert.equal(snapshot.codexConnected, true);
  assert.equal(snapshot.status, "needs_user");
  assert.ok(snapshot.usage.some((w) => w.windowDurationMins === 300));
  assert.ok(snapshot.usage.some((w) => w.windowDurationMins === 10080));
  assert.equal(snapshot.activities.length, 5);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("sk-ant"), false);
  assert.equal(serialized.includes("C:\\Users"), false);
});
