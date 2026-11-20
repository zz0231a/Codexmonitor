export type BridgeStatus = "offline" | "idle" | "working" | "needs_user" | "done" | "error";
export type ActivityStage = "analysis" | "reading" | "tool" | "needs_user" | "responding" | "done" | "error" | "processing";

export interface TaskSummary {
  id: string;
  title: string;
  status: BridgeStatus;
  lastActiveAt: number;
  model?: string;
  contextPercent?: number;
}
export interface ActivitySummary { stage: ActivityStage; summary: string; at: number; }
export interface UsageWindow { remainingPercent: number; windowDurationMins: number; resetsAt: number; }
export interface BridgeSnapshot {
  serverTime: number;
  codexConnected: boolean;
  status: BridgeStatus;
  primaryTask: TaskSummary | null;
  activities: ActivitySummary[];
  usage: UsageWindow[];
  otherActiveTaskCount: number;
}

function finiteNumber(...candidates: unknown[]): number | undefined {
  for (const raw of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** 兼容旧数组字段与官方 JSONL 对象：used_percent / window_minutes / resets_at。 */
export function normalizeUsageWindow(raw: unknown): UsageWindow | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const used = finiteNumber(value.usedPercent, value.used_percent);
  const duration = finiteNumber(value.windowDurationMins, value.window_minutes, value.window_duration_mins);
  const resets = finiteNumber(value.resetsAt, value.resets_at);
  if (used === undefined || used < 0 || used > 100) return null;
  if (duration === undefined || duration <= 0) return null;
  if (resets === undefined || resets < 0) return null;
  return { remainingPercent: Math.max(0, Math.min(100, 100 - used)), windowDurationMins: duration, resetsAt: resets };
}
