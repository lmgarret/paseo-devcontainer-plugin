import { type PluginScreenParams, type PluginScreenProps, useSettings } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ContainerRow } from "./actions";
import { FolderIcon, ProjectIcon } from "./project-icon";
import { settingsDefinition } from "../shared/contract";
import { HoverPressable } from "./hover";
import { groupByProject, kindColor, useDevcontainers, type WorkspaceTarget } from "./state";

// Popovers and commands cannot navigate; they open this screen with the target in its params.
export function workspaceParams(target: WorkspaceTarget): PluginScreenParams {
  return {
    workspace: target.workspaceId,
    ...(target.serverId ? { server: target.serverId } : {}),
    at: String(Date.now()),
  };
}

const handledRequests = new Set<string>();

export function ContainersScreen(props: PluginScreenProps & { openSettings(): void }) {
  const { theme, layout, host, params, navigation, openSettings } = props;
  const state = useDevcontainers();
  const settings = useSettings(settingsDefinition);
  const [collapsedOverride, setCollapsedOverride] = useState<string[] | null>(null);
  const toast = useToast();
  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 8 : 16, gap: 14, maxWidth: 720, width: "100%" as const },
      group: { gap: 2 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
      },
      hovered: { backgroundColor: theme.colors.surface2 },
      dots: { flexDirection: "row" as const, gap: 4, marginLeft: "auto" as const, paddingRight: 4 },
      dot: { width: 6, height: 6, borderRadius: 3 },
      project: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const, flexShrink: 1 },
      path: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.7, flexShrink: 2 },
      message: { color: theme.colors.foregroundMuted, fontSize: 13, padding: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13, padding: 12 },
      footer: { flexDirection: "row" as const, gap: 16, paddingHorizontal: 12 },
      settings: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      settingsText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const openWorkspace = (target: WorkspaceTarget) => {
    if (navigation) navigation.openWorkspace(target);
    else toast.show("Open the workspace from the sidebar", { variant: "info" });
  };

  const request = params.workspace ? `${params.workspace}:${params.server ?? ""}:${params.at ?? ""}` : null;
  useEffect(() => {
    if (!request || handledRequests.has(request) || !params.workspace) return;
    handledRequests.add(request);
    openWorkspace({ workspaceId: params.workspace, ...(params.server ? { serverId: params.server } : {}) });
  }, [request]);

  if (!state.status && !state.error) return <Loading />;
  const tools = state.status?.tools;

  // Folding answers immediately; the saved setting catches up and is shared by every client.
  const savedCollapsed = settings.status === "ready" ? settings.values.collapsedGroups : [];
  const collapsed = new Set(collapsedOverride ?? savedCollapsed);
  const toggleCollapsed = (key: string) => {
    const next = collapsed.has(key) ? [...collapsed].filter((entry) => entry !== key) : [...collapsed, key];
    setCollapsedOverride(next);
    if (settings.status !== "ready") return;
    void settings.save({ ...settings.values, collapsedGroups: next }, settings.revision).then((saved) => {
      if (saved) setCollapsedOverride(null);
      return undefined;
    });
  };

  const toggleHidden = (repoPath: string) => {
    if (settings.status !== "ready") return;
    const { hidden } = settings.values;
    const next = hidden.includes(repoPath) ? hidden.filter((path) => path !== repoPath) : [...hidden, repoPath];
    void settings.save({ ...settings.values, hidden: next }, settings.revision).then((saved) => {
      if (!saved) toast.error(settings.saveError ?? "Could not save");
      return state.refresh();
    });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {state.error ? <Text style={styles.danger}>Status unavailable: {state.error}</Text> : null}
      {state.status?.dockerError ? <Text style={styles.danger}>{state.status.dockerError}</Text> : null}
      {tools && !tools.devcontainer ? (
        <Text style={styles.danger} selectable>
          devcontainer CLI not found: npm install -g @devcontainers/cli
        </Text>
      ) : null}
      {state.status && state.views.length === 0 ? (
        <Text style={styles.message}>
          No dev containers found. Add a Paseo project with a .devcontainer folder, or a repository path in settings.
        </Text>
      ) : null}
      {groupByProject(state.views).map((group) => (
        <View key={group.key} style={styles.group}>
          <HoverPressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed.has(group.key) }}
            accessibilityLabel={`${collapsed.has(group.key) ? "Expand" : "Collapse"} ${group.name}`}
            onPress={() => toggleCollapsed(group.key)}
            style={styles.header}
            hoveredStyle={styles.hovered}
          >
            {group.project ? <ProjectIcon project={group.project} hostId={host.id} /> : <FolderIcon theme={theme} />}
            <Text style={styles.project} numberOfLines={1}>
              {group.name}
            </Text>
            <Icon
              name={collapsed.has(group.key) ? "ChevronRight" : "ChevronDown"}
              size={13}
              color={theme.colors.foregroundMuted}
            />
            <Text style={styles.path} numberOfLines={1}>
              {group.project?.rootPath ?? group.views[0]?.container.repoPath}
            </Text>
            {collapsed.has(group.key) ? (
              // Folded groups keep a glance of their containers' states.
              <View style={styles.dots}>
                {group.views.map((view) => (
                  <View
                    key={view.container.repoPath}
                    accessibilityLabel={`${view.container.name}: ${view.label}`}
                    style={[styles.dot, { backgroundColor: kindColor(view.kind, theme) }]}
                  />
                ))}
              </View>
            ) : null}
          </HoverPressable>
          {(collapsed.has(group.key) ? [] : group.views).map((view) => (
            <View key={view.container.repoPath} style={view.container.hidden ? { opacity: 0.55 } : undefined}>
              <ContainerRow
                theme={theme}
                layout={layout}
                hostId={host.id}
                view={view}
                state={state}
                variant="page"
                onShell={(workspaceId) => openWorkspace({ workspaceId })}
                onOpenWorkspace={openWorkspace}
                onToggleHidden={() => toggleHidden(view.container.repoPath)}
              />
            </View>
          ))}
        </View>
      ))}
      <View style={styles.footer}>
        <Pressable accessibilityRole="link" onPress={openSettings} style={styles.settings}>
          <Icon name="Settings" size={14} color={theme.colors.foregroundMuted} />
          <Text style={styles.settingsText}>Settings</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
