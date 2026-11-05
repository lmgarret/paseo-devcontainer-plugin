import { type PluginHostProps, useHosts } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Container, Guard, GuardWorktree } from "../shared/contract";
import { openGuide } from "./guide";
import { HoverPressable } from "./hover";
import { guardBadge, STATUS_KEY, useGuardPreview, useRestoreWorktrees, useStatusQuery } from "./state";
import { WithTooltip } from "./tooltip";

type Theme = PluginHostProps["theme"];
type Branch = GuardWorktree["branches"][number];

const MONO = "monospace";

export function worktreeProblems(guard: Guard | null): GuardWorktree[] {
  return guard?.worktrees.filter((entry) => entry.state !== "safe") ?? [];
}

// The folder's last path segment: Paseo's worktree slug, the same on both sides.
export function slugOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// The machine this plugin runs on, named as the app names its host, with an icon for its system.
function useMachine(): { name: string; icon: string } {
  const machine = useStatusQuery().data?.machine;
  const hosts = useHosts();
  const label = machine?.serverId ? hosts.find((host) => host.serverId === machine.serverId)?.label : undefined;
  const icon = machine?.platform === "darwin" ? "Laptop" : machine?.platform === "win32" ? "Monitor" : "Server";
  return { name: label || machine?.name || "This machine", icon };
}

// ---------------------------------------------------------------------------------------------
// Issue badge: a warning triangle with the number of issues, red when anything is broken. On a
// container it opens the list of its issues; on the sidebar entry it only summarises.

export function IssueBadge({
  theme,
  container,
  counts,
}: {
  theme: Theme;
  container?: Container;
  counts?: { broken: number; atRisk: number };
}) {
  const [open, setOpen] = useState(false);
  const badge = container ? guardBadge(container.guard) : null;
  const broken = counts?.broken ?? badge?.broken ?? 0;
  const atRisk = counts?.atRisk ?? badge?.atRisk ?? 0;
  if (broken + atRisk === 0) return null;
  const color = broken > 0 ? theme.colors.statusDanger : theme.colors.statusWarning;
  const summary = [broken > 0 ? `${broken} broken` : null, atRisk > 0 ? `${atRisk} at risk` : null].filter(Boolean).join(" · ");
  return (
    <>
      <WithTooltip theme={theme} text={container ? `${summary}. Click to see` : summary} onPress={container ? () => setOpen(true) : undefined}>
        <View
          accessibilityLabel={`Worktrees: ${summary}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            height: 20,
            paddingHorizontal: 7,
            borderRadius: 10,
            backgroundColor: `${color}24`,
          }}
        >
          <Icon name="TriangleAlert" size={12} color={color} />
          <Text style={{ color, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{broken + atRisk}</Text>
        </View>
      </WithTooltip>
      {container && open ? <IssuesModal theme={theme} container={container} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The button on a workspace row whose worktree has a problem; it opens the fix.

export function ProblemButton({
  theme,
  container,
  entry,
  title,
  onHover,
}: {
  theme: Theme;
  container: Container;
  entry: GuardWorktree;
  title: string;
  onHover(hovered: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const broken = entry.state === "broken";
  const color = broken ? theme.colors.statusDanger : theme.colors.statusWarning;
  return (
    <>
      <WithTooltip theme={theme} text={broken ? "Git fails here. Click to fix" : "A prune could break git. Click to fix"}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${broken ? "Git broken" : "At risk"}: fix ${title}`}
          onPress={() => setOpen(true)}
          onHoverIn={() => {
            setHovered(true);
            onHover(true);
          }}
          onHoverOut={() => {
            setHovered(false);
            onHover(false);
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            height: 22,
            paddingHorizontal: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: `${color}66`,
            backgroundColor: hovered ? theme.colors.surface1 : "transparent",
          }}
        >
          <Icon name={broken ? "OctagonAlert" : "TriangleAlert"} size={12} color={color} />
          <Text style={{ color, fontSize: 12 }}>{broken ? "Git broken" : "At risk"}</Text>
        </Pressable>
      </WithTooltip>
      {open ? <FixModal theme={theme} container={container} entry={entry} title={title} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Fix modal: what happened on each side, the choice, and the fix.

function FixModal({
  theme,
  container,
  entry,
  title,
  onClose,
}: {
  theme: Theme;
  container: Container;
  entry: GuardWorktree;
  title: string;
  onClose(): void;
}) {
  const machine = useMachine();
  const toast = useToast();
  const queryClient = useQueryClient();
  const repair = useRestoreWorktrees();
  const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState(entry.branches[0]?.name ?? "");
  const kind = entry.fix;
  const broken = entry.state === "broken";
  const heading =
    kind === "recreate" ? "Reconnect to git" : kind === "share" ? "Make safe" : kind === "restore" ? "Restore" : broken ? "Git broken" : "At risk";
  const verb = kind === "recreate" ? `Reconnect to ${branch}` : kind === "share" ? "Make safe" : kind === "restore" ? "Restore" : null;

  const run = async () => {
    setBusy(true);
    try {
      const result = await repair({ repoPath: container.repoPath, name: entry.name, ...(kind === "recreate" ? { branch } : {}) });
      if (result.failed > 0) toast.error(`${title}: could not repair it`);
      else toast.show(`${title}: ${kind === "share" ? "made safe" : "git works again"}`, { variant: "success" });
      onClose();
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={heading}
      icon={<Icon name={broken ? "OctagonAlert" : "TriangleAlert"} size={16} color={broken ? theme.colors.statusDanger : theme.colors.statusWarning} />}
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }} numberOfLines={1}>
          {title}
        </Text>
        <Section theme={theme} label={broken ? "What happened" : "What could happen"}>
          <Lanes theme={theme} entry={entry} machine={machine} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 8 }}>{explanation(entry, machine.name)}</Text>
        </Section>

        {kind === "recreate" ? (
          <Section theme={theme} label="Which branch was this workspace on?">
            <View style={{ gap: 6 }}>
              {entry.branches.map((candidate, index) => (
                <BranchCard
                  key={candidate.name}
                  theme={theme}
                  repoPath={container.repoPath}
                  entry={entry}
                  branch={candidate}
                  hint={
                    index === 0 && entry.branches.length > 1
                      ? "most likely"
                      : candidate.name === slugOf(entry.folder)
                        ? "original branch name"
                        : null
                  }
                  selected={candidate.name === branch}
                  onSelect={() => setBranch(candidate.name)}
                />
              ))}
            </View>
          </Section>
        ) : null}

        {kind === "share" && entry.target ? (
          <Section theme={theme} label="The record's path">
            <PathChange theme={theme} from={entry.folder} to={entry.target} />
          </Section>
        ) : null}

        {kind ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="ShieldCheck" size={13} color={theme.colors.statusSuccess} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
              {kind === "share" ? "Nothing else changes: same folder, branch and files." : "Your files stay as they are."}
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 }}>
          <GuideLink theme={theme} />
          <View style={{ flex: 1 }} />
          <SecondaryButton theme={theme} label={verb ? "Cancel" : "Close"} onPress={onClose} />
          {verb ? (
            <PrimaryButton
              theme={theme}
              label={busy ? "Working…" : verb}
              disabled={busy || (kind === "recreate" && !branch)}
              onPress={() => void run()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

// Each side, drawn as the worktree's folder linked to its git record or branch.
function Lanes({ theme, entry, machine }: { theme: Theme; entry: GuardWorktree; machine: { name: string; icon: string } }) {
  const lane = (side: "host" | "container", label: string, icon: string) => {
    const state = entry.sides[side];
    const recordless = entry.fix === "recreate";
    const end = recordless ? { icon: "GitBranch", label: "branch?" } : { icon: "Database", label: "record" };
    const status =
      state === "works"
        ? { icon: "Check", color: theme.colors.statusSuccess, tip: "Git works" }
        : state === "fails"
          ? { icon: "X", color: theme.colors.statusDanger, tip: "Git fails" }
          : state === "at-risk"
            ? { icon: "TriangleAlert", color: theme.colors.statusWarning, tip: "A prune here would break it" }
            : state === "unseen"
              ? { icon: "Minus", color: theme.colors.foregroundMuted, tip: "Not used here" }
              : { icon: "Minus", color: theme.colors.foregroundMuted, tip: "Container not running" };
    const wireColor =
      state === "fails" ? theme.colors.statusDanger : state === "at-risk" ? theme.colors.statusWarning : `${theme.colors.statusSuccess}99`;
    return (
      <View
        key={side}
        style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, gap: 10, backgroundColor: theme.colors.surface0 }}
      >
        <WithTooltip theme={theme} text={status.tip}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>
              {label}
            </Text>
            <Icon name={status.icon} size={12} color={status.color} />
          </View>
        </WithTooltip>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Node theme={theme} icon="Folder" label={recordless ? "your files" : slugOf(entry.folder)} tone={state === "at-risk" ? "warn" : "plain"} />
          <View style={{ width: 36, borderTopWidth: 2, borderStyle: state === "fails" || state === "at-risk" ? "dashed" : "solid", borderColor: wireColor }} />
          <Node theme={theme} icon={end.icon} label={end.label} tone={state === "fails" ? "gone" : "plain"} />
        </View>
      </View>
    );
  };
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {lane("host", machine.name, machine.icon)}
      {lane("container", "Container", "Box")}
    </View>
  );
}

function Node({ theme, icon, label, tone }: { theme: Theme; icon: string; label: string; tone: "plain" | "gone" | "warn" }) {
  const color = tone === "gone" ? theme.colors.statusDanger : tone === "warn" ? theme.colors.statusWarning : theme.colors.foreground;
  return (
    <View style={{ alignItems: "center", gap: 3, maxWidth: 90 }}>
      <View
        style={{
          width: 40,
          height: 34,
          borderRadius: 8,
          borderWidth: tone === "plain" ? 1 : 1.5,
          borderStyle: tone === "plain" ? "solid" : "dashed",
          borderColor: tone === "plain" ? theme.colors.border : color,
          backgroundColor: tone === "plain" ? theme.colors.surface1 : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={16} color={color} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// A branch the folder could be reconnected to, with its last commit and how many uncommitted
// changes the folder would show on it: the evidence for picking it.
function BranchCard({
  theme,
  repoPath,
  entry,
  branch,
  hint,
  selected,
  onSelect,
}: {
  theme: Theme;
  repoPath: string;
  entry: GuardWorktree;
  branch: Branch;
  hint: string | null;
  selected: boolean;
  onSelect(): void;
}) {
  const [showFiles, setShowFiles] = useState(selected);
  const preview = useGuardPreview();
  const query = useQuery({
    queryKey: ["devcontainer-guard-preview", repoPath, entry.name, branch.name],
    queryFn: () => preview({ repoPath, name: entry.name, branch: branch.name }),
  });
  const total = query.data?.total ?? null;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onSelect}
      style={{
        flexDirection: "row",
        gap: 10,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderRadius: 8,
        padding: 10,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          marginTop: 2,
          borderRadius: 7,
          borderWidth: selected ? 4 : 1.5,
          borderColor: selected ? theme.colors.accent : theme.colors.foregroundMuted,
        }}
      />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontFamily: MONO, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
            {branch.name}
          </Text>
          {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.8 }}>{hint}</Text> : null}
        </View>
        {branch.subject ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            Last commit {shortDate(branch.date)} · {branch.subject}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!total}
          onPress={() => setShowFiles((shown) => !shown)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 }}
        >
          <Icon name="FileDiff" size={12} color={total ? theme.colors.statusWarning : theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {query.isPending
              ? "Comparing…"
              : total === null
                ? "Could not compare"
                : total === 0
                  ? "No uncommitted changes"
                  : `${total} uncommitted ${total === 1 ? "change" : "changes"}`}
          </Text>
          {total ? <Icon name={showFiles ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} /> : null}
        </Pressable>
        {showFiles && query.data && query.data.total > 0 ? (
          <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, marginTop: 4 }}>
            {query.data.files.map((file, index) => (
              <Text
                key={file}
                style={{
                  color: theme.colors.foregroundMuted,
                  fontFamily: MONO,
                  fontSize: 11,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: theme.colors.border,
                }}
                numberOfLines={1}
              >
                {file}
              </Text>
            ))}
            {query.data.total > query.data.files.length ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 8, paddingVertical: 4 }}>
                +{query.data.total - query.data.files.length} more
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// The record's path before and after Make safe: the differing start, then the first shared folder.
function PathChange({ theme, from, to }: { theme: Theme; from: string; to: string }) {
  const a = from.split("/");
  const b = to.split("/");
  let shared = 0;
  while (shared < Math.min(a.length, b.length) - 1 && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared++;
  const show = (parts: string[]) => {
    const head = parts.slice(0, parts.length - shared).join("/");
    return shared > 0 ? `${head}/${parts[parts.length - shared]}${shared > 1 ? "/…" : ""}` : head;
  };
  return (
    <WithTooltip theme={theme} text={`Same folder: …/${slugOf(from)}`}>
      <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, gap: 6, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.statusDanger, fontFamily: MONO, fontSize: 12, textDecorationLine: "line-through" }}>{show(a)}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="ArrowRight" size={12} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontFamily: MONO, fontSize: 12, flexShrink: 1 }}>{show(b)}</Text>
        </View>
      </View>
    </WithTooltip>
  );
}

// ---------------------------------------------------------------------------------------------
// Issues modal: everything that needs attention in a container, health per side, recent repairs.

function IssuesModal({ theme, container, onClose }: { theme: Theme; container: Container; onClose(): void }) {
  const machine = useMachine();
  const toast = useToast();
  const queryClient = useQueryClient();
  const repair = useRestoreWorktrees();
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState<GuardWorktree | null>(null);
  const guard = container.guard;
  const problems = worktreeProblems(guard);
  const safeFixes = problems.filter((entry) => entry.fix === "share" || entry.fix === "restore").length;
  const count = (side: "host" | "container", state: GuardWorktree["sides"]["host"]) =>
    guard?.worktrees.filter((entry) => entry.sides[side] === state).length ?? 0;

  const fixAll = async () => {
    setBusy(true);
    try {
      const result = await repair({ repoPath: container.repoPath });
      if (result.failed > 0) toast.error(`${container.name}: ${result.failed} could not be fixed`);
      else toast.show(`${container.name}: fixed ${result.restored}`, { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (fixing) {
    return (
      <FixModal theme={theme} container={container} entry={fixing} title={fixing.title ?? slugOf(fixing.folder)} onClose={() => setFixing(null)} />
    );
  }
  const health = (side: "host" | "container", label: string, icon: string) => {
    const parts: [number, string, string][] = [
      [count(side, "works"), "ok", theme.colors.statusSuccess],
      [count(side, "fails"), "broken", theme.colors.statusDanger],
      [count(side, "at-risk"), "at risk", theme.colors.statusWarning],
    ];
    const shown = parts.filter(([value]) => value > 0);
    return (
      <View
        key={side}
        style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, gap: 6, backgroundColor: theme.colors.surface0 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {label}
          </Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {shown.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Not checked</Text>
          ) : (
            shown.map(([value, word, color]) => (
              <Text key={word} style={{ color, fontSize: 13 }}>
                {value} {word}
              </Text>
            ))
          )}
        </View>
      </View>
    );
  };

  return (
    <Modal
      title={container.name}
      icon={<Icon name="TriangleAlert" size={16} color={theme.colors.statusWarning} />}
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Modal.Content>
        {problems.length > 0 ? (
          <Section theme={theme} label="Needs you">
            <View style={{ gap: 6 }}>
              {problems.map((entry) => {
                const broken = entry.state === "broken";
                const verb =
                  entry.fix === "recreate" ? "Reconnect…" : entry.fix === "share" ? "Make safe…" : entry.fix === "restore" ? "Restore…" : "Details…";
                return (
                  <View
                    key={`${entry.name}:${entry.folder}`}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: theme.colors.surface0,
                    }}
                  >
                    <Icon
                      name={broken ? "OctagonAlert" : "TriangleAlert"}
                      size={13}
                      color={broken ? theme.colors.statusDanger : theme.colors.statusWarning}
                    />
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }} numberOfLines={1}>
                      {entry.title ?? slugOf(entry.folder)}
                    </Text>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{broken ? "git broken" : "at risk"}</Text>
                    <SecondaryButton theme={theme} label={verb} onPress={() => setFixing(entry)} />
                  </View>
                );
              })}
            </View>
          </Section>
        ) : null}
        <Section theme={theme} label="Health">
          <View style={{ flexDirection: "row", gap: 10 }}>
            {health("host", machine.name, machine.icon)}
            {health("container", "Container", "Box")}
          </View>
        </Section>
        {guard && guard.restored.length > 0 ? (
          <Section theme={theme} label="Repaired lately">
            <View style={{ gap: 4 }}>
              {guard.restored.slice(0, 5).map((entry) => (
                <View key={`${entry.at}:${entry.folder}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Icon name="Undo2" size={12} color={entry.error ? theme.colors.statusDanger : theme.colors.statusSuccess} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                    {entry.title ?? slugOf(entry.folder)}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>
                    {entry.error
                      ? "could not restore"
                      : entry.trigger === "archive"
                        ? `after an archive ${entry.side === "host" ? "here" : "in the container"}`
                        : "on request"}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, opacity: 0.8 }}>{ago(entry.at)}</Text>
                </View>
              ))}
            </View>
          </Section>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 }}>
          <GuideLink theme={theme} />
          <View style={{ flex: 1 }} />
          <SecondaryButton theme={theme} label="Close" onPress={onClose} />
          {safeFixes > 0 ? (
            <WithTooltip theme={theme} text="Make safe and restore: no choice needed">
              <PrimaryButton theme={theme} label={busy ? "Fixing…" : `Fix ${safeFixes} safely`} disabled={busy} onPress={() => void fixAll()} />
            </WithTooltip>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Small pieces

function Section({ theme, label, children }: { theme: Theme; label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.6, opacity: 0.85 }}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function PrimaryButton({ theme, label, disabled, onPress }: { theme: Theme; label: string; disabled?: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{ backgroundColor: theme.colors.accent, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 5, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: theme.colors.surface0, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function SecondaryButton({ theme, label, onPress }: { theme: Theme; label: string; onPress(): void }) {
  return (
    <HoverPressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 4 }}
      hoveredStyle={{ backgroundColor: theme.colors.surface2 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </HoverPressable>
  );
}

function GuideLink({ theme }: { theme: Theme }) {
  return (
    <Pressable accessibilityRole="link" onPress={openGuide} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name="BookOpen" size={12} color={theme.colors.accent} />
      <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Guide</Text>
    </Pressable>
  );
}

function explanation(entry: GuardWorktree, machine: string): string {
  const side = entry.sides.host === "at-risk" ? machine : "the container";
  if (entry.fix === "recreate") return "Your files are all there, but git lost track of which branch this folder is.";
  if (entry.fix === "share") return `Git works today, but the record names the folder by a path ${side} can't see, so a prune there would delete it.`;
  if (entry.state === "at-risk") return `Only one side sees this folder, so a prune on ${side} would delete its record.`;
  if (entry.fix === "restore") {
    return entry.problem?.startsWith("Its .git file")
      ? "Its .git file points to a path one side can't open. A saved copy puts it back."
      : "Its git record was deleted. A saved copy puts it back.";
  }
  return "This one can't be repaired here. The guide shows how to recover it by hand.";
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ago(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
