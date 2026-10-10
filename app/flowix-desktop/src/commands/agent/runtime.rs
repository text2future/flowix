use crate::agent_external::runtime_registry::{ExternalCliRuntime, ExternalRuntimeKind};
use crate::agent_wire::AgentUserMessage;
use crate::app::state::AppState;

use super::flowix_instructions::sync_native_agent_instructions;

/// Chat dispatch target. The former built-in runtime was removed; every
/// supported agent is an external CLI runtime now.
pub(super) type AgentRuntime = ExternalRuntimeKind;

/// Parse the frontend `agentType` payload. Unknown / missing values are an
/// error so a stale caller cannot silently select another runtime.
pub(super) fn runtime_from_agent_type(agent_type: Option<&str>) -> Result<AgentRuntime, String> {
    let raw = agent_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "agent type is required".to_string())?;
    ExternalRuntimeKind::parse(raw)
}

pub(super) fn runtime_from_message(message: &AgentUserMessage) -> Result<AgentRuntime, String> {
    runtime_from_agent_type(message.agent_type.as_deref())
}

pub(super) fn runtime_handle(state: &AppState, runtime: AgentRuntime) -> &dyn ExternalCliRuntime {
    state
        .external_runtimes
        .get(runtime)
        .expect("every external AgentRuntime must be registered")
}

/// Start an Agent runtime without exposing the conversation-specific command
/// contract to plugin callers. The runtime keeps its existing persistence and
/// lifecycle semantics; the plugin coordinator owns the result collection.
pub(crate) async fn start_plugin_chat(
    state: &AppState,
    thread_id: &str,
    message: AgentUserMessage,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let runtime = runtime_from_message(&message)?;
    if let Some(cwd) = message.cwd_for_runtime(runtime.key()) {
        let workspace_paths = message.workspace_paths_for_runtime(runtime.key());
        sync_native_agent_instructions(std::path::Path::new(cwd), runtime.key(), &workspace_paths)?;
    }
    state.external_runtimes
        .dispatch_chat(thread_id, runtime, message, app_handle)
        .await
        .map(|_| ())
}

pub(crate) async fn stop_any_runtime_chat(
    thread_id: &str,
    state: &AppState,
    app_handle: &tauri::AppHandle,
) -> bool {
    state
        .external_runtimes
        .stop_chat_all(thread_id, app_handle)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_with_agent_type(agent_type: Option<&str>) -> AgentUserMessage {
        AgentUserMessage {
            content: "hello".to_string(),
            llm_content: None,
            image_paths: vec![],
            run_id: None,
            system_reminder_directory: None,
            agent_type: agent_type.map(str::to_string),
            runtime_config: None,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        }
    }

    #[test]
    fn agent_runtime_normalizes_known_agent_types() {
        let cases = [
            ("codex", AgentRuntime::Codex),
            (" CODEX ", AgentRuntime::Codex),
            ("Claude", AgentRuntime::Claude),
            ("HERMES", AgentRuntime::Hermes),
            ("opencode", AgentRuntime::OpenCode),
            ("DEEPSEEK-HARNESS", AgentRuntime::DeepSeekHarness),
            ("dsh", AgentRuntime::DeepSeekHarness),
        ];

        for (agent_type, expected) in cases {
            assert_eq!(
                runtime_from_message(&message_with_agent_type(Some(agent_type))).unwrap(),
                expected,
                "agent_type {agent_type:?} should map to {expected:?}"
            );
        }
    }

    #[test]
    fn agent_runtime_rejects_removed_flowix_type() {
        assert!(runtime_from_message(&message_with_agent_type(Some("flowix"))).is_err());
        assert!(runtime_from_message(&message_with_agent_type(None)).is_err());
        assert!(runtime_from_message(&message_with_agent_type(Some("unknown-agent"))).is_err());
    }
}
