//! Per-sync, in-memory network measurements. No paths, URLs or credentials are recorded.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Default, Serialize)]
struct Counts {
    requests: u64,
    errors: u64,
    cancelled: u64,
    elapsed_ms_sum: u64,
    elapsed_ms_max: u64,
}
#[derive(Default, Serialize)]
struct Measurements {
    operations: BTreeMap<String, Counts>,
    directory_markers: u64,
    directory_cache_hits: u64,
}
tokio::task_local! { static CURRENT: Arc<Mutex<Measurements>>; }
tokio::task_local! { static PROGRESS: Arc<dyn Fn() + Send + Sync>; }

/// Report successful network operations as activity for the caller's idle timer.
pub async fn observe_sync_with_progress<F: Future>(
    future: F,
    progress: Arc<dyn Fn() + Send + Sync>,
    report: impl FnOnce(String),
) -> F::Output {
    PROGRESS.scope(progress, observe_sync(future, report)).await
}

/// Runs one sync with a report that is also emitted if the future is cancelled.
pub async fn observe_sync<F: Future>(future: F, report: impl FnOnce(String)) -> F::Output {
    struct Reporter<R: FnOnce(String)> {
        data: Arc<Mutex<Measurements>>,
        report: Option<R>,
        start: Instant,
        completed: bool,
    }
    impl<R: FnOnce(String)> Drop for Reporter<R> {
        fn drop(&mut self) {
            let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            let payload = serde_json::json!({"elapsed_ms": self.start.elapsed().as_millis() as u64, "completed": self.completed, "network": &*data});
            if let Some(report) = self.report.take() {
                report(payload.to_string());
            }
        }
    }
    let data = Arc::new(Mutex::new(Measurements::default()));
    let mut reporter = Reporter {
        data: data.clone(),
        report: Some(report),
        start: Instant::now(),
        completed: false,
    };
    let output = CURRENT.scope(data, future).await;
    reporter.completed = true;
    output
}

pub(crate) fn progress_callback() -> Option<Arc<dyn Fn() + Send + Sync>> {
    PROGRESS.try_with(Arc::clone).ok()
}

pub(crate) fn category(key: &str) -> &'static str {
    let mut segments = key.split('/');
    if segments.next() == Some("nb") && segments.next().is_some() {
        match segments.next() {
            Some("m") => "manifest",
            Some("s") => "stamps",
            Some("d") => "directories",
            Some("f") => "files",
            _ => "other",
        }
    } else {
        "other"
    }
}

pub(crate) struct RequestMeasurement {
    data: Option<Arc<Mutex<Measurements>>>,
    key: String,
    started: Instant,
    result: Option<bool>,
    progress: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl RequestMeasurement {
    pub(crate) fn start(category: &str, operation: &str) -> Self {
        Self {
            data: CURRENT.try_with(Arc::clone).ok(),
            key: format!("{category}.{operation}"),
            started: Instant::now(),
            result: None,
            progress: PROGRESS.try_with(Arc::clone).ok(),
        }
    }
    pub(crate) fn finish(&mut self, success: bool) {
        self.result = Some(success);
        if success {
            if let Some(progress) = &self.progress {
                progress();
            }
        }
    }
}
impl Drop for RequestMeasurement {
    fn drop(&mut self) {
        if let Some(data) = &self.data {
            let mut data = data.lock().unwrap_or_else(|e| e.into_inner());
            let counts = data.operations.entry(self.key.clone()).or_default();
            let elapsed = self.started.elapsed().as_millis() as u64;
            counts.requests += 1;
            counts.elapsed_ms_sum += elapsed;
            counts.elapsed_ms_max = counts.elapsed_ms_max.max(elapsed);
            match self.result {
                Some(false) => counts.errors += 1,
                None => counts.cancelled += 1,
                _ => {}
            }
        }
    }
}
pub(crate) fn directory_cache(total: usize, hits: usize) {
    let _ = CURRENT.try_with(|data| {
        let mut data = data.lock().unwrap_or_else(|e| e.into_inner());
        data.directory_markers += total as u64;
        data.directory_cache_hits += hits as u64;
    });
}

pub(crate) async fn credential_request<T, E>(
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let mut measurement = RequestMeasurement::start("control", "credentials");
    let result = future.await;
    measurement.finish(result.is_ok());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn progress_reports_successful_requests_only() {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        observe_sync_with_progress(
            async {
                let mut success = RequestMeasurement::start("files", "put");
                success.finish(true);
                let mut failure = RequestMeasurement::start("files", "put");
                failure.finish(false);
                let _cancelled = RequestMeasurement::start("files", "get");
            },
            Arc::new(move || {
                observed.fetch_add(1, Ordering::Relaxed);
            }),
            |_| {},
        )
        .await;
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }
}

