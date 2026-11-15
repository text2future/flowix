//! 项目态：把 Flowix 的 skill / 插件 / MCP 配置投影成 Codex 的 `.codex` 目录内容。
//!
//! 投影是单向的：Flowix 是配置的事实源，Codex 只读。所以这里写的都是派生文件，
//! 任何一次写入都可以由上层状态重算出来。

use super::*;

use std::path::PathBuf;
use serde_json::{Value, json};
use super::super::command::resolve_codex_cwd;
use super::super::AGENT_TYPE;
use crate::agent_external::select_external_session_for_runtime;
use crate::agent_wire::AgentUserMessage;

impl CodexAppServerManager {
    /// Read skills independently of model, plugin and MCP discovery.
    pub async fn project_skills(
        &self,
        cwd: &std::path::Path,
        force_reload: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request(
            "skills/list",
            json!({ "cwds": [cwd.to_string_lossy()], "forceReload": force_reload }),
        )
        .await
    }


    /// Read the Codex capabilities that are effective for one project root.
    /// This is a metadata-only operation: it does not create a thread or spend
    /// model tokens. Keep the cwd explicit so project-local config and skills
    /// cannot leak across notebooks in the preferences UI.
    pub async fn project_capabilities(
        &self,
        cwd: &std::path::Path,
        force_reload: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let cwd = cwd.to_string_lossy().to_string();

        let (
            skills,
            config,
            requirements,
            models,
            mcp,
            plugins,
            plugin_catalog,
            agents,
            experiments,
        ) = tokio::join!(
            self.request(
                "skills/list",
                json!({ "cwds": [cwd.clone()], "forceReload": force_reload }),
            ),
            self.request("config/read", json!({ "cwd": cwd.clone() })),
            self.request("configRequirements/read", json!({})),
            self.request_all_pages("model/list", json!({ "limit": 100 })),
            self.request_all_pages(
                "mcpServerStatus/list",
                json!({ "limit": 100, "detail": "full" }),
            ),
            self.request("plugin/installed", json!({ "cwds": [cwd.clone()] }),),
            self.request(
                "plugin/list",
                json!({ "cwds": [cwd.clone()], "forceRefetch": force_reload }),
            ),
            // Descendant threads are Codex's durable representation of
            // spawned sub-agents. Filtering by cwd keeps this repo-scoped.
            self.request_all_pages(
                "thread/list",
                json!({
                    "cwd": cwd.clone(),
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "sourceKinds": [
                        "subAgent",
                        "subAgentReview",
                        "subAgentCompact",
                        "subAgentThreadSpawn",
                        "subAgentOther"
                    ]
                }),
            ),
            self.request_all_pages("experimentalFeature/list", json!({ "limit": 100 })),
        );

        fn result_or_error(result: Result<Value, String>) -> Value {
            match result {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }

        Ok(json!({
            "cwd": cwd,
            "skills": result_or_error(skills),
            "config": result_or_error(config),
            "requirements": result_or_error(requirements),
            "models": result_or_error(models),
            "mcp": result_or_error(mcp),
            "plugins": result_or_error(plugins),
            "pluginCatalog": result_or_error(plugin_catalog),
            "agents": result_or_error(agents),
            "experiments": result_or_error(experiments),
            "projectConfigPath": std::path::Path::new(&cwd).join(".codex").join("config.toml"),
            "refreshedAt": chrono::Utc::now().timestamp_millis(),
        }))
    }


    pub async fn write_project_config(
        &self,
        cwd: &std::path::Path,
        edits: Value,
        expected_version: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let edits = edits
            .as_array()
            .ok_or_else(|| "config edits must be an array".to_string())?;
        if edits.is_empty() || edits.len() > 20 {
            return Err("config write requires between 1 and 20 edits".to_string());
        }
        const ALLOWED_KEYS: &[&str] = &[
            "model",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "model_verbosity",
            "review_model",
            "service_tier",
            "approval_policy",
            "approvals_reviewer",
            "sandbox_mode",
            "sandbox_workspace_write.network_access",
            "web_search",
            "instructions",
            "developer_instructions",
        ];
        for edit in edits {
            let key = edit
                .get("keyPath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !ALLOWED_KEYS.contains(&key) {
                return Err(format!("Codex setting is not editable from Flowix: {key}"));
            }
            if edit.get("mergeStrategy").and_then(Value::as_str) != Some("replace") {
                return Err("Codex settings UI only supports replace writes".to_string());
            }
            let value = edit.get("value").unwrap_or(&Value::Null);
            let valid = match key {
                "sandbox_workspace_write.network_access" => value.is_boolean(),
                "model_reasoning_effort" => {
                    matches!(
                        value.as_str(),
                        Some("low" | "medium" | "high" | "xhigh" | "max" | "ultra")
                    )
                }
                "model_verbosity" => matches!(value.as_str(), Some("low" | "medium" | "high")),
                "service_tier" => matches!(
                    value.as_str(),
                    Some("auto" | "default" | "flex" | "priority")
                ),
                "approval_policy" => matches!(
                    value.as_str(),
                    Some("untrusted" | "on-failure" | "on-request" | "never")
                ),
                "approvals_reviewer" => matches!(value.as_str(), Some("user" | "auto_review")),
                "sandbox_mode" => matches!(
                    value.as_str(),
                    Some("read-only" | "workspace-write" | "danger-full-access")
                ),
                "web_search" => matches!(
                    value.as_str(),
                    Some("disabled" | "cached" | "indexed" | "live")
                ),
                "instructions" | "developer_instructions" => {
                    value.as_str().is_some_and(|text| text.len() <= 50_000)
                }
                _ => value
                    .as_str()
                    .is_some_and(|text| !text.is_empty() && text.len() <= 200),
            };
            if !valid {
                return Err(format!("Invalid value for Codex setting: {key}"));
            }
        }
        let dot_codex = cwd.join(".codex");
        std::fs::create_dir_all(&dot_codex)
            .map_err(|error| format!("failed to create project Codex config folder: {error}"))?;
        if !crate::config::path_is_inside(&dot_codex, cwd) {
            return Err("project Codex config folder resolves outside the notebook".to_string());
        }
        self.request(
            "config/batchWrite",
            json!({
                "filePath": dot_codex.join("config.toml"),
                "expectedVersion": expected_version,
                "edits": edits,
                "reloadUserConfig": true
            }),
        )
        .await
    }


    pub async fn set_skill_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request(
            "skills/config/write",
            json!({ "name": name, "enabled": enabled }),
        )
        .await
    }


    pub async fn set_plugin_installed(
        &self,
        plugin_id: &str,
        installed: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let (method, params) = if installed {
            ("plugin/install", json!({ "pluginName": plugin_id }))
        } else {
            ("plugin/uninstall", json!({ "pluginId": plugin_id }))
        };
        self.request(method, params).await
    }


    pub async fn reload_mcp_servers(&self) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request("config/mcpServer/reload", json!({})).await
    }


    pub async fn upsert_project_mcp(
        &self,
        cwd: &std::path::Path,
        name: &str,
        definition: Value,
        expected_version: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        if name.is_empty()
            || name.len() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("MCP name may only contain letters, numbers, '-' and '_'".to_string());
        }
        let definition = definition
            .as_object()
            .ok_or_else(|| "MCP definition must be an object".to_string())?;
        if definition
            .keys()
            .any(|key| !matches!(key.as_str(), "command" | "args" | "url" | "enabled"))
        {
            return Err("MCP definition contains unsupported fields".to_string());
        }
        let has_command = definition
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty());
        let has_url = definition
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|v| v.starts_with("http://") || v.starts_with("https://"));
        if has_command == has_url {
            return Err("MCP definition must contain either command or http(s) url".to_string());
        }
        if definition
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|v| v.len() > 4_096)
            || definition
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|v| v.len() > 2_048)
            || definition.get("enabled").is_some_and(|v| !v.is_boolean())
        {
            return Err("MCP definition contains an invalid value".to_string());
        }
        if let Some(args) = definition.get("args") {
            let args = args
                .as_array()
                .ok_or_else(|| "MCP args must be an array".to_string())?;
            if args.len() > 100
                || args
                    .iter()
                    .any(|arg| arg.as_str().map_or(true, |v| v.len() > 4_096))
            {
                return Err("MCP args exceed the allowed size".to_string());
            }
        }
        let dot_codex = cwd.join(".codex");
        std::fs::create_dir_all(&dot_codex)
            .map_err(|e| format!("failed to create project Codex config folder: {e}"))?;
        if !crate::config::path_is_inside(&dot_codex, cwd) {
            return Err("project Codex config folder resolves outside the notebook".to_string());
        }
        let result = self.request("config/batchWrite", json!({
            "filePath": dot_codex.join("config.toml"),
            "expectedVersion": expected_version,
            "edits": [{ "keyPath": format!("mcp_servers.{name}"), "value": definition, "mergeStrategy": "replace" }],
            "reloadUserConfig": true
        })).await?;
        self.request("config/mcpServer/reload", json!({})).await?;
        Ok(result)
    }


    pub(super) async fn resolve_codex_thread(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<(String, PathBuf), String> {
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let session_id = select_external_session_for_runtime(stored, None);
        let cwd = self
            .resolve_codex_cwd_for_next_turn(flowix_thread_id, message)
            .await?;
        if let Some(codex_thread_id) = session_id {
            self.request("thread/resume", json!({ "threadId": codex_thread_id }))
                .await?;
            return Ok((codex_thread_id, cwd));
        }

        // Writable threads use the interactive server-request approval path;
        // unsupported server requests remain fail-closed in read_loop.
        let approval = app_server_approval_policy(message.permission_mode_for_runtime(AGENT_TYPE));
        let workspace_roots = message.workspace_paths_for_runtime(AGENT_TYPE);
        let result = self
            .request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": message.codex_model_for_runtime(),
                    // `thread/start` still uses the legacy string field.
                    // The object-form `sandboxPolicy` is for turn/start and
                    // thread/settings/update; passing it here is accepted by
                    // some server versions but silently leaves the thread
                    // read-only.
                    "sandbox": app_server_legacy_sandbox(message.permission_mode_for_runtime(AGENT_TYPE)),
                    "approvalPolicy": approval,
                    "approvalsReviewer": "user",
                    // Persist the paginated transcript so thread/read and
                    // thread/turns/list can return command/tool items after
                    // the live stream has completed. Without this, Codex
                    // still emits item/* notifications but the legacy
                    // history view drops those items on reload.
                    "historyMode": "paginated",
                    "runtimeWorkspaceRoots": workspace_roots,
                    "serviceName": "flowix"
                }),
            )
            .await?;
        let codex_thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Codex app-server did not return a thread id".to_string())?
            .to_string();
        self.inner
            .thread_manager
            .upsert_external_session(flowix_thread_id, AGENT_TYPE, &codex_thread_id, Some(result))
            .await
            .map_err(|error| error.to_string())?;
        Ok((codex_thread_id, cwd))
    }


    /// `turn/start` accepts `cwd`, so Codex can deliberately apply a workspace
    /// selection made while a previous turn was running. Keep Flowix's stored
    /// cwd in sync for session metadata, but do not let that historical value
    /// override the directory selected for this next turn.
    pub(super) async fn resolve_codex_cwd_for_next_turn(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<PathBuf, String> {
        let cwd = resolve_codex_cwd(message, None).ok_or_else(|| {
            "Agent working directory unavailable; open a notebook or pick a folder".to_string()
        })?;
        if self
            .inner
            .thread_manager
            .read_frozen_cwd(flowix_thread_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&cwd)
        {
            if let Err(error) = self
                .inner
                .thread_manager
                .upsert_frozen_cwd(flowix_thread_id, &cwd)
                .await
            {
                tracing::warn!(
                    "failed to persist Codex working directory for {flowix_thread_id}: {error}"
                );
            }
        }
        Ok(cwd)
    }

}
