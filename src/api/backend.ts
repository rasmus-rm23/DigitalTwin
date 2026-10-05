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
  sidecarPing: () => invoke<SidecarPing>("sidecar_ping"),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) return String(e.message);
  return String(e);
}
