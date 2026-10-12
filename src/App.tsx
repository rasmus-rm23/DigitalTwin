import { useEffect, useState } from "react";
import { backend, errorMessage, ProjectInfo } from "./api/backend";
import StartScreen from "./start/StartScreen";
import * as session from "./workspace/session";
import Workspace from "./workspace/Workspace";
import "./styles.css";

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);

  function changeProject(next: ProjectInfo | null) {
    if (next) session.projectOpened(next);
    else session.projectClosed();
    setProject(next);
  }

  // Resume: the core may still hold a project (frontend reload); otherwise reopen the project
  // that was open when the app last closed.
  useEffect(() => {
    (async () => {
      try {
        let current = await backend.projectCurrent();
        const last = session.lastProjectPath();
        if (!current && last) {
          try {
            current = await backend.projectOpen(last);
          } catch (e) {
            session.forgetProject(last);
            setStartError(`Could not reopen ${last}: ${errorMessage(e)}`);
          }
        }
        if (current) changeProject(current);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return null;

  return project ? (
    <Workspace project={project} onProjectChange={changeProject} />
  ) : (
    <StartScreen onProjectOpened={changeProject} initialError={startError} />
  );
}
