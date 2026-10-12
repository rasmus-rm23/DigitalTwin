import { useState } from "react";
import { backend, errorMessage, ProjectInfo } from "../api/backend";
import { createProjectWithDialog, openProjectWithDialog } from "../api/projectDialogs";
import * as session from "../workspace/session";

interface Props {
  onProjectOpened: (project: ProjectInfo) => void;
  initialError?: string | null;
}

/** Shown until the user creates or opens a project. */
export default function StartScreen({ onProjectOpened, initialError }: Props) {
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(session.recentProjects);

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

  async function openRecent(path: string) {
    await run(async () => {
      try {
        return await backend.projectOpen(path);
      } catch (e) {
        session.forgetProject(path);
        setRecent(session.recentProjects());
        throw e;
      }
    });
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
        {recent.length > 0 && (
          <div className="start-recent">
            <div className="start-recent-title">Recent</div>
            {recent.map((r) => (
              <button key={r.path} className="start-recent-item" disabled={busy} onClick={() => openRecent(r.path)} title={r.path}>
                <span>{r.name}</span>
                <span className="muted">{r.path}</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
