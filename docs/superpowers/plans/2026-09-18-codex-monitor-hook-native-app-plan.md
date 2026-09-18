# Codex Monitor Hook Native App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cubic-native `Codex Monitor` app whose Windows bridge receives Codex lifecycle hooks, falls back to incremental session JSONL metadata, and serves a privacy-safe read-only snapshot to device `10.23.2.209`.

**Architecture:** Keep the existing public `schemaVersion: 1` snapshot and Lua polling client. Add a loopback-only hook ingress, a read-only JSONL tailer, and a deterministic source arbiter behind the existing state store; keep the device-facing server on port `8973` with IP allowlisting. Package the Lua app with a current Cubic manifest and management page, then verify locally before any confirmed device or Codex-configuration mutation.

**Tech Stack:** Node.js 22, TypeScript 5.6, `node:http`, `node:fs`, Node test runner + `tsx`, PowerShell 5 startup scripts, Lua/LVGL, Cubic WebUI HTML/JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-18-codex-monitor-hook-native-app-design.md`

## Global Constraints

- Stable device app id: `codex_monitor`.
- Device address: `10.23.2.209`; default device allowlist contains only this address.
- Public bridge endpoint: `0.0.0.0:8973`; hook ingress: `127.0.0.1:8974` only.
- Public device API stays `GET /api/v1/status` and `GET /api/v1/health`, with `Cache-Control: no-store`.
- Hook ingress is never exposed on the LAN and accepts at most 64 KiB per event.
- Never expose or log prompts, assistant responses, reasoning, command arguments, tool outputs, file contents, account ids, API keys, tokens, raw session ids, or raw subagent ids.
- Hook data wins for 10 seconds; JSONL may advance state afterward but cannot regress a newer terminal state.
- Keep the current two-page terminal-style UI, 30-second rotation, manual LEFT/RIGHT switching, and HOME exit.
- Do not modify Windows Firewall, Codex hook configuration, Cubic files, running app, or autostart selection without action-time user confirmation.

---

### Task 1: Introduce source-aware event and health models

**Files:**
- Modify: `bridge/src/model.ts`
- Modify: `bridge/src/state-store.ts`
- Create: `bridge/src/event-model.ts`
- Create: `bridge/test/event-model.test.ts`
- Modify: `bridge/test/server.test.ts`

**Interfaces:**
- Produces: `BridgeEvent`, `BridgeSource`, `SourceHealth`, `normalizeBridgeEvent(raw, source, nowMs)`.
- Produces: `StateStore.updateSourceHealth(source, patch)` and `StateStore.sourceHealth()`.
- Existing `BridgeSnapshot` and public `schemaVersion: 1` remain backward compatible.

- [ ] **Step 1: Write failing event-model tests**

```ts
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
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd bridge && npm ci && node --test --import tsx test/event-model.test.ts`

Expected: FAIL because `event-model.ts` and `normalizeBridgeEvent` do not exist.

- [ ] **Step 3: Implement the event and source-health types**

```ts
export type BridgeSource = "hook" | "jsonl";

export interface BridgeEvent {
  source: BridgeSource;
  status: BridgeStatus;
  stage: ActivityStage;
  event: string;
  at: number;
  sessionKey: string;
  subagentKey?: string;
  project: string;
  model?: string;
  toolCategory?: string;
  contextPercent?: number;
  usage?: UsageWindow[];
}

export interface SourceHealth {
  hook: { lastEventAt: number; connected: boolean };
  jsonl: { lastRecordAt: number; available: boolean; fileFound: boolean };
}
```

Implement identifier hashing with `createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12)`, project basename extraction capped at 40 characters, and an explicit tool-category allowlist (`terminal`, `edit`, `read`, `web`, `image`, `mcp`, `other`). Do not copy arbitrary tool names into `BridgeEvent`.

- [ ] **Step 4: Extend the state store with source health**

Add immutable source-health updates without changing `current()` or `lastUpdatedAt()` semantics:

```ts
updateSourceHealth(source, patch) {
  health = { ...health, [source]: { ...health[source], ...patch } };
},
sourceHealth: () => structuredClone(health),
```

- [ ] **Step 5: Run model, event-model, state-store, and server tests**

Run: `cd bridge && npm test && npx tsc --noEmit`

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/model.ts bridge/src/event-model.ts bridge/src/state-store.ts bridge/test/event-model.test.ts bridge/test/server.test.ts
git commit -m "桥接层：建立 Hook 与 JSONL 事件模型"
```

---

### Task 2: Add the loopback-only Codex Hook ingress

**Files:**
- Create: `bridge/src/hook-ingress.ts`
- Create: `bridge/src/hook-cli.ts`
- Create: `bridge/test/hook-ingress.test.ts`
- Modify: `bridge/package.json`

**Interfaces:**
- Produces: `createHookIngress(onEvent, { host, port, maxBodyBytes })`.
- Produces: `buildHookEvent(payload, nowMs, salt)` and executable `hook-cli.ts`.
- `hook-cli.ts` posts only normalized `BridgeEvent` to `http://127.0.0.1:8974/internal/event` and always prints `{}` to stdout.

- [ ] **Step 1: Write failing ingress and CLI tests**

```ts
test("hook ingress accepts a normalized local event and rejects non-loopback binding", async () => {
  const received: BridgeEvent[] = [];
  const ingress = await createHookIngress((event) => received.push(event), {
    host: "127.0.0.1", port: 0, maxBodyBytes: 64 * 1024,
  });
  const res = await fetch(`${ingress.url}/internal/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "hook", status: "working", event: "PreToolUse", at: 1 }),
  });
  assert.equal(res.status, 204);
  assert.equal(received.length, 1);
  await ingress.close();
  await assert.rejects(() => createHookIngress(() => {}, { host: "0.0.0.0", port: 0, maxBodyBytes: 1 }));
});

test("oversized and malformed bodies are rejected", async () => {
  // Expect 413 for >64 KiB and 400 for invalid JSON.
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd bridge && node --test --import tsx test/hook-ingress.test.ts`

Expected: FAIL because the ingress and CLI do not exist.

- [ ] **Step 3: Implement the loopback server**

Use a dedicated `node:http` server. Reject any configured host other than `127.0.0.1`, `::1`, or `localhost`; accept only `POST /internal/event`; limit body size before concatenation; validate the parsed object with `normalizeBridgeEvent`; return `204`, `400`, `404`, `405`, or `413` without echoing payload data.

- [ ] **Step 4: Implement the command Hook adapter**

`hook-cli.ts` reads at most 64 KiB from stdin, normalizes only the whitelist fields, posts to loopback with a 400 ms timeout, and prints exactly:

```json
{}
```

If the Bridge is absent, it attempts one hidden detached Bridge start, waits 180 ms, retries once, then still returns `{}` so `PermissionRequest` remains in Codex's native UI.

- [ ] **Step 5: Add scripts and run verification**

Add:

```json
"hook": "tsx src/hook-cli.ts",
"typecheck": "tsc --noEmit"
```

Run: `cd bridge && npm test && npm run typecheck`

Expected: all tests and typecheck pass.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/hook-ingress.ts bridge/src/hook-cli.ts bridge/test/hook-ingress.test.ts bridge/package.json bridge/package-lock.json
git commit -m "桥接层：接收本机 Codex Hook 事件"
```

---

### Task 3: Implement incremental session JSONL fallback and usage extraction

**Files:**
- Create: `bridge/src/jsonl-monitor.ts`
- Create: `bridge/test/jsonl-monitor.test.ts`
- Create: `bridge/test/fixtures/session-sample.jsonl`
- Create: `bridge/test/fixtures/session-partial.jsonl`

**Interfaces:**
- Produces: `createJsonlMonitor(options)` with `poll(): Promise<BridgeEvent[]>`, `currentFile()`, and `close()`.
- Consumes only `session_meta`, `turn_context`, selected `event_msg`/`response_item` types, `token_count`, and `rate_limits` metadata.
- Emits no message, reasoning, arguments, output, or raw ids.

- [ ] **Step 1: Create privacy-focused fixtures and failing tests**

The fixture must include sentinel secrets in disallowed fields:

```json
{"timestamp":"2026-09-18T00:00:00Z","type":"session_meta","payload":{"id":"raw-session","cwd":"C:\\Users\\me\\project"}}
{"timestamp":"2026-09-18T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"DO_NOT_LEAK_PROMPT"}}
{"timestamp":"2026-09-18T00:00:02Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"DO_NOT_LEAK_ARGS"}}
{"timestamp":"2026-09-18T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":100000,"last_token_usage":{"total_tokens":25000},"rate_limits":[{"windowDurationMins":300,"usedPercent":20,"resetsAt":1800000000},{"windowDurationMins":10080,"usedPercent":60,"resetsAt":1800600000}]}}}
{"timestamp":"2026-09-18T00:00:04Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"DO_NOT_LEAK_REPLY"}}
```

Assert emitted events contain project `project`, context `25`, both usage windows, and none of the sentinel strings or full path.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd bridge && node --test --import tsx test/jsonl-monitor.test.ts`

Expected: FAIL because `jsonl-monitor.ts` does not exist.

- [ ] **Step 3: Implement newest-session discovery and incremental tailing**

Recursively scan `${CODEX_HOME}/sessions` for `.jsonl`, choose newest `mtimeMs`, keep `{ path, offset, partial }`, and read at most 8 MiB. On attachment, parse the tail only to establish metadata and cursor state; on later polls, parse only appended bytes. Tolerate rotation, truncation, partial final lines, malformed records, and disappearing files.

Map only these keys:

```ts
const JSONL_STATUS = {
  "event_msg:task_started": "working",
  "event_msg:user_message": "working",
  "response_item:function_call": "working",
  "response_item:custom_tool_call": "working",
  "response_item:web_search_call": "working",
  "event_msg:context_compacted": "working",
  "event_msg:task_complete": "done",
  "event_msg:turn_aborted": "idle",
} as const;
```

- [ ] **Step 4: Implement context and rate-limit extraction**

Compute context percent from `last_token_usage.total_tokens / model_context_window`. Recursively locate `rate_limits` or `rateLimits` only inside a `token_count` record, then pass candidate windows through existing `normalizeUsageWindow`; retain only 300- and 10080-minute windows.

- [ ] **Step 5: Run privacy, fallback, normalizer, and type tests**

Run: `cd bridge && npm test && npm run typecheck`

Expected: all tests pass; a serialized emitted event never contains any sentinel or raw path/id.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/jsonl-monitor.ts bridge/test/jsonl-monitor.test.ts bridge/test/fixtures/session-sample.jsonl bridge/test/fixtures/session-partial.jsonl
git commit -m "桥接层：增加 Codex JSONL 安全兜底"
```

---

### Task 4: Arbitrate sources and wire the live Bridge

**Files:**
- Create: `bridge/src/source-arbiter.ts`
- Create: `bridge/test/source-arbiter.test.ts`
- Modify: `bridge/src/main.ts`
- Modify: `bridge/src/server.ts`
- Modify: `bridge/test/server.test.ts`
- Modify: `bridge/config.example.json`
- Modify: `bridge/README.md`

**Interfaces:**
- Produces: `createSourceArbiter(store, { hookPriorityMs, now })` and `accept(event)`.
- `createStatusServer` health response adds `sources` but status response remains compatible.
- `main()` starts public server, loopback ingress, and JSONL monitor; fixture mode remains supported.

- [ ] **Step 1: Write failing arbitration tests**

```ts
test("hook wins for ten seconds, then jsonl may advance state", () => {
  let now = 100_000;
  const arbiter = createSourceArbiter(store, { hookPriorityMs: 10_000, now: () => now });
  arbiter.accept(hookEvent("working", now));
  now += 5_000;
  assert.equal(arbiter.accept(jsonlEvent("done", now)), false);
  now += 6_000;
  assert.equal(arbiter.accept(jsonlEvent("done", now)), true);
});

test("older working event cannot regress a newer terminal event", () => {
  arbiter.accept(jsonlEvent("done", 200));
  assert.equal(arbiter.accept(jsonlEvent("working", 199)), false);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd bridge && node --test --import tsx test/source-arbiter.test.ts`

Expected: FAIL because `source-arbiter.ts` does not exist.

- [ ] **Step 3: Implement source arbitration and event-to-snapshot projection**

Maintain a map by hashed session key. Update the task title from sanitized project name, append a safe activity label from a fixed event/stage dictionary, retain at most five activities, and pass the projected raw shape through `normalizeCodexSnapshot` before `store.update`.

Precedence rules:

```ts
if (event.source === "jsonl" && now() - lastHookAt < hookPriorityMs) return false;
if (event.at < lastAcceptedAt) return false;
if (isTerminal(current.status) && event.status === "working" && event.at <= current.at) return false;
```

- [ ] **Step 4: Extend health without breaking the public status schema**

Return this health body:

```json
{
  "bridge": "up",
  "codex_connected": true,
  "last_updated_at": 0,
  "sources": {
    "hook": { "connected": true, "last_event_at": 0 },
    "jsonl": { "available": true, "file_found": true, "last_record_at": 0 }
  }
}
```

Use HTTP `200` whenever either source is available; use `503` only when neither source can provide Codex state.

- [ ] **Step 5: Wire live startup and safe defaults**

Set `config.example.json` to:

```json
{
  "host": "0.0.0.0",
  "port": 8973,
  "allow": ["10.23.2.209"],
  "hookHost": "127.0.0.1",
  "hookPort": 8974,
  "jsonlPollIntervalMs": 1200
}
```

Remove the `live app-server transport not wired yet` branch. Live mode starts both sources; fixture mode starts neither and continues to serve its sample snapshot.

- [ ] **Step 6: Run full Bridge validation and a fixture smoke test**

Run:

```powershell
cd bridge
npm test
npm run typecheck
npm run start -- --fixture test/fixtures/app-server-snapshot.json
```

Expected: tests/typecheck pass; `/api/v1/status` returns `schemaVersion: 1`; `/api/v1/health` reports source health. Stop the smoke-test process after the two requests.

- [ ] **Step 7: Commit**

```powershell
git add bridge/src/source-arbiter.ts bridge/src/main.ts bridge/src/server.ts bridge/test/source-arbiter.test.ts bridge/test/server.test.ts bridge/config.example.json bridge/README.md
git commit -m "桥接层：接通 Hook 与 JSONL 实时状态"
```

---

### Task 5: Build an idempotent Codex Hook and startup installer

**Files:**
- Create: `bridge/scripts/manage-installation.mjs`
- Create: `bridge/test/installation.test.mjs`
- Modify: `bridge/scripts/install-startup.ps1`
- Modify: `bridge/scripts/uninstall-startup.ps1`
- Modify: `bridge/package.json`
- Modify: `bridge/README.md`

**Interfaces:**
- Produces pure functions `upsertManagedHooks`, `removeManagedHooks`, `ensureHooksFeature`, and `buildHookCommand`.
- CLI supports `--dry-run`, `--install`, and `--uninstall`.
- Managed marker is the absolute `hook-cli.ts` path plus label `codex-monitor-hook`; unrelated entries remain byte-for-byte equivalent after parse/stringify normalization.

- [ ] **Step 1: Write failing installer tests with a temporary Codex home**

```js
test("install is idempotent and preserves unrelated hooks", async () => {
  const initial = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  await writeFile(join(home, "hooks.json"), JSON.stringify(initial));
  const first = await install({ codexHome: home, dryRun: false, platform: "win32" });
  const second = await install({ codexHome: home, dryRun: false, platform: "win32" });
  assert.ok(first.added > 0);
  assert.equal(second.added, 0);
  assert.ok(JSON.stringify(await readHooks(home)).includes("other-tool"));
});

test("uninstall removes only codex-monitor-hook entries", async () => {
  // Assert unrelated hook and unrelated config keys remain.
});
```

- [ ] **Step 2: Run installer tests and verify failure**

Run: `cd bridge && node --test test/installation.test.mjs`

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement safe hook configuration transforms**

Manage these event arrays:

```js
const EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PreCompact", "PostCompact", "SubagentStart",
  "SubagentStop", "Stop",
];
```

Each desired entry is:

```js
{
  hooks: [{
    type: "command",
    command: `node "${wslPathToHookCli}"`,
    commandWindows: `& "${process.execPath}" --import tsx "${windowsPathToHookCli}"`,
    timeout: 5,
  }],
}
```

Create one backup per target (`hooks.json.codex-monitor.bak`, `config.toml.codex-monitor.bak`), use same-directory temporary files plus atomic rename, preserve newline style, and add/update `[features] hooks = true` without changing other keys.

- [ ] **Step 4: Keep startup installation current-user scoped**

Update the existing PowerShell scripts to use the checked `node.exe`, checked `tsx` import path, quoted absolute Bridge path, hidden window style, and the current-user Startup folder only. Uninstall removes only `Codex Monitor Bridge.lnk`.

- [ ] **Step 5: Add dry-run and package scripts**

```json
"install:dry-run": "node scripts/manage-installation.mjs --dry-run",
"install:hooks": "node scripts/manage-installation.mjs --install",
"uninstall:hooks": "node scripts/manage-installation.mjs --uninstall"
```

Dry-run prints target paths, events to add/update, startup target, and whether `hooks = true` needs changing, but never prints existing hook commands, config values, tokens, or payloads.

- [ ] **Step 6: Verify only against temporary directories**

Run:

```powershell
cd bridge
npm test
npm run typecheck
npm run install:dry-run
```

Expected: tests/typecheck pass; dry-run reports planned changes and makes no change to `$env:CODEX_HOME`, `~/.codex`, registry, or Startup.

- [ ] **Step 7: Commit**

```powershell
git add bridge/scripts/manage-installation.mjs bridge/scripts/install-startup.ps1 bridge/scripts/uninstall-startup.ps1 bridge/test/installation.test.mjs bridge/package.json bridge/README.md
git commit -m "安装：安全注册 Codex Hook 与登录启动"
```

---

### Task 6: Adapt the Cubic package to current console conventions

**Files:**
- Modify: `cubic/package/app.info`
- Modify: `cubic/package/main.html`
- Modify: `cubic/package/main.lua`
- Modify: `cubic/package/info.html`
- Modify: `cubic/test/manifest.test.mjs`
- Modify: `cubic/test/long-run-check.mjs`
- Create: `cubic/test/management-page.test.mjs`
- Create: `cubic/scripts/build-package.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces a distributable `dist/codex_monitor.zip` whose archive root directly contains `app.info`, `main.lua`, `main.html`, `info.html`, `main.png`, and `assets/`.
- Management page reads/writes `/sd/apps/codex_monitor/config.json` and tests `GET /api/v1/health`.
- Runtime keeps polling `GET /api/v1/status` once per second.

- [ ] **Step 1: Write failing current-manifest and management-page tests**

Assert `app.info` includes:

```ini
name = Codex Monitor
name_zh = Codex 状态监视
name_zh_cn = Codex 状态监视
name_en = Codex Monitor
kind = app
category = tool
catalog_scope = community
entry = main.lua
icon = main.png
description = Privacy-safe Codex status and usage monitor
description_zh = 在 Cubic 上显示经过隐私过滤的 Codex 状态、活动与用量
version = 0.2.0
```

Assert the management page renders source status fields, validates port range `1..65535`, and refuses empty host values before calling device file APIs.

- [ ] **Step 2: Run Cubic tests and verify failure**

Run: `cd cubic && node --test test/*.test.mjs`

Expected: FAIL for missing current manifest fields, source status, and package builder.

- [ ] **Step 3: Update manifest, description, and management page**

Keep host default empty so no developer address is baked into a public package; default port remains `8973`. The connection test displays Bridge, Codex, Hook, JSONL, and last-update status. Saving uses the Cubic-provided file API and does not touch global settings.

- [ ] **Step 4: Harden Lua configuration and health rendering**

Validate host as a hostname or IPv4 text without `/`, `?`, `#`, whitespace, or control characters. Validate port as an integer `1..65535`. Read system settings only for display timezone and weather location; show the configured city with unavailable weather metrics as `--` until a firmware-supported weather data API is verified. Do not introduce a remote API key or silently call a new third party.

- [ ] **Step 5: Add a deterministic package builder**

Use Node's built-in file traversal plus an existing local archive command discovered at runtime (`Compress-Archive` on Windows) to create `cubic/dist/codex_monitor.zip`. Before archiving, reject missing required files, any file outside `package/`, Windows absolute paths in text assets, and secret-like strings (`sk-`, `api_key`, `token=`).

- [ ] **Step 6: Run all static and package checks**

Run:

```powershell
cd cubic
node --test test/*.test.mjs
node scripts/build-package.mjs
```

Expected: all tests pass; builder reports the archive path and file count; inspecting the ZIP shows required files at archive root.

- [ ] **Step 7: Commit**

```powershell
git add cubic/package cubic/test cubic/scripts/build-package.mjs .gitignore
git commit -m "设备端：适配 Cubic 原生应用安装包"
```

---

### Task 7: End-to-end local validation, documentation, and confirmed deployment

**Files:**
- Create: `bridge/test/live-pipeline.test.ts`
- Create: `docs/deployment.md`
- Modify: `bridge/README.md`
- Modify: `docs/superpowers/specs/2026-09-18-codex-monitor-hook-native-app-design.md` only if verified device behavior differs from the approved design

**Interfaces:**
- Exercises hook payload -> loopback ingress -> arbiter -> state store -> public API -> Cubic fixture contract.
- Documents exact install, rollback, diagnosis, and confirmed device steps.

- [ ] **Step 1: Write the failing live-pipeline test**

Start hook ingress and public server on ephemeral ports, post a `UserPromptSubmit`, a `PreToolUse`, and a `PermissionRequest`, then assert `/api/v1/status` progresses `working -> working -> needs_user`, exposes only hashed ids/project basename, and passes the Cubic fixture contract. Stop hook events, append a JSONL `task_complete`, advance the fake clock by 11 seconds, poll, and assert final status `done`.

- [ ] **Step 2: Run the e2e test and verify failure**

Run: `cd bridge && node --test --import tsx test/live-pipeline.test.ts`

Expected: FAIL until all live modules expose deterministic start/stop and injected-clock interfaces.

- [ ] **Step 3: Complete deterministic lifecycle wiring and pass e2e**

Add only the lifecycle hooks needed by the test (`close`, timer cleanup, injected `now`, injected session root). Do not add production-only bypasses.

- [ ] **Step 4: Write deployment and rollback documentation**

Document:

1. `npm ci`, local tests, and package build;
2. dry-run output review;
3. confirmed Hook/startup installation;
4. obtaining the Windows LAN IPv4 address without publishing it in the repository;
5. confirmed upload of `cubic/dist/codex_monitor.zip` through the Cubic console;
6. setting Bridge host/port in the app page;
7. health/status checks and the five required live states;
8. rollback with `npm run uninstall:hooks`, startup removal, and Cubic app uninstall;
9. no-firewall-change policy and symptoms of a blocked port.

- [ ] **Step 5: Run the complete local verification suite**

Run:

```powershell
cd bridge
npm ci
npm test
npm run typecheck
npm run install:dry-run
cd ..\cubic
node --test test/*.test.mjs
node scripts/build-package.mjs
cd ..
git diff --check
git status --short
```

Expected: all tests/typecheck/package checks pass; dry-run makes no external changes; only intended source/doc changes are present.

- [ ] **Step 6: Request action-time confirmation for Codex configuration changes**

Present the exact files and startup item that will change:

- `%CODEX_HOME%\hooks.json`;
- `%CODEX_HOME%\config.toml` (`[features] hooks = true` only);
- current-user `Codex Monitor Bridge.lnk` startup shortcut.

After explicit confirmation, run `npm run install:hooks`, verify backups exist, verify unrelated entries remain, and request the user to approve the new command hook in Codex `/hooks` if Codex prompts.

- [ ] **Step 7: Verify Bridge on the LAN before touching the device**

Start or confirm the installed Bridge, request `/api/v1/health` and `/api/v1/status` locally, then verify the listening address is `0.0.0.0:8973` and hook ingress is only `127.0.0.1:8974`. Trigger a disposable Codex task and verify working/done transitions without printing payload contents.

- [ ] **Step 8: Request action-time confirmation for device upload and app switching**

State that uploading the ZIP changes files on `10.23.2.209` and opening it will stop/switch away from the currently running `全息PC监控`. After explicit confirmation, upload through the console's local-app install path, rescan, and open `Codex Monitor`.

- [ ] **Step 9: Configure and verify the physical device**

In the app management page, enter the verified Windows LAN IPv4 address and port `8973`, save, test `/api/v1/health`, then verify:

- working, tool activity, needs-user, done, and offline/recovery states;
- LEFT/RIGHT/HOME behavior;
- both usage windows or explicit `--` when unavailable;
- no clipped essential text at 320×240;
- 30-minute run without freezes or growing timer/resource counts.

Do not change Cubic autostart until separately requested or confirmed at action time.

- [ ] **Step 10: Reconcile documentation with verified behavior**

If firmware APIs, manifest keys, package path, or Hook payloads differ from the approved spec, stop and give the user the required three-way choice: update code to match docs, update docs to match verified behavior, or record a temporary divergence. Apply only the chosen reconciliation.

- [ ] **Step 11: Commit the verified integration**

```powershell
git add bridge/test/live-pipeline.test.ts bridge/README.md docs/deployment.md
git commit -m "验证：完成 Codex Monitor 本地端到端流程"
```

Do not commit generated ZIP files, local IP configuration, backups, device exports, Hook configuration, logs, session data, or credentials.

