//! Spelling results only. WebKit must not own spelling markers or correction UI.
use serde::Serialize;

const MAX_TEXT_UNITS: usize = 16_384;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SpellingRange {
    pub from: usize,
    pub to: usize,
}

fn text_length(text: &str) -> Result<usize, String> {
    let length = text.encode_utf16().count();
    if length > MAX_TEXT_UNITS {
        return Err("Spelling check exceeds the text limit.".into());
    }
    Ok(length)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn spell_check(
    app: tauri::AppHandle,
    text: String,
) -> Result<Vec<SpellingRange>, String> {
    use block2::RcBlock;
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{
        NSArray, NSOrthography, NSRange, NSString, NSTextCheckingResult, NSTextCheckingType,
    };
    use std::{ptr::NonNull, sync::Mutex, time::Duration};

    let length = text_length(&text)?;
    if length == 0 {
        return Ok(Vec::new());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let cleanup_app = app.clone();
    app.run_on_main_thread(move || {
        let checker = NSSpellChecker::sharedSpellChecker();
        checker.setAutomaticallyIdentifiesLanguages(true);
        let tag = NSSpellChecker::uniqueSpellDocumentTag();
        let sender = Mutex::new(Some(sender));
        let callback = RcBlock::new(move |_: isize, results: NonNull<NSArray<NSTextCheckingResult>>, _: NonNull<NSOrthography>, _: isize| {
            // AppKit owns these results for the duration of this callback.
            let results = unsafe { results.as_ref() };
            let mut ranges = Vec::new();
            for result in results {
                let range = result.range();
                if result.resultType() == NSTextCheckingType::Spelling
                    && range.length > 0
                    && range.location < length
                    && range.length <= length - range.location
                {
                    ranges.push(SpellingRange { from: range.location, to: range.location + range.length });
                }
            }
            if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = sender.send(ranges);
            }
            let _ = cleanup_app.run_on_main_thread(move || {
                NSSpellChecker::sharedSpellChecker().closeSpellDocumentWithTag(tag);
            });
        });
        // No correction/replacement types, options, or UI calls. AppKit copies
        // the string and callback; the result ranges use JavaScript's UTF-16 offsets.
        unsafe {
            checker.requestCheckingOfString_range_types_options_inSpellDocumentWithTag_completionHandler(
                &NSString::from_str(&text), NSRange::new(0, length),
                (NSTextCheckingType::Spelling | NSTextCheckingType::Orthography).bits(),
                None, tag, Some(&callback),
            );
        }
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "Spelling check timed out.".to_string())?
        .map_err(|_| "Spelling check ended before returning results.".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn spell_check(text: String) -> Result<Vec<SpellingRange>, String> {
    text_length(&text)?;
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_limit_counts_utf16_units() {
        assert_eq!(text_length("😀 Straße"), Ok(9));
        assert!(text_length(&"a".repeat(MAX_TEXT_UNITS)).is_ok());
        assert!(text_length(&"😀".repeat(MAX_TEXT_UNITS / 2 + 1)).is_err());
    }

    #[test]
    fn renderer_ranges_keep_utf16_offsets() {
        assert_eq!(
            serde_json::to_value(SpellingRange { from: 3, to: 8 }).unwrap(),
            serde_json::json!({ "from": 3, "to": 8 })
        );
    }
}
