//! Typed tab-window coordinator.
//!
//! The coordinator understands window routing and tab identity only. Content
//! lifecycles (memo editing today, web pages later) stay in their renderers.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::app::state::AppState;
use crate::lock_utils::read_lock;

pub const WINDOW_OPEN_TAB_EVENT: &str = "flowix:window-open-tab";
pub const WINDOW_MERGE_HOVER_EVENT: &str = "flowix:window-merge-hover";
pub const WINDOW_ROLLBACK_TAB_EVENT: &str = "flowix:window-rollback-tab";
pub const WINDOW_TAB_DRAG_POINTER_EVENT: &str = "flowix:window-tab-drag-pointer";
const WINDOW_CASCADE_OFFSET: i32 = 32;
const WINDOW_CASCADE_SLOTS: usize = 8;
const TAB_DRAG_HOVER_POLL_INTERVAL: Duration = Duration::from_millis(24);
const TAB_TRANSFER_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const TAB_WINDOW_READY_TIMEOUT: Duration = Duration::from_secs(8);
const TAB_WINDOW_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TabTarget {
    Memo {
        memo_id: String,
        notebook_id: String,
        notebook_path: String,
        file_path: String,
    },
    ExternalMarkdown {
        file_path: String,
    },
    Web {
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowTab {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub target: TabTarget,
}

#[derive(Debug, Clone)]
struct WindowEntry {
    label: String,
    ready: bool,
    tabs: Vec<WindowTab>,
    tab_region: Option<WindowRegion>,
}

#[derive(Debug)]
struct MoveRollback {
    source_label: String,
    source_window_index: usize,
    source_tab_index: usize,
    source_ready: bool,
    source_tab_region: Option<WindowRegion>,
    target_label: String,
    tab: WindowTab,
    target_inserted: bool,
}

#[derive(Debug, Default)]
struct WindowRegistry {
    windows: Vec<WindowEntry>,
}

impl WindowRegistry {
    fn prune(&mut self, app: &tauri::AppHandle) {
        self.windows
            .retain(|entry| app.get_webview_window(&entry.label).is_some());
    }

    fn find_tab(&self, tab_id: &str) -> Option<&WindowEntry> {
        self.windows
            .iter()
            .find(|entry| entry.tabs.iter().any(|tab| tab.id == tab_id))
    }

    fn tab_in_window(&self, label: &str, tab_id: &str) -> Option<WindowTab> {
        self.windows
            .iter()
            .find(|entry| entry.label == label)
            .and_then(|entry| entry.tabs.iter().find(|tab| tab.id == tab_id))
            .cloned()
    }

    fn add_window(&mut self, label: String, initial: WindowTab) {
        self.windows.push(WindowEntry {
            label,
            ready: false,
            tabs: vec![initial],
            tab_region: None,
        });
    }

    fn append_to_last(&mut self, tab: WindowTab) -> Option<(String, bool)> {
        let entry = self.windows.last_mut()?;
        if !entry.tabs.iter().any(|candidate| candidate.id == tab.id) {
            entry.tabs.push(tab);
        }
        Some((entry.label.clone(), entry.ready))
    }

    fn append_to(&mut self, label: &str, tab: WindowTab) -> Option<(String, bool)> {
        let entry = self.windows.iter_mut().find(|entry| entry.label == label)?;
        if !entry.tabs.iter().any(|candidate| candidate.id == tab.id) {
            entry.tabs.push(tab);
        }
        Some((entry.label.clone(), entry.ready))
    }

    fn mark_ready(&mut self, label: &str) -> Option<Vec<WindowTab>> {
        let entry = self.windows.iter_mut().find(|entry| entry.label == label)?;
        entry.ready = true;
        Some(entry.tabs.clone())
    }

    fn set_tab_region(&mut self, label: &str, region: WindowRegion) -> Result<(), String> {
        let entry = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == label)
            .ok_or_else(|| "tab window is unavailable".to_string())?;
        entry.tab_region = Some(region);
        Ok(())
    }

    fn close_tab(&mut self, label: &str, tab_id: &str) {
        if let Some(entry) = self.windows.iter_mut().find(|entry| entry.label == label) {
            entry.tabs.retain(|tab| tab.id != tab_id);
        }
        self.windows.retain(|entry| !entry.tabs.is_empty());
    }

    fn close_window(&mut self, label: &str) {
        self.windows.retain(|entry| entry.label != label);
    }

    fn reorder_tab(
        &mut self,
        label: &str,
        tab_id: &str,
        before_tab_id: Option<&str>,
    ) -> Result<(), String> {
        let entry = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == label)
            .ok_or_else(|| "tab window is unavailable".to_string())?;
        let source_index = entry
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("tab is not registered in source window: {tab_id}"))?;
        if before_tab_id == Some(tab_id) {
            return Ok(());
        }
        if let Some(before_id) = before_tab_id {
            if !entry.tabs.iter().any(|tab| tab.id == before_id) {
                return Err(format!(
                    "target tab is not registered in source window: {before_id}"
                ));
            }
        }
        let tab = entry.tabs.remove(source_index);
        let target_index = before_tab_id
            .and_then(|before_id| {
                entry
                    .tabs
                    .iter()
                    .position(|candidate| candidate.id == before_id)
            })
            .unwrap_or(entry.tabs.len());
        entry.tabs.insert(target_index, tab);
        Ok(())
    }

    fn mark_focused(&mut self, label: &str) {
        let Some(index) = self.windows.iter().position(|entry| entry.label == label) else {
            return;
        };
        let entry = self.windows.remove(index);
        self.windows.push(entry);
    }

    fn move_tab(
        &mut self,
        source_label: &str,
        tab_id: &str,
        target_label: &str,
        refreshed_tab: WindowTab,
    ) -> Result<(WindowTab, bool, MoveRollback), String> {
        let source_window_index = self
            .windows
            .iter()
            .position(|entry| entry.label == source_label)
            .ok_or_else(|| "source tab window is unavailable".to_string())?;
        let source = &self.windows[source_window_index];
        let source_tab_index = source
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("tab is not registered in source window: {tab_id}"))?;
        let source_ready = source.ready;
        let source_tab_region = source.tab_region;
        let target = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == target_label)
            .ok_or_else(|| "target tab window is unavailable".to_string())?;
        let target_inserted = !target
            .tabs
            .iter()
            .any(|candidate| candidate.id == refreshed_tab.id);
        if target_inserted {
            target.tabs.push(refreshed_tab.clone());
        }
        let ready = target.ready;
        self.close_tab(source_label, tab_id);
        let rollback = MoveRollback {
            source_label: source_label.to_string(),
            source_window_index,
            source_tab_index,
            source_ready,
            source_tab_region,
            target_label: target_label.to_string(),
            tab: refreshed_tab.clone(),
            target_inserted,
        };
        Ok((refreshed_tab, ready, rollback))
    }

    fn rollback_move(&mut self, rollback: MoveRollback) {
        if rollback.target_inserted {
            if let Some(target) = self
                .windows
                .iter_mut()
                .find(|entry| entry.label == rollback.target_label)
            {
                target.tabs.retain(|tab| tab.id != rollback.tab.id);
            }
        }
        if let Some(source) = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == rollback.source_label)
        {
            if !source.tabs.iter().any(|tab| tab.id == rollback.tab.id) {
                let index = rollback.source_tab_index.min(source.tabs.len());
                source.tabs.insert(index, rollback.tab);
            }
            return;
        }
        let index = rollback.source_window_index.min(self.windows.len());
        self.windows.insert(
            index,
            WindowEntry {
                label: rollback.source_label,
                ready: rollback.source_ready,
                tabs: vec![rollback.tab],
                tab_region: rollback.source_tab_region,
            },
        );
    }
}

#[derive(Debug)]
struct TabItemDrag {
    source_label: String,
    tab_id: String,
    drag_id: String,
    hovered_target: Option<String>,
}

impl TabItemDrag {
    fn matches(&self, source_label: &str, tab_id: &str, drag_id: &str) -> bool {
        self.source_label == source_label && self.tab_id == tab_id && self.drag_id == drag_id
    }
}

pub struct TabWindowCoordinator {
    registry: Mutex<WindowRegistry>,
    open_lock: Mutex<()>,
    next_label: AtomicUsize,
    cascade_index: AtomicUsize,
    tab_item_drag: Mutex<Option<TabItemDrag>>,
    next_transfer: AtomicUsize,
    pending_transfers: Mutex<HashMap<String, (String, String)>>,
    transfer_acks: Mutex<HashSet<String>>,
    transfer_notify: tokio::sync::Notify,
    registered_notify: tokio::sync::Notify,
    ready_notify: tokio::sync::Notify,
}

impl Default for TabWindowCoordinator {
    fn default() -> Self {
        Self {
            registry: Mutex::new(WindowRegistry::default()),
            open_lock: Mutex::new(()),
            next_label: AtomicUsize::new(0),
            cascade_index: AtomicUsize::new(0),
            tab_item_drag: Mutex::new(None),
            next_transfer: AtomicUsize::new(0),
            pending_transfers: Mutex::new(HashMap::new()),
            transfer_acks: Mutex::new(HashSet::new()),
            transfer_notify: tokio::sync::Notify::new(),
            registered_notify: tokio::sync::Notify::new(),
            ready_notify: tokio::sync::Notify::new(),
        }
    }
}

impl TabWindowCoordinator {
    fn next_label(&self) -> String {
        format!(
            "tab-host-{}",
            self.next_label.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn next_transfer_id(&self) -> String {
        format!(
            "tab-transfer-{}",
            self.next_transfer.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn wait_for_transfer_ack(&self, transfer_id: &str) -> bool {
        let wait = async {
            loop {
                let notified = self.transfer_notify.notified();
                if self
                    .transfer_acks
                    .lock()
                    .is_ok_and(|acks| acks.contains(transfer_id))
                {
                    return true;
                }
                if self
                    .pending_transfers
                    .lock()
                    .is_ok_and(|pending| !pending.contains_key(transfer_id))
                {
                    return false;
                }
                notified.await;
            }
        };
        let acknowledged = tokio::time::timeout(TAB_TRANSFER_ACK_TIMEOUT, wait)
            .await
            .is_ok_and(|value| value);
        if let Ok(mut acks) = self.transfer_acks.lock() {
            acks.remove(transfer_id);
        }
        if let Ok(mut pending) = self.pending_transfers.lock() {
            pending.remove(transfer_id);
        }
        acknowledged
    }

    fn release_window_state(&self, app: &tauri::AppHandle, label: &str) {
        let cancelled_drag = self.tab_item_drag.lock().ok().and_then(|mut drag| {
            if drag.as_ref().is_some_and(|session| {
                session.source_label == label || session.hovered_target.as_deref() == Some(label)
            }) {
                drag.take()
            } else {
                None
            }
        });
        if let Some(cancelled_drag) = cancelled_drag {
            clear_merge_hover(app, cancelled_drag.hovered_target.as_deref());
        }

        let removed_transfers = self
            .pending_transfers
            .lock()
            .map(|mut pending| {
                let ids = pending
                    .iter()
                    .filter(|(_, (target_label, _))| target_label == label)
                    .map(|(transfer_id, _)| transfer_id.clone())
                    .collect::<Vec<_>>();
                pending.retain(|_, (target_label, _)| target_label != label);
                ids
            })
            .unwrap_or_default();
        if !removed_transfers.is_empty() {
            if let Ok(mut acknowledgements) = self.transfer_acks.lock() {
                for transfer_id in removed_transfers {
                    acknowledgements.remove(&transfer_id);
                }
            }
            self.transfer_notify.notify_waiters();
        }
        self.ready_notify.notify_waiters();
    }

    async fn wait_for_window_ready(&self, label: &str) -> bool {
        let wait = async {
            loop {
                let notified = self.ready_notify.notified();
                if let Ok(registry) = self.registry.lock() {
                    match registry.windows.iter().find(|entry| entry.label == label) {
                        Some(entry) if entry.ready => return true,
                        None => return false,
                        _ => {}
                    }
                }
                notified.await;
            }
        };
        tokio::time::timeout(TAB_WINDOW_READY_TIMEOUT, wait)
            .await
            .is_ok_and(|value| value)
    }

    async fn mark_window_ready_when_registered(
        &self,
        label: &str,
    ) -> Result<Vec<WindowTab>, String> {
        let wait = async {
            loop {
                let notified = self.registered_notify.notified();
                let tabs = self
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .mark_ready(label);
                if let Some(tabs) = tabs {
                    return Ok(tabs);
                }
                notified.await;
            }
        };
        tokio::time::timeout(TAB_WINDOW_REGISTRATION_TIMEOUT, wait)
            .await
            .map_err(|_| format!("tab window was not registered before ready timeout: {label}"))?
    }

    fn tab_item_drag_is_active(&self, source_label: &str, tab_id: &str, drag_id: &str) -> bool {
        self.tab_item_drag
            .lock()
            .ok()
            .and_then(|drag| {
                drag.as_ref()
                    .map(|session| session.matches(source_label, tab_id, drag_id))
            })
            .unwrap_or(false)
    }

    fn update_tab_item_drag_hover(
        &self,
        app: &tauri::AppHandle,
        source_label: &str,
        tab_id: &str,
        drag_id: &str,
        point: tauri::PhysicalPosition<i32>,
    ) -> bool {
        let Ok(mut drag) = self.tab_item_drag.lock() else {
            return false;
        };
        let Some(session) = drag
            .as_mut()
            .filter(|session| session.matches(source_label, tab_id, drag_id))
        else {
            return false;
        };
        let next_target = self
            .registry
            .lock()
            .ok()
            .and_then(|registry| find_header_target(app, &registry, source_label, point));
        if next_target == session.hovered_target {
            return true;
        }
        let previous = std::mem::replace(&mut session.hovered_target, next_target.clone());
        let tab = self
            .registry
            .lock()
            .ok()
            .and_then(|registry| registry.tab_in_window(source_label, tab_id));
        drop(drag);
        if let Some(label) = previous {
            emit_merge_hover(app, &label, false, tab.clone());
        }
        if let Some(label) = next_target {
            emit_merge_hover(app, &label, true, tab.clone());
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OpenDisposition {
    NewWindow,
    LastWindow,
    Window(String),
}

enum DetachOperation {
    Cancelled,
    NewWindow {
        label: String,
    },
    Merge {
        target_label: String,
        tab: WindowTab,
        ready: bool,
        rollback: MoveRollback,
    },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDragResult {
    merged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeHoverPayload {
    active: bool,
    tab: Option<WindowTab>,
    target_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowOpenTabPayload {
    tab: WindowTab,
    transfer_id: Option<String>,
    target_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowRollbackTabPayload {
    tab_id: String,
    transfer_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabDragPointerPayload {
    drag_id: String,
    screen_x: f64,
}

fn emit_tab_drag_pointer(
    app: &tauri::AppHandle,
    source_label: &str,
    drag_id: &str,
    point: tauri::PhysicalPosition<i32>,
) {
    let Some(window) = app.get_webview_window(source_label) else {
        return;
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    app.emit_to(
        tauri::EventTarget::webview_window(source_label),
        WINDOW_TAB_DRAG_POINTER_EVENT,
        TabDragPointerPayload {
            drag_id: drag_id.to_string(),
            screen_x: f64::from(point.x) / scale_factor,
        },
    )
    .ok();
}

fn emit_transfer_rollback(
    app: &tauri::AppHandle,
    target_label: &str,
    tab_id: &str,
    transfer_id: &str,
) {
    if app.get_webview_window(target_label).is_none() {
        return;
    }
    app.emit_to(
        tauri::EventTarget::webview_window(target_label),
        WINDOW_ROLLBACK_TAB_EVENT,
        WindowRollbackTabPayload {
            tab_id: tab_id.to_string(),
            transfer_id: transfer_id.to_string(),
        },
    )
    .ok();
}

fn emit_merge_hover(app: &tauri::AppHandle, label: &str, active: bool, tab: Option<WindowTab>) {
    if app.get_webview_window(label).is_none() {
        return;
    }
    app.emit_to(
        tauri::EventTarget::webview_window(label),
        WINDOW_MERGE_HOVER_EVENT,
        MergeHoverPayload {
            active,
            tab,
            target_label: label.to_string(),
        },
    )
    .ok();
}

fn clear_merge_hover(app: &tauri::AppHandle, target_label: Option<&str>) {
    if let Some(label) = target_label {
        emit_merge_hover(app, label, false, None);
    }
}

fn cursor_physical_position(
    app: &tauri::AppHandle,
) -> Result<tauri::PhysicalPosition<i32>, String> {
    app.cursor_position()
        .map(|position| {
            tauri::PhysicalPosition::new(position.x.round() as i32, position.y.round() as i32)
        })
        .map_err(|err| err.to_string())
}

fn point_is_in_region(
    point: tauri::PhysicalPosition<i32>,
    window_position: tauri::PhysicalPosition<i32>,
    scale: f64,
    region: WindowRegion,
) -> bool {
    let left = window_position
        .x
        .saturating_add((region.x * scale).round() as i32);
    let top = window_position
        .y
        .saturating_add((region.y * scale).round() as i32);
    let right = left.saturating_add((region.width * scale).round() as i32);
    let bottom = top.saturating_add((region.height * scale).round() as i32);
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
}

fn find_header_target(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    source_label: &str,
    point: tauri::PhysicalPosition<i32>,
) -> Option<String> {
    registry.windows.iter().rev().find_map(|entry| {
        if entry.label == source_label {
            return None;
        }
        let window = app.get_webview_window(&entry.label)?;
        let position = window.outer_position().ok()?;
        let scale = window.scale_factor().ok()?;
        let region = entry.tab_region?;
        point_is_in_region(point, position, scale, region).then(|| entry.label.clone())
    })
}

fn deliver_merged_tab(
    app: &tauri::AppHandle,
    target_label: &str,
    tab: &WindowTab,
    ready: bool,
    transfer_id: &str,
) -> Result<(), String> {
    let window = app
        .get_webview_window(target_label)
        .ok_or_else(|| "target tab window is unavailable".to_string())?;
    window.unminimize().ok();
    window.set_focus().ok();
    if ready {
        app.emit_to(
            tauri::EventTarget::webview_window(target_label),
            WINDOW_OPEN_TAB_EVENT,
            WindowOpenTabPayload {
                tab: tab.clone(),
                transfer_id: Some(transfer_id.to_string()),
                target_label: target_label.to_string(),
            },
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn refresh_tab(tab: &WindowTab, state: &AppState) -> Result<WindowTab, String> {
    match &tab.target {
        TabTarget::Memo { memo_id, .. } => resolve_memo_tab(memo_id, state),
        TabTarget::ExternalMarkdown { file_path } => resolve_external_markdown_tab(file_path),
        TabTarget::Web { .. } => Ok(tab.clone()),
    }
}

fn resolve_external_markdown_tab(file_path: &str) -> Result<WindowTab, String> {
    let requested = std::path::PathBuf::from(file_path);
    let is_markdown = requested
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        });
    if !is_markdown || !requested.is_file() {
        return Err(format!(
            "external Markdown is unavailable: {}",
            requested.display()
        ));
    }
    let canonical = dunce::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve external Markdown: {error}"))?;
    let title = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "external Markdown filename is unavailable".to_string())?
        .to_string();
    let canonical = canonical.to_string_lossy().to_string();
    Ok(WindowTab {
        id: format!("external:{canonical}"),
        title,
        icon: None,
        target: TabTarget::ExternalMarkdown {
            file_path: canonical,
        },
    })
}

fn resolve_markdown_path_tab(file_path: &str, state: &AppState) -> Result<WindowTab, String> {
    let memo_tab = if is_direct_registered_notebook_child(file_path, state) {
        crate::open_target::parse_open_target(file_path)
            .ok()
            .and_then(|target| {
                crate::open_target::resolve_open_target(target, state.memo_file.as_ref()).ok()
            })
            .map(|resolved| resolve_memo_tab(&resolved.memo_id, state))
            .transpose()?
    } else {
        None
    };
    match memo_tab {
        Some(tab) => Ok(tab),
        None => resolve_external_markdown_tab(file_path),
    }
}

pub fn route_markdown_path_tab(
    app: &tauri::AppHandle,
    state: &AppState,
    coordinator: &TabWindowCoordinator,
    file_path: &str,
) -> Result<(), String> {
    route_tab(
        app,
        coordinator,
        resolve_markdown_path_tab(file_path, state)?,
        OpenDisposition::LastWindow,
    )
}

fn markdown_disposition_for_source(
    coordinator: &TabWindowCoordinator,
    window_label: &str,
) -> OpenDisposition {
    if !window_label.starts_with("tab-host-") {
        return OpenDisposition::LastWindow;
    }
    let registry = match coordinator.registry.lock() {
        Ok(registry) => registry,
        Err(_) => return OpenDisposition::LastWindow,
    };
    if registry
        .windows
        .iter()
        .any(|entry| entry.label == window_label && entry.ready)
    {
        OpenDisposition::Window(window_label.to_string())
    } else {
        OpenDisposition::LastWindow
    }
}

fn is_direct_registered_notebook_child(file_path: &str, state: &AppState) -> bool {
    let Ok(file_path) = dunce::canonicalize(file_path) else {
        return false;
    };
    let Some(parent) = file_path.parent() else {
        return false;
    };
    let notebook_roots = read_lock(&state.memo_file, "memo_file").registered_notebook_paths();
    notebook_roots
        .into_iter()
        .any(|root| dunce::canonicalize(root).is_ok_and(|canonical_root| canonical_root == parent))
}

fn resolve_memo_tab(memo_id: &str, state: &AppState) -> Result<WindowTab, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let location = memo_file
        .resolve_memo_location(memo_id)
        .map_err(|e| format!("resolve memo location failed: {e}"))?
        .ok_or_else(|| format!("memo not found: {memo_id}"))?;
    let file_path = std::path::PathBuf::from(&location.notebook.path)
        .join(&location.memo.filename)
        .to_string_lossy()
        .to_string();

    Ok(WindowTab {
        id: format!("memo:{memo_id}"),
        title: location.memo.filename,
        icon: location.memo.icon,
        target: TabTarget::Memo {
            memo_id: memo_id.to_string(),
            notebook_id: location.notebook.id,
            notebook_path: location.notebook.path,
            file_path,
        },
    })
}

fn tab_window_title(tab: &WindowTab) -> &str {
    let title = tab.title.as_str();
    let Some((stem, extension)) = title.rsplit_once('.') else {
        return title;
    };
    if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown") {
        stem
    } else {
        title
    }
}

fn cascade_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    coordinator: &TabWindowCoordinator,
) {
    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(anchor), Ok(window_size), Ok(Some(monitor))) = (
        main_window.outer_position(),
        window.outer_size(),
        main_window.current_monitor(),
    ) else {
        return;
    };
    let index = coordinator.cascade_index.fetch_add(1, Ordering::Relaxed) % WINDOW_CASCADE_SLOTS;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let (x, y) = cascaded_window_position(
        (anchor.x, anchor.y),
        (window_size.width, window_size.height),
        (monitor_position.x, monitor_position.y),
        (monitor_size.width, monitor_size.height),
        index,
    );
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .ok();
}

fn cascaded_window_position(
    anchor: (i32, i32),
    window_size: (u32, u32),
    monitor_origin: (i32, i32),
    monitor_size: (u32, u32),
    cascade_index: usize,
) -> (i32, i32) {
    let monitor_width = monitor_size.0.min(i32::MAX as u32) as i32;
    let monitor_height = monitor_size.1.min(i32::MAX as u32) as i32;
    let window_width = window_size.0.min(i32::MAX as u32) as i32;
    let window_height = window_size.1.min(i32::MAX as u32) as i32;
    let max_x = monitor_origin
        .0
        .saturating_add(monitor_width)
        .saturating_sub(window_width)
        .max(monitor_origin.0);
    let max_y = monitor_origin
        .1
        .saturating_add(monitor_height)
        .saturating_sub(window_height)
        .max(monitor_origin.1);
    let base_x = anchor.0.saturating_add(64).clamp(monitor_origin.0, max_x);
    let base_y = anchor.1.saturating_add(64).clamp(monitor_origin.1, max_y);
    let offset = WINDOW_CASCADE_OFFSET * cascade_index as i32;
    let axis = |base: i32, min: i32, max: i32| {
        let forward = base.saturating_add(offset);
        if forward <= max {
            forward
        } else {
            base.saturating_sub(offset).clamp(min, max)
        }
    };
    (
        axis(base_x, monitor_origin.0, max_x),
        axis(base_y, monitor_origin.1, max_y),
    )
}

fn create_window(
    app: &tauri::AppHandle,
    coordinator: &TabWindowCoordinator,
    tab: WindowTab,
    position: Option<WindowPosition>,
) -> Result<String, String> {
    use tauri::WebviewWindowBuilder;

    let label = coordinator.next_label();
    let title = tab_window_title(&tab).to_string();
    let builder = WebviewWindowBuilder::new(
        app,
        label.clone(),
        tauri::WebviewUrl::App("index.html#tab-window".into()),
    )
    .title(title)
    .inner_size(900.0, 680.0)
    .min_inner_size(420.0, 520.0)
    .devtools(cfg!(debug_assertions));

    let builder = match position {
        Some(position) => builder.position(position.x, position.y),
        None => builder.center(),
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            18.0, 25.0,
        )));
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .add_window(label.clone(), tab);
    coordinator.registered_notify.notify_waiters();
    crate::window_chrome::apply_window_border_color(&window);
    // 鏂扮獥鍙ｅ嵆鍒诲榻愪富棰樿儗鏅壊 (涓庝富绐楀彛鍚姩涓€鑷?, 閬垮厤鍐峰惎鍔ㄧ櫧闂€?
    let theme = app.state::<AppState>().user_config.get_preference().theme;
    crate::window_chrome::apply_theme_background(&window, theme);
    if position.is_none() {
        cascade_window(app, &window, coordinator);
    }

    let app_handle = app.clone();
    let event_label = label.clone();
    window.on_window_event(move |event| {
        let coordinator = app_handle.state::<TabWindowCoordinator>();
        match event {
            tauri::WindowEvent::Destroyed => {
                if let Some(watches) = app_handle
                    .try_state::<crate::commands::external_document_watch::ExternalDocumentWatchState>()
                {
                    watches.release_window(&event_label);
                }
                coordinator.release_window_state(&app_handle, &event_label);
                if let Ok(mut registry) = coordinator.registry.lock() {
                    registry.close_window(&event_label);
                };
            }
            tauri::WindowEvent::Focused(true) => {
                if let Ok(mut registry) = coordinator.registry.lock() {
                    registry.mark_focused(&event_label);
                }
            }
            _ => {}
        }
    });
    Ok(label)
}

fn route_tab(
    app: &tauri::AppHandle,
    coordinator: &TabWindowCoordinator,
    tab: WindowTab,
    disposition: OpenDisposition,
) -> Result<(), String> {
    let _open_guard = coordinator
        .open_lock
        .lock()
        .map_err(|_| "tab window open lock poisoned".to_string())?;
    let mut registry = coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?;
    registry.prune(app);

    let target = registry
        .find_tab(&tab.id)
        .map(|entry| (entry.label.clone(), entry.ready))
        .or_else(|| match disposition {
            OpenDisposition::LastWindow => registry.append_to_last(tab.clone()),
            OpenDisposition::Window(label) => registry.append_to(&label, tab.clone()),
            OpenDisposition::NewWindow => None,
        });

    let Some((label, ready)) = target else {
        drop(registry);
        create_window(app, coordinator, tab, None)?;
        return Ok(());
    };
    drop(registry);

    let Some(window) = app.get_webview_window(&label) else {
        return Err("registered tab window is unavailable".to_string());
    };
    window.unminimize().ok();
    window.set_focus().ok();
    if ready {
        app.emit_to(
            tauri::EventTarget::webview_window(&label),
            WINDOW_OPEN_TAB_EVENT,
            WindowOpenTabPayload {
                tab,
                transfer_id: None,
                target_label: label.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_note_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    memo_id: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_memo_tab(&memo_id, state.inner())?,
        OpenDisposition::NewWindow,
    )
}

#[tauri::command]
pub async fn open_note_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    memo_id: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_memo_tab(&memo_id, state.inner())?,
        OpenDisposition::LastWindow,
    )
}

#[tauri::command]
pub async fn open_external_markdown_window(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    file_path: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_external_markdown_tab(&file_path)?,
        OpenDisposition::NewWindow,
    )
}

#[tauri::command]
pub async fn open_external_markdown_tab(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    file_path: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_external_markdown_tab(&file_path)?,
        OpenDisposition::LastWindow,
    )
}

#[tauri::command]
pub async fn open_markdown_path_tab(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    file_path: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_markdown_path_tab(&file_path, state.inner())?,
        markdown_disposition_for_source(coordinator.inner(), window.label()),
    )
}

#[tauri::command]
pub async fn tab_window_ready(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
) -> Result<Vec<WindowTab>, String> {
    let tabs = coordinator
        .mark_window_ready_when_registered(window.label())
        .await?;
    coordinator.ready_notify.notify_waiters();
    Ok(tabs)
}

#[tauri::command]
pub fn tab_window_ack_transfer(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    transfer_id: String,
    tab_id: String,
) -> Result<(), String> {
    let expected_transfer = coordinator
        .pending_transfers
        .lock()
        .map_err(|_| "pending tab transfer lock poisoned".to_string())?
        .get(&transfer_id)
        .cloned();
    if expected_transfer.as_ref() != Some(&(window.label().to_string(), tab_id.clone())) {
        return Err("tab transfer is unavailable".to_string());
    }
    coordinator
        .transfer_acks
        .lock()
        .map_err(|_| "tab transfer acknowledgement lock poisoned".to_string())?
        .insert(transfer_id);
    coordinator.transfer_notify.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn tab_window_set_tab_region(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    region: WindowRegion,
) -> Result<(), String> {
    coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .set_tab_region(window.label(), region)
}

#[tauri::command]
pub fn tab_window_close_tab(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
) -> Result<(), String> {
    let mut registry = coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?;
    registry.close_tab(window.label(), &tab_id);
    Ok(())
}

#[tauri::command]
pub fn tab_window_reorder_tab(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    before_tab_id: Option<String>,
) -> Result<(), String> {
    coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .reorder_tab(window.label(), &tab_id, before_tab_id.as_deref())
}

#[tauri::command]
pub fn tab_window_begin_tab_item_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    drag_id: String,
) -> Result<(), String> {
    {
        let registry = coordinator
            .registry
            .lock()
            .map_err(|_| "tab window registry lock poisoned".to_string())?;
        if registry.tab_in_window(window.label(), &tab_id).is_none() {
            return Err(format!("tab is not registered in source window: {tab_id}"));
        }
    }
    let source_label = window.label().to_string();
    let next = TabItemDrag {
        source_label: source_label.clone(),
        tab_id: tab_id.clone(),
        drag_id: drag_id.clone(),
        hovered_target: None,
    };
    let previous = coordinator
        .tab_item_drag
        .lock()
        .map_err(|_| "tab item drag lock poisoned".to_string())?
        .replace(next);
    if let Some(previous) = previous {
        clear_merge_hover(&app, previous.hovered_target.as_deref());
    }
    if let Ok(point) = cursor_physical_position(&app) {
        emit_tab_drag_pointer(&app, &source_label, &drag_id, point);
        coordinator.update_tab_item_drag_hover(&app, &source_label, &tab_id, &drag_id, point);
    }

    // HTML drag events are not delivered consistently after the cursor leaves
    // a WebView (notably on macOS). Polling the OS cursor from the backend keeps
    // hover detection ordered and independent from either WebView's event loop.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TAB_DRAG_HOVER_POLL_INTERVAL).await;
            let coordinator = app.state::<TabWindowCoordinator>();
            if !coordinator.tab_item_drag_is_active(&source_label, &tab_id, &drag_id) {
                break;
            }
            let Ok(point) = cursor_physical_position(&app) else {
                continue;
            };
            emit_tab_drag_pointer(&app, &source_label, &drag_id, point);
            if !coordinator.update_tab_item_drag_hover(
                &app,
                &source_label,
                &tab_id,
                &drag_id,
                point,
            ) {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn tab_window_cancel_tab_item_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    drag_id: String,
) -> Result<(), String> {
    let cancelled = {
        let mut drag = coordinator
            .tab_item_drag
            .lock()
            .map_err(|_| "tab item drag lock poisoned".to_string())?;
        if drag
            .as_ref()
            .is_some_and(|session| session.matches(window.label(), &tab_id, &drag_id))
        {
            drag.take()
        } else {
            None
        }
    };
    if let Some(cancelled) = cancelled {
        clear_merge_hover(&app, cancelled.hovered_target.as_deref());
    }
    Ok(())
}

/// Moves a tab to another host or tears it off into a host window.
/// A single-tab source is merged only when dropped on another host; otherwise
/// the operation is cancelled and its existing window remains unchanged.
#[tauri::command]
pub async fn tab_window_detach_tab(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    position: WindowPosition,
    drag_id: String,
) -> Result<TabDragResult, String> {
    // Read the authoritative OS cursor before consuming the session. A
    // transient platform error then leaves the drag cancellable/retryable.
    let drop_point = cursor_physical_position(&app)?;
    let item_drag = {
        let mut drag = coordinator
            .tab_item_drag
            .lock()
            .map_err(|_| "tab item drag lock poisoned".to_string())?;
        if drag
            .as_ref()
            .is_some_and(|session| session.matches(window.label(), &tab_id, &drag_id))
        {
            drag.take()
        } else {
            None
        }
    }
    .ok_or_else(|| "tab item drag session is unavailable".to_string())?;

    let source_label = window.label().to_string();
    let registered_tab = coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .tab_in_window(&source_label, &tab_id)
        .ok_or_else(|| format!("tab is not registered in source window: {tab_id}"))?;
    let refreshed_tab = refresh_tab(&registered_tab, state.inner())?;
    let operation = (|| -> Result<DetachOperation, String> {
        let _open_guard = coordinator
            .open_lock
            .lock()
            .map_err(|_| "tab window open lock poisoned".to_string())?;
        let mut registry = coordinator
            .registry
            .lock()
            .map_err(|_| "tab window registry lock poisoned".to_string())?;
        registry.prune(&app);

        if registry.tab_in_window(&source_label, &tab_id).is_none() {
            return Err(format!("tab is not registered in source window: {tab_id}"));
        }
        let source_has_only_tab = registry
            .windows
            .iter()
            .find(|entry| entry.label == source_label)
            .is_some_and(|entry| entry.tabs.len() == 1);
        if let Some(target_label) = find_header_target(&app, &registry, &source_label, drop_point) {
            let (tab, ready, rollback) =
                registry.move_tab(&source_label, &tab_id, &target_label, refreshed_tab.clone())?;
            return Ok(DetachOperation::Merge {
                target_label,
                tab,
                ready,
                rollback,
            });
        }

        if source_has_only_tab {
            return Ok(DetachOperation::Cancelled);
        }

        drop(registry);
        let label = create_window(
            &app,
            coordinator.inner(),
            refreshed_tab.clone(),
            Some(position),
        )?;
        Ok(DetachOperation::NewWindow { label })
    })();
    clear_merge_hover(&app, item_drag.hovered_target.as_deref());
    match operation? {
        DetachOperation::Cancelled => Ok(TabDragResult { merged: false }),
        DetachOperation::NewWindow { label } => {
            if !coordinator.wait_for_window_ready(&label).await {
                if let Ok(mut registry) = coordinator.registry.lock() {
                    registry.close_window(&label);
                }
                if let Some(created) = app.get_webview_window(&label) {
                    created.destroy().ok();
                }
                return Err("new tab window did not become ready".to_string());
            }
            let _open_guard = coordinator
                .open_lock
                .lock()
                .map_err(|_| "tab window open lock poisoned".to_string())?;
            coordinator
                .registry
                .lock()
                .map_err(|_| "tab window registry lock poisoned".to_string())?
                .close_tab(&source_label, &tab_id);
            Ok(TabDragResult { merged: false })
        }
        DetachOperation::Merge {
            target_label,
            tab,
            ready,
            rollback,
        } => {
            if !ready {
                coordinator
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .rollback_move(rollback);
                return Err("target tab window is not ready".to_string());
            }
            let transfer_id = coordinator.next_transfer_id();
            coordinator
                .pending_transfers
                .lock()
                .map_err(|_| "pending tab transfer lock poisoned".to_string())?
                .insert(transfer_id.clone(), (target_label.clone(), tab.id.clone()));
            if let Err(err) = deliver_merged_tab(&app, &target_label, &tab, ready, &transfer_id) {
                if let Ok(mut pending) = coordinator.pending_transfers.lock() {
                    pending.remove(&transfer_id);
                }
                coordinator
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .rollback_move(rollback);
                emit_transfer_rollback(&app, &target_label, &tab.id, &transfer_id);
                return Err(err);
            }
            if !coordinator.wait_for_transfer_ack(&transfer_id).await {
                coordinator
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .rollback_move(rollback);
                emit_transfer_rollback(&app, &target_label, &tab.id, &transfer_id);
                return Err("target tab window did not acknowledge the transfer".to_string());
            }
            Ok(TabDragResult { merged: true })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> WindowTab {
        WindowTab {
            id: id.to_string(),
            title: id.to_string(),
            icon: None,
            target: TabTarget::Web {
                url: format!("https://example.com/{id}"),
            },
        }
    }

    fn tab_ids(registry: &WindowRegistry, label: &str) -> Vec<String> {
        registry
            .windows
            .iter()
            .find(|entry| entry.label == label)
            .unwrap()
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect()
    }

    #[test]
    fn registry_routes_any_tab_kind_to_the_most_recently_focused_window() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("memo:a"));
        registry.add_window("tab-host-2".to_string(), tab("web:a"));
        registry.mark_focused("tab-host-1");
        assert_eq!(
            registry.append_to_last(tab("web:b")),
            Some(("tab-host-1".to_string(), false))
        );
        assert_eq!(registry.find_tab("web:b").unwrap().label, "tab-host-1");
    }

    #[test]
    fn registry_routes_a_dropped_tab_to_the_explicit_host() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("memo:a"));
        registry.add_window("tab-host-2".to_string(), tab("web:a"));
        registry.mark_focused("tab-host-2");

        assert_eq!(
            registry.append_to("tab-host-1", tab("external:a")),
            Some(("tab-host-1".to_string(), false))
        );
        assert_eq!(
            registry
                .find_tab("external:a")
                .map(|entry| entry.label.as_str()),
            Some("tab-host-1")
        );
    }

    #[test]
    fn markdown_drop_uses_the_source_tab_host_when_available() {
        let coordinator = TabWindowCoordinator::default();
        coordinator
            .registry
            .lock()
            .unwrap()
            .add_window("tab-host-7".to_string(), tab("memo:a"));
        coordinator
            .registry
            .lock()
            .unwrap()
            .mark_ready("tab-host-7")
            .expect("mark ready");

        assert_eq!(
            markdown_disposition_for_source(&coordinator, "tab-host-7"),
            OpenDisposition::Window("tab-host-7".to_string())
        );
        assert_eq!(
            markdown_disposition_for_source(&coordinator, "main"),
            OpenDisposition::LastWindow
        );

        // 未就绪或不在 registry 中的 tab-host 降级为 LastWindow，避免错过
        // `WINDOW_OPEN_TAB_EVENT` 后的"静默吞 tab"。
        assert_eq!(
            markdown_disposition_for_source(&coordinator, "tab-host-99"),
            OpenDisposition::LastWindow
        );

        let pending = TabWindowCoordinator::default();
        pending
            .registry
            .lock()
            .unwrap()
            .add_window("tab-host-pending".to_string(), tab("memo:a"));
        assert_eq!(
            markdown_disposition_for_source(&pending, "tab-host-pending"),
            OpenDisposition::LastWindow
        );
    }

    #[test]
    fn window_title_uses_the_first_document_title_without_markdown_extension() {
        assert_eq!(tab_window_title(&tab("Project Notes.md")), "Project Notes");
        assert_eq!(
            tab_window_title(&tab("椤圭洰璁″垝.MARKDOWN")),
            "椤圭洰璁″垝"
        );
    }

    #[test]
    fn ready_returns_tabs_queued_during_webview_startup() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("memo:a"));
        registry.append_to_last(tab("web:a"));
        let tabs = registry.mark_ready("tab-host-1").unwrap();
        assert_eq!(
            tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
            vec!["memo:a", "web:a"]
        );
    }

    #[test]
    fn ready_distinguishes_an_unregistered_window() {
        let mut registry = WindowRegistry::default();
        assert_eq!(registry.mark_ready("tab-host-missing"), None);
    }

    #[tokio::test]
    async fn ready_waits_for_window_registration() {
        let coordinator = std::sync::Arc::new(TabWindowCoordinator::default());
        let waiting = {
            let coordinator = std::sync::Arc::clone(&coordinator);
            tokio::spawn(async move {
                coordinator
                    .mark_window_ready_when_registered("tab-host-1")
                    .await
            })
        };

        tokio::task::yield_now().await;
        coordinator
            .registry
            .lock()
            .unwrap()
            .add_window("tab-host-1".to_string(), tab("memo:a"));
        coordinator.registered_notify.notify_waiters();

        let tabs = waiting.await.unwrap().unwrap();
        assert_eq!(
            tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
            vec!["memo:a"]
        );
        assert!(coordinator
            .registry
            .lock()
            .unwrap()
            .windows
            .iter()
            .find(|entry| entry.label == "tab-host-1")
            .is_some_and(|entry| entry.ready));
    }

    #[test]
    fn closing_the_last_tab_removes_the_window() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("memo:a"));
        registry.close_tab("tab-host-1", "memo:a");
        assert!(registry.windows.is_empty());
    }

    #[test]
    fn reordering_a_tab_updates_only_its_window_order() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("a"));
        registry.append_to_last(tab("b"));
        registry.append_to_last(tab("c"));

        registry.reorder_tab("tab-host-1", "c", Some("a")).unwrap();
        assert_eq!(tab_ids(&registry, "tab-host-1"), vec!["c", "a", "b"]);

        registry.reorder_tab("tab-host-1", "c", None).unwrap();
        assert_eq!(tab_ids(&registry, "tab-host-1"), vec!["a", "b", "c"]);
        assert!(registry
            .reorder_tab("tab-host-1", "c", Some("missing"))
            .is_err());
        assert_eq!(tab_ids(&registry, "tab-host-1"), vec!["a", "b", "c"]);
    }

    #[test]
    fn tab_lookup_is_scoped_to_the_source_window() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("memo:a"));
        registry.add_window("tab-host-2".to_string(), tab("web:a"));

        assert_eq!(
            registry
                .tab_in_window("tab-host-2", "web:a")
                .map(|tab| tab.id),
            Some("web:a".to_string())
        );
        assert!(registry.tab_in_window("tab-host-1", "web:a").is_none());
    }

    #[test]
    fn moving_a_tab_removes_an_empty_source() {
        let mut registry = WindowRegistry::default();
        registry.add_window("tab-host-1".to_string(), tab("memo:a"));
        registry.add_window("tab-host-2".to_string(), tab("memo:b"));
        registry.mark_ready("tab-host-2").unwrap();

        let refreshed = WindowTab {
            title: "renamed.md".to_string(),
            ..tab("memo:a")
        };
        let (moved, ready, rollback) = registry
            .move_tab("tab-host-1", "memo:a", "tab-host-2", refreshed)
            .unwrap();

        assert_eq!(moved.id, "memo:a");
        assert_eq!(moved.title, "renamed.md");
        assert!(ready);
        assert!(registry
            .windows
            .iter()
            .all(|entry| entry.label != "tab-host-1"));
        assert_eq!(
            registry
                .windows
                .iter()
                .find(|entry| entry.label == "tab-host-2")
                .unwrap()
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            vec!["memo:b", "memo:a"]
        );

        registry.rollback_move(rollback);
        assert_eq!(
            registry
                .tab_in_window("tab-host-1", "memo:a")
                .map(|tab| tab.title),
            Some("renamed.md".to_string())
        );
        assert!(registry.tab_in_window("tab-host-2", "memo:a").is_none());
    }

    #[test]
    fn drag_hit_test_accepts_only_the_registered_tab_region() {
        let position = tauri::PhysicalPosition::new(100, 200);
        let region = WindowRegion {
            x: 90.0,
            y: 8.0,
            width: 600.0,
            height: 32.0,
        };
        assert!(point_is_in_region(
            tauri::PhysicalPosition::new(280, 216),
            position,
            2.0,
            region,
        ));
        assert!(point_is_in_region(
            tauri::PhysicalPosition::new(1480, 280),
            position,
            2.0,
            region,
        ));
        assert!(!point_is_in_region(
            tauri::PhysicalPosition::new(279, 240),
            position,
            2.0,
            region,
        ));
        assert!(!point_is_in_region(
            tauri::PhysicalPosition::new(500, 281),
            position,
            2.0,
            region,
        ));
    }

    #[test]
    fn tab_item_drag_session_is_scoped_by_source_tab_and_drag_id() {
        let drag = TabItemDrag {
            source_label: "tab-host-1".to_string(),
            tab_id: "memo:a".to_string(),
            drag_id: "drag-1".to_string(),
            hovered_target: None,
        };
        assert!(drag.matches("tab-host-1", "memo:a", "drag-1"));
        assert!(!drag.matches("tab-host-2", "memo:a", "drag-1"));
        assert!(!drag.matches("tab-host-1", "memo:b", "drag-1"));
        assert!(!drag.matches("tab-host-1", "memo:a", "drag-2"));
    }

    #[test]
    fn cascade_position_stays_inside_the_monitor() {
        assert_eq!(
            cascaded_window_position((1600, 900), (900, 680), (0, 0), (1920, 1080), 7),
            (796, 176)
        );
    }

    #[test]
    fn tab_protocol_serializes_as_the_frontend_discriminated_union() {
        let memo_tab = WindowTab {
            id: "memo:a".to_string(),
            title: "A.md".to_string(),
            icon: None,
            target: TabTarget::Memo {
                memo_id: "a".to_string(),
                notebook_id: "notebook".to_string(),
                notebook_path: "/notebook".to_string(),
                file_path: "/notebook/A.md".to_string(),
            },
        };
        let value = serde_json::to_value(&memo_tab).unwrap();
        assert_eq!(value["id"], "memo:a");
        assert_eq!(value["target"]["kind"], "memo");
        assert_eq!(value["target"]["memoId"], "a");
        assert_eq!(value["target"]["filePath"], "/notebook/A.md");

        let external_tab = WindowTab {
            id: "external:/tmp/Outside.md".to_string(),
            title: "Outside.md".to_string(),
            icon: None,
            target: TabTarget::ExternalMarkdown {
                file_path: "/tmp/Outside.md".to_string(),
            },
        };
        let external_value = serde_json::to_value(external_tab).unwrap();
        assert_eq!(external_value["target"]["kind"], "external_markdown");
        assert_eq!(external_value["target"]["filePath"], "/tmp/Outside.md");

        let delivery = serde_json::to_value(WindowOpenTabPayload {
            tab: memo_tab,
            transfer_id: Some("tab-transfer-1".to_string()),
            target_label: "tab-host-2".to_string(),
        })
        .unwrap();
        assert_eq!(delivery["tab"]["id"], "memo:a");
        assert_eq!(delivery["transferId"], "tab-transfer-1");
        assert_eq!(delivery["targetLabel"], "tab-host-2");
    }

    #[test]
    fn external_markdown_tab_uses_canonical_path_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("Outside.md");
        std::fs::write(&path, "# Outside").unwrap();

        let tab = resolve_external_markdown_tab(path.to_string_lossy().as_ref()).unwrap();
        let canonical = dunce::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(tab.id, format!("external:{canonical}"));
        assert_eq!(tab.title, "Outside.md");
        assert_eq!(
            tab.target,
            TabTarget::ExternalMarkdown {
                file_path: canonical,
            }
        );
    }
}
