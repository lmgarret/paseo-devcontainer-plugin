import type { PluginTheme } from "@getpaseo/plugin";
import { getPaseoClient, type PluginHostSummary, useHosts, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Action, type Container, openShellRpc, runActionRpc, type Status, statusRpc } from "../shared/contract";

// Shell is client-driven: it opens a Paseo terminal rather than running a daemon job.
export type UiAction = Action | "shell";

export type ViewKind = "busy" | "online" | "warning" | "stopped";

export interface ContainerView {
  container: Container;
  kind: ViewKind;
  label: string;
  detail: string | null;
  actions: UiAction[];
  host: PluginHostSummary | null;
  // Listed in the sidebar popover: paired with the app, running, or busy, and not hidden.
  active: boolean;
}

export interface DevcontainersState {
  status: Status | undefined;
  error: string | null;
  views: ContainerView[];
  run(repoPath: string, action: Action): Promise<void>;
  // Re-reads status now, e.g. after a settings change that affects the list.
  refresh(): Promise<void>;
  pending: boolean;
}

export const STATUS_KEY = ["devcontainer-status"];

export function useStatusQuery() {
  const getStatus = useRpc(statusRpc);
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => getStatus({}),
    refetchInterval: (query) =>
      query.state.data?.containers.some((container) => container.job?.state === "running") ? 1_500 : 5_000,
  });
}

export function useDevcontainers(): DevcontainersState {
  const hosts = useHosts();
  const query = useStatusQuery();
  const runAction = useRpc(runActionRpc);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: { repoPath: string; action: Action }) => runAction(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });

  const views = (query.data?.containers ?? []).map((container) => describe(container, hosts));
  return {
    status: query.data,
    error: query.error instanceof Error ? query.error.message : null,
    views,
    pending: mutation.isPending,
    async run(repoPath, action) {
      await mutation.mutateAsync({ repoPath, action });
    },
    async refresh() {
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
  };
}

const RUNNING_ACTIONS: UiAction[] = ["shell", "rebuild", "stop"];

export function describe(container: Container, hosts: readonly PluginHostSummary[]): ContainerView {
  const host = container.serverId ? (hosts.find((entry) => entry.serverId === container.serverId) ?? null) : null;
  const view = (kind: ViewKind, label: string, actions: UiAction[], detail: string | null = null): ContainerView => {
    const notes = [detail];
    if (container.paseoHomePersistent === false && container.paseoInstalled === true) {
      notes.push("Its Paseo home is not on a mount, so a rebuild gives the daemon a new identity.");
    }
    return {
      container,
      kind,
      label,
      actions,
      host,
      detail: notes.filter(Boolean).join(" ") || null,
      active:
        !container.hidden && (host !== null || container.docker === "running" || container.job?.state === "running"),
    };
  };

  if (container.job?.state === "running") return view("busy", container.job.phase, []);
  if (container.docker === "missing") return view("stopped", "Not created", ["start"]);
  if (container.docker === "stopped") return view("stopped", "Stopped", ["start"]);
  if (container.paseoInstalled === false) {
    return view("warning", "Paseo not installed", ["install-paseo", ...RUNNING_ACTIONS]);
  }
  if (host?.status === "online") return view("online", "Online", RUNNING_ACTIONS);
  if (container.daemonRunning === true) {
    if (!host) {
      const id = container.serverId ? ` (${container.serverId})` : "";
      return view("online", "Running · not paired", RUNNING_ACTIONS, `Pair its daemon${id} in Paseo to use it here.`);
    }
    return view(
      "warning",
      host.status === "connecting" ? "Connecting" : "Host unreachable",
      RUNNING_ACTIONS,
      "The daemon runs but the app cannot reach it.",
    );
  }
  return view("warning", "Daemon down", ["start-daemon", ...RUNNING_ACTIONS]);
}

const KIND_ORDER: Record<ViewKind, number> = { busy: 0, warning: 1, online: 2, stopped: 3 };

// Most urgent first: busy, then needing attention, running, and paired but stopped.
export function sortActive(views: ContainerView[]): ContainerView[] {
  return views
    .filter((view) => view.active)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.container.name.localeCompare(b.container.name));
}

export function useOpenShell() {
  return useRpc(openShellRpc);
}

export function kindColor(kind: ViewKind, theme: PluginTheme): string {
  switch (kind) {
    case "online":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "busy":
      return theme.colors.accent;
    case "stopped":
      return theme.colors.foregroundMuted;
  }
}

// Actions that do not depend on the app's host connection, for Command Center items.
export function commandActions(container: Container): Action[] {
  if (container.job?.state === "running") return [];
  if (container.docker !== "running") return ["start"];
  const actions: Action[] = ["stop", "rebuild"];
  if (container.paseoInstalled === false) actions.unshift("install-paseo");
  else if (container.daemonRunning !== true) actions.unshift("start-daemon");
  return actions;
}

// What the row is called under its project: the Paseo workspace, else the checked-out branch.
export function workspaceLabel(container: Container): string {
  if (container.workspace) return container.workspace.title;
  if (container.branch) return container.branch;
  return container.repoPath.split("/").filter(Boolean).pop() ?? container.repoPath;
}

export interface WorkspaceTarget {
  workspaceId: string;
  // Absent for this plugin's own host.
  serverId?: string;
}

// Prefer the workspace on the container's own Paseo host, where its agents live; fall back to
// this host's workspace for the folder.
export async function resolveWorkspace(view: ContainerView): Promise<WorkspaceTarget | null> {
  const { container, host } = view;
  if (host?.status === "online" && container.workspaceFolder) {
    try {
      const workspace = await getPaseoClient(host.serverId).workspaces.open({ cwd: container.workspaceFolder });
      return { workspaceId: workspace.id, serverId: host.serverId };
    } catch {
      // Fall through to this host's workspace.
    }
  }
  return container.workspace ? { workspaceId: container.workspace.id } : null;
}

export function canOpenWorkspace(view: ContainerView): boolean {
  return Boolean(view.container.workspace || (view.host?.status === "online" && view.container.workspaceFolder));
}

export interface ProjectGroup {
  key: string;
  project: Container["project"];
  name: string;
  views: ContainerView[];
}

export function groupByProject(views: ContainerView[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const view of views) {
    const project = view.container.project;
    const key = project?.id ?? `folder:${view.container.repoPath}`;
    const group = groups.get(key) ?? { key, project, name: project?.name ?? view.container.name, views: [] };
    group.views.push(view);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
