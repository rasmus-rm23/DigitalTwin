// Typed wrappers over Tauri commands. Keep in sync with src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  path: string;
  name: string;
  createdAt: string;
  schemaVersion: number;
}

export interface AppError {
  kind: "db" | "io" | "json" | "noProject" | "invalidInput" | "sidecar" | "parse";
  message: string;
}

export interface SidecarPing {
  status: string;
  version: string;
  python: string;
}

// --- Import (mirror of src-tauri/src/domain/import) ---

export type ColumnKind = "number" | "text" | "datetime" | "skip";
export type TextEncoding = "utf-8" | "windows-1252";

export type FileFormat =
  | { kind: "csv"; delimiter: string; encoding: TextEncoding }
  | { kind: "spreadsheet"; sheet: string };

export interface ColumnSpec {
  sourceIndex: number;
  name: string;
  kind: ColumnKind;
  /** chrono format string, "rfc3339", or null for native spreadsheet dates / auto. */
  datetimeFormat: string | null;
}

/** Omitted fields are auto-detected. */
export interface PreviewSettings {
  format?: FileFormat;
  decimal?: string;
  headerRow?: boolean;
  skipRows?: number;
}

export interface Preview {
  format: FileFormat;
  sheets: string[];
  decimal: string;
  headerRow: boolean;
  skipRows: number;
  columns: ColumnSpec[];
  rows: string[][];
  suggestedTableName: string;
}

export interface ImportOptions {
  format: FileFormat;
  decimal: string;
  headerRow: boolean;
  skipRows: number;
  timezone: string;
  tableName: string;
  columns: ColumnSpec[];
}

export interface ColumnInfo {
  name: string;
  kind: Exclude<ColumnKind, "skip">;
}

export interface TableInfo {
  id: number;
  name: string;
  sourcePath: string | null;
  rowCount: number;
  importedAt: string;
  columns: ColumnInfo[];
}

export interface ImportResult {
  table: TableInfo;
  warnings: string[];
}

/** Cell value from `tableRows`: datetime columns are epoch ms (UTC). */
export type CellValue = number | string | null;

// --- P&ID (mirror of src-tauri/src/domain/pid.rs) ---

export type ElementKind =
  | "column"
  | "vessel"
  | "tank"
  | "pump"
  | "heat_exchanger"
  | "valve"
  | "control_valve"
  | "instrument"
  | "connector"
  | "label";

export type ConnectionKind = "process" | "signal";

/** A data column by table id and zero-based column position. */
export interface ColumnRef {
  tableId: number;
  ordinal: number;
}

export interface PidElement {
  id: string;
  kind: ElementKind;
  tag: string;
  label: string;
  x: number;
  y: number;
  /** Displayed (rotated) size. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  props: Record<string, unknown>;
  column: ColumnRef | null;
}

export interface PidConnection {
  id: string;
  kind: ConnectionKind;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  label: string;
}

export interface Diagram {
  id: number;
  name: string;
  elements: PidElement[];
  connections: PidConnection[];
}

// --- Column type change (mirror of src-tauri/src/domain/column_type.rs) ---

export interface ColumnConversion {
  kind: Exclude<ColumnKind, "skip">;
  /** chrono format or "rfc3339"; null detects it from the values. */
  datetimeFormat: string | null;
  timezone: string;
  decimal: string;
}

export interface ConversionResult {
  table: TableInfo;
  converted: number;
  invalid: number;
  datetimeFormat: string | null;
  warnings: string[];
}

// --- Plots (mirror of src-tauri/src/domain/plots.rs) ---

/** Columns are zero-based positions in the table. */
export interface PlotSource {
  tableId: number;
  /** null treats the whole table as one batch. */
  batchColumn: number | null;
  timeColumn: number;
}

export interface SeriesDef {
  column: number;
  color: string | null;
}

export interface PlotDef {
  id: string;
  title: string;
  series: SeriesDef[];
  yMin: number | null;
  yMax: number | null;
}

export interface PlotConfig {
  source: PlotSource | null;
  selectedBatches: string[];
  layout: "stacked" | "pairs";
  /** px per plot, 80-2000. */
  plotHeight: number;
  showSimulations: boolean;
  plots: PlotDef[];
}

export interface PlotSheet {
  id: number;
  name: string;
  config: PlotConfig;
}

export interface BatchInfo {
  /** "" when the source has no batch column. */
  key: string;
  startMs: number;
  endMs: number;
  rows: number;
}

/** One batch's samples, time in hours since its first sample. */
export interface BatchSeries {
  key: string;
  hours: number[];
  /** One array per requested column. */
  values: (number | null)[][];
}

// --- Models (mirror of src-tauri/src/domain/models.rs and sidecar training.py) ---

export interface Algorithm {
  kind: "linear" | "neuralNetwork";
  /** Neurons per hidden layer (neural network). */
  hiddenLayers: number[];
  activation: "relu" | "tanh" | "logistic";
  /** L2 regularisation (neural network). */
  alpha: number;
  maxIter: number;
}

/** Delay and Gaussian smoothing (sigma) of one input for one output, in minutes. */
export interface Dynamics {
  input: number;
  output: number;
  delayMin: number;
  sigmaMin: number;
  /** False when the input cannot affect the output (e.g. it is downstream); it is then not used. */
  enabled: boolean;
}

export interface ModelConfig {
  source: PlotSource | null;
  inputs: number[];
  outputs: number[];
  dynamics: Dynamics[];
  algorithm: Algorithm;
  batches: string[];
  /** Share of each batch's duration, at its end, held out for testing (0-0.9). */
  testFraction: number;
}

export type ModelStatus = "draft" | "trained" | "failed";

export interface ModelSummary {
  id: number;
  name: string;
  status: ModelStatus;
  trainedAt: string | null;
}

export interface OutputSeries {
  batch: string;
  hours: number[];
  measured: number[];
  predicted: number[];
  testStartHours: number | null;
}

export interface OutputResult {
  column: number;
  name: string;
  nTrain: number;
  nTest: number;
  r2Train: number | null;
  r2Test: number | null;
  rmseTrain: number | null;
  rmseTest: number | null;
  coefficients: { intercept: number; slopes: { column: number; name: string; value: number }[] } | null;
  series: OutputSeries[];
}

export interface TrainResult {
  outputs: OutputResult[];
  warnings: string[];
}

export interface Model {
  id: number;
  name: string;
  config: ModelConfig;
  status: ModelStatus;
  result: TrainResult | null;
  error: string | null;
  trainedAt: string | null;
  /** The definition changed since the stored result was trained. */
  stale: boolean;
}

// --- Simulations (mirror of src-tauri/src/domain/simulations.rs and sidecar simulation.py) ---

export interface SetPoint {
  /** Hours since the simulation start. */
  hours: number;
  value: number;
}

/**
 * "fixed": one value throughout. "points": setpoints at given times, linear in between and held
 * before the first and after the last; two setpoints at the same time give a step.
 */
export interface InputProfile {
  column: number;
  mode: "fixed" | "points";
  value: number;
  points: SetPoint[];
}

export interface SimulationConfig {
  modelId: number | null;
  durationH: number;
  stepMin: number;
  inputs: InputProfile[];
}

/** A model variable with its measured range in the source table. */
export interface SimVariable {
  column: number;
  name: string;
  min: number | null;
  max: number | null;
  mean: number | null;
}

export interface SimModel {
  id: number;
  name: string;
  trained: boolean;
  trainedAt: string | null;
  /** The model definition changed since training; the trained version is simulated. */
  modelStale: boolean;
  inputs: SimVariable[];
  outputs: SimVariable[];
}

export interface SimulationSummary {
  id: number;
  name: string;
  runAt: string | null;
}

export interface SimulationResult {
  hours: number[];
  inputs: { column: number; name: string; values: number[] }[];
  outputs: { column: number; name: string; values: (number | null)[] }[];
  warnings: string[];
}

export interface Simulation {
  id: number;
  name: string;
  config: SimulationConfig;
  model: SimModel | null;
  result: SimulationResult | null;
  error: string | null;
  runAt: string | null;
  /** Settings or model changed since the stored result was computed. */
  stale: boolean;
}

/** File extension for project files (SQLite inside). */
export const PROJECT_EXTENSION = "dtwin";

export const IMPORT_EXTENSIONS = ["csv", "txt", "tsv", "xlsx", "xlsm", "xlsb", "xls", "ods"];

export const backend = {
  projectCreate: (path: string, name: string) =>
    invoke<ProjectInfo>("project_create", { path, name }),
  projectOpen: (path: string) => invoke<ProjectInfo>("project_open", { path }),
  projectClose: () => invoke<void>("project_close"),
  projectCurrent: () => invoke<ProjectInfo | null>("project_current"),
  importPreview: (path: string, settings: PreviewSettings) =>
    invoke<Preview>("import_preview", { path, settings }),
  /** Listen to the "import-progress" event (rows written) while this runs. */
  importRun: (path: string, options: ImportOptions) =>
    invoke<ImportResult>("import_run", { path, options }),
  tablesList: () => invoke<TableInfo[]>("tables_list"),
  tableRows: (id: number, offset: number, limit: number) =>
    invoke<CellValue[][]>("table_rows", { id, offset, limit }),
  tableDelete: (id: number) => invoke<void>("table_delete", { id }),
  pidGet: () => invoke<Diagram>("pid_get"),
  pidSave: (diagram: Diagram) => invoke<void>("pid_save", { diagram }),
  tableConvertColumn: (id: number, ordinal: number, conversion: ColumnConversion) =>
    invoke<ConversionResult>("table_convert_column", { id, ordinal, conversion }),
  plotSheetGet: () => invoke<PlotSheet>("plot_sheet_get"),
  plotSheetSave: (sheet: PlotSheet) => invoke<void>("plot_sheet_save", { sheet }),
  plotBatches: (source: PlotSource) => invoke<BatchInfo[]>("plot_batches", { source }),
  modelsList: () => invoke<ModelSummary[]>("models_list"),
  modelGet: (id: number) => invoke<Model>("model_get", { id }),
  modelCreate: (name: string) => invoke<Model>("model_create", { name }),
  modelSave: (id: number, name: string, config: ModelConfig) =>
    invoke<Model>("model_save", { id, name, config }),
  modelDelete: (id: number) => invoke<void>("model_delete", { id }),
  /** Trains in the Python sidecar; a failed run comes back as status "failed". */
  modelTrain: (id: number) => invoke<Model>("model_train", { id }),
  plotBatchSeries: (source: PlotSource, batch: string, columns: number[]) =>
    invoke<BatchSeries>("plot_batch_series", { source, batch, columns }),
  simulationsList: () => invoke<SimulationSummary[]>("simulations_list"),
  simulationGet: (id: number) => invoke<Simulation>("simulation_get", { id }),
  simulationCreate: (name: string) => invoke<Simulation>("simulation_create", { name }),
  simulationSave: (id: number, name: string, config: SimulationConfig) =>
    invoke<Simulation>("simulation_save", { id, name, config }),
  simulationDelete: (id: number) => invoke<void>("simulation_delete", { id }),
  /** Runs in the Python sidecar; a failed run comes back with `error` set. */
  simulationRun: (id: number) => invoke<Simulation>("simulation_run", { id }),
  sidecarPing: () => invoke<SidecarPing>("sidecar_ping"),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) return String(e.message);
  return String(e);
}
