import { TableInfo } from "../api/backend";

interface Props {
  tables: TableInfo[];
  onImport: () => void;
  onOpenTable: (table: TableInfo) => void;
  onDeleteTable: (table: TableInfo) => void;
}

export default function ExplorerTool({ tables, onImport, onOpenTable, onDeleteTable }: Props) {
  return (
    <div className="explorer">
      <div className="explorer-section">
        <span>Tables</span>
        <button className="icon" title="Import data…" onClick={onImport}>
          +
        </button>
      </div>
      {tables.length === 0 && <p className="muted">No tables yet. Import a CSV or Excel file.</p>}
      <ul className="explorer-list">
        {tables.map((t) => (
          <li key={t.id} title={t.sourcePath ?? undefined}>
            <button className="explorer-item" onClick={() => onOpenTable(t)}>
              {t.name}
              <span className="muted"> {t.rowCount.toLocaleString()}</span>
            </button>
            <button className="icon" title="Delete table" onClick={() => onDeleteTable(t)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
