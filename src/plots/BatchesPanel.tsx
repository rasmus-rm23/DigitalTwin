import { BatchInfo, PlotConfig, PlotSource, TableInfo } from "../api/backend";

interface Props {
  config: PlotConfig;
  tables: TableInfo[];
  batches: BatchInfo[];
  batchError: string | null;
  onSourceChange: (source: PlotSource | null) => void;
  onSelectBatches: (keys: string[]) => void;
  onShowSimulations: (on: boolean) => void;
  onOpenTable: (table: TableInfo) => void;
}

const dateTime = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" });

/** Suggested source columns for a table: a "batch"-like text column and the first date/time column. */
export function defaultSource(table: TableInfo): PlotSource {
  const batch = table.columns.findIndex((c) => c.kind === "text" && /batch|charge|lot|run/i.test(c.name));
  const timeCol = table.columns.findIndex((c) => c.kind === "datetime");
  const textTime = table.columns.findIndex((c) => /time|tid|date|dato/i.test(c.name));
  return {
    tableId: table.id,
    batchColumn: batch >= 0 ? batch : null,
    timeColumn: timeCol >= 0 ? timeCol : Math.max(textTime, 0),
  };
}

/** Right-panel "Batches" tab: data source, batch selection, model simulations. */
export default function BatchesPanel(props: Props) {
  const { config, tables, batches, batchError } = props;
  const source = config.source;
  const table = source ? tables.find((t) => t.id === source.tableId) : undefined;
  const selected = new Set(config.selectedBatches);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // Keep batch order stable (by start time).
    props.onSelectBatches(batches.map((b) => b.key).filter((k) => next.has(k)));
  }

  return (
    <div className="props">
      <div className="props-kind">Data source</div>
      <label>
        Table
        <select
          value={source?.tableId ?? ""}
          onChange={(e) => {
            const t = tables.find((t) => t.id === Number(e.target.value));
            props.onSourceChange(t ? defaultSource(t) : null);
          }}
        >
          <option value="">Choose a table…</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {source && table && (
        <>
          <label>
            Batch column
            <select
              value={source.batchColumn ?? ""}
              onChange={(e) =>
                props.onSourceChange({ ...source, batchColumn: e.target.value === "" ? null : Number(e.target.value) })
              }
            >
              <option value="">None (whole table is one batch)</option>
              {table.columns.map((c, i) => (
                <option key={i} value={i}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
          </label>
          <label>
            Time column
            <select
              value={source.timeColumn}
              onChange={(e) => props.onSourceChange({ ...source, timeColumn: Number(e.target.value) })}
            >
              {table.columns.map((c, i) => (
                <option key={i} value={i}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {batchError && (
        <div className="error">
          {batchError}
          {table && (
            <div>
              <button className="link-button" onClick={() => props.onOpenTable(table)}>
                Open {table.name}
              </button>
            </div>
          )}
        </div>
      )}

      {source && !batchError && (
        <>
          <div className="props-kind batches-header">
            <span>Batches</span>
            <span>
              <button className="link-button" onClick={() => props.onSelectBatches(batches.map((b) => b.key))}>
                All
              </button>
              <button className="link-button" onClick={() => props.onSelectBatches([])}>
                None
              </button>
            </span>
          </div>
          <p className="muted">Each batch is shifted to start at 0 h.</p>
          <ul className="batch-list">
            {batches.map((b) => (
              <li key={b.key}>
                <label className="checkbox">
                  <input type="checkbox" checked={selected.has(b.key)} onChange={() => toggle(b.key)} />
                  <span className="batch-key">{b.key || "All data"}</span>
                </label>
                <span className="muted">
                  {dateTime.format(new Date(b.startMs))} · {((b.endMs - b.startMs) / 3_600_000).toFixed(1)} h ·{" "}
                  {b.rows.toLocaleString()} rows
                </span>
              </li>
            ))}
          </ul>
          {batches.length === 0 && <p className="muted">No batches found.</p>}
        </>
      )}

      <div className="props-kind">Model simulations</div>
      <label className="checkbox" title="Available once models have been trained">
        <input
          type="checkbox"
          checked={config.showSimulations}
          disabled
          onChange={(e) => props.onShowSimulations(e.target.checked)}
        />
        Show model simulations
      </label>
      <p className="muted">Available once models have been trained.</p>
    </div>
  );
}
