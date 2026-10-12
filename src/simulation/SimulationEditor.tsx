import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlignedData } from "uplot";
import {
  backend,
  errorMessage,
  InputProfile,
  ModelSummary,
  SetPoint,
  SimVariable,
  Simulation,
  SimulationConfig,
  SimulationResult,
} from "../api/backend";
import { NumberField, Step } from "../models/ModelEditor";
import PlotChart from "../plots/PlotChart";
import OptimisePanel from "./OptimisePanel";

const SAVE_DELAY_MS = 500;
const TAB_KEY = "digitaltwin.simulationTab";
type Tab = "simulate" | "optimise";

function loadTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === "optimise" ? "optimise" : "simulate";
  } catch {
    return "simulate";
  }
}
const X_LABEL = "Time since simulation start (h)";
const OUTPUT_COLOR = "#4fc1ff";
const INPUT_COLOR = "#f2a33a";

interface Props {
  initial: Simulation;
  onChanged: (s: Simulation) => void;
}

const fmt = (v: number | null) => (v == null ? "–" : Number(v.toPrecision(4)).toString());

/** Setpoint value at `h`: linear between points, held outside (mirror of the sidecar's profile_values). */
export function profileAt(points: SetPoint[], h: number): number {
  const sorted = [...points].sort((a, b) => a.hours - b.hours);
  let i = -1;
  while (i + 1 < sorted.length && sorted[i + 1].hours <= h) i++;
  if (i < 0) return sorted[0].value;
  if (i >= sorted.length - 1) return sorted[sorted.length - 1].value;
  const a = sorted[i];
  const b = sorted[i + 1];
  return a.value + ((h - a.hours) / (b.hours - a.hours)) * (b.value - a.value);
}

/** Fixed at the measured mean (4 significant digits). */
function defaultProfile(v: SimVariable): InputProfile {
  return { column: v.column, mode: "fixed", value: v.mean == null ? 0 : Number(v.mean.toPrecision(4)), points: [] };
}

export default function SimulationEditor({ initial, onChanged }: Props) {
  const [sim, setSim] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [config, setConfig] = useState(initial.config);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [tab, setTabState] = useState<Tab>(loadTab);
  function setTab(t: Tab) {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Remembering the tab is a convenience only.
    }
  }

  useEffect(() => {
    backend.modelsList().then(setModels).catch((e) => setSaveError(errorMessage(e)));
  }, []);

  const update = useCallback((fn: (c: SimulationConfig) => SimulationConfig) => setConfig((c) => fn(c)), []);

  // --- Autosave (debounced); the core's answer brings the model's inputs and staleness ---
  const lastSaved = useRef(JSON.stringify({ name: initial.name, config: initial.config }));
  /** Saves the current settings, or `next` when given (state may not have caught up yet). */
  const save = useCallback(async (next?: SimulationConfig) => {
    const cfg = next ?? config;
    const json = JSON.stringify({ name, config: cfg });
    if (json === lastSaved.current || !name.trim()) return;
    try {
      const s = await backend.simulationSave(sim.id, name, cfg);
      lastSaved.current = json;
      setSim(s);
      onChanged(s);
      setSaveError(null);
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  }, [name, config, sim.id, onChanged]);

  useEffect(() => {
    const t = setTimeout(() => save(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [save]);

  // One profile per input of the chosen model: new inputs start fixed at their mean.
  const model = sim.model && sim.model.id === config.modelId ? sim.model : null;
  const modelInputs = model?.inputs ?? [];
  const inputsKey = modelInputs.map((v) => v.column).join(",");
  useEffect(() => {
    if (!model) return;
    update((c) => {
      const existing = new Map(c.inputs.map((p) => [p.column, p]));
      const inputs = model.inputs.map((v) => existing.get(v.column) ?? defaultProfile(v));
      return JSON.stringify(inputs) === JSON.stringify(c.inputs) ? c : { ...c, inputs };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id, inputsKey, update]);

  function setProfile(column: number, patch: Partial<InputProfile>) {
    update((c) => ({ ...c, inputs: c.inputs.map((p) => (p.column === column ? { ...p, ...patch } : p)) }));
  }

  // --- Run ---
  const pointsMissing = config.inputs.some((p) => p.mode === "points" && p.points.length === 0);
  const ready = !!model?.trained && config.inputs.length === modelInputs.length && !pointsMissing;
  async function run(next?: SimulationConfig) {
    setRunning(true);
    setRunError(null);
    try {
      await save(next);
      const s = await backend.simulationRun(sim.id);
      setSim(s);
      onChanged(s);
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  // --- Optimise ---
  const [optimising, setOptimising] = useState(false);
  const [optimiseError, setOptimiseError] = useState<string | null>(null);
  async function optimise() {
    setOptimising(true);
    setOptimiseError(null);
    try {
      await save();
      const s = await backend.simulationOptimise(sim.id);
      setSim(s);
      onChanged(s);
    } catch (e) {
      setOptimiseError(errorMessage(e));
    } finally {
      setOptimising(false);
    }
  }
  /** Copies the optimised values of the manipulable inputs into the setpoints, then runs. */
  function applyOptimised() {
    const opt = sim.optimisation;
    if (!opt) return;
    const manipulable = new Set(config.optimisation.manipulable.map((m) => m.column));
    const next = {
      ...config,
      inputs: config.inputs.map((p) => {
        const o = opt.profiles[String(p.column)];
        return manipulable.has(p.column) && o ? { ...o, column: p.column } : p;
      }),
    };
    setConfig(next);
    setTab("simulate"); // show the new run
    void run(next);
  }

  return (
    <div className="model-editor">
      <div className="model-header">
        <input className="model-name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="segmented" role="tablist">
          <button className={tab === "simulate" ? "active" : undefined} onClick={() => setTab("simulate")}>
            Simulate
          </button>
          <button className={tab === "optimise" ? "active" : undefined} onClick={() => setTab("optimise")}>
            Optimise
          </button>
        </div>
        <span className={saveError ? "error" : "muted"}>{saveError ?? ""}</span>
      </div>

      {tab === "simulate" ? (
        <>
          <Step n={1} title="Model" done={!!model?.trained}>
            <div className="props-row model-row">
              <label>
                Model
                <select
                  value={config.modelId ?? ""}
                  onChange={(e) =>
                    update((c) => ({ ...c, modelId: e.target.value === "" ? null : Number(e.target.value), inputs: [] }))
                  }
                >
                  <option value="">Choose a model…</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.trainedAt ? "" : " (not trained)"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {model && !model.trained && <p className="error">This model has not been trained yet. Train it in the Models view.</p>}
            {model?.modelStale && (
              <p className="warning">
                The model's definition changed since it was trained; the trained version is simulated.
              </p>
            )}
            {model?.trained && (
              <p className="muted">
                Outputs: {model.outputs.map((o) => o.name).join(", ")}. Trained{" "}
                {model.trainedAt ? new Date(model.trainedAt).toLocaleString() : ""}.
              </p>
            )}
          </Step>

          <Step n={2} title="Simulation time" done>
            <div className="props-row model-row">
              <label>
                Duration (h)
                <NumberField value={config.durationH} onChange={(durationH) => durationH > 0 && update((c) => ({ ...c, durationH }))} />
              </label>
              <label title="Time between simulated points">
                Time step (min)
                <NumberField value={config.stepMin} onChange={(stepMin) => stepMin > 0 && update((c) => ({ ...c, stepMin }))} />
              </label>
            </div>
          </Step>

          <Step n={3} title="Input setpoints" done={!!model && config.inputs.length > 0 && !pointsMissing}>
            {!model ? (
              <p className="muted">Choose a model first.</p>
            ) : (
              <>
                <p className="muted">
                  Each input is either fixed, or follows setpoints at given times: linear in between, held before the first
                  and after the last. Two setpoints at the same time give a step. Before t = 0 the inputs are held at their
                  t = 0 value.
                </p>
                {modelInputs.map((v) => {
                  const p = config.inputs.find((x) => x.column === v.column);
                  return p ? (
                    <InputEditor
                      key={v.column}
                      variable={v}
                      profile={p}
                      durationH={config.durationH}
                      onChange={(patch) => setProfile(v.column, patch)}
                    />
                  ) : null;
                })}
              </>
            )}
          </Step>

          <Step n={4} title="Run" done={!!sim.result && !sim.stale}>
            <div className="model-row">
              <button className="primary" disabled={!ready || running} onClick={() => run()}>
                {running ? "Running…" : sim.result ? "Run again" : "Run simulation"}
              </button>
              {!ready && <span className="muted">Choose a trained model and give every setpoint input at least one point.</span>}
              {sim.runAt && <span className="muted">Last run {new Date(sim.runAt).toLocaleString()}</span>}
              {sim.stale && <span className="warning">Settings or model changed since the last run.</span>}
            </div>
            {runError && <p className="error">{runError}</p>}
            {sim.error && <p className="error">Simulation failed: {sim.error}</p>}
            {sim.result && <SimulationResults result={sim.result} />}
          </Step>
        </>
      ) : (
        <Step n={1} title="Optimise manipulable inputs" done={!!sim.optimisation && !sim.optimisationStale}>
          {!model?.trained ? (
            <p className="muted">Choose a trained model in the Simulate tab first.</p>
          ) : !ready ? (
            <p className="muted">
              Complete the simulation settings in the Simulate tab first; the optimiser starts from those setpoints.
            </p>
          ) : (
            <>
              {optimiseError && <p className="error">{optimiseError}</p>}
              <OptimisePanel
                model={model}
                settings={config.optimisation}
                profiles={config.inputs}
                onChange={(fn) => update((c) => ({ ...c, optimisation: fn(c.optimisation) }))}
                canRun={ready}
                running={optimising}
                onOptimise={optimise}
                onApply={applyOptimised}
                result={sim.optimisation}
                error={sim.optimisationError}
                optimisedAt={sim.optimisedAt}
                stale={sim.optimisationStale}
              />
            </>
          )}
        </Step>
      )}
    </div>
  );
}

function InputEditor({
  variable,
  profile,
  durationH,
  onChange,
}: {
  variable: SimVariable;
  profile: InputProfile;
  durationH: number;
  onChange: (patch: Partial<InputProfile>) => void;
}) {
  const points = profile.points;
  function setPoint(i: number, patch: Partial<SetPoint>) {
    onChange({ points: points.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  }
  function addPoint() {
    const last = [...points].sort((a, b) => a.hours - b.hours).at(-1);
    const hours = last ? Math.min(last.hours + Math.max(durationH / 4, 0.5), durationH) : 0;
    onChange({ points: [...points, { hours: Number(hours.toPrecision(4)), value: last?.value ?? profile.value }] });
  }

  // Preview of the trajectory over the simulation time.
  const preview = useMemo<AlignedData | null>(() => {
    if (profile.mode !== "points" || points.length === 0) return null;
    const inside = [...points].filter((p) => p.hours > 0 && p.hours < durationH).sort((a, b) => a.hours - b.hours);
    const xs = [0, ...inside.map((p) => p.hours), durationH];
    const ys = [profileAt(points, 0), ...inside.map((p) => p.value), profileAt(points, durationH)];
    return [xs, ys] as AlignedData;
  }, [profile.mode, points, durationH]);

  const outside = (v: number) =>
    (variable.min != null && v < variable.min) || (variable.max != null && v > variable.max);

  return (
    <div className="sim-input">
      <div className="sim-input-header">
        <b>{variable.name}</b>
        <span className="muted">
          measured {fmt(variable.min)} to {fmt(variable.max)}, mean {fmt(variable.mean)}
        </span>
        <div className="segmented small">
          <button
            className={profile.mode === "fixed" ? "active" : undefined}
            onClick={() => onChange({ mode: "fixed" })}
          >
            Fixed
          </button>
          <button
            className={profile.mode === "points" ? "active" : undefined}
            onClick={() =>
              onChange({
                mode: "points",
                points: points.length > 0 ? points : [{ hours: 0, value: profile.value }],
              })
            }
          >
            Setpoints over time
          </button>
        </div>
      </div>
      {profile.mode === "fixed" ? (
        <label className="inline">
          Value
          <NumberField
            className={`num${outside(profile.value) ? " out-of-range" : ""}`}
            min={-Infinity}
            value={profile.value}
            onChange={(value) => onChange({ value })}
          />
        </label>
      ) : (
        <div className="sim-points">
          <table className="grid">
            <thead>
              <tr>
                <th>Time (h)</th>
                <th>Setpoint</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td>
                    <NumberField className="num" value={p.hours} onChange={(hours) => setPoint(i, { hours })} />
                  </td>
                  <td>
                    <NumberField
                      className={`num${outside(p.value) ? " out-of-range" : ""}`}
                      min={-Infinity}
                      value={p.value}
                      onChange={(value) => setPoint(i, { value })}
                    />
                  </td>
                  <td>
                    <button
                      className="icon"
                      title="Remove setpoint"
                      onClick={() => onChange({ points: points.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sim-points-side">
            <button onClick={addPoint}>Add setpoint</button>
            {points.length === 0 && <p className="error">Add at least one setpoint.</p>}
            {preview && (
              <PlotChart
                data={preview}
                height={120}
                yMin={null}
                yMax={null}
                syncKey="dt-sim-preview"
                xLabel={X_LABEL}
                lines={[{ label: variable.name, stroke: INPUT_COLOR, dash: [] }]}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SimulationResults({ result }: { result: SimulationResult }) {
  const charts = useMemo(
    () => [
      ...result.outputs.map((o) => ({ key: `o${o.column}`, title: o.name, kind: "Predicted", values: o.values, color: OUTPUT_COLOR, height: 220 })),
      ...result.inputs.map((i) => ({ key: `i${i.column}`, title: i.name, kind: "Setpoint", values: i.values, color: INPUT_COLOR, height: 140 })),
    ],
    [result],
  );
  return (
    <div className="model-results">
      {result.warnings.map((w, i) => (
        <p key={i} className="warning">
          {w}
        </p>
      ))}
      {charts.map((c) => (
        <div key={c.key} className="output-panel">
          <div className="output-panel-header">
            <b>{c.title}</b>
            <span className="muted">{c.kind === "Predicted" ? "predicted output" : "input setpoint"}</span>
          </div>
          <PlotChart
            data={[result.hours, c.values] as AlignedData}
            height={c.height}
            yMin={null}
            yMax={null}
            syncKey="dt-sim"
            xLabel={X_LABEL}
            lines={[{ label: c.kind, stroke: c.color, dash: [] }]}
          />
        </div>
      ))}
    </div>
  );
}
