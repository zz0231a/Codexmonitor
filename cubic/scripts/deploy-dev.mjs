// 开发期快速部署：把 package/ 直传到设备 /sd/apps/<app-id>/，跳过打包 tar + 控制台安装。
// 用法：
//   node scripts/deploy-dev.mjs                      # 传改动文件并重启应用
//   node scripts/deploy-dev.mjs --dry-run            # 只打印将要做的事
//   node scripts/deploy-dev.mjs --force              # 全部重传（默认按文件大小跳过未改动文件）
//   node scripts/deploy-dev.mjs --no-restart         # 只传文件，不重启应用
//   node scripts/deploy-dev.mjs --device 192.168.1.x --app codex_monitor
//
// 依赖固件控制台接口（见 docs/holocubic-app-dev.md）：
//   GET  /api/system/fs/list?path=...
//   POST /api/system/fs/mkdir?path=...
//   PUT  /api/system/fs/upload?path=...
//   POST /api/system/exit
//   POST /api/system/launch?id=...

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = path.join(ROOT, "package");

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DEVICE = argValue("device", "10.23.2.209");
const APP_ID = argValue("app", "codex_monitor");
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const NO_RESTART = args.includes("--no-restart");
const BASE = `http://${DEVICE}`;
const REMOTE_DIR = `/sd/apps/${APP_ID}`;
const TIMEOUT_MS = 15000;

async function api(url, options = {}) {
  const res = await fetch(BASE + url, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok || (body && body.ok === false)) {
    const msg = body && body.error ? body.error : `HTTP ${res.status}`;
    throw new Error(`${options.method || "GET"} ${url} 失败：${msg}`);
  }
  return body;
}

async function walkLocal(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkLocal(full, base));
    else files.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return files;
}

async function listRemote(dir) {
  try {
    const body = await api(`/api/system/fs/list?path=${encodeURIComponent(dir)}`);
    return body.entries || [];
  } catch {
    return null;
  }
}

async function collectRemote(dir) {
  const map = new Map();
  const entries = await listRemote(dir);
  if (!entries) return map;
  for (const entry of entries) {
    if (entry.is_dir) {
      const sub = await collectRemote(entry.path);
      for (const [k, v] of sub) map.set(k, v);
    } else {
      map.set(entry.path, entry.size);
    }
  }
  return map;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`设备：${BASE}  应用：${APP_ID}  目录：${REMOTE_DIR}`);
  if (DRY_RUN) console.log("（dry-run，只打印不执行）");

  const localFiles = await walkLocal(PACKAGE_DIR);
  console.log(`本地 package/ 共 ${localFiles.length} 个文件`);

  const remote = await collectRemote(REMOTE_DIR);
  if (remote.size === 0) console.log(`警告：设备上未读到 ${REMOTE_DIR}，将按全新安装处理`);

  const dirs = new Set(localFiles.map((f) => path.posix.dirname(`${REMOTE_DIR}/${f.rel}`)));
  const toUpload = [];
  let skipped = 0;
  for (const file of localFiles) {
    const remotePath = `${REMOTE_DIR}/${file.rel}`;
    const data = await readFile(file.full);
    if (!FORCE && remote.get(remotePath) === data.length) {
      skipped += 1;
      continue;
    }
    toUpload.push({ ...file, data, remotePath });
  }
  console.log(`需上传 ${toUpload.length} 个，跳过未改动 ${skipped} 个`);

  if (DRY_RUN) {
    for (const f of toUpload) console.log(`  将上传 ${f.rel}（${f.data.length} B）`);
    if (!NO_RESTART) console.log("  将重启应用（exit → launch）");
    return;
  }

  for (const dir of [...dirs].sort()) {
    await api(`/api/system/fs/mkdir?path=${encodeURIComponent(dir)}`, { method: "POST" }).catch(() => {});
  }

  for (const file of toUpload) {
    await api(`/api/system/fs/upload?path=${encodeURIComponent(file.remotePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file.data,
    });
    console.log(`  已上传 ${file.rel}（${file.data.length} B）`);
  }

  if (!NO_RESTART) {
    await api("/api/system/exit", { method: "POST" }).catch(() => {});
    await sleep(800);
    await api(`/api/system/launch?id=${encodeURIComponent(APP_ID)}`, { method: "POST" });
    console.log("已重启应用");
  }
  console.log("部署完成");
}

main().catch((err) => {
  console.error(`部署失败：${err.message}`);
  process.exit(1);
});
