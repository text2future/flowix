use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flowix_core::memo_file::{FileLockIntent, MemoFile};

use crate::config::path_is_inside;

pub(super) const MAX_ATTACHMENT_BYTES: u64 = 1024 * 1024 * 1024;

fn copy_bounded(reader: &mut impl Read, writer: &mut impl Write, limit: u64) -> io::Result<u64> {
    let copied = io::copy(&mut reader.take(limit.saturating_add(1)), writer)?;
    if copied > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ATTACHMENT_FILE_TOO_LARGE",
        ));
    }
    Ok(copied)
}

/// Resolve the owning notebook for an attachment. Ownership is expressed by
/// path: `note_path` may be an absolute path inside a registered notebook or
/// a notebook-relative path (which then requires `notebook_id`). Returns the
/// resolved notebook id plus the notebook-relative note path when known.
pub(super) fn resolve_note_owner(
    store: &MemoFile,
    notebook_id: Option<&str>,
    note_path: Option<&str>,
) -> io::Result<(String, Option<String>)> {
    let Some(note_path) = note_path.filter(|path| !path.trim().is_empty()) else {
        let id = notebook_id
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "explicit attachment owner required",
                )
            })?;
        notebook_root(store, Some(id))?;
        return Ok((id.to_string(), None));
    };
    let candidate = Path::new(note_path);
    if candidate.is_absolute() {
        let canonical_note = dunce::canonicalize(candidate).map_err(|error| {
            io::Error::new(io::ErrorKind::NotFound, format!("owner note not found: {error}"))
        })?;
        for notebook in store.read_notebook_configs()? {
            let Ok(root) = dunce::canonicalize(&notebook.path) else { continue };
            if let Ok(relative) = canonical_note.strip_prefix(&root) {
                if notebook_id.is_some_and(|id| id != notebook.id) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "attachment notebook does not match note",
                    ));
                }
                return Ok((
                    notebook.id,
                    Some(relative.to_string_lossy().replace('\\', "/")),
                ));
            }
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "owner note is outside every registered notebook",
        ));
    }
    let id = notebook_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "a notebook-relative owner note requires an explicit notebook",
            )
        })?;
    let root = notebook_root(store, Some(id))?;
    let note = root.join(note_path);
    if !note.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "attachment owner note not found",
        ));
    }
    Ok((id.to_string(), Some(note_path.replace('\\', "/"))))
}

pub(super) fn notebook_root(store: &MemoFile, notebook_id: Option<&str>) -> io::Result<PathBuf> {
    let notebooks = store.read_notebook_configs()?;
    let selected = store.current_notebook_id_value();
    let id = notebook_id.or(selected.as_deref());
    let notebook = notebooks
        .iter()
        .find(|notebook| match id {
            Some(id) => notebook.id == id,
            None => notebook.is_default,
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "attachment notebook is not registered",
            )
        })?;
    let root = dunce::canonicalize(&notebook.path)?;
    if !root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "notebook is not a directory",
        ));
    }
    Ok(root)
}

fn safe_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let sanitized: String = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches([' ', '.']);
    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if sanitized.is_empty() {
        "attachment".to_string()
    } else if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        format!("_{sanitized}")
    } else {
        sanitized.to_string()
    }
}

pub(super) fn save_for_owner(
    store: &MemoFile,
    notebook_id: Option<&str>,
    note_path: Option<&str>,
    name: &str,
    reader: &mut impl Read,
) -> io::Result<PathBuf> {
    let (notebook_id, owner_note) = resolve_note_owner(store, notebook_id, note_path)?;
    save_locked(store, Some(&notebook_id), owner_note.as_deref(), name, reader)
}

#[cfg(test)]
fn save(
    store: &MemoFile,
    notebook_id: Option<&str>,
    name: &str,
    reader: &mut impl Read,
) -> io::Result<PathBuf> {
    save_locked(store, notebook_id, None, name, reader)
}

fn save_locked(
    store: &MemoFile,
    notebook_id: Option<&str>,
    owner_note: Option<&str>,
    name: &str,
    reader: &mut impl Read,
) -> io::Result<PathBuf> {
    let root = notebook_root(store, notebook_id)?;
    let lock_id = store.read_notebook_configs()?.into_iter()
        .find(|notebook| dunce::canonicalize(&notebook.path).ok().as_deref() == Some(root.as_path()))
        .map(|notebook| notebook.id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "attachment notebook is not registered"))?;
    let directory = root.join("attachments");
    if !path_is_inside(&directory, &root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "attachment directory escapes notebook",
        ));
    }
    store.with_notebook_change(&[&lock_id], "create_attachment_directory", || fs::create_dir_all(&directory))?;
    let directory = dunce::canonicalize(&directory)?;
    if !directory.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "attachment directory escapes notebook",
        ));
    }
    let name = safe_name(name);
    let name_path = Path::new(&name);
    let stem = name_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let extension = name_path.extension().and_then(|value| value.to_str());
    let mut temporary = Some(tempfile::NamedTempFile::new_in(&directory)?);
    copy_bounded(reader, temporary.as_mut().unwrap(), MAX_ATTACHMENT_BYTES)?;
    temporary.as_ref().unwrap().as_file().sync_all()?;
    let fingerprint = super::upload_journal::fingerprint(temporary.as_mut().unwrap().as_file_mut())?;
    for index in 0..10_000 {
        let filename = if index == 0 {
            name.clone()
        } else {
            match extension {
                Some(extension) => format!("{stem}_{index}.{extension}"),
                None => format!("{stem}_{index}"),
            }
        };
        let target = directory.join(filename);
        let created = store.with_file_write(&lock_id, &target, FileLockIntent::Create,
            "save_attachment", |locked_target| {
                match fs::symlink_metadata(locked_target) {
                    Ok(_) => return Ok(false),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                let journal =
                    super::upload_journal::prepare(&root, locked_target, owner_note, &fingerprint)?;
                match temporary.take().unwrap().persist_noclobber(locked_target) {
                    Ok(_) => {
                        if let Err(error) = journal.confirm() {
                            tracing::warn!("Attachment saved; recovery confirmation failed: {error}");
                        }
                        Ok(true)
                    }
                    Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                        temporary = Some(error.file);
                        Ok(false)
                    }
                    Err(error) => Err(error.error),
                }
            })?;
        if created {
            return Ok(target);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "attachment name limit reached",
    ))
}

pub(super) fn authorized_attachment(store: &MemoFile, source: &Path) -> io::Result<PathBuf> {
    if !source.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "absolute attachment path required",
        ));
    }
    let source = dunce::canonicalize(source)?;
    if !source.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "attachment is not a file",
        ));
    }
    for notebook in store.read_notebook_configs()? {
        let root = Path::new(&notebook.path);
        let directory = root.join("attachments");
        if path_is_inside(&directory, root) && path_is_inside(&source, &directory) {
            return Ok(source);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "source is not a registered attachment",
    ))
}

#[cfg(test)]
mod tests;
