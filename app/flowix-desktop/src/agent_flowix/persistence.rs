use std::sync::Arc;

use rllm::ToolCall as LlmToolCall;
use uuid::Uuid;

use crate::agent_flowix::providers::OpenAICompatibleChatMessage;
use crate::agent_session::{ChatMessage as ThreadChatMessage, ThreadManager};

use super::context::build_llm_context_window;
use super::{AgentError, AgentManager, AgentUserMessage};

/// RAII guard 鈹€鈹€ 鍦?`persist_tool_call` (鍐?`is_loading = true`) 涔嬪悗,
/// `persist_tool_result` (鍐?`is_loading = 0`) 涔嬪墠鐨勪换浣?panic / early
/// return / 鏂板閿欒璺緞閮戒細瑙﹀彂 drop, fire-and-forget 涓€涓?/// `clear_tool_loading` 鎶婂搴旇瑙ｉ攣, 閬垮厤鍓嶇宸ュ叿璋冪敤琛屾案杩滆浆鍦堛€?///
/// 瑙ｅ喅 #3.1: 鍘嗗彶涓?`execute_tool_for_thread` panic 鎴栨柊澧為敊璇矾寰勫鑷?/// `persist_tool_result` 涓嶅埌鏃? loading 鐘舵€佸崱姝汇€係uccess 璺緞涓?/// `persist_tool_result` 宸茬粡鎶?is_loading 褰掗浂, guard 鐨?drop UPDATE 鍛戒腑
/// 鍚屼竴琛屽啀鍐?0 鈹€鈹€ 骞傜瓑, 涓嶇畻娴垂銆侴uard 鑷韩涓嶆寔閿?(涓嶆寔 thread_manager
/// 鐨?read guard), 閬垮厤涓庡灞?RwLock 閿侀『搴忓啿绐併€?
pub(super) struct IsLoadingGuard {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    thread_id: String,
    tool_call_id: String,
}

impl IsLoadingGuard {
    pub(super) fn new(
        thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
        thread_id: &str,
        tool_call_id: &str,
    ) -> Self {
        Self {
            thread_manager,
            thread_id: thread_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
        }
    }
}

impl Drop for IsLoadingGuard {
    fn drop(&mut self) {
        // drop 鏄悓姝ョ殑, 涓嶈兘 .await 鈹€鈹€ 浣嗚兘 spawn 涓€涓柊 task銆倀ask 鎷?        // `thread_manager` 鐨?Arc, 鍗充娇 AgentManager 鍚庣画琚?drop 寮曠敤璁℃暟
        // 浠嶈兘鎾戜綇杩欎釜 UPDATE 瀹屾垚銆?
        let tm = self.thread_manager.clone();
        let tid = std::mem::take(&mut self.thread_id);
        let tcid = std::mem::take(&mut self.tool_call_id);
        tokio::spawn(async move {
            let manager = tm.read().await;
            if let Err(e) = manager.clear_tool_loading(&tid, &tcid).await {
                tracing::warn!("[Agent] IsLoadingGuard reset failed for tool_call {tcid}: {e}");
            }
        });
    }
}

/// 璁＄畻 `tool` 琛屽啓鍏?SQLite 鏃剁殑涓婚敭 id 鈹€鈹€ 鎶藉嚭鏉ヤ究浜庡崟娴? 鍚屾椂涔熸槸
/// `persist_tool_call` 鐨勫敮涓€鍏ュ彛, 闃叉"涓ゅ format 鍚勮嚜婕斿寲"婕傜Щ銆?///
/// LLM 鍋跺彂涓嶇粰 `tool_call.id`(鏋佸皯鏁?gateway / 妯″瀷鍦ㄥ苟琛屽伐鍏疯皟鐢ㄥ満鏅笅婕忓～),
/// 鐩存帴 `format!("tool_{}", "")` 浼氬緱鍒?`"tool_"`, 鍚?thread 鍐呭娆?tool_call
/// 鍏ㄦ挒 PRIMARY KEY (`thread_messages.id` 鏄?TEXT PRIMARY KEY, 瑙?`threads.rs`)銆?/// 鍏滃簳鐢?UUID v4, 淇濊瘉姣忔璋冪敤閮藉緱鍒颁笉鍚?id銆?
pub(super) fn tool_call_row_id(tool_call_id: &str) -> String {
    if tool_call_id.is_empty() {
        format!("tool_{}", Uuid::new_v4())
    } else {
        format!("tool_{}", tool_call_id)
    }
}

pub(super) fn serialize_tool_calls(calls: &[LlmToolCall]) -> serde_json::Value {
    serde_json::Value::Array(
        calls
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "type": c.call_type,
                    "function": {
                        "name": c.function.name,
                        "arguments": c.function.arguments,
                    }
                })
            })
            .collect(),
    )
}

impl AgentManager {
    /// Find the most recent `assistant` message with `tool_calls` and
    /// replace any unparseable `function.arguments` string with `"{}"`.
    /// Returns `Ok(true)` if any row was rewritten, `Ok(false)` otherwise.
    ///
    /// Recovery for the LLM-side 400 "invalid function arguments" rejection.
    /// The root cause is the parallel-call parser collision in
    /// `openai_compatible.rs` 鈥?fixed separately 鈥?but this is the safety
    /// net: degrade gracefully (LLM sees empty args on the next round) rather
    /// than abort the user's session.
    ///
    /// Touches `tool_calls[*].function.arguments` (the wire-format string
    /// the gateway validates), NOT `tool_input` (a UI cache).
    pub(super) async fn sanitize_persisted_tool_calls(
        &self,
        thread_id: &str,
    ) -> Result<bool, AgentError> {
        let manager = self.thread_manager.read().await;
        let mut thread = match manager.get_thread(thread_id).await? {
            Some(t) => t,
            None => return Ok(false),
        };
        // Walk from the end 鈥?the most recent assistant(tool_calls) is
        // the one the gateway is choking on.
        let target = thread
            .messages
            .iter_mut()
            .rev()
            .find(|m| m.role == "assistant" && m.tool_calls.is_some());
        let Some(target) = target else {
            return Ok(false);
        };
        let Some(serde_json::Value::Array(arr)) = target.tool_calls.as_mut() else {
            return Ok(false);
        };
        let mut dirty = false;
        let mut sanitized_count = 0usize;
        for call in arr.iter_mut() {
            let args_str = call
                .get_mut("function")
                .and_then(|f| f.get_mut("arguments"))
                .and_then(|a| a.as_str())
                .map(|s| s.to_string());
            if let Some(args_str) = args_str {
                if serde_json::from_str::<serde_json::Value>(&args_str).is_err() {
                    tracing::warn!(
                        "[Agent] sanitizing invalid tool_call arguments in message {}",
                        target.id
                    );
                    call["function"]["arguments"] = serde_json::Value::String("{}".to_string());
                    dirty = true;
                    sanitized_count += 1;
                }
            }
        }
        if dirty {
            manager
                .update_message_tool_calls(
                    thread_id,
                    &target.id,
                    &target.tool_calls.clone().unwrap_or(serde_json::Value::Null),
                )
                .await?;
            tracing::info!(
                "[Agent] sanitized {} tool_call(s) in message {}",
                sanitized_count,
                target.id
            );
        }
        Ok(dirty)
    }

    pub(super) async fn persist_user_message(
        &self,
        thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<(), AgentError> {
        let thread_message = ThreadChatMessage {
            id: format!("user_{}", Uuid::new_v4()),
            role: "user".to_string(),
            content: message
                .llm_content
                .clone()
                .unwrap_or_else(|| message.content.clone()),
            llm_content: message.llm_content.clone(),
            system_reminder_directory: message.system_reminder_directory.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            is_loading: None,
            tool_call_id: None,
            tool_name: None,
            tool_data: None,
            tool_input: None,
            tool_calls: None,
            reasoning: None,
            is_completed: None,
            is_collapsed: None,
        };
        self.add_thread_message(thread_id, thread_message).await
    }

    pub(super) async fn load_thread_llm_messages(
        &self,
        thread_id: &str,
    ) -> Result<Vec<OpenAICompatibleChatMessage>, AgentError> {
        let manager = self.thread_manager.read().await;
        let thread = manager
            .get_thread(thread_id)
            .await?
            .ok_or_else(|| crate::agent_session::ThreadError::NotFound(thread_id.to_string()))?;
        Ok(build_llm_context_window(thread.messages))
    }

    pub(super) async fn add_thread_message(
        &self,
        thread_id: &str,
        message: ThreadChatMessage,
    ) -> Result<(), AgentError> {
        let manager = self.thread_manager.read().await;
        manager.add_message(thread_id, message).await?;
        Ok(())
    }

    pub(super) async fn flush_reasoning_message(
        &self,
        thread_id: &str,
        content: &str,
    ) -> Result<(), AgentError> {
        if content.is_empty() {
            return Ok(());
        }
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("reasoning_{}", Uuid::new_v4()),
                role: "reasoning".to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: None,
                reasoning: None,
                is_completed: Some(true),
                is_collapsed: None,
            },
        )
        .await
    }

    pub(super) async fn flush_assistant_message(
        &self,
        thread_id: &str,
        content: &str,
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        if content.is_empty() {
            return Ok(());
        }
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("assistant_{}", Uuid::new_v4()),
                role: "assistant".to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: None,
                reasoning: reasoning
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    /// Persist a partial assistant response after a recoverable stream
    /// failure. The row is intentionally marked `is_completed = false` so
    /// future recovery/UI code can distinguish it from a normal final answer.
    /// The returned id lets the resumed stream append/promote the same row
    /// instead of creating duplicate assistant messages in SQLite.
    pub(super) async fn flush_assistant_checkpoint(
        &self,
        thread_id: &str,
        content: &str,
        reasoning: Option<&str>,
    ) -> Result<String, AgentError> {
        let id = format!("assistant_partial_{}", Uuid::new_v4());
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: id.clone(),
                role: "assistant".to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: None,
                reasoning: reasoning
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                is_completed: Some(false),
                is_collapsed: None,
            },
        )
        .await?;
        Ok(id)
    }

    pub(super) async fn update_assistant_checkpoint(
        &self,
        thread_id: &str,
        message_id: &str,
        content: &str,
        is_completed: Option<bool>,
        tool_calls: Option<&[LlmToolCall]>,
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        let tool_calls_json = tool_calls.map(serialize_tool_calls);
        let manager = self.thread_manager.read().await;
        let updated = manager
            .update_assistant_checkpoint(
                thread_id,
                message_id,
                content,
                is_completed,
                tool_calls_json.as_ref(),
                reasoning,
            )
            .await?;
        if !updated {
            tracing::warn!(
                "[Agent] assistant checkpoint {message_id} for thread {thread_id} was not found"
            );
        }
        Ok(())
    }

    /// 鍔╂墜鏃㈣緭鍑轰簡鏂囨湰鍙堝彂鍑轰簡 tool_call 鐨勫悎骞惰惤鐩樸€侽penAI 鍗忚閲岃繖涓よ€呮湰灏辨槸
    /// 鍚屼竴鏉?assistant 娑堟伅 (content + tool_calls 瀛楁), 涓嶈鎷嗘垚涓よ銆?    /// text 鍙负绌?(LLM 绾彂 tool call, 涓嶅甫鍓嶅鏂囨湰), calls 鑷冲皯涓€涓€?
    pub(super) async fn flush_assistant_message_with_tool_calls(
        &self,
        thread_id: &str,
        content: &str,
        calls: &[LlmToolCall],
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        // 搴忓垪鍖栦负 OpenAI 鏍煎紡鐨?JSON 鏁扮粍, 鎸佷箙鍖栧眰涓?rllm 瑙ｈ€︺€?
        let tool_calls_json = serialize_tool_calls(calls);
        // 鍊熺敤棣栦釜 call.id 浣滆 id, 淇濇寔鍚?tool_call 鐨勫 row 鍏变韩鍓嶇紑渚夸簬鎺掓煡銆?
        let id_seed = calls
            .first()
            .map(|c| c.id.clone())
            // LLM 鏁磋疆閮芥病缁?id (鏋佸皯瑙? 鈹€鈹€ 鐢?UUID 鍏滃簳, 閬垮厤鍚屾绉掑唴鐨勫
            // 涓?call 鎷垮埌鍚屼竴 id_seed 鎾?PRIMARY KEY (issue #3.2)銆?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("assistant_tool_{}", id_seed),
                role: "assistant".to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: Some(tool_calls_json),
                reasoning: reasoning
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    pub(super) async fn persist_tool_call(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        tool_input: serde_json::Value,
    ) -> Result<(), AgentError> {
        // 琛?id 蹇呴』鍏ㄥ眬鍞竴 鈹€鈹€ LLM 鍋跺彂涓嶇粰 tool_call.id(缃曡浣嗗彂鐢熻繃),绌哄瓧绗︿覆
        // 鎷煎嚭鏉ュ氨鏄?"tool_",鍚?thread 鍐呭娆?tool_call 鍏ㄦ挒 PRIMARY KEY銆?        // 鐢?UUID 鍏滃簳, 涓?`flush_assistant_message_with_tool_calls` 鍚屽舰 (issue #3.2)銆?        // 杩欓噷**涓?*鏀瑰啓 `tool_call_id` 鍒楃殑鍊?鈹€鈹€ 閭ｅ垪鏄粰 `update_tool_result` 鐨?        // WHERE 瀛愬彞鐢ㄧ殑, 鍒楃┖鍊肩殑閫€鍖栧満鏅?LLM 涓€鏁磋疆閮界粰绌?id)鍦ㄥ師濮嬭矾寰勪笂鏍规湰
        // 杩涗笉鍒拌繖閲?PRIMARY KEY 宸叉嫆), 涓嶅睘浜庢湰娆′慨澶嶈瑙ｅ喅鐨勮寖鍥淬€?
        let row_id = tool_call_row_id(tool_call_id);
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: row_id,
                role: "tool".to_string(),
                content: String::new(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: Some(true),
                tool_call_id: Some(tool_call_id.to_string()),
                tool_name: Some(tool_name.to_string()),
                tool_data: None,
                tool_input: Some(tool_input),
                tool_calls: None,
                reasoning: None,
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    pub(super) async fn persist_tool_result(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        result_content: &str,
    ) -> Result<(), AgentError> {
        let manager = self.thread_manager.read().await;
        manager
            .update_tool_result(thread_id, tool_call_id, tool_name, result_content)
            .await?;
        Ok(())
    }
}
