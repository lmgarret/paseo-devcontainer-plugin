import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ACTION_LABELS } from "../shared/contract";
import { FolderIcon, ProjectIcon } from "./project-icon";
import {
  type ContainerView,
  canOpenWorkspace,
  type DevcontainersState,
  kindColor,
  resolveWorkspace,
  type UiAction,
  useOpenShell,
  type WorkspaceTarget,
  workspaceLabel,
} from "./state";

export const ACTION_META: Record<UiAction, { icon: string; label: string }> = {
  start: { icon: "Play", label: ACTION_LABELS.start },
  stop: { icon: "Square", label: ACTION_LABELS.stop },
  rebuild: { icon: "RotateCw", label: ACTION_LABELS.rebuild },
  "start-daemon": { icon: "Zap", label: ACTION_LABELS["start-daemon"] },
  "install-paseo": { icon: "Download", label: ACTION_LABELS["install-paseo"] },
  shell: { icon: "SquareTerminal", label: "Shell" },
};

// Tooltip text: what the button does, not just its name.
const ACTION_TOOLTIPS: Record<UiAction, string> = {
  start: "Start container",
  stop: "Stop container",
  rebuild: "Rebuild container",
  "start-daemon": "Start the Paseo daemon",
  "install-paseo": "Install Paseo in the container",
  shell: "Open a shell in the container",
};
const TOOLTIP_DELAY_MS = 350;
// Safety net for a missed hover-out.
const TOOLTIP_MAX_MS = 4_000;
let activeTooltip: { current: () => void } | null = null;

const NEEDS_CONFIRM: ReadonlySet<UiAction> = new Set(["stop", "rebuild"]);
// A failure stays in the row this long, then the row shows the plain state again.
const FAILURE_VISIBLE_MS = 10 * 60_000;

interface ContainerRowProps extends Pick<PluginHostProps, "theme" | "layout"> {
  // This plugin's host, for project icon colours.
  hostId: string;
  view: ContainerView;
  state: DevcontainersState;
  // Popover rows name the project; page rows sit under a project header and name the workspace.
  variant: "popover" | "page";
  // Receives the workspace holding the new shell terminal.
  onShell(workspaceId: string): void;
  onOpenWorkspace(target: WorkspaceTarget): void;
  // Page rows: hide from the sidebar popover, or bring back.
  onToggleHidden?: () => void;
}

// One line like Paseo's host list: status dot, name, muted context, and ghost icon actions.
export function ContainerRow({
  theme,
  layout,
  hostId,
  view,
  state,
  variant,
  onShell,
  onOpenWorkspace,
  onToggleHidden,
}: ContainerRowProps) {
  const toast = useToast();
  const openShell = useOpenShell();
  const [confirming, setConfirming] = useState<UiAction | null>(null);
  const [opening, setOpening] = useState(false);
  const [hovered, setHovered] = useState(false);
  // A visible tooltip lifts the row above its siblings so the bubble is not painted over.
  const [tooltipShown, setTooltipShown] = useState(false);
  const { container } = view;
  const page = variant === "page";
  const hit = layout.compact ? 32 : 22;
  const styles = useMemo(
    () => ({
      row: { paddingVertical: page ? 6 : 5, paddingHorizontal: 8, gap: 1, borderRadius: 6 },
      hovered: { backgroundColor: theme.colors.surface2 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: layout.compact ? 36 : 26 },
      lead: { width: 16, alignItems: "center" as const, justifyContent: "center" as const },
      dot: { width: 7, height: 7, borderRadius: 4 },
      text: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 6 },
      name: { color: theme.colors.foreground, fontSize: 14, flexShrink: 1 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 2 },
      danger: { color: theme.colors.statusDanger, fontSize: 12, flexShrink: 2 },
      icons: { flexDirection: "row" as const, alignItems: "center" as const },
      confirm: { color: theme.colors.foreground, fontSize: 12, marginRight: 2 },
      sub: { color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: 24 },
      log: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace", paddingLeft: 24 },
    }),
    [theme, page, hit, layout.compact],
  );

  async function run(action: UiAction) {
    setConfirming(null);
    try {
      if (action === "shell") {
        setOpening(true);
        const { workspaceId } = await openShell({ repoPath: container.repoPath });
        onShell(workspaceId);
      } else {
        await state.run(container.repoPath, action);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  }

  async function open() {
    const target = await resolveWorkspace(view);
    if (target) onOpenWorkspace(target);
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
    />
  );

  const job = container.job;
  const failed =
    job?.state === "failed" && job.endedAt !== null && Date.now() - job.endedAt < FAILURE_VISIBLE_MS ? job : null;
  const color = kindColor(view.kind, theme);
  const where = workspaceLabel(container);
  // Online and stopped are carried by the dot; other states are worth words.
  const quiet = view.kind === "online" || (view.kind === "stopped" && container.docker === "stopped");
  const title = page ? where : container.name;
  const context = page ? (quiet ? null : view.label) : quiet ? where : `${where} · ${view.label}`;
  const host = view.host
    ? `${view.host.label} ${view.host.status}`
    : container.serverId
      ? `${container.serverId} not paired`
      : null;
  const subline = [
    page && container.workspace && container.branch ? container.branch : null,
    container.containerName ?? "not created",
    host,
    container.hidden ? "hidden from sidebar" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const status =
    view.kind === "busy" ? (
      <ActivityIndicator size="small" color={color} style={{ transform: [{ scale: 0.55 }] }} />
    ) : (
      <View accessibilityLabel={view.label} style={[styles.dot, { backgroundColor: color }]} />
    );

  const openable = canOpenWorkspace(view);
  return (
    // The whole row opens the workspace, like a host row selects its host; icons press on their own.
    <Pressable
      accessibilityRole={openable ? "link" : undefined}
      accessibilityLabel={openable ? `Open ${title}` : undefined}
      onPress={openable ? () => void open() : undefined}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, hovered && styles.hovered, tooltipShown && { zIndex: 10 }]}
    >
      <View style={styles.line}>
        <View style={styles.lead}>{status}</View>
        {page ? null : container.project ? (
          <ProjectIcon project={container.project} hostId={hostId} />
        ) : (
          <FolderIcon theme={theme} />
        )}
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
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
        {confirming ? (
          <View style={styles.icons}>
            <Text style={styles.confirm}>{ACTION_META[confirming].label}?</Text>
            {iconButton("Check", `Confirm ${ACTION_META[confirming].label.toLowerCase()}`, theme.colors.statusDanger, () =>
              void run(confirming),
            )}
            {iconButton("X", "Cancel", theme.colors.foregroundMuted, () => setConfirming(null), "Cancel")}
          </View>
        ) : (
          <View style={styles.icons}>
            {view.actions.map((action, index) =>
              iconButton(
                ACTION_META[action].icon,
                ACTION_META[action].label,
                // The leading recovery action (start, start daemon, install) stands out.
                index === 0 && action !== "shell" ? theme.colors.accent : theme.colors.foregroundMuted,
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
      {page ? (
        <>
          <Text style={styles.sub} numberOfLines={1} selectable>
            {subline}
          </Text>
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
}

// Ghost icon button with a hover background and a delayed tooltip below it, right-aligned so the
// bubble grows inward from the row's right edge and stays inside the popover.
function IconButton({ theme, icon, color, label, tooltip, size, disabled, onPress, onTooltip }: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Handlers can be captured once by the web Pressable, so they read refs rather than state.
  const onTooltipRef = useRef(onTooltip);
  onTooltipRef.current = onTooltip;
  const hideRef = useRef<() => void>(() => {});

  hideRef.current = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHovered(false);
    setShown(false);
    onTooltipRef.current(false);
    if (activeTooltip === hideRef) activeTooltip = null;
  };
  const hoverIn = () => {
    setHovered(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Only one tooltip at a time, even if a hover-out was missed.
      if (activeTooltip && activeTooltip !== hideRef) activeTooltip.current();
      activeTooltip = hideRef;
      setShown(true);
      onTooltipRef.current(true);
      timer.current = setTimeout(() => hideRef.current(), TOOLTIP_MAX_MS);
    }, TOOLTIP_DELAY_MS);
  };
  const hoverOut = () => hideRef.current();
  useEffect(() => () => hideRef.current(), []);

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={() => {
          hideRef.current();
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
      {shown ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", top: size + 4, right: 0, width: 240, alignItems: "flex-end", zIndex: 100 }}
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
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
              {tooltip}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
