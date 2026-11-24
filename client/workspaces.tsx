import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import {
  getPaseoClient,
  type PluginHostProps,
  useProjects,
  useWorkspace,
  useWorkspaces,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SectionHeading } from "./ports";
import type { GuardWorktree } from "../shared/contract";
import type { ContainerView, WorkspaceTarget } from "./state";
import { ProblemButton, slugOf, worktreeProblems } from "./worktrees";

type Theme = PluginHostProps["theme"];
type Workspace = PluginWorkspaceSnapshot;

const SHOWN = 5;
// What needs you first, then what runs, then the rest by recent activity.
const STATUS_ORDER: Record<string, number> = { needs_input: 0, attention: 1, failed: 2, running: 3, done: 4 };
const ELSEWHERE = "elsewhere";
const OURS = "ours";
const problemKey = (folder: string) => `problem:${slugOf(folder)}`;

interface ContainerWorkspacesProps extends Pick<PluginHostProps, "theme" | "layout"> {
  view: ContainerView;
  onOpen(target: WorkspaceTarget): void;
}

// The container's project's workspaces on its own Paseo host, live from the app. A container
// hosts many, so the page lists them instead of guessing one to open; other projects on that host
// stay out of the way.
export function ContainerWorkspaces({ theme, layout, view, onOpen }: ContainerWorkspacesProps) {
  const { host } = view;
  const online = host?.status === "online";
  const hostId = host?.serverId ?? "";
  const [showAll, setShowAll] = useState(false);
  const { project, workspaceFolder } = view.container;
  const keyed = useProjectsWithKey(hostId, online, project?.key ?? null);
  // Git projects share their ID and key across hosts; the mounted folder covers the rest.
  const ours = (workspace: Workspace) =>
    workspace.projectId === project?.id || keyed.has(workspace.projectId) || workspace.projectRootPath === workspaceFolder;
  // Workspaces whose worktree is broken or at risk lead the list, in place of their plain row.
  const problems = worktreeProblems(view.container.guard);
  const problemKeys = new Set(problems.map((problem) => problemKey(problem.folder)));
  const groups = useWorkspaces({
    hosts: [hostId],
    where: (workspace) => !workspace.background && !workspace.archivingAt,
    orderBy: byUrgency,
    groupBy: (workspace) => {
      if (!ours(workspace)) return ELSEWHERE;
      const key = problemKey(workspace.directory);
      return problemKeys.has(key) ? key : OURS;
    },
  });
  const styles = useMemo(
    () => ({
      section: { marginTop: 6 },
      note: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75, paddingHorizontal: 8, paddingVertical: 4 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme],
  );

  const note = (text: string) => <Text style={styles.note}>{text}</Text>;
  const items = (key: string) => groups.find((group) => group.key === key)?.items ?? [];
  const entries = items(OURS);
  const elsewhere = items(ELSEWHERE).length;
  const total = groups.reduce((count, group) => count + (group.key === ELSEWHERE ? 0 : group.items.length), 0);
  const shown = showAll ? entries : entries.slice(0, SHOWN);
  const open = (workspace: WorkspaceRef) => onOpen({ workspaceId: workspace.id, serverId: workspace.hostId });

  return (
    <View style={styles.section}>
      <SectionHeading theme={theme} text={total > 0 ? `Workspaces · ${total}` : "Workspaces"} />
      {problems.map((problem) => {
        const workspace = items(problemKey(problem.folder))[0];
        return workspace ? (
          <LiveWorkspaceRow
            key={`${problem.name}:${problem.folder}`}
            theme={theme}
            layout={layout}
            view={view}
            workspaceRef={workspace}
            problem={problem}
            onOpen={() => open(workspace)}
          />
        ) : (
          <WorkspaceRow
            key={`${problem.name}:${problem.folder}`}
            theme={theme}
            layout={layout}
            view={view}
            title={problem.title ?? slugOf(problem.folder)}
            branch={null}
            status={null}
            age={null}
            problem={problem}
            onOpen={null}
          />
        );
      })}
      {!host
        ? note("Pair this container's daemon in Paseo to see its workspaces here.")
        : !online
          ? note(`${host.label} is ${host.status}.`)
          : total === 0
            ? note(`No ${project?.name ?? "project"} workspaces yet. Agents you start in this container show up here.`)
            : null}
      {host
        ? shown.map((workspace) => (
            <LiveWorkspaceRow
              key={workspace.key}
              theme={theme}
              layout={layout}
              view={view}
              workspaceRef={workspace}
              problem={null}
              onOpen={() => open(workspace)}
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

// Snapshots carry no project key: read which of the host's projects share ours, again whenever
// the host's project list changes.
function useProjectsWithKey(hostId: string, online: boolean, key: string | null): ReadonlySet<string> {
  const projects = useProjects({ hosts: [hostId] });
  const query = useQuery({
    queryKey: ["devcontainer-host-project-keys", hostId, key, projects.map((project) => project.id).join(",")],
    enabled: online && key !== null,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const { projects } = await getPaseoClient(hostId).projects.list();
      return projects.filter((candidate) => candidate.projectKey === key).map((candidate) => candidate.projectId);
    },
  });
  return useMemo(() => new Set(query.data ?? []), [query.data]);
}

function LiveWorkspaceRow({
  workspaceRef,
  ...props
}: Omit<Parameters<typeof WorkspaceRow>[0], "title" | "branch" | "status" | "age"> & { workspaceRef: WorkspaceRef }) {
  const workspace = useWorkspace(workspaceRef);
  if (!workspace) return null;
  const activity = activityAt(workspace);
  return (
    <WorkspaceRow
      {...props}
      title={workspace.title || workspace.name}
      branch={workspace.branch}
      status={workspace.indicator}
      age={activity ? ago(activity) : null}
    />
  );
}

// A workspace as a link: on hover its title is underlined and an arrow takes the branch's place.
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
            textDecorationLine: linkHover ? "underline" : "none",
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

// The latest of what the snapshot records: a prompt, a status change, or its creation.
function activityAt(workspace: Workspace): string | null {
  const times = [workspace.lastPromptAt, workspace.statusEnteredAt, workspace.createdAt].filter(
    (time): time is string => time !== null,
  );
  return times.length > 0 ? times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest)) : null;
}

function byUrgency(a: Workspace, b: Workspace): number {
  const order = (STATUS_ORDER[a.indicator] ?? 5) - (STATUS_ORDER[b.indicator] ?? 5);
  return order || (activityAt(b) ?? "").localeCompare(activityAt(a) ?? "");
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
