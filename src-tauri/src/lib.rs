mod config;
mod git;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// File-open requests from the OS (Finder "Open with", double-click on an
/// associated .md). Stored as well as emitted because the open event can
/// arrive before the frontend has registered its listener.
struct PendingOpen(Mutex<Option<String>>);

#[tauri::command]
fn take_pending_open(state: tauri::State<PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PendingOpen(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            git::repo_info,
            git::init_repo,
            git::read_document,
            git::save_document,
            git::file_history,
            git::file_at_commit,
            git::list_branches,
            git::create_branch,
            git::checkout_branch,
            git::merge_branch,
            git::abort_merge,
            git::merge_contents,
            config::read_vim_config,
            take_pending_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                if let Some(path) = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.display().to_string())
                    .next()
                {
                    *app.state::<PendingOpen>().0.lock().unwrap() = Some(path.clone());
                    let _ = app.emit("open-file", path);
                }
            }
        });
}
