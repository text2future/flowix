use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use tokio::io::BufReader;

use super::events::{parse_claude_stdout_line_with_state, ClaudeStreamState};
use super::{truncate_for_log, AGENT_TYPE};
use crate::agent_external::{
    emit_chunk_with_run_id, read_capped_line, ExternalRunRegistry, StreamingEmitBuffer,
    MAX_STDOUT_LINE_BYTES, STREAM_FLUSH_INTERVAL, STREAM_FLUSH_MAX_BYTES,
};
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;

/// flush `emit_buf` 的全部缓冲 chunk 并逐条 emit。空缓冲为 no-op。
fn flush_emit_buffer(
    app_handle: &tauri::AppHandle,
    emit_buf: &mut StreamingEmitBuffer,
    run_id: &str,
) {
    if emit_buf.is_empty() {
        return;
    }
    for chunk in emit_buf.flush() {
        emit_chunk_with_run_id(app_handle, &chunk, AGENT_TYPE, run_id);
    }
}

/// burst 保险 ── 缓冲超过 [`STREAM_FLUSH_MAX_BYTES`] 时立即 flush 并重置帧计时,
/// 防止持续高速文本流时缓冲无限增长。正常一帧的文本量远小于此阈值, 只有
/// read_capped_line 持续返回高频 text 行的极端 burst 才会触达。
fn flush_emit_buffer_if_full(
    app_handle: &tauri::AppHandle,
    emit_buf: &mut StreamingEmitBuffer,
    run_id: &str,
    last_flush_at: &mut Instant,
) {
    if emit_buf.pending_bytes() >= STREAM_FLUSH_MAX_BYTES {
        flush_emit_buffer(app_handle, emit_buf, run_id);
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
    // tool_use_id -> tool_name 跨行映射。ToolCall chunk 发出时记录 id->name,
    // 后续 ToolResult chunk 到达时用它填入真实工具名,避免前端 name="" fallback "unknown tool"。
    let mut tool_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // partial 模式跨行状态 ── 累积 tool_use 的 input_json_delta 分片, 在
    // content_block_stop flush 成 ToolCall。见 events::ClaudeStreamState。
    let mut stream_state = ClaudeStreamState::default();
    // 帧级文本合并 buffer ── 把高频 Text / Reasoning 攒批, 减少 agent-chunk IPC
    // emit 次数 (见 StreamingEmitBuffer doc)。Text/Reasoning 进 buffer; 其它 chunk
    // 先 flush 再 emit, 保证呈现顺序。
    let mut emit_buf = StreamingEmitBuffer::new(thread_id.clone());
    // 帧级 flush 计时 ── 与前端 rAF 帧率 (~16ms) 对齐。每读完一整行检查 elapsed,
    // burst 期间约每帧 flush 一次。
    //
    // 不用 select! + interval: read_capped_line 读 > BufReader 容量 (8 KiB) 的长行
    // 时会跨多次 fill_buf 累积 out, select! 在中途 drop 其 future 会丢失已累积的部分
    // 行 (reader cursor 已 consume 但 out 被丢), 导致大 tool_result 行损坏 -> JSON
    // 解析失败被当 non_json 文本回显。"行末时间检查"在 read_capped_line 完整返回一
    // 行后才检查时间, 零 drop 风险。
    let mut last_flush_at = Instant::now();

    loop {
        let line_opt = match read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await {
            Ok(opt) => opt,
            Err(err) => {
                // 管道异常: 尽量 flush 已收到的文本再上抛。
                flush_emit_buffer(&app_handle, &mut emit_buf, &run_id);
                return Err(err);
            }
        };
        let Some((raw, truncated_by_reader)) = line_opt else {
            // EOF: 必须在返回前 flush 残留文本 ── 否则 spawn tail 的
            // emit_stream_end_once 会先于尾部文本到达前端。
            flush_emit_buffer(&app_handle, &mut emit_buf, &run_id);
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
        // dev-only: 把子进程 stdout 原始行镜像到 ~/.flowix/debug/, 1:1 还原
        // vendor CLI 回包供排障。release 构建内 no-op, 不落盘。
        runtime_log::dump_debug_stdout_line(AGENT_TYPE, &thread_id, &run_id, line);
        runs.touch(&thread_id, Some(&run_id)).await;

        let parsed = parse_claude_stdout_line_with_state(&thread_id, line, &mut stream_state);
        let value = match parsed.value {
            Some(value) => value,
            None => {
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
                // 非 JSON 行作为文本回显 ── 进 buffer 合并 (最多延迟一帧)。
                emit_buf.append_text(&format!("{line}\n"));
                flush_emit_buffer_if_full(&app_handle, &mut emit_buf, &run_id, &mut last_flush_at);
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
                // SessionResolved 是非文本 chunk ── 先 flush 文本 buffer, 保证它之前
                // 的文本先落地, 再 emit。
                flush_emit_buffer(&app_handle, &mut emit_buf, &run_id);
                last_flush_at = Instant::now();
                emit_chunk_with_run_id(
                    &app_handle,
                    &AgentChunk::SessionResolved {
                        thread_id: thread_id.clone(),
                        session_id: session_id.clone(),
                    },
                    AGENT_TYPE,
                    &run_id,
                );
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
                        &mut emit_buf,
                        &run_id,
                        &mut last_flush_at,
                    );
                }
                AgentChunk::Reasoning { text, .. } => {
                    emit_buf.append_reasoning(&text);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &mut emit_buf,
                        &run_id,
                        &mut last_flush_at,
                    );
                }
                mut chunk => {
                    // 非文本 chunk ── 先 flush 文本 buffer, 保证
                    // text -> tool_call -> text -> tool_result 的呈现顺序, 再 emit。
                    flush_emit_buffer(&app_handle, &mut emit_buf, &run_id);
                    last_flush_at = Instant::now();
                    // ToolCall 发出前记录 id -> name
                    if let AgentChunk::ToolCall {
                        ref id, ref name, ..
                    } = chunk
                    {
                        if !id.is_empty() && !name.is_empty() {
                            tool_names.insert(id.clone(), name.clone());
                        }
                    }
                    // ToolResult 用 tool_use_id 查回真实工具名,填入 name 字段
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
                    emit_chunk_with_run_id(&app_handle, &chunk, AGENT_TYPE, &run_id);
                }
            }
        }

        // 帧级 flush ── 这一行处理完, 若距上次 flush 已过一帧, 落地缓冲文本。
        // burst 期间约每 16ms flush 一次 (与前端 rAF 对齐); 非文本 chunk 已在上面
        // 强制 flush, 这里主要兜持续文本流的攒批。行流停顿时 read_capped_line 阻塞,
        // 缓冲里最多残留一帧文本, 由下一行 / EOF / 工具调用触发落地。
        if last_flush_at.elapsed() >= STREAM_FLUSH_INTERVAL {
            flush_emit_buffer(&app_handle, &mut emit_buf, &run_id);
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
}
