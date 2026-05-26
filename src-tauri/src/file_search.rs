use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub snippet: String,
}

const MAX_RESULTS: usize = 100;

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".DS_Store",
    "__pycache__",
    ".next",
    "dist",
    ".svn",
];

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "pdf", "zip", "gz", "tar", "rar",
    "7z", "exe", "dll", "so", "dylib", "o", "a", "woff", "woff2", "ttf", "otf", "eot", "mp3",
    "mp4", "wav", "avi", "mov", "mkv", "db", "sqlite", "sqlite3", "wasm",
];

fn is_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| BINARY_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

fn walk_and_search(
    dir: &Path,
    query_lower: &str,
    file_pattern: Option<&str>,
    results: &mut Vec<SearchMatch>,
    max: usize,
) {
    if results.len() >= max {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries {
        if results.len() >= max {
            return;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            walk_and_search(&path, query_lower, file_pattern, results, max);
            continue;
        }

        if is_binary_extension(&path) {
            continue;
        }

        // Apply file pattern filter if provided (simple glob: *.ext)
        if let Some(pattern) = file_pattern {
            let pat = pattern.trim();
            if !pat.is_empty() {
                if let Some(suffix) = pat.strip_prefix('*') {
                    if !name.ends_with(suffix) {
                        continue;
                    }
                } else if name != pat {
                    continue;
                }
            }
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue, // skip files that can't be read as text
        };

        let content_lower = content.to_lowercase();
        for (line_idx, line) in content_lower.lines().enumerate() {
            if results.len() >= max {
                return;
            }
            if line.contains(query_lower) {
                // Get the original-case line
                let original_line: String = content.lines().nth(line_idx).unwrap_or("").to_string();

                results.push(SearchMatch {
                    path: path.to_string_lossy().to_string(),
                    line: line_idx + 1,
                    snippet: if original_line.len() > 300 {
                        format!("{}...", &original_line[..300])
                    } else {
                        original_line
                    },
                });
            }
        }
    }
}

#[tauri::command]
pub fn search_file_content(
    path: String,
    query: String,
    file_pattern: Option<String>,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let query_lower = query.to_lowercase();
    let max = max_results.unwrap_or(MAX_RESULTS).min(MAX_RESULTS);
    let mut results = Vec::new();

    walk_and_search(
        dir,
        &query_lower,
        file_pattern.as_deref(),
        &mut results,
        max,
    );

    Ok(results)
}
