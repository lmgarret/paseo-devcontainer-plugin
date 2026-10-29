import { openExternalUrl, type PluginHostProps } from "@getpaseo/plugin/client";
import { copyText, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Container, Forward } from "../shared/contract";
import { IconButton } from "./actions";
import { HoverPressable } from "./hover";
import { appForwards, type ContainerView, daemonForward, usePortActions } from "./state";

type Theme = PluginHostProps["theme"];

const noop = () => {};
const MONO = "monospace";
// A port seen after the app loaded stands out this long, tying its toast to where it is.
const FRESH_MS = 8_000;
const UNDO_MS = 10_000;
const loadedAt = Date.now();
const firstSeen = new Map<string, number>();

function urlOf(forward: Forward): string | null {
  return forward.hostPort === null ? null : `http://localhost:${forward.hostPort}`;
}

function isFresh(container: Container, forward: Forward): boolean {
  const key = `${container.repoPath}:${forward.containerPort}`;
  const now = Date.now();
  if (!firstSeen.has(key)) firstSeen.set(key, now);
  const seen = firstSeen.get(key) ?? now;
  // Ports already open when the app loads are not news.
  return seen - loadedAt > 3_000 && now - seen < FRESH_MS;
}

// Open in the browser, or say why it cannot be; shared by pills and panel rows.
function useOpenForward() {
  const toast = useToast();
  return (forward: Forward) => {
    const url = urlOf(forward);
    if (!url) {
      toast.error(`Port ${forward.containerPort} is not forwarded: ${forward.error ?? "unknown error"}`);
      return;
    }
    void openExternalUrl(url).catch((error: unknown) => toast.error(String(error)));
  };
}

// The row's ports as small pills, so opening a dev server takes one click from the list.
export function PortPills({ theme, container, max }: { theme: Theme; container: Container; max: number }) {
  const open = useOpenForward();
  const ports = appForwards(container);
  if (ports.length === 0) return null;
  const shown = ports.slice(0, max);
  const pill = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: theme.colors.surface2,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
      {shown.map((forward) => {
        const failed = forward.hostPort === null;
        const fresh = isFresh(container, forward);
        return (
          <HoverPressable
            key={forward.containerPort}
            accessibilityRole="link"
            accessibilityLabel={failed ? `Port ${forward.containerPort} not forwarded` : `Open ${urlOf(forward)}`}
            onPress={() => open(forward)}
            style={[pill, { borderColor: fresh ? theme.colors.accent : theme.colors.border }]}
            hoveredStyle={{ borderColor: theme.colors.foregroundMuted }}
          >
            <StateDot theme={theme} forward={forward} size={5} />
            <Text
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: failed ? theme.colors.statusDanger : fresh ? theme.colors.foreground : theme.colors.foregroundMuted,
              }}
            >
              {forward.containerPort}
            </Text>
          </HoverPressable>
        );
      })}
      {ports.length > max ? (
        <View style={[pill, { borderColor: theme.colors.border }]}>
          <Text style={{ fontFamily: MONO, fontSize: 11, color: theme.colors.foregroundMuted }}>+{ports.length - max}</Text>
        </View>
      ) : null}
    </View>
  );
}

// Filled when forwarded and listening, hollow while waiting for a listener, red when it failed.
function StateDot({ theme, forward, size }: { theme: Theme; forward: Forward; size: number }) {
  const failed = forward.hostPort === null;
  const color = failed ? theme.colors.statusDanger : theme.colors.statusSuccess;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size,
        backgroundColor: forward.listening || failed ? color : "transparent",
        borderWidth: forward.listening || failed ? 0 : 1,
        borderColor: theme.colors.foregroundMuted,
      }}
    />
  );
}

// An uppercase label with a rule, opening each block of a container's details.
export function SectionHeading({ theme, text }: { theme: Theme; text: string }) {
  return (
    // Lines up with the text below it, not with the daemon box's border.
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, paddingLeft: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5, opacity: 0.8 }}>
        {text.toUpperCase()}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
    </View>
  );
}

interface PortsPanelProps extends Pick<PluginHostProps, "theme" | "layout"> {
  view: ContainerView;
  // Lines the panel up with the container's name in the row above.
  indent: number;
  // Sections shown before the ports, such as the container's workspaces.
  before?: ReactNode;
}

// A running container's expanded details: its forwarded ports with open, copy, and stop, a ghost
// row to forward one by hand, ignored ports, then the daemon's pairing address.
export function PortsPanel({ theme, layout, view, indent, before }: PortsPanelProps) {
  const { container } = view;
  const toast = useToast();
  const actions = usePortActions();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [undo, setUndo] = useState<Forward | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);
  const hit = layout.compact ? 32 : 22;
  const daemon = daemonForward(container);
  const ports = appForwards(container);
  const ignored = actions.ignored(container.repoPath);
  const styles = useMemo(
    () => ({
      root: { paddingLeft: indent, paddingRight: 8, paddingBottom: 10, gap: 2 },
      section: { marginTop: 6 },
      daemon: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 10,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      mono: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 12 },
      faint: { color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.75 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      badge: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        minHeight: layout.compact ? 36 : 28,
        paddingHorizontal: 8,
        borderRadius: 6,
      },
      hovered: { backgroundColor: theme.colors.surface2 },
      port: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 12, width: 48 },
      process: { color: theme.colors.foregroundMuted, fontSize: 12, flex: 1, minWidth: 0 },
      remap: { color: theme.colors.statusWarning, fontSize: 11 },
      tag: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 3,
        paddingHorizontal: 4,
      },
      input: {
        color: theme.colors.foreground,
        fontFamily: MONO,
        fontSize: 12,
        width: 120,
        paddingVertical: 2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.accent,
      },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme, layout.compact, indent],
  );

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) =>
    void attempt(async () => {
      await copyText(text);
      toast.show(`Copied ${text}`, { variant: "success", durationMs: 1_500 });
    });

  const stop = (forward: Forward) =>
    void attempt(async () => {
      await actions.stop(container.repoPath, forward);
      // Dropping a port added by hand needs no undo; ignoring a detected one does.
      if (forward.manual) return;
      setUndo(forward);
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    });

  const closeAdd = () => {
    setAdding(false);
    setDraft("");
  };
  const submit = () => {
    const port = Number(draft.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("Enter a port between 1 and 65535");
      return;
    }
    void attempt(async () => {
      await actions.forward(container.repoPath, port);
      closeAdd();
    });
  };

  const iconButton = (icon: string, label: string, onPress: () => void) => (
    <IconButton
      key={label}
      theme={theme}
      icon={icon}
      color={theme.colors.foregroundMuted}
      label={label}
      tooltip={label}
      size={hit}
      disabled={busy || !actions.ready}
      onPress={onPress}
      onTooltip={noop}
      onHoverStart={noop}
    />
  );

  return (
    <View style={styles.root}>
      {before}

      <View style={styles.section}>
        <SectionHeading theme={theme} text="Forwarded ports" />
        {ports.length === 0 ? (
          <Text style={[styles.faint, { paddingHorizontal: 8, paddingVertical: 4 }]}>
            {container.hostNetwork
              ? "This container uses the host network, so Docker already serves its ports on localhost."
              : "Nothing listening yet. Ports show up here when a server starts in the container."}
          </Text>
        ) : null}
        {ports.map((forward) => (
          <PortRow
            key={forward.containerPort}
            theme={theme}
            forward={forward}
            alwaysShowActions={layout.compact}
            styles={styles}
            iconButton={iconButton}
            onCopy={copy}
            onStop={() => stop(forward)}
          />
        ))}

        {adding ? (
          <View style={styles.row}>
            <Text style={[styles.muted, { width: 14 }]}>+</Text>
            <TextInput
              autoFocus
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              onBlur={() => {
                if (!draft.trim()) closeAdd();
              }}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Escape") closeAdd();
              }}
              placeholder="port, e.g. 3000"
              placeholderTextColor={theme.colors.foregroundMuted}
              keyboardType="number-pad"
              style={styles.input}
            />
            <Text style={styles.faint} numberOfLines={1}>
              Enter to forward. It opens once something listens.
            </Text>
          </View>
        ) : (
          <HoverPressable
            accessibilityRole="button"
            onPress={() => setAdding(true)}
            style={styles.row}
            hoveredStyle={styles.hovered}
          >
            <Text style={[styles.muted, { width: 14 }]}>+</Text>
            <Text style={styles.muted}>Forward a port</Text>
          </HoverPressable>
        )}

        {undo ? (
          <View style={[styles.row, { gap: 8 }]}>
            <Text style={styles.muted}>
              Stopped forwarding <Text style={styles.mono}>{undo.containerPort}</Text>. It stays ignored for this
              repository.
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                void attempt(async () => {
                  await actions.restore(container.repoPath, undo.containerPort);
                  setUndo(null);
                })
              }
            >
              <Text style={styles.link}>Undo</Text>
            </Pressable>
          </View>
        ) : null}

        {ignored.length > 0 ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showIgnored }}
              onPress={() => setShowIgnored((shown) => !shown)}
              style={{ paddingHorizontal: 8, paddingVertical: 4 }}
            >
              <Text style={styles.faint}>
                {showIgnored ? "▾" : "▸"} {ignored.length} ignored {ignored.length === 1 ? "port" : "ports"}
              </Text>
            </Pressable>
            {showIgnored
              ? ignored.map((port) => (
                  <View key={port} style={[styles.row, { minHeight: 24, paddingLeft: 22 }]}>
                    <Text style={[styles.port, { color: theme.colors.foregroundMuted }]}>{port}</Text>
                    <View style={{ flex: 1 }} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Forward port ${port} again`}
                      disabled={busy}
                      onPress={() => void attempt(() => actions.restore(container.repoPath, port))}
                    >
                      <Text style={styles.link}>Forward</Text>
                    </Pressable>
                  </View>
                ))
              : null}
          </>
        ) : null}
      </View>

      {/* Pairing is set up once, so the daemon comes last. */}
      {daemon ? (
        <View style={styles.section}>
          <SectionHeading theme={theme} text="Paseo daemon" />
          <DaemonBlock theme={theme} view={view} forward={daemon} styles={styles} onCopy={copy} iconButton={iconButton} />
        </View>
      ) : null}
    </View>
  );
}

type PanelStyles = Record<string, object>;
type IconButtonFactory = (icon: string, label: string, onPress: () => void) => ReactElement;

// Pairing, not browsing: the address to pair with, whether it is paired, and copy.
function DaemonBlock({
  theme,
  view,
  forward,
  styles,
  onCopy,
  iconButton,
}: {
  theme: Theme;
  view: ContainerView;
  forward: Forward;
  styles: PanelStyles;
  onCopy(text: string): void;
  iconButton: IconButtonFactory;
}) {
  const { host } = view;
  const address = forward.hostPort === null ? null : `localhost:${forward.hostPort}`;
  const tone = forward.error
    ? theme.colors.statusDanger
    : host?.status === "online"
      ? theme.colors.statusSuccess
      : theme.colors.statusWarning;
  const badge = forward.error
    ? "Not forwarded"
    : !host
      ? "Not paired"
      : host.status === "online"
        ? `Paired · ${host.label}`
        : `${host.label} · ${host.status}`;
  const hint = forward.error ?? (host ? null : "Add a host in Paseo at this address");
  return (
    <View style={styles.daemon}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone }} />
      <Text style={styles.mono} selectable>
        {address ?? `container :${forward.containerPort}`}
      </Text>
      <Text style={[styles.badge, badgeTone(tone)]}>{badge}</Text>
      {hint ? (
        <Text style={forward.error ? styles.danger : styles.muted} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      {address ? <Text style={styles.faint}>container :{forward.containerPort}</Text> : null}
      {address ? iconButton("Copy", "Copy address", () => onCopy(address)) : null}
    </View>
  );
}

// A soft tint of the status colour when the theme gives hex colours, else an outline.
function badgeTone(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color)
    ? { color, backgroundColor: `${color}24`, borderColor: "transparent" }
    : { color, borderColor: color };
}

// One forwarded port: state, port, clickable local address, process; actions show on hover.
function PortRow({
  theme,
  forward,
  alwaysShowActions,
  styles,
  iconButton,
  onCopy,
  onStop,
}: {
  theme: Theme;
  forward: Forward;
  alwaysShowActions: boolean;
  styles: PanelStyles;
  iconButton: IconButtonFactory;
  onCopy(text: string): void;
  onStop(): void;
}) {
  const open = useOpenForward();
  const [hovered, setHovered] = useState(false);
  const url = urlOf(forward);
  const failed = forward.hostPort === null;
  const detail = failed
    ? forward.error
    : !forward.listening
      ? "waiting for a listener"
      : (forward.process ?? "unknown process");
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={url ? `Open ${url}` : `Port ${forward.containerPort} not forwarded`}
      onPress={() => open(forward)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, hovered && styles.hovered]}
    >
      <View style={{ width: 14, alignItems: "center" }}>
        <StateDot theme={theme} forward={forward} size={6} />
      </View>
      <Text style={styles.port}>{forward.containerPort}</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
        <Text
          style={[
            styles.mono,
            failed && { color: theme.colors.statusDanger },
            hovered && url ? { color: theme.colors.accent, textDecorationLine: "underline" } : null,
          ]}
        >
          {failed ? "not forwarded" : `localhost:${forward.hostPort}`}
        </Text>
        {!failed && forward.hostPort !== forward.containerPort ? (
          <Text style={styles.remap}>{forward.containerPort} busy here</Text>
        ) : null}
      </View>
      <Text style={[styles.process, failed && { color: theme.colors.statusDanger }]} numberOfLines={1}>
        {detail}
      </Text>
      {forward.manual ? <Text style={styles.tag}>added</Text> : null}
      <View style={{ flexDirection: "row", opacity: hovered || alwaysShowActions ? 1 : 0 }}>
        {url ? iconButton("ExternalLink", `Open ${url}`, () => open(forward)) : null}
        {url ? iconButton("Copy", `Copy ${url}`, () => onCopy(url)) : null}
        {iconButton("X", forward.manual ? "Remove" : "Stop forwarding", onStop)}
      </View>
    </Pressable>
  );
}
