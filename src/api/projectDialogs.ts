import { open, save } from "@tauri-apps/plugin-dialog";
import { backend, PROJECT_EXTENSION, ProjectInfo } from "./backend";

const filters = [{ name: "DigitalTwin project", extensions: [PROJECT_EXTENSION] }];

/** Returns the new project, or null if the user cancelled. */
export async function createProjectWithDialog(): Promise<ProjectInfo | null> {
  const path = await save({ title: "Create project", filters, defaultPath: `New project.${PROJECT_EXTENSION}` });
  if (!path) return null;
  const name = path.split(/[\\/]/).pop()!.replace(new RegExp(`\\.${PROJECT_EXTENSION}$`), "");
  return backend.projectCreate(path, name);
}

/** Returns the opened project, or null if the user cancelled. */
export async function openProjectWithDialog(): Promise<ProjectInfo | null> {
  const path = await open({ title: "Open project", filters, multiple: false, directory: false });
  if (!path) return null;
  return backend.projectOpen(path);
}
