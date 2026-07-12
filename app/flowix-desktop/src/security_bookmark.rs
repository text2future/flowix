//! macOS security-scoped bookmarks for user-selected directories.
//!
//! The app stores bookmark data separately from notebook / agent-access config
//! because both features can point at the same directory.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::user_config::{atomic_write_json, UserConfigError};

const BOOKMARKS_FILE_NAME: &str = "security-bookmarks.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkEntry {
    path: String,
    bookmark: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkConfig {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, BookmarkEntry>,
}

fn default_version() -> u32 {
    1
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(|c| c == '/' || c == '\\')
        .to_string()
}

pub struct SecurityBookmarkStore {
    config_dir: PathBuf,
    inner: RwLock<BookmarkConfig>,
    #[cfg(target_os = "macos")]
    active: RwLock<Vec<macos::ScopedAccess>>,
}

impl SecurityBookmarkStore {
    pub fn new(config_dir: PathBuf) -> Self {
        let config = read_from_disk(&config_dir)
            .ok()
            .flatten()
            .unwrap_or_default();
        let store = Self {
            config_dir,
            inner: RwLock::new(config),
            #[cfg(target_os = "macos")]
            active: RwLock::new(Vec::new()),
        };
        store.restore_all();
        store
    }

    pub fn record_directory(&self, path: &Path) -> Result<(), UserConfigError> {
        #[cfg(target_os = "macos")]
        {
            let bookmark = macos::bookmark_for_directory(path).ok_or_else(|| {
                UserConfigError::Io(io::Error::new(
                    io::ErrorKind::Other,
                    format!(
                        "failed to create security-scoped bookmark for {}",
                        path.display()
                    ),
                ))
            })?;
            self.record_directory_bookmark(path, bookmark)?;
        }
        #[cfg(not(target_os = "macos"))]
        let _ = path;
        Ok(())
    }

    pub fn record_directory_bookmark(
        &self,
        path: &Path,
        bookmark: String,
    ) -> Result<(), UserConfigError> {
        self.upsert(path, bookmark)?;
        self.start_accessing_path(path);
        Ok(())
    }

    pub fn restore_all(&self) {
        #[cfg(target_os = "macos")]
        {
            let entries: Vec<BookmarkEntry> = self
                .inner
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .entries
                .values()
                .cloned()
                .collect();
            let mut active = self.active.write().unwrap_or_else(|p| p.into_inner());
            active.clear();
            for entry in entries {
                match macos::resolve_bookmark(&entry.bookmark) {
                    Some(access) => active.push(access),
                    None => tracing::warn!(
                        "[security_bookmark] failed to resolve bookmark for {}",
                        entry.path
                    ),
                }
            }
        }
    }

    pub fn start_accessing_path(&self, path: &Path) {
        #[cfg(target_os = "macos")]
        {
            let key = normalize_path(path);
            let bookmark = {
                self.inner
                    .read()
                    .unwrap_or_else(|p| p.into_inner())
                    .entries
                    .get(&key)
                    .map(|entry| entry.bookmark.clone())
            };
            if let Some(bookmark) = bookmark {
                self.activate_bookmark(key, bookmark, path);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = path;
    }

    pub fn start_accessing_for_path(&self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some((key, bookmark)) = self.bookmark_for_containing_path(path) else {
                return false;
            };
            self.activate_bookmark(key, bookmark, path)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            false
        }
    }

    #[cfg(target_os = "macos")]
    fn activate_bookmark(&self, key: String, bookmark: String, requested_path: &Path) -> bool {
        if let Some(access) = macos::resolve_bookmark(&bookmark) {
            let mut active = self.active.write().unwrap_or_else(|p| p.into_inner());
            active.retain(|existing| existing.path_key() != key);
            active.push(access);
            return true;
        }
        tracing::warn!(
            "[security_bookmark] failed to activate bookmark for {} via {}",
            requested_path.display(),
            key
        );
        false
    }

    #[cfg(target_os = "macos")]
    fn bookmark_for_containing_path(&self, path: &Path) -> Option<(String, String)> {
        self.inner
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .iter()
            .filter(|(_, entry)| crate::path_scope::path_is_inside(path, Path::new(&entry.path)))
            .max_by_key(|(key, _)| key.len())
            .map(|(key, entry)| (key.clone(), entry.bookmark.clone()))
    }

    fn upsert(&self, path: &Path, bookmark: String) -> Result<(), UserConfigError> {
        let key = normalize_path(path);
        let mut next = self.inner.read().unwrap_or_else(|p| p.into_inner()).clone();
        next.entries.insert(
            key,
            BookmarkEntry {
                path: normalize_path(path),
                bookmark,
                updated_at: chrono::Utc::now().timestamp_millis(),
            },
        );
        let content = serde_json::to_string_pretty(&next)?;
        atomic_write_json(&self.config_dir.join(BOOKMARKS_FILE_NAME), &content)?;
        *self.inner.write().unwrap_or_else(|p| p.into_inner()) = next;
        Ok(())
    }
}

fn read_from_disk(config_dir: &Path) -> std::io::Result<Option<BookmarkConfig>> {
    let path = config_dir.join(BOOKMARKS_FILE_NAME);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&content).unwrap_or_default()))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::path::{Path, PathBuf};

    use base64::Engine;
    use objc2::rc::Retained;
    use objc2_foundation::{
        NSData, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
    };

    use super::normalize_path;

    pub struct ScopedAccess {
        url: Retained<NSURL>,
        path_key: String,
        active: bool,
    }

    impl ScopedAccess {
        pub fn path_key(&self) -> &str {
            &self.path_key
        }
    }

    impl Drop for ScopedAccess {
        fn drop(&mut self) {
            if self.active {
                unsafe { self.url.stopAccessingSecurityScopedResource() };
            }
        }
    }

    pub fn bookmark_for_directory(path: &Path) -> Option<String> {
        let url = NSURL::from_directory_path(path)?;
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::WithSecurityScope,
                None,
                None,
            )
            .map_err(|e| {
                tracing::warn!(
                    "[security_bookmark] failed to create bookmark for {}: {:?}",
                    path.display(),
                    e
                );
            })
            .ok()?;
        Some(base64::engine::general_purpose::STANDARD.encode(data.iter().collect::<Vec<_>>()))
    }

    pub fn resolve_bookmark(bookmark: &str) -> Option<ScopedAccess> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(bookmark)
            .ok()?;
        let data = NSData::with_bytes(&bytes);
        let mut stale = objc2::runtime::Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .map_err(|e| {
            tracing::warn!("[security_bookmark] failed to resolve bookmark: {:?}", e);
        })
        .ok()?;
        if stale.as_bool() {
            tracing::warn!("[security_bookmark] resolved stale bookmark");
        }
        let active = unsafe { url.startAccessingSecurityScopedResource() };
        let path = url.to_file_path().unwrap_or_else(PathBuf::new);
        Some(ScopedAccess {
            path_key: normalize_path(&path),
            url,
            active,
        })
    }
}

#[cfg(target_os = "macos")]
pub fn pick_directory_with_bookmark(title: &str) -> Option<(String, String)> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};

    let mtm = MainThreadMarker::new()?;
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    let title = objc2_foundation::NSString::from_str(title);
    panel.setTitle(Some(&title));
    let ok = panel.runModal();
    if ok != NSModalResponseOK {
        return None;
    }
    let url = panel.URL()?;
    let path = url.to_file_path()?;
    let bookmark = macos::bookmark_for_directory(&path)?;
    Some((path.to_string_lossy().to_string(), bookmark))
}
