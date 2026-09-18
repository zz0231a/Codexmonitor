import http from "node:http";
import { normalizeBridgeEvent, type BridgeEvent } from "./event-model.js";

export interface HookIngressOptions {
  host: string;
  port: number;
  maxBodyBytes: number;
  salt?: string;
  now?: () => number;
}

export interface RunningHookIngress {
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readLimitedBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<{ status?: number; raw?: string }> {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) return Promise.resolve({ status: 400 });
    if (length > maxBodyBytes) return Promise.resolve({ status: 413 });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { status?: number; raw?: string }) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners();
      resolve(result);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBodyBytes) {
        req.destroy();
        finish({ status: 413 });
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      finish({ raw: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => finish({ status: 400 }));
  });
}

export async function createHookIngress(
  onEvent: (event: BridgeEvent) => void,
  options: HookIngressOptions,
): Promise<RunningHookIngress> {
  if (!LOOPBACK.has(options.host)) {
    throw new Error("hook ingress must bind to loopback");
  }
  const salt = options.salt ?? "codex-monitor";
  const now = options.now ?? (() => Date.now());
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/internal/event") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if ((req.method ?? "GET") !== "POST") {
      res.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    void readLimitedBody(req, options.maxBodyBytes).then((body) => {
      if (body.status) {
        sendJson(res, body.status, { error: body.status === 413 ? "payload_too_large" : "invalid_json" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.raw ?? "");
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      try {
        onEvent(normalizeBridgeEvent(parsed, "hook", now(), salt));
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, options.host, () => resolve());
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("hook ingress failed to bind");
  return {
    url: `http://${options.host}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
