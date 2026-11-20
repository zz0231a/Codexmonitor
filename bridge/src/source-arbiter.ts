import type { BridgeEvent } from "./event-model.js";
import type { BridgeSnapshot, BridgeStatus, UsageWindow } from "./model.js";
import { normalizeCodexSnapshot, sanitizeTitle } from "./normalizer.js";
import type { StateStore } from "./state-store.js";

const HOOK_PRIORITY_MS = 10_000;
const MAX_ACTIVITIES = 5;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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
  UserPromptSubmit: "analyze input",
  PreToolUse: "run tool",
  PostToolUse: "run tool",
  PermissionRequest: "wait input",
  Stop: "task done",
  "event_msg:task_started": "working",
  "event_msg:user_message": "analyze input",
  "response_item:function_call": "run tool",
  "response_item:custom_tool_call": "run tool",
  "response_item:web_search_call": "web search",
  "event_msg:task_complete": "task done",
  "event_msg:turn_aborted": "aborted",
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
  lastHookAt: number;
  status: BridgeStatus;
  project: string;
  title: string;
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

  function project(): void {
    const clock = now();
    // 驱逐长时间无活动的会话，避免 sessions 表与快照体积无界增长
    for (const [id, session] of sessions) {
      if (clock - session.at > SESSION_TTL_MS && isTerminal(session.status)) {
        sessions.delete(id);
      }
    }
    const tasks = [...sessions.entries()].map(([id, session]) => {
      const title = session.title || sanitizeTitle(session.project) || "Codex Task";
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
      const current = sessions.get(event.sessionKey);
      if (event.source === "jsonl") {
        const sessionHookAt = current?.lastHookAt ?? 0;
        if (sessionHookAt > 0 && clock - sessionHookAt < hookPriorityMs) return false;
      }
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
        lastHookAt: event.source === "hook" ? clock : (current?.lastHookAt ?? 0),
        status: event.event === "event_msg:token_count" && current ? current.status : event.status,
        project: event.project || current?.project || "",
        title: event.title || current?.title || "",
        model: event.model ?? current?.model,
        contextPercent: event.contextPercent ?? current?.contextPercent,
        usage: mergeUsage(current?.usage ?? [], event.usage),
        activities: nextActivities,
        at: event.at,
      };
      sessions.set(event.sessionKey, next);
      store.updateSourceHealth(event.source, event.source === "hook"
        ? { connected: true, lastEventAt: event.at }
        : { available: true, lastRecordAt: event.at, fileFound: true });
      project();
      return true;
    },
  };
}
