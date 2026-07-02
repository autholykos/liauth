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
    let prompt = format!(
        "You are an editor's assistant working on a markdown document. \
         Apply ONE review note by proposing minimal text edits.\n\n\
         Respond with ONLY a JSON array: [{{\"find\": \"...\", \"replace\": \"...\"}}, ...]\n\n\
         Rules:\n\
         - Copy each \"find\" VERBATIM from the document — exact characters, \
         punctuation, and whitespace.\n\
         - Keep each \"find\" short but unambiguous; include neighboring words \
         only when needed to target one spot. When the note asks for a \
         pattern-wide change, emit one pair per occurrence.\n\
         - Propose only edits this note asks for; ignore other flaws. \
         If nothing is actionable, return [].\n\
         - Never include text between {{>> and <<}}, {{== and ==}}, or \
         {{~~ and ~~}} markers in a find or replace.\n\n\
         REVIEW NOTE:\n{note}{focus}\n\nDOCUMENT:\n{document}"
    );
    let body = serde_json::json!({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 4096,
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
