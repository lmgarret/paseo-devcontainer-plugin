/// <reference types="node" />
// Keeps a container's Paseo home on this machine, and its worktrees at the same absolute path on
// both sides. Git records each worktree's absolute path in the repository's shared `.git`, and
// `git worktree prune` deletes the record of any worktree it cannot see. When the host and the
// container see a worktree at different paths, a prune on either side (Paseo runs one on every
// archive) breaks the other side's worktrees.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DevcontainerSettings } from "../shared/contract";

// Written in each managed Paseo home: claims it for one repository, and marks its mount for discovery.
export const HOME_MARKER = ".devcontainer-plugin.json";

export interface PaseoHomePlan {
  // The container's Paseo home: a folder on this machine, mounted at the same path.
  home: string;
  // This machine's Paseo worktrees for the repository, mounted at the same path; null when unknown.
  hostWorktrees: string | null;
  // `devcontainer up --mount` values.
  mounts: string[];
}

type Log = (line: string) => void;

export function planPaseoHome(settings: DevcontainerSettings, repoPath: string, log: Log): PaseoHomePlan | null {
  if (!settings.persistPaseoHome) return null;
  try {
    const root = homesRoot(settings);
    mkdirSync(root, { recursive: true });
    const home = claimHome(realpathSync(root), repoPath);
    const hostWorktrees = hostWorktreesFor(repoPath);
    const mounts: string[] = [];
    for (const path of [home, hostWorktrees]) {
      if (!path) continue;
      // `--mount` is comma separated, with no escaping.
      if (path.includes(",")) {
        log(`Not mounting ${path}: the path contains a comma.`);
        if (path === home) return null;
        continue;
      }
      mounts.push(`type=bind,source=${path},target=${path}`);
    }
    return { home, hostWorktrees: hostWorktrees && !hostWorktrees.includes(",") ? hostWorktrees : null, mounts };
  } catch (error) {
    log(`Could not prepare a persistent Paseo home: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// Where this plugin keeps containers' Paseo homes.
export function homesRoot(settings: DevcontainerSettings): string {
  return settings.paseoHomesDir
    ? expandTilde(settings.paseoHomesDir)
    : join(hostPaseoHome(), "plugin-data", "devcontainer-host", "homes");
}

// The repository a managed home belongs to, from its marker.
export function homeOwner(home: string): string | null {
  return readMarker(home) || null;
}

// One folder per repository, named after it; a clash with another repository adds a hash.
function claimHome(root: string, repoPath: string): string {
  const name = basename(repoPath).replace(/[^\w.-]+/g, "-") || "repo";
  for (const candidate of [name, `${name}-${shortHash(repoPath)}`]) {
    const home = join(root, candidate);
    const owner = readMarker(home);
    if (owner !== null && owner !== repoPath) continue;
    mkdirSync(home, { recursive: true });
    if (owner === null) writeFileSync(join(home, HOME_MARKER), `${JSON.stringify({ repoPath }, null, 2)}\n`);
    return home;
  }
  throw new Error(`Paseo homes for ${repoPath} are taken by other repositories`);
}

function readMarker(home: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, HOME_MARKER), "utf8")) as { repoPath?: unknown };
    return typeof parsed.repoPath === "string" ? parsed.repoPath : "";
  } catch {
    return null;
  }
}

// Where this machine's Paseo daemon puts the repository's worktrees: <root>/<hash of the repo root>,
// derived like Paseo's `deriveWorktreeProjectHash`.
function hostWorktreesFor(repoPath: string): string | null {
  const repoRoot = repoRootOf(repoPath);
  if (!repoRoot) return null;
  const dir = join(worktreesRootOf(hostPaseoHome()), paseoProjectHash(repoRoot));
  // A missing bind source fails the container's creation.
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

// The daemon's `worktrees.root` setting, else <home>/worktrees.
export function worktreesRootOf(paseoHome: string): string {
  const configured = readConfig(paseoHome)?.worktrees?.root?.trim();
  if (!configured) return join(paseoHome, "worktrees");
  const expanded = expandTilde(configured);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(paseoHome, expanded);
}

// The main checkout of the repository, also for a linked worktree.
export function repoRootOf(repoPath: string): string | null {
  try {
    const dotGit = join(repoPath, ".git");
    let commonDir = dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (pointer?.[1]) {
      const gitDir = resolve(repoPath, pointer[1].trim());
      const common = existsSync(join(gitDir, "commondir")) ? readFileSync(join(gitDir, "commondir"), "utf8").trim() : "";
      commonDir = common ? resolve(gitDir, common) : gitDir;
    }
    const real = realpathSync(commonDir);
    return basename(real) === ".git" ? dirname(real) : real;
  } catch (error) {
    // EISDIR: a regular checkout, whose .git is a folder.
    if ((error as NodeJS.ErrnoException).code === "EISDIR") {
      return realpathSync(repoPath);
    }
    return null;
  }
}

export function paseoProjectHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hash = 0n;
  for (let index = 0; index < 8; index += 1) hash = (hash << 8n) | BigInt(digest[index] ?? 0);
  return hash.toString(36).padStart(13, "0").slice(0, 8);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

interface PaseoConfig {
  worktrees?: { root?: string };
  pluginsEnabled?: boolean;
  plugins?: Record<string, { source?: string; path?: string; enabled?: boolean }>;
  [key: string]: unknown;
}

export function readConfig(paseoHome: string): PaseoConfig | null {
  try {
    return JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")) as PaseoConfig;
  } catch {
    return null;
  }
}

// New worktrees go under the home's own path, which the container shares with this machine. Paseo
// would otherwise place them under the home's path in the container, ~/.paseo, which this machine
// cannot see. Returns whether the config changed.
export function pinWorktreesRoot(home: string, log: Log): boolean {
  const file = join(home, "config.json");
  const config: PaseoConfig | null = existsSync(file) ? readConfig(home) : { version: 1 };
  if (!config) {
    log(`Not changing ${file}: it is not valid JSON.`);
    return false;
  }
  if (config.worktrees?.root?.trim()) return false;
  config.worktrees = { ...config.worktrees, root: join(home, "worktrees") };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  log(`Paseo worktrees in this container go to ${config.worktrees.root}`);
  return true;
}

// Run in the container as its remote user: points ~/.paseo at the mounted home. Exit codes:
// 43 the home is not mounted (container created before), 44 the config sets PASEO_HOME,
// 45 both ~/.paseo and the mounted home hold a daemon's data.
export function linkHomeScript(home: string): string {
  const target = shellQuote(home);
  return [
    `H=${target}`,
    'L="$HOME/.paseo"',
    '[ -d "$H" ] || exit 43',
    '[ -z "${PASEO_HOME:-}" ] || exit 44',
    'if [ -L "$L" ]; then [ "$(readlink "$L")" = "$H" ] && exit 0; rm "$L"; fi',
    'if [ -d "$L" ]; then',
    '  if [ -n "$(ls -A "$L")" ]; then',
    '    [ ! -e "$H/server-id" ] || exit 45',
    '    cp -a "$L/." "$H/" && rm -rf "$L" || exit 1',
    '  else rmdir "$L"; fi',
    "fi",
    'ln -s "$H" "$L"',
  ].join("\n");
}

export function writeConfig(home: string, config: PaseoConfig): void {
  const file = join(home, "config.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// This machine's Paseo home, where the plugin's daemon runs.
export function hostPaseoHome(): string {
  return expandTilde(process.env.PASEO_HOME || "~/.paseo");
}

function expandTilde(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}
