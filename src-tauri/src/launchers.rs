use crate::persistence::{load_json_optional_quarantining, write_json_atomic, QuarantinedLoad};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

const CONFIG_VERSION: u32 = 1;
const DEFAULT_MIMIR_MCP_URL: &str = "http://127.0.0.1:17532/mcp";
const MIMIR_SERVER_ID: &str = "mimir_workbench";
static DETECTED_AGENTS: OnceLock<AgentDetectionCache> = OnceLock::new();

#[derive(Default)]
struct AgentDetectionCache {
    detected: Mutex<Option<Vec<DetectedAgent>>>,
}

impl AgentDetectionCache {
    fn cached_or_detect_with(
        &self,
        detect: impl FnOnce() -> Vec<DetectedAgent>,
    ) -> Vec<DetectedAgent> {
        let mut cached = self
            .detected
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(detected) = cached.as_ref() {
            return detected.clone();
        }
        let detected = detect();
        *cached = Some(detected.clone());
        detected
    }

    fn refresh_with(&self, detect: impl FnOnce() -> Vec<DetectedAgent>) -> Vec<DetectedAgent> {
        let detected = detect();
        *self
            .detected
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(detected.clone());
        detected
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub title: String,
    pub binary: String,
    pub resume_strategy: ResumeStrategy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeStrategy {
    Claude,
    Codex,
    Gemini,
    Pi,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    #[serde(flatten)]
    pub definition: AgentDefinition,
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LauncherKind {
    Agent,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "path", rename_all = "kebab-case")]
pub enum WorkingDirectory {
    Workspace,
    Home,
    Custom(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherPreset {
    pub id: String,
    pub title: String,
    pub kind: LauncherKind,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: WorkingDirectory,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherConfig {
    pub version: u32,
    pub presets: Vec<LauncherPreset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherConfigResponse {
    pub path: String,
    pub presets: Vec<LauncherPreset>,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLaunch {
    pub preset_id: String,
    pub title: String,
    pub kind: LauncherKind,
    pub agent_id: Option<String>,
    pub resume_strategy: ResumeStrategy,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedSkills {
    #[serde(default)]
    claude_root: Option<String>,
    #[serde(default)]
    project_skill_files: Vec<String>,
}

pub fn agent_catalog() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            id: "codex".into(),
            title: "Codex".into(),
            binary: "codex".into(),
            resume_strategy: ResumeStrategy::Codex,
        },
        AgentDefinition {
            id: "claude".into(),
            title: "Claude".into(),
            binary: "claude".into(),
            resume_strategy: ResumeStrategy::Claude,
        },
        AgentDefinition {
            id: "pi".into(),
            title: "Pi".into(),
            binary: "pi".into(),
            resume_strategy: ResumeStrategy::Pi,
        },
        AgentDefinition {
            id: "gemini".into(),
            title: "Gemini".into(),
            binary: "gemini".into(),
            resume_strategy: ResumeStrategy::Gemini,
        },
    ]
}

pub fn default_config() -> LauncherConfig {
    LauncherConfig {
        version: CONFIG_VERSION,
        presets: vec![
            agent_preset("codex", "Codex", "codex"),
            agent_preset("claude", "Claude", "claude"),
            agent_preset("pi", "Pi", "pi"),
            agent_preset("gemini", "Gemini", "gemini"),
            LauncherPreset {
                id: "terminal".into(),
                title: "Terminal".into(),
                kind: LauncherKind::Terminal,
                enabled: true,
                agent_id: None,
                binary: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                cwd: WorkingDirectory::Workspace,
            },
        ],
    }
}

fn agent_preset(id: &str, title: &str, agent_id: &str) -> LauncherPreset {
    LauncherPreset {
        id: id.into(),
        title: title.into(),
        kind: LauncherKind::Agent,
        enabled: true,
        agent_id: Some(agent_id.into()),
        binary: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        cwd: WorkingDirectory::Workspace,
    }
}

pub fn launcher_config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".mimir").join("launchers.json"))
        .ok_or_else(|| "Could not resolve the home directory for launcher configuration.".into())
}

pub fn load_config(path: &Path) -> Result<LauncherConfigResponse, String> {
    let (config, diagnostic) = match load_json_optional_quarantining::<LauncherConfig>(path)
        .map_err(|error| error.to_string())?
    {
        QuarantinedLoad::Loaded(config) => (config, None),
        QuarantinedLoad::Missing => {
            let config = default_config();
            write_json_atomic(path, &config).map_err(|error| error.to_string())?;
            (config, None)
        }
        QuarantinedLoad::Quarantined {
            path: quarantined_path,
            reason,
        } => {
            let config = default_config();
            write_json_atomic(path, &config).map_err(|error| error.to_string())?;
            (
                config,
                Some(format!(
                    "Invalid launcher configuration was moved to {}: {}",
                    quarantined_path.display(),
                    reason
                )),
            )
        }
    };
    validate_config(&config)?;
    Ok(LauncherConfigResponse {
        path: path.to_string_lossy().into_owned(),
        presets: config.presets,
        diagnostic,
    })
}

pub fn save_config(path: &Path, presets: Vec<LauncherPreset>) -> Result<(), String> {
    let config = LauncherConfig {
        version: CONFIG_VERSION,
        presets,
    };
    validate_config(&config)?;
    write_json_atomic(path, &config).map_err(|error| error.to_string())
}

pub fn validate_config(config: &LauncherConfig) -> Result<(), String> {
    if config.version != CONFIG_VERSION {
        return Err(format!(
            "Unsupported launcher configuration version {} (expected {}).",
            config.version, CONFIG_VERSION
        ));
    }
    let catalog_ids = agent_catalog()
        .into_iter()
        .map(|agent| agent.id)
        .collect::<HashSet<_>>();
    let mut ids = HashSet::new();
    for (index, preset) in config.presets.iter().enumerate() {
        let at = format!("presets[{index}]");
        validate_id(&preset.id).map_err(|error| format!("{at}.id: {error}"))?;
        if !ids.insert(preset.id.as_str()) {
            return Err(format!("{at}.id: duplicate launcher id '{}'.", preset.id));
        }
        if preset.title.trim().is_empty() {
            return Err(format!("{at}.title must not be empty."));
        }
        if preset.args.iter().any(|arg| arg.contains('\0')) {
            return Err(format!("{at}.args must not contain NUL bytes."));
        }
        if preset
            .binary
            .as_deref()
            .is_some_and(|binary| binary.trim().is_empty() || binary.contains('\0'))
        {
            return Err(format!(
                "{at}.binary must be a non-empty command or path without NUL bytes."
            ));
        }
        for (key, value) in &preset.env {
            if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
                return Err(format!("{at}.env contains an invalid environment entry."));
            }
        }
        if let WorkingDirectory::Custom(path) = &preset.cwd {
            if path.trim().is_empty() || path.contains('\0') {
                return Err(format!("{at}.cwd custom path must not be empty."));
            }
        }
        match preset.kind {
            LauncherKind::Agent => {
                let agent_id = preset
                    .agent_id
                    .as_deref()
                    .ok_or_else(|| format!("{at}.agentId is required for an agent preset."))?;
                if !catalog_ids.contains(agent_id) && preset.binary.is_none() {
                    return Err(format!(
                        "{at} references unknown agent '{agent_id}' without a custom binary."
                    ));
                }
            }
            LauncherKind::Terminal if preset.agent_id.is_some() => {
                return Err(format!("{at}.agentId is not valid for a terminal preset."));
            }
            LauncherKind::Terminal => {}
        }
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        return Err("must use lowercase letters, digits, '-' or '_'.".into());
    }
    Ok(())
}

pub fn resolve_launch(
    preset: &LauncherPreset,
    detected: &[DetectedAgent],
    workspace_path: Option<&str>,
    home_path: &Path,
    default_shell: &Path,
    mcp_url: &str,
) -> Result<ResolvedLaunch, String> {
    let cwd = match &preset.cwd {
        WorkingDirectory::Workspace => workspace_path
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| format!("Launcher '{}' requires an open workspace.", preset.title))?
            .to_string(),
        WorkingDirectory::Home => home_path.to_string_lossy().into_owned(),
        WorkingDirectory::Custom(path) => path.clone(),
    };
    if !Path::new(&cwd).is_dir() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }

    let (command, agent_id, resume_strategy) = match preset.kind {
        LauncherKind::Terminal => (
            preset
                .binary
                .clone()
                .unwrap_or_else(|| default_shell.to_string_lossy().into_owned()),
            None,
            ResumeStrategy::None,
        ),
        LauncherKind::Agent => {
            let agent_id = preset
                .agent_id
                .as_deref()
                .ok_or_else(|| format!("Launcher '{}' has no agent id.", preset.title))?;
            let definition = agent_catalog()
                .into_iter()
                .find(|agent| agent.id == agent_id);
            let resume_strategy = definition
                .as_ref()
                .map(|agent| agent.resume_strategy)
                .unwrap_or(ResumeStrategy::None);
            let command = if let Some(binary) = &preset.binary {
                validate_explicit_binary(binary)?;
                binary.clone()
            } else {
                let found = detected
                    .iter()
                    .find(|agent| agent.definition.id == agent_id)
                    .ok_or_else(|| format!("Agent detection has no result for '{agent_id}'."))?;
                found.binary_path.clone().ok_or_else(|| {
                    found
                        .diagnostic
                        .clone()
                        .unwrap_or_else(|| format!("{} is not installed.", found.definition.title))
                })?
            };
            (command, Some(agent_id.to_string()), resume_strategy)
        }
    };

    let mut environment = preset.env.clone();
    let inherited_path = std::env::var_os("PATH");
    let current_path = environment
        .get("PATH")
        .map(OsStr::new)
        .or(inherited_path.as_deref());
    let path = crate::mimir_cli::path_with_mimir_at(home_path, current_path)?;
    environment.insert("PATH".into(), path.to_string_lossy().into_owned());
    environment.insert("MIMIR_MCP_URL".into(), mcp_url.to_string());
    let mut args = preset.args.clone();
    if let Some(agent_id) = agent_id.as_deref() {
        let skills = prepare_agent_skills(agent_id, home_path, Path::new(&cwd), &environment)?;
        append_mimir_connection_args(
            agent_id,
            home_path,
            mcp_url,
            &environment,
            &skills,
            &mut args,
        )?;
    }

    Ok(ResolvedLaunch {
        preset_id: preset.id.clone(),
        title: preset.title.clone(),
        kind: preset.kind,
        agent_id,
        resume_strategy,
        command,
        args,
        cwd,
        env: environment,
    })
}

fn validate_explicit_binary(binary: &str) -> Result<(), String> {
    let path = Path::new(binary);
    let has_path_components = path.is_absolute() || path.components().count() > 1;
    if !has_path_components {
        // A bare command intentionally resolves through the child PATH.
        return Ok(());
    }

    let metadata = path.metadata().map_err(|error| {
        format!("Configured launcher binary is unavailable at {binary}: {error}")
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Configured launcher binary is not a file: {binary}"
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Configured launcher binary is not executable: {binary}"
            ));
        }
    }

    Ok(())
}

fn append_mimir_connection_args(
    agent_id: &str,
    home: &Path,
    mcp_url: &str,
    environment: &BTreeMap<String, String>,
    skills: &PreparedSkills,
    args: &mut Vec<String>,
) -> Result<(), String> {
    match agent_id {
        "codex"
            if !args
                .iter()
                .any(|arg| arg.contains(&format!("mcp_servers.{MIMIR_SERVER_ID}.url"))) =>
        {
            // Keep Mimir's one-run HTTP entry under one stable, product-owned
            // server id and avoid injecting the same URL override twice.
            args.extend([
                "-c".into(),
                format!(
                    "mcp_servers.{MIMIR_SERVER_ID}.url={}",
                    serde_json::to_string(mcp_url)
                        .expect("serializing an MCP URL string cannot fail")
                ),
            ]);
        }
        "claude" if !args.iter().any(|arg| arg.contains(MIMIR_SERVER_ID)) => {
            let config = serde_json::json!({
                "mcpServers": {
                    (MIMIR_SERVER_ID): {
                        "type": "http",
                        "url": mcp_url,
                    }
                }
            });
            args.extend(["--mcp-config".into(), config.to_string()]);
        }
        "claude" => {}
        "pi" => {
            let extension = crate::mimir_cli::pi_extension_path_at(home)
                .to_string_lossy()
                .into_owned();
            if !args.iter().any(|arg| arg == &extension) {
                args.extend(["--extension".into(), extension]);
            }
        }
        "gemini" => ensure_gemini_mcp_config(home, environment)?,
        _ => {}
    }
    if agent_id == "claude" {
        if let Some(root) = skills.claude_root.as_ref() {
            if !args.iter().any(|arg| arg == root) {
                args.extend(["--add-dir".into(), root.clone()]);
            }
        }
    }
    if agent_id == "pi" {
        for skill in &skills.project_skill_files {
            if !args.iter().any(|arg| arg == skill) {
                args.extend(["--skill".into(), skill.clone()]);
            }
        }
    }
    Ok(())
}

fn prepare_agent_skills(
    agent_id: &str,
    home: &Path,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<PreparedSkills, String> {
    #[cfg(windows)]
    let executable = home.join(".mimir").join("bin").join("mimir.cmd");
    #[cfg(not(windows))]
    let executable = home.join(".mimir").join("bin").join("mimir");

    if !executable.is_file() {
        return Ok(PreparedSkills::default());
    }
    let output = Command::new(&executable)
        .args(["skills", "prepare", agent_id, "--json"])
        .current_dir(cwd)
        .envs(environment)
        .env("MIMIR_HOME", home.join(".mimir"))
        .output()
        .map_err(|error| format!("Could not prepare Mimir skills: {error}"))?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if diagnostic.is_empty() {
            "Mimir skill preparation failed.".into()
        } else {
            format!("Mimir skill preparation failed: {diagnostic}")
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Mimir skill preparation returned invalid data: {error}"))
}

fn ensure_gemini_mcp_config(
    home: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<(), String> {
    let config_home = environment
        .get("GEMINI_CLI_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_CLI_HOME").map(PathBuf::from))
        .map(|value| value.join(".gemini"))
        .unwrap_or_else(|| home.join(".gemini"));
    let path = config_home.join("settings.json");
    let mut settings = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|error| {
            format!("Gemini settings are invalid at {}: {error}", path.display())
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Value::Object(serde_json::Map::new())
        }
        Err(error) => {
            return Err(format!(
                "Could not read Gemini settings at {}: {error}",
                path.display()
            ))
        }
    };
    let root = settings.as_object_mut().ok_or_else(|| {
        format!(
            "Gemini settings at {} must contain a JSON object.",
            path.display()
        )
    })?;

    if root
        .get("mcp")
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("excluded"))
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some(MIMIR_SERVER_ID))
        })
    {
        return Err(format!(
            "Gemini excludes the '{MIMIR_SERVER_ID}' MCP server in {}.",
            path.display()
        ));
    }

    let mcp_servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "Gemini mcpServers at {} must be a JSON object.",
                path.display()
            )
        })?;
    #[cfg(windows)]
    let command = home.join(".mimir").join("bin").join("mimir.cmd");
    #[cfg(not(windows))]
    let command = home.join(".mimir").join("bin").join("mimir");
    let command = command.to_string_lossy().into_owned();
    let desired = serde_json::json!({
        "command": command.clone(),
        "args": ["mcp-proxy"],
        "env": {
            "MIMIR_MCP_URL": "$MIMIR_MCP_URL"
        }
    });
    if let Some(existing) = mcp_servers.get(MIMIR_SERVER_ID) {
        let is_mimir_proxy = existing
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(|args| args.len() == 1 && args[0].as_str() == Some("mcp-proxy"))
            && existing.get("command").and_then(Value::as_str) == Some(command.as_str());
        if !is_mimir_proxy {
            return Err(format!(
                "Gemini already has an unrelated '{MIMIR_SERVER_ID}' MCP server in {}.",
                path.display()
            ));
        }
    }
    mcp_servers.insert(MIMIR_SERVER_ID.into(), desired);

    if let Some(allowed) = root
        .get_mut("mcp")
        .and_then(Value::as_object_mut)
        .and_then(|mcp| mcp.get_mut("allowed"))
        .and_then(Value::as_array_mut)
    {
        if !allowed
            .iter()
            .any(|item| item.as_str() == Some(MIMIR_SERVER_ID))
        {
            allowed.push(Value::String(MIMIR_SERVER_ID.into()));
        }
    }
    write_json_atomic(&path, &settings).map_err(|error| {
        format!(
            "Could not update Gemini settings at {}: {error}",
            path.display()
        )
    })
}

pub fn detect_agents() -> Vec<DetectedAgent> {
    agent_catalog()
        .into_iter()
        .map(detect_agent)
        .collect::<Vec<_>>()
}

fn detection_cache() -> &'static AgentDetectionCache {
    DETECTED_AGENTS.get_or_init(AgentDetectionCache::default)
}

fn cached_detect_agents() -> Vec<DetectedAgent> {
    detection_cache().cached_or_detect_with(detect_agents)
}

fn refresh_detected_agents() -> Vec<DetectedAgent> {
    detection_cache().refresh_with(detect_agents)
}

fn detected_agents_for_resolution(
    preset: &LauncherPreset,
    detect: impl FnOnce() -> Vec<DetectedAgent>,
) -> Vec<DetectedAgent> {
    // Terminal resolution only needs the configured/default shell. A custom
    // agent binary is already exact. Neither path should pay for unrelated
    // login-shell probes or `--version` processes.
    if preset.kind == LauncherKind::Terminal || preset.binary.is_some() {
        Vec::new()
    } else {
        detect()
    }
}

fn detect_agent(definition: AgentDefinition) -> DetectedAgent {
    let result = detect_binary(&definition.binary);
    match result {
        Ok(path) => {
            let version = Command::new(&path)
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    first_version(&format!("{stdout}\n{stderr}"))
                });
            DetectedAgent {
                definition,
                installed: true,
                binary_path: Some(path),
                version,
                diagnostic: None,
            }
        }
        Err(diagnostic) => DetectedAgent {
            definition,
            installed: false,
            binary_path: None,
            version: None,
            diagnostic: Some(diagnostic),
        },
    }
}

pub(crate) fn detect_binary(binary: &str) -> Result<String, String> {
    #[cfg(windows)]
    let output = Command::new("where.exe").arg(binary).output();

    #[cfg(not(windows))]
    let output = {
        let shell = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let shell_name = shell
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("sh");
        let flag = if matches!(shell_name, "sh" | "dash") {
            "-lc"
        } else {
            "-lic"
        };
        Command::new(&shell)
            .args([flag, &format!("command -v -- {}", shell_quote(binary))])
            .output()
    };

    let output = output.map_err(|error| format!("Could not run binary detection: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "'{binary}' was not found in the login-shell environment."
        ));
    }
    absolute_binary_from_output(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("Detection for '{binary}' returned no absolute executable path."))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn absolute_binary_from_output(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .rfind(|line| Path::new(line).is_absolute())
        .map(str::to_string)
}

fn first_version(value: &str) -> Option<String> {
    value.split_whitespace().find_map(|word| {
        let trimmed = word.trim_matches(|character: char| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
        });
        let mut pieces = trimmed.split('.');
        let valid = pieces.by_ref().take(3).all(|piece| {
            !piece.is_empty() && piece.chars().all(|character| character.is_ascii_digit())
        });
        if valid && trimmed.matches('.').count() >= 2 {
            Some(trimmed.to_string())
        } else {
            None
        }
    })
}

#[tauri::command]
pub async fn launcher_detect_agents() -> Result<Vec<DetectedAgent>, String> {
    // Opening/reloading launcher settings is the explicit refresh boundary, so
    // installing or removing an agent is visible without restarting Mimir.
    tauri::async_runtime::spawn_blocking(refresh_detected_agents)
        .await
        .map_err(|error| format!("Agent detection task failed: {error}"))
}

#[tauri::command]
pub fn launcher_load_config() -> Result<LauncherConfigResponse, String> {
    load_config(&launcher_config_path()?)
}

#[tauri::command]
pub fn launcher_save_config(presets: Vec<LauncherPreset>) -> Result<(), String> {
    save_config(&launcher_config_path()?, presets)
}

#[tauri::command]
pub async fn launcher_resolve(
    preset: LauncherPreset,
    workspace_path: Option<String>,
) -> Result<ResolvedLaunch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let detected = detected_agents_for_resolution(&preset, cached_detect_agents);
        let home = dirs::home_dir()
            .ok_or_else(|| "Could not resolve the home directory for this launcher.".to_string())?;
        let shell = default_shell_path();
        resolve_launch(
            &preset,
            &detected,
            workspace_path.as_deref(),
            &home,
            &shell,
            DEFAULT_MIMIR_MCP_URL,
        )
    })
    .await
    .map_err(|error| format!("Launcher resolution task failed: {error}"))?
}

pub(crate) fn default_shell_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("powershell.exe"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn append_test_args(agent_id: &str, home: &Path, mcp_url: &str, args: &mut Vec<String>) {
        append_mimir_connection_args(
            agent_id,
            home,
            mcp_url,
            &BTreeMap::new(),
            &PreparedSkills::default(),
            args,
        )
        .unwrap();
    }

    #[test]
    fn defaults_are_small_real_and_valid() {
        let config = default_config();
        validate_config(&config).unwrap();
        assert_eq!(
            config
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["codex", "claude", "pi", "gemini", "terminal"]
        );
        assert!(config.presets.iter().all(|preset| preset.args.is_empty()));
    }

    #[test]
    fn configuration_round_trips_and_is_human_editable() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested").join("launchers.json");
        let defaults = default_config();

        save_config(&path, defaults.presets.clone()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let loaded = load_config(&path).unwrap();

        assert!(text.contains("\n  \"presets\": ["));
        assert_eq!(loaded.presets, defaults.presets);
        assert_eq!(loaded.diagnostic, None);
    }

    #[test]
    fn missing_configuration_materializes_hackable_defaults() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested").join("launchers.json");

        let loaded = load_config(&path).unwrap();

        assert_eq!(loaded.presets, default_config().presets);
        let written: LauncherConfig =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written, default_config());
    }

    #[test]
    fn version_one_presets_without_visibility_remain_enabled() {
        let config: LauncherConfig = serde_json::from_value(serde_json::json!({
            "version": 1,
            "presets": [{
                "id": "codex",
                "title": "Codex",
                "kind": "agent",
                "agentId": "codex",
                "args": [],
                "env": {},
                "cwd": { "mode": "workspace" }
            }]
        }))
        .unwrap();

        assert!(config.presets[0].enabled);
    }

    #[test]
    fn corrupt_configuration_is_quarantined_and_defaults_recover() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("launchers.json");
        std::fs::write(&path, b"{broken").unwrap();

        let loaded = load_config(&path).unwrap();

        assert_eq!(loaded.presets, default_config().presets);
        assert!(loaded.diagnostic.unwrap().contains("moved"));
        assert_eq!(
            serde_json::from_slice::<LauncherConfig>(&std::fs::read(&path).unwrap()).unwrap(),
            default_config()
        );
        assert!(std::fs::read_dir(directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".corrupt-")));
    }

    #[test]
    fn validation_rejects_ambiguous_or_unsafe_presets() {
        let mut config = default_config();
        config.presets.push(config.presets[0].clone());
        assert!(validate_config(&config).unwrap_err().contains("duplicate"));

        let mut config = default_config();
        config.presets[0].args.push("bad\0arg".into());
        assert!(validate_config(&config).unwrap_err().contains("NUL"));

        let mut config = default_config();
        config.presets[0].env.insert("BAD=KEY".into(), "x".into());
        assert!(validate_config(&config)
            .unwrap_err()
            .contains("environment"));

        let mut config = default_config();
        config.presets[0].binary = Some(" ".into());
        assert!(validate_config(&config).unwrap_err().contains("binary"));
    }

    #[test]
    fn parses_login_shell_noise_and_versions() {
        assert_eq!(
            absolute_binary_from_output(
                "profile says hello\nnot/a/path\n/opt/homebrew/bin/codex\n"
            ),
            Some("/opt/homebrew/bin/codex".into())
        );
        assert_eq!(first_version("codex-cli 0.101.2\n"), Some("0.101.2".into()));
        assert_eq!(shell_quote("not'valid"), "'not'\"'\"'valid'");
    }

    #[test]
    fn resolves_exact_argv_and_workspace_without_shell_strings() {
        let directory = tempdir().unwrap();
        let preset = LauncherPreset {
            args: vec!["--model".into(), "gpt 5".into()],
            env: BTreeMap::from([("MIMIR_TEST".into(), "hello world".into())]),
            ..default_config().presets[0].clone()
        };
        let detected = vec![DetectedAgent {
            definition: agent_catalog()[0].clone(),
            installed: true,
            binary_path: Some("/opt/bin/codex".into()),
            version: None,
            diagnostic: None,
        }];

        let launch = resolve_launch(
            &preset,
            &detected,
            Some(directory.path().to_str().unwrap()),
            directory.path(),
            Path::new("/bin/zsh"),
            "http://127.0.0.1:29999/mcp",
        )
        .unwrap();

        assert_eq!(launch.command, "/opt/bin/codex");
        assert_eq!(
            launch.args,
            [
                "--model",
                "gpt 5",
                "-c",
                r#"mcp_servers.mimir_workbench.url="http://127.0.0.1:29999/mcp""#,
            ]
        );
        assert_eq!(launch.cwd, directory.path().to_string_lossy());
        assert_eq!(launch.resume_strategy, ResumeStrategy::Codex);
        assert_eq!(
            launch.env.get("MIMIR_MCP_URL").map(String::as_str),
            Some("http://127.0.0.1:29999/mcp")
        );
    }

    #[test]
    fn terminal_and_exact_binary_resolution_run_zero_agent_probes() {
        let mut terminal_probes = 0;
        let terminal = default_config()
            .presets
            .into_iter()
            .find(|preset| preset.kind == LauncherKind::Terminal)
            .unwrap();
        let detected = detected_agents_for_resolution(&terminal, || {
            terminal_probes += 1;
            detect_agents()
        });
        assert!(detected.is_empty());
        assert_eq!(terminal_probes, 0);

        let mut exact_agent = default_config().presets[0].clone();
        exact_agent.binary = Some("/opt/bin/codex".into());
        let mut exact_probes = 0;
        let detected = detected_agents_for_resolution(&exact_agent, || {
            exact_probes += 1;
            detect_agents()
        });
        assert!(detected.is_empty());
        assert_eq!(exact_probes, 0);
    }

    #[cfg(unix)]
    #[test]
    fn exact_binary_paths_fail_precisely_without_running_a_probe() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let mut preset = default_config().presets[0].clone();
        let binary = directory.path().join("custom-codex");
        preset.binary = Some(binary.to_string_lossy().into_owned());

        let missing = resolve_launch(
            &preset,
            &[],
            Some(directory.path().to_str().unwrap()),
            directory.path(),
            Path::new("/bin/sh"),
            DEFAULT_MIMIR_MCP_URL,
        )
        .unwrap_err();
        assert!(missing.contains("unavailable"));

        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        let not_executable = resolve_launch(
            &preset,
            &[],
            Some(directory.path().to_str().unwrap()),
            directory.path(),
            Path::new("/bin/sh"),
            DEFAULT_MIMIR_MCP_URL,
        )
        .unwrap_err();
        assert!(not_executable.contains("not executable"));

        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();
        let resolved = resolve_launch(
            &preset,
            &[],
            Some(directory.path().to_str().unwrap()),
            directory.path(),
            Path::new("/bin/sh"),
            DEFAULT_MIMIR_MCP_URL,
        )
        .unwrap();
        assert_eq!(resolved.command, binary.to_string_lossy());
    }

    #[test]
    fn detected_agent_resolution_requests_the_shared_catalog_once() {
        let agent = default_config().presets[0].clone();
        let mut probes = 0;
        let detected = detected_agents_for_resolution(&agent, || {
            probes += 1;
            vec![DetectedAgent {
                definition: agent_catalog()[0].clone(),
                installed: true,
                binary_path: Some("/opt/bin/codex".into()),
                version: None,
                diagnostic: None,
            }]
        });

        assert_eq!(probes, 1);
        assert_eq!(detected[0].binary_path.as_deref(), Some("/opt/bin/codex"));
    }

    #[test]
    fn detection_cache_reuses_launch_data_but_explicit_refresh_updates_it() {
        let cache = AgentDetectionCache::default();
        let definition = agent_catalog()[0].clone();
        let old = DetectedAgent {
            definition: definition.clone(),
            installed: true,
            binary_path: Some("/old/codex".into()),
            version: Some("1.0.0".into()),
            diagnostic: None,
        };
        let new = DetectedAgent {
            definition,
            installed: true,
            binary_path: Some("/new/codex".into()),
            version: Some("2.0.0".into()),
            diagnostic: None,
        };
        let mut probes = 0;

        let first = cache.cached_or_detect_with(|| {
            probes += 1;
            vec![old.clone()]
        });
        let reused = cache.cached_or_detect_with(|| {
            probes += 1;
            Vec::new()
        });
        let refreshed = cache.refresh_with(|| {
            probes += 1;
            vec![new.clone()]
        });
        let reused_refresh = cache.cached_or_detect_with(|| {
            probes += 1;
            Vec::new()
        });

        assert_eq!(first[0].binary_path.as_deref(), Some("/old/codex"));
        assert_eq!(reused[0].binary_path.as_deref(), Some("/old/codex"));
        assert_eq!(refreshed[0].binary_path.as_deref(), Some("/new/codex"));
        assert_eq!(reused_refresh[0].version.as_deref(), Some("2.0.0"));
        assert_eq!(probes, 2);
    }

    #[test]
    fn reports_missing_workspace_and_missing_agent_precisely() {
        let preset = default_config().presets[0].clone();
        let error = resolve_launch(
            &preset,
            &[],
            None,
            Path::new("/"),
            Path::new("/bin/sh"),
            DEFAULT_MIMIR_MCP_URL,
        )
        .unwrap_err();
        assert!(error.contains("open workspace"));

        let directory = tempdir().unwrap();
        let error = resolve_launch(
            &preset,
            &[],
            Some(directory.path().to_str().unwrap()),
            directory.path(),
            Path::new("/bin/sh"),
            DEFAULT_MIMIR_MCP_URL,
        )
        .unwrap_err();
        assert!(error.contains("no result"));
    }

    #[test]
    fn every_builtin_agent_connects_to_the_mimir_capability_spine() {
        let home = Path::new("/Users/mimir");
        let mcp_url = "http://127.0.0.1:29999/mcp";

        let mut codex = Vec::new();
        append_test_args("codex", home, mcp_url, &mut codex);
        assert_eq!(
            codex,
            [
                "-c",
                r#"mcp_servers.mimir_workbench.url="http://127.0.0.1:29999/mcp""#
            ]
        );

        let mut claude = Vec::new();
        append_test_args("claude", home, mcp_url, &mut claude);
        assert_eq!(
            claude,
            [
                "--mcp-config",
                r#"{"mcpServers":{"mimir_workbench":{"type":"http","url":"http://127.0.0.1:29999/mcp"}}}"#
            ]
        );

        let mut pi = Vec::new();
        append_test_args("pi", home, mcp_url, &mut pi);
        assert_eq!(pi, ["--extension", "/Users/mimir/.mimir/pi/mimir-tools.ts"]);

        let gemini_home = tempdir().unwrap();
        let mut gemini = Vec::new();
        append_test_args("gemini", gemini_home.path(), mcp_url, &mut gemini);
        assert!(gemini.is_empty());
        let gemini_settings: Value = serde_json::from_slice(
            &fs::read(gemini_home.path().join(".gemini").join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            gemini_settings["mcpServers"][MIMIR_SERVER_ID]["args"],
            serde_json::json!(["mcp-proxy"])
        );

        append_test_args("codex", home, mcp_url, &mut codex);
        append_test_args("claude", home, mcp_url, &mut claude);
        append_test_args("pi", home, mcp_url, &mut pi);
        append_test_args("gemini", gemini_home.path(), mcp_url, &mut gemini);
        assert_eq!(codex.len(), 2);
        assert_eq!(claude.len(), 2);
        assert_eq!(pi.len(), 2);
    }

    #[test]
    fn preconfigured_connection_flags_are_preserved_without_duplicate_injection() {
        let home = Path::new("/Users/mimir");
        let mcp_url = "http://127.0.0.1:29999/mcp";

        let mut codex = vec![
            "--full-auto".into(),
            "-c".into(),
            r#"mcp_servers.mimir_workbench.url="http://custom.example/mcp""#.into(),
        ];
        let mut claude = vec![
            "--dangerously-skip-permissions".into(),
            format!(
                "--mcp-config={}",
                serde_json::json!({
                    "mcpServers": {
                        (MIMIR_SERVER_ID): {
                            "type": "http",
                            "url": "http://custom.example/mcp"
                        }
                    }
                })
            ),
        ];
        let mut pi = vec![
            "--model".into(),
            "anthropic/claude-sonnet-4".into(),
            "--extension".into(),
            "/Users/mimir/.mimir/pi/mimir-tools.ts".into(),
        ];
        let expected_codex = codex.clone();
        let expected_claude = claude.clone();
        let expected_pi = pi.clone();

        append_test_args("codex", home, mcp_url, &mut codex);
        append_test_args("claude", home, mcp_url, &mut claude);
        append_test_args("pi", home, mcp_url, &mut pi);

        assert_eq!(codex, expected_codex);
        assert_eq!(claude, expected_claude);
        assert_eq!(pi, expected_pi);
    }

    #[test]
    fn claude_keeps_unrelated_mcp_config_and_adds_mimir_separately() {
        let mut args = vec!["--mcp-config=/tmp/user-servers.json".into()];

        append_test_args(
            "claude",
            Path::new("/Users/mimir"),
            "http://127.0.0.1:29999/mcp",
            &mut args,
        );

        assert_eq!(args[0], "--mcp-config=/tmp/user-servers.json");
        assert_eq!(args[1], "--mcp-config");
        assert!(args[2].contains(MIMIR_SERVER_ID));
    }

    #[test]
    fn codex_connection_ignores_unrelated_stdio_servers() {
        let mut args = vec![
            "-c".into(),
            r#"mcp_servers.other.command="other-server""#.into(),
        ];

        append_test_args(
            "codex",
            Path::new("/Users/mimir"),
            "http://127.0.0.1:29999/mcp",
            &mut args,
        );

        assert_eq!(
            args,
            [
                "-c",
                r#"mcp_servers.other.command="other-server""#,
                "-c",
                r#"mcp_servers.mimir_workbench.url="http://127.0.0.1:29999/mcp""#,
            ]
        );
    }

    #[test]
    fn claude_and_pi_receive_only_the_native_skill_paths_they_support() {
        let home = Path::new("/Users/mimir");
        let skills = PreparedSkills {
            claude_root: Some("/tmp/mimir-claude".into()),
            project_skill_files: vec!["/tmp/project/release/SKILL.md".into()],
        };
        let mut claude = Vec::new();
        append_mimir_connection_args(
            "claude",
            home,
            DEFAULT_MIMIR_MCP_URL,
            &BTreeMap::new(),
            &skills,
            &mut claude,
        )
        .unwrap();
        assert!(claude.ends_with(&["--add-dir".into(), "/tmp/mimir-claude".into()]));

        let mut pi = Vec::new();
        append_mimir_connection_args(
            "pi",
            home,
            DEFAULT_MIMIR_MCP_URL,
            &BTreeMap::new(),
            &skills,
            &mut pi,
        )
        .unwrap();
        assert!(pi.ends_with(&["--skill".into(), "/tmp/project/release/SKILL.md".into()]));
    }

    #[test]
    fn gemini_config_adds_only_the_owned_stdio_proxy() {
        let home = tempdir().unwrap();
        let gemini_cli_home = home.path().join("gemini-config");
        let gemini_home = gemini_cli_home.join(".gemini");
        fs::create_dir_all(&gemini_home).unwrap();
        fs::write(
            gemini_home.join("settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "theme": "user-choice",
                "mcp": { "allowed": ["existing"] },
                "mcpServers": {
                    "existing": { "command": "existing-server" }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let environment = BTreeMap::from([(
            "GEMINI_CLI_HOME".into(),
            gemini_cli_home.to_string_lossy().into_owned(),
        )]);

        ensure_gemini_mcp_config(home.path(), &environment).unwrap();

        let mut settings: Value =
            serde_json::from_slice(&fs::read(gemini_home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["theme"], "user-choice");
        assert_eq!(
            settings["mcpServers"][MIMIR_SERVER_ID]["args"],
            serde_json::json!(["mcp-proxy"])
        );
        assert_eq!(
            settings["mcp"]["allowed"],
            serde_json::json!(["existing", MIMIR_SERVER_ID])
        );

        settings["mcpServers"][MIMIR_SERVER_ID] = serde_json::json!({
            "command": "/opt/unrelated",
            "args": ["mcp-proxy"]
        });
        fs::write(
            gemini_home.join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        assert!(ensure_gemini_mcp_config(home.path(), &environment)
            .unwrap_err()
            .contains("unrelated"));
    }
}
