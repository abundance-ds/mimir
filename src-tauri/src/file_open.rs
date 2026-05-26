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

pub fn create_editor_window<M: Manager<tauri::Wry>>(
    manager: &M,
) -> tauri::Result<tauri::WebviewWindow> {
    let label = format!(
        "editor-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let url = format!("/?view=editor&window={}&new=1", label);
    let mut builder =
        tauri::WebviewWindowBuilder::new(manager, &label, tauri::WebviewUrl::App(url.into()))
            .title("Mim Panel")
            .inner_size(1280.0, 860.0)
            .min_inner_size(300.0, 620.0)
            .center()
            .decorations(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder.build()
}

#[tauri::command]
pub fn open_files_in_editor(app: tauri::AppHandle, paths: Vec<String>) {
    do_open_files_in_editor(&app, paths);
}

pub fn do_open_files_in_editor(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    let editor_win = app
        .webview_windows()
        .into_iter()
        .find(|(label, _)| label.starts_with("editor-"))
        .map(|(_, w)| w);

    if let Some(win) = editor_win {
        let _ = win.emit("shoulders://open-file", &paths);
        let _ = win.set_focus();
    } else {
        let state = app.state::<PendingFilePaths>();
        *state.0.lock().unwrap() = paths;
        let _ = create_editor_window(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_md_and_txt_files() {
        let args = vec![
            "/usr/bin/shoulders".into(),
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
        let args = vec!["/usr/bin/shoulders".into()];
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
