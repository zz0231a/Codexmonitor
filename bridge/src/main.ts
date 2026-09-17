import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeCodexSnapshot } from "./normalizer.js";
import { createStateStore } from "./state-store.js";
import { createStatusServer, type ServerConfig } from "./server.js";

export interface BridgeConfig extends ServerConfig {
  /** app-server 快照轮询间隔（毫秒），仅 fixture 模式使用。 */
  pollIntervalMs?: number;
}

const DEFAULT_CONFIG: BridgeConfig = {
  host: "127.0.0.1",
  port: 8973,
  allow: [],
  pollIntervalMs: 5000,
};

async function loadConfig(configPath: string): Promise<BridgeConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<BridgeConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function parseArgs(argv: string[]): { config?: string; fixture?: string } {
  const out: { config?: string; fixture?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config") out.config = argv[i + 1];
    if (argv[i] === "--fixture") out.fixture = argv[i + 1];
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const config = await loadConfig(args.config ?? path.join(process.cwd(), "config.json"));
  const store = createStateStore();
  const server = await createStatusServer(store, config);
  console.log(`[bridge] status API listening at ${server.url}/api/v1/status`);

  let stopPolling = false;
  if (args.fixture) {
    const push = async () => {
      try {
        const raw = JSON.parse(await readFile(args.fixture as string, "utf8"));
        store.update(normalizeCodexSnapshot(raw));
      } catch (err) {
        console.error(`[bridge] failed to read fixture: ${(err as Error).message}`);
        store.markDisconnected();
      }
    };
    await push();
    const timer = setInterval(() => { if (!stopPolling) void push(); }, config.pollIntervalMs ?? 5000);
    timer.unref();
  } else {
    // 实时 app-server 传输：协议边界在 codex-protocol.connectCodex()，
    // 接入真实 Codex Desktop 后在此替换 fixture 轮询循环。
    console.warn("[bridge] live app-server transport not wired yet; serving offline state");
    store.markDisconnected();
  }

  const shutdown = async () => {
    stopPolling = true;
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[bridge] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
