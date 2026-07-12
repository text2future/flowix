use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::agent::{AgentChunk, AgentUserMessage};
use crate::external_runtime::{
    emit_stream_end_once, kill_child_tree, persist_watchdog_finalized_run_state,
    select_external_session_for_runtime, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::runtime_log;
use crate::session::ThreadManager;
use super::events::{codex_event_to_chunks, is_transient_codex_reconnect_event};
use super::history::{codex_session_cwd, is_codex_session_id};
use super::io::read_capped_line;
use super::runtime::{diagnostics_enabled, emit_chunk_with_run_id, resolve_run_id};
use super::{truncate_for_log, AGENT_TYPE, MAX_STDOUT_LINE_BYTES, MAX_TOOL_OUTPUT_CHARS};

pub struct CodexCliManager {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
}

impl CodexCliManager {
    pub fn new(thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, AGENT_TYPE),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = resolve_run_id(&thread_id, message.run_id.as_deref());
        // 共享的"StreamEnd 已经 emit 出去没"标志 ── `stop_chat` 和流式任务
        // 都持有一份 Arc, 谁先 CAS(false→true) 谁负责发; 另一个分支看到
        // 标志为 true 直接 skip, 保证前端只收一条 StreamEnd。
        let stream_end_emitted = Arc::new(AtomicBool::new(false));

        // Reap any zombie child (kill/oom/broken pipe leaves the registry
        // entry behind until the watchdog sweeps it) and refuse overlapping
        // runs BEFORE we emit StreamStart — otherwise the UI flashes
        // loading for ~ms and then bounces to an error.
        if let Some(reason) = self.runs.reap_stale(&thread_id).await {
            return Err(reason);
        }

        tokio::spawn(async move {
            // 通用 metadata 协议 ── StreamStart 携带该 run 锁定的
            // model / reasoning_effort, 前端 hover card 等组件可读。
            let model = message.model_for_runtime("codex").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("codex")
                .map(str::to_string);
            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                AGENT_TYPE,
                &run_id,
            );

            let reason = match manager
                .run_codex(&thread_id, &run_id, message, &app_handle, stream_end_emitted.clone())
                .await
            {
                Ok(()) => None,
                Err(err) => {
                    emit_chunk_with_run_id(
                        &app_handle,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                        AGENT_TYPE,
                        &run_id,
                    );
                    Some(err)
                }
            };

            // 兜底 emit: 若 stop_chat / watchdog 还没替我们发过 StreamEnd,
            // 由本路径补发; 否则 CAS 失败, 跳过避免重复。详见
            // `shared::emit_stream_end_once`。
            emit_stream_end_once(
                &app_handle,
                &thread_id,
                &run_id,
                AGENT_TYPE,
                reason,
                &stream_end_emitted,
            );
        });

        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let mut running = match run_id {
            Some(rid) => self.runs.remove_if_run_id(thread_id, Some(rid)).await,
            None => self.runs.remove(thread_id).await,
        };
        if running.is_none() {
            let mapped_thread_id = {
                let manager = self.thread_manager.read().await;
                manager
                    .find_thread_by_external_session(thread_id, AGENT_TYPE)
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(mapped_thread_id) = mapped_thread_id {
                if mapped_thread_id != thread_id {
                    running = match run_id {
                        Some(rid) => {
                            self.runs
                                .remove_if_run_id(&mapped_thread_id, Some(rid))
                                .await
                        }
                        None => self.runs.remove(&mapped_thread_id).await,
                    };
                }
            }
        }
        let Some(mut running) = running else {
            return false;
        };
        kill_child_tree(&mut running.child, "CodexCli", thread_id).await;

        // 不等流式任务自己醒来 ── 用户停止后立刻发 StreamEnd。共享 flag 让
        // task body 末尾的兜底 emit 自动跳过 (避免重复事件)。
        let run_id_for_chunk = running
            .run_id
            .as_deref()
            .unwrap_or(thread_id)
            .to_string();
        emit_stream_end_once(
            app_handle,
            thread_id,
            &run_id_for_chunk,
            AGENT_TYPE,
            Some(USER_STOPPED_REASON.to_string()),
            &running.stream_end_emitted,
        );
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all("CodexCli").await
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self.runs.reap_inactive(idle_timeout_ms, "CodexCli").await;
        for run in &finalized {
            // CAS 已在 `reap_inactive` 锁内抢过 ── 这里的 run 都是 watchdog 赢得
            // slot 的, 直接发 Error + StreamEnd + persist, 不会双发。
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            if let Some(reason) = run.reason.clone() {
                emit_chunk_with_run_id(
                    app_handle,
                    &AgentChunk::Error {
                        thread_id: run.thread_id.clone(),
                        message: reason.clone(),
                    },
                    AGENT_TYPE,
                    run_id,
                );
            }
            emit_chunk_with_run_id(
                app_handle,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id.clone(),
                    reason: run.reason.clone(),
                },
                AGENT_TYPE,
                run_id,
            );
            persist_watchdog_finalized_run_state(&self.thread_manager, run, "CodexCli").await;
        }
        finalized.len()
    }

    async fn run_codex(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mapped_session_id = {
            let manager = self.thread_manager.read().await;
            manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_codex_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);
        let cwd = resolve_codex_cwd(&message, session_id.as_deref());
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let codex_model = message.codex_model_for_runtime().map(str::to_string);
        let reasoning_effort = message
            .codex_reasoning_effort_for_runtime()
            .map(str::to_string);
        let prompt = message.llm_content.unwrap_or(message.content);
        runtime_log::record_agent_event(
            "info",
            "codex_process",
            "codex.spawn_start",
            "Starting Codex CLI",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "session_mode": if session_id.is_some() { "resume" } else { "new" },
                "session_id": session_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "permission_mode": permission_mode,
                "codex_model": codex_model,
                "reasoning_effort": reasoning_effort,
                "prompt_chars": prompt.chars().count(),
            })),
        );
        if diagnostics_enabled() {
            runtime_log::record_agent_event(
                "info",
                "codex_diagnostics",
                "codex.diagnostics",
                "Codex diagnostic snapshot",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "binary": resolve_codex_binary().display().to_string(),
                    "cwd": cwd.display().to_string(),
                    "workspace_paths": workspace_paths,
                    "permission_mode": permission_mode,
                    "codex_model": codex_model,
                    "reasoning_effort": reasoning_effort,
                    "session_mode": if session_id.is_some() { "resume" } else { "new" },
                    "session_id": session_id,
                })),
            );
        }

        preflight_codex()?;

        let mut child = build_codex_command(
            session_id.as_deref(),
            &cwd,
            &workspace_paths,
            permission_mode.as_deref(),
            codex_model.as_deref(),
            reasoning_effort.as_deref(),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Codex CLI: {e}"))?;
        let child_pid = child.id();
        runtime_log::record_agent_event(
            "info",
            "codex_process",
            "codex.spawn_ok",
            "Codex CLI process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
            })),
        );

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("failed to write Codex prompt: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("failed to close Codex stdin: {e}"))?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Codex stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture Codex stderr".to_string())?;

        if let Err(mut duplicate_child) = self
            .runs
            .try_insert(
                thread_id.to_string(),
                child,
                Some(run_id.to_string()),
                stream_end_emitted,
            )
            .await
        {
            let _ = duplicate_child.kill().await;
            return Err("Codex CLI is already running for this thread".to_string());
        }

        let stdout_task = read_codex_stdout(
            thread_id.to_string(),
            run_id.to_string(),
            app_handle.clone(),
            self.thread_manager.clone(),
            self.runs.clone(),
            BufReader::new(stdout),
        );
        let stderr_task = read_stderr_to_string(
            thread_id.to_string(),
            run_id.to_string(),
            self.runs.clone(),
            BufReader::new(stderr),
        );

        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);
        // read_codex_stdout 只传播读取错误 ── Codex 的 task_complete 仅标记 terminal
        // turn, StreamEnd 统一由 tail / stop_chat / watchdog 经 `stream_end_emitted`
        // CAS 发, 不再从读取路径返回"已发"信号。
        stdout_result?;

        let mut child = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
        let status = if let Some(running) = child.as_mut() {
            running.child.wait().await.map_err(|e| e.to_string())?
        } else {
            // child 已被 stop_chat 或 watchdog 移走 ── 二者都已 CAS 抢发过
            // StreamEnd, 这里直接返回, tail 的 CAS 会失败而 skip, 不双发。
            runtime_log::record_agent_event(
                "warn",
                "codex_process",
                "codex.child_missing_after_run",
                "Codex child was removed before wait; likely stopped by user or watchdog",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({ "child_pid": child_pid })),
            );
            return Ok(());
        };

        let stderr_text = stderr_text.unwrap_or_default();
        runtime_log::record_agent_event(
            if status.success() { "info" } else { "error" },
            "codex_process",
            "codex.exit",
            "Codex CLI process exited",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
                "success": status.success(),
                "code": status.code(),
                "stderr_chars": stderr_text.chars().count(),
                "stderr_preview": truncate_for_log(stderr_text.trim()),
            })),
        );
        if !status.success() {
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("Codex CLI exited with status {status}")
            } else {
                format!("Codex CLI exited with status {status}: {detail}")
            });
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[CodexCli] stderr: {}", stderr_text.trim());
        }
        Ok(())
    }
}

/// Cwd 兜底链 ── 顺序:
/// 1. `message.cwd_for_runtime` (前端 IPC 入参, 即 `chat-stream.ts` 组装的 runtime_config)
/// 2. **该 session rollout 文件里的原始 cwd** ── Codex 的 session_meta 事件
///    内嵌 `payload.cwd`, 不依赖前端 store hydrate 状态
/// 3. Tauri 进程 cwd
/// 4. "." 兜底
///
/// 与 `claude_cli::resolve_claude_cwd` 同形, 详见 `claude_history::claude_session_cwd` 注释。
pub(crate) fn resolve_codex_cwd(
    message: &crate::agent::AgentUserMessage,
    session_id: Option<&str>,
) -> PathBuf {
    let from_ipc = message
        .cwd_for_runtime(AGENT_TYPE)
        .map(PathBuf::from)
        .filter(|p| p.exists());
    if let Some(cwd) = from_ipc {
        return cwd;
    }

    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        if let Ok(Some(cwd)) = codex_session_cwd(sid) {
            if cwd.exists() {
                return cwd;
            }
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn build_codex_command(
    session_id: Option<&str>,
    cwd: &PathBuf,
    workspace_paths: &[String],
    permission_mode: Option<&str>,
    codex_model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Command {
    let codex = resolve_codex_binary();
    // Codex CLI 是 `#!/usr/bin/env node` 的 JS 脚本（npm 包 `@openai/codex`）。
    // 解析软链到真正的 .js 后用 `node <codex.js>` 直接启动，绕过 shebang，
    // 不再依赖 child 进程的 PATH 里能找到 `node`。
    let codex_real = std::fs::canonicalize(&codex).unwrap_or_else(|_| codex.clone());
    let mut cmd = match codex_real.extension().and_then(|s| s.to_str()) {
        Some("js") => {
            // 绝对路径优先；fallback 让 `preflight_codex` 把守错误信息
            let node = resolve_node_binary().unwrap_or_else(|| PathBuf::from("node"));
            let mut cmd = Command::new(node);
            cmd.arg(codex_real);
            cmd
        }
        _ => {
            // 原生二进制或 .cmd shim（Windows npm 生成）→ 直接调本体
            let mut cmd = Command::new(codex);
            ensure_node_on_path(&mut cmd);
            cmd
        }
    };
    cmd.current_dir(cwd);
    crate::process_window::hide_command_window(&mut cmd);
    match session_id {
        Some(session_id) if !session_id.trim().is_empty() => {
            cmd.args(["exec", "resume"]);
            // `--sandbox` 仅 `codex exec` 接受；`codex exec resume` 会把它当
            // unexpected argument 拒绝（exit 2）。Resume 沿用首次会话的 sandbox
            // 配置即可——它已经持久化进 session 状态。
            append_model_override(&mut cmd, codex_model);
            append_reasoning_effort_override(&mut cmd, reasoning_effort);
            cmd.args(["--json", "--skip-git-repo-check", session_id, "-"]);
        }
        _ => {
            cmd.arg("exec");
            append_permission_override(&mut cmd, permission_mode);
            append_model_override(&mut cmd, codex_model);
            append_reasoning_effort_override(&mut cmd, reasoning_effort);
            cmd.args(["--json", "--skip-git-repo-check"]);
            cmd.arg("-C");
            cmd.arg(cwd);
            append_additional_workspace_dirs(&mut cmd, cwd, workspace_paths);
        }
    }
    cmd
}

/// 启动 Codex CLI 前的环境预检。
///
/// Codex CLI 是 Node.js 脚本（`@openai/codex` npm 包）。
/// 必须保证 `node` 可解析，否则 `Command::spawn` 会以 127 退出，
/// 且错误信息（`env: node: No such file or directory`）令人困惑。
/// 集中返回一个面向用户的产品级错误。
pub(crate) fn preflight_codex() -> Result<(), String> {
    let codex = resolve_codex_binary();
    let codex_real = std::fs::canonicalize(&codex).unwrap_or(codex);
    let needs_node = codex_real.extension().and_then(|s| s.to_str()) == Some("js");
    if !needs_node {
        // 未来若发布预编译的原生 codex，可跳过 node 预检
        return Ok(());
    }
    if resolve_node_binary().is_none() {
        return Err(format!(
            "Codex CLI requires Node.js, but no Node.js installation was found. \
             Install Node.js from https://nodejs.org/, or set the CODEX_NODE_PATH \
             environment variable to your `node` binary. \
             (Codex binary resolved to: {})",
            resolve_codex_binary().display()
        ));
    }
    Ok(())
}

/// 分层解析 node 可执行文件路径：
/// 1. `CODEX_NODE_PATH` 环境变量（用户显式覆盖，胜出）
/// 2. 当前 PATH 中的 `node`（终端启动场景）
/// 3. 常见安装位置（Homebrew / nvm / fnm / volta / asdf / n / npm-global / 系统）
pub(crate) fn resolve_node_binary() -> Option<PathBuf> {
    // 1) 用户显式覆盖
    if let Ok(path) = std::env::var("CODEX_NODE_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    // 2) 当前 PATH
    if let Some(found) = which_in_path("node", std::env::var_os("PATH").as_deref()) {
        return Some(found);
    }

    // 3) 常见安装位置
    for candidate in node_candidate_paths() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn node_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // 系统级
    paths.push(PathBuf::from("/opt/homebrew/bin/node"));
    paths.push(PathBuf::from("/usr/local/bin/node"));
    paths.push(PathBuf::from("/usr/bin/node"));

    let Some(home) = dirs::home_dir() else {
        return paths;
    };

    // npm 全局
    paths.push(home.join(".npm-global/bin/node"));
    paths.push(home.join(".npm/bin/node"));

    // nvm: 取版本号字典序最大的（即最新稳定版）
    if let Some(latest) = latest_versioned_subdir(&home.join(".nvm/versions/node")) {
        paths.push(latest.join("bin/node"));
    }

    // fnm
    if let Some(latest) = latest_versioned_subdir(&home.join(".local/share/fnm/node-versions")) {
        paths.push(latest.join("installation/bin/node"));
    }

    // volta 有 current 软链
    paths.push(home.join(".volta/tools/image/node/current/bin/node"));

    // asdf（plugin 名历史上既叫 node 也叫 nodejs）
    if let Some(latest) = latest_versioned_subdir(&home.join(".asdf/installs/nodejs")) {
        paths.push(latest.join("bin/node"));
    }
    if let Some(latest) = latest_versioned_subdir(&home.join(".asdf/installs/node")) {
        paths.push(latest.join("bin/node"));
    }

    // n: 简单 n 仓库
    paths.push(home.join("n/bin/node"));

    paths
}

fn latest_versioned_subdir(root: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if dirs.is_empty() {
        return None;
    }
    // 版本号字符串字典序 ≈ 语义序（"v20.10.0" > "v18.0.0"）
    dirs.sort();
    Some(dirs.swap_remove(dirs.len() - 1))
}

/// 在 PATH 缺失的 GUI 启动场景下，给 child 进程补一组常见 node 安装目录。
/// 仅在 codex 不是 .js 脚本时调用（如果是 .js，由 build_codex_command 走绝对路径 node 启动）。
fn ensure_node_on_path(cmd: &mut Command) {
    if which_in_path("node", std::env::var_os("PATH").as_deref()).is_some() {
        return;
    }

    let mut seen = std::collections::HashSet::new();
    let mut extra_dirs: Vec<PathBuf> = Vec::new();
    for node in node_candidate_paths() {
        if let Some(parent) = node.parent() {
            if seen.insert(parent.to_path_buf()) {
                extra_dirs.push(parent.to_path_buf());
            }
        }
    }

    let merged: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .chain(extra_dirs)
        .collect();

    cmd.env("PATH", std::env::join_paths(merged).unwrap_or_default());
}

fn which_in_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let path = path?;
    for dir in std::env::split_paths(path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn append_permission_override(cmd: &mut Command, permission_mode: Option<&str>) {
    if let Some(mode) = normalized_permission_mode(permission_mode) {
        cmd.arg("--sandbox");
        cmd.arg(mode);
    }
}

fn append_model_override(cmd: &mut Command, codex_model: Option<&str>) {
    if let Some(model) = normalized_codex_model(codex_model) {
        cmd.arg("-m");
        cmd.arg(model);
    }
}

fn append_reasoning_effort_override(cmd: &mut Command, reasoning_effort: Option<&str>) {
    if let Some(effort) = normalized_reasoning_effort(reasoning_effort) {
        cmd.arg("-c");
        cmd.arg(format!("model_reasoning_effort=\"{effort}\""));
    }
}

fn append_additional_workspace_dirs(cmd: &mut Command, cwd: &PathBuf, workspace_paths: &[String]) {
    for path in normalized_additional_workspace_dirs(cwd, workspace_paths) {
        cmd.arg("--add-dir");
        cmd.arg(path);
    }
}

fn normalized_additional_workspace_dirs(cwd: &PathBuf, workspace_paths: &[String]) -> Vec<PathBuf> {
    let cwd_normalized = normalize_workspace_path_for_compare(cwd);
    let mut seen = std::collections::HashSet::new();
    let mut dirs = Vec::new();

    for raw in workspace_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if !path.exists() {
            continue;
        }
        let normalized = normalize_workspace_path_for_compare(&path);
        if normalized == cwd_normalized || !seen.insert(normalized) {
            continue;
        }
        dirs.push(path);
    }

    dirs
}

fn normalize_workspace_path_for_compare(path: &PathBuf) -> String {
    path.to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string()
}

fn normalized_codex_model(model: Option<&str>) -> Option<String> {
    let model = model?.trim();
    if model.is_empty() || model == "inherit" {
        return None;
    }
    Some(model.to_string())
}

fn normalized_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&'static str> {
    match reasoning_effort?.trim() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        _ => None,
    }
}

fn normalized_permission_mode(mode: Option<&str>) -> Option<&'static str> {
    match mode.map(str::trim) {
        Some("read-only") => Some("read-only"),
        Some("workspace-write") => Some("workspace-write"),
        Some("danger-full-access") => Some("danger-full-access"),
        _ => None,
    }
}

pub(crate) fn resolve_codex_binary() -> PathBuf {
    if let Ok(path) = std::env::var("CODEX_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return path;
        }
    }

    #[cfg(windows)]
    {
        if let Some(home) = dirs::home_dir() {
            let npm_cmd = home
                .join("AppData")
                .join("Roaming")
                .join("npm")
                .join("codex.cmd");
            if npm_cmd.exists() {
                return npm_cmd;
            }
        }
        PathBuf::from("codex.cmd")
    }

    #[cfg(not(windows))]
    {
        // 先用父进程当前的 PATH 试一遍（命令行启动 tauri dev 时管用）。
        if let Ok(found) = which_codex() {
            return found;
        }

        // GUI 启动时 launchd 给的 PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
        // shell 里的 PATH 一律拿不到。挨个查常见安装位置作为回退。
        if let Some(home) = dirs::home_dir() {
            let candidates = [
                home.join(".npm-global/bin/codex"),
                home.join(".npm/bin/codex"),
                home.join(".local/bin/codex"),
                home.join(".cargo/bin/codex"),
                home.join(".bun/bin/codex"),
                home.join(".volta/bin/codex"),
                PathBuf::from("/opt/homebrew/bin/codex"),
                PathBuf::from("/usr/local/bin/codex"),
            ];
            for candidate in candidates {
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from("codex")
    }
}

/// 在当前 `PATH` 里找名为 `codex` 的可执行文件（仅普通文件，避开目录）。
/// 走标准库 `split_paths`，不引入 `which` crate。
fn which_codex() -> Result<PathBuf, ()> {
    let path = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("codex");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

async fn read_codex_stdout<R>(
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
    let mut emit_thread_id = thread_id.clone();
    let mut terminal_turn_seen = false;
    while let Some((line, line_truncated_by_reader)) =
        read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await?
    {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        runs.touch(&thread_id, Some(&run_id)).await;
        if line_truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "codex_stdout",
                "codex.stdout_line_truncated",
                "Codex stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(line),
                })),
            );
        }

        let Ok(value) = serde_json::from_str::<Value>(line) else {
            let line_chars = line.chars().count();
            runtime_log::record_agent_event(
                "warn",
                "codex_stdout",
                "codex.stdout_non_json",
                "Codex stdout emitted a non-JSON line",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "line_chars": line_chars,
                    "line_truncated": line_chars > MAX_TOOL_OUTPUT_CHARS || line_truncated_by_reader,
                    "line_truncated_by_reader": line_truncated_by_reader,
                    "line_preview": truncate_for_log(line),
                })),
            );
            continue;
        };
        log_codex_stdout_event(&thread_id, line, &value);

        if let Some(session_id) = extract_session_id(&value) {
            if seen_sessions.insert(session_id.clone()) {
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
                    tracing::warn!(
                        "[CodexCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
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
            emit_thread_id = session_id;
        }

        for chunk in codex_event_to_chunks(&emit_thread_id, &value) {
            emit_chunk_with_run_id(&app_handle, &chunk, AGENT_TYPE, &run_id);
        }

        if codex_run_signal(&value).is_terminal_turn() {
            terminal_turn_seen = true;
        }
    }
    runtime_log::record_agent_event(
        "info",
        "codex_stdout",
        "codex.stdout_eof",
        "Codex stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        None,
    );
    if terminal_turn_seen {
        runtime_log::record_agent_event(
            "info",
            "codex_stdout",
            "codex.terminal_turn_seen",
            "Codex reported a terminal turn; deferring StreamEnd until process exit",
            Some(&thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({ "run_id": run_id })),
        );
    }
    Ok(())
}

async fn read_stderr_to_string<R>(
    thread_id: String,
    run_id: String,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    let mut out = String::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        runs.touch(&thread_id, Some(&run_id)).await;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexRunSignal {
    Continue,
    TerminalTurn,
}

impl CodexRunSignal {
    fn is_terminal_turn(self) -> bool {
        matches!(self, Self::TerminalTurn)
    }
}

fn codex_run_signal(value: &Value) -> CodexRunSignal {
    if is_transient_codex_reconnect_event(value) {
        return CodexRunSignal::Continue;
    }
    if is_codex_task_complete(value) {
        return CodexRunSignal::TerminalTurn;
    }
    CodexRunSignal::Continue
}

fn is_codex_task_complete(value: &Value) -> bool {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str);
    if matches!(event_type, Some("turn.completed" | "turn.failed")) {
        return true;
    }
    if event_type != Some("event_msg") {
        return false;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .and_then(Value::as_str)
        == Some("task_complete")
}

fn log_codex_stdout_event(thread_id: &str, line: &str, value: &Value) {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_id = value
        .get("item")
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = value
        .get("item")
        .and_then(|item| item.get("command"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let output_chars = value
        .get("item")
        .and_then(|item| item.get("aggregated_output"))
        .and_then(Value::as_str)
        .map(|output| output.chars().count());

    runtime_log::record_agent_event(
        "info",
        "codex_stdout",
        "codex.stdout_event",
        "Codex stdout JSON event received",
        Some(thread_id),
        Some(AGENT_TYPE),
        Some(serde_json::json!({
            "event_type": event_type,
            "item_type": item_type,
            "item_id": item_id,
            "line_chars": line.chars().count(),
            "command": truncate_for_log(command),
            "aggregated_output_chars": output_chars,
        })),
    );
}

fn extract_session_id(value: &Value) -> Option<String> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    for key in [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
        "thread_id",
        "threadId",
    ] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    if event_type.contains("session") {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    find_nested_session_id(value)
}

fn find_nested_session_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["session_id", "sessionId", "thread_id", "threadId"] {
                if let Some(id) = map.get(key).and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
            map.values().find_map(find_nested_session_id)
        }
        Value::Array(items) => items.iter().find_map(find_nested_session_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_codex_task_complete_event() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "task_complete"
            }
        });
        assert!(is_codex_task_complete(&value));
    }

    #[test]
    fn ignores_non_task_complete_events_for_stream_end() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": "done"
            }
        });
        assert!(!is_codex_task_complete(&value));
    }

    #[test]
    fn detects_new_codex_turn_finished_events() {
        let completed = serde_json::json!({
            "type": "turn.completed"
        });
        let failed = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "stream disconnected before completion"
            }
        });

        assert!(is_codex_task_complete(&completed));
        assert!(is_codex_task_complete(&failed));
        assert_eq!(codex_run_signal(&completed), CodexRunSignal::TerminalTurn);
        assert_eq!(codex_run_signal(&failed), CodexRunSignal::TerminalTurn);
    }

    #[test]
    fn reconnecting_codex_turn_failed_is_not_terminal() {
        let reconnecting = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "stream disconnected before completion; Reconnecting..."
            }
        });

        assert!(is_codex_task_complete(&reconnecting));
        assert_eq!(codex_run_signal(&reconnecting), CodexRunSignal::Continue);
    }

    #[test]
    fn extracts_codex_thread_started_id() {
        let value = serde_json::json!({
            "type": "thread.started",
            "thread_id": "019ed38f-e9e3-7b61-8be3-80a40788d6e3"
        });
        assert_eq!(
            extract_session_id(&value).as_deref(),
            Some("019ed38f-e9e3-7b61-8be3-80a40788d6e3")
        );
    }

    #[test]
    fn maps_codex_agent_message_to_text_chunk() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": "`echo congratulations` 输出：congratulations"
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text.contains("congratulations")
        ));
    }

    #[test]
    fn normalizes_supported_permission_modes() {
        assert_eq!(
            normalized_permission_mode(Some("read-only")),
            Some("read-only")
        );
        assert_eq!(
            normalized_permission_mode(Some("workspace-write")),
            Some("workspace-write")
        );
        assert_eq!(
            normalized_permission_mode(Some("danger-full-access")),
            Some("danger-full-access")
        );
        assert_eq!(normalized_permission_mode(Some("inherit")), None);
        assert_eq!(normalized_permission_mode(Some("unknown")), None);
        assert_eq!(normalized_permission_mode(None), None);
    }

    #[test]
    fn normalizes_codex_model_override() {
        assert_eq!(
            normalized_codex_model(Some("gpt-5.5")).as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(normalized_codex_model(Some(" inherit ")), None);
        assert_eq!(normalized_codex_model(Some("")), None);
        assert_eq!(normalized_codex_model(None), None);
    }

    #[test]
    fn normalizes_reasoning_effort_override() {
        assert_eq!(normalized_reasoning_effort(Some("low")), Some("low"));
        assert_eq!(normalized_reasoning_effort(Some("medium")), Some("medium"));
        assert_eq!(normalized_reasoning_effort(Some("high")), Some("high"));
        assert_eq!(normalized_reasoning_effort(Some("xhigh")), Some("xhigh"));
        assert_eq!(normalized_reasoning_effort(Some(" extra-high ")), None);
        assert_eq!(normalized_reasoning_effort(None), None);
    }

    /// 构造一个隔离的临时目录，里面放一个 fake `codex` 可执行文件。
    /// 用 pid + 一个测试名后缀避免并行测试互相串扰。
    #[test]
    fn select_session_prefers_hint_over_mapping() {
        let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
        // thread_id 本身就是 UUID 形式 → hint 胜出，无视 SQLite 映射。
        let session_id = "019f0000-0000-7000-8000-000000000001";
        assert_eq!(
            select_external_session_for_runtime(mapped.clone(), Some(session_id.to_string()))
                .as_deref(),
            Some(session_id)
        );
    }

    #[test]
    fn select_session_falls_back_to_mapping_when_no_hint() {
        let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
        // thread_id 不是 UUID 形式 → 用 SQLite 里的映射 (cwd / workspace
        // 一致与否不再参与决策，UI 在首条消息锁定)。
        assert_eq!(
            select_external_session_for_runtime(mapped.clone(), None),
            mapped
        );
    }

    #[test]
    fn select_session_returns_none_for_brand_new_thread() {
        // 全新 thread：既没映射，thread_id 也不是 UUID → 新建 session。
        assert_eq!(
            select_external_session_for_runtime(None, None),
            None
        );
    }

    #[test]
    fn new_codex_session_adds_enabled_workspace_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-workspace-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        let cwd = root.join("primary");
        let secondary = root.join("secondary");
        let third = root.join("third");
        std::fs::create_dir_all(&cwd).expect("create primary dir");
        std::fs::create_dir_all(&secondary).expect("create secondary dir");
        std::fs::create_dir_all(&third).expect("create third dir");

        let workspace_paths = vec![
            cwd.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            root.join("missing").to_string_lossy().to_string(),
            third.to_string_lossy().to_string(),
        ];
        let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-C" && pair[1] == cwd.to_string_lossy()));
        assert_eq!(
            args.windows(2)
                .filter(|pair| pair[0] == "--add-dir")
                .map(|pair| pair[1].clone())
                .collect::<Vec<_>>(),
            vec![
                secondary.to_string_lossy().to_string(),
                third.to_string_lossy().to_string()
            ]
        );

        cleanup(&root);
    }

    #[test]
    fn new_codex_session_reads_prompt_from_stdin_without_dash_argument() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(!args.iter().any(|arg| arg == "-"));
        assert!(args.iter().any(|arg| arg == "exec"));
        assert!(args.iter().any(|arg| arg == "--json"));
    }

    #[test]
    fn resumed_codex_session_does_not_add_workspace_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-resume-workspace-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        let cwd = root.join("primary");
        let secondary = root.join("secondary");
        std::fs::create_dir_all(&cwd).expect("create primary dir");
        std::fs::create_dir_all(&secondary).expect("create secondary dir");

        let workspace_paths = vec![secondary.to_string_lossy().to_string()];
        let cmd = build_codex_command(
            Some("019f0000-0000-7000-8000-000000000000"),
            &cwd,
            &workspace_paths,
            None,
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(!args.iter().any(|arg| arg == "-C"));
        assert!(!args.iter().any(|arg| arg == "--add-dir"));

        cleanup(&root);
    }

    #[test]
    fn resumed_codex_session_does_not_emit_sandbox_flag() {
        // `codex exec resume` 拒绝 `--sandbox`（exit 2: unexpected argument）。
        // 即便用户在 UI 上配了 permission_mode，resume argv 也必须不带这个标志，
        // 让 CLI 从 session 状态里恢复首次会话时已持久化的 sandbox 配置。
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-resume-sandbox-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");

        let cmd = build_codex_command(
            Some("019f0000-0000-7000-8000-000000000000"),
            &root,
            &[],
            Some("workspace-write"),
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(
            !args.iter().any(|arg| arg == "--sandbox"),
            "resume argv must not contain --sandbox, got: {:?}",
            args
        );

        cleanup(&root);
    }

    #[test]
    fn codex_command_adds_reasoning_effort_override() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, Some("xhigh"));
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "model_reasoning_effort=\"xhigh\"" }));
    }

    #[test]
    fn codex_command_uses_documented_sandbox_flag() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(
            None,
            &cwd,
            &workspace_paths,
            Some("workspace-write"),
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--sandbox" && pair[1] == "workspace-write"));
    }

    fn make_fake_codex_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowix-codex-cli-test-{}-{}-{}",
            std::process::id(),
            suffix,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let fake = dir.join("codex");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake codex");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).expect("chmod fake");
        }
        dir
    }

    fn cleanup(dir: &PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 这几个测试都改全局 `PATH` / `CODEX_CLI_PATH`，必须串行。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn resolve_codex_binary_prefers_codex_cli_path_env() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = make_fake_codex_dir("env-override");
        let fake = dir.join("my-codex");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake");

        let original = std::env::var_os("CODEX_CLI_PATH");
        std::env::set_var("CODEX_CLI_PATH", &fake);
        let resolved = resolve_codex_binary();
        match original {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, fake);
    }

    #[test]
    fn resolve_codex_binary_ignores_missing_codex_cli_path() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let original = std::env::var_os("CODEX_CLI_PATH");
        std::env::set_var(
            "CODEX_CLI_PATH",
            std::env::temp_dir().join("flowix-nonexistent-codex-cli-path"),
        );
        let resolved = resolve_codex_binary();
        match original {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }
        assert_ne!(
            resolved,
            std::env::temp_dir().join("flowix-nonexistent-codex-cli-path")
        );
    }

    #[test]
    fn which_codex_finds_binary_in_path() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = make_fake_codex_dir("which-hit");
        let original = std::env::var_os("PATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let joined = match &original {
            Some(p) => format!("{}{}{}", dir.display(), sep, p.to_string_lossy()),
            None => dir.display().to_string(),
        };
        std::env::set_var("PATH", joined);
        let result = which_codex();
        match original {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        cleanup(&dir);

        let found = result.expect("expected to find fake codex in PATH");
        // `which_codex` 直接拼 `dir.join("codex")` 返回，不走符号链接解析；
        // 直接比路径即可，避开 macOS 上 `/var` ↔ `/private/var` 跨链接 canonicalize 抽风。
        assert_eq!(found, dir.join("codex"));
    }

    #[test]
    fn which_codex_returns_err_when_path_empty() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let original = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        let result = which_codex();
        match original {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        assert!(result.is_err());
    }

    fn make_fake_node_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowix-codex-node-test-{}-{}-{}",
            std::process::id(),
            suffix,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let fake = dir.join("node");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake node");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).expect("chmod fake");
        }
        dir
    }

    #[test]
    fn resolve_node_binary_prefers_codex_node_path_env() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = make_fake_node_dir("env-override");
        let fake = dir.join("node");

        let original = std::env::var_os("CODEX_NODE_PATH");
        std::env::set_var("CODEX_NODE_PATH", &fake);
        let resolved = resolve_node_binary();
        match original {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(fake));
    }

    #[test]
    fn resolve_node_binary_finds_node_in_path() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = make_fake_node_dir("path-hit");

        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CODEX_NODE_PATH");
        std::env::remove_var("CODEX_NODE_PATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let joined = match &original_path {
            Some(p) => format!("{}{}{}", dir.display(), sep, p.to_string_lossy()),
            None => dir.display().to_string(),
        };
        std::env::set_var("PATH", joined);

        let resolved = resolve_node_binary();

        match original_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(dir.join("node")));
    }

    #[test]
    fn resolve_node_binary_falls_back_to_homebrew_path_when_path_empty() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 只在 macOS / Linux 且文件确实存在的 CI 上验证；开发机一般命中
        #[cfg(unix)]
        {
            let original_path = std::env::var_os("PATH");
            let original_node_env = std::env::var_os("CODEX_NODE_PATH");
            std::env::remove_var("CODEX_NODE_PATH");
            std::env::set_var("PATH", "");

            let resolved = resolve_node_binary();

            match original_path {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
            match original_node_env {
                Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
                None => std::env::remove_var("CODEX_NODE_PATH"),
            }

            // 命中 /opt/homebrew/bin/node 或 /usr/local/bin/node 或 /usr/bin/node 之一即可
            if let Some(p) = &resolved {
                assert!(
                    p.starts_with("/opt/homebrew/bin/node")
                        || p.starts_with("/usr/local/bin/node")
                        || p.starts_with("/usr/bin/node"),
                    "unexpected fallback path: {}",
                    p.display()
                );
            }
        }
        #[cfg(not(unix))]
        {
            // Windows 上 `node` 通常已经在 PATH，不强制
        }
    }

    #[test]
    fn preflight_codex_returns_friendly_error_when_no_node() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CODEX_NODE_PATH");
        let original_cli_env = std::env::var_os("CODEX_CLI_PATH");
        std::env::remove_var("CODEX_NODE_PATH");
        std::env::set_var("PATH", "");
        // 把 codex 指向一个根本不存在的 .js，让 needs_node=true 但 node 找不到
        std::env::set_var(
            "CODEX_CLI_PATH",
            std::env::temp_dir().join("flowix-preflight-nonexistent-codex.js"),
        );

        let result = preflight_codex();

        match original_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }
        match original_cli_env {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }

        // 在装了 node 的开发机上（包括 CI）会通过；这里只断言"错误信息包含指引"或"通过"
        if let Err(msg) = result {
            assert!(
                msg.contains("Node.js"),
                "error should mention Node.js, got: {msg}"
            );
            assert!(
                msg.contains("CODEX_NODE_PATH") || msg.contains("nodejs.org"),
                "error should point to a fix path, got: {msg}"
            );
        }
    }
}
