use std::collections::HashSet;

/// Release a ready or destroyed window and complete only after the last participant.
pub(crate) fn finish_window<C>(
    waiting: &mut Option<(u64, HashSet<String>, C)>,
    label: &str,
) -> Option<(u64, C)> {
    if let Some((_, windows, _)) = waiting.as_mut() {
        windows.remove(label);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Option<(u64, HashSet<String>, i32)> {
        Some((7, ["editor-a".into(), "editor-b".into()].into(), 42))
    }

    #[test]
    fn acknowledgements_complete_only_after_last_window() {
        let mut waiting = pending();
        assert_eq!(finish_window(&mut waiting, "editor-a"), None);
        assert_eq!(finish_window(&mut waiting, "editor-b"), Some((7, 42)));
        assert!(waiting.is_none());
        assert_eq!(finish_window(&mut waiting, "editor-b"), None);
    }

    #[test]
    fn destruction_completes_only_after_last_pending_window() {
        let mut waiting = pending();
        assert_eq!(finish_window(&mut waiting, "unregistered-window"), None);
        assert_eq!(finish_window(&mut waiting, "editor-b"), None);
        assert_eq!(finish_window(&mut waiting, "editor-b"), None);
        assert_eq!(finish_window(&mut waiting, "editor-a"), Some((7, 42)));
    }

    #[test]
    fn cancellation_does_not_produce_completion() {
        let mut waiting: Option<(u64, HashSet<String>, i32)> = None;
        assert_eq!(finish_window(&mut waiting, "editor-a"), None);
    }
}
