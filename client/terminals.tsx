import type { PluginTerminalSnapshot } from "@getpaseo/plugin";
import { type TerminalRef, usePaseo, useTerminals, useWorkspaces } from "@getpaseo/plugin/client";
import { Component, type MutableRefObject, type ReactNode, useEffect, useRef } from "react";
import { type Container, logTerminalName, shellTerminalName } from "../shared/contract";

export type TerminalKind = "shell" | "logs";

// Focuses a container's open shell or log terminal; false when none is open, so the caller opens one.
export type FocusTerminal = (kind: TerminalKind) => boolean;

// Terminals this app opened, by container and kind: a shell may retitle its terminal, so its name
// alone cannot find it again.
const opened = new Map<string, string>();
const openedKey = (repoPath: string, kind: TerminalKind) => `${kind}:${repoPath}`;

export function rememberTerminal(repoPath: string, kind: TerminalKind, terminalId: string): void {
  opened.set(openedKey(repoPath, kind), terminalId);
}

// The server opens shell and logs terminals on this plugin's host, in the container folder's
// workspace. Renders `probe` to keep `focus` current.
export function useContainerTerminals(
  hostId: string,
  container: Container,
  enabled: boolean,
): { probe: ReactNode; focus: FocusTerminal } {
  const target = useRef<FocusTerminal | null>(null);
  const probe = enabled ? (
    <Quiet>
      <TerminalLookup hostId={hostId} container={container} target={target} />
    </Quiet>
  ) : null;
  return { probe, focus: (kind) => (enabled && target.current ? target.current(kind) : false) };
}

function TerminalLookup({
  hostId,
  container,
  target,
}: {
  hostId: string;
  container: Container;
  target: MutableRefObject<FocusTerminal | null>;
}) {
  const paseo = usePaseo();
  const { repoPath } = container;
  const workspaces = useWorkspaces({ hosts: [hostId], where: (workspace) => workspace.directory === repoPath });
  const names: Record<TerminalKind, string> = { shell: shellTerminalName(container.name), logs: logTerminalName(repoPath) };
  const kindOf = (terminal: PluginTerminalSnapshot): TerminalKind | null => {
    for (const kind of ["shell", "logs"] as const) {
      if (terminal.ref.id === opened.get(openedKey(repoPath, kind)) || terminal.title === names[kind]) return kind;
    }
    return null;
  };
  // Newest first, when several are open.
  const groups = useTerminals({
    hosts: [hostId],
    where: (terminal) => workspaces.some((workspace) => workspace.id === terminal.workspace.id) && kindOf(terminal) !== null,
    orderBy: ["createdAt", "desc"],
    groupBy: (terminal) => kindOf(terminal) ?? "",
  });
  useEffect(() => {
    target.current = (kind) => {
      const ref: TerminalRef | undefined = groups.find((group) => group.key === kind)?.items[0];
      if (!ref) return false;
      paseo.terminals.ref(ref).focus();
      return true;
    };
    return () => {
      target.current = null;
    };
  }, [groups, paseo, target]);
  return null;
}

// Without live terminals, shell and logs open a new terminal as before.
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[devcontainer-host] live terminals unavailable:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
