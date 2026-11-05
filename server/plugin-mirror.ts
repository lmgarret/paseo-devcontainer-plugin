/// <reference types="node" />
// Lists this machine's Paseo plugins to install in each container's daemon, so plugins with a
// daemon side also work on the container's Paseo host. The container's companion installs them
// (companion-plugins.ts); containers without it get them through `docker exec`. Only adds:
// removing a plugin here leaves containers alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DevcontainerSettings } from "../shared/contract";
import type { MirroredPlugin } from "./companion-plugins";
import { hostPaseoHome } from "./paseo-home";
import { resolveTool, run, toolEnv } from "./process";

// This plugin manages containers from the host; it must not run inside one.
const SELF_ID = "devcontainer-host";
// A GUI-launched daemon may not have the CLI on its PATH; the macOS app bundles it.
const MAC_APP_CLI = "/Applications/Paseo.app/Contents/Resources/bin/paseo";

interface ListedPlugin {
  id: string;
  enabled: boolean;
  installation?: {
    identity?: {
      kind?: string;
      registry?: { url: string; id: string };
      remote?: string;
      packageName?: string;
      pluginPath?: string;
    };
    currentRevision?: string;
  };
}


export interface HostPlugins {
  plugins: MirroredPlugin[];
  // Plugins that cannot be installed elsewhere, with the reason.
  skipped: string[];
}

// Changes when this machine's plugins do; cheap enough to poll.
export function hostPluginSignature(): string | null {
  try {
    const config = JSON.parse(readFileSync(join(hostPaseoHome(), "config.json"), "utf8")) as { plugins?: unknown };
    return JSON.stringify(config.plugins ?? {});
  } catch {
    return null;
  }
}

export async function listHostPlugins(settings: DevcontainerSettings): Promise<HostPlugins> {
  const cli = resolveTool("paseo", "") ?? resolveTool("paseo", MAC_APP_CLI);
  if (!cli) throw new Error("paseo CLI not found on this machine");
  const result = await run(cli, ["plugin", "ls", "--json"], { env: toolEnv([cli]), timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || "paseo plugin ls failed");
  const excluded = new Set(settings.mirrorExcludedPlugins);
  const plugins: MirroredPlugin[] = [];
  const skipped: string[] = [];
  for (const plugin of parseList(result.stdout)) {
    if (plugin.id === SELF_ID || !plugin.enabled || excluded.has(plugin.id)) continue;
    const args = addArgs(plugin);
    if (args) plugins.push({ id: plugin.id, args });
    else skipped.push(`${plugin.id} (installed from a folder on this machine)`);
  }
  return { plugins, skipped };
}

// Installed plugin IDs, parsed from the container's `paseo plugin ls --json`.
export function installedIds(stdout: string): Set<string> {
  return new Set(parseList(stdout).map((plugin) => plugin.id));
}

function parseList(stdout: string): ListedPlugin[] {
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? (parsed as ListedPlugin[]).filter((entry) => typeof entry?.id === "string") : [];
}

// Registry installs pin the registry's reviewed revision and refuse --ref; other sources pin the host's.
function addArgs(plugin: ListedPlugin): string[] | null {
  const identity = plugin.installation?.identity;
  const revision = plugin.installation?.currentRevision;
  if (!identity || identity.kind === "directory") return null;
  const suffix = identity.pluginPath && identity.pluginPath !== "." ? `:${identity.pluginPath}` : "";
  const args = ["--id", plugin.id];
  if (identity.registry) return [`${new URL(identity.registry.url).host}/${identity.registry.id}`, ...args];
  if (identity.kind === "npm" && identity.packageName) {
    return [`npm:${identity.packageName}${revision ? `@${revision}` : ""}${suffix}`, ...args];
  }
  if (identity.kind === "git" && identity.remote) {
    return [`git:${identity.remote}${suffix}`, ...args, ...(revision ? ["--ref", revision] : [])];
  }
  return null;
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}
