import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import {
  backend,
  ColumnKind,
  ColumnSpec,
  errorMessage,
  ImportResult,
  Preview,
  PreviewSettings,
  TextEncoding,
} from "../api/backend";

interface Props {
  path: string;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}

const DELIMITERS: [string, string][] = [
  [";", "Semicolon ;"],
  [",", "Comma ,"],
  ["\t", "Tab"],
  ["|", "Pipe |"],
];

const KINDS: [ColumnKind, string][] = [
  ["number", "Number"],
  ["text", "Text"],
  ["datetime", "Date/time"],
  ["skip", "Skip"],
];

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export default function ImportDialog({ path, onClose, onImported }: Props) {
  const [settings, setSettings] = useState<PreviewSettings>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<ColumnSpec[]>([]);
  const [tableName, setTableName] = useState("");
  const [timezone, setTimezone] = useState(LOCAL_TZ);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);

  // Re-preview whenever the parse settings change; column edits are reset to the new inference.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    backend
      .importPreview(path, settings)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setColumns(p.columns);
        setTableName((name) => name || p.suggestedTableName);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [path, settings]);

  // Pin detected values so changing one setting does not re-detect the others.
  function updateSettings(change: PreviewSettings) {
    if (!preview) return;
    setSettings({
      format: preview.format,
      decimal: preview.decimal,
      headerRow: preview.headerRow,
      skipRows: preview.skipRows,
      ...change,
    });
  }

  function updateColumn(i: number, change: Partial<ColumnSpec>) {
    setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...change } : c)));
  }

  const validation = useMemo(() => {
    if (!tableName.trim()) return "Enter a table name.";
    const used = columns.filter((c) => c.kind !== "skip");
    if (used.length === 0) return "Select at least one column.";
    const names = used.map((c) => c.name.trim().toLowerCase());
    if (names.some((n) => !n)) return "Every imported column needs a name.";
    if (new Set(names).size !== names.length) return "Column names must be unique.";
    return null;
  }, [tableName, columns]);

  async function runImport() {
    if (!preview || validation) return;
    setImporting(true);
    setError(null);
    setProgress(0);
    const unlisten = await listen<number>("import-progress", (e) => setProgress(e.payload));
    try {
      const result = await backend.importRun(path, {
        format: preview.format,
        decimal: preview.decimal,
        headerRow: preview.headerRow,
        skipRows: preview.skipRows,
        timezone,
        tableName: tableName.trim(),
        columns,
      });
      onImported(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      unlisten();
      setImporting(false);
    }
  }

  const format = preview?.format;
  const hasDatetime = columns.some((c) => c.kind === "datetime");

  return (
    <div className="modal-backdrop">
      <div className="modal import-dialog">
        <div className="modal-header">Import {fileName(path)}</div>

        <div className="import-settings">
          <label>
            Table name
            <input value={tableName} onChange={(e) => setTableName(e.target.value)} />
          </label>

          {format?.kind === "spreadsheet" && (
            <label>
              Sheet
              <select
                value={format.sheet}
                onChange={(e) => updateSettings({ format: { kind: "spreadsheet", sheet: e.target.value } })}
              >
                {preview!.sheets.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}

          {format?.kind === "csv" && (
            <>
              <label>
                Delimiter
                <select
                  value={format.delimiter}
                  onChange={(e) => updateSettings({ format: { ...format, delimiter: e.target.value } })}
                >
                  {DELIMITERS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Encoding
                <select
                  value={format.encoding}
                  onChange={(e) =>
                    updateSettings({ format: { ...format, encoding: e.target.value as TextEncoding } })
                  }
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="windows-1252">Windows-1252 (Western)</option>
                </select>
              </label>
            </>
          )}

          {preview && (
            <>
              <label>
                Decimal
                <select value={preview.decimal} onChange={(e) => updateSettings({ decimal: e.target.value })}>
                  <option value=",">Comma 1,5</option>
                  <option value=".">Point 1.5</option>
                </select>
              </label>
              <label>
                Skip rows
                <input
                  type="number"
                  min={0}
                  value={preview.skipRows}
                  onChange={(e) => updateSettings({ skipRows: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={preview.headerRow}
                  onChange={(e) => updateSettings({ headerRow: e.target.checked })}
                />
                First row is header
              </label>
              <label title="Time zone of the timestamps in the file. Converted to UTC on import.">
                Time zone
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!hasDatetime}>
                  {TIMEZONES.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>

        <div className="import-preview">
          {!preview && !error && <p className="muted">Reading file…</p>}
          {preview && (
            <table className="grid">
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th key={i} className={c.kind === "skip" ? "skipped" : undefined}>
                      <input
                        value={c.name}
                        disabled={c.kind === "skip"}
                        onChange={(e) => updateColumn(i, { name: e.target.value })}
                      />
                      <select
                        value={c.kind}
                        onChange={(e) => updateColumn(i, { kind: e.target.value as ColumnKind })}
                      >
                        {KINDS.map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {c.kind === "datetime" && (
                        <input
                          className="mono"
                          placeholder="auto"
                          title="chrono format, e.g. %d-%m-%Y %H:%M:%S, or rfc3339. Empty = auto."
                          value={c.datetimeFormat ?? ""}
                          onChange={(e) => updateColumn(i, { datetimeFormat: e.target.value || null })}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, i) => (
                      <td key={i} className={columns[i]?.kind === "skip" ? "skipped" : undefined}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-footer">
          <span className={error ? "error" : "muted"}>
            {error ??
              (importing
                ? `Importing… ${progress.toLocaleString()} rows`
                : preview
                  ? (validation ?? `Showing first ${preview.rows.length} rows`)
                  : "")}
          </span>
          <button onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button className="primary" onClick={runImport} disabled={!preview || !!validation || importing}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
