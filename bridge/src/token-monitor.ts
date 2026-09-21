import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TOP_N = 8;
const STALE_AFTER_MS = 12 * 60 * 1000;
const RATE_IDLE_AFTER_MS = 20_000;
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
  remainingPercent: number | null;
  window: string;
  todayTokens: number | null;
}

export interface TokenMonitorSnapshot {
  available: boolean;
  stale: boolean;
  updatedAt: number;
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

export const EMPTY_TOKEN_MONITOR: TokenMonitorSnapshot = {
  available: false,
  stale: true,
  updatedAt: 0,
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

function windowLabel(window: Record<string, unknown>): string {
  const minutes = finiteNumber(window.windowMinutes ?? window.window_minutes);
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
  const future = candidates
    .filter((item) => item.resetAt !== null && item.resetAt >= nowMs - 30_000)
    .sort((a, b) => (a.resetAt ?? 0) - (b.resetAt ?? 0));
  const chosen = future[0] ?? [...candidates].sort((a, b) => {
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

export function projectTokenMonitor(
  hub: unknown,
  settings: unknown,
  nowMs: number,
  rateState: TokenMonitorRateState | null = null,
): { snapshot: TokenMonitorSnapshot; rateState: TokenMonitorRateState | null } {
  const root = asRecord(hub);
  const devices = asRecord(root?.devices);
  if (!devices || Object.keys(devices).length === 0) {
    return { snapshot: EMPTY_TOKEN_MONITOR, rateState };
  }
  const wantedId = safeId(asRecord(settings)?.deviceId ?? asRecord(settings)?.lastPostedDeviceId);
  const device = asRecord(wantedId ? devices[wantedId] : null)
    ?? asRecord(Object.values(devices)[0]);
  if (!device) return { snapshot: EMPTY_TOKEN_MONITOR, rateState };

  const updatedMs = parseTimeMs(device.updatedAt) ?? parseTimeMs(device.receivedAt) ?? 0;
  const periods = asRecord(device.periods);
  const allTime = periodTotals(periods?.allTime);
  const today = periodTotals(periods?.today);
  const periodWindows = asRecord(device.periodWindows);
  const todayKey = typeof periodWindows?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(periodWindows.today)
    ? periodWindows.today
    : dateKeyUtc(updatedMs || nowMs);
  const last7 = sumDaily(device.history, todayKey) ?? today;

  const ranked = [...clientTotals(periods?.allTime).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N);

  const limitAccounts = new Map<string, Record<string, unknown>[]>();
  const providers = asRecord(device.limits)?.providers;
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

  const todayClients = clientTotals(periods?.today);

  const tools: TokenMonitorTool[] = ranked.map(([id, _tokens], index) => {
    const limitId = CLIENT_TO_LIMIT[id] ?? id;
    const next = nextResetWindow(pickAccount(limitAccounts.get(limitId) ?? []), nowMs);
    return {
      id,
      rank: index + 1,
      remainingPercent: next?.remainingPercent ?? null,
      window: next?.window ?? "--",
      todayTokens: todayClients.get(id) ?? null,
    };
  });

  const rate = today
    ? nextRate(rateState, today.tokens, nowMs)
    : { snapshot: { tokensPerMin: null, idle: true }, state: rateState };

  return {
    snapshot: {
      available: true,
      stale: updatedMs === 0 || nowMs - updatedMs > STALE_AFTER_MS,
      updatedAt: Math.floor((updatedMs || nowMs) / 1000),
      tools,
      rate: rate.snapshot,
      today,
      last7,
      allTime,
    },
    rateState: rate.state,
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

  return {
    dir,
    poll(): TokenMonitorSnapshot {
      const hub = readJsonFile(path.join(dir, "hub-devices.json"));
      if (hub === null) {
        rateState = null;
        return EMPTY_TOKEN_MONITOR;
      }
      const settings = readJsonFile(path.join(dir, "settings.json"));
      const projected = projectTokenMonitor(hub, settings, now(), rateState);
      rateState = projected.rateState;
      return projected.snapshot;
    },
  };
}
