import { useEffect, useRef, useState } from "react";
import { ConnectionKind, TableInfo } from "../api/backend";
import { PidEdge, PidNode, PidNodeData } from "./model";
import { InstrumentLocation } from "./nodes";
import { SYMBOL_BY_KIND } from "./symbols";

export interface PidActions {
  /** Record an undo step before a series of text edits. */
  beginEdit: () => void;
  updateNode: (id: string, patch: Partial<PidNodeData>, record?: boolean) => void;
  updateEdge: (id: string, patch: { kind?: ConnectionKind; label?: string }, record?: boolean) => void;
  rotate: (ids: string[], direction: 1 | -1) => void;
  reverseEdge: (id: string) => void;
  deleteSelection: () => void;
}

interface Props {
  nodes: PidNode[];
  edges: PidEdge[];
  tables: TableInfo[];
  actions: PidActions;
}

/** Text input with local state, so external re-renders do not move the caret while typing. */
function TextField({ value, onChange, onFocus, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <input
      value={text}
      placeholder={placeholder}
      onFocus={() => {
        focused.current = true;
        onFocus();
      }}
      onBlur={() => {
        focused.current = false;
        setText(value);
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

export function rotatable(kind: PidNodeData["kind"]) {
  return kind !== "instrument" && kind !== "label";
}

export default function PidProperties({ nodes, edges, tables, actions }: Props) {
  if (nodes.length + edges.length === 0) {
    return <p className="muted">Select a symbol or line to edit it. Drag symbols from the palette onto the drawing.</p>;
  }
  if (nodes.length + edges.length > 1) {
    const rotIds = nodes.filter((n) => rotatable(n.data.kind)).map((n) => n.id);
    return (
      <div className="props">
        <p className="muted">{nodes.length + edges.length} items selected</p>
        <div className="props-actions">
          {rotIds.length > 0 && <button onClick={() => actions.rotate(rotIds, 1)}>Rotate ⟳</button>}
          <button onClick={actions.deleteSelection}>Delete</button>
        </div>
      </div>
    );
  }
  if (edges.length === 1) return <EdgeProps edge={edges[0]} actions={actions} />;
  return <NodeProps node={nodes[0]} tables={tables} actions={actions} />;
}

function NodeProps({ node, tables, actions }: { node: PidNode; tables: TableInfo[]; actions: PidActions }) {
  const { data } = node;
  const def = SYMBOL_BY_KIND[data.kind];
  const update = (patch: Partial<PidNodeData>, record = true) => actions.updateNode(node.id, patch, record);
  const table = data.column ? tables.find((t) => t.id === data.column!.tableId) : undefined;

  return (
    <div className="props">
      <div className="props-kind">{def.title}</div>
      {data.kind !== "label" && (
        <label>
          Tag
          <TextField
            value={data.tag}
            placeholder={data.kind === "instrument" ? "e.g. TIC-101" : "e.g. C-101"}
            onFocus={actions.beginEdit}
            onChange={(tag) => update({ tag }, false)}
          />
        </label>
      )}
      <label>
        {data.kind === "label" ? "Text" : "Description"}
        <TextField value={data.label} onFocus={actions.beginEdit} onChange={(label) => update({ label }, false)} />
      </label>

      {data.kind === "instrument" && (
        <>
          <label>
            Location
            <select
              value={(data.props.location as InstrumentLocation | undefined) ?? "field"}
              onChange={(e) => update({ props: { ...data.props, location: e.target.value } })}
            >
              <option value="field">Field mounted</option>
              <option value="panel">Control room panel</option>
              <option value="dcs">DCS / shared display</option>
            </select>
          </label>
          <label>
            Data table
            <select
              value={data.column?.tableId ?? ""}
              onChange={(e) =>
                update({ column: e.target.value ? { tableId: Number(e.target.value), ordinal: 0 } : null })
              }
            >
              <option value="">Not linked</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {table && (
            <label>
              Column
              <select
                value={data.column!.ordinal}
                onChange={(e) => update({ column: { tableId: table.id, ordinal: Number(e.target.value) } })}
              >
                {table.columns.map((c, i) => (
                  <option key={i} value={i}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </select>
            </label>
          )}
          {tables.length === 0 && <p className="muted">Import a table to link this instrument to measured data.</p>}
        </>
      )}

      <div className="props-actions">
        {rotatable(data.kind) && (
          <>
            <button title="Rotate counter-clockwise (Shift+R)" onClick={() => actions.rotate([node.id], -1)}>
              ⟲
            </button>
            <button title="Rotate clockwise (R)" onClick={() => actions.rotate([node.id], 1)}>
              ⟳
            </button>
          </>
        )}
        <button onClick={actions.deleteSelection}>Delete</button>
      </div>
    </div>
  );
}

function EdgeProps({ edge, actions }: { edge: PidEdge; actions: PidActions }) {
  const kind = edge.data?.kind ?? "process";
  return (
    <div className="props">
      <div className="props-kind">{kind === "process" ? "Process line" : "Signal line"}</div>
      <label>
        Type
        <select value={kind} onChange={(e) => actions.updateEdge(edge.id, { kind: e.target.value as ConnectionKind })}>
          <option value="process">Process line (pipe)</option>
          <option value="signal">Signal line</option>
        </select>
      </label>
      <label>
        Label
        <TextField
          value={typeof edge.label === "string" ? edge.label : ""}
          placeholder={kind === "process" ? "e.g. line number" : ""}
          onFocus={actions.beginEdit}
          onChange={(label) => actions.updateEdge(edge.id, { label }, false)}
        />
      </label>
      <div className="props-actions">
        {kind === "process" && <button onClick={() => actions.reverseEdge(edge.id)}>Reverse flow</button>}
        <button onClick={actions.deleteSelection}>Delete</button>
      </div>
    </div>
  );
}
