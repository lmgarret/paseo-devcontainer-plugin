import { getPaseoClient, type PluginHostProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { HoverPressable } from "./hover";
import { SectionHeading } from "./ports";
import type { ContainerView, WorkspaceTarget } from "./state";

type Theme = PluginHostProps["theme"];
type Workspace = Awaited<ReturnType<ReturnType<typeof getPaseoClient>["workspaces"]["list"]>>["entries"][number];

const SHOWN = 5;
const REFRESH_MS = 15_000;
// What needs you first, then what runs, then the rest by recent activity.
const STATUS_ORDER: Record<string, number> = { needs_input: 0, attention: 1, failed: 2, running: 3, done: 4 };

interface ContainerWorkspacesProps extends Pick<PluginHostProps, "theme" | "layout"> {
  view: ContainerView;
  onOpen(target: WorkspaceTarget): void;
}

// The container's project's workspaces on its own Paseo host. A container hosts many, so the page
// lists them instead of guessing one to open; other projects on that host stay out of the way.
export function ContainerWorkspaces({ theme, layout, view, onOpen }: ContainerWorkspacesProps) {
  const { host } = view;
  const online = host?.status === "online";
  const [showAll, setShowAll] = useState(false);
  const { project, workspaceFolder } = view.container;
  const query = useQuery({
    queryKey: ["devcontainer-host-workspaces", host?.serverId, project?.id, workspaceFolder],
    enabled: online,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const client = getPaseoClient(host?.serverId ?? "");
      const [{ projects }, result] = await Promise.all([
        client.projects.list(),
        client.workspaces.list({ page: { limit: 100 } }),
      ]);
      // Git projects share their ID and key across hosts; the mounted folder covers the rest.
      const ours = new Set(
        projects
          .filter(
            (candidate) =>
              candidate.projectId === project?.id ||
              (project?.key && candidate.projectKey === project.key) ||
              candidate.projectRootPath === workspaceFolder,
          )
          .map((candidate) => candidate.projectId),
      );
      const visible = result.entries.filter((entry) => !entry.internal && !entry.background && !entry.archivingAt);
      return {
        entries: visible.filter((entry) => ours.has(entry.projectId)).sort(byUrgency),
        elsewhere: visible.filter((entry) => !ours.has(entry.projectId)).length,
      };
    },
  });
  const styles = useMemo(
    () => ({
      section: { marginTop: 6 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        minHeight: layout.compact ? 36 : 28,
        paddingHorizontal: 8,
        borderRadius: 6,
      },
      hovered: { backgroundColor: theme.colors.surface2 },
      title: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
      branch: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace", flexShrink: 2 },
      time: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75, marginLeft: "auto" as const },
      note: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75, paddingHorizontal: 8, paddingVertical: 4 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  const note = (text: string) => <Text style={styles.note}>{text}</Text>;
  const entries = query.data?.entries ?? [];
  const elsewhere = query.data?.elsewhere ?? 0;
  const shown = showAll ? entries : entries.slice(0, SHOWN);

  return (
    <View style={styles.section}>
      <SectionHeading theme={theme} text={entries.length > 0 ? `Workspaces · ${entries.length}` : "Workspaces"} />
      {!host
        ? note("Pair this container's daemon in Paseo to see its workspaces here.")
        : !online
          ? note(`${host.label} is ${host.status}.`)
          : query.error
            ? note(`Could not list workspaces: ${query.error instanceof Error ? query.error.message : String(query.error)}`)
            : !query.data
              ? note("Loading…")
              : entries.length === 0
                ? note(`No ${project?.name ?? "project"} workspaces yet. Agents you start in this container show up here.`)
                : null}
      {host
        ? shown.map((workspace) => (
            <HoverPressable
              key={workspace.id}
              accessibilityRole="link"
              accessibilityLabel={`Open ${workspaceTitle(workspace)}`}
              onPress={() => onOpen({ workspaceId: workspace.id, serverId: host.serverId })}
              style={styles.row}
              hoveredStyle={styles.hovered}
            >
              <View style={{ width: 14, alignItems: "center" }}>
                <View
                  accessibilityLabel={workspace.status.replace("_", " ")}
                  style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor(workspace.status, theme) }}
                />
              </View>
              <Text style={styles.title} numberOfLines={1}>
                {workspaceTitle(workspace)}
              </Text>
              {workspace.gitRuntime?.currentBranch ? (
                <Text style={styles.branch} numberOfLines={1}>
                  {workspace.gitRuntime.currentBranch}
                </Text>
              ) : null}
              {workspace.activityAt ? <Text style={styles.time}>{ago(workspace.activityAt)}</Text> : null}
            </HoverPressable>
          ))
        : null}
      {entries.length > SHOWN ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll((all) => !all)}
          style={{ paddingHorizontal: 8, paddingVertical: 4 }}
        >
          <Text style={styles.link}>{showAll ? "Show fewer" : `Show all ${entries.length}`}</Text>
        </Pressable>
      ) : null}
      {elsewhere > 0
        ? note(`${elsewhere} ${elsewhere === 1 ? "workspace" : "workspaces"} from other projects on ${host?.label ?? "this host"} not shown.`)
        : null}
    </View>
  );
}

function workspaceTitle(workspace: Workspace): string {
  return workspace.title || workspace.name;
}

function byUrgency(a: Workspace, b: Workspace): number {
  const order = (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5);
  return order || (b.activityAt ?? "").localeCompare(a.activityAt ?? "");
}

function statusColor(status: string, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.colors.accent;
    case "needs_input":
    case "attention":
      return theme.colors.statusWarning;
    case "failed":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

// "now", "12m", "3h", "5d": enough to tell fresh work from old.
function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
