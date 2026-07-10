use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

pub fn read_lock<'a, T>(lock: &'a RwLock<T>, name: &str) -> RwLockReadGuard<'a, T> {
    lock.read().unwrap_or_else(|poisoned| {
        tracing::error!("{name} read lock poisoned, recovering");
        poisoned.into_inner()
    })
}

pub fn write_lock<'a, T>(lock: &'a RwLock<T>, name: &str) -> RwLockWriteGuard<'a, T> {
    lock.write().unwrap_or_else(|poisoned| {
        tracing::error!("{name} write lock poisoned, recovering");
        poisoned.into_inner()
    })
}
