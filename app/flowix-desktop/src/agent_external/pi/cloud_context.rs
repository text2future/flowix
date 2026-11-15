//! pi 运行时需要的账号态：`SyncManager` + 启动时选定的 API 基址。
//!
//! 这两个值住在 `AppState` 里，但运行时**不能**去 `app.state::<AppState>()`：
//! 那会让 `agent_external` 反向依赖壳的容器，架构检查里就是一条
//! `agent_external->app` 回边。改由 bootstrap 在 `SyncManager` 建好之后注入。
//!
//! 为什么是 `OnceLock` 而不是锁：`api_base` 是启动时选定的 Cloud 目标
//! （见 `AppState::cloud_environment`），运行期不变；而且 `PiRpcManager` 先于
//! `cloud_sync` 构造，只能在事后注入。
//!
//! 注入是幂等的：重复调用保留第一次的值，避免测试或多窗口路径把上下文换来换去。

use std::sync::Arc;

use super::runtime::PiRpcManager;

/// pi 的 Cloud 凭据路径需要的两个值。
pub struct PiCloudContext {
    sync: Arc<flowix_sync::SyncManager>,
    api_base: String,
}

impl PiCloudContext {
    pub fn new(sync: Arc<flowix_sync::SyncManager>, api_base: impl Into<String>) -> Self {
        Self {
            sync,
            api_base: api_base.into(),
        }
    }

    pub fn sync(&self) -> &Arc<flowix_sync::SyncManager> {
        &self.sync
    }

    pub fn api_base(&self) -> &str {
        &self.api_base
    }
}

impl PiRpcManager {
    /// 注入账号态，由 bootstrap 调用一次。
    pub fn install_cloud_context(&self, context: PiCloudContext) {
        let _ = self.cloud_context.set(context);
    }

    /// Cloud 专用路径用这个：没注入就是配置缺失，直接报错。
    pub(super) fn cloud_or_err(&self) -> Result<&PiCloudContext, String> {
        self.cloud_context
            .get()
            .ok_or_else(|| "Pi cloud context is not installed".to_string())
    }

    /// 普通对话路径用这个：没注入只当作「Cloud 不可用」，不能让本地模型跟着失败。
    pub(super) fn cloud_context_opt(&self) -> Option<&PiCloudContext> {
        self.cloud_context.get()
    }
}
