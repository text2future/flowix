//! Serializes manual, automatic and polling path sync work, including retries.
mod status;

use super::*;
use flowix_sync::{PathNotebookLink, PendingNotebookAction};
use status::emit_activity_status;
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum SyncTarget {
    Notebook(String),
    FullAccount,
}

impl SyncTarget {
    fn notebook_scope(&self) -> Option<&str> {
        match self {
            Self::Notebook(notebook_id) => Some(notebook_id),
            Self::FullAccount => None,
        }
    }

    fn merge(&mut self, other: Self) {
        if *self != other {
            *self = Self::FullAccount;
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Notebook(notebook_id) => notebook_id,
            Self::FullAccount => "full-account",
        }
    }
}

fn current_target(requested: SyncTarget, current: Option<String>) -> Option<SyncTarget> {
    match (requested, current) {
        (SyncTarget::FullAccount, Some(id)) => Some(SyncTarget::Notebook(id)),
        (SyncTarget::Notebook(id), Some(current)) if id == current => {
            Some(SyncTarget::Notebook(id))
        }
        _ => None,
    }
}

struct ManualSyncRequest {
    target: SyncTarget,
    responder: oneshot::Sender<Result<CloudSyncResult, String>>,
    selection_epoch: u64,
}

enum SyncCoordinatorRequest {
    Automatic {
        target: SyncTarget,
        generation_changed: bool,
    },
    Retry(SyncTarget),
    Poll,
    Manual(ManualSyncRequest),
}

#[derive(Clone)]
struct SyncCoordinatorHandle {
    sender: mpsc::UnboundedSender<QueuedSyncRequest>,
    pending: std::sync::Arc<std::sync::Mutex<HashSet<CoalescedRequest>>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
enum CoalescedRequest {
    Poll,
    Automatic(SyncTarget, bool),
}

struct QueuedSyncRequest {
    request: SyncCoordinatorRequest,
    key: Option<CoalescedRequest>,
    pending: std::sync::Arc<std::sync::Mutex<HashSet<CoalescedRequest>>>,
}

impl QueuedSyncRequest {
    fn take(self) -> SyncCoordinatorRequest {
        if let Some(key) = &self.key {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(key);
        }
        self.request
    }
}

impl SyncCoordinatorHandle {
    fn send(&self, request: SyncCoordinatorRequest) -> Result<(), String> {
        let key = match &request {
            SyncCoordinatorRequest::Poll => Some(CoalescedRequest::Poll),
            SyncCoordinatorRequest::Automatic {
                target,
                generation_changed,
            } => Some(CoalescedRequest::Automatic(
                target.clone(),
                *generation_changed,
            )),
            _ => None,
        };
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = &key {
            if !pending.insert(key.clone()) {
                return Ok(());
            }
        }
        let queued = QueuedSyncRequest {
            request,
            key: key.clone(),
            pending: self.pending.clone(),
        };
        if self.sender.send(queued).is_err() {
            if let Some(key) = key {
                pending.remove(&key);
            }
            return Err("cloud sync coordinator is unavailable".to_string());
        }
        Ok(())
    }
}

#[derive(Default)]
struct PendingSyncBatch {
    target: Option<SyncTarget>,
    responders: Vec<ManualSyncRequest>,
    retry_on_failure: bool,
    debounce_required: bool,
}

impl PendingSyncBatch {
    fn merge_target(&mut self, target: SyncTarget) {
        match &mut self.target {
            Some(current) => current.merge(target),
            None => self.target = Some(target),
        }
    }
}

struct SyncActivity {
    run_id: String,
    started_at: i64,
    notebooks: HashSet<String>,
    result: CloudSyncResult,
}

impl SyncActivity {
    fn new() -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            notebooks: HashSet::new(),
            result: CloudSyncResult {
                notebooks: 0,
                uploaded: 0,
                deleted: 0,
                downloaded: 0,
            },
        }
    }
}

const AUTO_SYNC_DEBOUNCE: Duration = Duration::from_millis(600);
const AUTO_SYNC_MAX_WAIT: Duration = Duration::from_secs(5);
const FAILED_SYNC_RETRY_INTERVAL: Duration = Duration::from_secs(30);
pub(super) const CLOUD_POLL_INTERVAL: Duration = Duration::from_secs(10);
const CLOUD_SYNC_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

async fn timeout_without_progress<F: std::future::Future>(
    mut progress: watch::Receiver<()>,
    future: F,
    idle: Duration,
) -> Result<F::Output, ()> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            biased;
            result = &mut future => return Ok(result),
            changed = progress.changed() => {
                if changed.is_err() { return Err(()); }
            }
            _ = tokio::time::sleep(idle) => return Err(()),
        }
    }
}

static SYNC_COORDINATOR: OnceLock<SyncCoordinatorHandle> = OnceLock::new();
static POLLING_STARTED: AtomicBool = AtomicBool::new(false);
static DELETION_WORKER_RUNNING: AtomicBool = AtomicBool::new(false);
static NOTEBOOK_SELECTION: Lazy<watch::Sender<u64>> = Lazy::new(|| watch::channel(0).0);

async fn run_until_selection_changed<F: std::future::Future>(
    changes: &mut watch::Receiver<u64>,
    future: F,
) -> Option<F::Output> {
    tokio::pin!(future);
    tokio::select! {
        biased;
        _ = changes.changed() => None,
        result = &mut future => Some(result),
    }
}

fn current_notebook_id(state: &AppState) -> Option<String> {
    read_lock(&state.memo_file, "memo_file").current_notebook_id_value()
}

/// Called under notebook_transition before the selected notebook can change.
pub(crate) fn invalidate_notebook_selection() {
    NOTEBOOK_SELECTION.send_modify(|generation| *generation = generation.wrapping_add(1));
}

pub(crate) fn notebook_selection_changed(app: &AppHandle, notebook_id: Option<&str>) {
    if let Some(notebook_id) = notebook_id {
        schedule_notebook_sync(app.clone(), notebook_id.to_string());
    }
}

fn sync_coordinator(app: &AppHandle) -> SyncCoordinatorHandle {
    SYNC_COORDINATOR
        .get_or_init(|| {
            let (sender, receiver) = mpsc::unbounded_channel();
            let pending = std::sync::Arc::new(std::sync::Mutex::new(HashSet::new()));
            let handle = SyncCoordinatorHandle { sender, pending };
            tauri::async_runtime::spawn(run_sync_coordinator(app.clone(), receiver));
            handle
        })
        .clone()
}

fn send_sync_request(app: &AppHandle, request: SyncCoordinatorRequest) -> Result<(), String> {
    sync_coordinator(app).send(request)
}

fn automatic_sync_available(app: &AppHandle, notebook_id: &str) -> bool {
    let state = app.state::<AppState>();
    current_notebook_id(state.inner()).as_deref() == Some(notebook_id)
        && state.cloud_sync.cloud_sync_available()
        && state
            .cloud_sync
            .path_notebook(notebook_id)
            .ok()
            .flatten()
            .is_some_and(|notebook| notebook.enabled)
}

fn automatic_sync_target_available(app: &AppHandle, target: &SyncTarget) -> bool {
    match target {
        SyncTarget::Notebook(notebook_id) => automatic_sync_available(app, notebook_id),
        SyncTarget::FullAccount => {
            let state = app.state::<AppState>();
            current_notebook_id(state.inner()).is_some_and(|id| automatic_sync_available(app, &id))
        }
    }
}

fn enabled_notebooks_for_target(
    state: &AppState,
    target: &SyncTarget,
) -> Result<Vec<PathNotebookLink>, String> {
    Ok(state
        .cloud_sync
        .path_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .filter(|notebook| {
            target
                .notebook_scope()
                .is_none_or(|scope| notebook.notebook_id == scope)
        })
        .collect())
}

fn fail_sync_activity(
    app: &AppHandle,
    activity: &SyncActivity,
    batch: &mut PendingSyncBatch,
    target: &SyncTarget,
    error: String,
) -> String {
    let mut affected_notebooks = activity.notebooks.clone();
    if let SyncTarget::Notebook(notebook_id) = target {
        affected_notebooks.insert(notebook_id.clone());
    }
    emit_activity_status(
        app,
        activity,
        affected_notebooks,
        "error",
        "failed",
        Some(&error),
    );
    finish_responders(
        std::mem::take(&mut batch.responders),
        Err(error.clone()),
        &HashSet::new(),
    );
    if batch.retry_on_failure {
        schedule_retry_after_failure(app, target.clone());
    }
    error
}

fn merge_waiting_request(
    batch: &mut PendingSyncBatch,
    request: SyncCoordinatorRequest,
    poll_due: bool,
) -> bool {
    match request {
        SyncCoordinatorRequest::Automatic {
            target,
            generation_changed,
        } => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required |= generation_changed;
            false
        }
        SyncCoordinatorRequest::Retry(target) if poll_due => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        SyncCoordinatorRequest::Retry(_) => false,
        SyncCoordinatorRequest::Poll if poll_due => {
            batch.merge_target(SyncTarget::FullAccount);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        SyncCoordinatorRequest::Poll => false,
        SyncCoordinatorRequest::Manual(request) => {
            batch.merge_target(request.target.clone());
            batch.responders.push(request);
            batch.debounce_required = false;
            true
        }
    }
}

async fn collect_debounced_requests(
    receiver: &mut mpsc::UnboundedReceiver<QueuedSyncRequest>,
    batch: &mut PendingSyncBatch,
    poll_due: bool,
) {
    if !batch.debounce_required {
        return;
    }
    let max_deadline = Instant::now() + AUTO_SYNC_MAX_WAIT;
    let mut quiet_deadline = Instant::now() + AUTO_SYNC_DEBOUNCE;
    loop {
        let deadline = quiet_deadline.min(max_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let request = request.take();
                let resets_debounce = matches!(
                    request,
                    SyncCoordinatorRequest::Automatic {
                        generation_changed: true,
                        ..
                    }
                );
                if merge_waiting_request(batch, request, poll_due) {
                    break;
                }
                if resets_debounce {
                    quiet_deadline = (Instant::now() + AUTO_SYNC_DEBOUNCE).min(max_deadline);
                }
            }
        }
    }
    batch.debounce_required = false;
}

fn activity_covers(
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
    target: &SyncTarget,
) -> bool {
    completed_full_account
        || matches!(target, SyncTarget::Notebook(notebook_id) if completed_notebooks.contains(notebook_id))
}

fn merge_request_after_pass(
    batch: &mut PendingSyncBatch,
    request: SyncCoordinatorRequest,
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
) -> bool {
    match request {
        // An automatic request represents a possibly newer dirty generation,
        // even when the just-finished pass covered the same notebook.
        SyncCoordinatorRequest::Automatic {
            target,
            generation_changed: true,
        } => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = true;
            false
        }
        // The pass already covers this persisted generation. An identical
        // editor/watcher observation must not create a trailing network pass.
        SyncCoordinatorRequest::Automatic {
            generation_changed: false,
            target,
        } => {
            if activity_covers(completed_full_account, completed_notebooks, &target) {
                false
            } else {
                batch.merge_target(target);
                batch.retry_on_failure = true;
                batch.debounce_required = false;
                true
            }
        }
        SyncCoordinatorRequest::Retry(target) => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        // A successful pass makes an overlapping poll redundant. The next
        // periodic tick will be measured from this activity's success.
        SyncCoordinatorRequest::Poll => false,
        SyncCoordinatorRequest::Manual(request) => {
            // A request arriving during a pass may include edits made after its scan.
            batch.merge_target(request.target.clone());
            batch.debounce_required = false;
            batch.responders.push(request);
            true
        }
    }
}

async fn collect_trailing_requests(
    receiver: &mut mpsc::UnboundedReceiver<QueuedSyncRequest>,
    batch: &mut PendingSyncBatch,
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
) {
    let mut start_immediately = false;
    while let Ok(request) = receiver.try_recv() {
        start_immediately |= merge_request_after_pass(
            batch,
            request.take(),
            completed_full_account,
            completed_notebooks,
        );
    }
    if start_immediately || !batch.debounce_required {
        return;
    }
    let max_deadline = Instant::now() + AUTO_SYNC_MAX_WAIT;
    let mut quiet_deadline = Instant::now() + AUTO_SYNC_DEBOUNCE;
    loop {
        let deadline = quiet_deadline.min(max_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let request = request.take();
                let resets_debounce = matches!(
                    request,
                    SyncCoordinatorRequest::Automatic {
                        generation_changed: true,
                        ..
                    }
                );
                let start_immediately = merge_request_after_pass(
                    batch,
                    request,
                    completed_full_account,
                    completed_notebooks,
                );
                if start_immediately {
                    break;
                }
                if resets_debounce {
                    quiet_deadline = (Instant::now() + AUTO_SYNC_DEBOUNCE).min(max_deadline);
                }
            }
        }
    }
    batch.debounce_required = false;
}

fn finish_responders(
    responders: Vec<ManualSyncRequest>,
    result: Result<CloudSyncResult, String>,
    completed: &HashSet<String>,
) {
    let epoch = *NOTEBOOK_SELECTION.borrow();
    for request in responders {
        let own_result = match &result {
            Ok(_)
                if request.selection_epoch != epoch
                    || !activity_covers(false, completed, &request.target) =>
            {
                Err("笔记本已切换，原同步已停止。".to_string())
            }
            _ => result.clone(),
        };
        let _ = request.responder.send(own_result);
    }
}

async fn run_sync_activity(
    app: &AppHandle,
    receiver: &mut mpsc::UnboundedReceiver<QueuedSyncRequest>,
    mut batch: PendingSyncBatch,
) -> Result<CloudSyncResult, String> {
    let mut activity = SyncActivity::new();
    let mut completed_full_account = false;
    let mut completed_notebooks = HashSet::new();

    loop {
        let Some(requested_target) = batch.target.take() else {
            let result = activity.result.clone();
            finish_responders(batch.responders, Ok(result.clone()), &completed_notebooks);
            return Ok(result);
        };
        let state = app.state::<AppState>();
        // Snapshot selection and its cancellation receiver under the same lock
        // used by notebook switching, so they cannot describe different epochs.
        let (current, mut selection_changes) = {
            let _transition = state.notebook_transition.lock();
            let current = current_notebook_id(state.inner());
            let mut changes = NOTEBOOK_SELECTION.subscribe();
            let _ = *changes.borrow_and_update();
            (current, changes)
        };
        let Some(target) = current_target(requested_target, current) else {
            let error = "只能同步当前打开的笔记本。".to_string();
            finish_responders(
                std::mem::take(&mut batch.responders),
                Err(error.clone()),
                &HashSet::new(),
            );
            return Err(error);
        };
        if let Err(error) = state.cloud_sync.require_remote_access() {
            return Err(fail_sync_activity(
                app,
                &activity,
                &mut batch,
                &target,
                cloud_error(error),
            ));
        }

        let enabled = match enabled_notebooks_for_target(state.inner(), &target) {
            Ok(enabled) => enabled,
            Err(error) => {
                return Err(fail_sync_activity(
                    app, &activity, &mut batch, &target, error,
                ));
            }
        };
        let mut notebook_ids: Vec<String> = enabled
            .iter()
            .map(|notebook| notebook.notebook_id.clone())
            .collect();
        let pending_metadata = match state.cloud_sync.pending_notebook_changes() {
            Ok(changes) => changes,
            Err(error) => {
                return Err(fail_sync_activity(
                    app,
                    &activity,
                    &mut batch,
                    &target,
                    sync_error(error),
                ));
            }
        };
        notebook_ids.extend(
            pending_metadata
                .into_iter()
                .filter(|change| {
                    change.action == PendingNotebookAction::Delete
                        && target
                            .notebook_scope()
                            .is_none_or(|scope| change.notebook_id == scope)
                })
                .map(|change| change.notebook_id),
        );
        notebook_ids.sort();
        notebook_ids.dedup();
        activity.notebooks.extend(notebook_ids.iter().cloned());
        activity.result.notebooks = activity.notebooks.len();
        emit_activity_status(
            app,
            &activity,
            notebook_ids.clone(),
            "checking",
            "path",
            None,
        );

        let (progress_tx, progress_rx) = watch::channel(());
        let network_progress = progress_tx.clone();
        let path_report = match timeout_without_progress(
            progress_rx,
            async {
                let on_transfer = |notebook_id: &str, direction: Option<&str>| {
                    emit_activity_status(
                        app,
                        &activity,
                        [notebook_id.to_string()],
                        "syncing",
                        direction.unwrap_or("transfer-idle"),
                        None,
                    );
                };
                let on_progress = |notebook_id: &str, completed: usize, total: usize| {
                    progress_tx.send_replace(());
                    let mut status = CloudSyncStatus::new(
                        notebook_id,
                        &activity.run_id,
                        "syncing",
                        "actions",
                        activity.started_at,
                    );
                    status.progress_completed = Some(completed);
                    status.progress_total = Some(total);
                    status.engine = Some("path".to_string());
                    emit_sync_status(app, &status);
                };
                let pass = super::path_sync_runner::run_passes(
                    state.inner(),
                    app,
                    &notebook_ids,
                    true,
                    &on_transfer,
                    &on_progress,
                );
                let measured_pass = flowix_sync::telemetry::observe_sync_with_progress(
                    pass,
                    std::sync::Arc::new(move || {
                        network_progress.send_replace(());
                    }),
                    |metrics| {
                        crate::runtime_log::record_event(
                            "info",
                            "cloud.sync.network",
                            format!(
                                "run={} notebook_count={} metrics={metrics}",
                                activity.run_id,
                                notebook_ids.len()
                            ),
                        );
                    },
                );
                match run_until_selection_changed(&mut selection_changes, measured_pass).await {
                    Some(result)
                        if !selection_changes.has_changed().unwrap_or(true)
                            && current_notebook_id(state.inner()).as_deref()
                                == target.notebook_scope() =>
                    {
                        result
                    }
                    _ => Err("笔记本已切换，原同步已停止。".to_string()),
                }
            },
            CLOUD_SYNC_IDLE_TIMEOUT,
        )
        .await
        {
            Ok(Ok(report)) => report,
            Ok(Err(error)) => {
                return Err(fail_sync_activity(
                    app, &activity, &mut batch, &target, error,
                ));
            }
            Err(_) => {
                return Err(fail_sync_activity(
                    app,
                    &activity,
                    &mut batch,
                    &target,
                    "CLOUD_SYNC_TIMEOUT: path sync made no progress for 5 minutes".to_string(),
                ));
            }
        };
        activity.result = CloudSyncResult {
            notebooks: path_report.notebooks,
            uploaded: path_report.uploaded,
            downloaded: path_report.downloaded,
            deleted: path_report.deleted,
        };
        if !path_report.errors.is_empty() {
            return Err(fail_sync_activity(
                app,
                &activity,
                &mut batch,
                &target,
                path_report.errors.join("\n"),
            ));
        }
        match &target {
            SyncTarget::FullAccount => completed_full_account = true,
            SyncTarget::Notebook(notebook_id) => {
                completed_notebooks.insert(notebook_id.clone());
            }
        }

        // Manual callers whose pass has completed need not wait for later edits.
        finish_responders(
            std::mem::take(&mut batch.responders),
            Ok(activity.result.clone()),
            &completed_notebooks,
        );
        collect_trailing_requests(
            receiver,
            &mut batch,
            completed_full_account,
            &completed_notebooks,
        )
        .await;
        if batch.target.is_none() {
            emit_activity_status(
                app,
                &activity,
                activity.notebooks.clone(),
                "success",
                "complete",
                None,
            );
            let result = activity.result.clone();
            finish_responders(batch.responders, Ok(result.clone()), &completed_notebooks);
            return Ok(result);
        }
    }
}

fn automatic_check_due(elapsed: Option<Duration>, last_failed: bool) -> bool {
    let interval = if last_failed {
        FAILED_SYNC_RETRY_INTERVAL
    } else {
        CLOUD_POLL_INTERVAL
    };
    elapsed.is_none_or(|duration| duration >= interval)
}

async fn run_sync_coordinator(
    app: AppHandle,
    mut receiver: mpsc::UnboundedReceiver<QueuedSyncRequest>,
) {
    let mut last_attempt_at: Option<Instant> = None;
    let mut last_attempt_failed = false;
    while let Some(first_request) = receiver.recv().await {
        let first_request = first_request.take();
        let poll_due = automatic_check_due(
            last_attempt_at.map(|last| last.elapsed()),
            last_attempt_failed,
        );
        // A timer from an earlier failure may arrive after another attempt.
        // Do not let stale retries bypass the same backoff as polling.
        if matches!(first_request, SyncCoordinatorRequest::Retry(_)) && !poll_due {
            continue;
        }
        let mut batch = PendingSyncBatch::default();
        merge_waiting_request(&mut batch, first_request, poll_due);
        if batch.target.is_none() {
            continue;
        }
        collect_debounced_requests(&mut receiver, &mut batch, poll_due).await;
        if batch.target.is_none() {
            continue;
        }
        last_attempt_failed = match run_sync_activity(&app, &mut receiver, batch).await {
            Ok(_) => false,
            Err(error) => {
                tracing::warn!("cloud sync activity failed: {error}");
                true
            }
        };
        last_attempt_at = Some(Instant::now());
    }
}

/// Debounce editor/watcher bursts and run synchronization off the write path.
pub(crate) fn schedule_notebook_sync(app: AppHandle, notebook_id: String) {
    schedule_notebook_sync_observation(app, notebook_id, true);
}

pub(crate) fn schedule_notebook_sync_observation(
    app: AppHandle,
    notebook_id: String,
    generation_changed: bool,
) {
    if !automatic_sync_available(&app, &notebook_id) {
        return;
    }
    if let Err(error) = send_sync_request(
        &app,
        SyncCoordinatorRequest::Automatic {
            target: SyncTarget::Notebook(notebook_id.clone()),
            generation_changed,
        },
    ) {
        tracing::warn!("failed to schedule cloud sync for {notebook_id}: {error}");
    }
}

fn schedule_retry_after_failure(app: &AppHandle, target: SyncTarget) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FAILED_SYNC_RETRY_INTERVAL).await;
        if automatic_sync_target_available(&app, &target) {
            if let Err(error) =
                send_sync_request(&app, SyncCoordinatorRequest::Retry(target.clone()))
            {
                tracing::warn!(
                    "failed to schedule cloud retry for {}: {error}",
                    target.label()
                );
            }
        }
    });
}

// Recovery discovers remote identity once per authenticated session. Failures
// are retried by polling; an explicit local disabled row is never overwritten.
static NOTEBOOK_RECOVERY_RUNNING: AtomicBool = AtomicBool::new(false);
static NOTEBOOK_RECOVERY_COMPLETE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);
static NOTEBOOK_RECOVERY_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static NOTEBOOK_RECOVERY_COMPLETE_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

pub(crate) fn invalidate_notebook_recovery() {
    NOTEBOOK_RECOVERY_REVISION.fetch_add(1, Ordering::SeqCst);
}

pub(crate) fn schedule_cloud_notebook_recovery(app: AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return; };
    let manager = state.cloud_sync.clone();
    drop(state);
    if manager.remote_kind() != flowix_sync::remote::RemoteKind::OfficialCloud
        || !manager.cloud_sync_available()
    {
        return;
    }
    let generation = manager.account().session_generation();
    let revision = NOTEBOOK_RECOVERY_REVISION.load(Ordering::SeqCst);
    if NOTEBOOK_RECOVERY_COMPLETE.load(Ordering::SeqCst) == generation
        && NOTEBOOK_RECOVERY_COMPLETE_REVISION.load(Ordering::SeqCst) == revision
    {
        return;
    }
    if NOTEBOOK_RECOVERY_RUNNING.swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result: Result<bool, String> = async {
            let account = manager.account().state().map_err(|error| error.to_string())?;
            let user_id = account.account.filter(|_| account.authenticated)
                .ok_or_else(|| "cloud account unavailable".to_string())?.user.id;
            let remote = manager.remote_notebooks().await.map_err(|error| error.to_string())?;
            let remote_ids: HashSet<_> = remote.into_iter().map(|notebook| notebook.id).collect();
            let state = app.state::<AppState>();
            let _transition = state.notebook_transition.lock();
            let memo_file = read_lock(&state.memo_file, "memo_file");
            let configs = memo_file.read_notebook_configs().map_err(|error| error.to_string())?;
            let mut restored = false;
            for config in configs.into_iter().filter(|config| remote_ids.contains(&config.id) && Path::new(&config.path).is_dir()) {
                restored |= manager.restore_remote_notebook(
                    &PathNotebookMetadata { id: config.id, name: config.name, icon: config.icon, sort_order: config.sort },
                    &user_id,
                    generation,
                ).map_err(|error| error.to_string())?;
            }
            Ok(restored)
        }.await;
        match result {
            Ok(restored) => {
                NOTEBOOK_RECOVERY_COMPLETE.store(generation, Ordering::SeqCst);
                NOTEBOOK_RECOVERY_COMPLETE_REVISION.store(revision, Ordering::SeqCst);
                if restored {
                    if let Ok(state) = manager.account().state() {
                        let _ = app.emit("cloud-state-changed", state);
                    }
                }
                // An already-linked notebook also needs a pass after login;
                // it may contain edits made while the account was signed out.
                if let Some(id) = current_notebook_id(app.state::<AppState>().inner()) {
                    schedule_notebook_sync(app.clone(), id);
                }
            }
            Err(error) => tracing::warn!(%error, "notebook sync recovery will be retried"),
        }
        NOTEBOOK_RECOVERY_RUNNING.store(false, Ordering::SeqCst);
        // A session can change while discovery is in flight.
        if manager.account().session_generation() != generation
            || NOTEBOOK_RECOVERY_REVISION.load(Ordering::SeqCst) != revision {
            schedule_cloud_notebook_recovery(app);
        }
    });
}

/// Complete explicit notebook removals without synchronizing their contents.
/// A durable pending row is retried on later polls if this worker fails.
pub(crate) fn schedule_pending_notebook_deletions(app: AppHandle) {
    if !app.state::<AppState>().cloud_sync.cloud_sync_available()
        || DELETION_WORKER_RUNNING.swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = super::path_sync_runner::flush_deleted_notebook_manifests(
            app.state::<AppState>().inner(),
            &app,
        )
        .await;
        if let Err(error) = result {
            tracing::warn!(%error, "pending notebook deletion will be retried");
        }
        DELETION_WORKER_RUNNING.store(false, Ordering::SeqCst);
    });
}

pub(crate) fn start_cloud_sync_polling(app: AppHandle) {
    if POLLING_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            // Check once as soon as storage initialization finishes; later
            // checks use the regular interval.
            let should_poll = {
                let state = app.state::<AppState>();
                current_notebook_id(state.inner())
                    .is_some_and(|id| automatic_sync_available(&app, &id))
            };
            schedule_cloud_notebook_recovery(app.clone());
            schedule_pending_notebook_deletions(app.clone());
            if should_poll {
                if let Err(error) = send_sync_request(&app, SyncCoordinatorRequest::Poll) {
                    tracing::warn!("failed to request periodic cloud sync: {error}");
                }
            }
            tokio::time::sleep(CLOUD_POLL_INTERVAL).await;
        }
    });
}

pub(super) async fn sync_now(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    let state = app.state::<AppState>();
    state
        .cloud_sync
        .require_remote_access()
        .map_err(cloud_error)?;
    let (current, selection_epoch) = {
        let _transition = state.notebook_transition.lock();
        (
            current_notebook_id(state.inner()),
            *NOTEBOOK_SELECTION.borrow(),
        )
    };
    let current = current.ok_or_else(|| "请先打开需要同步的笔记本。".to_string())?;
    if notebook_id.as_deref().is_some_and(|id| id != current) {
        return Err("只能同步当前打开的笔记本。".to_string());
    }
    let target = SyncTarget::Notebook(current);
    let (responder, response) = oneshot::channel();
    send_sync_request(
        &app,
        SyncCoordinatorRequest::Manual(ManualSyncRequest {
            target,
            responder,
            selection_epoch,
        }),
    )?;
    match response.await {
        Ok(result) => result,
        Err(_) => Err("cloud sync coordinator stopped before completing the request".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_automatic_requests_are_coalesced_until_consumed() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let handle = SyncCoordinatorHandle {
            sender,
            pending: std::sync::Arc::new(std::sync::Mutex::new(HashSet::new())),
        };
        for _ in 0..1000 {
            handle
                .send(SyncCoordinatorRequest::Automatic {
                    target: SyncTarget::Notebook("nb".into()),
                    generation_changed: true,
                })
                .unwrap();
            handle.send(SyncCoordinatorRequest::Poll).unwrap();
        }
        assert_eq!(receiver.len(), 2);
        let _ = receiver.try_recv().unwrap().take();
        handle
            .send(SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb".into()),
                generation_changed: true,
            })
            .unwrap();
        assert_eq!(receiver.len(), 2);
    }

    #[tokio::test]
    async fn completed_manual_responders_do_not_wait_for_trailing_changes() {
        let (sender, receiver) = oneshot::channel();
        let request = ManualSyncRequest {
            target: SyncTarget::Notebook("nb".into()),
            responder: sender,
            selection_epoch: *NOTEBOOK_SELECTION.borrow(),
        };
        let result = CloudSyncResult {
            notebooks: 1,
            uploaded: 1,
            downloaded: 0,
            deleted: 0,
        };
        let mut batch = PendingSyncBatch::default();
        batch.target = Some(SyncTarget::Notebook("nb".into()));
        batch.responders.push(request);
        finish_responders(
            std::mem::take(&mut batch.responders),
            Ok(result),
            &HashSet::from(["nb".into()]),
        );
        assert!(receiver.await.unwrap().is_ok());
        assert!(batch.target.is_some());
    }

    #[tokio::test]
    async fn idle_timeout_extends_while_progress_continues() {
        let (progress, receiver) = watch::channel(());
        let work = async move {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_millis(40)).await;
                progress.send_replace(());
            }
            42
        };
        assert_eq!(
            timeout_without_progress(receiver, work, Duration::from_millis(120)).await,
            Ok(42)
        );
    }

    #[tokio::test]
    async fn idle_timeout_stops_stalled_work() {
        let (_progress, receiver) = watch::channel(());
        let stalled = std::future::pending::<()>();
        assert!(
            timeout_without_progress(receiver, stalled, Duration::from_millis(30))
                .await
                .is_err()
        );
    }

    #[test]
    fn sync_target_merge_keeps_one_scope_and_promotes_distinct_notebooks() {
        let mut target = SyncTarget::Notebook("nb_1".into());
        target.merge(SyncTarget::Notebook("nb_1".into()));
        assert_eq!(target, SyncTarget::Notebook("nb_1".into()));

        target.merge(SyncTarget::Notebook("nb_2".into()));
        assert_eq!(target, SyncTarget::FullAccount);

        target.merge(SyncTarget::Notebook("nb_3".into()));
        assert_eq!(target, SyncTarget::FullAccount);
    }

    #[test]
    fn failed_automatic_checks_back_off_without_delaying_manual_requests() {
        assert!(automatic_check_due(None, false));
        assert!(!automatic_check_due(Some(Duration::from_secs(9)), false));
        assert!(automatic_check_due(Some(Duration::from_secs(10)), false));
        assert!(!automatic_check_due(Some(Duration::from_secs(10)), true));
        assert!(automatic_check_due(Some(Duration::from_secs(30)), true));
        let mut batch = PendingSyncBatch::default();
        let (responder, _response) = oneshot::channel();
        assert!(merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
                selection_epoch: *NOTEBOOK_SELECTION.borrow(),
            }),
            false
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
    }

    #[test]
    fn every_sync_target_is_restricted_to_the_current_notebook() {
        assert_eq!(
            current_target(SyncTarget::FullAccount, Some("b".into())),
            Some(SyncTarget::Notebook("b".into()))
        );
        assert_eq!(
            current_target(SyncTarget::Notebook("a".into()), Some("a".into())),
            Some(SyncTarget::Notebook("a".into()))
        );
        assert_eq!(
            current_target(SyncTarget::Notebook("a".into()), Some("b".into())),
            None
        );
        assert_eq!(current_target(SyncTarget::FullAccount, None), None);
    }

    #[tokio::test]
    async fn a_manual_response_cannot_report_another_notebooks_success() {
        let (responder, response) = oneshot::channel();
        let request = ManualSyncRequest {
            target: SyncTarget::Notebook("notebook_a".into()),
            responder,
            selection_epoch: *NOTEBOOK_SELECTION.borrow(),
        };
        let result = CloudSyncResult {
            notebooks: 1,
            uploaded: 1,
            downloaded: 0,
            deleted: 0,
        };
        finish_responders(
            vec![request],
            Ok(result),
            &HashSet::from(["notebook_b".into()]),
        );
        assert!(response.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn a_changed_selection_wins_over_a_ready_pass() {
        let (sender, mut receiver) = watch::channel(0u64);
        let _ = *receiver.borrow_and_update();
        sender.send_modify(|value| *value += 1);
        let started = std::sync::atomic::AtomicBool::new(false);
        let result = run_until_selection_changed(&mut receiver, async {
            started.store(true, Ordering::SeqCst);
        })
        .await;
        assert!(result.is_none());
        assert!(!started.load(Ordering::SeqCst));
    }

    #[test]
    fn automatic_requests_debounce_and_manual_requests_start_immediately() {
        let mut batch = PendingSyncBatch::default();
        assert!(!merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: true,
            },
            true,
        ));
        assert!(batch.debounce_required);

        let (responder, _response) = oneshot::channel();
        assert!(merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
                selection_epoch: *NOTEBOOK_SELECTION.borrow(),
            }),
            true,
        ));
        assert!(!batch.debounce_required);
        assert_eq!(batch.responders.len(), 1);
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
    }

    #[test]
    fn new_dirty_generation_after_pass_requests_one_trailing_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: true,
            },
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
        assert!(batch.debounce_required);
    }

    #[test]
    fn repeated_generation_does_not_request_a_trailing_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: false,
            },
            false,
            &completed,
        ));
        assert!(batch.target.is_none());
        assert!(!batch.debounce_required);
    }

    #[test]
    fn persisted_generation_for_an_uncovered_notebook_still_wakes_the_worker() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_2".into()),
                generation_changed: false,
            },
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_2".into())));
    }

    #[test]
    fn manual_request_during_pass_schedules_a_fresh_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        let (responder, _response) = oneshot::channel();
        assert!(merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
                selection_epoch: *NOTEBOOK_SELECTION.borrow(),
            }),
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
        assert_eq!(batch.responders.len(), 1);
    }

    #[test]
    fn full_account_pass_covers_later_notebook_manual_request() {
        assert!(activity_covers(
            true,
            &HashSet::new(),
            &SyncTarget::Notebook("nb_1".into()),
        ));
    }

    #[test]
    fn cloud_sync_status_uses_camel_case_wire_format() {
        let mut status =
            CloudSyncStatus::new("nb_1", "run_1", "error", "failed", 1_700_000_000_000);
        status.finished_at = Some(1_700_000_000_100);
        status.last_error = Some("network unavailable".to_string());

        let value = serde_json::to_value(status).expect("serialize cloud sync status");
        assert_eq!(value["notebookId"], "nb_1");
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(value["finishedAt"], 1_700_000_000_100_i64);
        assert_eq!(value["lastError"], "network unavailable");
    }

    #[test]
    fn cloud_error_preserves_actionable_membership_code() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "MEMBERSHIP_REQUIRED".to_string(),
            message: "membership required".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 128,
                "quotaBytes": 0,
                "membershipExpiresAt": null,
            })),
        });

        assert!(message.starts_with("MEMBERSHIP_REQUIRED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("MEMBERSHIP_REQUIRED:")
                .expect("membership error prefix"),
        )
        .expect("membership error details");
        assert_eq!(details["usedBytes"], 128);
        assert_eq!(details["quotaBytes"], 0);
    }

    #[test]
    fn cloud_error_preserves_quota_details_for_the_ui() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "STORAGE_QUOTA_EXCEEDED".to_string(),
            message: "quota exceeded".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 52_428_800,
                "quotaBytes": 52_428_800,
                "requestedDeltaBytes": 1_024,
            })),
        });

        assert!(message.starts_with("STORAGE_QUOTA_EXCEEDED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("STORAGE_QUOTA_EXCEEDED:")
                .expect("quota error prefix"),
        )
        .expect("quota error details");
        assert_eq!(details["usedBytes"], 52_428_800);
        assert_eq!(details["quotaBytes"], 52_428_800);
        assert_eq!(details["requestedDeltaBytes"], 1_024);
    }
}
