import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { DockviewApi, DockviewReact, DockviewReadyEvent, themeDark } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { backend, errorMessage, IMPORT_EXTENSIONS, ImportResult, ProjectInfo, TableInfo } from "../api/backend";
import { createProjectWithDialog, openProjectWithDialog } from "../api/projectDialogs";
import ImportDialog from "../import/ImportDialog";
import ExplorerTool from "./ExplorerTool";
import { InspectorSlot, setActiveOwner, useInspector, useInspectorSlots } from "./inspector";
import * as session from "./session";
import MenuBar, { Menu } from "./MenuBar";
import ToolPanel, { ToolPanelState, ToolWindow } from "./ToolPanel";
import { VIEW_COMPONENTS, VIEWS } from "./views";
import { WorkspaceContext, WorkspaceData } from "./WorkspaceContext";

interface Props {
  project: ProjectInfo;
  onProjectChange: (project: ProjectInfo | null) => void;
}

/** Shows whatever the active view published for this slot. */
function InspectorTool({ slot }: { slot: InspectorSlot }) {
  const content = useInspector(slot);
  return content ? <>{content.render()}</> : null;
}

/** Right tool windows. Those with a slot are only shown while the active view fills it. */
const RIGHT_TOOLS: (ToolWindow & { slot?: InspectorSlot })[] = [
  { id: "properties", title: "Properties", slot: "properties", render: () => <InspectorTool slot="properties" /> },
  { id: "batches", title: "Batches", slot: "batches", render: () => <InspectorTool slot="batches" /> },
  { id: "plot", title: "Plot", slot: "plot", render: () => <InspectorTool slot="plot" /> },
  { id: "jobs", title: "Jobs", render: () => <p className="muted">Training and optimisation jobs</p> },
];

const LAYOUT_KEY = "digitaltwin.panels";
const DEFAULT_PANELS: Record<"left" | "right", ToolPanelState> = {
  left: { visible: true, collapsed: false, activeTool: "explorer", width: 260 },
  right: { visible: true, collapsed: false, activeTool: "properties", width: 280 },
};

function loadPanels() {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) return { ...DEFAULT_PANELS, ...JSON.parse(saved) } as typeof DEFAULT_PANELS;
  } catch {
    // Ignore unreadable layout and fall back to defaults.
  }
  return DEFAULT_PANELS;
}

export default function Workspace({ project, onProjectChange }: Props) {
  const [panels, setPanels] = useState(loadPanels);
  const [status, setStatus] = useState("");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const dockApi = useRef<DockviewApi | null>(null);

  const refreshTables = useCallback(() => {
    backend
      .tablesList()
      .then((t) => {
        setTables(t);
        setTablesLoaded(true);
      })
      .catch((e) => setStatus(errorMessage(e)));
  }, []);

  useEffect(refreshTables, [refreshTables, project.path]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(panels));
    } catch {
      // Layout persistence is a convenience only.
    }
  }, [panels]);

  function openView(id: string) {
    const api = dockApi.current;
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const view = VIEWS.find((v) => v.id === id)!;
    api.addPanel({ id, component: id, title: view.title });
  }

  function openTable(table: TableInfo) {
    const api = dockApi.current;
    if (!api) return;
    const id = `table:${table.id}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({ id, component: "table", title: table.name, params: { tableId: table.id } });
  }

  // Tabs restored from the saved layout may point at tables that were deleted since.
  useEffect(() => {
    const api = dockApi.current;
    if (!api || !tablesLoaded) return;
    for (const panel of api.panels) {
      const m = panel.id.match(/^table:(\d+)$/);
      if (m && !tables.some((t) => t.id === Number(m[1]))) panel.api.close();
    }
  }, [tables, tablesLoaded]);

  async function startImport() {
    const path = await open({
      title: "Import data",
      multiple: false,
      directory: false,
      filters: [{ name: "CSV or spreadsheet", extensions: IMPORT_EXTENSIONS }],
    });
    if (path) setImportPath(path);
  }

  async function onImported(result: ImportResult) {
    setImportPath(null);
    refreshTables();
    openTable(result.table);
    setStatus(`Imported ${result.table.rowCount.toLocaleString()} rows into "${result.table.name}"`);
    if (result.warnings.length > 0) {
      await message(result.warnings.join("\n\n"), { title: "Import warnings", kind: "warning" });
    }
  }

  async function deleteTable(table: TableInfo) {
    const ok = await ask(`Delete table "${table.name}"? This cannot be undone.`, {
      title: "Delete table",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await backend.tableDelete(table.id);
      dockApi.current?.getPanel(`table:${table.id}`)?.api.close();
      refreshTables();
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }

  const leftTools: ToolWindow[] = [
    {
      id: "explorer",
      title: "Explorer",
      render: () => (
        <ExplorerTool tables={tables} onImport={startImport} onOpenTable={openTable} onDeleteTable={deleteTable} />
      ),
    },
    { id: "variables", title: "Variables", render: () => <p className="muted">Inputs and outputs</p> },
  ];

  // Restore this project's tabs from the last session and save them on every layout change.
  function onReady(event: DockviewReadyEvent) {
    const api = event.api;
    dockApi.current = api;
    const saved = session.loadLayout(project.path);
    let restored = false;
    if (saved) {
      try {
        api.fromJSON(saved);
        restored = true;
      } catch {
        api.clear(); // unreadable or outdated layout: start fresh
      }
    }
    if (!restored) openView("overview");
    setActiveOwner(api.activePanel?.id ?? null);
    api.onDidActivePanelChange((e) => setActiveOwner(e.panel?.id ?? null));
    api.onDidLayoutChange(() => session.saveLayout(project.path, api.toJSON()));
  }
  useEffect(() => () => setActiveOwner(null), []);

  async function switchProject(action: () => Promise<ProjectInfo | null>) {
    try {
      const next = await action();
      if (next) onProjectChange(next);
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }

  async function closeProject() {
    await backend.projectClose();
    onProjectChange(null);
  }

  /** Brings a tool window to the front, showing and expanding its panel if needed. */
  const showTool = useCallback((id: string) => {
    const side = RIGHT_TOOLS.some((t) => t.id === id) ? "right" : "left";
    setPanels((p) => ({ ...p, [side]: { ...p[side], visible: true, collapsed: false, activeTool: id } }));
  }, []);

  const togglePanel = (side: "left" | "right") =>
    setPanels((p) => ({ ...p, [side]: { ...p[side], visible: !p[side].visible } }));

  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "New Project…", onClick: () => switchProject(createProjectWithDialog) },
        { label: "Open Project…", onClick: () => switchProject(openProjectWithDialog) },
        { label: "", separator: true },
        { label: "Import Data…", onClick: startImport },
        { label: "", separator: true },
        { label: "Close Project", onClick: closeProject },
      ],
    },
    {
      label: "View",
      items: [
        ...VIEWS.map((v) => ({ label: v.title, onClick: () => openView(v.id) })),
        { label: "", separator: true },
        { label: "Left Panel", checked: panels.left.visible, onClick: () => togglePanel("left") },
        { label: "Right Panel", checked: panels.right.visible, onClick: () => togglePanel("right") },
      ],
    },
  ];

  const slots = useInspectorSlots();
  const rightTools = RIGHT_TOOLS.filter((t) => !t.slot || slots.has(t.slot));

  const workspaceData: WorkspaceData ={ project, tables, tablesLoaded, refreshTables, openTable, showTool };

  return (
    <WorkspaceContext.Provider value={workspaceData}>
      <div className="workspace">
        <MenuBar menus={menus} />
        <div className="workspace-body">
          <ToolPanel
            side="left"
            tools={leftTools}
            state={panels.left}
            onChange={(left) => setPanels((p) => ({ ...p, left }))}
          />
          <div className="workspace-main">
            {/* Remount the dock when the project changes so views get fresh params. */}
            <DockviewReact
              key={project.path}
              components={VIEW_COMPONENTS}
              onReady={onReady}
              theme={themeDark}
            />
          </div>
          <ToolPanel
            side="right"
            tools={rightTools}
            state={panels.right}
            onChange={(right) => setPanels((p) => ({ ...p, right }))}
          />
        </div>
        {importPath && (
          <ImportDialog path={importPath} onClose={() => setImportPath(null)} onImported={onImported} />
        )}
        <div className="statusbar">
          <span>{project.name}</span>
          <span className="statusbar-msg">{status}</span>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
