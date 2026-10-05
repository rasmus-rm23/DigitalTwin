//! Tauri command wrappers. Keep these thin — logic belongs in `domain`.
//! Commands are `async` so they run off the UI thread.

use std::path::PathBuf;

use serde_json::Value;
use tauri::State;

use crate::domain::project::{Project, ProjectInfo};
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
