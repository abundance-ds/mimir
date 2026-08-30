use super::*;

pub(super) fn validate_component(value: &str, label: &'static str) -> Result<(), String> {
    ConfigIdentifier::new(value.to_string(), label)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(super) fn secure_platform_paths(paths: &MeetingPlatformPaths) -> Result<(), String> {
    let config_root = paths
        .config_file
        .parent()
        .ok_or_else(|| "Meeting settings path has no private parent directory".to_string())?;
    ensure_private_directory(config_root)
        .map_err(|error| format!("Could not secure Mimir's private data directory: {error}"))?;

    for directory in [
        &paths.meetings_root,
        &paths.content_root,
        &paths.exports_root,
        &paths.models_root,
    ] {
        let relative = directory.strip_prefix(config_root).map_err(|_| {
            format!(
                "Managed Scribe directory {} is outside its private root",
                directory.display()
            )
        })?;
        ensure_private_subdirectory(config_root, relative).map_err(|error| {
            format!(
                "Could not secure managed Scribe directory {}: {error}",
                directory.display()
            )
        })?;
    }

    repair_private_file_if_exists(&paths.config_file)
        .map_err(|error| format!("Could not repair meeting settings permissions: {error}"))?;
    // These roots are mode 0700. Files created below them already use the
    // private persistence helpers, so recursively chmod/stat-ing every audio
    // chunk and large model on each launch adds no isolation and makes Scribe
    // startup grow with recording history.
    Ok(())
}

pub(super) fn safe_direct_child(root: &Path, child: &str) -> Result<PathBuf, String> {
    validate_component(child, "path component")?;
    reject_symlink(root)?;
    // ConfigIdentifier permits no separators or traversal components, so this
    // is exactly one lexical child of the already checked managed root.
    Ok(root.join(child))
}

pub(super) fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to use symbolic link at managed meeting path {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

pub(super) fn remove_path_without_following(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to delete symbolic link at managed meeting path {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|error| format!("Could not delete {}: {error}", path.display()))
}

pub(super) fn collect_model_partials(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".model-") || !name.ends_with(".part") {
            continue;
        }
        if entry
            .file_type()
            .map(|kind| kind.is_file() || kind.is_symlink())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub(super) fn copy_path_without_symlinks(source: &Path, destination: &Path) -> Result<u64, String> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Could not inspect {}: {error}", source.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to export symbolic link from managed meeting path {}",
            source.display()
        ));
    }
    if metadata.is_file() {
        repair_private_file(source)
            .map_err(|error| format!("Could not secure source audio artifact: {error}"))?;
        if let Some(parent) = destination.parent() {
            ensure_private_directory(parent).map_err(|error| {
                format!("Could not secure private audio export directory: {error}")
            })?;
        }
        let mut input =
            File::open(source).map_err(|error| format!("Could not read audio export: {error}"))?;
        let mut output = create_private_new_file(destination)?;
        let copied = io::copy(&mut input, &mut output)
            .map_err(|error| format!("Could not copy audio export: {error}"))?;
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("Could not durably flush audio export: {error}"))?;
        return Ok(copied);
    }
    if !metadata.is_dir() {
        return Err(format!(
            "Unsupported file type in meeting audio export: {}",
            source.display()
        ));
    }
    create_private_new_directory(destination)?;
    let mut copied = 0_u64;
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("Could not read meeting audio directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read meeting audio directory: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        if Path::new(&name).components().count() != 1 {
            return Err("Invalid filename in meeting audio directory".into());
        }
        copied += copy_path_without_symlinks(&entry.path(), &destination.join(name))?;
    }
    Ok(copied)
}

pub(super) struct PendingPath {
    path: PathBuf,
    directory: bool,
    armed: bool,
}

impl PendingPath {
    pub(super) fn file(path: PathBuf) -> Self {
        Self {
            path,
            directory: false,
            armed: true,
        }
    }

    pub(super) fn directory(path: PathBuf) -> Self {
        Self {
            path,
            directory: true,
            armed: true,
        }
    }

    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingPath {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if self.directory {
            let _ = fs::remove_dir_all(&self.path);
        } else {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(super) fn create_private_new_file(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Private file {} has no parent directory", path.display()))?;
    ensure_private_directory(parent)
        .map_err(|error| format!("Could not secure private file parent: {error}"))?;
    repair_private_file_if_exists(path)
        .map_err(|error| format!("Refusing unsafe private file path: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

pub(super) fn create_private_new_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Private directory {} has no parent", path.display()))?;
    ensure_private_directory(parent)
        .map_err(|error| format!("Could not secure private directory parent: {error}"))?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| {
        format!(
            "Could not create private directory {}: {error}",
            path.display()
        )
    })?;
    ensure_private_directory(path).map_err(|error| {
        format!(
            "Could not secure private directory {}: {error}",
            path.display()
        )
    })
}

pub(super) fn sync_tree(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Could not inspect export staging directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect export staging entry: {error}"))?;
        let metadata = entry
            .file_type()
            .map_err(|error| format!("Could not inspect export staging entry: {error}"))?;
        if metadata.is_symlink() {
            return Err("Symbolic link appeared in audio export staging directory".into());
        }
        if metadata.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            File::open(entry.path())
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("Could not sync audio export file: {error}"))?;
        }
    }
    sync_directory(path)
}

pub(super) fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync directory {}: {error}", path.display()))
}
