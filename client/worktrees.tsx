import { openExternalUrl, type PluginHostProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { GUARD_DOCS_URL, type Guard } from "../shared/contract";
import { HoverPressable } from "./hover";
import { SectionHeading } from "./ports";
import { type ContainerView, STATUS_KEY, toneColor, useRestoreWorktrees } from "./state";

const MONO = "monospace";

interface WorktreesPanelProps extends Pick<PluginHostProps, "theme" | "layout"> {
  view: ContainerView;
  // Without a heading or a "nothing to report" line, for rows outside a card.
  compact?: boolean;
}

// The repository's worktrees as both sides see them: what is at risk or broken, what was repaired
// in the last day, a Restore button, and the docs on what can go wrong.
export function WorktreesPanel({ theme, layout, view, compact = false }: WorktreesPanelProps) {
  const guard = view.container.guard;
  const toast = useToast();
  const queryClient = useQueryClient();
  const restoreWorktrees = useRestoreWorktrees();
  const [busy, setBusy] = useState(false);
  const styles = useMemo(
    () => ({
      section: { marginTop: 6 },
      row: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 10,
        minHeight: layout.compact ? 32 : 24,
        paddingHorizontal: 8,
        paddingVertical: 3,
      },
      dot: { width: 6, height: 6, borderRadius: 3, marginTop: 5 },
      body: { flex: 1, minWidth: 0, gap: 1 },
      folder: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      faint: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 8, paddingTop: 4 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      hovered: { backgroundColor: theme.colors.surface2 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme, layout.compact],
  );
  if (!guard) return null;

  const issues = guard.worktrees;
  const fixable = issues.some((entry) => entry.fixable);
  const restored = guard.restored;
  if (compact && issues.length === 0 && restored.length === 0) return null;

  const restore = async () => {
    setBusy(true);
    try {
      const result = await restoreWorktrees({ repoPath: view.container.repoPath });
      const parts = [
        result.restored > 0 ? `restored ${result.restored}` : null,
        result.failed > 0 ? `${result.failed} failed` : null,
        result.remaining > 0 ? `${result.remaining} still broken` : null,
      ].filter(Boolean);
      const message = `${view.container.name}: ${parts.join(", ") || "nothing to restore"}`;
      if (result.failed > 0 || result.remaining > 0) toast.error(message);
      else toast.show(message, { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      {compact ? null : <SectionHeading theme={theme} text="Worktrees" />}
      {compact ? null : <Text style={[styles.faint, { paddingHorizontal: 8, paddingVertical: 2 }]}>{summary(guard)}</Text>}
      {guard.error ? <Text style={[styles.danger, { paddingHorizontal: 8 }]}>{guard.error}</Text> : null}
      {issues.map((entry) => (
        <View key={`${entry.name}:${entry.folder}`} style={styles.row}>
          <View
            accessibilityLabel={entry.state === "broken" ? "broken" : "at risk"}
            style={[styles.dot, { backgroundColor: toneColor(entry.state === "broken" ? "danger" : "warning", theme) }]}
          />
          <View style={styles.body}>
            <Text style={styles.folder} numberOfLines={1} selectable>
              {shortPath(entry.folder)}
            </Text>
            {entry.problem ? <Text style={styles.muted}>{entry.problem}</Text> : null}
          </View>
        </View>
      ))}
      {restored.map((entry) => (
        <View key={`${entry.at}:${entry.folder}`} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: toneColor(entry.error ? "danger" : "success", theme) }]} />
          <View style={styles.body}>
            <Text style={styles.folder} numberOfLines={1} selectable>
              {shortPath(entry.folder)}
            </Text>
            <Text style={entry.error ? styles.danger : styles.faint}>
              {entry.error
                ? `Could not restore: ${entry.error}`
                : `Restored ${ago(entry.at)} ${TRIGGERS[entry.trigger] ?? ""} by ${entry.side === "host" ? "this machine" : "the container"}`.replace(/\s+/g, " ")}
            </Text>
          </View>
        </View>
      ))}
      {guard.companion === "pending" && !compact ? (
        <Text style={[styles.faint, { paddingHorizontal: 8 }]}>
          The container's worktree guard plugin starts with its Paseo daemon's next start.
        </Text>
      ) : null}
      <View style={styles.actions}>
        {fixable ? (
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel={`Restore worktrees of ${view.container.name}`}
            disabled={busy}
            onPress={() => void restore()}
            style={[styles.button, busy && { opacity: 0.5 }]}
            hoveredStyle={styles.hovered}
          >
            <Text style={styles.buttonText}>{busy ? "Restoring…" : "Restore"}</Text>
          </HoverPressable>
        ) : null}
        <Pressable
          accessibilityRole="link"
          onPress={() => void openExternalUrl(GUARD_DOCS_URL).catch((error: unknown) => toast.error(String(error)))}
        >
          <Text style={styles.link}>What can go wrong</Text>
        </Pressable>
      </View>
    </View>
  );
}

const TRIGGERS: Record<string, string> = {
  archive: "after an archive",
  manual: "on request",
};

function summary(guard: Guard): string {
  const broken = guard.worktrees.filter((entry) => entry.state === "broken").length;
  const atRisk = guard.worktrees.length - broken;
  const counts = [`${guard.safe} safe`, atRisk > 0 ? `${atRisk} at risk` : null, broken > 0 ? `${broken} broken` : null]
    .filter(Boolean)
    .join(" · ");
  if (guard.checkedAt === null) return "Checking…";
  const scope = guard.containerChecked ? "" : " · seen from this machine only";
  return `${counts} · checked ${ago(guard.checkedAt)}${scope}. Shared with the container's git, which can prune or repair them.`;
}

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
