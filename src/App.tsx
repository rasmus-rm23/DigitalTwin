import { useEffect, useState } from "react";
import { backend, ProjectInfo } from "./api/backend";
import StartScreen from "./start/StartScreen";
import Workspace from "./workspace/Workspace";
import "./styles.css";

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // The core owns the open project; pick it up after a frontend reload.
  useEffect(() => {
    backend
      .projectCurrent()
      .then(setProject)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  return project ? (
    <Workspace project={project} onProjectChange={setProject} />
  ) : (
    <StartScreen onProjectOpened={setProject} />
  );
}
