use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;
use rllm::chat::ChatMessage as LlmChatMessage;

use crate::external_runtime::{emit_chunk_with_run_id, resolve_run_id};
use crate::providers::OpenAICompatibleStreamItem;
use crate::runtime_log;

use super::persistence::IsLoadingGuard;
use super::state::{InFlightChat, STUCK_THRESHOLD};
use super::wire::FLOWIX_AGENT_TYPE;
use super::{AgentChunk, AgentError, AgentManager, AgentUserMessage, UsageInfo};

const MAX_LLM_RECOVERY_RETRIES: u32 = 2;

/// True if the LLM gateway's error message indicates a recoverable
/// tool-arguments problem (typically: 400 with concatenated/garbled JSON
/// from a prior turn). The recovery loop's sanitize-and-retry path is
/// only entered when this returns true; for other 4xx/5xx (auth, rate
/// limit, server) we synthesize and end immediately.
fn is_recoverable_args_error(reason: &str) -> bool {
    reason.contains("invalid function arguments") || reason.contains("tool_call_id")
}

/// Build the user-facing message for an LLM-side failure. Pure function —
/// extracted from `synthesize_llm_unavailable` so it can be unit-tested
/// without a Tauri `AppHandle`. The reason is taken verbatim (callers
/// strip any wrapper prefix before calling).
pub(super) fn format_llm_unavailable_message(reason: &str) -> String {
    format!("(LLM 暂时不可用, 原因: {})", reason)
}

impl AgentManager {
    /// Common end-of-cycle exit. Emits the message as a `Text` chunk
    /// (so the frontend appends it to / creates the assistant message via
    /// the `text` case at chat-store.ts:280), persists the same text as
    /// a `role: assistant` row, clears the stuck-detection counter, and
    /// returns `Ok(msg)`. Used by `synthesize_llm_unavailable`, the
    /// `Stuck` abort site, and the `MaxCycles` abort site — all three
    /// were doing the same shape before this helper existed.
    pub(super) async fn finalize_with_synthesized_message(
        &self,
        thread_id: &str,
        msg: String,
        app_handle: &tauri::AppHandle,
        run_id: &str,
    ) -> Result<String, AgentError> {
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: msg.clone(),
            },
            FLOWIX_AGENT_TYPE,
            run_id,
        );
        self.flush_assistant_message(thread_id, &msg).await?;
        self.clear_tool_call_attempts(thread_id).await;
        Ok(msg)
    }

    /// Graceful exit for LLM-side failures. Builds the user-facing
    /// message, logs a warn, and delegates to
    /// `finalize_with_synthesized_message`. Use this for any
    /// `chat_stream_tagged` / mid-stream error path so the chat doesn't
    /// end in a hard error toast.
    pub(super) async fn synthesize_llm_unavailable(
        &self,
        thread_id: &str,
        reason: &str,
        app_handle: &tauri::AppHandle,
        run_id: &str,
    ) -> Result<String, AgentError> {
        let synth_msg = format_llm_unavailable_message(reason);
        tracing::warn!("[Agent] LLM unavailable, synthesizing assistant message: {synth_msg}");
        self.finalize_with_synthesized_message(thread_id, synth_msg, app_handle, run_id)
            .await
    }

    /// Outer entry — registers a per-thread cancel flag, **spawns** the inner
    /// implementation onto tokio, and immediately returns. The spawned task
    /// owns the cancel-flag lifecycle (insert / remove + emit `StreamStart`
    /// / `StreamEnd`) so every exit path of the inner loop is observable to
    /// the frontend through chunks rather than the IPC return value.
    ///
    /// Background-running model: when a user creates a new conversation
    /// while thread A is still streaming, we **don't** await A's completion.
    /// The IPC returns `Ok("")` immediately and A keeps running in the
    /// background. The frontend's chunk listener dispatches incoming
    /// `agent-chunk` events to `threadStates[tid]`, so re-entering thread A
    /// shows the latest in-progress content. UI state (`isLoading`) is
    /// driven by `StreamStart` / `StreamEnd` chunks rather than the IPC
    /// `finally` block (which would only fire when the **active** thread
    /// finishes).
    ///
    /// **Self-interrupt**: if a chat is already in-flight for this
    /// `thread_id` (e.g. user sent two messages in a row before the first
    /// one finished), the existing cancel flag is `store(true)`'d before
    /// the new one is installed. The old chat's ReAct loop hits a
    /// checkpoint, runs `flush_cancel`, and exits via the normal
    /// StreamEnd path — guaranteeing at most one in-flight chat per
    /// thread_id at any time, even under user double-click. The old task
    /// only unregisters itself if the registry still points at its own
    /// cancel flag, so it cannot tear down a newer run.
    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, AgentError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let run_id = resolve_run_id(thread_id, message.run_id.as_deref());
        {
            let mut in_flight = self.in_flight.lock().await;
            // 自打断: 如果该 thread 已有 in-flight chat, 先 set true
            // 让旧 chat 在下一个 checkpoint 走 flush_cancel, 再 install
            // 新 run。旧 task 退出时只会通过 Arc::ptr_eq 清理自己的 entry,
            // 不会误删新 task 的 registry。
            if let Some(old) = in_flight.remove(thread_id) {
                old.cancel.store(true, Ordering::Release);
                tracing::info!(
                    "[Agent] self-interrupt for thread_id {thread_id} (previous chat in flight)"
                );
            }
            in_flight.insert(
                thread_id.to_string(),
                InFlightChat {
                    cancel: cancel.clone(),
                    started_at: chrono::Utc::now().timestamp_millis(),
                    run_id: run_id.clone(),
                },
            );
        }

        // 通用 metadata 协议 ── StreamStart 携带 model / reasoning_effort,
        // 该 run 锁定。前端 hover card / 状态栏可读这两个字段展示。
        // 旧 provider 不识别时为 None,前端 fallback 到全局配置 / 显示 "—」。
        //
        // `run_id` 通过 `resolve_run_id` 统一来源 ── 前端传就用前端的,
        // 没传就 mint 一个 (跟 CLI managers 同形)。这保证每个 chunk 都带
        // run_id, 前端 mapper 不再 fallback 到 `st.activeRunId`, self-interrupt
        // 时旧 run 的 StreamEnd 不会被误归到新 run。
        let agent_type = message.agent_type.as_deref().unwrap_or("flowix");
        let model = message.model_for_runtime(agent_type).map(str::to_string);
        let reasoning_effort = message
            .reasoning_effort_for_runtime(agent_type)
            .map(str::to_string);
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::StreamStart {
                thread_id: thread_id.to_string(),
                model,
                reasoning_effort,
            },
            FLOWIX_AGENT_TYPE,
            &run_id,
        );

        // spawn 后 IPC 立即返回, 不再 await 整个 stream 跑完。
        // 失败 / 完成 / 取消信号全靠 `agent-chunk` 事件 (包括 `Error`
        // 和 `StreamEnd`), 前端 store 按 thread_id 派发到对应 thread。
        //
        // `me: Arc<Self>` ── 把 self 的 Arc clone 一份喂给 spawn task,
        // 任务在 self 之后 (e.g. AppState drop) 才结束, refcount 自然
        // 收敛。这是借用 self 给异步任务的标准做法, 避免在 struct 里
        // 存 Weak<Self> 那套循环引用。
        let me: Arc<AgentManager> = Arc::clone(self);
        let tid_owned = thread_id.to_string();
        let app_handle_owned = app_handle.clone();
        let cancel_for_task = cancel.clone();
        let run_id_owned = run_id.clone();
        tokio::spawn(async move {
            let result = me
                .chat_stream_inner(
                    &tid_owned,
                    message,
                    &app_handle_owned,
                    &cancel_for_task,
                    run_id_owned.clone(),
                )
                .await;

            // 任何路径退出都要 unregister + emit StreamEnd。任务结束前
            // 先清 in_flight, 最后 emit ── 前端收到 StreamEnd 时, 我们
            // 的 in-memory 状态已经归零, 任何
            // 立即触发的 `agent_running_threads` 查询都看不到这个 thread
            // (与"stream 真结束了"的语义一致)。
            me.unregister_in_flight_if_current(&tid_owned, &cancel_for_task)
                .await;
            let reason = match &result {
                Ok(_) => None,
                Err(e) => Some(e.to_string()),
            };
            emit_chunk_with_run_id(
                &app_handle_owned,
                &AgentChunk::StreamEnd {
                    thread_id: tid_owned.clone(),
                    reason,
                },
                FLOWIX_AGENT_TYPE,
                &run_id_owned,
            );
        });

        Ok(String::new())
    }

    /// Inner implementation — the actual ReAct loop with three cancel
    /// checkpoints. Does NOT touch `in_flight` directly; the outer
    /// `chat_stream` owns registration lifecycle.
    ///
    /// Cancel checkpoints:
    ///   #1. Top of `for _cycle` — between cycles, before reload. Catches
    ///       "user clicked stop right after a tool-call cycle's flush".
    ///   #2. Top of `while let Some(item) = stream.next().await` — mid-
    ///       stream. Returning here drops `stream` and aborts the HTTP
    ///       connection.
    ///   #3. After the inner while loop — after stream is exhausted,
    ///       before the final-return or next-cycle decision. Catches
    ///       "user clicked stop right after the last chunk arrived".
    ///
    /// All three sites funnel into `flush_cancel`, which mirrors the
    /// existing `finalize_with_synthesized_message` shape (flush partial
    /// buffers, emit a final chunk, clear tool-call attempts) but with
    /// the user-cancellation message instead of an LLM-unavailable one.
    pub(super) async fn chat_stream_inner(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        cancel: &Arc<AtomicBool>,
        run_id: String,
    ) -> Result<String, AgentError> {
        let mut ai_config = self.user_config.get_ai_config().model;
        let agent_type = message.agent_type.as_deref().unwrap_or("flowix");
        if let Some(model) = message.model_for_runtime(agent_type) {
            if !model.trim().is_empty() {
                ai_config.model = model.to_string();
            }
        }
        let instance = if let Some(role_section) = self.agent_role_system_section(&message) {
            // Runtime Agent Role takes the role slot — base_system_prompt
            // omits the default static role section in this branch, keeping
            // exactly one role block in the final prompt (mutual exclusion
            // with [`crate::prompt::role::section`]).
            let system_prompt = self.base_system_prompt(&ai_config, Some(&role_section));
            self.build_instance_with_system_prompt(&ai_config, system_prompt)?
        } else {
            self.ensure_instance(&ai_config).await?
        };

        self.persist_user_message(thread_id, &message).await?;
        // 兜底清空该 thread 的卡死检测计数。LLM 给最终回答的正常路径也会清,
        // 这里只兜异常退出 (stuck / 100 cycle 上限 / stream error) 后用户重发
        // 同一 thread 的场景, 避免上次的计数污染新一轮。
        self.clear_tool_call_attempts(thread_id).await;
        // 用户消息已落盘, 下面的 ReAct 循环第一轮 reload 会读到。
        // load_thread_llm_messages 现在直接返回 rllm 的 ChatMessage 序列, 包含
        // tool_use / tool_result。每轮 cycle 顶部再 reload 一次拿到最新落盘状态。
        #[allow(unused_assignments)]
        let mut llm_messages: Vec<LlmChatMessage> = Vec::new();

        // React loop with streaming
        let max_cycles = 100;
        let mut full_response = String::new();
        let mut reasoning_buffer = String::new();
        let mut assistant_buffer = String::new();
        // Tracked across cycles so the MaxCycles error message can name
        // the last tool the LLM was stuck on.
        let mut last_tool_name: Option<String> = None;

        // ── Token 预算: 跨 cycle 累计 total_tokens, 超过配置上限立刻熔断。──
        // budget=0 表示不限 (旧 config 行为, 也方便单测)。Usage chunk 由
        // provider 在每个流末尾单独 push 一次, 不会重复计数 ── 这是把
        // 之前 "Usage 解析后完全没用" 的死字段从 provider 层穿透出来的目的。
        // 注意: OpenAI 的 `prompt_tokens` 在 stream+include_usage 模式下是
        // **累计**的 (整个 thread 的输入), 不是单轮 ── 我们的累计是有意为之。
        let token_budget = self.user_config.get_ai_config().model.max_total_tokens;
        let mut tokens_used: u32 = 0;

        tracing::debug!("[Agent] Starting chat_stream for thread_id: {}", thread_id);

        for _cycle in 0..max_cycles {
            // ── Checkpoint #1: between cycles, before reload. ──
            if cancel.load(Ordering::Acquire) {
                return self
                    .flush_cancel(
                        thread_id,
                        reasoning_buffer,
                        assistant_buffer,
                        full_response,
                        app_handle,
                        &run_id,
                    )
                    .await;
            }

            // 每轮从盘上 reload, 拿到本轮 (含上轮) 新落盘的 assistant(tool_calls) +
            // tool(result) 行, 作为下轮 LLM 调用的真实上下文。这样 disk 是唯一真源,
            // 不需要再在循环里手动 push ToolUse/ToolResult 到 llm_messages。
            llm_messages = self.load_thread_llm_messages(thread_id).await?;
            reasoning_buffer.clear();
            assistant_buffer.clear();
            let mut hit_tool_call = false;
            // Bounded retry loop for LLM-side 400 rejections. When the
            // provider returns "invalid function arguments json string" it
            // means a previous round's persisted `tool_calls[*].function.arguments`
            // is unparseable JSON (root cause: the parallel-call parser
            // collision — see `openai_compatible.rs`; the recovery exists
            // as a safety net in case a future parser bug or a corrupted
            // thread DB lands us in the same place). We sanitize the
            // affected message in place and retry, up to N times.
            let mut recovery_attempts: u32 = 0;
            let mut stream = loop {
                match instance
                    .provider
                    .chat_stream_tagged(&llm_messages, Some(&instance.tools))
                    .await
                {
                    Ok(s) => break s,
                    Err(e) => {
                        let reason = e.to_string();
                        // Two reasons to bail: (a) the error isn't a
                        // recoverable tool-args error, or (b) we've
                        // already retried the maximum number of times.
                        let can_retry = recovery_attempts < MAX_LLM_RECOVERY_RETRIES
                            && is_recoverable_args_error(&reason);
                        if !can_retry {
                            // 持久化 LLM 流断原因 (auth / 4xx / 5xx / network
                            // 等), 便于排障: tracing 日志在进程退出后即丢,
                            // 写 ~/.flowix/logs/agent.log 才能在用户事后反馈
                            // "刚才那条消息没回" 时回溯。
                            runtime_log::record_agent_event(
                                "error",
                                "llm_stream",
                                "llm.stream_failed",
                                format!("LLM stream request failed: {e}"),
                                Some(thread_id),
                                None,
                                Some(serde_json::json!({
                                    "is_recoverable_args_error": is_recoverable_args_error(&reason),
                                    "recovery_attempts": recovery_attempts,
                                })),
                            );
                            return self
                                .synthesize_llm_unavailable(
                                    thread_id,
                                    &format!("Stream failed: {}", e),
                                    app_handle,
                                    &run_id,
                                )
                                .await;
                        }
                        // Sanitize the corrupted row and retry once.
                        match self.sanitize_persisted_tool_calls(thread_id).await {
                            Ok(true) => {
                                recovery_attempts += 1;
                                let progress = format!(
                                    "LLM rejected turn due to malformed tool_calls; \
                                     sanitized and retrying ({recovery_attempts}/{MAX_LLM_RECOVERY_RETRIES})"
                                );
                                tracing::warn!("[Agent] {progress}");
                                // 记录 sanitize-and-retry 事件 ── 这条不是
                                // 终态错误 (LLM 仍有机会正常收口), 但
                                // 频繁出现意味着 tool_calls 持久化层有 bug
                                // (见 `openai_compatible.rs` 的 parallel-call
                                // 解析), 事后查 agent.log 能定位到具体 thread。
                                runtime_log::record_agent_event(
                                    "warn",
                                    "recovery_retry",
                                    "llm.sanitize_retry",
                                    progress.clone(),
                                    Some(thread_id),
                                    None,
                                    Some(serde_json::json!({
                                        "recovery_attempts": recovery_attempts,
                                        "max_recovery_attempts": MAX_LLM_RECOVERY_RETRIES,
                                    })),
                                );
                                emit_chunk_with_run_id(
                                    app_handle,
                                    &AgentChunk::Error {
                                        thread_id: thread_id.to_string(),
                                        message: progress,
                                    },
                                    FLOWIX_AGENT_TYPE,
                                    &run_id,
                                );
                                llm_messages = self.load_thread_llm_messages(thread_id).await?;
                                continue;
                            }
                            // Nothing to sanitize, or the sanitize itself
                            // failed — either way the gateway's complaint
                            // isn't fixable from the agent side.
                            Ok(false) | Err(_) => {
                                runtime_log::record_agent_event(
                                    "error",
                                    "llm_stream",
                                    "llm.stream_failed",
                                    format!("LLM stream request failed: {e}"),
                                    Some(thread_id),
                                    None,
                                    Some(serde_json::json!({
                                        "is_recoverable_args_error": true,
                                        "sanitize_attempted": true,
                                        "sanitize_result": "no_change_or_failed",
                                        "recovery_attempts": recovery_attempts,
                                    })),
                                );
                                return self
                                    .synthesize_llm_unavailable(
                                        thread_id,
                                        &format!("Stream failed: {}", e),
                                        app_handle,
                                        &run_id,
                                    )
                                    .await;
                            }
                        }
                    }
                }
            };

            // Process stream items — OpenAICompatibleStreamItem 区分 reasoning vs text,
            // 直接发结构化 AgentChunk 给前端, 走 switch 路径而非 startsWith。
            while let Some(item_result) = stream.next().await {
                // ── Checkpoint #2: mid-stream, before each poll. ──
                // Returning here drops `stream`, which aborts the in-flight
                // HTTP connection (reqwest's `bytes_stream` semantics).
                if cancel.load(Ordering::Acquire) {
                    return self
                        .flush_cancel(
                            thread_id,
                            reasoning_buffer,
                            assistant_buffer,
                            full_response,
                            app_handle,
                            &run_id,
                        )
                        .await;
                }
                match item_result {
                    Ok(item) => {
                        match item {
                            OpenAICompatibleStreamItem::Usage {
                                total_tokens,
                                input_tokens,
                                cached_input_tokens,
                                output_tokens,
                                reasoning_output_tokens,
                                model_context_window,
                            } => {
                                // 通用 metadata 协议 ── 把 usage 推给前端,
                                // 前端累加到 `AgentRunState.usage` / thread 累计。
                                // 不论是否触发 budget 熔断, 都 emit 一次,
                                // 让前端能看到每 turn 的 token 增量。
                                let usage = UsageInfo {
                                    input_tokens,
                                    cached_input_tokens,
                                    output_tokens,
                                    reasoning_output_tokens,
                                    total_tokens: Some(total_tokens),
                                    model_context_window,
                                };
                                emit_chunk_with_run_id(
                                    app_handle,
                                    &AgentChunk::Usage {
                                        thread_id: thread_id.to_string(),
                                        model_id: None,
                                        last_run_at: None,
                                        usage: Some(usage),
                                        status_info: None,
                                    },
                                    FLOWIX_AGENT_TYPE,
                                    &run_id,
                                );
                                // saturating_add 防御性: 单次 Usage 字段极端大时
                                // 也只是卡在 u32::MAX, 不会 panic / wrap 成小数。
                                tokens_used = tokens_used.saturating_add(total_tokens);
                                if token_budget > 0 && tokens_used > token_budget {
                                    let err = AgentError::TokenBudget {
                                        used: tokens_used,
                                        budget: token_budget,
                                    };
                                    let err_msg = err.to_string();
                                    tracing::warn!("[Agent] {err_msg}");
                                    // 持久化 token 预算熔断 ── 用户事后反馈
                                    // "agent 用一半就停了" 第一时间查 agent.log
                                    // 定位是不是预算到了, 而不是反复跑同样
                                    // 的对话试错。
                                    runtime_log::record_agent_event(
                                        "warn",
                                        "token_budget",
                                        "llm.token_budget_exceeded",
                                        err_msg.clone(),
                                        Some(thread_id),
                                        None,
                                        Some(serde_json::json!({
                                            "tokens_used": tokens_used,
                                            "token_budget": token_budget,
                                        })),
                                    );
                                    // 与 Stuck 用同一条 finalize 路径: emit Error
                                    // chunk (前端 switch 走 error case), 写一行
                                    // 助手文本 (UI 看起来正常收口而非崩溃 toast),
                                    // 然后清掉 stuck-detect 计数。
                                    emit_chunk_with_run_id(
                                        app_handle,
                                        &AgentChunk::Error {
                                            thread_id: thread_id.to_string(),
                                            message: err_msg.clone(),
                                        },
                                        FLOWIX_AGENT_TYPE,
                                        &run_id,
                                    );
                                    return self
                                        .finalize_with_synthesized_message(
                                            thread_id,
                                            format!(
                                                "(agent aborted — {err_msg}). \
                                                 Split the request into smaller pieces \
                                                 or raise `max_total_tokens` in \
                                                 Preferences → Agent."
                                            ),
                                            app_handle,
                                            &run_id,
                                        )
                                        .await;
                                }
                            }
                            OpenAICompatibleStreamItem::Text(text) => {
                                tracing::debug!("[Agent] Emitting text chunk: {}", text);
                                emit_chunk_with_run_id(
                                    app_handle,
                                    &AgentChunk::Text {
                                        thread_id: thread_id.to_string(),
                                        text: text.clone(),
                                    },
                                    FLOWIX_AGENT_TYPE,
                                    &run_id,
                                );
                                assistant_buffer.push_str(&text);
                                full_response.push_str(&text);
                            }
                            OpenAICompatibleStreamItem::Reasoning(text) => {
                                tracing::debug!("[Agent] Emitting reasoning chunk: {}", text);
                                emit_chunk_with_run_id(
                                    app_handle,
                                    &AgentChunk::Reasoning {
                                        thread_id: thread_id.to_string(),
                                        text: text.clone(),
                                    },
                                    FLOWIX_AGENT_TYPE,
                                    &run_id,
                                );
                                reasoning_buffer.push_str(&text);
                            }
                            OpenAICompatibleStreamItem::ToolUseComplete { tool_call } => {
                                self.flush_reasoning_message(thread_id, &reasoning_buffer)
                                    .await?;
                                reasoning_buffer.clear();
                                // 把 assistant_buffer 里的前导文本与本轮 tool_call 合并
                                // 到同一行 (OpenAI 协议本来就是一条 message 带 content +
                                // tool_calls)。不调 flush_assistant_message 是为了避免
                                // 紧接着再写一条空的 assistant 行。
                                self.flush_assistant_message_with_tool_calls(
                                    thread_id,
                                    &assistant_buffer,
                                    std::slice::from_ref(&tool_call),
                                )
                                .await?;
                                assistant_buffer.clear();

                                // Parse the LLM-supplied JSON arguments. If they
                                // are unparseable we still must ship valid JSON
                                // to the LLM on the next round-trip; falling back
                                // to the literal string would persist a
                                // `Value::String(...)` and the gateway rejects
                                // the next turn with 400 "invalid function
                                // arguments". An empty `{}` is the safest
                                // alternative: the LLM sees a tool call happened
                                // with no args and can react to the synthesized
                                // tool_result the recovery loop injects.
                                let tool_input = match serde_json::from_str::<serde_json::Value>(
                                    &tool_call.function.arguments,
                                ) {
                                    Ok(v) => v,
                                    Err(e) => {
                                        tracing::warn!(
                                                "[Agent] tool_call {} ({}): arguments not valid JSON ({e}); falling back to {{}}",
                                                tool_call.id,
                                                tool_call.function.name
                                            );
                                        serde_json::Value::Object(serde_json::Map::new())
                                    }
                                };
                                emit_chunk_with_run_id(
                                    app_handle,
                                    &AgentChunk::ToolCall {
                                        thread_id: thread_id.to_string(),
                                        id: tool_call.id.clone(),
                                        name: tool_call.function.name.clone(),
                                        input: tool_input.clone(),
                                    },
                                    FLOWIX_AGENT_TYPE,
                                    &run_id,
                                );
                                self.persist_tool_call(
                                    thread_id,
                                    &tool_call.id,
                                    &tool_call.function.name,
                                    tool_input,
                                )
                                .await?;

                                // Drop guard: 包住 execute_tool + emit + persist
                                // 这段。任一步 panic / 提前 return / 新错误路径
                                // 触发 drop ── 自动把对应 tool 行的 is_loading
                                // 归零, 不让 UI 转圈卡死。
                                let _loading_guard = IsLoadingGuard::new(
                                    self.thread_manager.clone(),
                                    thread_id,
                                    &tool_call.id,
                                );

                                // Execute tool call
                                let tool_result = self
                                    .execute_tool_for_thread(
                                        thread_id,
                                        &tool_call.function.name,
                                        &tool_call.function.arguments,
                                    )
                                    .await;
                                emit_chunk_with_run_id(
                                    app_handle,
                                    &AgentChunk::ToolResult {
                                        thread_id: thread_id.to_string(),
                                        id: tool_call.id.clone(),
                                        name: tool_call.function.name.clone(),
                                        result: serde_json::to_value(&tool_result)
                                            .unwrap_or(serde_json::Value::Null),
                                    },
                                    FLOWIX_AGENT_TYPE,
                                    &run_id,
                                );
                                let result_json = serde_json::to_string_pretty(&tool_result)
                                    .unwrap_or_else(|_| {
                                        r#"{"error":"serialization failed"}"#.to_string()
                                    });
                                self.persist_tool_result(
                                    thread_id,
                                    &tool_call.id,
                                    &tool_call.function.name,
                                    &result_json,
                                )
                                .await?;

                                // Track for MaxCycles error message
                                // (named when the loop bails).
                                last_tool_name = Some(tool_call.function.name.clone());

                                // 同一 (tool, args) 连续调用 STUCK_THRESHOLD 次就熔断。
                                // 计数 + 比较放一起避免竞态。触发时给前端发个 Error 块,
                                // 让用户看到中断原因, 再 return Err 走前端 catch 路径。
                                let stuck = self
                                    .record_tool_call(
                                        thread_id,
                                        &tool_call.function.name,
                                        &tool_call.function.arguments,
                                    )
                                    .await;
                                if stuck {
                                    let err = AgentError::Stuck {
                                        tool: tool_call.function.name.clone(),
                                        count: STUCK_THRESHOLD + 1,
                                    };
                                    let err_msg = err.to_string();
                                    tracing::warn!("[Agent] {}", err_msg);
                                    // 持久化 stuck 事件 ── `tool` + `count`
                                    // 一起写, 排障时能直接看到"用户在哪个工具
                                    // 上把 LLM 卡住了"(e.g. 一直 read 同
                                    // 一个文件)。`arguments` 不写文件 (可能
                                    // 很长且含敏感数据), 真要回溯靠
                                    // thread.db 的 tool_calls 列。
                                    runtime_log::record_agent_event(
                                        "warn",
                                        "stuck",
                                        "agent.stuck",
                                        err_msg.clone(),
                                        Some(thread_id),
                                        Some(&tool_call.function.name),
                                        Some(serde_json::json!({
                                            "count": STUCK_THRESHOLD + 1,
                                            "threshold": STUCK_THRESHOLD,
                                        })),
                                    );
                                    // Flush a synthesized final assistant
                                    // message to disk and return Ok so the
                                    // user sees a normal-looking completion
                                    // in the UI rather than an "Agent
                                    // crashed" toast. The user can
                                    // immediately send a new prompt.
                                    let synth_msg = format!(
                                        "(agent aborted — {}). Try rephrasing the request \
                                         or check that the file path is correct.",
                                        err_msg
                                    );
                                    return self
                                        .finalize_with_synthesized_message(
                                            thread_id, synth_msg, app_handle, &run_id,
                                        )
                                        .await;
                                }

                                // tool_use / tool_result 已通过 flush_assistant_message_with_tool_calls
                                // + persist_tool_call / persist_tool_result 落盘, 下轮 cycle
                                // 顶部的 reload_thread_llm_messages 会读到, 这里不再手动 push。

                                // Continue to next iteration to get final response
                                hit_tool_call = true;
                                break;
                            }
                            OpenAICompatibleStreamItem::Done { .. } => {
                                // Stream ended — no-op, 循环自然退出
                            }
                        }
                    }
                    Err(e) => {
                        // Mid-stream failure (network blip, provider 5xx,
                        // socket close, etc.). The tool_use/tool_result
                        // for this cycle are already persisted (see the
                        // ToolUseComplete arm), so the thread state is
                        // consistent; we just need to end the cycle.
                        // Synthesize an assistant message and return Ok.
                        // 与初始 request 失败不同, 这条是流到一半断的 ──
                        // 部分 tokens 已经花在 reasoning / text / 工具
                        // 调用上, 用户重发时会接着上次的中断点继续
                        // (thread.db 是真源)。 错误本身仍然是 LLM
                        // 不可用, 走同一条 synthesize 路径, 但日志上
                        // kind 标 `llm_stream_mid` 区分前后。
                        runtime_log::record_agent_event(
                            "error",
                            "llm_stream_mid",
                            "llm.stream_mid_error",
                            format!("LLM stream errored mid-flight: {e}"),
                            Some(thread_id),
                            None,
                            None,
                        );
                        return self
                            .synthesize_llm_unavailable(
                                thread_id,
                                &format!("Stream error: {}", e),
                                app_handle,
                                &run_id,
                            )
                            .await;
                    }
                }
            }

            // ── Checkpoint #3: after stream exhausted, before the
            //    final-return vs. next-cycle decision. ── Returning
            //    here drops `stream` cleanly (no more items, but the
            //    connection is still alive at the provider).
            if cancel.load(Ordering::Acquire) {
                return self
                    .flush_cancel(
                        thread_id,
                        reasoning_buffer,
                        assistant_buffer,
                        full_response,
                        app_handle,
                        &run_id,
                    )
                    .await;
            }

            // Continue only when this cycle actually executed a tool. A cycle without
            // tool calls is the completion signal for the current ReAct task.
            if !hit_tool_call {
                // LLM 给出最终回答, 视为完成一次完整任务, 清空卡死检测计数。
                self.clear_tool_call_attempts(thread_id).await;
                self.flush_reasoning_message(thread_id, &reasoning_buffer)
                    .await?;
                self.flush_assistant_message(thread_id, &assistant_buffer)
                    .await?;
                return Ok(full_response);
            }
        }

        // 循环跑满 max_cycles 还没 return, 说明 LLM 一直在调工具没给最终回答。
        // 合成一条最终的 assistant 消息落盘并 emit, 让用户看到正常结束而不是
        // "agent crashed" 弹窗, 然后返回 Ok。
        let last_tool = last_tool_name
            .as_deref()
            .map(|n| format!(" Last tool: `{}`.", n))
            .unwrap_or_default();
        let synth_msg = format!(
            "(agent aborted after {max_cycles} tool-call cycles without a final answer).{last_tool} \
             Try a more specific prompt."
        );
        tracing::warn!("[Agent] agent exceeded max cycles ({max_cycles})");
        // 持久化 max-cycles 熔断 ── `last_tool` 一起写, 配合 thread.db
        // 里的 tool_calls 链能复盘 LLM 为什么"一直调工具不收口"。
        runtime_log::record_agent_event(
            "warn",
            "max_cycles",
            "agent.max_cycles",
            format!("agent exceeded max cycles ({max_cycles})"),
            Some(thread_id),
            last_tool_name.as_deref(),
            Some(serde_json::json!({
                "max_cycles": max_cycles,
            })),
        );
        return self
            .finalize_with_synthesized_message(thread_id, synth_msg, app_handle, &run_id)
            .await;
    }

    /// 取消 helper — `chat_stream_inner` 三个 cancel 站点共用的退出形状。
    /// 与 `finalize_with_synthesized_message` 对称, 但用「用户主动停止」的
    /// 文案 (`_(已停止生成)_`), 不用 LLM 不可用的模板。
    ///
    /// 把 suffix 拼到 `assistant_buffer` 末尾再 `flush_assistant_message`
    /// 落盘, 同时 emit 一个独立的 `Text` chunk 给前端 (UI 把它当普通 text
    /// 追加, 跟用户看到的实时流体验一致 ── 不再需要新事件类型)。
    pub(super) async fn flush_cancel(
        &self,
        thread_id: &str,
        reasoning_buffer: String,
        assistant_buffer: String,
        full_response: String,
        app_handle: &tauri::AppHandle,
        run_id: &str,
    ) -> Result<String, AgentError> {
        const STOPPED_SUFFIX: &str = "_(已停止生成)_";
        tracing::info!(
            "[Agent] chat cancelled by user for thread_id: {}",
            thread_id
        );
        // 推理模型会先 reasoning 再 text, 中断时要保留思考痕迹。
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, &reasoning_buffer)
                .await?;
        }
        // 落盘最终 assistant 行 = 原流式累积 + 停止标记; 同一行 emit 给 UI。
        let final_assistant = format!("{assistant_buffer}{STOPPED_SUFFIX}");
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: STOPPED_SUFFIX.to_string(),
            },
            FLOWIX_AGENT_TYPE,
            run_id,
        );
        // 始终落一条 (哪怕 assistant_buffer 为空), 让 thread 里有明确的
        // 助手结束标记; `flush_assistant_message` 自身有 is_empty 短路,
        // 但我们这里传的是带 suffix 的非空串, 一定落盘。
        self.flush_assistant_message(thread_id, &final_assistant)
            .await?;
        self.clear_tool_call_attempts(thread_id).await;
        Ok(format!("{full_response}{STOPPED_SUFFIX}"))
    }
}
