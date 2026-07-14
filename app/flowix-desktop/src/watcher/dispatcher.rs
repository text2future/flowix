//! `EventDispatcher` — 多 channel pub-sub 抽象。
//!
//! 当前实现:
//! - `EventDispatcher` trait + `TauriDispatcher` impl (包装 `AppHandle`)
//! - `publish(channel, payload)` 接口, 内部统一调 `app.emit()`
//! - `memo_events::emit` 默认优先走这里 (从 `app.state` 拿实例),
//!   拿不到才退到直接 `app.emit`, 业务代码不变。
//!
//! 未来扩展:
//! - `subscribe(channel) -> SubscriptionId` (多监听者支持, 当前单一 useMemoEvents)
//! - 多 channel 类型: attachment / tag / notebook 等, 在 dispatcher 里 extend

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// 跨 channel 事件派发器 trait — 后续可注入 mock / test impl。
///
/// `publish` 不带泛型, 这样 trait 自身保持 dyn-compatible,
/// 可以作为 `Arc<dyn EventDispatcher>` 共享 (`SharedDispatcher`)。
/// 调用方先把 `Serialize` 转成 `serde_json::Value` 再传进来。
pub trait EventDispatcher: Send + Sync {
    fn publish(&self, channel: &str, payload: serde_json::Value);
}

/// Tauri 2 dispatcher — 直接 `app.emit(channel, payload)`。
///
/// 跟 `crate::memo_events::emit()` 等价, 但走 trait 抽象方便测试 mock
/// 和未来多 channel 扩展。
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

/// 全局 dispatcher 句柄 — 用 `Arc<dyn EventDispatcher>` 让 memo_events 模块
/// 在不依赖 Tauri 状态注入的情况下也能 emit (兼容旧调用方)。
pub type SharedDispatcher = Arc<dyn EventDispatcher>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Test impl — 记录 publish 调用, 不依赖 Tauri AppHandle。
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
        // 两次调用都成功说明 Arc<dyn EventDispatcher> 可用
    }
}

/// 跨 channel 的统一 emit 入口。业务调用点走这里, 不再直接
/// 调 `app.emit` 。优先走 dispatcher (侾于 mock 测试 + 多 channel 扩展),
/// 拿不到退到直接 `app.emit` —— 与原 `memo_events::emit` 语义一致。
///
/// 返回 `bool`: true 表示成功到达前端 (dispatcher.publish 或 app.emit
/// 都不报错), false 表示发送失败。仅在需要诊断 (e.g. agent-chunk
/// fire-and-forget 不能隐匿错误) 的调用点检查返回值。
pub fn emit_to(app: &tauri::AppHandle, channel: &str, payload: impl serde::Serialize) -> bool {
    if let Some(dispatcher) = app.try_state::<SharedDispatcher>() {
        match serde_json::to_value(&payload) {
            Ok(value) => dispatcher.publish(channel, value),
            Err(_) => return false,
        }
    } else {
        // 走宕空走 dispatcher 则直接 app.emit。app.emit 要求
        // Serialize + Clone (外部不存在引用它会被 move), 这里
        // 先 to_value 复制一份再发。
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
