import { test } from "node:test";
import assert from "node:assert/strict";
import { createHookIngress } from "../src/hook-ingress.js";
import { buildHookEvent, runHookCli } from "../src/hook-cli.js";
import type { BridgeEvent } from "../src/event-model.js";

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
  const ingress = await createHookIngress(() => {}, {
    host: "127.0.0.1", port: 0, maxBodyBytes: 64 * 1024, salt: "test-salt",
  });
  const tooBig = await fetch(`${ingress.url}/internal/event`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
    body: "x".repeat(64 * 1024 + 1),
  });
  assert.equal(tooBig.status, 413);
  const malformed = await fetch(`${ingress.url}/internal/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(`${ingress.url}/internal/event`)).status, 405);
  assert.equal((await fetch(`${ingress.url}/nope`, { method: "POST", body: "{}" })).status, 404);
  const errorBody = await malformed.text();
  assert.equal(errorBody.includes("not-json"), false);
  await ingress.close();
});

test("hook CLI posts a normalized event and always prints {}", async () => {
  const posts: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await runHookCli({
      readStdin: async () => Buffer.from(JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: "C:\\Users\\me\\secret-project",
        session_id: "raw-session-id",
      })),
      post: async (_url, body) => {
        posts.push(body);
        return 204;
      },
      salt: "test-salt",
      hookUrl: "http://127.0.0.1:9/internal/event",
      now: () => 10,
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(printed, "{}\n");
  assert.equal(posts.length, 1);
  const posted = JSON.parse(posts[0]) as BridgeEvent;
  assert.equal(posted.status, "working");
  assert.equal(posted.project, "secret-project");
  assert.equal(JSON.stringify(posted).includes("raw-session-id"), false);
});

test("buildHookEvent only keeps whitelist fields", () => {
  const event = buildHookEvent({
    hook_event_name: "PermissionRequest",
    prompt: "Add the clock\nDO_NOT_LEAK",
    cwd: "C:\\Users\\me\\work",
  }, 5, "s");
  assert.equal(event.status, "needs_user");
  assert.equal(event.title, "Add the clock");
  assert.equal(JSON.stringify(event).includes("DO_NOT_LEAK"), false);
});
