// Per-user session state kept in the webview's local storage, so the app can resume
// where it was left: the last open project, recent projects, and each project's open tabs.
// View state only; nothing here is needed to read a project.
import { SerializedDockview } from "dockview-react";
import { ProjectInfo } from "../api/backend";

const LAST_PROJECT = "digitaltwin.lastProject";
const RECENT = "digitaltwin.recentProjects";
const LAYOUT_PREFIX = "digitaltwin.layout:";
const MAX_RECENT = 10;

export interface RecentProject {
  path: string;
  name: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Session state is a convenience; ignore storage failures.
  }
}

/** Project paths compare case-insensitively on Windows. */
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Project that was open when the app last closed (null if the user closed it first). */
export function lastProjectPath(): string | null {
  return read<string>(LAST_PROJECT);
}

export function recentProjects(): RecentProject[] {
  return read<RecentProject[]>(RECENT) ?? [];
}

export function projectOpened(project: ProjectInfo) {
  write(LAST_PROJECT, project.path);
  const rest = recentProjects().filter((r) => !samePath(r.path, project.path));
  write(RECENT, [{ path: project.path, name: project.name }, ...rest].slice(0, MAX_RECENT));
}

/** The user closed the project: start on the start screen next time. */
export function projectClosed() {
  write(LAST_PROJECT, null);
}

/** A project file could not be opened (moved or deleted): forget it. */
export function forgetProject(path: string) {
  if (lastProjectPath() && samePath(lastProjectPath()!, path)) write(LAST_PROJECT, null);
  write(
    RECENT,
    recentProjects().filter((r) => !samePath(r.path, path)),
  );
}

export function loadLayout(projectPath: string): SerializedDockview | null {
  return read<SerializedDockview>(LAYOUT_PREFIX + projectPath.toLowerCase());
}

export function saveLayout(projectPath: string, layout: SerializedDockview) {
  write(LAYOUT_PREFIX + projectPath.toLowerCase(), layout);
}
