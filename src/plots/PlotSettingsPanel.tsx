import { useEffect, useRef, useState } from "react";
import { PlotDef, TableInfo } from "../api/backend";
import { PALETTE } from "./data";

interface Props {
  plot: PlotDef | null;
  table: TableInfo | undefined;
  onChange: (patch: Partial<PlotDef>) => void;
  onDelete: () => void;
}

/** Number input that keeps its own text while typing; empty means "auto" (null). */
function OptionalNumber({ value, onChange, placeholder }: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value == null ? "" : String(value));
  }, [value]);
  return (
    <input
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setText(value == null ? "" : String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim().replace(",", ".");
        if (t === "") onChange(null);
        else if (!Number.isNaN(Number(t))) onChange(Number(t));
      }}
    />
  );
}

/** Right-panel "Plot" tab: settings of the selected plot. */
export default function PlotSettingsPanel({ plot, table, onChange, onDelete }: Props) {
  const [query, setQuery] = useState("");
  if (!plot) return <p className="muted">Select a plot to edit it, or add one with “+ Add plot”.</p>;
  if (!table) return <p className="muted">Choose a data table in the Batches tab first.</p>;

  const numeric = table.columns
    .map((c, i) => ({ ...c, index: i }))
    .filter((c) => c.kind === "number" && !plot.series.some((s) => s.column === c.index));
  const matches = numeric.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  function addColumn(index: number) {
    onChange({ series: [...plot!.series, { column: index, color: PALETTE[plot!.series.length % PALETTE.length] }] });
    setQuery("");
  }

  const rangeInvalid = plot.yMin != null && plot.yMax != null && plot.yMin >= plot.yMax;

  return (
    <div className="props">
      <label>
        Title
        <input value={plot.title} onChange={(e) => onChange({ title: e.target.value })} />
      </label>

      <div className="props-kind">Tag columns</div>
      <ul className="series-list">
        {plot.series.map((s, i) => (
          <li key={s.column}>
            <input
              type="color"
              value={s.color ?? PALETTE[i % PALETTE.length]}
              title="Line colour (used when one batch is shown)"
              onChange={(e) =>
                onChange({ series: plot.series.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })
              }
            />
            <span className="series-name">{table.columns[s.column]?.name}</span>
            <button
              className="icon"
              title="Remove"
              onClick={() => onChange({ series: plot.series.filter((_, j) => j !== i) })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {plot.series.length === 0 && <p className="muted">No columns yet.</p>}
      <label>
        Add column
        <input placeholder="Filter, e.g. TI-30" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="column-picker">
        {matches.slice(0, 50).map((c) => (
          <button key={c.index} className="column-picker-item" onClick={() => addColumn(c.index)}>
            {c.name}
          </button>
        ))}
        {matches.length > 50 && <span className="muted">{matches.length - 50} more, refine the filter</span>}
        {matches.length === 0 && <span className="muted">No matching numeric columns</span>}
      </div>

      <div className="props-kind">Y axis</div>
      <div className="props-row">
        <label>
          Min
          <OptionalNumber value={plot.yMin} placeholder="auto" onChange={(yMin) => onChange({ yMin })} />
        </label>
        <label>
          Max
          <OptionalNumber value={plot.yMax} placeholder="auto" onChange={(yMax) => onChange({ yMax })} />
        </label>
      </div>
      {rangeInvalid && <p className="error">Min must be below max.</p>}

      <div className="props-actions">
        <button onClick={onDelete}>Delete plot</button>
      </div>
    </div>
  );
}
