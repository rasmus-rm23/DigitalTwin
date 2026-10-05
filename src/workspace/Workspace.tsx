import { DockviewApi, DockviewReact, DockviewReadyEvent, themeDark } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useEffect, useRef, useState } from "react";
import { backend, errorMessage, ProjectInfo } from "../api/backend";
import { createProjectWithDialog, openProjectWithDialog } from "../api/projectDialogs";
import MenuBar, { Menu } from "./MenuBar";
import ToolPanel, { ToolPanelState, ToolWindow } from "./ToolPanel";
import { VIEW_COMPONENTS, VIEWS } from "./views";

interface Props {
  project: ProjectInfo;
  onProjectChange: (project: ProjectInfo | null) => void;
}

const LEFT_TOOLS: ToolWindow[] = [
  { id: "explorer", title: "Explorer", render: () => <p className="muted">Project items</p> },
  { id: "variables", title: "Variables", render: () => <p className="muted">Inputs and outputs</p> },
];

const RIGHT_TOOLS: ToolWindow[] = [
  { id: "properties", title: "Properties", render: () => <p className="muted">Selection properties</p> },
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
  const dockApi = useRef<DockviewApi | null>(null);

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
    api.addPanel({ id, component: id, title: view.title, params: { project } });
  }

  function onReady(event: DockviewReadyEvent) {
    dockApi.current = event.api;
    openView("overview");
  }

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

  const togglePanel = (side: "left" | "right") =>
    setPanels((p) => ({ ...p, [side]: { ...p[side], visible: !p[side].visible } }));

  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "New Project…", onClick: () => switchProject(createProjectWithDialog) },
        { label: "Open Project…", onClick: () => switchProject(openProjectWithDialog) },
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

  return (
    <div className="workspace">
      <MenuBar menus={menus} />
      <div className="workspace-body">
        <ToolPanel
          side="left"
          tools={LEFT_TOOLS}
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
          tools={RIGHT_TOOLS}
          state={panels.right}
          onChange={(right) => setPanels((p) => ({ ...p, right }))}
        />
      </div>
      <div className="statusbar">
        <span>{project.name}</span>
        <span className="statusbar-msg">{status}</span>
      </div>
    </div>
  );
}
