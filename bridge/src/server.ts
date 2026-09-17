import http from "node:http";
import type { StateStore } from "./state-store.js";

export interface ServerConfig {
  host?: string;
  port?: number;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** 设备端公开的 JSON 信封（snake_case），只含已脱敏字段。 */
function buildPublicSnapshot(store: StateStore) {
  const snapshot = store.current();
  return {
    schemaVersion: 1,
    server_time: Math.floor(Date.now() / 1000),
    last_updated_at: store.lastUpdatedAt(),
    codex_connected: snapshot ? snapshot.codexConnected : false,
    status: snapshot ? snapshot.status : "offline",
    primary_task: snapshot ? snapshot.primaryTask : null,
    activities: snapshot ? snapshot.activities : [],
    usage: {
      windows: snapshot
        ? snapshot.usage.map((w) => ({
            remaining_percent: w.remainingPercent,
            window_duration_mins: w.windowDurationMins,
            resets_at: w.resetsAt,
          }))
        : [],
    },
    other_active_task_count: snapshot ? snapshot.otherActiveTaskCount : 0,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

/**
 * 创建只读状态服务器。
 * 只提供 GET /api/v1/status 与 GET /api/v1/health；
 * 其余路径 404，非 GET 方法 405；status 即使数据过期也保持 200。
 */
export async function createStatusServer(store: StateStore, config: ServerConfig): Promise<RunningServer> {
  const host = config.host ?? "127.0.0.1";
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if ((req.method ?? "GET") !== "GET") {
      res.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (path === "/api/v1/status") {
      sendJson(res, 200, buildPublicSnapshot(store));
      return;
    }
    if (path === "/api/v1/health") {
      const connected = store.current()?.codexConnected ?? false;
      sendJson(res, connected ? 200 : 503, {
        bridge: "up",
        codex_connected: connected,
        last_updated_at: store.lastUpdatedAt(),
      });
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(config.port ?? 0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge server failed to bind");
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
