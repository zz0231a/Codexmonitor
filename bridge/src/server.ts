import http from "node:http";
import type { StateStore } from "./state-store.js";
import type { BridgeSnapshot } from "./model.js";

export interface ServerConfig {
  host?: string;
  port?: number;
  /** 允许访问的设备地址；为空数组或不提供表示不限制。 */
  allow?: string[];
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/**
 * 设备端公开的 JSON 信封。
 * 顶层字段用 snake_case（设计文档约定），嵌套对象保持模型 camelCase。
 * 只包含已通过 normalizer 脱敏的字段。
 */
export function buildPublicSnapshot(snapshot: BridgeSnapshot | null, lastUpdatedAt: number) {
  return {
    schemaVersion: 1 as const,
    server_time: Math.floor(Date.now() / 1000),
    last_updated_at: lastUpdatedAt,
    codex_connected: snapshot ? snapshot.codexConnected : false,
    status: snapshot ? snapshot.status : "offline",
    primary_task: snapshot ? snapshot.primaryTask : null,
    activities: snapshot ? snapshot.activities : [],
    usage: { windows: snapshot ? snapshot.usage : [] },
    other_active_task_count: snapshot ? snapshot.otherActiveTaskCount : 0,
  };
}

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function corsHeaders(origin: string | undefined, allow: string[]): Record<string, string> {
  if (!origin) return {};
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && allow.includes(parsed.hostname)) {
      return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    }
  } catch {}
  return {};
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/**
 * 创建只读状态服务器。
 * 只提供 GET /api/v1/status 与 GET /api/v1/health；
 * 其余路径 404，非 GET 方法 405，白名单外客户端 403；
 * status 即使数据过期也保持 200。
 */
export async function createStatusServer(store: StateStore, config: ServerConfig): Promise<RunningServer> {
  const host = config.host ?? "127.0.0.1";
  const allow = config.allow ?? [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if ((req.method ?? "GET") !== "GET") {
      res.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (allow.length > 0 && !allow.includes(normalizeRemoteAddress(req.socket.remoteAddress))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const responseHeaders = corsHeaders(req.headers.origin, allow);
    if (path === "/api/v1/status") {
      sendJson(res, 200, buildPublicSnapshot(store.current(), store.lastUpdatedAt()), responseHeaders);
      return;
    }
    if (path === "/api/v1/health") {
      const snapshot = store.current();
      const connected = snapshot?.codexConnected ?? false;
      const sources = store.sourceHealth();
      const sourceAvailable = sources.hook.connected || sources.jsonl.available || connected;
      sendJson(res, sourceAvailable ? 200 : 503, {
        bridge: "up",
        codex_connected: connected,
        last_updated_at: store.lastUpdatedAt(),
        sources: {
          hook: { connected: sources.hook.connected, last_event_at: sources.hook.lastEventAt },
          jsonl: {
            available: sources.jsonl.available,
            file_found: sources.jsonl.fileFound,
            last_record_at: sources.jsonl.lastRecordAt,
          },
        },
      }, responseHeaders);
      return;
    }
    sendJson(res, 404, { error: "not_found" }, responseHeaders);
  });
  await new Promise<void>((resolve) => server.listen(config.port ?? 0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge server failed to bind");
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
