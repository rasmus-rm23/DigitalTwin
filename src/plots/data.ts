// Turning per-batch series into uPlot data and series styling.
import { AlignedData } from "uplot";
import { BatchSeries, PlotDef, SimulationResult, TableInfo } from "../api/backend";

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

/** A rendered batch or simulation: its legend label and series. */
export interface PlotEntry {
  label: string;
  series: BatchSeries;
  /** Simulations only: the columns they have values for (their model's inputs and outputs). */
  simColumns?: Set<number>;
}

/**
 * A simulation result as a batch: one value array per requested column (null where the
 * simulation does not have that column).
 */
export function simulationSeries(key: string, result: SimulationResult, columns: number[]): BatchSeries {
  const byColumn = new Map<number, (number | null)[]>();
  for (const v of [...result.inputs, ...result.outputs]) byColumn.set(v.column, v.values);
  const empty = result.hours.map(() => null);
  return { key, hours: result.hours, values: columns.map((c) => byColumn.get(c) ?? empty) };
}

/**
 * One line per (entry, column). Colour shows the batch or simulation when several are rendered,
 * otherwise the column; with both several entries and columns, dashes show the column.
 */
export function plotLines(def: PlotDef, entries: PlotEntry[], table: TableInfo | undefined): PlotLine[] {
  const multiBatch = entries.length > 1;
  const multiColumn = def.series.length > 1;
  const lines: PlotLine[] = [];
  entries.forEach(({ label, simColumns }, b) => {
    def.series.forEach((s, c) => {
      const name = table?.columns[s.column]?.name ?? `column ${s.column + 1}`;
      lines.push({
        // A simulation is always named, so it is not mistaken for measured data.
        label: multiBatch || simColumns ? `${label} · ${name}` : name,
        stroke: multiBatch ? PALETTE[b % PALETTE.length] : (s.color ?? PALETTE[c % PALETTE.length]),
        dash: multiBatch && multiColumn ? DASHES[c % DASHES.length] : [],
      });
    });
  });
  return lines;
}
