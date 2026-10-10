#[derive(Default, Debug, PartialEq, Eq)]
pub(crate) enum UpdatePhase {
    #[default]
    Idle,
    Downloading,
    Cancelled,
    Installing,
}

impl UpdatePhase {
    pub(crate) fn start(&mut self) -> bool {
        if *self != Self::Idle {
            return false;
        }
        *self = Self::Downloading;
        true
    }

    pub(crate) fn cancel(&mut self) -> bool {
        if !matches!(self, Self::Downloading | Self::Cancelled) {
            return false;
        }
        *self = Self::Cancelled;
        true
    }

    pub(crate) fn begin_install(&mut self) -> bool {
        if *self != Self::Downloading {
            return false;
        }
        *self = Self::Installing;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_rejects_cancel_and_duplicate_updates() {
        let mut phase = UpdatePhase::default();
        assert!(phase.start());
        assert!(phase.begin_install());
        assert!(!phase.cancel());
        assert!(!phase.start());
        assert_eq!(phase, UpdatePhase::Installing);
    }

    #[test]
    fn cancellation_wins_before_install_handoff() {
        let mut phase = UpdatePhase::default();
        assert!(phase.start());
        assert!(phase.cancel());
        assert!(!phase.begin_install());
        assert!(!phase.start());
    }

    #[test]
    fn idle_and_download_phases_reject_invalid_transitions() {
        let mut phase = UpdatePhase::default();
        assert!(!phase.cancel());
        assert!(!phase.begin_install());
        assert!(phase.start());
        assert!(!phase.start());
    }
}
