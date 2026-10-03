//! Exact native proposal replacements use the same boundary rule as the Editor:
//! replace visible text, then move whole discussions. Never slice a wrapper.
use regex::Regex;
use std::sync::LazyLock;

static COMMENTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)<comment\s+((?:"[^"]*"|[^">])*)>(.*?)</comment>"#).unwrap());
static IDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\bid="([^"]*)""#).unwrap());

struct Thread<'a> {
    id: &'a str,
    raw_from: usize,
    raw_to: usize,
    content_from: usize,
    content_to: usize,
    from: usize,
    to: usize,
    open: String,
    tail: &'a str,
    quote: &'a str,
    detached: bool,
}

fn read(source: &str) -> (String, Vec<Thread<'_>>) {
    let mut text = String::new();
    let mut threads = Vec::new();
    let mut end = 0;
    for capture in COMMENTS.captures_iter(source) {
        let whole = capture.get(0).unwrap();
        let attrs = capture.get(1).unwrap().as_str();
        let inner = capture.get(2).unwrap();
        let detached = attrs.contains("detached=\"");
        let mut raw_from = whole.start();
        if detached && attrs.contains("padding=\"2\"") {
            let prefix = &source[end..raw_from];
            if prefix.ends_with("\r\n\r\n") {
                raw_from -= 4;
            } else if prefix.ends_with("\n\n") || prefix.ends_with("\r\r") {
                raw_from -= 2;
            }
        }
        text.push_str(&source[end..raw_from]);
        let content_to = inner.start() + inner.as_str().find("<reply ").unwrap_or(inner.len());
        let quote = &source[inner.start()..content_to];
        let from = text.len();
        text.push_str(quote);
        threads.push(Thread {
            id: IDS
                .captures(attrs)
                .and_then(|id| id.get(1))
                .map_or("", |id| id.as_str()),
            raw_from,
            raw_to: whole.end(),
            content_from: inner.start(),
            content_to,
            from,
            to: text.len(),
            open: source[raw_from..inner.start()].into(),
            tail: &source[content_to..whole.end()],
            quote,
            detached,
        });
        end = whole.end();
    }
    text.push_str(&source[end..]);
    (text, threads)
}

fn raw_to_clean(threads: &[Thread<'_>], position: usize) -> usize {
    let mut hidden = 0;
    for thread in threads {
        if position < thread.raw_from {
            break;
        }
        if position <= thread.content_from {
            return thread.from;
        }
        if position <= thread.content_to {
            return thread.from + position - thread.content_from;
        }
        if position < thread.raw_to {
            return thread.to;
        }
        hidden += thread.raw_to - thread.raw_from - thread.quote.len();
    }
    position - hidden
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn detach(thread: &mut Thread<'_>, line_ending: &str) {
    if thread.detached {
        return;
    }
    thread.open = format!(
        "{line_ending}{line_ending}{} detached=\"removed\" quote=\"{}\" padding=\"2\">",
        thread.open.trim_end_matches('>'),
        escape(thread.quote)
    );
    thread.detached = true;
}

pub fn replace(source: &str, target: &str, replacement: &str) -> Result<Option<String>, String> {
    if target.is_empty() {
        return Err("Edit proposal has no target text".into());
    }
    let (clean, mut threads) = read(source);
    let (insert, mut added) = read(replacement);
    let structured_target = COMMENTS.is_match(target);
    let haystack = if structured_target { source } else { &clean };
    let matches: Vec<_> = haystack.match_indices(target).collect();
    if matches.len() > 1 {
        return Err("Target text is ambiguous in file".into());
    }
    let Some((offset, _)) = matches.first() else {
        if !insert.is_empty() && clean.match_indices(&insert).count() == 1 {
            return Ok(None);
        }
        return Err("Target text no longer found in file".into());
    };
    let (from, to) = if structured_target {
        (
            raw_to_clean(&threads, *offset),
            raw_to_clean(&threads, offset + target.len()),
        )
    } else {
        (*offset, offset + target.len())
    };
    let text = format!("{}{}{}", &clean[..from], insert, &clean[to..]);
    let line_ending = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    threads.retain(|thread| {
        !added
            .iter()
            .any(|next| !next.id.is_empty() && next.id == thread.id)
    });
    for thread in &mut threads {
        if thread.detached {
            continue;
        }
        let overlap = thread.to.min(to).saturating_sub(thread.from.max(from));
        if overlap == thread.to - thread.from {
            detach(thread, line_ending);
            continue;
        }
        thread.from = if thread.from < from || (thread.from == from && to > from) {
            thread.from
        } else if thread.from >= to {
            thread.from - (to - from) + insert.len()
        } else {
            from + insert.len()
        };
        thread.to = if thread.to <= from {
            thread.to
        } else if thread.to >= to {
            thread.to - (to - from) + insert.len()
        } else {
            from
        };
        if thread.to <= thread.from {
            detach(thread, line_ending);
        }
    }
    for thread in &mut added {
        thread.from += from;
        thread.to += from;
    }
    threads.extend(added);
    threads.sort_by_key(|thread| (thread.from, thread.to));
    let mut result = String::new();
    let mut end = 0;
    for thread in &mut threads {
        if !thread.detached && thread.from < end {
            detach(thread, line_ending);
        }
        if thread.detached {
            continue;
        }
        result.push_str(&text[end..thread.from]);
        result.push_str(&thread.open);
        result.push_str(&text[thread.from..thread.to]);
        result.push_str(thread.tail);
        end = thread.to;
    }
    result.push_str(&text[end..]);
    for thread in threads.iter().filter(|thread| thread.detached) {
        result.push_str(&thread.open);
        result.push_str(thread.tail);
    }
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    const TAG: &str = "<comment id=\"a\" text=\"Check\">the claim<reply id=\"r\" text=\"https://example.com/spec\"/></comment>";

    #[test]
    fn replacements_across_wrappers_keep_discussions_and_clean_prose() {
        let source = format!("Intro {TAG} and context.");
        let result = replace(&source, "the claim and context.", "a new passage.")
            .unwrap()
            .unwrap();
        assert_eq!(read(&result).0, "Intro a new passage.");
        assert!(result.contains("quote=\"the claim\""));
        assert!(result.contains("https://example.com/spec"));
        assert_eq!(read(&result).1.len(), 1);
    }

    #[test]
    fn partial_edits_keep_tags_and_unicode_offsets() {
        let source = format!("Ü {TAG}\r\n");
        let result = replace(&source, "claim", "日本語").unwrap().unwrap();
        assert_eq!(read(&result).0, "Ü the 日本語\r\n");
        assert!(result.contains(">the 日本語<reply"));
        assert_eq!(
            replace(&source, "Ü", "Ö").unwrap().unwrap(),
            source.replacen('Ü', "Ö", 1)
        );
    }

    #[test]
    fn metadata_words_are_not_prose_targets_and_repeated_quotes_fail() {
        assert!(replace(TAG, "Check", "Changed").is_err());
        assert!(replace("Same Same", "Same", "New")
            .unwrap_err()
            .contains("ambiguous"));
    }
}
