import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { ContainersScreen, workspaceParams } from "./client/screen";
import { DevcontainerSettingsScreen } from "./client/settings";
import { DevcontainerSidebarItem, SCREEN_ID, setSettingsOpener } from "./client/sidebar";
import { ACTION_META } from "./client/actions";
import { DEVCONTAINERS_ICON } from "./client/devcontainers-icon";
import { GUIDE_SCREEN_ID, GuideScreen, setGuideOpener } from "./client/guide";
import { commandActions, type UiAction } from "./client/state";
import { ContainerBadge, WorktreeBadge } from "./client/badges";
import { publishStatus } from "./client/live-status";
import { provideBadges } from "./client/companion";
import { type Container, openLogsRpc, openShellRpc, runActionRpc, statusRpc, statusSubscription } from "./shared/contract";

const SETTINGS_ID = "settings";
// After the status subscription closed, read once and subscribe again this much later.
const RESUBSCRIBE_MS = 10_000;
const KEYWORDS = ["devcontainer", "dev container", "docker", "container"];

export default function contribute(client: PluginClientContext) {
  function Screen(props: PluginScreenProps) {
    return <ContainersScreen {...props} openSettings={() => client.openSettings(SETTINGS_ID)} />;
  }

  setSettingsOpener(() => client.openSettings(SETTINGS_ID));
  client.addScreen({ id: SCREEN_ID, title: "Dev containers", Component: Screen });
  setGuideOpener(() => client.openScreen({ screenId: GUIDE_SCREEN_ID }));
  client.addScreen({ id: GUIDE_SCREEN_ID, title: "Worktrees shared with dev containers", Component: GuideScreen });
  client.addSidebarFooterItem({ id: "devcontainers", title: "Dev containers", Component: DevcontainerSidebarItem });
  // The container badge only shows on a container's workspaces, which the companion plugin badges.
  client.addWorkspaceRowBadgeItem({
    id: "worktree",
    title: "Shared worktree problems",
    icon: "GitBranch",
    Component: WorktreeBadge,
  });
  // The companion plugin badges container workspaces with the same components.
  const withdrawBadges = provideBadges({ container: ContainerBadge, worktree: WorktreeBadge });
  client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "Dev containers",
    icon: DEVCONTAINERS_ICON,
    Component: DevcontainerSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "devcontainers-open",
    title: "Dev containers",
    icon: DEVCONTAINERS_ICON,
    keywords: KEYWORDS,
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  client.addCommandCenterItem({
    id: "devcontainers-worktrees-guide",
    title: "Dev containers: Worktrees guide",
    icon: "BookOpen",
    keywords: [...KEYWORDS, "worktree", "git", "prune", "repair"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: GUIDE_SCREEN_ID });
    },
  });
  client.addCommandCenterItem({
    id: "devcontainers-settings",
    title: "Dev containers: Settings",
    icon: "Settings",
    keywords: KEYWORDS,
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  // One item per container and currently valid action, kept current by the daemon's pushes.
  const commands = new Map<string, () => void>();
  const sync = (containers: Container[]) => {
    const wanted = new Map<string, { container: Container; action: UiAction }>();
    for (const container of containers) {
      const actions: UiAction[] = commandActions(container);
      if (container.docker === "running") actions.push("shell");
      if (container.job) actions.push("logs");
      for (const action of actions) {
        wanted.set(`dc-${action}-${commandKey(container.repoPath)}`, { container, action });
      }
    }
    for (const [id, remove] of commands) {
      if (!wanted.has(id)) {
        remove();
        commands.delete(id);
      }
    }
    for (const [id, { container, action }] of wanted) {
      if (commands.has(id)) continue;
      commands.set(
        id,
        client.addCommandCenterItem({
          id,
          title: `Dev container: ${ACTION_META[action].label} ${container.name}`,
          icon: ACTION_META[action].icon,
          keywords: [...KEYWORDS, container.repoPath],
          context: "global",
          async onSelect({ rpc, openScreen }) {
            const { repoPath } = container;
            let workspaceId: string | null;
            if (action === "shell") workspaceId = (await rpc(openShellRpc, { repoPath })).workspaceId;
            else if (action === "logs") workspaceId = (await rpc(openLogsRpc, { repoPath })).workspaceId;
            else if (action === "dismiss") return;
            else workspaceId = (await rpc(runActionRpc, { repoPath, action })).logWorkspaceId;
            // Command callbacks cannot navigate to a workspace; the screen does it from its params.
            if (workspaceId) openScreen({ screenId: SCREEN_ID, params: workspaceParams({ workspaceId }) });
          },
        }),
      );
    }
  };

  let stopped = false;
  let release: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async () => {
    try {
      const status = await client.rpc(statusRpc, {});
      if (stopped) return;
      publishStatus(status);
      sync(status.containers);
    } catch {
      // Host offline or plugin reloading; keep the last items.
    }
  };
  const watch = () => {
    retryTimer = null;
    if (stopped) return;
    release = client.subscribe(
      statusSubscription,
      {},
      (event) => {
        if (stopped || !event.status) return;
        publishStatus(event.status);
        sync(event.status.containers);
      },
      {
        onClosed: () => {
          release = null;
          if (stopped) return;
          void refresh();
          retryTimer = setTimeout(watch, RESUBSCRIBE_MS);
        },
      },
    );
  };
  watch();

  return () => {
    stopped = true;
    withdrawBadges();
    if (retryTimer) clearTimeout(retryTimer);
    release?.();
    for (const remove of commands.values()) remove();
    commands.clear();
  };
}

// IDs allow only lowercase letters, digits and hyphens: a readable tail plus a hash of the path.
function commandKey(path: string): string {
  let hash = 5381;
  for (let index = 0; index < path.length; index++) hash = ((hash * 33) ^ path.charCodeAt(index)) >>> 0;
  const tail = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-30)
    .replace(/^-/, "");
  return `${tail}-${hash.toString(36)}`;
}
