use crate::config::{dsh_credential_ref_for_route, AiConfigFile, AiModelConfig};

#[derive(Clone, PartialEq, Eq)]
pub struct HarnessRuntimeConfig {
    pub(crate) provider: String,
    pub(crate) provider_name: String,
    pub(crate) api_protocol: String,
    pub(crate) api_key_env: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: Option<String>,
}

pub fn resolve_runtime_config(
    config: &AiModelConfig,
    runtime_model: Option<&str>,
) -> Result<HarnessRuntimeConfig, String> {
    let provider_route = config.provider_id.trim().to_string();
    if provider_route.is_empty() {
        return Err("DeepSeek Harness provider route is not configured; open Models and configure a provider".into());
    }
    if provider_route == "flowix" {
        return Err("The saved DeepSeek Harness provider uses the obsolete Flowix route; open Models and reconfigure it".into());
    }
    let provider_name = if config.display_name.trim().is_empty() {
        config.provider.trim()
    } else {
        config.display_name.trim()
    };
    if provider_name.is_empty() {
        return Err(format!("DeepSeek Harness provider route {provider_route} has no display name; open Models and reconfigure it"));
    }
    let model = runtime_model
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("inherit"))
        .or_else(|| {
            Some(config.model.trim())
                .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("inherit"))
        })
        .ok_or("AI model is not configured")?;
    let (inferred_protocol, default_url) = match normalize_provider(provider_name).as_str() {
        "anthropic" | "claude" => ("anthropic-messages", Some("https://api.anthropic.com/v1")),
        "kimiforcoding" | "minimax" | "minimaxcn" | "vercelaigateway" => {
            ("anthropic-messages", None)
        }
        "openai" | "openairesponses" | "openairesponsesapi" | "responsesapi" => {
            ("openai-responses", Some("https://api.openai.com/v1"))
        }
        "deepseek" => ("openai-completions", Some("https://api.deepseek.com/v1")),
        "openrouter" => ("openai-completions", Some("https://openrouter.ai/api/v1")),
        "ollama" => ("openai-completions", Some("http://127.0.0.1:11434/v1")),
        _ => ("openai-completions", None),
    };
    let api_protocol = if config.api_protocol.trim().is_empty() {
        inferred_protocol
    } else {
        config.api_protocol.trim()
    };
    let base_url = config
        .api_url
        .trim()
        .is_empty()
        .then_some(default_url)
        .flatten()
        .unwrap_or(config.api_url.trim())
        .trim_end_matches('/')
        .to_string();
    if base_url.is_empty() {
        return Err(format!(
            "API URL is not configured for provider {provider_name}"
        ));
    }
    let api_key = config.effective_api_key(&provider_route).trim().to_string();
    let api_key_env = if config.api_key_env.trim().is_empty() {
        dsh_credential_ref_for_route(&provider_route)
    } else {
        config.api_key_env.trim().to_string()
    };
    Ok(HarnessRuntimeConfig {
        provider: provider_route,
        provider_name: (!config.display_name.trim().is_empty())
            .then(|| config.display_name.trim().to_string())
            .unwrap_or_else(|| provider_name.to_string()),
        api_protocol: api_protocol.to_string(),
        api_key_env,
        base_url,
        model: model.to_string(),
        api_key: (!api_key.is_empty()).then_some(api_key),
    })
}

pub(crate) fn select_harness_config(
    configs: Vec<AiConfigFile>,
    provider_id: Option<&str>,
) -> Result<AiModelConfig, String> {
    let requested = provider_id.map(str::trim).filter(|v| !v.is_empty());
    let selected = match requested {
        Some(route) => configs
            .into_iter()
            .find(|c| c.model.provider_id.trim() == route),
        None => configs.into_iter().next(),
    };
    selected.map(|c| c.model).ok_or_else(|| match requested {
        Some(route) => format!("DeepSeek Harness provider route is not configured: {route}"),
        None => "DeepSeek Harness provider is not configured".to_string(),
    })
}

fn normalize_provider(provider: &str) -> String {
    provider
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn normalize_permission(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("danger-full-access" | "yolo") => "danger-full-access",
        Some("workspace-write") => "workspace-write",
        _ => "read-only",
    }
}
pub(crate) fn normalize_agent_preset(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("code") => "code",
        Some("minimal") => "minimal",
        Some("cordis") => "cordis",
        _ => "standard",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(provider_id: &str, provider: &str, model: &str) -> AiModelConfig {
        AiModelConfig {
            provider_id: provider_id.into(),
            provider: provider.into(),
            display_name: provider.into(),
            model: model.into(),
            ..Default::default()
        }
    }

    #[test]
    fn runtime_override_wins_and_inherit_falls_back() {
        let config = route("route-a", "DeepSeek", "deepseek-chat");
        assert_eq!(
            resolve_runtime_config(&config, Some("deepseek-reasoner"))
                .unwrap()
                .model,
            "deepseek-reasoner"
        );
        assert_eq!(
            resolve_runtime_config(&config, Some("inherit"))
                .unwrap()
                .model,
            "deepseek-chat"
        );
    }

    #[test]
    fn provider_defaults_are_public_contract_values() {
        let resolved = resolve_runtime_config(&route("route-a", "DeepSeek", "m"), None).unwrap();
        assert_eq!(resolved.api_protocol, "openai-completions");
        assert_eq!(resolved.base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn invalid_and_obsolete_routes_fail_closed() {
        assert!(resolve_runtime_config(&route("", "DeepSeek", "m"), None).is_err());
        assert!(resolve_runtime_config(&route("flowix", "DeepSeek", "m"), None).is_err());
        let mut google = route("google-route", "Gemini", "m");
        google.api_url = "https://generativelanguage.googleapis.com/v1beta".into();
        google.api_protocol = "google-generative-ai".into();
        assert!(resolve_runtime_config(&google, None).is_ok());
    }

    #[test]
    fn permissions_and_presets_fail_closed() {
        assert_eq!(normalize_permission(Some("unknown")), "read-only");
        assert_eq!(normalize_permission(Some("yolo")), "danger-full-access");
        assert_eq!(normalize_agent_preset(Some("unknown")), "standard");
        assert_eq!(normalize_agent_preset(Some("code")), "code");
    }
}
