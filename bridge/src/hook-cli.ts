import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeBridgeEvent, type BridgeEvent } from "./event-model.js";

const MAX_STDIN_BYTES = 64 * 1024;
const POST_TIMEOUT_MS = 400;
const RETRY_WAIT_MS = 180;

export interface HookCliDeps {
  readStdin?: (maxBytes: number) => Promise<Buffer>;
  post?: (url: string, body: string) => Promise<number>;
  startBridge?: () => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  salt?: string;
  hookUrl?: string;
}

export function buildHookEvent(payload: unknown, nowMs: number, salt: string): BridgeEvent {
  return normalizeBridgeEvent(payload, "hook", nowMs, salt);
}

async function readStdinLimited(maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      return Buffer.concat([...chunks, buf.subarray(0, maxBytes - total)]);
    }
    total += buf.length;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function postEvent(url: string, body: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  return res.status;
}

function startDetachedBridge(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src", "main.ts")], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadHookUrl(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const raw = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")) as { hookPort?: number };
    const port = typeof raw.hookPort === "number" ? raw.hookPort : 8974;
    return `http://127.0.0.1:${port}/internal/event`;
  } catch {
    return "http://127.0.0.1:8974/internal/event";
  }
}

export async function runHookCli(deps: HookCliDeps = {}): Promise<void> {
  try {
    const raw = await (deps.readStdin ?? readStdinLimited)(MAX_STDIN_BYTES);
    let payload: unknown = {};
    try {
      payload = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      payload = {};
    }
    const event = buildHookEvent(payload, (deps.now ?? Date.now)(), deps.salt ?? "codex-monitor");
    const url = await loadHookUrl(deps.hookUrl);
    const body = JSON.stringify(event);
    const post = deps.post ?? postEvent;
    try {
      await post(url, body);
    } catch {
      (deps.startBridge ?? startDetachedBridge)();
      await (deps.wait ?? wait)(RETRY_WAIT_MS);
      try {
        await post(url, body);
      } catch {
        // PermissionRequest must still reach Codex's native UI.
      }
    }
  } finally {
    process.stdout.write("{}\n");
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  runHookCli().catch(() => {
    process.stdout.write("{}\n");
  });
}
