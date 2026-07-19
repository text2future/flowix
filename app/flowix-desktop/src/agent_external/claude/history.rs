use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::agent_session::{ChatMessage, ThreadInfo};
use crate::agent_types::AgentId;

use super::{
    events::{should_silence_event, silence_reason},
    AGENT_TYPE,
};

/// [history path] 列出 `~/.claude/projects/.../*.jsonl` 里的所有 session
/// 摘要。被前端 IPC `list_agent_conversation_instances` 等调用,数据源
/// 是持久化 JSONL ── 与 stream path 完全独立。
pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_claude_sessions)
        .await
        .map_err(|e| e.to_string())?
}

/// [history path] 读 `~/.claude/projects/.../<sid>.jsonl` 全量,转成
/// `Vec<ChatMessage>` 推到 thread card。被前端 IPC `get_session` 调用。
/// 同会话的 stream path 走 `events.rs::parse_claude_stdout_line`,
/// 数据源是 Claude Code 子进程的 stdout ── 两条 path 处理的是同一份
/// 对话的不同视图(streaming 是实时切片, history 是压缩后的全量)。
pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || read_claude_session_messages(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

pub fn is_claude_session_id(text: &str) -> bool {
    // 必须显式拒绝 "claude-local-agent-inst-<ts>-<seq>" 等前端 thread id
    // 占位符 ── 这些字符串长度 ≥ 32 且包含 5 个 dash, 老版宽松判断会把
    // 它们当成 session id 透传给 Claude CLI 的 --resume, 但 CLI 是 UUID
    // 严格校验: "Provided value ... is not a UUID and does not match any
    // session title"。
    let value = text.trim();
    if value.is_empty() || value.starts_with("claude-local-") {
        return false;
    }
    // Claude Code 真 session id 是 UUID ── 36 字符, 4 个 dash, 其余全是
    // ASCII 十六进制位。 同时也兼容 Claude 后续可能的非 UUID 格式
    // (例如未来他们换 ULID/base32), 通过长度 + dash 计数宽放, 仍是合法
    // 的"长得像 id 字符串"。
    let dash_count = value.chars().filter(|c| *c == '-').count();
    value.len() >= 32 && dash_count == 4
}

#[derive(Default)]
struct ClaudeSessionDraft {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

fn list_claude_sessions() -> Result<Vec<ThreadInfo>, String> {
    let mut sessions: BTreeMap<String, ClaudeSessionDraft> = BTreeMap::new();

    for path in claude_session_files()? {
        if let Ok(meta) = read_claude_session_meta(&path) {
            let draft = sessions.entry(meta.id.clone()).or_default();
            draft.id = meta.id;
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
                    .unwrap_or_else(|| "Claude Code Session".to_string()),
                created_at,
                updated_at: draft.updated_at.unwrap_or(created_at),
            }
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

/// [history path] 读持久化 JSONL 全量,逐行转 `ChatMessage`。每行经
/// `value_to_chat_messages` 过滤(isMeta / isSidechain / isSynthetic /
/// subagent_type / task-notification 守卫),再经 `append_claude_history_message`
/// 合并同 tool_call_id 的 tool_use + tool_result。
fn read_claude_session_messages(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let path = find_claude_session_file(session_id)?
        .ok_or_else(|| format!("Claude Code session not found: {session_id}"))?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();

    for (idx, line) in text.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        for message in value_to_chat_messages(session_id, idx, &value) {
            append_claude_history_message(&mut messages, message);
        }
    }

    // A Claude Code process killed mid-tool-execution (SIGKILL, OOM, power
    // loss) can leave `tool_use` rows without their `tool_result`
    // counterpart. They render as permanently-spinning tool rows in the UI.
    // For every tool row that still has `is_loading = true`, look up whether
    // its id has a matching tool_result; if not, force `is_loading = false`
    // so the UI stops spinning. The unmatched `tool_input` is preserved.
    close_orphan_claude_tool_calls(&mut messages);

    Ok(messages)
}

/// [history path] 修复"session 中途被 kill 留下的孤儿 tool_use"。
/// stream path 没有等价需求 ── 流式下 tool_result 紧跟 tool_use 到达,
/// 不会留孤儿。
fn close_orphan_claude_tool_calls(messages: &mut [ChatMessage]) {
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

/// [history path] 把 `value_to_chat_messages` 产生的 `ChatMessage` 追加
/// 到消息列表;特殊处理 tool_result ── 若已有同 tool_call_id 的
/// tool_call_message(说明 tool_use 已先到),则原地合并而非追加,
/// 避免 thread card 上同时显示"调用中"和"已返回"两条 tool 气泡。
fn append_claude_history_message(messages: &mut Vec<ChatMessage>, message: ChatMessage) {
    let is_tool_result = message.role == "tool"
        && message.tool_name.as_deref() == Some("tool_result")
        && message.tool_call_id.as_deref().is_some();
    if !is_tool_result {
        messages.push(message);
        return;
    }

    let Some(tool_call_id) = message.tool_call_id.as_deref() else {
        messages.push(message);
        return;
    };
    if let Some(existing) = messages
        .iter_mut()
        .rev()
        .find(|m| m.role == "tool" && m.tool_call_id.as_deref() == Some(tool_call_id))
    {
        existing.content = message.content;
        existing.tool_data = message.tool_data;
        existing.is_loading = Some(false);
    } else {
        messages.push(message);
    }
}

struct SessionMeta {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

/// [history path] 读 JSONL 全量,提取 session 级元数据 ── id / title /
/// created_at / updated_at。title 从首个 type=user 行 + 非合成消息
/// (`!should_silence_event`) + 含可读 text 的行提取 ── 避免把
/// Skill body / task-notification XML 误当成 session 标题。
fn read_claude_session_meta(path: &Path) -> Result<SessionMeta, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut id = session_id_from_filename(path);
    let mut title = None;
    let mut created_at = None;
    let mut updated_at = None;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        id = extract_session_id(&value).or(id);
        if let Some(ts) = extract_timestamp_millis(&value) {
            created_at = created_at.or(Some(ts));
            updated_at = Some(ts);
        }
        if title.is_none()
            && value.get("type").and_then(Value::as_str) == Some("user")
            && !should_silence_event(&value)
        {
            if let Some(text) = message_content_to_text(&value) {
                title = Some(truncate_title(&text.replace('\n', " ")));
            }
        }
    }

    let id = id.ok_or_else(|| "missing Claude Code session id".to_string())?;
    Ok(SessionMeta {
        id,
        title,
        created_at,
        updated_at,
    })
}

/// [history path] 从 Claude Code CLI 的 session jsonl 里读出原始 cwd ──
/// session 元数据第一行通常带 `cwd` 字段 (`{"type":..., "cwd":"/abs/path", ...}`).
///
/// 用途: 后端 `claude_cli.rs::run_claude` 的 cwd 兜底链 ── 当 IPC 入参
/// 的 `message.cwd_for_runtime` 拿不到值时 (前端全局 store 启动 race
/// 场景), 用 session 文件自身的 cwd 作为最可靠的真源。 见 agent_conversation
/// 在前端把 runtime_config 写入 instance 的对应修复。
pub fn claude_session_cwd(session_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(path) = find_claude_session_file(session_id)? else {
        return Ok(None);
    };
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            let trimmed = cwd.trim();
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }
        // metadata 事件 (新版本 Claude Code CLI 把 cwd 放在 metadata.cwd)
        if let Some(cwd) = value
            .get("metadata")
            .and_then(|m| m.get("cwd"))
            .and_then(Value::as_str)
        {
            let trimmed = cwd.trim();
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }
        // envelope 模式: message.cwd (legacy)
        if let Some(cwd) = value
            .get("message")
            .and_then(|m| m.get("cwd"))
            .and_then(Value::as_str)
        {
            let trimmed = cwd.trim();
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }
    }
    Ok(None)
}

/// [history path] 持久化 JSONL 单行 → `Vec<ChatMessage>` ── 被
/// `read_claude_session_messages` 调用。Entry guard 用 `silence_reason`
/// 拦截合成消息(详见 `silence_reason` 的 doc);通过后按 role 分发:
/// text / tool_use / tool_result 块各自转 `ChatMessage`。
fn value_to_chat_messages(session_id: &str, idx: usize, value: &Value) -> Vec<ChatMessage> {
    if let Some(reason) = silence_reason(value) {
        tracing::debug!(
            "[ClaudeHistory] silenced event session_id={session_id} idx={idx} reason={reason} \
             event_type={} is_meta={} is_sidechain={} origin_kind={}",
            value.get("type").and_then(serde_json::Value::as_str).unwrap_or_default(),
            value.get("isMeta").and_then(serde_json::Value::as_bool).unwrap_or(false),
            value.get("isSidechain").and_then(serde_json::Value::as_bool).unwrap_or(false),
            value.get("origin")
                .and_then(|o| o.get("kind"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
        );
        return Vec::new();
    }

    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => value
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    };
    if role != "user" && role != "assistant" {
        return Vec::new();
    }
    let timestamp = extract_timestamp(value);
    let mut messages = Vec::new();

    if let Some(content) = message_content(value) {
        if let Some(parts) = content.as_array() {
            // `should_skip_user_text_blocks` heuristic **intentionally removed**.
            // Empirically validated: the event-level guards in `silence_reason`
            // (isMeta / isSidechain / isSynthetic / subagent_type /
            // task-notification) already cover every real-case synthetic message.
            // history.rs's content-shape heuristic was redundant defense, and
            // removing it let history.rs stop tracking the "real user input +
            // image" defensive case that Claude Code doesn't currently emit in
            // JSONL. If a future Claude Code CLI release starts echoing user
            // text + image rows that we want to render verbatim, re-add the
            // heuristic and the two tests below.
            let mut text = String::new();
            for (part_idx, part) in parts.iter().enumerate() {
                let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
                match part_type {
                    "tool_use" => {
                        if !text.trim().is_empty() {
                            messages.push(base_message(
                                format!("{session_id}-{idx}-{role}-text-{}", messages.len()),
                                role,
                                std::mem::take(&mut text),
                                timestamp.clone(),
                            ));
                        }
                        messages.push(tool_call_message(
                            session_id, idx, part_idx, part, &timestamp,
                        ));
                    }
                    "tool_result" => {
                        // 与 events.rs type=user 的 "Async agent launched
                        // successfully" 前缀守卫对齐 ── Agent launch metadata
                        // 占位 tool_result 在持久化 JSONL 里 isSidechain=false /
                        // 无 subagent_type,事件级 silence_reason 抓不到,只能
                        // 靠 content 前缀判定。content 有 string 和 array 两种
                        // 形态,都得查。
                        let content_text = match part.get("content") {
                            Some(Value::String(s)) => Some(s.as_str()),
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .filter_map(|p| {
                                    p.get("text").and_then(Value::as_str)
                                })
                                .next(),
                            _ => None,
                        };
                        let is_agent_launch_metadata = content_text.is_some_and(
                            |s| s.starts_with("Async agent launched successfully"),
                        );
                        if is_agent_launch_metadata {
                            continue;
                        }
                        if !text.trim().is_empty() {
                            messages.push(base_message(
                                format!("{session_id}-{idx}-{role}-text-{}", messages.len()),
                                role,
                                std::mem::take(&mut text),
                                timestamp.clone(),
                            ));
                        }
                        messages.push(tool_result_message(
                            session_id, idx, part_idx, part, &timestamp,
                        ));
                    }
                    _ => {
                        if let Some(part_text) = part
                            .get("text")
                            .or_else(|| part.get("content"))
                            .and_then(Value::as_str)
                        {
                            text.push_str(part_text);
                        }
                    }
                }
            }
            if !text.trim().is_empty() {
                messages.push(base_message(
                    format!("{session_id}-{idx}-{role}-text-{}", messages.len()),
                    role,
                    text,
                    timestamp,
                ));
            }
            return messages;
        }
    }

    let Some(content) = message_content_to_text(value) else {
        return Vec::new();
    };
    if content.trim().is_empty() {
        return Vec::new();
    }
    vec![base_message(
        format!("{session_id}-{idx}-{role}"),
        role,
        content,
        timestamp,
    )]
}

/// [history path] 把任意形状 content (string / array) 摊平成纯文本 ──
/// `value_to_chat_messages` 的 string-content 兜底分支 + `read_claude_session_meta`
/// 的 title 提取共用。
fn message_content_to_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let content = message_content(value)?;
    content_blocks_to_text(content)
}

/// [history path] 在两种 content envelope 之间二选一:
/// `message.content`(嵌套格式,Claude Code v2) 或顶层 `content`(legacy 格式)。
fn message_content(value: &Value) -> Option<&Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"))
}

/// [history path] 把 array content 摊平成字符串 ── 遍历每个 block,取 `text`
/// 或 `content` 字段拼接;空结果返回 None(避免推空 user 气泡)。
fn content_blocks_to_text(content: &Value) -> Option<String> {
    match content {
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

/// [history path] 构造 user / tool 通用 ChatMessage 结构。所有 field 默认
/// None,调用方按需填充 tool_call_id / tool_name / tool_input / tool_data 等。
fn base_message(id: String, role: &str, content: String, timestamp: String) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp,
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

/// [history path] 构造 type=assistant 的 tool_use ChatMessage ── id /
/// name / tool_input 从 JSONL block 字段读出,等 tool_result 到来后由
/// `append_claude_history_message` 合并。
fn tool_call_message(
    session_id: &str,
    idx: usize,
    part_idx: usize,
    part: &Value,
    timestamp: &str,
) -> ChatMessage {
    let id = part
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("claude_tool")
        .to_string();
    let name = part
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let mut message = base_message(
        format!("{session_id}-{idx}-tool-call-{part_idx}"),
        "tool",
        String::new(),
        timestamp.to_string(),
    );
    message.tool_call_id = Some(id);
    message.tool_name = Some(name);
    message.tool_input = Some(part.get("input").cloned().unwrap_or(Value::Null));
    message.is_loading = Some(false);
    message
}

/// [history path] 构造 type=user 的 tool_result ChatMessage ── 解析
/// block.content 为 envelope JSON 字符串,存入 `tool_data` 供前端展示。
fn tool_result_message(
    session_id: &str,
    idx: usize,
    part_idx: usize,
    part: &Value,
    timestamp: &str,
) -> ChatMessage {
    let id = part
        .get("tool_use_id")
        .or_else(|| part.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("claude_tool")
        .to_string();
    let result = claude_tool_result_content(part);
    let result_content =
        serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
    let mut message = base_message(
        format!("{session_id}-{idx}-tool-result-{part_idx}"),
        "tool",
        result_content.clone(),
        timestamp.to_string(),
    );
    message.tool_call_id = Some(id);
    message.tool_name = Some("tool_result".to_string());
    message.tool_data = Some(result_content);
    message.is_loading = Some(false);
    message
}

/// [history path] 把 tool_result block.content 序列化成 envelope JSON
/// 字符串 ── 与 `events.rs::claude_tool_result_value`(events path)行为一致,
/// 只是输出格式用 pretty JSON 存到 `tool_data` 供前端展示。
fn claude_tool_result_content(part: &Value) -> Value {
    let Some(content) = part.get("content") else {
        return claude_tool_result_envelope(part.clone(), part);
    };
    let content = match content {
        Value::String(text) => serde_json::json!({ "content": text }),
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
            if text.trim().is_empty() {
                serde_json::json!({ "content": content })
            } else {
                serde_json::json!({ "content": text })
            }
        }
        _ => serde_json::json!({ "content": content }),
    };
    claude_tool_result_envelope(content, part)
}

/// [both paths] tool_result envelope 公共逻辑 ── history.rs 走
/// `claude_tool_result_content`,events.rs 走 `claude_tool_result_value`,
/// 两者最终都调这里给 envelope 加 `is_error` 字段。
fn claude_tool_result_envelope(mut value: Value, source: &Value) -> Value {
    if let Some(is_error) = source.get("is_error").and_then(Value::as_bool) {
        match &mut value {
            Value::Object(map) => {
                map.insert("is_error".to_string(), Value::Bool(is_error));
            }
            _ => {
                value = serde_json::json!({
                    "content": value,
                    "is_error": is_error,
                });
            }
        }
    }
    value
}

/// [history path] 列出 `~/.claude/projects/.../*.jsonl` 文件 ── 被
/// `find_claude_session_file` 调用。
fn claude_session_files() -> Result<Vec<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let config_root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let root = config_root.join("projects");
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

/// [history path] 按 session_id 找 JSONL 文件 ── 先按文件名匹配,
/// 找不到再退化为按 metadata.id 匹配(处理 sub-agent 文件名不含主 session id
/// 的情况)。
fn find_claude_session_file(session_id: &str) -> Result<Option<PathBuf>, String> {
    for path in claude_session_files()? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(session_id))
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    for path in claude_session_files()? {
        if read_claude_session_meta(&path)
            .map(|meta| meta.id == session_id)
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// [history path] 递归找 session id ── 顶层 / message envelope / parentUuid。
/// 被 `read_claude_session_meta` 用作 id fallback。
fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value
        .get("message")
        .and_then(|m| extract_session_id(m))
        .or_else(|| {
            value
                .get("parentUuid")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

/// [history path] 从文件路径里抽 session id ── `~/.claude/projects/.../<sid>.jsonl`
/// 的文件名就是 sid(去掉 .jsonl 后缀)。
fn session_id_from_filename(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_string)
}

/// [history path] 优先用 JSONL `timestamp` 字段;缺失则用当前时间作为 fallback。
fn extract_timestamp(value: &Value) -> String {
    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
        timestamp.to_string()
    } else {
        chrono::Utc::now().to_rfc3339()
    }
}

/// [history path] 同 `extract_timestamp`,但返回 i64 毫秒 ── 用于 session
/// metadata 的 created_at / updated_at 计算。
fn extract_timestamp_millis(value: &Value) -> Option<i64> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|text| {
            chrono::DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|dt| dt.timestamp_millis())
        })
}

/// [history path] session 标题裁剪 ── 收拢空白字符到单空格,截前 40 字符,
/// 超长加 `...`。被 `read_claude_session_meta` 用。
fn truncate_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= 40 {
        trimmed
    } else {
        format!("{}...", trimmed.chars().take(40).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_claude_session_ids() {
        assert!(is_claude_session_id("019ed38f-e9e3-7b61-8be3-80a40788d6e3"));
        assert!(!is_claude_session_id("claude-local-1"));
    }

    #[test]
    fn rejects_local_claude_thread_ids() {
        // 回归 ── 这条字符串长度 ≥ 32 且含 5 个 dash, 老版宽松规则会误判为
        // "是真的 session id", 把 `claude-local-agent-inst-...` 当真实 UUID
        // 透传给 Claude CLI 的 --resume。 CLI 是 UUID 严格校验, 报错:
        // "Provided value ... is not a UUID and does not match any session
        // title"。 修正后必须以 `claude-local-` 前缀直接拒掉。
        assert!(!is_claude_session_id(
            "claude-local-agent-inst-1783828675847-3"
        ));
        assert!(!is_claude_session_id(
            "claude-local-agent-inst-1783828675847-100"
        ));
        // 空白 + 短字符串 ── 老版意外匹配的 corner。
        assert!(!is_claude_session_id(""));
        assert!(!is_claude_session_id("   "));
    }

    #[test]
    fn maps_assistant_message_to_chat_message() {
        let value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-06-29T01:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "hello" }]
            }
        });
        let messages = value_to_chat_messages("session_1", 0, &value);
        let message = messages.first().expect("message");
        assert_eq!(message.role, "assistant");
        assert_eq!(message.content, "hello");
    }

    #[test]
    fn maps_tool_blocks_to_tool_messages() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-06-29T01:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let messages = value_to_chat_messages("session_1", 0, &assistant);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(messages[0].tool_name.as_deref(), Some("Read"));
        assert_eq!(
            messages[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("file_path")),
            Some(&serde_json::json!("README.md"))
        );

        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents"
                }]
            }
        });
        let messages = value_to_chat_messages("session_1", 1, &user);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(messages[0].tool_name.as_deref(), Some("tool_result"));
        assert!(messages[0].content.contains("file contents"));
        assert_eq!(messages[0].is_loading, Some(false));
    }

    #[test]
    fn merges_tool_result_into_existing_tool_message() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-06-29T01:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents",
                    "is_error": true
                }]
            }
        });

        let mut messages = Vec::new();
        for message in value_to_chat_messages("session_1", 0, &assistant) {
            append_claude_history_message(&mut messages, message);
        }
        for message in value_to_chat_messages("session_1", 1, &user) {
            append_claude_history_message(&mut messages, message);
        }

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(messages[0].tool_name.as_deref(), Some("Read"));
        assert!(messages[0].content.contains("file contents"));
        assert!(messages[0].content.contains("is_error"));
        assert_eq!(messages[0].is_loading, Some(false));
    }

    // `skips_user_text_only_skill_injection_messages` 和
    // `skips_user_text_when_mixed_only_with_tool_result` 这两个测试是
    // **有意永久删除**的——它们断言的块级 `should_skip_user_text_blocks`
    // 启发式不再存在于 history.rs。守卫保留与否不影响实际 dev 行为(已实测),
    // 保留守卫时这两条是回归护栏,删除守卫后它们会反过来 fail,所以一并删除。
    // 若未来重新引入守卫(见 `value_to_chat_messages` 内的设计说明),
    // 把这两条测试从 git history 拉回来即可。

    #[test]
    fn skips_meta_user_messages_in_session_history() {
        let user = serde_json::json!({
            "parentUuid": "c4ed80bd-9300-46a7-a454-2849594d41e6",
            "type": "user",
            "message": {
                "role": "user",
                "content": "[Your previous response had no visible output. Please continue.]"
            },
            "isMeta": true,
            "uuid": "7257a401-a054-4807-9f88-27a0ad4b58f7",
            "timestamp": "2026-07-18T14:42:15.285Z"
        });

        let messages = value_to_chat_messages("session_1", 1, &user);
        assert!(messages.is_empty());
    }

    #[test]
    fn shows_sidechain_assistant_messages_in_session_history() {
        // 反向 — isSidechain=true assistant 文本应在历史 thread card 展示。
        let value = serde_json::json!({
            "type": "assistant",
            "isSidechain": true,
            "timestamp": "2026-07-18T15:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "sub-agent reply" }]
            }
        });
        let messages = value_to_chat_messages("session_1", 2, &value);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].content, "sub-agent reply");
    }

    fn shows_sidechain_user_tool_results_in_session_history() {
        // 反向 — isSidechain=true sub-agent tool_result 应在历史 thread card 展示。
        let value = serde_json::json!({
            "type": "user",
            "isSidechain": true,
            "timestamp": "2026-07-18T15:00:01Z",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "sub-agent tool output"
                }]
            }
        });
        let messages = value_to_chat_messages("session_1", 3, &value);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_name.as_deref(), Some("tool_result"));
        assert!(messages[0].content.contains("sub-agent tool output"));
    }

    fn shows_agent_tool_use_in_assistant_history() {
        // 反向 — main agent 的 Task 工具(name="Agent")tool_use 应在历史 thread card 展示。
        let assistant = serde_json::json!({
            "type": "assistant",
            "isSidechain": false,
            "timestamp": "2026-07-18T15:36:31.240Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "call_e6e37468672748648ccf4b3e",
                    "name": "Agent",
                    "input": { "description": "Read README.md", "subagent_type": "Explore" }
                }]
            }
        });
        let messages = value_to_chat_messages("session_1", 0, &assistant);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_name.as_deref(), Some("Agent"));
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("call_e6e37468672748648ccf4b3e"));
    }

    #[test]
    fn keeps_user_array_text_when_other_block_types_are_present() {
        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "real user text"
                    },
                    {
                        "type": "image",
                        "source": { "type": "base64", "media_type": "image/png", "data": "abc" }
                    }
                ]
            }
        });

        let messages = value_to_chat_messages("session_1", 1, &user);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "real user text");
    }

    #[test]
    fn close_orphan_claude_tool_calls_closes_only_unmatched_uses() {
        // tool_use(call_id=X) merged with its tool_result at the helper layer.
        // tool_use(call_id=Y) without a result — orphan.
        let mut messages = vec![
            tool_use_msg("X", "Read", false),
            tool_use_msg("Y", "Bash", true),
            tool_result_msg("X", "ok"),
        ];

        close_orphan_claude_tool_calls(&mut messages);

        let by_call: std::collections::HashMap<&str, &ChatMessage> = messages
            .iter()
            .filter_map(|m| m.tool_call_id.as_deref().map(|id| (id, m)))
            .collect();
        // X already had its is_loading set to false by the helper merge.
        assert_eq!(by_call["X"].is_loading, Some(false));
        // Y had no output → forced to false by the orphan sweeper.
        assert_eq!(by_call["Y"].is_loading, Some(false));
    }

    #[test]
    fn close_orphan_claude_tool_calls_leaves_user_messages_alone() {
        let mut messages = vec![base_message(
            "u".to_string(),
            "user",
            "hi".to_string(),
            "2026-06-29T01:00:00Z".to_string(),
        )];
        close_orphan_claude_tool_calls(&mut messages);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].is_loading, None);
    }

    fn tool_use_msg(call_id: &str, name: &str, loading: bool) -> ChatMessage {
        let mut m = base_message(
            format!("claude-tool-{call_id}"),
            "tool",
            String::new(),
            "2026-06-29T01:00:00Z".to_string(),
        );
        m.tool_call_id = Some(call_id.to_string());
        m.tool_name = Some(name.to_string());
        m.is_loading = Some(loading);
        m.tool_input = Some(serde_json::json!({}));
        m
    }

    fn tool_result_msg(call_id: &str, output: &str) -> ChatMessage {
        let mut m = base_message(
            format!("claude-tool-result-{call_id}"),
            "tool",
            output.to_string(),
            "2026-06-29T01:00:01Z".to_string(),
        );
        m.tool_call_id = Some(call_id.to_string());
        m.tool_name = Some("tool_result".to_string());
        m.tool_data = Some(output.to_string());
        m.is_loading = Some(false);
        m
    }

    /// 写一个临时 `~/.claude/projects/<encoded>/<sid>.jsonl`, 验证
    /// `claude_session_cwd` 能从 `cwd` 字段读回原始 cwd。 这是
    /// "重启产品后 IPC 入参 cwd 为空, 后端兜底到 session 元数据"
    /// 修复路径的回归测试。
    #[test]
    fn claude_session_cwd_reads_cwd_field() {
        let tmp_root = tempdir_via_env();
        let encoded = encode_claude_project_dir(&tmp_root);
        let project_dir = tmp_root.join(".claude").join("projects").join(&encoded);
        std::fs::create_dir_all(&project_dir).expect("create project dir");
        let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e3";
        let path = project_dir.join(format!("{sid}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"type\":\"user\",\"cwd\":\"{tmp}\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}},\"sessionId\":\"{sid}\",\"uuid\":\"u1\"}}\n",
                tmp = tmp_root.display(),
                sid = sid,
            ),
        )
        .expect("write session jsonl");

        let cwd = with_claude_config_dir(tmp_root.join(".claude"), || {
            claude_session_cwd(sid).expect("read cwd")
        });
        let resolved = cwd.expect("cwd should be present");
        assert_eq!(resolved, tmp_root);
    }

    /// 没有任何 cwd 字段时, 返回 None ── 而不是空字符串或兜底进程 cwd。
    #[test]
    fn claude_session_cwd_returns_none_when_missing() {
        let tmp_root = tempdir_via_env();
        let encoded = encode_claude_project_dir(&tmp_root);
        let project_dir = tmp_root.join(".claude").join("projects").join(&encoded);
        std::fs::create_dir_all(&project_dir).expect("create project dir");
        let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e4";
        let path = project_dir.join(format!("{sid}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}},\"sessionId\":\"{sid}\",\"uuid\":\"u2\"}}\n"
            ),
        )
        .expect("write session jsonl");

        let cwd = with_claude_config_dir(tmp_root.join(".claude"), || {
            claude_session_cwd(sid).expect("read cwd")
        });
        assert!(cwd.is_none());
    }

    fn tempdir_via_env() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "claude-history-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        dir
    }

    /// Claude Code CLI 的项目目录编码方式:
    ///   /Users/rop/notes  →  -Users-rop-notes
    /// 把所有非 ASCII 替换成 `-`, 但单元测试 fixture 用纯 ASCII 路径,
    /// 实际反推不复杂 ── 不需要完整复刻, 只取 path segment 拼成 dash-joined.
    fn encode_claude_project_dir(path: &Path) -> String {
        let binding = path.to_string_lossy();
        let stripped = binding.trim_start_matches('/');
        let mut s = String::from("-");
        for (i, seg) in stripped.split('/').enumerate() {
            if i > 0 {
                s.push('-');
            }
            s.push_str(seg);
        }
        s
    }

    fn with_claude_config_dir<T>(root: PathBuf, f: impl FnOnce() -> T) -> T {
        // Save & restore CLAUDE_CONFIG_DIR 避免污染其它并发 test.
        let prev = std::env::var_os("CLAUDE_CONFIG_DIR");
        std::env::set_var("CLAUDE_CONFIG_DIR", &root);
        let result = f();
        match prev {
            Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
            None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
        }
        result
    }
}
