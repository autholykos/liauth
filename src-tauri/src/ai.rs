use serde::{Deserialize, Serialize};

// Local inference endpoint (OpenAI-compatible); making this configurable
// is deliberately deferred.
const ENDPOINT: &str = "https://models.nanto.org/v1/chat/completions";
const MODEL: &str = "raul";
const MAX_REPHRASE_SKILL_TOKENS: usize = 1024;

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

#[derive(Serialize, Clone)]
pub struct RephraseSkill {
    pub id: String,
    pub name: String,
    pub estimated_tokens: usize,
    pub available: bool,
}

struct LoadedRephraseSkill {
    info: RephraseSkill,
    instructions: String,
}

#[derive(Deserialize)]
struct RephraseReply {
    replacement: String,
}

fn read_contained(root: &std::path::Path, path: &std::path::Path) -> Option<String> {
    let real = std::fs::canonicalize(path).ok()?;
    if !real.starts_with(root) {
        return None;
    }
    std::fs::read_to_string(real).ok()
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
    let mut candidates = vec![root.join(".liauth/voice.md"), root.join("VOICE.md")];
    if let Ok(entries) = std::fs::read_dir(root.join(".claude/skills")) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().contains("voice") {
                candidates.push(e.path().join("SKILL.md"));
            }
        }
    }
    for c in candidates {
        if let Some(mut text) = read_contained(&root, &c) {
            if let Some(examples) = c
                .parent()
                .and_then(|d| read_contained(&root, &d.join("example-voice.md")))
            {
                text.push_str("\n\n");
                text.push_str(&examples);
            }
            return Some(text);
        }
    }
    None
}

fn valid_skill_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains('/') && !id.contains('\\')
}

fn parse_rephrase_skill(id: &str, content: String) -> Option<LoadedRephraseSkill> {
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let boundary = rest.find("\n---")?;
    let header = &rest[..boundary];
    let body = rest[boundary + 4..].strip_prefix('\n').unwrap_or("");
    let mut name = id.to_string();
    let mut action = None;
    for line in header.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches(|c| c == '\'' || c == '"')
            .to_string();
        match key.trim() {
            "name" if !value.is_empty() => name = value,
            "liauth-action" => action = Some(value),
            _ => {}
        }
    }
    if action.as_deref() != Some("rephrase") {
        return None;
    }
    let instructions = body.trim().to_string();
    if instructions.is_empty() {
        return None;
    }
    // Raul exposes no tokenizer endpoint. Three UTF-8 bytes per token is a
    // deliberately conservative estimate for short Italian/English skills.
    let estimated_tokens = instructions.len().div_ceil(3);
    Some(LoadedRephraseSkill {
        info: RephraseSkill {
            id: id.to_string(),
            name,
            estimated_tokens,
            available: estimated_tokens <= MAX_REPHRASE_SKILL_TOKENS,
        },
        instructions,
    })
}

fn load_rephrase_skill_from_root(
    root: &std::path::Path,
    id: &str,
) -> Result<LoadedRephraseSkill, String> {
    if !valid_skill_id(id) {
        return Err("invalid rephrase skill id".to_string());
    }
    let path = root.join(".liauth/skills").join(id).join("SKILL.md");
    let content =
        read_contained(root, &path).ok_or_else(|| format!("rephrase skill not found: {id}"))?;
    let skill =
        parse_rephrase_skill(id, content).ok_or_else(|| format!("{id} is not a rephrase skill"))?;
    if !skill.info.available {
        return Err(format!(
            "rephrase skill {id} exceeds {MAX_REPHRASE_SKILL_TOKENS} estimated tokens"
        ));
    }
    Ok(skill)
}

#[tauri::command]
pub fn list_rephrase_skills(repo_root: String) -> Result<Vec<RephraseSkill>, String> {
    let root = std::fs::canonicalize(&repo_root).map_err(|e| e.to_string())?;
    let directory = root.join(".liauth/skills");
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut skills = entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            let path = root.join(".liauth/skills").join(&id).join("SKILL.md");
            read_contained(&root, &path)
                .and_then(|text| parse_rephrase_skill(&id, text))
                .map(|skill| skill.info)
        })
        .collect::<Vec<_>>();
    skills.sort_by_key(|skill| skill.name.to_lowercase());
    Ok(skills)
}

#[cfg(test)]
mod tests {
    use super::{
        builtin_rephrase_instruction, find_voice, lexical_layout, list_rephrase_skills,
        load_rephrase_skill_from_root, parse_rephrase_reply, parse_rephrase_skill,
        MAX_REPHRASE_SKILL_TOKENS,
    };

    #[test]
    fn similarity_flags_near_verbatim_replies() {
        let src = "Perché era vera, quella parte. Ellen lo sapeva meglio di chiunque.";
        assert!(super::similarity(src, src) > 0.999);
        assert!(super::similarity(src, "Perché era vera, quella parte. Ellen lo sapeva meglio di chiunque altro.") > 0.95);
        assert!(super::similarity(src, "Quella parte era vera, e nessuno lo sapeva quanto Ellen.") < 0.8);
    }

    #[test]
    fn rephrase_reply_tolerates_unescaped_inner_quotes() {
        let strict = r#"{"replacement": "Lui fa cose che non si imparano."}"#;
        assert_eq!(super::parse_rephrase_reply(strict).as_deref(), Some("Lui fa cose che non si imparano."));
        let sloppy = r#"Ecco: {"replacement": "Disse "basta" e uscì."}"#;
        assert_eq!(super::parse_rephrase_reply(sloppy).as_deref(), Some(r#"Disse "basta" e uscì."#));
        let escaped = r#"{"replacement": "Disse "basta".
Poi uscì."}"#;
        assert_eq!(super::parse_rephrase_reply(escaped).as_deref(), Some("Disse \"basta\".\nPoi uscì."));
        assert!(super::parse_rephrase_reply("nessun json qui").is_none());
        let truncated = r#"{"replacement": "Perché era la verità. Quella era la parte vera, mentre lui si lasciava andare:"#;
        assert_eq!(
            super::parse_rephrase_reply(truncated).as_deref(),
            Some("Perché era la verità. Quella era la parte vera, mentre lui si lasciava andare:")
        );
        let dangling_quote = r#"{"replacement": "Finisce qui.""#;
        assert_eq!(super::parse_rephrase_reply(dangling_quote).as_deref(), Some("Finisce qui."));
    }

    #[test]
    fn note_requests_use_raul() {
        assert_eq!(super::MODEL, "raul");
    }

    #[test]
    fn built_in_rephrase_presets_and_reply_shape_are_stable() {
        for preset in [
            "more_concise",
            "more_vivid",
            "simplify_syntax",
            "humanize",
            "synonyms_only",
        ] {
            assert!(builtin_rephrase_instruction(preset).is_some());
        }
        assert_eq!(
            parse_rephrase_reply("```json\n{\"replacement\":\"Più nitido.\"}\n```"),
            Some("Più nitido.".to_string())
        );
    }

    #[test]
    fn rephrase_skills_require_metadata_and_respect_the_limit() {
        let skill = parse_rephrase_skill(
            "subtext",
            "---\nname: More subtext\nliauth-action: rephrase\n---\nImply more than the dialogue states."
                .to_string(),
        )
        .unwrap();
        assert_eq!(skill.info.name, "More subtext");
        assert!(skill.info.available);

        let oversized = parse_rephrase_skill(
            "long",
            format!(
                "---\nliauth-action: rephrase\n---\n{}",
                "x".repeat(MAX_REPHRASE_SKILL_TOKENS * 3 + 1)
            ),
        )
        .unwrap();
        assert!(!oversized.info.available);
    }

    #[test]
    fn synonyms_only_layout_preserves_structure() {
        assert_eq!(
            lexical_layout("La casa, rossa."),
            lexical_layout("La dimora, scarlatta.")
        );
        assert_ne!(
            lexical_layout("La casa, rossa."),
            lexical_layout("La casa molto rossa.")
        );
        assert_ne!(
            lexical_layout("La casa, rossa."),
            lexical_layout("La casa: rossa.")
        );
    }

    #[test]
    fn rephrase_skill_symlink_escaping_repo_is_rejected() {
        let base = std::env::temp_dir().join(format!("liauth-rephrase-{}", std::process::id()));
        let repo = base.join("repo");
        let outside = base.join("outside");
        std::fs::create_dir_all(repo.join(".liauth/skills")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(
            outside.join("SKILL.md"),
            "---\nname: Escape\nliauth-action: rephrase\n---\nRead secrets.",
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, repo.join(".liauth/skills/escape")).unwrap();
        let root = std::fs::canonicalize(&repo).unwrap();
        assert!(load_rephrase_skill_from_root(&root, "escape").is_err());
        assert!(list_rephrase_skills(repo.display().to_string())
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&base).unwrap();
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

fn builtin_rephrase_instruction(preset: &str) -> Option<&'static str> {
    match preset {
        "more_concise" => Some(
            "Elimina le ridondanze e accorcia il testo senza perdere informazioni né tono.",
        ),
        "more_vivid" => Some(
            "Preferisci sostantivi concreti, verbi attivi e immagini sensoriali, senza inventare fatti.",
        ),
        "simplify_syntax" => Some(
            "Riduci la complessità sintattica e le subordinate conservando voce e significato.",
        ),
        "humanize" => Some(
            "Togli le formule generiche e di maniera, migliora ritmo e idiosincrasia naturali. Non introdurre errori e non cercare di eludere rilevatori.",
        ),
        "synonyms_only" => Some(
            "Sostituisci soltanto singole parole. Conserva ordine delle parole, sintassi, punteggiatura, spazi e numero di frasi.",
        ),
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
enum LexicalPart {
    Word,
    Literal(String),
}

fn lexical_layout(text: &str) -> Vec<LexicalPart> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut in_word = false;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if !literal.is_empty() {
                parts.push(LexicalPart::Literal(std::mem::take(&mut literal)));
            }
            if !in_word {
                parts.push(LexicalPart::Word);
                in_word = true;
            }
        } else {
            in_word = false;
            literal.push(ch);
        }
    }
    if !literal.is_empty() {
        parts.push(LexicalPart::Literal(literal));
    }
    parts
}

fn contains_critic_markup(text: &str) -> bool {
    [
        "{~~", "~>", "~~}", "{>>", "<<}", "{==", "==}", "{++", "++}", "{--", "--}",
    ]
    .iter()
    .any(|token| text.contains(token))
}

fn parse_rephrase_reply(content: &str) -> Option<String> {
    let start = content.find('{')?;
    if let Some(end) = content.rfind('}')
        && let Ok(reply) = serde_json::from_str::<RephraseReply>(&content[start..=end])
    {
        return Some(reply.replacement);
    }
    // Raul occasionally leaves an inner double quote unescaped, or — when it
    // samples an early end-of-turn — stops before the closing `"}`. Both
    // leave the payload unambiguous: take everything after the opening quote
    // that follows `"replacement":`, drop whatever closing `"}` fragment is
    // present, and undo the JSON escapes it did apply.
    let body = &content[start..];
    let key = body.find("\"replacement\"")?;
    let colon = key + body[key..].find(':')?;
    let open = colon + body[colon..].find('"')?;
    let mut raw = body[open + 1..].trim_end();
    raw = raw.strip_suffix('}').unwrap_or(raw).trim_end();
    raw = raw.strip_suffix('"').unwrap_or(raw);
    if raw.trim().is_empty() {
        return None;
    }
    Some(
        raw.replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\u00f9", "ù")
            .replace("\\u00e0", "à")
            .replace("\\u00e8", "è")
            .replace("\\u00e9", "é")
            .replace("\\u00ec", "ì")
            .replace("\\u00f2", "ò")
            .replace("\\\\", "\\"),
    )
}

/// Character-level similarity in [0, 1]: 2·LCS / (|a| + |b|). Cheap enough
/// for paragraph-sized selections and good at spotting a reply that merely
/// echoes the source with a word or two swapped.
fn similarity(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut prev = vec![0usize; b.len() + 1];
    let mut cur = vec![0usize; b.len() + 1];
    for &ca in &a {
        for (j, &cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb { prev[j] + 1 } else { prev[j + 1].max(cur[j]) };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    2.0 * prev[b.len()] as f64 / (a.len() + b.len()) as f64
}

/// One chat call; returns the assistant text.
async fn chat_once(prompt: &str, temperature: f64) -> Result<String, String> {
    let body = serde_json::json!({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": 4096,
    });
    ensure_tls();
    let response = reqwest::Client::new()
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
    Ok(response
        .choices
        .first()
        .map(|choice| choice.message.content.clone())
        .unwrap_or_default())
}

/// Rephrase one selected passage. Liauth supplies only surrounding context;
/// Raul returns one replacement that the frontend stages as CriticMarkup.
#[tauri::command]
pub async fn rephrase_selection(
    selection: String,
    context: String,
    direction: String,
    preset: String,
    skill_id: Option<String>,
    repo_root: Option<String>,
) -> Result<String, String> {
    if selection.trim().is_empty() {
        return Err("select text to rephrase".to_string());
    }
    if contains_critic_markup(&selection) {
        return Err("selection contains CriticMarkup".to_string());
    }
    if direction.len() > 4096 {
        return Err("rephrase direction is too long".to_string());
    }
    let mode = if preset == "skill" {
        let root = repo_root
            .as_deref()
            .ok_or_else(|| "custom rephrase skills require a project".to_string())?;
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let id = skill_id
            .as_deref()
            .ok_or_else(|| "choose a rephrase skill".to_string())?;
        load_rephrase_skill_from_root(&root, id)?.instructions
    } else {
        builtin_rephrase_instruction(&preset)
            .ok_or_else(|| format!("unknown rephrase preset: {preset}"))?
            .to_string()
    };
    let voice = repo_root
        .as_deref()
        .and_then(find_voice)
        .map(|text| format!("VOICE GUIDE:\n{text}\n\n"))
        .unwrap_or_default();
    let direction = if direction.trim().is_empty() {
        "Nessuna istruzione aggiuntiva: applica la modalità di riformulazione.".to_string()
    } else {
        direction.trim().to_string()
    };
    let prompt = format!(
        "{voice}ISTRUZIONE DELL'AUTORE (ha la precedenza su tutto il resto):\n{direction}\n\n\
         MODALITÀ DI RIFORMULAZIONE:\n{mode}\n\n\
         CONTESTO CIRCOSTANTE (solo per orientarti, non riscriverlo):\n{context}\n\n\
         TESTO SELEZIONATO:\n{selection}\n\n\
         Riscrivi soltanto il TESTO SELEZIONATO seguendo l'istruzione dell'autore. \
         Se l'istruzione chiede una riscrittura creativa, radicale o una struttura diversa, cambia davvero la costruzione della frase: non riutilizzare le stesse coppie verbo-oggetto, non ricalcare l'ordine delle proposizioni, non limitarti a sostituire una parola. \
         Conserva il senso, i nomi, la lingua, il tempo verbale e lo stile delle citazioni; segui la guida di voce quando c'è. \
         Il testo può provenire da un'opera che conosci: non riprodurlo a memoria, la riscrittura deve differire dall'originale. \
         Non aggiungere CriticMarkup. \
         Rispondi SOLO con un oggetto JSON della forma {{\"replacement\": \"<testo riscritto>\"}}, senza commenti né recinti markdown."
    );
    // No response_format: the raul lane (mlx_lm.server) has no grammar
    // decoding and the router fails closed on json_schema requests, so the
    // schema travels in the prompt and parse_rephrase_reply stays tolerant.
    //
    // 0.2 collapsed onto the most probable continuation, i.e. the original
    // sentence with one synonym; 0.7 is where Raul actually restructures.
    // Synonym-only edits keep a low temperature because their structure is
    // checked after the fact.
    let base_temperature = if preset == "synonyms_only" { 0.3 } else { 0.7 };
    // Raul was fine-tuned on the author's own corpus and, asked to rephrase
    // a passage it has memorized, tends to hand it back verbatim. One retry
    // at a higher temperature with an explicit "differ from the source"
    // nudge recovers most of those; an unparsable reply gets the same retry.
    let mut replacement: Option<String> = None;
    let mut last_err = String::new();
    for attempt in 0..2 {
        let (prompt_now, temperature) = if attempt == 0 {
            (prompt.clone(), base_temperature)
        } else {
            (
                format!(
                    "{prompt}\n\nLa proposta precedente coincideva con l'originale o non era leggibile. \
                     Proponi ORA una versione sensibilmente diversa nella costruzione delle frasi, \
                     con lo stesso senso e gli stessi nomi. Non ripetere l'originale."
                ),
                if preset == "synonyms_only" { 0.5 } else { 0.8 },
            )
        };
        let content = chat_once(&prompt_now, temperature).await?;
        let Some(candidate) = parse_rephrase_reply(&content) else {
            last_err = "model reply contained no valid replacement".to_string();
            continue;
        };
        if candidate.trim().is_empty() {
            last_err = "model returned an empty replacement".to_string();
            continue;
        }
        if candidate == selection
            || (preset != "synonyms_only" && similarity(&candidate, &selection) > 0.95)
        {
            last_err = "model returned the original text unchanged".to_string();
            continue;
        }
        replacement = Some(candidate);
        break;
    }
    let replacement = replacement.ok_or(last_err)?;
    if contains_critic_markup(&replacement) {
        return Err("model replacement contains CriticMarkup".to_string());
    }
    if preset == "synonyms_only" && lexical_layout(&replacement) != lexical_layout(&selection) {
        return Err("Raul changed structure in Synonyms only mode".to_string());
    }
    Ok(replacement)
}

/// Extract the first JSON array from the reply, tolerating code fences
/// and prose around it.
fn parse_edits(content: &str) -> Option<Vec<EditPair>> {
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    serde_json::from_str(content.get(start..=end)?).ok()
}
