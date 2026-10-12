mod commands;
pub mod domain;
pub mod error;
mod sidecar;
mod state;

use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Remembers window size, position and maximised state between runs.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::project_create,
            commands::project_open,
            commands::project_close,
            commands::project_current,
            commands::import_preview,
            commands::import_run,
            commands::tables_list,
            commands::table_rows,
            commands::table_delete,
            commands::pid_get,
            commands::pid_save,
            commands::table_convert_column,
            commands::plot_sheet_get,
            commands::plot_sheet_save,
            commands::plot_batches,
            commands::plot_batch_series,
            commands::sidecar_ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
