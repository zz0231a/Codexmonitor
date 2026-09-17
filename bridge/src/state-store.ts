import type { BridgeSnapshot } from "./model.js";

export interface StateStore {
  /** 写入一次新的归一化快照并刷新最后更新时间。 */
  update(snapshot: BridgeSnapshot): void;
  /** Codex 断连时保留最后数据，仅标记 codexConnected=false。 */
  markDisconnected(): void;
  current(): BridgeSnapshot | null;
  /** 最近一次成功更新的 Unix 秒时间戳；从未更新为 0。 */
  lastUpdatedAt(): number;
}

export function createStateStore(now: () => number = () => Math.floor(Date.now() / 1000)): StateStore {
  let snapshot: BridgeSnapshot | null = null;
  let updatedAt = 0;
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
  };
}
