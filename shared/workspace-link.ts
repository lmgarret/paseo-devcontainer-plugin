// What this plugin stores in a Paseo workspace's metadata (Paseo 0.16 and later) to link it to a
// dev container. The host plugin tags workspaces created on this machine, the companion plugin
// those created in the container, and the New workspace setup can tag one before it exists, all
// with the same keys. Paseo never reads them. Readers use the link first and fall back to matching
// projects and folders, for workspaces created earlier and hosts without metadata.
//
// No imports: this file is copied into the container's companion plugin, which has no
// node_modules, and is also loaded by the app.

// Every key starts with this, so the plugin's keys never clash with another plugin's.
export const WORKSPACE_LINK_PREFIX = "devcontainer.";

export const WORKSPACE_LINK_KEYS = {
  // The repository folder on the machine that runs Docker: the container's identity, as in its
  // `devcontainer.local_folder` label and `Container.repoPath`. It survives rebuilds, unlike the
  // container's ID or name.
  repoPath: "devcontainer.repoPath",
  // The Paseo daemon the workspace is on: the machine's, or the container's.
  side: "devcontainer.side",
} as const;

export type WorkspaceLinkSide = "host" | "container";

export interface WorkspaceLink {
  repoPath: string;
  side: WorkspaceLinkSide;
}

// The patch that links a workspace, for any `setMetadata` or a creation request's `metadata`.
export function workspaceLinkMetadata(link: WorkspaceLink): Record<string, string> {
  return { [WORKSPACE_LINK_KEYS.repoPath]: link.repoPath, [WORKSPACE_LINK_KEYS.side]: link.side };
}

// The link a workspace's metadata holds; null without one, on hosts without metadata, or when
// the values are not what this plugin writes.
export function readWorkspaceLink(metadata: Readonly<Record<string, unknown>> | null | undefined): WorkspaceLink | null {
  const repoPath = metadata?.[WORKSPACE_LINK_KEYS.repoPath];
  const side = metadata?.[WORKSPACE_LINK_KEYS.side];
  if (typeof repoPath !== "string" || !repoPath) return null;
  return { repoPath, side: side === "container" ? "container" : "host" };
}
