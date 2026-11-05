import { getPaseoClient, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SectionHeading } from "./ports";
import type { GuardWorktree } from "../shared/contract";
import type { ContainerView, WorkspaceTarget } from "./state";
import { ProblemButton, slugOf, worktreeProblems } from "./worktrees";

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
  const all = query.data?.entries ?? [];
  const elsewhere = query.data?.elsewhere ?? 0;
  // Workspaces whose worktree is broken or at risk lead the list, in place of their plain row.
  const problems = worktreeProblems(view.container.guard).map((problem) => ({
    problem,
    workspace: all.find((entry) => entry.workspaceDirectory && slugOf(entry.workspaceDirectory) === slugOf(problem.folder)) ?? null,
  }));
  const claimed = new Set(problems.flatMap(({ workspace }) => (workspace ? [workspace.id] : [])));
  const entries = all.filter((entry) => !claimed.has(entry.id));
  const shown = showAll ? entries : entries.slice(0, SHOWN);

  return (
    <View style={styles.section}>
      <SectionHeading theme={theme} text={all.length > 0 ? `Workspaces · ${all.length}` : "Workspaces"} />
      {problems.map(({ problem, workspace }) => (
        <WorkspaceRow
          key={`${problem.name}:${problem.folder}`}
          theme={theme}
          layout={layout}
          view={view}
          title={workspace ? workspaceTitle(workspace) : (problem.title ?? slugOf(problem.folder))}
          branch={workspace?.gitRuntime?.currentBranch ?? null}
          status={workspace?.status ?? null}
          age={workspace?.activityAt ? ago(workspace.activityAt) : null}
          problem={problem}
          onOpen={workspace && host ? () => onOpen({ workspaceId: workspace.id, serverId: host.serverId }) : null}
        />
      ))}
      {!host
        ? note("Pair this container's daemon in Paseo to see its workspaces here.")
        : !online
          ? note(`${host.label} is ${host.status}.`)
          : query.error
            ? note(`Could not list workspaces: ${query.error instanceof Error ? query.error.message : String(query.error)}`)
            : !query.data
              ? note("Loading…")
              : all.length === 0
                ? note(`No ${project?.name ?? "project"} workspaces yet. Agents you start in this container show up here.`)
                : null}
      {host
        ? shown.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              theme={theme}
              layout={layout}
              view={view}
              title={workspaceTitle(workspace)}
              branch={workspace.gitRuntime?.currentBranch ?? null}
              status={workspace.status}
              age={workspace.activityAt ? ago(workspace.activityAt) : null}
              problem={null}
              onOpen={() => onOpen({ workspaceId: workspace.id, serverId: host.serverId })}
            />
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

// A workspace as a link: its title is underlined, and on hover an arrow takes the branch's place.
// A worktree problem adds its button, whose hover leaves the link alone.
export function WorkspaceRow({
  theme,
  layout,
  view,
  title,
  branch,
  status,
  age,
  problem,
  onOpen,
}: {
  theme: Theme;
  layout: PluginHostProps["layout"];
  view: ContainerView;
  title: string;
  branch: string | null;
  status: string | null;
  age: string | null;
  problem: GuardWorktree | null;
  onOpen: (() => void) | null;
}) {
  const [rowHovered, setRowHovered] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);
  const linkHover = rowHovered && !buttonHovered && onOpen !== null;
  return (
    <Pressable
      accessibilityRole={onOpen ? "link" : undefined}
      accessibilityLabel={onOpen ? `Open ${title}` : undefined}
      disabled={!onOpen}
      onPress={onOpen ?? undefined}
      onHoverIn={() => setRowHovered(true)}
      onHoverOut={() => setRowHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: layout.compact ? 36 : 28,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: linkHover ? theme.colors.surface2 : "transparent",
      }}
    >
      <View style={{ width: 14, alignItems: "center" }}>
        <View
          accessibilityLabel={status ? status.replace("_", " ") : undefined}
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor(status ?? "", theme) }}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            flexShrink: 1,
            textDecorationLine: onOpen ? "underline" : "none",
            textDecorationColor: linkHover ? theme.colors.foreground : `${theme.colors.foreground}44`,
          }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {linkHover ? (
          <Icon name="ArrowUpRight" size={12} color={theme.colors.foreground} />
        ) : branch ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace", flexShrink: 2 }} numberOfLines={1}>
            {branch}
          </Text>
        ) : null}
      </View>
      {problem ? <ProblemButton theme={theme} container={view.container} entry={problem} title={title} onHover={setButtonHovered} /> : null}
      {age ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75, minWidth: 24, textAlign: "right" }}>{age}</Text> : null}
    </Pressable>
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
