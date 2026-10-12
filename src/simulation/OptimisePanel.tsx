import { useEffect, useMemo, useRef, useState } from "react";
import { AlignedData } from "uplot";
import {
  Goal,
  InputProfile,
  OptimisationResult,
  OptimisationSettings,
  OutputGoal,
  SimModel,
  SimulationResult,
} from "../api/backend";
import { NumberField } from "../models/ModelEditor";
import PlotChart from "../plots/PlotChart";

const BASELINE_COLOR = "#8a8a8a";
const OPTIMISED_COLOR = "#89d185";

const fmt = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "–" : Number(v.toPrecision(4)).toString();

/** Number field that may be empty (null), e.g. an optional limit. */
function OptionalNumber({ value, onChange, placeholder }: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value == null ? "" : String(value));
  }, [value]);
  return (
    <input
      className="num"
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(value == null ? "" : String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim().replace(",", ".");
        if (t === "") onChange(null);
        else if (Number.isFinite(Number(t))) onChange(Number(t));
      }}
    />
  );
}

interface Props {
  model: SimModel;
  settings: OptimisationSettings;
  profiles: InputProfile[];
  onChange: (fn: (s: OptimisationSettings) => OptimisationSettings) => void;
  canRun: boolean;
  running: boolean;
  onOptimise: () => void;
  onApply: () => void;
  result: OptimisationResult | null;
  error: string | null;
  optimisedAt: string | null;
  stale: boolean;
}

/** Simulation step "Optimise": manipulable inputs with bounds, output goals and limits, result. */
export default function OptimisePanel(props: Props) {
  const { model, settings, profiles, onChange, result } = props;

  const manip = (col: number) => settings.manipulable.find((m) => m.column === col);
  function setManipulable(col: number, on: boolean) {
    const v = model.inputs.find((x) => x.column === col)!;
    onChange((s) => {
      if (!on) return { ...s, manipulable: s.manipulable.filter((m) => m.column !== col) };
      // Default bounds: the measured range (the model is not trusted far outside it).
      const value = profiles.find((p) => p.column === col)?.value ?? 0;
      const min = v.min ?? value - 1;
      const max = v.max != null && v.max > min ? v.max : min + 1;
      return { ...s, manipulable: [...s.manipulable, { column: col, min, max }] };
    });
  }
  function setBound(col: number, patch: { min?: number; max?: number }) {
    onChange((s) => ({ ...s, manipulable: s.manipulable.map((m) => (m.column === col ? { ...m, ...patch } : m)) }));
  }

  const goalOf = (col: number): OutputGoal =>
    settings.outputs.find((g) => g.column === col) ?? {
      column: col,
      goal: null,
      target: 0,
      weight: 1,
      measure: "mean",
      min: null,
      max: null,
    };
  function setGoal(col: number, patch: Partial<OutputGoal>) {
    onChange((s) => {
      const next = { ...goalOf(col), ...patch };
      const exists = s.outputs.some((g) => g.column === col);
      return { ...s, outputs: exists ? s.outputs.map((g) => (g.column === col ? next : g)) : [...s.outputs, next] };
    });
  }

  const nManip = settings.manipulable.filter((m) => model.inputs.some((v) => v.column === m.column)).length;
  const nGoals = settings.outputs.filter((g) => g.goal && model.outputs.some((o) => o.column === g.column)).length;
  const badBounds = settings.manipulable.some((m) => !(m.min < m.max));
  const ready = props.canRun && nManip > 0 && nGoals > 0 && !badBounds;

  return (
    <>
      <p className="muted">
        The optimiser changes the manipulable inputs within their bounds: a fixed input's value, or the value at each
        of its setpoints (the times stay). It minimises the weighted sum of the output goals, each scaled by the
        output's measured range, and keeps outputs within their limits at all times where possible.
      </p>
      <table className="grid opt-table">
        <thead>
          <tr>
            <th>Input</th>
            <th>Manipulable</th>
            <th>Lower bound</th>
            <th>Upper bound</th>
            <th>Optimised</th>
          </tr>
        </thead>
        <tbody>
          {model.inputs.map((v) => {
            const m = manip(v.column);
            const p = profiles.find((x) => x.column === v.column);
            return (
              <tr key={v.column}>
                <th>{v.name}</th>
                <td>
                  <input type="checkbox" checked={!!m} onChange={(e) => setManipulable(v.column, e.target.checked)} />
                </td>
                <td>{m ? <NumberField className="num" min={-Infinity} value={m.min} onChange={(min) => setBound(v.column, { min })} /> : <span className="muted">–</span>}</td>
                <td>{m ? <NumberField className="num" min={-Infinity} value={m.max} onChange={(max) => setBound(v.column, { max })} /> : <span className="muted">–</span>}</td>
                <td className="muted">
                  {!m ? "kept as set" : p?.mode === "points" ? `${p.points.length} setpoint value(s)` : "fixed value"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {badBounds && <p className="error">Each lower bound must be below its upper bound.</p>}

      <table className="grid opt-table">
        <thead>
          <tr>
            <th>Output</th>
            <th>Goal</th>
            <th>Target</th>
            <th>Weight</th>
            <th>Measure</th>
            <th title="The output must stay at or above this value at all times">Lower limit</th>
            <th title="The output must stay at or below this value at all times">Upper limit</th>
          </tr>
        </thead>
        <tbody>
          {model.outputs.map((o) => {
            const g = goalOf(o.column);
            return (
              <tr key={o.column}>
                <th title={`measured ${fmt(o.min)} to ${fmt(o.max)}`}>{o.name}</th>
                <td>
                  <select value={g.goal ?? ""} onChange={(e) => setGoal(o.column, { goal: (e.target.value || null) as Goal | null })}>
                    <option value="">–</option>
                    <option value="minimise">Minimise</option>
                    <option value="maximise">Maximise</option>
                    <option value="target">Target</option>
                  </select>
                </td>
                <td>
                  {g.goal === "target" ? (
                    <NumberField className="num" min={-Infinity} value={g.target} onChange={(target) => setGoal(o.column, { target })} />
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
                <td>
                  {g.goal ? <NumberField className="num" value={g.weight} onChange={(weight) => setGoal(o.column, { weight })} /> : <span className="muted">–</span>}
                </td>
                <td>
                  {g.goal ? (
                    <select value={g.measure} onChange={(e) => setGoal(o.column, { measure: e.target.value as OutputGoal["measure"] })}>
                      <option value="mean">Mean</option>
                      <option value="end">At end</option>
                    </select>
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
                <td>
                  <OptionalNumber value={g.min} placeholder="none" onChange={(min) => setGoal(o.column, { min })} />
                </td>
                <td>
                  <OptionalNumber value={g.max} placeholder="none" onChange={(max) => setGoal(o.column, { max })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="model-row">
        <button className="primary" disabled={!ready || props.running} onClick={props.onOptimise}>
          {props.running ? "Optimising…" : "Optimise"}
        </button>
        <label className="inline" title="The optimiser stops after this time">
          Time limit (s)
          <NumberField
            className="num"
            min={1}
            value={settings.maxSeconds}
            onChange={(maxSeconds) => maxSeconds <= 600 && onChange((s) => ({ ...s, maxSeconds }))}
          />
        </label>
        {!ready && !props.running && (
          <span className="muted">Mark at least one input as manipulable and give at least one output a goal.</span>
        )}
        {props.running && <span className="muted">Up to {settings.maxSeconds} s.</span>}
        {props.optimisedAt && <span className="muted">Last optimised {new Date(props.optimisedAt).toLocaleString()}</span>}
        {props.stale && result && <span className="warning">Settings changed since the last optimisation.</span>}
      </div>
      {props.error && <p className="error">Optimisation failed: {props.error}</p>}
      {result && <OptimisationResults result={result} model={model} settings={settings} onApply={props.onApply} />}
    </>
  );
}

function OptimisationResults({ result, model, settings, onApply }: {
  result: OptimisationResult;
  model: SimModel;
  settings: OptimisationSettings;
  onApply: () => void;
}) {
  const manipulable = new Set(settings.manipulable.map((m) => m.column));
  const changed = model.inputs.filter((v) => manipulable.has(v.column) && result.profiles[String(v.column)]);
  const base = (col: number) => result.baseline.inputs.find((i) => i.column === col);
  return (
    <div className="model-results">
      {result.warnings.map((w, i) => (
        <p key={i} className="warning">
          {w}
        </p>
      ))}
      <p>
        Cost {fmt(result.baselineCost)} → <b>{fmt(result.cost)}</b> · output limits{" "}
        {result.limitsMet ? <span className="ok">met</span> : <span className="error">not met</span>}
        {!result.baselineLimitsMet && result.limitsMet && <span className="muted"> (not met before)</span>}
        <span className="muted">
          {" "}
          · {result.evaluations.toLocaleString()} model runs in {result.seconds} s
        </span>
      </p>
      <table className="grid opt-table">
        <thead>
          <tr>
            <th>Output goal</th>
            <th>Measure</th>
            <th>Current setpoints</th>
            <th>Optimised</th>
          </tr>
        </thead>
        <tbody>
          {result.objectives.map((o) => (
            <tr key={o.column}>
              <th>{o.name}</th>
              <td>{o.measure === "end" ? "at end" : "mean"}</td>
              <td className="num">{fmt(o.baseline)}</td>
              <td className="num">
                <b>{fmt(o.value)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="grid opt-table">
        <thead>
          <tr>
            <th>Input</th>
            <th>Current</th>
            <th>Optimised</th>
          </tr>
        </thead>
        <tbody>
          {changed.map((v) => {
            const p = result.profiles[String(v.column)];
            return (
              <tr key={v.column}>
                <th>{v.name}</th>
                <td className="num">{p.mode === "fixed" ? fmt(base(v.column)?.values[0]) : "setpoints"}</td>
                <td className="num">
                  {p.mode === "fixed" ? (
                    <b>{fmt(p.value)}</b>
                  ) : (
                    p.points.map((s, i) => (
                      <div key={i}>
                        {fmt(s.hours)} h: <b>{fmt(s.value)}</b>
                      </div>
                    ))
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="model-row">
        <button onClick={onApply}>Apply optimised setpoints and run</button>
        <span className="muted">Copies the optimised values into the input setpoints above.</span>
      </div>
      <ComparisonCharts baseline={result.baseline} optimised={result.optimised} columns={[...model.outputs.map((o) => o.column), ...changed.map((v) => v.column)]} />
    </div>
  );
}

/** Current vs optimised trajectory, for the outputs and the changed inputs. */
function ComparisonCharts({ baseline, optimised, columns }: {
  baseline: SimulationResult;
  optimised: SimulationResult;
  columns: number[];
}) {
  const charts = useMemo(() => {
    const find = (r: SimulationResult, col: number) => [...r.outputs, ...r.inputs].find((v) => v.column === col);
    return columns.flatMap((col) => {
      const b = find(baseline, col);
      const o = find(optimised, col);
      if (!b || !o) return [];
      const isOutput = optimised.outputs.some((v) => v.column === col);
      return [{ col, name: o.name, isOutput, data: [optimised.hours, b.values, o.values] as AlignedData }];
    });
  }, [baseline, optimised, columns]);
  return (
    <>
      {charts.map((c) => (
        <div key={c.col} className="output-panel">
          <div className="output-panel-header">
            <b>{c.name}</b>
            <span className="muted">{c.isOutput ? "predicted output" : "input setpoint"}</span>
          </div>
          <PlotChart
            data={c.data}
            height={c.isOutput ? 200 : 130}
            yMin={null}
            yMax={null}
            syncKey="dt-opt"
            xLabel="Time since simulation start (h)"
            lines={[
              { label: "Current", stroke: BASELINE_COLOR, dash: [6, 4] },
              { label: "Optimised", stroke: OPTIMISED_COLOR, dash: [] },
            ]}
          />
        </div>
      ))}
    </>
  );
}
