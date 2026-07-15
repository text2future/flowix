use std::sync::Arc;

use rllm::ToolCall as LlmToolCall;
use uuid::Uuid;

use crate::agent_flowix::providers::OpenAICompatibleChatMessage;
use crate::agent_session::{ChatMessage as ThreadChatMessage, ThreadManager};

use super::context::build_llm_context_window;
use super::{AgentError, AgentManager, AgentUserMessage};

/// RAII guard ── 在 `persist_tool_call` (写 `is_loading = true`) 之后,
/// `persist_tool_result` (写 `is_loading = 0`) 之前的任何 panic / early
/// return / 新增错误路径都会触发 drop, fire-and-forget 一个
/// `clear_tool_loading` 把对应行解锁, 避免前端工具调用行永远转圈。
///
/// 解决 #3.1: 历史上 `execute_tool_for_thread` panic 或新增错误路径导致
/// `persist_tool_result` 不到时, loading 状态卡死。Success 路径下
/// `persist_tool_result` 已经把 is_loading 归零, guard 的 drop UPDATE 命中
/// 同一行再写 0 ── 幂等, 不算浪费。Guard 自身不持锁 (不持 thread_manager
/// 的 read guard), 避免与外层 RwLock 锁顺序冲突。
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
        // drop 是同步的, 不能 .await ── 但能 spawn 一个新 task。task 拿
        // `thread_manager` 的 Arc, 即使 AgentManager 后续被 drop 引用计数
        // 仍能撑住这个 UPDATE 完成。
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

/// 计算 `tool` 行写入 SQLite 时的主键 id ── 抽出来便于单测, 同时也是
/// `persist_tool_call` 的唯一入口, 防止"两处 format 各自演化"漂移。
///
/// LLM 偶发不给 `tool_call.id`(极少数 gateway / 模型在并行工具调用场景下漏填),
/// 直接 `format!("tool_{}", "")` 会得到 `"tool_"`, 同 thread 内多次 tool_call
/// 全撞 PRIMARY KEY (`thread_messages.id` 是 TEXT PRIMARY KEY, 见 `threads.rs`)。
/// 兜底用 UUID v4, 保证每次调用都得到不同 id。
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
    /// `openai_compatible.rs` — fixed separately — but this is the safety
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
        // Walk from the end — the most recent assistant(tool_calls) is
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

    /// 助手既输出了文本又发出了 tool_call 的合并落盘。OpenAI 协议里这两者本就是
    /// 同一条 assistant 消息 (content + tool_calls 字段), 不该拆成两行。
    /// text 可为空 (LLM 纯发 tool call, 不带前导文本), calls 至少一个。
    pub(super) async fn flush_assistant_message_with_tool_calls(
        &self,
        thread_id: &str,
        content: &str,
        calls: &[LlmToolCall],
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        // 序列化为 OpenAI 格式的 JSON 数组, 持久化层与 rllm 解耦。
        let tool_calls_json = serialize_tool_calls(calls);
        // 借用首个 call.id 作行 id, 保持同 tool_call 的多 row 共享前缀便于排查。
        let id_seed = calls
            .first()
            .map(|c| c.id.clone())
            // LLM 整轮都没给 id (极少见) ── 用 UUID 兜底, 避免同毫秒内的多
            // 个 call 拿到同一 id_seed 撞 PRIMARY KEY (issue #3.2)。
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
        // 行 id 必须全局唯一 ── LLM 偶发不给 tool_call.id(罕见但发生过),空字符串
        // 拼出来就是 "tool_",同 thread 内多次 tool_call 全撞 PRIMARY KEY。
        // 用 UUID 兜底, 与 `flush_assistant_message_with_tool_calls` 同形 (issue #3.2)。
        // 这里**不**改写 `tool_call_id` 列的值 ── 那列是给 `update_tool_result` 的
        // WHERE 子句用的, 列空值的退化场景(LLM 一整轮都给空 id)在原始路径上根本
        // 进不到这里(PRIMARY KEY 已拒), 不属于本次修复要解决的范围。
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
