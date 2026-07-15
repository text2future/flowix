//! Application-wide event dispatching.
//!
//! This module owns the shared pub-sub abstraction used by commands, agents,
//! search indexing, open-target handling, and watcher-originated memo events.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

/// Cross-channel event dispatcher trait.
///
/// `publish` avoids generics so the trait remains dyn-compatible and can be
/// shared as `Arc<dyn EventDispatcher>`.
pub trait EventDispatcher: Send + Sync {
    fn publish(&self, channel: &str, payload: serde_json::Value);
}

/// Tauri 2 dispatcher backed by `app.emit(channel, payload)`.
pub struct TauriDispatcher {
    app: AppHandle,
}

impl TauriDispatcher {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventDispatcher for TauriDispatcher {
    fn publish(&self, channel: &str, payload: serde_json::Value) {
        let _ = self.app.emit(channel, payload);
    }
}

/// Shared global dispatcher handle.
pub type SharedDispatcher = Arc<dyn EventDispatcher>;

/// Unified emit entry point. Prefer the managed dispatcher when available and
/// fall back to direct `app.emit` for compatibility with early setup paths.
pub fn emit_to(app: &tauri::AppHandle, channel: &str, payload: impl serde::Serialize) -> bool {
    if let Some(dispatcher) = app.try_state::<SharedDispatcher>() {
        match serde_json::to_value(&payload) {
            Ok(value) => dispatcher.publish(channel, value),
            Err(_) => return false,
        }
    } else {
        match serde_json::to_value(&payload) {
            Ok(value) => {
                if app.emit(channel, value).is_err() {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct TestDispatcher {
        log: Mutex<Vec<(String, String)>>,
    }

    impl EventDispatcher for TestDispatcher {
        fn publish(&self, channel: &str, payload: serde_json::Value) {
            let s = serde_json::to_string(&payload).unwrap();
            self.log.lock().unwrap().push((channel.to_string(), s));
        }
    }

    #[test]
    fn test_dispatcher_records_publish() {
        let d = TestDispatcher {
            log: Mutex::new(Vec::new()),
        };
        d.publish("test-channel", serde_json::json!({"k": "v"}));
        let log = d.log.lock().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].0, "test-channel");
        assert!(log[0].1.contains("\"k\":\"v\""));
    }

    #[test]
    fn shared_dispatcher_works_via_arc() {
        let d: SharedDispatcher = Arc::new(TestDispatcher {
            log: Mutex::new(Vec::new()),
        });
        d.publish("ch", serde_json::json!(42));
        d.publish("ch2", serde_json::json!("hello"));
    }
}
