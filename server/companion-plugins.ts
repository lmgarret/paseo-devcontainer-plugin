/// <reference types="node" />
// The companion's plugin mirror: installs in the container's daemon the plugins the host plugin
// lists in the shared Paseo home. It runs whenever the daemon does, so a daemon started outside
// the host plugin, from VS Code or a shell, still gets them. Only adds plugins.
//
// Node built-ins only: this file is copied into the container's companion plugin, which has no
// node_modules. The host plugin imports its constants and types to write the list.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Under the container's Paseo home, which both sides see at the same path.
export const COMPANION_DATA = "devcontainer-companion";
export const PLUGINS_FILE = "plugins.json";

export interface MirroredPlugin {
  id: string;
  // `paseo plugin add` arguments that install the plugin from the host's source and revision.
  args: string[];
}

export interface PluginList {
  plugins: MirroredPlugin[];
}

const TAG = "[devcontainer-companion]";
const POLL_MS = 10_000;
const LIST_TIMEOUT_MS = 30_000;
const ADD_TIMEOUT_MS = 10 * 60_000;

function listFile(): string | null {
  try {
    const home = realpathSync(process.env.PASEO_HOME || join(homedir(), ".paseo"));
    return join(home, COMPANION_DATA, PLUGINS_FILE);
  } catch {
    return null;
  }
}

function readList(text: string): MirroredPlugin[] {
  const parsed = JSON.parse(text) as Partial<PluginList>;
  return (parsed.plugins ?? []).filter(
    (entry) => typeof entry?.id === "string" && Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string"),
  );
}

function paseo(args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile("paseo", args, { env: process.env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const lastLine = String(stderr).trim().split("\n").pop()?.trim();
      resolve({ ok: !error, stdout: String(stdout), error: error ? lastLine || error.message : "" });
    });
  });
}

// Polls the list; each new version is applied once. Listing the daemon's plugins fails until the
// daemon serves requests, so that is retried on the next poll.
export function startPluginMirror(): () => void {
  let applied: string | null = null;
  let busy = false;
  let lastError = "";
  const tick = async () => {
    const file = listFile();
    if (!file || busy) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (text === applied) return;
    busy = true;
    try {
      const wanted = readList(text);
      const listed = await paseo(["plugin", "ls", "--json"], LIST_TIMEOUT_MS);
      if (!listed.ok) {
        if (listed.error !== lastError) console.error(`${TAG} could not list plugins: ${listed.error}`);
        lastError = listed.error;
        return;
      }
      lastError = "";
      const installed = new Set((JSON.parse(listed.stdout) as { id?: unknown }[]).map((entry) => entry?.id));
      for (const plugin of wanted.filter((entry) => !installed.has(entry.id))) {
        console.log(`${TAG} installing plugin ${plugin.id}`);
        const added = await paseo(["plugin", "add", ...plugin.args], ADD_TIMEOUT_MS);
        console.log(`${TAG} ${added.ok ? `installed plugin ${plugin.id}` : `could not install plugin ${plugin.id}: ${added.error}`}`);
      }
      // Failed installs are retried when the list changes or the daemon restarts, not every poll.
      applied = text;
    } catch (error) {
      console.error(`${TAG} plugin mirror failed: ${error instanceof Error ? error.message : String(error)}`);
      applied = text;
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => clearInterval(timer);
}
