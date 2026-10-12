// Conversion between the stored Diagram and React Flow nodes/edges.
import { Edge, MarkerType, Node } from "@xyflow/react";
import { ColumnRef, ConnectionKind, Diagram, ElementKind, PidElement, TableInfo } from "../api/backend";
import { SYMBOL_BY_KIND } from "./symbols";

export type PidNodeData = {
  kind: ElementKind;
  tag: string;
  label: string;
  rotation: PidElement["rotation"];
  props: Record<string, unknown>;
  column: ColumnRef | null;
};

export type PidNode = Node<PidNodeData>;
export type PidEdge = Edge<{ kind: ConnectionKind }>;

export const GRID = 10;

const LINE_COLOR = "#c8c8c8";
const SIGNAL_COLOR = "#8fb8de";

export function nodeType(kind: ElementKind) {
  return kind === "instrument" ? "instrument" : kind === "label" ? "label" : "symbol";
}

export function newId(prefix: string) {
  return `${prefix}${crypto.randomUUID().slice(0, 8)}`;
}

/** Applies the visual style for a line kind: solid pipe with arrow, or dashed signal line. */
export function styleEdge(edge: PidEdge, kind: ConnectionKind): PidEdge {
  return {
    ...edge,
    type: "smoothstep",
    data: { kind },
    style:
      kind === "process"
        ? { stroke: LINE_COLOR, strokeWidth: 2 }
        : { stroke: SIGNAL_COLOR, strokeWidth: 1.2, strokeDasharray: "6 4" },
    markerEnd: kind === "process" ? { type: MarkerType.ArrowClosed, color: LINE_COLOR, width: 16, height: 16 } : undefined,
    labelStyle: { fill: "#cccccc", fontSize: 11 },
    labelBgStyle: { fill: "#1e1e1e" },
  };
}

export function fromDiagram(d: Diagram): { nodes: PidNode[]; edges: PidEdge[] } {
  const nodes: PidNode[] = d.elements.map((e) => ({
    id: e.id,
    type: nodeType(e.kind),
    position: { x: e.x, y: e.y },
    width: e.width,
    height: e.height,
    data: { kind: e.kind, tag: e.tag, label: e.label, rotation: e.rotation, props: e.props, column: e.column },
  }));
  const edges: PidEdge[] = d.connections.map((c) =>
    styleEdge(
      {
        id: c.id,
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle,
        targetHandle: c.targetHandle,
        label: c.label || undefined,
      },
      c.kind,
    ),
  );
  return { nodes, edges };
}

export function toDiagram(meta: { id: number; name: string }, nodes: PidNode[], edges: PidEdge[]): Diagram {
  return {
    ...meta,
    elements: nodes.map((n) => {
      const def = SYMBOL_BY_KIND[n.data.kind];
      return {
        id: n.id,
        kind: n.data.kind,
        tag: n.data.tag,
        label: n.data.label,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        width: Math.round(n.width ?? n.measured?.width ?? def.width),
        height: Math.round(n.height ?? n.measured?.height ?? def.height),
        rotation: n.data.rotation,
        props: n.data.props,
        column: n.data.column,
      };
    }),
    connections: edges.map((e) => ({
      id: e.id,
      kind: e.data?.kind ?? "process",
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      targetHandle: e.targetHandle ?? null,
      label: typeof e.label === "string" ? e.label : "",
    })),
  };
}

/** Next free tag with the given prefix, numbered from 101. */
export function nextTag(prefix: string, nodes: PidNode[]): string {
  if (!prefix) return "";
  let max = 100;
  for (const n of nodes) {
    if (n.data.tag.startsWith(prefix)) {
      const num = parseInt(n.data.tag.slice(prefix.length), 10);
      if (!Number.isNaN(num)) max = Math.max(max, num);
    }
  }
  return `${prefix}${max + 1}`;
}

export function columnExists(ref: ColumnRef, tables: TableInfo[]) {
  const t = tables.find((t) => t.id === ref.tableId);
  return !!t && ref.ordinal >= 0 && ref.ordinal < t.columns.length;
}

export function columnName(ref: ColumnRef, tables: TableInfo[]): string | null {
  const t = tables.find((t) => t.id === ref.tableId);
  const c = t?.columns[ref.ordinal];
  return t && c ? `${t.name} › ${c.name}` : null;
}

/** ISA tag split into function letters and loop number: "TIC-101" -> ["TIC", "101"]. */
export function splitInstrumentTag(tag: string): [string, string] {
  const m = tag.trim().match(/^([A-Za-z]+)[-\s]*(.*)$/);
  return m ? [m[1].toUpperCase(), m[2]] : ["", tag.trim()];
}
