//! Identity and liveness belong to a native window instance, never its label.
use std::sync::{
    atomic::{AtomicU64, AtomicU8, Ordering},
    Arc,
};

const ALIVE: u8 = 0;
const DESTROYED: u8 = 1;
const FORCE_COMMITTED: u8 = 2;

pub(super) struct WindowLifetime {
    id: u64,
    state: AtomicU8,
}
impl WindowLifetime {
    pub(super) fn new() -> Arc<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Arc::new(Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            state: AtomicU8::new(ALIVE),
        })
    }
    pub(super) fn id(&self) -> u64 {
        self.id
    }
    pub(super) fn is_alive(&self) -> bool {
        self.state.load(Ordering::Acquire) == ALIVE
    }
    pub(super) fn destroyed(&self) {
        let _ = self
            .state
            .compare_exchange(ALIVE, DESTROYED, Ordering::AcqRel, Ordering::Acquire);
    }
    /// Destruction and forced termination race through one atomic transition.
    /// A stale callback cannot force after Destroyed wins, nor can a late task
    /// target a replacement window with the same label.
    pub(super) fn force_if_alive(&self, force: impl FnOnce()) {
        if self
            .state
            .compare_exchange(ALIVE, FORCE_COMMITTED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            force();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Barrier},
        time::Duration,
    };
    #[test]
    fn worker_resuming_after_destroy_cannot_force_a_replacement() {
        let old = WindowLifetime::new();
        let replacement = WindowLifetime::new();
        let paused = Arc::new(Barrier::new(2));
        let (sender, receiver) = mpsc::channel();
        let worker = old.clone();
        let gate = paused.clone();
        let thread = std::thread::spawn(move || {
            gate.wait();
            worker.force_if_alive(|| {
                sender.send(()).unwrap();
            });
        });
        // This is the old race: dispatch already captured its target, but
        // Destroyed is processed before dispatch registers/arms a close.
        old.destroyed();
        paused.wait();
        thread.join().unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(10)).is_err());
        assert_ne!(old.id(), replacement.id());
        assert!(replacement.is_alive());
    }
    #[test]
    fn every_duplicate_observes_the_same_destroyed_flag() {
        let first = WindowLifetime::new();
        let duplicate = first.clone();
        first.destroyed();
        duplicate.force_if_alive(|| panic!("late force callback ran"));
    }
    #[test]
    fn an_unclosed_window_still_requires_force() {
        let lifetime = WindowLifetime::new();
        let mut forced = false;
        lifetime.force_if_alive(|| forced = true);
        assert!(forced);
        assert!(!lifetime.is_alive());
    }
}
