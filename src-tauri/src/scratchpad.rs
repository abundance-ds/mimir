//! One shared Markdown file and a bounded journal of settled saves.
use crate::persistence::{self, QuarantinedLoad};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

const HEADER: &str = "<!-- Mimir scratchpad: shared across projects.\nProject scratchpad.md paths may be symbolic links to this file.\nEdit ~/.mimir/scratchpad.md directly; keep project links intact.\nMimir keeps the last 100 saved states while it is running.\n-->\n\n";
const LIMIT: usize = 100;
static LINKS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedText {
    pub time: u64,
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub content: String,
    pub history: Vec<SavedText>,
}

struct Notebook {
    path: PathBuf,
    journal: PathBuf,
    history: Vec<SavedText>,
}

pub fn body(raw: &str) -> &str {
    if raw.starts_with("<!-- Mimir scratchpad:") {
        if let Some(end) = raw.find("-->") {
            return raw[end + 3..]
                .strip_prefix("\r\n\r\n")
                .or_else(|| raw[end + 3..].strip_prefix("\n\n"))
                .or_else(|| raw[end + 3..].strip_prefix('\n'))
                .unwrap_or(&raw[end + 3..]);
        }
    }
    raw
}

pub fn path_at(home: &Path) -> PathBuf {
    home.join(".mimir/scratchpad.md")
}

fn ensure_file(home: &Path) -> Result<PathBuf, String> {
    let path = path_at(home);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    // create_new cannot overwrite an existing file, including a broken link.
    use std::io::Write;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => file
            .write_all(HEADER.as_bytes())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(path)
}

impl Notebook {
    fn open(home: &Path) -> Result<Self, String> {
        let path = ensure_file(home)?;
        let journal = home.join(".mimir/scratchpad-history.json");
        let history = match persistence::load_json_optional_quarantining(&journal)
            .map_err(|e| e.to_string())?
        {
            QuarantinedLoad::Loaded(value) => value,
            QuarantinedLoad::Missing | QuarantinedLoad::Quarantined { .. } => Vec::new(),
        };
        let mut notebook = Self {
            path,
            journal,
            history,
        };
        notebook.refresh()?;
        Ok(notebook)
    }

    fn remember(&mut self, content: &str) -> Result<(), String> {
        if self.history.last().is_some_and(|s| s.content == content) {
            return Ok(());
        }
        let mut next = self.history.clone();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let time = now.max(next.last().map_or(0, |s| s.time + 1));
        next.push(SavedText {
            time,
            content: content.to_owned(),
        });
        if next.len() > LIMIT {
            next.drain(..next.len() - LIMIT);
        }
        persistence::write_json_atomic(&self.journal, &next).map_err(|e| e.to_string())?;
        self.history = next;
        Ok(())
    }

    fn refresh(&mut self) -> Result<bool, String> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            // A delete/recreate save can briefly leave the path absent. Never
            // recreate it in this interval or record an empty intermediate state.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("Could not read Scratchpad: {e}")),
        };
        let content = body(&raw);
        let changed = self.history.last().is_none_or(|s| s.content != content);
        if changed {
            self.remember(content)?;
        }
        // Preserve the explanation after whole-file agent writes. Check again
        // before normalization so a later edit is left for the next pass.
        if !raw.starts_with(HEADER) && fs::read_to_string(&self.path).ok().as_deref() == Some(&raw)
        {
            persistence::write_bytes_atomic(&self.path, format!("{HEADER}{content}").as_bytes())
                .map_err(|e| e.to_string())?;
        }
        Ok(changed)
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            path: self.path.to_string_lossy().into_owned(),
            content: self
                .history
                .last()
                .map(|s| s.content.clone())
                .unwrap_or_default(),
            history: self.history.clone(),
        }
    }

    fn save(&mut self, content: &str, expected: &str) -> Result<Snapshot, String> {
        self.refresh()?;
        let current = self.snapshot().content;
        if current != expected && current != content {
            return Err("Scratchpad changed outside the Editor. Your text is still here. Use Keep my text or Use latest.".into());
        }
        // Journal first: both sides remain recoverable even if writing fails.
        self.remember(content)?;
        persistence::write_bytes_atomic(&self.path, format!("{HEADER}{content}").as_bytes())
            .map_err(|e| format!("Could not save Scratchpad: {e}"))?;
        Ok(self.snapshot())
    }
}

fn notebook() -> &'static Mutex<Option<Notebook>> {
    static STATE: OnceLock<Mutex<Option<Notebook>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn with_notebook<T>(f: impl FnOnce(&mut Notebook) -> Result<T, String>) -> Result<T, String> {
    let mut state = notebook().lock().map_err(|e| e.to_string())?;
    if state.is_none() {
        let home = dirs::home_dir().ok_or("Could not find the home folder.")?;
        *state = Some(Notebook::open(&home)?);
    }
    f(state.as_mut().unwrap())
}

fn start_watch(app: tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        match with_notebook(|book| {
            let mut changed = book.refresh()?;
            if let Some(home) = dirs::home_dir() {
                changed |= repair_aliases(&home, book)?;
            }
            Ok(changed)
        }) {
            Ok(true) => {
                let _ = app.emit("mimir://scratchpad-changed", ());
            }
            Ok(false) => {}
            Err(error) => log::warn!("Scratchpad: {error}"),
        }
    });
}

#[tauri::command]
pub fn scratchpad_snapshot(app: tauri::AppHandle) -> Result<Snapshot, String> {
    let result = with_notebook(|book| {
        book.refresh()?;
        Ok(book.snapshot())
    });
    start_watch(app);
    result
}

#[tauri::command]
pub fn scratchpad_save(content: String, expected: String) -> Result<Snapshot, String> {
    with_notebook(|book| book.save(&content, &expected))
}

#[tauri::command]
pub fn scratchpad_resolve(path: String) -> Option<String> {
    let home = dirs::home_dir()?;
    let target = path_at(&home);
    let path = Path::new(&path);
    if path == target || is_alias(path, &target) {
        Some(target.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
pub fn scratchpad_prepare(workspace: String) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Could not find the home folder.")?;
    prepare_alias(&home, Path::new(&workspace))
}

pub fn is_alias(path: &Path, target: &Path) -> bool {
    fs::read_link(path).ok().is_some_and(|link| {
        let resolved = if link.is_absolute() {
            link
        } else {
            path.parent().unwrap_or(Path::new(".")).join(link)
        };
        resolved == target
            || resolved
                .canonicalize()
                .ok()
                .is_some_and(|p| Some(p) == target.canonicalize().ok())
    })
}

fn aliases_path(home: &Path) -> PathBuf {
    home.join(".mimir/scratchpad-links.json")
}
fn aliases(home: &Path) -> Result<Vec<PathBuf>, String> {
    match persistence::load_json_optional_quarantining(aliases_path(home))
        .map_err(|e| e.to_string())?
    {
        QuarantinedLoad::Loaded(value) => Ok(value),
        _ => Ok(Vec::new()),
    }
}

fn git(workspace: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn append_rules(path: &Path, rules: &[String]) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "{} is a symbolic link. Mimir will not change shared ignore rules.",
            path.display()
        ));
    }
    let mut text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    let missing: Vec<_> = rules
        .iter()
        .filter(|rule| !text.lines().any(|l| l == rule.as_str()))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("\n# Mimir: shared Scratchpad link (local to this project)\n");
    for rule in missing {
        text.push_str(rule);
        text.push('\n');
    }
    persistence::write_bytes_atomic(path, text.as_bytes()).map_err(|e| e.to_string())
}

/// Only register links we create (or links already pointing to our file).
/// A normal project file with the same name is never changed or ignored.
pub fn prepare_alias(home: &Path, workspace: &Path) -> Result<bool, String> {
    let _guard = LINKS_LOCK.lock().map_err(|e| e.to_string())?;
    let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
    let workspace = workspace.as_path();
    let target = ensure_file(home)?;
    let link = workspace.join("scratchpad.md");
    if link == target {
        return Ok(false);
    }
    if fs::symlink_metadata(&link).is_ok() && !is_alias(&link, &target) {
        return Ok(false);
    }
    if git(
        workspace,
        &["ls-files", "--error-unmatch", "--", "scratchpad.md"],
    )
    .is_some()
    {
        return Ok(false);
    }
    if fs::symlink_metadata(&link).is_err() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        return Ok(false);
    }
    // Keep recovery active even if a later ignore-file update fails.
    let mut owned = aliases(home)?;
    if !owned.contains(&link) {
        owned.push(link.clone());
        persistence::write_json_atomic(aliases_path(home), &owned).map_err(|e| e.to_string())?;
    }
    let ignore = workspace.join(".ignore");
    let created_ignore = !ignore.exists();
    if let (Some(root), Some(exclude)) = (
        git(workspace, &["rev-parse", "--show-toplevel"]),
        git(
            workspace,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        ),
    ) {
        let relative = link
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_string_lossy();
        let mut rules = vec![format!("/{relative}")];
        if created_ignore {
            let relative = ignore
                .strip_prefix(&root)
                .map_err(|e| e.to_string())?
                .to_string_lossy();
            rules.push(format!("/{relative}"));
        }
        append_rules(Path::new(&exclude), &rules)?;
        if git(workspace, &["check-ignore", "--", "scratchpad.md"]).is_none() {
            return Err("The local Git rules do not exclude Mimir's scratchpad.md link.".into());
        }
    }
    append_rules(&ignore, &["!/scratchpad.md".into()])?;
    Ok(true)
}

fn repair_aliases(home: &Path, book: &mut Notebook) -> Result<bool, String> {
    let _guard = LINKS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut changed = false;
    let mut owned = aliases(home)?;
    let mut released = Vec::new();
    for link in &owned {
        if is_alias(link, &book.path) || !link.parent().is_some_and(Path::is_dir) {
            continue;
        }
        // An unrelated replacement link belongs to its author.
        if fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
            continue;
        }
        // Git may now own a normal replacement or a tracked deletion. Stop
        // managing that path; a later Git removal must not recreate our link.
        if git(
            link.parent().unwrap(),
            &["ls-files", "--error-unmatch", "--", "scratchpad.md"],
        )
        .is_some()
        {
            released.push(link.clone());
            continue;
        }
        if let Ok(raw) = fs::read_to_string(link) {
            let content = body(&raw);
            let expected = book.snapshot().content;
            book.save(content, &expected)?;
            // Preserve the detached file itself as well as its journal entry.
            let recovery = link.with_file_name(format!(
                "scratchpad-recovered-{}.md",
                book.history.last().unwrap().time
            ));
            fs::rename(link, recovery).map_err(|e| e.to_string())?;
            changed = true;
        } else if link.exists() {
            continue;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&book.path, link).map_err(|e| e.to_string())?;
    }
    if !released.is_empty() {
        owned.retain(|link| !released.contains(link));
        persistence::write_json_atomic(aliases_path(home), &owned).map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn saves_external_edits_and_restores_without_erasing_later_text() {
        let home = tempdir().unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        book.save("First", "").unwrap();
        fs::write(&book.path, "Agent edit").unwrap();
        assert!(book.refresh().unwrap());
        assert!(!book.refresh().unwrap());
        assert!(fs::read_to_string(&book.path).unwrap().starts_with(HEADER));
        assert!(book.save("Unsaved human text", "First").is_err());
        assert_eq!(body(&fs::read_to_string(&book.path).unwrap()), "Agent edit");
        book.save("First", "Agent edit").unwrap();
        let restored = Notebook::open(home.path()).unwrap();
        assert_eq!(
            restored
                .history
                .iter()
                .map(|s| s.content.as_str())
                .collect::<Vec<_>>(),
            ["", "First", "Agent edit", "First"]
        );
    }

    #[test]
    fn bounds_history_and_does_not_treat_missing_file_as_clear() {
        let home = tempdir().unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        for n in 0..105 {
            book.save(&n.to_string(), &book.snapshot().content).unwrap();
        }
        assert_eq!(book.history.len(), 100);
        assert_eq!(book.history.first().unwrap().content, "5");
        assert!(book
            .history
            .windows(2)
            .all(|pair| pair[0].time < pair[1].time));
        fs::remove_file(&book.path).unwrap();
        assert!(!book.refresh().unwrap());
        assert_eq!(book.snapshot().content, "104");
    }

    #[test]
    fn captures_final_text_written_while_closed() {
        let home = tempdir().unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        book.save("Before closing", "").unwrap();
        let path = book.path.clone();
        drop(book);
        fs::write(&path, "Intermediate offline text").unwrap();
        fs::write(&path, "Final offline text").unwrap();
        let book = Notebook::open(home.path()).unwrap();
        assert_eq!(
            book.history
                .iter()
                .map(|s| s.content.as_str())
                .collect::<Vec<_>>(),
            ["", "Before closing", "Final offline text"]
        );
        assert!(fs::read_to_string(path).unwrap().starts_with(HEADER));
    }

    #[test]
    fn preserves_corrupt_history_and_recovers_the_live_text() {
        let home = tempdir().unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        book.save("Keep this text", "").unwrap();
        let journal = book.journal.clone();
        drop(book);
        let corrupt = "{broken history";
        fs::write(&journal, corrupt).unwrap();
        let book = Notebook::open(home.path()).unwrap();
        assert_eq!(book.snapshot().content, "Keep this text");
        assert_eq!(book.history.len(), 1);
        assert!(fs::read_dir(journal.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|entry| {
                entry.path() != journal
                    && fs::read_to_string(entry.path()).ok().as_deref() == Some(corrupt)
            }));
    }

    #[test]
    fn journal_failure_leaves_the_file_and_memory_unchanged_and_allows_retry() {
        let home = tempdir().unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        book.save("Saved", "").unwrap();
        let journal = book.journal.clone();
        book.journal = home.path().join("blocked");
        fs::create_dir(&book.journal).unwrap();
        assert!(book.save("Unsaved", "Saved").is_err());
        assert_eq!(book.snapshot().content, "Saved");
        assert_eq!(body(&fs::read_to_string(&book.path).unwrap()), "Saved");
        book.journal = journal;
        book.save("Unsaved", "Saved").unwrap();
        assert_eq!(book.snapshot().content, "Unsaved");
    }

    #[test]
    #[cfg(unix)]
    fn tracked_replacement_and_its_deletion_are_not_repaired() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        git(workspace.path(), &["init"]).unwrap();
        prepare_alias(home.path(), workspace.path()).unwrap();
        let link = workspace.path().join("scratchpad.md");
        fs::remove_file(&link).unwrap();
        fs::write(&link, "Project document").unwrap();
        git(workspace.path(), &["add", "-f", "--", "scratchpad.md"]).unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        book.save("Shared text", "").unwrap();
        assert!(!repair_aliases(home.path(), &mut book).unwrap());
        assert!(!fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&link).unwrap(), "Project document");
        assert!(aliases(home.path()).unwrap().is_empty());
        git(
            workspace.path(),
            &["rm", "--cached", "-f", "--", "scratchpad.md"],
        )
        .unwrap();
        fs::remove_file(&link).unwrap();
        assert!(!repair_aliases(home.path(), &mut book).unwrap());
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(book.snapshot().content, "Shared text");
    }

    #[test]
    #[cfg(unix)]
    fn ignore_setup_failure_does_not_abandon_an_owned_link() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let shared_ignore = home.path().join("shared-ignore");
        fs::write(&shared_ignore, "build/\n").unwrap();
        std::os::unix::fs::symlink(&shared_ignore, workspace.path().join(".ignore")).unwrap();
        assert!(prepare_alias(home.path(), workspace.path()).is_err());
        assert_eq!(fs::read_to_string(shared_ignore).unwrap(), "build/\n");
        let link = workspace.path().join("scratchpad.md");
        fs::remove_file(&link).unwrap();
        fs::write(&link, "Detached save").unwrap();
        let mut book = Notebook::open(home.path()).unwrap();
        assert!(repair_aliases(home.path(), &mut book).unwrap());
        assert!(is_alias(&link, &book.path));
        assert_eq!(book.snapshot().content, "Detached save");
    }

    #[test]
    fn existing_project_file_and_ignore_rules_are_preserved() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("scratchpad.md"), "Project document").unwrap();
        assert!(!prepare_alias(home.path(), workspace.path()).unwrap());
        assert_eq!(
            fs::read_to_string(workspace.path().join("scratchpad.md")).unwrap(),
            "Project document"
        );
        assert!(!workspace.path().join(".ignore").exists());
    }

    #[test]
    #[cfg(unix)]
    fn owned_link_is_locally_excluded_but_visible_to_file_completion_and_repaired() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        git(workspace.path(), &["init"]).unwrap();
        fs::write(workspace.path().join(".ignore"), "build/\n").unwrap();
        assert!(prepare_alias(home.path(), workspace.path()).unwrap());
        assert!(git(workspace.path(), &["check-ignore", "scratchpad.md"]).is_some());
        assert_eq!(
            fs::read_to_string(workspace.path().join(".ignore")).unwrap(),
            "build/\n\n# Mimir: shared Scratchpad link (local to this project)\n!/scratchpad.md\n"
        );
        let first = fs::read(workspace.path().join(".ignore")).unwrap();
        prepare_alias(home.path(), workspace.path()).unwrap();
        assert_eq!(fs::read(workspace.path().join(".ignore")).unwrap(), first);
        if let Ok(output) = std::process::Command::new("rg")
            .args(["--files", "--follow", "--hidden"])
            .current_dir(workspace.path())
            .output()
        {
            assert!(String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|s| s == "scratchpad.md"));
        }
        let mut book = Notebook::open(home.path()).unwrap();
        book.save("Central", "").unwrap();
        let link = workspace.path().join("scratchpad.md");
        fs::remove_file(&link).unwrap();
        fs::write(&link, "Detached agent save").unwrap();
        assert!(repair_aliases(home.path(), &mut book).unwrap());
        assert!(is_alias(&link, &book.path));
        assert_eq!(book.snapshot().content, "Detached agent save");
        assert!(book.history.iter().any(|s| s.content == "Central"));
        assert!(fs::read_dir(workspace.path()).unwrap().flatten().any(|p| p
            .file_name()
            .to_string_lossy()
            .starts_with("scratchpad-recovered-")));
    }

    #[test]
    #[cfg(unix)]
    fn worktree_exclude_uses_git_path_and_no_global_rules() {
        let home = tempdir().unwrap();
        let repo = tempdir().unwrap();
        let linked = repo.path().join("linked");
        git(repo.path(), &["init"]).unwrap();
        git(
            repo.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ],
        )
        .unwrap();
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "test-worktree",
                linked.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(prepare_alias(home.path(), &linked).unwrap());
        assert!(git(&linked, &["check-ignore", "scratchpad.md"]).is_some());
        assert!(git(&linked, &["status", "--porcelain"]).unwrap().is_empty());
        assert!(!repo.path().join(".gitignore").exists());
        assert!(!home.path().join(".gitignore").exists());
    }
}
