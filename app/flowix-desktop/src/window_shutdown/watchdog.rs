//! Lock-free deadline enforcement. Callbacks must not depend on the UI/runtime.
use std::time::{Duration, Instant};

/// Total close/quit budget measured from native request receipt, not save start.
pub(super) const CLOSE_BUDGET: Duration = Duration::from_secs(1);

pub(super) fn arm(deadline: Instant, force: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
        force();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    #[test]
    fn expired_deadline_is_not_restarted_when_work_is_delayed() {
        let (sender, receiver) = mpsc::channel();
        arm(Instant::now() - Duration::from_secs(1), move || {
            let _ = sender.send(());
        });
        receiver.recv_timeout(Duration::from_millis(100)).unwrap();
    }
}
