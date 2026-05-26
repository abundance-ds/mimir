#[derive(serde::Serialize)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
}

#[derive(serde::Serialize)]
pub struct FileLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: String,
    pub insertions: usize,
    pub deletions: usize,
}

#[tauri::command]
pub async fn git_file_log(
    file_path: String,
    limit: Option<usize>,
) -> Result<Vec<FileLogEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        let dir = path
            .parent()
            .ok_or_else(|| "Invalid file path".to_string())?;

        let repo = git2::Repository::discover(dir).map_err(|_| "not_a_repo".to_string())?;

        let workdir = repo
            .workdir()
            .ok_or_else(|| "Bare repository".to_string())?;

        let rel_path = path
            .strip_prefix(workdir)
            .map_err(|_| "File is not inside the repository".to_string())?;
        let rel_str = rel_path
            .to_str()
            .ok_or_else(|| "Non-UTF-8 path".to_string())?;

        if repo.head().is_err() {
            return Ok(Vec::new());
        }

        let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push_head().map_err(|e| e.to_string())?;
        revwalk
            .set_sorting(git2::Sort::TIME)
            .map_err(|e| e.to_string())?;

        let max = limit.unwrap_or(50);
        let mut entries = Vec::new();

        for oid_result in revwalk {
            if entries.len() >= max {
                break;
            }

            let oid = oid_result.map_err(|e| e.to_string())?;
            let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
            let tree = commit.tree().map_err(|e| e.to_string())?;

            if tree.get_path(std::path::Path::new(rel_str)).is_err() {
                continue;
            }

            let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

            let mut diff_opts = git2::DiffOptions::new();
            diff_opts.pathspec(rel_str);

            let diff = repo
                .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut diff_opts))
                .map_err(|e| e.to_string())?;

            let stats = diff.stats().map_err(|e| e.to_string())?;

            if stats.files_changed() == 0 && parent_tree.is_some() {
                continue;
            }

            let time = commit.time();
            let offset = chrono::FixedOffset::east_opt(time.offset_minutes() * 60)
                .unwrap_or_else(|| chrono::FixedOffset::east_opt(0).unwrap());
            let dt = chrono::DateTime::from_timestamp(time.seconds(), 0)
                .unwrap_or_default()
                .with_timezone(&offset);

            let hash_str = oid.to_string();
            let short = hash_str[..7.min(hash_str.len())].to_string();

            entries.push(FileLogEntry {
                hash: hash_str,
                short_hash: short,
                message: commit
                    .message()
                    .unwrap_or("")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string(),
                author: commit.author().name().unwrap_or("Unknown").to_string(),
                timestamp: dt.to_rfc3339(),
                insertions: stats.insertions(),
                deletions: stats.deletions(),
            });
        }

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_file_at_revision(file_path: String, revision: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        let dir = path
            .parent()
            .ok_or_else(|| "Invalid file path".to_string())?;

        let repo = git2::Repository::discover(dir).map_err(|e| format!("Not a git repo: {}", e))?;

        let workdir = repo
            .workdir()
            .ok_or_else(|| "Bare repository".to_string())?;

        let rel_path = path
            .strip_prefix(workdir)
            .map_err(|_| "File is not inside the repository".to_string())?;

        let oid = git2::Oid::from_str(&revision).map_err(|e| format!("Invalid revision: {}", e))?;

        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Commit not found: {}", e))?;

        let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;

        let entry = tree
            .get_path(rel_path)
            .map_err(|_| "File not found at this revision".to_string())?;

        let blob = repo
            .find_blob(entry.id())
            .map_err(|e| format!("Blob error: {}", e))?;

        String::from_utf8(blob.content().to_vec())
            .map_err(|_| "File is not valid UTF-8".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_clone(url: String, target_dir: String) -> Result<String, String> {
    let target = target_dir.clone();
    tokio::task::spawn_blocking(move || {
        git2::Repository::clone(&url, &target).map_err(|e| format!("Clone failed: {}", e))?;
        Ok(target)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_clone_authenticated(
    url: String,
    target_dir: String,
    token: String,
) -> Result<String, String> {
    let target = target_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut callbacks = git2::RemoteCallbacks::new();
        callbacks.credentials(move |_url, username, _allowed| {
            git2::Cred::userpass_plaintext(username.unwrap_or("x-access-token"), &token)
        });
        let mut fetch_opts = git2::FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_opts);
        builder
            .clone(&url, std::path::Path::new(&target))
            .map_err(|e| format!("Authenticated clone failed: {}", e))?;
        Ok(target)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    let repo = git2::Repository::init(&path).map_err(|e| format!("Init failed: {}", e))?;

    let gitignore_path = std::path::Path::new(&path).join(".gitignore");
    if !gitignore_path.exists() {
        std::fs::write(
            &gitignore_path,
            ".shoulders.json\n.DS_Store\nnode_modules/\n",
        )
        .map_err(|e| format!("Failed to write .gitignore: {}", e))?;
    }

    Ok(repo
        .workdir()
        .unwrap_or(std::path::Path::new(&path))
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn git_status(path: String) -> Result<Vec<GitStatusEntry>, String> {
    let repo = git2::Repository::open(&path).map_err(|e| format!("Not a git repo: {}", e))?;

    let statuses = repo
        .statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))
        .map_err(|e| format!("Status failed: {}", e))?;

    let entries: Vec<GitStatusEntry> = statuses
        .iter()
        .filter_map(|entry| {
            let path = entry.path()?.to_string();
            let status = entry.status();
            let label = if status.is_index_new() || status.is_wt_new() {
                "new"
            } else if status.is_index_modified() || status.is_wt_modified() {
                "modified"
            } else if status.is_index_deleted() || status.is_wt_deleted() {
                "deleted"
            } else if status.is_index_renamed() || status.is_wt_renamed() {
                "renamed"
            } else {
                return None;
            };
            Some(GitStatusEntry {
                path,
                status: label.to_string(),
            })
        })
        .collect();

    Ok(entries)
}
