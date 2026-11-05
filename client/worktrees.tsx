import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Guard, GuardWorktree } from "../shared/contract";
import { IconButton } from "./actions";
import { openGuide } from "./guide";
import { HoverPressable } from "./hover";
import { STATUS_KEY, useGuardPreview, useRestoreWorktrees } from "./state";

type Theme = PluginHostProps["theme"];

const MONO = "monospace";
const noop = () => {};

// What the workspace row shows next to the problem's worktree, when it is a workspace.
export interface ProblemWorkspace {
  title: string;
  branch: string | null;
  // "12m", "5d"; null when unknown.
  age: string | null;
}

export function worktreeProblems(guard: Guard | null): GuardWorktree[] {
  return guard?.worktrees.filter((entry) => entry.state !== "safe") ?? [];
}

// The folder's last path segment: Paseo's worktree slug, the same on both sides.
export function slugOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// The heading's health icon: a shield when git works everywhere; the counts live in its tooltip.
export function GuardHealth({ theme, guard, size }: { theme: Theme; guard: Guard | null; size: number }) {
  if (!guard || guard.checkedAt === null) return null;
  const problems = worktreeProblems(guard).length;
  const restored = guard.restored.filter((entry) => !entry.error).length;
  const parts = [
    problems === 0
      ? "Git works on both sides for every worktree"
      : `${guard.safe} of ${guard.worktrees.length} worktrees work on both sides`,
    restored > 0 ? `${restored} restored today` : null,
    guard.containerChecked ? null : "container not checked",
  ].filter(Boolean);
  return (
    <IconButton
      theme={theme}
      icon={problems === 0 ? "ShieldCheck" : "Shield"}
      color={problems === 0 ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
      label="Worktrees guide"
      tooltip={`${parts.join(" · ")}. Open the guide.`}
      size={size}
      disabled={false}
      onPress={openGuide}
      onTooltip={noop}
      onHoverStart={noop}
    />
  );
}

interface ProblemRowProps extends Pick<PluginHostProps, "theme" | "layout"> {
  repoPath: string;
  entry: GuardWorktree;
  workspace: ProblemWorkspace | null;
}

// A workspace whose worktree is broken or at risk: a short label and one verb on the row; the two
// sides, one sentence, and the choice when opened.
export function WorktreeProblemRow({ theme, layout, repoPath, entry, workspace }: ProblemRowProps) {
  const [open, setOpen] = useState(false);
  const broken = entry.state === "broken";
  const tone = broken ? theme.colors.statusDanger : theme.colors.statusWarning;
  const verb =
    entry.fix === "recreate" ? "Recreate" : entry.fix === "share" ? "Make safe" : entry.fix === "restore" ? "Restore" : null;
  const title = workspace?.title ?? entry.title ?? slugOf(entry.folder);

  return (
    <View style={open ? { backgroundColor: theme.colors.surface2, borderRadius: 8, paddingBottom: 12, marginVertical: 2 } : null}>
      <HoverPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}: ${broken ? "git broken" : "at risk"}`}
        onPress={() => setOpen((value) => !value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: layout.compact ? 36 : 28,
          paddingHorizontal: 8,
          borderRadius: 6,
        }}
        hoveredStyle={open ? null : { backgroundColor: theme.colors.surface2 }}
      >
        <View style={{ width: 14, alignItems: "center" }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.foregroundMuted }} />
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO, flex: 1 }} numberOfLines={1}>
          {workspace?.branch ?? ""}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={broken ? "Unlink" : "TriangleAlert"} size={12} color={tone} />
          {layout.compact ? null : <Text style={{ color: tone, fontSize: 12 }}>{broken ? "Git broken" : "At risk"}</Text>}
        </View>
        {verb && !open ? (
          <View
            style={{
              paddingHorizontal: 10,
              paddingVertical: 2,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: broken ? theme.colors.accent : theme.colors.border,
            }}
          >
            <Text style={{ color: broken ? theme.colors.accent : theme.colors.foreground, fontSize: 12 }}>{verb}</Text>
          </View>
        ) : null}
        {workspace?.age ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75, minWidth: 24, textAlign: "right" }}>
            {workspace.age}
          </Text>
        ) : null}
      </HoverPressable>
      {open ? (
        <ProblemDetail theme={theme} repoPath={repoPath} title={title} entry={entry} verb={verb} onClose={() => setOpen(false)} />
      ) : null}
    </View>
  );
}

function ProblemDetail({
  theme,
  repoPath,
  title,
  entry,
  verb,
  onClose,
}: {
  theme: Theme;
  repoPath: string;
  title: string;
  entry: GuardWorktree;
  verb: string | null;
  onClose(): void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const repair = useRestoreWorktrees();
  const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState(entry.branches[0] ?? "");

  const run = async () => {
    setBusy(true);
    try {
      const result = await repair({ repoPath, name: entry.name, ...(entry.fix === "recreate" ? { branch } : {}) });
      if (result.failed > 0) toast.error(`${title}: could not repair it; see the plugin log`);
      else toast.show(`${title}: ${entry.fix === "share" ? "made safe" : "git works again"}`, { variant: "success" });
      onClose();
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ paddingLeft: 32, paddingRight: 12, paddingTop: 4, gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <SideChip theme={theme} icon="Laptop" label="This Mac" state={entry.sides.host} />
        <SideChip theme={theme} icon="Box" label="Container" state={entry.sides.container} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{sentence(entry)}</Text>
      {entry.fix === "recreate" ? (
        <BranchChoice theme={theme} repoPath={repoPath} entry={entry} branch={branch} onBranch={setBranch} />
      ) : null}
      {entry.fix === "share" && entry.target ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontFamily: MONO, textDecorationLine: "line-through" }}>
            {shortPath(entry.folder)}
          </Text>
          <Icon name="ArrowRight" size={12} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: MONO }}>{shortPath(entry.target)}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {verb ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy || (entry.fix === "recreate" && !branch)}
            onPress={() => void run()}
            style={{
              backgroundColor: theme.colors.accent,
              borderRadius: 6,
              paddingHorizontal: 12,
              paddingVertical: 4,
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={{ color: theme.colors.surface0, fontSize: 12, fontWeight: "600" }}>{busy ? `${verb}…` : verb}</Text>
          </Pressable>
        ) : null}
        <HoverPressable
          accessibilityRole="button"
          onPress={onClose}
          style={{ borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 3 }}
          hoveredStyle={{ backgroundColor: theme.colors.surface1 }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{verb ? "Cancel" : "Close"}</Text>
        </HoverPressable>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="link" onPress={openGuide} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name="BookOpen" size={12} color={theme.colors.accent} />
          <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Guide</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SideChip({
  theme,
  icon,
  label,
  state,
}: {
  theme: Theme;
  icon: string;
  label: string;
  state: GuardWorktree["sides"]["host"];
}) {
  const meta =
    state === "works"
      ? { icon: "Check", color: theme.colors.statusSuccess, border: theme.colors.border }
      : state === "fails"
        ? { icon: "X", color: theme.colors.statusDanger, border: theme.colors.statusDanger }
        : state === "at-risk"
          ? { icon: "TriangleAlert", color: theme.colors.statusWarning, border: theme.colors.statusWarning }
          : { icon: "Minus", color: theme.colors.foregroundMuted, border: theme.colors.border };
  return (
    <View
      accessibilityLabel={`${label}: ${state ?? "not checked"}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: meta.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Icon name={meta.icon} size={12} color={meta.color} />
    </View>
  );
}

// Branches as a segmented control, then what the choice would show as changed.
function BranchChoice({
  theme,
  repoPath,
  entry,
  branch,
  onBranch,
}: {
  theme: Theme;
  repoPath: string;
  entry: GuardWorktree;
  branch: string;
  onBranch(branch: string): void;
}) {
  const preview = useGuardPreview();
  const query = useQuery({
    queryKey: ["devcontainer-guard-preview", repoPath, entry.name, branch],
    queryFn: () => preview({ repoPath, name: entry.name, branch }),
    enabled: branch !== "",
  });
  const files = query.data;
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5, opacity: 0.8 }}>RECREATE ON BRANCH</Text>
      <View
        style={{
          flexDirection: "row",
          alignSelf: "flex-start",
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 7,
          overflow: "hidden",
        }}
      >
        {entry.branches.map((candidate, index) => {
          const selected = candidate === branch;
          return (
            <Pressable
              key={candidate}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onBranch(candidate)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderLeftWidth: index === 0 ? 0 : 1,
                borderLeftColor: theme.colors.border,
                backgroundColor: selected ? theme.colors.surface1 : "transparent",
              }}
            >
              {selected ? <Icon name="GitBranch" size={12} color={theme.colors.accent} /> : null}
              <Text style={{ color: selected ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontFamily: MONO }}>
                {candidate}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="FileDiff" size={12} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
          {query.isPending
            ? "Comparing…"
            : !files
              ? "Could not compare with the branch"
              : files.total === 0
                ? "Files match the branch"
                : `${files.total} ${files.total === 1 ? "file differs" : "files differ"} and stay as they are`}
        </Text>
        {files && files.total > 0 ? (
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO, opacity: 0.7, flexShrink: 2 }}
            numberOfLines={1}
          >
            {files.files.slice(0, 2).map(slugOf).join(" · ")}
            {files.total > 2 ? ` · +${files.total - 2}` : ""}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function sentence(entry: GuardWorktree): string {
  const side = entry.sides.host === "at-risk" ? "this Mac" : "the container";
  if (entry.fix === "recreate") return "Its git record was deleted before the guard could save it.";
  if (entry.fix === "share") return `Its record uses a path ${side} can't see, so a prune there would delete it.`;
  if (entry.state === "at-risk") return `Only one side sees its folder, so a prune on ${side} would delete its record.`;
  if (entry.fix === "restore") {
    return entry.problem?.startsWith("Its .git file")
      ? "Its .git file points to a path one side can't open."
      : "Its git record was deleted; a saved copy brings it back.";
  }
  return "This one can't be repaired here; the guide shows how to recover it by hand.";
}

function shortPath(path: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/)/.exec(path)?.[1];
  const short = home ? `~${path.slice(home.length)}` : path;
  const parts = short.split("/");
  return parts.length > 4 ? `${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}` : short;
}
