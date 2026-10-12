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
  plotBatchSeries: (source: PlotSource, batch: string, columns: number[]) =>
    invoke<BatchSeries>("plot_batch_series", { source, batch, columns }),
  sidecarPing: () => invoke<SidecarPing>("sidecar_ping"),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) return String(e.message);
  return String(e);
}
