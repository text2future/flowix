//! Copying files and folders inside a notebook.
//!
//! The rules that matter here are all about not damaging the workspace:
//! never overwrite (the destination is reserved with `create_new`/`create_dir`,
//! so a racing writer loses instead of being clobbered), never follow symlinks,
//! never copy notebook-private state (`.flowix`, `.DS_Store`), refuse to copy a
//! directory into its own descendant, and clean up only what this call created
//! when something fails halfway.
//!
//! The scan-then-write order is deliberate: containment is re-checked after the
//! walk, so an ancestor swapped for a symlink mid-copy is caught before any
//! byte lands outside the source tree.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// macOS marks cloud-only placeholders with `UF_DATALESS`; copying one would
/// materialise a truncated file. Other platforms report nothing.
#[cfg(target_os = "macos")]
pub fn is_cloud_file_not_downloaded(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt;

    const UF_DATALESS: u32 = 0x4000_0000;
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.st_flags() & UF_DATALESS != 0)
}

#[cfg(not(target_os = "macos"))]
pub fn is_cloud_file_not_downloaded(_path: &Path) -> bool {
    false
}

/// Pick a destination name that does not exist yet, appending `suffix` and then
/// ` (n)` on collision.
///
/// Compound collection extensions (`.lib.yaml` and friends) are kept whole, so
/// `Notes.lib.yaml` copies to `Notes - Copy.lib.yaml` rather than
/// `Notes.lib - Copy.yaml`.
pub fn copy_target(source: &Path, directory: &Path, suffix: &str) -> io::Result<PathBuf> {
    let name = source
        .file_name()
        .ok_or_else(|| io::Error::other("INVALID_FILE_PATH"))?;
    let direct = directory.join(name);
    match fs::symlink_metadata(&direct) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(direct),
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    let (stem, extension) = if source.is_dir() {
        (name.to_string_lossy().into_owned(), String::new())
    } else {
        let name = name.to_string_lossy();
        [".lib.yaml", ".table.yaml", ".media.yaml"]
            .iter()
            .find_map(|ext| {
                name.strip_suffix(ext)
                    .map(|stem| (stem.to_owned(), ext.to_string()))
            })
            .unwrap_or_else(|| {
                (
                    source
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    source
                        .extension()
                        .map(|ext| format!(".{}", ext.to_string_lossy()))
                        .unwrap_or_default(),
                )
            })
    };
    for index in 1..=10_000 {
        let number = if index == 1 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = directory.join(format!("{stem}{suffix}{number}{extension}"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
            Ok(_) => {}
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "FILE_EXISTS"))
}

/// Copy `source` to `target` (which must not exist).
///
/// Scan before writing; never follow links or copy notebook-private state. On
/// failure, remove only the destination this call created.
pub fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("SOURCE_NOT_REGULAR_FILE"));
    }
    let source_is_directory = metadata.is_dir();
    let physical_source = dunce::canonicalize(source)?;
    let source = physical_source.as_path();
    if source_is_directory
        && dunce::canonicalize(
            target
                .parent()
                .ok_or_else(|| io::Error::other("INVALID_FILE_PATH"))?,
        )?
        .starts_with(source)
    {
        return Err(io::Error::other("INVALID_MOVE_TARGET"));
    }
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !matches!(entry.file_name().to_str(), Some(".flowix" | ".DS_Store"))
        })
    {
        let entry = entry.map_err(io::Error::other)?;
        if entry.file_type().is_symlink()
            || !(entry.file_type().is_dir() || entry.file_type().is_file())
        {
            return Err(io::Error::other("SOURCE_NOT_REGULAR_FILE"));
        }
        if is_cloud_file_not_downloaded(entry.path()) {
            return Err(io::Error::other("CLOUD_FILE_NOT_DOWNLOADED"));
        }
        entries.push((
            entry.path().to_owned(),
            entry
                .path()
                .strip_prefix(source)
                .map_err(io::Error::other)?
                .to_owned(),
            entry.file_type().is_dir(),
        ));
    }
    // Reserve the root with create_new/create_dir: a racing writer is never overwritten.
    let mut root_file = if source_is_directory {
        fs::create_dir(target)?;
        None
    } else {
        Some(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?,
        )
    };
    let result = (|| {
        for (path, relative, directory) in entries {
            // Re-check physical containment after scanning, including changes to ancestors.
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !dunce::canonicalize(&path)?.starts_with(source)
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "FILE_PERMISSION_DENIED",
                ));
            }
            let destination = target.join(relative);
            if directory {
                if destination != target {
                    fs::create_dir(&destination)?;
                }
            } else {
                let mut input = fs::File::open(&path)?;
                let mut output = if destination == target {
                    root_file
                        .take()
                        .ok_or_else(|| io::Error::other("INVALID_FILE_PATH"))?
                } else {
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&destination)?
                };
                io::copy(&mut input, &mut output)?;
                output.set_permissions(input.metadata()?.permissions())?;
                output.sync_all()?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        drop(root_file);
        let cleanup = if source_is_directory {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        };
        if let Err(cleanup_error) = cleanup {
            return Err(io::Error::other(format!(
                "IMPORT_FOLDER_CLEANUP_FAILED: {error}; {cleanup_error}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_tree_without_private_state_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("folder");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::create_dir_all(source.join(".flowix")).unwrap();
        fs::write(source.join("sub/note.md"), "hello").unwrap();
        fs::write(source.join(".flowix/local.db"), "private").unwrap();
        let target = copy_target(&source, root.path(), " - Copy").unwrap();
        assert_eq!(target.file_name().unwrap(), "folder - Copy");
        copy_tree(&source, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("sub/note.md")).unwrap(),
            "hello"
        );
        assert!(!target.join(".flowix").exists());
        assert!(copy_tree(&source, &target).is_err());
        assert!(target.join("sub/note.md").exists());
        assert_eq!(
            copy_target(&source, root.path(), " - Copy")
                .unwrap()
                .file_name()
                .unwrap(),
            "folder - Copy (2)"
        );
    }

    #[test]
    fn copies_file_and_preserves_compound_extension() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("Test.lib.yaml");
        fs::write(&source, "data").unwrap();
        let target = copy_target(&source, root.path(), " - Copy").unwrap();
        assert_eq!(target.file_name().unwrap(), "Test - Copy.lib.yaml");
        copy_tree(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "data");
    }

    #[test]
    fn rejects_copying_into_a_descendant_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("child")).unwrap();
        let target = source.join("child/copy");
        assert!(copy_tree(&source, &target).is_err());
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_executable_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("run.sh");
        let target = root.path().join("copy.sh");
        fs::write(&source, "echo hello").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        copy_tree(&source, &target).unwrap();
        assert_eq!(
            fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_before_creating_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("folder");
        fs::create_dir(&source).unwrap();
        std::os::unix::fs::symlink(root.path(), source.join("escape")).unwrap();
        let target = root.path().join("copy");
        assert!(copy_tree(&source, &target).is_err());
        assert!(!target.exists());
    }
}
