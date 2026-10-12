// P&ID symbol library: simplified ISO 10628 / ISA-5.1 shapes.
// Keep kinds in sync with ELEMENT_KINDS in src-tauri/src/domain/pid.rs.
import { ReactNode } from "react";
import { ElementKind } from "../api/backend";

export type Side = "top" | "right" | "bottom" | "left";

/** A connection point: a side of the unrotated symbol and a position along it (0..1). */
export interface HandleDef {
  id: string;
  side: Side;
  at: number;
}

export interface SymbolDef {
  kind: ElementKind;
  title: string;
  group: "Equipment" | "Valves" | "Instruments" | "Other";
  /** Default (unrotated) size in px. */
  width: number;
  height: number;
  resizable: boolean;
  /** Prefix for auto-numbered tags, e.g. "C-" gives C-101, C-102, ... */
  tagPrefix: string;
  handles: HandleDef[];
  /** SVG content in unrotated coordinates (0..w, 0..h). Not used for instruments and labels. */
  draw?: (w: number, h: number) => ReactNode;
}

const sides = (...extra: HandleDef[]): HandleDef[] => [
  { id: "t", side: "top", at: 0.5 },
  { id: "r", side: "right", at: 0.5 },
  { id: "b", side: "bottom", at: 0.5 },
  { id: "l", side: "left", at: 0.5 },
  ...extra,
];

const P = 1.5; // stroke inset so outlines are not clipped

function bowTie(w: number, top: number, h: number) {
  const cy = top + h / 2;
  return (
    <>
      <path d={`M${P},${top + P} L${w / 2},${cy} L${P},${top + h - P} Z`} />
      <path d={`M${w - P},${top + P} L${w / 2},${cy} L${w - P},${top + h - P} Z`} />
    </>
  );
}

export const SYMBOLS: SymbolDef[] = [
  {
    kind: "column",
    title: "Column",
    group: "Equipment",
    width: 60,
    height: 220,
    resizable: true,
    tagPrefix: "C-",
    handles: [
      { id: "t", side: "top", at: 0.5 },
      { id: "b", side: "bottom", at: 0.5 },
      { id: "l1", side: "left", at: 0.2 },
      { id: "l2", side: "left", at: 0.5 },
      { id: "l3", side: "left", at: 0.8 },
      { id: "r1", side: "right", at: 0.2 },
      { id: "r2", side: "right", at: 0.5 },
      { id: "r3", side: "right", at: 0.8 },
    ],
    draw: (w, h) => {
      const head = Math.min(w / 2, h / 6);
      const trays = [];
      for (let y = head + 12; y < h - head - 6; y += 18) {
        trays.push(<line key={y} x1={P + 4} y1={y} x2={w - P - 4} y2={y} strokeDasharray="4 3" />);
      }
      return (
        <>
          <rect x={P} y={P} width={w - 2 * P} height={h - 2 * P} rx={w / 2 - P} ry={head} />
          {trays}
        </>
      );
    },
  },
  {
    kind: "vessel",
    title: "Vessel",
    group: "Equipment",
    width: 70,
    height: 120,
    resizable: true,
    tagPrefix: "V-",
    handles: sides(),
    draw: (w, h) => (
      <rect x={P} y={P} width={w - 2 * P} height={h - 2 * P} rx={w / 2 - P} ry={Math.min(w / 3, h / 4)} />
    ),
  },
  {
    kind: "tank",
    title: "Tank",
    group: "Equipment",
    width: 110,
    height: 100,
    resizable: true,
    tagPrefix: "T-",
    handles: [
      { id: "t", side: "top", at: 0.5 },
      { id: "b", side: "bottom", at: 0.5 },
      { id: "l", side: "left", at: 0.8 },
      { id: "r", side: "right", at: 0.8 },
      { id: "l2", side: "left", at: 0.4 },
      { id: "r2", side: "right", at: 0.4 },
    ],
    draw: (w, h) => (
      <path d={`M${P},${h * 0.2} L${w / 2},${P} L${w - P},${h * 0.2} V${h - P} H${P} Z`} />
    ),
  },
  {
    kind: "pump",
    title: "Pump",
    group: "Equipment",
    width: 56,
    height: 56,
    resizable: false,
    tagPrefix: "P-",
    handles: sides(),
    draw: (w, h) => {
      const r = Math.min(w, h) / 2 - P;
      return (
        <>
          <circle cx={w / 2} cy={h / 2} r={r} />
          {/* Triangle pointing in the flow direction (left to right). */}
          <path d={`M${w / 2 - r * 0.45},${h / 2 - r * 0.8} L${w / 2 + r},${h / 2} L${w / 2 - r * 0.45},${h / 2 + r * 0.8}`} />
        </>
      );
    },
  },
  {
    kind: "heat_exchanger",
    title: "Heat exchanger",
    group: "Equipment",
    width: 110,
    height: 44,
    resizable: true,
    tagPrefix: "E-",
    handles: [
      { id: "l", side: "left", at: 0.5 },
      { id: "r", side: "right", at: 0.5 },
      { id: "t1", side: "top", at: 0.25 },
      { id: "t2", side: "top", at: 0.75 },
      { id: "b1", side: "bottom", at: 0.25 },
      { id: "b2", side: "bottom", at: 0.75 },
    ],
    draw: (w, h) => {
      const n = 6;
      const step = (w - h) / n;
      const pts = Array.from({ length: n + 1 }, (_, i) => `${h / 2 + i * step},${i % 2 ? h * 0.25 : h * 0.75}`);
      return (
        <>
          <rect x={P} y={P} width={w - 2 * P} height={h - 2 * P} rx={h / 2 - P} />
          <polyline points={`${P},${h / 2} ${pts.join(" ")} ${w - P},${h / 2}`} />
        </>
      );
    },
  },
  {
    kind: "valve",
    title: "Valve",
    group: "Valves",
    width: 40,
    height: 24,
    resizable: false,
    tagPrefix: "HV-",
    handles: [
      { id: "l", side: "left", at: 0.5 },
      { id: "r", side: "right", at: 0.5 },
    ],
    draw: (w, h) => bowTie(w, 0, h),
  },
  {
    kind: "control_valve",
    title: "Control valve",
    group: "Valves",
    width: 40,
    height: 46,
    resizable: false,
    tagPrefix: "FV-",
    handles: [
      { id: "l", side: "left", at: 35 / 46 },
      { id: "r", side: "right", at: 35 / 46 },
      { id: "t", side: "top", at: 0.5 },
    ],
    draw: (w, h) => (
      <>
        {bowTie(w, h - 22, 22)}
        <line x1={w / 2} y1={h - 11} x2={w / 2} y2={13} />
        <path d={`M${w / 2 - 12},13 A12,12 0 0 1 ${w / 2 + 12},13 Z`} />
      </>
    ),
  },
  {
    kind: "instrument",
    title: "Instrument",
    group: "Instruments",
    width: 52,
    height: 52,
    resizable: false,
    tagPrefix: "TI-",
    handles: sides(),
  },
  {
    kind: "connector",
    title: "Stream in/out",
    group: "Other",
    width: 100,
    height: 28,
    resizable: true,
    tagPrefix: "S-",
    handles: [
      { id: "l", side: "left", at: 0.5 },
      { id: "r", side: "right", at: 0.5 },
    ],
    draw: (w, h) => <path d={`M${P},${P} H${w - h / 2} L${w - P},${h / 2} L${w - h / 2},${h - P} H${P} Z`} />,
  },
  {
    kind: "label",
    title: "Text",
    group: "Other",
    width: 140,
    height: 24,
    resizable: true,
    tagPrefix: "",
    handles: [],
  },
];

export const SYMBOL_BY_KIND = Object.fromEntries(SYMBOLS.map((s) => [s.kind, s])) as Record<
  ElementKind,
  SymbolDef
>;

export const GROUPS = ["Equipment", "Valves", "Instruments", "Other"] as const;

/** Small preview of a symbol for the palette. */
export function SymbolIcon({ kind, size = 28 }: { kind: ElementKind; size?: number }) {
  const def = SYMBOL_BY_KIND[kind];
  const scale = size / Math.max(def.width, def.height);
  const w = def.width * scale;
  const h = def.height * scale;
  return (
    <svg width={size} height={size} viewBox={`${-(size - w) / 2 / scale} ${-(size - h) / 2 / scale} ${size / scale} ${size / scale}`} className="pid-symbol">
      {kind === "instrument" ? (
        <circle cx={def.width / 2} cy={def.height / 2} r={def.width / 2 - 2} />
      ) : kind === "label" ? (
        <text x={def.width / 2} y={def.height / 2} textAnchor="middle" dominantBaseline="central" fontSize={def.height * 1.6} stroke="none" fill="currentColor">
          T
        </text>
      ) : (
        def.draw?.(def.width, def.height)
      )}
    </svg>
  );
}

/**
 * Where a handle ends up after rotating the symbol clockwise by `rotation` degrees.
 * Returns the side of the displayed node and the position along it (0..1).
 */
export function rotateHandle(h: HandleDef, rotation: number): { side: Side; at: number } {
  // Unit-square point for the handle, rotated 90° clockwise k times: (u, v) -> (1 - v, u).
  let [u, v] =
    h.side === "top" ? [h.at, 0] : h.side === "right" ? [1, h.at] : h.side === "bottom" ? [h.at, 1] : [0, h.at];
  for (let k = 0; k < ((rotation / 90) % 4 + 4) % 4; k++) [u, v] = [1 - v, u];
  if (v === 0) return { side: "top", at: u };
  if (u === 1) return { side: "right", at: v };
  if (v === 1) return { side: "bottom", at: u };
  return { side: "left", at: v };
}
