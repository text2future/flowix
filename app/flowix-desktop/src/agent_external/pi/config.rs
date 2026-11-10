use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Manager};

use super::runtime::pi_config_dir;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit_multiplier: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_icon_url: Option<String>,
    /// Cloud directory rank: larger values are shown first in the picker.
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderConfig {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub api: String,
    pub base_url: String,
    /// Flowix-owned provider source, surfaced for settings UI classification.
    /// Stored in Pi settings.json so Pi's native models.json stays provider-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub credential_configured: bool,
    #[serde(default)]
    pub default_model_id: Option<String>,
    #[serde(default)]
    pub models: Vec<PiModelEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelCatalogProvider {
    pub id: String,
    pub display_name: String,
    pub api: String,
    pub base_url: String,
    pub takes_api_key: bool,
    pub models: Vec<PiModelEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelCatalog {
    pub pi_version: String,
    pub pi_ai_version: String,
    pub apis: Vec<String>,
    pub providers: Vec<PiModelCatalogProvider>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiFeatures {
    pub tool_search: bool,
    /// Read-only input for the one-time frontend preference migration.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub legacy_code_mode: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMcpServer {
    pub name: String,
    pub config: Value,
}

pub fn features() -> Result<PiFeatures, String> {
    let dir = pi_config_dir()?;
    let settings = read_json(&dir.join("settings.json"))?;
    let value = settings.get("flowixFeatures").cloned().unwrap_or_default();
    let mut features: PiFeatures = serde_json::from_value(value.clone()).unwrap_or_default();
    features.legacy_code_mode = value.get("codeMode").and_then(Value::as_bool);
    Ok(features)
}

/// Pi reads `shellPath` from `settings.json` before its own discovery, so the
/// host must honour it when deciding whether the `bash` tool can work here.
pub fn shell_path() -> Result<Option<String>, String> {
    let dir = pi_config_dir()?;
    let settings = read_json(&dir.join("settings.json"))?;
    Ok(settings
        .get("shellPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned))
}

pub fn save_features(features: PiFeatures) -> Result<(), String> {
    let dir = pi_config_dir()?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("settings.json");
    let mut settings = read_json(&path)?;
    if !settings["flowixFeatures"].is_object() {
        settings["flowixFeatures"] = json!({});
    }
    settings["flowixFeatures"]["toolSearch"] = json!(features.tool_search);
    write_json(&path, &settings)
}

pub fn clear_legacy_code_mode() -> Result<(), String> {
    let path = pi_config_dir()?.join("settings.json");
    let mut settings = read_json(&path)?;
    let removed = settings
        .get_mut("flowixFeatures")
        .and_then(Value::as_object_mut)
        .and_then(|features| features.remove("codeMode"));
    if removed.is_some() {
        write_json(&path, &settings)?;
    }
    Ok(())
}

fn mcp_config_path() -> Result<std::path::PathBuf, String> {
    Ok(pi_config_dir()?.join("mcp.json"))
}

fn read_mcp_config() -> Result<(std::path::PathBuf, Value), String> {
    let path = mcp_config_path()?;
    let config = read_json(&path)?;
    let root = config
        .as_object()
        .ok_or_else(|| format!("invalid {}: root must be a JSON object", path.display()))?;
    if root
        .get("mcpServers")
        .is_some_and(|servers| !servers.is_object())
    {
        return Err(format!(
            "invalid {}: mcpServers must be a JSON object",
            path.display()
        ));
    }
    Ok((path, config))
}

pub fn list_mcp_servers() -> Result<Vec<PiMcpServer>, String> {
    let (_, config) = read_mcp_config()?;
    let servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(servers
        .into_iter()
        .map(|(name, config)| PiMcpServer { name, config })
        .collect())
}

fn validate_mcp_server(name: &str, config: &Value) -> Result<(), String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("Pi MCP server names may contain only letters, digits, _ and -".into());
    }
    let object = config
        .as_object()
        .ok_or_else(|| "Pi MCP server configuration must be a JSON object".to_string())?;
    if object.get("sse").is_some() || object.get("type").and_then(Value::as_str) == Some("sse") {
        return Err("Pi does not support the legacy SSE transport; use streamable HTTP".into());
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let url = object
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if (object.contains_key("command") && !command) || (object.contains_key("url") && !url) {
        return Err("Pi MCP command and url values must be non-empty strings".into());
    }
    if command == url {
        return Err(
            "Configure exactly one Pi MCP transport: command (stdio) or url (streamable HTTP)"
                .into(),
        );
    }
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if !matches!(kind, "stdio" | "http" | "streamable-http") {
            return Err("Pi MCP type must be stdio, http or streamable-http".into());
        }
        if (kind == "stdio" && !command) || (matches!(kind, "http" | "streamable-http") && !url) {
            return Err("Pi MCP type does not match its command or url".into());
        }
    }
    if object.get("args").is_some_and(|value| {
        !value
            .as_array()
            .is_some_and(|args| args.iter().all(Value::is_string))
    }) {
        return Err("Pi MCP args must be an array of strings".into());
    }
    for key in ["env", "headers", "toolExposure"] {
        if object.get(key).is_some_and(|value| !value.is_object()) {
            return Err(format!("Pi MCP {key} must be an object"));
        }
    }
    for key in ["env", "headers"] {
        if object
            .get(key)
            .and_then(Value::as_object)
            .is_some_and(|values| values.values().any(|value| !value.is_string()))
        {
            return Err(format!("Pi MCP {key} values must be strings"));
        }
    }
    if object
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("Pi MCP enabled must be a boolean".into());
    }
    if object
        .get("timeout")
        .is_some_and(|value| !value.as_f64().is_some_and(|timeout| timeout > 0.0))
    {
        return Err("Pi MCP timeout must be a positive number of seconds".into());
    }
    for key in ["cwd", "description"] {
        if object.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("Pi MCP {key} must be a string"));
        }
    }
    if let Some(exposure) = object.get("exposure").and_then(Value::as_str) {
        if !matches!(
            exposure,
            "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden"
        ) {
            return Err("Pi MCP exposure must be codemode, deferred, direct or hidden".into());
        }
    }
    Ok(())
}

pub fn save_mcp_server(name: &str, config: Value) -> Result<(), String> {
    validate_mcp_server(name, &config)?;
    let (path, mut file) = read_mcp_config()?;
    let servers = object_at(&mut file, "mcpServers")?;
    let normalized = name.replace('-', "_");
    if servers
        .keys()
        .any(|existing| existing != name && existing.replace('-', "_") == normalized)
    {
        return Err("Pi treats server names that differ only by - and _ as the same name".into());
    }
    servers.insert(name.to_string(), config);
    write_json(&path, &file)
}

pub fn delete_mcp_server(name: &str) -> Result<(), String> {
    let (path, mut file) = read_mcp_config()?;
    let is_empty = if let Some(servers) = file.get_mut("mcpServers").and_then(Value::as_object_mut)
    {
        servers.remove(name);
        servers.is_empty()
    } else {
        false
    };
    if is_empty {
        if let Some(root) = file.as_object_mut() {
            root.remove("mcpServers");
        }
    }
    write_json(&path, &file)
}

fn catalog_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os("FLOWIX_PI_PROVIDER_CATALOG") {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(target_os = "macos")]
    let platform = "darwin";
    #[cfg(target_os = "windows")]
    let platform = "windows";
    #[cfg(target_os = "linux")]
    let platform = "linux";
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("cannot locate PI resources: {error}"))?;
    let packaged_catalog = resources.join("pi").join("provider-catalog.json");
    if packaged_catalog.is_file() {
        return Ok(packaged_catalog);
    }
    Ok(resources
        .join("pi")
        .join(format!("{platform}-{arch}"))
        .join("provider-catalog.json"))
}

pub fn catalog(app: &AppHandle) -> Result<PiModelCatalog, String> {
    let path = catalog_path(app)?;
    let value = read_json(&path)?;
    serde_json::from_value(value)
        .map_err(|error| format!("invalid PI provider catalog {}: {error}", path.display()))
}

pub(super) fn read_json(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Pi config path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|error| error.to_string())?
    };
    #[cfg(not(unix))]
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

fn object_at<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>, String> {
    if !value.get(key).is_some_and(Value::is_object) {
        value[key] = json!({});
    }
    value[key]
        .as_object_mut()
        .ok_or_else(|| format!("Pi {key} config is not an object"))
}

pub fn list() -> Result<Vec<PiProviderConfig>, String> {
    let dir = pi_config_dir()?;
    let models = read_json(&dir.join("models.json"))?;
    let auth = read_json(&dir.join("auth.json"))?;
    let settings = read_json(&dir.join("settings.json"))?;
    let default_provider = settings.get("defaultProvider").and_then(Value::as_str);
    let default_model = settings.get("defaultModel").and_then(Value::as_str);
    let cloud_provider_id = settings
        .get("flowixCloudProviderId")
        .and_then(Value::as_str);
    let providers = models
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let flowix_catalog = settings.get("flowixPiCatalog").and_then(Value::as_object);
    Ok(providers
        .into_iter()
        .filter_map(|(id, provider)| {
            let models = provider.get("models")?.as_array()?;
            let provider_metadata = flowix_catalog.and_then(|catalog| catalog.get(&id));
            let model_metadata = provider_metadata
                .and_then(|metadata| metadata.get("models"))
                .and_then(Value::as_object);
            let entries: Vec<PiModelEntry> =
                models
                    .iter()
                    .filter_map(|entry| {
                        let id = entry.get("id")?.as_str()?.to_string();
                        let metadata = model_metadata.and_then(|catalog| catalog.get(&id));
                        Some(PiModelEntry {
                            id,
                            name: entry
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            subtitle: metadata
                                .and_then(|item| item.get("subtitle"))
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            credit_multiplier: metadata
                                .and_then(|item| item.get("creditMultiplier"))
                                .and_then(Value::as_f64)
                                .filter(|value| value.is_finite() && (0.01..=10.0).contains(value)),
                            provider_icon_url: metadata
                                .and_then(|item| item.get("providerIconUrl"))
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            sort_order: metadata
                                .and_then(|item| item.get("sortOrder"))
                                .and_then(Value::as_i64)
                                .unwrap_or(0),
                            api: entry.get("api").and_then(Value::as_str).map(str::to_string),
                            reasoning: entry
                                .get("reasoning")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            vision: entry.get("input").and_then(Value::as_array).is_some_and(
                                |input| input.iter().any(|item| item.as_str() == Some("image")),
                            ),
                            context_window: entry
                                .get("contextWindow")
                                .and_then(Value::as_u64)
                                .map(|value| value as u32),
                            max_tokens: entry
                                .get("maxTokens")
                                .and_then(Value::as_u64)
                                .map(|value| value as u32),
                        })
                    })
                    .collect();
            Some(PiProviderConfig {
                id: id.clone(),
                display_name: provider
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                icon_url: provider_metadata
                    .and_then(|metadata| metadata.get("providerIconUrl"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                api: provider
                    .get("api")
                    .and_then(Value::as_str)
                    .unwrap_or("openai-completions")
                    .to_string(),
                base_url: provider
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                source: (cloud_provider_id == Some(id.as_str()))
                    .then(|| "flowix-cloud".to_string()),
                api_key: None,
                credential_configured: auth
                    .get(&id)
                    .and_then(|entry| entry.get("key"))
                    .and_then(Value::as_str)
                    .is_some_and(|key| !key.is_empty()),
                default_model_id: (default_provider == Some(id.as_str()))
                    .then(|| default_model.unwrap_or_default().to_string())
                    .filter(|id| !id.is_empty()),
                models: entries,
            })
        })
        .collect())
}

pub fn save(mut config: PiProviderConfig, app: &AppHandle) -> Result<(), String> {
    let id = config.id.trim().to_ascii_lowercase();
    if id.is_empty()
        || !id.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || (index > 0 && ch == '-')
        })
    {
        return Err("Provider ID must use lowercase letters, numbers, or internal hyphens".into());
    }
    config.id = id.clone();
    config.display_name = config.display_name.trim().to_string();
    config.base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if config.display_name.is_empty()
        || !config.base_url.starts_with("http://") && !config.base_url.starts_with("https://")
    {
        return Err("A provider name and valid HTTP(S) base URL are required".into());
    }
    let fallback_apis = [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
    ];
    let supported_apis = catalog(app)
        .map(|catalog| catalog.apis)
        .unwrap_or_else(|_| fallback_apis.iter().map(|api| (*api).to_string()).collect());
    if !supported_apis.iter().any(|api| api == &config.api)
        || config.models.iter().any(|model| {
            model
                .api
                .as_ref()
                .is_some_and(|api| !supported_apis.iter().any(|supported| supported == api))
        })
    {
        return Err("Unsupported Pi model API".into());
    }
    if config.models.is_empty() || config.models.iter().any(|model| model.id.trim().is_empty()) {
        return Err("At least one model ID is required".into());
    }
    let mut seen = std::collections::HashSet::new();
    if config
        .models
        .iter()
        .any(|model| !seen.insert(model.id.trim().to_string()))
    {
        return Err("Model IDs must be unique within a provider".into());
    }

    let dir = pi_config_dir()?;
    let models_path = dir.join("models.json");
    let mut models_json = read_json(&models_path)?;
    let model_values: Vec<Value> = config.models.iter().map(|model| {
        let mut value = json!({
            "id": model.id.trim(),
            "name": if model.name.trim().is_empty() { model.id.trim() } else { model.name.trim() },
            "reasoning": model.reasoning,
            "input": if model.vision { vec!["text", "image"] } else { vec!["text"] },
            "contextWindow": model.context_window.unwrap_or(128000),
            "maxTokens": model.max_tokens.unwrap_or(8192),
        });
        value.as_object_mut().map(|object| {
            if let Some(api) = model.api.as_deref() { object.insert("api".into(), json!(api)); }
            if model.context_window.is_none() { object.remove("contextWindow"); }
            if model.max_tokens.is_none() { object.remove("maxTokens"); }
        });
        value
    }).collect();
    let providers = object_at(&mut models_json, "providers")?;
    providers.insert(
        id.clone(),
        json!({
            "name": config.display_name,
            "api": config.api,
            "baseUrl": config.base_url,
            "models": model_values,
        }),
    );
    write_json(&models_path, &models_json)?;

    let settings_path = dir.join("settings.json");
    let mut settings = read_json(&settings_path)?;
    let mut settings_changed = false;
    if let Some(default_model) = config
        .default_model_id
        .as_deref()
        .filter(|model| config.models.iter().any(|entry| entry.id == *model))
    {
        settings["defaultProvider"] = json!(id);
        settings["defaultModel"] = json!(default_model);
        settings_changed = true;
    } else if settings.get("defaultProvider").and_then(Value::as_str) == Some(id.as_str()) {
        if let Some(settings) = settings.as_object_mut() {
            settings.remove("defaultProvider");
            settings.remove("defaultModel");
        }
        settings_changed = true;
    }
    if config.source.as_deref() == Some("flowix-cloud") {
        settings["flowixCloudProviderId"] = json!(id);
        settings_changed = true;
    }
    let mut model_metadata = Map::new();
    for model in &config.models {
        let mut metadata = Map::new();
        if let Some(subtitle) = model
            .subtitle
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            metadata.insert("subtitle".into(), json!(subtitle.trim()));
        }
        if let Some(multiplier) = model
            .credit_multiplier
            .filter(|value| value.is_finite() && (0.01..=10.0).contains(value))
        {
            metadata.insert("creditMultiplier".into(), json!(multiplier));
        }
        if let Some(icon_url) = model
            .provider_icon_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            metadata.insert("providerIconUrl".into(), json!(icon_url.trim()));
        }
        // Zero is the default, so omitting it keeps the metadata compact while
        // still letting a rank be cleared on the next credential refresh.
        if model.sort_order != 0 {
            metadata.insert("sortOrder".into(), json!(model.sort_order));
        }
        if !metadata.is_empty() {
            model_metadata.insert(model.id.clone(), Value::Object(metadata));
        }
    }
    let mut provider_metadata = Map::new();
    if let Some(icon_url) = config
        .icon_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        provider_metadata.insert("providerIconUrl".into(), json!(icon_url.trim()));
    }
    if !model_metadata.is_empty() {
        provider_metadata.insert("models".into(), Value::Object(model_metadata));
    }
    if provider_metadata.is_empty() {
        let removed = settings
            .get_mut("flowixPiCatalog")
            .and_then(Value::as_object_mut)
            .is_some_and(|catalog| catalog.remove(&id).is_some());
        if removed {
            let catalog_empty = settings
                .get("flowixPiCatalog")
                .and_then(Value::as_object)
                .is_some_and(Map::is_empty);
            if catalog_empty {
                settings
                    .as_object_mut()
                    .map(|settings| settings.remove("flowixPiCatalog"));
            }
            settings_changed = true;
        }
    } else {
        let provider_metadata = Value::Object(provider_metadata);
        let unchanged = settings
            .get("flowixPiCatalog")
            .and_then(Value::as_object)
            .and_then(|catalog| catalog.get(&id))
            == Some(&provider_metadata);
        if !unchanged {
            object_at(&mut settings, "flowixPiCatalog")?.insert(id.clone(), provider_metadata);
            settings_changed = true;
        }
    }
    if settings_changed {
        write_json(&settings_path, &settings)?;
    }

    if let Some(key) = config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        let auth_path = dir.join("auth.json");
        let mut auth = read_json(&auth_path)?;
        let auth_entries = auth
            .as_object_mut()
            .ok_or("Pi auth config is not an object")?;
        auth_entries.insert(id.clone(), json!({ "type": "api_key", "key": key }));
        write_json(&auth_path, &auth)?;
    }
    Ok(())
}

pub fn delete(provider_id: &str) -> Result<(), String> {
    let id = provider_id.trim();
    let dir = pi_config_dir()?;
    let models_path = dir.join("models.json");
    let mut models = read_json(&models_path)?;
    if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
        providers.remove(id);
    }
    write_json(&models_path, &models)?;
    let settings_path = dir.join("settings.json");
    let mut settings = read_json(&settings_path)?;
    let mut settings_changed = false;
    if settings.get("defaultProvider").and_then(Value::as_str) == Some(id) {
        if let Some(settings) = settings.as_object_mut() {
            settings.remove("defaultProvider");
            settings.remove("defaultModel");
        }
        settings_changed = true;
    }
    if settings
        .get("flowixCloudProviderId")
        .and_then(Value::as_str)
        == Some(id)
    {
        if let Some(settings) = settings.as_object_mut() {
            settings.remove("flowixCloudProviderId");
        }
        settings_changed = true;
    }
    let removed_catalog_metadata = settings
        .get_mut("flowixPiCatalog")
        .and_then(Value::as_object_mut)
        .is_some_and(|catalog| catalog.remove(id).is_some());
    if removed_catalog_metadata {
        let catalog_empty = settings
            .get("flowixPiCatalog")
            .and_then(Value::as_object)
            .is_some_and(Map::is_empty);
        if catalog_empty {
            settings
                .as_object_mut()
                .map(|settings| settings.remove("flowixPiCatalog"));
        }
        settings_changed = true;
    }
    if settings_changed {
        write_json(&settings_path, &settings)?;
    }
    let auth_path = dir.join("auth.json");
    let mut auth = read_json(&auth_path)?;
    if let Some(auth) = auth.as_object_mut() {
        auth.remove(id);
    }
    write_json(&auth_path, &auth)
}

pub fn legacy_cloud_provider_id(api_base: &str) -> Result<Option<String>, String> {
    let dir = pi_config_dir()?;
    let models = read_json(&dir.join("models.json"))?;
    let auth = read_json(&dir.join("auth.json"))?;
    let provider_id = "flowix-cloud";
    let expected_base_url = format!("{}/v1/ai", api_base.trim_end_matches('/'));
    let provider = models
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(provider_id));
    let looks_like_cloud_provider = provider.is_some_and(|provider| {
        provider.get("name").and_then(Value::as_str) == Some("Flowix Cloud")
            && provider.get("api").and_then(Value::as_str) == Some("openai-completions")
            && provider.get("baseUrl").and_then(Value::as_str) == Some(&expected_base_url)
    });
    let has_cloud_credential = auth
        .get(provider_id)
        .and_then(|entry| entry.get("key"))
        .and_then(Value::as_str)
        .is_some_and(|key| key.starts_with("fai_"));
    Ok((looks_like_cloud_provider && has_cloud_credential).then(|| provider_id.to_string()))
}

fn collect_cloud_provider_ids(
    providers: impl IntoIterator<Item = (String, bool)>,
    marked_provider_id: Option<&str>,
    legacy_provider_id: Option<&str>,
) -> Vec<String> {
    let mut ids: Vec<String> = providers
        .into_iter()
        .filter_map(|(id, is_cloud)| is_cloud.then_some(id))
        .collect();
    for id in [marked_provider_id, legacy_provider_id]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// Remove every Flowix Cloud Pi provider, including providers identified by
/// the settings marker and the legacy provider shape.
pub fn delete_cloud_providers(api_base: &str) -> Result<bool, String> {
    let providers = list()?.into_iter().map(|provider| {
        let is_cloud = provider.source.as_deref() == Some("flowix-cloud");
        (provider.id, is_cloud)
    });
    let settings = read_json(&pi_config_dir()?.join("settings.json"))?;
    let marked_provider_id = settings
        .get("flowixCloudProviderId")
        .and_then(Value::as_str);
    let legacy_provider_id = legacy_cloud_provider_id(api_base)?;
    let provider_ids =
        collect_cloud_provider_ids(providers, marked_provider_id, legacy_provider_id.as_deref());
    if provider_ids.is_empty() {
        return Ok(false);
    }
    for provider_id in provider_ids {
        delete(&provider_id)?;
    }
    Ok(true)
}

pub fn is_flowix_cloud_provider(provider_id: Option<&str>, api_base: &str) -> Result<bool, String> {
    let dir = pi_config_dir()?;
    let settings = read_json(&dir.join("settings.json"))?;
    let selected_provider = provider_id
        .filter(|value| !value.trim().is_empty())
        .or_else(|| settings.get("defaultProvider").and_then(Value::as_str));
    let Some(selected_provider) = selected_provider else {
        return Ok(false);
    };
    let providers = list()?;
    if providers.iter().any(|provider| {
        provider.id == selected_provider && provider.source.as_deref() == Some("flowix-cloud")
    }) {
        return Ok(true);
    }
    Ok(legacy_cloud_provider_id(api_base)?.as_deref() == Some(selected_provider))
}

pub fn save_cloud_credential(
    app: &AppHandle,
    api_base: &str,
    credential: flowix_sync::CloudAiCredential,
) -> Result<(), String> {
    let api_base = api_base.trim_end_matches('/');
    let providers = list()?;
    let legacy_cloud_id = legacy_cloud_provider_id(api_base)?;
    let settings = read_json(&pi_config_dir()?.join("settings.json"))?;
    let catalog = if !credential.cloud_models_enabled {
        Vec::new()
    } else if credential.models.is_empty() {
        vec![credential.model.clone()]
    } else {
        credential.models.clone()
    };
    let provider_icon_url = credential
        .provider
        .as_ref()
        .and_then(|provider| provider.icon_url.clone());
    let model_ids: Vec<String> = catalog.iter().map(|model| model.id.clone()).collect();
    let current_cloud = providers
        .iter()
        .find(|provider| provider.source.as_deref() == Some("flowix-cloud"))
        .or_else(|| {
            legacy_cloud_id
                .as_deref()
                .and_then(|id| providers.iter().find(|provider| provider.id == id))
        });
    let saved_default = current_cloud
        .and_then(|provider| provider.default_model_id.clone())
        .filter(|id| model_ids.iter().any(|model_id| model_id == id));
    // A newly discovered member catalog is visible immediately, but should
    // not silently become the active model before the user selects it.
    let default_model_id = saved_default;
    let provider_id = current_cloud
        .map(|provider| provider.id.clone())
        .unwrap_or_else(|| {
            let existing_ids: std::collections::HashSet<&str> = providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect();
            let base_id = "flowix-cloud-member";
            if !existing_ids.contains(base_id) {
                return base_id.to_string();
            }
            let mut suffix = 2;
            loop {
                let candidate = format!("{base_id}-{suffix}");
                if !existing_ids.contains(candidate.as_str()) {
                    return candidate;
                }
                suffix += 1;
            }
        });
    let default_model_id = if current_cloud.is_some()
        && settings.get("defaultProvider").and_then(Value::as_str) != Some(provider_id.as_str())
    {
        None
    } else {
        default_model_id
    };
    save(
        PiProviderConfig {
            id: provider_id,
            display_name: "Flowix Cloud".into(),
            icon_url: provider_icon_url,
            api: "openai-completions".into(),
            base_url: format!("{api_base}/v1/ai"),
            source: Some("flowix-cloud".into()),
            api_key: Some(credential.api_key),
            credential_configured: true,
            default_model_id,
            models: catalog
                .into_iter()
                .map(|model| {
                    let id = model.id;
                    let name = model
                        .title
                        .filter(|title| !title.trim().is_empty())
                        .unwrap_or_else(|| id.clone());
                    PiModelEntry {
                        id,
                        name,
                        subtitle: model
                            .subtitle
                            .filter(|subtitle| !subtitle.trim().is_empty()),
                        credit_multiplier: model
                            .credit_multiplier
                            .filter(|value| value.is_finite() && (0.01..=10.0).contains(value)),
                        provider_icon_url: model
                            .provider_icon_url
                            .filter(|url| !url.trim().is_empty()),
                        sort_order: model.sort_order.unwrap_or(0),
                        api: None,
                        reasoning: false,
                        vision: false,
                        context_window: None,
                        max_tokens: None,
                    }
                })
                .collect(),
        },
        app,
    )
}

pub async fn test_connection(config: PiProviderConfig) -> Result<u64, String> {
    let dir = pi_config_dir()?;
    let auth = read_json(&dir.join("auth.json"))?;
    let api_key = config
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .or_else(|| {
            auth.get(&config.id)
                .and_then(|entry| entry.get("key"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let model = config
        .models
        .first()
        .ok_or("Add a model before testing this provider")?;
    let (url, body) = match config.api.as_str() {
        "openai-completions" => (
            format!("{}/chat/completions", config.base_url.trim_end_matches('/')),
            json!({"model": model.id, "messages": [{"role":"user","content":"Reply with OK"}], "max_tokens": 8}),
        ),
        "openai-responses" => (
            format!("{}/responses", config.base_url.trim_end_matches('/')),
            json!({"model": model.id, "input":"Reply with OK", "max_output_tokens": 8}),
        ),
        "anthropic-messages" => (
            format!("{}/messages", config.base_url.trim_end_matches('/')),
            json!({"model": model.id, "max_tokens": 8, "messages": [{"role":"user","content":"Reply with OK"}]}),
        ),
        _ => return Err("Unsupported Pi model API".into()),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.post(url).json(&body);
    if !api_key.is_empty() {
        request = if config.api == "anthropic-messages" {
            request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(api_key)
        };
    }
    let started = std::time::Instant::now();
    let response = request
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "Provider returned HTTP {status}: {}",
            detail.chars().take(240).collect::<String>()
        ));
    }
    Ok(started.elapsed().as_millis() as u64)
}

pub async fn discover_models(config: PiProviderConfig) -> Result<Vec<PiModelEntry>, String> {
    let dir = pi_config_dir()?;
    let auth = read_json(&dir.join("auth.json"))?;
    let api_key = config
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .or_else(|| {
            auth.get(&config.id)
                .and_then(|entry| entry.get("key"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let url = format!("{}/models", config.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if !api_key.is_empty() {
        request = if config.api == "anthropic-messages" {
            request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(api_key)
        };
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Model discovery failed: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Provider returned invalid model catalog: {error}"))?;
    if !status.is_success() {
        return Err(format!("Provider returned HTTP {status}"));
    }
    let entries = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .ok_or("Provider response did not include a model list")?;
    let mut seen = std::collections::HashSet::new();
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim().to_string();
            if id.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            Some(PiModelEntry {
                name: entry
                    .get("name")
                    .or_else(|| entry.get("display_name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                id,
                subtitle: None,
                credit_multiplier: None,
                provider_icon_url: None,
                sort_order: entry
                    .get("sort_order")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                reasoning: false,
                vision: false,
                api: None,
                context_window: None,
                max_tokens: None,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::collect_cloud_provider_ids;

    #[test]
    fn cloud_provider_cleanup_includes_marked_and_legacy_ids_without_duplicates() {
        let ids = collect_cloud_provider_ids(
            [
                ("flowix-cloud-member".to_string(), true),
                ("custom-provider".to_string(), false),
            ],
            Some("flowix-cloud-member"),
            Some("flowix-cloud"),
        );

        assert_eq!(ids, ["flowix-cloud-member", "flowix-cloud"]);
    }

    #[test]
    fn cloud_provider_cleanup_ignores_empty_markers_and_non_cloud_providers() {
        let ids =
            collect_cloud_provider_ids([("custom-provider".to_string(), false)], Some("  "), None);

        assert!(ids.is_empty());
    }
}
