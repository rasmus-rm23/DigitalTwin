import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { backend, errorMessage, Simulation, SimulationSummary } from "../api/backend";
import SimulationEditor from "./SimulationEditor";

/** The Simulation view: list of simulations on the left, the selected one's settings and results. */
export default function SimulationView() {
  const [sims, setSims] = useState<SimulationSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await backend.simulationsList();
      setSims(list);
      setSelected((s) => (s !== null && list.some((m) => m.id === s) ? s : (list[0]?.id ?? null)));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setSim(null);
    if (selected === null) return;
    backend
      .simulationGet(selected)
      .then(setSim)
      .catch((e) => setError(errorMessage(e)));
  }, [selected]);

  async function create() {
    try {
      const s = await backend.simulationCreate(`Simulation ${sims.length + 1}`);
      await refresh();
      setSelected(s.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove(s: SimulationSummary) {
    if (!(await ask(`Delete simulation "${s.name}"?`, { title: "Delete simulation", kind: "warning" }))) return;
    try {
      await backend.simulationDelete(s.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const onChanged = useCallback((s: Simulation) => {
    setSims((list) => list.map((x) => (x.id === s.id ? { ...x, name: s.name, runAt: s.runAt } : x)));
  }, []);

  return (
    <div className="models-view">
      <div className="models-list">
        <div className="explorer-section">
          <span>Simulations</span>
          <button className="icon" title="New simulation" onClick={create}>
            +
          </button>
        </div>
        <ul className="explorer-list">
          {sims.map((s) => (
            <li key={s.id} className={s.id === selected ? "active" : undefined}>
              <button className="explorer-item" onClick={() => setSelected(s.id)}>
                <span className={`status-dot ${s.runAt ? "trained" : "draft"}`} title={s.runAt ? "run" : "not run"} />
                {s.name}
              </button>
              <button className="icon" title="Delete simulation" onClick={() => remove(s)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        {sims.length === 0 && (
          <div className="models-empty">
            <p className="muted">No simulations yet.</p>
            <button className="primary" onClick={create}>
              New simulation
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="models-main">
        {sim ? (
          <SimulationEditor key={sim.id} initial={sim} onChanged={onChanged} />
        ) : (
          <div className="view-placeholder">
            {selected === null ? "Create a simulation to run what-if scenarios with a trained model." : "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}
