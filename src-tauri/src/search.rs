use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub session_id: String,
    pub project_id: String,
    pub label: String,
    pub archived: bool,
    pub match_text: String,
    pub message_index: usize,
}

fn data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".mim"))
}

fn extract_match_excerpt(text: &str, query_lower: &str, context_chars: usize) -> Option<String> {
    let text_lower = text.to_lowercase();
    let pos = text_lower.find(query_lower)?;

    let start = if pos > context_chars {
        pos - context_chars
    } else {
        0
    };
    let end = (pos + query_lower.len() + context_chars).min(text.len());

    // Snap to char boundaries
    let start = text.floor_char_boundary(start);
    let end = text.ceil_char_boundary(end);

    let mut excerpt = String::new();
    if start > 0 {
        excerpt.push_str("...");
    }
    excerpt.push_str(&text[start..end]);
    if end < text.len() {
        excerpt.push_str("...");
    }
    Some(excerpt)
}

fn search_session_file(
    path: &std::path::Path,
    project_id: &str,
    query_lower: &str,
    results: &mut Vec<SearchResult>,
    max_results: usize,
) {
    if results.len() >= max_results {
        return;
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    // Quick pre-check: if the whole file doesn't contain the query, skip parsing
    if !content.to_lowercase().contains(query_lower) {
        return;
    }

    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let session_id = json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let label = json
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let archived = json
        .get("archived")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let messages = match json.get("messages").and_then(|v| v.as_array()) {
        Some(msgs) => msgs,
        None => return,
    };

    // Also check title match
    if label.to_lowercase().contains(query_lower) {
        // Find first message excerpt if possible, otherwise use the label itself
        let match_text = if let Some(first_content) = messages
            .iter()
            .find_map(|m| m.get("content").and_then(|c| c.as_str()))
        {
            extract_match_excerpt(first_content, query_lower, 50)
                .unwrap_or_else(|| format!("Title match: {}", label))
        } else {
            format!("Title match: {}", label)
        };

        if results.len() < max_results {
            results.push(SearchResult {
                session_id: session_id.clone(),
                project_id: project_id.to_string(),
                label: label.clone(),
                archived,
                match_text,
                message_index: 0,
            });
        }
    }

    // Search through messages
    for (idx, msg) in messages.iter().enumerate() {
        if results.len() >= max_results {
            break;
        }

        // Check direct content string
        if let Some(content_str) = msg.get("content").and_then(|c| c.as_str()) {
            if let Some(excerpt) = extract_match_excerpt(content_str, query_lower, 50) {
                // Avoid duplicate if title already matched on the same session
                let already_has = results
                    .iter()
                    .any(|r| r.session_id == session_id && r.message_index == idx);
                if !already_has {
                    results.push(SearchResult {
                        session_id: session_id.clone(),
                        project_id: project_id.to_string(),
                        label: label.clone(),
                        archived,
                        match_text: excerpt,
                        message_index: idx,
                    });
                }
                continue;
            }
        }

        // Check parts array (parts may contain {type: "text", text: "..."})
        if let Some(parts) = msg.get("parts").and_then(|p| p.as_array()) {
            for part in parts {
                if results.len() >= max_results {
                    break;
                }
                let text = part
                    .get("text")
                    .and_then(|t| t.as_str())
                    .or_else(|| part.get("content").and_then(|t| t.as_str()));
                if let Some(text) = text {
                    if let Some(excerpt) = extract_match_excerpt(text, query_lower, 50) {
                        results.push(SearchResult {
                            session_id: session_id.clone(),
                            project_id: project_id.to_string(),
                            label: label.clone(),
                            archived,
                            match_text: excerpt,
                            message_index: idx,
                        });
                        break; // One match per message is enough
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn search_sessions(query: String) -> Result<Vec<SearchResult>, String> {
    let query_trimmed = query.trim();
    if query_trimmed.is_empty() {
        return Ok(vec![]);
    }

    let query_lower = query_trimmed.to_lowercase();
    let max_results = 50;
    let mut results = Vec::new();

    let base = match data_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    let projects_dir = base.join("projects");
    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let project_entries = match fs::read_dir(&projects_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(vec![]),
    };

    for project_entry in project_entries {
        if results.len() >= max_results {
            break;
        }

        let project_entry = match project_entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !project_entry
            .file_type()
            .map(|ft| ft.is_dir())
            .unwrap_or(false)
        {
            continue;
        }

        let project_id = project_entry.file_name().to_string_lossy().to_string();
        let sessions_dir = project_entry.path().join("sessions");

        if !sessions_dir.exists() {
            continue;
        }

        let session_files = match fs::read_dir(&sessions_dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for session_entry in session_files {
            if results.len() >= max_results {
                break;
            }

            let session_entry = match session_entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let path = session_entry.path();
            if path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }

            search_session_file(&path, &project_id, &query_lower, &mut results, max_results);
        }
    }

    // Deduplicate: keep only the first result per session (best match)
    let mut seen_sessions = std::collections::HashSet::new();
    results.retain(|r| seen_sessions.insert(format!("{}:{}", r.session_id, r.message_index)));

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_extract_match_excerpt_basic() {
        let text = "The quick brown fox jumps over the lazy dog";
        let excerpt = extract_match_excerpt(text, "brown fox", 10).unwrap();
        assert!(excerpt.contains("brown fox"));
        assert!(excerpt.len() < text.len() + 10); // excerpt should be bounded
    }

    #[test]
    fn test_extract_match_excerpt_at_start() {
        let text = "Hello world this is a test";
        let excerpt = extract_match_excerpt(text, "hello", 5).unwrap();
        assert!(excerpt.starts_with("Hello")); // no leading "..." when match is at start
        assert!(!excerpt.starts_with("..."));
    }

    #[test]
    fn test_extract_match_excerpt_at_end() {
        let text = "This is a test string";
        let excerpt = extract_match_excerpt(text, "string", 5).unwrap();
        assert!(excerpt.contains("string"));
        assert!(!excerpt.ends_with("..."));
    }

    #[test]
    fn test_extract_match_excerpt_no_match() {
        let text = "Hello world";
        assert!(extract_match_excerpt(text, "xyz", 10).is_none());
    }

    #[test]
    fn test_search_finds_content_match() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();

        // Override HOME for the test - we can't do this safely in parallel tests,
        // so we test search_session_file directly instead.
        let session_path = base.join("session.json");
        let session = serde_json::json!({
            "id": "sess-1",
            "label": "My Chat",
            "archived": false,
            "messages": [
                { "role": "user", "content": "Can you help me with Rust programming?" },
                { "role": "assistant", "content": "Sure, Rust is a great systems language." },
            ],
        });
        fs::write(&session_path, serde_json::to_string(&session).unwrap()).unwrap();

        let mut results = Vec::new();
        search_session_file(&session_path, "proj-1", "rust", &mut results, 50);

        assert!(!results.is_empty());
        assert_eq!(results[0].session_id, "sess-1");
        assert_eq!(results[0].project_id, "proj-1");
        assert!(results[0].match_text.to_lowercase().contains("rust"));
    }

    #[test]
    fn test_search_respects_max_results() {
        let tmp = tempfile::tempdir().unwrap();
        let session_path = tmp.path().join("session.json");
        let mut messages = Vec::new();
        for i in 0..100 {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("Message {} about Rust programming", i),
            }));
        }
        let session = serde_json::json!({
            "id": "sess-big",
            "label": "Big Chat",
            "archived": false,
            "messages": messages,
        });
        fs::write(&session_path, serde_json::to_string(&session).unwrap()).unwrap();

        let mut results = Vec::new();
        search_session_file(&session_path, "proj-1", "rust", &mut results, 5);

        assert!(results.len() <= 5);
    }

    #[test]
    fn test_search_finds_parts_content() {
        let tmp = tempfile::tempdir().unwrap();
        let session_path = tmp.path().join("session.json");
        let session = serde_json::json!({
            "id": "sess-parts",
            "label": "Parts Chat",
            "archived": false,
            "messages": [
                {
                    "role": "assistant",
                    "parts": [
                        { "type": "text", "text": "Let me explain how WebAssembly works." },
                    ],
                },
            ],
        });
        fs::write(&session_path, serde_json::to_string(&session).unwrap()).unwrap();

        let mut results = Vec::new();
        search_session_file(&session_path, "proj-1", "webassembly", &mut results, 50);

        assert!(!results.is_empty());
        assert!(results[0].match_text.contains("WebAssembly"));
    }

    #[test]
    fn test_search_returns_archived_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let session_path = tmp.path().join("session.json");
        let session = serde_json::json!({
            "id": "sess-archived",
            "label": "Old Chat",
            "archived": true,
            "messages": [
                { "role": "user", "content": "This is about quantum computing." },
            ],
        });
        fs::write(&session_path, serde_json::to_string(&session).unwrap()).unwrap();

        let mut results = Vec::new();
        search_session_file(&session_path, "proj-1", "quantum", &mut results, 50);

        assert!(!results.is_empty());
        assert!(results[0].archived);
    }

    #[test]
    fn test_search_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let session_path = tmp.path().join("session.json");
        let session = serde_json::json!({
            "id": "sess-case",
            "label": "Case Test",
            "archived": false,
            "messages": [
                { "role": "user", "content": "TypeScript is great for frontend development." },
            ],
        });
        fs::write(&session_path, serde_json::to_string(&session).unwrap()).unwrap();

        let mut results = Vec::new();
        search_session_file(&session_path, "proj-1", "typescript", &mut results, 50);

        assert!(!results.is_empty());
        assert!(results[0].match_text.contains("TypeScript"));
    }

    #[test]
    fn test_search_skips_non_json_files() {
        let tmp = tempfile::tempdir().unwrap();
        let not_json = tmp.path().join("readme.md");
        fs::write(&not_json, "# This mentions Rust").unwrap();

        let mut results = Vec::new();
        search_session_file(&not_json, "proj-1", "rust", &mut results, 50);

        // Should fail to parse as JSON session and return no results
        assert!(results.is_empty());
    }
}
