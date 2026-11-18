// The companion plugin's app side (see server/companion.ts). Paseo only lets a plugin badge the
// workspaces of its own host, so the companion, which runs in the container's daemon, adds the
// badge items for the container's workspaces. What they show comes from the host plugin, loaded
// in the same app: it registers its badge components here, and the companion renders them. With
// no host plugin in the app, the companion shows nothing.
//
// Also imported by the host plugin. The copy in the container has no node_modules, so this file
// imports only modules the app supplies to plugin code.
import type { PluginClientContext, PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { type ComponentType, useSyncExternalStore } from "react";

type BadgeComponent = ComponentType<PluginWorkspaceRowBadgeItemProps & { side: "container" }>;

export interface BadgeComponents {
  container: BadgeComponent;
  worktree: BadgeComponent;
}

interface Registry {
  components: BadgeComponents | null;
  listeners: Set<() => void>;
}

// Shared through the app's global scope, since each plugin's code is loaded on its own. Bump the
// version when the components' props change.
const KEY = "__paseoDevcontainerBadges_v1";

function registry(): Registry {
  const scope = globalThis as unknown as Record<string, Registry | undefined>;
  scope[KEY] ??= { components: null, listeners: new Set() };
  return scope[KEY];
}

// The host plugin's side; returns its cleanup.
export function provideBadges(components: BadgeComponents): () => void {
  const shared = registry();
  shared.components = components;
  for (const listener of shared.listeners) listener();
  return () => {
    if (shared.components !== components) return;
    shared.components = null;
    for (const listener of shared.listeners) listener();
  };
}

function subscribe(listener: () => void): () => void {
  const shared = registry();
  shared.listeners.add(listener);
  return () => shared.listeners.delete(listener);
}

function useBadges(): BadgeComponents | null {
  return useSyncExternalStore(subscribe, () => registry().components);
}

function ContainerItem(props: PluginWorkspaceRowBadgeItemProps) {
  const Component = useBadges()?.container;
  return Component ? <Component {...props} side="container" /> : null;
}

function WorktreeItem(props: PluginWorkspaceRowBadgeItemProps) {
  const Component = useBadges()?.worktree;
  return Component ? <Component {...props} side="container" /> : null;
}

export default function contribute(client: PluginClientContext) {
  // Paseo before 0.16 has no workspace badges; the rest of the companion still runs there.
  if (typeof client.addWorkspaceRowBadgeItem !== "function") return () => {};
  const removers = [
    client.addWorkspaceRowBadgeItem({ id: "container", title: "Dev container", icon: "Box", Component: ContainerItem }),
    client.addWorkspaceRowBadgeItem({
      id: "worktree",
      title: "Shared worktree problems",
      icon: "GitBranch",
      Component: WorktreeItem,
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
