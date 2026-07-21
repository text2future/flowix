use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;
use rllm::chat::{ChatRole, MessageType};

use crate::agent_external::{emit_chunk_with_run_id, resolve_run_id};
use crate::agent_flowix::providers::{OpenAICompatibleChatMessage, OpenAICompatibleStreamItem};
use crate::runtime_log;

use super::persistence::IsLoadingGuard;
use super::state::{InFlightChat, STUCK_THRESHOLD};
use super::wire::FLOWIX_AGENT_TYPE;
use super::{AgentChunk, AgentError, AgentManager, AgentUserMessage, UsageInfo};

const MAX_LLM_RECOVERY_RETRIES: u32 = 2;
const MAX_AUTO_RESUME_ATTEMPTS: u32 = 1;

#[derive(Debug, Clone)]
struct AssistantCheckpoint {
    message_id: String,
    content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LlmFailureKind {
    RetryableTransport,
    RetryableRateLimit,
    RetryableServer,
    RecoverableHistory,
    FatalAuth,
    FatalRequest,
    FatalContext,
    FatalNotFound,
    Unknown,
}

pub(super) fn classify_llm_failure(reason: &str) -> LlmFailureKind {
    let lower = reason.to_ascii_lowercase();
    if is_recoverable_args_error(&lower) {
        return LlmFailureKind::RecoverableHistory;
    }
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("auth")
        || lower.contains("api key")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
    {
        return LlmFailureKind::FatalAuth;
    }
    if lower.contains("context length")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
        || lower.contains("token limit")
    {
        return LlmFailureKind::FatalContext;
    }
    if lower.contains("404") || lower.contains("not found") || lower.contains("model_not_found") {
        return LlmFailureKind::FatalNotFound;
    }
    if lower.contains("429") || lower.contains("rate limit") || lower.contains("too many requests")
    {
        return LlmFailureKind::RetryableRateLimit;
    }
    if lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("server error")
        || lower.contains("bad gateway")
        || lower.contains("service unavailable")
        || lower.contains("gateway timeout")
    {
        return LlmFailureKind::RetryableServer;
    }
    if lower.contains("400")
        || lower.contains("bad request")
        || lower.contains("invalid request")
        || lower.contains("invalid_request")
    {
        return LlmFailureKind::FatalRequest;
    }
    if lower.contains("connection")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("reset")
        || lower.contains("eof")
        || lower.contains("broken pipe")
        || lower.contains("decode")
        || lower.contains("dns")
        || lower.contains("tcp")
        || lower.contains("tls")
        || lower.contains("body")
        || lower.contains("stream")
        || lower.contains("network")
    {
        return LlmFailureKind::RetryableTransport;
    }
    LlmFailureKind::Unknown
}

fn is_auto_resumable_mid_stream(kind: LlmFailureKind) -> bool {
    matches!(
        kind,
        LlmFailureKind::RetryableTransport
            | LlmFailureKind::RetryableRateLimit
            | LlmFailureKind::RetryableServer
    )
}

/// True if the LLM gateway's error message indicates a recoverable
/// tool-arguments problem (typically: 400 with concatenated/garbled JSON
/// from a prior turn). The recovery loop's sanitize-and-retry path is
/// only entered when this returns true; for other 4xx/5xx (auth, rate
/// limit, server) we synthesize and end immediately.
fn is_recoverable_args_error(reason: &str) -> bool {
    reason.contains("invalid function arguments") || reason.contains("tool_call_id")
}

fn build_recovery_instruction(reason: &str) -> String {
    format!(
        "The previous assistant response in this same conversation was interrupted by a transient model or network error.\n\
         Continue from the last visible assistant message without repeating completed text.\n\
         Treat any tool results already present in the conversation as authoritative and do not repeat side-effecting tool calls unless a new call is necessary.\n\
         Interruption reason: {reason}"
    )
}

/// Build the user-facing message for an LLM-side failure. Pure function 鈥?/// extracted from `synthesize_llm_unavailable` so it can be unit-tested
/// without a Tauri `AppHandle`. The reason is taken verbatim (callers
/// strip any wrapper prefix before calling).
pub(super) fn format_llm_unavailable_message(reason: &str) -> String {
    format!("(LLM 鏆傛椂涓嶅彲鐢? 鍘熷洜: {})", reason)
}

impl AgentManager {
    /// Common end-of-cycle exit. Emits the message as a `Text` chunk
    /// (so the frontend appends it to / creates the assistant message via
    /// the `text` case at chat-store.ts:280), persists the same text as
    /// a `role: assistant` row, clears the stuck-detection counter, and
    /// returns `Ok(msg)`. Used by `synthesize_llm_unavailable`, the
    /// `Stuck` abort site, and the `MaxCycles` abort site 鈥?all three
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
        self.flush_assistant_message(thread_id, &msg, None).await?;
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

    async fn checkpoint_stream_buffers(
        &self,
        thread_id: &str,
        reasoning_buffer: &mut String,
        assistant_buffer: &mut String,
        assistant_checkpoint: &mut Option<AssistantCheckpoint>,
    ) -> Result<bool, AgentError> {
        let mut wrote_checkpoint = false;
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, reasoning_buffer)
                .await?;
            reasoning_buffer.clear();
            wrote_checkpoint = true;
        }
        if !assistant_buffer.is_empty() {
            if let Some(checkpoint) = assistant_checkpoint.as_mut() {
                checkpoint.content.push_str(assistant_buffer);
                self.update_assistant_checkpoint(
                    thread_id,
                    &checkpoint.message_id,
                    &checkpoint.content,
                    Some(false),
                    None,
                    None,
                )
                .await?;
            } else {
                let message_id = self
                    .flush_assistant_checkpoint(thread_id, assistant_buffer, None)
                    .await?;
                *assistant_checkpoint = Some(AssistantCheckpoint {
                    message_id,
                    content: assistant_buffer.clone(),
                });
            }
            assistant_buffer.clear();
            wrote_checkpoint = true;
        }
        Ok(wrote_checkpoint)
    }

    async fn finalize_mid_stream_unavailable(
        &self,
        thread_id: &str,
        reason: &str,
        reasoning_buffer: &mut String,
        assistant_buffer: &mut String,
        assistant_checkpoint: &mut Option<AssistantCheckpoint>,
        full_response: &str,
        app_handle: &tauri::AppHandle,
        run_id: &str,
    ) -> Result<String, AgentError> {
        let synth_msg = format_llm_unavailable_message(reason);
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, reasoning_buffer)
                .await?;
            reasoning_buffer.clear();
        }

        if assistant_checkpoint.is_some() || !assistant_buffer.is_empty() {
            emit_chunk_with_run_id(
                app_handle,
                &AgentChunk::Text {
                    thread_id: thread_id.to_string(),
                    text: synth_msg.clone(),
                },
                FLOWIX_AGENT_TYPE,
                run_id,
            );

            if let Some(checkpoint) = assistant_checkpoint.as_mut() {
                checkpoint.content.push_str(assistant_buffer);
                checkpoint.content.push_str(&synth_msg);
                assistant_buffer.clear();
                self.update_assistant_checkpoint(
                    thread_id,
                    &checkpoint.message_id,
                    &checkpoint.content,
                    Some(false),
                    None,
                    None,
                )
                .await?;
            } else {
                let final_content = format!("{assistant_buffer}{synth_msg}");
                assistant_buffer.clear();
                let _ = self
                    .flush_assistant_checkpoint(thread_id, &final_content, None)
                    .await?;
            }
            self.clear_tool_call_attempts(thread_id).await;
            return Ok(format!("{full_response}{synth_msg}"));
        }

        self.synthesize_llm_unavailable(thread_id, reason, app_handle, run_id)
            .await
    }

    /// Outer entry 鈥?registers a per-thread cancel flag, **spawns** the inner
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
    /// StreamEnd path 鈥?guaranteeing at most one in-flight chat per
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
            // 鑷墦鏂? 濡傛灉璇?thread 宸叉湁 in-flight chat, 鍏?set true
            // 璁╂棫 chat 鍦ㄤ笅涓€涓?checkpoint 璧?flush_cancel, 鍐?install
            // 鏂?run銆傛棫 task 閫€鍑烘椂鍙細閫氳繃 Arc::ptr_eq 娓呯悊鑷繁鐨?entry,
            // 涓嶄細璇垹鏂?task 鐨?registry銆?
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

        // 閫氱敤 metadata 鍗忚 鈹€鈹€ StreamStart 鎼哄甫 model / reasoning_effort,
        // 璇?run 閿佸畾銆傚墠绔?hover card / 鐘舵€佹爮鍙杩欎袱涓瓧娈靛睍绀恒€?        // 鏃?provider 涓嶈瘑鍒椂涓?None,鍓嶇 fallback 鍒板叏灞€閰嶇疆 / 鏄剧ず "鈥斻€嶃€?        //
        // `run_id` 閫氳繃 `resolve_run_id` 缁熶竴鏉ユ簮 鈹€鈹€ 鍓嶇浼犲氨鐢ㄥ墠绔殑,
        // 娌′紶灏?mint 涓€涓?(璺?CLI managers 鍚屽舰)銆傝繖淇濊瘉姣忎釜 chunk 閮藉甫
        // run_id, 鍓嶇 mapper 涓嶅啀 fallback 鍒?`st.activeRunId`, self-interrupt
        // 鏃舵棫 run 鐨?StreamEnd 涓嶄細琚褰掑埌鏂?run銆?
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

        // spawn 鍚?IPC 绔嬪嵆杩斿洖, 涓嶅啀 await 鏁翠釜 stream 璺戝畬銆?        // 澶辫触 / 瀹屾垚 / 鍙栨秷淇″彿鍏ㄩ潬 `agent-chunk` 浜嬩欢 (鍖呮嫭 `Error`
        // 鍜?`StreamEnd`), 鍓嶇 store 鎸?thread_id 娲惧彂鍒板搴?thread銆?        //
        // `me: Arc<Self>` 鈹€鈹€ 鎶?self 鐨?Arc clone 涓€浠藉杺缁?spawn task,
        // 浠诲姟鍦?self 涔嬪悗 (e.g. AppState drop) 鎵嶇粨鏉? refcount 鑷劧
        // 鏀舵暃銆傝繖鏄€熺敤 self 缁欏紓姝ヤ换鍔＄殑鏍囧噯鍋氭硶, 閬垮厤鍦?struct 閲?        // 瀛?Weak<Self> 閭ｅ寰幆寮曠敤銆?
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

            // 浠讳綍璺緞閫€鍑洪兘瑕?unregister + emit StreamEnd銆備换鍔＄粨鏉熷墠
            // 鍏堟竻 in_flight, 鏈€鍚?emit 鈹€鈹€ 鍓嶇鏀跺埌 StreamEnd 鏃? 鎴戜滑
            // 鐨?in-memory 鐘舵€佸凡缁忓綊闆? 浠讳綍
            // 绔嬪嵆瑙﹀彂鐨?`agent_running_threads` 鏌ヨ閮界湅涓嶅埌杩欎釜 thread
            // (涓?stream 鐪熺粨鏉熶簡"鐨勮涔変竴鑷?銆?
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

    /// Inner implementation 鈥?the actual ReAct loop with three cancel
    /// checkpoints. Does NOT touch `in_flight` directly; the outer
    /// `chat_stream` owns registration lifecycle.
    ///
    /// Cancel checkpoints:
    ///   #1. Top of `for _cycle` 鈥?between cycles, before reload. Catches
    ///       "user clicked stop right after a tool-call cycle's flush".
    ///   #2. Top of `while let Some(item) = stream.next().await` 鈥?mid-
    ///       stream. Returning here drops `stream` and aborts the HTTP
    ///       connection.
    ///   #3. After the inner while loop 鈥?after stream is exhausted,
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
            // Runtime Agent Role takes the role slot 鈥?base_system_prompt
            // omits the default static role section in this branch, keeping
            // exactly one role block in the final prompt (mutual exclusion
            // with [`crate::agent_flowix::prompt::role::section`]).
            let system_prompt = self.base_system_prompt(&ai_config, Some(&role_section));
            self.build_instance_with_system_prompt(&ai_config, system_prompt)?
        } else {
            self.ensure_instance(&ai_config).await?
        };

        self.persist_user_message(thread_id, &message).await?;
        // 鍏滃簳娓呯┖璇?thread 鐨勫崱姝绘娴嬭鏁般€侺LM 缁欐渶缁堝洖绛旂殑姝ｅ父璺緞涔熶細娓?
        // 杩欓噷鍙厹寮傚父閫€鍑?(stuck / 100 cycle 涓婇檺 / stream error) 鍚庣敤鎴烽噸鍙?        // 鍚屼竴 thread 鐨勫満鏅? 閬垮厤涓婃鐨勮鏁版薄鏌撴柊涓€杞€?        self.clear_tool_call_attempts(thread_id).await;
        // 鐢ㄦ埛娑堟伅宸茶惤鐩? 涓嬮潰鐨?ReAct 寰幆绗竴杞?reload 浼氳鍒般€?        // load_thread_llm_messages 鐜板湪鐩存帴杩斿洖 rllm 鐨?ChatMessage 搴忓垪, 鍖呭惈
        // tool_use / tool_result銆傛瘡杞?cycle 椤堕儴鍐?reload 涓€娆℃嬁鍒版渶鏂拌惤鐩樼姸鎬併€?
        #[allow(unused_assignments)]
        let mut llm_messages: Vec<OpenAICompatibleChatMessage> = Vec::new();

        // React loop with streaming
        let max_cycles = 100;
        let mut full_response = String::new();
        let mut reasoning_buffer = String::new();
        let mut assistant_buffer = String::new();
        let mut assistant_checkpoint: Option<AssistantCheckpoint> = None;
        let mut pending_recovery_instruction: Option<String> = None;
        let mut auto_resume_attempts: u32 = 0;
        // Tracked across cycles so the MaxCycles error message can name
        // the last tool the LLM was stuck on.
        let mut last_tool_name: Option<String> = None;

        // 鈹€鈹€ Token 棰勭畻: 璺?cycle 绱 total_tokens, 瓒呰繃閰嶇疆涓婇檺绔嬪埢鐔旀柇銆傗攢鈹€
        // budget=0 琛ㄧず涓嶉檺 (鏃?config 琛屼负, 涔熸柟渚垮崟娴?銆俇sage chunk 鐢?        // provider 鍦ㄦ瘡涓祦鏈熬鍗曠嫭 push 涓€娆? 涓嶄細閲嶅璁℃暟 鈹€鈹€ 杩欐槸鎶?        // 涔嬪墠 "Usage 瑙ｆ瀽鍚庡畬鍏ㄦ病鐢? 鐨勬瀛楁浠?provider 灞傜┛閫忓嚭鏉ョ殑鐩殑銆?        // 娉ㄦ剰: OpenAI 鐨?`prompt_tokens` 鍦?stream+include_usage 妯″紡涓嬫槸
        // **绱**鐨?(鏁翠釜 thread 鐨勮緭鍏?, 涓嶆槸鍗曡疆 鈹€鈹€ 鎴戜滑鐨勭疮璁℃槸鏈夋剰涓轰箣銆?
        let token_budget = self.user_config.get_ai_config().model.max_total_tokens;
        let mut tokens_used: u32 = 0;

        tracing::debug!("[Agent] Starting chat_stream for thread_id: {}", thread_id);

        'cycle_loop: for _cycle in 0..max_cycles {
            // 鈹€鈹€ Checkpoint #1: between cycles, before reload. 鈹€鈹€
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

            // 姣忚疆浠庣洏涓?reload, 鎷垮埌鏈疆 (鍚笂杞? 鏂拌惤鐩樼殑 assistant(tool_calls) +
            // tool(result) 琛? 浣滀负涓嬭疆 LLM 璋冪敤鐨勭湡瀹炰笂涓嬫枃銆傝繖鏍?disk 鏄敮涓€鐪熸簮,
            // 涓嶉渶瑕佸啀鍦ㄥ惊鐜噷鎵嬪姩 push ToolUse/ToolResult 鍒?llm_messages銆?            llm_messages = self.load_thread_llm_messages(thread_id).await?;
            if let Some(instruction) = pending_recovery_instruction.take() {
                llm_messages.push(OpenAICompatibleChatMessage {
                    role: ChatRole::User,
                    content: instruction,
                    message_type: MessageType::Text,
                    reasoning: None,
                });
            }
            reasoning_buffer.clear();
            assistant_buffer.clear();
            let mut hit_tool_call = false;
            // Bounded retry loop for LLM-side 400 rejections. When the
            // provider returns "invalid function arguments json string" it
            // means a previous round's persisted `tool_calls[*].function.arguments`
            // is unparseable JSON (root cause: the parallel-call parser
            // collision 鈥?see `openai_compatible.rs`; the recovery exists
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
                        let failure_kind = classify_llm_failure(&reason);
                        // Two reasons to bail: (a) the error isn't a
                        // recoverable tool-args error, or (b) we've
                        // already retried the maximum number of times.
                        let can_retry = recovery_attempts < MAX_LLM_RECOVERY_RETRIES
                            && failure_kind == LlmFailureKind::RecoverableHistory;
                        if !can_retry {
                            // 鎸佷箙鍖?LLM 娴佹柇鍘熷洜 (auth / 4xx / 5xx / network
                            // 绛?, 渚夸簬鎺掗殰: tracing 鏃ュ織鍦ㄨ繘绋嬮€€鍑哄悗鍗充涪,
                            // 鍐?~/.flowix/logs/agent.log 鎵嶈兘鍦ㄧ敤鎴蜂簨鍚庡弽棣?
                            // "鍒氭墠閭ｆ潯娑堟伅娌″洖" 鏃跺洖婧€?
                            runtime_log::record_agent_event(
                                "error",
                                "llm_stream",
                                "llm.stream_failed",
                                format!("LLM stream request failed: {e}"),
                                Some(thread_id),
                                None,
                                Some(serde_json::json!({
                                    "failure_kind": format!("{failure_kind:?}"),
                                    "is_recoverable_args_error": failure_kind == LlmFailureKind::RecoverableHistory,
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
                                // 璁板綍 sanitize-and-retry 浜嬩欢 鈹€鈹€ 杩欐潯涓嶆槸
                                // 缁堟€侀敊璇?(LLM 浠嶆湁鏈轰細姝ｅ父鏀跺彛), 浣?
                                // 棰戠箒鍑虹幇鎰忓懗鐫€ tool_calls 鎸佷箙鍖栧眰鏈?bug
                                // (瑙?`openai_compatible.rs` 鐨?parallel-call
                                // 瑙ｆ瀽), 浜嬪悗鏌?agent.log 鑳藉畾浣嶅埌鍏蜂綋 thread銆?
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
                            // failed 鈥?either way the gateway's complaint
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

            // Process stream items 鈥?OpenAICompatibleStreamItem 鍖哄垎 reasoning vs text,
            // 鐩存帴鍙戠粨鏋勫寲 AgentChunk 缁欏墠绔? 璧?switch 璺緞鑰岄潪 startsWith銆?
            while let Some(item_result) = stream.next().await {
                // 鈹€鈹€ Checkpoint #2: mid-stream, before each poll. 鈹€鈹€
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
                                // 閫氱敤 metadata 鍗忚 鈹€鈹€ 鎶?usage 鎺ㄧ粰鍓嶇,
                                // 鍓嶇绱姞鍒?`AgentRunState.usage` / thread 绱銆?                                // 涓嶈鏄惁瑙﹀彂 budget 鐔旀柇, 閮?emit 涓€娆?
                                // 璁╁墠绔兘鐪嬪埌姣?turn 鐨?token 澧為噺銆?
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
                                // saturating_add 闃插尽鎬? 鍗曟 Usage 瀛楁鏋佺澶ф椂
                                // 涔熷彧鏄崱鍦?u32::MAX, 涓嶄細 panic / wrap 鎴愬皬鏁般€?
                                tokens_used = tokens_used.saturating_add(total_tokens);
                                if token_budget > 0 && tokens_used > token_budget {
                                    let err = AgentError::TokenBudget {
                                        used: tokens_used,
                                        budget: token_budget,
                                    };
                                    let err_msg = err.to_string();
                                    tracing::warn!("[Agent] {err_msg}");
                                    // 鎸佷箙鍖?token 棰勭畻鐔旀柇 鈹€鈹€ 鐢ㄦ埛浜嬪悗鍙嶉
                                    // "agent 鐢ㄤ竴鍗婂氨鍋滀簡" 绗竴鏃堕棿鏌?agent.log
                                    // 瀹氫綅鏄笉鏄绠楀埌浜? 鑰屼笉鏄弽澶嶈窇鍚屾牱
                                    // 鐨勫璇濊瘯閿欍€?
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
                                    // 涓?Stuck 鐢ㄥ悓涓€鏉?finalize 璺緞: emit Error
                                    // chunk (鍓嶇 switch 璧?error case), 鍐欎竴琛?
                                    // 鍔╂墜鏂囨湰 (UI 鐪嬭捣鏉ユ甯告敹鍙ｈ€岄潪宕╂簝 toast),
                                    // 鐒跺悗娓呮帀 stuck-detect 璁℃暟銆?
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
                                                "(agent aborted 鈥?{err_msg}). \
                                                 Split the request into smaller pieces \
                                                 or raise `max_total_tokens` in \
                                                 Preferences 鈫?Agent."
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
                                let reasoning_for_turn = if reasoning_buffer.trim().is_empty() {
                                    None
                                } else {
                                    Some(reasoning_buffer.clone())
                                };
                                self.flush_reasoning_message(thread_id, &reasoning_buffer)
                                    .await?;
                                reasoning_buffer.clear();
                                // 鎶?assistant_buffer 閲岀殑鍓嶅鏂囨湰涓庢湰杞?tool_call 鍚堝苟
                                // 鍒板悓涓€琛?(OpenAI 鍗忚鏈潵灏辨槸涓€鏉?message 甯?content +
                                // tool_calls)銆備笉璋?flush_assistant_message 鏄负浜嗛伩鍏?                                // 绱ф帴鐫€鍐嶅啓涓€鏉＄┖鐨?assistant 琛屻€?
                                if let Some(mut checkpoint) = assistant_checkpoint.take() {
                                    checkpoint.content.push_str(&assistant_buffer);
                                    self.update_assistant_checkpoint(
                                        thread_id,
                                        &checkpoint.message_id,
                                        &checkpoint.content,
                                        Some(true),
                                        Some(std::slice::from_ref(&tool_call)),
                                        reasoning_for_turn.as_deref(),
                                    )
                                    .await?;
                                } else {
                                    self.flush_assistant_message_with_tool_calls(
                                        thread_id,
                                        &assistant_buffer,
                                        std::slice::from_ref(&tool_call),
                                        reasoning_for_turn.as_deref(),
                                    )
                                    .await?;
                                }
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

                                // Drop guard: 鍖呬綇 execute_tool + emit + persist
                                // 杩欐銆備换涓€姝?panic / 鎻愬墠 return / 鏂伴敊璇矾寰?                                // 瑙﹀彂 drop 鈹€鈹€ 鑷姩鎶婂搴?tool 琛岀殑 is_loading
                                // 褰掗浂, 涓嶈 UI 杞湀鍗℃銆?
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
                                        &message,
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

                                // 鍚屼竴 (tool, args) 杩炵画璋冪敤 STUCK_THRESHOLD 娆″氨鐔旀柇銆?                                // 璁℃暟 + 姣旇緝鏀句竴璧烽伩鍏嶇珵鎬併€傝Е鍙戞椂缁欏墠绔彂涓?Error 鍧?
                                // 璁╃敤鎴风湅鍒颁腑鏂師鍥? 鍐?return Err 璧板墠绔?catch 璺緞銆?
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
                                    // 鎸佷箙鍖?stuck 浜嬩欢 鈹€鈹€ `tool` + `count`
                                    // 涓€璧峰啓, 鎺掗殰鏃惰兘鐩存帴鐪嬪埌"鐢ㄦ埛鍦ㄥ摢涓伐鍏?
                                    // 涓婃妸 LLM 鍗′綇浜?(e.g. 涓€鐩?read 鍚?
                                    // 涓€涓枃浠?銆俙arguments` 涓嶅啓鏂囦欢 (鍙兘
                                    // 寰堥暱涓斿惈鏁忔劅鏁版嵁), 鐪熻鍥炴函闈?
                                    // thread.db 鐨?tool_calls 鍒椼€?
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
                                        "(agent aborted 鈥?{}). Try rephrasing the request \
                                         or check that the file path is correct.",
                                        err_msg
                                    );
                                    return self
                                        .finalize_with_synthesized_message(
                                            thread_id, synth_msg, app_handle, &run_id,
                                        )
                                        .await;
                                }

                                // tool_use / tool_result 宸查€氳繃 flush_assistant_message_with_tool_calls
                                // + persist_tool_call / persist_tool_result 钀界洏, 涓嬭疆 cycle
                                // 椤堕儴鐨?reload_thread_llm_messages 浼氳鍒? 杩欓噷涓嶅啀鎵嬪姩 push銆?
                                // Continue to next iteration to get final response
                                hit_tool_call = true;
                                break;
                            }
                            OpenAICompatibleStreamItem::Done { .. } => {
                                // Stream ended 鈥?no-op, 寰幆鑷劧閫€鍑?
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
                        // 涓庡垵濮?request 澶辫触涓嶅悓, 杩欐潯鏄祦鍒颁竴鍗婃柇鐨?鈹€鈹€
                        // 閮ㄥ垎 tokens 宸茬粡鑺卞湪 reasoning / text / 宸ュ叿
                        // 璋冪敤涓? 鐢ㄦ埛閲嶅彂鏃朵細鎺ョ潃涓婃鐨勪腑鏂偣缁х画
                        // (thread.db 鏄湡婧?銆?閿欒鏈韩浠嶇劧鏄?LLM
                        // 涓嶅彲鐢? 璧板悓涓€鏉?synthesize 璺緞, 浣嗘棩蹇椾笂
                        // kind 鏍?`llm_stream_mid` 鍖哄垎鍓嶅悗銆?
                        runtime_log::record_agent_event(
                            "error",
                            "llm_stream_mid",
                            "llm.stream_mid_error",
                            format!("LLM stream errored mid-flight: {e}"),
                            Some(thread_id),
                            None,
                            None,
                        );
                        let reason = format!("Stream error: {}", e);
                        let failure_kind = classify_llm_failure(&reason);
                        if is_auto_resumable_mid_stream(failure_kind)
                            && auto_resume_attempts < MAX_AUTO_RESUME_ATTEMPTS
                        {
                            auto_resume_attempts += 1;
                            let wrote_checkpoint = self
                                .checkpoint_stream_buffers(
                                    thread_id,
                                    &mut reasoning_buffer,
                                    &mut assistant_buffer,
                                    &mut assistant_checkpoint,
                                )
                                .await?;
                            let instruction = build_recovery_instruction(&reason);
                            pending_recovery_instruction = Some(instruction);
                            let progress = format!(
                                "recovering interrupted LLM stream ({auto_resume_attempts}/{MAX_AUTO_RESUME_ATTEMPTS}); checkpointed_partial={wrote_checkpoint}; kind={failure_kind:?}"
                            );
                            tracing::warn!("[Agent] {progress}");
                            runtime_log::record_agent_event(
                                "warn",
                                "llm_stream_recovery",
                                "llm.stream_auto_resume",
                                progress,
                                Some(thread_id),
                                None,
                                Some(serde_json::json!({
                                    "failure_kind": format!("{failure_kind:?}"),
                                    "auto_resume_attempts": auto_resume_attempts,
                                    "max_auto_resume_attempts": MAX_AUTO_RESUME_ATTEMPTS,
                                    "checkpointed_partial": wrote_checkpoint,
                                })),
                            );
                            continue 'cycle_loop;
                        }

                        return self
                            .finalize_mid_stream_unavailable(
                                thread_id,
                                &reason,
                                &mut reasoning_buffer,
                                &mut assistant_buffer,
                                &mut assistant_checkpoint,
                                &full_response,
                                app_handle,
                                &run_id,
                            )
                            .await;
                    }
                }
            }

            // 鈹€鈹€ Checkpoint #3: after stream exhausted, before the
            //    final-return vs. next-cycle decision. 鈹€鈹€ Returning
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
                // LLM 缁欏嚭鏈€缁堝洖绛? 瑙嗕负瀹屾垚涓€娆″畬鏁翠换鍔? 娓呯┖鍗℃妫€娴嬭鏁般€?                self.clear_tool_call_attempts(thread_id).await;
                self.flush_reasoning_message(thread_id, &reasoning_buffer)
                    .await?;
                if let Some(mut checkpoint) = assistant_checkpoint.take() {
                    checkpoint.content.push_str(&assistant_buffer);
                    self.update_assistant_checkpoint(
                        thread_id,
                        &checkpoint.message_id,
                        &checkpoint.content,
                        Some(true),
                        None,
                        Some(&reasoning_buffer),
                    )
                    .await?;
                } else {
                    self.flush_assistant_message(
                        thread_id,
                        &assistant_buffer,
                        Some(&reasoning_buffer),
                    )
                    .await?;
                }
                return Ok(full_response);
            }
        }

        // 寰幆璺戞弧 max_cycles 杩樻病 return, 璇存槑 LLM 涓€鐩村湪璋冨伐鍏锋病缁欐渶缁堝洖绛斻€?        // 鍚堟垚涓€鏉℃渶缁堢殑 assistant 娑堟伅钀界洏骞?emit, 璁╃敤鎴风湅鍒版甯哥粨鏉熻€屼笉鏄?        // "agent crashed" 寮圭獥, 鐒跺悗杩斿洖 Ok銆?
        let last_tool = last_tool_name
            .as_deref()
            .map(|n| format!(" Last tool: `{}`.", n))
            .unwrap_or_default();
        let synth_msg = format!(
            "(agent aborted after {max_cycles} tool-call cycles without a final answer).{last_tool} \
             Try a more specific prompt."
        );
        tracing::warn!("[Agent] agent exceeded max cycles ({max_cycles})");
        // 鎸佷箙鍖?max-cycles 鐔旀柇 鈹€鈹€ `last_tool` 涓€璧峰啓, 閰嶅悎 thread.db
        // 閲岀殑 tool_calls 閾捐兘澶嶇洏 LLM 涓轰粈涔?涓€鐩磋皟宸ュ叿涓嶆敹鍙?銆?
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

    /// 鍙栨秷 helper 鈥?`chat_stream_inner` 涓変釜 cancel 绔欑偣鍏辩敤鐨勯€€鍑哄舰鐘躲€?    /// 涓?`finalize_with_synthesized_message` 瀵圭О, 浣嗙敤銆岀敤鎴蜂富鍔ㄥ仠姝€嶇殑
    /// 鏂囨 (`_(宸插仠姝㈢敓鎴?_`), 涓嶇敤 LLM 涓嶅彲鐢ㄧ殑妯℃澘銆?    ///
    /// 鎶?suffix 鎷煎埌 `assistant_buffer` 鏈熬鍐?`flush_assistant_message`
    /// 钀界洏, 鍚屾椂 emit 涓€涓嫭绔嬬殑 `Text` chunk 缁欏墠绔?(UI 鎶婂畠褰撴櫘閫?text
    /// 杩藉姞, 璺熺敤鎴风湅鍒扮殑瀹炴椂娴佷綋楠屼竴鑷?鈹€鈹€ 涓嶅啀闇€瑕佹柊浜嬩欢绫诲瀷)銆?
    pub(super) async fn flush_cancel(
        &self,
        thread_id: &str,
        reasoning_buffer: String,
        assistant_buffer: String,
        full_response: String,
        app_handle: &tauri::AppHandle,
        run_id: &str,
    ) -> Result<String, AgentError> {
        const STOPPED_SUFFIX: &str = "_(宸插仠姝㈢敓鎴?_";
        tracing::info!(
            "[Agent] chat cancelled by user for thread_id: {}",
            thread_id
        );
        // 鎺ㄧ悊妯″瀷浼氬厛 reasoning 鍐?text, 涓柇鏃惰淇濈暀鎬濊€冪棔杩广€?
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, &reasoning_buffer)
                .await?;
        }
        // 钀界洏鏈€缁?assistant 琛?= 鍘熸祦寮忕疮绉?+ 鍋滄鏍囪; 鍚屼竴琛?emit 缁?UI銆?
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
        // 濮嬬粓钀戒竴鏉?(鍝€?assistant_buffer 涓虹┖), 璁?thread 閲屾湁鏄庣‘鐨?        // 鍔╂墜缁撴潫鏍囪; `flush_assistant_message` 鑷韩鏈?is_empty 鐭矾,
        // 浣嗘垜浠繖閲屼紶鐨勬槸甯?suffix 鐨勯潪绌轰覆, 涓€瀹氳惤鐩樸€?
        self.flush_assistant_message(thread_id, &final_assistant, None)
            .await?;
        self.clear_tool_call_attempts(thread_id).await;
        Ok(format!("{full_response}{STOPPED_SUFFIX}"))
    }
}
