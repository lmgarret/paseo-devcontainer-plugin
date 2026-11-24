import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginWorkspaceRowBadgeItemProps, useHosts, useWorkspace } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { View, type ViewStyle } from "react-native";
import { containerOf } from "./links";
import { useSharedStatus } from "./live-status";
import { describe } from "./state";
import { type StatusSpec, containerStatus, statusSvg, worktreeStatus } from "./status-icon";
import { WithTooltip } from "./tooltip";

interface BadgeSpec extends StatusSpec {
  label: string;
  // Hover text; `label` when absent.
  tooltip?: string;
  // Written beside the icon.
  text?: string;
}

// Beyond the SDK's contract, which expects a bare WorkspaceRowBadge: a negative flex order draws
// the icon first on the meta line, on the web, since React Native has no `order` and keeps
// Paseo's place elsewhere; and our own tooltip names the container, which Paseo's row tooltip
// cannot.
// react-native-web passes `order` through; React Native's types do not list it. Raised so the
// row's other content, drawn after it, cannot cover it and swallow the hover.
const FIRST = { order: -1, position: "relative", zIndex: 1 } as unknown as ViewStyle;

function Badge({ spec, theme }: { spec: BadgeSpec; theme: PluginTheme }) {
  return (
    <View style={FIRST}>
      <WithTooltip theme={theme} text={spec.tooltip ?? spec.label} placement="above">
        <WorkspaceRowBadge
          icon={{ svg: statusSvg(spec, theme.colors) }}
          tone={spec.tone}
          {...(spec.text ? { label: spec.text } : {})}
          accessibilityLabel={spec.label}
        />
      </WithTooltip>
    </View>
  );
}

// Rendered by this plugin for its own host's workspaces, and by the companion plugin for the
// workspaces of a container's daemon (see companion.tsx).
type Side = "host" | "container";
type BadgeProps = PluginWorkspaceRowBadgeItemProps & { side?: Side };

// Hooks read the shared status, not settings: on a container's rows they run under the
// companion, which cannot read this plugin's settings.
function useBadgeContext(workspaceId: string, side: Side) {
  const status = useSharedStatus();
  const workspace = useWorkspace(workspaceId);
  if (!status?.workspaceBadges || !workspace) return null;
  const container = containerOf(workspace, side, status.containers);
  return container ? { workspace, container, showName: status.workspaceBadgeNames } : null;
}

// Only on a container's workspaces: on this machine's, the container's state is not theirs.
export function ContainerBadge({ workspaceId, theme, side = "host" }: BadgeProps) {
  const hosts = useHosts();
  const context = useBadgeContext(workspaceId, side);
  if (!context || side !== "container") return null;
  const { container } = context;
  const view = describe(container, hosts);
  const name = container.devcontainerName ?? container.name;
  const label = `Dev container ${name}: ${view.label}`;
  const tooltip = [`${name} · ${view.label}`, view.detail].filter(Boolean).join("\n");
  const spec: BadgeSpec = { ...containerStatus(view), label, tooltip, text: context.showName ? name : undefined };
  return <Badge spec={spec} theme={theme} />;
}

// Worktrees have the same path on both sides, so the guard's entry matches either side's folder.
export function WorktreeBadge({ workspaceId, theme, side = "host" }: BadgeProps) {
  const context = useBadgeContext(workspaceId, side);
  const entry = context?.container.guard?.worktrees.find((worktree) => worktree.folder === context.workspace.directory);
  if (!entry || entry.state === "safe") return null;
  const label =
    entry.state === "broken"
      ? `Git broken: ${entry.problem ?? "fix it from the container's card"}`
      : `At risk: ${entry.problem ?? "a prune could break git"}`;
  const spec: BadgeSpec = { ...worktreeStatus(entry.state), label };
  return <Badge spec={spec} theme={theme} />;
}
