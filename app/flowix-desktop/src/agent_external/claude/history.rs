use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::agent_session::{ChatMessage, ThreadInfo, ThreadMessagesPage};
use crate::agent_types::AgentId;

use super::{
    events::{should_silence_event, silence_reason},
    AGENT_TYPE,
};

/// [history path] 列出 `~/.claude/projects/.../*.jsonl` 里的所�?session
/// 摘�?。�?前�? IPC `list_agent_conversation_instances` 等调�?数据�?/// �?��久化 JSONL ── �?stream path 完全�?���?
#[allow(dead_code)]
pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_claude_sessions)
        .await
        .map_err(|e| e.to_string())?
}

/// [history path] �?`~/.claude/projects/.../<sid>.jsonl` 全量,�?��
/// `Vec<ChatMessage>` 推到 thread card。�?前�? IPC `get_session` 调用�?/// 同会话的 stream path �?`events.rs::parse_claude_stdout_line`,
/// 数据源是 Claude Code 子进程的 stdout ── 两条 path 处理的是同一�?/// 对话的不同�?�?streaming �?��时切�? history �?��缩后的全�?�?
pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut messages = read_claude_session_messages(&session_id)?;
        crate::agent_external::canonicalize_imported_messages(
            AGENT_TYPE,
            &session_id,
            &mut messages,
        );
        Ok(messages)
    })
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
        let mut messages = read_claude_session_messages(&session_id)?;
        crate::agent_external::canonicalize_imported_messages(
            AGENT_TYPE,
            &session_id,
            &mut messages,
        );
        Ok(paginate_claude_messages(messages, before_sequence, limit))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn paginate_claude_messages(
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
    ThreadMessagesPage {
        messages: if start < end {
            messages[start..end].to_vec()
        } else {
            Vec::new()
        },
        oldest_sequence: (start < end).then_some((start + 1) as i64),
        has_more: start > 0,
        snapshot_sequence: None,
        complete_turn_ids: None,
    }
}

pub fn is_claude_session_id(text: &str) -> bool {
    // 必须显式拒绝 "claude-local-agent-inst-<ts>-<seq>" 等前�?thread id
    // 占位�?── 这些字�?串长�?�?32 且包�?5 �?dash, 老版宽松判断会把
    // 它们当成 session id 透传�?Claude CLI �?--resume, �?CLI �?UUID
    // 涓ユ牸鏍￠獙: "Provided value ... is not a UUID and does not match any
    // session title"銆?
    let value = text.trim();
    if value.is_empty() || value.starts_with("claude-local-") {
        return false;
    }
    // Claude Code �?session id �?UUID ── 36 字�?, 4 �?dash, 其余全是
    // ASCII 十六进制位�?同时也兼�?Claude 后续�?��的非 UUID 格式
    // (例�?�?��他们�?ULID/base32), 通过长度 + dash 计数宽放, 仍是合法
    // �?长得�?id 字�?�?�?
    let dash_count = value.chars().filter(|c| *c == '-').count();
    value.len() >= 32 && dash_count == 4
}

#[allow(dead_code)]
#[derive(Default)]
struct ClaudeSessionDraft {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

#[allow(dead_code)]
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

/// [history path] 读持久化 JSONL 全量,逐�?�?`ChatMessage`。每行经
/// `value_to_chat_messages` 杩囨护(isMeta / isSidechain / isSynthetic /
/// subagent_type / task-notification 瀹堝崼),鍐嶇粡 `append_claude_history_message`
/// 合并�?tool_call_id �?tool_use + tool_result�?
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

/// [history path] �??"session �?���? kill 留下的�?�?tool_use"�?/// stream path 没有等价需�?── 流式�?tool_result 紧跟 tool_use 到达,
/// 涓嶄細鐣欏鍎裤€?
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

/// [history path] �?`value_to_chat_messages` 产生�?`ChatMessage` 追加
/// 到消�?���?特殊处理 tool_result ── 若已有同 tool_call_id �?/// tool_call_message(说明 tool_use 已先�?,则原地合并而非追加,
/// 避免 thread card 上同时显�?调用�?�?已返�?两条 tool 气泡�?
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

#[allow(dead_code)]
struct SessionMeta {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

/// [history path] �?JSONL 全量,提取 session 级元数据 ── id / title /
/// created_at / updated_at。title 从�?�?type=user �?+ 非合成消�?/// (`!should_silence_event`) + �?���?text 的�?提取 ── 避免�?/// Skill body / task-notification XML �?���?session 标�?�?
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

/// [history path] �?Claude Code CLI �?session jsonl 里�?出原�?cwd ──
/// session 元数�??一行通常�?`cwd` 字�? (`{"type":..., "cwd":"/abs/path", ...}`).
///
/// 用�? 后�? `claude_cli.rs::run_claude` �?cwd 兜底�?── �?IPC 入参
/// �?`message.cwd_for_runtime` 拿不到值时 (前�?全局 store �?�� race
/// 场景), �?session 文件�?���?cwd 作为最�?��的真源�?�?agent_conversation
/// 鍦ㄥ墠绔妸 runtime_config 鍐欏叆 instance 鐨勫搴斾慨澶嶃€?
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
        // metadata 事件 (新版�?Claude Code CLI �?cwd 放在 metadata.cwd)
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
        // envelope 妯″紡: message.cwd (legacy)
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

/// [history path] 持久�?JSONL 单�? �?`Vec<ChatMessage>` ── �?/// `read_claude_session_messages` 调用。Entry guard �?`silence_reason`
/// 拦截合成消息(详�? `silence_reason` �?doc);通过后按 role 分发:
/// text / tool_use / tool_result 块各�?�� `ChatMessage`�?
fn value_to_chat_messages(session_id: &str, idx: usize, value: &Value) -> Vec<ChatMessage> {
    if let Some(reason) = silence_reason(value) {
        tracing::debug!(
            "[ClaudeHistory] silenced event session_id={session_id} idx={idx} reason={reason} \
             event_type={} is_meta={} is_sidechain={} origin_kind={}",
            value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            value
                .get("isMeta")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            value
                .get("isSidechain")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            value
                .get("origin")
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
                        // 涓?events.rs type=user 鐨?"Async agent launched
                        // successfully" 鍓嶇紑瀹堝崼瀵归綈 鈹€鈹€ Agent launch metadata
                        // 占位 tool_result 在持久化 JSONL �?isSidechain=false /
                        // �?subagent_type,事件�?silence_reason 抓不�?�?��
                        // �?content 前缀判定。content �?string �?array 两�?
                        // 形�?都得查�?
                        let content_text = match part.get("content") {
                            Some(Value::String(s)) => Some(s.as_str()),
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .filter_map(|p| p.get("text").and_then(Value::as_str))
                                .next(),
                            _ => None,
                        };
                        let is_agent_launch_metadata = content_text
                            .is_some_and(|s| s.starts_with("Async agent launched successfully"));
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

/// [history path] 把任意形�?content (string / array) 摊平成纯文本 ──
/// `value_to_chat_messages` �?string-content 兜底分支 + `read_claude_session_meta`
/// �?title 提取共用�?
fn message_content_to_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let content = message_content(value)?;
    content_blocks_to_text(content)
}

/// [history path] 在两�?content envelope 之间二选一:
/// `message.content`(嵌�?格式,Claude Code v2) 或顶�?`content`(legacy 格式)�?
fn message_content(value: &Value) -> Option<&Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"))
}

/// [history path] �?array content 摊平成字符串 ── 遍历每个 block,�?`text`
/// �?`content` 字�?拼接;空结果返�?None(避免推空 user 气泡)�?
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

/// [history path] 构�?user / tool 通用 ChatMessage 结构。所�?field 默�?
/// None,璋冪敤鏂规寜闇€濉厖 tool_call_id / tool_name / tool_input / tool_data 绛夈€?
fn base_message(id: String, role: &str, content: String, timestamp: String) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        message_type: None,
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp,
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_call: None,
        tool_result: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        error_details: None,
        is_collapsed: None,
        codex_turn_id: None,
        turn_duration_ms: None,
        source_sequence: None,
        attachments: None,
    }
}

/// [history path] 构�?type=assistant �?tool_use ChatMessage ── id /
/// name / tool_input �?JSONL block 字�?读出,�?tool_result 到来后由
/// `append_claude_history_message` 合并�?
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

/// [history path] 构�?type=user �?tool_result ChatMessage ── 解析
/// block.content �?envelope JSON 字�?�?存入 `tool_data` 供前�?��示�?
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

/// [history path] �?tool_result block.content 序列化成 envelope JSON
/// 字�?�?── �?`events.rs::claude_tool_result_value`(events path)行为一�?
/// �?��输出格式�?pretty JSON 存到 `tool_data` 供前�?��示�?
fn claude_tool_result_content(part: &Value) -> Value {
    let Some(content) = part.get("content") else {
        return super::claude_tool_result_envelope(part.clone(), part);
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
    super::claude_tool_result_envelope(content, part)
}

/// [history path] 列出 `~/.claude/projects/.../*.jsonl` 文件 ── �?/// `find_claude_session_file` 调用�?
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

/// [history path] �?session_id �?JSONL 文件 ── 先按文件名匹�?
/// 找不到再退化为�?metadata.id 匹配(处理 sub-agent 文件名不�?�� session id
/// 的情�?�?
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

/// [history path] 递归�?session id ── 顶层 / message envelope / parentUuid�?/// �?`read_claude_session_meta` 用作 id fallback�?
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

/// [history path] 从文件路径里�?session id ── `~/.claude/projects/.../<sid>.jsonl`
/// 的文件名就是 sid(去掉 .jsonl 后缀)�?
fn session_id_from_filename(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_string)
}

/// [history path] 优先�?JSONL `timestamp` 字�?;缺失则用当前时间作为 fallback�?
fn extract_timestamp(value: &Value) -> String {
    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
        timestamp.to_string()
    } else {
        chrono::Utc::now().to_rfc3339()
    }
}

/// [history path] �?`extract_timestamp`,但返�?i64 �?? ── 用于 session
/// metadata �?created_at / updated_at 计算�?
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

/// [history path] session 鏍囬瑁佸壀 鈹€鈹€ 鏀舵嫝绌虹櫧瀛楃鍒板崟绌烘牸,鎴墠 40 瀛楃,
/// 超长�?`...`。�? `read_claude_session_meta` 用�?
fn truncate_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= 40 {
        trimmed
    } else {
        format!("{}...", trimmed.chars().take(40).collect::<String>())
    }
}

#[cfg(test)]
mod tests;
