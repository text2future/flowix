use std::path::PathBuf;

use rllm::chat::{ChatRole, MessageType};
use rllm::{FunctionCall, ToolCall as LlmToolCall};
use serde::Deserialize;

use crate::agent_flowix::providers::OpenAICompatibleChatMessage;
use crate::agent_flowix::tools::{execute_tool, get_sub_agent_tools};
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
    result: &crate::agent_flowix::tools::ToolResult,
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
    ) -> crate::agent_flowix::tools::ToolResult {
        let args = match serde_json::from_str::<SubAgentArgs>(arguments) {
            Ok(args) => args,
            Err(e) => {
                return crate::agent_flowix::tools::ToolResult::error(format!(
                    "Invalid arguments: {e}"
                ))
            }
        };

        if args.system_prompt.trim().is_empty() {
            return crate::agent_flowix::tools::ToolResult::error("system_prompt cannot be empty");
        }
        if args.user_prompt.trim().is_empty() {
            return crate::agent_flowix::tools::ToolResult::error("user_prompt cannot be empty");
        }

        let config = self.user_config.get_ai_config().model;
        if config.model.trim().is_empty()
            || (provider_kind(&config.provider) != FlowixProviderKind::Ollama
                && config.effective_api_key(&config.provider).trim().is_empty())
        {
            return crate::agent_flowix::tools::ToolResult::error(
                "AI model is not configured; open Preferences -> Agent to set model and api key",
            );
        }

        let system_prompt = args.system_prompt.clone();
        let tools = get_sub_agent_tools();
        let provider = match build_chat_provider(&config, system_prompt.clone(), &tools) {
            Ok(provider) => provider,
            Err(err) => {
                return crate::agent_flowix::tools::ToolResult::error(format!(
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
                return crate::agent_flowix::tools::ToolResult::error(format!(
                    "sub_agent token budget exceeded before model call: estimated {estimated_tokens} of {token_budget} total tokens"
                ));
            }

            let response = match provider.chat_with_tools(&messages, Some(&tools)).await {
                Ok(response) => response,
                Err(e) => {
                    return crate::agent_flowix::tools::ToolResult::error(format!(
                        "sub_agent model call failed: {e}"
                    ));
                }
            };

            let text = response.text().unwrap_or_default();
            let tool_calls = response.tool_calls().unwrap_or_default();

            if tool_calls.is_empty() {
                return crate::agent_flowix::tools::ToolResult::success(serde_json::json!({
                    "answer": text,
                    "tool_steps": tool_steps,
                    "cycles": cycles_used,
                    "estimated_tokens": estimated_tokens
                }));
            }

            if cycles_used >= max_cycles {
                return crate::agent_flowix::tools::ToolResult::error(format!(
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
                    _ => crate::agent_flowix::tools::ToolResult::error(format!(
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
    ) -> crate::agent_flowix::tools::ToolResult {
        let runtime_workspace_paths = message.runtime_workspace_paths_for_runtime("flowix");

        if tool_name == crate::agent_flowix::tools::sub_agent::TOOL_NAME {
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

        // Plan B: Agent 涓嶅啀 mark_self_write, 涔熶笉鍐嶆墜鍔?emit memo-event銆?        // 涓€鍒囩鐩樺彉鏇翠氦缁?watcher 鐨?dispatch_modify_event 鍗曠偣澶勭悊 鈥?        // 瀹冭蛋 frontmatter-key-first 鍒嗘祦, 鑷姩鐢?reload_memo_from_disk_by_filename
        // (鎴?register_existing_file) 鍚屾 memo index, 鐒跺悗 emit
        // `MemoEvent::Updated` / `Created` (source: ExternalTool)銆?
        // `self.memo_file` 鏄?`Arc<RwLock<MemoFile>>`, 瑙ｅ紩鐢ㄥ悗璋冪敤 `.read()`
        // 鑷姩寰楀埌 `&RwLock<MemoFile>`, 鍠傜粰 `execute_tool` 鐨勫舰鍙傜被鍨嬨€?
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

        // 宸ュ叿璋冪敤澶辫触 鈹€鈹€ 鎶婇敊璇暅鍍忓埌 agent.log銆?娉ㄦ剰杩?*涓嶆浛浠?*鎶婇敊璇?        // 浜よ繕 LLM: 涓嬮潰 `ToolResult` chunk 浠嶇劧 emit 鍒板墠绔? thread.db 涔?        // 钀?tool_data (success=false) 琛? LLM 涓嬭疆 reload 鏃惰兘鐪嬪埌, 鐢?        // LLM 鑷繁鍐冲畾鏄敼璺緞 / 鎹㈠伐鍏?/ 鏀跺彛銆?agent.log 杩欓噷鏄帓闅滅殑
        // 闀滃儚 鈹€鈹€ 鐢ㄦ埛浜嬪悗鍙嶉"鍒氭墠 LLM 鎬庝箞鎰ｅ湪閭ｉ噷"鏃? 鑳界洿鎺?grep
        // `kind=tool_error` 鐪嬪叿浣撳摢鏉″伐鍏疯皟鐢ㄥ悆浜嗕粈涔?error銆?
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
                        // 璺?filesystem.rs::read 璧板悓鏍疯矾寰?鈹€鈹€ 鏀?`tokio::fs::read_to_string`
                        // 璁?worker 涓嶈鍚屾 I/O 鍗℃, 鍗曟澶ф枃浠惰鐩樹笉鍐嶅喕浣忔暣涓?                        // ReAct 寰幆銆?read 宸ュ叿鏈韩宸插垏鍒?tokio::fs, 杩欓噷璺熷畠瀵归綈銆?
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
                        // 娓呮帀 read 蹇収: 鏂囦欢鍙兘鍙樹簡, 鏃у揩鐓уけ鏁堛€?                        // edit 宸ュ叿鐨?drift 妫€娴嬩緷璧?read_snapshot, 涓嶆竻浼氳
                        // 涓嬫 edit 鐢ㄨ繃鏈熷揩鐓ф姤 "File changed on disk" 鍋囬槼鎬с€?
                        let mut snapshots = self.read_snapshots.write().await;
                        if let Some(files) = snapshots.get_mut(thread_id) {
                            files.remove(&path_key);
                        }
                        // memo index 鍚屾 + memo-event emit 瀹屽叏浜ょ粰 watcher
                        // (dispatch_modify_event: frontmatter-key-first 鍒嗘祦 鈫?
                        //  reload_memo_from_disk_by_filename / register_unnamed_file 鈫?
                        //  emit source=ExternalTool)銆侫gent 涓嶅啀鑷繁 emit銆?
                    }
                }
                _ => {}
            }
        }

        result
    }
}
