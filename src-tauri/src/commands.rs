//! Tauri command wrappers. Keep these thin — logic belongs in `domain`.
//! Commands are `async` so they run off the UI thread.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::domain::import::{self, ImportOptions, ImportResult, Preview, PreviewSettings};
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

#[tauri::command]
pub async fn sidecar_ping(state: State<'_, AppState>) -> AppResult<Value> {
    let mut guard = state.sidecar.lock().unwrap();
    if guard.is_none() {
        *guard = Some(Sidecar::spawn()?);
    }
    let result = guard.as_mut().unwrap().call("ping", Value::Null);
    if matches!(result, Err(AppError::Sidecar(_)) | Err(AppError::Io(_))) {
        // Drop a broken sidecar so the next call restarts it.
        *guard = None;
    }
    result
}
