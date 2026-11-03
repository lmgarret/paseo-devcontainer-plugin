/// <reference types="node" />
// This machine's side of the worktree guard (see worktree-guard.ts): checks a repository's
// worktrees from here and, through `docker exec`, from its container; repairs after archives and
// on request; and installs the companion plugin that does the same after the container's own
// archives.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DevcontainerSettings, Guard } from "../shared/contract";
import {
  classify,
  errorText,
  type FixResult,
  type FolderOps,
  GUARD_CONFIG,
  GUARD_DIR,
  type GuardConfig,
  type GuardReport,
  localOps,
  localView,
  parseProbe,
  PROBE_SCRIPT,
  probeInput,
  probeRequest,
  readContainerStatus,
  resetIndexCommand,
  RECORD_EXISTS_EXIT,
  restore,
  settleArchive,
  type Side,
  snapshot,
  writePointerCommand,
  writeRecordCommand,
} from "./worktree-guard";
import type { DockerContainer } from "./discovery";
import { homeOwner, homesRoot, hostPaseoHome, readConfig, shellQuote, writeConfig } from "./paseo-home";
import { run, toolEnv } from "./process";

export const COMPANION_ID = "devcontainer-guard";
const PLUGIN_ID = "devcontainer-host";
// Row refreshes check at most this often; archives and Restore check right away.
const CHECK_INTERVAL_MS = 15_000;
const HISTORY_MS = 24 * 60 * 60_000;
const EXEC_TIMEOUT_MS = 30_000;
// After an archive, checks keep repairing this long: Paseo's prune may come after the first one.
const ARCHIVE_WINDOW_MS = 5 * 60_000;
const FOLLOW_UP_MS = 15_000;

type Log = (line: string) => void;

export interface GuardTarget {
  repoPath: string;
  home: string;
  config: GuardConfig;
  container: { id: string; remoteUser: string; running: boolean };
}

// The guard applies to a main checkout whose container uses a Paseo home this plugin manages.
export function guardTarget(
  settings: DevcontainerSettings,
  repoPath: string,
  container: DockerContainer | null,
): GuardTarget | null {
  if (!settings.guardWorktrees || !settings.persistPaseoHome) return null;
  const home = container?.paseoHome.home;
  if (!container || !home || !container.workspaceFolder) return null;
  try {
    // Homes of another plugin instance or an earlier homes folder are left alone.
    if (dirname(home) !== realpathSync(homesRoot(settings))) return null;
    if (homeOwner(home) !== repoPath) return null;
    const hostRepo = realpathSync(repoPath);
    // A linked worktree or a submodule has a .git file; only main checkouts own worktree records.
    if (!statSync(join(hostRepo, ".git")).isDirectory()) return null;
    return {
      repoPath,
      home,
      config: { hostRepo, containerRepo: container.workspaceFolder, guardDir: join(home, GUARD_DIR) },
      container: { id: container.id, remoteUser: container.remoteUser, running: container.running },
    };
  } catch {
    return null;
  }
}

// Run in the container as root: links the repository's paths on this machine to its folder in
// the container, so `.git` files that a repair on this machine rewrote still open there. A path
// that exists and is not a link is left alone.
export function repoLinkScript(hostPaths: string[], containerRepo: string): string {
  const lines = [`C=${shellQuote(containerRepo)}`];
  for (const path of new Set(hostPaths)) {
    if (path === containerRepo) continue;
    lines.push(
      `H=${shellQuote(path)}`,
      'if [ -L "$H" ]; then [ "$(readlink "$H")" = "$C" ] || ln -sfn "$C" "$H";',
      'elif [ -e "$H" ]; then echo "blocked $H" >&2;',
      'else mkdir -p "$(dirname "$H")" && ln -s "$C" "$H"; fi',
    );
  }
  return lines.join("\n");
}

export function hostRepoPaths(repoPath: string): string[] {
  try {
    return [...new Set([repoPath, realpathSync(repoPath)])];
  } catch {
    return [repoPath];
  }
}

interface RepoState {
  // The last target and docker seen, so the companion's reports are picked up between checks.
  target: GuardTarget;
  docker: string | null;
  status: Guard;
  lastCheck: number;
  chain: Promise<unknown>;
  restores: Guard["restored"];
  // The companion's last status already acted on, and whether a check for a newer one is queued.
  handledContainerStatus: number;
  reportCheck: boolean;
  // Recent archives: checks until `until` repair, but never bring back these folders.
  archives: { until: number; folders: Set<string> };
}

export class WorktreeGuard {
  private readonly repos = new Map<string, RepoState>();

  // The row's last result; starts a check when it is stale. Never waits for one.
  status(target: GuardTarget, docker: string | null): Guard {
    const state = this.state(target, docker);
    if (docker && Date.now() - state.lastCheck > CHECK_INTERVAL_MS) {
      state.lastCheck = Date.now();
      void this.check(target, docker, { trigger: "refresh" }).catch((error: unknown) =>
        console.error(`[devcontainer-host] worktree check of ${target.repoPath} failed:`, error),
      );
    }
    return { ...state.status, companion: companionState(target.home), restored: recent(state.restores) };
  }

  // A workspace of this repository was archived here. Waits for Paseo to remove its worktree and
  // prune, repairs, and keeps repairing on checks for a few minutes.
  async afterArchive(target: GuardTarget, docker: string, folder: string): Promise<FixResult[]> {
    const state = this.state(target);
    const now = Date.now();
    if (state.archives.until < now) state.archives.folders.clear();
    state.archives.folders.add(folder);
    state.archives.until = now + ARCHIVE_WINDOW_MS;
    if (folder !== target.config.hostRepo && folder !== target.repoPath) await settleArchive(folder);
    const { results } = await this.check(target, docker, { trigger: "archive" });
    setTimeout(() => {
      void this.check(target, docker, { trigger: "archive" }).catch((error: unknown) =>
        console.error(`[devcontainer-host] worktree check of ${target.repoPath} failed:`, error),
      );
    }, FOLLOW_UP_MS);
    return results;
  }

  // Checks now; with `restore`, repairs what it can, except folders in `exclude`.
  check(
    target: GuardTarget,
    docker: string,
    options: { trigger: string; restore?: boolean; exclude?: string[] },
  ): Promise<{ status: Guard; results: FixResult[] }> {
    const state = this.state(target, docker);
    // One check at a time per repository: a repair must not race a snapshot.
    const next = state.chain.then(() => this.runCheck(target, docker, state, options));
    state.chain = next.catch(() => undefined);
    return next;
  }

  // Cheap and frequent: a new report from the container's companion starts a check right away.
  pollContainerReports(): void {
    for (const state of this.repos.values()) {
      if (!state.docker) continue;
      const report = readContainerStatus(state.target.config);
      if (!report || report.updatedAt <= state.handledContainerStatus || state.reportCheck) continue;
      state.reportCheck = true;
      void this.check(state.target, state.docker, { trigger: "archive" })
        .catch((error: unknown) => console.error(`[devcontainer-host] worktree check of ${state.target.repoPath} failed:`, error))
        .finally(() => {
          state.reportCheck = false;
        });
    }
  }

  private state(target: GuardTarget, docker: string | null = null): RepoState {
    let state = this.repos.get(target.repoPath);
    if (state) {
      state.target = target;
      if (docker) state.docker = docker;
    } else {
      state = {
        target,
        docker,
        status: {
          checkedAt: null,
          containerChecked: false,
          error: null,
          safe: 0,
          worktrees: [],
          restored: [],
          companion: "off",
        },
        lastCheck: 0,
        chain: Promise.resolve(),
        restores: [],
        handledContainerStatus: 0,
        reportCheck: false,
        archives: { until: 0, folders: new Set() },
      };
      this.repos.set(target.repoPath, state);
    }
    return state;
  }

  private async runCheck(
    target: GuardTarget,
    docker: string,
    state: RepoState,
    options: { trigger: string; restore?: boolean; exclude?: string[] },
  ): Promise<{ status: Guard; results: FixResult[] }> {
    state.lastCheck = Date.now();
    const { config } = target;
    let error: string | null = null;
    writeGuardConfig(config);
    const inspect = async (): Promise<GuardReport> => {
      const request = probeRequest(config, "host");
      const views: { host: ReturnType<typeof localView>; container?: ReturnType<typeof parseProbe> } = {
        host: localView(request),
      };
      if (target.container.running) {
        try {
          views.container = await probeContainer(docker, target, request);
        } catch (probeError) {
          error = `Could not check the container: ${errorText(probeError)}`;
        }
      }
      return classify(config, "host", views);
    };

    let report = await inspect();
    const ops: Partial<Record<Side, FolderOps>> = { host: localOps() };
    if (target.container.running) ops.container = containerOps(docker, target);
    const results: FixResult[] = [];
    const record = (side: Side, trigger: string, fixed: FixResult[], at = Date.now()) => {
      for (const result of fixed) {
        state.restores.unshift({ at, side, trigger, folder: result.folder, error: result.error });
        if (side !== "host") continue;
        if (result.error) console.error(`[devcontainer-host] could not repair worktree ${result.folder}: ${result.error}`);
        else console.log(`[devcontainer-host] repaired worktree ${result.folder} (${trigger})`);
      }
    };

    const archiving = state.archives.until >= Date.now();
    if (options.restore || archiving) {
      const exclude = new Set([...(options.exclude ?? []), ...(archiving ? state.archives.folders : [])]);
      const fixed = await restore(config, "host", report, ops, { exclude });
      record("host", archiving && !options.restore ? "archive" : options.trigger, fixed);
      results.push(...fixed);
    }
    // The companion repaired after an archive in the container, and left what it could not reach.
    const companion = readContainerStatus(config);
    if (companion && companion.updatedAt > state.handledContainerStatus) {
      state.handledContainerStatus = companion.updatedAt;
      record("container", companion.trigger, companion.restored, companion.updatedAt);
      if (companion.pending.length > 0) {
        if (results.length > 0) report = await inspect();
        const fixed = await restore(config, "host", report, ops, {
          only: new Set(companion.pending),
          exclude: new Set(companion.archived ? [companion.archived] : []),
        });
        record("host", companion.trigger, fixed);
        results.push(...fixed);
      }
    }
    if (results.length > 0) report = await inspect();
    snapshot(config, "host", report);

    state.restores = recent(state.restores);
    const worktrees = report.worktrees.filter((entry) => entry.state !== "safe");
    state.status = {
      checkedAt: report.checkedAt,
      containerChecked: report.sides.includes("container"),
      error,
      safe: report.worktrees.length - worktrees.length,
      worktrees: worktrees.map((entry) => ({
        name: entry.name,
        folder: entry.folder,
        state: entry.state,
        problem: entry.problem,
        fixable: entry.fix !== null && entry.reachable.some(({ side }) => ops[side]),
      })),
      restored: state.restores,
      companion: companionState(target.home),
    };
    return { status: { ...state.status }, results };
  }
}

function recent(restores: Guard["restored"]): Guard["restored"] {
  const since = Date.now() - HISTORY_MS;
  return restores.filter((entry) => entry.at >= since).slice(0, 50);
}

async function probeContainer(docker: string, target: GuardTarget, request: ReturnType<typeof probeRequest>) {
  const script = `${repoLinkScript(hostRepoPaths(target.repoPath), target.config.containerRepo)}\n${PROBE_SCRIPT}`;
  // As root: links need it, and every path is readable.
  const result = await run(docker, ["exec", "-i", "-u", "root", target.container.id, "sh", "-c", script], {
    env: toolEnv([docker]),
    timeoutMs: EXEC_TIMEOUT_MS,
    input: probeInput(request),
  });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || `exit ${result.code}`);
  return parseProbe(result.stdout);
}

// Writes as the container's user, so git there can still update what it owns.
function containerOps(docker: string, target: GuardTarget): FolderOps {
  const exec = async (command: string[]) => {
    const result = await run(docker, ["exec", "-u", target.container.remoteUser, target.container.id, ...command], {
      env: toolEnv([docker]),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (result.code === RECORD_EXISTS_EXIT) throw Object.assign(new Error("The record exists"), { code: "EEXIST" });
    if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || `exit ${result.code}`);
  };
  return {
    writeRecord: (dir, files) => exec(writeRecordCommand(dir, files)),
    writePointer: (gitFile, pointer) => exec(writePointerCommand(gitFile, pointer)),
    resetIndex: (folder, recordDir) => exec(resetIndexCommand(folder, recordDir)),
  };
}

function writeGuardConfig(config: GuardConfig): void {
  const file = join(config.guardDir, GUARD_CONFIG);
  const content = `${JSON.stringify({ hostRepo: config.hostRepo, containerRepo: config.containerRepo }, null, 2)}\n`;
  if (readText(file) === content) return;
  mkdirSync(config.guardDir, { recursive: true });
  writeAtomic(file, content);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Same directory, so the rename stays on one filesystem.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

// This plugin's own folder on this machine: the daemon runs a bundle, so it is read from the
// daemon's plugin config.
function pluginSourceDir(): string | null {
  const plugins = readConfig(hostPaseoHome())?.plugins ?? {};
  for (const source of Object.values(plugins)) {
    if (!source.path) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(source.path, "paseo-plugin.json"), "utf8")) as { id?: string };
      if (manifest.id === PLUGIN_ID && existsSync(join(source.path, "server", "companion.ts"))) return source.path;
    } catch {
      // Not this plugin.
    }
  }
  return null;
}

function companionDir(home: string): string {
  return join(home, "plugins", COMPANION_ID);
}

function companionFiles(source: string): Record<string, string> {
  const read = (path: string) => readFileSync(join(source, path), "utf8");
  return {
    "paseo-plugin.json": `${JSON.stringify(
      {
        id: COMPANION_ID,
        name: "Dev container worktree guard",
        description: "Restores git worktree records that an archive in this container deletes for the host's worktrees.",
        requirements: { paseo: ">=0.15.0" },
      },
      null,
      2,
    )}\n`,
    "index.server.ts": 'export { default } from "./server/companion";\n',
    "server/companion.ts": read("server/companion.ts"),
    "server/worktree-guard.ts": read("server/worktree-guard.ts"),
  };
}

function companionState(home: string): Guard["companion"] {
  const entry = readConfig(home)?.plugins?.[COMPANION_ID];
  if (!existsSync(join(companionDir(home), "index.server.ts"))) return "off";
  if (!entry) return "pending";
  return entry.enabled === false ? "off" : "installed";
}

export interface CompanionInstall {
  // Files differ from what the daemon last loaded.
  changed: boolean;
  // Registered in the daemon's config; false when the daemon runs and could not be told.
  registered: boolean;
}

// Copies the companion into the container's Paseo home, which the container sees at the same
// path, and registers it in that daemon's config. The config is only edited while the daemon is
// stopped, since a running daemon owns it. A copy that the user disabled stays disabled.
export function installCompanion(target: GuardTarget, daemonRunning: boolean, log: Log): CompanionInstall | null {
  const source = pluginSourceDir();
  if (!source) {
    log("Worktree guard: could not find this plugin's folder; the container's companion plugin is not installed.");
    return null;
  }
  writeGuardConfig(target.config);
  const dir = companionDir(target.home);
  let changed = false;
  for (const [path, content] of Object.entries(companionFiles(source))) {
    const file = join(dir, path);
    if (readText(file) === content) continue;
    writeAtomic(file, content);
    changed = true;
  }
  const config = readConfig(target.home) ?? { version: 1 };
  const entry = config.plugins?.[COMPANION_ID];
  if (entry && entry.path === dir && config.pluginsEnabled === true) return { changed, registered: true };
  if (entry?.enabled === false) return { changed, registered: true };
  if (daemonRunning) return { changed, registered: false };
  config.pluginsEnabled = true;
  config.plugins = { ...config.plugins, [COMPANION_ID]: { source: "directory", path: dir, enabled: true } };
  writeConfig(target.home, config);
  log(`Worktree guard: installed the ${COMPANION_ID} plugin in the container's Paseo daemon.`);
  return { changed, registered: true };
}
