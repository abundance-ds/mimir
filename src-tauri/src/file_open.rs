use std::{
    io::Read,
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

#[cfg(any(target_os = "macos", test))]
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

fn resolve_html_path(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open {path}: {error}"))?;
    if !target.is_file() {
        return Err(format!("Could not open {path}: the path is not a file"));
    }

    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "htm" | "html") {
        return Err("Only HTML files can open in the browser.".into());
    }
    Ok(target)
}

#[tauri::command]
pub fn open_html_in_browser(path: String) -> Result<(), String> {
    let target = resolve_html_path(&path)?;
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|error| format!("Could not open {}: {error}", target.display()))
}

pub(crate) fn read_binary_bytes(path: &str, max_bytes: Option<u64>) -> Result<Vec<u8>, String> {
    let Some(limit) = max_bytes else {
        return std::fs::read(path).map_err(|error| format!("Could not read {path}: {error}"));
    };
    let too_large =
        || "This image is too large to preview. Open it in the default app.".to_string();
    let file =
        std::fs::File::open(path).map_err(|error| format!("Could not read {path}: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("The preview path is not a file.".into());
    }
    if metadata.len() > limit {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    Ok(bytes)
}

fn resolve_preview_path(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open {path}: {error}"))?;
    if !target.is_file() {
        return Err("The preview path is not a file.".into());
    }
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "pdf" | "jpg" | "jpeg" | "png" | "webp" | "gif" | "svg"
    ) {
        return Err("Only images and PDF files can open from a preview.".into());
    }
    Ok(target)
}

#[tauri::command]
pub fn open_preview_in_default_app(path: String) -> Result<(), String> {
    let target = resolve_preview_path(&path)?;
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|error| format!("Could not open {}: {error}", target.display()))
}

pub fn do_open_files_in_editor(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    app.state::<PendingFilePaths>().enqueue(paths);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("mimir://open-files-pending", ());
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_md_and_txt_files() {
        let args = vec![
            "/usr/bin/mimir".into(),
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
        let args = vec!["/usr/bin/mimir".into()];
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
        let args = vec!["mimir".into(), "notes/hello world.md".into()];

        assert_eq!(
            resolve_file_args(&args, root.path()),
            vec![file.canonicalize().unwrap().to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn decodes_spaces_and_unicode_in_file_urls() {
        let url = url::Url::parse("file:///tmp/Mimir%20Notes/%E2%9C%A8.md").unwrap();
        let paths = file_paths_from_urls(&[url]);

        assert_eq!(paths, vec!["/tmp/Mimir Notes/✨.md"]);
    }

    #[test]
    fn pending_queue_appends_without_duplicates_and_drains_once() {
        let pending = PendingFilePaths::default();
        pending.enqueue(vec!["/one.md".into(), "/two.md".into()]);
        pending.enqueue(vec!["/two.md".into(), "/three.txt".into()]);

        assert_eq!(pending.take(), vec!["/one.md", "/two.md", "/three.txt"]);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn accepts_existing_html_files_case_insensitively() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("Preview.HTML");
        std::fs::write(&file, "<!doctype html>").unwrap();

        assert_eq!(
            resolve_html_path(file.to_str().unwrap()).unwrap(),
            file.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_non_html_files() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("notes.md");
        std::fs::write(&file, "# Notes").unwrap();

        assert_eq!(
            resolve_html_path(file.to_str().unwrap()).unwrap_err(),
            "Only HTML files can open in the browser."
        );
    }
    #[test]
    fn preview_paths_accept_images_and_pdfs_outside_the_workspace() {
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "photo.JPG",
            "photo.jpeg",
            "photo.png",
            "photo.webp",
            "photo.gif",
            "logo.svg",
            "report.pdf",
        ] {
            let file = directory.path().join(name);
            std::fs::write(&file, "sample").unwrap();
            assert_eq!(
                resolve_preview_path(file.to_str().unwrap()).unwrap(),
                file.canonicalize().unwrap()
            );
        }
    }

    #[test]
    fn preview_paths_reject_missing_files_directories_and_other_types() {
        let directory = tempfile::tempdir().unwrap();
        assert!(resolve_preview_path(directory.path().to_str().unwrap()).is_err());
        assert!(
            resolve_preview_path(directory.path().join("missing.png").to_str().unwrap()).is_err()
        );
        let file = directory.path().join("script.sh");
        std::fs::write(&file, "echo sample").unwrap();
        assert!(resolve_preview_path(file.to_str().unwrap()).is_err());
    }
    #[test]
    fn bounded_binary_reads_accept_the_limit_and_reject_larger_files() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("photo.png");
        std::fs::write(&file, [1, 2, 3]).unwrap();
        let path = file.to_str().unwrap();
        assert_eq!(read_binary_bytes(path, Some(3)).unwrap(), vec![1, 2, 3]);
        assert!(read_binary_bytes(path, Some(2))
            .unwrap_err()
            .contains("too large"));
        assert_eq!(read_binary_bytes(path, None).unwrap(), vec![1, 2, 3]);
        assert!(read_binary_bytes(directory.path().to_str().unwrap(), Some(3)).is_err());
    }
}
