use super::*;

pub(super) fn escape_markdown_heading(value: &str) -> String {
    value.replace(['\n', '\r'], " ").trim().to_string()
}

pub(super) fn format_timestamp(milliseconds: i64) -> String {
    let milliseconds = milliseconds.max(0) as u64;
    let seconds = milliseconds / 1_000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3_600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

const READABLE_TRANSCRIPT_MAX_GAP_MS: i64 = 1_500;
const READABLE_TRANSCRIPT_MAX_DURATION_MS: i64 = 30_000;

pub(super) struct ReadableTranscriptSegment {
    pub(super) start_ms: i64,
    pub(super) end_ms: i64,
    channel_id: Option<String>,
    pub(super) speaker: String,
    pub(super) text: String,
    is_final: bool,
}

pub(super) fn readable_transcript_segments(
    segments: &[TranscriptSegmentRecord],
    gaps: &[TranscriptGapRecord],
) -> Vec<ReadableTranscriptSegment> {
    let mut readable: Vec<ReadableTranscriptSegment> = Vec::new();
    for record in segments {
        let segment = &record.segment;
        let speaker = segment
            .speaker
            .as_deref()
            .or(segment.channel_id.as_deref())
            .unwrap_or("Speaker")
            .to_string();
        let can_merge = readable.last().is_some_and(|previous| {
            previous.is_final
                && segment.is_final
                && previous.channel_id == segment.channel_id
                && previous.speaker == speaker
                && segment.start_ms >= previous.start_ms
                && segment.start_ms.saturating_sub(previous.end_ms)
                    <= READABLE_TRANSCRIPT_MAX_GAP_MS
                && segment
                    .end_ms
                    .max(previous.end_ms)
                    .saturating_sub(previous.start_ms)
                    <= READABLE_TRANSCRIPT_MAX_DURATION_MS
                && !gaps.iter().any(|gap| {
                    gap.gap
                        .channel_id
                        .as_ref()
                        .is_none_or(|channel| Some(channel) == segment.channel_id.as_ref())
                        && gap.gap.end_ms > previous.end_ms
                        && gap.gap.start_ms < segment.start_ms
                })
        });
        if can_merge {
            let previous = readable.last_mut().expect("readable segment exists");
            previous.end_ms = previous.end_ms.max(segment.end_ms);
            previous.text.push(' ');
            previous.text.push_str(segment.text.trim());
            continue;
        }
        readable.push(ReadableTranscriptSegment {
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            channel_id: segment.channel_id.clone(),
            speaker,
            text: segment.text.trim().to_string(),
            is_final: segment.is_final,
        });
    }
    readable
}

pub(super) fn content_file_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(error) => {
            return Err(format!(
                "Could not inspect private meeting content: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Private meeting content must be a regular file".into());
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("Could not inspect private meeting content timestamp: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Private meeting content has an invalid timestamp".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "v1:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos()
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(format!(
            "v1:{}:{}:{}",
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos()
        ))
    }
}

pub(super) fn push_diagnostic(diagnostics: &Mutex<Vec<String>>, diagnostic: String) {
    if let Ok(mut values) = diagnostics.lock() {
        if !values.contains(&diagnostic) {
            values.push(diagnostic);
        }
    }
}

pub(super) fn bounded_diagnostic(value: &str) -> String {
    let mut characters = value.chars();
    let mut bounded = characters
        .by_ref()
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        bounded.push('…');
    }
    bounded
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Meeting platform mutex was poisoned".into())
}
