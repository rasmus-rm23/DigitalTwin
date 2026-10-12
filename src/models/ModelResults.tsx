import { useMemo } from "react";
import { AlignedData } from "uplot";
import { OutputResult, OutputSeries, TrainResult } from "../api/backend";
import PlotChart from "../plots/PlotChart";

const fmt = (v: number | null, digits = 3) => (v == null ? "–" : v.toPrecision(digits));

/** Metrics, coefficients and measured-vs-predicted plots of a trained model for one batch. */
export default function ModelResults({ result, batch }: { result: TrainResult; batch: string | null }) {
  return (
    <div className="model-results">
      {result.warnings.map((w, i) => (
        <p key={i} className="warning">
          {w}
        </p>
      ))}
      <table className="grid metrics">
        <thead>
          <tr>
            <th>Output</th>
            <th>R² train</th>
            <th>R² test</th>
            <th>RMSE train</th>
            <th>RMSE test</th>
            <th>Rows train / test</th>
          </tr>
        </thead>
        <tbody>
          {result.outputs.map((o) => (
            <tr key={o.column}>
              <th>{o.name}</th>
              <td className="num">{fmt(o.r2Train)}</td>
              <td className="num">{fmt(o.r2Test)}</td>
              <td className="num">{fmt(o.rmseTrain)}</td>
              <td className="num">{fmt(o.rmseTest)}</td>
              <td className="num">
                {o.nTrain.toLocaleString()} / {o.nTest.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.outputs.map((o) => (
        <OutputPanel key={o.column} output={o} batch={batch} />
      ))}
    </div>
  );
}

function OutputPanel({ output, batch }: { output: OutputResult; batch: string | null }) {
  const series: OutputSeries | undefined = output.series.find((s) => s.batch === batch) ?? output.series[0];
  const data = useMemo<AlignedData | null>(() => {
    if (!series) return null;
    const isTest = (h: number) => series.testStartHours != null && h >= series.testStartHours;
    return [
      series.hours,
      series.measured,
      series.predicted.map((p, i) => (isTest(series.hours[i]) ? null : p)),
      series.predicted.map((p, i) => (isTest(series.hours[i]) ? p : null)),
    ] as AlignedData;
  }, [series]);

  return (
    <div className="output-panel">
      <div className="output-panel-header">
        <b>{output.name}</b>: measured vs predicted
        {series?.batch && <span className="batch-key">batch {series.batch}</span>}
        {series?.testStartHours != null && (
          <span className="muted">test data from {series.testStartHours.toFixed(2)} h</span>
        )}
      </div>
      {output.coefficients && (
        <div className="coefficients">
          <span className="muted">Linear model:</span> {output.name} = {output.coefficients.intercept.toPrecision(5)}
          {output.coefficients.slopes.map((s) => (
            <span key={s.column}>
              {" "}
              {s.value >= 0 ? "+" : "−"} {Math.abs(s.value).toPrecision(4)} × {s.name}
            </span>
          ))}
        </div>
      )}
      {data && (
        <PlotChart
          data={data}
          height={220}
          yMin={null}
          yMax={null}
          syncKey="dt-model"
          lines={[
            { label: "Measured", stroke: "#a0a0a0", dash: [] },
            { label: "Predicted (train)", stroke: "#4fc1ff", dash: [] },
            { label: "Predicted (test)", stroke: "#f2a33a", dash: [] },
          ]}
        />
      )}
    </div>
  );
}
