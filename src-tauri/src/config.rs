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

/// Save the vim config. Always writes the dedicated Liauth file — never a
/// fallback (~/.vimrc), so editing inside Liauth can't clobber the user's
/// real vim setup. Since the Liauth file wins on lookup, saving content
/// that was loaded from a fallback effectively forks it.
#[tauri::command]
pub fn write_vim_config(content: String) -> Result<VimConfig, String> {
    let home =
        PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?);
    let path = home.join(".config/liauth/vimrc");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(VimConfig {
        path: path.display().to_string(),
        content,
    })
}
