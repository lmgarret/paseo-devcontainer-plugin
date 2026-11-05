/// <reference types="node" />
// This machine's side of the worktree guard (see worktree-guard.ts): checks a repository's
// worktrees from here and, through `docker exec`, from its container; repairs after archives and
// on request. The companion plugin (companion-host.ts) does the same after the container's own
// archives.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DevcontainerSettings, Guard } from "../shared/contract";
import {
  AUTOMATIC_FIXES,
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
  translate,
  type WorktreeReport,
  writePointerCommand,
  writeRecordCommand,
} from "./worktree-guard";
import type { DockerContainer } from "./discovery";
import { companionState, managedHome, readText, writeAtomic } from "./companion-host";
import { shellQuote } from "./paseo-home";
import { run, toolEnv } from "./process";

// Row refreshes check at most this often; archives and Restore check right away.
const CHECK_INTERVAL_MS = 15_000;
const HISTORY_MS = 24 * 60 * 60_000;
const EXEC_TIMEOUT_MS = 30_000;
// After an archive, checks keep repairing this long: Paseo's prune may come after the first one.
const ARCHIVE_WINDOW_MS = 5 * 60_000;
const FOLLOW_UP_MS = 15_000;


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
  if (!settings.guardWorktrees) return null;
  const home = managedHome(settings, repoPath, container);
  if (!container || !home || !container.workspaceFolder) return null;
  try {
    const hostRepo = realpathSync(repoPath);
    // A linked worktree or a submodule has a .git file; only main checkouts own worktree records.
    if (!statSync(join(hostRepo, ".git")).isDirectory()) return null;
    return {
      repoPath,
      home,
      config: {
        hostRepo,
        containerRepo: container.workspaceFolder,
        guardDir: join(home, GUARD_DIR),
        mounts: container.mounts,
      },
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
  report: GuardReport | null;
}

// What a check may repair: snapshot fixes on its own after archives, every fix that needs no
// choice on Restore, or one worktree's fix, whatever it is, when asked for by name.
export type RepairMode = "auto" | "all" | { name: string; branch?: string };

interface CheckOptions {
  trigger: string;
  repair?: RepairMode;
  exclude?: string[];
}

export class WorktreeGuard {
  private readonly repos = new Map<string, RepoState>();

  // This machine's live Paseo workspaces.
  constructor(private readonly hostWorkspaces: () => LiveWorkspace[]) {}

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

  // Tracked files that differ from `branch` in a worktree whose record would be recreated on it.
  async preview(target: GuardTarget, name: string, branch: string): Promise<{ files: string[]; total: number }> {
    const entry = this.recreatable(target, name, branch);
    const folder = translate(target.config, entry.folder, "host");
    if (!existsSync(join(folder, ".git"))) throw new Error("Its folder is not on this machine");
    // A throwaway index, so neither the folder nor the repository's index changes.
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpdir(), `devcontainer-guard-${process.pid}-${Date.now()}.index`) };
    const git = ["-c", "safe.directory=*", "--git-dir", join(target.config.hostRepo, ".git"), "--work-tree", folder];
    try {
      await runGit([...git, "read-tree", `refs/heads/${branch}`], env);
      const files = (await runGit([...git, "-C", folder, "diff", "--name-only"], env)).split("\n").filter(Boolean);
      return { files: files.slice(0, 20), total: files.length };
    } finally {
      rmSync(env.GIT_INDEX_FILE, { force: true });
    }
  }

  // The last check's entry for a record to recreate, with a branch it offered.
  private recreatable(target: GuardTarget, name: string, branch: string | undefined): WorktreeReport {
    const state = this.state(target);
    const entry = state.report?.worktrees.find((candidate) => candidate.name === name && candidate.fix?.kind === "recreate");
    if (!entry) throw new Error(`${name} has no record to recreate; check again`);
    const offered = state.status.worktrees.find((candidate) => candidate.name === name)?.branches ?? [];
    if (!branch || !offered.some((candidate) => candidate.name === branch)) {
      throw new Error(`Pick one of the branches offered for ${name}`);
    }
    return entry;
  }

  // Checks now; `repair` says what it may fix, never in folders of `exclude`.
  check(
    target: GuardTarget,
    docker: string,
    options: CheckOptions,
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
        report: null,
      };
      this.repos.set(target.repoPath, state);
    }
    return state;
  }

  private async runCheck(
    target: GuardTarget,
    docker: string,
    state: RepoState,
    options: CheckOptions,
  ): Promise<{ status: Guard; results: FixResult[] }> {
    state.lastCheck = Date.now();
    const { config } = target;
    let error: string | null = null;
    writeGuardConfig(config);
    // Live workspaces of both daemons, so a folder whose record is gone shows up.
    const workspaces = [...this.hostWorkspaces()];
    if (target.container.running) {
      try {
        workspaces.push(...(await containerWorkspaces(docker, target)));
      } catch (listError) {
        error = `Could not list the container's workspaces: ${errorText(listError)}`;
      }
    }
    const live = workspaces.map((workspace) => workspace.folder);
    const titles = new Map(workspaces.filter((workspace) => workspace.title).map((workspace) => [workspace.folder, workspace.title]));
    const titleOf = (folder: string) => titles.get(translate(config, folder, "host")) ?? null;
    const inspect = async (): Promise<GuardReport> => {
      const request = probeRequest(config, "host", live);
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
      return classify(config, "host", views, Date.now(), live);
    };

    let report = await inspect();
    const ops: Partial<Record<Side, FolderOps>> = { host: localOps() };
    if (target.container.running) ops.container = containerOps(docker, target);
    const results: FixResult[] = [];
    const record = (side: Side, trigger: string, fixed: FixResult[], at = Date.now()) => {
      for (const result of fixed) {
        state.restores.unshift({ at, side, trigger, folder: result.folder, title: titleOf(result.folder), error: result.error });
        if (side !== "host") continue;
        if (result.error) console.error(`[devcontainer-host] could not repair worktree ${result.folder}: ${result.error}`);
        else console.log(`[devcontainer-host] repaired worktree ${result.folder} (${trigger})`);
      }
    };

    const archiving = state.archives.until >= Date.now();
    const repair: RepairMode | undefined = options.repair ?? (archiving ? "auto" : undefined);
    if (repair) {
      const exclude = new Set([...(options.exclude ?? []), ...(archiving ? state.archives.folders : [])]);
      const scope =
        repair === "auto"
          ? { kinds: AUTOMATIC_FIXES }
          : repair === "all"
            ? { kinds: new Set([...AUTOMATIC_FIXES, "share" as const]) }
            : {
                only: new Set([repair.name]),
                branches: new Map(repair.branch ? [[repair.name, repair.branch]] : []),
              };
      if (typeof repair === "object" && repair.branch) this.recreatable(target, repair.name, repair.branch);
      const fixed = await restore(config, "host", report, ops, { exclude, ...scope });
      record("host", options.repair ? options.trigger : "archive", fixed);
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
          kinds: AUTOMATIC_FIXES,
        });
        record("host", companion.trigger, fixed);
        results.push(...fixed);
      }
    }
    if (results.length > 0) report = await inspect();
    snapshot(config, "host", report);

    state.restores = recent(state.restores);
    state.report = report;
    const order = { broken: 0, "at-risk": 1, safe: 2 } as const;
    const worktrees = [...report.worktrees].sort((a, b) => order[a.state] - order[b.state]);
    const branches = new Map<string, Guard["worktrees"][number]["branches"]>();
    for (const entry of worktrees) {
      if (entry.fix?.kind === "recreate") branches.set(entry.name, await branchCandidates(config, entry.folder));
    }
    state.status = {
      checkedAt: report.checkedAt,
      containerChecked: report.sides.includes("container"),
      error,
      safe: worktrees.filter((entry) => entry.state === "safe").length,
      worktrees: worktrees.map((entry) => ({
        name: entry.name,
        folder: entry.folder,
        title: titleOf(entry.folder),
        sides: { host: entry.sides.host ?? null, container: entry.sides.container ?? null },
        state: entry.state,
        problem: entry.problem,
        fix: fixLabel(entry, ops, branches.get(entry.name) ?? []),
        branches: branches.get(entry.name) ?? [],
        target: entry.fix?.kind === "share" ? dirname(entry.fix.gitFile) : null,
      })),
      restored: state.restores,
      companion: companionState(target.home),
    };
    return { status: { ...state.status }, results };
  }
}

function fixLabel(
  entry: WorktreeReport,
  ops: Partial<Record<Side, FolderOps>>,
  branches: unknown[],
): Guard["worktrees"][number]["fix"] {
  if (!entry.fix || !entry.reachable.some(({ side }) => ops[side])) return null;
  if (entry.fix.kind === "share") return "share";
  if (entry.fix.kind === "recreate") return branches.length > 0 ? "recreate" : null;
  return "restore";
}

// Branches a record-less worktree was likely on: Paseo names a worktree's branch after its folder
// and may rename it later, so a branch at the same commit as the folder's name comes first.
// Branches checked out elsewhere are left out.
async function branchCandidates(config: GuardConfig, folder: string): Promise<Guard["worktrees"][number]["branches"]> {
  const common = join(config.hostRepo, ".git");
  let refs: [string, string, string, string][];
  try {
    refs = (
      await runGit([
        "--git-dir",
        common,
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(contents:subject)",
        "refs/heads",
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", tip = "", date = "", ...subject] = line.split("\t");
        return [name, tip, date, subject.join("\t")];
      });
  } catch {
    return [];
  }
  const checkedOut = new Set<string>();
  const headOf = (dir: string) => /^ref: refs\/heads\/(.+)$/m.exec(readText(join(dir, "HEAD")) ?? "")?.[1];
  for (const dir of [common, ...listRecordDirs(common)]) {
    const branch = headOf(dir);
    if (branch) checkedOut.add(branch);
  }
  const slug = basename(folder);
  const slugTip = refs.find(([name]) => name === slug)?.[1];
  if (!slugTip) return [];
  const renamed = refs.filter(([name, tip]) => name !== slug && tip === slugTip).map(([name]) => name);
  return [...renamed, slug]
    .filter((name) => !checkedOut.has(name))
    .slice(0, 5)
    .map((name) => {
      const ref = refs.find(([candidate]) => candidate === name);
      return { name, date: ref?.[2] ?? "", subject: ref?.[3] ?? "" };
    });
}

function listRecordDirs(common: string): string[] {
  try {
    return readdirSync(join(common, "worktrees")).map((name) => join(common, "worktrees", name));
  } catch {
    return [];
  }
}

function runGit(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return run("git", args, { env, timeoutMs: EXEC_TIMEOUT_MS }).then((result) => {
    if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || `git exit ${result.code}`);
    return result.stdout;
  });
}

export interface LiveWorkspace {
  // As this machine sees it.
  folder: string;
  title: string;
}

// The container daemon's workspaces, with folders as this machine sees them.
async function containerWorkspaces(docker: string, target: GuardTarget): Promise<LiveWorkspace[]> {
  const result = await run(
    docker,
    ["exec", "-u", target.container.remoteUser, target.container.id, "bash", "-lc", "paseo workspace ls --json"],
    { env: toolEnv([docker]), timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || `exit ${result.code}`);
  const entries = JSON.parse(result.stdout || "[]") as { cwd?: string; name?: string }[];
  return entries.flatMap((entry) =>
    entry.cwd ? [{ folder: translate(target.config, entry.cwd, "host"), title: entry.name ?? "" }] : [],
  );
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

export function writeGuardConfig(config: GuardConfig): void {
  const file = join(config.guardDir, GUARD_CONFIG);
  const content = `${JSON.stringify(
    { hostRepo: config.hostRepo, containerRepo: config.containerRepo, mounts: config.mounts ?? [] },
    null,
    2,
  )}\n`;
  if (readText(file) === content) return;
  mkdirSync(config.guardDir, { recursive: true });
  writeAtomic(file, content);
}
