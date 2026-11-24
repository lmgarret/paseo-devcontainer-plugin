import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { type Container, readWorkspaceLink } from "../shared/contract";

// Which workspaces belong to which container. The link in a workspace's metadata decides first
// (see shared/workspace-link.ts); workspaces without one, created before it or on a host older
// than Paseo 0.16, are matched by project and folder.

// Workspace ID to the repository its metadata links it to, for one Paseo host. The app's workspace
// snapshots lack metadata, so the host's workspace list fills it, and its live updates keep it
// current, such as a link stored just after a workspace was created. Empty while offline.
export function useWorkspaceLinks(hostId: string, online: boolean): ReadonlyMap<string, string> {
  const [links, setLinks] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    setLinks(new Map());
    if (!online || !hostId) return;
    const client = getPaseoClient(hostId);
    const apply = (entries: readonly { id: string; metadata?: Readonly<Record<string, unknown>> | null }[]) =>
      setLinks((previous) => {
        const next = new Map(previous);
        for (const entry of entries) {
          const repoPath = readWorkspaceLink(entry.metadata)?.repoPath;
          if (repoPath) next.set(entry.id, repoPath);
          else next.delete(entry.id);
        }
        return next.size === previous.size && [...next].every(([id, repoPath]) => previous.get(id) === repoPath) ? previous : next;
      });
    let live = true;
    const unsubscribe = client.workspaces.subscribe((update) => {
      if (update.kind === "upsert") apply([update.workspace]);
      else if (update.kind === "remove") apply([{ id: update.id }]);
    });
    client.workspaces
      .list({ page: { limit: 200 } })
      .then(({ entries }) => {
        if (live) apply(entries);
      })
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [hostId, online]);
  return links;
}

// A sidebar workspace's container. On the container's own host: the container whose daemon it
// is. On this machine's: the one its metadata links it to, which the app's snapshot lacks and
// the status lists, else the same Paseo project or the repository folder.
export function containerOf(
  workspace: PluginWorkspaceSnapshot,
  side: "host" | "container",
  containers: readonly Container[],
): Container | null {
  if (side === "container") {
    return containers.find((container) => container.serverId !== null && container.serverId === workspace.hostId) ?? null;
  }
  return (
    containers.find((container) => container.linkedWorkspaceIds.includes(workspace.id)) ??
    containers.find(
      (container) =>
        container.project?.id === workspace.projectId ||
        container.repoPath === workspace.projectRootPath ||
        container.repoPath === workspace.directory,
    ) ??
    null
  );
}
