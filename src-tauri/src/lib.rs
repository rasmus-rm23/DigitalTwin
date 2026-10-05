mod commands;
pub mod domain;
pub mod error;
mod sidecar;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::project_create,
            commands::project_open,
            commands::project_close,
            commands::project_current,
            commands::sidecar_ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
