/// <reference types="node" />
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

// Mirrors Paseo's own project icon resolution (server/utils/project-icon.js) so the plugin shows
// the same icon as the sidebar: a custom icon from the Paseo home, else a favicon in the repo.

export interface ProjectIcon {
  data: string;
  mimeType: string;
}

const ICON_PATTERNS = [
  "favicon.svg",
  "favicon.png",
  "favicon-*.svg",
  "favicon-*.png",
  "favico.svg",
  "favico.png",
  "icon.svg",
  "icon.png",
  "app-icon.svg",
  "app-icon.png",
  "apple-touch-icon.png",
  "apple-touch-icon-*.png",
  "icon-*.png",
  "android-chrome-*.png",
  "safari-pinned-tab.svg",
  "mstile-*.png",
  "logo.svg",
  "logo.png",
];
const PRIORITY_DIRS = ["public", "static", "priv/static", "assets", "images", "img"];
const MONOREPO_DIRS = ["packages", "apps"];
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  "vendor",
  "src",
  "lib",
  "test",
  "tests",
  "__tests__",
]);
const MAX_AUTO_ICON_BYTES = 32 * 1024;
const MAX_CUSTOM_ICON_BYTES = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function readProjectIcon(project: {
  projectId: string;
  rootPath: string;
  customIconRevision: string | null;
}): Promise<ProjectIcon | null> {
  if (project.customIconRevision) {
    const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const key = createHash("sha256").update(project.projectId).digest("hex");
    try {
      const bytes = await readFile(join(paseoHome, "projects", "icons", `${key}.bin`));
      const mimeType = sniff(bytes);
      if (mimeType && bytes.length <= MAX_CUSTOM_ICON_BYTES) return { data: bytes.toString("base64"), mimeType };
    } catch {
      // Missing custom icon: Paseo shows the initial too.
    }
    return null;
  }
  const path = await findIcon(project.rootPath);
  if (!path) return null;
  try {
    if ((await stat(path)).size > MAX_AUTO_ICON_BYTES) return null;
    const bytes = await readFile(path);
    const mimeType = sniff(bytes) ?? (extname(path).toLowerCase() === ".svg" ? "image/svg+xml" : null);
    if (!mimeType) return null;
    if (mimeType === "image/png" && !isSquarePng(bytes)) return null;
    return { data: bytes.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  const head = bytes.toString("utf8", 0, 256).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && bytes.includes("<svg"))) return "image/svg+xml";
  return null;
}

function isSquarePng(bytes: Buffer): boolean {
  return bytes.length >= 24 && bytes.readUInt32BE(16) === bytes.readUInt32BE(20);
}

function matches(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  return new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`).test(name);
}

async function entries(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function iconIn(dir: string): Promise<string | null> {
  const names = await entries(dir);
  if (!names) return null;
  for (const pattern of ICON_PATTERNS) {
    for (const name of names) {
      if (matches(name, pattern) && (await isFile(join(dir, name)))) return join(dir, name);
    }
  }
  return null;
}

async function searchRecursive(dir: string, maxDepth: number, depth = 0): Promise<string | null> {
  if (depth > maxDepth) return null;
  const found = await iconIn(dir);
  if (found) return found;
  for (const name of (await entries(dir)) ?? []) {
    if (IGNORED_DIRS.has(name) || !(await isDir(join(dir, name)))) continue;
    const nested = await searchRecursive(join(dir, name), maxDepth, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function searchPriority(base: string, maxDepth: number): Promise<string | null> {
  for (const priority of PRIORITY_DIRS) {
    const dir = join(base, priority);
    if (!(await isDir(dir))) continue;
    const found = await searchRecursive(dir, maxDepth);
    if (found) return found;
  }
  return null;
}

async function findIcon(root: string, maxDepth = 3): Promise<string | null> {
  const priority = await searchPriority(root, maxDepth - 1);
  if (priority) return priority;
  for (const mono of MONOREPO_DIRS) {
    for (const name of (await entries(join(root, mono))) ?? []) {
      const pkg = join(root, mono, name);
      if (!(await isDir(pkg))) continue;
      const found = (await searchPriority(pkg, maxDepth - 1)) ?? (await iconIn(pkg));
      if (found) return found;
    }
  }
  return iconIn(root);
}
