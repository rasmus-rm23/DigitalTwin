import { useEffect, useRef } from "react";
import uPlot, { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { PlotLine } from "./data";

interface Props {
  data: AlignedData;
  lines: PlotLine[];
  height: number;
  yMin: number | null;
  yMax: number | null;
  /** Plots with the same key share a crosshair. */
  syncKey: string;
  /** x-axis label; defaults to time since batch start. */
  xLabel?: string;
}

const AXIS = { stroke: "#a0a0a0", grid: { stroke: "#2f2f2f", width: 1 }, ticks: { stroke: "#3c3c3c", width: 1 } };

const NEAREST_SEARCH = 500;

/** Nearest non-null value around index i (other batches' samples sit in between). */
function nearestValue(ys: (number | null)[], i: number): number | null {
  for (let d = 1; d <= NEAREST_SEARCH; d++) {
    if (ys[i - d] != null) return ys[i - d];
    if (ys[i + d] != null) return ys[i + d];
  }
  return null;
}

function formatValue(v: number | null): string {
  if (v == null) return "–";
  const abs = Math.abs(v);
  return abs !== 0 && (abs < 0.01 || abs >= 1e6) ? v.toExponential(3) : v.toPrecision(5).replace(/\.?0+$/, "");
}

/** A uPlot line chart that fills its container's width. */
export default function PlotChart({ data, lines, height, yMin, yMax, syncKey, xLabel = "Time since batch start (h)" }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);

  // Recreate the chart when its structure changes; data-only changes go through setData.
  const structure = JSON.stringify({ lines, yMin, yMax, syncKey, xLabel });
  useEffect(() => {
    const el = container.current!;
    const opts: Options = {
      width: Math.max(el.clientWidth, 100),
      height,
      cursor: { sync: { key: syncKey }, drag: { x: true, y: false } },
      legend: { live: true },
      scales: {
        x: { time: false },
        y: {
          range: (_u, min, max) => {
            // A constant series (e.g. a fixed setpoint) gets a band around its value.
            if (min != null && min === max) {
              const pad = Math.abs(min) * 0.1 || 1;
              [min, max] = [min - pad, max + pad];
            }
            const [lo, hi] = uPlot.rangeNum(min ?? 0, max ?? 1, 0.1, true);
            return [yMin ?? lo, yMax ?? hi];
          },
        },
      },
      axes: [
        { ...AXIS, label: xLabel, labelSize: 20 },
        { ...AXIS, size: 60 },
      ],
      series: [
        { label: "h", value: (_u, v) => (v == null ? "–" : `${v.toFixed(3)} h`) },
        ...lines.map((l) => ({
          label: l.label,
          stroke: l.stroke,
          dash: l.dash,
          width: 1.5,
          spanGaps: true,
          points: { show: false },
          // On the merged axis each position belongs to one batch; show the nearest sample.
          value: (u: uPlot, v: number | null, si: number, i: number | null) =>
            formatValue(v ?? (i == null ? null : nearestValue(u.data[si] as (number | null)[], i))),
        })),
      ],
    };
    const u = new uPlot(opts, data, el);
    chart.current = u;
    const observer = new ResizeObserver(() => u.setSize({ width: Math.max(el.clientWidth, 100), height }));
    observer.observe(el);
    return () => {
      observer.disconnect();
      u.destroy();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, height]);

  useEffect(() => {
    chart.current?.setData(data);
  }, [data]);

  return <div ref={container} className="plot-chart" />;
}
