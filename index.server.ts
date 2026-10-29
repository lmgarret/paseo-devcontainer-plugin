import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { openShellRpc, projectIconRpc, runActionRpc, settingsDefinition, statusRpc } from "./shared/contract";
import type { PaseoCatalog, WorkspaceRef } from "./server/discovery";
import { DevcontainerController } from "./server/controller";
import { resolveTool } from "./server/process";

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

  const unsubscribe = settings.subscribe(() => controller.invalidate());

  console.log(
    `[devcontainer-host] docker=${resolveTool("docker", "") ?? "missing"} devcontainer=${resolveTool("devcontainer", "") ?? "missing"}`,
  );
  server.handle(statusRpc, (_input, context) => {
    paseo = context.paseo;
    return controller.status();
  });
  server.handle(runActionRpc, ({ repoPath, action }, context) => {
    paseo = context.paseo;
    return { job: controller.startAction(repoPath, action) };
  });
  server.handle(projectIconRpc, async ({ projectId }) => ({ icon: await controller.projectIcon(projectId) }));
  server.handle(openShellRpc, async ({ repoPath }, context) => {
    paseo = context.paseo;
    const shell = await controller.shellCommand(repoPath);
    // Terminals belong to a workspace: reuse the one for this folder, or open it.
    const workspace = await context.paseo.workspaces.open({ cwd: repoPath });
    const terminal = await workspace.terminals.create({
      name: shell.name,
      command: shell.command,
      args: shell.args,
    });
    return { workspaceId: workspace.id, terminalId: terminal.id };
  });
  return () => unsubscribe();
}
