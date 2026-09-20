use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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

/// Liauth's own config directory, created on demand.
fn config_dir() -> Result<PathBuf, String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?);
    let dir = home.join(".config/liauth");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Save the vim config. Always writes the dedicated Liauth file — never a
/// fallback (~/.vimrc), so editing inside Liauth can't clobber the user's
/// real vim setup. Since the Liauth file wins on lookup, saving content
/// that was loaded from a fallback effectively forks it.
#[tauri::command]
pub fn write_vim_config(content: String) -> Result<VimConfig, String> {
    let path = config_dir()?.join("vimrc");
    fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(VimConfig {
        path: path.display().to_string(),
        content,
    })
}

/// Overwrite `path` readable by its owner only, whatever the umask, and
/// tighten a file that already exists with looser permissions.
fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct TypeSafeStatus {
    pub configured: bool,
    pub from_environment: bool,
}

pub(crate) fn typesafe_key() -> Result<Option<String>, String> {
    if let Ok(key) = std::env::var("TYPESAFE_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(Some(key.trim().to_owned()));
        }
    }
    let path = config_dir()?.join("typesafe-key");
    match fs::read_to_string(path) {
        Ok(key) => Ok((!key.trim().is_empty()).then(|| key.trim().to_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read the TypeSafe API key".into()),
    }
}

#[tauri::command]
pub fn typesafe_status() -> Result<TypeSafeStatus, String> {
    Ok(TypeSafeStatus {
        configured: typesafe_key()?.is_some(),
        from_environment: std::env::var("TYPESAFE_API_KEY").is_ok_and(|key| !key.trim().is_empty()),
    })
}

#[tauri::command]
pub fn write_typesafe_key(api_key: String) -> Result<TypeSafeStatus, String> {
    let path = config_dir()?.join("typesafe-key");
    store_typesafe_key(&path, &api_key)?;
    typesafe_status()
}

fn store_typesafe_key(path: &Path, api_key: &str) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Could not remove the TypeSafe API key".into()),
        }
    } else {
        if key.len() > 4096 || key.chars().any(char::is_whitespace) {
            return Err("Enter a valid TypeSafe API key".into());
        }
        write_private(path, key).map_err(|_| "Could not save the TypeSafe API key")?;
    }
    Ok(())
}

/// Dump of the in-app key recorder (`:keylog`), one JSON object per line.
/// Each dump carries the whole ring buffer, so the file is overwritten. It
/// holds keystrokes, so it stays private to the user.
#[tauri::command]
pub fn write_keylog(content: String) -> Result<String, String> {
    let path = config_dir()?.join("keylog.jsonl");
    write_private(&path, &content)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typesafe_key_can_be_replaced_and_removed_without_writing_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("typesafe-key");
        store_typesafe_key(&path, " synthetic-one \n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "synthetic-one");
        assert!(store_typesafe_key(&path, "invalid key").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "synthetic-one");
        store_typesafe_key(&path, "synthetic-two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "synthetic-two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        store_typesafe_key(&path, "").unwrap();
        assert!(!path.exists());
        store_typesafe_key(&path, "").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_write_is_owner_only_even_over_a_looser_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keylog.jsonl");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_private(&path, "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
