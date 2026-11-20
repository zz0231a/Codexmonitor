import type { BridgeSnapshot } from "./model.js";
import { DEFAULT_SOURCE_HEALTH, type BridgeSource, type SourceHealth } from "./event-model.js";
import { EMPTY_TOKEN_MONITOR, type TokenMonitorSnapshot } from "./token-monitor.js";

export interface StateStore {
  /** 写入一次新的归一化快照并刷新最后更新时间。 */
  update(snapshot: BridgeSnapshot): void;
  /** Codex 断连时保留最后数据，仅标记 codexConnected=false。 */
  markDisconnected(): void;
  current(): BridgeSnapshot | null;
  /** 最近一次成功更新的 Unix 秒时间戳；从未更新为 0。 */
  lastUpdatedAt(): number;
  updateTokenMonitor(snapshot: TokenMonitorSnapshot): void;
  tokenMonitor(): TokenMonitorSnapshot;
  updateSourceHealth(source: BridgeSource, patch: Partial<SourceHealth[BridgeSource]>): void;
  sourceHealth(): SourceHealth;
}

export function createStateStore(now: () => number = () => Math.floor(Date.now() / 1000)): StateStore {
  let snapshot: BridgeSnapshot | null = null;
  let updatedAt = 0;
  let tokenMonitor: TokenMonitorSnapshot = EMPTY_TOKEN_MONITOR;
  let health: SourceHealth = structuredClone(DEFAULT_SOURCE_HEALTH);
  return {
    update(next) {
      snapshot = { ...next };
      updatedAt = now();
    },
    markDisconnected() {
      if (snapshot) snapshot = { ...snapshot, codexConnected: false };
    },
    current: () => snapshot,
    lastUpdatedAt: () => updatedAt,
    updateTokenMonitor(next) {
      tokenMonitor = next;
    },
    tokenMonitor: () => tokenMonitor,
    updateSourceHealth(source, patch) {
      health = { ...health, [source]: { ...health[source], ...patch } };
    },
    sourceHealth: () => structuredClone(health),
  };
}
