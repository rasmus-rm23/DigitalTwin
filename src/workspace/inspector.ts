// What the Properties tool window shows. The active editor publishes a render function
// for its selection; the tool window subscribes and renders it.
import { ReactNode, useSyncExternalStore } from "react";

export interface InspectorContent {
  /** Identifies the publisher, so it only clears its own content. */
  owner: string;
  title: string;
  render: () => ReactNode;
}

let current: InspectorContent | null = null;
const listeners = new Set<() => void>();

export function setInspector(content: InspectorContent | null) {
  current = content;
  listeners.forEach((l) => l());
}

export function clearInspector(owner: string) {
  if (current?.owner === owner) setInspector(null);
}

export function useInspector(): InspectorContent | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
