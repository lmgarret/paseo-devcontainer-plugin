import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { ContainersScreen, workspaceParams } from "./client/screen";
import { DevcontainerSettingsScreen } from "./client/settings";
import { DevcontainerSidebarItem, SCREEN_ID, setSettingsOpener } from "./client/sidebar";
import { ACTION_META } from "./client/actions";
import { DEVCONTAINERS_ICON } from "./client/devcontainers-icon";
import { commandActions, type UiAction } from "./client/state";
import { type Container, openShellRpc, runActionRpc, statusRpc } from "./shared/contract";

const SETTINGS_ID = "settings";
const COMMAND_REFRESH_MS = 15_000;
const KEYWORDS = ["devcontainer", "dev container", "docker", "container"];

export default function contribute(client: PluginClientContext) {
  function Screen(props: PluginScreenProps) {
    return <ContainersScreen {...props} openSettings={() => client.openSettings(SETTINGS_ID)} />;
  }

  setSettingsOpener(() => client.openSettings(SETTINGS_ID));
  client.addScreen({ id: SCREEN_ID, title: "Dev containers", Component: Screen });
  client.addSidebarFooterItem({ id: "devcontainers", title: "Dev containers", Component: DevcontainerSidebarItem });
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
    id: "devcontainers-settings",
    title: "Dev containers: Settings",
    icon: "Settings",
    keywords: KEYWORDS,
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  // One item per container and currently valid action, refreshed from the daemon.
  const commands = new Map<string, () => void>();
  const sync = (containers: Container[]) => {
    const wanted = new Map<string, { container: Container; action: UiAction }>();
    for (const container of containers) {
      const actions: UiAction[] = commandActions(container);
      if (container.docker === "running") actions.push("shell");
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
            if (action !== "shell") {
              await rpc(runActionRpc, { repoPath: container.repoPath, action });
              return;
            }
            // Command callbacks cannot navigate to a workspace; the screen does it from its params.
            const { workspaceId } = await rpc(openShellRpc, { repoPath: container.repoPath });
            openScreen({ screenId: SCREEN_ID, params: workspaceParams({ workspaceId }) });
          },
        }),
      );
    }
  };

  let stopped = false;
  const refresh = async () => {
    try {
      const status = await client.rpc(statusRpc, {});
      if (!stopped) sync(status.containers);
    } catch {
      // Host offline or plugin reloading; keep the last items and retry on the next tick.
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), COMMAND_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
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
