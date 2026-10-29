import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  type Action,
  dismissJobRpc,
  openLogsRpc,
  openShellRpc,
  projectIconRpc,
  runActionRpc,
  settingsDefinition,
  statusRpc,
} from "./shared/contract";
import type { PaseoCatalog, WorkspaceRef } from "./server/discovery";
import { DevcontainerController } from "./server/controller";
import { resolveTool } from "./server/process";

const FORWARD_INTERVAL_MS = 3_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  // The SDK connection only reaches us through handler contexts; keep the latest for discovery.
  let paseo: PluginHandlerContext["paseo"] | null = null;

  const controller = new DevcontainerController(
    async () => {
      const current = await settings.read();
      if (current.status !== "ready") throw new Error(`Plugin settings are invalid: ${current.error}`);
      return current.values;
    },
    async (): Promise<PaseoCatalog> => {
      if (!paseo) return { projects: [], workspaces: [] };
      const { projects } = await paseo.projects.list();
      const workspaces: WorkspaceRef[] = [];
      let cursor: string | undefined;
      // Bounded: a few hundred workspaces at most.
      for (let page = 0; page < 10; page++) {
        const result = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const entry of result.entries) {
          if (!entry.workspaceDirectory) continue;
          workspaces.push({
            id: entry.id,
            projectId: entry.projectId,
            directory: entry.workspaceDirectory,
            title: entry.title || entry.name,
            branch: entry.gitRuntime?.currentBranch ?? null,
          });
        }
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      return {
        projects: projects.map((project) => ({
          projectId: project.projectId,
          projectKey: project.projectKey ?? null,
          rootPath: project.projectRootPath,
          name: project.projectCustomName || project.projectDisplayName,
          customIconRevision: project.projectCustomIconRevision ?? null,
          iconRevision: project.projectIconRevision ?? null,
        })),
        workspaces,
      };
    },
  );

  // Forwarding runs whether or not a client is open: the app needs the daemon ports to connect.
  let syncing = false;
  const syncForwards = () => {
    if (syncing) return;
    syncing = true;
    controller
      .syncForwards()
      .catch((error: unknown) => console.error("[devcontainer-host] port forwarding failed:", error))
      .finally(() => {
        syncing = false;
      });
  };
  const forwardTimer = setInterval(syncForwards, FORWARD_INTERVAL_MS);
  // Forwarding a port by hand or stopping one answers right away rather than on the next tick.
  const unsubscribe = settings.subscribe(() => {
    controller.invalidate();
    syncForwards();
  });

  console.log(
    `[devcontainer-host] docker=${resolveTool("docker", "") ?? "missing"} devcontainer=${resolveTool("devcontainer", "") ?? "missing"}`,
  );
  server.handle(statusRpc, (_input, context) => {
    paseo = context.paseo;
    return controller.status();
  });
  // Terminals belong to a workspace: reuse the one for this folder, or open it.
  const openLogs = async (api: PluginHandlerContext["paseo"], repoPath: string) => {
    const log = controller.logCommand(repoPath);
    const workspace = await api.workspaces.open({ cwd: repoPath });
    // One log terminal per folder: replace an earlier one so it starts from the top.
    const { entries } = await workspace.terminals.list();
    await Promise.all(
      entries.filter((entry) => entry.name === log.name).map((entry) => api.terminals.ref(entry).kill().catch(() => {})),
    );
    const terminal = await workspace.terminals.create(log);
    return { workspaceId: workspace.id, terminalId: terminal.id };
  };
  // Builds are slow and fail in ways worth reading; a start of an existing container is quick.
  const builds = async (repoPath: string, action: Action) =>
    action === "rebuild" || action === "rebuild-no-cache" || (action === "start" && (await controller.containerMissing(repoPath)));

  server.handle(runActionRpc, async ({ repoPath, action }, context) => {
    paseo = context.paseo;
    const current = await settings.read();
    const showLog = current.status === "ready" && current.values.openBuildLogs && (await builds(repoPath, action));
    const job = controller.startAction(repoPath, action);
    let logWorkspaceId: string | null = null;
    if (showLog) {
      try {
        logWorkspaceId = (await openLogs(context.paseo, repoPath)).workspaceId;
      } catch (error) {
        console.error("[devcontainer-host] could not open the build log:", error);
      }
    }
    return { job, logWorkspaceId };
  });
  server.handle(openLogsRpc, ({ repoPath }, context) => {
    paseo = context.paseo;
    return openLogs(context.paseo, repoPath);
  });
  server.handle(dismissJobRpc, ({ repoPath }) => {
    controller.dismiss(repoPath);
    return {};
  });
  server.handle(projectIconRpc, async ({ projectId }) => ({ icon: await controller.projectIcon(projectId) }));
  server.handle(openShellRpc, async ({ repoPath }, context) => {
    paseo = context.paseo;
    const shell = await controller.shellCommand(repoPath);
    const workspace = await context.paseo.workspaces.open({ cwd: repoPath });
    const terminal = await workspace.terminals.create({
      name: shell.name,
      command: shell.command,
      args: shell.args,
    });
    return { workspaceId: workspace.id, terminalId: terminal.id };
  });
  return () => {
    clearInterval(forwardTimer);
    controller.close();
    unsubscribe();
  };
}
