/// <reference types="node" />
// Keeps git worktrees working when one repository is used by Paseo on this machine and in a dev
// container. Both sides share the repository's `.git`, where git keeps one record per worktree
// under `.git/worktrees/<name>`, and git writes absolute paths. `git worktree prune` deletes the
// record of any worktree it cannot see, and `git worktree repair` points every worktree it sees
// at its own side's path of the repository. Either breaks worktrees of the other side.
//
// The guard snapshots the records into a folder both sides see at the same path, sorts each
// worktree into safe, at risk, or broken, and puts back what a prune or repair took, only for
// worktrees whose folder still exists.
//
// Node built-ins only: this file is copied into the container's companion plugin, which has no
// node_modules.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Under the container's Paseo home, which both sides see at the same path.
export const GUARD_DIR = "devcontainer-guard";
export const GUARD_CONFIG = "config.json";
// Written by the container's companion plugin after it acts on an archive there.
export const CONTAINER_STATUS = "status.container.json";
// Enough to make a worktree usable again. The index is rebuilt from HEAD rather than restored, so
// a stale copy cannot show bogus staged changes; merge and rebase state is not kept.
const RECORD_FILES = ["HEAD", "commondir", "gitdir", "locked", "config.worktree"];
const ENTRY_META = ".guard.json";

export type Side = "host" | "container";
export const SIDE_LABEL: Record<Side, string> = { host: "this machine", container: "the container" };

// A folder of this machine and where the container sees it.
export interface Mount {
  source: string;
  target: string;
}

export interface GuardConfig {
  // The repository's main checkout on the host, and the same folder in the container.
  hostRepo: string;
  containerRepo: string;
  // <container home>/devcontainer-guard.
  guardDir: string;
  // The container's other bind mounts, to map its paths to this machine's.
  mounts?: Mount[];
}

// What one side sees at a path: a directory, a file, or nothing.
export type PathKind = "d" | "f" | "-";

// One side's view: path kinds, and the gitdir each `.git` file names.
export interface SideView {
  kinds: Map<string, PathKind>;
  pointers: Map<string, string | null>;
}

export type WorktreeState = "safe" | "at-risk" | "broken";

export type Fix =
  // Put the deleted record back from the snapshot.
  | { kind: "record" }
  // Another worktree took the record's name: put this one back under a new name and repoint it.
  | { kind: "rename" }
  // Write back the folder's last working `.git` pointer.
  | { kind: "pointer"; pointer: string }
  // At risk: the record names the folder by a path only one side sees; name it by a path both see.
  | { kind: "share"; gitFile: string }
  // A live workspace whose record is gone with no snapshot: recreate it on a branch the caller
  // picks, under a new name when another worktree took this one.
  | { kind: "recreate"; rename: boolean };

// Snapshot-based fixes, safe to apply without asking; the others wait for a person.
export const AUTOMATIC_FIXES: ReadonlySet<Fix["kind"]> = new Set(["record", "rename", "pointer"]);

export interface WorktreeReport {
  name: string;
  // The worktree's folder, as git records it.
  folder: string;
  state: WorktreeState;
  // Why it is at risk or broken, for people.
  problem: string | null;
  fix: Fix | null;
  // Sides that can reach the folder, so a fix runs where it can.
  reachable: { side: Side; folder: string }[];
  // The folder's `.git` pointer, preferring one that opens; null when no side reads it.
  pointer: string | null;
}

export interface GuardReport {
  checkedAt: number;
  worktrees: WorktreeReport[];
  // Sides the check could see; a stopped container leaves only the host.
  sides: Side[];
}

interface RecordInfo {
  name: string;
  dir: string;
  // Path of the worktree's `.git` file, as in the record's gitdir file.
  gitFile: string | null;
  locked: boolean;
}

interface SnapshotEntry {
  name: string;
  dir: string;
  gitFile: string;
  // The worktree's `.git` content when it last worked.
  pointer: string | null;
  savedAt: number;
}

// The side running this code reads the shared `.git` directly.
export function repoOn(config: GuardConfig, side: Side): string {
  return side === "host" ? config.hostRepo : config.containerRepo;
}

function worktreesDir(config: GuardConfig, side: Side): string {
  return join(repoOn(config, side), ".git", "worktrees");
}

function snapshotsDir(config: GuardConfig): string {
  return join(config.guardDir, "snapshots");
}

// The same path as the other side sees it, through the repository's folder or another mount;
// the longest match wins. Paths outside every mount are returned as they are.
export function translate(config: GuardConfig, path: string, to: Side): string {
  const pairs: [string, string][] = [
    [config.hostRepo, config.containerRepo],
    ...(config.mounts ?? []).map(({ source, target }): [string, string] => [source, target]),
  ];
  let best: [string, string] | null = null;
  for (const [host, container] of pairs) {
    const [from, into] = to === "host" ? [container, host] : [host, container];
    if ((path === from || path.startsWith(`${from}/`)) && (!best || from.length > best[0].length)) best = [from, into];
  }
  return best ? best[1] + path.slice(best[0].length) : path;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function readRecords(config: GuardConfig, side: Side): RecordInfo[] {
  const root = worktreesDir(config, side);
  return listDirs(root).map((name) => {
    const dir = join(root, name);
    return {
      name,
      dir,
      gitFile: readText(join(dir, "gitdir"))?.trim() || null,
      locked: readText(join(dir, "locked")) !== null,
    };
  });
}

function readSnapshots(config: GuardConfig): SnapshotEntry[] {
  const root = snapshotsDir(config);
  const entries: SnapshotEntry[] = [];
  for (const name of listDirs(root)) {
    const dir = join(root, name);
    try {
      const meta = JSON.parse(readFileSync(join(dir, ENTRY_META), "utf8")) as Partial<SnapshotEntry>;
      if (typeof meta.gitFile !== "string") continue;
      entries.push({
        name,
        dir,
        gitFile: meta.gitFile,
        pointer: typeof meta.pointer === "string" ? meta.pointer : null,
        savedAt: typeof meta.savedAt === "number" ? meta.savedAt : 0,
      });
    } catch {
      // A half-written entry: the next snapshot replaces it.
    }
  }
  return entries;
}

// `gitdir: <path>` in a worktree's `.git` file; relative paths are from the folder.
export function parsePointer(content: string | null, gitFile: string): string | null {
  const match = content ? /^gitdir:\s*(.+)$/m.exec(content) : null;
  const value = match?.[1]?.trim();
  return value ? resolve(dirname(gitFile), value) : null;
}

function kindOf(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? "d" : "f";
  } catch {
    return "-";
  }
}

// What the side running this code sees, for the paths a check needs.
export function localView(request: ProbeRequest): SideView {
  const view: SideView = { kinds: new Map(), pointers: new Map() };
  for (const path of request.paths) view.kinds.set(path, kindOf(path));
  for (const gitFile of request.gitFiles) {
    const pointer = parsePointer(readText(gitFile), gitFile);
    view.pointers.set(gitFile, pointer);
    if (pointer) view.kinds.set(pointer, kindOf(pointer));
  }
  return view;
}

export interface ProbeRequest {
  // Paths whose kind is needed.
  paths: string[];
  // `.git` files whose pointer, and the pointer's kind, are needed.
  gitFiles: string[];
}

// The same probe as a shell script, for a side reached through `docker exec`; reads
// `e <path>` and `p <path>` lines on stdin. Paths with newlines or tabs are not supported.
export const PROBE_SCRIPT = [
  "kind() { if [ -d \"$1\" ]; then echo d; elif [ -e \"$1\" ]; then echo f; else echo -; fi; }",
  "while IFS= read -r line; do",
  '  op=${line%% *}; p=${line#* }',
  '  case "$op" in',
  "    e) printf 'e\\t%s\\t%s\\n' \"$(kind \"$p\")\" \"$p\" ;;",
  "    p)",
  '      v=""',
  "      if [ -f \"$p\" ]; then v=$(sed -n 's/^gitdir:[[:space:]]*//p' \"$p\" | head -n 1); fi",
  '      case "$v" in ""|/*) r="$v" ;; *) r="$(dirname "$p")/$v" ;; esac',
  "      if [ -n \"$r\" ]; then printf 'p\\t%s\\t%s\\t%s\\n' \"$(kind \"$r\")\" \"$r\" \"$p\"; else printf 'p\\t-\\t\\t%s\\n' \"$p\"; fi ;;",
  "  esac",
  "done",
].join("\n");

export function probeInput(request: ProbeRequest): string {
  return [...request.paths.map((path) => `e ${path}`), ...request.gitFiles.map((path) => `p ${path}`)].join("\n") + "\n";
}

export function parseProbe(stdout: string): SideView {
  const view: SideView = { kinds: new Map(), pointers: new Map() };
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] === "e" && fields.length >= 3) {
      view.kinds.set(fields.slice(2).join("\t"), asKind(fields[1]));
    } else if (fields[0] === "p" && fields.length >= 4) {
      const pointer = fields[2] ? resolve(fields[2]) : null;
      view.pointers.set(fields.slice(3).join("\t"), pointer);
      if (pointer) view.kinds.set(pointer, asKind(fields[1]));
    }
  }
  return view;
}

function asKind(value: string | undefined): PathKind {
  return value === "d" || value === "f" ? value : "-";
}

// Everything a check needs to look at on each side; `local` reads the shared `.git`. `live` holds
// the folders of live workspaces, so ones whose record is gone are found too.
export function probeRequest(config: GuardConfig, local: Side, live: readonly string[] = []): ProbeRequest {
  const paths = new Set<string>();
  const gitFiles = new Set<string>();
  const add = (gitFile: string) => {
    for (const side of ["host", "container"] as const) {
      const path = translate(config, gitFile, side);
      paths.add(path);
      gitFiles.add(path);
    }
  };
  for (const record of readRecords(config, local)) if (record.gitFile) add(record.gitFile);
  for (const entry of readSnapshots(config)) {
    add(entry.gitFile);
    if (entry.pointer) paths.add(entry.pointer);
  }
  for (const folder of live) add(join(folder, ".git"));
  return { paths: [...paths], gitFiles: [...gitFiles] };
}

// The record a pointer names, when it is one of this repository's, in either side's form.
function namedRecord(config: GuardConfig, pointer: string | null): string | null {
  if (!pointer) return null;
  const parent = dirname(pointer);
  for (const side of ["host", "container"] as const) {
    if (parent === worktreesDir(config, side)) return basename(pointer);
  }
  return null;
}

interface Seen {
  side: Side;
  folder: string;
  gitFile: string;
  pointer: string | null;
}

// Classifies every worktree from the live records, the snapshot, and each side's view. `local`
// is the side running this code, which reads the shared `.git`.
export function classify(
  config: GuardConfig,
  local: Side,
  views: Partial<Record<Side, SideView>>,
  now = Date.now(),
  live: readonly string[] = [],
): GuardReport {
  const records = new Map(readRecords(config, local).map((record) => [record.name, record]));
  const snapshots = new Map(readSnapshots(config).map((entry) => [entry.name, entry]));
  const sides = (Object.keys(views) as Side[]).filter((side) => views[side]);
  const both = sides.length === 2;

  // Where a worktree's `.git` file can be seen, in either side's form of its path.
  const seenFrom = (gitFile: string): Seen[] => {
    const seen: Seen[] = [];
    for (const side of sides) {
      const view = views[side] as SideView;
      for (const path of new Set([gitFile, translate(config, gitFile, side)])) {
        if (view.kinds.get(path) !== "f") continue;
        seen.push({ side, folder: dirname(path), gitFile: path, pointer: view.pointers.get(path) ?? null });
        break;
      }
    }
    return seen;
  };
  const resolvesOn = (side: Side, pointer: string | null) => !!pointer && views[side]?.kinds.get(pointer) === "d";
  // The host's form of a path, so records written from either side compare equal.
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && translate(config, a, "host") === translate(config, b, "host");

  const worktrees: WorktreeReport[] = [];
  for (const name of new Set([...records.keys(), ...snapshots.keys()])) {
    const record = records.get(name) ?? null;
    const snapshot = snapshots.get(name) ?? null;
    const gitFile = record?.gitFile ?? snapshot?.gitFile;
    if (!gitFile) continue;
    const folder = dirname(gitFile);
    const report = (state: WorktreeState, problem: string | null, fix: Fix | null, seen: Seen[]): void => {
      const pointer = seen.find((entry) => resolvesOn(entry.side, entry.pointer))?.pointer ?? seen[0]?.pointer ?? null;
      worktrees.push({
        name,
        folder,
        state,
        problem,
        fix,
        reachable: seen.map(({ side, folder }) => ({ side, folder })),
        pointer,
      });
    };

    // A snapshot of another folder, or of this one under its old record: is it still there and
    // still naming this record?
    if (snapshot && (!record || !same(record.gitFile, snapshot.gitFile))) {
      const seen = seenFrom(snapshot.gitFile).filter((entry) => namedRecord(config, entry.pointer) === name);
      if (seen.length > 0) {
        const snapshotFolder = dirname(snapshot.gitFile);
        if (!record) {
          worktrees.push({
            name,
            folder: snapshotFolder,
            state: "broken",
            problem: "Its git record was deleted, likely by a git worktree prune on the other side; git fails in this folder.",
            fix: { kind: "record" },
            reachable: seen.map(({ side, folder }) => ({ side, folder })),
            pointer: seen[0]?.pointer ?? null,
          });
        } else {
          worktrees.push({
            name,
            folder: snapshotFolder,
            state: "broken",
            problem: `Its git record now belongs to ${dirname(record.gitFile ?? "")}; git in this folder acts on that worktree.`,
            fix: { kind: "rename" },
            reachable: seen.map(({ side, folder }) => ({ side, folder })),
            pointer: seen[0]?.pointer ?? null,
          });
        }
      }
      if (!record) continue;
    }
    if (!record) continue;

    const seen = seenFrom(gitFile);
    // A record whose folder no side sees: an archived worktree that prune has yet to clear, or a
    // folder of a side that is not running.
    if (seen.length === 0) continue;

    // Pointers a repair rewrote to a path some side cannot open.
    const broken = seen.filter((entry) => !resolvesOn(entry.side, entry.pointer));
    if (broken.length > 0) {
      const lastGood = snapshot?.pointer ?? null;
      // Only when both sides were seen: a stopped container may be the side it works on.
      const nowhere = both && broken.length === seen.length;
      // A pointer that never worked on a side is how that side's worktrees always are, not damage.
      const changed = broken.some((entry) => lastGood !== null && entry.pointer !== lastGood);
      if (changed || nowhere) {
        const fixable =
          lastGood !== null &&
          namedRecord(config, lastGood) === name &&
          broken.every((entry) => resolvesOn(entry.side, lastGood)) &&
          lastGood !== broken[0]?.pointer;
        const where = broken.map((entry) => SIDE_LABEL[entry.side]).join(" and ");
        report(
          "broken",
          `Its .git file points to ${broken[0]?.pointer ?? "nothing"}, which ${where} cannot open, likely after a git worktree repair on the other side.`,
          fixable ? { kind: "pointer", pointer: lastGood } : null,
          seen,
        );
        continue;
      }
    }

    // A prune on a side that cannot see the folder deletes its record.
    if (both && !record.locked) {
      const visible = new Set(
        sides.filter((side) => views[side]?.kinds.get(gitFile) === "f"),
      );
      if (visible.size === 1) {
        const [only] = [...visible] as [Side];
        const other: Side = only === "host" ? "container" : "host";
        // The same folder through a mount, at a path both sides see.
        const shared = [translate(config, gitFile, "host"), translate(config, gitFile, "container")].find(
          (path) => path !== gitFile && sides.every((side) => views[side]?.kinds.get(path) === "f"),
        );
        report(
          "at-risk",
          `Only ${SIDE_LABEL[only]} sees ${folder}, so a git worktree prune in ${SIDE_LABEL[other]} deletes its record.`,
          shared ? { kind: "share", gitFile: shared } : null,
          seen,
        );
        continue;
      }
    }
    report("safe", null, null, seen);
  }
  // Live workspaces whose record is gone and was never snapshotted.
  const covered = new Set(worktrees.map((entry) => translate(config, entry.folder, "host")));
  for (const folder of live) {
    if (covered.has(translate(config, folder, "host"))) continue;
    const gitFile = join(folder, ".git");
    const seen = seenFrom(gitFile);
    const name = seen.map((entry) => namedRecord(config, entry.pointer)).find(Boolean);
    if (!name) continue;
    const record = records.get(name);
    if (record && same(record.gitFile, gitFile)) continue;
    worktrees.push({
      name,
      folder,
      state: "broken",
      problem: record
        ? `Its git record now belongs to ${dirname(record.gitFile ?? "")}, and none was saved for this folder.`
        : "Its git record is gone, and none was saved before; git fails in this folder.",
      fix: { kind: "recreate", rename: !!record },
      reachable: seen.map(({ side, folder: reached }) => ({ side, folder: reached })),
      pointer: seen[0]?.pointer ?? null,
    });
  }
  worktrees.sort((a, b) => a.folder.localeCompare(b.folder));
  return { checkedAt: now, worktrees, sides };
}

// Saves working records so a later prune or repair can be undone. Broken worktrees keep their
// last good copy, and entries are only dropped once every side confirms the folder is gone.
export function snapshot(config: GuardConfig, local: Side, report: GuardReport, now = Date.now()): void {
  const root = snapshotsDir(config);
  mkdirSync(root, { recursive: true });
  // A name another folder still claims keeps the snapshot of that folder's record.
  const broken = new Set(report.worktrees.filter((entry) => entry.state === "broken").map((entry) => entry.name));
  const records = readRecords(config, local);
  const live = new Set(records.map((record) => record.name));
  for (const record of records) {
    if (!record.gitFile || broken.has(record.name)) continue;
    const folder = dirname(record.gitFile);
    const entry = report.worktrees.find((candidate) => candidate.name === record.name && candidate.folder === folder);
    // Not seen anywhere: an archived worktree on its way out.
    if (!entry) continue;
    writeEntry(root, record, entry.pointer, now);
  }
  if (report.sides.length < 2) return;
  for (const entry of readSnapshots(config)) {
    if (live.has(entry.name) || broken.has(entry.name)) continue;
    rmSync(entry.dir, { recursive: true, force: true });
  }
}

function writeEntry(root: string, record: RecordInfo, pointer: string | null, now: number): void {
  const dir = join(root, record.name);
  mkdirSync(dir, { recursive: true });
  let changed = false;
  for (const file of RECORD_FILES) {
    const content = readText(join(record.dir, file));
    const target = join(dir, file);
    if (content === null) {
      if (readText(target) !== null) {
        rmSync(target, { force: true });
        changed = true;
      }
      continue;
    }
    if (readText(target) === content) continue;
    atomicWrite(target, content);
    changed = true;
  }
  const meta = { gitFile: record.gitFile, pointer, savedAt: now };
  const current = readText(join(dir, ENTRY_META));
  let previous: { gitFile?: string; pointer?: string | null } = {};
  try {
    previous = current ? (JSON.parse(current) as typeof previous) : {};
  } catch {
    // Rewritten below.
  }
  if (changed || previous.gitFile !== meta.gitFile || previous.pointer !== meta.pointer) {
    atomicWrite(join(dir, ENTRY_META), `${JSON.stringify(meta, null, 2)}\n`);
  }
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

// Runs where a worktree's folder is: on this side, or in the container through `docker exec`.
export interface FolderOps {
  // Creates the record; fails with code EEXIST when it already exists.
  writeRecord(dir: string, files: Record<string, string>): Promise<void>;
  writePointer(gitFile: string, pointer: string): Promise<void>;
  // Rebuilds the index from HEAD without touching files: a mixed reset.
  resetIndex(folder: string, recordDir: string): Promise<void>;
}

export interface FixResult {
  name: string;
  folder: string;
  // The record's name after the fix; differs from `name` after a rename.
  restoredAs: string;
  error: string | null;
}

// Docker Desktop's file sharing caches directory entries in the container: a record the host
// writes can stay invisible there for a while, while the host sees the container's writes at
// once. So a fix runs in the container when it reaches the folder, and records are written by
// the side that fixes.
const FIX_ORDER: Side[] = ["container", "host"];

// Applies fixes; `local` reads the shared `.git`. Each folder is fixed from the first side in
// FIX_ORDER that reaches it and has `ops`.
export async function restore(
  config: GuardConfig,
  local: Side,
  report: GuardReport,
  ops: Partial<Record<Side, FolderOps>>,
  options: {
    only?: ReadonlySet<string>;
    exclude?: ReadonlySet<string>;
    kinds?: ReadonlySet<Fix["kind"]>;
    // The branch to recreate each record on, by record name.
    branches?: ReadonlyMap<string, string>;
  } = {},
): Promise<FixResult[]> {
  const snapshots = new Map(readSnapshots(config).map((entry) => [entry.name, entry]));
  const results: FixResult[] = [];
  for (const entry of report.worktrees) {
    if (!entry.fix || (options.only && !options.only.has(entry.name))) continue;
    if (options.kinds && !options.kinds.has(entry.fix.kind)) continue;
    if (entry.reachable.some(({ folder }) => options.exclude?.has(folder)) || options.exclude?.has(entry.folder)) continue;
    const at = FIX_ORDER.map((side) => entry.reachable.find((reach) => reach.side === side && ops[side])).find(Boolean);
    if (!at) continue;
    const folderOps = ops[at.side] as FolderOps;
    const result: FixResult = { name: entry.name, folder: entry.folder, restoredAs: entry.name, error: null };
    try {
      if (entry.fix.kind === "pointer") {
        await folderOps.writePointer(join(at.folder, ".git"), entry.fix.pointer);
      } else if (entry.fix.kind === "share") {
        // The record lives in the shared `.git`; its folder is not touched.
        atomicWrite(join(worktreesDir(config, local), entry.name, "gitdir"), `${entry.fix.gitFile}\n`);
      } else if (entry.fix.kind === "recreate") {
        const branch = options.branches?.get(entry.name);
        if (!branch) throw new Error("Pick the branch to recreate it on");
        const name = entry.fix.rename ? freeName(config, local, entry.name) : entry.name;
        // Named by its folder's path on this machine: Paseo's worktree folders are mounted at that
        // same path in the container, so a prune on either side keeps the record.
        const gitFile = join(translate(config, entry.folder, "host"), ".git");
        await folderOps.writeRecord(join(worktreesDir(config, at.side), name), {
          HEAD: `ref: refs/heads/${branch}\n`,
          commondir: "../..\n",
          gitdir: `${gitFile}\n`,
        });
        if (entry.fix.rename) {
          const pointerRoot = dirname(entry.pointer ?? join(worktreesDir(config, at.side), entry.name));
          await folderOps.writePointer(join(at.folder, ".git"), join(pointerRoot, name));
        }
        result.restoredAs = name;
        await folderOps.resetIndex(at.folder, join(worktreesDir(config, at.side), name));
      } else {
        const saved = snapshots.get(entry.name);
        if (!saved) throw new Error("No snapshot of its record");
        const name = entry.fix.kind === "record" ? entry.name : freeName(config, local, entry.name);
        const files: Record<string, string> = {};
        for (const file of RECORD_FILES) {
          const content = readText(join(saved.dir, file));
          if (content !== null) files[file] = content;
        }
        // Fails when the other side restored it first.
        await folderOps.writeRecord(join(worktreesDir(config, at.side), name), files);
        if (entry.fix.kind === "rename") {
          // Keep the pointer's form, so it opens where it did.
          const pointerRoot = dirname(saved.pointer ?? join(worktreesDir(config, at.side), entry.name));
          await folderOps.writePointer(join(at.folder, ".git"), join(pointerRoot, name));
        }
        result.restoredAs = name;
        await folderOps.resetIndex(at.folder, join(worktreesDir(config, at.side), name));
      }
    } catch (error) {
      result.error = (error as NodeJS.ErrnoException).code === "EEXIST" ? null : errorText(error);
    }
    results.push(result);
  }
  return results;
}

function freeName(config: GuardConfig, side: Side, name: string): string {
  const taken = new Set(listDirs(worktreesDir(config, side)));
  for (let index = 1; ; index++) {
    const candidate = `${name}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Folder operations on the side running this code.
export function localOps(): FolderOps {
  return {
    async writeRecord(dir, files) {
      mkdirSync(dirname(dir), { recursive: true });
      mkdirSync(dir);
      for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    },
    async writePointer(gitFile, pointer) {
      atomicWrite(gitFile, `gitdir: ${pointer}\n`);
    },
    resetIndex: (folder, recordDir) =>
      new Promise((resolvePromise, reject) => {
        // A command-line safe.directory: git refuses checkouts owned by another user, and the
        // global config is not ours to change.
        execFile(
          "git",
          ["-c", "safe.directory=*", "--git-dir", recordDir, "--work-tree", folder, "reset", "-q"],
          { cwd: folder, timeout: 120_000 },
          (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise()),
        );
      }),
  };
}

// The same operations as shell commands, for a side reached through `docker exec`. Exit code 17:
// the record exists.
export const RECORD_EXISTS_EXIT = 17;
export function writeRecordCommand(dir: string, files: Record<string, string>): string[] {
  const script = [
    'd=$1; shift; mkdir -p "$(dirname "$d")" || exit 1',
    `if ! mkdir "$d" 2>/dev/null; then [ -e "$d" ] && exit ${RECORD_EXISTS_EXIT}; exit 1; fi`,
    'while [ $# -gt 1 ]; do printf %s "$2" | base64 -d > "$d/$1" || exit 1; shift 2; done',
  ].join("\n");
  const args = Object.entries(files).flatMap(([file, content]) => [file, Buffer.from(content).toString("base64")]);
  return ["sh", "-c", script, "sh", dir, ...args];
}

export function writePointerCommand(gitFile: string, pointer: string): string[] {
  return ["sh", "-c", 'printf "gitdir: %s\\n" "$2" > "$1.tmp" && mv "$1.tmp" "$1"', "sh", gitFile, pointer];
}

export function resetIndexCommand(folder: string, recordDir: string): string[] {
  return ["git", "-c", "safe.directory=*", "--git-dir", recordDir, "--work-tree", folder, "-C", folder, "reset", "-q"];
}

// Snapshotted records that are gone from the repository, whether archived or pruned.
export function missingRecords(config: GuardConfig, side: Side): string[] {
  const live = new Set(readRecords(config, side).map((record) => record.name));
  return readSnapshots(config)
    .map((entry) => entry.name)
    .filter((name) => !live.has(name));
}

// Paseo reports an archive when it marks the workspace archived, before it removes the worktree
// and prunes. Waits for the folder to go, then for the prune that follows.
export async function settleArchive(folder: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(folder) && Date.now() < deadline) await sleep(500);
  await sleep(1_500);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export interface ContainerStatus {
  updatedAt: number;
  trigger: string;
  // The archived workspace's folder, so the host does not bring it back either.
  archived: string | null;
  restored: FixResult[];
  // Broken worktrees the container could not reach, left for the host.
  pending: string[];
}

export function readContainerStatus(config: Pick<GuardConfig, "guardDir">): ContainerStatus | null {
  try {
    return JSON.parse(readFileSync(join(config.guardDir, CONTAINER_STATUS), "utf8")) as ContainerStatus;
  } catch {
    return null;
  }
}

export function writeContainerStatus(config: Pick<GuardConfig, "guardDir">, status: ContainerStatus): void {
  mkdirSync(config.guardDir, { recursive: true });
  atomicWrite(join(config.guardDir, CONTAINER_STATUS), `${JSON.stringify(status, null, 2)}\n`);
}

export function readGuardConfig(guardDir: string): GuardConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(join(guardDir, GUARD_CONFIG), "utf8")) as Partial<GuardConfig>;
    if (typeof parsed.hostRepo !== "string" || typeof parsed.containerRepo !== "string") return null;
    const mounts = Array.isArray(parsed.mounts)
      ? parsed.mounts.filter((mount) => typeof mount?.source === "string" && typeof mount?.target === "string")
      : [];
    return { hostRepo: parsed.hostRepo, containerRepo: parsed.containerRepo, guardDir, mounts };
  } catch {
    return null;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
