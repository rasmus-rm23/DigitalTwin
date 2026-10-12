import { Handle, NodeProps, NodeResizer, Position } from "@xyflow/react";
import { createContext, useContext } from "react";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { columnName, PidNode, splitInstrumentTag } from "./model";
import { rotateHandle, Side, SYMBOL_BY_KIND } from "./symbols";

/** Editor callbacks that nodes need (history for resize). */
export const EditorContext = createContext<{ snapshot: () => void }>({ snapshot: () => {} });

const POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/** Connection handles placed according to the symbol definition and rotation. */
function Handles({ kind, rotation }: { kind: PidNode["data"]["kind"]; rotation: number }) {
  return (
    <>
      {SYMBOL_BY_KIND[kind].handles.map((h) => {
        const { side, at } = rotateHandle(h, rotation);
        const along = `${at * 100}%`;
        return (
          <Handle
            key={h.id}
            id={h.id}
            type="source"
            position={POSITION[side]}
            style={side === "top" || side === "bottom" ? { left: along } : { top: along }}
          />
        );
      })}
    </>
  );
}

function Resizer({ selected, kind }: { selected: boolean; kind: PidNode["data"]["kind"] }) {
  const { snapshot } = useContext(EditorContext);
  if (!SYMBOL_BY_KIND[kind].resizable) return null;
  return <NodeResizer isVisible={selected} minWidth={20} minHeight={20} onResizeStart={snapshot} />;
}

/** Equipment, valves and connectors: an SVG symbol rotated inside the node box. */
export function SymbolNode({ data, width, height, selected }: NodeProps<PidNode>) {
  const def = SYMBOL_BY_KIND[data.kind];
  const W = width ?? def.width;
  const H = height ?? def.height;
  const sideways = data.rotation % 180 !== 0;
  const [w, h] = sideways ? [H, W] : [W, H];
  return (
    <div className={`pid-node${selected ? " selected" : ""}`} style={{ width: W, height: H }}>
      <Resizer selected={!!selected} kind={data.kind} />
      <svg width={W} height={H} className="pid-symbol" overflow="visible">
        <g transform={`translate(${W / 2},${H / 2}) rotate(${data.rotation}) translate(${-w / 2},${-h / 2})`}>
          {def.draw?.(w, h)}
        </g>
      </svg>
      {data.kind === "connector" ? (
        <div className="pid-connector-text">{data.tag || data.label}</div>
      ) : (
        (data.tag || data.label) && (
          <div className="pid-caption">
            {data.tag && <b>{data.tag}</b>}
            {data.label && <span>{data.label}</span>}
          </div>
        )
      )}
      <Handles kind={data.kind} rotation={data.rotation} />
    </div>
  );
}

export type InstrumentLocation = "field" | "panel" | "dcs";

/** Font size that keeps `text` inside a bubble of radius r (approx. 0.6 em per character). */
function fitFont(text: string, r: number, max: number) {
  return Math.min(max, (1.5 * r) / (0.6 * Math.max(text.length, 1)));
}

/** ISA-5.1 instrument bubble: function letters over loop number. */
export function InstrumentNode({ data, width, height, selected }: NodeProps<PidNode>) {
  const { tables } = useWorkspace();
  const W = width ?? 52;
  const H = height ?? 52;
  const r = Math.min(W, H) / 2 - 1.5;
  const [letters, number] = splitInstrumentTag(data.tag);
  const location = (data.props.location as InstrumentLocation | undefined) ?? "field";
  const linked = data.column ? columnName(data.column, tables) : null;
  return (
    <div
      className={`pid-node${selected ? " selected" : ""}`}
      style={{ width: W, height: H }}
      title={linked ? `Linked to ${linked}` : "Not linked to a data column"}
    >
      <svg width={W} height={H} className="pid-symbol">
        {location === "dcs" && <rect x={1.5} y={1.5} width={W - 3} height={H - 3} />}
        <circle cx={W / 2} cy={H / 2} r={r} />
        {location === "panel" && <line x1={W / 2 - r} y1={H / 2} x2={W / 2 + r} y2={H / 2} />}
        <text x={W / 2} y={H / 2 - 4} className="pid-instrument-letters" style={{ fontSize: fitFont(letters, r, 12) }}>
          {letters}
        </text>
        <text x={W / 2} y={H / 2 + 12} className="pid-instrument-number" style={{ fontSize: fitFont(number, r, 10) }}>
          {number}
        </text>
      </svg>
      {linked && <span className="pid-link-dot" />}
      {data.label && <div className="pid-caption"><span>{data.label}</span></div>}
      <Handles kind="instrument" rotation={0} />
    </div>
  );
}

/** Free text annotation. */
export function LabelNode({ data, width, height, selected }: NodeProps<PidNode>) {
  return (
    <div className={`pid-node pid-label${selected ? " selected" : ""}`} style={{ width: width ?? 140, minHeight: height ?? 24 }}>
      <Resizer selected={!!selected} kind="label" />
      {data.label || <span className="muted">Text</span>}
    </div>
  );
}

export const NODE_TYPES = { symbol: SymbolNode, instrument: InstrumentNode, label: LabelNode };
