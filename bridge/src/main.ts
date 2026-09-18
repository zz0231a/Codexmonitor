import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHookIngress, type RunningHookIngress } from "./hook-ingress.js";
import { createJsonlMonitor, type JsonlMonitor } from "./jsonl-monitor.js";
import { normalizeCodexSnapshot } from "./normalizer.js";
import { createStatusServer, type RunningServer, type ServerConfig } from "./server.js";
import { createSourceArbiter } from "./source-arbiter.js";
import { createStateStore, type StateStore } from "./state-store.js";

export interface BridgeConfig extends ServerConfig {
  /** app-server 快照轮询间隔（毫秒），仅 fixture 模式使用。 */
  pollIntervalMs?: number;
  hookHost?: string;
  hookPort?: number;
  jsonlPollIntervalMs?: number;
  privacySalt?: string;
  sessionsRoot?: string;
}

const DEFAULT_CONFIG: BridgeConfig = {
  host: "127.0.0.1",
  port: 8973,
  allow: [],
  pollIntervalMs: 5000,
  hookHost: "127.0.0.1",
  hookPort: 8974,
  jsonlPollIntervalMs: 1200,
  privacySalt: "codex-monitor",
};

export interface RunningBridge {
  store: StateStore;
  status: RunningServer;
  hook?: RunningHookIngress;
  jsonl?: JsonlMonitor;
  url: string;
  hookUrl?: string;
  pollJsonl(): Promise<void>;
  close(): Promise<void>;
}

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

function defaultSessionsRoot(config: BridgeConfig): string {
  if (config.sessionsRoot) return config.sessionsRoot;
  const home = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  return path.join(home, "sessions");
}

export async function startBridge(options: {
  config?: BridgeConfig;
  fixture?: string;
  now?: () => number;
}): Promise<RunningBridge> {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const store = createStateStore(options.now ? () => Math.floor(options.now!() / 1000) : undefined);
  const server = await createStatusServer(store, config);
  const timers: NodeJS.Timeout[] = [];
  let hook: RunningHookIngress | undefined;
  let jsonl: JsonlMonitor | undefined;
  const salt = config.privacySalt ?? "codex-monitor";
  const now = options.now ?? (() => Date.now());
  const arbiter = createSourceArbiter(store, { now });

  if (options.fixture) {
    const push = async () => {
      try {
        const raw = JSON.parse(await readFile(options.fixture as string, "utf8"));
        store.update(normalizeCodexSnapshot(raw));
      } catch (err) {
        console.error(`[bridge] failed to read fixture: ${(err as Error).message}`);
        store.markDisconnected();
      }
    };
    await push();
    const timer = setInterval(() => { void push(); }, config.pollIntervalMs ?? 5000);
    timer.unref();
    timers.push(timer);
  } else {
    hook = await createHookIngress((event) => { arbiter.accept(event); }, {
      host: config.hookHost ?? "127.0.0.1",
      port: config.hookPort ?? 8974,
      maxBodyBytes: 64 * 1024,
      salt,
      now,
    });
    jsonl = createJsonlMonitor({
      sessionsRoot: defaultSessionsRoot(config),
      salt,
      now,
    });
    const pollJsonl = async () => {
      try {
        const events = await jsonl!.poll();
        for (const event of events) arbiter.accept(event);
        const file = jsonl!.currentFile();
        store.updateSourceHealth("jsonl", {
          available: Boolean(file),
          fileFound: Boolean(file),
          lastRecordAt: store.sourceHealth().jsonl.lastRecordAt,
        });
      } catch {
        store.updateSourceHealth("jsonl", { available: false, fileFound: false });
      }
    };
    await pollJsonl();
    const timer = setInterval(() => { void pollJsonl(); }, config.jsonlPollIntervalMs ?? 1200);
    timer.unref();
    timers.push(timer);
  }

  return {
    store,
    status: server,
    hook,
    jsonl,
    url: server.url,
    hookUrl: hook?.url,
    async pollJsonl() {
      if (!jsonl) return;
      const events = await jsonl.poll();
      for (const event of events) arbiter.accept(event);
      const file = jsonl.currentFile();
      store.updateSourceHealth("jsonl", {
        available: Boolean(file),
        fileFound: Boolean(file),
        lastRecordAt: store.sourceHealth().jsonl.lastRecordAt,
      });
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      jsonl?.close();
      await hook?.close();
      await server.close();
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<RunningBridge> {
  const args = parseArgs(argv);
  const config = await loadConfig(args.config ?? path.join(process.cwd(), "config.json"));
  const bridge = await startBridge({ config, fixture: args.fixture });
  console.log(`[bridge] status API listening at ${bridge.url}/api/v1/status`);
  if (bridge.hookUrl) console.log(`[bridge] hook ingress listening at ${bridge.hookUrl}/internal/event`);
  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return bridge;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[bridge] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
