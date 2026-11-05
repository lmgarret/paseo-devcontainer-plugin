import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ACTION_LABELS } from "../shared/contract";
import { PortPills } from "./ports";
import { FolderIcon, ProjectIcon } from "./project-icon";
import {
  type ContainerView,
  type DevcontainersState,
  FAILURE_VISIBLE_MS,
  guardBadge,
  kindColor,
  STATUS_KEY,
  toneColor,
  type UiAction,
  useDismissJob,
  useOpenLogs,
  useOpenShell,
  workspaceLabel,
} from "./state";

export const ACTION_META: Record<UiAction, { icon: string; label: string }> = {
  start: { icon: "Play", label: ACTION_LABELS.start },
  stop: { icon: "Square", label: ACTION_LABELS.stop },
  rebuild: { icon: "Hammer", label: ACTION_LABELS.rebuild },
  "rebuild-no-cache": { icon: "Eraser", label: ACTION_LABELS["rebuild-no-cache"] },
  "start-daemon": { icon: "Zap", label: ACTION_LABELS["start-daemon"] },
  "install-paseo": { icon: "Download", label: ACTION_LABELS["install-paseo"] },
  shell: { icon: "SquareTerminal", label: "Shell" },
  logs: { icon: "ScrollText", label: "Logs" },
  dismiss: { icon: "X", label: "Dismiss" },
};

// Tooltip text: what the button does, not just its name.
const ACTION_TOOLTIPS: Record<UiAction, string> = {
  start: "Start container",
  stop: "Stop container",
  rebuild: "Rebuild container",
  "rebuild-no-cache": "Rebuild container without the image cache",
  "start-daemon": "Start the Paseo daemon",
  "install-paseo": "Install Paseo in the container",
  shell: "Open a shell in the container",
  logs: "Open the log in a terminal",
  dismiss: "Dismiss the failure",
};
const TOOLTIP_DELAY_MS = 350;
// Rows wait longer so passing over them on the way to an icon shows nothing.
const ROW_TOOLTIP_DELAY_MS = 700;
// Safety net for a missed hover-out.
const TOOLTIP_MAX_MS = 4_000;
let activeTooltip: { current: () => void } | null = null;

// Each leading column (chevron, status dot, project icon) is 16 wide plus a 10 gap; text under
// the name, and a card's panel, indent by the columns a row shows.
export const LEAD = 26;
export const CARD_INDENT = 3 * LEAD;

const NEEDS_CONFIRM: ReadonlySet<UiAction> = new Set(["stop", "rebuild", "rebuild-no-cache"]);

interface ContainerRowProps extends Pick<PluginHostProps, "theme" | "layout"> {
  // This plugin's host, for project icon colours.
  hostId: string;
  view: ContainerView;
  state: DevcontainersState;
  // Popover rows and page cards name the project; page rows sit under a project header and name
  // the workspace.
  variant: "popover" | "page" | "card";
  // Receives the workspace holding a new shell or log terminal.
  onOpenWorkspace(workspaceId: string): void;
  // Pressing the row: the page expands it, the popover shows it on the page. A container hosts
  // many workspaces, so the row never guesses one to open.
  onPress?: () => void;
  pressLabel?: string;
  // Page rows: hide from the sidebar popover, or bring back.
  onToggleHidden?: () => void;
  // Page rows of running containers: show or hide the daemon and ports panel below.
  expanded?: boolean;
  onToggleExpanded?: () => void;
}

// One line like Paseo's host list: status dot, name, muted context, and ghost icon actions.
export function ContainerRow({
  theme,
  layout,
  hostId,
  view,
  state,
  variant,
  onOpenWorkspace,
  onPress,
  pressLabel,
  onToggleHidden,
  expanded = false,
  onToggleExpanded,
}: ContainerRowProps) {
  const toast = useToast();
  const openShell = useOpenShell();
  const openLogs = useOpenLogs();
  const dismissJob = useDismissJob();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<UiAction | null>(null);
  const [opening, setOpening] = useState(false);
  const [hovered, setHovered] = useState(false);
  // A visible tooltip lifts the row above its siblings so the bubble is not painted over.
  const [tooltipShown, setTooltipShown] = useState(false);
  // Hovering the row itself shows its full, untruncated text.
  const rowTooltip = useTooltip(ROW_TOOLTIP_DELAY_MS, setTooltipShown);
  const { container } = view;
  // Cards are page rows that lead the running section with their project's icon and name.
  const card = variant === "card";
  const page = variant !== "popover";
  const expandable = page && onToggleExpanded !== undefined;
  const indent = (expandable ? LEAD : 0) + LEAD + (page && !card ? 0 : LEAD);
  const hit = layout.compact ? 32 : 22;
  const styles = useMemo(
    () => ({
      row: { paddingVertical: card ? 8 : page ? 6 : 5, paddingHorizontal: 8, gap: 1, borderRadius: 6 },
      hovered: { backgroundColor: theme.colors.surface2 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: layout.compact ? 36 : 26 },
      lead: { width: 16, alignItems: "center" as const, justifyContent: "center" as const },
      dot: { width: 7, height: 7, borderRadius: 4 },
      text: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 6 },
      // The name keeps its width; the muted context truncates first.
      name: { color: theme.colors.foreground, fontSize: 14, flexShrink: 0, maxWidth: "70%" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      danger: { color: theme.colors.statusDanger, fontSize: 12, flexShrink: 1 },
      icons: { flexDirection: "row" as const, alignItems: "center" as const },
      confirm: { color: theme.colors.foreground, fontSize: 12, marginRight: 2 },
      // Under the name: page rows lead with a chevron and a dot, popover rows with a dot and an icon.
      sub: { color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: page ? indent : 24 },
      log: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace", paddingLeft: page ? indent : 24 },
    }),
    [theme, page, card, indent, hit, layout.compact],
  );

  async function run(action: UiAction) {
    setConfirming(null);
    try {
      if (action === "shell" || action === "logs") {
        setOpening(true);
        const open = action === "shell" ? openShell : openLogs;
        const { workspaceId } = await open({ repoPath: container.repoPath });
        onOpenWorkspace(workspaceId);
      } else if (action === "dismiss") {
        await dismissJob({ repoPath: container.repoPath });
        await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      } else {
        const logWorkspaceId = await state.run(container.repoPath, action);
        if (logWorkspaceId) onOpenWorkspace(logWorkspaceId);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  }

  const disabled = state.pending || opening;
  const iconButton = (icon: string, label: string, color: string, onPress: () => void, tooltip = label) => (
    <IconButton
      key={label}
      theme={theme}
      icon={icon}
      color={color}
      label={`${label} ${container.name}`}
      tooltip={tooltip}
      size={hit}
      disabled={disabled}
      onPress={onPress}
      onTooltip={setTooltipShown}
      onHoverStart={rowTooltip.hide}
    />
  );

  const job = container.job;
  // A failure that left no running container stays until dismissed.
  const failed =
    job?.state === "failed" &&
    (container.docker !== "running" || (job.endedAt !== null && Date.now() - job.endedAt < FAILURE_VISIBLE_MS))
      ? job
      : null;
  const color = kindColor(view.kind, theme);
  const where = workspaceLabel(container);
  // A project's main checkout is the default; only worktrees need their workspace named in the popover.
  const mainCheckout = !container.workspace && container.project?.rootPath === container.repoPath;
  const popoverWhere = mainCheckout ? null : where;
  // Online and stopped are carried by the dot; other states are worth words.
  const quiet = view.kind === "online" || (view.kind === "stopped" && container.docker === "stopped");
  const title = page && !card ? where : container.name;
  // An online host is carried by the dot, so only its name is worth words.
  const host = view.host
    ? view.host.status === "online"
      ? view.host.label
      : `${view.host.label} ${view.host.status}`
    : null;
  // Page rows fit on one line: the state when worth words, the paired host, the branch when the
  // workspace is named otherwise, and whether the sidebar hides it.
  const context = page
    ? [
        card ? popoverWhere : null,
        quiet ? null : view.label,
        host,
        !card && container.workspace && container.branch ? container.branch : null,
        container.hidden ? "hidden" : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
    : [popoverWhere, quiet ? null : view.label].filter(Boolean).join(" · ") || null;
  // The Docker container's name is rarely needed; hovering the row shows it.
  const fullText = [title, page && !card ? null : where, view.label, host, container.containerName, view.detail]
    .filter(Boolean)
    .join(" · ");

  const status =
    view.kind === "busy" ? (
      <ActivityIndicator size="small" color={color} style={{ transform: [{ scale: 0.55 }] }} />
    ) : (
      <View accessibilityLabel={view.label} style={[styles.dot, { backgroundColor: color }]} />
    );

  return (
    // The whole row responds to a press; icons press on their own.
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? (pressLabel ?? title) : undefined}
      onPress={onPress}
      onHoverIn={() => {
        setHovered(true);
        rowTooltip.showLater();
      }}
      onHoverOut={() => {
        setHovered(false);
        rowTooltip.hide();
      }}
      style={[styles.row, hovered && styles.hovered, tooltipShown && { zIndex: 10 }]}
    >
      {rowTooltip.shown ? <TooltipBubble theme={theme} text={fullText} top={layout.compact ? 40 : 30} align="left" /> : null}
      <View style={styles.line}>
        {expandable ? (
          <View style={styles.lead}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
              hitSlop={6}
              onPress={onToggleExpanded}
            >
              <Icon
                name={expanded ? "ChevronDown" : "ChevronRight"}
                size={13}
                color={expanded ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.lead}>{status}</View>
        {page && !card ? null : container.project ? (
          <ProjectIcon project={container.project} hostId={hostId} />
        ) : (
          <FolderIcon theme={theme} />
        )}
        <View style={styles.text}>
          <Text style={[styles.name, card && { fontWeight: "500" }]} numberOfLines={1}>
            {title}
          </Text>
          {failed ? (
            <Text style={styles.danger} numberOfLines={1}>
              {ACTION_META[failed.action].label} failed
            </Text>
          ) : context ? (
            <Text style={styles.muted} numberOfLines={1}>
              {context}
            </Text>
          ) : null}
        </View>
        {confirming ? null : <GuardPill theme={theme} view={view} popover={!page} />}
        {confirming ? null : <PortPills theme={theme} container={container} max={page ? 3 : 2} />}
        {confirming ? (
          <View style={styles.icons}>
            <Text style={styles.confirm}>{ACTION_META[confirming].label}?</Text>
            {iconButton("Check", `Confirm ${ACTION_META[confirming].label.toLowerCase()}`, theme.colors.statusDanger, () =>
              void run(confirming),
            )}
            {/* A stale image layer is a common cause of a broken build; offer the clean variant here. */}
            {confirming === "rebuild"
              ? iconButton(
                  ACTION_META["rebuild-no-cache"].icon,
                  ACTION_META["rebuild-no-cache"].label,
                  theme.colors.statusDanger,
                  () => void run("rebuild-no-cache"),
                  ACTION_TOOLTIPS["rebuild-no-cache"],
                )
              : null}
            {iconButton("X", "Cancel", theme.colors.foregroundMuted, () => setConfirming(null), "Cancel")}
          </View>
        ) : (
          <View style={styles.icons}>
            {view.actions.map((action, index) =>
              iconButton(
                ACTION_META[action].icon,
                ACTION_META[action].label,
                // The leading recovery action (start, retry, start daemon, install) stands out.
                index === 0 && action !== "shell" && action !== "logs" ? theme.colors.accent : theme.colors.foregroundMuted,
                () => (NEEDS_CONFIRM.has(action) ? setConfirming(action) : void run(action)),
                ACTION_TOOLTIPS[action],
              ),
            )}
            {onToggleHidden
              ? iconButton(
                  container.hidden ? "Eye" : "EyeOff",
                  container.hidden ? "Show in sidebar" : "Hide from sidebar",
                  theme.colors.foregroundMuted,
                  onToggleHidden,
                )
              : null}
          </View>
        )}
      </View>
      {failed?.error ? (
        <Text style={styles.sub} numberOfLines={page ? 3 : 1} selectable>
          {failed.error}
        </Text>
      ) : null}
      {/* A second line only for what needs attention: warnings and running jobs. */}
      {page ? (
        <>
          {view.detail ? <Text style={styles.sub}>{view.detail}</Text> : null}
          {job?.state === "running"
            ? job.log.slice(-3).map((line, index) => (
                <Text key={`${job.id}-${index}`} style={styles.log} numberOfLines={1}>
                  {line}
                </Text>
              ))
            : null}
        </>
      ) : null}
    </Pressable>
  );
}

// Worktrees broken, at risk, or repaired; the popover only shows broken ones.
function GuardPill({ theme, view, popover }: { theme: PluginHostProps["theme"]; view: ContainerView; popover: boolean }) {
  const badge = guardBadge(view.container.guard);
  if (!badge || (popover && badge.tone !== "danger")) return null;
  if (badge.broken + badge.atRisk === 0) return null;
  const counts: [number, string][] = [
    [badge.broken, theme.colors.statusDanger],
    [badge.atRisk, theme.colors.statusWarning],
  ];
  const tip = [
    badge.broken > 0 ? `${badge.broken} ${badge.broken === 1 ? "workspace where" : "workspaces where"} git is broken` : null,
    badge.atRisk > 0 ? `${badge.atRisk} at risk of breaking` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <WithTooltip theme={theme} text={`Git worktrees: ${tip}. ${popover ? "Open the container to fix." : "Fix them in the workspace list below."}`} align="right">
      <View
        accessibilityLabel={`Worktrees: ${badge.text}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 7,
          paddingVertical: 1,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          flexShrink: 0,
        }}
      >
        <Icon name="GitBranch" size={12} color={toneColor(badge.tone, theme)} />
        {counts
          .filter(([count]) => count > 0)
          .map(([count, color]) => (
            <Text key={color} style={{ color, fontSize: 11, fontVariant: ["tabular-nums"] }}>
              {count}
            </Text>
          ))}
      </View>
    </WithTooltip>
  );
}

// Shows `text` in a bubble below its children on hover, after the usual delay. Presses go to
// `onPress`, so wrapping part of a pressable row keeps the row working.
export function WithTooltip({
  theme,
  text,
  children,
  align = "left",
  top = 22,
  onPress,
}: {
  theme: PluginHostProps["theme"];
  text: string;
  children: ReactNode;
  align?: "left" | "right";
  top?: number;
  onPress?: () => void;
}) {
  const tip = useTooltip(TOOLTIP_DELAY_MS);
  return (
    <Pressable
      accessible={false}
      onPress={onPress}
      onHoverIn={tip.showLater}
      onHoverOut={tip.hide}
      style={{ position: "relative", zIndex: tip.shown ? 20 : 0 }}
    >
      {children}
      {tip.shown ? <TooltipBubble theme={theme} text={text} top={top} align={align} /> : null}
    </Pressable>
  );
}

interface IconButtonProps {
  theme: PluginHostProps["theme"];
  icon: string;
  color: string;
  label: string;
  tooltip: string;
  size: number;
  disabled: boolean;
  onPress(): void;
  onTooltip(shown: boolean): void;
  // Lets the row cancel its own pending tooltip when the pointer reaches an icon.
  onHoverStart(): void;
}

// Ghost icon button with a hover background and a delayed tooltip below it, right-aligned so the
// bubble grows inward from the row's right edge and stays inside the popover.
// Delayed hover tooltip shared by icon buttons and rows: one visible at a time, and handlers read
// refs because the web Pressable can keep the first handler it was given.
function useTooltip(delayMs: number, onChange?: (shown: boolean) => void) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const hideRef = useRef<() => void>(() => {});

  hideRef.current = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setShown(false);
    onChangeRef.current?.(false);
    if (activeTooltip === hideRef) activeTooltip = null;
  };
  const showLater = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (activeTooltip && activeTooltip !== hideRef) activeTooltip.current();
      activeTooltip = hideRef;
      setShown(true);
      onChangeRef.current?.(true);
      // Safety net for a missed hover-out.
      timer.current = setTimeout(() => hideRef.current(), TOOLTIP_MAX_MS);
    }, delayMs);
  };
  useEffect(() => () => hideRef.current(), []);
  return { shown, showLater, hide: () => hideRef.current() };
}

function TooltipBubble({ theme, text, top, align }: { theme: PluginHostProps["theme"]; text: string; top: number; align: "left" | "right" }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top,
        ...(align === "right" ? { right: 0, alignItems: "flex-end" as const } : { left: 0, alignItems: "flex-start" as const }),
        width: 320,
        zIndex: 100,
      }}
    >
      <View
        style={{
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={4}>
          {text}
        </Text>
      </View>
    </View>
  );
}

export function IconButton({
  theme,
  icon,
  color,
  label,
  tooltip,
  size,
  disabled,
  onPress,
  onTooltip,
  onHoverStart,
}: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const bubble = useTooltip(TOOLTIP_DELAY_MS, onTooltip);
  const hoverIn = () => {
    setHovered(true);
    onHoverStart();
    bubble.showLater();
  };
  const hoverOut = () => {
    setHovered(false);
    bubble.hide();
  };

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={() => {
          hoverOut();
          onPress();
        }}
        onHoverIn={hoverIn}
        onHoverOut={hoverOut}
        style={({ pressed }) => ({
          width: size,
          height: size,
          borderRadius: 5,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
          backgroundColor: hovered || pressed ? theme.colors.border : "transparent",
        })}
      >
        <Icon name={icon} size={14} color={color} />
      </Pressable>
      {bubble.shown ? <TooltipBubble theme={theme} text={tooltip} top={size + 4} align="right" /> : null}
    </View>
  );
}
