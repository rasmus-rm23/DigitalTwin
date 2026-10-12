// Content of the right-panel tool windows. Each view publishes a render function per slot
// (e.g. the P&ID editor fills "properties", the plot view fills "batches" and "plot"), keyed by
// its dockview panel id. The tool windows show the active panel's content only, and the
// workspace hides the tabs whose slot the active panel does not fill.
import { ReactNode, useMemo, useSyncExternalStore } from "react";

export type InspectorSlot = "properties" | "batches" | "plot";

export interface InspectorContent {
  /** The publishing view's dockview panel id (singleton views use their view id, e.g. "plots"). */
  owner: string;
  title: string;
  render: () => ReactNode;
}

const content = new Map<string, Map<InspectorSlot, InspectorContent>>();
let activeOwner: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  listeners.forEach((l) => l());
}

export function setInspector(slot: InspectorSlot, c: InspectorContent) {
  let slots = content.get(c.owner);
  if (!slots) content.set(c.owner, (slots = new Map()));
  slots.set(slot, c);
  notify();
}

export function clearInspector(slot: InspectorSlot, owner: string) {
  if (content.get(owner)?.delete(slot)) notify();
}

/** Called by the workspace when the active main-area tab changes. */
export function setActiveOwner(owner: string | null) {
  if (owner === activeOwner) return;
  activeOwner = owner;
  notify();
}

function useVersion() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** The active view's content for a slot. */
export function useInspector(slot: InspectorSlot): InspectorContent | null {
  useVersion();
  return (activeOwner && content.get(activeOwner)?.get(slot)) || null;
}

/**
 * The slots the active view fills. Views republish on every render, so this snapshot is a
 * string that only changes when the set of slots does; otherwise the workspace would re-render
 * the views on every publish, and they would publish again.
 */
export function useInspectorSlots(): Set<InspectorSlot> {
  const key = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => [...((activeOwner && content.get(activeOwner)?.keys()) || [])].sort().join(","),
  );
  return useMemo(() => new Set(key ? (key.split(",") as InspectorSlot[]) : []), [key]);
}
