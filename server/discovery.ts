/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Container, DevcontainerSettings } from "../shared/contract";
import { HOME_MARKER } from "./paseo-home";
import { run, toolEnv } from "./process";

export interface ProjectRef {
  projectId: string;
  // Shared across hosts for the same repository; Paseo derives the icon colour from it.
  projectKey: string | null;
  rootPath: string;
  name: string;
  customIconRevision: string | null;
  iconRevision: string | null;
}

export interface WorkspaceRef {
  id: string;
  projectId: string;
  directory: string;
  title: string;
  branch: string | null;
}

export interface PaseoCatalog {
  projects: ProjectRef[];
  workspaces: WorkspaceRef[];
}

export interface DockerContainer {
  id: string;
  name: string;
  running: boolean;
  createdAt: string;
  // When the container last started, in ms; null when it never ran.
  startedAt: number | null;
  localFolder: string;
  configFile: string | null;
  remoteUser: string;
  // Where the repository is mounted inside the container.
  workspaceFolder: string | null;
  // `home`: the plugin's managed Paseo home, mounted at its own path; null for any other home.
  paseoHome: { persistent: boolean; serverId: string | null; home: string | null };
  hostNetwork: boolean;
}

export interface Candidate {
  repoPath: string;
  name: string;
  source: Container["source"];
  configFile: string | null;
  container: DockerContainer | null;
  project: ProjectRef | null;
  workspace: WorkspaceRef | null;
  branch: string | null;
}

interface InspectMount {
  Type: string;
  Source: string;
  Destination: string;
}

interface InspectResult {
  Id: string;
  Name: string;
  Created: string;
  State: { Status: string; StartedAt?: string };
  Config: { User?: string; Env?: string[] | null; Labels?: Record<string, string> | null };
  HostConfig?: { NetworkMode?: string };
  Mounts?: InspectMount[];
}

const CONFIG_LOCATIONS = [".devcontainer/devcontainer.json", ".devcontainer.json"];

export function findConfig(repoPath: string): string | null {
  for (const location of CONFIG_LOCATIONS) {
    const path = join(repoPath, location);
    if (existsSync(path)) return path;
  }
  return null;
}

export async function listDockerContainers(docker: string): Promise<DockerContainer[]> {
  const env = toolEnv([docker]);
  const ids = await run(
    docker,
    ["ps", "-a", "--filter", "label=devcontainer.local_folder", "--format", "{{.ID}}"],
    { env, timeoutMs: 15_000 },
  );
  if (ids.code !== 0) throw new Error(ids.stderr.trim() || "docker ps failed");
  const list = ids.stdout.split("\n").map((id) => id.trim()).filter(Boolean);
  if (list.length === 0) return [];
  const inspected = await run(docker, ["inspect", ...list], { env, timeoutMs: 15_000 });
  // A container removed between the two calls makes inspect exit non-zero but still print the rest.
  const parsed = JSON.parse(inspected.stdout || "[]") as InspectResult[];
  return parsed.map(toDockerContainer);
}

function toDockerContainer(raw: InspectResult): DockerContainer {
  const labels = raw.Config.Labels ?? {};
  const remoteUser = remoteUserOf(labels["devcontainer.metadata"], raw.Config.User);
  return {
    id: raw.Id.slice(0, 12),
    name: raw.Name.replace(/^\//, ""),
    running: raw.State.Status === "running",
    createdAt: raw.Created,
    startedAt: startedAtOf(raw.State.StartedAt),
    localFolder: labels["devcontainer.local_folder"] ?? "",
    configFile: labels["devcontainer.config_file"] ?? null,
    remoteUser,
    workspaceFolder: workspaceFolderOf(raw, labels["devcontainer.local_folder"]),
    paseoHome: paseoHomeOf(raw, remoteUser),
    hostNetwork: raw.HostConfig?.NetworkMode === "host",
  };
}

function startedAtOf(value: string | undefined): number | null {
  const time = value ? Date.parse(value) : Number.NaN;
  // Docker reports 0001-01-01 for containers that never started.
  return Number.isFinite(time) && time > 0 ? time : null;
}

function hostPathOf(mount: InspectMount): string {
  // Docker Desktop reports some bind sources under its VM's /host_mnt.
  return mount.Source.replace(/^\/host_mnt(?=\/)/, "");
}

function workspaceFolderOf(raw: InspectResult, localFolder: string | undefined): string | null {
  const mount = (raw.Mounts ?? []).find((entry) => entry.Type === "bind" && hostPathOf(entry) === localFolder);
  return mount?.Destination ?? null;
}

// The merged config is baked into the image label; the last entry that sets remoteUser wins.
function remoteUserOf(metadata: string | undefined, containerUser: string | undefined): string {
  let user: string | null = null;
  try {
    const entries = JSON.parse(metadata ?? "[]") as { remoteUser?: string; containerUser?: string }[];
    for (const entry of entries) user = entry.remoteUser ?? entry.containerUser ?? user;
  } catch {
    // Unparseable metadata: fall back to the image user.
  }
  return user ?? (containerUser || "root");
}

// Maps the container's Paseo home to a mount so a stopped container's server ID can be read on
// this machine, and so we can tell whether a rebuild keeps the daemon identity.
function paseoHomeOf(raw: InspectResult, remoteUser: string): DockerContainer["paseoHome"] {
  const env = Object.fromEntries(
    (raw.Config.Env ?? []).map((entry) => {
      const index = entry.indexOf("=");
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  const configured = env.PASEO_HOME as string | undefined;
  // The plugin's home is mounted at its own path and linked from ~/.paseo, so it is not where
  // Paseo's default home is mounted.
  const managed = configured
    ? undefined
    : (raw.Mounts ?? []).find(
        (entry) => entry.Type === "bind" && hostPathOf(entry) === entry.Destination && existsSync(join(entry.Destination, HOME_MARKER)),
      );
  if (managed) return { persistent: true, serverId: readServerId(managed.Destination), home: managed.Destination };
  const home = remoteUser === "root" ? "/root" : `/home/${remoteUser}`;
  const paseoHome = configured || `${home}/.paseo`;
  const mount = (raw.Mounts ?? [])
    .filter((candidate) => paseoHome === candidate.Destination || paseoHome.startsWith(`${candidate.Destination}/`))
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  if (!mount) return { persistent: false, serverId: null, home: null };
  if (mount.Type !== "bind") return { persistent: true, serverId: null, home: null };
  return {
    persistent: true,
    serverId: readServerId(hostPathOf(mount) + paseoHome.slice(mount.Destination.length)),
    home: null,
  };
}

function readServerId(hostPath: string): string | null {
  try {
    return readFileSync(join(hostPath, "server-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// The checked-out branch, read from the repository so it works without a Paseo workspace.
export function readBranch(repoPath: string): string | null {
  try {
    let gitDir = join(repoPath, ".git");
    const dotGit = readFileSync(gitDir, "utf8");
    // A worktree's .git is a file pointing at its git dir.
    const pointer = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (pointer?.[1]) gitDir = pointer[1].trim();
    return branchFromHead(readFileSync(join(gitDir, "HEAD"), "utf8"));
  } catch {
    try {
      return branchFromHead(readFileSync(join(repoPath, ".git", "HEAD"), "utf8"));
    } catch {
      return null;
    }
  }
}

function branchFromHead(head: string): string | null {
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return ref?.[1]?.trim() ?? (head.trim().slice(0, 7) || null);
}

// One candidate per repository folder, from Paseo projects, extra paths, and existing containers.
// Stopped containers are listed only when their folder is a project or a Paseo workspace.
export function mergeCandidates(
  settings: DevcontainerSettings,
  catalog: PaseoCatalog,
  containers: DockerContainer[],
  // Folders to keep even when stopped, such as ones with a recent action.
  keep: Iterable<string> = [],
): Candidate[] {
  const byFolder = new Map<string, DockerContainer>();
  for (const container of containers) {
    const current = byFolder.get(container.localFolder);
    // Prefer the running container, then the newest, like `devcontainer up` would reuse.
    if (
      !current ||
      (container.running && !current.running) ||
      (container.running === current.running && container.createdAt > current.createdAt)
    ) {
      byFolder.set(container.localFolder, container);
    }
  }
  const workspaceByDir = new Map(catalog.workspaces.map((workspace) => [workspace.directory, workspace]));
  const projectById = new Map(catalog.projects.map((project) => [project.projectId, project]));
  const projectByRoot = new Map(catalog.projects.map((project) => [project.rootPath, project]));

  const candidates = new Map<string, Candidate>();
  const add = (repoPath: string, source: Candidate["source"]) => {
    if (candidates.has(repoPath)) return;
    const container = byFolder.get(repoPath) ?? null;
    const configFile = container?.configFile ?? findConfig(repoPath);
    if (!container && !configFile) return;
    const workspace = workspaceByDir.get(repoPath) ?? null;
    const project = (workspace && projectById.get(workspace.projectId)) || projectByRoot.get(repoPath) || null;
    candidates.set(repoPath, {
      repoPath,
      name: project?.name ?? basename(repoPath),
      source,
      configFile,
      container,
      project,
      workspace,
      branch: workspace?.branch ?? readBranch(repoPath),
    });
  };

  if (settings.scanPaseoProjects) {
    for (const project of catalog.projects) add(project.rootPath, "project");
  }
  for (const repoPath of settings.extraRepoPaths) add(repoPath, "extra");
  for (const container of byFolder.values()) {
    if (container.running || workspaceByDir.has(container.localFolder)) add(container.localFolder, "container");
  }
  for (const repoPath of keep) add(repoPath, "container");
  return [...candidates.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || Number(b.repoPath === b.project?.rootPath) - Number(a.repoPath === a.project?.rootPath),
  );
}
