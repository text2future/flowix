use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn fingerprint(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(hash.finalize().into());
        }
        hash.update(&buffer[..count]);
    }
}

#[derive(Default)]
pub struct ExportAccess {
    targets: Mutex<HashMap<(String, PathBuf), Option<[u8; 32]>>>,
    generations: Mutex<HashMap<String, u64>>,
}

impl ExportAccess {
    pub fn revoke(&self, window: &str) {
        let Ok(mut generations) = self.generations.lock() else {
            return;
        };
        let generation = generations.entry(window.to_string()).or_default();
        *generation = generation.saturating_add(1);
        if let Ok(mut targets) = self.targets.lock() {
            targets.retain(|(owner, _), _| owner != window);
        }
    }

    #[cfg(test)]
    pub fn grant(&self, window: &str, path: &Path) -> Option<PathBuf> {
        self.grant_for_generation(window, self.generation(window), path)
    }

    pub fn generation(&self, window: &str) -> u64 {
        self.generations
            .lock()
            .map(|values| *values.get(window).unwrap_or(&0))
            .unwrap_or(u64::MAX)
    }

    pub fn grant_for_generation(
        &self,
        window: &str,
        generation: u64,
        path: &Path,
    ) -> Option<PathBuf> {
        let (target, exists) = resolve_target(path).ok()?;
        let expected = if exists {
            Some(fingerprint(&target).ok()?)
        } else {
            None
        };
        let generations = self.generations.lock().ok()?;
        if *generations.get(window).unwrap_or(&0) != generation {
            return None;
        }
        let mut targets = self.targets.lock().ok()?;
        targets.retain(|(owner, _), _| owner != window);
        targets.insert((window.to_string(), target.clone()), expected);
        Some(target)
    }

    pub fn save(
        &self,
        window: &str,
        path: &Path,
        reader: &mut impl Read,
        memo_file: &flowix_core::memo_file::MemoFile,
    ) -> io::Result<()> {
        let (target, _) = resolve_target(path)?;
        let expected = self
            .targets
            .lock()
            .map_err(|_| io::Error::other("export authorization lock unavailable"))?
            .remove(&(window.to_string(), target.clone()))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "save dialog authorization required",
                )
            })?;
        let parent = target
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        io::copy(reader, &mut temporary)?;
        if expected.is_some() {
            match fs::metadata(&target) {
                Ok(metadata) => temporary
                    .as_file()
                    .set_permissions(metadata.permissions())?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        temporary.as_file().sync_all()?;
        let publish = |target: &Path| -> io::Result<()> {
            if let Some(expected) = expected {
                let (_, exists) = resolve_target(target)?;
                if !exists || fingerprint(target)? != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "EXPORT_CONTENT_CONFLICT: target changed since selection",
                    ));
                }
                temporary.persist(target).map_err(|error| error.error)?;
            } else {
                temporary
                    .persist_noclobber(target)
                    .map_err(|error| error.error)?;
            }
            Ok(())
        };
        let notebook_ids = memo_file.notebook_ids_for_paths(&[target.as_path()])?;
        match notebook_ids.as_slice() {
            [notebook_id] => memo_file.with_file_write(
                notebook_id,
                &target,
                if expected.is_some() {
                    flowix_core::memo_file::FileLockIntent::Existing
                } else {
                    flowix_core::memo_file::FileLockIntent::Create
                },
                "export_save",
                publish,
            ),
            [] => {
                let _guard = memo_file.acquire_cross_process_write_lock()?;
                publish(&target)
            }
            _ => {
                memo_file.with_registered_path_change(&[target.as_path()], "export_save_nested_notebooks", || {
                    publish(&target)
                })
            }
        }
    }

    /// Check that a path was selected by the save dialog without consuming the
    /// authorization. Native exporters write to a temporary file first and
    /// then call [`Self::save`] to perform the authorized atomic commit.
    pub fn authorized_target(&self, window: &str, path: &Path) -> io::Result<PathBuf> {
        let (target, _) = resolve_target(path)?;
        let targets = self
            .targets
            .lock()
            .map_err(|_| io::Error::other("export authorization lock unavailable"))?;
        if !targets.contains_key(&(window.to_string(), target.clone())) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "save dialog authorization required",
            ));
        }
        Ok(target)
    }
}

fn resolve_target(path: &Path) -> io::Result<(PathBuf, bool)> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "absolute export path required",
        ));
    }
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("missing file name"))?;
    let parent = dunce::canonicalize(
        path.parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?;
    if !parent.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "export parent is not a directory",
        ));
    }
    let target = parent.join(name);
    let exists = match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "export target must be a regular file",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    Ok((target, exists))
}

#[cfg(test)]
mod tests;
