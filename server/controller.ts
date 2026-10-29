import type { Action, Container, DevcontainerSettings, Job, Status } from "../shared/contract";
import { type Candidate, listDockerContainers, mergeCandidates, type PaseoCatalog } from "./discovery";
import { type ProjectIcon, readProjectIcon } from "./icons";
import { resolveTool, run, toolEnv } from "./process";

const LOG_LINES = 40;
const STATUS_CACHE_MS = 2_000;
const DAEMON_START_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
// First builds pull images and run features; keep a generous ceiling so a hung build still ends.
const UP_TIMEOUT_MS = 45 * 60_000;

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
    // Jobs change faster than the cache; always return the live ones.
    return {
      ...status,
      containers: status.containers.map((container) => ({ ...container, job: this.jobSnapshot(container.repoPath) })),
    };
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
    void this.execute(repoPath, job)
      .then(
        () => {
          job.state = "succeeded";
          job.phase = "Done";
        },
        (error: unknown) => {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : String(error);
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
    args.push(container.id, "sh", "-c", 'if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi');
    return { name: `${candidate.name} (container)`, command: tools.docker, args };
  }

  async projectIcon(projectId: string): Promise<ProjectIcon | null> {
    const project = this.catalog.projects.find((entry) => entry.projectId === projectId);
    return project ? readProjectIcon(project) : null;
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
        const detected = daemon?.serverId ?? container?.paseoHome.serverId ?? null;
        if (detected) this.knownServerIds.set(candidate.repoPath, detected);
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
          serverId:
            detected || this.knownServerIds.get(candidate.repoPath) || null,
          paseoHomePersistent: container ? container.paseoHome.persistent : null,
          paseoInstalled: daemon ? daemon.installed : null,
          daemonRunning: daemon?.installed ? daemon.running : null,
          job: null,
        };
      }),
    );
    return { containers, dockerError, tools };
  }

  private exec(docker: string, target: Target, script: string, options: { timeoutMs: number; onLine?: Log }) {
    return run(docker, ["exec", "-u", target.remoteUser, target.containerId, "bash", "-lc", script], {
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
      if (result.code === 42) return { installed: false, running: false, serverId: null };
      try {
        const parsed = JSON.parse(result.stdout) as { localDaemon?: string; serverId?: string };
        return { installed: true, running: parsed.localDaemon === "running", serverId: parsed.serverId ?? null };
      } catch {
        return { installed: true, running: false, serverId: null };
      }
    } catch (error) {
      console.error("[devcontainer-host] daemon status failed:", error);
      return null;
    }
  }

  private async execute(repoPath: string, job: Job): Promise<void> {
    const log: Log = (line) => {
      // devcontainer CLI prefixes every line with an ISO timestamp.
      const text = line.replace(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]\s?/, "").trim();
      if (!text) return;
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
        const result = await run(docker, ["stop", existing.containerId], {
          env: toolEnv([docker]),
          timeoutMs: 120_000,
          onLine: log,
        });
        if (result.code !== 0) throw new Error(result.stderr.trim() || "docker stop failed");
        return;
      }
      case "start":
      case "rebuild": {
        const target = await this.up(settings, tools, candidate, job.action === "rebuild", phase, log);
        await this.ensureDaemon(settings, docker, target, repoPath, phase, log);
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
    rebuild: boolean,
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
    if (settings.dotfilesRepository) {
      args.push("--dotfiles-repository", settings.dotfilesRepository);
      if (settings.dotfilesTargetPath) args.push("--dotfiles-target-path", settings.dotfilesTargetPath);
      if (settings.dotfilesInstallCommand) args.push("--dotfiles-install-command", settings.dotfilesInstallCommand);
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
    return {
      containerId: outcome.containerId.slice(0, 12),
      remoteUser: outcome.remoteUser ?? candidate.container?.remoteUser ?? "root",
    };
  }

  private async ensureDaemon(
    settings: DevcontainerSettings,
    docker: string,
    target: Target,
    repoPath: string,
    phase: (text: string) => void,
    log: Log,
  ): Promise<void> {
    phase("Checking Paseo in the container");
    let info = await this.daemonInfo(docker, target);
    if (!info) throw new Error("Could not query Paseo in the container");
    if (!info.installed) {
      if (!settings.autoInstallPaseo) {
        throw new Error("Paseo is not installed in the container. Use Install Paseo.");
      }
      await this.installPaseo(settings, docker, target, phase, log);
      info = await this.daemonInfo(docker, target);
    }
    if (info?.running) {
      log(`Daemon already running (${info.serverId ?? "unknown server"})`);
      this.checkServerId(repoPath, info, log);
      return;
    }
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
        log(`Daemon running (${info.serverId ?? "unknown server"})`);
        this.checkServerId(repoPath, info, log);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1_000));
    }
    throw new Error("The Paseo daemon did not report running within 60 s");
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

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}
