import { type PluginScreenParams, type PluginScreenProps, useSettings } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { CARD_INDENT, ContainerRow } from "./actions";
import { DEVCONTAINERS_ICON } from "./devcontainers-icon";
import { FolderIcon, ProjectIcon } from "./project-icon";
import { settingsDefinition } from "../shared/contract";
import { HoverPressable } from "./hover";
import { PortsPanel } from "./ports";
import {
  appForwards,
  type ContainerView,
  groupByProject,
  kindColor,
  sortActive,
  useDevcontainers,
  type WorkspaceTarget,
} from "./state";
import { ContainerWorkspaces } from "./workspaces";

// Popovers and commands cannot navigate; they open this screen with the target in its params.
export function workspaceParams(target: WorkspaceTarget): PluginScreenParams {
  return {
    workspace: target.workspaceId,
    ...(target.serverId ? { server: target.serverId } : {}),
    at: String(Date.now()),
  };
}

// The popover opens a container on this page, expanded.
export function containerParams(repoPath: string): PluginScreenParams {
  return { container: repoPath, at: String(Date.now()) };
}

const handledRequests = new Set<string>();

export function ContainersScreen(props: PluginScreenProps & { openSettings(): void }) {
  const { theme, layout, host, params, navigation, openSettings } = props;
  const state = useDevcontainers();
  const settings = useSettings(settingsDefinition);
  const [collapsedOverride, setCollapsedOverride] = useState<string[] | null>(null);
  // Running cards open by default; these are the ones folded by hand.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toast = useToast();
  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      // A centred column, like Paseo's settings pages.
      content: {
        paddingHorizontal: layout.compact ? 12 : 24,
        paddingTop: layout.compact ? 16 : 32,
        paddingBottom: 48,
        gap: 28,
        maxWidth: 800,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
      top: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 16 },
      heading: { flex: 1, gap: 4 },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      h1: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "600" as const },
      summary: { color: theme.colors.foregroundMuted, fontSize: 13 },
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      banner: {
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        gap: 4,
      },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      section: { gap: 10 },
      sectionTitle: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8, paddingHorizontal: 4 },
      h2: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      count: { color: theme.colors.foregroundMuted, fontSize: 12 },
      card: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      empty: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        padding: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: "dashed" as const,
        borderColor: theme.colors.border,
        textAlign: "center" as const,
      },
      list: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingVertical: 6,
        paddingHorizontal: 6,
        gap: 8,
      },
      group: { gap: 1 },
      // Rows sit under their project's name, past its icon.
      indented: { paddingLeft: 24 },
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

  // The popover opens a container here: make sure its card is open.
  const focus = params.container ? `${params.container}:${params.at ?? ""}` : null;
  useEffect(() => {
    if (!focus || handledRequests.has(focus) || !params.container) return;
    handledRequests.add(focus);
    const repoPath = params.container;
    setFolded((current) => {
      const next = new Set(current);
      next.delete(repoPath);
      return next;
    });
  }, [focus]);

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

  const toggleFolded = (repoPath: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(repoPath)) next.add(repoPath);
      return next;
    });

  const toggleHidden = (repoPath: string) => {
    if (settings.status !== "ready") return;
    const { hidden } = settings.values;
    const next = hidden.includes(repoPath) ? hidden.filter((path) => path !== repoPath) : [...hidden, repoPath];
    void settings.save({ ...settings.values, hidden: next }, settings.revision).then((saved) => {
      if (!saved) toast.error(settings.saveError ?? "Could not save");
      return state.refresh();
    });
  };

  // Running, or starting: what this page is mostly for. The rest is a compact list below.
  const live = (view: ContainerView) => view.container.docker === "running" || view.kind === "busy";
  const running = sortActive(state.views.filter((view) => live(view) && !view.container.hidden)).concat(
    state.views.filter((view) => live(view) && view.container.hidden),
  );
  const others = state.views.filter((view) => !live(view));
  const paired = state.views.filter((view) => view.host?.status === "online").length;
  const ports = running.reduce(
    (sum, view) => sum + appForwards(view.container).filter((forward) => forward.hostPort !== null).length,
    0,
  );
  const summary = state.status
    ? [
        `${running.length} running`,
        `${paired} paired`,
        `${ports} ${ports === 1 ? "port" : "ports"} forwarded`,
        others.length > 0 ? `${others.length} stopped` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const row = (view: ContainerView, variant: "page" | "card", open = false) => (
    <ContainerRow
      theme={theme}
      layout={layout}
      hostId={host.id}
      view={view}
      state={state}
      variant={variant}
      onOpenWorkspace={(workspaceId) => openWorkspace({ workspaceId })}
      onToggleHidden={() => toggleHidden(view.container.repoPath)}
      {...(variant === "card"
        ? {
            expanded: open,
            onToggleExpanded: () => toggleFolded(view.container.repoPath),
            onPress: () => toggleFolded(view.container.repoPath),
            pressLabel: `${open ? "Collapse" : "Expand"} ${view.container.name}`,
          }
        : {})}
    />
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.top}>
        <View style={styles.heading}>
          <View style={styles.titleRow}>
            <Icon icon={DEVCONTAINERS_ICON} size={layout.compact ? 20 : 22} color={theme.colors.foregroundMuted} />
            <Text style={styles.h1}>Dev containers</Text>
          </View>
          {summary ? <Text style={styles.summary}>{summary}</Text> : null}
        </View>
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="Dev container settings"
          onPress={openSettings}
          style={styles.button}
          hoveredStyle={styles.hovered}
        >
          <Icon name="Settings" size={13} color={theme.colors.foregroundMuted} />
          <Text style={styles.buttonText}>Settings</Text>
        </HoverPressable>
      </View>

      {state.error || state.status?.dockerError || (tools && !tools.devcontainer) ? (
        <View style={styles.banner}>
          {state.error ? <Text style={styles.danger}>Status unavailable: {state.error}</Text> : null}
          {state.status?.dockerError ? <Text style={styles.danger}>{state.status.dockerError}</Text> : null}
          {tools && !tools.devcontainer ? (
            <Text style={styles.danger} selectable>
              devcontainer CLI not found: npm install -g @devcontainers/cli
            </Text>
          ) : null}
        </View>
      ) : null}

      {state.status && state.views.length === 0 ? (
        <Text style={styles.empty}>
          No dev containers found. Add a Paseo project with a .devcontainer folder, or a repository path in settings.
        </Text>
      ) : (
        <>
          <View style={styles.section}>
            <View style={styles.sectionTitle}>
              <Text style={styles.h2}>Running</Text>
              <Text style={styles.count}>{running.length}</Text>
            </View>
            {running.length === 0 ? (
              <Text style={styles.empty}>Nothing running. Start a container from the list below.</Text>
            ) : null}
            {running.map((view) => {
              const open = !folded.has(view.container.repoPath);
              const ready = view.container.docker === "running";
              return (
                <View
                  key={view.container.repoPath}
                  style={[styles.card, view.container.hidden && { opacity: 0.55 }]}
                >
                  {row(view, "card", open)}
                  {open && ready ? (
                    <PortsPanel
                      theme={theme}
                      layout={layout}
                      view={view}
                      indent={CARD_INDENT}
                      before={<ContainerWorkspaces theme={theme} layout={layout} view={view} onOpen={openWorkspace} />}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>

          {others.length > 0 ? (
            <View style={styles.section}>
              <View style={styles.sectionTitle}>
                <Text style={styles.h2}>Other containers</Text>
                <Text style={styles.count}>{others.length}</Text>
              </View>
              <View style={styles.list}>
                {groupByProject(others).map((group) => (
                  <View key={group.key} style={styles.group}>
                    <HoverPressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: !collapsed.has(group.key) }}
                      accessibilityLabel={`${collapsed.has(group.key) ? "Expand" : "Collapse"} ${group.name}`}
                      onPress={() => toggleCollapsed(group.key)}
                      style={styles.header}
                      hoveredStyle={styles.hovered}
                    >
                      {group.project ? (
                        <ProjectIcon project={group.project} hostId={host.id} />
                      ) : (
                        <FolderIcon theme={theme} />
                      )}
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
                      <View
                        key={view.container.repoPath}
                        style={[styles.indented, view.container.hidden && { opacity: 0.55 }]}
                      >
                        {row(view, "page")}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
