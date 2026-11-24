//! UI status projection for a sync activity.

use chrono::Utc;
use tauri::AppHandle;

use super::super::{emit_sync_status, CloudSyncStatus};
use super::SyncActivity;

pub(super) fn emit_activity_status(
    app: &AppHandle,
    activity: &SyncActivity,
    notebook_ids: impl IntoIterator<Item = String>,
    state: &str,
    phase: &str,
    error: Option<&str>,
) {
    let finished_at = matches!(state, "success" | "error").then(|| Utc::now().timestamp_millis());
    for notebook_id in notebook_ids {
        let mut status = CloudSyncStatus::new(
            &notebook_id,
            &activity.run_id,
            state,
            phase,
            activity.started_at,
        );
        status.uploaded = activity.result.uploaded;
        status.deleted = activity.result.deleted;
        status.downloaded = activity.result.downloaded;
        status.finished_at = finished_at;
        status.last_error = error.map(str::to_owned);
        status.engine = Some("path".to_string());
        // Only this run's flags count: a summary carried over from an earlier
        // activity would claim a pass happened in this one.
        if let Some(summary) =
            super::super::path_sync_runner::summary_since(&notebook_id, activity.started_at)
        {
            status.writable = Some(summary.writable);
            status.allows_deletes = Some(summary.allows_deletes);
            status.deletion_deferred = Some(summary.deletion_deferred);
        }
        #[cfg(debug_assertions)]
        {
            let error_code = error
                .and_then(|value| value.split(|c: char| c == ':' || c.is_whitespace()).next())
                .filter(|value| value.starts_with("CLOUD_") || value.starts_with("OBJECT_"))
                .unwrap_or(if error.is_some() { "OTHER" } else { "NONE" });
            crate::runtime_log::record_event(
                "info", "cloud.sync.status",
                format!("notebook={} run={} state={} phase={} elapsed_ms={} uploaded={} downloaded={} deleted={} error_code={}",
                    status.notebook_id, status.run_id, state, phase,
                    Utc::now().timestamp_millis().saturating_sub(activity.started_at),
                    status.uploaded, status.downloaded, status.deleted, error_code),
            );
        }
        emit_sync_status(app, &status);
    }
}
