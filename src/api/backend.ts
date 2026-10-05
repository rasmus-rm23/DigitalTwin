// Typed wrappers over Tauri commands. Keep in sync with src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  path: string;
  name: string;
  createdAt: string;
  schemaVersion: number;
}

export interface AppError {
  kind: "db" | "io" | "json" | "noProject" | "invalidInput" | "sidecar";
  message: string;
}

export interface SidecarPing {
  status: string;
  version: string;
  python: string;
}

/** File extension for project files (SQLite inside). */
export const PROJECT_EXTENSION = "dtwin";

export const backend = {
  projectCreate: (path: string, name: string) =>
    invoke<ProjectInfo>("project_create", { path, name }),
  projectOpen: (path: string) => invoke<ProjectInfo>("project_open", { path }),
  projectClose: () => invoke<void>("project_close"),
  projectCurrent: () => invoke<ProjectInfo | null>("project_current"),
  sidecarPing: () => invoke<SidecarPing>("sidecar_ping"),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) return String(e.message);
  return String(e);
}
