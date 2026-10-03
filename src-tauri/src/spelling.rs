use serde::Serialize;

#[derive(Serialize)]
pub struct SpellingLanguage {
    code: String,
    name: String,
}

#[derive(Serialize, Debug)]
pub struct SpellingRange {
    from: usize,
    to: usize,
}

#[derive(Serialize)]
pub struct SpellingResult {
    supported: bool,
    ranges: Vec<SpellingRange>,
}

#[tauri::command]
pub fn spelling_languages() -> Vec<SpellingLanguage> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSSpellChecker;
        use objc2_foundation::NSLocale;
        let locale = NSLocale::currentLocale();
        NSSpellChecker::sharedSpellChecker()
            .availableLanguages()
            .iter()
            .map(|code| SpellingLanguage {
                code: code.to_string(),
                name: locale.localizedStringForLocaleIdentifier(&code).to_string(),
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

// Explicit-language checks must use this API: the unified async checker can
// override an NSOrthography hint with automatic language detection.
#[tauri::command]
pub fn check_spelling(text: String, language: String) -> Result<SpellingResult, String> {
    if text.encode_utf16().count() > 4000 {
        return Err("Spelling request is too large".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSSpellChecker;
        use objc2_foundation::NSString;
        let checker = NSSpellChecker::sharedSpellChecker();
        let language = (!language.is_empty()).then(|| NSString::from_str(&language));
        if language
            .as_ref()
            .is_some_and(|value| !checker.availableLanguages().containsObject(value))
        {
            return Err("The selected spelling dictionary is unavailable".into());
        }
        let text = NSString::from_str(&text);
        let tag = NSSpellChecker::uniqueSpellDocumentTag();
        let mut ranges = Vec::new();
        let mut start = 0;
        while start < text.length() {
            let range = unsafe {
                checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                    &text, start as isize, language.as_deref(), false, tag, std::ptr::null_mut(),
                )
            };
            let Some(to) = range.location.checked_add(range.length) else {
                break;
            };
            if range.length == 0
                || range.location >= text.length()
                || to > text.length()
                || to <= start
            {
                break;
            }
            ranges.push(SpellingRange {
                from: range.location,
                to,
            });
            start = to;
        }
        checker.closeSpellDocumentWithTag(tag);
        Ok(SpellingResult {
            supported: true,
            ranges,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (text, language);
        Ok(SpellingResult {
            supported: false,
            ranges: Vec::new(),
        })
    }
}

#[tauri::command]
pub fn spelling_suggestions(word: String, language: String) -> Result<Vec<String>, String> {
    if word.len() > 2048 {
        return Ok(Vec::new());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSSpellChecker;
        use objc2_foundation::{NSRange, NSString};
        let checker = NSSpellChecker::sharedSpellChecker();
        let word = NSString::from_str(&word);
        let language = (!language.is_empty()).then(|| NSString::from_str(&language));
        let tag = NSSpellChecker::uniqueSpellDocumentTag();
        let suggestions = checker
            .guessesForWordRange_inString_language_inSpellDocumentWithTag(
                NSRange::new(0, word.length()),
                &word,
                language.as_deref(),
                tag,
            )
            .map(|values| values.iter().take(8).map(|v| v.to_string()).collect())
            .unwrap_or_default();
        checker.closeSpellDocumentWithTag(tag);
        Ok(suggestions)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (word, language);
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn learn_spelling_word(word: String) -> Result<(), String> {
    if word.is_empty() || word.len() > 2048 {
        return Err("Invalid spelling word".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSSpellChecker;
        use objc2_foundation::NSString;
        NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(&word));
    }
    Ok(())
}
