# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**DigitalTwin** is a Windows desktop app for building a data-driven digital twin of a chemical
production process. It uses historical data from SCADA, the QC lab and similar sources.
The workflow:

1. Import process data (CSV/XLSX) as tables and relate them through key columns.
2. Draw a P&ID (process and instrumentation diagram) and map table columns to diagram elements.
3. Classify variables (input/output, manipulable or not, bounds).
4. Train ML models (linear/polynomial regression, neural networks) with variable pre-treatment
   and optimised time delays.
5. Compare model and measured data, both as small plots on the P&ID and in a full plot view.
6. Run what-if simulations and optimise the manipulable inputs against a cost function.

The repo is greenfield. When you scaffold something, follow the architecture below and update
this file if a decision changes.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust), Windows target |
| Frontend | React + TypeScript (Vite) |
| Data/ML engine | Python sidecar (pandas, scikit-learn, PyTorch, scipy), bundled with the app |
| Storage | One SQLite file per project |
| AI integration | MCP server embedded in the running app |

## Architecture

```
React UI  ──Tauri commands/events──▶  Rust core  ──JSON-RPC over stdio──▶  Python sidecar
                                         │                                   (import, train,
                                         ├── SQLite project file              simulate, optimise)
                                         └── MCP server (same command layer as the UI)
```

- **Rust core is the single source of truth.** It owns the open project, the SQLite connection
  and the sidecar process. Neither the UI nor the sidecar writes to the database except through
  the core. The one possible exception is bulk table writes from the sidecar, which the core
  must coordinate explicitly.
- **One command layer.** Every user action (import table, create relation, train model, ...)
  is a Rust function. The Tauri commands and the MCP tools are thin wrappers over it. Never
  implement a feature only in the UI if an AI agent should be able to do it too, which is
  almost everything.
- **The Python sidecar is stateless between calls** where practical. It receives data and
  parameters and returns results or serialised models. Long jobs (training, optimisation)
  report progress and can be cancelled.
- **The UI holds view state only** (layout, open tabs, selection). Domain state comes from
  the core.

## UI layout (VS Code-like)

- Menu bar at the top.
- **Main area**: tabbed documents (tables, relation model, P&ID, plots, models, simulations).
- **Left and right tool panels**: each holds tabbed tool windows that can be shown/hidden
  and collapsed/expanded. Persist the layout per user (and optionally per project).
- **Startup**: if a project was open when the app closed, it is reopened. Otherwise the window
  shows only a start screen (new, open, recent projects); the user must **create or open a
  project** before the workspace becomes available.
- **Resume state**: window size/position/maximised (`tauri-plugin-window-state`, saved on exit),
  the last open project, recent projects, and each project's open tabs (dockview layout, saved
  on every change, keyed by project path). See `workspace/session.ts`. This is per-user view
  state in the webview's local storage, not in the project file. File → Close Project clears
  "last project", so the next start shows the start screen.
- Right tool windows (Properties, Batches, Plot) show content published by the **active** main-area
  tab through `workspace/inspector.ts` (keyed by its dockview panel id, e.g. "plots"). Tabs the
  active view does not fill are hidden; Jobs is always shown. Views republish on every render, so
  the workspace only re-renders when the set of filled slots changes.
- Panels restored from a saved layout only get ids as params (e.g. `{ tableId }`); views look up
  current data from `WorkspaceContext`, never from stored params.
- Use an established docking library (e.g. dockview) instead of a custom docking system.

## Domain model and terminology

- **Project**: one `.sqlite` file containing everything below.
- **Table**: imported data (CSV/XLSX). Keep the source file name and import settings so the
  table can be re-imported.
- **Relation**: a key-column link between two tables (a tabular model, like Power BI).
- **Production**: one production run (batch or campaign). Most data is tied to a production.
  Plots normally show **one production at a time**. A comparison mode overlays several
  productions aligned at **t = 0**.
- **Variable**: a column with a role:
  - `input`: either **manipulable** (operator can set it, e.g. temperature setpoint) or
    **non-manipulable** (given, e.g. raw material composition).
  - `output`: a result to model (e.g. density, contaminant concentration).
  - Inputs have **bounds** (min/max, e.g. pump capacity). Optimisation must respect them.
- **P&ID**: a diagram for illustration. Elements (vessels, columns, pumps, instruments,
  streams) can be linked to variables, and can show small live/model plots.
- **Process dynamics**: processes are batch, continuous or (usually) mixed.
  - *Continuous relations*: an output responds to an input after a **time delay** (e.g.
    column temperature → product density at the outlet). The delay is a model parameter that
    can be optimised within a user-set interval during training.
  - *Accumulated/batch relations*: a measurement represents an aggregate over a time window
    (e.g. a tank sample reflects the average composition during filling). Features must be
    built by aggregating the input time series over that window.
- **Model**: an ML model (linear/polynomial regression, neural network, ...) with
  pre-treatment steps (polynomial features, categorical encoding, scaling, delays/aggregation).
  Store the model definition, trained artefact, training data selection and metrics.
- **Scenario / simulation**: user-defined input trajectories. Setpoints as a function of
  time, linearly interpolated between points, fed through a model.
- **Optimisation**: find manipulable input values/trajectories within bounds that minimise a
  cost function (e.g. contaminant, negative production rate, or a weighted combination).

## Conventions

- Windows is the only target platform for now. Use cross-platform paths (`std::path`,
  `pathlib`) all the same.
- Store timestamps in UTC as ISO 8601 or epoch milliseconds. Convert to local time only in the UI.
- Change the SQLite schema only through numbered migrations in the Rust core. Never edit an
  existing migration.
- Keep the Tauri/MCP command signatures and the sidecar JSON-RPC messages typed on both sides
  (Rust structs ↔ TypeScript types ↔ Python dataclasses/pydantic). Update all three together.
- Write tests for domain logic in Rust and Python, especially delay handling, aggregation
  windows, interpolation and optimisation constraints.

## Repository layout

```
src/                    React frontend
  api/backend.ts          typed wrappers for every Tauri command (mirror of commands.rs)
  start/                  start screen (new/open project)
  import/                 ImportDialog (preview + column settings)
  tables/                 TableView (virtualized, paged grid), ColumnTypeDialog
  models/                 Models view: ModelsView (list), ModelEditor (5 steps), ModelResults,
                          ModelBatchesPanel (right-panel tab)
  simulation/             Simulation view: SimulationView (list), SimulationEditor (model, time,
                          input setpoint profiles, run, result plots), OptimisePanel (step 5)
  plots/                  Plots view: PlotsView (sheet, data loading, cards), PlotChart (uPlot),
                          BatchesPanel / PlotSettingsPanel (right-panel tabs), data.ts (batch merge)
  pid/                    P&ID editor: symbols.tsx (symbol library + handle rotation), model.ts
                          (Diagram <-> React Flow), nodes.tsx, PidEditor.tsx, PidProperties.tsx
  workspace/              shell: MenuBar, ToolPanel (left/right tool windows), ExplorerTool,
                          views.tsx (main-area tabs + dockview component registry),
                          WorkspaceContext (project, tables, showTool), inspector.ts (right-panel
                          slots: properties / batches / plot),
                          session.ts (resume state: last/recent projects, tab layouts)
src-tauri/src/          Rust core
  domain/                 domain logic; db.rs holds the SQLite migrations
    import/               CSV/spreadsheet import: source.rs (reading, encoding/delimiter
                          detection), convert.rs (type inference, number/date parsing, DST)
    tables.rs             catalog + row access for imported tables (all data_<id> SQL lives here)
    pid.rs                P&ID diagrams: load, validate and save
    plots.rs              plot sheets + batch list and batch-aligned series queries
    column_type.rs        change a column's type in place (keeps table id and column position)
    models.rs             ML model definitions, training-request assembly, stored results
    simulations.rs        what-if simulations and input optimisation: settings, input profiles,
                          request assembly, results
  commands.rs             thin Tauri command wrappers (async, so they stay off the UI thread)
  sidecar.rs              JSON-RPC client for the Python sidecar
  state.rs                AppState: open project + sidecar process
  error.rs                AppError, serialised to the UI as { kind, message }
sidecar/                Python data/ML engine
  src/digitaltwin_sidecar/  rpc.py (protocol), methods.py (method registry), features.py (delay +
                            Gaussian smoothing), training.py (linear / MLP per output),
                            simulation.py (Simulator: input profiles through a trained model),
                            optimisation.py (manipulable inputs within bounds, scipy)
  tests/
```

Data files live outside the repo, in `C:\data_area\DigitalTwin\input_data\`. Never commit plant
data. Tests generate their own input files.

`sample_data\` holds synthetic sample files (SCADA log, batch metadata, QC results) produced by a
separate project. Do not generate sample data from this repo.

Project files use the extension `.dtwin` (a SQLite database inside).

### Imported tables

- Catalog: `data_table` (name, source path, import options as JSON) and `data_column`
  (name, kind). Rows live in `data_<id>` with columns `c0, c1, ...` in catalog order plus
  `_row INTEGER PRIMARY KEY` for import order. Types: number → REAL, text → TEXT,
  datetime → INTEGER epoch ms UTC. User-facing names never appear in SQL identifiers.
- Import runs in one transaction. Unparseable cells become NULL and are reported as warnings.
- Local timestamps are converted with the chosen IANA zone. In the repeated autumn DST hour the
  earlier instant is used unless that would not move the series forward (sequential logs). In the
  skipped spring hour the time is shifted +1 h. Both are counted in the warnings.
- Throughput: ~1M rows × 6 columns in under 2 s (release). Check with
  `cargo test --release -- --ignored large_import`.

### P&ID

- Built on React Flow (`@xyflow/react`). One diagram per project for now (`pid_get` creates it),
  but the schema (`pid_diagram`, `pid_element`, `pid_connection`) allows several.
- The editor autosaves the whole diagram (debounced) with `pid_save`, which validates and replaces
  all elements and connections in one transaction.
- Element ids are client-generated strings. `width`/`height` are the displayed size (already
  swapped for 90°/270° rotation); symbols are drawn unrotated and rotated inside the node.
- Symbol kinds must match in `ELEMENT_KINDS` (`pid.rs`) and `SYMBOLS` (`symbols.tsx`). A new
  symbol needs a size, handles (side + position 0..1) and a `draw` function.
- Lines touching an instrument default to `signal` (dashed), others to `process` (arrow).
- Instruments link to a data column via `(table_id, column_ordinal)`. The FK clears the link when
  the table is deleted, and the editor drops links to missing columns before saving.
- The editor publishes its selection to the Properties tool window through `workspace/inspector.ts`.
- Undo/redo: whole-diagram snapshots taken before each change (Ctrl+Z, Ctrl+Y; R / Shift+R rotate).

### Changing column types

- Table view: click the type next to a column name. `table_convert_column` re-parses the values
  (text -> date/time with a detected or given format and time zone, text <-> number, ...) and
  rebuilds the SQL column in place (add, fill, drop old, rename), so the table id and column
  position, and therefore P&ID and plot links, stay valid. It also updates the stored import options.
- Unconvertible values become NULL and are reported. Indexes on the column are dropped first.

### Plots

- Charts use uPlot. One plot sheet per project (`plot_sheet`, config as one JSON document
  validated by `domain/plots.rs`): source (table, batch column or none, time column), selected
  batches, layout (stacked / pairs), plot height, overlaid simulation ids,
  plots (title, series columns + colours, optional y min/max). Autosaved like the P&ID.
- `plot_batches` lists batches (creates an index on the batch column); `plot_batch_series` returns
  one batch's numeric columns with time in hours since the batch's first sample (t = 0).
- Batches are merged onto one shared, non-decreasing x axis (`plots/data.ts`). Duplicate time
  stamps within a batch are allowed, so do not use `uPlot.join` (it merges equal x values).
  Lines span the other batches' null positions; legends show each line's nearest sample.
- Simulation overlays: a selected simulation with a result whose model uses the sheet's table is
  drawn like another batch (from t = 0), only in plots of columns it has (its model's inputs and
  outputs), labelled "Sim <name>". `simulations_list` gives each simulation's table; results are
  fetched with `simulation_get` and cached per run time. The list refreshes when the tab is activated.
- Colour = batch (or simulation) when several are shown (dashes then tell columns apart), else the column.
- The view publishes the right-panel "Batches" and "Plot" tabs via `inspector.ts`; selecting or
  adding a plot calls `showTool("plot")`.

### Models

- A model (`model` table, migration 5) = one source table (batch + time columns), input and output
  columns, a delay `delayMin` and Gaussian spread `sigmaMin` (minutes) for every input/output
  pair, an algorithm (linear or neural network) and the training batches.
- Features: for an output sample at time t, each input is the Gaussian-weighted average of the
  input centred at t - delay (window +-3 sigma; sigma = 0 means interpolated value at t - delay).
  Rows whose window does not fit inside the batch are dropped. Duplicate time stamps are averaged
  before smoothing. See `sidecar/.../features.py`.
- Each pair has `enabled` (default true). Unticking it ("no effect", e.g. an input downstream of
  the output in the process) leaves that input out of that output's model. Every output needs at
  least one connected input (checked in `training_request` and in the sidecar).
- One scikit-learn model per output (each output has its own feature set), wrapped in input and
  target standardisation. Linear = OLS (coefficients reported in original units); neural
  network = `MLPRegressor` (hidden layers, activation, alpha, max iterations).
- The right-panel "Batches" tab (`ModelBatchesPanel`) holds the training batches, the test share and
  the batch shown in the results plots (view state only, defaults to the first trained batch).
- Validation: the last `testFraction` (default 20 %) of every selected batch's duration is test
  data. Results: R2 / RMSE train and test per output, measured vs predicted series (thinned to
  2000 points per batch), linear coefficients, warnings (e.g. no convergence).
- `model_train`: the core builds the request under the project lock (`training_request`),
  calls the sidecar without it, then stores result + base64 pickled artifact + the trained
  definition (`store_training`). `stale` = definition changed since training. A failed run keeps
  the previous result and sets status "failed".
- Not yet: delay optimisation within an interval, polynomial/categorical pre-treatment, progress
  and cancel for long trainings, predicting batches that were not trained on.

### Simulations

- A simulation (`simulation` table, migration 6) = a model, a duration (h), an output time step
  (min) and one profile per model input: `fixed` (one value) or `points` (setpoints at hours since
  start, linear in between, held before the first and after the last; two setpoints at the same
  time give a step). New simulations use the most recently trained model with every input fixed at
  its mean in the source table.
- The **trained** model version is simulated (`models::trained`: trained config + artifact), even
  if the definition changed since; the editor warns about that.
- Sidecar `simulate`: inputs are sampled on the step grid from before t = 0 (held at their t = 0
  value) until after the end, so every delay/smoothing window is defined and the output exists
  from t = 0. Warns when a profile leaves an input's measured range (extrapolation).
- `simulation_run` works like `model_train`: `run_request` under the lock, sidecar call without it,
  `store_run`. `stale` = settings changed or the model was retrained since the run (the
  optimisation settings do not count).

### Optimisation

- Part of a simulation (`config.optimisation`; result columns from migration 7). Manipulable inputs
  and their bounds are chosen **per simulation** for now (default bounds: the measured range), not
  as a project-wide variable classification yet.
- Decision variables: a fixed input's value, or the value at each of a setpoint input's setpoints
  (times fixed); max 60. Other inputs keep their profiles.
- Cost (sidecar `optimisation.py`): sum over outputs with a goal of weight x (minimise: m,
  maximise: -m, target: (m - target)^2) with m = mean over the simulation or value at the end, scaled
  by the output's measured range. Output limits (min/max at all times) add 1000 x the scaled worst
  violation (an exact penalty, so optima sit on a limit, not past it; met = violation <= 1e-4).
- Solver: scipy `differential_evolution` (seed 0, starts from the current setpoints, L-BFGS-B
  polish), stopped by a time budget (default 30 s). The result holds the optimised profiles,
  objective values before/after, and baseline and optimised runs for the comparison plots.
  "Apply optimised setpoints and run" copies the manipulable inputs' profiles into the setpoints.
- Simulator evaluations are ~1 ms for an 8 h run at 1-minute steps with a small MLP.


### Adding a feature end to end

1. Domain logic in `src-tauri/src/domain/` (plus a migration in `db.rs` if the schema changes).
2. Command wrapper in `commands.rs` → register it in `lib.rs` → typed wrapper in `src/api/backend.ts`.
3. If it needs Python: a function in `sidecar/.../methods.py`, registered in `METHODS`, called via
   `Sidecar::call`.
4. UI: a singleton main-area view goes in `VIEWS` (`views.tsx`); a per-item view (like a table)
   gets a component key in `VIEW_COMPONENTS`; a tool window goes in `leftTools` or `RIGHT_TOOLS`
   (`Workspace.tsx`).

## Commands

Run from the repo root (Windows; npm scripts use `.venv\Scripts`).

| Task | Command |
|---|---|
| First-time setup | `npm install` then `npm run sidecar:setup` |
| Run the app (dev, hot reload) | `npm run tauri dev` |
| Build the installer | `npm run tauri build` (NSIS + MSI) |
| All tests + type check | `npm test` |
| Rust tests only | `npm run test:rust` |
| Python tests only | `npm run test:py` |
| Python lint/format | `cd sidecar; .venv\Scripts\python -m ruff check --fix .; .venv\Scripts\python -m ruff format .` |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml` |

In dev, the core starts the sidecar on first use with `sidecar/.venv` Python (falling back to
`python` on PATH) and `PYTHONPATH=sidecar/src`. Python code changes need an app restart,
or the sidecar must be killed.

## Gotchas

- rusqlite 0.40 has no `usize` conversion. Use `i64` for SQL integers.
- dockview: use the `dockview-react` package (v8 `dockview` is framework-agnostic core only).
- The sidecar's stdout carries the JSON-RPC stream only. Log to stderr.
- Sidecar dependencies (numpy, scikit-learn) are in `sidecar/pyproject.toml`; `npm run
  sidecar:setup` installs them. Python method errors keep the sidecar running; it is only
  restarted when its process has died (`call_sidecar` in `commands.rs`).
- CSV is split by our own `split_record` (`import/source.rs`), not the `csv` crate. The crate's
  record line numbers and byte offsets are wrong with CRLF line endings and blank lines, and
  warnings need exact line numbers.
- Commands lock the project mutex for their whole run, so a long import blocks other project
  commands until it finishes.
- The window has `dragDropEnabled: false` (`tauri.conf.json`). Tauri's file drop handling
  otherwise swallows HTML5 drag-and-drop on Windows, which the P&ID palette uses.
- Model artifacts are pickles and `simulate` unpickles them, so running a simulation in a project
  file from an untrusted source can execute code. Only open project files you trust.
- System Python defaults to cp1252 here. Scripts that edit repo files must use
  `encoding="utf-8"` (or Node), or non-ASCII characters get corrupted.

## Not yet implemented

- MCP server (planned: embedded in the app, wrapping the same domain functions as `commands.rs`).
- Sidecar packaging for release builds (`Sidecar::spawn` only handles dev).
- Long-running sidecar jobs with progress/cancel (the current client is a blocking request/response;
  training runs synchronously and reports no progress).
- Import: cancel, re-import from the stored options, appending to an existing table.
- Plots: several plot sheets, x-axis zoom shared across plots, relations to other tables
  (e.g. QC results per batch), model predictions for measured batches.
- Simulation: starting from a measured batch's state/history, comparing several scenarios in one
  plot. Optimisation: optimising setpoint times, rate-of-change limits on inputs, a project-wide
  manipulable/bounds classification (Variables tool), progress and cancel.

## Open decisions

- Python sidecar packaging (PyInstaller vs embedded Python distribution) and environment
  management (uv recommended but not installed yet; plain venv + pip works today).
- MCP transport for the embedded server (stdio via a launcher vs local HTTP/SSE).
- Data tables are in SQLite (fine up to ~1M rows per table). If much larger data appears, move
  storage behind `domain/tables.rs` (e.g. to Parquet) without changing callers.
