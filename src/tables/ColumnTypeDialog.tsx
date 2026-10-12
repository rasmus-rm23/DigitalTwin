import { useState } from "react";
import { backend, ColumnConversion, ConversionResult, errorMessage, TableInfo } from "../api/backend";

interface Props {
  table: TableInfo;
  ordinal: number;
  onClose: () => void;
  onConverted: (result: ConversionResult) => void;
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];

/** Changes a column's type in place, e.g. text timestamps to date/time. */
export default function ColumnTypeDialog({ table, ordinal, onClose, onConverted }: Props) {
  const column = table.columns[ordinal];
  const [kind, setKind] = useState<ColumnConversion["kind"]>(column.kind === "datetime" ? "text" : "datetime");
  const [format, setFormat] = useState("");
  const [timezone, setTimezone] = useState(LOCAL_TZ);
  const [decimal, setDecimal] = useState(".");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConversionResult | null>(null);

  async function convert() {
    setBusy(true);
    setError(null);
    try {
      const r = await backend.tableConvertColumn(table.id, ordinal, {
        kind,
        datetimeFormat: format.trim() || null,
        timezone,
        decimal,
      });
      setResult(r);
      onConverted(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal column-type-dialog">
        <div className="modal-header">
          Change type of “{column.name}” (now {column.kind})
        </div>
        <div className="props modal-body">
          {result ? (
            <>
              <p>
                Converted {result.converted.toLocaleString()} values to {kind}
                {result.datetimeFormat && (
                  <>
                    {" "}
                    using format <code>{result.datetimeFormat}</code>
                  </>
                )}
                .
              </p>
              {result.warnings.map((w, i) => (
                <p key={i} className="error">
                  {w}
                </p>
              ))}
            </>
          ) : (
            <>
              <label>
                New type
                <select value={kind} onChange={(e) => setKind(e.target.value as ColumnConversion["kind"])}>
                  <option value="datetime">Date/time</option>
                  <option value="number">Number</option>
                  <option value="text">Text</option>
                </select>
              </label>
              {kind === "datetime" && (
                <>
                  <label title="chrono format, e.g. %d/%m/%Y %H.%M or %Y-%m-%d %H:%M:%S. Leave empty to detect.">
                    Format
                    <input
                      className="mono"
                      placeholder="detect automatically"
                      value={format}
                      onChange={(e) => setFormat(e.target.value)}
                    />
                  </label>
                  <label title="Time zone of the timestamps. They are stored as UTC.">
                    Time zone
                    <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                      {TIMEZONES.map((z) => (
                        <option key={z}>{z}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {kind === "number" && (
                <label>
                  Decimal separator
                  <select value={decimal} onChange={(e) => setDecimal(e.target.value)}>
                    <option value=".">Point 1.5</option>
                    <option value=",">Comma 1,5</option>
                  </select>
                </label>
              )}
              <p className="muted">
                Values that cannot be converted are left empty and listed afterwards. Links from the P&ID and plots
                to this column are kept.
              </p>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-footer">
          <span />
          {result ? (
            <button className="primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="primary" onClick={convert} disabled={busy || kind === column.kind}>
                {busy ? "Converting…" : "Convert"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
