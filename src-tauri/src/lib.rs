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

#[derive(serde::Serialize)]
struct ProjectFile {
    path: String,
    rel: String,
}

#[derive(serde::Serialize)]
struct ProjectFiles {
    root: String,
    name: String,
    files: Vec<ProjectFile>,
}

fn is_markdown(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| {
            matches!(x.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt")
        })
}

fn collect_markdown(
    dir: &std::path::Path,
    root: &std::path::Path,
    depth: usize,
    out: &mut Vec<ProjectFile>,
) {
    // Bounded so a navigator rooted in an unexpectedly huge tree stays cheap.
    if depth > 6 || out.len() >= 500 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with('.') {
            continue; // hidden files and .git
        }
        let p = e.path();
        if p.is_dir() {
            collect_markdown(&p, root, depth + 1, out);
        } else if is_markdown(&p) {
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .display()
                .to_string();
            out.push(ProjectFile {
                path: p.display().to_string(),
                rel,
            });
        }
    }
}

/// Markdown files of the document's project, for the navigator. The
/// project is the git repository containing the anchor (the same
/// boundary versioning uses); without one, just the anchor's folder.
/// The anchor may be a document path or a folder opened directly.
#[tauri::command]
fn list_project_files(file_path: String) -> Option<ProjectFiles> {
    let anchor = std::path::Path::new(&file_path);
    let parent = if anchor.is_dir() {
        anchor
    } else {
        anchor.parent()?
    };
    let root = git2::Repository::discover(parent)
        .ok()
        .and_then(|r| r.workdir().map(|w| w.to_path_buf()))
        .unwrap_or_else(|| parent.to_path_buf());
    let mut files = Vec::new();
    collect_markdown(&root, &root, 0, &mut files);
    // Root-level files first, then each subfolder as a group.
    files.sort_by(|a, b| {
        let dir = |f: &ProjectFile| {
            f.rel.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default()
        };
        dir(a).cmp(&dir(b)).then(a.rel.cmp(&b.rel))
    });
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    Some(ProjectFiles {
        root: root.display().to_string(),
        name,
        files,
    })
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
            config::write_vim_config,
            take_pending_open,
            list_project_files,
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
