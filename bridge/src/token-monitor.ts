import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TOP_N = 8;
const STALE_AFTER_MS = 12 * 60 * 1000;
const RATE_IDLE_AFTER_MS = 20_000;
const ACTIVE_TOOL_IDLE_AFTER_MS = 60_000;
const CLIENT_TO_LIMIT: Record<string, string> = {
  droid: "factory",
  micode: "mimo",
  zcode: "zai",
  qodercn: "qoder",
};

export interface TokenMonitorTotals {
  tokens: number;
  costUsd: number;
}

export interface TokenMonitorTool {
  id: string;
  rank: number;
  /** 圆环用：下一次重置的那一档，可能是月度等非 5H/7D 窗口。 */
  remainingPercent: number | null;
  window: string;
  /** 鱼标签用：只认 5 小时（300 分钟 / session）和 7 天（10080 分钟 / weekly）。 */
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
  todayTokens: number | null;
}

export interface TokenMonitorSnapshot {
  available: boolean;
  stale: boolean;
  updatedAt: number;
  activeToolId: string | null;
  tools: TokenMonitorTool[];
  rate: { tokensPerMin: number | null; idle: boolean };
  today: TokenMonitorTotals | null;
  last7: TokenMonitorTotals | null;
  allTime: TokenMonitorTotals | null;
}

export interface TokenMonitorRateState {
  tokens: number;
  atMs: number;
  tokensPerMin: number | null;
}

export interface TokenMonitorActivityState {
  todayByTool: Record<string, number>;
  activeToolId: string | null;
  activeAtMs: number | null;
}

export const EMPTY_TOKEN_MONITOR: TokenMonitorSnapshot = {
  available: false,
  stale: true,
  updatedAt: 0,
  activeToolId: null,
  tools: [],
  rate: { tokensPerMin: null, idle: true },
  today: null,
  last7: null,
  allTime: null,
};

export function defaultTokenMonitorDir(): string {
  const roaming = process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  return path.join(roaming, "Token Monitor");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeId(value: unknown): string | null {
  const id = String(value || "").trim().toLowerCase();
  if (!id || id.length > 24) return null;
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) return null;
  return id;
}

function windowMinutesOf(window: Record<string, unknown>): number | null {
  return finiteNumber(window.windowMinutes ?? window.window_minutes);
}

function isFiveHourWindow(window: Record<string, unknown>): boolean {
  const minutes = windowMinutesOf(window);
  if (minutes === 300) return true;
  if (minutes !== null) return false;
  return String(window.kind || "").trim().toLowerCase() === "session";
}

function isSevenDayWindow(window: Record<string, unknown>): boolean {
  const minutes = windowMinutesOf(window);
  if (minutes === 10080) return true;
  if (minutes !== null) return false;
  return String(window.kind || "").trim().toLowerCase() === "weekly";
}

function quotaPercent(
  account: Record<string, unknown> | null,
  match: (window: Record<string, unknown>) => boolean,
): number | null {
  if (!account) return null;
  const windows = Array.isArray(account.windows) ? account.windows : [];
  for (const raw of windows) {
    const window = asRecord(raw);
    if (!window || window.showMeter === false) continue;
    if (!match(window)) continue;
    const remaining = finiteNumber(window.remainingPercent);
    if (remaining === null) continue;
    return clampPercent(remaining);
  }
  return null;
}

function windowLabel(window: Record<string, unknown>): string {
  const minutes = windowMinutesOf(window);
  if (minutes === 300) return "5H";
  if (minutes === 10080) return "7D";
  const kind = String(window.kind || "").trim().toLowerCase();
  if (kind === "session") return "5H";
  if (kind === "weekly") return "WKLY";
  if (kind === "daily") return "DAY";
  if (kind === "billing") return "MO";
  return "LEFT";
}

function periodTotals(period: unknown): TokenMonitorTotals | null {
  const record = asRecord(period);
  if (!record) return null;
  const tokens = finiteNumber(record.totalTokens ?? record.tokens);
  const costUsd = finiteNumber(record.costUsd ?? record.cost);
  if (tokens === null || tokens < 0) return null;
  return { tokens, costUsd: costUsd === null || costUsd < 0 ? 0 : costUsd };
}

function addTotals(a: TokenMonitorTotals | null, b: TokenMonitorTotals | null): TokenMonitorTotals | null {
  if (!a) return b;
  if (!b) return a;
  return { tokens: a.tokens + b.tokens, costUsd: a.costUsd + b.costUsd };
}

function mergeClients(into: Map<string, number>, add: Map<string, number>): void {
  for (const [id, tokens] of add) {
    into.set(id, (into.get(id) ?? 0) + tokens);
  }
}

function deviceTodayKey(device: Record<string, unknown>, nowMs: number): string {
  const periodWindows = asRecord(device.periodWindows);
  if (typeof periodWindows?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(periodWindows.today)) {
    return periodWindows.today;
  }
  const updatedMs = parseTimeMs(device.updatedAt) ?? parseTimeMs(device.receivedAt) ?? nowMs;
  return dateKeyUtc(updatedMs);
}

function clientTotals(period: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const clients = asRecord(asRecord(period)?.clients);
  if (!clients) return out;
  for (const [rawId, rawValue] of Object.entries(clients)) {
    const id = safeId(rawId);
    const tokens = finiteNumber(rawValue);
    if (!id || tokens === null || tokens < 0) continue;
    out.set(id, tokens);
  }
  return out;
}

function dateKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function last7Keys(todayKey: string): Set<string> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayKey);
  if (!match) return new Set([todayKey]);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const keys = new Set<string>();
  for (let i = 0; i < 7; i += 1) {
    keys.add(dateKeyUtc(utc - i * 86400000));
  }
  return keys;
}

function sumDaily(history: unknown, todayKey: string): TokenMonitorTotals | null {
  const daily = asRecord(history)?.daily;
  if (!Array.isArray(daily)) return null;
  const want = last7Keys(todayKey);
  let tokens = 0;
  let costUsd = 0;
  let matched = false;
  for (const row of daily) {
    const record = asRecord(row);
    if (!record) continue;
    const date = typeof record.date === "string" ? record.date : "";
    if (!want.has(date)) continue;
    const rowTokens = finiteNumber(record.tokens ?? record.totalTokens);
    const rowCost = finiteNumber(record.cost ?? record.costUsd) ?? 0;
    if (rowTokens === null || rowTokens < 0) continue;
    tokens += rowTokens;
    costUsd += rowCost;
    matched = true;
  }
  return matched ? { tokens, costUsd } : null;
}

function pickAccount(accounts: Record<string, unknown>[]): Record<string, unknown> | null {
  if (accounts.length === 0) return null;
  const ranked = [...accounts].sort((a, b) => {
    const aOk = String(a.status || "") === "ok" ? 0 : 1;
    const bOk = String(b.status || "") === "ok" ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    const aAt = parseTimeMs(a.updatedAt) ?? 0;
    const bAt = parseTimeMs(b.updatedAt) ?? 0;
    return bAt - aAt;
  });
  return ranked[0] ?? null;
}

function nextResetWindow(account: Record<string, unknown> | null, nowMs: number): { remainingPercent: number; window: string } | null {
  if (!account) return null;
  const windows = Array.isArray(account.windows) ? account.windows : [];
  const candidates: { remainingPercent: number; window: string; resetAt: number | null }[] = [];
  for (const raw of windows) {
    const window = asRecord(raw);
    if (!window) continue;
    if (window.showMeter === false) continue;
    const remaining = finiteNumber(window.remainingPercent);
    if (remaining === null) continue;
    candidates.push({
      remainingPercent: clampPercent(remaining),
      window: windowLabel(window),
      resetAt: parseTimeMs(window.resetsAt),
    });
  }
  if (candidates.length === 0) return null;
  // 5H/7D 可能是 100% 未用的速率窗口；只要还有未满窗口（如 Kimi 月度），就不要用满额窗口冒充用量。
  const used = candidates.filter((item) => item.remainingPercent < 100);
  const pool = used.length > 0 ? used : candidates;
  const future = pool
    .filter((item) => item.resetAt !== null && item.resetAt >= nowMs - 30_000)
    .sort((a, b) => (a.resetAt ?? 0) - (b.resetAt ?? 0));
  const chosen = future[0] ?? [...pool].sort((a, b) => {
    if (a.resetAt === null && b.resetAt === null) return 0;
    if (a.resetAt === null) return 1;
    if (b.resetAt === null) return -1;
    return a.resetAt - b.resetAt;
  })[0];
  return chosen ? { remainingPercent: chosen.remainingPercent, window: chosen.window } : null;
}

function nextRate(
  previous: TokenMonitorRateState | null,
  tokens: number,
  nowMs: number,
): { snapshot: TokenMonitorSnapshot["rate"]; state: TokenMonitorRateState } {
  if (!previous) {
    return {
      snapshot: { tokensPerMin: null, idle: true },
      state: { tokens, atMs: nowMs, tokensPerMin: null },
    };
  }
  if (tokens < previous.tokens) {
    return {
      snapshot: { tokensPerMin: null, idle: true },
      state: { tokens, atMs: nowMs, tokensPerMin: null },
    };
  }
  const dtMs = nowMs - previous.atMs;
  if (dtMs <= 0) {
    return {
      snapshot: { tokensPerMin: previous.tokensPerMin, idle: previous.tokensPerMin === null },
      state: previous,
    };
  }
  const delta = tokens - previous.tokens;
  if (delta > 0 && dtMs >= 1000) {
    const tokensPerMin = delta / (dtMs / 60_000);
    return {
      snapshot: { tokensPerMin, idle: false },
      state: { tokens, atMs: nowMs, tokensPerMin },
    };
  }
  const idle = nowMs - previous.atMs >= RATE_IDLE_AFTER_MS || previous.tokensPerMin === null;
  return {
    snapshot: { tokensPerMin: idle ? null : previous.tokensPerMin, idle },
    state: {
      tokens,
      atMs: previous.atMs,
      tokensPerMin: idle ? null : previous.tokensPerMin,
    },
  };
}

function nextActiveTool(
  previous: TokenMonitorActivityState | null,
  todayByTool: Map<string, number>,
  nowMs: number,
): { activeToolId: string | null; state: TokenMonitorActivityState } {
  const current = Object.fromEntries(todayByTool);
  let activeToolId: string | null = null;
  let activeAtMs: number | null = null;

  if (previous) {
    let largestDelta = 0;
    for (const [id, tokens] of todayByTool) {
      const before = previous.todayByTool[id];
      const delta = before === undefined ? 0 : tokens - before;
      if (delta > largestDelta) {
        largestDelta = delta;
        activeToolId = id;
      }
    }
    if (activeToolId !== null) {
      activeAtMs = nowMs;
    } else if (
      previous.activeToolId !== null
      && previous.activeAtMs !== null
      && nowMs - previous.activeAtMs < ACTIVE_TOOL_IDLE_AFTER_MS
    ) {
      activeToolId = previous.activeToolId;
      activeAtMs = previous.activeAtMs;
    }
  }

  return {
    activeToolId,
    state: { todayByTool: current, activeToolId, activeAtMs },
  };
}

export function projectTokenMonitor(
  hub: unknown,
  settings: unknown,
  nowMs: number,
  rateState: TokenMonitorRateState | null = null,
  activityState: TokenMonitorActivityState | null = null,
): {
  snapshot: TokenMonitorSnapshot;
  rateState: TokenMonitorRateState | null;
  activityState: TokenMonitorActivityState | null;
} {
  const root = asRecord(hub);
  const devices = asRecord(root?.devices);
  if (!devices || Object.keys(devices).length === 0) {
    return { snapshot: EMPTY_TOKEN_MONITOR, rateState, activityState };
  }
  const wantedId = safeId(asRecord(settings)?.deviceId ?? asRecord(settings)?.lastPostedDeviceId);
  const deviceList = Object.values(devices)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
  const localDevice = asRecord(wantedId ? devices[wantedId] : null) ?? deviceList[0];
  if (!localDevice || deviceList.length === 0) return { snapshot: EMPTY_TOKEN_MONITOR, rateState, activityState };

  // Token Monitor 首页 TOTAL TOKENS 是全部设备加总；额度环仍用本机账号。
  let allTime: TokenMonitorTotals | null = null;
  let today: TokenMonitorTotals | null = null;
  let last7: TokenMonitorTotals | null = null;
  const allTimeClients = new Map<string, number>();
  const todayClients = new Map<string, number>();
  let updatedMs = 0;
  for (const item of deviceList) {
    const periods = asRecord(item.periods);
    const deviceToday = periodTotals(periods?.today);
    allTime = addTotals(allTime, periodTotals(periods?.allTime));
    today = addTotals(today, deviceToday);
    last7 = addTotals(last7, sumDaily(item.history, deviceTodayKey(item, nowMs)) ?? deviceToday);
    mergeClients(allTimeClients, clientTotals(periods?.allTime));
    mergeClients(todayClients, clientTotals(periods?.today));
    updatedMs = Math.max(
      updatedMs,
      parseTimeMs(item.updatedAt) ?? parseTimeMs(item.receivedAt) ?? 0,
    );
  }

  const ranked = [...allTimeClients.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N);

  const limitAccounts = new Map<string, Record<string, unknown>[]>();
  const providers = asRecord(localDevice.limits)?.providers;
  if (Array.isArray(providers)) {
    for (const raw of providers) {
      const account = asRecord(raw);
      const provider = safeId(account?.provider);
      if (!account || !provider) continue;
      const list = limitAccounts.get(provider) ?? [];
      list.push(account);
      limitAccounts.set(provider, list);
    }
  }

  const tools: TokenMonitorTool[] = ranked.map(([id, _tokens], index) => {
    const limitId = CLIENT_TO_LIMIT[id] ?? id;
    const account = pickAccount(limitAccounts.get(limitId) ?? []);
    const next = nextResetWindow(account, nowMs);
    return {
      id,
      rank: index + 1,
      remainingPercent: next?.remainingPercent ?? null,
      window: next?.window ?? "--",
      fiveHourPercent: quotaPercent(account, isFiveHourWindow),
      sevenDayPercent: quotaPercent(account, isSevenDayWindow),
      todayTokens: todayClients.get(id) ?? null,
    };
  });

  const rate = today
    ? nextRate(rateState, today.tokens, nowMs)
    : { snapshot: { tokensPerMin: null, idle: true }, state: rateState };
  const activity = nextActiveTool(activityState, todayClients, nowMs);

  return {
    snapshot: {
      available: true,
      stale: updatedMs === 0 || nowMs - updatedMs > STALE_AFTER_MS,
      updatedAt: Math.floor((updatedMs || nowMs) / 1000),
      activeToolId: activity.activeToolId,
      tools,
      rate: rate.snapshot,
      today,
      last7,
      allTime,
    },
    rateState: rate.state,
    activityState: activity.state,
  };
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function createTokenMonitorReader(options: {
  dir?: string;
  now?: () => number;
} = {}) {
  const dir = options.dir ?? defaultTokenMonitorDir();
  const now = options.now ?? Date.now;
  let rateState: TokenMonitorRateState | null = null;
  let activityState: TokenMonitorActivityState | null = null;

  return {
    dir,
    poll(): TokenMonitorSnapshot {
      const hub = readJsonFile(path.join(dir, "hub-devices.json"));
      if (hub === null) {
        rateState = null;
        activityState = null;
        return EMPTY_TOKEN_MONITOR;
      }
      const settings = readJsonFile(path.join(dir, "settings.json"));
      const projected = projectTokenMonitor(hub, settings, now(), rateState, activityState);
      rateState = projected.rateState;
      activityState = projected.activityState;
      return projected.snapshot;
    },
  };
}
