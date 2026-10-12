import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { backend, errorMessage, Model, ModelSummary } from "../api/backend";
import ModelEditor from "./ModelEditor";

/** The Models view: list of models on the left, the selected model's definition and results. */
export default function ModelsView() {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await backend.modelsList();
      setModels(list);
      setSelected((s) => (s !== null && list.some((m) => m.id === s) ? s : (list[0]?.id ?? null)));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setModel(null);
    if (selected === null) return;
    backend
      .modelGet(selected)
      .then(setModel)
      .catch((e) => setError(errorMessage(e)));
  }, [selected]);

  async function create() {
    try {
      const m = await backend.modelCreate(`Model ${models.length + 1}`);
      await refresh();
      setSelected(m.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove(m: ModelSummary) {
    if (!(await ask(`Delete model "${m.name}"? This cannot be undone.`, { title: "Delete model", kind: "warning" })))
      return;
    try {
      await backend.modelDelete(m.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // Keep the list in step with name/status changes made in the editor.
  const onChanged = useCallback((m: Model) => {
    setModels((list) =>
      list.map((s) => (s.id === m.id ? { ...s, name: m.name, status: m.status, trainedAt: m.trainedAt } : s)),
    );
  }, []);

  return (
    <div className="models-view">
      <div className="models-list">
        <div className="explorer-section">
          <span>Models</span>
          <button className="icon" title="New model" onClick={create}>
            +
          </button>
        </div>
        <ul className="explorer-list">
          {models.map((m) => (
            <li key={m.id} className={m.id === selected ? "active" : undefined}>
              <button className="explorer-item" onClick={() => setSelected(m.id)}>
                <span className={`status-dot ${m.status}`} title={m.status} />
                {m.name}
              </button>
              <button className="icon" title="Delete model" onClick={() => remove(m)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        {models.length === 0 && (
          <div className="models-empty">
            <p className="muted">No models yet.</p>
            <button className="primary" onClick={create}>
              New model
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="models-main">
        {model ? (
          <ModelEditor key={model.id} initial={model} onChanged={onChanged} />
        ) : (
          <div className="view-placeholder">{selected === null ? "Create a model to start." : "Loading…"}</div>
        )}
      </div>
    </div>
  );
}
