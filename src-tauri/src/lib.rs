mod config;
mod git;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
