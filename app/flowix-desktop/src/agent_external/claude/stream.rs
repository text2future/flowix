use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use tokio::io::BufReader;

use super::events::{
    parse_claude_stdout_line_with_state, ClaudeStreamState, ParsedClaudeStdoutLine,
};
use super::{truncate_for_log, AGENT_TYPE};
use crate::agent_external::{
    persist_and_emit_external_chunk, read_capped_line, ExternalRunRegistry, StreamingEmitBuffer,
    MAX_STDOUT_LINE_BYTES, STREAM_FLUSH_INTERVAL, STREAM_FLUSH_MAX_BYTES,
};
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;

/// flush `emit_buf` 鐨勫叏閮ㄧ紦鍐?chunk 骞堕€愭潯 emit銆傜┖缂撳啿涓?no-op銆?
async fn flush_emit_buffer(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<tokio::sync::RwLock<ThreadManager>>,
    emit_buf: &mut StreamingEmitBuffer,
    run_id: &str,
) {
    if emit_buf.is_empty() {
        return;
    }
    for chunk in emit_buf.flush() {
        persist_and_emit_external_chunk(
            app_handle,
            thread_manager,
            AGENT_TYPE,
            &chunk,
            run_id,
            None,
        )
        .await;
    }
}

/// burst 淇濋櫓 鈹€鈹€ 缂撳啿瓒呰繃 [`STREAM_FLUSH_MAX_BYTES`] 鏃剁珛鍗?flush 骞堕噸缃抚璁℃椂,
/// 闃叉鎸佺画楂橀€熸枃鏈祦鏃剁紦鍐叉棤闄愬闀裤€傛甯镐竴甯х殑鏂囨湰閲忚繙灏忎簬姝ら槇鍊? 鍙湁
/// read_capped_line 鎸佺画杩斿洖楂橀 text 琛岀殑鏋佺 burst 鎵嶄細瑙﹁揪銆?
async fn flush_emit_buffer_if_full(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<tokio::sync::RwLock<ThreadManager>>,
    emit_buf: &mut StreamingEmitBuffer,
    run_id: &str,
    last_flush_at: &mut Instant,
) {
    if emit_buf.pending_bytes() >= STREAM_FLUSH_MAX_BYTES {
        flush_emit_buffer(app_handle, thread_manager, emit_buf, run_id).await;
        *last_flush_at = Instant::now();
    }
}

pub(crate) async fn read_claude_stdout<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut seen_sessions = HashSet::new();
    // tool_use_id -> tool_name 璺ㄨ鏄犲皠銆俆oolCall chunk 鍙戝嚭鏃惰褰?id->name,
    // 鍚庣画 ToolResult chunk 鍒拌揪鏃剁敤瀹冨～鍏ョ湡瀹炲伐鍏峰悕,閬垮厤鍓嶇 name="" fallback "unknown tool"銆?
    let mut tool_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // partial 妯″紡璺ㄨ鐘舵€?鈹€鈹€ 绱Н tool_use 鐨?input_json_delta 鍒嗙墖, 鍦?    // content_block_stop flush 鎴?ToolCall銆傝 events::ClaudeStreamState銆?
    let mut stream_state = ClaudeStreamState::default();
    // 甯х骇鏂囨湰鍚堝苟 buffer 鈹€鈹€ 鎶婇珮棰?Text / Reasoning 鏀掓壒, 鍑忓皯 agent-chunk IPC
    // emit 娆℃暟 (瑙?StreamingEmitBuffer doc)銆俆ext/Reasoning 杩?buffer; 鍏跺畠 chunk
    // 鍏?flush 鍐?emit, 淇濊瘉鍛堢幇椤哄簭銆?
    let mut emit_buf = StreamingEmitBuffer::new(thread_id.clone());
    // 甯х骇 flush 璁℃椂 鈹€鈹€ 涓庡墠绔?rAF 甯х巼 (~16ms) 瀵归綈銆傛瘡璇诲畬涓€鏁磋妫€鏌?elapsed,
    // burst 鏈熼棿绾︽瘡甯?flush 涓€娆°€?    //
    // 涓嶇敤 select! + interval: read_capped_line 璇?> BufReader 瀹归噺 (8 KiB) 鐨勯暱琛?    // 鏃朵細璺ㄥ娆?fill_buf 绱Н out, select! 鍦ㄤ腑閫?drop 鍏?future 浼氫涪澶卞凡绱Н鐨勯儴鍒?    // 琛?(reader cursor 宸?consume 浣?out 琚涪), 瀵艰嚧澶?tool_result 琛屾崯鍧?-> JSON
    // 瑙ｆ瀽澶辫触琚綋 non_json 鏂囨湰鍥炴樉銆?琛屾湯鏃堕棿妫€鏌?鍦?read_capped_line 瀹屾暣杩斿洖涓€
    // 琛屽悗鎵嶆鏌ユ椂闂? 闆?drop 椋庨櫓銆?
    let mut last_flush_at = Instant::now();

    loop {
        let line_opt = match read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await {
            Ok(opt) => opt,
            Err(err) => {
                // 绠￠亾寮傚父: 灏介噺 flush 宸叉敹鍒扮殑鏂囨湰鍐嶄笂鎶涖€?
                flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
                return Err(err);
            }
        };
        let Some((raw, truncated_by_reader)) = line_opt else {
            // EOF: 蹇呴』鍦ㄨ繑鍥炲墠 flush 娈嬬暀鏂囨湰 鈹€鈹€ 鍚﹀垯 spawn tail 鐨?
            // emit_stream_end_once 浼氬厛浜庡熬閮ㄦ枃鏈埌杈惧墠绔€?
            flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
            break;
        };
        if truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "claude_stdout",
                "claude.stdout_line_truncated",
                "Claude stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(raw.trim()),
                })),
            );
        }
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // dev-only: 鎶婂瓙杩涚▼ stdout 鍘熷琛岄暅鍍忓埌 ~/.flowix/debug/, 1:1 杩樺師
        // vendor CLI 鍥炲寘渚涙帓闅溿€俽elease 鏋勫缓鍐?no-op, 涓嶈惤鐩樸€?
        runtime_log::dump_debug_stdout_line(AGENT_TYPE, &thread_id, &run_id, line);
        runs.touch(&thread_id, Some(&run_id)).await;

        let parsed = parse_claude_stdout_line_with_state(&thread_id, line, &mut stream_state);
        let value = match parsed.value {
            Some(value) => value,
            None => {
                let Some(text) = non_json_stdout_text(&parsed, line) else {
                    runtime_log::record_agent_event(
                        "debug",
                        "claude_stdout",
                        "claude.stdout_non_json_dropped",
                        "Claude stdout emitted a JSON-like line that was intentionally dropped",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "line_chars": line.chars().count(),
                            "line_preview": truncate_for_log(line),
                        })),
                    );
                    continue;
                };
                let line_chars = line.chars().count();
                runtime_log::record_agent_event(
                    "warn",
                    "claude_stdout",
                    "claude.stdout_non_json",
                    "Claude stdout emitted a non-JSON line",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "line_chars": line_chars,
                        "line_preview": truncate_for_log(line),
                    })),
                );
                // 闈?JSON 琛屼綔涓烘枃鏈洖鏄?鈹€鈹€ 杩?buffer 鍚堝苟 (鏈€澶氬欢杩熶竴甯?銆?
                emit_buf.append_text(&text);
                flush_emit_buffer_if_full(
                    &app_handle,
                    &thread_manager,
                    &mut emit_buf,
                    &run_id,
                    &mut last_flush_at,
                )
                .await;
                continue;
            }
        };

        if let Some(session_id) = parsed.session_id {
            if seen_sessions.insert(session_id.clone()) {
                runtime_log::record_agent_event(
                    "info",
                    "claude_stdout",
                    "claude.session_resolved",
                    "Claude Code reported a session id",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "session_id": session_id,
                    })),
                );
                let manager = thread_manager.read().await;
                if let Err(err) = manager
                    .upsert_external_session(
                        &thread_id,
                        AGENT_TYPE,
                        &session_id,
                        Some(value.clone()),
                    )
                    .await
                {
                    runtime_log::record_agent_event(
                        "warn",
                        "claude_stdout",
                        "claude.session_persist_failed",
                        "Failed to persist Claude external session mapping",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "session_id": session_id,
                            "error": err.to_string(),
                        })),
                    );
                    tracing::warn!(
                        "[ClaudeCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
                // SessionResolved 鏄潪鏂囨湰 chunk 鈹€鈹€ 鍏?flush 鏂囨湰 buffer, 淇濊瘉瀹冧箣鍓?
                // 鐨勬枃鏈厛钀藉湴, 鍐?emit銆?
                flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
                last_flush_at = Instant::now();
                let chunk = AgentChunk::SessionResolved {
                    thread_id: thread_id.clone(),
                    session_id: session_id.clone(),
                };
                persist_and_emit_external_chunk(
                    &app_handle,
                    &thread_manager,
                    AGENT_TYPE,
                    &chunk,
                    &run_id,
                    None,
                )
                .await;
                runs.set_session_id(&thread_id, Some(&run_id), session_id.clone())
                    .await;
            }
        }

        for chunk in parsed.chunks {
            match chunk {
                AgentChunk::Text { text, .. } => {
                    emit_buf.append_text(&text);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &thread_manager,
                        &mut emit_buf,
                        &run_id,
                        &mut last_flush_at,
                    )
                    .await;
                }
                AgentChunk::Reasoning { text, .. } => {
                    emit_buf.append_reasoning(&text);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &thread_manager,
                        &mut emit_buf,
                        &run_id,
                        &mut last_flush_at,
                    )
                    .await;
                }
                mut chunk => {
                    // 闈炴枃鏈?chunk 鈹€鈹€ 鍏?flush 鏂囨湰 buffer, 淇濊瘉
                    // text -> tool_call -> text -> tool_result 鐨勫憟鐜伴『搴? 鍐?emit銆?
                    flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
                    last_flush_at = Instant::now();
                    // ToolCall 鍙戝嚭鍓嶈褰?id -> name
                    if let AgentChunk::ToolCall {
                        ref id, ref name, ..
                    } = chunk
                    {
                        if !id.is_empty() && !name.is_empty() {
                            tool_names.insert(id.clone(), name.clone());
                        }
                    }
                    // ToolResult 鐢?tool_use_id 鏌ュ洖鐪熷疄宸ュ叿鍚?濉叆 name 瀛楁
                    if let AgentChunk::ToolResult {
                        ref id,
                        ref mut name,
                        ..
                    } = chunk
                    {
                        if name.is_empty() {
                            if let Some(real_name) = tool_names.get(id) {
                                *name = real_name.clone();
                            }
                        }
                    }
                    persist_and_emit_external_chunk(
                        &app_handle,
                        &thread_manager,
                        AGENT_TYPE,
                        &chunk,
                        &run_id,
                        None,
                    )
                    .await;
                }
            }
        }

        // 甯х骇 flush 鈹€鈹€ 杩欎竴琛屽鐞嗗畬, 鑻ヨ窛涓婃 flush 宸茶繃涓€甯? 钀藉湴缂撳啿鏂囨湰銆?        // burst 鏈熼棿绾︽瘡 16ms flush 涓€娆?(涓庡墠绔?rAF 瀵归綈); 闈炴枃鏈?chunk 宸插湪涓婇潰
        // 寮哄埗 flush, 杩欓噷涓昏鍏滄寔缁枃鏈祦鐨勬敀鎵广€傝娴佸仠椤挎椂 read_capped_line 闃诲,
        // 缂撳啿閲屾渶澶氭畫鐣欎竴甯ф枃鏈? 鐢变笅涓€琛?/ EOF / 宸ュ叿璋冪敤瑙﹀彂钀藉湴銆?
        if last_flush_at.elapsed() >= STREAM_FLUSH_INTERVAL {
            flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
            last_flush_at = Instant::now();
        }
    }
    runtime_log::record_agent_event(
        "info",
        "claude_stdout",
        "claude.stdout_eof",
        "Claude stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        None,
    );
    Ok(())
}

fn non_json_stdout_text(parsed: &ParsedClaudeStdoutLine, line: &str) -> Option<String> {
    if parsed.chunks.is_empty() {
        return None;
    }

    let text = parsed
        .chunks
        .iter()
        .filter_map(|chunk| match chunk {
            AgentChunk::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    if text.is_empty() {
        Some(format!("{line}\n"))
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_for_log_marks_long_output() {
        let text = "x".repeat(2050);
        let truncated = truncate_for_log(&text);

        assert!(truncated.ends_with("\n...[truncated]"));
        assert_eq!(
            truncated
                .trim_end_matches("\n...[truncated]")
                .chars()
                .count(),
            2048
        );
    }

    #[test]
    fn non_json_stdout_text_drops_malformed_claude_skill_event() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: C:\Users\Administrator\AppData\Local\Temp\claude\bundled-skills\2.1.199\2e69ace9e17316f996ad08e77f1a5312\claude-api\n\n# Building LLM-Powered Applications with Claude"}]}}"#;
        let mut state = ClaudeStreamState::default();
        let parsed = parse_claude_stdout_line_with_state("thread_1", line, &mut state);

        assert!(parsed.value.is_none());
        assert!(parsed.chunks.is_empty());
        assert_eq!(non_json_stdout_text(&parsed, line), None);
    }

    #[test]
    fn non_json_stdout_text_keeps_plain_stdout() {
        let parsed = ParsedClaudeStdoutLine {
            value: None,
            session_id: None,
            chunks: vec![AgentChunk::Text {
                thread_id: "thread_1".to_string(),
                text: "plain progress\n".to_string(),
            }],
        };

        assert_eq!(
            non_json_stdout_text(&parsed, "plain progress"),
            Some("plain progress\n".to_string())
        );
    }
}
