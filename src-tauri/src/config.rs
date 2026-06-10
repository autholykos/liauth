use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct VimConfig {
    pub path: String,
    pub content: String,
}

/// Locate the user's vim configuration. A dedicated Liauth file wins so
/// users can keep a curated, fully-supported subset; otherwise fall back
/// to their real vimrc (vimscript only — init.lua can't be parsed).
#[tauri::command]
pub fn read_vim_config() -> Option<VimConfig> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let candidates = [
        home.join(".config/liauth/vimrc"),
        home.join(".vimrc"),
        home.join(".config/nvim/init.vim"),
    ];
    for path in candidates {
        if let Ok(content) = fs::read_to_string(&path) {
            return Some(VimConfig {
                path: path.display().to_string(),
                content,
            });
        }
    }
    None
}
