use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::agent::AgentId;
use crate::session::{ChatMessage, ThreadInfo, ThreadMessagesPage};

const AGENT_TYPE: &str = "codex";
const MAX_HISTORY_TOOL_OUTPUT_CHARS: usize = 4096;

pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_codex_sessions)
        .await
        .map_err(|e| e.to_string())?
}

pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || read_codex_session_messages(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn get_session_page(
    session_id: &str,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let messages = read_codex_session_messages(&session_id)?;
        Ok(paginate_codex_messages(messages, before_sequence, limit))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn is_codex_session_id(text: &str) -> bool {
    // 必须显式拒绝 "codex-local-agent-inst-<ts>-<seq>" 等前端占位符 ──
    // 这些字符串长度 ≥ 32 且包含 5 个 dash, 老版宽松判断会把它当成
    // session id 传给 Codex CLI 的 resume, 但 CLI 不认 ── 与
    // claude_history 同病同治。
    let value = text.trim();
    if value.is_empty() || value.starts_with("codex-local-") {
        return false;
    }
    value.len() >= 32
        && value.chars().filter(|c| *c == '-').count() == 4
}

#[derive(Default)]
struct CodexSessionDraft {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    path: Option<PathBuf>,
}

fn list_codex_sessions() -> Result<Vec<ThreadInfo>, String> {
    let mut sessions: BTreeMap<String, CodexSessionDraft> = BTreeMap::new();

    for item in read_codex_history_items()? {
        let draft = sessions.entry(item.session_id.clone()).or_default();
        draft.id = item.session_id;
        draft.title = Some(item.text);
        draft.updated_at = Some(item.ts);
        draft.created_at = draft.created_at.or(Some(item.ts));
    }

    for path in codex_session_files()? {
        if let Ok(meta) = read_codex_session_meta(&path) {
            let draft = sessions.entry(meta.id.clone()).or_default();
            draft.id = meta.id;
            draft.path = Some(path);
            draft.created_at = draft.created_at.or(meta.created_at);
            draft.updated_at = draft.updated_at.max(meta.updated_at).or(meta.created_at);
            if draft
                .title
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                draft.title = meta.title;
            }
        }
    }

    let mut list = sessions
        .into_values()
        .filter(|draft| !draft.id.trim().is_empty())
        .map(|draft| {
            let created_at = draft
                .created_at
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            ThreadInfo {
                thread_id: draft.id,
                agent_id: AgentId::new(AGENT_TYPE),
                title: draft
                    .title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| "Codex Session".to_string()),
                created_at,
                updated_at: draft.updated_at.unwrap_or(created_at),
            }
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

fn read_codex_session_messages(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let path = find_codex_session_file(session_id)?
        .ok_or_else(|| format!("Codex session not found: {session_id}"))?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    let mut seen_user_messages = HashSet::new();

    for (idx, line) in text.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let top_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload").unwrap_or(&value);

        if top_type == "event_msg" {
            if let Some(message) = event_msg_to_chat_message(session_id, idx, &timestamp, payload) {
                if message.role == "user" && !seen_user_messages.insert(message.content.clone()) {
                    continue;
                }
                messages.push(message);
            }
            continue;
        }

        if top_type != "response_item" {
            continue;
        }

        if let Some(message) = response_item_to_chat_message(session_id, idx, &timestamp, payload) {
            if message.role == "user" {
                if message.content.starts_with("<environment_context>") {
                    continue;
                }
                if !seen_user_messages.insert(message.content.clone()) {
                    continue;
                }
            }
            if message.role == "tool" && message.id.starts_with("tool-result-") {
                if let Some(call_id) = message.tool_call_id.as_deref() {
                    if let Some(existing) =
                        messages.iter_mut().rev().find(|m: &&mut ChatMessage| {
                            m.role == "tool" && m.tool_call_id.as_deref() == Some(call_id)
                        })
                    {
                        existing.content = message.content.clone();
                        existing.tool_data = message.tool_data.clone();
                        existing.is_loading = Some(false);
                        continue;
                    }
                }
            }
            messages.push(message);
        }
    }

    // A Codex process killed mid-tool-execution (SIGKILL, OOM, power loss)
    // can leave `function_call` rows without their `function_call_output`
    // counterpart. They render as permanently-spinning tool rows in the UI.
    // For every tool row that still has `is_loading = true` after the merge
    // pass, look up whether its `call_id` has a matching tool_result; if
    // not, force `is_loading = false` so the UI stops spinning. The
    // unmatched `tool_input` is preserved so the user can still see what
    // the model attempted.
    close_orphan_codex_tool_calls(&mut messages);

    Ok(messages)
}

fn close_orphan_codex_tool_calls(messages: &mut [ChatMessage]) {
    use std::collections::HashSet;
    let matched: HashSet<String> = messages
        .iter()
        .filter(|m| m.role == "tool" && m.tool_name.as_deref() == Some("tool_result"))
        .filter_map(|m| m.tool_call_id.clone())
        .collect();
    for m in messages.iter_mut() {
        if m.role == "tool"
            && m.is_loading == Some(true)
            && m.tool_name.as_deref() != Some("tool_result")
        {
            if let Some(id) = m.tool_call_id.as_ref() {
                if !matched.contains(id) {
                    m.is_loading = Some(false);
                }
            }
        }
    }
}

fn paginate_codex_messages(
    messages: Vec<ChatMessage>,
    before_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let total = messages.len();
    let limit = limit.clamp(1, 1000) as usize;
    let end = before_sequence
        .map(|sequence| (sequence - 1).clamp(0, total as i64) as usize)
        .unwrap_or(total);
    let start = end.saturating_sub(limit);
    let page_messages = if start < end {
        messages[start..end].to_vec()
    } else {
        Vec::new()
    };
    ThreadMessagesPage {
        messages: page_messages,
        oldest_sequence: (start < end).then_some((start + 1) as i64),
        has_more: start > 0,
    }
}

struct HistoryItem {
    session_id: String,
    text: String,
    ts: i64,
}

fn read_codex_history_items() -> Result<Vec<HistoryItem>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let path = home.join(".codex").join("history.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        let text = value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("Codex Session")
            .replace('\n', " ");
        let ts = value
            .get("ts")
            .and_then(Value::as_i64)
            .map(normalize_epoch_millis)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        items.push(HistoryItem {
            session_id: session_id.to_string(),
            text: truncate_title(&text),
            ts,
        });
    }
    Ok(items)
}

struct SessionMeta {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

fn read_codex_session_meta(path: &Path) -> Result<SessionMeta, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut id = None;
    let mut title = None;
    let mut created_at = None;
    let mut updated_at = None;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(ts) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_millis)
        {
            created_at = created_at.or(Some(ts));
            updated_at = Some(ts);
        }
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "session_meta" => {
                let payload = value.get("payload").unwrap_or(&value);
                id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(id);
                if let Some(ts) = payload
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_timestamp_millis)
                {
                    created_at = created_at.or(Some(ts));
                }
            }
            "response_item" => {
                if title.is_none() {
                    let payload = value.get("payload").unwrap_or(&value);
                    if payload.get("type").and_then(Value::as_str) == Some("message")
                        && payload.get("role").and_then(Value::as_str) == Some("user")
                    {
                        if let Some(text) = content_parts_to_text(payload.get("content")) {
                            if !text.starts_with("<environment_context>") {
                                title = Some(truncate_title(&text.replace('\n', " ")));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let id = id
        .or_else(|| session_id_from_filename(path))
        .ok_or_else(|| "missing Codex session id".to_string())?;
    Ok(SessionMeta {
        id,
        title,
        created_at,
        updated_at,
    })
}

fn response_item_to_chat_message(
    session_id: &str,
    idx: usize,
    timestamp: &str,
    payload: &Value,
) -> Option<ChatMessage> {
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match item_type {
        "message" => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if role != "user" && role != "assistant" {
                return None;
            }
            let content = content_parts_to_text(payload.get("content"))?;
            if content.trim().is_empty() {
                return None;
            }
            Some(base_message(
                format!("{session_id}-{idx}-{role}"),
                role,
                content,
                timestamp,
            ))
        }
        "function_call" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or(name)
                .to_string();
            let input = payload
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| payload.clone());
            let mut message =
                base_message(format!("tool-{call_id}"), "tool", String::new(), timestamp);
            message.tool_call_id = Some(call_id);
            message.tool_name = Some(name.to_string());
            message.tool_input = Some(input);
            message.is_loading = Some(true);
            Some(message)
        }
        "function_call_output" => {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let raw_output = payload
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| payload.to_string());
            let output_chars = raw_output.chars().count();
            let output_truncated = output_chars > MAX_HISTORY_TOOL_OUTPUT_CHARS;
            let output = truncate_history_tool_output(&raw_output);
            let data = serde_json::json!({
                "output": output,
                "output_chars": output_chars,
                "output_truncated": output_truncated,
            });
            let data_text =
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string());
            let mut message = base_message(
                format!("tool-result-{call_id}"),
                "tool",
                data_text.clone(),
                timestamp,
            );
            message.tool_call_id = Some(call_id);
            message.tool_name = Some("tool_result".to_string());
            message.tool_data = Some(data_text);
            message.is_loading = Some(false);
            Some(message)
        }
        "web_search_call" | "web_search" | "web_search_preview" | "search_query" => {
            let call_id = payload
                .get("call_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("web_search")
                .to_string();
            let mut message =
                base_message(format!("tool-{call_id}"), "tool", String::new(), timestamp);
            message.tool_call_id = Some(call_id);
            message.tool_name = Some("web_search".to_string());
            message.tool_input = Some(payload.clone());
            message.is_loading = Some(false);
            Some(message)
        }
        "reasoning" => {
            let summary = payload
                .get("summary")
                .and_then(Value::as_array)
                .and_then(|items| {
                    let text = items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                    (!text.trim().is_empty()).then_some(text)
                })?;
            let mut message = base_message(
                format!("{session_id}-{idx}-reasoning"),
                "reasoning",
                summary,
                timestamp,
            );
            message.is_completed = Some(true);
            Some(message)
        }
        _ => None,
    }
}

fn event_msg_to_chat_message(
    session_id: &str,
    idx: usize,
    timestamp: &str,
    payload: &Value,
) -> Option<ChatMessage> {
    match payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "user_message" => payload.get("message").and_then(Value::as_str).map(|text| {
            base_message(
                format!("{session_id}-{idx}-user-event"),
                "user",
                text.to_string(),
                timestamp,
            )
        }),
        _ => None,
    }
}

fn base_message(id: String, role: &str, content: String, timestamp: &str) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp: if timestamp.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            timestamp.to_string()
        },
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        is_collapsed: None,
    }
}

fn content_parts_to_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.to_string()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn codex_session_files() -> Result<Vec<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect())
}

fn find_codex_session_file(session_id: &str) -> Result<Option<PathBuf>, String> {
    for path in codex_session_files()? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(session_id))
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    for path in codex_session_files()? {
        if read_codex_session_meta(&path)
            .map(|meta| meta.id == session_id)
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn session_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts = stem.rsplit('-').take(5).collect::<Vec<_>>();
    if parts.len() == 5 {
        Some(parts.into_iter().rev().collect::<Vec<_>>().join("-"))
    } else {
        None
    }
}

/// 从 Codex CLI 的 session jsonl 里读出原始 cwd ── Codex rollout 文件
/// 第一行通常是 `session_meta` 事件, 内嵌 `payload.cwd` 字段.
///
/// 用途: 后端 `codex_cli.rs` 的 cwd 兜底链 ── IPC 入参拿不到 cwd 时,
/// 用 session 文件自身的 cwd 作为真源。 与 claude 修复同形 (见
/// `claude_history::claude_session_cwd` 注释).
pub fn codex_session_cwd(session_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    codex_session_cwd_in(&home, session_id)
}

pub(crate) fn codex_session_cwd_in(
    home: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(path) = codex_session_files_in(home)
        .into_iter()
        .flatten()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.contains(session_id))
                .unwrap_or(false)
                || read_codex_session_meta(path)
                    .map(|meta| meta.id == session_id)
                    .unwrap_or(false)
        })
    else {
        return Ok(None);
    };
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Codex 新版: `payload.cwd`, 旧版: 顶层 `cwd`. 两者都兼容.
        let cwd = value
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .or_else(|| value.get("cwd"))
            .and_then(Value::as_str);
        if let Some(cwd) = cwd {
            let trimmed = cwd.trim();
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }
        // 有的版本把 cwd 写在 `cwd` / `original_cwd` 字段. 兼容.
        if let Some(cwd) = value.get("original_cwd").and_then(Value::as_str) {
            let trimmed = cwd.trim();
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }
    }
    Ok(None)
}

pub(crate) fn codex_session_files_in(home: &Path) -> Result<Vec<PathBuf>, String> {
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect())
}

fn truncate_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= 40 {
        trimmed
    } else {
        format!("{}...", trimmed.chars().take(40).collect::<String>())
    }
}

fn truncate_history_tool_output(text: &str) -> String {
    if text.chars().count() <= MAX_HISTORY_TOOL_OUTPUT_CHARS {
        text.to_string()
    } else {
        format!(
            "{}\n...[truncated]",
            text.chars()
                .take(MAX_HISTORY_TOOL_OUTPUT_CHARS)
                .collect::<String>()
        )
    }
}

fn normalize_epoch_millis(ts: i64) -> i64 {
    if ts < 10_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}

fn parse_timestamp_millis(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_codex_session_ids() {
        assert!(is_codex_session_id("019ed38f-e9e3-7b61-8be3-80a40788d6e3"));
        assert!(!is_codex_session_id("thread_1781665906"));
    }

    #[test]
    fn rejects_local_codex_thread_ids() {
        // 同 claude 的修复 ── "codex-local-agent-inst-..." 前缀直接拒掉,
        // 避免误把前端占位符当 Codex CLI session id。
        assert!(!is_codex_session_id(
            "codex-local-agent-inst-1783828675847-3"
        ));
        assert!(!is_codex_session_id(""));
    }

    #[test]
    fn extracts_session_id_from_rollout_filename() {
        let path =
            PathBuf::from("rollout-2026-06-17T11-11-24-019ed38f-e9e3-7b61-8be3-80a40788d6e3.jsonl");
        assert_eq!(
            session_id_from_filename(&path).as_deref(),
            Some("019ed38f-e9e3-7b61-8be3-80a40788d6e3")
        );
    }

    #[test]
    fn maps_response_item_function_call_to_tool_message() {
        let payload = serde_json::json!({
            "type": "function_call",
            "name": "shell_command",
            "arguments": "{\"command\":\"echo congratulations\"}",
            "call_id": "call_1"
        });
        let message =
            response_item_to_chat_message("session_1", 3, "2026-06-17T03:11:36Z", &payload)
                .expect("tool message");
        assert_eq!(message.role, "tool");
        assert_eq!(message.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(message.tool_name.as_deref(), Some("shell_command"));
        assert_eq!(
            message.tool_input.as_ref().and_then(|v| v.get("command")),
            Some(&serde_json::json!("echo congratulations"))
        );
        assert_eq!(message.is_loading, Some(true));
    }

    #[test]
    fn maps_response_item_web_search_call_to_tool_message() {
        let payload = serde_json::json!({
            "type": "web_search_call",
            "id": "ws_1",
            "action": {
                "query": [{"q": "Flowix Codex web search history"}]
            },
            "status": "completed"
        });
        let message =
            response_item_to_chat_message("session_1", 3, "2026-06-17T03:11:36Z", &payload)
                .expect("web search tool message");
        assert_eq!(message.role, "tool");
        assert_eq!(message.tool_call_id.as_deref(), Some("ws_1"));
        assert_eq!(message.tool_name.as_deref(), Some("web_search"));
        assert_eq!(
            message
                .tool_input
                .as_ref()
                .and_then(|v| v.get("action"))
                .and_then(|v| v.get("query")),
            Some(&serde_json::json!([{ "q": "Flowix Codex web search history" }]))
        );
        assert_eq!(message.is_loading, Some(false));
    }

    #[test]
    fn truncates_large_function_call_output_for_history_messages() {
        let large_output = "x".repeat(MAX_HISTORY_TOOL_OUTPUT_CHARS + 10);
        let payload = serde_json::json!({
            "type": "function_call_output",
            "call_id": "call_1",
            "output": large_output,
        });

        let message =
            response_item_to_chat_message("session_1", 4, "2026-06-17T03:11:36Z", &payload)
                .expect("tool result message");
        let tool_data = message.tool_data.as_deref().expect("tool data");
        let data: Value = serde_json::from_str(tool_data).expect("tool data json");

        assert_eq!(message.role, "tool");
        assert_eq!(message.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(data.get("output_chars").and_then(Value::as_u64), Some(4106));
        assert_eq!(
            data.get("output_truncated").and_then(Value::as_bool),
            Some(true)
        );
        assert!(data
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .ends_with("...[truncated]"));
    }

    #[test]
    fn paginates_codex_messages_with_virtual_sequence() {
        let messages = (0..25)
            .map(|idx| {
                base_message(
                    format!("message-{idx}"),
                    "assistant",
                    format!("message {idx}"),
                    "2026-06-17T03:11:36Z",
                )
            })
            .collect::<Vec<_>>();

        let first = paginate_codex_messages(messages.clone(), None, 10);
        assert_eq!(first.messages.len(), 10);
        assert_eq!(first.messages[0].id, "message-15");
        assert_eq!(first.oldest_sequence, Some(16));
        assert!(first.has_more);

        let second = paginate_codex_messages(messages, first.oldest_sequence, 10);
        assert_eq!(second.messages.len(), 10);
        assert_eq!(second.messages[0].id, "message-5");
        assert_eq!(second.oldest_sequence, Some(6));
        assert!(second.has_more);
    }

    #[test]
    fn close_orphan_codex_tool_calls_closes_only_unmatched_calls() {
        let mut messages = vec![
            // function_call(call_id=X) — has a matching output below.
            tool_call_msg("X", "Read", true),
            // function_call(call_id=Y) — killed before tool_result was written.
            tool_call_msg("Y", "Bash", true),
            // function_call_output for X (already merged with the row above).
            tool_result_msg("X", "ok"),
        ];

        close_orphan_codex_tool_calls(&mut messages);

        let by_call: std::collections::HashMap<&str, &ChatMessage> = messages
            .iter()
            .filter_map(|m| m.tool_call_id.as_deref().map(|id| (id, m)))
            .collect();
        // X: matched → left at is_loading=false (because the output row has it).
        assert_eq!(by_call["X"].is_loading, Some(false));
        // Y: unmatched → forced to false.
        assert_eq!(by_call["Y"].is_loading, Some(false));
    }

    #[test]
    fn close_orphan_codex_tool_calls_leaves_non_tool_rows_alone() {
        // User rows and any other non-tool rows must not be touched by
        // the orphan sweep; only role=tool rows with is_loading=true and
        // unmatched call_id are fair game.
        let mut messages = vec![
            user_msg("hello"),
            tool_call_msg("Z", "Read", false), // already merged with output below
            tool_result_msg("Z", "loaded"),
        ];

        close_orphan_codex_tool_calls(&mut messages);

        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].is_loading, None);
        // The merge layer is what flips a matched function_call to
        // is_loading=false; the orphan sweep correctly leaves it alone.
        assert_eq!(messages[1].is_loading, Some(false));
        assert_eq!(messages[2].is_loading, Some(false));
    }

    fn tool_call_msg(call_id: &str, name: &str, loading: bool) -> ChatMessage {
        let mut m = base_message(
            format!("tool-{call_id}"),
            "tool",
            String::new(),
            "2026-06-17T03:11:36Z",
        );
        m.tool_call_id = Some(call_id.to_string());
        m.tool_name = Some(name.to_string());
        m.is_loading = Some(loading);
        m.tool_input = Some(serde_json::json!({}));
        m
    }

    fn tool_result_msg(call_id: &str, output: &str) -> ChatMessage {
        let mut m = base_message(
            format!("tool-result-{call_id}"),
            "tool",
            output.to_string(),
            "2026-06-17T03:11:37Z",
        );
        m.tool_call_id = Some(call_id.to_string());
        m.tool_name = Some("tool_result".to_string());
        m.tool_data = Some(output.to_string());
        m.is_loading = Some(false);
        m
    }

    fn user_msg(text: &str) -> ChatMessage {
        base_message(
            "user-msg".to_string(),
            "user",
            text.to_string(),
            "2026-06-17T03:11:35Z",
        )
    }

    /// Codex rollout session_meta 事件带 `payload.cwd`. 验证
    /// `codex_session_cwd_in` 能从该字段读出真值 ── 后端 cwd 兜底链
    /// 在 IPC 入参空时, 用这个值救回 "重启后 resume cwd 缺失"。
    #[test]
    fn codex_session_cwd_reads_payload_cwd() {
        let tmp = codex_session_cwd_tempdir();
        let sessions_dir = tmp.join(".codex").join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
        let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e3";
        let path = sessions_dir.join(format!("rollout-2026-07-12T00-00-00-{sid}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-07-12T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{sid}\",\"cwd\":\"{tmp}\"}}}}\n",
                tmp = tmp.display(),
                sid = sid,
            ),
        )
        .expect("write rollout jsonl");

        // 不依赖 dirs::home_dir / HOME env. 直接传 home.
        let cwd = codex_session_cwd_in(&tmp, sid).expect("read cwd");
        let resolved = cwd.expect("cwd should be present");
        assert_eq!(resolved, tmp);
    }

    /// 字段缺失时返回 None ── 不允许悄悄兜底到 "."
    #[test]
    fn codex_session_cwd_returns_none_when_missing() {
        let tmp = codex_session_cwd_tempdir();
        let sessions_dir = tmp.join(".codex").join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
        let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e4";
        let path = sessions_dir.join(format!("rollout-2026-07-12T00-00-00-{sid}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-07-12T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{sid}\"}}}}\n",
                sid = sid
            ),
        )
        .expect("write rollout jsonl");

        let cwd = codex_session_cwd_in(&tmp, sid).expect("read cwd");
        assert!(cwd.is_none());
    }

    fn codex_session_cwd_tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codex-history-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        dir
    }
}
