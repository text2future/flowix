use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::agent_external::shared::{kill_child_tree, read_capped_line};

type Pending = oneshot::Sender<Result<Value, String>>;

type RouteKey = (String, String);

#[derive(Default)]
struct SubscriberRoutes {
    senders: HashMap<RouteKey, mpsc::UnboundedSender<Value>>,
}

impl SubscriberRoutes {
    fn insert(&mut self, thread_id: &str, run_id: &str, sender: mpsc::UnboundedSender<Value>) {
        self.senders
            .insert((thread_id.to_string(), run_id.to_string()), sender);
    }

    fn remove(&mut self, thread_id: &str, run_id: &str) {
        self.senders
            .remove(&(thread_id.to_string(), run_id.to_string()));
    }

    fn for_thread(&self, thread_id: &str) -> Vec<mpsc::UnboundedSender<Value>> {
        self.senders
            .iter()
            .filter(|((candidate, _), _)| candidate == thread_id)
            .map(|(_, sender)| sender.clone())
            .collect()
    }

    fn clear(&mut self) {
        self.senders.clear();
    }
}

/// A transport for the DSH App Server JSON-RPC/JSONL protocol.
///
/// It forwards dsh-appserver requests verbatim and routes server notifications
/// by their provider-owned thread id.
pub(crate) struct AppServerClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    routes: Arc<Mutex<SubscriberRoutes>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

#[async_trait::async_trait]
impl super::transport::DshClient for AppServerClient {
    fn next_request_id(&self) -> u64 {
        self.next_request_id()
    }
    fn is_closed(&self) -> bool {
        self.is_closed()
    }
    async fn request(&self, value: Value) -> Result<Value, String> {
        self.request(value).await
    }
    async fn subscribe(&self, thread_id: &str, run_id: &str) -> mpsc::UnboundedReceiver<Value> {
        self.subscribe(thread_id, run_id).await
    }
    async fn unsubscribe(&self, thread_id: &str, run_id: &str) {
        self.unsubscribe(thread_id, run_id).await
    }
    async fn shutdown(&self) {
        self.shutdown().await
    }
}

impl AppServerClient {
    pub(crate) async fn spawn(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Arc<Self>, String> {
        let mut process = Command::new(command);
        // DSH runs as a background stdio service and must not allocate a
        // visible console when Flowix starts it on Windows.
        crate::process_window::hide_command_window(&mut process);
        process
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = process
            .spawn()
            .map_err(|error| format!("start dsh-appserver: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("dsh-appserver stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("dsh-appserver stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("dsh-appserver stderr unavailable")?;
        let client = Arc::new(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            routes: Arc::new(Mutex::new(SubscriberRoutes::default())),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        Self::spawn_reader(client.clone(), BufReader::new(stdout));
        Self::spawn_stderr_reader(BufReader::new(stderr));
        Ok(client)
    }

    pub(crate) fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) async fn request(&self, value: Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("dsh-appserver is not running".into());
        }
        let id = value
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("App Server request has no numeric id")?;
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        tracing::info!(target: "dsh_appserver", request_id = id, method, "sending App Server request");
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let frame = format!("{value}\n");
        if let Err(error) = self.stdin.lock().await.write_all(frame.as_bytes()).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("write dsh-appserver request: {error}"));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(125), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("dsh-appserver response channel closed".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("dsh-appserver request timed out".into())
            }
        }
    }

    pub(crate) async fn subscribe(
        &self,
        thread_id: &str,
        run_id: &str,
    ) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.routes.lock().await.insert(thread_id, run_id, tx);
        rx
    }

    pub(crate) async fn unsubscribe(&self, thread_id: &str, run_id: &str) {
        self.routes.lock().await.remove(thread_id, run_id);
    }

    pub(crate) async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        kill_child_tree(&mut child, "dsh-appserver", "app-server").await;
    }

    fn spawn_reader(client: Arc<Self>, mut reader: BufReader<tokio::process::ChildStdout>) {
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                let bytes = match reader.read_line(&mut line).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        client
                            .fail_all(format!("dsh-appserver stdout failed: {error}"))
                            .await;
                        return;
                    }
                };
                if bytes == 0 {
                    client.fail_all("dsh-appserver exited".into()).await;
                    return;
                }
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let failed = message.get("error").is_some();
                    tracing::info!(target: "dsh_appserver", request_id = id, failed, "received App Server response");
                    if let Some(sender) = client.pending.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("App Server request failed")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                } else {
                    let method = message
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let thread_id = message.pointer("/params/threadId").and_then(Value::as_str);
                    tracing::info!(target: "dsh_appserver", method, thread_id = thread_id.unwrap_or("<none>"), "received App Server notification");
                    if let Some(thread_id) = thread_id {
                        // Direct App Server notifications do not carry a
                        // Flowix run id. Broadcast by DSH thread so a normal
                        // turn subscriber and a command-triggered turn
                        // subscriber can coexist. Each subscriber still has
                        // its own `(threadId, runId)` lifecycle and removes
                        // only itself when its turn completes.
                        let senders = client.routes.lock().await.for_thread(thread_id);
                        if senders.is_empty() {
                            tracing::warn!(target: "dsh_appserver", method, thread_id, "no subscriber for App Server notification");
                        } else {
                            for sender in senders {
                                let _ = sender.send(message.clone());
                            }
                        }
                    }
                }
            }
        });
    }

    fn spawn_stderr_reader(mut reader: BufReader<tokio::process::ChildStderr>) {
        tokio::spawn(async move {
            while let Ok(Some((line, _))) = read_capped_line(&mut reader, 16 * 1024).await {
                let line = line.trim();
                if !line.is_empty() {
                    tracing::info!(target: "dsh_appserver", "{}", crate::agent_external::truncate_for_log(line));
                }
            }
        });
    }

    async fn fail_all(&self, message: String) {
        self.closed.store(true, Ordering::Release);
        for (_, sender) in self.pending.lock().await.drain() {
            let _ = sender.send(Err(message.clone()));
        }
        self.routes.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscriptions_for_one_thread_are_broadcast_without_cross_thread_leaks() {
        let routes = Arc::new(Mutex::new(SubscriberRoutes::default()));
        let (first_tx, mut first_rx) = mpsc::unbounded_channel();
        let (second_tx, mut second_rx) = mpsc::unbounded_channel();
        let (other_tx, mut other_rx) = mpsc::unbounded_channel();
        {
            let mut routes = routes.lock().await;
            routes.insert("thread-1", "run-1", first_tx);
            routes.insert("thread-1", "run-2", second_tx);
            routes.insert("thread-2", "run-3", other_tx);
        }

        let message = serde_json::json!({"method": "turn/started"});
        for sender in routes.lock().await.for_thread("thread-1") {
            sender.send(message.clone()).unwrap();
        }

        assert_eq!(first_rx.recv().await, Some(message.clone()));
        assert_eq!(second_rx.recv().await, Some(message));
        assert!(other_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn unsubscribe_is_scoped_to_the_subscriber_run() {
        let mut routes = SubscriberRoutes::default();
        let (first_tx, _first_rx) = mpsc::unbounded_channel();
        let (second_tx, _second_rx) = mpsc::unbounded_channel();
        routes.insert("thread-1", "run-1", first_tx);
        routes.insert("thread-1", "run-2", second_tx);

        routes.remove("thread-1", "run-1");

        assert_eq!(routes.for_thread("thread-1").len(), 1);
    }
}
