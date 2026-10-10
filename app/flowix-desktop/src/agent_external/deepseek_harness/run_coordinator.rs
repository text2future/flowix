use crate::agent_wire::RunInfo;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

struct ActiveRun {
    started_at: i64,
    last_event_at: i64,
    run_id: String,
    session_id: String,
    stream_end_emitted: Arc<AtomicBool>,
    stopping: bool,
}

pub(crate) struct RunTarget {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) stream_end_emitted: Arc<AtomicBool>,
}

#[derive(Default)]
pub(crate) struct RunCoordinator {
    active: Mutex<HashMap<String, ActiveRun>>,
}

impl RunCoordinator {
    pub(crate) async fn register(
        &self,
        thread_id: &str,
        run_id: &str,
        session_id: Option<&str>,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut active = self.active.lock().await;
        if active.contains_key(thread_id) {
            return Err("DeepSeek Harness is already running for this thread".into());
        }
        let now = chrono::Utc::now().timestamp_millis();
        active.insert(
            thread_id.into(),
            ActiveRun {
                started_at: now,
                last_event_at: now,
                run_id: run_id.into(),
                session_id: session_id.unwrap_or_default().into(),
                stream_end_emitted,
                stopping: false,
            },
        );
        Ok(())
    }

    async fn update(&self, thread_id: &str, run_id: &str, update: impl FnOnce(&mut ActiveRun)) {
        if let Some(run) = self.active.lock().await.get_mut(thread_id) {
            if run.run_id == run_id {
                update(run);
            }
        }
    }

    pub(crate) async fn touch(&self, thread_id: &str, run_id: &str) {
        self.update(thread_id, run_id, |run| {
            run.last_event_at = chrono::Utc::now().timestamp_millis()
        })
        .await;
    }
    pub(crate) async fn bind_session(&self, thread_id: &str, run_id: &str, session_id: &str) {
        self.update(thread_id, run_id, |run| run.session_id = session_id.into())
            .await;
    }

    pub(crate) async fn mark_stopping(&self, thread_id: &str, run_id: &str) {
        self.update(thread_id, run_id, |run| run.stopping = true).await;
    }

    pub(crate) async fn target(
        &self,
        thread_id: &str,
        expected_run_id: Option<&str>,
    ) -> Option<RunTarget> {
        self.active.lock().await.get(thread_id).and_then(|run| {
            (expected_run_id.is_none() || expected_run_id == Some(run.run_id.as_str())).then(|| {
                RunTarget {
                    run_id: run.run_id.clone(),
                    session_id: run.session_id.clone(),
                    stream_end_emitted: run.stream_end_emitted.clone(),
                }
            })
        })
    }

    pub(crate) async fn remove_if_matches(&self, thread_id: &str, run_id: &str) -> bool {
        let mut active = self.active.lock().await;
        if active
            .get(thread_id)
            .is_some_and(|run| run.run_id == run_id)
        {
            active.remove(thread_id);
            true
        } else {
            false
        }
    }

    pub(crate) async fn running_threads(&self, agent_type: &str) -> HashMap<String, RunInfo> {
        self.active
            .lock()
            .await
            .iter()
            .map(|(thread_id, run)| {
                let mut info = RunInfo::active(
                        run.started_at,
                        Some("DeepSeek Harness"),
                        Some(agent_type),
                        Some(run.run_id.clone()),
                        Some(thread_id.clone()),
                        Some(run.session_id.clone()),
                    );
                if run.stopping { info.phase = Some("stopping".to_string()); }
                (thread_id.clone(), info)
            })
            .collect()
    }

    pub(crate) async fn stale_runs(&self, idle_timeout_ms: i64) -> Vec<(String, String)> {
        let now = chrono::Utc::now().timestamp_millis();
        self.active
            .lock()
            .await
            .iter()
            .filter(|(_, run)| now.saturating_sub(run.last_event_at) > idle_timeout_ms)
            .map(|(thread, run)| (thread.clone(), run.run_id.clone()))
            .collect()
    }
    pub(crate) async fn is_empty(&self) -> bool {
        self.active.lock().await.is_empty()
    }
    pub(crate) async fn clear(&self) -> usize {
        let mut active = self.active.lock().await;
        let count = active.len();
        active.clear();
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[tokio::test]
    async fn registration_is_atomic_per_thread() {
        let runs = RunCoordinator::default();
        let flag = Arc::new(AtomicBool::new(false));
        assert!(runs.register("t", "r1", None, flag.clone()).await.is_ok());
        assert!(runs.register("t", "r2", None, flag).await.is_err());
    }

    #[tokio::test]
    async fn removal_and_target_are_run_scoped() {
        let runs = RunCoordinator::default();
        runs.register("t", "r1", Some("s1"), Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert!(runs.target("t", Some("other")).await.is_none());
        assert!(!runs.remove_if_matches("t", "other").await);
        assert!(runs.remove_if_matches("t", "r1").await);
        assert!(runs.is_empty().await);
    }

    #[tokio::test]
    async fn delayed_cleanup_from_old_run_cannot_remove_new_run() {
        let runs = RunCoordinator::default();
        runs.register("t", "r1", None, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert!(runs.remove_if_matches("t", "r1").await);
        runs.register("t", "r2", None, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert!(!runs.remove_if_matches("t", "r1").await);
        assert_eq!(runs.target("t", None).await.unwrap().run_id, "r2");
    }

    #[tokio::test]
    async fn stale_run_updates_cannot_rebind_new_run() {
        let runs = RunCoordinator::default();
        runs.register("t", "r2", None, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        runs.bind_session("t", "r1", "wrong").await;
        let target = runs.target("t", None).await.unwrap();
        assert_eq!(target.session_id, "");
    }

    #[tokio::test]
    async fn stopping_remains_visible_until_native_turn_is_removed() {
        let runs = RunCoordinator::default();
        runs.register("t", "r1", Some("s1"), Arc::new(AtomicBool::new(false)))
            .await.unwrap();
        runs.mark_stopping("t", "r1").await;
        let snapshot = runs.running_threads("deepseek-harness").await;
        assert_eq!(snapshot["t"].phase.as_deref(), Some("stopping"));
        assert!(runs.register("t", "r2", None, Arc::new(AtomicBool::new(false))).await.is_err());
        assert!(runs.remove_if_matches("t", "r1").await);
    }
}
