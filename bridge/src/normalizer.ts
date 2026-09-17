import type { ActivityStage, ActivitySummary, BridgeSnapshot, BridgeStatus, TaskSummary, UsageWindow } from "./model.js";
import { normalizeUsageWindow } from "./model.js";
import { parseProtocolStatus, parseProtocolTimestamp } from "./codex-protocol.js";

const MAX_ACTIVITIES = 5;
const MAX_LABEL_LENGTH = 80;

const STATUS_RANK: Record<BridgeStatus, number> = {
  needs_user: 3,
  working: 2,
  done: 1,
  idle: 1,
  error: 1,
  offline: 0,
};

/** 主任务优先级：等待用户 > 运行中 > 最近活跃。 */
export function selectPrimaryTask(tasks: TaskSummary[]): TaskSummary | null {
  let best: TaskSummary | null = null;
  for (const task of tasks) {
    if (!best) { best = task; continue; }
    const rank = STATUS_RANK[task.status] ?? 0;
    const bestRank = STATUS_RANK[best.status] ?? 0;
    if (rank > bestRank || (rank === bestRank && task.lastActiveAt > best.lastActiveAt)) best = task;
  }
  return best;
}

/** 活动阶段归类；计数类事件不是用户可见活动，返回 null 跳过。 */
export function classifyActivityStage(kind: unknown): ActivityStage | null {
  switch (kind) {
    case "user_message":
    case "reasoning":
      return "analysis";
    case "reading":
    case "file_read":
      return "reading";
    case "tool":
    case "exec":
      return "tool";
    case "approval":
    case "request_user_input":
      return "needs_user";
    case "agent_message":
    case "message":
      return "responding";
    case "turn_complete":
    case "completed":
      return "done";
    case "error":
    case "failed":
      return "error";
    case "token_count":
      return null;
    default:
      return "processing";
  }
}

const DEFAULT_LABELS: Record<ActivityStage, string> = {
  analysis: "分析输入",
  reading: "读取文件",
  tool: "执行工具",
  needs_user: "等待用户处理",
  responding: "生成回复",
  done: "任务完成",
  error: "处理失败",
  processing: "处理中",
};

const PATH_PATTERN = /[A-Za-z]:[\\/][^"'\s，。；、]+|\/(?:home|Users|tmp|var|etc)\/[^"'\s，。；、]+/g;
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|api[_-]?key\s*[=:]\s*[^\s，。]+|token\s*[=:]\s*[^\s，。]+)/gi;

/** 生成设备端安全的短摘要：去掉路径与密钥形态内容、去除换行、截断到 80 字符。 */
export function sanitizeLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(PATH_PATTERN, "[路径]")
    .replace(SECRET_PATTERN, "[密钥]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function clampPercent(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(100, raw));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeTask(raw: unknown): TaskSummary {
  const task = asRecord(raw);
  const summary: TaskSummary = {
    id: typeof task.id === "string" && task.id ? task.id : "",
    title: sanitizeLabel(task.title),
    status: parseProtocolStatus(task.status),
    lastActiveAt: parseProtocolTimestamp(task.lastActiveAt),
  };
  const model = sanitizeLabel(task.model);
  if (model) summary.model = model;
  const contextPercent = clampPercent(task.contextPercent);
  if (contextPercent !== undefined) summary.contextPercent = contextPercent;
  return summary;
}

function normalizeActivities(rawTasks: unknown[]): ActivitySummary[] {
  const activities: ActivitySummary[] = [];
  for (const rawTask of rawTasks) {
    const task = asRecord(rawTask);
    for (const rawActivity of asArray(task.activities)) {
      const activity = asRecord(rawActivity);
      const stage = classifyActivityStage(activity.kind);
      if (stage === null) continue;
      const label = sanitizeLabel(activity.text ?? activity.summary) || DEFAULT_LABELS[stage];
      activities.push({ stage, summary: label, at: parseProtocolTimestamp(activity.at) });
    }
  }
  activities.sort((a, b) => a.at - b.at);
  return activities.slice(-MAX_ACTIVITIES);
}

function normalizeUsageWindows(raw: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const rawWindow of asArray(raw)) {
    const window = normalizeUsageWindow(rawWindow);
    if (window) windows.push(window);
  }
  windows.sort((a, b) => a.windowDurationMins - b.windowDurationMins);
  return windows;
}

/** 把 app-server 原始输入归一化为设备端快照；只保留安全字段。 */
export function normalizeCodexSnapshot(input: unknown): BridgeSnapshot {
  const root = asRecord(input);
  const rawTasks = asArray(root.tasks);
  const tasks = rawTasks.map(normalizeTask);
  const primaryTask = selectPrimaryTask(tasks);
  const activeStatuses: BridgeStatus[] = ["working", "needs_user"];
  return {
    serverTime: Math.floor(Date.now() / 1000),
    codexConnected: true,
    status: primaryTask ? primaryTask.status : "idle",
    primaryTask,
    activities: normalizeActivities(rawTasks),
    usage: normalizeUsageWindows(root.rateLimits),
    otherActiveTaskCount: tasks.filter((t) => t.id !== primaryTask?.id && activeStatuses.includes(t.status)).length,
  };
}
