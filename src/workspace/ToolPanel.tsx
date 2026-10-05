import { ReactNode, useRef } from "react";

export interface ToolWindow {
  id: string;
  title: string;
  render: () => ReactNode;
}

export interface ToolPanelState {
  visible: boolean;
  collapsed: boolean;
  activeTool: string;
  width: number;
}

interface Props {
  side: "left" | "right";
  tools: ToolWindow[];
  state: ToolPanelState;
  onChange: (state: ToolPanelState) => void;
}

const MIN_WIDTH = 160;
const MAX_WIDTH = 600;

/**
 * A side panel of tabbed tool windows. Hidden panels render nothing; collapsed
 * panels shrink to a strip of vertical tabs; clicking the active tab collapses it.
 */
export default function ToolPanel({ side, tools, state, onChange }: Props) {
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  if (!state.visible) return null;

  const active = tools.find((t) => t.id === state.activeTool) ?? tools[0];

  function selectTab(id: string) {
    if (id === active.id && !state.collapsed) onChange({ ...state, collapsed: true });
    else onChange({ ...state, activeTool: id, collapsed: false });
  }

  function startResize(e: React.PointerEvent) {
    dragStart.current = { x: e.clientX, width: state.width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function resize(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const delta = e.clientX - dragStart.current.x;
    const width = dragStart.current.width + (side === "left" ? delta : -delta);
    onChange({ ...state, width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)) });
  }

  const tabs = (
    <div className="toolpanel-tabs">
      {tools.map((t) => (
        <button
          key={t.id}
          className={`toolpanel-tab${t.id === active.id && !state.collapsed ? " active" : ""}`}
          onClick={() => selectTab(t.id)}
          title={t.title}
        >
          {t.title}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`toolpanel toolpanel-${side}${state.collapsed ? " collapsed" : ""}`}>
      {tabs}
      {!state.collapsed && (
        <>
          <div className="toolpanel-body" style={{ width: state.width }}>
            <div className="toolpanel-header">{active.title}</div>
            <div className="toolpanel-content">{active.render()}</div>
          </div>
          <div
            className="toolpanel-resizer"
            onPointerDown={startResize}
            onPointerMove={resize}
            onPointerUp={() => (dragStart.current = null)}
          />
        </>
      )}
    </div>
  );
}
