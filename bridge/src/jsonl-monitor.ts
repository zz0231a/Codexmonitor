import { readdir, stat, open } from "node:fs/promises";
import path from "node:path";
import type { BridgeEvent, BridgeSource } from "./event-model.js";
import { normalizeBridgeEvent } from "./event-model.js";
import { normalizeUsageWindow, type BridgeStatus, type UsageWindow } from "./model.js";

const JSONL_STATUS: Record<string, BridgeStatus> = {
  "event_msg:task_started": "working",
  "event_msg:user_message": "working",
  "response_item:function_call": "working",
  "response_item:custom_tool_call": "working",
  "response_item:web_search_call": "working",
  "event_msg:context_compacted": "working",
  "event_msg:task_complete": "done",
  "event_msg:turn_aborted": "idle",
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_DURATIONS = new Set([300, 10080]);

export interface JsonlMonitorOptions {
  sessionsRoot: string;
  salt: string;
  now?: () => number;
  maxBytes?: number;
}

export interface JsonlMonitor {
  poll(): Promise<BridgeEvent[]>;
  currentFile(): string | null;
  close(): void;
}

interface Cursor {
  path: string;
  offset: number;
  partial: string;
}

interface SessionMeta {
  sessionId: string;
  cwd: string;
  model?: string;
  contextPercent?: number;
  usage?: UsageWindow[];
  lastStatus: BridgeStatus;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function newestJsonl(root: string): Promise<{ path: string; mtimeMs: number; size: number } | null> {
  const files = await listJsonlFiles(root);
  let best: { path: string; mtimeMs: number; size: number } | null = null;
  for (const file of files) {
    try {
      const info = await stat(file);
      if (!best || info.mtimeMs > best.mtimeMs) {
        best = { path: file, mtimeMs: info.mtimeMs, size: info.size };
      }
    } catch {
      // skip disappearing files
    }
  }
  return best;
}

function parseTime(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

function findRateLimits(node: unknown): unknown[] {
  if (Array.isArray(node)) {
    if (node.some((item) => {
      const rec = asRecord(item);
      return typeof rec.windowDurationMins === "number" || typeof rec.usedPercent === "number";
    })) {
      return node;
    }
    for (const item of node) {
      const found = findRateLimits(item);
      if (found.length) return found;
    }
    return [];
  }
  const rec = asRecord(node);
  if (Array.isArray(rec.rate_limits)) return rec.rate_limits;
  if (Array.isArray(rec.rateLimits)) return rec.rateLimits;
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") {
      const found = findRateLimits(value);
      if (found.length) return found;
    }
  }
  return [];
}

function extractUsage(tokenCountPayload: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const raw of findRateLimits(tokenCountPayload)) {
    const window = normalizeUsageWindow(raw);
    if (window && ALLOWED_DURATIONS.has(window.windowDurationMins)) windows.push(window);
  }
  windows.sort((a, b) => a.windowDurationMins - b.windowDurationMins);
  return windows;
}

function extractContextPercent(tokenCountPayload: Record<string, unknown>): number | undefined {
  const info = asRecord(tokenCountPayload.info);
  const usage = asRecord(info.last_token_usage ?? tokenCountPayload.last_token_usage);
  const total = usage.total_tokens;
  const window = info.model_context_window ?? tokenCountPayload.model_context_window;
  if (typeof total !== "number" || typeof window !== "number" || !Number.isFinite(total) || !Number.isFinite(window) || window <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round((total / window) * 100)));
}

function keyFor(type: string, payloadType: string): string {
  return `${type}:${payloadType}`;
}

function toEvent(
  source: BridgeSource,
  status: BridgeStatus,
  event: string,
  at: number,
  meta: SessionMeta,
  salt: string,
  extra: Record<string, unknown> = {},
): BridgeEvent {
  return normalizeBridgeEvent({
    status,
    event,
    at,
    session_id: meta.sessionId,
    cwd: meta.cwd,
    model: meta.model,
    contextPercent: meta.contextPercent,
    usage: meta.usage,
    ...extra,
  }, source, at, salt);
}

function parseRecord(raw: unknown, meta: SessionMeta, salt: string, nowMs: number): BridgeEvent | null {
  const rec = asRecord(raw);
  const type = typeof rec.type === "string" ? rec.type : "";
  const payload = asRecord(rec.payload);
  const payloadType = typeof payload.type === "string" ? payload.type : "";
  const at = parseTime(rec.timestamp, nowMs);

  if (type === "session_meta") {
    if (typeof payload.id === "string") meta.sessionId = payload.id;
    if (typeof payload.cwd === "string") meta.cwd = payload.cwd;
    return null;
  }
  if (type === "turn_context") {
    if (typeof payload.model === "string") meta.model = payload.model;
    return null;
  }
  if (type === "event_msg" && payloadType === "token_count") {
    const contextPercent = extractContextPercent(payload);
    if (contextPercent !== undefined) meta.contextPercent = contextPercent;
    const usage = extractUsage(payload);
    if (usage.length) meta.usage = usage;
    return toEvent("jsonl", meta.lastStatus, "event_msg:token_count", at, meta, salt);
  }

  const mapped = JSONL_STATUS[keyFor(type, payloadType)];
  if (!mapped) return null;
  meta.lastStatus = mapped;
  const extra: Record<string, unknown> = {};
  if (type === "response_item" && typeof payload.name === "string") extra.tool_name = payload.name;
  if (payloadType === "web_search_call") extra.tool_name = "web_search";
  return toEvent("jsonl", mapped, keyFor(type, payloadType), at, meta, salt, extra);
}

function splitLines(chunk: string, partial: string): { lines: string[]; partial: string } {
  const text = partial + chunk;
  const parts = text.split(/\r?\n/);
  const nextPartial = parts.pop() ?? "";
  return { lines: parts, partial: nextPartial };
}

export function createJsonlMonitor(options: JsonlMonitorOptions): JsonlMonitor {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => Date.now());
  let cursor: Cursor | null = null;
  let current: string | null = null;
  const meta: SessionMeta = { sessionId: "", cwd: "", lastStatus: "idle" };
  let closed = false;

  async function readSlice(filePath: string, start: number, length: number): Promise<Buffer> {
    const handle = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function attach(filePath: string, size: number): Promise<BridgeEvent[]> {
    const start = Math.max(0, size - maxBytes);
    const buf = await readSlice(filePath, start, Math.min(maxBytes, size - start));
    let text = buf.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    const split = splitLines(text, "");
    cursor = { path: filePath, offset: size, partial: split.partial };
    current = filePath;
    const events: BridgeEvent[] = [];
    for (const line of split.lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const event = parseRecord(parsed, meta, options.salt, now());
      if (event) events.push(event);
    }
    return events;
  }

  return {
    async poll() {
      if (closed) return [];
      const newest = await newestJsonl(options.sessionsRoot);
      if (!newest) {
        cursor = null;
        current = null;
        return [];
      }
      try {
        if (!cursor || cursor.path !== newest.path || newest.size < cursor.offset) {
          return await attach(newest.path, newest.size);
        }
        if (newest.size === cursor.offset && !cursor.partial) return [];
        const length = Math.min(maxBytes, Math.max(0, newest.size - cursor.offset));
        const buf = length > 0 ? await readSlice(newest.path, cursor.offset, length) : Buffer.alloc(0);
        const split = splitLines(buf.toString("utf8"), cursor.partial);
        cursor = { path: newest.path, offset: newest.size, partial: split.partial };
        current = newest.path;
        const events: BridgeEvent[] = [];
        for (const line of split.lines) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const event = parseRecord(parsed, meta, options.salt, now());
          if (event) events.push(event);
        }
        return events;
      } catch {
        return [];
      }
    },
    currentFile: () => current,
    close() {
      closed = true;
    },
  };
}

export { JSONL_STATUS };
