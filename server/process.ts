/// <reference types="node" />
import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export class ToolMissingError extends Error {}

// A GUI-launched daemon on macOS usually lacks Homebrew, Docker Desktop and nvm paths.
const EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
  join(homedir(), ".docker/bin"),
  join(homedir(), ".orbstack/bin"),
  join(homedir(), ".volta/bin"),
  join(homedir(), ".npm-global/bin"),
  join(homedir(), "Library/pnpm"),
];

function nvmDirs(): string[] {
  const root = join(homedir(), ".nvm/versions/node");
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs(): string[] {
  const inherited = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...inherited, ...EXTRA_DIRS, ...nvmDirs()])];
}

export function resolveTool(name: string, configured: string): string | null {
  if (configured) return isExecutable(configured) ? configured : null;
  for (const dir of searchDirs()) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// Tools' own directories go first: `devcontainer` is a `#!/usr/bin/env node` script, and
// docker needs its credential helpers.
export function toolEnv(tools: string[]): NodeJS.ProcessEnv {
  const dirs = [...new Set([...tools.map((tool) => dirname(tool)), ...searchDirs()])];
  return { ...process.env, PATH: dirs.join(delimiter) };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const emit = (chunk: string) => {
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(ANSI, "").trimEnd();
        if (clean) options.onLine(clean);
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      emit(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      emit(chunk);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${command} ${args[0] ?? ""} timed out after ${options.timeoutMs} ms`));
        }, options.timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      emit("\n");
      resolve({ code, stdout, stderr });
    });
  });
}
