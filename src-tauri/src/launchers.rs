use crate::persistence::{load_json_optional_quarantining, write_json_atomic, QuarantinedLoad};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

const CONFIG_VERSION: u32 = 1;
const DEFAULT_MIM_MCP_URL: &str = "http://127.0.0.1:17532/mcp";

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
    ]
}

pub fn default_config() -> LauncherConfig {
    LauncherConfig {
        version: CONFIG_VERSION,
        presets: vec![
            agent_preset("codex", "Codex", "codex"),
            agent_preset("claude", "Claude", "claude"),
            agent_preset("pi", "Pi", "pi"),
            LauncherPreset {
                id: "terminal".into(),
                title: "Terminal".into(),
                kind: LauncherKind::Terminal,
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
        agent_id: Some(agent_id.into()),
        binary: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        cwd: WorkingDirectory::Workspace,
    }
}

pub fn launcher_config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".mim").join("launchers.json"))
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
        .map(|value| OsStr::new(value))
        .or(inherited_path.as_deref());
    let path = crate::mimx::path_with_mimx_at(home_path, current_path)?;
    environment.insert("PATH".into(), path.to_string_lossy().into_owned());
    environment.insert("MIMX_MCP_URL".into(), mcp_url.to_string());
    let mut args = preset.args.clone();
    if let Some(agent_id) = agent_id.as_deref() {
        append_mim_connection_args(agent_id, home_path, mcp_url, &mut args);
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

fn append_mim_connection_args(agent_id: &str, home: &Path, mcp_url: &str, args: &mut Vec<String>) {
    match agent_id {
        "codex" if !args.iter().any(|arg| arg.contains("mcp_servers.mim.")) => {
            args.extend([
                "-c".into(),
                format!(
                    "mcp_servers.mim.url={}",
                    serde_json::to_string(mcp_url)
                        .expect("serializing an MCP URL string cannot fail")
                ),
            ]);
        }
        "claude" if !args.iter().any(|arg| arg == "--mcp-config") => {
            let config = serde_json::json!({
                "mcpServers": {
                    "mim": {
                        "type": "http",
                        "url": mcp_url,
                    }
                }
            });
            args.extend(["--mcp-config".into(), config.to_string()]);
        }
        "pi" => {
            let extension = crate::mimx::pi_extension_path_at(home)
                .to_string_lossy()
                .into_owned();
            if !args.iter().any(|arg| arg == &extension) {
                args.extend(["--extension".into(), extension]);
            }
        }
        _ => {}
    }
}

pub fn detect_agents() -> Vec<DetectedAgent> {
    agent_catalog()
        .into_iter()
        .map(detect_agent)
        .collect::<Vec<_>>()
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
        .filter(|line| Path::new(line).is_absolute())
        .next_back()
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
    tauri::async_runtime::spawn_blocking(detect_agents)
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
        let detected = detect_agents();
        let home = dirs::home_dir()
            .ok_or_else(|| "Could not resolve the home directory for this launcher.".to_string())?;
        let shell = default_shell_path();
        resolve_launch(
            &preset,
            &detected,
            workspace_path.as_deref(),
            &home,
            &shell,
            DEFAULT_MIM_MCP_URL,
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
            ["codex", "claude", "pi", "terminal"]
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
            env: BTreeMap::from([("MIM_TEST".into(), "hello world".into())]),
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
                r#"mcp_servers.mim.url="http://127.0.0.1:29999/mcp""#,
            ]
        );
        assert_eq!(launch.cwd, directory.path().to_string_lossy());
        assert_eq!(launch.resume_strategy, ResumeStrategy::Codex);
        assert_eq!(
            launch.env.get("MIMX_MCP_URL").map(String::as_str),
            Some("http://127.0.0.1:29999/mcp")
        );
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
            DEFAULT_MIM_MCP_URL,
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
            DEFAULT_MIM_MCP_URL,
        )
        .unwrap_err();
        assert!(error.contains("no result"));
    }

    #[test]
    fn every_builtin_agent_connects_to_the_mim_capability_spine() {
        let home = Path::new("/Users/mim");
        let mcp_url = "http://127.0.0.1:29999/mcp";

        let mut codex = Vec::new();
        append_mim_connection_args("codex", home, mcp_url, &mut codex);
        assert_eq!(
            codex,
            ["-c", r#"mcp_servers.mim.url="http://127.0.0.1:29999/mcp""#]
        );

        let mut claude = Vec::new();
        append_mim_connection_args("claude", home, mcp_url, &mut claude);
        assert_eq!(
            claude,
            [
                "--mcp-config",
                r#"{"mcpServers":{"mim":{"type":"http","url":"http://127.0.0.1:29999/mcp"}}}"#
            ]
        );

        let mut pi = Vec::new();
        append_mim_connection_args("pi", home, mcp_url, &mut pi);
        assert_eq!(pi, ["--extension", "/Users/mim/.mim/pi/mim-tools.ts"]);

        append_mim_connection_args("codex", home, mcp_url, &mut codex);
        append_mim_connection_args("claude", home, mcp_url, &mut claude);
        append_mim_connection_args("pi", home, mcp_url, &mut pi);
        assert_eq!(codex.len(), 2);
        assert_eq!(claude.len(), 2);
        assert_eq!(pi.len(), 2);
    }
}
