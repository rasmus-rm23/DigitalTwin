//! Tauri command wrappers. Keep these thin — logic belongs in `domain`.
//! Commands are `async` so they run off the UI thread.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::domain::import::{self, ImportOptions, ImportResult, Preview, PreviewSettings};
use crate::domain::column_type::{self, ColumnConversion, ConversionResult};
use crate::domain::models::{self, Model, ModelConfig, ModelSummary};
use crate::domain::pid::{self, Diagram};
use crate::domain::plots::{self, BatchInfo, BatchSeries, PlotSheet, PlotSource};
use crate::domain::project::{Project, ProjectInfo};
use crate::domain::tables::{self, TableInfo};
use crate::error::{AppError, AppResult};
use crate::sidecar::Sidecar;
use crate::state::AppState;

#[tauri::command]
pub async fn project_create(
    state: State<'_, AppState>,
    path: PathBuf,
    name: String,
) -> AppResult<ProjectInfo> {
    let project = Project::create(&path, &name)?;
    let info = project.info()?;
    *state.project.lock().unwrap() = Some(project);
    Ok(info)
}

#[tauri::command]
pub async fn project_open(state: State<'_, AppState>, path: PathBuf) -> AppResult<ProjectInfo> {
    let project = Project::open(&path)?;
    let info = project.info()?;
    *state.project.lock().unwrap() = Some(project);
    Ok(info)
}

#[tauri::command]
pub async fn project_close(state: State<'_, AppState>) -> AppResult<()> {
    state.project.lock().unwrap().take();
    Ok(())
}

#[tauri::command]
pub async fn project_current(state: State<'_, AppState>) -> AppResult<Option<ProjectInfo>> {
    state.project.lock().unwrap().as_ref().map(Project::info).transpose()
}

/// Runs `f` against the open project, or fails with `NoProject`.
fn with_project<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Project) -> AppResult<T>,
) -> AppResult<T> {
    let mut guard = state.project.lock().unwrap();
    f(guard.as_mut().ok_or(AppError::NoProject)?)
}

#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    path: PathBuf,
    settings: PreviewSettings,
) -> AppResult<Preview> {
    with_project(&state, |p| import::preview(&p.conn, &path, settings))
}

/// Emits `import-progress` events with the number of rows written so far.
#[tauri::command]
pub async fn import_run(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    options: ImportOptions,
) -> AppResult<ImportResult> {
    with_project(&state, |p| {
        import::run(&mut p.conn, &path, &options, |rows| {
            let _ = app.emit("import-progress", rows);
        })
    })
}

#[tauri::command]
pub async fn tables_list(state: State<'_, AppState>) -> AppResult<Vec<TableInfo>> {
    with_project(&state, |p| tables::list(&p.conn))
}

#[tauri::command]
pub async fn table_rows(
    state: State<'_, AppState>,
    id: i64,
    offset: i64,
    limit: i64,
) -> AppResult<Vec<Vec<Value>>> {
    with_project(&state, |p| tables::rows(&p.conn, id, offset, limit))
}

#[tauri::command]
pub async fn table_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    with_project(&state, |p| tables::delete(&mut p.conn, id))
}

/// The project's main P&ID (created empty on first call).
#[tauri::command]
pub async fn pid_get(state: State<'_, AppState>) -> AppResult<Diagram> {
    with_project(&state, |p| pid::get_or_create_main(&p.conn))
}

#[tauri::command]
pub async fn pid_save(state: State<'_, AppState>, diagram: Diagram) -> AppResult<()> {
    with_project(&state, |p| pid::save(&mut p.conn, &diagram))
}

#[tauri::command]
pub async fn table_convert_column(
    state: State<'_, AppState>,
    id: i64,
    ordinal: i64,
    conversion: ColumnConversion,
) -> AppResult<ConversionResult> {
    with_project(&state, |p| column_type::convert_column(&mut p.conn, id, ordinal, &conversion))
}

/// The project's plot sheet (created empty on first call).
#[tauri::command]
pub async fn plot_sheet_get(state: State<'_, AppState>) -> AppResult<PlotSheet> {
    with_project(&state, |p| plots::get_or_create_main(&p.conn))
}

#[tauri::command]
pub async fn plot_sheet_save(state: State<'_, AppState>, sheet: PlotSheet) -> AppResult<()> {
    with_project(&state, |p| plots::save(&p.conn, &sheet))
}

#[tauri::command]
pub async fn plot_batches(state: State<'_, AppState>, source: PlotSource) -> AppResult<Vec<BatchInfo>> {
    with_project(&state, |p| plots::batches(&p.conn, &source))
}

#[tauri::command]
pub async fn plot_batch_series(
    state: State<'_, AppState>,
    source: PlotSource,
    batch: String,
    columns: Vec<i64>,
) -> AppResult<BatchSeries> {
    with_project(&state, |p| plots::batch_series(&p.conn, &source, &batch, &columns))
}

#[tauri::command]
pub async fn sidecar_ping(state: State<'_, AppState>) -> AppResult<Value> {
    call_sidecar(&state, "ping", Value::Null)
}

/// Calls the Python sidecar, starting it on first use. A sidecar whose process died is
/// dropped so the next call restarts it; ordinary method errors keep it running.
fn call_sidecar(state: &State<'_, AppState>, method: &str, params: Value) -> AppResult<Value> {
    let mut guard = state.sidecar.lock().unwrap();
    if guard.is_none() {
        *guard = Some(Sidecar::spawn()?);
    }
    let sidecar = guard.as_mut().unwrap();
    let result = sidecar.call(method, params);
    if result.is_err() && !sidecar.is_alive() {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn models_list(state: State<'_, AppState>) -> AppResult<Vec<ModelSummary>> {
    with_project(&state, |p| models::list(&p.conn))
}

#[tauri::command]
pub async fn model_get(state: State<'_, AppState>, id: i64) -> AppResult<Model> {
    with_project(&state, |p| models::get(&p.conn, id))
}

#[tauri::command]
pub async fn model_create(state: State<'_, AppState>, name: String) -> AppResult<Model> {
    with_project(&state, |p| models::create(&p.conn, &name))
}

#[tauri::command]
pub async fn model_save(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    config: ModelConfig,
) -> AppResult<Model> {
    with_project(&state, |p| models::save(&p.conn, id, &name, &config))
}

#[tauri::command]
pub async fn model_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    with_project(&state, |p| models::delete(&p.conn, id))
}

/// Trains a model in the sidecar. The project is only locked while assembling the data and
/// storing the result, not during training. Validation errors are returned as errors;
/// training failures are stored on the model (status "failed") and returned with it.
#[tauri::command]
pub async fn model_train(state: State<'_, AppState>, id: i64) -> AppResult<Model> {
    let (config, request) = with_project(&state, |p| models::training_request(&p.conn, id))?;
    let outcome = call_sidecar(&state, "train", request);
    with_project(&state, |p| models::store_training(&p.conn, id, &config, outcome))
}
