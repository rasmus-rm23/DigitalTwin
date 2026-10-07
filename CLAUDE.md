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
- **Startup**: a new window shows only a start screen. The user must **create a new project
  or open an existing one** before the workspace becomes available.
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
  tables/                 TableView (virtualized, paged grid)
  workspace/              shell: MenuBar, ToolPanel (left/right tool windows), ExplorerTool,
                          views.tsx (main-area tabs + dockview component registry)
src-tauri/src/          Rust core
  domain/                 domain logic; db.rs holds the SQLite migrations
    import/               CSV/spreadsheet import: source.rs (reading, encoding/delimiter
                          detection), convert.rs (type inference, number/date parsing, DST)
    tables.rs             catalog + row access for imported tables (all data_<id> SQL lives here)
  commands.rs             thin Tauri command wrappers (async, so they stay off the UI thread)
  sidecar.rs              JSON-RPC client for the Python sidecar
  state.rs                AppState: open project + sidecar process
  error.rs                AppError, serialised to the UI as { kind, message }
sidecar/                Python data/ML engine
  src/digitaltwin_sidecar/  rpc.py (protocol), methods.py (method registry)
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
- CSV is split by our own `split_record` (`import/source.rs`), not the `csv` crate. The crate's
  record line numbers and byte offsets are wrong with CRLF line endings and blank lines, and
  warnings need exact line numbers.
- Commands lock the project mutex for their whole run, so a long import blocks other project
  commands until it finishes.

## Not yet implemented

- MCP server (planned: embedded in the app, wrapping the same domain functions as `commands.rs`).
- Sidecar packaging for release builds (`Sidecar::spawn` only handles dev).
- Long-running sidecar jobs with progress/cancel (the current client is a blocking request/response).
- Import: cancel, re-import from the stored options, appending to an existing table.

## Open decisions

- Specific libraries: plotting (e.g. Plotly vs ECharts vs uPlot for large time series),
  P&ID editor (e.g. React Flow).
- Python sidecar packaging (PyInstaller vs embedded Python distribution) and environment
  management (uv recommended but not installed yet; plain venv + pip works today).
- MCP transport for the embedded server (stdio via a launcher vs local HTTP/SSE).
- Data tables are in SQLite (fine up to ~1M rows per table). If much larger data appears, move
  storage behind `domain/tables.rs` (e.g. to Parquet) without changing callers.
