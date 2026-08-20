mod ai;
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
    has_notes: bool,
}

#[derive(serde::Serialize)]
struct ProjectFiles {
    root: String,
    name: String,
    files: Vec<ProjectFile>,
    truncated: bool,
}

fn is_markdown(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt"))
}

fn contains_block(text: &str, start: &str, end: &str) -> bool {
    text.match_indices(start)
        .any(|(i, _)| text[i + start.len()..].contains(end))
}

fn has_unresolved_notes(text: &str) -> bool {
    contains_block(text, "{==", "==}")
        || contains_block(text, "{>>", "<<}")
        || contains_block(text, "{++", "++}")
        || contains_block(text, "{--", "--}")
        || text.match_indices("{~~").any(|(i, _)| {
            let rest = &text[i + 3..];
            rest.find("~~}")
                .is_some_and(|end| rest[..end].contains("~>"))
        })
}

fn collect_markdown(
    dir: &std::path::Path,
    root: &std::path::Path,
    depth: usize,
    out: &mut Vec<ProjectFile>,
) -> bool {
    // Bounded so a navigator rooted in an unexpectedly huge tree stays cheap.
    if depth > 6 {
        return false;
    }
    if out.len() >= 500 {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for e in entries.flatten() {
        if out.len() >= 500 {
            return true;
        }
        if e.file_name().to_string_lossy().starts_with('.') {
            continue; // hidden files and .git
        }
        let p = e.path();
        if p.is_dir() {
            if collect_markdown(&p, root, depth + 1, out) {
                return true;
            }
        } else if is_markdown(&p) {
            let rel = p.strip_prefix(root).unwrap_or(&p).display().to_string();
            let has_notes = std::fs::read_to_string(&p)
                .map(|text| has_unresolved_notes(&text))
                .unwrap_or(false);
            out.push(ProjectFile {
                path: p.display().to_string(),
                rel,
                has_notes,
            });
        }
    }
    false
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
    let truncated = collect_markdown(&root, &root, 0, &mut files);
    // Root-level files first, then each subfolder as a group.
    files.sort_by(|a, b| {
        let dir = |f: &ProjectFile| {
            f.rel
                .rsplit_once('/')
                .map(|x| x.0.to_string())
                .unwrap_or_default()
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
        truncated,
    })
}

fn file_name(path: &std::path::Path) -> Result<&std::ffi::OsStr, String> {
    path.file_name()
        .ok_or_else(|| "file has no name".to_string())
}

fn destination_folder(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if path.is_dir() {
        return Ok(path.to_path_buf());
    }
    if path.is_file() {
        return path
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| "destination has no parent folder".to_string());
    }
    Err("destination no longer exists".to_string())
}

struct TrackedFile {
    repo: git2::Repository,
    rel: std::path::PathBuf,
}

fn tracked_file(path: &std::path::Path) -> Option<TrackedFile> {
    let repo = git2::Repository::discover(path.parent()?).ok()?;
    let root = std::fs::canonicalize(repo.workdir()?).ok()?;
    let file = std::fs::canonicalize(path).ok()?;
    let rel = file.strip_prefix(root).ok()?.to_path_buf();
    repo.index().ok()?.get_path(&rel, 0)?;
    Some(TrackedFile { repo, rel })
}

fn stage_destination(
    tracked: Option<TrackedFile>,
    destination: &std::path::Path,
    remove_source: bool,
) {
    let Some(TrackedFile { repo, rel }) = tracked else {
        return;
    };
    let Some(root) = repo.workdir().and_then(|p| std::fs::canonicalize(p).ok()) else {
        return;
    };
    let Some(new_rel) = std::fs::canonicalize(destination)
        .ok()
        .and_then(|p| p.strip_prefix(root).ok().map(std::path::Path::to_path_buf))
    else {
        return;
    };
    let Ok(mut index) = repo.index() else {
        return;
    };
    if (!remove_source || index.remove_path(&rel).is_ok()) && index.add_path(&new_rel).is_ok() {
        let _ = index.write();
    }
}

fn stage_delete(tracked: Option<TrackedFile>) {
    let Some(TrackedFile { repo, rel }) = tracked else {
        return;
    };
    let Ok(mut index) = repo.index() else {
        return;
    };
    if index.remove_path(&rel).is_ok() {
        let _ = index.write();
    }
}

fn unique_copy_path(source: &std::path::Path, folder: &std::path::Path) -> std::path::PathBuf {
    let direct = folder.join(file_name(source).unwrap_or_default());
    if !direct.exists() {
        return direct;
    }

    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let extension = source.extension().map(|x| x.to_string_lossy());
    for number in 1.. {
        let suffix = if number == 1 {
            " copy".to_string()
        } else {
            format!(" copy {number}")
        };
        let name = match &extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = folder.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[tauri::command]
fn rename_project_file(file_path: String, new_name: String) -> Result<String, String> {
    let source = std::path::Path::new(&file_path);
    if !source.is_file() {
        return Err("file no longer exists".to_string());
    }
    let new_name = new_name.trim();
    if new_name.is_empty()
        || matches!(new_name, "." | "..")
        || new_name.contains('/')
        || new_name.contains('\\')
    {
        return Err("enter a file name without a folder path".to_string());
    }
    let destination = source
        .parent()
        .ok_or_else(|| "file has no parent folder".to_string())?
        .join(new_name);
    if destination == source {
        return Ok(file_path);
    }
    if destination.exists() {
        let same_file =
            std::fs::canonicalize(&destination).ok() == std::fs::canonicalize(source).ok();
        if !same_file {
            return Err(format!("{new_name} already exists"));
        }
    }
    let tracked = tracked_file(source);
    std::fs::rename(source, &destination).map_err(|e| e.to_string())?;
    stage_destination(tracked, &destination, true);
    Ok(destination.display().to_string())
}

#[tauri::command]
fn paste_project_file(
    file_path: String,
    destination_path: String,
    cut: bool,
) -> Result<String, String> {
    let source = std::path::Path::new(&file_path);
    if !source.is_file() {
        return Err("copied file no longer exists".to_string());
    }
    let folder = destination_folder(std::path::Path::new(&destination_path))?;
    let same_folder = source.parent().and_then(|p| std::fs::canonicalize(p).ok())
        == std::fs::canonicalize(&folder).ok();
    if cut && same_folder {
        return Ok(file_path);
    }

    let destination = if cut {
        let target = folder.join(file_name(source)?);
        if target.exists() {
            return Err(format!("{} already exists", target.display()));
        }
        target
    } else {
        unique_copy_path(source, &folder)
    };
    if cut {
        let tracked = tracked_file(source);
        std::fs::rename(source, &destination).map_err(|e| e.to_string())?;
        stage_destination(tracked, &destination, true);
    } else {
        let tracked = tracked_file(source);
        std::fs::copy(source, &destination).map_err(|e| e.to_string())?;
        stage_destination(tracked, &destination, false);
    }
    Ok(destination.display().to_string())
}

#[tauri::command]
fn delete_project_file(file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    if !path.is_file() {
        return Err("file no longer exists".to_string());
    }
    let tracked = tracked_file(path);
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    stage_delete(tracked);
    Ok(())
}

/// Native print dialog. `window.print()` is a silent no-op in WKWebView,
/// so PDF export invokes this instead. On macOS the print operation is
/// built by hand because tauri's `Webview::print()` hardcodes zero page
/// margins (and WKWebView ignores CSS `@page` margins).
#[tauri::command]
fn print_page(webview: tauri::Webview) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview
            .with_webview(|pw| unsafe {
                let wk = &*(pw.inner() as *const objc2_web_kit::WKWebView);
                let info = objc2_app_kit::NSPrintInfo::sharedPrintInfo();
                // Points: ~15mm top/bottom, ~16mm sides.
                info.setTopMargin(42.0);
                info.setBottomMargin(42.0);
                info.setLeftMargin(45.0);
                info.setRightMargin(45.0);
                let op = wk.printOperationWithPrintInfo(&info);
                op.setCanSpawnSeparateThread(true);
                if let Some(window) = wk.window() {
                    op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        &window,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        webview.print().map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
fn disable_mac_press_and_hold() {
    // Vim navigation uses held keys; the native accent picker otherwise
    // appears over the editor instead of allowing key repeat.
    use objc2_foundation::{ns_string, NSUserDefaults};

    NSUserDefaults::standardUserDefaults()
        .setBool_forKey(false, ns_string!("ApplePressAndHoldEnabled"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    disable_mac_press_and_hold();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PendingOpen(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            print_page,
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
            ai::draft_note_edits,
            ai::warm_note_cache,
            ai::list_rephrase_skills,
            ai::rephrase_selection,
            take_pending_open,
            list_project_files,
            rename_project_file,
            paste_project_file,
            delete_project_file,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &std::path::Path) -> String {
        path.display().to_string()
    }

    #[test]
    fn detects_only_complete_critic_markup_notes() {
        for note in [
            "{==highlight==}",
            "{>>comment<<}",
            "{~~old~>new~~}",
            "{++addition++}",
            "{--deletion--}",
        ] {
            assert!(has_unresolved_notes(note), "note not detected: {note}");
        }
        assert!(!has_unresolved_notes("plain markdown"));
        assert!(!has_unresolved_notes("{>>unfinished"));
        assert!(!has_unresolved_notes("{~~missing arrow~~}"));
    }

    #[test]
    fn project_listing_marks_files_with_notes() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.md");
        let noted = dir.path().join("noted.md");
        std::fs::write(&plain, "No review comments here.\n").unwrap();
        std::fs::write(&noted, "A {>>review comment<<} here.\n").unwrap();

        let project = list_project_files(p(&plain)).unwrap();
        assert!(
            !project
                .files
                .iter()
                .find(|f| f.path == p(&plain))
                .unwrap()
                .has_notes
        );
        assert!(
            project
                .files
                .iter()
                .find(|f| f.path == p(&noted))
                .unwrap()
                .has_notes
        );
    }

    #[test]
    fn navigator_file_operations_preserve_content_and_avoid_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("draft.md");
        std::fs::write(&original, "draft content\n").unwrap();

        let renamed = rename_project_file(p(&original), "chapter.md".into()).unwrap();
        assert!(!original.exists());
        assert_eq!(
            std::fs::read_to_string(&renamed).unwrap(),
            "draft content\n"
        );

        let copied = paste_project_file(renamed.clone(), renamed.clone(), false).unwrap();
        assert_eq!(
            std::path::Path::new(&copied).file_name().unwrap(),
            "chapter copy.md"
        );
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "draft content\n");

        let destination = dir.path().join("subfolder");
        std::fs::create_dir(&destination).unwrap();
        let moved = paste_project_file(copied.clone(), p(&destination), true).unwrap();
        assert!(!std::path::Path::new(&copied).exists());
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "draft content\n");

        delete_project_file(moved.clone()).unwrap();
        assert!(!std::path::Path::new(&moved).exists());
        assert!(rename_project_file(renamed, "../escape.md".into()).is_err());
    }

    #[test]
    fn navigator_rename_and_delete_are_staged_for_the_next_save() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("draft.md");
        let other = dir.path().join("other.md");
        let original_path = p(&original);
        let other_path = p(&other);

        git::init_repo(original_path.clone()).unwrap();
        git::save_document(original_path.clone(), "draft\n".into(), None, true)
            .unwrap()
            .unwrap();
        git::save_document(other_path.clone(), "other\n".into(), None, true)
            .unwrap()
            .unwrap();

        let renamed = rename_project_file(original_path, "chapter.md".into()).unwrap();
        git::save_document(renamed.clone(), "draft\n".into(), None, true)
            .unwrap()
            .unwrap();

        let repo = git2::Repository::discover(dir.path()).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_path(std::path::Path::new("draft.md")).is_err());
        assert!(tree.get_path(std::path::Path::new("chapter.md")).is_ok());
        drop(tree);

        let copied = paste_project_file(renamed.clone(), renamed.clone(), false).unwrap();
        git::save_document(other_path.clone(), "other\n".into(), None, true)
            .unwrap()
            .unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree
            .get_path(std::path::Path::new("chapter copy.md"))
            .is_ok());
        assert_eq!(std::fs::read_to_string(copied).unwrap(), "draft\n");
        drop(tree);

        delete_project_file(renamed).unwrap();
        git::save_document(other_path, "other\n".into(), None, true)
            .unwrap()
            .unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_path(std::path::Path::new("chapter.md")).is_err());
        assert!(tree.get_path(std::path::Path::new("other.md")).is_ok());
    }
}
