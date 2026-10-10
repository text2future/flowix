use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const EXIT_CLI_RUNNING: i32 = 20;
pub const EXIT_PERMISSION_DENIED: i32 = 21;
pub const EXIT_FILE_IN_USE: i32 = 22;
pub const EXIT_FILE_ACCESS: i32 = 23;
pub const EXIT_ENUMERATION: i32 = 24;

#[derive(Debug)]
pub enum CloseError {
    CliStillRunning,
    PermissionDenied,
    FileInUse(String),
    FileAccess(String),
    Enumeration(String),
}

impl CloseError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::CliStillRunning => EXIT_CLI_RUNNING,
            Self::PermissionDenied => EXIT_PERMISSION_DENIED,
            Self::FileInUse(_) => EXIT_FILE_IN_USE,
            Self::FileAccess(_) => EXIT_FILE_ACCESS,
            Self::Enumeration(_) => EXIT_ENUMERATION,
        }
    }
}

pub fn close_target_executable(
    target: &Path,
    timeout: Duration,
    interval: Duration,
    log_path: &Path,
) -> Result<(), CloseError> {
    log(
        log_path,
        &format!("close-start target={}", target.display()),
    );

    if !target.exists() {
        log(
            log_path,
            "target-process-missing; first-install path accepted",
        );
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        close_target_windows(target, timeout, interval, log_path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (timeout, interval);
        Err(CloseError::Enumeration(
            "the installer helper can only inspect Windows processes".to_string(),
        ))
    }
}

pub fn log(log_path: &Path, message: &str) {
    use std::fs::OpenOptions;
    use std::io::Write;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{timestamp} {message}");
    }
}

/// Owns a successful Win32 handle acquisition across every early return.
#[cfg(target_os = "windows")]
struct OwnedHandle(windows::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(target_os = "windows")]
fn close_target_windows(
    target: &Path,
    timeout: Duration,
    interval: Duration,
    log_path: &Path,
) -> Result<(), CloseError> {
    use windows::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    let expected_path = normalize_path(target);
    let deadline = Instant::now() + timeout;
    let mut attempt = 0_u32;
    let mut saw_uninspectable_candidate = false;

    loop {
        attempt += 1;
        if Instant::now() >= deadline {
            break;
        }

        let pids = enumerate_named_pids(&expected_path, log_path)?;

        let mut found_target = false;
        for pid in pids {
            if Instant::now() >= deadline {
                break;
            }
            let access =
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
            let handle = match unsafe { OpenProcess(access, false, pid) } {
                Ok(handle) => OwnedHandle(handle),
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) =>
                {
                    continue
                }
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(ERROR_ACCESS_DENIED.0) =>
                {
                    // A query-only handle may still identify this process. If it is the target,
                    // retry with the full rights and revalidate that same final handle.
                    let query = match unsafe {
                        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    } {
                        Ok(handle) => OwnedHandle(handle),
                        Err(query_error)
                            if query_error.code()
                                == windows::core::HRESULT::from_win32(
                                    ERROR_INVALID_PARAMETER.0,
                                ) =>
                        {
                            continue
                        }
                        Err(query_error) => {
                            saw_uninspectable_candidate = true;
                            log(log_path, &format!("candidate-uninspectable pid={pid} win32={} action=leave-running", query_error.code().0));
                            continue;
                        }
                    };
                    let is_target = image_matches(query.0, &expected_path);
                    if !is_target {
                        continue;
                    }
                    match unsafe { OpenProcess(access, false, pid) } {
                        Ok(handle) => OwnedHandle(handle),
                        Err(reopen_error) => {
                            saw_uninspectable_candidate = true;
                            log(
                                log_path,
                                &format!(
                                    "target-open-for-terminate-denied pid={pid} win32={}",
                                    reopen_error.code().0
                                ),
                            );
                            continue;
                        }
                    }
                }
                Err(error) => {
                    saw_uninspectable_candidate = true;
                    log(
                        log_path,
                        &format!(
                            "candidate-open-failed pid={pid} win32={} action=leave-running",
                            error.code().0
                        ),
                    );
                    continue;
                }
            };

            if !image_matches(handle.0, &expected_path) {
                continue;
            }

            found_target = true;
            log(
                log_path,
                &format!("target-process-confirmed pid={pid} attempt={attempt}"),
            );
            let already_exited = unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_OBJECT_0;
            if !already_exited {
                if let Err(error) = unsafe { TerminateProcess(handle.0, 1) } {
                    let exited_during_terminate =
                        unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_OBJECT_0;
                    if !exited_during_terminate {
                        let failure = if error.code()
                            == windows::core::HRESULT::from_win32(ERROR_ACCESS_DENIED.0)
                        {
                            CloseError::PermissionDenied
                        } else {
                            CloseError::Enumeration(format!("terminate pid {pid} failed: {error}"))
                        };
                        log(
                            log_path,
                            &format!(
                                "target-process-terminate-failed pid={pid} win32={}",
                                error.code().0
                            ),
                        );
                        return Err(failure);
                    }
                }

                // Bound each wait so one long-lived child does not prevent the
                // remaining instances from being inspected within the shared deadline.
                let remaining = deadline.saturating_duration_since(Instant::now());
                let wait_ms = interval.min(remaining).as_millis().min(u32::MAX as u128) as u32;
                let waited = unsafe { WaitForSingleObject(handle.0, wait_ms) };
                if waited == WAIT_TIMEOUT {
                    log(
                        log_path,
                        &format!("target-process-wait-timeout pid={pid} attempt={attempt}"),
                    );
                } else if waited != WAIT_OBJECT_0 {
                    return Err(CloseError::Enumeration(format!(
                        "wait for pid {pid} returned {waited:?}"
                    )));
                }
            }
        }

        if !found_target {
            match can_replace_file(target) {
                Ok(()) => {
                    log(log_path, &format!("cli-ready attempt={attempt} uninspectable-candidates={saw_uninspectable_candidate}"));
                    return Ok(());
                }
                Err(error) => {
                    log(
                        log_path,
                        &format!("cli-file-not-replaceable attempt={attempt} error={error:?}"),
                    );
                }
            }
        }

        if Instant::now() < deadline {
            std::thread::sleep(interval.min(deadline.saturating_duration_since(Instant::now())));
        }
    }

    let remaining_pids = enumerate_target_pids(&expected_path, log_path)?;
    if !remaining_pids.is_empty() {
        log(
            log_path,
            &format!("cli-close-timeout pids={remaining_pids:?} attempts={attempt}"),
        );
        return Err(CloseError::CliStillRunning);
    }
    match can_replace_file(target) {
        Ok(()) => {
            log(
                log_path,
                &format!("cli-ready-after-timeout-check attempts={attempt}"),
            );
            Ok(())
        }
        Err(error) => {
            log(
                log_path,
                &format!("cli-file-remains-locked attempts={attempt} error={error:?}"),
            );
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
fn enumerate_named_pids(expected_path: &str, log_path: &Path) -> Result<Vec<u32>, CloseError> {
    use windows::Win32::Foundation::ERROR_NO_MORE_FILES;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let snapshot = OwnedHandle(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|error| {
            log(
                log_path,
                &format!(
                    "process-enumeration-failed code={} error={error}",
                    error.code().0
                ),
            );
            CloseError::Enumeration(error.to_string())
        })?,
    );
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut matching = Vec::new();
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while next.is_ok() {
        let name = String::from_utf16_lossy(
            &entry.szExeFile[..entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len())],
        );
        if Path::new(expected_path)
            .file_name()
            .is_some_and(|expected| name.eq_ignore_ascii_case(&expected.to_string_lossy()))
        {
            matching.push(entry.th32ProcessID);
        }
        next = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if let Err(error) = next {
        if error.code() != windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
            log(
                log_path,
                &format!(
                    "process-enumeration-failed code={} error={error}",
                    error.code().0
                ),
            );
            return Err(CloseError::Enumeration(error.to_string()));
        }
    }
    Ok(matching)
}

#[cfg(target_os = "windows")]
fn enumerate_target_pids(expected_path: &str, log_path: &Path) -> Result<Vec<u32>, CloseError> {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let mut matching = Vec::new();
    for pid in enumerate_named_pids(expected_path, log_path)? {
        if let Ok(handle) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            let handle = OwnedHandle(handle);
            if image_matches(handle.0, expected_path) {
                matching.push(pid);
            }
        }
    }
    Ok(matching)
}

#[cfg(target_os = "windows")]
fn image_matches(handle: windows::Win32::Foundation::HANDLE, expected_path: &str) -> bool {
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_FORMAT};

    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    }
    .is_err()
    {
        return false;
    }
    let actual = String::from_utf16_lossy(&buffer[..length as usize]);
    normalize_path(Path::new(&actual)) == expected_path
}

#[cfg(target_os = "windows")]
fn can_replace_file(target: &Path) -> Result<(), CloseError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, GENERIC_READ,
        GENERIC_WRITE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE, OPEN_EXISTING,
    };

    if !target.exists() {
        return Ok(());
    }
    let wide = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    match unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    } {
        Ok(handle) => {
            let _handle = OwnedHandle(handle);
            Ok(())
        }
        Err(error)
            if error.code() == windows::core::HRESULT::from_win32(ERROR_SHARING_VIOLATION.0)
                || error.code() == windows::core::HRESULT::from_win32(ERROR_LOCK_VIOLATION.0) =>
        {
            Err(CloseError::FileInUse(error.to_string()))
        }
        Err(error) if error.code() == windows::core::HRESULT::from_win32(ERROR_ACCESS_DENIED.0) => {
            Err(CloseError::FileAccess(format!(
                "file access denied: {error}"
            )))
        }
        Err(error) => Err(CloseError::FileAccess(error.to_string())),
    }
}

#[cfg(target_os = "windows")]
fn normalize_path(path: &Path) -> String {
    let normalized = dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\");
    let normalized = if let Some(rest) = normalized.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = normalized.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        normalized
    };
    normalized.trim_end_matches('\\').to_lowercase()
}

#[cfg(windows)]
mod preflight;
#[cfg(windows)]
pub use preflight::{listen_for_shutdown, prepare_install};
