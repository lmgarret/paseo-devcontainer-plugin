/// <reference types="node" />
// The companion's workspace links (see companion.ts and shared/workspace-link.ts): stores in the
// metadata of each workspace created in the container for the repository the link the host plugin
// stores on its own workspaces, with the container side. The host plugin writes which repository
// the container runs in the shared Paseo home; without that file, or on a Paseo host without
// metadata, it does nothing.
//
// Type imports and Node built-ins only: the copy has no node_modules.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWorkspaceLink, workspaceLinkMetadata } from "../shared/workspace-link";
import { COMPANION_DATA } from "./companion-plugins";
import { errorText, repoRootOf } from "./worktree-guard";

// Under COMPANION_DATA in the container's Paseo home.
export const LINK_FILE = "link.json";

export interface ContainerLink {
  // The repository folder on the host: the container's identity.
  repoPath: string;
  // The same folder in the container.
  containerFolder: string;
}

const TAG = "[devcontainer-companion]";

export function readContainerLink(): ContainerLink | null {
  try {
    const home = realpathSync(process.env.PASEO_HOME || join(homedir(), ".paseo"));
    const parsed = JSON.parse(readFileSync(join(home, COMPANION_DATA, LINK_FILE), "utf8")) as Partial<ContainerLink>;
    if (typeof parsed.repoPath !== "string" || typeof parsed.containerFolder !== "string") return null;
    return { repoPath: parsed.repoPath, containerFolder: parsed.containerFolder };
  } catch {
    return null;
  }
}

// The host repository a folder in the container belongs to: its folder there, or a worktree of
// it. The repository may also be linked at its host path, which resolves to the same folder.
function repoOf(cwd: string, link: ContainerLink): string | null {
  const root = repoRootOf(cwd);
  if (!root) return null;
  const roots = [link.containerFolder, link.repoPath].flatMap((path) => {
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
  return roots.includes(root) ? link.repoPath : null;
}

export function startLinks(server: PluginServerContext): () => void {
  return server.addHook("workspace.create.after", async ({ workspace }, { paseo }) => {
    try {
      // No metadata on hosts before Paseo 0.16; a link set at creation stays.
      if (!workspace.metadata || readWorkspaceLink(workspace.metadata)) return;
      const link = readContainerLink();
      const repoPath = link ? repoOf(workspace.cwd, link) : null;
      if (!repoPath) return;
      await paseo.workspaces.ref(workspace.id).setMetadata(workspaceLinkMetadata({ repoPath, side: "container" }));
    } catch (error) {
      console.error(`${TAG} could not link workspace ${workspace.cwd} to the container: ${errorText(error)}`);
    }
  });
}
