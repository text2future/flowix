use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;

use super::{attachments, base64_input, upload_quota};
use crate::app::state::AppState;
use crate::lock_utils::read_lock;

const CHUNK_BYTES: usize = 256 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(600);
static REQUEST_QUOTA: upload_quota::UploadQuota = upload_quota::UploadQuota::new(4);

fn admit_request(
    upload_id: &str,
    content: Option<&str>,
) -> Result<upload_quota::UploadPermit<'static>, String> {
    if uuid::Uuid::parse_str(upload_id).is_err()
        || content.is_some_and(|content| {
            content.is_empty() || content.len() > CHUNK_BYTES.div_ceil(3) * 4
        })
    {
        return Err("Invalid upload request".into());
    }
    REQUEST_QUOTA.acquire()
}

struct Upload {
    owner: String,
    note_path: Option<String>,
    notebook_id: String,
    name: String,
    expected: u64,
    received: u64,
    created: Instant,
    file: File,
    _permit: upload_quota::UploadPermit<'static>,
}

#[derive(Default)]
pub(crate) struct UploadSessions {
    uploads: Mutex<HashMap<String, Upload>>,
    generations: Mutex<HashMap<String, u64>>,
}

impl UploadSessions {
    fn generation(&self, owner: &str) -> Result<u64, String> {
        Ok(*self
            .generations
            .lock()
            .map_err(|_| "Upload state unavailable")?
            .get(owner)
            .unwrap_or(&0))
    }

    fn begin(
        &self,
        owner: &str,
        generation: u64,
        note_path: Option<String>,
        notebook_id: String,
        name: String,
        size: u64,
    ) -> Result<String, String> {
        if size > base64_input::MAX_CONTENT_BYTES as u64 {
            return Err("ATTACHMENT_CONTENT_TOO_LARGE".into());
        }
        if name.is_empty()
            || name.len() > 1024
            || note_path.as_deref().is_some_and(|path| path.len() > 1024)
        {
            return Err("Invalid upload metadata".into());
        }
        let generations = self
            .generations
            .lock()
            .map_err(|_| "Upload state unavailable")?;
        if *generations.get(owner).unwrap_or(&0) != generation {
            return Err("Upload owner was closed".into());
        }
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload state unavailable")?;
        uploads.retain(|_, upload| upload.created.elapsed() < SESSION_TTL);
        let permit = upload_quota::UPLOAD_QUOTA.acquire()?;
        let id = uuid::Uuid::new_v4().to_string();
        let file = tempfile::tempfile().map_err(|error| error.to_string())?;
        uploads.insert(
            id.clone(),
            Upload {
                owner: owner.into(),
                note_path,
                notebook_id,
                name,
                expected: size,
                received: 0,
                created: Instant::now(),
                file,
                _permit: permit,
            },
        );
        Ok(id)
    }

    fn append(&self, owner: &str, id: &str, offset: u64, content: &str) -> Result<(), String> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload state unavailable")?;
        uploads.retain(|_, upload| upload.created.elapsed() < SESSION_TTL);
        let upload = uploads
            .get_mut(id)
            .filter(|upload| upload.owner == owner)
            .ok_or("Upload session not found")?;
        let result = (|| {
            if offset != upload.received || content.len() > CHUNK_BYTES.div_ceil(3) * 4 {
                return Err("Invalid upload chunk".to_string());
            }
            let mut bytes = Vec::with_capacity(CHUNK_BYTES);
            base64_input::reader(content)
                .map_err(|error| error.to_string())?
                .take((CHUNK_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.is_empty()
                || bytes.len() > CHUNK_BYTES
                || upload.received + bytes.len() as u64 > upload.expected
            {
                return Err("Invalid upload chunk size".to_string());
            }
            upload
                .file
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            upload.received += bytes.len() as u64;
            Ok(())
        })();
        if result.is_err() {
            uploads.remove(id);
        }
        result
    }

    fn take(&self, owner: &str, id: &str) -> Result<Upload, String> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload state unavailable")?;
        uploads.retain(|_, upload| upload.created.elapsed() < SESSION_TTL);
        if !uploads.get(id).is_some_and(|upload| upload.owner == owner) {
            return Err("Upload session not found".into());
        }
        let mut upload = uploads.remove(id).ok_or("Upload session not found")?;
        if upload.received != upload.expected {
            return Err("Upload is incomplete".into());
        }
        upload
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        Ok(upload)
    }

    fn cancel(&self, owner: &str, id: &str) -> Result<(), String> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload state unavailable")?;
        if uploads.get(id).is_some_and(|upload| upload.owner == owner) {
            uploads.remove(id);
        }
        Ok(())
    }

    pub(crate) fn revoke(&self, owner: &str) {
        let Ok(mut generations) = self.generations.lock() else {
            return;
        };
        let generation = generations.entry(owner.to_string()).or_default();
        *generation = generation.saturating_add(1);
        if let Ok(mut uploads) = self.uploads.lock() {
            uploads.retain(|_, upload| upload.owner != owner);
        }
    }

    pub(crate) fn start_cleanup(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(sessions) = weak.upgrade() else {
                    break;
                };
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(mut uploads) = sessions.uploads.lock() {
                        uploads.retain(|_, upload| upload.created.elapsed() < SESSION_TTL);
                    }
                })
                .await;
            }
        });
    }
}

#[tauri::command]
pub fn begin_attachment_upload(
    window: tauri::WebviewWindow,
    note_path: String,
    file_name: String,
    size: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let generation = state.upload_sessions.generation(window.label())?;
    let store = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, owner_note) =
        attachments::resolve_note_owner(&store, None, Some(&note_path))
            .map_err(|error| error.to_string())?;
    let root = attachments::notebook_root(&store, Some(&notebook_id))
        .map_err(|error| error.to_string())?;
    super::start_security_bookmark_access(&state, &root);
    state.upload_sessions.begin(
        window.label(),
        generation,
        owner_note,
        notebook_id,
        file_name,
        size,
    )
}

#[tauri::command]
pub async fn append_attachment_upload(
    window: tauri::WebviewWindow,
    upload_id: String,
    offset: u64,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let permit = admit_request(&upload_id, Some(&content))?;
    let sessions = state.upload_sessions.clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        sessions.append(&owner, &upload_id, offset, &content)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn finish_attachment_upload(
    window: tauri::WebviewWindow,
    upload_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let permit = admit_request(&upload_id, None)?;
    let sessions = state.upload_sessions.clone();
    let memo_file = state.memo_file.clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let _permit = permit;
        let mut upload = sessions.take(&owner, &upload_id)?;
        let store = read_lock(&memo_file, "memo_file");
        let path = attachments::save_for_owner(
            &store,
            Some(&upload.notebook_id),
            upload.note_path.as_deref(),
            &upload.name,
            &mut upload.file,
        )
        .map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_attachment_upload(
    window: tauri::WebviewWindow,
    upload_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.upload_sessions.cancel(window.label(), &upload_id)
}

#[cfg(test)]
mod tests;
