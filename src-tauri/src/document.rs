use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const SAMPLE_BYTES: usize = 8192;

fn open_file(path: &Path) -> Result<File, String> {
    if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
        return Err("Choose a regular text file, not a folder or device".into());
    }
    File::open(path).map_err(|e| e.to_string())
}

pub(crate) fn text(bytes: &[u8]) -> Result<&str, String> {
    let value =
        std::str::from_utf8(bytes).map_err(|_| "The file is not valid UTF-8 text".to_string())?;
    if bytes.contains(&0) || bytes.starts_with(b"%PDF-") || bytes.starts_with(b"{\\rtf") {
        return Err("Binary or formatted documents cannot be opened as plain text".into());
    }
    Ok(value)
}

fn sample(bytes: &[u8]) -> Result<&str, String> {
    let prefix = &bytes[..bytes.len().min(SAMPLE_BYTES)];
    let end = match std::str::from_utf8(prefix) {
        Err(error) if bytes.len() > SAMPLE_BYTES && error.error_len().is_none() => {
            error.valid_up_to()
        }
        _ => prefix.len(),
    };
    text(&prefix[..end])
}

fn read_prefix(file: &mut File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take((SAMPLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Explicit opens accept text regardless of its name; validate the complete file.
pub(crate) fn read_text(path: &Path) -> Result<String, String> {
    let mut file = open_file(path)?;
    let mut bytes = read_prefix(&mut file)?;
    sample(&bytes)?;
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    text(&bytes)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Discovery/drop probing is bounded; opening always performs full validation.
pub(crate) fn probe_text(path: &Path) -> Result<String, String> {
    let mut file = open_file(path)?;
    let bytes = read_prefix(&mut file)?;
    sample(&bytes).map(str::to_owned)
}

fn name_hint(path: &Path) -> Option<bool> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if [
        "md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdx", "rmd", "qmd", "txt", "text",
    ]
    .contains(&extension.as_str())
    {
        return Some(true);
    }
    let name = path.file_name()?.to_str()?.to_ascii_uppercase();
    if [
        "README",
        "CHANGELOG",
        "CHANGES",
        "LICENSE",
        "LICENCE",
        "COPYING",
        "NOTICE",
        "AUTHORS",
        "CONTRIBUTING",
        "INSTALL",
        "TODO",
        "NOTES",
        "FAQ",
    ]
    .iter()
    .any(|stem| {
        name == *stem
            || name.starts_with(&format!("{stem}."))
            || name.starts_with(&format!("{stem}-"))
    }) {
        return Some(true);
    }
    // These files are still available through an explicit open. Avoid filling
    // the document navigator (and Save all) with code, configuration or assets.
    if [
        "MAKEFILE",
        "DOCKERFILE",
        "JUSTFILE",
        ".GITIGNORE",
        ".GITATTRIBUTES",
        ".GITMODULES",
        ".EDITORCONFIG",
        ".ENV",
        ".BASHRC",
        ".ZSHRC",
        ".PROFILE",
        ".NPMRC",
    ]
    .contains(&name.as_str())
        || name.starts_with(".ENV.")
        || [
            "rs", "py", "js", "jsx", "ts", "tsx", "go", "c", "h", "cpp", "hpp", "java", "rb", "sh",
            "zsh", "fish", "json", "jsonl", "toml", "yaml", "yml", "ini", "cfg", "conf", "lock",
            "html", "xml", "svg", "css", "csv", "pdf", "rtf", "png", "jpg", "jpeg", "gif", "webp",
            "ico", "zip", "gz", "o", "a", "rlib", "rmeta", "so", "dylib", "dll", "exe", "r", "jl",
            "swift", "kt", "cs", "php", "pl", "lua", "sql", "bash", "mk", "cmake",
        ]
        .contains(&extension.as_str())
    {
        return Some(false);
    }
    None
}

fn markdown_hint(value: &str) -> bool {
    let value = value.trim_start_matches('\u{feff}');
    if value.starts_with("#!") {
        return false;
    }
    let mut items = 0;
    let mut previous = "";
    for line in value.lines() {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        let hashes = trimmed.bytes().take_while(|b| *b == b'#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with([' ', '\t']) {
            return true;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            return true;
        }
        if !previous.is_empty()
            && trimmed.len() >= 3
            && (trimmed.bytes().all(|b| b == b'=') || trimmed.bytes().all(|b| b == b'-'))
        {
            return true;
        }
        let numbered = trimmed.trim_start_matches(|c: char| c.is_ascii_digit());
        if trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed.starts_with("+ ")
            || trimmed.starts_with("> ")
            || (numbered.len() < trimmed.len()
                && (numbered.starts_with(". ") || numbered.starts_with(") ")))
        {
            items += 1;
            if items >= 2 {
                return true;
            }
        }
        previous = trimmed;
    }
    false
}

pub(crate) fn is_document(path: &Path, bytes: &[u8]) -> bool {
    text(bytes).is_ok() && name_hint(path).unwrap_or_else(|| sample(bytes).is_ok_and(markdown_hint))
}

pub(crate) fn read_discovered(path: &Path) -> Option<String> {
    match name_hint(path) {
        Some(false) => None,
        Some(true) => read_text(path).ok(),
        None if markdown_hint(&probe_text(path).ok()?) => read_text(path).ok(),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_utf8_text_independently_of_the_name() {
        let dir = tempfile::tempdir().unwrap();
        let content = "\u{feff}# Titolo\r\n\r\nCaffè e 日本語.\r\n";
        for name in [
            "README",
            "chapter.custom",
            "NOTES.MDOWN",
            "config.json",
            "without-extension",
        ] {
            let path = dir.path().join(name);
            fs::write(&path, content).unwrap();
            assert_eq!(read_text(&path).unwrap(), content);
        }
        assert!(read_text(dir.path()).is_err());
    }

    #[test]
    fn rejects_binary_content_even_with_a_markdown_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("looks-like-text.md");
        for bytes in [
            b"text\0binary".as_slice(),
            b"\xff\xfeUTF16",
            b"%PDF-1.7\ntext",
            b"{\\rtf1 document}",
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(read_text(&path).is_err());
            assert!(read_discovered(&path).is_none());
        }
        let mut bytes = vec![b'a'; SAMPLE_BYTES + 20];
        bytes.push(0);
        fs::write(&path, bytes).unwrap();
        assert!(probe_text(&path).is_ok());
        assert!(read_text(&path).is_err());
        assert!(read_discovered(&path).is_none());
    }

    #[test]
    fn a_sample_boundary_does_not_reject_or_truncate_unicode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unicode");
        let content = "a".repeat(SAMPLE_BYTES - 1) + "🙂 fine";
        fs::write(&path, &content).unwrap();
        assert!(probe_text(&path).is_ok());
        assert_eq!(read_text(&path).unwrap(), content);
    }

    #[test]
    fn discovers_document_names_and_markdown_but_not_source_or_configuration() {
        for name in [
            "README",
            "LICENSE",
            "CHANGELOG.en",
            "notes.txt",
            "draft.MKD",
            "chapter.mdx",
        ] {
            assert!(is_document(Path::new(name), b"ordinary text"), "{name}");
        }
        for (name, content) in [
            ("chapter.custom", "# Heading\n\nText"),
            ("chapter", "Title\n=====\nText"),
            ("todo.data", "- first\n- second"),
            ("example.odd", "```rust\ncode\n``` "),
        ] {
            assert!(is_document(Path::new(name), content.as_bytes()), "{name}");
        }
        for name in [
            "code.py",
            "code.rs",
            "analysis.R",
            "settings.json",
            "settings.yaml",
            "Dockerfile",
            "Makefile",
            ".gitignore",
            ".env.local",
        ] {
            assert!(
                !is_document(Path::new(name), b"# Heading\n\nExample\n"),
                "{name}"
            );
        }
        assert!(!is_document(Path::new("script"), b"#!/bin/sh\n# Heading\n"));
        assert!(!is_document(Path::new("unknown"), b"ordinary text"));
        assert!(!is_document(Path::new("README"), b"bad\0content"));
    }

    #[cfg(unix)]
    #[test]
    fn devices_are_not_documents() {
        assert!(read_text(Path::new("/dev/null")).is_err());
        assert!(probe_text(Path::new("/dev/null")).is_err());
    }
}
