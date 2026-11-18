/// <reference types="node" />
// This machine's side of the companion plugin (see companion.ts): copies it into a container's
// Paseo home, registers it with that daemon, and writes the data its modules act on.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DevcontainerSettings, Guard } from "../shared/contract";
import { COMPANION_DATA, type MirroredPlugin, PLUGINS_FILE, type PluginList } from "./companion-plugins";
import type { DockerContainer } from "./discovery";
import { homeOwner, homesRoot, readConfig, writeConfig } from "./paseo-home";
import { pluginDir } from "./plugin-dir";

export const COMPANION_ID = "devcontainer-companion";
// The companion's ID when it only ran the worktree guard; moved to COMPANION_ID while the daemon is stopped.
const LEGACY_COMPANION_ID = "devcontainer-guard";

type Log = (line: string) => void;

// The container's Paseo home when this plugin manages it for the repository: the companion
// and its data go there.
export function managedHome(settings: DevcontainerSettings, repoPath: string, container: DockerContainer | null): string | null {
  if (!settings.persistPaseoHome) return null;
  const home = container?.paseoHome.home;
  if (!home) return null;
  try {
    // Homes of another plugin instance or an earlier homes folder are left alone.
    if (dirname(home) !== realpathSync(homesRoot(settings))) return null;
    return homeOwner(home) === repoPath ? home : null;
  } catch {
    return null;
  }
}

// Whether any companion module has work to do.
export function wantsCompanion(settings: DevcontainerSettings): boolean {
  return settings.guardWorktrees || settings.mirrorHostPlugins || settings.workspaceBadges;
}

function companionDir(home: string, id = COMPANION_ID): string {
  return join(home, "plugins", id);
}

function companionFiles(source: string): Record<string, string> {
  const read = (path: string) => readFileSync(join(source, path), "utf8");
  return {
    "paseo-plugin.json": `${JSON.stringify(
      {
        id: COMPANION_ID,
        name: "Dev container companion",
        description:
          "Restores git worktree records that an archive in this container deletes for the host's worktrees, installs the host's plugins, and shows the container's status on its workspaces.",
        requirements: { paseo: ">=0.15.0" },
      },
      null,
      2,
    )}\n`,
    "index.server.ts": 'export { default } from "./server/companion";\n',
    "index.client.tsx": 'export { default } from "./client/companion";\n',
    "client/companion.tsx": read("client/companion.tsx"),
    "server/companion.ts": read("server/companion.ts"),
    "server/companion-guard.ts": read("server/companion-guard.ts"),
    "server/companion-plugins.ts": read("server/companion-plugins.ts"),
    "server/worktree-guard.ts": read("server/worktree-guard.ts"),
  };
}

// The legacy companion still runs the guard until its daemon restarts.
export function companionState(home: string): Guard["companion"] {
  const plugins = readConfig(home)?.plugins ?? {};
  const id = plugins[COMPANION_ID] ? COMPANION_ID : LEGACY_COMPANION_ID;
  const entry = plugins[id];
  if (!existsSync(join(companionDir(home, id), "index.server.ts"))) return "off";
  if (!entry) return "pending";
  return entry.enabled === false ? "off" : "installed";
}

// The current companion is registered and enabled, so it mirrors plugins once its daemon runs.
export function companionMirrors(home: string): boolean {
  const config = readConfig(home);
  const entry = config?.plugins?.[COMPANION_ID];
  return config?.pluginsEnabled === true && entry?.path === companionDir(home) && entry.enabled !== false;
}

export interface CompanionInstall {
  // Files differ from what the daemon last loaded.
  changed: boolean;
  // Registered in the daemon's config; false when the daemon runs and could not be told.
  registered: boolean;
}

// Copies the companion into the container's Paseo home, which the container sees at the same
// path, and registers it in that daemon's config. The config is only edited while the daemon is
// stopped, since a running daemon owns it. A copy that the user disabled stays disabled,
// including under its legacy ID.
export function installCompanion(home: string, daemonRunning: boolean, log: Log): CompanionInstall | null {
  const source = pluginDir();
  if (!source) {
    log("Companion: could not find this plugin's folder; the container's companion plugin is not installed.");
    return null;
  }
  const dir = companionDir(home);
  let changed = false;
  for (const [path, content] of Object.entries(companionFiles(source))) {
    const file = join(dir, path);
    if (readText(file) === content) continue;
    writeAtomic(file, content);
    changed = true;
  }
  const config = readConfig(home) ?? { version: 1 };
  const plugins = { ...config.plugins };
  const legacy = plugins[LEGACY_COMPANION_ID];
  const entry = plugins[COMPANION_ID];
  if (!legacy && entry && entry.path === dir && config.pluginsEnabled === true) return { changed, registered: true };
  if (!legacy && entry?.enabled === false) return { changed, registered: true };
  if (daemonRunning) return { changed, registered: false };
  const enabled = entry ? entry.enabled !== false : legacy ? legacy.enabled !== false : true;
  delete plugins[LEGACY_COMPANION_ID];
  config.pluginsEnabled = true;
  config.plugins = { ...plugins, [COMPANION_ID]: { source: "directory", path: dir, enabled } };
  writeConfig(home, config);
  if (legacy) {
    rmSync(companionDir(home, LEGACY_COMPANION_ID), { recursive: true, force: true });
    log(`Companion: replaced the ${LEGACY_COMPANION_ID} plugin with ${COMPANION_ID} in the container's Paseo daemon.`);
  } else {
    log(`Companion: installed the ${COMPANION_ID} plugin in the container's Paseo daemon.`);
  }
  return { changed, registered: true };
}

// The plugins the companion installs; null removes the list, so it installs nothing.
export function writePluginList(home: string, plugins: MirroredPlugin[] | null): void {
  const file = join(home, COMPANION_DATA, PLUGINS_FILE);
  if (plugins === null) {
    rmSync(file, { force: true });
    return;
  }
  const list: PluginList = { plugins };
  const content = `${JSON.stringify(list, null, 2)}\n`;
  if (readText(file) !== content) writeAtomic(file, content);
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Same directory, so the rename stays on one filesystem.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}
