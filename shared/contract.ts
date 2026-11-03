import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// npm 11 skips dependency install scripts unless allowed; node-pty needs its build for terminals.
export const DEFAULT_INSTALL_COMMAND = "npm install -g --allow-scripts=esbuild,node-pty,msgpackr-extract @getpaseo/cli";

const generalShape = {
  // Start and Rebuild install Paseo when the container lacks it.
  autoInstallPaseo: z.boolean().default(true),
  // Runs in the container as the remote user with `bash -lc`.
  installCommand: z.string().default(DEFAULT_INSTALL_COMMAND),
  // Keeps each container's Paseo home in a folder on this machine, mounted at the same path, so
  // sessions survive rebuilds and git worktrees resolve on both sides.
  persistPaseoHome: z.boolean().default(true),
  // Empty: $PASEO_HOME/plugin-data/devcontainer-host/homes. One subfolder per repository.
  paseoHomesDir: z.string().default(""),
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
});
export type Container = z.infer<typeof containerSchema>;

const statusSchema = z.object({
  containers: z.array(containerSchema),
  dockerError: z.string().nullable(),
  tools: z.object({ docker: z.string().nullable(), devcontainer: z.string().nullable() }),
});
export type Status = z.infer<typeof statusSchema>;

export const statusRpc = defineRpc({
  name: "status.get",
  input: z.object({}),
  output: statusSchema,
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
