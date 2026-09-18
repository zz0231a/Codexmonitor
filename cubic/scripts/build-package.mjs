import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = path.join(ROOT, "package");
const DIST_DIR = path.join(ROOT, "dist");
const ZIP_PATH = path.join(DIST_DIR, "codex_monitor.zip");
const REQUIRED = ["app.info", "main.lua", "main.html", "info.html", "main.png", "assets"];
const TEXT_EXT = new Set([".html", ".lua", ".info", ".json", ".js", ".css", ".txt", ".md"]);
const SECRET = /sk-|api_key|token=/i;
const WINDOWS_ABS = /[A-Za-z]:\\/;

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else files.push({ full, rel });
  }
  return files;
}

function rejectSecretsAndPaths(rel, text) {
  if (WINDOWS_ABS.test(text)) throw new Error(`${rel} contains a Windows absolute path`);
  if (SECRET.test(text)) throw new Error(`${rel} contains a secret-like string`);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = entry.data;
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04"),
      u16(20), u16(0x0800), u16(8), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(raw.length),
      u16(name.length), u16(0),
      name, compressed,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\x01\x02"),
      u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from("PK\x05\x06"),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(localBuf.length), u16(0),
  ]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function archive(files) {
  await rm(ZIP_PATH, { force: true });
  const psFiles = files.map((file) => `'${file.full.replace(/'/g, "''")}'`).join(",");
  if (await run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path ${psFiles} -DestinationPath '${ZIP_PATH.replace(/'/g, "''")}' -Force`], PACKAGE_DIR)) {
    return "Compress-Archive";
  }
  const zipLiteral = ZIP_PATH.replace(/'/g, "''");
  const dirLiteral = PACKAGE_DIR.replace(/'/g, "''");
  if (await run("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath '${zipLiteral}') { Remove-Item -LiteralPath '${zipLiteral}' -Force }; [System.IO.Compression.ZipFile]::CreateFromDirectory('${dirLiteral}', '${zipLiteral}')`], ROOT)) {
    return "ZipFile";
  }
  const names = files.map((file) => file.rel.replace(/\\/g, "/"));
  if (await run("tar", ["-a", "-cf", ZIP_PATH, "-C", PACKAGE_DIR, ...names], ROOT)) {
    return "tar";
  }
  const entries = [];
  for (const file of files) {
    entries.push({ name: file.rel.replace(/\\/g, "/"), data: await readFile(file.full) });
  }
  await writeFile(ZIP_PATH, createZip(entries));
  return "node-zip";
}

const files = await walk(PACKAGE_DIR);
for (const file of files) {
  if (file.rel.includes("..")) throw new Error(`refusing path outside package: ${file.rel}`);
  const ext = path.extname(file.rel).toLowerCase();
  if (TEXT_EXT.has(ext) || file.rel === "app.info") {
    rejectSecretsAndPaths(file.rel, await readFile(file.full, "utf8"));
  }
}
for (const required of REQUIRED) {
  await stat(path.join(PACKAGE_DIR, required));
}

await mkdir(DIST_DIR, { recursive: true });
const method = await archive(files);
const zip = await stat(ZIP_PATH);
console.log(`wrote ${ZIP_PATH} (${files.length} files, ${zip.size} bytes, via ${method})`);
