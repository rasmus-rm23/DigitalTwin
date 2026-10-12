import {
  Background,
  BackgroundVariant,
  Connection,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, Diagram, ElementKind, errorMessage } from "../api/backend";
import { clearInspector, setInspector } from "../workspace/inspector";
import { useWorkspace } from "../workspace/WorkspaceContext";
import {
  columnExists,
  fromDiagram,
  GRID,
  newId,
  nextTag,
  nodeType,
  PidEdge,
  PidNode,
  styleEdge,
  toDiagram,
} from "./model";
import { EditorContext, NODE_TYPES } from "./nodes";
import PidProperties, { PidActions, rotatable } from "./PidProperties";
import { GROUPS, SymbolIcon, SYMBOL_BY_KIND, SYMBOLS } from "./symbols";

const INSPECTOR_OWNER = "pid";
const DRAG_TYPE = "application/x-pid-kind";
const HISTORY_LIMIT = 100;
const SAVE_DELAY_MS = 500;

type Snapshot = { nodes: PidNode[]; edges: PidEdge[] };

export default function PidEditor() {
  return (
    <ReactFlowProvider>
      <PidCanvas />
    </ReactFlowProvider>
  );
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function PidCanvas() {
  const { tables, tablesLoaded } = useWorkspace();
  const rf = useReactFlow<PidNode, PidEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<PidNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<PidEdge>([]);
  const [meta, setMeta] = useState<{ id: number; name: string } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);

  // --- Undo/redo: whole-diagram snapshots taken before each change ---
  const current = useRef<Snapshot>({ nodes, edges });
  current.current = { nodes, edges };
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [, setHistoryVersion] = useState(0);

  const snapshot = useCallback(() => {
    past.current.push(current.current);
    if (past.current.length > HISTORY_LIMIT) past.current.shift();
    future.current = [];
    setHistoryVersion((v) => v + 1);
  }, []);

  const restore = useCallback(
    (from: Snapshot[], to: Snapshot[]) => {
      const s = from.pop();
      if (!s) return;
      to.push(current.current);
      setNodes(s.nodes);
      setEdges(s.edges);
      setHistoryVersion((v) => v + 1);
    },
    [setNodes, setEdges],
  );
  const undo = useCallback(() => restore(past.current, future.current), [restore]);
  const redo = useCallback(() => restore(future.current, past.current), [restore]);

  // --- Load ---
  useEffect(() => {
    backend
      .pidGet()
      .then((d) => {
        const { nodes, edges } = fromDiagram(d);
        lastSaved.current = JSON.stringify(toDiagram(d, nodes, edges));
        setNodes(nodes);
        setEdges(edges);
        setMeta({ id: d.id, name: d.name });
        if (nodes.length) requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
      })
      .catch((e) => setError(errorMessage(e)));
  }, [rf, setNodes, setEdges]);

  // --- Autosave (debounced); flushes a pending save when the editor closes ---
  const lastSaved = useRef("");
  const pending = useRef<{ diagram: Diagram; json: string } | null>(null);

  const save = useCallback((diagram: Diagram, json: string) => {
    backend
      .pidSave(diagram)
      .then(() => {
        lastSaved.current = json;
        if (pending.current?.json === json) pending.current = null;
        setSaveState("saved");
        setError(null);
      })
      .catch((e) => {
        setSaveState("error");
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    if (!meta) return;
    const diagram = toDiagram(meta, nodes, edges);
    const json = JSON.stringify(diagram);
    if (json === lastSaved.current) return;
    pending.current = { diagram, json };
    setSaveState("saving");
    const timer = setTimeout(() => save(diagram, json), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [meta, nodes, edges, save]);

  useEffect(
    () => () => {
      const p = pending.current;
      if (p && p.json !== lastSaved.current) void backend.pidSave(p.diagram);
    },
    [],
  );

  // Drop links to columns whose table was deleted (the core already cleared them).
  useEffect(() => {
    if (!tablesLoaded) return;
    setNodes((ns) =>
      ns.some((n) => n.data.column && !columnExists(n.data.column, tables))
        ? ns.map((n) =>
            n.data.column && !columnExists(n.data.column, tables) ? { ...n, data: { ...n.data, column: null } } : n,
          )
        : ns,
    );
  }, [tables, tablesLoaded, setNodes]);

  // --- Editing ---
  const addElement = useCallback(
    (kind: ElementKind, center?: { x: number; y: number }) => {
      const def = SYMBOL_BY_KIND[kind];
      if (!center) {
        const r = wrapper.current!.getBoundingClientRect();
        center = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      snapshot();
      const node: PidNode = {
        id: newId("n"),
        type: nodeType(kind),
        position: { x: snap(center.x - def.width / 2), y: snap(center.y - def.height / 2) },
        width: def.width,
        height: def.height,
        selected: true,
        data: {
          kind,
          tag: nextTag(def.tagPrefix, current.current.nodes),
          label: "",
          rotation: 0,
          props: kind === "instrument" ? { location: "field" } : {},
          column: null,
        },
      };
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
      setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
    },
    [rf, snapshot, setNodes, setEdges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      snapshot();
      const kinds = [c.source, c.target].map((id) => rf.getNode(id)?.data.kind);
      const kind = kinds.includes("instrument") ? "signal" : "process";
      setEdges((es) => addEdge(styleEdge({ ...c, id: newId("e") }, kind), es));
    },
    [rf, snapshot, setEdges],
  );

  const rotate = useCallback(
    (ids: string[], direction: 1 | -1) => {
      snapshot();
      setNodes((ns) =>
        ns.map((n) => {
          if (!ids.includes(n.id) || !rotatable(n.data.kind)) return n;
          const W = n.width ?? SYMBOL_BY_KIND[n.data.kind].width;
          const H = n.height ?? SYMBOL_BY_KIND[n.data.kind].height;
          const rotation = (((n.data.rotation + direction * 90) % 360) + 360) % 360;
          return {
            ...n,
            width: H,
            height: W,
            // Keep the centre in place.
            position: { x: snap(n.position.x + (W - H) / 2), y: snap(n.position.y + (H - W) / 2) },
            data: { ...n.data, rotation: rotation as PidNode["data"]["rotation"] },
          };
        }),
      );
    },
    [snapshot, setNodes],
  );

  const deleteSelection = useCallback(() => {
    const { nodes, edges } = current.current;
    void rf.deleteElements({ nodes: nodes.filter((n) => n.selected), edges: edges.filter((e) => e.selected) });
  }, [rf]);

  const actions: PidActions = useMemo(
    () => ({
      beginEdit: snapshot,
      updateNode: (id, patch, record = true) => {
        if (record) snapshot();
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
      },
      updateEdge: (id, patch, record = true) => {
        if (record) snapshot();
        setEdges((es) =>
          es.map((e) => {
            if (e.id !== id) return e;
            const label = patch.label ?? (typeof e.label === "string" ? e.label : "");
            return styleEdge({ ...e, label: label || undefined }, patch.kind ?? e.data?.kind ?? "process");
          }),
        );
      },
      rotate,
      reverseEdge: (id) => {
        snapshot();
        setEdges((es) =>
          es.map((e) =>
            e.id === id
              ? { ...e, source: e.target, target: e.source, sourceHandle: e.targetHandle, targetHandle: e.sourceHandle }
              : e,
          ),
        );
      },
      deleteSelection,
    }),
    [snapshot, rotate, deleteSelection, setNodes, setEdges],
  );

  // --- Properties tool window ---
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);
  useEffect(() => {
    setInspector("properties", {
      owner: INSPECTOR_OWNER,
      title: "P&ID",
      render: () => <PidProperties nodes={selectedNodes} edges={selectedEdges} tables={tables} actions={actions} />,
    });
  });
  useEffect(() => () => clearInspector("properties", INSPECTOR_OWNER), []);

  // --- Keyboard: undo/redo and rotate (Delete is handled by React Flow) ---
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target) || !wrapper.current?.offsetParent) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ids = current.current.nodes.filter((n) => n.selected).map((n) => n.id);
        if (ids.length) rotate(ids, e.shiftKey ? -1 : 1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo, rotate]);

  // --- Palette drag & drop ---
  function onDragOver(e: DragEvent) {
    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }

  function onDrop(e: DragEvent) {
    const kind = e.dataTransfer.getData(DRAG_TYPE) as ElementKind;
    if (!kind) return;
    e.preventDefault();
    addElement(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }

  const status =
    error ?? (saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved" : "Not saved");

  return (
    <EditorContext.Provider value={{ snapshot }}>
      <div className="pid-editor">
        <div className="pid-palette">
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="pid-palette-group">{g}</div>
              {SYMBOLS.filter((s) => s.group === g).map((s) => (
                <button
                  key={s.kind}
                  className="pid-palette-item"
                  draggable
                  title={`${s.title}: drag onto the drawing or click to add`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, s.kind);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => addElement(s.kind)}
                >
                  <SymbolIcon kind={s.kind} />
                  <span>{s.title}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="pid-canvas" ref={wrapper} onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow<PidNode, PidEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={snapshot}
            onSelectionDragStart={snapshot}
            onBeforeDelete={async () => {
              snapshot();
              return true;
            }}
            isValidConnection={(c) => c.source !== c.target}
            connectionMode={ConnectionMode.Loose}
            snapToGrid
            snapGrid={[GRID, GRID]}
            deleteKeyCode={["Delete", "Backspace"]}
            colorMode="dark"
            minZoom={0.1}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID * 2} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
            <Panel position="top-right" className="pid-toolbar">
              <button onClick={undo} disabled={past.current.length === 0} title="Undo (Ctrl+Z)">
                ↶
              </button>
              <button onClick={redo} disabled={future.current.length === 0} title="Redo (Ctrl+Y)">
                ↷
              </button>
              <button onClick={() => rf.fitView({ padding: 0.2 })} title="Fit drawing to view">
                Fit
              </button>
              <span className={error ? "error" : "muted"}>{status}</span>
            </Panel>
          </ReactFlow>
        </div>
      </div>
    </EditorContext.Provider>
  );
}
