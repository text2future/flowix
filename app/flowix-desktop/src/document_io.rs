//! Bounded blocking I/O for document commands. Never hold an application lock
//! on the window event thread or across an await.
use std::sync::OnceLock;
use tokio::sync::Semaphore;

pub async fn run<T: Send + 'static>(
    operation: &'static str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    let started = std::time::Instant::now();
    let permit = SLOTS
        .get_or_init(|| Semaphore::new(4))
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    let queued_ms = started.elapsed().as_millis();
    let result = tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string());
    drop(permit);
    let total_ms = started.elapsed().as_millis();
    tracing::info!(target: "document_io", operation, queued_ms,
        total_ms, success = result.is_ok());
    // tracing does not reach app.log; mirror slow operations there so a user on
    // a slow machine can send one file instead of opening the devtools.
    if total_ms >= 40 {
        let payload = format!(
            "{{\"operation\":\"{operation}\",\"queuedMs\":{queued_ms},\"totalMs\":{total_ms},\"success\":{}}}",
            result.is_ok()
        );
        tauri::async_runtime::spawn_blocking(move || {
            crate::runtime_log::record_event("warn", "slow-document-io", payload);
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::run;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn bounds_blocking_writes_and_keeps_async_runtime_responsive() {
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for _ in 0..20 {
            let active = active.clone();
            let maximum = maximum.clone();
            jobs.push(tokio::spawn(run("test_slow_write", move || {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(count, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(20));
                active.fetch_sub(1, Ordering::SeqCst);
            })));
        }
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            tokio::time::sleep(std::time::Duration::from_millis(1)),
        )
        .await
        .unwrap();
        for job in jobs {
            job.await.unwrap().unwrap();
        }
        assert!(maximum.load(Ordering::SeqCst) <= 4);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}
