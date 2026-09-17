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

export function normalizeUsageWindow(raw: unknown): UsageWindow | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const used = value.usedPercent;
  const duration = value.windowDurationMins;
  const resets = value.resetsAt;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
  if (typeof resets !== "number" || !Number.isFinite(resets) || resets < 0) return null;
  return { remainingPercent: Math.max(0, Math.min(100, 100 - used)), windowDurationMins: duration, resetsAt: resets };
}
