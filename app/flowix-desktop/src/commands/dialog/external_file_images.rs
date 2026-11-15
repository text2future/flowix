use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;

use super::{attachment_fingerprint, attachments};

fn cache_root() -> io::Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory is unavailable"))?;
    Ok(home
        .join(".flowix")
        .join("cache")
        .join("external-file-images"))
}

pub(in crate::commands) fn contains(path: &Path) -> bool {
    let Ok(root) = cache_root().and_then(|path| dunce::canonicalize(path)) else {
        return false;
    };
    let Ok(path) = dunce::canonicalize(path) else {
        return false;
    };
    path.is_file() && path.starts_with(root)
}

fn existing_matches(path: &Path, fingerprint: &(String, u64)) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.len() != fingerprint.1 {
        return Ok(false);
    }
    let mut existing = File::open(path)?;
    Ok(attachment_fingerprint::fingerprint(&mut existing)? == *fingerprint)
}

/// Persist file content without an original path for external Markdown documents.
/// The existing external-file-images directory also stores non-image attachments.
pub(super) fn save(
    reader: &mut impl Read,
    name: &str,
    deduplicate: bool,
) -> io::Result<attachments::SavedNotebookAsset> {
    save_in_directory(reader, name, deduplicate, &cache_root()?)
}

fn save_in_directory(
    reader: &mut impl Read,
    name: &str,
    deduplicate: bool,
    requested_root: &Path,
) -> io::Result<attachments::SavedNotebookAsset> {
    fs::create_dir_all(requested_root)?;
    let root = dunce::canonicalize(requested_root)?;
    let safe_name = attachments::safe_name(name);
    let name_path = Path::new(&safe_name);
    let stem = name_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = name_path.extension().and_then(|value| value.to_str());

    let mut temporary = Some(NamedTempFile::new_in(&root)?);
    let fingerprint = attachments::copy_bounded(
        reader,
        temporary.as_mut().expect("temporary external file exists"),
        attachments::MAX_ATTACHMENT_BYTES,
    )?;
    temporary
        .as_ref()
        .expect("temporary external file exists")
        .as_file()
        .sync_all()?;

    for index in 0..10_000 {
        let filename = if index == 0 {
            safe_name.clone()
        } else {
            match extension {
                Some(extension) => format!("{stem}_{index}.{extension}"),
                None => format!("{stem}_{index}"),
            }
        };
        let target = root.join(filename);

        match fs::symlink_metadata(&target) {
            Ok(_) => {
                if deduplicate && index == 0 && existing_matches(&target, &fingerprint)? {
                    return Ok(attachments::SavedNotebookAsset {
                        path: target.to_string_lossy().into_owned(),
                        created: false,
                    });
                }
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        match temporary
            .take()
            .expect("temporary external file exists")
            .persist_noclobber(&target)
        {
            Ok(_) => {
                return Ok(attachments::SavedNotebookAsset {
                    path: target.to_string_lossy().into_owned(),
                    created: true,
                });
            }
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                temporary = Some(error.file);
                if deduplicate && index == 0 && existing_matches(&target, &fingerprint)? {
                    return Ok(attachments::SavedNotebookAsset {
                        path: target.to_string_lossy().into_owned(),
                        created: false,
                    });
                }
            }
            Err(error) => return Err(error.error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "external file cache name limit reached",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_persists_non_image_content_and_preserves_name_collisions() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("external-file-images");
        let saved = save_in_directory(&mut &b"%PDF-first"[..], "report.pdf", true, &root).unwrap();
        assert_eq!(fs::read(&saved.path).unwrap(), b"%PDF-first");
        assert_eq!(
            Path::new(&saved.path),
            dunce::canonicalize(&root).unwrap().join("report.pdf")
        );
        assert!(saved.created);

        let reused = save_in_directory(&mut &b"%PDF-first"[..], "report.pdf", true, &root).unwrap();
        assert_eq!(reused.path, saved.path);
        assert!(!reused.created);

        let second =
            save_in_directory(&mut &b"%PDF-second"[..], "report.pdf", true, &root).unwrap();
        assert_ne!(second.path, saved.path);
        assert_eq!(fs::read(second.path).unwrap(), b"%PDF-second");
        assert_eq!(fs::read(saved.path).unwrap(), b"%PDF-first");
    }
}
