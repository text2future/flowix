//! Mutable Windows state must not share the executable installation directory.
use std::path::{Path, PathBuf};

pub fn windows_state_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("FlowixData"))
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())
}

pub fn migrate_pi_sessions(local_data: &Path) -> Result<PathBuf, String> {
    let old = local_data.join("Flowix").join("pi-sessions");
    let new = local_data.join("FlowixData").join("pi-sessions");
    if old.exists() {
        if new.exists() {
            // Coexisting stores are resolved per conversation without merging.
            return Ok(new);
        }
        std::fs::create_dir_all(new.parent().unwrap()).map_err(|e| e.to_string())?;
        // Move only this known data directory. Never overwrite, merge or remove
        // installation files. Failure leaves the legacy data available.
        std::fs::rename(&old, &new).map_err(|e| {
            format!(
                "Cannot migrate Pi sessions from {} to {}: {e}",
                old.display(),
                new.display()
            )
        })?;
    }
    Ok(new)
}

/// Select existing history in place, without overwriting or hiding a conflict.
pub fn resolve_pi_session_candidates(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    let mut selected: Option<&PathBuf> = None;
    for candidate in candidates {
        if candidate.try_exists().map_err(|error| {
            format!(
                "cannot inspect Pi session directory {}: {error}",
                candidate.display()
            )
        })? {
            if let Some(previous) = selected {
                return Err(format!(
                    "Pi conversation has histories at both {} and {}; preserve both and resolve this conversation's conflict before continuing",
                    previous.display(), candidate.display()
                ));
            }
            selected = Some(candidate);
        }
    }
    selected
        .or_else(|| candidates.first())
        .cloned()
        .ok_or_else(|| "Pi session has no candidate directory".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "flowix-state-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn migrates_nested_sessions_once_without_touching_program_files() {
        let f = Fixture::new();
        let old = f.0.join("Flowix/pi-sessions/thread");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("history.jsonl"), b"saved conversation").unwrap();
        std::fs::write(f.0.join("Flowix/Flowix.exe"), b"program").unwrap();
        let new = migrate_pi_sessions(&f.0).unwrap();
        assert_eq!(
            std::fs::read(new.join("thread/history.jsonl")).unwrap(),
            b"saved conversation"
        );
        assert_eq!(migrate_pi_sessions(&f.0).unwrap(), new);
        assert_eq!(
            std::fs::read(f.0.join("Flowix/Flowix.exe")).unwrap(),
            b"program"
        );
    }
    #[test]
    fn never_overwrites_an_existing_session_store() {
        let f = Fixture::new();
        for base in ["Flowix", "FlowixData"] {
            let dir = f.0.join(base).join("pi-sessions");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session"), base).unwrap();
        }
        assert_eq!(
            migrate_pi_sessions(&f.0).unwrap(),
            f.0.join("FlowixData/pi-sessions")
        );
        assert_eq!(
            std::fs::read(f.0.join("Flowix/pi-sessions/session")).unwrap(),
            b"Flowix"
        );
        assert_eq!(
            std::fs::read(f.0.join("FlowixData/pi-sessions/session")).unwrap(),
            b"FlowixData"
        );
    }

    #[test]
    fn coexisting_stores_resolve_distinct_conversations_and_new_sessions() {
        let f = Fixture::new();
        let old_root = f.0.join("Flowix/pi-sessions");
        let new_root = f.0.join("FlowixData/pi-sessions");
        std::fs::create_dir_all(old_root.join("old-thread")).unwrap();
        std::fs::create_dir_all(new_root.join("new-thread")).unwrap();
        assert_eq!(migrate_pi_sessions(&f.0).unwrap(), new_root);
        assert_eq!(migrate_pi_sessions(&f.0).unwrap(), new_root);
        for (name, expected) in [
            ("old-thread", old_root.join("old-thread")),
            ("new-thread", new_root.join("new-thread")),
            ("fresh", new_root.join("fresh")),
        ] {
            assert_eq!(
                resolve_pi_session_candidates(&[new_root.join(name), old_root.join(name)]).unwrap(),
                expected
            );
        }
        assert!(!new_root.join("old-thread").exists());
        assert!(!new_root.join("fresh").exists());
    }

    #[test]
    fn duplicate_conversation_preserves_both_histories() {
        let f = Fixture::new();
        let candidates = [f.0.join("new/thread"), f.0.join("old/thread")];
        for (index, path) in candidates.iter().enumerate() {
            std::fs::create_dir_all(path).unwrap();
            std::fs::write(path.join("history.jsonl"), index.to_string()).unwrap();
        }
        assert!(resolve_pi_session_candidates(&candidates)
            .unwrap_err()
            .contains("both"));
        for (index, path) in candidates.iter().enumerate() {
            assert_eq!(
                std::fs::read_to_string(path.join("history.jsonl")).unwrap(),
                index.to_string()
            );
        }
    }

    #[test]
    fn legacy_hash_directory_remains_accessible_without_renaming() {
        let f = Fixture::new();
        let candidates = [
            f.0.join("FlowixData/pi-sessions/stable"),
            f.0.join("FlowixData/pi-sessions/legacy"),
            f.0.join("Flowix/pi-sessions/stable"),
            f.0.join("Flowix/pi-sessions/legacy"),
        ];
        std::fs::create_dir_all(&candidates[3]).unwrap();
        std::fs::write(candidates[3].join("history.jsonl"), b"legacy").unwrap();
        assert_eq!(
            resolve_pi_session_candidates(&candidates).unwrap(),
            candidates[3]
        );
        assert_eq!(
            std::fs::read(candidates[3].join("history.jsonl")).unwrap(),
            b"legacy"
        );
        assert!(!candidates[0].exists());
    }
}
