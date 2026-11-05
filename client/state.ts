import type { PluginTheme } from "@getpaseo/plugin";
import { getPaseoClient, type PluginHostSummary, useHosts, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  type Action,
  ACTION_LABELS,
  type Container,
  dismissJobRpc,
  type Forward,
  type Guard,
  guardPreviewRpc,
  guardRestoreRpc,
  openLogsRpc,
  openShellRpc,
  runActionRpc,
  settingsDefinition,
  type Status,
  statusRpc,
} from "../shared/contract";

// Client-driven: shell and logs open a Paseo terminal, dismiss forgets a finished job.
export type UiAction = Action | "shell" | "logs" | "dismiss";

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
  // Resolves to the workspace holding the build log when it was opened.
  run(repoPath: string, action: Action): Promise<string | null>;
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
  // Time-based states such as "Reconnecting…" expire without new data, so re-derive regularly.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
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
      return (await mutation.mutateAsync({ repoPath, action })).logWorkspaceId;
    },
    async refresh() {
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
  };
}

const RUNNING_ACTIONS: UiAction[] = ["shell", "rebuild", "stop"];
// A failure keeps its log button this long; a failure that left no running container stays until
// dismissed.
export const FAILURE_VISIBLE_MS = 10 * 60_000;
const BUILD_ACTIONS: ReadonlySet<Action> = new Set(["start", "rebuild", "rebuild-no-cache"]);

export function describe(container: Container, hosts: readonly PluginHostSummary[]): ContainerView {
  const host = container.serverId ? (hosts.find((entry) => entry.serverId === container.serverId) ?? null) : null;
  const job = container.job;
  const recentFailure =
    job?.state === "failed" && job.endedAt !== null && Date.now() - job.endedAt < FAILURE_VISIBLE_MS;
  // A failed rebuild removes the container first, so nothing is left running.
  const stranded = job?.state === "failed" && container.docker !== "running";
  const view = (kind: ViewKind, label: string, actions: UiAction[], detail: string | null = null): ContainerView => {
    const notes = [detail];
    if (container.paseoHomePersistent === false && container.paseoInstalled === true) {
      notes.push("Its Paseo home is not on a mount, so a rebuild gives the daemon a new identity.");
    }
    return {
      container,
      kind,
      label,
      actions: recentFailure && !actions.includes("logs") ? [...actions, "logs"] : actions,
      host,
      detail: notes.filter(Boolean).join(" ") || null,
      active:
        !container.hidden && (host !== null || container.docker === "running" || job?.state === "running" || stranded),
    };
  };

  if (job?.state === "running") return view("busy", job.phase, ["logs"]);
  if (stranded) {
    const retry: Action = BUILD_ACTIONS.has(job.action) ? job.action : "start";
    // Rebuild's confirmation offers the no-cache variant.
    const actions: UiAction[] = retry === "rebuild" ? [retry] : [retry, "rebuild"];
    return view("warning", `${ACTION_LABELS[job.action]} failed`, [...actions, "logs", "dismiss"]);
  }
  // Rebuild is offered in every state but busy, so it is always in the same place.
  if (container.docker === "missing") return view("stopped", "Never started", ["start", "rebuild"]);
  if (container.docker === "stopped") return view("stopped", "Stopped", ["start", "rebuild"]);
  if (container.paseoInstalled === false) {
    return view("warning", "No Paseo", ["install-paseo", ...RUNNING_ACTIONS]);
  }
  // The container's own report wins: the app may reach another daemon at the forwarded address.
  if (container.daemonRunning === false) return view("warning", "Paseo stopped", ["start-daemon", ...RUNNING_ACTIONS]);
  if (host?.status === "online") return view("online", "Online", RUNNING_ACTIONS);
  // Right after a start the daemon boots and the app reconnects on its own: not a problem yet.
  if (host && justStarted(container)) {
    return view("busy", "Reconnecting…", RUNNING_ACTIONS, "The container just started; Paseo reconnects on its own.");
  }
  if (container.daemonRunning === true) {
    const forward = daemonForward(container);
    if (!host) {
      const id = container.serverId ? ` (${container.serverId})` : "";
      const address = forward?.hostPort ? ` at localhost:${forward.hostPort}` : "";
      return view("online", "Running · not paired", RUNNING_ACTIONS, `Pair its daemon${id}${address} in Paseo to use it here.`);
    }
    return view(
      "warning",
      host.status === "connecting" ? "Connecting" : "Host unreachable",
      RUNNING_ACTIONS,
      forward?.error
        ? `The daemon runs but its port is not forwarded: ${forward.error}.`
        : "The daemon runs but the app cannot reach it.",
    );
  }
  return view("warning", "Paseo stopped", ["start-daemon", ...RUNNING_ACTIONS]);
}

export function daemonForward(container: Container): Forward | null {
  return container.forwards.find((forward) => forward.kind === "daemon") ?? null;
}

export function appForwards(container: Container): Forward[] {
  return container.forwards.filter((forward) => forward.kind === "app");
}

export interface PortActions {
  ready: boolean;
  // Detected ports this repository stopped forwarding.
  ignored(repoPath: string): number[];
  forward(repoPath: string, port: number): Promise<void>;
  // A manual forward is dropped; a detected one is ignored for this repository.
  stop(repoPath: string, forward: Forward): Promise<void>;
  restore(repoPath: string, port: number): Promise<void>;
}

// Per-repository port choices live in settings, which only clients can write.
export function usePortActions(): PortActions {
  const settings = useSettings(settingsDefinition);
  const queryClient = useQueryClient();
  type RepoPorts = { forwarded: number[]; ignored: number[] };
  const update = async (repoPath: string, change: (ports: RepoPorts) => RepoPorts) => {
    if (settings.status !== "ready") throw new Error("Settings are not loaded yet");
    const next = change(settings.values.repoPorts[repoPath] ?? { forwarded: [], ignored: [] });
    const repoPorts = { ...settings.values.repoPorts, [repoPath]: next };
    if (next.forwarded.length === 0 && next.ignored.length === 0) delete repoPorts[repoPath];
    if (!(await settings.save({ ...settings.values, repoPorts }, settings.revision))) {
      throw new Error(settings.saveError ?? "Could not save");
    }
    // The daemon re-syncs forwards on save; pick up the result shortly after.
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: STATUS_KEY }), 1_000);
  };
  const without = (ports: number[], port: number) => ports.filter((entry) => entry !== port);
  return {
    ready: settings.status === "ready",
    ignored: (repoPath) => (settings.status === "ready" ? (settings.values.repoPorts[repoPath]?.ignored ?? []) : []),
    forward: (repoPath, port) =>
      update(repoPath, (ports) => ({
        forwarded: [...without(ports.forwarded, port), port],
        ignored: without(ports.ignored, port),
      })),
    stop: (repoPath, forward) =>
      update(repoPath, (ports) =>
        forward.manual
          ? { ...ports, forwarded: without(ports.forwarded, forward.containerPort) }
          : { ...ports, ignored: [...without(ports.ignored, forward.containerPort), forward.containerPort] },
      ),
    restore: (repoPath, port) => update(repoPath, (ports) => ({ ...ports, ignored: without(ports.ignored, port) })),
  };
}

const RECONNECT_GRACE_MS = 90_000;

function justStarted(container: Container): boolean {
  const now = Date.now();
  const job = container.job;
  const startedByAction =
    job?.state === "succeeded" &&
    (job.action === "start" || job.action === "rebuild" || job.action === "start-daemon") &&
    job.endedAt !== null &&
    now - job.endedAt < RECONNECT_GRACE_MS;
  const startedRecently = container.startedAt !== null && now - container.startedAt < RECONNECT_GRACE_MS;
  return startedByAction || startedRecently;
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

export function useOpenLogs() {
  return useRpc(openLogsRpc);
}

export function useDismissJob() {
  return useRpc(dismissJobRpc);
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
  if (container.docker !== "running") return ["start", "rebuild", "rebuild-no-cache"];
  const actions: Action[] = ["stop", "rebuild", "rebuild-no-cache"];
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

export function useGuardPreview() {
  return useRpc(guardPreviewRpc);
}

export function useRestoreWorktrees() {
  return useRpc(guardRestoreRpc);
}

export type GuardTone = "danger" | "warning" | "success";

// The row's worktree badge: counts of broken, at risk, and repaired in the last day, coloured by
// the most urgent; `text` is for screen readers.
export function guardBadge(
  guard: Guard | null,
): { broken: number; atRisk: number; restored: number; text: string; tone: GuardTone } | null {
  if (!guard) return null;
  const broken = guard.worktrees.filter((entry) => entry.state === "broken").length;
  const atRisk = guard.worktrees.filter((entry) => entry.state === "at-risk").length;
  const restored = guard.restored.filter((entry) => !entry.error).length;
  const parts = [
    broken > 0 ? `${broken} broken` : null,
    atRisk > 0 ? `${atRisk} at risk` : null,
    restored > 0 ? `${restored} restored` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const tone: GuardTone = broken > 0 ? "danger" : atRisk > 0 ? "warning" : "success";
  return { broken, atRisk, restored, text: parts.join(", "), tone };
}

export function toneColor(tone: GuardTone, theme: PluginTheme): string {
  switch (tone) {
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    case "success":
      return theme.colors.statusSuccess;
  }
}
