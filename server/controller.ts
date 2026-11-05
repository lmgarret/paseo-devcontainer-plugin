/// <reference types="node" />
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  ACTION_LABELS,
  type Container,
  type DevcontainerSettings,
  type Job,
  type Notice,
  type Status,
} from "../shared/contract";
import { type Candidate, listDockerContainers, mergeCandidates, type PaseoCatalog } from "./discovery";
import { PortForwarder } from "./forwarder";
import { COMPANION_ID, type GuardTarget, guardTarget, hostRepoPaths, installCompanion, repoLinkScript, WorktreeGuard } from "./guard";
import { type ProjectIcon, readProjectIcon } from "./icons";
import { hostPaseoHome, linkHomeScript, pinWorktreesRoot, planPaseoHome, repoRootOf } from "./paseo-home";
import { resolveTool, run, toolEnv } from "./process";

const LOG_LINES = 40;
// Full job logs, one file per repository, followed by the log terminal.
const LOG_DIR = join(tmpdir(), "paseo-devcontainer-logs");
const STATUS_CACHE_MS = 2_000;
const DAEMON_START_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
// First builds pull images and run features; keep a generous ceiling so a hung build still ends.
const UP_TIMEOUT_MS = 45 * 60_000;
// Docker Desktop and OrbStack relay the macOS agent to this path in their VM.
const DOCKER_VM_AGENT_SOCKET = "/run/host-services/ssh-auth.sock";
const SSH_AGENT_TARGET = "/tmp/paseo-ssh-agent.sock";
// Prepended to exec'd scripts so shells and the daemon's agents use the forwarded agent.
const USE_SSH_AGENT = `if [ -S ${SSH_AGENT_TARGET} ]; then export SSH_AUTH_SOCK=${SSH_AGENT_TARGET}; fi; `;
const NOTICE_MS = 10 * 60_000;

// What the daemon's workspace hooks report.
export interface WorkspaceEvent {
  cwd: string;
  projectId: string;
}

interface Tools {
  docker: string | null;
  devcontainer: string | null;
}

interface Target {
  containerId: string;
  remoteUser: string;
}

interface DaemonInfo {
  installed: boolean;
  running: boolean;
  serverId: string | null;
  // The daemon's port inside the container; null for a socket or an unknown address.
  listenPort: number | null;
}

interface Discovery {
  settings: DevcontainerSettings;
  tools: Tools;
  candidates: Candidate[];
  dockerError: string | null;
}

type Log = (line: string) => void;

export class DevcontainerController {
  private readonly jobs = new Map<string, Job>();
  // Last server ID a daemon reported per repository, for when the container is stopped.
  private readonly knownServerIds = new Map<string, string>();
  private readonly forwarder = new PortForwarder();
  private readonly guard = new WorktreeGuard(() =>
    this.catalog.workspaces.map((workspace) => ({ folder: workspace.directory, title: workspace.title })),
  );
  private notices: Notice[] = [];
  private nextJobId = 1;
  private catalog: PaseoCatalog = { projects: [], workspaces: [] };
  private cached: { at: number; status: Promise<Status> } | null = null;

  constructor(
    private readonly readSettings: () => Promise<DevcontainerSettings>,
    private readonly listCatalog: () => Promise<PaseoCatalog>,
  ) {}

  async status(): Promise<Status> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > STATUS_CACHE_MS) {
      const status = this.computeStatus();
      this.cached = { at: now, status };
      // Do not keep serving a failed computation for the cache lifetime.
      status.catch(() => {
        if (this.cached?.status === status) this.cached = null;
      });
    }
    const status = await this.cached.status;
    // Jobs and forwards change faster than the cache; always return the live ones.
    return {
      ...status,
      containers: status.containers.map((container) => ({
        ...container,
        forwards: this.forwarder.forwards(container.repoPath),
        job: this.jobSnapshot(container.repoPath),
      })),
    };
  }

  // Opens and closes local ports for what listens in running containers; called on an interval.
  async syncForwards(): Promise<void> {
    const settings = await this.readSettings();
    const docker = resolveTool("docker", settings.dockerPath);
    if (!docker) return;
    const containers = await listDockerContainers(docker);
    await this.forwarder.sync(settings, docker, containers);
  }

  close(): void {
    this.forwarder.close();
  }

  // Settings changes (hidden containers, discovery) must show on the next status read.
  invalidate(): void {
    this.cached = null;
  }

  startAction(repoPath: string, action: Action): Job {
    const current = this.jobs.get(repoPath);
    if (current?.state === "running") {
      throw new Error(`${current.action} is already running for ${repoPath}`);
    }
    const job: Job = {
      id: this.nextJobId++,
      action,
      state: "running",
      phase: "Preparing",
      log: [],
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    };
    this.jobs.set(repoPath, job);
    this.cached = null;
    const file = logFile(repoPath);
    resetLog(file, `── ${ACTION_LABELS[action]} · ${repoPath} · ${new Date(job.startedAt).toLocaleString()}`);
    void this.execute(repoPath, job, file)
      .then(
        () => {
          job.state = "succeeded";
          job.phase = "Done";
          appendLog(file, `✔ ${ACTION_LABELS[action]} done`);
        },
        (error: unknown) => {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : String(error);
          appendLog(file, `✖ ${ACTION_LABELS[action]} failed: ${job.error}`);
          console.error(`[devcontainer-host] ${action} ${repoPath} failed:`, job.error);
        },
      )
      .finally(() => {
        job.endedAt = Date.now();
        this.cached = null;
      });
    return { ...job, log: [...job.log] };
  }

  // Command for an interactive shell in the container, run by a Paseo terminal on this machine.
  async shellCommand(repoPath: string): Promise<{ name: string; command: string; args: string[] }> {
    const { tools, candidates } = await this.discover();
    const candidate = candidates.find((entry) => entry.repoPath === repoPath);
    const container = candidate?.container;
    if (!candidate || !container?.running) throw new Error("The container is not running");
    if (!tools.docker) throw new Error("docker not found. Install Docker Desktop or set the docker path in settings.");
    const args = ["exec", "-it", "-u", container.remoteUser];
    if (container.workspaceFolder) args.push("-w", container.workspaceFolder);
    // Prefer a login bash like VS Code's terminal; fall back to sh in minimal images.
    args.push(
      container.id,
      "sh",
      "-c",
      `${USE_SSH_AGENT}if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi`,
    );
    return { name: `${candidate.name} (container)`, command: tools.docker, args };
  }

  // Whether the folder has no container yet, so starting it builds one.
  async containerMissing(repoPath: string): Promise<boolean> {
    const { candidates } = await this.discover();
    return !candidates.find((entry) => entry.repoPath === repoPath)?.container;
  }

  // Command that shows the folder's latest job log and follows it, across later jobs too.
  logCommand(repoPath: string): { name: string; command: string; args: string[] } {
    const file = logFile(repoPath);
    if (!existsSync(file)) throw new Error("No log yet for this dev container");
    const name = repoPath.split("/").filter(Boolean).pop() ?? repoPath;
    // -F reopens the file when a new job replaces it.
    return { name: `${name} (dev container log)`, command: "/bin/sh", args: ["-c", 'exec tail -n +1 -F "$1"', "sh", file] };
  }

  dismiss(repoPath: string): void {
    if (this.jobs.get(repoPath)?.state === "running") throw new Error("The job is still running");
    this.jobs.delete(repoPath);
    this.cached = null;
  }

  async projectIcon(projectId: string): Promise<ProjectIcon | null> {
    const project = this.catalog.projects.find((entry) => entry.projectId === projectId);
    return project ? readProjectIcon(project) : null;
  }

  // Restore and Make safe for every worktree, or one worktree's fix; recreate needs a branch.
  async restoreWorktrees(
    repoPath: string,
    name?: string,
    branch?: string,
  ): Promise<{ restored: number; failed: number; remaining: number }> {
    const { target, docker } = await this.requireGuard(repoPath);
    const { status, results } = await this.guard.check(target, docker, {
      trigger: "manual",
      repair: name ? { name, ...(branch ? { branch } : {}) } : "all",
    });
    this.cached = null;
    return {
      restored: results.filter((result) => !result.error).length,
      failed: results.filter((result) => result.error).length,
      remaining: status.worktrees.filter((entry) => entry.state === "broken").length,
    };
  }

  async previewRecreate(repoPath: string, name: string, branch: string) {
    const { target } = await this.requireGuard(repoPath);
    return this.guard.preview(target, name, branch);
  }

  private async requireGuard(repoPath: string): Promise<{ target: GuardTarget; docker: string }> {
    const { settings, tools, candidates } = await this.discover();
    const candidate = candidates.find((entry) => entry.repoPath === repoPath);
    const target = candidate ? guardTarget(settings, candidate.repoPath, candidate.container) : null;
    if (!candidate || !target) throw new Error("The worktree guard does not cover this container");
    if (!tools.docker) throw new Error("docker not found. Install Docker Desktop or set the docker path in settings.");
    return { target, docker: tools.docker };
  }

  // A workspace was archived here: Paseo's `git worktree prune` deletes the records of worktrees
  // this machine cannot see. Puts them back, but not the archived one.
  async afterWorkspaceArchive(workspace: WorkspaceEvent): Promise<void> {
    const { tools, targets } = await this.guardTargetsFor(workspace);
    if (!tools.docker) return;
    const docker = tools.docker;
    await Promise.all(targets.map((target) => this.guard.afterArchive(target, docker, workspace.cwd)));
    if (targets.length > 0) this.cached = null;
  }

  // A workspace was created here in a repository its container also uses: worth knowing, and
  // worth a snapshot of the new worktree's record.
  async afterWorkspaceCreate(workspace: WorkspaceEvent): Promise<void> {
    const { tools, targets, candidates } = await this.guardTargetsFor(workspace);
    for (const target of targets) {
      const name = candidates.find((entry) => entry.repoPath === target.repoPath)?.name ?? target.repoPath;
      const message =
        `${name} also runs in a dev container, which shares its git worktree records. Archiving or ` +
        "`git worktree prune` and `repair` on either side can break the other side's worktrees; the " +
        "dev container plugin restores them where it can.";
      console.warn(`[devcontainer-host] ${message}`);
      this.notices.push({ id: `${target.repoPath}:${workspace.cwd}:${Date.now()}`, at: Date.now(), repoPath: target.repoPath, message });
      if (tools.docker) await this.guard.check(target, tools.docker, { trigger: "create" });
    }
    if (targets.length > 0) this.cached = null;
  }

  // Runs without a client: checks stale repositories, which also acts on the container's reports.
  async guardTick(): Promise<void> {
    const { settings, tools, candidates } = await this.discover();
    for (const candidate of candidates) {
      const target = guardTarget(settings, candidate.repoPath, candidate.container);
      if (target) this.guard.status(target, tools.docker);
    }
  }

  pollGuardReports(): void {
    this.guard.pollContainerReports();
  }

  private async guardTargetsFor(workspace: WorkspaceEvent) {
    const { settings, tools, candidates } = await this.discover();
    // An archived worktree's folder is gone; its project still names the repository.
    const root = repoRootOf(workspace.cwd);
    const targets = candidates.flatMap((candidate) => {
      const target = guardTarget(settings, candidate.repoPath, candidate.container);
      if (!target) return [];
      const matches =
        candidate.project?.projectId === workspace.projectId ||
        root === target.config.hostRepo ||
        root === candidate.repoPath;
      return matches ? [target] : [];
    });
    return { tools, targets, candidates };
  }

  private jobSnapshot(repoPath: string): Job | null {
    const job = this.jobs.get(repoPath);
    return job ? { ...job, log: [...job.log] } : null;
  }

  private async discover(): Promise<Discovery> {
    const settings = await this.readSettings();
    const tools = {
      docker: resolveTool("docker", settings.dockerPath),
      devcontainer: resolveTool("devcontainer", settings.devcontainerPath),
    };
    // Projects and workspaces link containers to Paseo even when project scanning is off.
    this.catalog = await this.listCatalog().catch((error: unknown) => {
      console.error("[devcontainer-host] project list failed:", error);
      return this.catalog;
    });
    let dockerError: string | null = null;
    let containers: Awaited<ReturnType<typeof listDockerContainers>> = [];
    if (!tools.docker) {
      dockerError = "docker not found. Install Docker Desktop or set the docker path in settings.";
    } else {
      try {
        containers = await listDockerContainers(tools.docker);
      } catch (error) {
        dockerError = error instanceof Error ? error.message : String(error);
      }
    }
    const candidates = mergeCandidates(settings, this.catalog, containers, this.jobs.keys());
    return { settings, tools, candidates, dockerError };
  }

  private async computeStatus(): Promise<Status> {
    const { settings, tools, candidates, dockerError } = await this.discover();
    const containers = await Promise.all(
      candidates.map(async (candidate): Promise<Container> => {
        const container = candidate.container;
        const daemon =
          container?.running && tools.docker
            ? await this.daemonInfo(tools.docker, { containerId: container.id, remoteUser: container.remoteUser })
            : null;
        if (daemon?.listenPort) this.forwarder.setDaemonPort(candidate.repoPath, daemon.listenPort);
        // Unknown when the check failed: keep the last state rather than cut a live connection.
        if (!container?.running) this.forwarder.setDaemonRunning(candidate.repoPath, false);
        else if (daemon) this.forwarder.setDaemonRunning(candidate.repoPath, daemon.installed && daemon.running);
        const detected = daemon?.serverId ?? container?.paseoHome.serverId ?? null;
        if (detected) this.knownServerIds.set(candidate.repoPath, detected);
        const guard = guardTarget(settings, candidate.repoPath, candidate.container);
        return {
          repoPath: candidate.repoPath,
          name: candidate.name,
          source: candidate.source,
          project: candidate.project
            ? {
                id: candidate.project.projectId,
                key: candidate.project.projectKey,
                name: candidate.project.name,
                rootPath: candidate.project.rootPath,
                iconRevision: candidate.project.customIconRevision ?? candidate.project.iconRevision ?? "auto",
              }
            : null,
          workspace: candidate.workspace ? { id: candidate.workspace.id, title: candidate.workspace.title } : null,
          branch: candidate.branch,
          workspaceFolder: container?.workspaceFolder ?? null,
          hidden: settings.hidden.includes(candidate.repoPath),
          docker: container ? (container.running ? "running" : "stopped") : "missing",
          containerId: container?.id ?? null,
          containerName: container?.name ?? null,
          startedAt: container?.running ? container.startedAt : null,
          hostNetwork: container?.hostNetwork ?? false,
          serverId:
            detected || this.knownServerIds.get(candidate.repoPath) || null,
          paseoHomePersistent: container ? container.paseoHome.persistent : null,
          paseoInstalled: daemon ? daemon.installed : null,
          daemonRunning: daemon?.installed ? daemon.running : null,
          forwards: [],
          job: null,
          guard: guard ? this.guard.status(guard, tools.docker) : null,
        };
      }),
    );
    const since = Date.now() - NOTICE_MS;
    this.notices = this.notices.filter((notice) => notice.at >= since);
    return {
      containers,
      dockerError,
      tools,
      notices: [...this.notices],
      machine: {
        name: hostname().replace(/\.local$/, "") || "This machine",
        platform: process.platform,
        serverId: readServerId(),
      },
    };
  }

  private exec(docker: string, target: Target, script: string, options: { timeoutMs: number; onLine?: Log }) {
    return run(docker, ["exec", "-u", target.remoteUser, target.containerId, "bash", "-lc", USE_SSH_AGENT + script], {
      env: toolEnv([docker]),
      ...options,
    });
  }

  private async daemonInfo(docker: string, target: Target): Promise<DaemonInfo | null> {
    try {
      const result = await this.exec(
        docker,
        target,
        "command -v paseo >/dev/null 2>&1 || exit 42; paseo daemon status --json",
        { timeoutMs: 20_000 },
      );
      if (result.code === 42) return { installed: false, running: false, serverId: null, listenPort: null };
      try {
        const parsed = JSON.parse(result.stdout) as { localDaemon?: string; serverId?: string; listen?: string };
        return {
          installed: true,
          running: parsed.localDaemon === "running",
          serverId: parsed.serverId ?? null,
          listenPort: listenPortOf(parsed.listen),
        };
      } catch {
        return { installed: true, running: false, serverId: null, listenPort: null };
      }
    } catch (error) {
      console.error("[devcontainer-host] daemon status failed:", error);
      return null;
    }
  }

  private async execute(repoPath: string, job: Job, file: string): Promise<void> {
    const log: Log = (line) => {
      // devcontainer CLI prefixes every line with an ISO timestamp.
      const text = line.replace(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]\s?/, "").trim();
      if (!text) return;
      appendLog(file, text);
      job.log.push(text);
      if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
    };
    const phase = (text: string) => {
      job.phase = text;
      log(`▸ ${text}`);
    };

    const { settings, tools, candidates } = await this.discover();
    const candidate = candidates.find((entry) => entry.repoPath === repoPath);
    if (!candidate) throw new Error(`No dev container config or container for ${repoPath}`);
    if (!tools.docker) throw new Error("docker not found. Install Docker Desktop or set the docker path in settings.");
    const docker = tools.docker;
    const existing = candidate.container
      ? { containerId: candidate.container.id, remoteUser: candidate.container.remoteUser }
      : null;
    const requireRunning = (): Target => {
      if (!existing || !candidate.container?.running) throw new Error("The container is not running");
      return existing;
    };

    switch (job.action) {
      case "stop": {
        if (!existing) throw new Error("The container does not exist");
        phase("Stopping container");
        this.forwarder.setDaemonRunning(repoPath, false);
        const result = await run(docker, ["stop", existing.containerId], {
          env: toolEnv([docker]),
          timeoutMs: 120_000,
          onLine: log,
        });
        if (result.code !== 0) throw new Error(result.stderr.trim() || "docker stop failed");
        return;
      }
      case "start":
      case "rebuild":
      case "rebuild-no-cache": {
        const rebuild = job.action === "start" ? null : { noCache: job.action === "rebuild-no-cache" };
        const target = await this.up(settings, tools, candidate, rebuild, phase, log);
        // The container is up either way; a missing Paseo only leaves Install Paseo to press.
        await this.ensureDaemon(settings, docker, target, repoPath, phase, log, { optional: true });
        return;
      }
      case "start-daemon":
        await this.ensureDaemon(settings, docker, requireRunning(), repoPath, phase, log);
        return;
      case "install-paseo":
        await this.installPaseo(settings, docker, requireRunning(), phase, log);
        return;
    }
  }

  private async up(
    settings: DevcontainerSettings,
    tools: Tools,
    candidate: Candidate,
    rebuild: { noCache: boolean } | null,
    phase: (text: string) => void,
    log: Log,
  ): Promise<Target> {
    if (!tools.devcontainer) {
      throw new Error("devcontainer CLI not found. Run `npm install -g @devcontainers/cli` or set its path in settings.");
    }
    const docker = tools.docker as string;
    phase(rebuild ? "Rebuilding dev container" : "Starting dev container");
    const args = ["up", "--workspace-folder", candidate.repoPath];
    if (candidate.configFile) args.push("--config", candidate.configFile);
    if (rebuild) args.push("--remove-existing-container");
    if (rebuild?.noCache) args.push("--build-no-cache");
    if (settings.dotfilesRepository) {
      args.push("--dotfiles-repository", settings.dotfilesRepository);
      if (settings.dotfilesTargetPath) args.push("--dotfiles-target-path", settings.dotfilesTargetPath);
      if (settings.dotfilesInstallCommand) args.push("--dotfiles-install-command", settings.dotfilesInstallCommand);
    }
    for (const mount of planPaseoHome(settings, candidate.repoPath, log)?.mounts ?? []) args.push("--mount", mount);
    const agentSocket = sshAgentSource(settings, log);
    if (agentSocket) {
      args.push("--mount", `type=bind,source=${agentSocket},target=${SSH_AGENT_TARGET}`);
      args.push("--remote-env", `SSH_AUTH_SOCK=${SSH_AGENT_TARGET}`);
    }
    const result = await run(tools.devcontainer, args, {
      env: toolEnv([tools.devcontainer, docker]),
      timeoutMs: UP_TIMEOUT_MS,
      onLine: (line) => {
        if (!line.startsWith("{")) log(line);
      },
    });
    const outcome = parseOutcome(result.stdout);
    if (result.code !== 0 || outcome?.outcome !== "success" || !outcome.containerId) {
      throw new Error(outcome?.message ?? (lastLine(result.stderr) || "devcontainer up failed"));
    }
    const target = {
      containerId: outcome.containerId.slice(0, 12),
      remoteUser: outcome.remoteUser ?? candidate.container?.remoteUser ?? "root",
    };
    if (agentSocket) await this.openSshAgent(docker, target, log);
    return target;
  }

  // The socket in Docker's VM is root-only; containers usually run as another user.
  private async openSshAgent(docker: string, target: Target, log: Log): Promise<void> {
    const script =
      `[ -S ${SSH_AGENT_TARGET} ] || exit 42; ` +
      (process.platform === "darwin" ? `chmod 666 ${SSH_AGENT_TARGET}` : "true");
    const result = await run(docker, ["exec", "-u", "root", target.containerId, "sh", "-c", script], {
      env: toolEnv([docker]),
      timeoutMs: 20_000,
    });
    if (result.code === 42) log("SSH agent not mounted in this container; rebuild it to forward the agent.");
    else if (result.code !== 0) log(`Could not open the SSH agent socket: ${lastLine(result.stderr)}`);
  }

  private async ensureDaemon(
    settings: DevcontainerSettings,
    docker: string,
    target: Target,
    repoPath: string,
    phase: (text: string) => void,
    log: Log,
    { optional = false }: { optional?: boolean } = {},
  ): Promise<void> {
    phase("Checking Paseo in the container");
    const guard = await this.linkRepo(settings, docker, target, repoPath, log);
    let info = await this.daemonInfo(docker, target);
    if (!info) throw new Error("Could not query Paseo in the container");
    if (!info.installed) {
      if (!settings.autoInstallPaseo) {
        if (!optional) throw new Error("Paseo is not installed in the container. Use Install Paseo.");
        log("Paseo is not installed in the container; use Install Paseo, or turn on Install automatically.");
        return;
      }
      await this.installPaseo(settings, docker, target, phase, log);
      info = await this.daemonInfo(docker, target);
    }
    if (info?.listenPort) this.forwarder.setDaemonPort(repoPath, info.listenPort);
    if (info?.running) {
      this.forwarder.setDaemonRunning(repoPath, true);
      log(`Daemon already running (${info.serverId ?? "unknown server"})`);
      this.checkServerId(repoPath, info, log);
      if (guard) await this.prepareCompanion(docker, target, guard, true, log);
      return;
    }
    await this.linkPaseoHome(settings, docker, target, repoPath, log);
    if (guard) await this.prepareCompanion(docker, target, guard, false, log);
    phase("Starting Paseo daemon");
    // `paseo daemon start` detaches its supervisor, so it outlives this exec.
    const result = await this.exec(
      docker,
      target,
      'if [ -n "${PASEO_HOME:-}" ]; then mkdir -p "$PASEO_HOME"; fi; paseo daemon start',
      { timeoutMs: DAEMON_START_TIMEOUT_MS, onLine: log },
    );
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || "paseo daemon start failed");
    phase("Waiting for the daemon");
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      info = await this.daemonInfo(docker, target);
      if (info?.running) {
        if (info.listenPort) this.forwarder.setDaemonPort(repoPath, info.listenPort);
        this.forwarder.setDaemonRunning(repoPath, true);
        log(`Daemon running (${info.serverId ?? "unknown server"})`);
        this.checkServerId(repoPath, info, log);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1_000));
    }
    throw new Error("The Paseo daemon did not report running within 60 s");
  }

  // Before the daemon starts: ~/.paseo becomes the mounted home, whose worktrees use its shared path.
  private async linkPaseoHome(
    settings: DevcontainerSettings,
    docker: string,
    target: Target,
    repoPath: string,
    log: Log,
  ): Promise<void> {
    const plan = planPaseoHome(settings, repoPath, log);
    if (!plan) return;
    const result = await this.exec(docker, target, linkHomeScript(plan.home), { timeoutMs: 120_000 });
    switch (result.code) {
      case 0:
        pinWorktreesRoot(plan.home, log);
        log(`Paseo home: ${plan.home}`);
        return;
      case 43:
        log("This container was created without the persistent Paseo home; rebuild it to keep sessions across rebuilds.");
        return;
      case 44:
        log("The dev container config sets PASEO_HOME; leaving the Paseo home as configured.");
        return;
      case 45:
        log(`Both ~/.paseo and ${plan.home} hold a Paseo daemon's data; keeping ~/.paseo. Merge them by hand to persist it.`);
        return;
      default:
        log(`Could not link the Paseo home: ${lastLine(result.stderr) || `exit ${result.code}`}`);
    }
  }

  // On every daemon start, as root: the repository's path on this machine becomes a link to its
  // folder in the container, so worktrees whose .git a repair here rewrote still open there.
  // Lost on rebuild, so it is made again each time. Returns the guard's target when it applies.
  private async linkRepo(
    settings: DevcontainerSettings,
    docker: string,
    target: Target,
    repoPath: string,
    log: Log,
  ): Promise<GuardTarget | null> {
    if (!settings.guardWorktrees) return null;
    // Read again: `devcontainer up` may have just created the container.
    const containers = await listDockerContainers(docker).catch(() => []);
    const container = containers.find((entry) => entry.id === target.containerId);
    if (!container?.workspaceFolder) {
      log("Worktree guard: the repository's folder in the container is unknown; not linking its path.");
      return null;
    }
    const script = repoLinkScript(hostRepoPaths(repoPath), container.workspaceFolder);
    const result = await run(docker, ["exec", "-u", "root", target.containerId, "sh", "-c", script], {
      env: toolEnv([docker]),
      timeoutMs: 20_000,
    });
    if (result.code !== 0) log(`Worktree guard: could not link ${repoPath} in the container: ${lastLine(result.stderr)}`);
    for (const line of result.stderr.split("\n")) {
      if (line.startsWith("blocked ")) log(`Worktree guard: ${line.slice(8)} exists in the container and is not a link; leaving it.`);
    }
    return guardTarget(settings, repoPath, container);
  }

  // Copies the companion plugin into the container's Paseo home and registers it; a running
  // daemon reloads it when its files changed.
  private async prepareCompanion(docker: string, target: Target, guard: GuardTarget, running: boolean, log: Log) {
    let install: ReturnType<typeof installCompanion>;
    try {
      install = installCompanion(guard, running, log);
    } catch (error) {
      log(`Worktree guard: could not install the companion plugin: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!install) return;
    if (!install.registered) {
      log("Worktree guard: the container's companion plugin starts with its Paseo daemon's next start.");
      return;
    }
    if (running && install.changed) {
      const result = await this.exec(docker, target, `paseo plugin reload ${COMPANION_ID}`, { timeoutMs: 60_000 });
      if (result.code !== 0) log(`Worktree guard: could not reload the companion plugin: ${lastLine(result.stderr)}`);
    }
  }

  private checkServerId(repoPath: string, info: DaemonInfo, log: Log) {
    if (!info.serverId) return;
    const expected = this.knownServerIds.get(repoPath);
    if (expected && expected !== info.serverId) {
      log(`Warning: daemon server ID ${info.serverId} differs from ${expected}; pair the new host in Paseo.`);
    }
    this.knownServerIds.set(repoPath, info.serverId);
  }

  private async installPaseo(
    settings: DevcontainerSettings,
    docker: string,
    target: Target,
    phase: (text: string) => void,
    log: Log,
  ): Promise<void> {
    phase("Installing Paseo in the container");
    const result = await this.exec(docker, target, settings.installCommand, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      onLine: log,
    });
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || "Paseo install failed");
  }
}

interface UpOutcome {
  outcome?: string;
  message?: string;
  containerId?: string;
  remoteUser?: string;
}

function parseOutcome(stdout: string): UpOutcome | null {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line) as UpOutcome;
  } catch {
    return null;
  }
}

// "127.0.0.1:6767" or "[::1]:6767"; a socket path has no port.
function listenPortOf(listen: string | undefined): number | null {
  const match = /:(\d+)$/.exec(listen ?? "");
  return match?.[1] ? Number(match[1]) : null;
}

function sshAgentSource(settings: DevcontainerSettings, log: Log): string | null {
  if (!settings.forwardSshAgent) return null;
  if (settings.sshAgentSocket) return settings.sshAgentSocket;
  if (process.platform === "darwin") return DOCKER_VM_AGENT_SOCKET;
  const socket = process.env.SSH_AUTH_SOCK;
  if (socket && existsSync(socket)) return socket;
  log("No SSH agent found ($SSH_AUTH_SOCK); the container will not get one.");
  return null;
}

function logFile(repoPath: string): string {
  let hash = 5381;
  for (let index = 0; index < repoPath.length; index++) hash = ((hash * 33) ^ repoPath.charCodeAt(index)) >>> 0;
  const tail = (repoPath.split("/").filter(Boolean).pop() ?? "repo").replace(/[^\w.-]+/g, "-");
  return join(LOG_DIR, `${tail}-${hash.toString(36)}.log`);
}

// A new file rather than a truncation, so a following `tail -F` starts over cleanly.
function resetLog(file: string, header: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(`${file}.new`, `${header}\n`);
    renameSync(`${file}.new`, file);
  } catch (error) {
    console.error("[devcontainer-host] could not create the job log:", error);
  }
}

function appendLog(file: string, line: string): void {
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // The in-memory tail still shows in the app.
  }
}

// This daemon's Paseo server ID, so the app can name the host as it does elsewhere.
function readServerId(): string | null {
  try {
    return readFileSync(join(hostPaseoHome(), "server-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}
