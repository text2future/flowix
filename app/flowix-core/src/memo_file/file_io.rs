use std::fs;
use std::io::{self, Write};
use std::path::Path;

use super::MemoFile;

#[derive(Debug, PartialEq, Eq)]
pub enum FileWriteOutcome {
    Saved,
    Conflict { disk_content: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum MergedFileWriteOutcome {
    Saved { content: String, merged: bool },
    Conflict { disk_content: String },
}

pub fn atomic_write_bytes(path: &Path, content: &[u8]) -> io::Result<()> {
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("file has no parent"))?;
    fs::create_dir_all(parent)?;
    let permissions = match fs::metadata(&path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    if let Some(permissions) = permissions {
        temporary.as_file().set_permissions(permissions)?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    Ok(())
}

pub fn atomic_create_bytes(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("file has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    Ok(())
}

#[cfg(windows)]
pub fn rename_file_noclobber(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if source[..source.len() - 1].contains(&0) || target[..target.len() - 1].contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn rename_file_noclobber(source: &Path, target: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn rename_file_noclobber(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-clobber rename is unsupported on this platform",
    ))
}

impl MemoFile {
    pub fn create_file(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let _guard = self.acquire_cross_process_write_lock()?;
        atomic_create_bytes(path, content)
    }

    pub fn write_file(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let _guard = self.acquire_cross_process_write_lock()?;
        atomic_write_bytes(path, content)
    }

    pub fn rename_file(&self, source: &Path, target: &Path) -> io::Result<()> {
        let _guard = self.acquire_cross_process_write_lock()?;
        rename_file_noclobber(source, target)
    }

    pub fn delete_file(&self, path: &Path) -> io::Result<()> {
        let _guard = self.acquire_cross_process_write_lock()?;
        fs::remove_file(path)
    }

    pub fn write_file_if_matches(
        &self,
        path: &Path,
        content: &str,
        expected: Option<&str>,
    ) -> io::Result<FileWriteOutcome> {
        let _guard = self.acquire_cross_process_write_lock()?;
        let disk_content = fs::read_to_string(path)?;
        if expected.is_some_and(|expected| expected != disk_content) {
            return Ok(FileWriteOutcome::Conflict { disk_content });
        }
        atomic_write_bytes(path, content.as_bytes())?;
        Ok(FileWriteOutcome::Saved)
    }

    /// Merge a Markdown edit against a concurrent disk edit while holding the
    /// same cross-process lock used by ordinary conditional writes.
    pub fn write_markdown_merging(
        &self,
        path: &Path,
        content: &str,
        expected: Option<&str>,
    ) -> io::Result<MergedFileWriteOutcome> {
        let _guard = self.acquire_cross_process_write_lock()?;
        let disk_content = fs::read_to_string(path)?;
        let (content, merged) = match expected {
            Some(base) if base != disk_content => {
                match crate::text_merge::merge_markdown(
                    base.as_bytes(),
                    content.as_bytes(),
                    disk_content.as_bytes(),
                ) {
                    crate::text_merge::MergeOutcome::Merged(bytes) => {
                        (String::from_utf8(bytes).map_err(io::Error::other)?, true)
                    }
                    crate::text_merge::MergeOutcome::Conflict
                    | crate::text_merge::MergeOutcome::Unsupported => {
                        return Ok(MergedFileWriteOutcome::Conflict { disk_content });
                    }
                }
            }
            _ => (content.to_owned(), false),
        };
        atomic_write_bytes(path, content.as_bytes())?;
        Ok(MergedFileWriteOutcome::Saved { content, merged })
    }
}

#[cfg(test)]
mod tests;

/// Ephemeral OS identity for correlating observed rename events, never persisted.
#[cfg(windows)]
pub fn filesystem_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }
    Some((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}

#[cfg(unix)]
pub fn filesystem_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
pub fn filesystem_identity(_path: &Path) -> Option<(u64, u64)> {
    None
}
