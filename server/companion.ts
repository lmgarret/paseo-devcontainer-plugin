/// <reference types="node" />
// The companion plugin, run by the Paseo daemon inside a dev container. The host plugin copies
// this file and worktree-guard.ts into the container's Paseo home as the
// `devcontainer-guard` plugin; the host plugin itself never loads it.
//
// The host plugin's hooks only fire for the host's own archives. This one repairs after an
// archive in the container: it puts back records the prune there deleted for worktrees the
// container can reach, and leaves the rest for the host, which reads the status file it writes.
//
// Type imports and Node built-ins only: the copy has no node_modules.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classify,
  errorText,
  GUARD_DIR,
  type GuardConfig,
  localOps,
  localView,
  missingRecords,
  probeRequest,
  readGuardConfig,
  restore,
  settleArchive,
  sleep,
  snapshot,
  writeContainerStatus,
} from "./worktree-guard";

const TAG = "[devcontainer-guard]";
// A second pass catches a prune that ran after the first one.
const FOLLOW_UP_MS = 15_000;

// The home the host plugin linked ~/.paseo to.
function guardConfig(): GuardConfig | null {
  try {
    const home = realpathSync(process.env.PASEO_HOME || join(homedir(), ".paseo"));
    return readGuardConfig(join(home, GUARD_DIR));
  } catch {
    return null;
  }
}

function inspect(config: GuardConfig) {
  return classify(config, "container", { container: localView(probeRequest(config, "container")) });
}

// Snapshots only: records of worktrees made here reach the snapshot before any prune.
function refresh(): void {
  const config = guardConfig();
  if (!config) return;
  snapshot(config, "container", inspect(config));
}

async function afterArchive(archived: string): Promise<void> {
  const config = guardConfig();
  if (!config) {
    console.log(`${TAG} no guard config; nothing to check`);
    return;
  }
  if (archived !== config.containerRepo) await settleArchive(archived);
  await repair(config, archived);
  await sleep(FOLLOW_UP_MS);
  await repair(config, archived);
}

async function repair(config: GuardConfig, archived: string): Promise<void> {
  const exclude = new Set([archived]);
  let report = inspect(config);
  const restored = await restore(config, "container", report, { container: localOps() }, { exclude });
  if (restored.length > 0) report = inspect(config);
  snapshot(config, "container", report);
  // Records still missing whose folders the container cannot see: the host checks those.
  const pending = missingRecords(config, "container");
  writeContainerStatus(config, { updatedAt: Date.now(), trigger: "archive", archived, restored, pending });
  for (const result of restored) {
    console.log(`${TAG} ${result.error ? `could not restore ${result.folder}: ${result.error}` : `restored ${result.folder}`}`);
  }
  if (pending.length > 0) console.log(`${TAG} left for the host: ${pending.join(", ")}`);
}

export default function contribute(server: PluginServerContext) {
  const safely = (work: () => unknown) => async () => {
    try {
      await work();
    } catch (error) {
      console.error(`${TAG} ${errorText(error)}`);
    }
  };
  void safely(refresh)();
  const unsubscribe = [
    server.addHook("workspace.archive.after", ({ workspace }) => safely(() => afterArchive(workspace.cwd))()),
    server.addHook("workspace.create.after", () => safely(refresh)()),
  ];
  return () => {
    for (const stop of unsubscribe) stop();
  };
}
