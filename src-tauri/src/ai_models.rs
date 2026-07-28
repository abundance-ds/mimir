use crate::persistence::{load_json_optional_quarantining, write_json_atomic, QuarantinedLoad};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const CONFIG_DIR_NAME: &str = ".mimir";
const DEFAULT_MODELS_JSON: &str = include_str!("../resources/ai-models.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRegistry {
    pub version: u32,
    pub models: Vec<AiModelConfig>,
    pub providers: HashMap<String, AiProviderConfig>,
    #[serde(default, alias = "autoOrder")]
    pub defaults: ModelDefaults,
    #[serde(default)]
    pub legacy_ids: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelDefaults {
    #[serde(default)]
    pub chat: Vec<String>,
    #[serde(default)]
    pub agent: Vec<String>,
    #[serde(default)]
    pub rewrite: Vec<String>,
    #[serde(default)]
    pub ghost: Vec<String>,
    #[serde(default)]
    pub extract: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub short_label: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub provider_label: Option<String>,
    pub provider: String,
    pub model: String,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default)]
    pub capabilities: AiModelCapabilities,
    #[serde(default)]
    pub pricing: AiModelPricing,
    #[serde(default)]
    pub control: Option<AiModelControl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiModelCapabilities {
    #[serde(default)]
    pub text: bool,
    #[serde(default)]
    pub json: bool,
    #[serde(default)]
    pub streaming: bool,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub prompt_caching: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiModelPricing {
    #[serde(default)]
    pub input_per_million: f64,
    #[serde(default)]
    pub cache_read_input_per_million: f64,
    #[serde(default)]
    pub cache_write_input_per_million: f64,
    #[serde(default)]
    pub output_per_million: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiModelControl {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub options: Vec<AiModelControlOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiModelControlOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub budget_tokens: Option<u32>,
    #[serde(default)]
    pub provider_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub url: String,
    pub api_key_env: String,
}

fn default_context_window() -> u32 {
    200_000
}

pub fn app_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(CONFIG_DIR_NAME))
}

pub fn ensure_config_dir() -> Result<PathBuf, String> {
    let dir = app_config_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Could not create {}: {}", dir.display(), err))?;
    Ok(dir)
}

pub fn load_registry() -> Result<ModelRegistry, String> {
    let dir = ensure_config_dir()?;
    load_registry_at(&dir.join("models.json"))
}

fn load_registry_at(path: &Path) -> Result<ModelRegistry, String> {
    let defaults =
        parse_default_registry().map_err(|err| format!("Invalid embedded models: {}", err))?;
    let mut registry = match load_json_optional_quarantining::<ModelRegistry>(path)
        .map_err(|error| error.to_string())?
    {
        QuarantinedLoad::Loaded(registry) => registry,
        QuarantinedLoad::Missing => {
            write_json_atomic(path, &defaults).map_err(|error| error.to_string())?;
            return Ok(defaults);
        }
        QuarantinedLoad::Quarantined {
            path: quarantined,
            reason,
        } => {
            eprintln!(
                "[ai_models] Invalid model registry moved to {}: {reason}",
                quarantined.display()
            );
            write_json_atomic(path, &defaults).map_err(|error| error.to_string())?;
            return Ok(defaults);
        }
    };

    let mut changed = migrate_registry(&mut registry, &defaults);
    if registry.version < defaults.version {
        registry.version = defaults.version;
        changed = true;
    }

    // Always sync product config from embedded defaults
    registry.defaults = defaults.defaults.clone();
    registry.providers = defaults.providers.clone();
    registry.legacy_ids = defaults.legacy_ids.clone();

    if changed {
        write_json_atomic(path, &registry).map_err(|error| error.to_string())?;
    }

    Ok(registry)
}

fn migrate_registry(registry: &mut ModelRegistry, defaults: &ModelRegistry) -> bool {
    if registry.version >= defaults.version {
        return false;
    }

    // Re-sync providers and metadata from defaults
    registry.providers = defaults.providers.clone();
    registry.defaults = defaults.defaults.clone();
    registry.legacy_ids = defaults.legacy_ids.clone();

    // Replace all known default models, keep user-added custom models
    let mut models = defaults.models.clone();
    for existing in &registry.models {
        let is_known_default = defaults.models.iter().any(|model| {
            model.id == existing.id
                || (model.provider == existing.provider && model.model == existing.model)
        });
        let is_legacy = defaults.legacy_ids.contains_key(&existing.id);
        if !is_known_default && !is_legacy {
            models.push(existing.clone());
        }
    }
    registry.models = models;

    // Ensure all built-in provider models have prompt_caching
    for model in &mut registry.models {
        if !model.capabilities.prompt_caching
            && matches!(model.provider.as_str(), "anthropic" | "openai" | "google")
        {
            model.capabilities.prompt_caching = true;
        }

        // Default cache pricing for models that don't specify it
        if model.pricing.cache_read_input_per_million == 0.0 {
            let cache_read = match model.provider.as_str() {
                "anthropic" => model.pricing.input_per_million * 0.1,
                "openai" | "google" => model.pricing.input_per_million,
                _ => 0.0,
            };
            if cache_read > 0.0 {
                model.pricing.cache_read_input_per_million = cache_read;
            }
        }

        if model.pricing.cache_write_input_per_million == 0.0 && model.provider == "anthropic" {
            model.pricing.cache_write_input_per_million = model.pricing.input_per_million * 1.25;
        }
    }

    true
}

pub fn resolve_model(
    registry: &ModelRegistry,
    feature: &str,
    model_id: Option<&str>,
) -> Result<AiModelConfig, String> {
    if let Some(id) = model_id.filter(|id| !id.trim().is_empty() && id != &"auto") {
        return registry
            .models
            .iter()
            .find(|model| model.id == id)
            .cloned()
            .ok_or_else(|| format!("Unknown AI model id: {}", id));
    }

    let order = match feature {
        "chat" => &registry.defaults.chat,
        "agent" => &registry.defaults.agent,
        "rewrite" => &registry.defaults.rewrite,
        "ghost" => &registry.defaults.ghost,
        "extract" => &registry.defaults.extract,
        _ => &registry.defaults.chat,
    };

    for default_id in order {
        if let Some(model) = registry.models.iter().find(|m| m.id == *default_id) {
            return Ok(model.clone());
        }
    }

    registry
        .models
        .first()
        .cloned()
        .ok_or_else(|| "No AI models configured".to_string())
}

pub fn provider_hosts(registry: &ModelRegistry) -> Vec<String> {
    registry
        .providers
        .values()
        .filter_map(|provider| url::Url::parse(&provider.url).ok())
        .filter_map(|url| url.host_str().map(ToOwned::to_owned))
        .collect()
}

fn parse_default_registry() -> Result<ModelRegistry, serde_json::Error> {
    serde_json::from_str(DEFAULT_MODELS_JSON)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_registry_materializes_atomically() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested").join("models.json");

        let loaded = load_registry_at(&path).unwrap();
        let persisted: ModelRegistry =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();

        assert_eq!(persisted.version, loaded.version);
        assert_eq!(persisted.models.len(), loaded.models.len());
        assert!(std::fs::read_to_string(path).unwrap().ends_with('\n'));
    }

    #[test]
    fn corrupt_registry_is_quarantined_before_defaults_recover() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("models.json");
        let corrupt = b"{\"models\":";
        std::fs::write(&path, corrupt).unwrap();

        let loaded = load_registry_at(&path).unwrap();

        assert!(!loaded.models.is_empty());
        let quarantined = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|candidate| {
                candidate
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().contains(".corrupt-"))
            })
            .unwrap();
        assert_eq!(std::fs::read(quarantined).unwrap(), corrupt);
        assert!(serde_json::from_slice::<ModelRegistry>(&std::fs::read(path).unwrap()).is_ok());
    }
}
