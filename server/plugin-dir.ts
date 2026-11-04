/// <reference types="node" />
// The daemon runs this plugin as a bundle, so its own folder is found through the daemon's
// plugin config. Files beside the code, such as the docs and the companion's sources, are read
// from there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostPaseoHome, readConfig } from "./paseo-home";

const PLUGIN_ID = "devcontainer-host";

// The configured folder whose manifest is this plugin's, preferring its usual ID and enabled
// entries.
export function pluginDir(): string | null {
  const plugins = Object.entries(readConfig(hostPaseoHome())?.plugins ?? {}).sort(
    ([idA, a], [idB, b]) =>
      Number(idB === PLUGIN_ID) - Number(idA === PLUGIN_ID) || Number(b.enabled !== false) - Number(a.enabled !== false),
  );
  for (const [, source] of plugins) {
    if (!source.path) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(source.path, "paseo-plugin.json"), "utf8")) as { id?: string };
      if (manifest.id === PLUGIN_ID) return source.path;
    } catch {
      // Not this plugin.
    }
  }
  return null;
}

// A file of this plugin, by its path in the repository; null when it cannot be read.
export function readPluginFile(path: string): string | null {
  const dir = pluginDir();
  if (!dir) return null;
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return null;
  }
}
