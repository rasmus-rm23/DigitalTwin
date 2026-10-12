import { BatchInfo } from "../api/backend";

interface Props {
  hasSource: boolean;
  batches: BatchInfo[];
  batchError: string | null;
  /** Training batches (config.batches). */
  selected: string[];
  onSelect: (keys: string[]) => void;
  testFraction: number;
  onTestFraction: (f: number) => void;
  /** Batches with results from the last training, in order. */
  resultBatches: string[];
  shownBatch: string | null;
  onShowBatch: (key: string) => void;
}

const dateTime = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" });

/** Right-panel "Batches" tab of the Models view: training batches and the batch shown in the results. */
export default function ModelBatchesPanel(props: Props) {
  const { batches, resultBatches } = props;
  const selected = new Set(props.selected);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // Keep batch order stable (by start time).
    props.onSelect(batches.map((b) => b.key).filter((k) => next.has(k)));
  }

  if (!props.hasSource) return <p className="muted">Choose the model's data table first (step 1).</p>;
  if (props.batchError) return <p className="error">{props.batchError}</p>;

  return (
    <div className="props">
      <div className="props-kind batches-header">
        <span>Training batches</span>
        <span>
          <button className="link-button" onClick={() => props.onSelect(batches.map((b) => b.key))}>
            All
          </button>
          <button className="link-button" onClick={() => props.onSelect([])}>
            None
          </button>
        </span>
      </div>
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
      <label title="The last part of every selected batch is used to test the model">
        Test share: {Math.round(props.testFraction * 100)} % (end of each batch)
        <input
          type="range"
          min={0}
          max={50}
          step={5}
          value={Math.round(props.testFraction * 100)}
          onChange={(e) => props.onTestFraction(Number(e.target.value) / 100)}
        />
      </label>

      <div className="props-kind">Show in results</div>
      {resultBatches.length === 0 ? (
        <p className="muted">Train the model to inspect its results per batch.</p>
      ) : (
        <ul className="batch-list">
          {resultBatches.map((key) => (
            <li key={key}>
              <label className="checkbox">
                <input
                  type="radio"
                  name="model-shown-batch"
                  checked={props.shownBatch === key}
                  onChange={() => props.onShowBatch(key)}
                />
                <span className="batch-key">{key || "All data"}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
