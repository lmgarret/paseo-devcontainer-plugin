/// <reference types="node" />
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DevcontainerSettings, Forward } from "../shared/contract";
import type { DockerContainer } from "./discovery";
import { run, toolEnv } from "./process";

export const DEFAULT_DAEMON_PORT = 6767;
const DAEMON_PORT_RANGE = 100;
const APP_PORT_RANGE = 20;
// Linux hands these out to unnamed sockets; listeners there are rarely apps worth opening.
const EPHEMERAL_FROM = 32768;
const EPHEMERAL_TO = 60999;

// Runs in the container: one TCP connection bridged to the exec's stdio. Pipe writes are
// asynchronous, so it exits only once stdout has flushed.
const BRIDGE =
  'const s=require("net").connect(+process.argv[2],process.argv[1]);' +
  "process.stdin.pipe(s);s.pipe(process.stdout);" +
  's.on("error",()=>process.exit(1));s.on("close",()=>process.stdout.write("",()=>process.exit(0)));';

// Runs in the container: maps listening socket inodes to the command line of the process owning them.
const PROCESSES =
  'const fs=require("fs");const want=new Set(process.argv.slice(1));const out={};' +
  'for(const pid of fs.readdirSync("/proc")){if(!/^\\d+$/.test(pid))continue;let fds;' +
  'try{fds=fs.readdirSync(`/proc/${pid}/fd`)}catch{continue}' +
  'for(const fd of fds){let link;try{link=fs.readlinkSync(`/proc/${pid}/fd/${fd}`)}catch{continue}' +
  'const m=/^socket:\\[(\\d+)\\]$/.exec(link);if(!m||!want.has(m[1])||out[m[1]])continue;' +
  'try{out[m[1]]=fs.readFileSync(`/proc/${pid}/cmdline`,"utf8").split("\\0").filter(Boolean)}catch{}}}' +
  "console.log(JSON.stringify(out));";
const PROCESS_LABEL_MAX = 120;

// A login shell, so Node from nix, nvm, or a dotfiles PATH is found.
const NODE_LOOKUP = 'if command -v bash >/dev/null; then exec bash -lc "command -v node"; else command -v node; fi';

interface Listener {
  // Address to connect to from inside the container.
  host: string;
  port: number;
  // Socket inode, to find the owning process.
  inode: string;
}

interface Route {
  docker: string;
  env: NodeJS.ProcessEnv;
  containerId: string;
  remoteUser: string;
  node: string;
  host: string;
  port: number;
}

interface RepoForwards {
  daemon: Tunnel | null;
  apps: Map<number, Tunnel>;
  // Why nothing can be forwarded, such as Node missing in the container.
  error: string | null;
}

function emptyRepo(): RepoForwards {
  return { daemon: null, apps: new Map(), error: null };
}

interface SavedState {
  // Stable host port of each repository's daemon, so its pairing survives restarts.
  daemonPorts: Record<string, number>;
}

// A local port whose connections are each tunnelled into the container through `docker exec`.
class Tunnel {
  private readonly servers: Server[] = [];
  private readonly children = new Set<ChildProcess>();
  hostPort: number | null = null;
  error: string | null = null;
  // Command line of the process listening in the container, when known.
  process: string | null = null;
  // Forwarded on request rather than detected.
  manual = false;
  listening = false;

  constructor(public route: Route) {}

  // Loopback on IPv4 and, when available, IPv6, so `localhost` reaches us either way.
  async bind(port: number): Promise<boolean> {
    if (await answers(port)) return false;
    const v4 = await listen(port, "127.0.0.1", this.accept);
    if (typeof v4 === "string") return false;
    const v6 = await listen(port, "::1", this.accept);
    if (v6 === "EADDRINUSE") {
      v4.close();
      return false;
    }
    this.servers.push(v4);
    if (typeof v6 !== "string") this.servers.push(v6);
    this.hostPort = port;
    this.error = null;
    return true;
  }

  close(): void {
    for (const server of this.servers) server.close();
    this.servers.length = 0;
    for (const child of this.children) child.kill();
    this.children.clear();
    this.hostPort = null;
  }

  private readonly accept = (socket: Socket) => {
    const { docker, env, containerId, remoteUser, node, host, port } = this.route;
    const child = spawn(docker, ["exec", "-i", "-u", remoteUser, containerId, node, "-e", BRIDGE, host, String(port)], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stdin.on("error", () => socket.destroy());
    child.on("error", () => socket.destroy());
    child.on("exit", () => this.children.delete(child));
    socket.on("error", () => child.kill());
    socket.on("close", () => child.kill());
  };
}

export class PortForwarder {
  private readonly repos = new Map<string, RepoForwards>();
  // In-container daemon port per repository, as the daemon reports it.
  private readonly daemonPorts = new Map<string, number>();
  private readonly nodePaths = new Map<string, string>();
  // Process command line per container and socket inode; looked up once per new listener.
  private readonly processes = new Map<string, Map<string, string | null>>();
  private readonly saved: SavedState;

  constructor(private readonly statePath = defaultStatePath()) {
    this.saved = readState(statePath);
  }

  setDaemonPort(repoPath: string, port: number): void {
    this.daemonPorts.set(repoPath, port);
  }

  forwards(repoPath: string): Forward[] {
    const repo = this.repos.get(repoPath);
    if (!repo) return [];
    if (repo.error) {
      const containerPort = this.daemonPorts.get(repoPath) ?? DEFAULT_DAEMON_PORT;
      return [{ kind: "daemon", containerPort, hostPort: null, error: repo.error, process: null, manual: false, listening: false }];
    }
    const apps = [...repo.apps.values()].sort((a, b) => a.route.port - b.route.port);
    return [
      ...(repo.daemon ? [forwardOf("daemon", repo.daemon)] : []),
      ...apps.map((tunnel) => forwardOf("app", tunnel)),
    ];
  }

  // Matches forwards to what listens in each running container. Callers must not overlap calls.
  async sync(settings: DevcontainerSettings, docker: string, containers: DockerContainer[]): Promise<void> {
    const running = new Map<string, DockerContainer>();
    for (const container of containers) {
      if (!container.running || !container.localFolder) continue;
      const current = running.get(container.localFolder);
      if (!current || container.createdAt > current.createdAt) running.set(container.localFolder, container);
    }
    for (const repoPath of [...this.repos.keys()]) {
      if (!running.has(repoPath)) this.closeRepo(repoPath);
    }
    const ids = new Set([...running.values()].map((container) => container.id));
    for (const id of [...this.nodePaths.keys()]) if (!ids.has(id)) this.nodePaths.delete(id);
    for (const id of [...this.processes.keys()]) if (!ids.has(id)) this.processes.delete(id);
    // One container at a time, so two never race for the same host port.
    for (const [repoPath, container] of running) {
      await this.syncContainer(settings, docker, repoPath, container).catch((error: unknown) => {
        console.error(`[devcontainer-host] port forwarding for ${repoPath} failed:`, error);
      });
    }
  }

  close(): void {
    for (const repoPath of [...this.repos.keys()]) this.closeRepo(repoPath);
  }

  private async syncContainer(
    settings: DevcontainerSettings,
    docker: string,
    repoPath: string,
    container: DockerContainer,
  ): Promise<void> {
    const env = toolEnv([docker]);
    const listeners = await listListeners(docker, env, container.id);
    // Keep current forwards when the container cannot be read this time.
    if (!listeners) return;
    const daemonPort = this.daemonPorts.get(repoPath) ?? DEFAULT_DAEMON_PORT;
    const daemonListener = listeners.find((listener) => listener.port === daemonPort) ?? null;
    // A saved port is kept open while the daemon restarts, so the app reconnects to the same address.
    const wantDaemon = settings.forwardDaemon && (daemonListener !== null || repoPath in this.saved.daemonPorts);
    const overrides = settings.repoPorts[repoPath];
    const manual = new Set((overrides?.forwarded ?? []).filter((port) => port !== daemonPort));
    const ignored = [...settings.ignoredPorts, ...(overrides?.ignored ?? [])];
    // Host-network containers already share their ports with this machine through Docker; only
    // the daemon needs a port of its own, since this machine's daemon holds the default one.
    const detected =
      settings.forwardPorts && !container.hostNetwork
        ? listeners.filter(
            (listener) => listener.port !== daemonPort && !manual.has(listener.port) && isAppPort(listener.port, ignored),
          )
        : [];
    const byPort = new Map(listeners.map((listener) => [listener.port, listener]));
    const apps = [
      ...detected.map((listener) => ({ listener, manual: false })),
      ...[...manual].map((port) => ({
        listener: byPort.get(port) ?? { host: "127.0.0.1", port, inode: "" },
        manual: true,
      })),
    ];
    const repo = this.repos.get(repoPath) ?? emptyRepo();
    if (!wantDaemon && apps.length === 0) {
      this.closeRepo(repoPath);
      return;
    }
    this.repos.set(repoPath, repo);

    const node = await this.nodePath(docker, env, container);
    if (!node) {
      this.closeRepo(repoPath);
      this.repos.set(repoPath, { ...emptyRepo(), error: "Node.js not found in the container" });
      return;
    }
    repo.error = null;
    const base = { docker, env, containerId: container.id, remoteUser: container.remoteUser, node };

    if (wantDaemon) {
      const route = { ...base, host: daemonListener?.host ?? "127.0.0.1", port: daemonPort };
      repo.daemon ??= new Tunnel(route);
      repo.daemon.route = route;
      repo.daemon.listening = daemonListener !== null;
      if (repo.daemon.hostPort === null) await this.bindDaemon(repoPath, repo.daemon, settings.daemonPortStart);
    } else if (repo.daemon) {
      repo.daemon.close();
      repo.daemon = null;
    }

    const seen = new Set<number>();
    for (const { listener, manual: isManual } of apps) {
      seen.add(listener.port);
      const route = { ...base, host: listener.host, port: listener.port };
      const tunnel = repo.apps.get(listener.port) ?? new Tunnel(route);
      tunnel.route = route;
      tunnel.manual = isManual;
      tunnel.listening = byPort.has(listener.port);
      repo.apps.set(listener.port, tunnel);
      if (tunnel.hostPort === null) await this.bindApp(tunnel, listener.port);
    }
    for (const [port, tunnel] of repo.apps) {
      if (seen.has(port)) continue;
      tunnel.close();
      repo.apps.delete(port);
    }

    const names = await this.processNames(docker, env, container, node, apps.map((app) => app.listener));
    for (const { listener } of apps) {
      const tunnel = repo.apps.get(listener.port);
      if (tunnel) tunnel.process = names.get(listener.inode) ?? null;
    }
  }

  // Looks up only inodes not seen before, so a steady container costs nothing extra.
  private async processNames(
    docker: string,
    env: NodeJS.ProcessEnv,
    container: DockerContainer,
    node: string,
    listeners: Listener[],
  ): Promise<Map<string, string | null>> {
    const known = this.processes.get(container.id) ?? new Map<string, string | null>();
    this.processes.set(container.id, known);
    const missing = listeners.map((listener) => listener.inode).filter((inode) => inode && !known.has(inode));
    if (missing.length === 0) return known;
    // The remote user sees its own processes, which run the dev servers. Root without
    // CAP_SYS_PTRACE (Docker's default) cannot read other users' fds, so it only fills gaps.
    const found: Record<string, string[]> = {};
    for (const user of new Set([container.remoteUser, "root"])) {
      const wanted = missing.filter((inode) => !found[inode]);
      if (wanted.length === 0) break;
      const result = await run(docker, ["exec", "-u", user, container.id, node, "-e", PROCESSES, ...wanted], {
        env,
        timeoutMs: 10_000,
      }).catch(() => null);
      if (result?.code !== 0) continue;
      try {
        Object.assign(found, JSON.parse(result.stdout) as Record<string, string[]>);
      } catch {
        // Unreadable output: leave these unnamed.
      }
    }
    for (const inode of missing) known.set(inode, processLabel(found[inode]));
    return known;
  }

  private async bindDaemon(repoPath: string, tunnel: Tunnel, start: number): Promise<void> {
    const saved = this.saved.daemonPorts[repoPath];
    if (saved !== undefined) {
      // Never move a saved port: the app is paired with it.
      if (!(await tunnel.bind(saved))) tunnel.error = `localhost:${saved} is in use by another process`;
      return;
    }
    const reserved = new Set(Object.values(this.saved.daemonPorts));
    for (let port = start; port < start + DAEMON_PORT_RANGE && port <= 65535; port++) {
      if (reserved.has(port) || this.owns(port)) continue;
      if (await tunnel.bind(port)) {
        this.saved.daemonPorts[repoPath] = port;
        this.save();
        return;
      }
    }
    tunnel.error = `No free port from ${start}`;
  }

  // Same port as in the container when free, else the next free one; daemon ports stay reserved.
  private async bindApp(tunnel: Tunnel, port: number): Promise<void> {
    const reserved = new Set(Object.values(this.saved.daemonPorts));
    for (let candidate = port; candidate <= port + APP_PORT_RANGE && candidate <= 65535; candidate++) {
      if (reserved.has(candidate) || this.owns(candidate)) continue;
      if (await tunnel.bind(candidate)) return;
    }
    tunnel.error = `No free port from ${port} to ${port + APP_PORT_RANGE}`;
  }

  // Checked before probing: a probe connection to our own listener would open a tunnel.
  private owns(port: number): boolean {
    for (const repo of this.repos.values()) {
      if (repo.daemon?.hostPort === port) return true;
      for (const tunnel of repo.apps.values()) if (tunnel.hostPort === port) return true;
    }
    return false;
  }

  private async nodePath(docker: string, env: NodeJS.ProcessEnv, container: DockerContainer): Promise<string | null> {
    const cached = this.nodePaths.get(container.id);
    if (cached) return cached;
    const result = await run(
      docker,
      ["exec", "-u", container.remoteUser, container.id, "sh", "-c", NODE_LOOKUP],
      { env, timeoutMs: 20_000 },
    ).catch(() => null);
    // Dotfiles may print to a login shell's stdout; the path is the last line.
    const path = result?.code === 0 ? result.stdout.trim().split("\n").pop()?.trim() : undefined;
    if (!path?.startsWith("/")) return null;
    this.nodePaths.set(container.id, path);
    return path;
  }

  private closeRepo(repoPath: string): void {
    const repo = this.repos.get(repoPath);
    if (!repo) return;
    repo.daemon?.close();
    for (const tunnel of repo.apps.values()) tunnel.close();
    this.repos.delete(repoPath);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify(this.saved, null, 2)}\n`);
    } catch (error) {
      console.error("[devcontainer-host] could not save forwarded ports:", error);
    }
  }
}

function forwardOf(kind: Forward["kind"], tunnel: Tunnel): Forward {
  return {
    kind,
    containerPort: tunnel.route.port,
    hostPort: tunnel.hostPort,
    error: tunnel.error,
    process: kind === "daemon" ? "Paseo daemon" : tunnel.process,
    manual: tunnel.manual,
    listening: tunnel.listening,
  };
}

// "node /app/node_modules/.bin/vite --host" from the full argv, without the interpreter's path.
function processLabel(argv: string[] | undefined): string | null {
  if (!argv?.length) return null;
  const [command = "", ...args] = argv;
  const label = [command.split("/").pop() ?? command, ...args].join(" ");
  return label.length > PROCESS_LABEL_MAX ? `${label.slice(0, PROCESS_LABEL_MAX - 1)}…` : label;
}

function isAppPort(port: number, ignored: readonly number[]): boolean {
  return port >= 1024 && (port < EPHEMERAL_FROM || port > EPHEMERAL_TO) && !ignored.includes(port);
}

function defaultStatePath(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "devcontainer-host", "forwards.json");
}

function readState(path: string): SavedState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { daemonPorts?: unknown };
    const entries = Object.entries(typeof parsed.daemonPorts === "object" && parsed.daemonPorts ? parsed.daemonPorts : {});
    return {
      daemonPorts: Object.fromEntries(
        entries.filter((entry): entry is [string, number] => Number.isInteger(entry[1])),
      ),
    };
  } catch {
    return { daemonPorts: {} };
  }
}

// Resolves to the server, or the error code when the port cannot be bound.
function listen(port: number, host: string, onConnection: (socket: Socket) => void): Promise<Server | string> {
  return new Promise((resolve) => {
    const server = createServer(onConnection);
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "ERROR"));
    server.listen({ port, host, exclusive: true }, () => {
      server.removeAllListeners("error");
      server.on("error", (error) => console.error(`[devcontainer-host] forward ${host}:${port} failed:`, error));
      resolve(server);
    });
  });
}

// macOS lets us bind 127.0.0.1 next to another process's wildcard listener; ask first.
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function listListeners(docker: string, env: NodeJS.ProcessEnv, containerId: string): Promise<Listener[] | null> {
  // tcp6 is missing when IPv6 is off; cat still prints tcp and exits non-zero.
  const result = await run(docker, ["exec", containerId, "cat", "/proc/net/tcp", "/proc/net/tcp6"], {
    env,
    timeoutMs: 10_000,
  }).catch(() => null);
  return result?.stdout ? parseListeners(result.stdout) : null;
}

export function parseListeners(text: string): Listener[] {
  const byPort = new Map<number, Listener>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // st 0A is LISTEN.
    if (fields[3] !== "0A") continue;
    const [address, portHex] = (fields[1] ?? "").split(":");
    if (!address || !portHex) continue;
    const host = connectHost(address);
    if (!host) continue;
    const port = Number.parseInt(portHex, 16);
    const inode = fields[9] ?? "";
    const current = byPort.get(port);
    if (!current || (current.host.includes(":") && !host.includes(":"))) byPort.set(port, { host, port, inode });
  }
  return [...byPort.values()];
}

// /proc/net/tcp{,6} addresses are hex, little-endian per 32-bit word.
function connectHost(hex: string): string | null {
  if (hex.length === 8) {
    const ip = [6, 4, 2, 0].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(".");
    return ip === "0.0.0.0" ? "127.0.0.1" : ip;
  }
  if (hex.length !== 32) return null;
  const words = [0, 8, 16, 24].map((index) => hex.slice(index, index + 8).toUpperCase());
  const [w0, w1, w2, w3] = words as [string, string, string, string];
  const prefixZero = w0 === "00000000" && w1 === "00000000";
  // "::" is dual-stack by default and accepts IPv4.
  if (prefixZero && w2 === "00000000" && w3 === "00000000") return "127.0.0.1";
  if (prefixZero && w2 === "00000000" && w3 === "01000000") return "::1";
  if (prefixZero && w2 === "FFFF0000") return connectHost(w3);
  const bytes = words.flatMap((word) => [6, 4, 2, 0].map((index) => word.slice(index, index + 2)));
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(`${bytes[index]}${bytes[index + 1]}`.toLowerCase());
  return groups.join(":");
}
