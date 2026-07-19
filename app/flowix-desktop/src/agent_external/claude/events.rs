use serde_json::Value;
use std::collections::BTreeMap;

use crate::agent_flowix::AgentChunk;
use crate::agent_types::UsageInfo;

pub(crate) struct ParsedClaudeStdoutLine {
    pub value: Option<Value>,
    pub session_id: Option<String>,
    pub chunks: Vec<AgentChunk>,
}

/// `--include-partial-messages` 模式下, Claude Code 把一次 assistant 回答拆成
/// 多条 `stream_event`(Anthropic 原生流式事件)增量输出。其中 `tool_use` 块的
/// `input` JSON 通过 `input_json_delta` 分片到达, 单行解析无法还原完整 input,
/// 必须跨行累积 ── 本结构持有这个跨行状态, 由 `read_claude_stdout` 循环按会话
/// 保存, 传入 `claude_event_to_chunks_with_state`。
///
/// 镜像 OpenAI 兼容 provider 的 `PendingToolCalls`(BTreeMap 按 content_block
/// `index` 累积 `arguments`), 仅作用于 Claude partial 流式路径。
#[derive(Default)]
pub(crate) struct ClaudeStreamState {
    /// content_block `index` -> 累积中的 tool_use 输入。
    /// `content_block_start`(tool_use) 建 entry;`input_json_delta` 追加
    /// `partial_json`;`content_block_stop` flush 成 `AgentChunk::ToolCall`。
    pending_tool_inputs: BTreeMap<i64, PendingToolInput>,
}

struct PendingToolInput {
    id: String,
    name: String,
    json_buf: String,
}

/// [stream path] 把 Claude Code 子进程 stdout 的一行 JSONL 解析成
/// `ParsedClaudeStdoutLine`。非 JSON 行作为 raw 文本 Text chunk 透传,
/// JSON 行转 AgentChunk 列表。被 `stream.rs::read_claude_stdout` 调用于
/// 流式回显。同会话的 history path 走 `history.rs::value_to_chat_messages`,
/// 数据源是 `~/.claude/projects/.../sid.jsonl` ── 两条路径处理的是同一份
/// 对话的不同视图(streaming 是实时切片, history 是压缩后的全量)。
///
/// 本入口是非 partial 兜底(单元测试 / 未开 `--include-partial-messages` 的历史
/// 路径);真实流式路径走 [`parse_claude_stdout_line_with_state`](partial=true +
/// 跨行 state)。
#[allow(dead_code)] // 非 partial 兜底 + 单元测试入口; 生产流式走 with_state。
pub(crate) fn parse_claude_stdout_line(thread_id: &str, line: &str) -> ParsedClaudeStdoutLine {
    parse_claude_stdout_line_inner(thread_id, line, false, &mut ClaudeStreamState::default())
}

/// [stream path] partial 模式专用入口 ── `read_claude_stdout` 持有跨行 `state`,
/// `partial=true` 抑制冗余 `assistant` 快照(delta 已驱动渲染), 并把
/// `stream_event` 解析成增量 `AgentChunk`。`state` 在调用方循环里跨行复用,
/// 同一会话的 `input_json_delta` 分片在此累积。
pub(crate) fn parse_claude_stdout_line_with_state(
    thread_id: &str,
    line: &str,
    state: &mut ClaudeStreamState,
) -> ParsedClaudeStdoutLine {
    parse_claude_stdout_line_inner(thread_id, line, true, state)
}

fn parse_claude_stdout_line_inner(
    thread_id: &str,
    line: &str,
    partial: bool,
    state: &mut ClaudeStreamState,
) -> ParsedClaudeStdoutLine {
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
    let chunks = claude_event_to_chunks_with_state(thread_id, &value, partial, state);

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
    if value
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(Value::as_str)
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
#[allow(dead_code)] // 非 partial 兜底 + 单元测试入口; 生产流式走 with_state。
pub(crate) fn claude_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    claude_event_to_chunks_with_state(thread_id, value, false, &mut ClaudeStreamState::default())
}

pub(crate) fn claude_event_to_chunks_with_state(
    thread_id: &str,
    value: &Value,
    partial: bool,
    state: &mut ClaudeStreamState,
) -> Vec<AgentChunk> {
    if let Some(reason) = silence_reason(value) {
        tracing::debug!(
            "[ClaudeCli] silenced event thread_id={thread_id} reason={reason} \
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

    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // [stream path, partial only] type=stream_event ── Anthropic 原生流式事件
    // (message_start / content_block_start|delta|stop / message_delta|stop)。
    // text_delta / thinking_delta -> 增量 Text / Reasoning;input_json_delta ->
    // 跨行累积;message_delta -> Usage。partial=false 时不会出现该 type。
    if event_type == "stream_event" {
        return stream_event_to_chunks(thread_id, value, state);
    }

    // [stream path] type=assistant 分发 ── text / thinking / tool_use 块
    // → 对应 AgentChunk;image / attachment 等 → 静默丢弃。
    if event_type == "assistant" {
        // partial: delta 已驱动渲染, 丢弃冗余累积快照。partial 快照与非 partial
        // 完整消息的 stop_reason 都是 null, 只能靠 `partial` 标志区分。
        if partial {
            return Vec::new();
        }
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
    // 丢弃。合成消息(isMeta / isSynthetic /
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

/// [stream path, partial only] 解析 `type=stream_event` 行。`event` 是 Anthropic
/// 原生流式事件, `index` 标识 content_block。tool_use 的 `input` 通过
/// `input_json_delta` 分片累积到 `state`, 在 `content_block_stop` flush 成
/// `AgentChunk::ToolCall`(解析失败 / 空 -> `{}`)。
///
/// sub-agent 的 stream_event 带 `parent_tool_use_id`(非 null)── 与非 partial
/// 路径一致, sub-agent 活动按设计展示在主 thread card 上(见 cli.rs
/// `emits_claude_subagent_event_while_streaming`), 此处不额外过滤。
fn stream_event_to_chunks(
    thread_id: &str,
    value: &Value,
    state: &mut ClaudeStreamState,
) -> Vec<AgentChunk> {
    let Some(ev) = value.get("event") else {
        return Vec::new();
    };
    let event_type = ev.get("type").and_then(Value::as_str).unwrap_or_default();
    let index = ev.get("index").and_then(Value::as_i64).unwrap_or(0);

    match event_type {
        // 新 message 开始: 清掉上一轮残留的 pending tool input, 防跨轮泄漏。
        "message_start" => {
            state.pending_tool_inputs.clear();
            Vec::new()
        }
        // tool_use 块开始: 记 id / name, input 由 input_json_delta 累积。
        // text / thinking 块 start 无 chunk(内容由 delta 投递)。
        "content_block_start" => {
            let is_tool_use = ev
                .get("content_block")
                .and_then(|b| b.get("type"))
                .and_then(Value::as_str)
                == Some("tool_use");
            if is_tool_use {
                let cb = ev.get("content_block").cloned().unwrap_or(Value::Null);
                let id = cb
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("claude_tool")
                    .to_string();
                let name = cb
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                state.pending_tool_inputs.insert(
                    index,
                    PendingToolInput {
                        id,
                        name,
                        json_buf: String::new(),
                    },
                );
            }
            Vec::new()
        }
        "content_block_delta" => {
            let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
            match delta
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "text_delta" => match delta.get("text").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => vec![AgentChunk::Text {
                        thread_id: thread_id.to_string(),
                        text: text.to_string(),
                    }],
                    _ => Vec::new(),
                },
                "thinking_delta" => match delta.get("thinking").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => vec![AgentChunk::Reasoning {
                        thread_id: thread_id.to_string(),
                        text: text.to_string(),
                    }],
                    _ => Vec::new(),
                },
                "input_json_delta" => {
                    if let Some(fragment) = delta.get("partial_json").and_then(Value::as_str) {
                        if let Some(pending) = state.pending_tool_inputs.get_mut(&index) {
                            pending.json_buf.push_str(fragment);
                        }
                    }
                    Vec::new()
                }
                _ => Vec::new(),
            }
        }
        // flush 累积的 tool_use input -> ToolCall(解析失败 / 空 -> `{}`)。
        "content_block_stop" => match state.pending_tool_inputs.remove(&index) {
            Some(pending) => {
                let input = if pending.json_buf.trim().is_empty() {
                    serde_json::json!({})
                } else {
                    serde_json::from_str(&pending.json_buf)
                        .unwrap_or_else(|_| serde_json::json!({}))
                };
                vec![AgentChunk::ToolCall {
                    thread_id: thread_id.to_string(),
                    id: pending.id,
                    name: pending.name,
                    input,
                }]
            }
            None => Vec::new(),
        },
        // 末尾 usage(input / output / cache_read tokens)。stop_reason 也在本事件,
        // 但前端靠 stream_end 收敛 run, 无需额外 chunk。
        "message_delta" => match ev.get("usage") {
            Some(usage) => vec![AgentChunk::Usage {
                thread_id: thread_id.to_string(),
                model_id: None,
                last_run_at: None,
                usage: Some(UsageInfo {
                    input_tokens: usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    cached_input_tokens: usage
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    output_tokens: usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    reasoning_output_tokens: None,
                    total_tokens: None,
                    model_context_window: None,
                }),
                status_info: None,
            }],
            None => Vec::new(),
        },
        // message_stop / 其他: 无 chunk。
        _ => Vec::new(),
    }
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
