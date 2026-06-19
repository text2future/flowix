use crate::watcher::dispatcher;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

use crate::agent_access::AgentAccessStore;
use crate::prompt::{build_system_prompt, SystemPromptConfig};
use crate::providers::{
    execute_tool, get_all_tools, OpenAICompatibleConfig, OpenAICompatibleProvider,
    OpenAICompatibleStreamItem,
};
use crate::runtime_log;
use crate::skills::SkillStore;
use crate::threads::{ChatMessage as ThreadChatMessage, ThreadManager};
use crate::user_config::{AiModelConfig, UserConfigStore};
use flowix_core::memo_file::MemoFile;
use rllm::chat::{ChatMessage as LlmChatMessage, ChatRole, MessageType, Tool};
use rllm::{FunctionCall, ToolCall as LlmToolCall};
use uuid::Uuid;

/// 智能体 ID newtype ── 替代裸 `&str` / `String`, 防止把任意字符串当成 agent_id
/// 传进 [`crate::threads::ThreadManager::create_thread`]。当前应用同一时刻只有
/// "当前 ai_config 描述的那一个 agent", schema 仍保留 `agent_id` 列以兼容历史
/// 数据, 全部写入 [`default_agent_id`]`()`。
///
/// `#[serde(transparent)]` 让 wire 形状就是 `String` (例如 `"default"`), 与
/// 历史上 `ThreadInfo.agent_id: String` **二进制兼容** ── 旧 SQLite 行 / 旧
/// IPC payload 不用迁移。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub String);

impl AgentId {
    pub fn new(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for AgentId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for AgentId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

/// 线程表 `agent_id` 列的固定占位值。重构后前端不再传 agent_id, 但 schema
/// 仍保留该列以兼容历史数据, 所有新建 thread 全部写入此值。
///
/// 用函数而非 `pub const` 是因为 `String` 不能在 const 上下文构造; 调用方
/// 应缓存返回值, 不要每处都重新分配。
pub fn default_agent_id() -> AgentId {
    AgentId::new("default")
}

/// AgentManager 现在只维护"当前生效的 provider 实例", 真正的配置真源是
/// `~/.flowix/flowix-ai-config.toml` (经 `UserConfigStore` 暴露)。每次 chat
/// 调用前读最新配置, 与构建缓存的配置对比, 不一致则重建 provider。
///
/// 这样 ai_config 变更 (例如用户在偏好里换了模型 / API key) 不再依赖前端重新
/// "init agent", 后端自己感知并热替换。
///
/// 三个 `Arc<...>` 依赖从 `lib.rs` 注入, 与 `AppState` 共享同一份引用 (refcount=2):
/// - `user_config`: 读 flowix-ai-config.toml
/// - `thread_manager`: 落盘 chat 历史
/// - `memo_file`: 工具读写的真实笔记
///
/// 这三个字段之前是 `chat_stream` 等方法的 `app_state: &crate::commands::AppState`
/// 参数 ── 模块反向依赖 commands。注入后 agent 不再依赖 commands 模块, 可以
/// 单独测试 (见 `for_tests` 构造器)。
pub struct AgentManager {
    instance: tokio::sync::RwLock<Option<CachedInstance>>,
    /// 每个 thread 的 read 工具快照。edit 工具需要 read 后的内容做漂移检测。
    read_snapshots: tokio::sync::RwLock<HashMap<String, HashMap<String, String>>>,
    /// 每个 thread 的 (tool_name, args_hash) → 累计调用次数。
    /// 超过 STUCK_THRESHOLD 视为 LLM 卡在循环里, 熔断。LLM 给最终回答
    /// (无 tool call) 或 chat 异常退出时由 chat_stream 入口清空。
    tool_call_attempts: tokio::sync::RwLock<HashMap<String, HashMap<CallKey, u32>>>,
    /// 每个 thread 当前正在跑的 chat_stream 取消标志 ──
    /// chat_stream 入口 insert 一个新的 Arc<AtomicBool>, 退出 (任何路径)
    /// remove; stop_chat 通过 thread_id 查 Arc, set true, 然后立刻 remove
    /// (单次信号, 不重复触发)。拆 mutex + remove 一步完成避免
    /// "查到有但 remove 之前 chat_stream 已退出" 的竞态。
    cancel_flags: tokio::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 每个 in-flight thread 的开始时间戳 (epoch millis) ── 给
    /// `agent_running_threads` IPC 用, 让前端启动时能 seed 哪些 thread
    /// 在后台跑。`chat_stream` 入口 insert, spawn task 退出时 remove,
    /// 镜像 `cancel_flags` 的生命周期。
    started_at: tokio::sync::Mutex<HashMap<String, i64>>,
    /// ai_config 真源 (`~/.flowix/flowix-ai-config.toml`)
    user_config: Arc<UserConfigStore>,
    /// 线程表 (chat 历史的持久化)
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    /// 笔记本文件 (工具读写的对象)
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    /// Agent 可访问目录真源 (`~/.flowix/agent_access.json`)。
    /// `execute_tool` 把它喂给 `ToolScope::from_memo_file_and_access`
    /// 决定 `allowed_roots`, 也用来过滤 `available_dirs` 工具的返回。
    agent_access: Arc<AgentAccessStore>,
    /// Skills registry (`~/.flowix/skills/.system/` + 用户自添加)。
    /// 系统 prompt builder 读 `summaries()` 注入 "# Skills" 段;
    /// `load_skill` 工具 handler 读 `get(name)` 拿 body。
    /// 启动后不可变 ── 无内部锁, `Arc` 共享给 prompt builder / tool handler。
    skill_store: Arc<SkillStore>,
}

/// 在 `AgentManager` drop 时清掉与每个 thread 关联的 in-memory 状态 ──
/// 解决 #3.5: Tauri 进程退出时 `instance: tokio::sync::RwLock<Option<CachedInstance>>`
/// 里的 `CachedInstance` (含 rllm client / reqwest HTTP client) 不
/// graceful shutdown, 可能造成:
/// - 在飞请求被截断 (用户看到一半的响应)
/// - 连接池未 flush (操作系统层面 close, 但我们没法等)
///
/// 不在 drop 里 spawn 额外 task 强 cancel 活跃 stream ── 留给 reqwest 自销毁。
/// `instance` / `read_snapshots` / `tool_call_attempts` / `cancel_flags` 都是
/// `Arc<...>`, 单个 owner drop 时 refcount 减一, 不阻塞真正的 I/O 关停。
/// 只负责把"我们维护的"状态显式打 log, 便于排障时区分"我 drop 了" vs
/// "进程被 SIGKILL"。
impl Drop for AgentManager {
    fn drop(&mut self) {
        tracing::info!("[AgentManager] dropping; flushing in-memory state");
        // 锁取不到不阻塞 ── 锁中毒或活跃写锁都不会让 Drop 失败, 这条
        // 路径是进程退出最后的清理, 不该 panic。
        if let Ok(snapshots) = self.read_snapshots.try_read() {
            if !snapshots.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} read_snapshots entries",
                    snapshots.len()
                );
            }
        }
        if let Ok(attempts) = self.tool_call_attempts.try_read() {
            if !attempts.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} tool_call_attempts entries",
                    attempts.len()
                );
            }
        }
        if let Ok(flags) = self.cancel_flags.try_lock() {
            if !flags.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} active cancel flags",
                    flags.len()
                );
            }
        }
    }
}

struct CachedInstance {
    config: AiModelConfig,
    instance: AgentInstance,
}

#[derive(Clone)]
pub struct AgentInstance {
    provider: Arc<OpenAICompatibleProvider>,
    tools: Vec<Tool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserMessage {
    pub content: String,
    pub llm_content: Option<String>,
    pub system_reminder_directory: Option<String>,
    pub runtime: Option<String>,
    pub permission_mode: Option<String>,
    pub codex_model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    /// Fire-and-forget 后永远是空串 ── `chat_stream` 内部 spawn 后立刻
    /// `Ok(String::new())` 返回。真正的助手回答走 `agent-chunk` 事件的
    /// `Text` / `Reasoning` 变体。保留字段是为了不破坏既有 IPC 形状。
    pub response: String,
}

/// `agent_running_threads` IPC 返回值 ── 一个 thread_id → 元信息的快照。
/// 启动时前端拉一次, seed `threadStates[].isLoading = true`。
///
/// `started_at` 用途: UI 显示"X 分钟前开始"; Phase 1 主要用 isLoading 布尔。
/// `current_tool` 暂为 None (见 [`AgentManager::running_threads`])。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub started_at: i64,
    pub current_tool: Option<String>,
}

/// agent 流式协议 — emit 到 `agent-chunk` 事件, 前端 `client.ts:listenToAgentStream`
/// 用 `listen<AgentChunk>` 接收。前端 TypeScript 镜像见
/// `app/flowix-web/types/agent.ts` 的同名类型。
///
/// 用 `#[serde(tag = "kind")]` 内部标签, 前端 `switch (chunk.kind)` 判别;
/// 替换之前 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:`
/// 字符串前缀协议 ── 那种协议下 [ERROR] chunk 会被前端 fallthrough 当成普通文本
/// 拼到 assistant 正文, 这里是结构化错误事件。
///
/// **每个变体都带 `thread_id`** — 多对话后台并行时, 前端 store 按 thread_id
/// 派发到 `threadStates[tid]`, 互不串台。
///
/// **Wire 形状**: Tauri `app.emit("agent-chunk", &chunk)` 不做字段重命名,
/// 直接用 serde 序列化结果。`AgentChunk` 没有 `#[serde(rename_all)]`,
/// 字段名保持 snake_case ── `thread_id` 在 JSON 里就是 `thread_id`。
/// TS 端 listener 拿到的 `payload.thread_id` 与 Rust 字段同名
/// (与现有 `memo-event` 的 `payload.memo` / `payload.source` 命名习惯一致)。
/// 这跟 IPC command args/returns 的 `camelCase` 约定是两套规则 ──
/// 后者有 Tauri 自动转换, 前者没有, 不要混。
///
/// `StreamStart` / `StreamEnd` 是生命周期变体, 由 `chat_stream` 外层在
/// insert / remove cancel_flag 时各 emit 一次 ── 覆盖所有退出路径
/// (Ok / Err / panic-via-drop)。前端靠它们收敛 `isLoading`, 不再依赖
/// IPC `chat_with_agent_stream` 的 await finally 块 (该 IPC 在新模型下
/// 立即返回, 不再等待 stream 跑完)。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChunk {
    /// 助手流式回答 (普通 content)
    Text { thread_id: String, text: String },
    /// 推理模型的思考过程 (reasoning_content)
    Reasoning { thread_id: String, text: String },
    /// LLM 发出的工具调用
    ToolCall {
        thread_id: String,
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// 工具执行结果
    ToolResult {
        thread_id: String,
        id: String,
        name: String,
        result: serde_json::Value,
    },
    /// 错误事件 (卡死 / 超 cycle / stream error / not configured 等)
    // TODO: evolve into a structured variant ({ kind: "stuck" | "max_cycles" |
    // "stream" | "not_configured", ... }) when the frontend needs to discriminate
    // error sources. v1 keeps the message as opaque String ── the wire shape
    // crosses the IPC boundary as JSON and is parsed by `chat-store.ts:switch`.
    Error { thread_id: String, message: String },
    /// Stream 开始 ── chat_stream 入口 insert cancel_flag 后 emit 一次。
    /// 前端借此把对应 thread 的 `isLoading` 置 true。
    StreamStart { thread_id: String },
    /// Stream 结束 ── chat_stream 出口 remove cancel_flag 前 emit 一次。
    /// 覆盖所有退出路径 (Ok / Err / panic)。`reason` 可选, 留作未来
    /// 区分 "自然完成" vs "用户主动 stop" vs "stuck 熔断" 等场景。
    StreamEnd {
        thread_id: String,
        reason: Option<String>,
    },
}

/// 同一 (tool_name, args) 累计调用次数超过该阈值就判定 LLM 卡在循环里, 熔断。
/// 阈值语义: 计数 > STUCK_THRESHOLD 时返回 true (即第 6 次同调用触发)。
const STUCK_THRESHOLD: u32 = 5;

/// LLM 网关返回 400 "invalid function arguments json string" 时, 先 sanitize
/// 上轮落盘的 `tool_calls[*].function.arguments`, 再重发。该上限控制 sanitize
/// 失败时的重试次数 ── 超过就当普通 LLM 错误处理, 走 synthesize 出口。
const MAX_LLM_RECOVERY_RETRIES: u32 = 2;

/// True if the LLM gateway's error message indicates a recoverable
/// tool-arguments problem (typically: 400 with concatenated/garbled JSON
/// from a prior turn). The recovery loop's sanitize-and-retry path is
/// only entered when this returns true; for other 4xx/5xx (auth, rate
/// limit, server) we synthesize and end immediately.
fn is_recoverable_args_error(reason: &str) -> bool {
    reason.contains("invalid function arguments") || reason.contains("tool_call_id")
}

/// agent 层错误。`Thread` / `UserConfig` 透传 `#[from]`, 让 agent 内部
/// `?` 一步到位 (例如 `manager.get_thread(...)?`)。语义错误 (stuck / max cycles /
/// not configured) 显式构造, 配合 Tauri IPC 边界 `.map_err(|e| e.to_string())`
/// 转字符串给前端。
///
/// 复合变体 `Thread(ThreadError::Sqlite(rusqlite::Error))` 显示为
/// `"agent error: thread error: thread database error: <rusqlite>"` ── 三层前缀。
/// 嫌长可改 `#[error(transparent)]` on the wrapper, 但 v1 保持显式便于排查。
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("thread error: {0}")]
    Thread(#[from] crate::threads::ThreadError),
    #[error("user config error: {0}")]
    UserConfig(#[from] crate::user_config::UserConfigError),
    #[error("ai model not configured; open Preferences → Agent to set model and api key")]
    NotConfigured,
    #[error("agent stuck: tool '{tool}' called {count} times with identical arguments")]
    Stuck { tool: String, count: u32 },
    /// 单次 `chat_stream` 跨所有 cycle 累计的 `total_tokens` 超出 ai_config 里
    /// 的 `max_total_tokens` 上限 ── 配合 `finalize_with_synthesized_message` 走
    /// "assistant 正常收口 + emit Error chunk" 路径, 与 `Stuck` 同形, UI 不弹
    /// 错误 toast。`used` / `budget` 一并带回便于前端展示用量。
    #[error("token budget exceeded: used {used} of {budget} total tokens")]
    TokenBudget { used: u32, budget: u32 },
}

/// (tool_name, args_hash) 元组作为 HashMap key, 用于检测"同一工具同一参数"
/// 重复调用的循环模式。args_hash 用 DefaultHasher 计算, 在同一进程内稳定
/// (跨进程不必稳定, 我们不需要比较重启前后的快照)。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CallKey {
    tool_name: String,
    args_hash: u64,
}

fn compute_call_key(tool_name: &str, arguments: &str) -> CallKey {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    arguments.hash(&mut hasher);
    CallKey {
        tool_name: tool_name.to_string(),
        args_hash: hasher.finish(),
    }
}

/// Build the user-facing message for an LLM-side failure. Pure function —
/// extracted from `synthesize_llm_unavailable` so it can be unit-tested
/// without a Tauri `AppHandle`. The reason is taken verbatim (callers
/// strip any wrapper prefix before calling).
fn format_llm_unavailable_message(reason: &str) -> String {
    format!("(LLM 暂时不可用, 原因: {})", reason)
}

/// Emit an `agent-chunk` event to the frontend, logging a warning on failure
/// instead of silently swallowing the error.
///
/// 替换历史 8 处 `let _ = app_handle.emit(...)` ── 之前错误被吞, 前端
/// `listen<AgentChunk>` 断了后整个 agent 流静默失败: 用户看不到 LLM 响应,
/// 但后端 stream 继续跑、token 照花 (issue #3.3)。helper 不返回错误, 仍然
/// fire-and-forget ── emit 失败不应阻塞 chat 主路径, 但留下可见痕迹便于
/// 排障 ("前端 webview 死了 / IPC 通道断了" 这类问题从无声变成有迹)。
///
/// 所有调用方必须先把 `thread_id` 注入 chunk (`AgentChunk` 每个变体自带
/// `thread_id: String`)。这块没法用 `Into` 简写, 因为每个变体字段名不同;
/// 改为由调用点显式构造完整 chunk 再传进来 ── 反而强制每次 emit 都写明
/// thread 来源, 防止某个 inner loop 误用外层 thread_id。
fn emit_chunk(app_handle: &tauri::AppHandle, chunk: &AgentChunk) {
    // 走统一 emit_to 入口, 但需要诊断 (子轮序纯火
    // 不能隐匿) —— dispatcher::emit_to 返回 bool 表示是否成功发送。
    if !dispatcher::emit_to(app_handle, "agent-chunk", chunk) {
        tracing::warn!(
            chunk_kind = ?std::mem::discriminant(chunk),
            "[Agent] emit agent-chunk failed; frontend may be disconnected"
        );
    }
}

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
struct IsLoadingGuard {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    thread_id: String,
    tool_call_id: String,
}

impl IsLoadingGuard {
    fn new(
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

/// 把持久化行转回 rllm 的 ChatMessage。返回 None 表示该行不进 LLM 上下文
/// (reasoning / system / 残缺 tool 等待)。
///
/// 转换规则:
/// - user → User, content = llm_content ?? content, Text
/// - assistant 带 tool_calls → Assistant, content, ToolUse(反序列化的 Vec<ToolCall>)
/// - assistant 不带 tool_calls → Assistant, content, Text
/// - tool 带 tool_data → User(content = tool_data), ToolResult(vec![ToolCall{ id, function{name: "tool_result", arguments: tool_data }}])
/// - tool 不带 tool_data → None (避免给 LLM 看空 tool result)
/// - reasoning / system / 其它 → None
///
/// 工具结果用 `role: User` 包一层是 rllm 的约定 (它的 ChatRole 只有 User/Assistant),
/// provider 看 MessageType 而不是 role 决定发什么, 跟 rllm 自带参考实现 (llm crate 的
/// `providers/openai_compatible.rs`) 一致。
fn persisted_to_llm(m: crate::threads::ChatMessage) -> Option<LlmChatMessage> {
    match m.role.as_str() {
        "user" => Some(LlmChatMessage {
            role: ChatRole::User,
            content: m.llm_content.unwrap_or(m.content),
            message_type: MessageType::Text,
        }),
        "assistant" => {
            let message_type = match m.tool_calls {
                Some(serde_json::Value::Array(arr)) => {
                    let calls: Vec<LlmToolCall> = arr
                        .into_iter()
                        .filter_map(|v| serde_json::from_value::<LlmToolCall>(v).ok())
                        .collect();
                    if calls.is_empty() {
                        MessageType::Text
                    } else {
                        MessageType::ToolUse(calls)
                    }
                }
                Some(serde_json::Value::Null) | None => MessageType::Text,
                // tool_calls 形状不预期 (非数组) — 当作普通文本, 不喂垃圾给 LLM
                _ => MessageType::Text,
            };
            Some(LlmChatMessage {
                role: ChatRole::Assistant,
                content: m.content,
                message_type,
            })
        }
        "tool" => {
            let data = m.tool_data?;
            let call_id = m.tool_call_id?;
            Some(LlmChatMessage {
                role: ChatRole::User,
                content: data.clone(),
                message_type: MessageType::ToolResult(vec![LlmToolCall {
                    id: call_id,
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: "tool_result".to_string(),
                        arguments: data,
                    },
                }]),
            })
        }
        _ => None, // reasoning / system / end / 其它
    }
}

impl AgentManager {
    /// 构造时必须传入 5 个共享依赖 ── 与 `AppState` 持有同一份 Arc 引用。
    /// 这样 `agent` 模块不再依赖 `commands::AppState` (历史 P2-#2 反向依赖)。
    pub fn new(
        user_config: Arc<UserConfigStore>,
        thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
        memo_file: Arc<std::sync::RwLock<MemoFile>>,
        agent_access: Arc<AgentAccessStore>,
        skill_store: Arc<SkillStore>,
    ) -> Self {
        Self {
            instance: tokio::sync::RwLock::new(None),
            read_snapshots: tokio::sync::RwLock::new(HashMap::new()),
            tool_call_attempts: tokio::sync::RwLock::new(HashMap::new()),
            cancel_flags: tokio::sync::Mutex::new(HashMap::new()),
            started_at: tokio::sync::Mutex::new(HashMap::new()),
            user_config,
            thread_manager,
            memo_file,
            agent_access,
            skill_store,
        }
    }

    /// 测试用 fixture ── 用空 / 临时路径构造 5 个依赖, 不真正读写磁盘。
    /// 现存的单元测试只验证 `record_tool_call` / `clear_tool_call_attempts` /
    /// `cleanup_thread` 的 HashMap 状态, 不触碰 `user_config` / `thread_manager` /
    /// `memo_file` / `agent_access` (参见 `cleanup_thread_removes_read_snapshot`
    /// 注释: "can't call `execute_tool_for_thread` because it lacks `memo_file`")。
    /// skill_store 用空目录构造 (没有 SKILL.md 时返回空 store, 不影响既有断言)。
    #[cfg(test)]
    pub fn for_tests() -> Self {
        let home = std::env::temp_dir().join(format!("agent_mgr_test_{}", std::process::id()));
        std::fs::create_dir_all(&home).ok();
        let skills_root = home.join("skills");
        std::fs::create_dir_all(&skills_root).ok();
        Self::new(
            Arc::new(UserConfigStore::new(home.clone())),
            Arc::new(tokio::sync::RwLock::new(
                crate::threads::ThreadManager::for_tests(),
            )),
            Arc::new(std::sync::RwLock::new(MemoFile::default())),
            Arc::new(AgentAccessStore::new(
                home.join(".flowix"),
                &MemoFile::default(),
            )),
            Arc::new(SkillStore::load(&skills_root)),
        )
    }

    /// 拿到与当前 ai_config 对应的 provider 实例; 配置缺 model 则报错。
    ///
    /// 走双读锁: 先 read 尝试命中缓存, 不命中再升级到 write 重建。这样并发 chat
    /// 不会互相阻塞 — 只有真正发生配置变更时才有写锁竞争。
    async fn ensure_instance(&self, config: &AiModelConfig) -> Result<AgentInstance, AgentError> {
        if config.model.trim().is_empty() {
            return Err(AgentError::NotConfigured);
        }
        {
            let guard = self.instance.read().await;
            if let Some(cached) = guard.as_ref() {
                if &cached.config == config {
                    return Ok(cached.instance.clone());
                }
            }
        }
        let instance = self.build_instance(config);
        let mut guard = self.instance.write().await;
        *guard = Some(CachedInstance {
            config: config.clone(),
            instance: instance.clone(),
        });
        Ok(instance)
    }

    fn build_instance(&self, config: &AiModelConfig) -> AgentInstance {
        // Enable reasoning_split to separate thinking from final response
        let reasoning_split = config.model.contains("MiniMax");
        // 系统 prompt 注入 skills 摘要 (`# Skills` 段), LLM 看到名字后按需
        // `load_skill` 拉全文 ── `summaries()` 是稳定排序, 跨重启无漂移。
        let system_prompt = build_system_prompt(SystemPromptConfig {
            model: &config.model,
            tools_enabled: true,
            skills: self.skill_store.summaries(),
        });

        let provider = OpenAICompatibleProvider::new(
            OpenAICompatibleConfig::new(&config.api_key, &config.model, &config.api_url)
                .with_system(system_prompt)
                .with_reasoning_split(reasoning_split),
        );

        AgentInstance {
            provider: Arc::new(provider),
            tools: get_all_tools(),
        }
    }

    /// 记录本轮 (tool, args) 调用, 返回是否达到熔断阈值。
    /// 调用次数 > STUCK_THRESHOLD 时返回 true, 第 6 次同调用即触发。
    async fn record_tool_call(&self, thread_id: &str, tool_name: &str, arguments: &str) -> bool {
        let key = compute_call_key(tool_name, arguments);
        let mut attempts = self.tool_call_attempts.write().await;
        let thread_attempts = attempts.entry(thread_id.to_string()).or_default();
        let count = thread_attempts.entry(key).or_insert(0);
        *count += 1;
        *count > STUCK_THRESHOLD
    }

    /// 清空该 thread 的累计计数。下次 chat_stream 入口会兜底再调一次,
    /// 这里主要给"LLM 给最终回答"的清空信号使用。
    async fn clear_tool_call_attempts(&self, thread_id: &str) {
        let mut attempts = self.tool_call_attempts.write().await;
        attempts.remove(thread_id);
    }

    /// 删除 thread 时清理 AgentManager 内与该 thread 关联的所有 in-memory 状态。
    /// 解决 "thread_delete 走 ThreadManager 但不通知 AgentManager" 造成的
    /// read_snapshots / tool_call_attempts HashMap 长期泄露。
    /// 多次调用幂等, 不存在的 thread_id 静默 no-op。
    pub async fn cleanup_thread(&self, thread_id: &str) {
        let mut snapshots = self.read_snapshots.write().await;
        snapshots.remove(thread_id);
        let mut attempts = self.tool_call_attempts.write().await;
        attempts.remove(thread_id);
    }

    /// 查询当前所有 in-flight chat ── 供前端 `agent_running_threads`
    /// IPC 调用。前端启动时调用一次, seed 到 `threadStates[].isLoading`。
    ///
    /// 返回值映射 `thread_id -> { started_at, current_tool }` ──
    /// `current_tool` 暂时是 `None`, 因为 ReAct 循环的 `last_tool_name`
    /// 是函数局部变量, 不在 manager state 里。Phase 1 不需要, 等
    /// UI 真用上再补一个 in-flight tool 镜像。
    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let started = self.started_at.lock().await;
        started
            .iter()
            .map(|(tid, started_at)| {
                (
                    tid.clone(),
                    RunInfo {
                        started_at: *started_at,
                        current_tool: None,
                    },
                )
            })
            .collect()
    }

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
    async fn sanitize_persisted_tool_calls(&self, thread_id: &str) -> Result<bool, AgentError> {
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

    /// Common end-of-cycle exit. Emits the message as a `Text` chunk
    /// (so the frontend appends it to / creates the assistant message via
    /// the `text` case at chat-store.ts:280), persists the same text as
    /// a `role: assistant` row, clears the stuck-detection counter, and
    /// returns `Ok(msg)`. Used by `synthesize_llm_unavailable`, the
    /// `Stuck` abort site, and the `MaxCycles` abort site — all three
    /// were doing the same shape before this helper existed.
    async fn finalize_with_synthesized_message(
        &self,
        thread_id: &str,
        msg: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, AgentError> {
        emit_chunk(
            app_handle,
            &AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: msg.clone(),
            },
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
    async fn synthesize_llm_unavailable(
        &self,
        thread_id: &str,
        reason: &str,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, AgentError> {
        let synth_msg = format_llm_unavailable_message(reason);
        tracing::warn!("[Agent] LLM unavailable, synthesizing assistant message: {synth_msg}");
        self.finalize_with_synthesized_message(thread_id, synth_msg, app_handle)
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
    /// and the new task share the same `cancel_flags` slot, so the new
    /// task's `remove` on exit won't prematurely tear down the new flag.
    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, AgentError> {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut flags = self.cancel_flags.lock().await;
            // 自打断: 如果该 thread 已有 in-flight chat, 先 set true
            // 让旧 chat 在下一个 checkpoint 走 flush_cancel, 再 install
            // 新 flag。旧 task 退出时会 remove 自己的 flag (现在是 cancel
            // 变量里那个 true 的 Arc), 不会误删新 task 的 flag。
            if let Some(old) = flags.remove(thread_id) {
                old.store(true, Ordering::Release);
                tracing::info!(
                    "[Agent] self-interrupt for thread_id {thread_id} (previous chat in flight)"
                );
            }
            flags.insert(thread_id.to_string(), cancel.clone());
        }

        // 镜像 started_at ── 给 `agent_running_threads` 查询用。
        self.started_at
            .lock()
            .await
            .insert(thread_id.to_string(), chrono::Utc::now().timestamp_millis());

        emit_chunk(
            app_handle,
            &AgentChunk::StreamStart {
                thread_id: thread_id.to_string(),
            },
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
        tokio::spawn(async move {
            let result = me
                .chat_stream_inner(&tid_owned, message, &app_handle_owned, &cancel_for_task)
                .await;

            // 任何路径退出都要 unregister + emit StreamEnd。任务结束前
            // 先清 cancel_flags, 再清 started_at, 最后 emit ── 前端
            // 收到 StreamEnd 时, 我们的 in-memory 状态已经归零, 任何
            // 立即触发的 `agent_running_threads` 查询都看不到这个 thread
            // (与"stream 真结束了"的语义一致)。
            {
                let mut flags = me.cancel_flags.lock().await;
                flags.remove(&tid_owned);
            }
            {
                let mut started = me.started_at.lock().await;
                started.remove(&tid_owned);
            }
            let reason = match &result {
                Ok(_) => None,
                Err(e) => Some(e.to_string()),
            };
            emit_chunk(
                &app_handle_owned,
                &AgentChunk::StreamEnd {
                    thread_id: tid_owned.clone(),
                    reason,
                },
            );
        });

        Ok(String::new())
    }

    /// Inner implementation — the actual ReAct loop with three cancel
    /// checkpoints. Does NOT touch `cancel_flags` directly; the outer
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
    async fn chat_stream_inner(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, AgentError> {
        let ai_config = self.user_config.get_ai_config().model;
        let instance = self.ensure_instance(&ai_config).await?;

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
                                emit_chunk(
                                    app_handle,
                                    &AgentChunk::Error {
                                        thread_id: thread_id.to_string(),
                                        message: progress,
                                    },
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
                        )
                        .await;
                }
                match item_result {
                    Ok(item) => {
                        match item {
                            OpenAICompatibleStreamItem::Usage { total_tokens, .. } => {
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
                                    emit_chunk(
                                        app_handle,
                                        &AgentChunk::Error {
                                            thread_id: thread_id.to_string(),
                                            message: err_msg.clone(),
                                        },
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
                                        )
                                        .await;
                                }
                            }
                            OpenAICompatibleStreamItem::Text(text) => {
                                tracing::debug!("[Agent] Emitting text chunk: {}", text);
                                emit_chunk(
                                    app_handle,
                                    &AgentChunk::Text {
                                        thread_id: thread_id.to_string(),
                                        text: text.clone(),
                                    },
                                );
                                assistant_buffer.push_str(&text);
                                full_response.push_str(&text);
                            }
                            OpenAICompatibleStreamItem::Reasoning(text) => {
                                tracing::debug!("[Agent] Emitting reasoning chunk: {}", text);
                                emit_chunk(
                                    app_handle,
                                    &AgentChunk::Reasoning {
                                        thread_id: thread_id.to_string(),
                                        text: text.clone(),
                                    },
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
                                emit_chunk(
                                    app_handle,
                                    &AgentChunk::ToolCall {
                                        thread_id: thread_id.to_string(),
                                        id: tool_call.id.clone(),
                                        name: tool_call.function.name.clone(),
                                        input: tool_input.clone(),
                                    },
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
                                emit_chunk(
                                    app_handle,
                                    &AgentChunk::ToolResult {
                                        thread_id: thread_id.to_string(),
                                        id: tool_call.id.clone(),
                                        name: tool_call.function.name.clone(),
                                        result: serde_json::to_value(&tool_result)
                                            .unwrap_or(serde_json::Value::Null),
                                    },
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
                                            thread_id, synth_msg, app_handle,
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
            .finalize_with_synthesized_message(thread_id, synth_msg, app_handle)
            .await;
    }

    /// 取消 helper — `chat_stream_inner` 三个 cancel 站点共用的退出形状。
    /// 与 `finalize_with_synthesized_message` 对称, 但用「用户主动停止」的
    /// 文案 (`_(已停止生成)_`), 不用 LLM 不可用的模板。
    ///
    /// 把 suffix 拼到 `assistant_buffer` 末尾再 `flush_assistant_message`
    /// 落盘, 同时 emit 一个独立的 `Text` chunk 给前端 (UI 把它当普通 text
    /// 追加, 跟用户看到的实时流体验一致 ── 不再需要新事件类型)。
    async fn flush_cancel(
        &self,
        thread_id: &str,
        reasoning_buffer: String,
        assistant_buffer: String,
        full_response: String,
        app_handle: &tauri::AppHandle,
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
        emit_chunk(
            app_handle,
            &AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: STOPPED_SUFFIX.to_string(),
            },
        );
        // 始终落一条 (哪怕 assistant_buffer 为空), 让 thread 里有明确的
        // 助手结束标记; `flush_assistant_message` 自身有 is_empty 短路,
        // 但我们这里传的是带 suffix 的非空串, 一定落盘。
        self.flush_assistant_message(thread_id, &final_assistant)
            .await?;
        self.clear_tool_call_attempts(thread_id).await;
        Ok(format!("{full_response}{STOPPED_SUFFIX}"))
    }

    /// Frontend-initiated abort. Looks up the cancel flag for `thread_id`
    /// and sets it to `true`; the in-flight `chat_stream_inner` picks it
    /// up on the next checkpoint and exits via `flush_cancel`. The flag
    /// itself is owned by `chat_stream` (registered on entry, removed
    /// after exit), so the worst case here is "no chat running for this
    /// thread_id" — we return `false` to signal the no-op.
    ///
    /// Single-shot semantics: we `remove` immediately after `set`, so a
    /// second `stop_chat` call for the same thread_id returns `false`
    /// even if the chat hasn't exited yet. This avoids racing with
    /// `chat_stream`'s own remove-on-exit (both want to remove the same
    /// key; whichever loses the race sees an empty HashMap entry — which
    /// is a no-op for both).
    pub async fn stop_chat(&self, thread_id: &str) -> bool {
        let cancel = {
            let mut flags = self.cancel_flags.lock().await;
            flags.remove(thread_id)
        };
        match cancel {
            Some(flag) => {
                flag.store(true, Ordering::Release);
                tracing::info!(
                    "[Agent] stop_chat signalled cancel for thread_id: {}",
                    thread_id
                );
                true
            }
            None => false,
        }
    }

    async fn persist_user_message(
        &self,
        thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<(), AgentError> {
        let thread_message = ThreadChatMessage {
            id: format!("user_{}", Uuid::new_v4()),
            role: "user".to_string(),
            content: message.content.clone(),
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

    async fn load_thread_llm_messages(
        &self,
        thread_id: &str,
    ) -> Result<Vec<LlmChatMessage>, AgentError> {
        let manager = self.thread_manager.read().await;
        let thread = manager
            .get_thread(thread_id)
            .await?
            .ok_or_else(|| crate::threads::ThreadError::NotFound(thread_id.to_string()))?;
        Ok(thread
            .messages
            .into_iter()
            .filter_map(persisted_to_llm)
            .collect())
    }

    async fn add_thread_message(
        &self,
        thread_id: &str,
        message: ThreadChatMessage,
    ) -> Result<(), AgentError> {
        let manager = self.thread_manager.read().await;
        manager.add_message(thread_id, message).await?;
        Ok(())
    }

    async fn execute_tool_for_thread(
        &self,
        thread_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> crate::providers::tools::ToolResult {
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
        // (或 register_unnamed_file) 同步 index.json, 然后 emit
        // `MemoEvent::Updated` / `Created` (source: ExternalTool)。这同时也
        // 绕开 v3 物理文件名是 `<title>.md` 导致 `extract_memo_id_from_abs_path`
        // 永远 None 的死代码 (老 agent 路径里 memo_after 永远是 None, 事件
        // 从来没发出过)。

        // `self.memo_file` 是 `Arc<RwLock<MemoFile>>`, 解引用后调用 `.read()`
        // 自动得到 `&RwLock<MemoFile>`, 喂给 `execute_tool` 的形参类型。
        let result = execute_tool(
            tool_name,
            arguments,
            &self.memo_file,
            &self.agent_access,
            &self.skill_store,
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
                        // index.json 同步 + memo-event emit 完全交给 fs_watcher
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

    async fn flush_reasoning_message(
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

    async fn flush_assistant_message(
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
                reasoning: None,
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    /// 助手既输出了文本又发出了 tool_call 的合并落盘。OpenAI 协议里这两者本就是
    /// 同一条 assistant 消息 (content + tool_calls 字段), 不该拆成两行。
    /// text 可为空 (LLM 纯发 tool call, 不带前导文本), calls 至少一个。
    async fn flush_assistant_message_with_tool_calls(
        &self,
        thread_id: &str,
        content: &str,
        calls: &[LlmToolCall],
    ) -> Result<(), AgentError> {
        // 序列化为 OpenAI 格式的 JSON 数组, 持久化层与 rllm 解耦。
        let serialized_calls: Vec<serde_json::Value> = calls
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
            .collect();
        let tool_calls_json = serde_json::Value::Array(serialized_calls);
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
                reasoning: None,
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    async fn persist_tool_call(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        tool_input: serde_json::Value,
    ) -> Result<(), AgentError> {
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("tool_{}", tool_call_id),
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

    async fn persist_tool_result(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_key_stable_for_same_inputs() {
        let k1 = compute_call_key("read", r#"{"path":"/a.md"}"#);
        let k2 = compute_call_key("read", r#"{"path":"/a.md"}"#);
        assert_eq!(k1, k2);
    }

    #[test]
    fn call_key_distinguishes_different_args() {
        let k1 = compute_call_key("read", r#"{"path":"/a.md"}"#);
        let k2 = compute_call_key("read", r#"{"path":"/b.md"}"#);
        assert_ne!(k1.args_hash, k2.args_hash);
    }

    #[test]
    fn call_key_distinguishes_different_tools() {
        let k1 = compute_call_key("read", r#"{"path":"/a.md"}"#);
        let k2 = compute_call_key("write", r#"{"path":"/a.md"}"#);
        assert_ne!(k1.tool_name, k2.tool_name);
    }

    #[test]
    fn llm_unavailable_message_wraps_raw_reason() {
        // The plain inner-error path (e.g. mid-stream `Stream error: ...`).
        let msg = format_llm_unavailable_message("Stream error: connection reset by peer");
        assert_eq!(
            msg,
            "(LLM 暂时不可用, 原因: Stream error: connection reset by peer)"
        );
    }

    #[test]
    fn llm_unavailable_message_takes_reason_verbatim() {
        // Reason strings are constructed by callers in the recovery loop
        // (e.g. `format!("Stream failed: {}", e)`); the formatter must
        // not strip or re-wrap anything. This guards against accidental
        // re-introduction of a prefix-strip step that would silently
        // drop caller context.
        let inputs = [
            "Stream failed: API error 401: {\"type\":\"error\"}",
            "Stream error: connection reset by peer",
            "any reason",
        ];
        for input in inputs {
            let msg = format_llm_unavailable_message(input);
            assert!(
                msg.ends_with(&format!("原因: {})", input)),
                "input={input}, got={msg}"
            );
        }
    }

    #[test]
    fn llm_unavailable_message_preserves_chinese_punctuation() {
        // Chinese half-width comma (`,`) is intentional — matches the
        // rest of the codebase. Full-width comma (`，`) would also
        // be valid but is a different code point; this test guards
        // against accidental character substitution during refactors.
        let msg = format_llm_unavailable_message("any reason");
        assert!(msg.contains("(LLM 暂时不可用, 原因: "), "got: {msg}");
    }

    #[tokio::test]
    async fn record_tool_call_threshold_triggers_on_sixth() {
        let mgr = AgentManager::for_tests();
        let args = r#"{"path":"/a.md"}"#;
        for i in 1..=STUCK_THRESHOLD {
            let stuck = mgr.record_tool_call("thread-1", "read", args).await;
            assert!(
                !stuck,
                "第 {i} 次调用不该触发熔断 (阈值 {})",
                STUCK_THRESHOLD
            );
        }
        // 第 STUCK_THRESHOLD + 1 次必须返回 true
        let stuck = mgr.record_tool_call("thread-1", "read", args).await;
        assert!(stuck, "第 {} 次同调用应触发熔断", STUCK_THRESHOLD + 1);
    }

    #[tokio::test]
    async fn record_tool_call_isolates_threads() {
        let mgr = AgentManager::for_tests();
        let args = r#"{"path":"/a.md"}"#;
        // thread-A 触发熔断
        for _ in 0..=STUCK_THRESHOLD {
            let _ = mgr.record_tool_call("thread-A", "read", args).await;
        }
        // thread-B 应不受影响, 计数独立
        let stuck = mgr.record_tool_call("thread-B", "read", args).await;
        assert!(!stuck, "不同 thread 的卡死计数应隔离");
    }

    #[tokio::test]
    async fn clear_tool_call_attempts_resets() {
        let mgr = AgentManager::for_tests();
        let args = r#"{"path":"/a.md"}"#;
        for _ in 0..=STUCK_THRESHOLD {
            let _ = mgr.record_tool_call("thread-1", "read", args).await;
        }
        mgr.clear_tool_call_attempts("thread-1").await;
        // 清空后重新计数, 不应立即触发
        let stuck = mgr.record_tool_call("thread-1", "read", args).await;
        assert!(!stuck, "clear 后计数应从 0 重新开始");
    }

    #[tokio::test]
    async fn cleanup_thread_removes_read_snapshot() {
        let mgr = AgentManager::for_tests();
        // 直接通过公共 API 触发, 这里只看 HashMap 状态
        // 不能调用 execute_tool_for_thread (要 memo_file), 但 cleanup 的语义
        // 仅是 HashMap::remove, 单独验证 read_snapshots 这一侧。
        {
            let mut snapshots = mgr.read_snapshots.write().await;
            snapshots
                .entry("thread-1".to_string())
                .or_default()
                .insert("/a.md".to_string(), "content".to_string());
            assert!(snapshots.contains_key("thread-1"));
        }
        mgr.cleanup_thread("thread-1").await;
        let snapshots = mgr.read_snapshots.read().await;
        assert!(
            !snapshots.contains_key("thread-1"),
            "read_snapshots 应被清空"
        );
    }

    #[tokio::test]
    async fn cleanup_thread_removes_tool_call_attempts() {
        let mgr = AgentManager::for_tests();
        let args = r#"{"path":"/a.md"}"#;
        for _ in 0..=STUCK_THRESHOLD {
            let _ = mgr.record_tool_call("thread-1", "read", args).await;
        }
        mgr.cleanup_thread("thread-1").await;
        // 清理后重新计数, 不应被上次的累积触发
        let stuck = mgr.record_tool_call("thread-1", "read", args).await;
        assert!(!stuck, "cleanup 后计数应从 0 重新开始");
    }

    #[tokio::test]
    async fn cleanup_thread_isolates_threads() {
        let mgr = AgentManager::for_tests();
        let args = r#"{"path":"/a.md"}"#;
        // thread-A 触发一次计数
        let _ = mgr.record_tool_call("thread-A", "read", args).await;
        // thread-B 注入 read snapshot
        {
            let mut snapshots = mgr.read_snapshots.write().await;
            snapshots
                .entry("thread-B".to_string())
                .or_default()
                .insert("/b.md".to_string(), "content".to_string());
        }
        mgr.cleanup_thread("thread-A").await;
        // thread-A 状态清空
        let attempts = mgr.tool_call_attempts.read().await;
        assert!(
            !attempts.contains_key("thread-A"),
            "thread-A 卡死计数应被清空"
        );
        drop(attempts);
        // thread-B 的 read snapshot 不受影响
        let snapshots = mgr.read_snapshots.read().await;
        assert!(
            snapshots.contains_key("thread-B"),
            "thread-B 数据不应被波及"
        );
    }

    #[tokio::test]
    async fn cleanup_thread_is_idempotent() {
        let mgr = AgentManager::for_tests();
        // 对不存在的 thread_id 调用, 不应 panic
        mgr.cleanup_thread("nonexistent").await;
        mgr.cleanup_thread("nonexistent").await; // 二次调用同样安全
        let snapshots = mgr.read_snapshots.read().await;
        let attempts = mgr.tool_call_attempts.read().await;
        assert!(snapshots.is_empty());
        assert!(attempts.is_empty());
    }

    // AgentChunk 序列化 ── 验证 wire 协议形状, 防止日后误改 serde tag 默默
    // 破坏前后端 IPC 约定。`kind` 必须是 snake_case, 字段命名
    // (threadId/text/id/name/input/result/message/reason) 是与前端的硬
    // 契约, 不要随便改。`thread_id` 走 serde `rename_all = "snake_case"`,
    // 前端 TS 端字段是 `threadId` (camelCase, serde 双向自动转换)。
    #[test]
    fn agent_chunk_text_serializes_with_snake_case_tag() {
        let chunk = AgentChunk::Text {
            thread_id: "thread_1".to_string(),
            text: "hello".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "text");
        assert_eq!(v["thread_id"], "thread_1");
        assert_eq!(v["text"], "hello");
    }

    #[test]
    fn agent_chunk_reasoning_serializes_with_snake_case_tag() {
        let chunk = AgentChunk::Reasoning {
            thread_id: "thread_1".to_string(),
            text: "thinking...".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "reasoning");
        assert_eq!(v["thread_id"], "thread_1");
        assert_eq!(v["text"], "thinking...");
    }

    #[test]
    fn agent_chunk_tool_call_serializes_with_snake_case_tag() {
        let chunk = AgentChunk::ToolCall {
            thread_id: "thread_1".to_string(),
            id: "call_1".to_string(),
            name: "read".to_string(),
            input: serde_json::json!({"path": "/a.md"}),
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "tool_call");
        assert_eq!(v["thread_id"], "thread_1");
        assert_eq!(v["id"], "call_1");
        assert_eq!(v["name"], "read");
        assert_eq!(v["input"]["path"], "/a.md");
    }

    #[test]
    fn agent_chunk_tool_result_serializes_with_snake_case_tag() {
        let chunk = AgentChunk::ToolResult {
            thread_id: "thread_1".to_string(),
            id: "call_1".to_string(),
            name: "read".to_string(),
            result: serde_json::json!({"content": "data"}),
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "tool_result");
        assert_eq!(v["thread_id"], "thread_1");
        assert_eq!(v["id"], "call_1");
        assert_eq!(v["name"], "read");
        assert_eq!(v["result"]["content"], "data");
    }

    #[test]
    fn agent_chunk_error_serializes_with_snake_case_tag() {
        let chunk = AgentChunk::Error {
            thread_id: "thread_1".to_string(),
            message: "Agent stuck".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "error");
        assert_eq!(v["thread_id"], "thread_1");
        assert_eq!(v["message"], "Agent stuck");
    }

    #[test]
    fn agent_chunk_stream_start_serializes_with_snake_case_tag() {
        let chunk = AgentChunk::StreamStart {
            thread_id: "thread_1".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "stream_start");
        assert_eq!(v["thread_id"], "thread_1");
    }

    #[test]
    fn agent_chunk_stream_end_serializes_with_snake_case_tag() {
        // 两个分支: 正常完成 (reason = null) / 异常退出 (reason = "...")
        let chunk = AgentChunk::StreamEnd {
            thread_id: "thread_1".to_string(),
            reason: None,
        };
        let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["kind"], "stream_end");
        assert_eq!(v["thread_id"], "thread_1");
        assert!(
            v["reason"].is_null(),
            "正常完成时 reason 必须是 null, 不是缺字段"
        );

        let chunk_err = AgentChunk::StreamEnd {
            thread_id: "thread_2".to_string(),
            reason: Some("agent stuck".to_string()),
        };
        let v2: serde_json::Value = serde_json::to_value(&chunk_err).unwrap();
        assert_eq!(v2["kind"], "stream_end");
        assert_eq!(v2["thread_id"], "thread_2");
        assert_eq!(v2["reason"], "agent stuck");
    }

    #[test]
    fn run_info_serializes_with_camel_case() {
        // 验证 `agent_running_threads` IPC 返回值形状 ── 跟 CLAUDE.md 的
        // 跨 IPC struct 必须 camelCase 一致。`started_at` / `current_tool`
        // 是 wire 硬契约, 前端 TS 端 `runInfo.startedAt` / `runInfo.currentTool`。
        let info = RunInfo {
            started_at: 1_700_000_000_000,
            current_tool: Some("read".to_string()),
        };
        let v: serde_json::Value = serde_json::to_value(&info).unwrap();
        assert_eq!(v["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(v["currentTool"], "read");

        let none_info = RunInfo {
            started_at: 0,
            current_tool: None,
        };
        let v2: serde_json::Value = serde_json::to_value(&none_info).unwrap();
        assert!(v2["currentTool"].is_null());
    }

    #[test]
    fn default_agent_id_returns_stable_placeholder() {
        // 占位值应稳定为 "default", 历史 schema 兼容要求。
        let a = default_agent_id();
        let b = default_agent_id();
        assert_eq!(a, b);
        assert_eq!(a.0, "default");
    }

    #[test]
    fn agent_id_display_matches_inner() {
        let id = AgentId::new("custom-agent");
        assert_eq!(id.to_string(), "custom-agent");
        assert_eq!(format!("{}", id), "custom-agent");
    }

    #[test]
    fn agent_id_from_string_and_str() {
        let from_string: AgentId = String::from("a").into();
        let from_str: AgentId = "b".into();
        assert_eq!(from_string.0, "a");
        assert_eq!(from_str.0, "b");
    }

    #[test]
    fn token_budget_error_message_includes_used_and_budget() {
        // 前端 `agent-chunk` Error case 会拿到这段字符串, 用于 toast / 上下文提示。
        // 锁住字段名 (used / budget) 与单位, 防止文案漂移破坏前端正则解析。
        let err = AgentError::TokenBudget {
            used: 120_000,
            budget: 100_000,
        };
        let msg = err.to_string();
        assert!(msg.contains("120000"), "应包含 used 数值, 实际: {msg}");
        assert!(msg.contains("100000"), "应包含 budget 数值, 实际: {msg}");
        assert!(
            msg.contains("token budget"),
            "应保留错误类型标识, 实际: {msg}"
        );
    }
}
