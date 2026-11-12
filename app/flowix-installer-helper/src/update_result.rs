//! Shared app/installer protocol. Only the compatibility bridge uses old markers.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

const STATE: &str = "app-update-state.json";
const TARGET: &str = "app-update-target.txt";
const RESULT: &str = "app-update-result.txt";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Success,
    Failed,
}

#[derive(Debug, Serialize, Deserialize)]
struct Record {
    schema: u32,
    attempt_id: String,
    target_version: String,
    status: Status,
    message: Option<String>,
    #[serde(default)]
    legacy_client: bool,
}

#[derive(Debug)]
pub struct Outcome {
    pub status: String,
    pub message: Option<String>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn locked<T>(dir: &Path, action: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    fs::create_dir_all(dir)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("app-update-state.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    action() // Dropping the file releases the cross-process lock, including on error.
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| invalid("missing parent"))?)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn write(dir: &Path, record: &Record) -> io::Result<()> {
    atomic_write(&dir.join(STATE), &serde_json::to_vec(record)?)
}

fn read(dir: &Path) -> io::Result<Option<Record>> {
    match fs::read(dir.join(STATE)) {
        Ok(bytes) => {
            let record: Record = serde_json::from_slice(&bytes)?;
            if record.schema != 1
                || record.attempt_id.is_empty()
                || record.target_version.is_empty()
            {
                return Err(invalid("unsupported or invalid update state"));
            }
            Ok(Some(record))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn legacy(dir: &Path) -> io::Result<Option<Record>> {
    let version = match fs::read_to_string(dir.join(TARGET)) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        Ok(_) => return Err(invalid("empty legacy update target")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let result = match fs::read_to_string(dir.join(RESULT)) {
        Ok(v) => v,
        Err(e) if e.kind() == io::ErrorKind::NotFound => "pending|".into(),
        Err(e) => return Err(e),
    };
    let (status, message) = result
        .trim()
        .split_once('|')
        .ok_or_else(|| invalid("invalid legacy update result"))?;
    let status = match status {
        "pending" => Status::Pending,
        "success" => Status::Success,
        "failed" => Status::Failed,
        _ => return Err(invalid("invalid legacy update status")),
    };
    Ok(Some(Record {
        schema: 1,
        attempt_id: format!("legacy-{}", uuid::Uuid::new_v4()),
        target_version: version,
        status,
        message: (!message.is_empty()).then(|| message.into()),
        legacy_client: true,
    }))
}

fn remove_legacy(dir: &Path) {
    let _ = fs::remove_file(dir.join(TARGET));
    let _ = fs::remove_file(dir.join(RESULT));
}

fn read_or_legacy(dir: &Path) -> io::Result<Option<Record>> {
    match read(dir)? {
        // Older apps can consume their result or start another attempt without
        // knowing about JSON. Their markers remain authoritative during migration.
        Some(record) if record.legacy_client => {
            let markers = legacy(dir)?;
            if markers.is_none() {
                fs::remove_file(dir.join(STATE))?;
            }
            Ok(markers)
        }
        Some(record) => Ok(Some(record)),
        None => legacy(dir),
    }
}

pub fn begin(dir: &Path, version: &str, attempt_id: &str) -> io::Result<()> {
    if version.is_empty() || uuid::Uuid::parse_str(attempt_id).is_err() {
        return Err(invalid("invalid update identity"));
    }
    locked(dir, || {
        write(
            dir,
            &Record {
                schema: 1,
                attempt_id: attempt_id.into(),
                target_version: version.into(),
                status: Status::Pending,
                message: None,
                legacy_client: false,
            },
        )?;
        remove_legacy(dir);
        Ok(())
    })
}

/// Missing state is a manual install. A mismatched attempt must never change a newer update.
pub fn finish(
    dir: &Path,
    version: &str,
    attempt_id: Option<&str>,
    status: Status,
    message: &str,
) -> io::Result<()> {
    if status == Status::Pending {
        return Err(invalid("installer result must be terminal"));
    }
    locked(dir, || {
        let mut record = match read_or_legacy(dir)? {
            Some(record) => record,
            None if attempt_id.is_none() => return Ok(()),
            None => return Err(invalid("update state is missing")),
        };
        // An extraction failure can run NSIS's callback before preflight has
        // captured VERSION. Only an identified new-protocol attempt may report
        // an early failure this way; success must always match a version.
        let version_matches = record.target_version == version
            || (version.is_empty() && status == Status::Failed && attempt_id.is_some());
        if !version_matches
            || match attempt_id {
                Some(id) => id != record.attempt_id,
                None => !record.legacy_client,
            }
        {
            return Err(invalid("stale installer update identity"));
        }
        if record.status != Status::Pending && record.status != status {
            return Err(invalid("update result is already terminal"));
        }
        record.status = status;
        record.message = (!message.is_empty()).then(|| message.into());
        write(dir, &record)?;
        // Old apps still consume this file when the new installer fails. Remove this
        // bridge only after clients using the two-marker protocol are unsupported.
        if record.legacy_client {
            let status = if status == Status::Success {
                "success"
            } else {
                "failed"
            };
            atomic_write(
                &dir.join(RESULT),
                format!("{status}|{message}\n").as_bytes(),
            )?;
        }
        Ok(())
    })
}

pub fn consume(dir: &Path, current_version: &str) -> io::Result<Option<Outcome>> {
    locked(dir, || {
        let record = match read_or_legacy(dir)? {
            Some(v) => v,
            None => return Ok(None),
        };
        let success = record.status == Status::Success && record.target_version == current_version;
        let message = match record.status {
            Status::Success if success => None,
            Status::Success => Some(format!("Installer reported success for {}, but Flowix started as {current_version}.", record.target_version)),
            Status::Pending => Some(format!("Installer did not report a completed update to {}; Flowix started as {current_version}.", record.target_version)),
            Status::Failed => record.message,
        };
        match fs::remove_file(dir.join(STATE)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        remove_legacy(dir);
        Ok(Some(Outcome {
            status: if success { "success" } else { "failed" }.into(),
            message,
        }))
    })
}

pub fn clear(dir: &Path) -> io::Result<()> {
    locked(dir, || {
        match fs::remove_file(dir.join(STATE)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        remove_legacy(dir);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_consume_once() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        begin(dir.path(), "2.0", &id).unwrap();
        finish(dir.path(), "2.0", Some(&id), Status::Success, "").unwrap();
        assert_eq!(
            consume(dir.path(), "2.0").unwrap().unwrap().status,
            "success"
        );
        assert!(consume(dir.path(), "2.0").unwrap().is_none());
    }
    #[test]
    fn stale_callback_cannot_replace_newer_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        begin(dir.path(), "2.0", &first).unwrap();
        begin(dir.path(), "2.0", &second).unwrap();
        assert!(finish(dir.path(), "2.0", Some(&first), Status::Failed, "stale").is_err());
        assert_eq!(read(dir.path()).unwrap().unwrap().attempt_id, second);
    }
    #[test]
    fn unicode_errors_and_version_mismatch_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        begin(dir.path(), "2.0", &id).unwrap();
        finish(
            dir.path(),
            "2.0",
            Some(&id),
            Status::Failed,
            "文件被占用 | 重试\n下一行",
        )
        .unwrap();
        assert_eq!(
            consume(dir.path(), "1.0")
                .unwrap()
                .unwrap()
                .message
                .unwrap(),
            "文件被占用 | 重试\n下一行"
        );
        begin(dir.path(), "2.0", &id).unwrap();
        finish(dir.path(), "2.0", Some(&id), Status::Success, "").unwrap();
        assert_eq!(
            consume(dir.path(), "1.0").unwrap().unwrap().status,
            "failed"
        );
    }
    #[test]
    fn older_clients_receive_legacy_failure_and_new_clients_consume_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TARGET), "1.5.18").unwrap();
        finish(dir.path(), "1.5.18", None, Status::Failed, "locked").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(RESULT)).unwrap(),
            "failed|locked\n"
        );
        assert_eq!(
            consume(dir.path(), "1.5.16")
                .unwrap()
                .unwrap()
                .message
                .as_deref(),
            Some("locked")
        );
    }
    #[test]
    fn corrupt_state_is_not_deleted_or_hidden_by_legacy() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STATE), "broken").unwrap();
        assert!(consume(dir.path(), "2.0").is_err());
        assert!(dir.path().join(STATE).exists());
    }
    #[test]
    fn legacy_retry_can_advance_after_an_older_failure() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TARGET), "1.0").unwrap();
        finish(dir.path(), "1.0", None, Status::Failed, "old failure").unwrap();
        fs::write(dir.path().join(TARGET), "2.0").unwrap();
        fs::write(dir.path().join(RESULT), "pending|2.0").unwrap();
        finish(dir.path(), "2.0", None, Status::Success, "").unwrap();
        assert_eq!(
            consume(dir.path(), "2.0").unwrap().unwrap().status,
            "success"
        );
    }
    #[test]
    fn legacy_callback_cannot_override_a_new_protocol_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        begin(dir.path(), "2.0", &id).unwrap();
        fs::write(dir.path().join(TARGET), "2.0").unwrap();
        fs::write(dir.path().join(RESULT), "malformed stale marker").unwrap();
        assert!(finish(dir.path(), "2.0", None, Status::Failed, "old callback").is_err());
        finish(dir.path(), "2.0", Some(&id), Status::Success, "").unwrap();
        assert!(finish(
            dir.path(),
            "2.0",
            Some(&id),
            Status::Failed,
            "late callback"
        )
        .is_err());
        assert_eq!(
            consume(dir.path(), "2.0").unwrap().unwrap().status,
            "success"
        );
    }
    #[test]
    fn manual_install_clear_and_unfinished_install_are_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        begin(dir.path(), "2.0", &id).unwrap();
        assert_eq!(
            consume(dir.path(), "2.0").unwrap().unwrap().status,
            "failed"
        );
        begin(dir.path(), "2.0", &id).unwrap();
        clear(dir.path()).unwrap();
        assert!(consume(dir.path(), "2.0").unwrap().is_none());
    }
    #[test]
    fn early_failure_requires_an_exact_attempt_and_success_requires_version() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        begin(dir.path(), "2.0", &id).unwrap();
        assert!(finish(dir.path(), "", None, Status::Failed, "unidentified").is_err());
        assert!(finish(dir.path(), "", Some(&id), Status::Success, "").is_err());
        finish(
            dir.path(),
            "",
            Some(&id),
            Status::Failed,
            "early extraction failure",
        )
        .unwrap();
        assert_eq!(
            consume(dir.path(), "1.0")
                .unwrap()
                .unwrap()
                .message
                .as_deref(),
            Some("early extraction failure")
        );
    }
    #[test]
    fn legacy_result_already_consumed_by_old_app_is_not_reported_twice() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TARGET), "2.0").unwrap();
        finish(dir.path(), "2.0", None, Status::Failed, "already seen").unwrap();
        remove_legacy(dir.path());
        assert!(consume(dir.path(), "1.0").unwrap().is_none());
        assert!(!dir.path().join(STATE).exists());
    }
}
