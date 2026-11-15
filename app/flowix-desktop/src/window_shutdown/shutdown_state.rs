use std::collections::HashSet;

pub(super) type WindowId = u64;

pub(super) enum ExitRequest<C> {
    AlreadyPending,
    Start { cancelled: Option<(u64, C)> },
}

/// A repeated user quit must remain deferred while the existing save pass runs.
/// A user quit may supersede updater preparation, but never an earlier user quit.
pub(super) fn prepare_user_exit<C>(
    waiting: &mut Option<(u64, HashSet<WindowId>, C)>,
    is_exit: impl FnOnce(&C) -> bool,
) -> ExitRequest<C> {
    if waiting
        .as_ref()
        .is_some_and(|(_, _, completion)| is_exit(completion))
    {
        return ExitRequest::AlreadyPending;
    }
    ExitRequest::Start {
        cancelled: waiting
            .take()
            .map(|(request, _, completion)| (request, completion)),
    }
}

/// Saving is mandatory for an installer, but only best effort for user exit.
pub(super) enum Report<C> {
    Pending,
    Complete(u64, C),
    Cancelled(u64),
}

/// Release a window after a successful save acknowledgement.
fn finish_window<C>(
    waiting: &mut Option<(u64, HashSet<WindowId>, C)>,
    window_id: WindowId,
) -> Option<(u64, C)> {
    if let Some((_, windows, _)) = waiting.as_mut() {
        windows.remove(&window_id);
    }
    if waiting
        .as_ref()
        .is_some_and(|(_, windows, _)| windows.is_empty())
    {
        waiting
            .take()
            .map(|(request, _, completion)| (request, completion))
    } else {
        None
    }
}

/// Destruction is acceptable for best-effort user exit, but it cannot satisfy
/// the installer's durable-save requirement.
pub(super) fn destroyed<C>(
    waiting: &mut Option<(u64, HashSet<WindowId>, C)>,
    window_id: WindowId,
    require_saved: bool,
) -> Report<C> {
    let Some((request, windows, _)) = waiting.as_ref() else {
        return Report::Pending;
    };
    if !windows.contains(&window_id) {
        return Report::Pending;
    }
    if require_saved {
        let request = *request;
        waiting.take();
        return Report::Cancelled(request);
    }
    match finish_window(waiting, window_id) {
        Some((request, completion)) => Report::Complete(request, completion),
        None => Report::Pending,
    }
}

pub(super) fn report<C>(
    waiting: &mut Option<(u64, HashSet<WindowId>, C)>,
    window_id: WindowId,
    ready: bool,
    require_saved: bool,
) -> Report<C> {
    let Some((request, windows, _)) = waiting.as_ref() else {
        return Report::Pending;
    };
    if !windows.contains(&window_id) {
        return Report::Pending;
    }
    if !ready && require_saved {
        let request = *request;
        waiting.take();
        return Report::Cancelled(request);
    }
    match finish_window(waiting, window_id) {
        Some((request, completion)) => Report::Complete(request, completion),
        None => Report::Pending,
    }
}

pub(super) fn expire<C>(
    waiting: &mut Option<(u64, HashSet<WindowId>, C)>,
    request: u64,
) -> Option<(u64, C)> {
    if waiting.as_ref().is_some_and(|(id, _, _)| *id == request) {
        waiting.take().map(|(id, _, completion)| (id, completion))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Option<(u64, HashSet<WindowId>, i32)> {
        Some((7, [11, 12].into(), 42))
    }

    #[test]
    fn acknowledgements_complete_only_after_last_window() {
        let mut waiting = pending();
        assert!(matches!(
            report(&mut waiting, 11, true, false),
            Report::Pending
        ));
        assert!(matches!(
            report(&mut waiting, 12, true, false),
            Report::Complete(7, 42)
        ));
        assert!(waiting.is_none());
        assert!(matches!(
            report(&mut waiting, 12, true, false),
            Report::Pending
        ));
    }

    #[test]
    fn destruction_completes_only_after_last_pending_window() {
        let mut waiting = pending();
        assert!(matches!(
            destroyed(&mut waiting, 99, false),
            Report::Pending
        ));
        assert!(matches!(
            destroyed(&mut waiting, 12, false),
            Report::Pending
        ));
        assert!(matches!(
            destroyed(&mut waiting, 12, false),
            Report::Pending
        ));
        assert!(matches!(
            destroyed(&mut waiting, 11, false),
            Report::Complete(7, 42)
        ));
    }

    #[test]
    fn cancellation_does_not_produce_completion() {
        let mut waiting: Option<(u64, HashSet<WindowId>, i32)> = None;
        assert!(matches!(
            destroyed(&mut waiting, 11, false),
            Report::Pending
        ));
    }
    #[test]
    fn failed_save_cannot_veto_user_exit() {
        let mut waiting = pending();
        assert!(matches!(
            report(&mut waiting, 11, false, false),
            Report::Pending
        ));
        assert!(matches!(
            report(&mut waiting, 12, false, false),
            Report::Complete(7, 42)
        ));
        assert!(waiting.is_none());
    }

    #[test]
    fn updater_still_requires_durable_documents() {
        let mut waiting = pending();
        assert!(matches!(
            report(&mut waiting, 11, false, true),
            Report::Cancelled(7)
        ));
        assert!(waiting.is_none());
    }

    #[test]
    fn destroyed_updater_participant_cancels_instead_of_approving_update() {
        let mut waiting = pending();
        assert!(matches!(
            destroyed(&mut waiting, 11, true),
            Report::Cancelled(7)
        ));
        assert!(waiting.is_none());
    }

    #[test]
    fn stale_timeout_cannot_end_new_request() {
        let mut waiting = pending();
        assert_eq!(expire(&mut waiting, 6), None);
        assert!(waiting.is_some());
        assert_eq!(expire(&mut waiting, 7), Some((7, 42)));
        assert_eq!(expire(&mut waiting, 7), None);
    }

    #[test]
    fn unregistered_report_cannot_cancel_update() {
        let mut waiting = pending();
        assert!(matches!(
            report(&mut waiting, 99, false, true),
            Report::Pending
        ));
        assert!(waiting.is_some());
    }

    #[test]
    fn repeated_user_exit_keeps_original_save_request_pending() {
        let mut waiting = Some((7, [11].into(), true));
        assert!(matches!(
            prepare_user_exit(&mut waiting, |is_exit| *is_exit),
            ExitRequest::AlreadyPending
        ));
        assert_eq!(waiting, Some((7, [11].into(), true)));
    }

    #[test]
    fn user_exit_supersedes_updater_request_without_losing_its_identity() {
        let mut waiting = Some((7, [11].into(), false));
        match prepare_user_exit(&mut waiting, |is_exit| *is_exit) {
            ExitRequest::Start { cancelled } => {
                assert_eq!(cancelled, Some((7, false)))
            }
            ExitRequest::AlreadyPending => panic!("updater request should be superseded"),
        }
        assert!(waiting.is_none());
    }
}
