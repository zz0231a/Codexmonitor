import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, uninstall, upsertManagedHooks, removeManagedHooks } from "../scripts/manage-installation.mjs";

const hookCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hook-cli.ts");

async function readHooks(home) {
  return JSON.parse(await readFile(path.join(home, "hooks.json"), "utf8"));
}

test("install is idempotent and preserves unrelated hooks", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-hooks-"));
  const initial = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  await writeFile(path.join(home, "hooks.json"), JSON.stringify(initial));
  const first = await install({ codexHome: home, dryRun: false, platform: "win32", hookCliPath, execPath: process.execPath });
  const second = await install({ codexHome: home, dryRun: false, platform: "win32", hookCliPath, execPath: process.execPath });
  assert.ok(first.added > 0);
  assert.equal(second.added, 0);
  assert.ok(JSON.stringify(await readHooks(home)).includes("other-tool"));
});

test("uninstall removes only codex-monitor-hook entries", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-hooks-un-"));
  await writeFile(path.join(home, "hooks.json"), JSON.stringify({
    other: true,
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }],
    },
  }));
  await writeFile(path.join(home, "config.toml"), "[other]\nvalue = 1\n[features]\nhooks = false\n");
  await install({ codexHome: home, dryRun: false, hookCliPath, execPath: process.execPath });
  const afterInstall = await readHooks(home);
  assert.ok(JSON.stringify(afterInstall).includes("codex-monitor-hook"));
  const result = await uninstall({ codexHome: home, dryRun: false, hookCliPath });
  assert.ok(result.removed > 0);
  const after = await readFile(path.join(home, "hooks.json"), "utf8");
  assert.equal(after.includes("codex-monitor-hook"), false);
  assert.ok(after.includes("other-tool"));
  const toml = await readFile(path.join(home, "config.toml"), "utf8");
  assert.ok(toml.includes("[other]"));
  assert.ok(toml.includes("value = 1"));
});

test("dry-run does not write files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-hooks-dry-"));
  await writeFile(path.join(home, "hooks.json"), JSON.stringify({ hooks: {} }));
  const result = await install({ codexHome: home, dryRun: true, hookCliPath, execPath: process.execPath });
  assert.equal(result.dryRun, true);
  assert.equal(JSON.stringify(await readHooks(home)), JSON.stringify({ hooks: {} }));
});

test("upsert and remove keep unrelated matcher groups intact", () => {
  const initial = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  const upserted = upsertManagedHooks(initial, { execPath: "node", hookCliPath });
  assert.equal(upserted.config.hooks.Stop[0].hooks[0].command, "other-tool");
  const removed = removeManagedHooks(upserted.config, { hookCliPath });
  assert.equal(removed.config.hooks.Stop[0].hooks[0].command, "other-tool");
  assert.equal(JSON.stringify(removed.config.hooks.Stop[0].hooks).includes("codex-monitor-hook"), false);
});
