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

/// [history path] 鍒楀嚭 `~/.claude/projects/.../*.jsonl` 閲岀殑鎵€鏈?session
/// 鎽樿銆傝鍓嶇 IPC `list_agent_conversation_instances` 绛夎皟鐢?鏁版嵁婧?/// 鏄寔涔呭寲 JSONL 鈹€鈹€ 涓?stream path 瀹屽叏鐙珛銆?
pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_claude_sessions)
        .await
        .map_err(|e| e.to_string())?
}

/// [history path] 璇?`~/.claude/projects/.../<sid>.jsonl` 鍏ㄩ噺,杞垚
/// `Vec<ChatMessage>` 鎺ㄥ埌 thread card銆傝鍓嶇 IPC `get_session` 璋冪敤銆?/// 鍚屼細璇濈殑 stream path 璧?`events.rs::parse_claude_stdout_line`,
/// 鏁版嵁婧愭槸 Claude Code 瀛愯繘绋嬬殑 stdout 鈹€鈹€ 涓ゆ潯 path 澶勭悊鐨勬槸鍚屼竴浠?/// 瀵硅瘽鐨勪笉鍚岃鍥?streaming 鏄疄鏃跺垏鐗? history 鏄帇缂╁悗鐨勫叏閲?銆?
pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || read_claude_session_messages(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

pub fn is_claude_session_id(text: &str) -> bool {
    // 蹇呴』鏄惧紡鎷掔粷 "claude-local-agent-inst-<ts>-<seq>" 绛夊墠绔?thread id
    // 鍗犱綅绗?鈹€鈹€ 杩欎簺瀛楃涓查暱搴?鈮?32 涓斿寘鍚?5 涓?dash, 鑰佺増瀹芥澗鍒ゆ柇浼氭妸
    // 瀹冧滑褰撴垚 session id 閫忎紶缁?Claude CLI 鐨?--resume, 浣?CLI 鏄?UUID
    // 涓ユ牸鏍￠獙: "Provided value ... is not a UUID and does not match any
    // session title"銆?
    let value = text.trim();
    if value.is_empty() || value.starts_with("claude-local-") {
        return false;
    }
    // Claude Code 鐪?session id 鏄?UUID 鈹€鈹€ 36 瀛楃, 4 涓?dash, 鍏朵綑鍏ㄦ槸
    // ASCII 鍗佸叚杩涘埗浣嶃€?鍚屾椂涔熷吋瀹?Claude 鍚庣画鍙兘鐨勯潪 UUID 鏍煎紡
    // (渚嬪鏈潵浠栦滑鎹?ULID/base32), 閫氳繃闀垮害 + dash 璁℃暟瀹芥斁, 浠嶆槸鍚堟硶
    // 鐨?闀垮緱鍍?id 瀛楃涓?銆?
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

/// [history path] 璇绘寔涔呭寲 JSONL 鍏ㄩ噺,閫愯杞?`ChatMessage`銆傛瘡琛岀粡
/// `value_to_chat_messages` 杩囨护(isMeta / isSidechain / isSynthetic /
/// subagent_type / task-notification 瀹堝崼),鍐嶇粡 `append_claude_history_message`
/// 鍚堝苟鍚?tool_call_id 鐨?tool_use + tool_result銆?
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

/// [history path] 淇"session 涓€旇 kill 鐣欎笅鐨勫鍎?tool_use"銆?/// stream path 娌℃湁绛変环闇€姹?鈹€鈹€ 娴佸紡涓?tool_result 绱ц窡 tool_use 鍒拌揪,
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

/// [history path] 鎶?`value_to_chat_messages` 浜х敓鐨?`ChatMessage` 杩藉姞
/// 鍒版秷鎭垪琛?鐗规畩澶勭悊 tool_result 鈹€鈹€ 鑻ュ凡鏈夊悓 tool_call_id 鐨?/// tool_call_message(璇存槑 tool_use 宸插厛鍒?,鍒欏師鍦板悎骞惰€岄潪杩藉姞,
/// 閬垮厤 thread card 涓婂悓鏃舵樉绀?璋冪敤涓?鍜?宸茶繑鍥?涓ゆ潯 tool 姘旀场銆?
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

/// [history path] 璇?JSONL 鍏ㄩ噺,鎻愬彇 session 绾у厓鏁版嵁 鈹€鈹€ id / title /
/// created_at / updated_at銆倀itle 浠庨涓?type=user 琛?+ 闈炲悎鎴愭秷鎭?/// (`!should_silence_event`) + 鍚彲璇?text 鐨勮鎻愬彇 鈹€鈹€ 閬垮厤鎶?/// Skill body / task-notification XML 璇綋鎴?session 鏍囬銆?
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

/// [history path] 浠?Claude Code CLI 鐨?session jsonl 閲岃鍑哄師濮?cwd 鈹€鈹€
/// session 鍏冩暟鎹涓€琛岄€氬父甯?`cwd` 瀛楁 (`{"type":..., "cwd":"/abs/path", ...}`).
///
/// 鐢ㄩ€? 鍚庣 `claude_cli.rs::run_claude` 鐨?cwd 鍏滃簳閾?鈹€鈹€ 褰?IPC 鍏ュ弬
/// 鐨?`message.cwd_for_runtime` 鎷夸笉鍒板€兼椂 (鍓嶇鍏ㄥ眬 store 鍚姩 race
/// 鍦烘櫙), 鐢?session 鏂囦欢鑷韩鐨?cwd 浣滀负鏈€鍙潬鐨勭湡婧愩€?瑙?agent_conversation
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
        // metadata 浜嬩欢 (鏂扮増鏈?Claude Code CLI 鎶?cwd 鏀惧湪 metadata.cwd)
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

/// [history path] 鎸佷箙鍖?JSONL 鍗曡 鈫?`Vec<ChatMessage>` 鈹€鈹€ 琚?/// `read_claude_session_messages` 璋冪敤銆侲ntry guard 鐢?`silence_reason`
/// 鎷︽埅鍚堟垚娑堟伅(璇﹁ `silence_reason` 鐨?doc);閫氳繃鍚庢寜 role 鍒嗗彂:
/// text / tool_use / tool_result 鍧楀悇鑷浆 `ChatMessage`銆?
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
                        // 鍗犱綅 tool_result 鍦ㄦ寔涔呭寲 JSONL 閲?isSidechain=false /
                        // 鏃?subagent_type,浜嬩欢绾?silence_reason 鎶撲笉鍒?鍙兘
                        // 闈?content 鍓嶇紑鍒ゅ畾銆俢ontent 鏈?string 鍜?array 涓ょ
                        // 褰㈡€?閮藉緱鏌ャ€?
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

/// [history path] 鎶婁换鎰忓舰鐘?content (string / array) 鎽婂钩鎴愮函鏂囨湰 鈹€鈹€
/// `value_to_chat_messages` 鐨?string-content 鍏滃簳鍒嗘敮 + `read_claude_session_meta`
/// 鐨?title 鎻愬彇鍏辩敤銆?
fn message_content_to_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let content = message_content(value)?;
    content_blocks_to_text(content)
}

/// [history path] 鍦ㄤ袱绉?content envelope 涔嬮棿浜岄€変竴:
/// `message.content`(宓屽鏍煎紡,Claude Code v2) 鎴栭《灞?`content`(legacy 鏍煎紡)銆?
fn message_content(value: &Value) -> Option<&Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"))
}

/// [history path] 鎶?array content 鎽婂钩鎴愬瓧绗︿覆 鈹€鈹€ 閬嶅巻姣忎釜 block,鍙?`text`
/// 鎴?`content` 瀛楁鎷兼帴;绌虹粨鏋滆繑鍥?None(閬垮厤鎺ㄧ┖ user 姘旀场)銆?
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

/// [history path] 鏋勯€?user / tool 閫氱敤 ChatMessage 缁撴瀯銆傛墍鏈?field 榛樿
/// None,璋冪敤鏂规寜闇€濉厖 tool_call_id / tool_name / tool_input / tool_data 绛夈€?
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

/// [history path] 鏋勯€?type=assistant 鐨?tool_use ChatMessage 鈹€鈹€ id /
/// name / tool_input 浠?JSONL block 瀛楁璇诲嚭,绛?tool_result 鍒版潵鍚庣敱
/// `append_claude_history_message` 鍚堝苟銆?
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

/// [history path] 鏋勯€?type=user 鐨?tool_result ChatMessage 鈹€鈹€ 瑙ｆ瀽
/// block.content 涓?envelope JSON 瀛楃涓?瀛樺叆 `tool_data` 渚涘墠绔睍绀恒€?
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

/// [history path] 鎶?tool_result block.content 搴忓垪鍖栨垚 envelope JSON
/// 瀛楃涓?鈹€鈹€ 涓?`events.rs::claude_tool_result_value`(events path)琛屼负涓€鑷?
/// 鍙槸杈撳嚭鏍煎紡鐢?pretty JSON 瀛樺埌 `tool_data` 渚涘墠绔睍绀恒€?
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

/// [both paths] tool_result envelope 鍏叡閫昏緫 鈹€鈹€ history.rs 璧?/// `claude_tool_result_content`,events.rs 璧?`claude_tool_result_value`,
/// 涓よ€呮渶缁堥兘璋冭繖閲岀粰 envelope 鍔?`is_error` 瀛楁銆?
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

/// [history path] 鍒楀嚭 `~/.claude/projects/.../*.jsonl` 鏂囦欢 鈹€鈹€ 琚?/// `find_claude_session_file` 璋冪敤銆?
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

/// [history path] 鎸?session_id 鎵?JSONL 鏂囦欢 鈹€鈹€ 鍏堟寜鏂囦欢鍚嶅尮閰?
/// 鎵句笉鍒板啀閫€鍖栦负鎸?metadata.id 鍖归厤(澶勭悊 sub-agent 鏂囦欢鍚嶄笉鍚富 session id
/// 鐨勬儏鍐?銆?
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

/// [history path] 閫掑綊鎵?session id 鈹€鈹€ 椤跺眰 / message envelope / parentUuid銆?/// 琚?`read_claude_session_meta` 鐢ㄤ綔 id fallback銆?
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

/// [history path] 浠庢枃浠惰矾寰勯噷鎶?session id 鈹€鈹€ `~/.claude/projects/.../<sid>.jsonl`
/// 鐨勬枃浠跺悕灏辨槸 sid(鍘绘帀 .jsonl 鍚庣紑)銆?
fn session_id_from_filename(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_string)
}

/// [history path] 浼樺厛鐢?JSONL `timestamp` 瀛楁;缂哄け鍒欑敤褰撳墠鏃堕棿浣滀负 fallback銆?
fn extract_timestamp(value: &Value) -> String {
    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
        timestamp.to_string()
    } else {
        chrono::Utc::now().to_rfc3339()
    }
}

/// [history path] 鍚?`extract_timestamp`,浣嗚繑鍥?i64 姣 鈹€鈹€ 鐢ㄤ簬 session
/// metadata 鐨?created_at / updated_at 璁＄畻銆?
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
/// 瓒呴暱鍔?`...`銆傝 `read_claude_session_meta` 鐢ㄣ€?
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
        // 鍥炲綊 鈹€鈹€ 杩欐潯瀛楃涓查暱搴?鈮?32 涓斿惈 5 涓?dash, 鑰佺増瀹芥澗瑙勫垯浼氳鍒や负
        // "鏄湡鐨?session id", 鎶?`claude-local-agent-inst-...` 褰撶湡瀹?UUID
        // 閫忎紶缁?Claude CLI 鐨?--resume銆?CLI 鏄?UUID 涓ユ牸鏍￠獙, 鎶ラ敊:
        // "Provided value ... is not a UUID and does not match any session
        // title"銆?淇鍚庡繀椤讳互 `claude-local-` 鍓嶇紑鐩存帴鎷掓帀銆?
        assert!(!is_claude_session_id(
            "claude-local-agent-inst-1783828675847-3"
        ));
        assert!(!is_claude_session_id(
            "claude-local-agent-inst-1783828675847-100"
        ));
        // 绌虹櫧 + 鐭瓧绗︿覆 鈹€鈹€ 鑰佺増鎰忓鍖归厤鐨?corner銆?
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

    // `skips_user_text_only_skill_injection_messages` 鍜?    // `skips_user_text_when_mixed_only_with_tool_result` 杩欎袱涓祴璇曟槸
    // **鏈夋剰姘镐箙鍒犻櫎**鐨勨€斺€斿畠浠柇瑷€鐨勫潡绾?`should_skip_user_text_blocks`
    // 鍚彂寮忎笉鍐嶅瓨鍦ㄤ簬 history.rs銆傚畧鍗繚鐣欎笌鍚︿笉褰卞搷瀹為檯 dev 琛屼负(宸插疄娴?,
    // 淇濈暀瀹堝崼鏃惰繖涓ゆ潯鏄洖褰掓姢鏍?鍒犻櫎瀹堝崼鍚庡畠浠細鍙嶈繃鏉?fail,鎵€浠ヤ竴骞跺垹闄ゃ€?    // 鑻ユ湭鏉ラ噸鏂板紩鍏ュ畧鍗?瑙?`value_to_chat_messages` 鍐呯殑璁捐璇存槑),
    // 鎶婅繖涓ゆ潯娴嬭瘯浠?git history 鎷夊洖鏉ュ嵆鍙€?
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
        // 鍙嶅悜 鈥?isSidechain=true assistant 鏂囨湰搴斿湪鍘嗗彶 thread card 灞曠ず銆?
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

    #[test]
    fn shows_sidechain_user_tool_results_in_session_history() {
        // 鍙嶅悜 鈥?isSidechain=true sub-agent tool_result 搴斿湪鍘嗗彶 thread card 灞曠ず銆?
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

    #[test]
    fn shows_agent_tool_use_in_assistant_history() {
        // 鍙嶅悜 鈥?main agent 鐨?Task 宸ュ叿(name="Agent")tool_use 搴斿湪鍘嗗彶 thread card 灞曠ず銆?
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
        assert_eq!(
            messages[0].tool_call_id.as_deref(),
            Some("call_e6e37468672748648ccf4b3e")
        );
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
        // tool_use(call_id=Y) without a result 鈥?orphan.
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
        // Y had no output 鈫?forced to false by the orphan sweeper.
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

    /// 鍐欎竴涓复鏃?`~/.claude/projects/<encoded>/<sid>.jsonl`, 楠岃瘉
    /// `claude_session_cwd` 鑳戒粠 `cwd` 瀛楁璇诲洖鍘熷 cwd銆?杩欐槸
    /// "閲嶅惎浜у搧鍚?IPC 鍏ュ弬 cwd 涓虹┖, 鍚庣鍏滃簳鍒?session 鍏冩暟鎹?
    /// 淇璺緞鐨勫洖褰掓祴璇曘€?
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

    /// 娌℃湁浠讳綍 cwd 瀛楁鏃? 杩斿洖 None 鈹€鈹€ 鑰屼笉鏄┖瀛楃涓叉垨鍏滃簳杩涚▼ cwd銆?
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

    /// Claude Code CLI 鐨勯」鐩洰褰曠紪鐮佹柟寮?
    ///   /Users/rop/notes  鈫? -Users-rop-notes
    /// 鎶婃墍鏈夐潪 ASCII 鏇挎崲鎴?`-`, 浣嗗崟鍏冩祴璇?fixture 鐢ㄧ函 ASCII 璺緞,
    /// 瀹為檯鍙嶆帹涓嶅鏉?鈹€鈹€ 涓嶉渶瑕佸畬鏁村鍒? 鍙彇 path segment 鎷兼垚 dash-joined.
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
        // Save & restore CLAUDE_CONFIG_DIR 閬垮厤姹℃煋鍏跺畠骞跺彂 test.
        // 鎸?TEST_ENV_LOCK 璁?set/restore 涓庡叾瀹冩敼 env 鐨勬祴璇曚簰鏂?鈹€鈹€ 鍚﹀垯
        // save-restore 绐楀彛鏈?find_claude_session_file 鍙兘璇诲埌琚苟鍙戞祴璇?        // 鏀瑰啓鐨?CLAUDE_CONFIG_DIR, 瀵艰嚧 session 鏂囦欢鎵句笉鍒?(flaky)銆?
        let _guard = crate::agent_external::acquire_test_env_lock();
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
