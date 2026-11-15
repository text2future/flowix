use super::transport::DshClient;
use std::sync::Arc;
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) async fn timed_host_request<C: DshClient + ?Sized>(
    host: &Arc<C>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    timed_host_request_with_timeout(host, request, PROBE_TIMEOUT).await
}

async fn timed_host_request_with_timeout<C: DshClient + ?Sized>(
    host: &Arc<C>,
    request: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    match tokio::time::timeout(timeout, host.request(request)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "DeepSeek Harness request timed out after {}s",
            timeout.as_secs()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::super::transport::{fake::FakeDshClient, DshClient};
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct PendingClient;
    #[async_trait::async_trait]
    impl DshClient for PendingClient {
        fn next_request_id(&self) -> u64 {
            1
        }
        fn is_closed(&self) -> bool {
            false
        }
        async fn request(&self, _value: serde_json::Value) -> Result<serde_json::Value, String> {
            std::future::pending().await
        }
        async fn subscribe(
            &self,
            _thread_id: &str,
            _run_id: &str,
        ) -> mpsc::UnboundedReceiver<serde_json::Value> {
            let (_tx, rx) = mpsc::unbounded_channel();
            rx
        }
        async fn unsubscribe(&self, _thread_id: &str, _run_id: &str) {}
        async fn shutdown(&self) {}
    }

    #[tokio::test]
    async fn transport_errors_are_preserved_by_probe_boundary() {
        let host = Arc::new(FakeDshClient::new(vec![Err("offline".into())]));
        assert_eq!(
            timed_host_request(&host, serde_json::Value::Null)
                .await
                .unwrap_err(),
            "offline"
        );
    }

    #[tokio::test]
    async fn stalled_transport_is_bounded_by_timeout() {
        let host = Arc::new(PendingClient);
        let error = timed_host_request_with_timeout(
            &host,
            serde_json::Value::Null,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert!(error.contains("timed out"));
    }
}
