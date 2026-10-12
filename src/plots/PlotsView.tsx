import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  backend,
  BatchInfo,
  BatchSeries,
  errorMessage,
  PlotConfig,
  PlotDef,
  PlotSheet,
  PlotSource,
  TableInfo,
} from "../api/backend";
import { clearInspector, setInspector } from "../workspace/inspector";
import { useWorkspace } from "../workspace/WorkspaceContext";
import BatchesPanel from "./BatchesPanel";
import { alignBatches, plotLines } from "./data";
import PlotChart from "./PlotChart";
import PlotSettingsPanel from "./PlotSettingsPanel";

const OWNER = "plots";
const SAVE_DELAY_MS = 500;
const SYNC_KEY = "dt-plots";

const sourceKey = (s: PlotSource | null) => (s ? `${s.tableId}:${s.batchColumn}:${s.timeColumn}` : "");

function newPlotId() {
  return `p${crypto.randomUUID().slice(0, 8)}`;
}

function validConfig(c: PlotConfig) {
  return c.plots.every((p) => p.yMin == null || p.yMax == null || p.yMin < p.yMax);
}

/** The Plots view: batch-aligned time-series plots of one data table. */
export default function PlotsView() {
  const { tables, tablesLoaded, openTable, showTool } = useWorkspace();
  const [sheet, setSheet] = useState<PlotSheet | null>(null);
  const [selectedPlot, setSelectedPlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "invalid">("saved");

  const config = sheet?.config;
  const source = config?.source ?? null;
  const table = source ? tables.find((t) => t.id === source.tableId) : undefined;

  const update = useCallback((fn: (c: PlotConfig) => PlotConfig) => {
    setSheet((s) => (s ? { ...s, config: fn(s.config) } : s));
  }, []);

  // --- Load and autosave the sheet ---
  const lastSaved = useRef("");
  const pending = useRef<{ sheet: PlotSheet; json: string } | null>(null);

  useEffect(() => {
    backend
      .plotSheetGet()
      .then((s) => {
        lastSaved.current = JSON.stringify(s);
        setSheet(s);
        setSelectedPlot(s.config.plots[0]?.id ?? null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!sheet) return;
    const json = JSON.stringify(sheet);
    if (json === lastSaved.current) return;
    if (!validConfig(sheet.config)) {
      setSaveState("invalid");
      return;
    }
    pending.current = { sheet, json };
    setSaveState("saving");
    const timer = setTimeout(() => {
      backend
        .plotSheetSave(sheet)
        .then(() => {
          lastSaved.current = json;
          if (pending.current?.json === json) pending.current = null;
          setSaveState("saved");
        })
        .catch((e) => {
          setSaveState("error");
          setError(errorMessage(e));
        });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sheet]);

  useEffect(
    () => () => {
      const p = pending.current;
      if (p && p.json !== lastSaved.current) void backend.plotSheetSave(p.sheet);
    },
    [],
  );

  // --- Batches of the source ---
  const [batches, setBatches] = useState<BatchInfo[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchesVersion, setBatchesVersion] = useState(0);
  const autoSelect = useRef(false);

  useEffect(() => {
    setBatches([]);
    setBatchError(null);
    if (!source) return;
    let cancelled = false;
    backend
      .plotBatches(source)
      .then((b) => {
        if (cancelled) return;
        setBatches(b);
        if (autoSelect.current && b.length > 0) update((c) => ({ ...c, selectedBatches: [b[0].key] }));
        autoSelect.current = false;
      })
      .catch((e) => !cancelled && setBatchError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey(source), batchesVersion]);

  const renderedBatches = useMemo(() => {
    const available = new Set(batches.map((b) => b.key));
    return (config?.selectedBatches ?? []).filter((k) => available.has(k));
  }, [batches, config?.selectedBatches]);

  // --- Series data: all plotted columns for each rendered batch, cached per batch ---
  const columns = useMemo(
    () => [...new Set((config?.plots ?? []).flatMap((p) => p.series.map((s) => s.column)))].sort((a, b) => a - b),
    [config?.plots],
  );
  const seriesCache = useRef(new Map<string, BatchSeries>());
  const [series, setSeries] = useState<BatchSeries[]>([]);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useEffect(() => {
    if (!source || batchError || columns.length === 0 || renderedBatches.length === 0) {
      setSeries([]);
      return;
    }
    let cancelled = false;
    const prefix = `${sourceKey(source)}|${columns.join(",")}|`;
    Promise.all(
      renderedBatches.map(async (key) => {
        const cached = seriesCache.current.get(prefix + key);
        if (cached) return cached;
        const s = await backend.plotBatchSeries(source, key, columns);
        seriesCache.current.set(prefix + key, s);
        return s;
      }),
    )
      .then((s) => {
        if (cancelled) return;
        setSeries(s);
        setSeriesError(null);
      })
      .catch((e) => !cancelled && setSeriesError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey(source), batchError, columns.join(","), renderedBatches.join("\u0000")]);

  // A table deleted or changed elsewhere: reload the sheet so the core can clean it up.
  const tablesSignature = tables.map((t) => `${t.id}:${t.columns.map((c) => c.kind).join(",")}`).join("|");
  const firstSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!tablesLoaded) return;
    if (firstSignature.current === null) {
      firstSignature.current = tablesSignature;
      return;
    }
    if (source && !tables.some((t) => t.id === source.tableId)) {
      update((c) => ({ ...c, source: null, selectedBatches: [], plots: c.plots.map((p) => ({ ...p, series: [] })) }));
    }
    seriesCache.current.clear();
    setBatchesVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablesSignature, tablesLoaded]);

  // --- Editing ---
  const addPlot = useCallback(() => {
    const id = newPlotId();
    update((c) => ({
      ...c,
      plots: [...c.plots, { id, title: `Plot ${c.plots.length + 1}`, series: [], yMin: null, yMax: null }],
    }));
    setSelectedPlot(id);
    showTool("plot");
  }, [update, showTool]);

  const changePlot = useCallback(
    (id: string, patch: Partial<PlotDef>) =>
      update((c) => ({ ...c, plots: c.plots.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
    [update],
  );

  const deletePlot = useCallback(
    (id: string) => {
      update((c) => ({ ...c, plots: c.plots.filter((p) => p.id !== id) }));
      setSelectedPlot(null);
    },
    [update],
  );

  // --- Right-panel tabs ---
  const selected = config?.plots.find((p) => p.id === selectedPlot) ?? null;
  useEffect(() => {
    if (!config) return;
    setInspector("batches", {
      owner: OWNER,
      title: "Batches",
      render: () => (
        <BatchesPanel
          config={config}
          tables={tables}
          batches={batches}
          batchError={batchError}
          onSourceChange={(s) => {
            autoSelect.current = true;
            update((c) => ({ ...c, source: s, selectedBatches: [] }));
          }}
          onSelectBatches={(keys) => update((c) => ({ ...c, selectedBatches: keys }))}
          onShowSimulations={(on) => update((c) => ({ ...c, showSimulations: on }))}
          onOpenTable={openTable}
        />
      ),
    });
    setInspector("plot", {
      owner: OWNER,
      title: "Plot",
      render: () => (
        <PlotSettingsPanel
          plot={selected}
          table={table}
          onChange={(patch) => selected && changePlot(selected.id, patch)}
          onDelete={() => selected && deletePlot(selected.id)}
        />
      ),
    });
  });
  useEffect(
    () => () => {
      clearInspector("batches", OWNER);
      clearInspector("plot", OWNER);
    },
    [],
  );

  if (!config) return <div className="view-placeholder">{error ?? "Loading…"}</div>;

  const status =
    saveState === "invalid"
      ? "Not saved: fix the y-axis range"
      : saveState === "error"
        ? `Not saved: ${error}`
        : saveState === "saving"
          ? "Saving…"
          : "All changes saved";

  const hint = !source
    ? "Choose a data table in the Batches tab on the right."
    : batchError
      ? batchError
      : renderedBatches.length === 0
        ? "Select one or more batches in the Batches tab."
        : seriesError;

  return (
    <div className="plots-view">
      <div className="plots-toolbar">
        <button onClick={addPlot}>+ Add plot</button>
        <div className="segmented" role="group" aria-label="Layout">
          <button
            className={config.layout === "stacked" ? "active" : undefined}
            onClick={() => update((c) => ({ ...c, layout: "stacked" }))}
            title="One plot per row"
          >
            ☰ Stacked
          </button>
          <button
            className={config.layout === "pairs" ? "active" : undefined}
            onClick={() => update((c) => ({ ...c, layout: "pairs" }))}
            title="Two plots side by side"
          >
            ◫ Pairs
          </button>
        </div>
        <label className="plots-height">
          Height
          <input
            type="range"
            min={120}
            max={800}
            step={20}
            value={config.plotHeight}
            onChange={(e) => update((c) => ({ ...c, plotHeight: Number(e.target.value) }))}
          />
          <span>{config.plotHeight} px</span>
        </label>
        <span className={`plots-status ${saveState === "saved" || saveState === "saving" ? "muted" : "error"}`}>
          {status}
        </span>
      </div>
      {hint && <div className="plots-hint">{hint}</div>}
      <div className="plots-scroll">
        <div className={`plots-grid ${config.layout}`}>
          {config.plots.map((p) => (
            <PlotCard
              key={p.id}
              plot={p}
              selected={p.id === selectedPlot}
              height={config.plotHeight}
              series={series}
              columns={columns}
              batchKeys={renderedBatches}
              tableInfo={table}
              onSelect={() => {
                setSelectedPlot(p.id);
                showTool("plot");
              }}
            />
          ))}
          {config.plots.length === 0 && (
            <div className="plots-empty">
              <p className="muted">No plots yet.</p>
              <button onClick={addPlot}>+ Add plot</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlotCard({
  plot,
  selected,
  height,
  series,
  columns,
  batchKeys,
  tableInfo,
  onSelect,
}: {
  plot: PlotDef;
  selected: boolean;
  height: number;
  series: BatchSeries[];
  columns: number[];
  batchKeys: string[];
  tableInfo: TableInfo | undefined;
  onSelect: () => void;
}) {
  const table = tableInfo;
  const lines = useMemo(() => plotLines(plot, batchKeys, table), [plot, batchKeys, table]);
  const data = useMemo(() => {
    const idx = plot.series.map((s) => columns.indexOf(s.column));
    const ready = series.length === batchKeys.length && idx.every((i) => i >= 0);
    return ready ? alignBatches(series, idx) : null;
  }, [plot.series, columns, series, batchKeys.length]);

  return (
    <div className={`plot-card${selected ? " selected" : ""}`} onMouseDown={onSelect}>
      <div className="plot-card-title">{plot.title || "Untitled plot"}</div>
      {plot.series.length === 0 ? (
        <div className="plot-card-empty muted" style={{ height }}>
          Add tag columns in the Plot tab.
        </div>
      ) : data ? (
        <PlotChart data={data} lines={lines} height={height} yMin={plot.yMin} yMax={plot.yMax} syncKey={SYNC_KEY} />
      ) : (
        <div className="plot-card-empty muted" style={{ height }} />
      )}
    </div>
  );
}
