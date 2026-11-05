/// <reference types="node" />
// The companion plugin, run by the Paseo daemon inside a dev container. The host plugin copies
// this file and the modules it imports into the container's Paseo home as the
// `devcontainer-companion` plugin; the host plugin itself never loads it. Each module does
// nothing until the host plugin writes its data into the shared home:
// - the worktree guard repairs git worktree records after archives in the container;
// - the plugin mirror installs the host's plugins in this daemon.
//
// Type imports and Node built-ins only: the copy has no node_modules.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startGuard } from "./companion-guard";
import { startPluginMirror } from "./companion-plugins";

export default function contribute(server: PluginServerContext) {
  const stops = [startGuard(server), startPluginMirror()];
  return () => {
    for (const stop of stops) stop();
  };
}
