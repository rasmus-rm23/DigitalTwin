import { createContext, useContext } from "react";
import { ProjectInfo, TableInfo } from "../api/backend";

/** Project-wide data shared by views and tool windows. Domain state still comes from the core. */
export interface WorkspaceData {
  project: ProjectInfo;
  tables: TableInfo[];
  /** False until the first table list has arrived (so `tables` being empty means "none"). */
  tablesLoaded: boolean;
  refreshTables: () => void;
  openTable: (table: TableInfo) => void;
  /** Brings a tool window (e.g. "plot", "batches") to the front. */
  showTool: (id: string) => void;
}

export const WorkspaceContext = createContext<WorkspaceData | null>(null);

export function useWorkspace(): WorkspaceData {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <Workspace>");
  return ctx;
}
