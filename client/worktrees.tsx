import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GuardWorktree } from "../shared/contract";
import { openGuide } from "./guide";
import { HoverPressable } from "./hover";
import { SectionHeading } from "./ports";
import { type ContainerView, STATUS_KEY, useGuardPreview, useRestoreWorktrees } from "./state";

type Theme = PluginHostProps["theme"];
type SideState = GuardWorktree["sides"]["host"];

const MONO = "monospace";

interface WorktreesPanelProps extends Pick<PluginHostProps, "theme" | "layout"> {
  view: ContainerView;
  // Problems only, without a heading, for rows outside a card.
  compact?: boolean;
}

// The repository's worktrees as a grid: one row per worktree, one column per side, so where git
// works and where it does not shows at a glance. Safe worktrees fold into one line.
export function WorktreesPanel({ theme, layout, view, compact = false }: WorktreesPanelProps) {
  const guard = view.container.guard;
  const toast = useToast();
  const queryClient = useQueryClient();
  const restoreWorktrees = useRestoreWorktrees();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [showSafe, setShowSafe] = useState(false);
  const narrow = layout.compact;
  const sideWidth = narrow ? 36 : 112;
  const styles = useMemo(
    () => ({
      section: { marginTop: 6 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, minHeight: narrow ? 40 : 34, paddingHorizontal: 8 },
      problem: { backgroundColor: theme.colors.surface2, borderRadius: 6, marginBottom: 2 },
      head: { color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5 },
      name: { color: theme.colors.foreground, fontSize: 13 },
      faint: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.8 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      side: { width: sideWidth, flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      action: { width: narrow ? 96 : 112, alignItems: "flex-end" as const },
      button: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border },
      primary: { borderColor: theme.colors.accent },
      hovered: { backgroundColor: theme.colors.surface1 },
      footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingHorizontal: 8, paddingTop: 6 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme, narrow, sideWidth],
  );
  if (!guard) return null;

  const problems = guard.worktrees.filter((entry) => entry.state !== "safe");
  const safe = guard.worktrees.filter((entry) => entry.state === "safe");
  const restored = guard.restored;
  if (compact && problems.length === 0) return null;

  const repair = async (one: { name: string; branch?: string }) => {
    setBusy(true);
    try {
      const result = await restoreWorktrees({ repoPath: view.container.repoPath, ...one });
      if (result.failed > 0) toast.error(`${view.container.name}: could not repair it; see the plugin log`);
      else if (result.restored > 0) toast.show(`${view.container.name}: repaired`, { variant: "success" });
      else toast.show("Nothing to repair any more", { variant: "info" });
      setOpen(null);
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const row = (entry: GuardWorktree) => {
    const key = `${entry.name}:${entry.folder}`;
    const expanded = open === key;
    const action =
      entry.fix === "restore" ? "Restore" : entry.fix === "share" ? "Make safe" : entry.fix === "recreate" ? "Recreate…" : null;
    return (
      <View key={key} style={entry.state === "safe" ? null : styles.problem}>
        <View style={styles.row}>
          <Pressable
            style={{ flex: 1, minWidth: 0, paddingVertical: 4 }}
            onPress={entry.problem ? () => setOpen(expanded ? null : key) : undefined}
            accessibilityRole={entry.problem ? "button" : undefined}
            accessibilityLabel={entry.problem ? `${expanded ? "Hide" : "Show"} why ${nameOf(entry)} ${entry.state === "broken" ? "is broken" : "is at risk"}` : undefined}
          >
            <Text style={styles.name} numberOfLines={1}>
              {nameOf(entry)}
            </Text>
            {entry.state === "safe" ? null : (
              <Text style={styles.faint} numberOfLines={1}>
                {reason(entry)}
                {entry.problem ? (expanded ? " · hide" : " · why?") : ""}
              </Text>
            )}
          </Pressable>
          <SideCell theme={theme} state={entry.sides.host} width={sideWidth} narrow={narrow} />
          <SideCell theme={theme} state={guard.containerChecked ? entry.sides.container : null} width={sideWidth} narrow={narrow} />
          <View style={styles.action}>
            {action ? (
              <HoverPressable
                accessibilityRole="button"
                accessibilityLabel={`${action.replace("…", "")} ${nameOf(entry)}`}
                disabled={busy}
                onPress={() => (entry.fix === "recreate" ? setOpen(expanded ? null : key) : void repair({ name: entry.name }))}
                style={[styles.button, entry.state === "broken" && styles.primary, busy && { opacity: 0.5 }]}
                hoveredStyle={styles.hovered}
              >
                <Text style={{ color: entry.state === "broken" ? theme.colors.accent : theme.colors.foreground, fontSize: 12 }}>
                  {action}
                </Text>
              </HoverPressable>
            ) : null}
          </View>
        </View>
        {expanded ? (
          <View style={{ paddingHorizontal: 8, paddingBottom: 8, gap: 4 }}>
            {entry.problem ? <Text style={styles.muted}>{entry.problem}</Text> : null}
            <Text style={[styles.faint, { fontFamily: MONO }]} selectable>
              {shortPath(entry.folder)}
            </Text>
            {entry.fix === "recreate" ? (
              <RecreateChooser
                theme={theme}
                repoPath={view.container.repoPath}
                name={entry.name}
                branches={entry.branches}
                busy={busy}
                onRecreate={(branch) => void repair({ name: entry.name, branch })}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  const latest = restored[0];
  return (
    <View style={styles.section}>
      {compact ? null : <SectionHeading theme={theme} text="Worktrees" />}
      {guard.error ? <Text style={[styles.danger, { paddingHorizontal: 8 }]}>{guard.error}</Text> : null}
      {guard.checkedAt === null ? <Text style={[styles.faint, { paddingHorizontal: 8 }]}>Checking…</Text> : null}
      {guard.checkedAt !== null && guard.worktrees.length > 0 ? (
        <View style={[styles.row, { minHeight: 24 }]}>
          <Text style={[styles.head, { flex: 1 }]}>WORKSPACE</Text>
          <SideHead theme={theme} icon="Laptop" label="This Mac" width={sideWidth} narrow={narrow} />
          <SideHead theme={theme} icon="Box" label="Container" width={sideWidth} narrow={narrow} />
          <View style={styles.action} />
        </View>
      ) : null}
      {problems.map(row)}
      {!compact && safe.length > 0 ? (
        <>
          <Pressable accessibilityRole="button" onPress={() => setShowSafe((shown) => !shown)} style={[styles.row, { gap: 8 }]}>
            <Icon name="Check" size={13} color={theme.colors.statusSuccess} />
            <Text style={styles.muted}>
              {problems.length > 0 ? `${safe.length} more work on both sides` : `${safe.length} worktrees work on both sides`}
              {` · ${showSafe ? "hide" : "show"}`}
            </Text>
          </Pressable>
          {showSafe ? safe.map(row) : null}
        </>
      ) : null}
      {compact ? null : (
        <View style={styles.footer}>
          {latest ? (
            <>
              <Icon name="Undo2" size={13} color={latest.error ? theme.colors.statusDanger : theme.colors.statusSuccess} />
              <Text style={styles.muted} numberOfLines={1}>
                {latest.error
                  ? `Could not restore ${latest.title ?? shortPath(latest.folder)}`
                  : `${latest.title ?? shortPath(latest.folder)} restored ${TRIGGERS[latest.trigger] ?? ""} · ${ago(latest.at)}`}
                {restored.length > 1 ? ` · +${restored.length - 1} more today` : ""}
              </Text>
            </>
          ) : guard.companion === "pending" ? (
            <Text style={styles.faint}>The container's guard plugin starts with its Paseo daemon's next start.</Text>
          ) : null}
          <View style={{ flex: 1 }} />
          <Pressable accessibilityRole="link" onPress={openGuide} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name="BookOpen" size={12} color={theme.colors.accent} />
            <Text style={styles.link}>Worktrees guide</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function SideHead({ theme, icon, label, width, narrow }: { theme: Theme; icon: string; label: string; width: number; narrow: boolean }) {
  return (
    <View accessibilityLabel={label} style={{ width, flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />
      {narrow ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5 }}>{label.toUpperCase()}</Text>}
    </View>
  );
}

const SIDE_META: Record<NonNullable<SideState>, { icon: string; label: string; tone: "ok" | "bad" | "warn" | "none" }> = {
  works: { icon: "Check", label: "works", tone: "ok" },
  fails: { icon: "X", label: "git fails", tone: "bad" },
  "at-risk": { icon: "TriangleAlert", label: "prune deletes", tone: "warn" },
  unseen: { icon: "Minus", label: "not here", tone: "none" },
};

function SideCell({ theme, state, width, narrow }: { theme: Theme; state: SideState; width: number; narrow: boolean }) {
  const meta = state ? SIDE_META[state] : { icon: "Minus", label: "not checked", tone: "none" as const };
  const color =
    meta.tone === "ok"
      ? theme.colors.statusSuccess
      : meta.tone === "bad"
        ? theme.colors.statusDanger
        : meta.tone === "warn"
          ? theme.colors.statusWarning
          : theme.colors.foregroundMuted;
  return (
    <View accessibilityLabel={meta.label} style={{ width, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={meta.icon} size={13} color={color} />
      {narrow ? null : <Text style={{ color: meta.tone === "none" ? theme.colors.foregroundMuted : color, fontSize: 12 }}>{meta.label}</Text>}
    </View>
  );
}

function nameOf(entry: GuardWorktree): string {
  return entry.title || entry.folder.split("/").filter(Boolean).pop() || entry.folder;
}

// A few words for the row; the full explanation shows on press.
function reason(entry: GuardWorktree): string {
  if (entry.state === "at-risk") return entry.fix === "share" ? "record uses a path one side can't see" : "only one side sees its folder";
  if (entry.fix === "recreate") return "record lost, never snapshotted";
  if (entry.problem?.startsWith("Its .git file")) return ".git points to the other side's path";
  if (entry.problem?.includes("now belongs to")) return "record taken by another worktree";
  return entry.fix ? "record deleted" : "can't be repaired here";
}

// Pick the branch to recreate a record on, see what would differ, then confirm.
function RecreateChooser({
  theme,
  repoPath,
  name,
  branches,
  busy,
  onRecreate,
}: {
  theme: PluginHostProps["theme"];
  repoPath: string;
  name: string;
  branches: string[];
  busy: boolean;
  onRecreate(branch: string): void;
}) {
  const [branch, setBranch] = useState(branches[0] ?? "");
  const preview = useGuardPreview();
  const query = useQuery({
    queryKey: ["devcontainer-guard-preview", repoPath, name, branch],
    queryFn: () => preview({ repoPath, name, branch }),
    enabled: branch !== "",
  });
  const chip = (selected: boolean) => ({
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: selected ? theme.colors.accent : theme.colors.border,
  });
  return (
    <View style={{ gap: 4, paddingTop: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {branches.map((candidate) => (
          <Pressable key={candidate} onPress={() => setBranch(candidate)} style={chip(candidate === branch)}>
            <Text style={{ color: theme.colors.foreground, fontFamily: MONO, fontSize: 11 }}>{candidate}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {query.isPending
          ? "Comparing with the branch…"
          : query.error
            ? `Could not compare: ${query.error instanceof Error ? query.error.message : String(query.error)}`
            : query.data.total === 0
              ? "Files match the branch: nothing will show as changed."
              : `${query.data.total} tracked ${query.data.total === 1 ? "file differs" : "files differ"} from the branch; they will show as changes, untouched.`}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !branch}
        onPress={() => onRecreate(branch)}
        style={[chip(true), { alignSelf: "flex-start", paddingVertical: 4 }, busy && { opacity: 0.5 }]}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Recreate on {branch}</Text>
      </Pressable>
    </View>
  );
}


const TRIGGERS: Record<string, string> = {
  archive: "after an archive",
  manual: "on request",
};

function shortPath(path: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/)/.exec(path)?.[1];
  return home ? `~${path.slice(home.length)}` : path;
}

function ago(at: number): string {
  const seconds = Math.floor((Date.now() - at) / 1_000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
