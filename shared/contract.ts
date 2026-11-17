import { defineRpc, defineSettings, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

// npm 11 skips dependency install scripts unless allowed; node-pty needs its build for terminals.
export const DEFAULT_INSTALL_COMMAND = "npm install -g --allow-scripts=esbuild,node-pty,msgpackr-extract @getpaseo/cli";

const generalShape = {
  // Start and Rebuild install Paseo when the container lacks it.
  autoInstallPaseo: z.boolean().default(true),
  // Runs in the container as the remote user with `bash -lc`.
  installCommand: z.string().default(DEFAULT_INSTALL_COMMAND),
  // Installs this machine's enabled plugins in each container's daemon, through its companion plugin
  // when the Paseo home is kept here; only adds, never removes.
  mirrorHostPlugins: z.boolean().default(true),
  // Plugin IDs left out of the mirror.
  mirrorExcludedPlugins: z.array(z.string()).default([]),
  // Keeps each container's Paseo home in a folder on this machine, mounted at the same path, so
  // sessions survive rebuilds and git worktrees resolve on both sides.
  persistPaseoHome: z.boolean().default(true),
  // Empty: $PASEO_HOME/plugin-data/devcontainer-host/homes. One subfolder per repository.
  paseoHomesDir: z.string().default(""),
  // Snapshots worktree records shared with containers and restores what a prune or repair on the
  // other side breaks; the companion plugin in container daemons repairs there. Needs persistPaseoHome.
  guardWorktrees: z.boolean().default(true),
  // Empty: resolved from PATH and common install locations.
  dockerPath: z.string().default(""),
  devcontainerPath: z.string().default(""),
  // Mirrors VS Code's dotfiles settings; only applied when a container is created.
  dotfilesRepository: z.string().default(""),
  dotfilesTargetPath: z.string().default(""),
  dotfilesInstallCommand: z.string().default(""),
  // Mounts the host's SSH agent into created containers, like VS Code's agent forwarding.
  forwardSshAgent: z.boolean().default(true),
  // Empty: Docker Desktop's and OrbStack's agent socket on macOS, $SSH_AUTH_SOCK on Linux.
  sshAgentSocket: z.string().default(""),
  // Builds open their log in a terminal of the folder's workspace.
  openBuildLogs: z.boolean().default(true),
  // Each container's daemon gets a stable local port, saved per repository, from this one up.
  forwardDaemon: z.boolean().default(true),
  daemonPortStart: z.number().int().min(1024).max(65535).default(6768),
  // Other ports listening in a container, opened on the same local port when free.
  forwardPorts: z.boolean().default(true),
  ignoredPorts: z.array(z.number().int()).default([]),
  // Per repository: ports forwarded by hand, and detected ports to stop forwarding.
  repoPorts: z
    .record(
      z.string(),
      z.object({
        forwarded: z.array(z.number().int()).default([]),
        ignored: z.array(z.number().int()).default([]),
      }),
    )
    .default({}),
};

export const settingsDefinition = defineSettings({
  id: "devcontainer",
  scope: "host",
  version: 2,
  schema: z.object({
    ...generalShape,
    // Offer every Paseo project on this host that has a dev container config.
    scanPaseoProjects: z.boolean().default(true),
    // Repositories to offer even when they are not Paseo projects.
    extraRepoPaths: z.array(z.string()).default([]),
    // Repository paths kept out of the sidebar popover.
    hidden: z.array(z.string()).default([]),
    // Project groups folded on the "All dev containers" page.
    collapsedGroups: z.array(z.string()).default([]),
  }),
  migrate(values, fromVersion) {
    if (fromVersion !== 1 || typeof values !== "object" || values === null) return {};
    const v1 = values as Record<string, unknown>;
    const general = Object.fromEntries(
      Object.keys(generalShape).filter((key) => key in v1).map((key) => [key, v1[key]]),
    );
    const repoPath = typeof v1.repoPath === "string" ? v1.repoPath : "";
    return { ...general, extraRepoPaths: repoPath ? [repoPath] : [] };
  },
});

export type DevcontainerSettings = z.output<typeof settingsDefinition.schema>;

export const actionSchema = z.enum(["start", "rebuild", "rebuild-no-cache", "stop", "start-daemon", "install-paseo"]);
export type Action = z.infer<typeof actionSchema>;

export const ACTION_LABELS: Record<Action, string> = {
  start: "Start",
  rebuild: "Rebuild",
  "rebuild-no-cache": "Rebuild without cache",
  stop: "Stop",
  "start-daemon": "Start Paseo daemon",
  "install-paseo": "Install Paseo",
};

const jobSchema = z.object({
  id: z.number(),
  action: actionSchema,
  state: z.enum(["running", "succeeded", "failed"]),
  phase: z.string(),
  log: z.array(z.string()),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

const forwardSchema = z.object({
  kind: z.enum(["daemon", "app"]),
  containerPort: z.number(),
  // Local port on this machine; null while it cannot be bound.
  hostPort: z.number().nullable(),
  error: z.string().nullable(),
  // Command line of the listening process in the container, when known.
  process: z.string().nullable(),
  // Forwarded by hand rather than detected.
  manual: z.boolean(),
  // Something listens on the port in the container; a port forwarded by hand may not yet.
  listening: z.boolean(),
});
export type Forward = z.infer<typeof forwardSchema>;

export const GUARD_DOCS_URL = "https://github.com/lmgarret/paseo-devcontainer-plugin/blob/main/docs/worktrees.md";

const sideStateSchema = z.enum(["works", "fails", "at-risk", "unseen"]);

const guardWorktreeSchema = z.object({
  name: z.string(),
  folder: z.string(),
  // The Paseo workspace's title on either side, when the folder is one.
  title: z.string().nullable(),
  // Git works, fails, or a prune there would delete its record; null when that side was not checked.
  sides: z.object({ host: sideStateSchema.nullable(), container: sideStateSchema.nullable() }),
  state: z.enum(["safe", "at-risk", "broken"]),
  problem: z.string().nullable(),
  // What can repair it: Restore from its snapshot, Make safe by naming it with a path both sides
  // see, or Recreate its record on a branch you pick.
  fix: z.enum(["restore", "share", "recreate"]).nullable(),
  // For recreate: branches it was likely on, most likely first, with their last commit.
  branches: z.array(z.object({ name: z.string(), date: z.string(), subject: z.string() })),
  // For make safe: the folder's path both sides see, which the record will use.
  target: z.string().nullable(),
});

const guardRestoreSchema = z.object({
  at: z.number(),
  // Where the repair ran: this machine's plugin, or the container's companion plugin.
  side: z.enum(["host", "container"]),
  trigger: z.string(),
  folder: z.string(),
  title: z.string().nullable(),
  error: z.string().nullable(),
});

// Worktrees of a repository used both here and in its container.
const guardSchema = z.object({
  checkedAt: z.number().nullable(),
  // The container was running and checked too; otherwise only this machine's view.
  containerChecked: z.boolean(),
  error: z.string().nullable(),
  safe: z.number(),
  // Every worktree, safe ones included, problems first.
  worktrees: z.array(guardWorktreeSchema),
  // Repairs of the last day, newest first.
  restored: z.array(guardRestoreSchema),
  // The container daemon runs the companion plugin that repairs after its own archives.
  companion: z.enum(["installed", "pending", "off"]),
});
export type Guard = z.infer<typeof guardSchema>;
export type GuardWorktree = z.infer<typeof guardWorktreeSchema>;

const containerSchema = z.object({
  // Identity: the repository folder, as in the `devcontainer.local_folder` label.
  repoPath: z.string(),
  name: z.string(),
  source: z.enum(["project", "container", "extra"]),
  // The Paseo project on this host the folder belongs to, as a root checkout or a workspace.
  project: z
    .object({
      id: z.string(),
      key: z.string().nullable(),
      name: z.string(),
      rootPath: z.string(),
      // Changes when the icon does, for client caching.
      iconRevision: z.string(),
    })
    .nullable(),
  // This host's Paseo workspace for the folder, when there is one.
  workspace: z.object({ id: z.string(), title: z.string() }).nullable(),
  branch: z.string().nullable(),
  // The folder's path inside the container.
  workspaceFolder: z.string().nullable(),
  hidden: z.boolean(),
  docker: z.enum(["running", "stopped", "missing"]),
  containerId: z.string().nullable(),
  containerName: z.string().nullable(),
  // When the container last started, in ms since the epoch.
  startedAt: z.number().nullable(),
  // Shares this machine's network through Docker, so only its daemon is forwarded.
  hostNetwork: z.boolean(),
  // Paired Paseo host: daemon report, or the server-id file in a mounted Paseo home.
  serverId: z.string().nullable(),
  // False when the Paseo home is inside the container and a rebuild resets its identity.
  paseoHomePersistent: z.boolean().nullable(),
  // Null when the container is not running or the check failed.
  paseoInstalled: z.boolean().nullable(),
  daemonRunning: z.boolean().nullable(),
  forwards: z.array(forwardSchema),
  job: jobSchema.nullable(),
  // Null when the worktree guard does not apply: off, no managed Paseo home, or not a main checkout.
  guard: guardSchema.nullable(),
});
export type Container = z.infer<typeof containerSchema>;

// Something the daemon wants people to know once, such as a workspace created in a shared repository.
const noticeSchema = z.object({ id: z.string(), at: z.number(), repoPath: z.string(), message: z.string() });
export type Notice = z.infer<typeof noticeSchema>;

const statusSchema = z.object({
  containers: z.array(containerSchema),
  dockerError: z.string().nullable(),
  tools: z.object({ docker: z.string().nullable(), devcontainer: z.string().nullable() }),
  notices: z.array(noticeSchema),
  // The machine this plugin's daemon runs on: its name and Node's platform, for labels and icons.
  // `serverId` names the Paseo host, whose label the app shows.
  machine: z.object({ name: z.string(), platform: z.string(), serverId: z.string().nullable() }),
});
export type Status = z.infer<typeof statusSchema>;

export const statusRpc = defineRpc({
  name: "status.get",
  input: z.object({}),
  output: statusSchema,
});

// A snapshot on subscribe, then one whenever it changes; `error` when the daemon cannot compute it.
export const statusSubscription = defineSubscription({
  name: "status.watch",
  // The app bumps `attempt` to subscribe again after the subscription closed.
  input: z.object({ attempt: z.number().int().optional() }),
  event: z.object({ status: statusSchema.nullable(), error: z.string().nullable() }),
});

export const runActionRpc = defineRpc({
  name: "action.run",
  input: z.object({ repoPath: z.string(), action: actionSchema }),
  // The workspace holding the build log terminal, when it was opened.
  output: z.object({ job: jobSchema, logWorkspaceId: z.string().nullable() }),
});

export const openLogsRpc = defineRpc({
  name: "logs.open",
  input: z.object({ repoPath: z.string() }),
  output: z.object({ workspaceId: z.string(), terminalId: z.string() }),
});

// Forgets a finished job, so a failed build stops asking for attention.
export const dismissJobRpc = defineRpc({
  name: "job.dismiss",
  input: z.object({ repoPath: z.string() }),
  output: z.object({}),
});

export const openShellRpc = defineRpc({
  name: "shell.open",
  input: z.object({ repoPath: z.string() }),
  output: z.object({ workspaceId: z.string(), terminalId: z.string() }),
});

export const projectIconRpc = defineRpc({
  name: "project.icon",
  input: z.object({ projectId: z.string() }),
  output: z.object({ icon: z.object({ data: z.string(), mimeType: z.string() }).nullable() }),
});

// docs/worktrees.md as installed with the daemon's copy of the plugin; null when unreadable.
export const worktreesGuideRpc = defineRpc({
  name: "guide.worktrees",
  input: z.object({}),
  output: z.object({ markdown: z.string().nullable() }),
});

// Checks the repository's worktrees now and repairs what can be repaired.
// Without a name: every restore and make-safe fix. With one: that worktree's fix, any kind;
// recreate needs a branch.
export const guardRestoreRpc = defineRpc({
  name: "guard.restore",
  input: z.object({ repoPath: z.string(), name: z.string().optional(), branch: z.string().optional() }),
  output: z.object({ restored: z.number(), failed: z.number(), remaining: z.number() }),
});

// Tracked files whose content differs from the branch a record would be recreated on: what
// `git status` shows as changes afterwards.
export const guardPreviewRpc = defineRpc({
  name: "guard.preview",
  input: z.object({ repoPath: z.string(), name: z.string(), branch: z.string() }),
  output: z.object({ files: z.array(z.string()), total: z.number() }),
});
