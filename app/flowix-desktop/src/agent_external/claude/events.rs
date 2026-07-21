use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

use crate::agent_flowix::AgentChunk;
use crate::agent_types::UsageInfo;

pub(crate) struct ParsedClaudeStdoutLine {
    pub value: Option<Value>,
    pub session_id: Option<String>,
    pub chunks: Vec<AgentChunk>,
}

/// `--include-partial-messages` 妯″紡涓? Claude Code 鎶婁竴娆?assistant 鍥炵瓟鎷嗘垚
/// 澶氭潯 `stream_event`(Anthropic 鍘熺敓娴佸紡浜嬩欢)澧為噺杈撳嚭銆傚叾涓?`tool_use` 鍧楃殑
/// `input` JSON 閫氳繃 `input_json_delta` 鍒嗙墖鍒拌揪, 鍗曡瑙ｆ瀽鏃犳硶杩樺師瀹屾暣 input,
/// 蹇呴』璺ㄨ绱Н 鈹€鈹€ 鏈粨鏋勬寔鏈夎繖涓法琛岀姸鎬? 鐢?`read_claude_stdout` 寰幆鎸変細璇?/// 淇濆瓨, 浼犲叆 `claude_event_to_chunks_with_state`銆?///
/// 闀滃儚 OpenAI 鍏煎 provider 鐨?`PendingToolCalls`(BTreeMap 鎸?content_block
/// `index` 绱Н `arguments`), 浠呬綔鐢ㄤ簬 Claude partial 娴佸紡璺緞銆?
#[derive(Default)]
pub(crate) struct ClaudeStreamState {
    /// content_block `index` -> 绱Н涓殑 tool_use 杈撳叆銆?
    /// `content_block_start`(tool_use) 寤?entry;`input_json_delta` 杩藉姞
    /// `partial_json`;`content_block_stop` flush 鎴?`AgentChunk::ToolCall`銆?
    pending_tool_inputs: BTreeMap<i64, PendingToolInput>,
    /// 已发出 ToolCall 的 tool_use_id 集合 —— 跨行去重,防止 stream_event 增量与
    /// 完整 assistant 快照对同一 id 重复发 ToolCall。partial 模式下内置工具
    /// (WebSearch / Agent / TaskOutput 等无 stream_event 增量的工具)只出现在完整
    /// 快照里,靠本集合判定"是否已被增量发过"以决定是否从快照补发。
    emitted_tool_call_ids: HashSet<String>,
}

struct PendingToolInput {
    id: String,
    name: String,
    json_buf: String,
}

/// [stream path] 鎶?Claude Code 瀛愯繘绋?stdout 鐨勪竴琛?JSONL 瑙ｆ瀽鎴?/// `ParsedClaudeStdoutLine`銆傞潪 JSON 琛屼綔涓?raw 鏂囨湰 Text chunk 閫忎紶,
/// JSON 琛岃浆 AgentChunk 鍒楄〃銆傝 `stream.rs::read_claude_stdout` 璋冪敤浜?/// 娴佸紡鍥炴樉銆傚悓浼氳瘽鐨?history path 璧?`history.rs::value_to_chat_messages`,
/// 鏁版嵁婧愭槸 `~/.claude/projects/.../sid.jsonl` 鈹€鈹€ 涓ゆ潯璺緞澶勭悊鐨勬槸鍚屼竴浠?/// 瀵硅瘽鐨勪笉鍚岃鍥?streaming 鏄疄鏃跺垏鐗? history 鏄帇缂╁悗鐨勫叏閲?銆?///
/// 鏈叆鍙ｆ槸闈?partial 鍏滃簳(鍗曞厓娴嬭瘯 / 鏈紑 `--include-partial-messages` 鐨勫巻鍙?/// 璺緞);鐪熷疄娴佸紡璺緞璧?[`parse_claude_stdout_line_with_state`](partial=true +
/// 璺ㄨ state)
#[allow(dead_code)] // 闈?partial 鍏滃簳 + 鍗曞厓娴嬭瘯鍏ュ彛; 鐢熶骇娴佸紡璧?with_state銆?
pub(crate) fn parse_claude_stdout_line(thread_id: &str, line: &str) -> ParsedClaudeStdoutLine {
    parse_claude_stdout_line_inner(thread_id, line, false, &mut ClaudeStreamState::default())
}

/// [stream path] partial 妯″紡涓撶敤鍏ュ彛 鈹€鈹€ `read_claude_stdout` 鎸佹湁璺ㄨ `state`,
/// `partial=true` 鎶戝埗鍐椾綑 `assistant` 蹇収(delta 宸查┍鍔ㄦ覆鏌?, 骞舵妸
/// `stream_event` 瑙ｆ瀽鎴愬閲?`AgentChunk`銆俙state` 鍦ㄨ皟鐢ㄦ柟寰幆閲岃法琛屽鐢?
/// 鍚屼竴浼氳瘽鐨?`input_json_delta` 鍒嗙墖鍦ㄦ绱Н銆?
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
        if looks_like_claude_json_event_line(line) {
            return ParsedClaudeStdoutLine {
                value: None,
                session_id: None,
                chunks: Vec::new(),
            };
        }
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

/// [history path primarily] Claude Code v2 鎶?Task 瀛?agent 瀹屾垚鐨勯€氱煡
/// 鍖呮垚 `type=user` 娑堟伅鍠傜粰涓?agent,鍐呭鏄暣娈?/// `<task-notification>...</task-notification>` XML 鈥斺€?杩欎竴褰㈡€佸彧鍦?/// 鎸佷箙鍖?JSONL 閲屽嚭鐜?鐢?CLI 鍦ㄥ帇缂?/ 涓婁笅鏂囨仮澶嶉樁娈靛啓鍏?銆?/// 娴佸紡 stdout 閲?sub-agent 瀹屾垚閫氱煡鏀硅蛋 `type=result, origin.kind=
/// "task-notification"`(鏃?type=user 褰㈡€?,鎵€浠ユ湰 helper 鍦?stream path
/// 涓婂疄闄呬笂鏄?no-op銆?///
/// `origin.kind == "task-notification"` 鏄渶鍙潬鐨?schema 绾т俊鍙?
/// 鏃х増鏈垨闈炴爣鏍煎紡鍙兘娌℃湁 origin 瀛楁浣?content 鐩存帴鏄?`<task-notification>`
/// 瀛楃涓测€斺€斾竴骞跺厹搴曘€?
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

/// [both paths] 娴佸紡 `isSynthetic=true` + 鎸佷箙鍖?`isMeta=true` 鐨勭粺涓€
/// helper銆備袱鑰呰涔夌浉鍚?鏍囪"harness / CLI 鍚堟垚鐨?user 娑堟伅"(涓昏鏄?/// Skill 宸ュ叿璋冪敤鏃舵敞鍏ョ殑 skill body,浠ュ強 `Your previous response had no
/// visible output...` 涓€绫荤殑闅愬紡鎻愰啋),涓?thread card 涓婁笉搴斿睍绀恒€?///
/// 瀛楁鍚嶉殢杞戒綋涓嶅悓,鏈?helper 鍚屾椂瑕嗙洊涓ゆ潯璺緞:
///   - [stream path]  娴佸紡 stdout(v2.1.207+): 椤跺眰 `isSynthetic` 瀛楁
///   - [history path] 鎸佷箙鍖?JSONL: 椤跺眰 `isMeta` 瀛楁(鍑虹幇鍦?--resume /
///                     鍘嬬缉閲嶅缓闃舵,浠ュ強閮ㄥ垎琛屽悓鏃跺湪鎸佷箙鍖栨枃浠朵腑)
/// 涓や釜閮借鐩栦互闃?resume / 鍘嬬缉閲嶅缓鍦烘櫙涓嬫贩鐢ㄥ鑷存紡杩囥€?
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
    if value
        .get("isVisibleInTranscriptOnly")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    if value.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if message_content_text(value).is_some_and(|text| is_claude_skill_injection_text(&text)) {
        return true;
    }
    false
}

fn message_content_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"))?;
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

fn is_claude_skill_injection_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("Base directory for this skill:")
        || trimmed.starts_with("# Building LLM-Powered Applications with Claude")
        || trimmed.contains("\n# Building LLM-Powered Applications with Claude")
}

fn looks_like_claude_json_event_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{')
        && (trimmed.contains(r#""type":"user""#)
            || trimmed.contains(r#""type": "user""#)
            || trimmed.contains(r#""type":"assistant""#)
            || trimmed.contains(r#""type": "assistant""#)
            || trimmed.contains(r#""type":"stream_event""#)
            || trimmed.contains(r#""type": "stream_event""#)
            || trimmed.contains(r#""type":"result""#)
            || trimmed.contains(r#""type": "result""#)
            || trimmed.contains(r#""type":"system""#)
            || trimmed.contains(r#""type": "system""#)
            || trimmed.contains("Base directory for this skill:"))
}

/// [both paths] 缁熶竴闈欓粯鍒ゅ畾鍏ュ彛 鈹€鈹€ 鍦?events.rs(stream) 涓?history.rs
/// (history) 涓や釜鍏ュ彛閮戒細琚皟鐢ㄣ€傝繑鍥?`Some(reason)` 鏃惰浜嬩欢搴斿湪娓叉煋鍓?/// 鏁存潯涓㈠純;`reason` 鏄ǔ瀹氱殑瀛楃涓叉爣绛?鍙敤浜?`tracing::debug!` 鏃ュ織涓?/// 鍗曞厓娴嬭瘯鏂█,缁濅笉灞曠ず缁欐渶缁堢敤鎴枫€?///
/// 妫€鏌ラ『搴忓浐瀹?浠庢渶鍏蜂綋鐨?绯荤粺鍚堟垚"淇″彿鍒版渶寮?鍚屾椂鍙嶆槧涓ゆ潯 path 鐨?/// 鍛戒腑棰戠巼 鈹€鈹€ 楂橀淇″彿鍦ㄥ墠,閬垮厤鏃犺皳鐨勪綆棰戞鏌?:
///   1. synthetic_user_event   [history]   task-notification(origin.kind 鎴?<task-notification> 鍓嶇紑)
///   2. synthetic_user_marker  [both]      Skill body 娉ㄥ叆 / 绯荤粺鎻愰啋(isSynthetic 鎴?isMeta)
/// 浠讳綍澶氶噸鍛戒腑浼樺厛褰掑埌鏈€鍏堝尮閰嶇殑閭ｄ竴绫?閬垮厤鏃ュ織閲屽悓涓€琛屽嚭鐜板涓?reason銆?
pub(super) fn silence_reason(value: &Value) -> Option<&'static str> {
    if is_synthetic_user_event(value) {
        return Some("synthetic_user_event");
    }
    if is_synthetic_user_marker(value) {
        return Some("synthetic_user_marker");
    }
    None
}

/// [both paths] `silence_reason(value).is_some()` 鐨勮涔夌硸,鐢ㄤ簬"璇ヨ
/// 鏄惁搴斾涪寮?鐨勭函甯冨皵鍒ゅ畾(涓嶉渶瑕?reason 瀛楃涓?銆俙silence_reason` 涓?/// `should_silence_event` 閮藉澶栨毚闇?鍓嶈€呯敤浜庨渶瑕佹墦鏃ュ織鐨勫叆鍙?/// (events.rs::claude_event_to_chunks / history.rs::value_to_chat_messages),
/// 鍚庤€呯敤浜?鍙嶅悜鏉′欢"鍒ゆ柇(history.rs::read_claude_session_meta 鐨勬爣棰?/// 鍊欓€夋潯浠?,灏戝仛涓€娆?Option 瑙ｅ寘銆?
pub(super) fn should_silence_event(value: &Value) -> bool {
    silence_reason(value).is_some()
}

/// [stream path] 鍗曡 JSONL 鈫?AgentChunk 鍒楄〃銆傝 `parse_claude_stdout_line`
/// 璋冪敤,鏄祦寮?stdout 瑙ｆ瀽鐨勬渶搴曞眰銆俥ntry guard 鐢?`silence_reason` 鎷︽埅
/// 鍚堟垚娑堟伅(璇﹁ `silence_reason` 鐨?doc);閫氳繃鍚庢寜 `type` 鍒嗗彂鍒板悇 block
/// 澶勭悊鍒嗘敮(assistant / user / result / system / 鏈煡 type fallback)
#[allow(dead_code)] // 闈?partial 鍏滃簳 + 鍗曞厓娴嬭瘯鍏ュ彛; 鐢熶骇娴佸紡璧?with_state銆?
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

    // [stream path, partial only] type=stream_event 鈹€鈹€ Anthropic 鍘熺敓娴佸紡浜嬩欢
    // (message_start / content_block_start|delta|stop / message_delta|stop)銆?    // text_delta / thinking_delta -> 澧為噺 Text / Reasoning;input_json_delta ->
    // 璺ㄨ绱Н;message_delta -> Usage銆俻artial=false 鏃朵笉浼氬嚭鐜拌 type銆?
    if event_type == "stream_event" {
        return stream_event_to_chunks(thread_id, value, state);
    }

    // [stream path] type=assistant 鍒嗗彂 鈹€鈹€ text / thinking / tool_use 鍧?    // 鈫?瀵瑰簲 AgentChunk;image / attachment 绛?鈫?闈欓粯涓㈠純銆?
    if event_type == "assistant" {
        // partial: delta 宸查┍鍔ㄦ覆鏌? 涓㈠純鍐椾綑绱Н蹇収銆俻artial 蹇収涓庨潪 partial
        // 瀹屾暣娑堟伅鐨?stop_reason 閮芥槸 null, 鍙兘闈?`partial` 鏍囧織鍖哄垎銆?
        if partial {
            // text/thinking 已由 stream_event delta 驱动渲染,跳过;但对内置工具
            // (WebSearch / Agent / TaskOutput 等无 stream_event 增量、仅存于快照的
            // 工具)补发 ToolCall,避免后续 tool_result 因 name="" 且无配对 tool_call
            // 渲染成 "Unknown Tool"。详见 reconcile_partial_assistant_tool_calls。
            return reconcile_partial_assistant_tool_calls(thread_id, value, state);
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

    // [stream path] type=user 鍒嗗彂 鈹€鈹€ text 鍧?鈫?AgentChunk::Text;
    // tool_result 鍧?鈫?AgentChunk::ToolResult;image / attachment 绛?鈫?闈欓粯
    // 涓㈠純銆傚悎鎴愭秷鎭?isMeta / isSynthetic /
    // task-notification)鐢?entry guard `silence_reason` 鍦ㄥ垎鍙戝墠鎷︽埅,
    // 涓嶄細鍒拌繖閲屻€?
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

    // [stream path] type=result 鈹€鈹€ CLI 缁堟鏍囪,娓叉煋鍓嶄涪寮冦€?
    if event_type == "result" {
        return Vec::new();
    }

    // [stream path] type=system 鈹€鈹€ subtype=error 杞?AgentChunk::Error,
    // 鍏朵粬 subtype(init / thinking_tokens 绛?鏄?harness 鍏冩暟鎹?涓㈠純銆?
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

    // [stream path] 鏈煡 type 鍏滃簳 鈹€鈹€ 鐢?first_string 鎵鹃《灞?string 瀛楁銆?
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

/// [stream path, partial only] 瑙ｆ瀽 `type=stream_event` 琛屻€俙event` 鏄?Anthropic
/// 鍘熺敓娴佸紡浜嬩欢, `index` 鏍囪瘑 content_block銆倀ool_use 鐨?`input` 閫氳繃
/// `input_json_delta` 鍒嗙墖绱Н鍒?`state`, 鍦?`content_block_stop` flush 鎴?/// `AgentChunk::ToolCall`(瑙ｆ瀽澶辫触 / 绌?-> `{}`)銆?///
/// sub-agent 鐨?stream_event 甯?`parent_tool_use_id`(闈?null)鈹€鈹€ 涓庨潪 partial
/// 璺緞涓€鑷? sub-agent 娲诲姩鎸夎璁″睍绀哄湪涓?thread card 涓?瑙?cli.rs
/// `emits_claude_subagent_event_while_streaming`), 姝ゅ涓嶉澶栬繃婊ゃ€?
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
        // 鏂?message 寮€濮? 娓呮帀涓婁竴杞畫鐣欑殑 pending tool input, 闃茶法杞硠婕忋€?
        "message_start" => {
            state.pending_tool_inputs.clear();
            Vec::new()
        }
        // tool_use 鍧楀紑濮? 璁?id / name, input 鐢?input_json_delta 绱Н銆?
        // text / thinking 鍧?start 鏃?chunk(鍐呭鐢?delta 鎶曢€?銆?
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
        // flush 绱Н鐨?tool_use input -> ToolCall(瑙ｆ瀽澶辫触 / 绌?-> `{}`)銆?
        "content_block_stop" => match state.pending_tool_inputs.remove(&index) {
            Some(pending) => {
                // 若该 id 已被完整快照补发过(insert 返回 false),跳过避免重复 ToolCall。
                if !state.emitted_tool_call_ids.insert(pending.id.clone()) {
                    return Vec::new();
                }
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
        // 鏈熬 usage(input / output / cache_read tokens)銆俿top_reason 涔熷湪鏈簨浠?
        // 浣嗗墠绔潬 stream_end 鏀舵暃 run, 鏃犻渶棰濆 chunk銆?
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
        // message_stop / 鍏朵粬: 鏃?chunk銆?
        _ => Vec::new(),
    }
}

// [both paths] ToolResult payload 搴忓垪鍖?鈹€鈹€ events.rs 鍜?history.rs 鐨?// 涓ゆ潯 path 鍦ㄦ帹 ToolResult 鏃堕兘浼氳皟杩欓噷鎶?block.content 杞垚缁熶竴 envelope銆?
/// [stream path, partial only] 完整 `type=assistant` 快照里的 tool_use 补发。
///
/// `--include-partial-messages` 下 Claude Code 对普通模型工具(Bash / Read 等)会先
/// 发 `stream_event` content_block_* 增量再发完整快照;但对内置工具(WebSearch 服务
/// 端工具、Agent / Task / TaskOutput 等 SDK 编排工具)只产出完整 `type=assistant`
/// 快照,没有 stream_event 增量。partial 主路径会整条丢弃快照(text/thinking 已由
/// delta 渲染),导致这些 tool_use 的 ToolCall 永不发出,后续 tool_result(name 恒
/// 为空)渲染成 "Unknown Tool"。
///
/// 本函数遍历快照 content,对**未在 `emitted_tool_call_ids` 登记**的 tool_use 补发
/// `AgentChunk::ToolCall`(含完整 input);text/thinking 跳过(已由 delta 流过)。
/// 同一 id 若已被 stream_event 发过则跳过,避免重复。
fn reconcile_partial_assistant_tool_calls(
    thread_id: &str,
    value: &Value,
    state: &mut ClaudeStreamState,
) -> Vec<AgentChunk> {
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut chunks = Vec::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("claude_tool")
            .to_string();
        // insert 返回 false = 已由 stream_event 增量发过,跳过避免重复
        if !state.emitted_tool_call_ids.insert(id.clone()) {
            continue;
        }
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        chunks.push(AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input,
        });
    }
    chunks
}

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

// [stream path] 浠庨《灞?/ 宓屽 message envelope 閲岄€掑綊鎵?session id 鈹€鈹€
// Claude Code 鐨?stdout JSONL 鍦ㄩ《灞傛垨 message.* 閲岄兘浼氬甫 session_id銆?// 鐢ㄤ簬 `parse_claude_stdout_line` 鐨?`SessionResolved` chunk 鎺ㄩ€佷笌
// `upsert_external_session` 鎸佷箙鍖栥€?
fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value.get("message").and_then(extract_session_id)
}

// [stream path] 鏈煡 type 鍏滃簳鐢ㄧ殑閫掑綊 string 鏌ユ壘 鈹€鈹€ 鍏堢湅椤跺眰 keys,
// 鍐嶉€掑綊 Value::Object / Value::Array,鎵惧埌浠绘剰 string 瀛楁鍗宠繑鍥炪€?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claude_stdout_contract_fixture_to_expected_chunks() {
        let mut state = ClaudeStreamState::default();
        let mut session_ids = Vec::new();
        let mut chunks = Vec::new();

        for line in include_str!("../fixtures/claude_stdout_contract.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let parsed = parse_claude_stdout_line_with_state("thread_contract", line, &mut state);
            if let Some(session_id) = parsed.session_id {
                session_ids.push(session_id);
            }
            chunks.extend(parsed.chunks);
        }

        assert_eq!(session_ids, vec!["claude-session-1"]);
        assert_eq!(chunks.len(), 6);
        assert!(matches!(
            &chunks[0],
            AgentChunk::Reasoning { text, .. } if text == "Need inspect workspace."
        ));
        assert!(matches!(
            &chunks[1],
            AgentChunk::Text { text, .. } if text == "The workspace is "
        ));
        assert!(matches!(
            &chunks[2],
            AgentChunk::ToolCall { id, name, input, .. }
                if id == "toolu_1"
                    && name == "Bash"
                    && input.get("command").and_then(Value::as_str) == Some("pwd")
        ));
        assert!(matches!(
            &chunks[3],
            AgentChunk::Usage {
                usage: Some(crate::agent_types::UsageInfo {
                    input_tokens: Some(90),
                    cached_input_tokens: Some(30),
                    output_tokens: Some(12),
                    ..
                }),
                ..
            }
        ));
        assert!(matches!(
            &chunks[4],
            AgentChunk::ToolResult { id, result, .. }
                if id == "toolu_1"
                    && result.get("content").and_then(Value::as_str) == Some("/tmp/flowix\n")
        ));
        assert!(matches!(
            &chunks[5],
            AgentChunk::Error { message, .. } if message == "Claude transport error"
        ));
    }
}
