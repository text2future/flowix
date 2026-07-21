use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::{AgentManager, RunInfo};

pub(super) const STUCK_THRESHOLD: u32 = 5;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct CallKey {
    pub(super) tool_name: String,
    pub(super) args_hash: u64,
}

pub(super) struct InFlightChat {
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) started_at: i64,
    pub(super) run_id: String,
}

pub(super) fn compute_call_key(tool_name: &str, arguments: &str) -> CallKey {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    arguments.hash(&mut hasher);
    CallKey {
        tool_name: tool_name.to_string(),
        args_hash: hasher.finish(),
    }
}

impl AgentManager {
    /// 璁板綍鏈疆 (tool, args) 璋冪敤, 杩斿洖鏄惁杈惧埌鐔旀柇闃堝€笺€?    /// 璋冪敤娆℃暟 > STUCK_THRESHOLD 鏃惰繑鍥?true, 绗?6 娆″悓璋冪敤鍗宠Е鍙戙€?
    pub(super) async fn record_tool_call(
        &self,
        thread_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> bool {
        let key = compute_call_key(tool_name, arguments);
        let mut attempts = self.tool_call_attempts.write().await;
        let thread_attempts = attempts.entry(thread_id.to_string()).or_default();
        let count = thread_attempts.entry(key).or_insert(0);
        *count += 1;
        *count > STUCK_THRESHOLD
    }

    /// 娓呯┖璇?thread 鐨勭疮璁¤鏁般€備笅娆?chat_stream 鍏ュ彛浼氬厹搴曞啀璋冧竴娆?
    /// 杩欓噷涓昏缁?LLM 缁欐渶缁堝洖绛?鐨勬竻绌轰俊鍙蜂娇鐢ㄣ€?
    pub(super) async fn clear_tool_call_attempts(&self, thread_id: &str) {
        let mut attempts = self.tool_call_attempts.write().await;
        attempts.remove(thread_id);
    }

    /// 鍒犻櫎 thread 鏃舵竻鐞?AgentManager 鍐呬笌璇?thread 鍏宠仈鐨勬墍鏈?in-memory 鐘舵€併€?    /// 瑙ｅ喅 "thread_delete 璧?ThreadManager 浣嗕笉閫氱煡 AgentManager" 閫犳垚鐨?    /// read_snapshots / tool_call_attempts HashMap 闀挎湡娉勯湶銆?    /// 澶氭璋冪敤骞傜瓑, 涓嶅瓨鍦ㄧ殑 thread_id 闈欓粯 no-op銆?
    pub async fn cleanup_thread(&self, thread_id: &str) {
        let mut snapshots = self.read_snapshots.write().await;
        snapshots.remove(thread_id);
        let mut attempts = self.tool_call_attempts.write().await;
        attempts.remove(thread_id);
    }

    /// 鏌ヨ褰撳墠鎵€鏈?in-flight chat 鈹€鈹€ 渚涘墠绔?`agent_running_threads`
    /// IPC 璋冪敤銆傚墠绔惎鍔ㄦ椂璋冪敤涓€娆? seed 鍒?`threadStates[].isLoading`銆?    ///
    /// 杩斿洖鍊兼槧灏?`thread_id -> { started_at, current_tool }` 鈹€鈹€
    /// `current_tool` 鏆傛椂鏄?`None`, 鍥犱负 ReAct 寰幆鐨?`last_tool_name`
    /// 鏄嚱鏁板眬閮ㄥ彉閲? 涓嶅湪 manager state 閲屻€侾hase 1 涓嶉渶瑕? 绛?    /// UI 鐪熺敤涓婂啀琛ヤ竴涓?in-flight tool 闀滃儚銆?
    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let in_flight = self.in_flight.lock().await;
        in_flight
            .iter()
            .map(|(tid, run)| {
                (
                    tid.clone(),
                    RunInfo::active(
                        run.started_at,
                        None,
                        Some("flowix"),
                        Some(run.run_id.clone()),
                        Some(tid.clone()),
                        None,
                    ),
                )
            })
            .collect()
    }

    pub(super) async fn unregister_in_flight_if_current(
        &self,
        thread_id: &str,
        cancel: &Arc<AtomicBool>,
    ) {
        let mut in_flight = self.in_flight.lock().await;
        let is_current_run = in_flight
            .get(thread_id)
            .map(|run| Arc::ptr_eq(&run.cancel, cancel))
            .unwrap_or(false);
        if is_current_run {
            in_flight.remove(thread_id);
        }
    }

    pub async fn stop_chat(&self, thread_id: &str, _run_id: Option<&str>) -> bool {
        let in_flight = {
            let mut registry = self.in_flight.lock().await;
            registry.remove(thread_id)
        };
        match in_flight {
            Some(run) => {
                run.cancel.store(true, Ordering::Release);
                tracing::info!(
                    "[Agent] stop_chat signalled cancel for thread_id: {}",
                    thread_id
                );
                true
            }
            None => false,
        }
    }
}
