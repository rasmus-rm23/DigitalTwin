import { useState } from "react";
import { errorMessage, ProjectInfo } from "../api/backend";
import { createProjectWithDialog, openProjectWithDialog } from "../api/projectDialogs";

interface Props {
  onProjectOpened: (project: ProjectInfo) => void;
}

/** Shown until the user creates or opens a project. */
export default function StartScreen({ onProjectOpened }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<ProjectInfo | null>) {
    setError(null);
    setBusy(true);
    try {
      const project = await action();
      if (project) onProjectOpened(project);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="start-screen">
      <div className="start-card">
        <h1>DigitalTwin</h1>
        <p className="muted">Data-driven digital twins of chemical production processes.</p>
        <div className="start-actions">
          <button className="primary" disabled={busy} onClick={() => run(createProjectWithDialog)}>
            New project…
          </button>
          <button disabled={busy} onClick={() => run(openProjectWithDialog)}>
            Open project…
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
