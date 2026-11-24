import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { ACTION_LABELS } from "../shared/contract";
import { logoStatus } from "./status-icon";
import { ContainerRow } from "./actions";
import { IssueBadge } from "./worktrees";
import { DEVCONTAINERS_ICON } from "./devcontainers-icon";
import { HoverPressable } from "./hover";
import { containerParams, workspaceParams } from "./screen";
import {
  appForwards,
  guardBadge,
  type ContainerView,
  type DevcontainersState,
  kindColor,
  sortActive,
  useDevcontainers,
} from "./state";

export const SCREEN_ID = "containers";

// Popovers receive no settings navigation; the client entry provides it.
let openSettings: (() => void) | null = null;
export function setSettingsOpener(opener: () => void) {
  openSettings = opener;
}

const POPOVER_LIMIT = 5;

// Module scope so a remounted sidebar does not repeat toasts.
const lastKinds = new Map<string, ContainerView["kind"]>();
const notifiedJobs = new Set<string>();
const notifiedNotices = new Set<string>();
// The shared-worktrees warning shows once per repository while the app runs, not on every workspace.
const warnedRepos = new Set<string>();
const notifiedRepairs = new Set<string>();
const loadedAt = Date.now();
// Detected forwards already seen; ports open when the app loads are not announced.
const knownForwards = new Set<string>();
let forwardsSeeded = false;

function useToasts(state: DevcontainersState) {
  const toast = useToast();
  const signature = state.views
    .map((view) => {
      const ports = appForwards(view.container).map((forward) => `${forward.containerPort}>${forward.hostPort}`);
      const repairs = view.container.guard?.restored.length ?? 0;
      return `${view.container.repoPath}:${view.kind}:${view.host?.status}:${view.container.job?.state}:${ports.join(",")}:${repairs}`;
    })
    .join("|") + `|${(state.status?.notices ?? []).map((notice) => notice.id).join(",")}`;

  useEffect(() => {
    const unreachable: string[] = [];
    for (const view of state.views) {
      const key = view.container.repoPath;
      if (view.kind === "busy") continue;
      // Only containers paired with this app: their host is the one shown as unreachable.
      if (view.kind === "stopped" && view.host && view.host.status !== "online" && !view.container.hidden) {
        if (lastKinds.get(key) !== "stopped") unreachable.push(view.container.name);
      }
      lastKinds.set(key, view.kind);
    }

    const finished = state.views.flatMap((view) => {
      const job = view.container.job;
      if (!job || job.state === "running" || !job.endedAt || job.endedAt < loadedAt) return [];
      const id = `${view.container.repoPath}:${job.id}:${job.startedAt}`;
      if (notifiedJobs.has(id)) return [];
      notifiedJobs.add(id);
      return [{ name: view.container.name, job }];
    });

    const forwarded = state.status ? newForwards(state.views) : [];
    const notices = (state.status?.notices ?? []).filter((notice) => {
      if (notice.at < loadedAt || notifiedNotices.has(notice.id)) return false;
      notifiedNotices.add(notice.id);
      if (warnedRepos.has(notice.repoPath)) return false;
      warnedRepos.add(notice.repoPath);
      return true;
    });
    // Repairs the daemon made on its own, such as after an archive; Restore has its own toast.
    const repaired = state.views.flatMap((view) => {
      const fresh = (view.container.guard?.restored ?? []).filter((entry) => {
        const id = `${view.container.repoPath}:${entry.at}:${entry.folder}`;
        if (entry.at < loadedAt || entry.trigger === "manual" || notifiedRepairs.has(id)) return false;
        notifiedRepairs.add(id);
        return true;
      });
      const ok = fresh.filter((entry) => !entry.error).length;
      const failed = fresh.length - ok;
      if (fresh.length === 0) return [];
      const parts = [ok > 0 ? `restored ${ok}` : null, failed > 0 ? `could not restore ${failed}` : null].filter(Boolean);
      return [{ failed: failed > 0, message: `${view.container.name}: ${parts.join(", ")} git worktree ${fresh.length === 1 ? "record" : "records"} after an archive` }];
    });

    // A newer toast replaces the visible one, so show the most important message last.
    for (const message of forwarded) toast.show(message, { variant: "info", durationMs: 6_000 });
    for (const notice of notices) toast.show(notice.message, { variant: "warning", durationMs: 10_000 });
    for (const { failed, message } of repaired) {
      if (failed) toast.error(message);
      else toast.show(message, { variant: "success", durationMs: 6_000 });
    }
    if (unreachable.length > 0) {
      toast.show(`${unreachable.join(", ")}: container host unreachable. Start devcontainer?`, {
        variant: "warning",
        durationMs: 6_000,
      });
    }
    for (const { name, job } of finished) {
      if (job.state === "succeeded") {
        toast.show(`${name}: ${ACTION_LABELS[job.action]} done`, { variant: "success" });
      } else {
        toast.error(`${name}: ${ACTION_LABELS[job.action]} failed. ${job.error ?? ""}`.trim());
      }
    }
  }, [signature, toast]);
}

// One message per container whose detected ports appeared since the last status, like VS Code's
// "Your application running on port 5173 is available" notification.
function newForwards(views: ContainerView[]): string[] {
  const current = new Set<string>();
  const messages: string[] = [];
  for (const view of views) {
    const fresh: string[] = [];
    for (const forward of appForwards(view.container)) {
      if (forward.hostPort === null || forward.manual) continue;
      const key = `${view.container.repoPath}:${forward.containerPort}`;
      current.add(key);
      if (knownForwards.has(key)) continue;
      knownForwards.add(key);
      fresh.push(
        forward.hostPort === forward.containerPort
          ? `${forward.containerPort}`
          : `${forward.containerPort} (as ${forward.hostPort})`,
      );
    }
    if (forwardsSeeded && fresh.length > 0 && !view.container.hidden) {
      const ports = `${fresh.length > 1 ? "ports" : "port"} ${fresh.join(", ")}`;
      messages.push(`${view.container.name}: ${ports} forwarded to localhost`);
    }
  }
  // Forget closed ports so a server that comes back is announced again.
  for (const key of knownForwards) if (!current.has(key)) knownForwards.delete(key);
  forwardsSeeded = true;
  return messages;
}

function ContainersPopover({ theme, layout, host, close, openScreen }: PluginPopoverProps) {
  const state = useDevcontainers();
  const active = sortActive(state.views);
  const shown = active.slice(0, POPOVER_LIMIT);
  const styles = useMemo(
    () => ({
      // Wide enough that a project name and a short state fit without truncation.
      root: { minWidth: layout.compact ? undefined : 320, maxWidth: 460 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, paddingHorizontal: 8, paddingVertical: 6 },
      danger: { color: theme.colors.statusDanger, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4 },
      footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      all: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingHorizontal: 8,
        minHeight: layout.compact ? 46 : 36,
        borderRadius: 6,
      },
      cog: {
        width: layout.compact ? 40 : 30,
        height: layout.compact ? 40 : 30,
        borderRadius: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      hovered: { backgroundColor: theme.colors.surface2 },
      allText: { color: theme.colors.foreground, fontSize: 14 },
      more: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  // Popovers cannot navigate to a workspace; the screen does it from its params.
  const showWorkspace = (workspaceId: string) => {
    close();
    openScreen({ screenId: SCREEN_ID, params: workspaceParams({ workspaceId }) });
  };
  // A row opens the page with its container expanded, where its workspaces and ports are.
  const showContainer = (repoPath: string) => {
    close();
    openScreen({ screenId: SCREEN_ID, params: containerParams(repoPath) });
  };

  return (
    <View style={styles.root}>
      {!state.status ? (
        <Text style={styles.muted}>{state.error ? `Status unavailable: ${state.error}` : "Checking…"}</Text>
      ) : null}
      {state.status?.dockerError ? <Text style={styles.danger}>{state.status.dockerError}</Text> : null}
      {state.status && shown.length === 0 ? <Text style={styles.muted}>No active dev containers</Text> : null}
      {shown.map((view) => (
        <ContainerRow
          key={view.container.repoPath}
          theme={theme}
          layout={layout}
          view={view}
          state={state}
          hostId={host.id}
          variant="popover"
          onOpenWorkspace={showWorkspace}
          onFocusTerminal={close}
          onPress={() => showContainer(view.container.repoPath)}
          pressLabel={`Show ${view.container.name}`}
        />
      ))}
      <View style={styles.footer}>
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="All dev containers"
          onPress={() => openScreen({ screenId: SCREEN_ID })}
          style={styles.all}
          hoveredStyle={styles.hovered}
        >
          <View style={{ width: 16, alignItems: "center" }}>
            <Icon name="Boxes" size={14} color={theme.colors.foregroundMuted} />
          </View>
          <Text style={styles.allText}>All dev containers</Text>
          {active.length > shown.length ? <Text style={styles.more}>+{active.length - shown.length} active</Text> : null}
        </HoverPressable>
        {openSettings ? (
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="Dev container settings"
            onPress={() => {
              close();
              openSettings?.();
            }}
            style={styles.cog}
            hoveredStyle={styles.hovered}
          >
            <Icon name="Settings" size={15} color={theme.colors.foregroundMuted} />
          </HoverPressable>
        ) : null}
      </View>
    </View>
  );
}

export function DevcontainerSidebarItem({ theme, currentScreen, openPopover }: PluginSidebarItemProps) {
  const state = useDevcontainers();
  useToasts(state);
  const active = sortActive(state.views);
  const busy = active.find((view) => view.kind === "busy");
  // Hidden containers stay out of the sidebar entirely, counts included.
  const shown = state.views.filter((view) => !view.container.hidden);
  const starting = shown.filter((view) => view.kind === "busy").length;
  const running = shown.filter((view) => view.kind !== "busy" && view.container.docker === "running").length;
  const counts = [running > 0 ? `${running} running` : null, starting > 0 ? `${starting} starting` : null].filter(Boolean);
  const label = `Dev containers · ${counts.length > 0 ? counts.join(", ") : "none running"}`;
  // The first active view is the most urgent one.
  const lead = active[0];
  // Every container's worktree issues, at a glance.
  const issues = shown.reduce(
    (sum, view) => {
      const badge = guardBadge(view.container.guard);
      return { broken: sum.broken + (badge?.broken ?? 0), atRisk: sum.atRisk + (badge?.atRisk ?? 0) };
    },
    { broken: 0, atRisk: 0 },
  );

  return (
    <SidebarRow
      icon={logoStatus(lead, theme.colors) ?? DEVCONTAINERS_ICON}
      label={label}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openPopover(ContainersPopover)}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginRight: 4 }}>
          {issues.broken + issues.atRisk > 0 ? <IssueBadge theme={theme} counts={issues} /> : null}
          {/* The icon carries the lead container's state; the spinner shows work in progress. */}
          {busy ? <ActivityIndicator size="small" color={kindColor("busy", theme)} /> : null}
        </View>
      }
    />
  );
}
