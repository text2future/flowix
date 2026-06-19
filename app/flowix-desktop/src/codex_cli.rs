use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::agent::{AgentChunk, AgentUserMessage};
use crate::codex_history::is_codex_session_id;
use crate::threads::ThreadManager;
use crate::watcher::dispatcher;

const RUNTIME: &str = "codex";

pub struct CodexCliManager {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    children: Mutex<HashMap<String, Child>>,
}

impl CodexCliManager {
    pub fn new(thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>) -> Self {
        Self {
            thread_manager,
            children: Mutex::new(HashMap::new()),
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

        tokio::spawn(async move {
            emit_chunk(
                &app_handle,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                },
            );

            let reason = match manager.run_codex(&thread_id, message, &app_handle).await {
                Ok(()) => None,
                Err(err) => {
                    emit_chunk(
                        &app_handle,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                    );
                    Some(err)
                }
            };

            emit_chunk(&app_handle, &AgentChunk::StreamEnd { thread_id, reason });
        });

        Ok(String::new())
    }

    pub async fn stop_chat(&self, thread_id: &str) -> bool {
        let child = {
            let mut children = self.children.lock().await;
            children.remove(thread_id)
        };
        let Some(mut child) = child else {
            return false;
        };
        if let Err(err) = child.kill().await {
            tracing::warn!("[CodexCli] failed to kill child for {thread_id}: {err}");
        }
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent::RunInfo> {
        let children = self.children.lock().await;
        let now = chrono::Utc::now().timestamp_millis();
        children
            .keys()
            .map(|tid| {
                (
                    tid.clone(),
                    crate::agent::RunInfo {
                        started_at: now,
                        current_tool: Some("codex".to_string()),
                    },
                )
            })
            .collect()
    }

    async fn run_codex(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let session_id = {
            let manager = self.thread_manager.read().await;
            let mapped = manager
                .get_external_session(thread_id, RUNTIME)
                .await
                .map_err(|e| e.to_string())?;
            mapped.or_else(|| is_codex_session_id(thread_id).then(|| thread_id.to_string()))
        };

        let cwd = message
            .system_reminder_directory
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let permission_mode = message.permission_mode.clone();
        let codex_model = message.codex_model.clone();
        let prompt = message.llm_content.unwrap_or(message.content);

        let mut child = build_codex_command(
            session_id.as_deref(),
            &cwd,
            permission_mode.as_deref(),
            codex_model.as_deref(),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Codex CLI: {e}"))?;

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

        {
            let mut children = self.children.lock().await;
            children.insert(thread_id.to_string(), child);
        }

        let stdout_task = read_codex_stdout(
            thread_id.to_string(),
            app_handle.clone(),
            self.thread_manager.clone(),
            BufReader::new(stdout),
        );
        let stderr_task = read_to_string(BufReader::new(stderr));

        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);

        let mut child = {
            let mut children = self.children.lock().await;
            children.remove(thread_id)
        };
        let status = if let Some(child) = child.as_mut() {
            child.wait().await.map_err(|e| e.to_string())?
        } else {
            return Ok(());
        };

        stdout_result?;
        let stderr_text = stderr_text.unwrap_or_default();
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

fn build_codex_command(
    session_id: Option<&str>,
    cwd: &PathBuf,
    permission_mode: Option<&str>,
    codex_model: Option<&str>,
) -> Command {
    let mut cmd = Command::new(resolve_codex_binary());
    match session_id {
        Some(session_id) if !session_id.trim().is_empty() => {
            cmd.args(["exec", "resume"]);
            append_permission_override(&mut cmd, permission_mode);
            append_model_override(&mut cmd, codex_model);
            cmd.args(["--json", "--skip-git-repo-check", session_id, "-"]);
        }
        _ => {
            cmd.arg("exec");
            append_permission_override(&mut cmd, permission_mode);
            append_model_override(&mut cmd, codex_model);
            cmd.args(["--json", "--skip-git-repo-check"]);
            cmd.arg("-C");
            cmd.arg(cwd);
            cmd.arg("-");
        }
    }
    cmd
}

fn append_permission_override(cmd: &mut Command, permission_mode: Option<&str>) {
    if let Some(mode) = normalized_permission_mode(permission_mode) {
        cmd.arg("-c");
        cmd.arg(format!("sandbox_mode=\"{mode}\""));
    }
}

fn append_model_override(cmd: &mut Command, codex_model: Option<&str>) {
    if let Some(model) = normalized_codex_model(codex_model) {
        cmd.arg("-m");
        cmd.arg(model);
    }
}

fn normalized_codex_model(model: Option<&str>) -> Option<String> {
    let model = model?.trim();
    if model.is_empty() || model == "inherit" {
        return None;
    }
    Some(model.to_string())
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
    app_handle: tauri::AppHandle,
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    reader: BufReader<R>,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    let mut seen_sessions = HashSet::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(line) else {
            emit_chunk(
                &app_handle,
                &AgentChunk::Text {
                    thread_id: thread_id.clone(),
                    text: format!("{line}\n"),
                },
            );
            continue;
        };

        if let Some(session_id) = extract_session_id(&value) {
            if seen_sessions.insert(session_id.clone()) {
                let manager = thread_manager.read().await;
                if let Err(err) = manager
                    .upsert_external_session(&thread_id, RUNTIME, &session_id, Some(value.clone()))
                    .await
                {
                    tracing::warn!(
                        "[CodexCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
            }
        }

        for chunk in codex_event_to_chunks(&thread_id, &value) {
            emit_chunk(&app_handle, &chunk);
        }
    }
    Ok(())
}

async fn read_to_string<R>(reader: BufReader<R>) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    let mut out = String::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

fn emit_chunk(app_handle: &tauri::AppHandle, chunk: &AgentChunk) {
    if !dispatcher::emit_to(app_handle, "agent-chunk", chunk) {
        tracing::warn!("[CodexCli] emit agent-chunk failed");
    }
}

fn codex_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    if let Some(item) = value.get("item") {
        return codex_item_event_to_chunks(thread_id, &event_type, item);
    }

    if event_type.contains("session") || event_type.contains("turn") {
        return Vec::new();
    }

    if event_type.contains("error") {
        if let Some(text) = first_string(value, &["message", "error"]) {
            return vec![AgentChunk::Error {
                thread_id: thread_id.to_string(),
                message: text,
            }];
        }
    }

    if event_type.contains("reason") || event_type.contains("thinking") {
        if let Some(text) = first_string(value, &["text", "delta", "content", "message"]) {
            return vec![AgentChunk::Reasoning {
                thread_id: thread_id.to_string(),
                text,
            }];
        }
    }

    if event_type.contains("tool")
        || event_type.contains("command")
        || event_type.contains("exec")
        || event_type.contains("patch")
    {
        let id = first_string(value, &["id", "call_id", "callId"])
            .unwrap_or_else(|| format!("codex_{}", chrono::Utc::now().timestamp_millis()));
        let name = first_string(value, &["name", "tool", "command"])
            .unwrap_or_else(|| "codex".to_string());

        if event_type.contains("result")
            || event_type.contains("output")
            || event_type.contains("complete")
            || event_type.contains("done")
        {
            return vec![AgentChunk::ToolResult {
                thread_id: thread_id.to_string(),
                id,
                name,
                result: value.clone(),
            }];
        }

        return vec![AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input: value.clone(),
        }];
    }

    if let Some(text) = first_string(value, &["delta", "text", "content", "message"]) {
        if !text.trim().is_empty() {
            return vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text,
            }];
        }
    }

    Vec::new()
}

fn codex_item_event_to_chunks(thread_id: &str, event_type: &str, item: &Value) -> Vec<AgentChunk> {
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex_{}", chrono::Utc::now().timestamp_millis()));

    if item_type == "agent_message" {
        if event_type.ends_with("completed") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    return vec![AgentChunk::Text {
                        thread_id: thread_id.to_string(),
                        text: text.to_string(),
                    }];
                }
            }
        }
        return Vec::new();
    }

    if item_type == "reasoning" || item_type == "reasoning_message" {
        if let Some(text) = first_string(item, &["text", "summary", "content"]) {
            if !text.trim().is_empty() {
                return vec![AgentChunk::Reasoning {
                    thread_id: thread_id.to_string(),
                    text,
                }];
            }
        }
        return Vec::new();
    }

    if item_type == "command_execution" {
        let command = item
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("command");
        if event_type.ends_with("started") {
            return vec![AgentChunk::ToolCall {
                thread_id: thread_id.to_string(),
                id,
                name: "command_execution".to_string(),
                input: serde_json::json!({
                    "command": command,
                    "status": item.get("status").cloned().unwrap_or(Value::Null),
                }),
            }];
        }
        if event_type.ends_with("completed") {
            return vec![AgentChunk::ToolResult {
                thread_id: thread_id.to_string(),
                id,
                name: "command_execution".to_string(),
                result: serde_json::json!({
                    "command": command,
                    "output": item
                        .get("aggregated_output")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    "exit_code": item.get("exit_code").cloned().unwrap_or(Value::Null),
                    "status": item.get("status").cloned().unwrap_or(Value::Null),
                }),
            }];
        }
        return Vec::new();
    }

    if event_type.ends_with("started") {
        return vec![AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name: fallback_tool_name(&item_type),
            input: item.clone(),
        }];
    }

    if event_type.ends_with("completed") {
        return vec![AgentChunk::ToolResult {
            thread_id: thread_id.to_string(),
            id,
            name: fallback_tool_name(&item_type),
            result: item.clone(),
        }];
    }

    Vec::new()
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

fn fallback_tool_name(item_type: &str) -> String {
    if item_type.trim().is_empty() {
        "codex_item".to_string()
    } else {
        item_type.to_string()
    }
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }

    match value {
        Value::Object(map) => map.values().find_map(|v| first_string(v, keys)),
        Value::Array(items) => items.iter().find_map(|v| first_string(v, keys)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn maps_codex_command_execution_to_tool_chunks() {
        let started = serde_json::json!({
            "type": "item.started",
            "item": {
                "id": "item_0",
                "type": "command_execution",
                "command": "powershell -Command 'echo congratulations'",
                "aggregated_output": "",
                "exit_code": null,
                "status": "in_progress"
            }
        });
        let completed = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_0",
                "type": "command_execution",
                "command": "powershell -Command 'echo congratulations'",
                "aggregated_output": "congratulations\r\n",
                "exit_code": 0,
                "status": "completed"
            }
        });

        let start_chunks = codex_event_to_chunks("thread_1", &started);
        assert!(matches!(
            start_chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, .. }]
                if id == "item_0" && name == "command_execution"
        ));

        let complete_chunks = codex_event_to_chunks("thread_1", &completed);
        assert!(matches!(
            complete_chunks.as_slice(),
            [AgentChunk::ToolResult { id, name, result, .. }]
                if id == "item_0"
                    && name == "command_execution"
                    && result["output"] == "congratulations\r\n"
                    && result["exit_code"] == 0
        ));
    }

    #[test]
    fn maps_codex_agent_message_to_text_chunk() {
        let value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "agent_message",
                "text": "`echo congratulations` 输出：congratulations"
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

    /// 构造一个隔离的临时目录，里面放一个 fake `codex` 可执行文件。
    /// 用 pid + 一个测试名后缀避免并行测试互相串扰。
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
}
