// Turning per-batch series into uPlot data and series styling.
import { AlignedData } from "uplot";
import { BatchSeries, PlotDef, TableInfo } from "../api/backend";

export const PALETTE = [
  "#4fc1ff",
  "#f2a33a",
  "#89d185",
  "#f48771",
  "#c586c0",
  "#dcdcaa",
  "#4ec9b0",
  "#ce9178",
  "#9cdcfe",
  "#d16969",
];

/** Dash patterns that tell columns apart when colour already encodes the batch. */
const DASHES: number[][] = [[], [6, 4], [2, 3], [10, 3, 2, 3]];

export interface PlotLine {
  label: string;
  stroke: string;
  dash: number[];
}

/**
 * Merges batches onto one shared time axis. Each batch keeps its own samples (duplicate
 * times allowed); other batches' positions are null and the line spans them.
 * `columns[k]` is the index into each BatchSeries.values for the k-th plotted column.
 */
export function alignBatches(batches: BatchSeries[], columns: number[]): AlignedData {
  const entries: { x: number; b: number; i: number }[] = [];
  batches.forEach((s, b) => s.hours.forEach((x, i) => entries.push({ x, b, i })));
  entries.sort((p, q) => p.x - q.x || p.b - q.b || p.i - q.i);

  const xs = entries.map((e) => e.x);
  const ys: (number | null)[][] = [];
  batches.forEach((s, b) => {
    for (const c of columns) {
      const values = s.values[c];
      ys.push(entries.map((e) => (e.b === b ? (values?.[e.i] ?? null) : null)));
    }
  });
  return [xs, ...ys] as AlignedData;
}

/**
 * One line per (batch, column). Colour shows the batch when several are rendered,
 * otherwise the column; with both several batches and columns, dashes show the column.
 */
export function plotLines(def: PlotDef, batchKeys: string[], table: TableInfo | undefined): PlotLine[] {
  const multiBatch = batchKeys.length > 1;
  const multiColumn = def.series.length > 1;
  const lines: PlotLine[] = [];
  batchKeys.forEach((key, b) => {
    def.series.forEach((s, c) => {
      const name = table?.columns[s.column]?.name ?? `column ${s.column + 1}`;
      lines.push({
        label: multiBatch ? `${key || "All"} · ${name}` : name,
        stroke: multiBatch ? PALETTE[b % PALETTE.length] : (s.color ?? PALETTE[c % PALETTE.length]),
        dash: multiBatch && multiColumn ? DASHES[c % DASHES.length] : [],
      });
    });
  });
  return lines;
}
