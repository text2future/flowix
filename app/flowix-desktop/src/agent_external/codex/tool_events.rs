//! Central registry for Codex tool-shaped rollout/stdout items.
//!
//! Codex has three relevant schemas:
//! - paired records (`function_call` + `function_call_output`);
//! - lifecycle records whose phase comes from `item.started` / `item.completed`.
//! - records already complete in one item (for example historical web search).
//! Keeping these definitions in one place prevents the live and history
//! parsers from drifting apart.

use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexToolEventMode {
    Call,
    Result,
    Lifecycle,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CodexToolEventDefinition {
    pub item_type: &'static str,
    pub canonical_name: &'static str,
    pub mode: CodexToolEventMode,
    pub prefer_payload_name: bool,
}

/// Protocol baseline verified against Codex CLI 0.144.4 and local rollout
/// files. New variants must be added here before parser-specific handling.
pub(crate) const CODEX_TOOL_EVENT_DEFINITIONS: &[CodexToolEventDefinition] = &[
    payload_named_definition("function_call", "function_call", CodexToolEventMode::Call),
    payload_named_definition(
        "function_call_output",
        "function_call",
        CodexToolEventMode::Result,
    ),
    payload_named_definition(
        "custom_tool_call",
        "custom_tool_call",
        CodexToolEventMode::Call,
    ),
    payload_named_definition(
        "custom_tool_call_output",
        "custom_tool_call",
        CodexToolEventMode::Result,
    ),
    definition(
        "command_execution",
        "command_execution",
        CodexToolEventMode::Lifecycle,
    ),
    definition(
        "mcp_tool_call",
        "mcp_tool_call",
        CodexToolEventMode::Lifecycle,
    ),
    definition(
        "mcp_tool_call_end",
        "mcp_tool_call",
        CodexToolEventMode::Complete,
    ),
    definition("file_change", "file_change", CodexToolEventMode::Lifecycle),
    definition(
        "patch_apply_end",
        "file_change",
        CodexToolEventMode::Complete,
    ),
    definition("web_search", "web_search", CodexToolEventMode::Lifecycle),
    definition("web_search_end", "web_search", CodexToolEventMode::Complete),
    definition(
        "web_search_call",
        "web_search",
        CodexToolEventMode::Complete,
    ),
    definition(
        "web_search_preview",
        "web_search",
        CodexToolEventMode::Complete,
    ),
    definition("search_query", "web_search", CodexToolEventMode::Complete),
    definition(
        "image_generation",
        "image_generation",
        CodexToolEventMode::Lifecycle,
    ),
    definition(
        "image_generation_call",
        "image_generation",
        CodexToolEventMode::Complete,
    ),
    definition(
        "image_generation_end",
        "image_generation",
        CodexToolEventMode::Complete,
    ),
    definition(
        "dynamic_tool_call",
        "dynamic_tool_call",
        CodexToolEventMode::Lifecycle,
    ),
    definition(
        "collab_agent_tool_call",
        "collab_agent_tool_call",
        CodexToolEventMode::Lifecycle,
    ),
    definition("tool_search_call", "tool_search", CodexToolEventMode::Call),
    definition(
        "tool_search_output",
        "tool_search",
        CodexToolEventMode::Result,
    ),
];

const fn definition(
    item_type: &'static str,
    canonical_name: &'static str,
    mode: CodexToolEventMode,
) -> CodexToolEventDefinition {
    CodexToolEventDefinition {
        item_type,
        canonical_name,
        mode,
        prefer_payload_name: false,
    }
}

const fn payload_named_definition(
    item_type: &'static str,
    canonical_name: &'static str,
    mode: CodexToolEventMode,
) -> CodexToolEventDefinition {
    CodexToolEventDefinition {
        item_type,
        canonical_name,
        mode,
        prefer_payload_name: true,
    }
}

pub(crate) fn tool_event_definition(item_type: &str) -> Option<CodexToolEventDefinition> {
    CODEX_TOOL_EVENT_DEFINITIONS
        .iter()
        .copied()
        .find(|definition| definition.item_type == item_type)
}

/// Conservative forward-compatibility gate. Valid JSON is shown as a generic
/// tool only when either its type is tool-shaped or it exposes call/tool
/// identity plus input/output fields. Lifecycle and message records therefore
/// remain hidden rather than becoming noisy fake tool cards.
pub(crate) fn looks_like_unknown_tool_event(item_type: &str, payload: &Value) -> bool {
    let type_is_tool_shaped = item_type.contains("tool")
        || item_type.ends_with("_call")
        || item_type.ends_with("_execution")
        || item_type.ends_with("_change")
        || item_type.ends_with("_search")
        || item_type.ends_with("_generation");
    let has_identity = ["call_id", "tool_call_id", "tool_name", "name"]
        .iter()
        .any(|key| payload.get(*key).is_some());
    let has_tool_data = [
        "arguments",
        "input",
        "params",
        "output",
        "result",
        "aggregated_output",
    ]
    .iter()
    .any(|key| payload.get(*key).is_some());
    type_is_tool_shaped || (has_identity && has_tool_data)
}

pub(crate) fn tool_event_id(payload: &Value, item_type: &str) -> String {
    ["call_id", "tool_call_id", "id"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex-{item_type}"))
}

pub(crate) fn tool_event_name(
    payload: &Value,
    definition: Option<CodexToolEventDefinition>,
    item_type: &str,
) -> String {
    if let Some(definition) = definition.filter(|definition| !definition.prefer_payload_name) {
        return definition.canonical_name.to_string();
    }
    let payload_name = payload
        .get("name")
        .or_else(|| payload.get("tool_name"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("invocation")
                .and_then(|invocation| invocation.get("tool"))
                .and_then(Value::as_str)
        })
        .filter(|name| !name.trim().is_empty());
    if payload_name == Some("exec") {
        if let Some(name) = single_nested_exec_tool_name(payload) {
            return name;
        }
    }
    payload_name.map(str::to_string).unwrap_or_else(|| {
        definition
            .map(|definition| definition.canonical_name)
            .unwrap_or(item_type)
            .to_string()
    })
}

/// Newer Codex sessions wrap function tools in one `custom_tool_call` named
/// `exec`. When that wrapper invokes exactly one distinct `tools.<name>(...)`
/// function, expose the inner name for the UI. Multi-tool orchestration stays
/// labelled `exec` because splitting it into synthetic rows would be lossy.
fn single_nested_exec_tool_name(payload: &Value) -> Option<String> {
    let input = payload.get("input").and_then(Value::as_str)?;
    let mut names = std::collections::BTreeSet::new();
    let mut rest = input;
    while let Some(index) = rest.find("tools.") {
        rest = &rest[index + "tools.".len()..];
        let len = rest
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .map(char::len_utf8)
            .sum::<usize>();
        if len > 0 && rest[len..].trim_start().starts_with('(') {
            names.insert(rest[..len].to_string());
        }
        rest = &rest[len.min(rest.len())..];
    }
    (names.len() == 1)
        .then(|| names.into_iter().next())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_unique_item_types() {
        let mut types = std::collections::HashSet::new();
        for definition in CODEX_TOOL_EVENT_DEFINITIONS {
            assert!(
                types.insert(definition.item_type),
                "duplicate tool event type"
            );
        }
    }

    #[test]
    fn registry_covers_current_codex_tool_families() {
        for item_type in [
            "command_execution",
            "mcp_tool_call",
            "mcp_tool_call_end",
            "file_change",
            "patch_apply_end",
            "web_search",
            "web_search_end",
            "web_search_call",
            "image_generation",
            "image_generation_call",
            "image_generation_end",
            "dynamic_tool_call",
            "collab_agent_tool_call",
            "tool_search_call",
            "tool_search_output",
            "function_call",
            "function_call_output",
            "custom_tool_call",
            "custom_tool_call_output",
        ] {
            assert!(
                tool_event_definition(item_type).is_some(),
                "missing Codex tool event definition: {item_type}"
            );
        }
    }

    #[test]
    fn unknown_fallback_requires_tool_shape() {
        assert!(looks_like_unknown_tool_event(
            "future_connector_call",
            &serde_json::json!({ "call_id": "c1", "arguments": {} })
        ));
        assert!(!looks_like_unknown_tool_event(
            "thread_settings_applied",
            &serde_json::json!({ "model": "gpt-5" })
        ));
        assert!(!looks_like_unknown_tool_event(
            "message",
            &serde_json::json!({ "role": "assistant", "content": "done" })
        ));
    }

    #[test]
    fn unwraps_only_single_tool_exec_calls() {
        let single = serde_json::json!({
            "name": "exec",
            "input": "const result = await tools.view_image({path: '/tmp/a.png'});"
        });
        assert_eq!(
            tool_event_name(
                &single,
                tool_event_definition("custom_tool_call"),
                "custom_tool_call"
            ),
            "view_image"
        );

        let multiple = serde_json::json!({
            "name": "exec",
            "input": "await tools.exec_command({}); await tools.view_image({});"
        });
        assert_eq!(
            tool_event_name(
                &multiple,
                tool_event_definition("custom_tool_call"),
                "custom_tool_call"
            ),
            "exec"
        );
    }
}
