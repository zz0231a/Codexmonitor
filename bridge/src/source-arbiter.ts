import type { BridgeEvent } from "./event-model.js";
import type { BridgeSnapshot, BridgeStatus, UsageWindow } from "./model.js";
import { normalizeCodexSnapshot, sanitizeLabel } from "./normalizer.js";
import type { StateStore } from "./state-store.js";

const HOOK_PRIORITY_MS = 10_000;
const MAX_ACTIVITIES = 5;
const TERMINAL = new Set<BridgeStatus>(["done", "error", "idle"]);

const ACTIVITY_KIND: Record<string, string> = {
  UserPromptSubmit: "user_message",
  PreToolUse: "tool",
  PostToolUse: "tool",
  PermissionRequest: "approval",
  PreCompact: "reasoning",
  PostCompact: "reasoning",
  SubagentStart: "tool",
  SubagentStop: "tool",
  Stop: "completed",
  "event_msg:task_started": "reasoning",
  "event_msg:user_message": "user_message",
  "response_item:function_call": "tool",
  "response_item:custom_tool_call": "tool",
  "response_item:web_search_call": "tool",
  "event_msg:context_compacted": "reasoning",
  "event_msg:task_complete": "completed",
  "event_msg:turn_aborted": "completed",
  "event_msg:token_count": "token_count",
};

const ACTIVITY_TEXT: Record<string, string> = {
  UserPromptSubmit: "分析输入",
  PreToolUse: "执行工具",
  PostToolUse: "执行工具",
  PermissionRequest: "等待用户处理",
  Stop: "任务完成",
  "event_msg:task_started": "处理中",
  "event_msg:user_message": "分析输入",
  "response_item:function_call": "执行工具",
  "response_item:custom_tool_call": "执行工具",
  "response_item:web_search_call": "检索网络",
  "event_msg:task_complete": "任务完成",
  "event_msg:turn_aborted": "任务中止",
};

export interface SourceArbiterOptions {
  hookPriorityMs?: number;
  now?: () => number;
}

export interface SourceArbiter {
  accept(event: BridgeEvent): boolean;
}

interface SessionState {
  lastAcceptedAt: number;
  status: BridgeStatus;
  project: string;
  model?: string;
  contextPercent?: number;
  usage: UsageWindow[];
  activities: { kind: string; text: string; at: number }[];
  at: number;
}

function isTerminal(status: BridgeStatus): boolean {
  return TERMINAL.has(status);
}

function mergeUsage(current: UsageWindow[], incoming?: UsageWindow[]): UsageWindow[] {
  if (!incoming || incoming.length === 0) return current;
  const byDuration = new Map(current.map((w) => [w.windowDurationMins, w]));
  for (const window of incoming) byDuration.set(window.windowDurationMins, window);
  return [...byDuration.values()].sort((a, b) => a.windowDurationMins - b.windowDurationMins);
}

export function createSourceArbiter(store: StateStore, options: SourceArbiterOptions = {}): SourceArbiter {
  const hookPriorityMs = options.hookPriorityMs ?? HOOK_PRIORITY_MS;
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, SessionState>();
  let lastHookAt = 0;

  function project(): void {
    const tasks = [...sessions.entries()].map(([id, session]) => {
      const title = sanitizeLabel(session.project) || "Codex 任务";
      const task: Record<string, unknown> = {
        id,
        title,
        status: session.status,
        lastActiveAt: session.at,
        activities: session.activities,
      };
      if (session.model) task.model = session.model;
      if (session.contextPercent !== undefined) task.contextPercent = session.contextPercent;
      return task;
    });
    const usage = [...sessions.values()].flatMap((session) => session.usage);
    const snapshot: BridgeSnapshot = normalizeCodexSnapshot({
      tasks,
      rateLimits: usage.map((w) => ({
        usedPercent: 100 - w.remainingPercent,
        windowDurationMins: w.windowDurationMins,
        resetsAt: w.resetsAt,
      })),
    });
    store.update(snapshot);
  }

  return {
    accept(event: BridgeEvent): boolean {
      const clock = now();
      if (event.source === "jsonl" && lastHookAt > 0 && clock - lastHookAt < hookPriorityMs) return false;
      const current = sessions.get(event.sessionKey);
      if (current && event.at < current.lastAcceptedAt) return false;
      if (current && isTerminal(current.status) && event.status === "working" && event.at <= current.at) return false;

      const kind = ACTIVITY_KIND[event.event] ?? "reasoning";
      const nextActivities = current ? [...current.activities] : [];
      if (kind !== "token_count") {
        nextActivities.push({
          kind,
          text: ACTIVITY_TEXT[event.event] ?? event.event,
          at: event.at,
        });
        while (nextActivities.length > MAX_ACTIVITIES) nextActivities.shift();
      }

      const next: SessionState = {
        lastAcceptedAt: event.at,
        status: event.event === "event_msg:token_count" && current ? current.status : event.status,
        project: event.project || current?.project || "",
        model: event.model ?? current?.model,
        contextPercent: event.contextPercent ?? current?.contextPercent,
        usage: mergeUsage(current?.usage ?? [], event.usage),
        activities: nextActivities,
        at: event.at,
      };
      sessions.set(event.sessionKey, next);
      if (event.source === "hook") lastHookAt = clock;
      store.updateSourceHealth(event.source, event.source === "hook"
        ? { connected: true, lastEventAt: event.at }
        : { available: true, lastRecordAt: event.at, fileFound: true });
      project();
      return true;
    },
  };
}
