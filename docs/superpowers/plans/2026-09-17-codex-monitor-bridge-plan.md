# Codex Monitor Windows Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a Windows login-start bridge that reads the local Codex app-server and exposes a privacy-filtered, read-only status API to Cubic.

**Architecture:** A Node.js bridge owns the app-server protocol connection, normalizes task state and rate-limit windows, and serves a small HTTP API. Protocol-specific code is isolated from the public snapshot model so Codex upgrades do not require device-app changes.

**Tech Stack:** Node.js 22+, TypeScript, built-in `node:test`, JSON-RPC over the local Codex app-server proxy, built-in `http`, Windows user-level startup shortcut/script.

**Spec:** `docs/superpowers/specs/2026-09-17-codex-cubic-monitor-design.md`

## Global Constraints

- Expose only `GET /api/v1/status` and `GET /api/v1/health`.
- Do not send full prompts, responses, command arguments, file contents, account IDs, API keys, or auth tokens to Cubic or logs.
- Choose the primary task by `needs_user` > `working` > most recently active.
- Identify usage windows by `windowDurationMins`, not by fixed primary/secondary ordering.
- Convert `usedPercent` to remaining percentage and clamp to 0–100.
- Keep the bridge read-only and local/LAN-scoped.

### Task 1: Establish bridge package and public snapshot types

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/tsconfig.json`
- Create: `bridge/src/model.ts`
- Test: `bridge/test/model.test.ts`

**Interfaces:**
- Produces `BridgeSnapshot`, `TaskSummary`, `ActivitySummary`, `UsageWindow`, and `normalizeUsageWindow(raw)` for later tasks.

- [x] **Step 1: Write failing model tests**

```ts
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
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `cd bridge; npm test -- --test-name-pattern="normalizes|absent"`

Expected: FAIL because `src/model.ts` and `normalizeUsageWindow` do not exist.

- [x] **Step 3: Implement the minimal model and package scripts**

Define exact JSON-safe interfaces and implement `normalizeUsageWindow(raw: unknown): UsageWindow | null`; reject non-numeric or out-of-range values by returning `null`.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `cd bridge; npm test -- --test-name-pattern="normalizes|absent"`

Expected: PASS.

- [x] **Step 5: Commit**

```text
git add bridge
git commit -m "桥接层：建立状态快照模型"
```

### Task 2: Implement protocol adapter and task selection

**Files:**
- Create: `bridge/src/codex-protocol.ts`
- Create: `bridge/src/normalizer.ts`
- Test: `bridge/test/normalizer.test.ts`
- Create: `bridge/test/fixtures/app-server-snapshot.json`

**Interfaces:**
- Consumes `BridgeSnapshot` model types from Task 1.
- Produces `normalizeCodexSnapshot(input): BridgeSnapshot` and `selectPrimaryTask(tasks): TaskSummary | null`.

- [x] **Step 1: Write failing tests for task priority, activity redaction, and rate windows**

```ts
test("prioritizes a task needing user action over a running task", () => {
  const selected = selectPrimaryTask([
    { id: "run", status: "working", lastActiveAt: 30 },
    { id: "ask", status: "needs_user", lastActiveAt: 10 },
  ]);
  assert.equal(selected?.id, "ask");
});

test("drops sensitive fields from activity summaries", () => {
  const snapshot = normalizeCodexSnapshot({ tasks: [{ id: "x", status: "working", title: "Task", lastActiveAt: 1, activities: [{ kind: "tool", text: "run", command: "secret" }] }] });
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});
```

- [x] **Step 2: Run tests and verify failure**

Run: `cd bridge; npm test -- --test-name-pattern="prioritizes|drops"`

Expected: FAIL because the adapter and normalizer are not implemented.

- [x] **Step 3: Implement the adapter and normalizer**

Implement a JSON-RPC transport boundary with `connectCodex(): AsyncIterable<unknown>` and keep protocol parsing in `codex-protocol.ts`. In `normalizer.ts`, map only safe event kind, safe short label, timestamp, status, model name, counts, and usage fields. Truncate labels to 80 characters and remove newlines.

- [x] **Step 4: Run all bridge unit tests**

Run: `cd bridge; npm test`

Expected: PASS for priority, redaction, window identification, missing fields, and status mapping.

- [x] **Step 5: Commit**

```text
git add bridge/src bridge/test
git commit -m "桥接层：归一化 Codex 任务与用量"
```

### Task 3: Add read-only HTTP server and stale-state behavior

**Files:**
- Create: `bridge/src/server.ts`
- Create: `bridge/src/state-store.ts`
- Test: `bridge/test/server.test.ts`

**Interfaces:**
- Consumes `BridgeSnapshot` from Task 1 and normalized updates from Task 2.
- Produces `createStatusServer(store, config)` and JSON responses for `/api/v1/status` and `/api/v1/health`.

- [x] **Step 1: Write failing HTTP tests**

```ts
test("serves status but rejects mutating routes", async () => {
  const server = await createTestServer({ codexConnected: true, primaryTask: null });
  const status = await fetch(`${server.url}/api/v1/status`);
  assert.equal(status.status, 200);
  const post = await fetch(`${server.url}/api/v1/status`, { method: "POST" });
  assert.equal(post.status, 405);
  await server.close();
});
```

- [x] **Step 2: Run test and verify failure**

Run: `cd bridge; npm test -- --test-name-pattern="serves status"`

Expected: FAIL because the server does not exist.

- [x] **Step 3: Implement server and state store**

Bind to the configured LAN address, return a JSON snapshot with `schemaVersion: 1`, set `Cache-Control: no-store`, reject non-GET methods, and return `503` only for `/health` when the bridge cannot connect. A stale status snapshot remains readable and includes `codex_connected: false` and `last_updated_at`.

- [x] **Step 4: Run HTTP, redaction, and stale-state tests**

Run: `cd bridge; npm test`

Expected: PASS, including no mutating endpoint and no restricted fields in serialized output.

- [x] **Step 5: Commit**

```text
git add bridge/src/server.ts bridge/src/state-store.ts bridge/test/server.test.ts
git commit -m "桥接层：提供只读状态接口"
```

### Task 4: Add Windows startup, configuration, and end-to-end sample run

**Files:**
- Create: `bridge/src/main.ts`
- Create: `bridge/config.example.json`
- Create: `bridge/scripts/install-startup.ps1`
- Create: `bridge/scripts/uninstall-startup.ps1`
- Create: `bridge/README.md`
- Test: `bridge/test/e2e-sample.test.ts`

**Interfaces:**
- Consumes the adapter, state store, and HTTP server from Tasks 1–3.
- Produces a user-level startup installation and a working `npm run start` command.

- [x] **Step 1: Write failing sample integration test**

```ts
test("sample app-server snapshot becomes the documented public JSON", async () => {
  const snapshot = await runNormalizerFixture("test/fixtures/app-server-snapshot.json");
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(JSON.stringify(snapshot).includes("command"), false);
  assert.ok(snapshot.usage.windows.some((w) => w.windowDurationMins === 300));
  assert.ok(snapshot.usage.windows.some((w) => w.windowDurationMins === 10080));
});
```

- [x] **Step 2: Run and verify failure**

Run: `cd bridge; npm test -- --test-name-pattern="sample app-server"`

Expected: FAIL because the executable entry point and fixture runner are not implemented.

- [x] **Step 3: Implement startup and configuration**

Read `config.json`, default to a loopback listener plus an explicit LAN opt-in, start the app-server adapter, and expose clean shutdown. The PowerShell installer creates a current-user Startup shortcut or scheduled task without administrator rights; the uninstaller removes only that named entry.

- [x] **Step 4: Run all tests and a local sample server**

Run: `cd bridge; npm test`; then `npm run start -- --fixture test/fixtures/app-server-snapshot.json` and request `GET http://127.0.0.1:<port>/api/v1/status`.

Expected: all tests PASS and the response contains only the documented safe snapshot fields.

- [x] **Step 5: Commit**

```text
git add bridge
git commit -m "桥接层：完成 Windows 启动与配置"
```

## Verification Checklist

- [x] Unit tests pass with `npm test`.
- [x] Sample response contains both 300-minute and 10080-minute windows when supplied.
- [x] `GET /api/v1/health` reports bridge and Codex connectivity separately.
- [x] No response or log contains prompt text, response text, command arguments, file contents, account IDs, API keys, or auth tokens.
- [x] Startup install/uninstall is scoped to the current user and named application entry.
