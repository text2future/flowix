use rllm::chat::Tool;
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::{function_tool, ToolResult, ToolScope};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 32 * 1024;

pub const TOOL_NAME: &str = "shell";

pub fn shell_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "Run a non-interactive shell command in an allowed working directory. Use for project checks such as tests, builds, git status, or package scripts. Do not use for long-running servers or interactive programs.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Command text to run." },
                "cwd": { "type": "string", "description": "Working directory. Must be inside an accessible directory." },
                "shell": {
                    "type": "string",
                    "enum": ["auto", "powershell", "cmd", "bash", "zsh"],
                    "description": "Shell to use. auto uses PowerShell on Windows and bash on macOS/Linux.",
                    "default": "auto"
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Timeout in milliseconds.",
                    "minimum": 1000,
                    "maximum": MAX_TIMEOUT_MS,
                    "default": DEFAULT_TIMEOUT_MS
                }
            },
            "required": ["command", "cwd"]
        }),
    )
}

#[derive(Deserialize)]
struct Args {
    command: String,
    cwd: String,
    shell: Option<ShellKind>,
    timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ShellKind {
    Auto,
    Powershell,
    Cmd,
    Bash,
    Zsh,
}

struct CappedOutput {
    text: String,
    truncated: bool,
}

fn resolve_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn path_has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|name| name.starts_with('.') && name != "." && name != "..")
            .unwrap_or(false),
        _ => false,
    })
}

fn select_shell(shell: ShellKind) -> ShellKind {
    match shell {
        ShellKind::Auto if cfg!(windows) => ShellKind::Powershell,
        ShellKind::Auto => ShellKind::Bash,
        other => other,
    }
}

fn build_command(shell: ShellKind, command: &str) -> Command {
    match shell {
        ShellKind::Powershell => {
            let mut cmd = Command::new("powershell.exe");
            crate::process_window::hide_command_window(&mut cmd);
            let command = format!(
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
                 $OutputEncoding = [System.Text.Encoding]::UTF8; {}",
                command
            );
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &command,
            ]);
            cmd
        }
        ShellKind::Cmd => {
            let mut cmd = Command::new("cmd.exe");
            crate::process_window::hide_command_window(&mut cmd);
            cmd.args(["/C", command]);
            cmd
        }
        ShellKind::Bash => {
            let mut cmd = Command::new("/bin/bash");
            crate::process_window::hide_command_window(&mut cmd);
            cmd.args(["-lc", command]);
            cmd
        }
        ShellKind::Zsh => {
            let mut cmd = Command::new("/bin/zsh");
            crate::process_window::hide_command_window(&mut cmd);
            cmd.args(["-lc", command]);
            cmd
        }
        ShellKind::Auto => unreachable!("auto shell should be resolved before command creation"),
    }
}

fn shell_name(shell: ShellKind) -> &'static str {
    match shell {
        ShellKind::Auto => "auto",
        ShellKind::Powershell => "powershell",
        ShellKind::Cmd => "cmd",
        ShellKind::Bash => "bash",
        ShellKind::Zsh => "zsh",
    }
}

async fn read_capped<R>(mut reader: R, max_bytes: usize) -> std::io::Result<CappedOutput>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }

        let remaining = max_bytes.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        if read > remaining {
            truncated = true;
        }
    }

    Ok(CappedOutput {
        text: String::from_utf8_lossy(&output).to_string(),
        truncated,
    })
}

pub async fn execute_tool(arguments: &str, scope: &ToolScope) -> ToolResult {
    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let command_text = args.command.trim();
    if command_text.is_empty() {
        return ToolResult::error("command cannot be empty");
    }

    let cwd = resolve_path(&args.cwd);
    if !cwd.is_dir() {
        return ToolResult::error(format!("cwd is not a directory: {}", cwd.display()));
    }
    if path_has_hidden_component(&cwd) {
        return ToolResult::error(format!(
            "Hidden directories are not accessible to shell tool: {}",
            cwd.display()
        ));
    }
    if !scope.is_allowed(&cwd) {
        return ToolResult::error(format!(
            "cwd is outside the registered notebook scope: {}",
            cwd.display()
        ));
    }

    let shell = select_shell(args.shell.unwrap_or(ShellKind::Auto));
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);
    let started = Instant::now();

    let mut command = build_command(shell, command_text);
    command.current_dir(&cwd);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return ToolResult::error(format!(
                "Failed to start {} in {}: {}",
                shell_name(shell),
                cwd.display(),
                e
            ))
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = stdout
        .map(|stream| tokio::spawn(async move { read_capped(stream, MAX_OUTPUT_BYTES).await }));
    let stderr_task = stderr
        .map(|stream| tokio::spawn(async move { read_capped(stream, MAX_OUTPUT_BYTES).await }));

    let mut timed_out = false;
    let status = tokio::select! {
        status = child.wait() => status,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            timed_out = true;
            kill_child_process_tree(&mut child).await;
            child.wait().await
        }
    };

    let status = match status {
        Ok(status) => status,
        Err(e) => return ToolResult::error(format!("Failed to wait for command: {}", e)),
    };

    let stdout = match stdout_task {
        Some(task) => task
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(CappedOutput {
                text: String::new(),
                truncated: false,
            }),
        None => CappedOutput {
            text: String::new(),
            truncated: false,
        },
    };
    let stderr = match stderr_task {
        Some(task) => task
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(CappedOutput {
                text: String::new(),
                truncated: false,
            }),
        None => CappedOutput {
            text: String::new(),
            truncated: false,
        },
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    let output_truncated = stdout.truncated || stderr.truncated;

    ToolResult::success(serde_json::json!({
        "command": command_text,
        "cwd": cwd.display().to_string(),
        "shell": shell_name(shell),
        "exit_code": status.code(),
        "success_exit": status.success(),
        "stdout": stdout.text,
        "stderr": stderr.text,
        "duration_ms": duration_ms,
        "timed_out": timed_out,
        "truncated": output_truncated,
        "stdout_truncated": stdout.truncated,
        "stderr_truncated": stderr.truncated,
    }))
}

async fn kill_child_process_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let mut cmd = Command::new("taskkill");
            crate::process_window::hide_command_window(&mut cmd);
            let _ = cmd
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
            return;
        }
    }

    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_scope(root: PathBuf) -> ToolScope {
        ToolScope {
            allowed_roots: vec![root.clone()],
            _default_root: root,
        }
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("flowix-shell-{}-{}", name, suffix))
    }

    #[tokio::test]
    async fn shell_rejects_cwd_outside_scope() {
        let root = unique_temp_dir("root");
        let outside = unique_temp_dir("outside");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&outside).expect("create outside");

        let args = serde_json::json!({
            "command": "echo hi",
            "cwd": outside.display().to_string()
        })
        .to_string();
        let result = execute_tool(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        assert!(result.error.unwrap_or_default().contains("outside"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn shell_runs_simple_command_in_allowed_cwd() {
        let root = unique_temp_dir("run");
        std::fs::create_dir_all(&root).expect("create root");
        let command = if cfg!(windows) {
            "Write-Output flowix-shell-ok"
        } else {
            "printf flowix-shell-ok"
        };

        let args = serde_json::json!({
            "command": command,
            "cwd": root.display().to_string(),
            "timeout_ms": 10_000
        })
        .to_string();
        let result = execute_tool(&args, &test_scope(root.clone())).await;

        assert!(result.success, "shell should succeed: {:?}", result);
        let data = result.data.expect("shell data");
        assert_eq!(data["success_exit"].as_bool(), Some(true));
        assert!(data["stdout"]
            .as_str()
            .unwrap_or_default()
            .contains("flowix-shell-ok"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_rejects_hidden_cwd() {
        let root = unique_temp_dir("hidden-root");
        let hidden = root.join(".hidden");
        std::fs::create_dir_all(&hidden).expect("create hidden");

        let args = serde_json::json!({
            "command": "echo hi",
            "cwd": hidden.display().to_string()
        })
        .to_string();
        let result = execute_tool(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        assert!(result.error.unwrap_or_default().contains("Hidden"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_reports_nonzero_exit_without_tool_error() {
        let root = unique_temp_dir("exit");
        std::fs::create_dir_all(&root).expect("create root");
        let command = "exit 7";

        let args = serde_json::json!({
            "command": command,
            "cwd": root.display().to_string(),
            "timeout_ms": 10_000
        })
        .to_string();
        let result = execute_tool(&args, &test_scope(root.clone())).await;

        assert!(result.success, "nonzero exit should still return tool data");
        let data = result.data.expect("shell data");
        assert_eq!(data["success_exit"].as_bool(), Some(false));
        assert_eq!(data["exit_code"].as_i64(), Some(7));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_reports_timeout() {
        let root = unique_temp_dir("timeout");
        std::fs::create_dir_all(&root).expect("create root");
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 5"
        } else {
            "sleep 5"
        };

        let args = serde_json::json!({
            "command": command,
            "cwd": root.display().to_string(),
            "timeout_ms": 1_000
        })
        .to_string();
        let result = execute_tool(&args, &test_scope(root.clone())).await;

        assert!(result.success, "timeout should still return tool data");
        let data = result.data.expect("shell data");
        assert_eq!(data["timed_out"].as_bool(), Some(true));
        assert_eq!(data["success_exit"].as_bool(), Some(false));
        let _ = std::fs::remove_dir_all(root);
    }
}
