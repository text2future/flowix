//! Flowix CLI sidecar 句柄 + 面向前端的 `cli_invoke` IPC 命令。
//!
//! ## 架构
//!
//! Tauri 2 + `tokio::process::Command` (不走 `tauri-plugin-shell` ── 它对
//! long-lived 双向流不友好, 一次性 `output()` 风格 OK 但我们这里要 hold 住
//! child 一辈子, 还要异步读写 stdin/stdout/stderr)。 协议见
//! `app/flowix-cli/src/serve.rs` 顶部注释 ── line-delimited JSON-RPC。
//!
//! ## 生命周期
//!
//! 1. `lib.rs::run()` 的 `.setup()` 里 `SidecarHandle::spawn(...)` ── 拉起
//!    `flowix-cli serve` 进程, 启动 reader / stderr-forwarder 两个常驻任务。
//! 2. 句柄塞进 `AppState.flowix_cli`, 业务模块通过 `cli_invoke` IPC 走前端调用。
//! 3. `RunEvent::ExitRequested` 触发 `try_shutdown(200ms)` ── 发 `shutdown`
//!    JSON-RPC 请求, 等 ack, 超时则 `kill()`。`RunEvent::Exit` 兜底 kill。
//!
//! ## 死状态
//!
//! reader 任务看到 stdout EOF / parse 错 / 子进程退出时, 把 `dead: Some(reason)`
//! 写进共享状态, 同时给所有 pending oneshot 合成一个错误。后续 `invoke` 立刻
//! 失败, 不阻塞 IPC 调用方。 IPC 入口会在检测到 dead handle 时尝试重启一次。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime::{self, JoinHandle};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, RwLock};

/// Sidecar 进程的句柄 ── 跨线程共享 (`Arc<SidecarHandle>`), 持有 writer /
/// pending map / 死状态 / child 本身。
///
/// 内部所有 `Mutex` 都是 `tokio::sync::Mutex` ── `std::sync::MutexGuard` 不是
/// `Send`, 跨 `.await` 会让 future 不 Send, Tauri 2 的 IPC handler 拒绝。
pub struct SidecarHandle {
    /// 写半边 (请求)。 进程死后被 reader 任务置 None。
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// 等待响应的 oneshot map: `id -> oneshot::Sender<Value>`。
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// 自增 id 计数器。
    next_id: AtomicU64,
    /// 死状态: 进程退出 / spawn 失败 / reader EOF 时填入。`invoke` 读这个。
    dead: Arc<RwLock<Option<String>>>,
    /// 子进程本身 (for `kill()`)。
    child: Arc<Mutex<Option<Child>>>,
    /// 路径 (用于诊断 + 错误消息)。
    bin_path: PathBuf,
    /// reader / stderr 任务 handle, 留着方便 abort (优雅退出时保险用)。
    _tasks: Vec<JoinHandle<()>>,
}

impl SidecarHandle {
    /// 构造一个"占位"句柄 ── 在 `AppState` 构造时 (spawn 之前) 用,
    /// 所有 `invoke` 立刻返 "sidecar not yet spawned" 错。
    pub fn placeholder() -> Arc<Self> {
        Arc::new(Self {
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            dead: Arc::new(RwLock::new(Some("not yet spawned".into()))),
            child: Arc::new(Mutex::new(None)),
            bin_path: PathBuf::new(),
            _tasks: Vec::new(),
        })
    }

    /// 构造一个"已死"句柄 ── spawn 失败时塞进 `AppState`, 让 `invoke`
    /// 立刻返带具体原因的错, 而不是泛泛的 "not yet spawned"。
    pub fn dead(reason: String) -> Arc<Self> {
        Arc::new(Self {
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            dead: Arc::new(RwLock::new(Some(reason))),
            child: Arc::new(Mutex::new(None)),
            bin_path: PathBuf::new(),
            _tasks: Vec::new(),
        })
    }

    /// Spawn `flowix-cli serve` 子进程, 启动 reader / stderr-forwarder。
    ///
    /// 路径解析: dev 走 `CARGO_MANIFEST_DIR/binaries/flowix-cli` (由
    /// `scripts/build-cli.sh` 创建的 symlink), prod 走 `current_exe().parent()`
    /// (Tauri 2 把 sidecar 放在主二进制旁)。 两边都找不到时报清晰错误。
    pub async fn spawn() -> Result<Arc<Self>, String> {
        let bin_path = resolve_sidecar_path()?;
        tracing::info!(?bin_path, "spawning flowix-cli sidecar");

        let mut cmd = Command::new(&bin_path);
        cmd.arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", bin_path.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "flowix-cli stdin not captured".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "flowix-cli stdout not captured".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "flowix-cli stderr not captured".to_string())?;

        let stdin_arc = Arc::new(Mutex::new(Some(stdin)));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let dead: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
        let child_arc: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));

        // reader: 按行读 stdout, 按 `id` 路由到 pending。
        let reader = {
            let pending = pending.clone();
            let dead = dead.clone();
            let stdin = stdin_arc.clone();
            let child_arc = child_arc.clone();
            async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let parsed: Result<Value, _> = serde_json::from_str(&line);
                            match parsed {
                                Ok(env) => {
                                    if let Some(id) = env.get("id").and_then(|v| v.as_u64()) {
                                        let mut map = pending.lock().await;
                                        if let Some(tx) = map.remove(&id) {
                                            // 不管 result 还是 error 都透传。
                                            let _ = tx.send(env);
                                        } else {
                                            tracing::warn!(
                                                "sidecar response with unknown id={id}: {env}"
                                            );
                                        }
                                    } else {
                                        tracing::debug!("sidecar notification: {env}");
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "sidecar stdout parse error: {e} (line: {line})"
                                    );
                                }
                            }
                        }
                        Ok(None) => {
                            // EOF ── child 关闭 stdout。 标记 dead, 给所有 pending 发错。
                            let reason = "sidecar closed stdout (EOF)".to_string();
                            tracing::info!("{reason}");
                            *dead.write().await = Some(reason);
                            drain_pending_with_error(&pending, "sidecar exited unexpectedly").await;
                            // stdin 也跟着没意义了, 释放。
                            *stdin.lock().await = None;
                            // 把 child 也 drop, 让 OS 回收。
                            *child_arc.lock().await = None;
                            return;
                        }
                        Err(e) => {
                            let reason = format!("sidecar stdout read error: {e}");
                            tracing::warn!("{reason}");
                            *dead.write().await = Some(reason);
                            drain_pending_with_error(&pending, "sidecar stdout error").await;
                            return;
                        }
                    }
                }
            })
        };

        // stderr forwarder: 行级转发到 tracing, 带等级 (warn if 含 "error", else info)。
        let stderr_task = {
            async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let lower = line.to_lowercase();
                    if lower.contains("error") || lower.contains("panic") {
                        tracing::warn!(target: "flowix_cli", "{}", line);
                    } else {
                        tracing::info!(target: "flowix_cli", "{}", line);
                    }
                }
            })
        };

        Ok(Arc::new(Self {
            stdin: stdin_arc,
            pending,
            next_id: AtomicU64::new(1),
            dead,
            child: child_arc,
            bin_path,
            _tasks: vec![reader, stderr_task],
        }))
    }

    /// 同步 JSON-RPC 请求: 分配 id, 写 stdin, 按 method 等响应。
    pub async fn invoke(&self, method: &str, params: Value) -> Result<Value, String> {
        // 死状态检查 ── 立刻返错, 不阻塞。
        if let Some(reason) = self.dead.read().await.clone() {
            return Err(format!("sidecar unavailable: {reason}"));
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let envelope = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line =
            serde_json::to_string(&envelope).map_err(|e| format!("encode envelope: {e}"))?;
        line.push('\n');

        // 注册 oneshot 后再写, 防 race (reader 跑得比注册快)。
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        // 写 stdin: 必须上锁, 防并发写交错。
        {
            let mut guard = self.stdin.lock().await;
            let write_result = async {
                let stdin = guard
                    .as_mut()
                    .ok_or_else(|| "sidecar stdin closed".to_string())?;
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| format!("write to sidecar: {e}"))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("flush sidecar: {e}"))
            }
            .await;
            if let Err(err) = write_result {
                let _ = self.pending.lock().await.remove(&id);
                return Err(err);
            }
        }

        let timeout = request_timeout(method);
        let response = tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| {
                let pending = self.pending.clone();
                async_runtime::spawn(async move {
                    let _ = pending.lock().await.remove(&id);
                });
                format!("sidecar request timeout ({}s)", timeout.as_secs())
            })?
            .map_err(|_| "sidecar dropped response channel (exited?)".to_string())?;

        // 拆 result / error。
        if let Some(err) = response.get("error") {
            let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
            let message = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("(no message)");
            return Err(format!("sidecar error {code}: {message}"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// 优雅关闭: 发 shutdown 请求, 等 ack (默认 200ms), 超时后 kill。
    pub async fn try_shutdown(&self, timeout: Duration) -> Result<(), String> {
        if self.dead.read().await.is_some() {
            return Ok(()); // 已死, 算"成功"关掉。
        }
        let result = tokio::time::timeout(timeout, self.invoke("shutdown", json!({}))).await;
        match result {
            Ok(Ok(_)) => {
                tracing::info!("sidecar shutdown acked");
                Ok(())
            }
            Ok(Err(e)) => {
                tracing::warn!("sidecar shutdown returned error: {e}, killing");
                self.kill().await;
                Ok(())
            }
            Err(_) => {
                tracing::warn!("sidecar shutdown timed out, killing");
                self.kill().await;
                Ok(())
            }
        }
    }

    /// 强制 kill ── `SIGKILL` / `TerminateProcess`, 不等 graceful。
    pub async fn kill(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
        }
    }

    /// 用于诊断 / 健康检查。
    pub async fn is_alive(&self) -> bool {
        self.dead.read().await.is_none()
    }

    /// 路径 (用于诊断 / 错误消息)。
    pub fn bin_path(&self) -> &Path {
        &self.bin_path
    }
}

fn request_timeout(method: &str) -> Duration {
    match method {
        "memo.search" => Duration::from_secs(30),
        "memo.list" | "notebooks.list" => Duration::from_secs(15),
        "memo.show" => Duration::from_secs(20),
        "memo.create" | "memo.write" | "memo.edit" | "memo.delete" => Duration::from_secs(20),
        "shutdown" => Duration::from_secs(5),
        _ => Duration::from_secs(10),
    }
}

/// 给所有 pending 合成一个错误, 唤醒等待中的 invoke 调用方。
async fn drain_pending_with_error(
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    msg: &str,
) {
    let entries: Vec<(u64, oneshot::Sender<Value>)> = {
        let mut map = pending.lock().await;
        map.drain().collect()
    };
    for (_id, tx) in entries {
        let env = json!({
            "error": { "code": -32001, "message": msg },
        });
        let _ = tx.send(env);
    }
}

/// 解析 sidecar 路径 ── dev 优先 `CARGO_MANIFEST_DIR/binaries/flowix-cli`,
/// prod fallback `current_exe().parent()/flowix-cli`。
fn resolve_sidecar_path() -> Result<PathBuf, String> {
    // 1. dev 模式: `app/flowix-desktop/binaries/flowix-cli` (symlink or
    //    target-triple 同名)。 `CARGO_MANIFEST_DIR` 在 build 时硬编码进二进制。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("flowix-cli");
    if dev.exists() {
        return Ok(dev);
    }

    // 2. dev Windows: 同上但加 .exe
    #[cfg(windows)]
    {
        let dev_exe = dev.with_extension("exe");
        if dev_exe.exists() {
            return Ok(dev_exe);
        }
    }

    // 3. prod: 跟主二进制同目录的 `flowix-cli`。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let prod = parent.join("flowix-cli");
            if prod.exists() {
                return Ok(prod);
            }
            #[cfg(windows)]
            {
                let prod_exe = prod.with_extension("exe");
                if prod_exe.exists() {
                    return Ok(prod_exe);
                }
            }
        }
    }

    Err(format!(
        "flowix-cli sidecar not found (tried {} and current_exe parent). \
         run `bash scripts/build-cli.sh` first.",
        dev.display()
    ))
}

// =====================================================================
// Tauri IPC 命令 — 前端通过 `invoke('cli_invoke', { method, params })` 调
// =====================================================================

/// 暴露给前端的 JSON-RPC 调用入口。
///
/// 简单转发到 `SidecarHandle::invoke`, 错误原样回传 (前端拿到的是
/// `sidecar error <code>: <message>` 格式字符串, 跟 `Result<Value, String>`
/// 契约一致)。
#[tauri::command]
pub async fn cli_invoke(
    state: tauri::State<'_, crate::commands::AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or_else(|| json!({}));
    let handle = ensure_sidecar_handle(&state).await?;
    match handle.invoke(&method, params.clone()).await {
        Ok(value) => Ok(value),
        Err(err) if err.starts_with("sidecar unavailable:") => {
            tracing::warn!("flowix-cli sidecar unavailable, attempting restart: {err}");
            let restarted = restart_sidecar_handle(&state).await?;
            restarted.invoke(&method, params).await
        }
        Err(err) => Err(err),
    }
}

async fn ensure_sidecar_handle(
    state: &tauri::State<'_, crate::commands::AppState>,
) -> Result<Arc<SidecarHandle>, String> {
    let existing = {
        let guard = state.flowix_cli.read().await;
        guard.clone()
    };
    match existing {
        Some(handle) if handle.is_alive().await => Ok(handle),
        Some(_) | None => restart_sidecar_handle(state).await,
    }
}

async fn restart_sidecar_handle(
    state: &tauri::State<'_, crate::commands::AppState>,
) -> Result<Arc<SidecarHandle>, String> {
    let handle = SidecarHandle::spawn().await?;
    {
        let mut guard = state.flowix_cli.write().await;
        *guard = Some(handle.clone());
    }
    Ok(handle)
}
