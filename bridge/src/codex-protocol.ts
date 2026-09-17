import type { BridgeStatus } from "./model.js";

/**
 * Codex app-server 协议边界。
 *
 * 本文件是桥接程序中唯一理解 app-server 原始协议的地方：
 * 协议字段名、状态枚举和时间戳解析都集中在这里。
 * Codex 升级导致协议变化时，只需要修改本文件。
 */

/** 协议任务状态 → 设备端稳定状态 */
const PROTOCOL_STATUS_TO_BRIDGE: Record<string, BridgeStatus> = {
  running: "working",
  awaiting_user: "needs_user",
  awaiting_input: "needs_user",
  needs_user: "needs_user",
  working: "working",
  completed: "done",
  done: "done",
  failed: "error",
  error: "error",
  idle: "idle",
};

export function parseProtocolStatus(raw: unknown): BridgeStatus {
  if (typeof raw !== "string") return "idle";
  return PROTOCOL_STATUS_TO_BRIDGE[raw] ?? "idle";
}

/** 协议时间戳支持秒或毫秒；无法识别时返回 0。 */
export function parseProtocolTimestamp(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return raw < 1e12 ? raw : Math.floor(raw / 1000);
}

/**
 * 连接本机共享 app-server 并产出结构化事件流。
 * 真实传输在 Task 4 接线；此处固定为协议边界的消费者契约。
 */
export async function* connectCodex(): AsyncIterable<unknown> {
  throw new Error("app-server transport is wired in the executable entry point (Task 4)");
}
