import { useSyncExternalStore } from "react";
import type { Status } from "../shared/contract";

// The last status the plugin's one global subscription received, for surfaces mounted many times
// at once, such as a badge on every sidebar workspace row, that should not subscribe each.
let current: Status | null = null;
const listeners = new Set<() => void>();

export function publishStatus(status: Status): void {
  current = status;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSharedStatus(): Status | null {
  return useSyncExternalStore(subscribe, () => current);
}
