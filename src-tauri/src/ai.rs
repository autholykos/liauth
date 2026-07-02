use serde::{Deserialize, Serialize};

// Local inference endpoint (OpenAI-compatible); making this configurable
// is deliberately deferred.
const ENDPOINT: &str = "https://models.nanto.org/v1/chat/completions";
const MODEL: &str = "bart";

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

/// Turn one review note into concrete find→replace edits. The whole
/// document travels as context; the instruction is the single note. The
/// frontend applies the pairs as {~~find~>replace~~} suggestions, so the
/// model never mutates the document directly.
#[tauri::command]
pub async fn draft_note_edits(
    note: String,
    excerpt: Option<String>,
    document: String,
) -> Result<Vec<EditPair>, String> {
    let focus = excerpt
        .filter(|e| !e.trim().is_empty())
        .map(|e| format!("\n\nFOCUS (text the note is anchored to):\n{e}"))
        .unwrap_or_default();
    // The document goes FIRST so sequential notes on the same document share
    // a prompt prefix and hit the server's KV cache (minutes → seconds).
    let prompt = format!(
        "DOCUMENT:\n{document}\n\nREVIEW NOTE:\n{note}{focus}\n\n\
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
         language, voice, and tense.\n\
         - To insert new text, use the sentence at the insertion point as \
         \"find\" and return it with the new text in the right position as \
         \"replace\".\n\
         - Propose ONLY edits this note explicitly asks for; ignore other \
         flaws. If the note is purely informational, return [].\n\
         - Never include the {{>> <<}}, {{== ==}}, or {{~~ ~~}} annotation \
         markers in a find or replace.",
    );
    let body = serde_json::json!({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 8192,
    });
    // reqwest's rustls-no-provider build panics (stranding the invoke
    // promise) unless a process-level CryptoProvider exists; the updater
    // plugin may have installed one already, hence the ignored error.
    static INIT_TLS: std::sync::Once = std::sync::Once::new();
    INIT_TLS.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .ok();
    });
    // Prompt processing on the local model is slow (~50 tok/s), so a long
    // document legitimately takes minutes.
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
    parse_edits(content)
        .ok_or_else(|| "model reply contained no JSON edit list".to_string())
}

/// Extract the first JSON array from the reply, tolerating code fences
/// and prose around it.
fn parse_edits(content: &str) -> Option<Vec<EditPair>> {
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    serde_json::from_str(content.get(start..=end)?).ok()
}
