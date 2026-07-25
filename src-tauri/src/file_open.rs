use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct PendingFilePaths(pub Mutex<Vec<String>>);

impl PendingFilePaths {
    fn enqueue(&self, paths: impl IntoIterator<Item = String>) {
        let mut pending = self.0.lock().unwrap();
        for path in paths {
            if !pending.contains(&path) {
                pending.push(path);
            }
        }
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

#[tauri::command]
pub fn take_pending_files(state: tauri::State<'_, PendingFilePaths>) -> Vec<String> {
    state.take()
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

pub fn resolve_file_args(args: &[String], cwd: &Path) -> Vec<String> {
    filter_file_args(args)
        .into_iter()
        .map(|argument| {
            let path = PathBuf::from(argument);
            let absolute = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            absolute
                .canonicalize()
                .unwrap_or(absolute)
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

pub fn file_paths_from_urls(urls: &[url::Url]) -> Vec<String> {
    urls.iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| match url.to_file_path() {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(()) => {
                log::warn!("Could not convert file-open URL to a local path: {url}");
                None
            }
        })
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

    app.state::<PendingFilePaths>().enqueue(paths);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("mim://open-files-pending", ());
        let _ = win.set_focus();
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

    #[test]
    fn resolves_relative_single_instance_paths_against_sender_cwd() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("notes");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("hello world.md");
        std::fs::write(&file, "# hello").unwrap();
        let args = vec!["mim".into(), "notes/hello world.md".into()];

        assert_eq!(
            resolve_file_args(&args, root.path()),
            vec![file.canonicalize().unwrap().to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn decodes_spaces_and_unicode_in_file_urls() {
        let url = url::Url::parse("file:///tmp/Mim%20Notes/%E2%9C%A8.md").unwrap();
        let paths = file_paths_from_urls(&[url]);

        assert_eq!(paths, vec!["/tmp/Mim Notes/✨.md"]);
    }

    #[test]
    fn pending_queue_appends_without_duplicates_and_drains_once() {
        let pending = PendingFilePaths::default();
        pending.enqueue(vec!["/one.md".into(), "/two.md".into()]);
        pending.enqueue(vec!["/two.md".into(), "/three.txt".into()]);

        assert_eq!(pending.take(), vec!["/one.md", "/two.md", "/three.txt"]);
        assert!(pending.take().is_empty());
    }
}
