//! watcher 通往壳的唯一出口。
//!
//! watcher 只做两件事：看磁盘、把结果写进索引。它需要的一切「外面的事」——
//! 云端同步调度、agent 会话路径重定位、后台索引与媒体扫描——都属于别的子系统。
//! 直接 `app.state::<AppState>()` 去拿，会让一个磁盘观察模块反向依赖壳的装配
//! 容器，也就是架构检查禁止的那条回边。
//!
//! 所以能力在这里声明成函数指针，由 `app::bootstrap` 在装配期注入一次。注入的
//! 实现自己负责从 `AppHandle` 里取 `AppState`（因此没有安装顺序要求：真正的
//! 调用发生在事件到达之后，那时 `AppState` 一定已经就位）。
//!
//! 返回 `Result` 的能力在端口缺失时返回错误而不是静默成功 —— 缺少注入是装配
//! bug，应该以日志形式暴露出来，而不是让「本次编辑没有同步到云端」无声发生。

use std::sync::OnceLock;

use flowix_sync::LocalChangeKind;
use tauri::AppHandle;

pub(crate) struct HostPorts {
    /// 让同步协调器看一眼这个笔记本。
    pub schedule_cloud_sync: fn(&AppHandle, &str, bool),
    /// 登记一条本机变更（云端据此决定要不要上传）。
    pub record_local_change:
        fn(&AppHandle, &str, &str, LocalChangeKind, &str) -> Result<bool, String>,
    /// 登记一次已确认的本机移动。
    pub record_local_move: fn(&AppHandle, &str, &str, &str) -> Result<bool, String>,
    /// 笔记/文件夹移动后，把引用它的 agent 会话跟着改路径。
    pub rebase_agent_paths:
        fn(&AppHandle, &str, &str, &str, &str, &str, &str) -> Result<(), String>,
    /// 请求后台重建索引。两个布尔的含义沿用 `NotebookBackground::request`：
    /// `urgent`（插队）与 `invalidate`（先作废旧索引）。
    pub request_background: fn(&AppHandle, &str, bool, bool),
    /// 只请求媒体扫描，返回是否真的排队了。
    pub request_media: fn(&AppHandle, &str) -> bool,
}

static PORTS: OnceLock<HostPorts> = OnceLock::new();

/// 安装实现。装配期调用一次。
pub(crate) fn install(ports: HostPorts) {
    if PORTS.set(ports).is_err() {
        tracing::warn!("watcher host port is already installed; keeping the first implementation");
    }
}

fn ports() -> Option<&'static HostPorts> {
    PORTS.get()
}

pub(crate) fn schedule_cloud_sync(app: &AppHandle, notebook_id: &str, generation_changed: bool) {
    match ports() {
        Some(ports) => (ports.schedule_cloud_sync)(app, notebook_id, generation_changed),
        // 缺注入意味着编辑到不了云端，必须吵闹。
        None => tracing::error!(
            notebook_id,
            "watcher host port is not installed; this local change will not be synced"
        ),
    }
}

pub(crate) fn record_local_change(
    app: &AppHandle,
    notebook_id: &str,
    cloud_id: &str,
    kind: LocalChangeKind,
    fingerprint: &str,
) -> Result<bool, String> {
    let Some(ports) = ports() else {
        return Err("watcher host port is not installed".to_string());
    };
    (ports.record_local_change)(app, notebook_id, cloud_id, kind, fingerprint)
}

pub(crate) fn record_local_move(
    app: &AppHandle,
    notebook_id: &str,
    from_path: &str,
    to_path: &str,
) -> Result<bool, String> {
    let Some(ports) = ports() else {
        return Err("watcher host port is not installed".to_string());
    };
    (ports.record_local_move)(app, notebook_id, from_path, to_path)
}

pub(crate) fn rebase_agent_paths(
    app: &AppHandle,
    old_notebook_id: &str,
    new_notebook_id: &str,
    old_relative: &str,
    new_relative: &str,
    old_absolute: &str,
    new_absolute: &str,
) -> Result<(), String> {
    let Some(ports) = ports() else {
        return Err("watcher host port is not installed".to_string());
    };
    (ports.rebase_agent_paths)(
        app,
        old_notebook_id,
        new_notebook_id,
        old_relative,
        new_relative,
        old_absolute,
        new_absolute,
    )
}

pub(crate) fn request_background(
    app: &AppHandle,
    notebook_id: &str,
    urgent: bool,
    invalidate: bool,
) {
    match ports() {
        Some(ports) => (ports.request_background)(app, notebook_id, urgent, invalidate),
        None => tracing::error!(
            notebook_id,
            "watcher host port is not installed; background indexing was not requested"
        ),
    }
}

pub(crate) fn request_media(app: &AppHandle, notebook_id: &str) -> bool {
    match ports() {
        Some(ports) => (ports.request_media)(app, notebook_id),
        None => {
            tracing::error!(
                notebook_id,
                "watcher host port is not installed; media scan was not requested"
            );
            false
        }
    }
}
