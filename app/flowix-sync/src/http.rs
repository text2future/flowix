//! A rebuildable HTTP client handle.
//!
//! reqwest snapshots the OS proxy configuration when a [`reqwest::Client`] is
//! built and never refreshes it afterwards (`Proxy::system()` →
//! `Matcher::from_system()`, a one-shot snapshot). A desktop app that stays
//! running across a VPN on/off toggle therefore keeps a client pinned to a
//! proxy port that no longer exists: every request fails at the connect stage
//! with "error sending request", while freshly built clients (curl, a restarted
//! app, a per-request client) connect fine.
//!
//! This handle carries the client's builder alongside the live client so the
//! app can rebuild it. Rebuilding re-reads the current system proxy state, so
//! the next attempt connects directly — or through the new proxy, whichever
//! the OS now advertises. The retry loops that use it live with their callers
//! ([`crate::client::CloudClient`] for the API control plane,
//! [`crate::object_store::transport`] for object storage), because a retry has
//! to rebuild the signed or authenticated request, not just the client.

use std::sync::{Arc, RwLock};

/// A [`reqwest::Client`] that can be rebuilt to re-read the OS proxy state.
#[derive(Clone)]
pub struct HttpClient {
    current: Arc<RwLock<reqwest::Client>>,
    build: Arc<dyn Fn() -> Result<reqwest::Client, reqwest::Error> + Send + Sync>,
}

impl HttpClient {
    /// Wraps a builder factory. The factory is called once now and again on
    /// every [`HttpClient::rebuild`]; it must produce an equivalent client
    /// each time (timeouts, TLS defaults), because only the proxy snapshot is
    /// meant to change between builds.
    ///
    /// If the factory fails on the first call, a default client is used as a
    /// stopgap until the first rebuild succeeds; a factory that cannot build
    /// at all (broken TLS backend) makes the whole app unusable regardless.
    pub fn new(
        build: impl Fn() -> Result<reqwest::Client, reqwest::Error> + Send + Sync + 'static,
    ) -> Self {
        let current = build().unwrap_or_default();
        Self {
            current: Arc::new(RwLock::new(current)),
            build: Arc::new(build),
        }
    }

    /// Wraps an already-built client: [`HttpClient::rebuild`] re-uses it
    /// as-is, so the handle never changes underneath. Intended for tests and
    /// for callers that manage their own client lifecycle.
    pub fn pinned(client: reqwest::Client) -> Self {
        Self::new(move || Ok(client.clone()))
    }

    /// A cheap handle to the live client (`reqwest::Client` clones are Arc
    /// clones). Request building goes through this snapshot; hold it only for
    /// the duration of building one request.
    pub fn get(&self) -> reqwest::Client {
        self.current
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Builds a fresh client (re-snapshotting the OS proxy state) and swaps it
    /// in. If the builder fails, the current client is kept: a stale snapshot
    /// is strictly better than no client at all.
    pub fn rebuild(&self) {
        if let Ok(fresh) = (self.build)() {
            *self
                .current
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = fresh;
        }
    }
}

/// True when a request failed before leaving this device — the signature of a
/// stale proxy snapshot: the connect stage refused or dropped us before any
/// bytes were on the wire, so retrying against a rebuilt client cannot
/// duplicate a request the server already saw.
///
/// Deliberately excludes timeouts: a request that timed out may have reached
/// the server, and rebuilding the client would not have helped it anyway.
pub(crate) fn is_stale_snapshot_error(error: &reqwest::Error) -> bool {
    error.is_connect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A listener that accepts connections and never answers, for pinning
    /// down timeout semantics.
    async fn silent_server() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // Hold the socket open without reading or writing, so the
                    // request hangs until the client's timeout fires.
                    let _held = socket;
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                });
            }
        });
        addr
    }

    #[tokio::test]
    async fn connect_refusal_counts_as_stale_snapshot() {
        // Nothing listens on port 1; connecting is refused immediately.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        let error = client
            .get("http://127.0.0.1:1/")
            .send()
            .await
            .expect_err("connect to dead port must fail");
        assert!(is_stale_snapshot_error(&error));
    }

    #[tokio::test]
    async fn timeouts_do_not_count_as_stale_snapshot() {
        let addr = silent_server().await;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(300))
            .build()
            .unwrap();
        let error = client
            .get(format!("http://{addr}/"))
            .send()
            .await
            .expect_err("silent server must time out");
        assert!(error.is_timeout());
        assert!(!is_stale_snapshot_error(&error));
    }

    #[tokio::test]
    async fn rebuild_swaps_in_a_fresh_client() {
        let builds = Arc::new(AtomicUsize::new(0));
        let builds_for_factory = Arc::clone(&builds);
        let http = HttpClient::new(move || {
            let generation = builds_for_factory.fetch_add(1, Ordering::SeqCst) + 1;
            if generation == 1 {
                // First snapshot pinned to a dead local proxy: exactly what a
                // client built while a VPN injected a system proxy looks like
                // after the VPN goes away.
                Ok(reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .proxy(reqwest::Proxy::http("http://127.0.0.1:1").unwrap())
                    .build()
                    .unwrap())
            } else {
                Ok(reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .build()
                    .unwrap())
            }
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buffer = vec![0u8; 512];
                    let _ = socket.read(&mut buffer).await;
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                        )
                        .await;
                });
            }
        });

        let stale = http.get().get(format!("http://{addr}/")).send().await;
        assert!(
            stale.is_err() && is_stale_snapshot_error(stale.as_ref().unwrap_err()),
            "the pinned proxy must fail at the connect stage: {stale:?}"
        );

        http.rebuild();

        let fresh = http.get().get(format!("http://{addr}/")).send().await;
        assert!(
            fresh
                .as_ref()
                .is_ok_and(|response| response.status().is_success()),
            "the rebuilt client must connect directly: {fresh:?}"
        );
        assert_eq!(builds.load(Ordering::SeqCst), 2, "exactly one rebuild");
    }
}
