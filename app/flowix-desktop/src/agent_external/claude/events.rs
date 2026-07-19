use serde_json::Value;

use crate::agent_flowix::AgentChunk;

pub(crate) struct ParsedClaudeStdoutLine {
    pub value: Option<Value>,
    pub session_id: Option<String>,
    pub chunks: Vec<AgentChunk>,
}

/// [stream path] 把 Claude Code 子进程 stdout 的一行 JSONL 解析成
/// `ParsedClaudeStdoutLine`。非 JSON 行作为 raw 文本 Text chunk 透传,
/// JSON 行转 AgentChunk 列表。被 `stream.rs::read_claude_stdout` 调用于
/// 流式回显。同会话的 history path 走 `history.rs::value_to_chat_messages`,
/// 数据源是 `~/.claude/projects/.../sid.jsonl` ── 两条路径处理的是同一份
/// 对话的不同视图(streaming 是实时切片, history 是压缩后的全量)。
pub(crate) fn parse_claude_stdout_line(thread_id: &str, line: &str) -> ParsedClaudeStdoutLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedClaudeStdoutLine {
            value: None,
            session_id: None,
            chunks: vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: format!("{line}\n"),
            }],
        };
    };

    let session_id = extract_session_id(&value);
    let chunks = claude_event_to_chunks(thread_id, &value);

    ParsedClaudeStdoutLine {
        value: Some(value),
        session_id,
        chunks,
    }
}

/// [history path primarily] Claude Code v2 把 Task 子 agent 完成的通知
/// 包成 `type=user` 消息喂给主 agent,内容是整段
/// `<task-notification>...</task-notification>` XML —— 这一形态只在
/// 持久化 JSONL 里出现(由 CLI 在压缩 / 上下文恢复阶段写入)。
/// 流式 stdout 里 sub-agent 完成通知改走 `type=result, origin.kind=
/// "task-notification"`(无 type=user 形态),所以本 helper 在 stream path
/// 上实际上是 no-op。
///
/// `origin.kind == "task-notification"` 是最可靠的 schema 级信号;
/// 旧版本或非标格式可能没有 origin 字段但 content 直接是 `<task-notification>`
/// 字符串——一并兜底。
fn is_synthetic_user_event(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if value.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str)
        == Some("task-notification")
    {
        return true;
    }
    if let Some(content) = value.get("message").and_then(|m| m.get("content")) {
        if let Some(text) = content.as_str() {
            return text.trim_start().starts_with("<task-notification>");
        }
    }
    false
}

/// [history path primarily] Sub-agent 分支链路 (`isSidechain=true`) 的
/// JSONL 行不属于主对话:它们是 Task 工具 spawn 的 Explore / Bash / Plan
/// agent 在自己的 thread 里产生的 user / assistant / tool_use / tool_result,
/// 主 thread card 不应展示。流式 stdout 不携带 isSidechain 字段(改用
/// `subagent_type`,见 `is_subagent_event`),所以本 helper 在 stream path
/// 上也是 no-op。
///
/// 仅匹配 `isSidechain: true`;缺失或 `false` 不影响(主链路)。
fn is_sidechain_event(value: &Value) -> bool {
    value.get("isSidechain").and_then(Value::as_bool) == Some(true)
}

/// [stream path primarily] 流式 stdout 的 sub-agent 分支信号 ──
/// `subagent_type` 是顶层字段,例如 `"Explore"` / `"general-purpose"`。
/// 这是 Task 工具 spawn 的子 agent 产生的活动(tool_use / tool_result /
/// text)被 echo 进主 agent 的 stdout 视图,主 thread card 不应展示。
///
/// `subagent_type` 同时出现在 type=user(sub-agent 的 tool_result 回显)
/// 和 type=assistant(sub-agent 的 tool_use / text)两种行上 ── 所以本
/// helper **不限 type**,任意 type + 顶层 `subagent_type` 即命中。持久化
/// JSONL 里同一类内容用 `isSidechain=true` 表示(见 `is_sidechain_event`);
/// 流式 stdout 不携带 isSidechain 字段,所以两条独立 helper 各管一摊。
fn is_subagent_event(value: &Value) -> bool {
    value
        .get("subagent_type")
        .and_then(Value::as_str)
        .is_some()
}

/// [both paths] 流式 `isSynthetic=true` + 持久化 `isMeta=true` 的统一
/// helper。两者语义相同:标记"harness / CLI 合成的 user 消息"(主要是
/// Skill 工具调用时注入的 skill body,以及 `Your previous response had no
/// visible output...` 一类的隐式提醒),主 thread card 上不应展示。
///
/// 字段名随载体不同,本 helper 同时覆盖两条路径:
///   - [stream path]  流式 stdout(v2.1.207+): 顶层 `isSynthetic` 字段
///   - [history path] 持久化 JSONL: 顶层 `isMeta` 字段(出现在 --resume /
///                     压缩重建阶段,以及部分行同时在持久化文件中)
/// 两个都覆盖以防 resume / 压缩重建场景下混用导致漏过。
fn is_synthetic_user_marker(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if value.get("isSynthetic").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    false
}

/// [both paths] 统一静默判定入口 ── 在 events.rs(stream) 与 history.rs
/// (history) 两个入口都会被调用。返回 `Some(reason)` 时该事件应在渲染前
/// 整条丢弃;`reason` 是稳定的字符串标签,只用于 `tracing::debug!` 日志与
/// 单元测试断言,绝不展示给最终用户。
///
/// 检查顺序固定,从最具体的"系统合成"信号到最弱(同时反映两条 path 的
/// 命中频率 ── 高频信号在前,避免无谓的低频检查):
///   1. synthetic_user_event   [history]   task-notification(origin.kind 或 <task-notification> 前缀)
///   2. synthetic_user_marker  [both]      Skill body 注入 / 系统提醒(isSynthetic 或 isMeta)
/// 任何多重命中优先归到最先匹配的那一类,避免日志里同一行出现多个 reason。
pub(super) fn silence_reason(value: &Value) -> Option<&'static str> {
    if is_synthetic_user_event(value) {
        return Some("synthetic_user_event");
    }
    if is_synthetic_user_marker(value) {
        return Some("synthetic_user_marker");
    }
    None
}

/// [both paths] `silence_reason(value).is_some()` 的语义糖,用于"该行
/// 是否应丢弃"的纯布尔判定(不需要 reason 字符串)。`silence_reason` 与
/// `should_silence_event` 都对外暴露,前者用于需要打日志的入口
/// (events.rs::claude_event_to_chunks / history.rs::value_to_chat_messages),
/// 后者用于"反向条件"判断(history.rs::read_claude_session_meta 的标题
/// 候选条件),少做一次 Option 解包。
pub(super) fn should_silence_event(value: &Value) -> bool {
    silence_reason(value).is_some()
}

/// [stream path] 单行 JSONL → AgentChunk 列表。被 `parse_claude_stdout_line`
/// 调用,是流式 stdout 解析的最底层。entry guard 用 `silence_reason` 拦截
/// 合成消息(详见 `silence_reason` 的 doc);通过后按 `type` 分发到各 block
/// 处理分支(assistant / user / result / system / 未知 type fallback)。
pub(crate) fn claude_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    if let Some(reason) = silence_reason(value) {
        tracing::debug!(
            "[ClaudeCli] silenced event thread_id={thread_id} reason={reason} \
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

    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // [stream path] type=assistant 分发 ── text / thinking / tool_use 块
    // → 对应 AgentChunk;image / attachment 等 → 静默丢弃。
    if event_type == "assistant" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                match block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Text {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(Value::as_str)
                        {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Reasoning {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("claude_tool")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        chunks.push(AgentChunk::ToolCall {
                            thread_id: thread_id.to_string(),
                            id,
                            name,
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                        });
                    }
                    _ => {}
                }
            }
        }
        return chunks;
    }

    // [stream path] type=user 分发 ── text 块 → AgentChunk::Text;
    // tool_result 块 → AgentChunk::ToolResult;image / attachment 等 → 静默
    // 丢弃。合成消息(isMeta / isSynthetic / subagent_type / sidechain /
    // task-notification)由 entry guard `silence_reason` 在分发前拦截,
    // 不会到这里。
    if event_type == "user" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Text {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    Some("tool_result") => {
                        let id = block
                            .get("tool_use_id")
                            .or_else(|| block.get("id"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("claude_tool")
                            .to_string();
                        chunks.push(AgentChunk::ToolResult {
                            thread_id: thread_id.to_string(),
                            id,
                            name: String::new(),
                            result: claude_tool_result_value(block),
                        });
                    }
                    _ => {}
                }
            }
        }
        return chunks;
    }

    // [stream path] type=result ── CLI 终止标记,渲染前丢弃。
    if event_type == "result" {
        return Vec::new();
    }

    // [stream path] type=system ── subtype=error 转 AgentChunk::Error,
    // 其他 subtype(init / thinking_tokens 等)是 harness 元数据,丢弃。
    if event_type == "system" {
        if value.get("subtype").and_then(Value::as_str) == Some("error") {
            if let Some(text) = first_string(value, &["message", "error"]) {
                return vec![AgentChunk::Error {
                    thread_id: thread_id.to_string(),
                    message: text,
                }];
            }
        }
        return Vec::new();
    }

    // [stream path] 未知 type 兜底 ── 用 first_string 找顶层 string 字段。
    if let Some(text) = first_string(value, &["delta", "text", "content"]) {
        if !text.trim().is_empty() {
            return vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text,
            }];
        }
    }

    Vec::new()
}

// [both paths] ToolResult payload 序列化 ── events.rs 和 history.rs 的
// 两条 path 在推 ToolResult 时都会调这里把 block.content 转成统一 envelope。
fn claude_tool_result_value(block: &Value) -> Value {
    let Some(content) = block.get("content") else {
        return claude_tool_result_envelope(block.clone(), block);
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
    claude_tool_result_envelope(content, block)
}

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

// [stream path] 从顶层 / 嵌套 message envelope 里递归找 session id ──
    // Claude Code 的 stdout JSONL 在顶层或 message.* 里都会带 session_id。
    // 用于 `parse_claude_stdout_line` 的 `SessionResolved` chunk 推送与
    // `upsert_external_session` 持久化。
fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value.get("message").and_then(extract_session_id)
}

// [stream path] 未知 type 兜底用的递归 string 查找 ── 先看顶层 keys,
    // 再递归 Value::Object / Value::Array,找到任意 string 字段即返回。
fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }

    match value {
        Value::Object(map) => map.values().find_map(|v| first_string(v, keys)),
        Value::Array(items) => items.iter().find_map(|v| first_string(v, keys)),
        _ => None,
    }
}
