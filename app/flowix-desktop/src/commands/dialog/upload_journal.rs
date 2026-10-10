use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::app::state::AppState;
use crate::config::path_is_inside;
use crate::lock_utils::read_lock;

#[derive(Serialize, Deserialize)]
pub(crate) struct ImportRecord {
    path: String,
    /// Notebook-relative path of the note that owned this upload, when known.
    /// Older records stored a legacy `memo_id` instead; unknown fields from
    /// those records are ignored on read.
    #[serde(default)]
    note_path: Option<String>,
    sha256: String,
    bytes: u64,
    prepared_at: i64,
    confirmed: bool,
}

pub(super) struct Journal {
    path: PathBuf,
    root: PathBuf,
    record: ImportRecord,
}

pub(super) fn fingerprint(file: &mut File) -> io::Result<(String, u64)> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes += count as u64;
    }
    file.seek(SeekFrom::Start(0))?;
    Ok((format!("{:x}", hasher.finalize()), bytes))
}

fn journal_directory(root: &Path) -> io::Result<PathBuf> {
    let directory = root.join(".flowix/attachment-imports");
    if !path_is_inside(&directory, root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Recovery directory escapes notebook",
        ));
    }
    Ok(directory)
}

pub(super) fn prepare(
    root: &Path,
    target: &Path,
    note_path: Option<&str>,
    fingerprint: &(String, u64),
) -> io::Result<Journal> {
    let directory = journal_directory(root)?;
    fs::create_dir_all(&directory)?;
    let directory = dunce::canonicalize(directory)?;
    if !directory.starts_with(root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Recovery directory escapes notebook",
        ));
    }
    let relative = target.strip_prefix(root).map_err(io::Error::other)?;
    let record = ImportRecord {
        path: relative.to_string_lossy().into_owned(),
        note_path: note_path.map(str::to_owned),
        sha256: fingerprint.0.clone(),
        bytes: fingerprint.1,
        prepared_at: chrono::Utc::now().timestamp_millis(),
        confirmed: false,
    };
    let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
    flowix_core::memo_file::atomic_create_bytes(&path, &serde_json::to_vec(&record)?)?;
    Ok(Journal {
        path,
        root: root.to_path_buf(),
        record,
    })
}

impl Journal {
    pub(super) fn confirm(mut self) -> io::Result<()> {
        if !path_is_inside(&self.path, &self.root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Recovery record escapes notebook",
            ));
        }
        self.record.confirmed = true;
        flowix_core::memo_file::atomic_write_bytes(&self.path, &serde_json::to_vec(&self.record)?)
    }
}

#[derive(Serialize)]
pub(crate) struct ImportRecords {
    records: Vec<ImportRecord>,
    incomplete: bool,
}

fn list(root: &Path) -> io::Result<ImportRecords> {
    let directory = journal_directory(root)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ImportRecords {
                records: Vec::new(),
                incomplete: false,
            })
        }
        Err(error) => return Err(error),
    };
    let mut records = Vec::new();
    let mut incomplete = false;
    for (index, entry) in entries.enumerate() {
        if index >= 2000 {
            incomplete = true;
            break;
        }
        let read = || -> io::Result<ImportRecord> {
            let entry = entry?;
            if !entry.file_type()?.is_file() || !path_is_inside(&entry.path(), &directory) {
                return Err(io::Error::other("Invalid recovery entry"));
            }
            let mut bytes = Vec::new();
            File::open(entry.path())?
                .take(32 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 32 * 1024 {
                return Err(io::Error::other("Recovery entry too large"));
            }
            let record: ImportRecord = serde_json::from_slice(&bytes)?;
            let relative = Path::new(&record.path);
            if relative.is_absolute()
                || !path_is_inside(&root.join(relative), &root.join("attachments"))
            {
                return Err(io::Error::other("Invalid recovery target"));
            }
            Ok(record)
        };
        match read() {
            Ok(record) => records.push(record),
            Err(_) => incomplete = true,
        }
    }
    records.sort_by_key(|record| std::cmp::Reverse(record.prepared_at));
    if records.len() > 200 {
        incomplete = true;
        records.truncate(200);
    }
    Ok(ImportRecords {
        records,
        incomplete,
    })
}

#[tauri::command]
pub async fn list_attachment_import_records(
    notebook_id: String,
    state: State<'_, AppState>,
) -> Result<ImportRecords, String> {
    let root = super::attachments::notebook_root(
        &read_lock(&state.memo_file, "memo_file"),
        Some(&notebook_id),
    )
    .map_err(|error| error.to_string())?;
    super::start_security_bookmark_access(&state, &root);
    tokio::task::spawn_blocking(move || list(&root).map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_record_survives_without_confirmation() {
        let directory = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(directory.path()).unwrap();
        let journal = prepare(
            &root,
            &root.join("attachments/file"),
            Some("memo"),
            &("hash".into(), 3),
        )
        .unwrap();
        let pending = list(&root).unwrap();
        assert_eq!(pending.records.len(), 1);
        assert!(!pending.records[0].confirmed);
        journal.confirm().unwrap();
        let confirmed = list(&root).unwrap();
        assert!(confirmed.records[0].confirmed);
        assert_eq!(confirmed.records[0].note_path.as_deref(), Some("memo"));
    }

    #[test]
    fn corrupt_records_are_reported_as_incomplete() {
        let directory = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(directory.path()).unwrap();
        assert!(!list(&root).unwrap().incomplete);
        let journal = prepare(
            &root,
            &root.join("attachments/file"),
            None,
            &("hash".into(), 0),
        )
        .unwrap();
        fs::write(&journal.path, "invalid json").unwrap();
        let result = list(&root).unwrap();
        assert!(result.incomplete);
        assert!(result.records.is_empty());
    }

    #[test]
    fn fingerprint_preserves_stream_position_at_start() {
        use std::io::Write;
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"abc").unwrap();
        let (hash, bytes) = fingerprint(&mut file).unwrap();
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(bytes, 3);
        assert_eq!(file.stream_position().unwrap(), 0);
    }
}
