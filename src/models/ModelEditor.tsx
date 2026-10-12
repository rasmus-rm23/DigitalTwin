import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Algorithm,
  backend,
  BatchInfo,
  Dynamics,
  errorMessage,
  Model,
  ModelConfig,
  PlotSource,
  TableInfo,
} from "../api/backend";
import { defaultSource } from "../plots/BatchesPanel";
import { clearInspector, setInspector } from "../workspace/inspector";
import { useWorkspace } from "../workspace/WorkspaceContext";
import ModelBatchesPanel from "./ModelBatchesPanel";
import ModelResults from "./ModelResults";

const SAVE_DELAY_MS = 500;
/** Inspector owner: the Models view's dockview panel id. */
const OWNER = "models";

type Role = "none" | "input" | "output";

interface Props {
  initial: Model;
  onChanged: (m: Model) => void;
}

/** Number field with local text, so typing "1." or "" does not fight the stored value. */
export function NumberField({ value, onChange, min = 0, title, className }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  title?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <input
      className={className}
      inputMode="decimal"
      title={title}
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.target.select(); // typing replaces the value instead of appending to "0"
      }}
      onBlur={() => {
        focused.current = false;
        setText(String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.trim().replace(",", "."));
        if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min) onChange(n);
      }}
    />
  );
}

export function Step({ n, title, children, done }: { n: number; title: string; children: ReactNode; done: boolean }) {
  return (
    <section className="model-step">
      <h3>
        <span className={`step-number${done ? " done" : ""}`}>{done ? "✓" : n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Keeps one Dynamics entry per input/output pair (new pairs start at 0/0). */
function syncDynamics(c: ModelConfig): Dynamics[] {
  const existing = new Map(c.dynamics.map((d) => [`${d.input}:${d.output}`, d]));
  return c.inputs.flatMap((input) =>
    c.outputs.map(
      (output) => existing.get(`${input}:${output}`) ?? { input, output, delayMin: 0, sigmaMin: 0, enabled: true },
    ),
  );
}

export default function ModelEditor({ initial, onChanged }: Props) {
  const { tables, showTool } = useWorkspace();
  const [model, setModel] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [config, setConfig] = useState(initial.config);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [trainError, setTrainError] = useState<string | null>(null);

  const source = config.source;
  const table: TableInfo | undefined = source ? tables.find((t) => t.id === source.tableId) : undefined;

  const update = useCallback((fn: (c: ModelConfig) => ModelConfig) => setConfig((c) => fn(c)), []);

  // --- Autosave (debounced); the core's answer updates status/staleness, not the form ---
  const lastSaved = useRef(JSON.stringify({ name: initial.name, config: initial.config }));
  const save = useCallback(async () => {
    const json = JSON.stringify({ name, config });
    if (json === lastSaved.current || !name.trim()) return;
    try {
      const m = await backend.modelSave(model.id, name, config);
      lastSaved.current = json;
      setModel(m);
      onChanged(m);
      setSaveError(null);
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  }, [name, config, model.id, onChanged]);

  useEffect(() => {
    const t = setTimeout(save, SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [save]);

  // --- Batches of the source ---
  const [batches, setBatches] = useState<BatchInfo[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const sourceKey = source ? `${source.tableId}:${source.batchColumn}:${source.timeColumn}` : "";
  useEffect(() => {
    setBatches([]);
    setBatchError(null);
    if (!source) return;
    backend
      .plotBatches(source)
      .then(setBatches)
      .catch((e) => setBatchError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // --- Variables ---
  const [filter, setFilter] = useState("");
  const numeric = useMemo(
    () => (table?.columns ?? []).map((c, i) => ({ ...c, index: i })).filter((c) => c.kind === "number"),
    [table],
  );
  const shown = numeric.filter(
    (c) =>
      c.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
      config.inputs.includes(c.index) ||
      config.outputs.includes(c.index),
  );
  const role = (i: number): Role => (config.inputs.includes(i) ? "input" : config.outputs.includes(i) ? "output" : "none");
  function setRole(i: number, r: Role) {
    update((c) => {
      const next = {
        ...c,
        inputs: r === "input" ? [...c.inputs.filter((x) => x !== i), i] : c.inputs.filter((x) => x !== i),
        outputs: r === "output" ? [...c.outputs.filter((x) => x !== i), i] : c.outputs.filter((x) => x !== i),
      };
      return { ...next, dynamics: syncDynamics(next) };
    });
  }
  const colName = (i: number) => table?.columns[i]?.name ?? `column ${i + 1}`;

  // --- Dynamics ---
  const [bulk, setBulk] = useState({ delay: 0, sigma: 0 });
  function setDyn(input: number, output: number, patch: Partial<Dynamics>) {
    update((c) => ({
      ...c,
      dynamics: c.dynamics.map((d) => (d.input === input && d.output === output ? { ...d, ...patch } : d)),
    }));
  }
  const dyn = (input: number, output: number) =>
    config.dynamics.find((d) => d.input === input && d.output === output) ?? {
      input,
      output,
      delayMin: 0,
      sigmaMin: 0,
      enabled: true,
    };
  const unconnectedOutputs = config.outputs.filter(
    (o) => !config.inputs.some((i) => dyn(i, o).enabled),
  );

  function setAlgorithm(patch: Partial<Algorithm>) {
    update((c) => ({ ...c, algorithm: { ...c.algorithm, ...patch } }));
  }
  const [layersText, setLayersText] = useState(config.algorithm.hiddenLayers.join(", "));

  // --- Train ---
  const ready =
    !!source &&
    !batchError &&
    config.inputs.length > 0 &&
    config.outputs.length > 0 &&
    config.batches.length > 0 &&
    unconnectedOutputs.length === 0;
  // --- Right-panel "Batches" tab: training batches and the batch shown in the results ---
  const resultBatches = useMemo(() => model.result?.outputs[0]?.series.map((s) => s.batch) ?? [], [model.result]);
  const [pickedBatch, setPickedBatch] = useState<string | null>(null);
  const shownBatch = pickedBatch !== null && resultBatches.includes(pickedBatch) ? pickedBatch : (resultBatches[0] ?? null);
  useEffect(() => {
    setInspector("batches", {
      owner: OWNER,
      title: "Batches",
      render: () => (
        <ModelBatchesPanel
          hasSource={!!source}
          batches={batches}
          batchError={batchError}
          selected={config.batches}
          onSelect={(keys) => update((c) => ({ ...c, batches: keys }))}
          testFraction={config.testFraction}
          onTestFraction={(testFraction) => update((c) => ({ ...c, testFraction }))}
          resultBatches={resultBatches}
          shownBatch={shownBatch}
          onShowBatch={setPickedBatch}
        />
      ),
    });
  });
  useEffect(() => () => clearInspector("batches", OWNER), []);

  async function train() {
    setTraining(true);
    setTrainError(null);
    try {
      await save();
      const m = await backend.modelTrain(model.id);
      setModel(m);
      onChanged(m);
    } catch (e) {
      setTrainError(errorMessage(e));
    } finally {
      setTraining(false);
    }
  }

  const pairs = config.inputs.length * config.outputs.length;

  return (
    <div className="model-editor">
      <div className="model-header">
        <input className="model-name" value={name} onChange={(e) => setName(e.target.value)} />
        <span className={saveError ? "error" : "muted"}>{saveError ?? ""}</span>
      </div>

      <Step n={1} title="Data" done={!!source && !batchError}>
        <div className="props-row model-row">
          <label>
            Table
            <select
              value={source?.tableId ?? ""}
              onChange={(e) => {
                const t = tables.find((t) => t.id === Number(e.target.value));
                update((c) => ({ ...c, source: t ? defaultSource(t) : null, inputs: [], outputs: [], dynamics: [], batches: [] }));
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
                    update((c) => ({
                      ...c,
                      batches: [],
                      source: { ...(c.source as PlotSource), batchColumn: e.target.value === "" ? null : Number(e.target.value) },
                    }))
                  }
                >
                  <option value="">None (whole table)</option>
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
                  onChange={(e) =>
                    update((c) => ({ ...c, batches: [], source: { ...(c.source as PlotSource), timeColumn: Number(e.target.value) } }))
                  }
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
        </div>
        {batchError && <p className="error">{batchError}</p>}
      </Step>

      <Step n={2} title="Inputs and outputs" done={config.inputs.length > 0 && config.outputs.length > 0}>
        {!table ? (
          <p className="muted">Choose a table first.</p>
        ) : (
          <>
            <div className="model-row">
              <input placeholder="Filter columns, e.g. TI-30" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="muted">
                {config.inputs.length} input(s), {config.outputs.length} output(s)
              </span>
            </div>
            <div className="role-list">
              {shown.map((c) => (
                <div key={c.index} className={`role-row ${role(c.index)}`}>
                  <span className="role-name">{c.name}</span>
                  <div className="segmented small">
                    {(["none", "input", "output"] as Role[]).map((r) => (
                      <button
                        key={r}
                        className={role(c.index) === r ? "active" : undefined}
                        onClick={() => setRole(c.index, r)}
                      >
                        {r === "none" ? "–" : r === "input" ? "Input" : "Output"}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Step>

      <Step n={3} title="Delay and smoothing (minutes)" done={pairs > 0 && unconnectedOutputs.length === 0}>
        {pairs === 0 ? (
          <p className="muted">Select inputs and outputs first.</p>
        ) : (
          <>
            <p className="muted">
              Each input is averaged with Gaussian weights centred at <i>t − delay</i> with spread <i>σ</i> (window ±3σ)
              before it is paired with the output at time <i>t</i>. σ = 0 uses the input value at <i>t − delay</i>.
              Untick a pair when the input cannot affect the output, e.g. because it is downstream of it in the
              process; the input is then not used for that output.
            </p>
            <div className="model-row">
              <span>Set all:</span>
              <label className="inline">
                delay
                <NumberField className="num" value={bulk.delay} onChange={(delay) => setBulk((b) => ({ ...b, delay }))} />
              </label>
              <label className="inline">
                σ
                <NumberField className="num" value={bulk.sigma} onChange={(sigma) => setBulk((b) => ({ ...b, sigma }))} />
              </label>
              <button
                onClick={() =>
                  update((c) => ({
                    ...c,
                    dynamics: c.dynamics.map((d) => (d.enabled ? { ...d, delayMin: bulk.delay, sigmaMin: bulk.sigma } : d)),
                  }))
                }
              >
                Apply to all connected
              </button>
            </div>
            <div className="dyn-scroll">
              <table className="grid dyn-table">
                <thead>
                  <tr>
                    <th>Input ↓ / Output →</th>
                    {config.outputs.map((o) => (
                      <th key={o}>{colName(o)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {config.inputs.map((i) => (
                    <tr key={i}>
                      <th>{colName(i)}</th>
                      {config.outputs.map((o) => {
                        const d = dyn(i, o);
                        return (
                          <td key={o} className={d.enabled ? undefined : "unconnected"}>
                            <div className="dyn-cell">
                              <input
                                type="checkbox"
                                checked={d.enabled}
                                title={d.enabled ? "Connected: untick if this input cannot affect this output" : "Not connected"}
                                onChange={(e) => setDyn(i, o, { enabled: e.target.checked })}
                              />
                              {d.enabled ? (
                                <>
                                  <label title="Delay (min)">
                                    τ
                                    <NumberField className="num" value={d.delayMin} onChange={(delayMin) => setDyn(i, o, { delayMin })} />
                                  </label>
                                  <label title="Gaussian spread σ (min)">
                                    σ
                                    <NumberField className="num" value={d.sigmaMin} onChange={(sigmaMin) => setDyn(i, o, { sigmaMin })} />
                                  </label>
                                </>
                              ) : (
                                <span className="muted">no effect</span>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {unconnectedOutputs.length > 0 && (
              <p className="error">
                No input is connected to {unconnectedOutputs.map(colName).join(", ")}. Connect at least one input per
                output.
              </p>
            )}
          </>
        )}
      </Step>

      <Step n={4} title="Model type" done>
        <div className="segmented">
          <button
            className={config.algorithm.kind === "linear" ? "active" : undefined}
            onClick={() => setAlgorithm({ kind: "linear" })}
          >
            Linear
          </button>
          <button
            className={config.algorithm.kind === "neuralNetwork" ? "active" : undefined}
            onClick={() => setAlgorithm({ kind: "neuralNetwork" })}
          >
            Neural network
          </button>
        </div>
        {config.algorithm.kind === "linear" ? (
          <p className="muted">Ordinary least squares: output = intercept + Σ slope × input feature.</p>
        ) : (
          <div className="props-row model-row">
            <label title="Neurons per hidden layer, comma separated, e.g. 32, 16">
              Hidden layers
              <input
                value={layersText}
                onChange={(e) => {
                  setLayersText(e.target.value);
                  const layers = e.target.value.split(/[,;\s]+/).filter(Boolean).map(Number);
                  if (layers.length > 0 && layers.length <= 5 && layers.every((n) => Number.isInteger(n) && n >= 1 && n <= 1024))
                    setAlgorithm({ hiddenLayers: layers });
                }}
              />
            </label>
            <label>
              Activation
              <select
                value={config.algorithm.activation}
                onChange={(e) => setAlgorithm({ activation: e.target.value as Algorithm["activation"] })}
              >
                <option value="relu">ReLU</option>
                <option value="tanh">tanh</option>
                <option value="logistic">Logistic</option>
              </select>
            </label>
            <label title="L2 regularisation; larger values give smoother models">
              Regularisation (α)
              <NumberField value={config.algorithm.alpha} onChange={(alpha) => setAlgorithm({ alpha })} />
            </label>
            <label>
              Max iterations
              <NumberField
                value={config.algorithm.maxIter}
                min={1}
                onChange={(maxIter) => setAlgorithm({ maxIter: Math.round(maxIter) })}
              />
            </label>
          </div>
        )}
      </Step>

      <Step n={5} title="Train" done={model.status === "trained" && !model.stale}>
        <div className="model-row">
          <button className="primary" disabled={!ready || training} onClick={train}>
            {training ? "Training…" : model.status === "trained" ? "Retrain model" : "Train model"}
          </button>
          <span className="muted">
            {config.batches.length} training batch(es){" "}
            <button className="link-button" onClick={() => showTool("batches")}>
              choose in Batches
            </button>
          </span>
          {!ready && <span className="muted">Complete steps 1–3 and select training batches to train.</span>}
          {model.trainedAt && (
            <span className="muted">Last trained {new Date(model.trainedAt).toLocaleString()}</span>
          )}
          {model.stale && model.result && <span className="warning">Settings changed since the last training.</span>}
        </div>
        {trainError && <p className="error">{trainError}</p>}
        {model.status === "failed" && model.error && <p className="error">Training failed: {model.error}</p>}
        {model.result && <ModelResults result={model.result} batch={shownBatch} />}
      </Step>
    </div>
  );
}
