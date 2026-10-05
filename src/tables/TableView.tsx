import { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { backend, CellValue, errorMessage, TableInfo } from "../api/backend";

const ROW_HEIGHT = 22;
const PAGE_SIZE = 500;
const OVERSCAN = 20;

export interface TableViewParams {
  table: TableInfo;
}

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Datetimes are stored as UTC epoch ms and shown in this PC's local time. */
function formatCell(value: CellValue, kind: string): string {
  if (value === null) return "";
  if (kind === "datetime" && typeof value === "number") return dateFormat.format(new Date(value));
  return String(value);
}

/** Read-only, virtualized grid over an imported table. Rows are fetched in pages. */
export default function TableView({ params }: IDockviewPanelProps<TableViewParams>) {
  const { table } = params;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, CellValue[][]>());
  const loading = useRef(new Set<number>());
  const [range, setRange] = useState({ start: 0, end: 50 });
  const [, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    (page: number) => {
      if (pages.current.has(page) || loading.current.has(page)) return;
      loading.current.add(page);
      backend
        .tableRows(table.id, page * PAGE_SIZE, PAGE_SIZE)
        .then((rows) => {
          pages.current.set(page, rows);
          setVersion((v) => v + 1);
        })
        .catch((e) => setError(errorMessage(e)))
        .finally(() => loading.current.delete(page));
    },
    [table.id],
  );

  const updateRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(table.rowCount, Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + OVERSCAN);
    setRange({ start, end });
  }, [table.rowCount]);

  useEffect(() => {
    updateRange();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateRange);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateRange]);

  useEffect(() => {
    for (let p = Math.floor(range.start / PAGE_SIZE); p <= Math.floor((range.end - 1) / PAGE_SIZE); p++) {
      loadPage(p);
    }
  }, [range, loadPage]);

  const rows = [];
  for (let r = range.start; r < range.end; r++) {
    const row = pages.current.get(Math.floor(r / PAGE_SIZE))?.[r % PAGE_SIZE];
    rows.push(
      <tr key={r} style={{ height: ROW_HEIGHT }}>
        <td className="rownum">{r + 1}</td>
        {table.columns.map((c, i) => (
          <td key={i} className={c.kind === "text" ? undefined : "num"}>
            {row ? formatCell(row[i], c.kind) : ""}
          </td>
        ))}
      </tr>,
    );
  }

  return (
    <div className="table-view">
      <div className="table-view-info muted">
        {table.rowCount.toLocaleString()} rows · {table.columns.length} columns
        {table.sourcePath && <> · {table.sourcePath}</>}
        {error && <span className="error"> · {error}</span>}
      </div>
      <div className="table-view-scroll" ref={scrollRef} onScroll={updateRange}>
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {table.columns.map((c, i) => (
                <th key={i} title={c.kind}>
                  {c.name}
                  <span className="kind">{c.kind}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {range.start > 0 && <tr style={{ height: range.start * ROW_HEIGHT }} />}
            {rows}
            {range.end < table.rowCount && <tr style={{ height: (table.rowCount - range.end) * ROW_HEIGHT }} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}
