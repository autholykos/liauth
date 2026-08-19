use serde::{Deserialize, Serialize};

// Local inference endpoint (OpenAI-compatible); making this configurable
// is deliberately deferred.
const ENDPOINT: &str = "https://models.nanto.org/v1/chat/completions";
const MODEL: &str = "toki";

#[derive(Serialize, Deserialize)]
pub struct EditPair {
    pub find: String,
    pub replace: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

/// Find the project's voice/style guide, walking the same repo root the
/// versioning uses: .liauth/voice.md, VOICE.md, or a Claude-style voice
/// skill (.claude/skills/*voice*/SKILL.md). A calibration file named
/// example-voice.md beside the guide is appended when present.
fn find_voice(repo_root: &str) -> Option<String> {
    let root = std::fs::canonicalize(repo_root).ok()?;
    // Canonicalize (resolving symlinks) and require containment in the
    // repo: the warmup posts this text to the model automatically on
    // open, so a crafted repo with VOICE.md -> ~/.ssh/id_rsa must not
    // become an exfiltration path.
    let read_contained = |p: &std::path::Path| {
        let real = std::fs::canonicalize(p).ok()?;
        if !real.starts_with(&root) {
            return None;
        }
        std::fs::read_to_string(&real).ok()
    };
    let mut candidates = vec![root.join(".liauth/voice.md"), root.join("VOICE.md")];
    if let Ok(entries) = std::fs::read_dir(root.join(".claude/skills")) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().contains("voice") {
                candidates.push(e.path().join("SKILL.md"));
            }
        }
    }
    for c in candidates {
        if let Some(mut text) = read_contained(&c) {
            if let Some(examples) = c
                .parent()
                .and_then(|d| read_contained(&d.join("example-voice.md")))
            {
                text.push_str("\n\n");
                text.push_str(&examples);
            }
            return Some(text);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::find_voice;

    #[test]
    fn note_requests_use_toki() {
        assert_eq!(super::MODEL, "toki");
    }

    #[test]
    fn voice_symlink_escaping_repo_is_rejected() {
        let base = std::env::temp_dir().join(format!("liauth-voice-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let secret = base.join("secret.txt");
        std::fs::write(&secret, "private key material").unwrap();
        std::os::unix::fs::symlink(&secret, repo.join("VOICE.md")).unwrap();
        assert_eq!(find_voice(repo.to_str().unwrap()), None);

        // A real file (and an in-repo symlink) still resolve.
        std::fs::remove_file(repo.join("VOICE.md")).unwrap();
        std::fs::write(repo.join("VOICE.md"), "style guide").unwrap();
        assert_eq!(
            find_voice(repo.to_str().unwrap()).as_deref(),
            Some("style guide")
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}

/// Shared start of every model prompt, most-stable-first — VOICE is
/// constant per project and DOCUMENT per note session — so warmup and
/// every note request share a prompt prefix and hit the server's KV
/// cache (minutes → seconds), across chapters for the voice segment.
fn prompt_prefix(repo_root: Option<&str>, document: &str) -> String {
    let voice = repo_root
        .and_then(find_voice)
        .map(|v| {
            format!(
                "VOICE — the author's style guide; any proposed prose must \
                 follow it:\n{v}\n\n"
            )
        })
        .unwrap_or_default();
    format!("{voice}DOCUMENT:\n{document}\n\n")
}

/// reqwest's rustls-no-provider build panics (stranding the invoke
/// promise) unless a process-level CryptoProvider exists; the updater
/// plugin may have installed one already, hence the ignored error.
fn ensure_tls() {
    static INIT_TLS: std::sync::Once = std::sync::Once::new();
    INIT_TLS.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .ok();
    });
}

/// Best-effort KV-cache warmup: run the shared document prefix through the
/// model with a one-token reply so the first real draft on this document
/// skips the multi-minute prompt-processing cost. Fired on document open;
/// failures are irrelevant.
#[tauri::command]
pub async fn warm_note_cache(document: String, repo_root: Option<String>) {
    ensure_tls();
    let prompt = format!(
        "{}Reply with exactly: ok",
        prompt_prefix(repo_root.as_deref(), &document)
    );
    let body = serde_json::json!({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 1,
    });
    let _ = reqwest::Client::new()
        .post(ENDPOINT)
        .timeout(std::time::Duration::from_secs(600))
        .json(&body)
        .send()
        .await;
}

/// Turn one review note into concrete find→replace edits. The whole
/// document travels as context; the instruction is the single note. The
/// frontend applies the pairs as {~~find~>replace~~} suggestions, so the
/// model never mutates the document directly.
#[tauri::command]
pub async fn draft_note_edits(
    note: String,
    excerpt: Option<String>,
    document: String,
    repo_root: Option<String>,
) -> Result<Vec<EditPair>, String> {
    let focus = excerpt
        .filter(|e| !e.trim().is_empty())
        .map(|e| format!("\n\nFOCUS (text the note is anchored to):\n{e}"))
        .unwrap_or_default();
    let prompt = format!(
        "{}REVIEW NOTE:\n{note}{focus}\n\n\
         Apply the REVIEW NOTE above to the DOCUMENT by proposing concrete \
         text edits.\n\n\
         Respond with ONLY a JSON array: [{{\"find\": \"...\", \"replace\": \"...\"}}, ...]\n\n\
         Rules:\n\
         - Copy each \"find\" VERBATIM from the document — exact characters, \
         punctuation, and whitespace.\n\
         - For mechanical fixes (typos, accents, quotes, punctuation) keep \
         each \"find\" as short as possible while unambiguous; one pair per \
         occurrence for pattern-wide asks.\n\
         - For structural or stylistic notes (pacing, order, adding a beat, \
         tone), work at the sentence or paragraph level: take the smallest \
         complete passage that must change as \"find\" and give the fully \
         rewritten passage as \"replace\". Write new prose in the document's \
         language and tense, following the VOICE style guide when one is \
         provided above.\n\
         - To insert new text, use the sentence at the insertion point as \
         \"find\" and return it with the new text in the right position as \
         \"replace\".\n\
         - The note may start with an identifier label (e.g. \"NOTE 14-D4 —\"); \
         ignore the label, the instruction is what follows.\n\
         - Propose ONLY edits this note asks for; ignore other flaws. Return \
         [] only when the note requests no change to the text at all.\n\
         - Never include the {{>> <<}}, {{== ==}}, or {{~~ ~~}} annotation \
         markers in a find or replace.",
        prompt_prefix(repo_root.as_deref(), &document),
    );
    // The server admits prompt + max_tokens against its KV budget
    // (currently 32768), so an oversized generation ceiling gets whole
    // requests rejected on long chapters; observed replies stay well
    // under 2k tokens.
    let body = serde_json::json!({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 4096,
    });
    ensure_tls();
    // Long-document prompt processing can legitimately take minutes.
    let resp = reqwest::Client::new()
        .post(ENDPOINT)
        .timeout(std::time::Duration::from_secs(600))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("model request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("model request failed: {e}"))?
        .json::<ChatResponse>()
        .await
        .map_err(|e| format!("bad model response: {e}"))?;
    let content = resp
        .choices
        .first()
        .map(|c| c.message.content.as_str())
        .unwrap_or("");
    parse_edits(content).ok_or_else(|| "model reply contained no JSON edit list".to_string())
}

/// Extract the first JSON array from the reply, tolerating code fences
/// and prose around it.
fn parse_edits(content: &str) -> Option<Vec<EditPair>> {
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    serde_json::from_str(content.get(start..=end)?).ok()
}
