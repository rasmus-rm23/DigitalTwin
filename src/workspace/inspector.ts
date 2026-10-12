// Content of the right-panel tool windows. The active view publishes a render function per
// slot (e.g. the P&ID editor fills "properties", the plot view fills "batches" and "plot");
// each tool window subscribes to its slot and renders it.
import { ReactNode, useSyncExternalStore } from "react";

export type InspectorSlot = "properties" | "batches" | "plot";

export interface InspectorContent {
  /** Identifies the publisher, so it only clears its own content. */
  owner: string;
  title: string;
  render: () => ReactNode;
}

const current = new Map<InspectorSlot, InspectorContent>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function setInspector(slot: InspectorSlot, content: InspectorContent) {
  current.set(slot, content);
  notify();
}

export function clearInspector(slot: InspectorSlot, owner: string) {
  if (current.get(slot)?.owner === owner) {
    current.delete(slot);
    notify();
  }
}

export function useInspector(slot: InspectorSlot): InspectorContent | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current.get(slot) ?? null,
  );
}
