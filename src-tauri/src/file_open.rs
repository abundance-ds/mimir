use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct PendingFilePaths(pub Mutex<Vec<String>>);

#[tauri::command]
pub fn take_pending_files(state: tauri::State<'_, PendingFilePaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

const SUPPORTED_EXTENSIONS: &[&str] = &[".md", ".markdown", ".txt"];

pub fn filter_file_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let lower = a.to_lowercase();
            SUPPORTED_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
        })
        .cloned()
        .collect()
}

#[tauri::command]
pub fn open_files_in_editor(app: tauri::AppHandle, paths: Vec<String>) {
    do_open_files_in_editor(&app, paths);
}

pub fn do_open_files_in_editor(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("mim://open-file", &paths);
        let _ = win.set_focus();
    } else {
        let state = app.state::<PendingFilePaths>();
        *state.0.lock().unwrap() = paths;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_md_and_txt_files() {
        let args = vec![
            "/usr/bin/mim-terminal".into(),
            "/docs/readme.md".into(),
            "/docs/notes.txt".into(),
            "/docs/image.png".into(),
        ];
        let result = filter_file_args(&args);
        assert_eq!(result, vec!["/docs/readme.md", "/docs/notes.txt"]);
    }

    #[test]
    fn supports_markdown_extension() {
        let args = vec!["binary".into(), "file.markdown".into()];
        assert_eq!(filter_file_args(&args), vec!["file.markdown"]);
    }

    #[test]
    fn case_insensitive() {
        let args = vec!["binary".into(), "FILE.MD".into(), "Notes.TXT".into()];
        let result = filter_file_args(&args);
        assert_eq!(result, vec!["FILE.MD", "Notes.TXT"]);
    }

    #[test]
    fn skips_flags() {
        let args = vec![
            "binary".into(),
            "--verbose".into(),
            "-f".into(),
            "file.md".into(),
        ];
        assert_eq!(filter_file_args(&args), vec!["file.md"]);
    }

    #[test]
    fn skips_binary_path() {
        let args = vec!["/usr/bin/mim-terminal".into()];
        assert!(filter_file_args(&args).is_empty());
    }

    #[test]
    fn empty_args() {
        let args: Vec<String> = vec![];
        assert!(filter_file_args(&args).is_empty());
    }

    #[test]
    fn skips_unsupported_extensions() {
        let args = vec![
            "binary".into(),
            "style.css".into(),
            "app.js".into(),
            "data.json".into(),
        ];
        assert!(filter_file_args(&args).is_empty());
    }
}
