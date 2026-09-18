import { createHash } from "node:crypto";
import type { ActivityStage, BridgeStatus, UsageWindow } from "./model.js";
import { normalizeUsageWindow } from "./model.js";

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

export const DEFAULT_SOURCE_HEALTH: SourceHealth = {
  hook: { lastEventAt: 0, connected: false },
  jsonl: { lastRecordAt: 0, available: false, fileFound: false },
};

const TOOL_CATEGORIES = new Set(["terminal", "edit", "read", "web", "image", "mcp", "other"]);

const TOOL_NAME_CATEGORY: Record<string, string> = {
  exec_command: "terminal",
  shell: "terminal",
  bash: "terminal",
  powershell: "terminal",
  apply_patch: "edit",
  edit: "edit",
  write_file: "edit",
  str_replace: "edit",
  read_file: "read",
  read: "read",
  grep: "read",
  glob: "read",
  web_search: "web",
  web_fetch: "web",
  image: "image",
  generate_image: "image",
};

const HOOK_STATUS: Record<string, BridgeStatus> = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PermissionRequest: "needs_user",
  PreCompact: "working",
  PostCompact: "working",
  SubagentStart: "working",
  SubagentStop: "working",
  Stop: "done",
};

const HOOK_STAGE: Record<string, ActivityStage> = {
  SessionStart: "processing",
  UserPromptSubmit: "analysis",
  PreToolUse: "tool",
  PostToolUse: "tool",
  PermissionRequest: "needs_user",
  PreCompact: "processing",
  PostCompact: "processing",
  SubagentStart: "processing",
  SubagentStop: "processing",
  Stop: "done",
};

const VALID_STATUS = new Set<BridgeStatus>(["offline", "idle", "working", "needs_user", "done", "error"]);
const VALID_STAGE = new Set<ActivityStage>([
  "analysis", "reading", "tool", "needs_user", "responding", "done", "error", "processing",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function hashIdentifier(salt: string, value: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12);
}

export function projectBasename(cwd: unknown): string {
  if (typeof cwd !== "string" || !cwd.trim()) return "";
  const trimmed = cwd.replace(/[\\/]+$/, "").trim();
  const parts = trimmed.split(/[\\/]/);
  return (parts.at(-1) ?? "").slice(0, 40);
}

export function classifyToolCategory(toolName: unknown): string | undefined {
  if (typeof toolName !== "string" || !toolName) return undefined;
  const lower = toolName.toLowerCase();
  if (lower.startsWith("mcp")) return "mcp";
  const mapped = TOOL_NAME_CATEGORY[lower];
  if (mapped && TOOL_CATEGORIES.has(mapped)) return mapped;
  return "other";
}

function asStatus(value: unknown): BridgeStatus | undefined {
  return typeof value === "string" && VALID_STATUS.has(value as BridgeStatus) ? value as BridgeStatus : undefined;
}

function asStage(value: unknown): ActivityStage | undefined {
  return typeof value === "string" && VALID_STAGE.has(value as ActivityStage) ? value as ActivityStage : undefined;
}

function stageFor(status: BridgeStatus, eventName: string, explicit?: ActivityStage): ActivityStage {
  if (explicit) return explicit;
  if (HOOK_STAGE[eventName]) return HOOK_STAGE[eventName];
  if (status === "needs_user") return "needs_user";
  if (status === "error") return "error";
  if (status === "done") return "done";
  if (status === "working") return "processing";
  return "processing";
}

function hashedKey(salt: string, rawId: unknown, existing?: unknown): string | undefined {
  if (typeof existing === "string" && /^[a-f0-9]{12}$/.test(existing)) return existing;
  if (typeof rawId === "string" && rawId) return hashIdentifier(salt, rawId);
  return undefined;
}

function normalizeUsageList(raw: unknown): UsageWindow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const windows: UsageWindow[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (typeof rec.remainingPercent === "number" && typeof rec.windowDurationMins === "number" && typeof rec.resetsAt === "number") {
      const duration = rec.windowDurationMins;
      if (duration !== 300 && duration !== 10080) continue;
      if (!Number.isFinite(rec.remainingPercent) || rec.remainingPercent < 0 || rec.remainingPercent > 100) continue;
      if (!Number.isFinite(rec.resetsAt) || rec.resetsAt < 0) continue;
      windows.push({
        remainingPercent: rec.remainingPercent,
        windowDurationMins: duration,
        resetsAt: rec.resetsAt,
      });
      continue;
    }
    const window = normalizeUsageWindow(item);
    if (window && (window.windowDurationMins === 300 || window.windowDurationMins === 10080)) {
      windows.push(window);
    }
  }
  return windows.length > 0 ? windows : undefined;
}

function postToolFailed(raw: Record<string, unknown>): boolean {
  const response = asRecord(raw.tool_response);
  return response.is_error === true;
}

function safeEventName(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim().slice(0, 80) || "unknown";
}

function clampPercent(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(100, raw));
}

function safeModel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const model = raw.replace(/[\r\n]/g, " ").trim().slice(0, 80);
  return model || undefined;
}

/** Normalize a Codex hook payload or an already-shaped event. Never copies raw ids, cwd, or tool names. */
export function normalizeBridgeEvent(
  raw: unknown,
  source: BridgeSource,
  nowMs: number,
  salt: string,
): BridgeEvent {
  const input = asRecord(raw);
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const eventName = safeEventName(hookName || (typeof input.event === "string" ? input.event : "unknown"));

  let status = asStatus(input.status) ?? HOOK_STATUS[hookName] ?? HOOK_STATUS[eventName] ?? "idle";
  if ((hookName === "PostToolUse" || eventName === "PostToolUse") && postToolFailed(input)) {
    status = "error";
  }

  const sessionKey = hashedKey(salt, input.session_id, input.sessionKey) ?? hashIdentifier(salt, "");
  const subagentKey = hashedKey(salt, input.subagent_id, input.subagentKey);
  const project = projectBasename(input.project) || projectBasename(input.cwd);
  const toolCategory = TOOL_CATEGORIES.has(String(input.toolCategory))
    ? String(input.toolCategory)
    : classifyToolCategory(input.tool_name);
  const at = typeof input.at === "number" && Number.isFinite(input.at) && input.at >= 0 ? input.at : nowMs;
  const model = safeModel(input.model);
  const contextPercent = clampPercent(input.contextPercent);
  const usage = normalizeUsageList(input.usage);

  const event: BridgeEvent = {
    source,
    status,
    stage: stageFor(status, eventName, asStage(input.stage)),
    event: eventName,
    at,
    sessionKey,
    project,
  };
  if (subagentKey) event.subagentKey = subagentKey;
  if (model) event.model = model;
  if (toolCategory) event.toolCategory = toolCategory;
  if (contextPercent !== undefined) event.contextPercent = contextPercent;
  if (usage) event.usage = usage;
  return event;
}
