//! 笔记本切换锁：全进程唯一。
//!
//! 「切笔记本」是一段不能被打断的复合动作 —— 迁移、索引失效、偏好落盘、watcher
//! 重绑——必须整段互斥。以前这把锁挂在 `AppState` 上，于是想拿它就必须先拿整个
//! `AppState`，而 `AppState` 是壳的装配容器。watcher 的 worker 线程为了这把锁，
//! 不得不反向依赖 `app::state`，这就是 `watcher → app` 回边的来源之一。
//!
//! 锁本身是进程级的：一个进程只有一个「当前笔记本」。所以它不需要被注入，
//! 也不该挂在任何一个容器的字段上。`AppState::notebook_transition` 保留字段
//! （调用点太多，且读起来就是「state 的手柄」），但它只是这个静态锁的零尺寸
//! 句柄，`.lock()` 的语义与之前完全一致。

use std::sync::{Mutex, MutexGuard};

static TRANSITION: Mutex<()> = Mutex::new(());

/// 阻塞直到拿到切换锁。中毒时继续用里面的 `()`，与仓库其它锁的处理一致：
/// 这把锁保护的是「序列化」，不是被保护的数据，中毒不改变正确性。
pub(crate) fn lock() -> MutexGuard<'static, ()> {
    TRANSITION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `AppState::notebook_transition` 的类型。零尺寸，可以随便复制。
#[derive(Clone, Copy, Debug, Default)]
pub struct NotebookTransition;

impl NotebookTransition {
    pub(crate) fn lock(&self) -> MutexGuard<'static, ()> {
        lock()
    }
}
