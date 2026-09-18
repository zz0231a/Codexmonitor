import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBridge } from "../src/main.js";

async function postHook(url: string, payload: unknown) {
  const res = await fetch(`${url}/internal/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 204);
}

test("hook events then jsonl fallback drive the public snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-live-"));
  const session = path.join(dir, "session.jsonl");
  await writeFile(session, `{"timestamp":"2026-09-18T00:00:00Z","type":"session_meta","payload":{"id":"raw-session-id","cwd":"C:\\\\Users\\\\me\\\\secret-project"}}\n`);
  let now = 1_700_000_000_000;
  const bridge = await startBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      allow: ["127.0.0.1"],
      hookHost: "127.0.0.1",
      hookPort: 0,
      sessionsRoot: dir,
      privacySalt: "test-salt",
      jsonlPollIntervalMs: 60_000,
    },
    now: () => now,
  });
  try {
    await postHook(bridge.hookUrl as string, {
      hook_event_name: "UserPromptSubmit",
      cwd: "C:\\Users\\me\\secret-project",
      session_id: "raw-session-id",
    });
    let status = await (await fetch(`${bridge.url}/api/v1/status`)).json();
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.status, "working");
    await postHook(bridge.hookUrl as string, {
      hook_event_name: "PreToolUse",
      cwd: "C:\\Users\\me\\secret-project",
      session_id: "raw-session-id",
      tool_name: "exec_command",
    });
    status = await (await fetch(`${bridge.url}/api/v1/status`)).json();
    assert.equal(status.status, "working");
    await postHook(bridge.hookUrl as string, {
      hook_event_name: "PermissionRequest",
      cwd: "C:\\Users\\me\\secret-project",
      session_id: "raw-session-id",
    });
    status = await (await fetch(`${bridge.url}/api/v1/status`)).json();
    assert.equal(status.status, "needs_user");
    assert.equal(status.primary_task.title, "secret-project");
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("raw-session-id"), false);
    assert.equal(serialized.includes("C:\\Users"), false);
    assert.match(String(status.primary_task.id), /^[a-f0-9]{12}$/);

    await appendFile(session, `{"timestamp":"2026-09-18T00:00:20Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"DO_NOT_LEAK_REPLY"}}\n`);
    now += 11_000;
    await bridge.pollJsonl();
    status = await (await fetch(`${bridge.url}/api/v1/status`)).json();
    assert.equal(status.status, "done");
    assert.equal(JSON.stringify(status).includes("DO_NOT_LEAK_REPLY"), false);

    const health = await (await fetch(`${bridge.url}/api/v1/health`)).json();
    assert.equal(health.bridge, "up");
    assert.equal(health.sources.hook.connected, true);
  } finally {
    await bridge.close();
  }
});
