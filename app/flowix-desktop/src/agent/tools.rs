use std::path::PathBuf;

use rllm::chat::{ChatRole, MessageType};
use rllm::{FunctionCall, ToolCall as LlmToolCall};
use serde::Deserialize;

use crate::providers::{execute_tool, get_sub_agent_tools, OpenAICompatibleChatMessage};
use crate::runtime_log;

use super::context::{
    estimate_llm_message_tokens, estimate_tokens_from_chars, truncate_for_sub_agent,
};
use super::provider::{build_chat_provider, provider_kind, FlowixProviderKind};
use super::{AgentManager, AgentUserMessage};

const DEFAULT_SUB_AGENT_MAX_TOOL_CYCLES: u32 = 4;
const MAX_SUB_AGENT_TOOL_CYCLES: u32 = 8;
const SUB_AGENT_MAX_TOOL_RESULT_CHARS: usize = 24_000;
const SUB_AGENT_TOOL_STEP_PREVIEW_CHARS: usize = 1_000;

#[derive(Deserialize)]
struct SubAgentArgs {
    system_prompt: String,
    user_prompt: String,
    #[serde(default)]
    max_tool_cycles: Option<u32>,
}

fn tool_path_key(arguments: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Args {
        path: String,
    }

    let args = serde_json::from_str::<Args>(arguments).ok()?;
    let path = PathBuf::from(args.path);
    let resolved = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let normalized = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    Some(normalized.display().to_string())
}

fn compact_tool_arguments(arguments: &str) -> serde_json::Value {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(arguments) else {
        return serde_json::json!({ "raw_preview": truncate_for_sub_agent(arguments, 240) });
    };
    let mut out = serde_json::Map::new();
    for key in ["path", "pattern", "query", "glob", "name"] {
        if let Some(v) = value.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if out.is_empty() {
        serde_json::json!({ "keys": value.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() })
    } else {
        serde_json::Value::Object(out)
    }
}

fn summarize_tool_result_for_history(
    tool_name: &str,
    arguments: &str,
    result: &crate::providers::tools::ToolResult,
) -> serde_json::Value {
    let result_json = serde_json::to_string(result).unwrap_or_default();
    serde_json::json!({
        "tool": tool_name,
        "arguments": compact_tool_arguments(arguments),
        "success": result.success,
        "error": result.error,
        "result_preview": truncate_for_sub_agent(&result_json, SUB_AGENT_TOOL_STEP_PREVIEW_CHARS),
        "result_chars": result_json.chars().count()
    })
}

impl AgentManager {
    async fn execute_sub_agent(
        &self,
        thread_id: &str,
        arguments: &str,
        runtime_workspace_paths: Option<&[String]>,
    ) -> crate::providers::tools::ToolResult {
        let args = match serde_json::from_str::<SubAgentArgs>(arguments) {
            Ok(args) => args,
            Err(e) => {
                return crate::providers::tools::ToolResult::error(format!(
                    "Invalid arguments: {e}"
                ))
            }
        };

        if args.system_prompt.trim().is_empty() {
            return crate::providers::tools::ToolResult::error("system_prompt cannot be empty");
        }
        if args.user_prompt.trim().is_empty() {
            return crate::providers::tools::ToolResult::error("user_prompt cannot be empty");
        }

        let config = self.user_config.get_ai_config().model;
        if config.model.trim().is_empty()
            || (provider_kind(&config.provider) != FlowixProviderKind::Ollama
                && config.effective_api_key(&config.provider).trim().is_empty())
        {
            return crate::providers::tools::ToolResult::error(
                "AI model is not configured; open Preferences -> Agent to set model and api key",
            );
        }

        let system_prompt = args.system_prompt.clone();
        let tools = get_sub_agent_tools();
        let provider = match build_chat_provider(&config, system_prompt.clone(), &tools) {
            Ok(provider) => provider,
            Err(err) => {
                return crate::providers::tools::ToolResult::error(format!(
                    "sub_agent provider setup failed: {err}"
                ))
            }
        };
        let max_cycles = args
            .max_tool_cycles
            .unwrap_or(DEFAULT_SUB_AGENT_MAX_TOOL_CYCLES)
            .min(MAX_SUB_AGENT_TOOL_CYCLES);
        let token_budget = config.max_total_tokens;

        let mut messages = vec![OpenAICompatibleChatMessage {
            role: ChatRole::User,
            content: args.user_prompt,
            message_type: MessageType::Text,
            reasoning: None,
        }];
        let mut tool_steps = Vec::new();
        let mut cycles_used = 0u32;

        loop {
            let estimated_tokens = estimate_tokens_from_chars(system_prompt.chars().count())
                .saturating_add(estimate_llm_message_tokens(&messages));
            if token_budget > 0 && estimated_tokens > token_budget {
                return crate::providers::tools::ToolResult::error(format!(
                    "sub_agent token budget exceeded before model call: estimated {estimated_tokens} of {token_budget} total tokens"
                ));
            }

            let response = match provider.chat_with_tools(&messages, Some(&tools)).await {
                Ok(response) => response,
                Err(e) => {
                    return crate::providers::tools::ToolResult::error(format!(
                        "sub_agent model call failed: {e}"
                    ));
                }
            };

            let text = response.text().unwrap_or_default();
            let tool_calls = response.tool_calls().unwrap_or_default();

            if tool_calls.is_empty() {
                return crate::providers::tools::ToolResult::success(serde_json::json!({
                    "answer": text,
                    "tool_steps": tool_steps,
                    "cycles": cycles_used,
                    "estimated_tokens": estimated_tokens
                }));
            }

            if cycles_used >= max_cycles {
                return crate::providers::tools::ToolResult::error(format!(
                    "sub_agent exceeded {max_cycles} tool-call cycles without a final answer"
                ));
            }

            messages.push(OpenAICompatibleChatMessage {
                role: ChatRole::Assistant,
                content: text.clone(),
                message_type: MessageType::ToolUse(tool_calls.clone()),
                reasoning: response.thinking().filter(|s| !s.trim().is_empty()),
            });

            let mut results = Vec::with_capacity(tool_calls.len());
            for call in tool_calls {
                let name = call.function.name.clone();
                let result = match name.as_str() {
                    "available_dirs" | "read" | "ls" | "glob" | "grep" | "load_skill" => {
                        execute_tool(
                            &name,
                            &call.function.arguments,
                            &self.memo_file,
                            &self.agent_access,
                            Some(self.security_bookmarks.clone()),
                            &self.skill_store,
                            runtime_workspace_paths,
                            None,
                        )
                        .await
                    }
                    _ => crate::providers::tools::ToolResult::error(format!(
                        "sub_agent cannot call tool '{name}'"
                    )),
                };
                if !result.success {
                    if let Some(err_msg) = result.error.as_deref() {
                        runtime_log::record_agent_event(
                            "error",
                            "sub_agent_tool_error",
                            "sub_agent.tool_execution_failed",
                            err_msg,
                            Some(thread_id),
                            Some(&name),
                            None,
                        );
                    }
                }
                let result_json = serde_json::to_string_pretty(&result)
                    .unwrap_or_else(|_| r#"{"error":"serialization failed"}"#.to_string());
                let truncated_result_json =
                    truncate_for_sub_agent(&result_json, SUB_AGENT_MAX_TOOL_RESULT_CHARS);
                tool_steps.push(summarize_tool_result_for_history(
                    &name,
                    &call.function.arguments,
                    &result,
                ));
                results.push(LlmToolCall {
                    id: call.id,
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: "tool_result".to_string(),
                        arguments: truncated_result_json,
                    },
                });
            }

            messages.push(OpenAICompatibleChatMessage {
                role: ChatRole::User,
                content: String::new(),
                message_type: MessageType::ToolResult(results),
                reasoning: None,
            });
            cycles_used = cycles_used.saturating_add(1);
        }
    }

    pub(super) async fn execute_tool_for_thread(
        &self,
        thread_id: &str,
        tool_name: &str,
        arguments: &str,
        message: &AgentUserMessage,
    ) -> crate::providers::tools::ToolResult {
        let runtime_workspace_paths = message.runtime_workspace_paths_for_runtime("flowix");

        if tool_name == crate::providers::tools::sub_agent::TOOL_NAME {
            return self
                .execute_sub_agent(thread_id, arguments, runtime_workspace_paths.as_deref())
                .await;
        }

        let path_key = tool_path_key(arguments);
        let read_snapshot = if tool_name == "edit" {
            match path_key.as_ref() {
                Some(path_key) => {
                    let snapshots = self.read_snapshots.read().await;
                    snapshots
                        .get(thread_id)
                        .and_then(|files| files.get(path_key))
                        .cloned()
                }
                None => None,
            }
        } else {
            None
        };

        // Plan B: Agent 不再 mark_self_write, 也不再手动 emit memo-event。
        // 一切磁盘变更交给 fs_watcher 的 dispatch_modify_event 单点处理 —
        // 它走 frontmatter-key-first 分流, 自动用 reload_memo_from_disk_by_filename
        // (或 register_existing_file) 同步 memo index, 然后 emit
        // `MemoEvent::Updated` / `Created` (source: ExternalTool)。

        // `self.memo_file` 是 `Arc<RwLock<MemoFile>>`, 解引用后调用 `.read()`
        // 自动得到 `&RwLock<MemoFile>`, 喂给 `execute_tool` 的形参类型。
        let result = execute_tool(
            tool_name,
            arguments,
            &self.memo_file,
            &self.agent_access,
            Some(self.security_bookmarks.clone()),
            &self.skill_store,
            runtime_workspace_paths.as_deref(),
            read_snapshot.as_deref(),
        )
        .await;

        // 工具调用失败 ── 把错误镜像到 agent.log。 注意这**不替代**把错误
        // 交还 LLM: 下面 `ToolResult` chunk 仍然 emit 到前端, thread.db 也
        // 落 tool_data (success=false) 行, LLM 下轮 reload 时能看到, 由
        // LLM 自己决定是改路径 / 换工具 / 收口。 agent.log 这里是排障的
        // 镜像 ── 用户事后反馈"刚才 LLM 怎么愣在那里"时, 能直接 grep
        // `kind=tool_error` 看具体哪条工具调用吃了什么 error。
        if !result.success {
            if let Some(err_msg) = result.error.as_deref() {
                runtime_log::record_agent_event(
                    "error",
                    "tool_error",
                    "tool.execution_failed",
                    err_msg,
                    Some(thread_id),
                    Some(tool_name),
                    None,
                );
            }
        }

        if result.success {
            match tool_name {
                "read" => {
                    if let Some(path_key) = path_key {
                        // 跟 filesystem.rs::read 走同样路径 ── 改 `tokio::fs::read_to_string`
                        // 让 worker 不被同步 I/O 卡死, 单次大文件读盘不再冻住整个
                        // ReAct 循环。 read 工具本身已切到 tokio::fs, 这里跟它对齐。
                        if let Ok(content) = tokio::fs::read_to_string(&path_key).await {
                            let mut snapshots = self.read_snapshots.write().await;
                            snapshots
                                .entry(thread_id.to_string())
                                .or_default()
                                .insert(path_key, content);
                        }
                    }
                }
                "write" | "edit" => {
                    if let Some(path_key) = path_key {
                        // 清掉 read 快照: 文件可能变了, 旧快照失效。
                        // edit 工具的 drift 检测依赖 read_snapshot, 不清会让
                        // 下次 edit 用过期快照报 "File changed on disk" 假阳性。
                        let mut snapshots = self.read_snapshots.write().await;
                        if let Some(files) = snapshots.get_mut(thread_id) {
                            files.remove(&path_key);
                        }
                        // memo index 同步 + memo-event emit 完全交给 fs_watcher
                        // (dispatch_modify_event: frontmatter-key-first 分流 →
                        //  reload_memo_from_disk_by_filename / register_unnamed_file →
                        //  emit source=ExternalTool)。Agent 不再自己 emit。
                    }
                }
                _ => {}
            }
        }

        result
    }
}
