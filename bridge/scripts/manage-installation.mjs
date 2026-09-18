import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PreCompact", "PostCompact", "SubagentStart",
  "SubagentStop", "Stop",
];

const MANAGED_NAME = "codex-monitor-hook";

function toWslPath(windowsPath) {
  const abs = path.resolve(windowsPath);
  const match = abs.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return abs.replace(/\\/g, "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

export function buildHookCommand({ execPath, hookCliPath }) {
  const windowsPath = path.resolve(hookCliPath);
  return {
    type: "command",
    command: `node "${toWslPath(windowsPath)}"`,
    commandWindows: `& "${execPath}" --import tsx "${windowsPath}"`,
    timeout: 5,
    name: MANAGED_NAME,
  };
}

export function isManagedHook(hook, hookCliPath) {
  if (!hook || typeof hook !== "object") return false;
  if (hook.name === MANAGED_NAME) return true;
  const marker = hookCliPath ? path.resolve(hookCliPath).replace(/\\/g, "\\") : "hook-cli.ts";
  const command = String(hook.command ?? "");
  const commandWindows = String(hook.commandWindows ?? "");
  return command.includes("hook-cli.ts") || commandWindows.includes("hook-cli.ts") || commandWindows.includes(marker) || command.includes(marker);
}

function matcherHasManaged(group, hookCliPath) {
  const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
  return hooks.some((hook) => isManagedHook(hook, hookCliPath));
}

export function upsertManagedHooks(config, { execPath, hookCliPath }) {
  const next = structuredClone(config ?? {});
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  const desired = buildHookCommand({ execPath, hookCliPath });
  let added = 0;
  let updated = 0;
  for (const event of EVENTS) {
    const list = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const index = list.findIndex((group) => matcherHasManaged(group, hookCliPath));
    if (index >= 0) {
      const group = list[index];
      const hooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
      const hookIndex = hooks.findIndex((hook) => isManagedHook(hook, hookCliPath));
      const previous = hookIndex >= 0 ? hooks[hookIndex] : null;
      if (JSON.stringify(previous) === JSON.stringify(desired)) {
        next.hooks[event] = list;
        continue;
      }
      if (hookIndex >= 0) hooks[hookIndex] = desired;
      else hooks.push(desired);
      list[index] = { ...group, hooks };
      updated += 1;
    } else {
      list.push({ hooks: [desired] });
      added += 1;
    }
    next.hooks[event] = list;
  }
  return { config: next, added, updated };
}

export function removeManagedHooks(config, { hookCliPath }) {
  const next = structuredClone(config ?? {});
  if (!next.hooks || typeof next.hooks !== "object") return { config: next, removed: 0 };
  let removed = 0;
  for (const event of Object.keys(next.hooks)) {
    const list = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const filtered = [];
    for (const group of list) {
      if (!group || typeof group !== "object") {
        filtered.push(group);
        continue;
      }
      const hooks = Array.isArray(group.hooks) ? group.hooks.filter((hook) => {
        const managed = isManagedHook(hook, hookCliPath);
        if (managed) removed += 1;
        return !managed;
      }) : group.hooks;
      if (Array.isArray(hooks) && hooks.length === 0 && matcherHasManaged(group, hookCliPath)) continue;
      if (Array.isArray(group.hooks) && hooks.length !== group.hooks.length) {
        filtered.push({ ...group, hooks });
      } else {
        filtered.push(group);
      }
    }
    if (filtered.length === 0 && EVENTS.includes(event)) delete next.hooks[event];
    else next.hooks[event] = filtered;
  }
  return { config: next, removed };
}

export function ensureHooksFeature(tomlText) {
  const source = tomlText ?? "";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  if (!source.trim()) {
    return { text: `[features]${newline}hooks = true${newline}`, changed: true };
  }
  const lines = source.split(/\r?\n/);
  let inFeatures = false;
  let featuresIndex = -1;
  let hooksIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "[features]") {
      inFeatures = true;
      featuresIndex = i;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inFeatures = false;
      continue;
    }
    if (inFeatures && /^hooks\s*=/.test(line)) hooksIndex = i;
  }
  if (hooksIndex >= 0) {
    if (/^hooks\s*=\s*true\s*$/.test(lines[hooksIndex].trim())) {
      return { text: source, changed: false };
    }
    lines[hooksIndex] = "hooks = true";
    return { text: lines.join(newline), changed: true };
  }
  if (featuresIndex >= 0) {
    lines.splice(featuresIndex + 1, 0, "hooks = true");
    return { text: lines.join(newline), changed: true };
  }
  const prefix = source.endsWith("\n") ? source : source + newline;
  return { text: `${prefix}${newline}[features]${newline}hooks = true${newline}`, changed: true };
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

async function atomicWrite(target, content) {
  const temp = `${target}.tmp-codex-monitor`;
  await writeFile(temp, content, "utf8");
  await rename(temp, target);
}

async function backupOnce(target) {
  const backup = `${target}.codex-monitor.bak`;
  if (existsSync(target) && !existsSync(backup)) {
    await copyFile(target, backup);
  }
  return backup;
}

export function startupShortcutPath() {
  return path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Codex Monitor Bridge.lnk");
}

export async function install(options) {
  const codexHome = options.codexHome;
  const hookCliPath = options.hookCliPath;
  const execPath = options.execPath ?? process.execPath;
  const dryRun = Boolean(options.dryRun);
  const hooksPath = path.join(codexHome, "hooks.json");
  const tomlPath = path.join(codexHome, "config.toml");
  let existing = {};
  let newline = "\n";
  if (existsSync(hooksPath)) {
    const raw = await readFile(hooksPath, "utf8");
    newline = detectNewline(raw);
    existing = JSON.parse(raw);
  }
  const tomlRaw = existsSync(tomlPath) ? await readFile(tomlPath, "utf8") : "";
  const transformed = upsertManagedHooks(existing, { execPath, hookCliPath });
  const features = ensureHooksFeature(tomlRaw);
  const result = {
    added: transformed.added,
    updated: transformed.updated,
    hooksPath,
    tomlPath,
    startupPath: startupShortcutPath(),
    featuresChanged: features.changed,
    dryRun,
  };
  if (dryRun) return result;
  await mkdir(codexHome, { recursive: true });
  await backupOnce(hooksPath);
  if (existsSync(tomlPath) || features.changed) await backupOnce(tomlPath);
  const json = JSON.stringify(transformed.config, null, 2).replace(/\n/g, newline);
  await atomicWrite(hooksPath, json.endsWith(newline) ? json : json + newline);
  if (features.changed) await atomicWrite(tomlPath, features.text);
  return result;
}

export async function uninstall(options) {
  const codexHome = options.codexHome;
  const hookCliPath = options.hookCliPath;
  const dryRun = Boolean(options.dryRun);
  const hooksPath = path.join(codexHome, "hooks.json");
  if (!existsSync(hooksPath)) return { removed: 0, dryRun };
  const raw = await readFile(hooksPath, "utf8");
  const newline = detectNewline(raw);
  const transformed = removeManagedHooks(JSON.parse(raw), { hookCliPath });
  if (dryRun) return { removed: transformed.removed, dryRun };
  await backupOnce(hooksPath);
  const json = JSON.stringify(transformed.config, null, 2).replace(/\n/g, newline);
  await atomicWrite(hooksPath, json.endsWith(newline) ? json : json + newline);
  return { removed: transformed.removed, dryRun };
}

function parseCli(argv) {
  const out = { dryRun: false, install: false, uninstall: false, codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    if (argv[i] === "--install") out.install = true;
    if (argv[i] === "--uninstall") out.uninstall = true;
    if (argv[i] === "--codex-home") out.codexHome = argv[i + 1];
  }
  return out;
}

function printDryRun(result) {
  console.log(`hooks: ${result.hooksPath}`);
  console.log(`config: ${result.tomlPath}`);
  console.log(`startup: ${result.startupPath}`);
  console.log(`events to add: ${result.added}`);
  console.log(`events to update: ${result.updated}`);
  console.log(`features.hooks=true change needed: ${result.featuresChanged}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseCli(process.argv.slice(2));
  const hookCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hook-cli.ts");
  if (args.uninstall) {
    const result = await uninstall({ ...args, hookCliPath });
    if (args.dryRun) console.log(`would remove ${result.removed} managed hook entries`);
    else console.log(`removed ${result.removed} managed hook entries`);
  } else {
    const result = await install({ ...args, hookCliPath, execPath: process.execPath, dryRun: args.dryRun || !args.install });
    if (result.dryRun) printDryRun(result);
    else console.log(`installed hooks (added ${result.added}, updated ${result.updated})`);
  }
}
