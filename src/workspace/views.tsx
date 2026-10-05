import { IDockviewPanelProps } from "dockview-react";
import { FunctionComponent, useState } from "react";
import { backend, errorMessage, ProjectInfo } from "../api/backend";

/** Document views that can be opened as tabs in the main area. */
export interface ViewDef {
  id: string;
  title: string;
  component: FunctionComponent<IDockviewPanelProps>;
}

function Placeholder({ text }: { text: string }) {
  return <div className="view-placeholder">{text}</div>;
}

function OverviewView({ params }: IDockviewPanelProps<{ project: ProjectInfo }>) {
  const [engine, setEngine] = useState<string>("not checked");
  const { project } = params;

  async function ping() {
    setEngine("checking…");
    try {
      const r = await backend.sidecarPing();
      setEngine(`${r.status} (sidecar ${r.version}, Python ${r.python})`);
    } catch (e) {
      setEngine(`error: ${errorMessage(e)}`);
    }
  }

  return (
    <div className="view-padded">
      <h2>{project.name}</h2>
      <table className="kv">
        <tbody>
          <tr><th>File</th><td>{project.path}</td></tr>
          <tr><th>Created</th><td>{new Date(project.createdAt).toLocaleString()}</td></tr>
          <tr><th>Schema</th><td>v{project.schemaVersion}</td></tr>
          <tr>
            <th>Python engine</th>
            <td>{engine} <button onClick={ping}>Check</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export const VIEWS: ViewDef[] = [
  { id: "overview", title: "Overview", component: OverviewView },
  { id: "tables", title: "Tables", component: () => <Placeholder text="Imported tables (CSV/XLSX)" /> },
  { id: "relations", title: "Relations", component: () => <Placeholder text="Tabular model: relations between tables" /> },
  { id: "pid", title: "P&ID", component: () => <Placeholder text="Process & instrumentation diagram" /> },
  { id: "plots", title: "Plots", component: () => <Placeholder text="Measured vs. model plots" /> },
  { id: "models", title: "Models", component: () => <Placeholder text="ML models and training" /> },
  { id: "simulation", title: "Simulation", component: () => <Placeholder text="What-if scenarios and optimisation" /> },
];

export const VIEW_COMPONENTS = Object.fromEntries(VIEWS.map((v) => [v.id, v.component]));
