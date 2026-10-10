use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const EXIT_OK: i32 = 0;
pub const EXIT_CLI_RUNNING: i32 = 20;
pub const EXIT_PERMISSION_DENIED: i32 = 21;
pub const EXIT_FILE_IN_USE: i32 = 22;
pub const EXIT_FILE_ACCESS: i32 = 23;
pub const EXIT_ENUMERATION: i32 = 24;

#[derive(Debug)]
pub enum CloseError {
    CliStillRunning,
    PermissionDenied,
    FileInUse,
    FileAccess(String),
    Enumeration(String),
}

impl CloseError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::CliStillRunning => EXIT_CLI_RUNNING,
            Self::PermissionDenied => EXIT_PERMISSION_DENIED,
            Self::FileInUse => EXIT_FILE_IN_USE,
            Self::FileAccess(_) => EXIT_FILE_ACCESS,
            Self::Enumeration(_) => EXIT_ENUMERATION,
        }
    }

    pub fn user_message(&self) -> &'static str {
        match self {
            Self::CliStillRunning => "Flowix CLI is still running or is being restarted. Pause its MCP connection and retry.",
            Self::PermissionDenied => "Flowix could not close its CLI because permission was denied. Exit the app holding the Flowix MCP connection and retry.",
            Self::FileInUse => "The Flowix CLI file is still in use. Close the related app and retry.",
            Self::FileAccess(_) => "Flowix could not access the CLI file. Check install permissions and available disk space.",
            Self::Enumeration(_) => "Flowix could not inspect running processes. See the installer log for details.",
        }
    }
}

pub fn close_target_cli(
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
        log(log_path, "target-cli-missing; first-install path accepted");
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        close_target_cli_windows(target, timeout, interval, log_path)
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

pub fn merge_missing_tree(source: &Path, target: &Path, log_path: &Path) -> Result<(), String> {
    log(
        log_path,
        &format!(
            "install-commit-merge-start backup={} target={}",
            source.display(),
            target.display()
        ),
    );
    merge_directory(source, source, target, log_path).map_err(|error| {
        log(
            log_path,
            &format!("install-commit-merge-failed error={error}"),
        );
        error.to_string()
    })?;
    log(log_path, "install-commit-merge-complete");
    Ok(())
}

fn merge_directory(
    source_root: &Path,
    source: &Path,
    target: &Path,
    log_path: &Path,
) -> std::io::Result<()> {
    use std::fs;

    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            log(
                log_path,
                &format!(
                    "install-commit-skip-symlink path={}",
                    entry.path().display()
                ),
            );
            continue;
        }
        let source_path = entry.path();
        let relative = source_path
            .strip_prefix(source_root)
            .unwrap_or(&source_path);
        let Some(name) = relative.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if relative.components().count() == 1
            && matches!(
                name,
                "app-update-result.txt"
                    | "app-update-target.txt"
                    | "app-update.log"
                    | "update.lock"
            )
        {
            continue;
        }
        let target_path = target.join(relative);
        if kind.is_dir() {
            let target_kind = fs::symlink_metadata(&target_path)
                .ok()
                .map(|metadata| metadata.file_type());
            if target_kind
                .is_some_and(|target_kind| target_kind.is_symlink() || !target_kind.is_dir())
            {
                log(
                    log_path,
                    &format!("install-commit-skip-conflict path={}", relative.display()),
                );
                continue;
            }
            merge_directory(source_root, &source_path, &target_path, log_path)?;
        } else if kind.is_file() && !target_path.exists() {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &target_path)?;
            log(
                log_path,
                &format!("install-commit-preserved path={}", relative.display()),
            );
        }
    }
    Ok(())
}

pub fn restore_tree(backup: &Path, target: &Path, log_path: &Path) -> Result<(), String> {
    log(
        log_path,
        &format!(
            "install-rollback-start backup={} target={}",
            backup.display(),
            target.display()
        ),
    );
    if !backup.exists() {
        if target.exists() {
            std::fs::remove_dir_all(target).map_err(|error| {
                log(
                    log_path,
                    &format!("install-rollback-clean-partial-failed error={error}"),
                );
                error.to_string()
            })?;
        }
        log(log_path, "install-rollback-no-previous-install");
        return Ok(());
    }
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|error| {
            log(
                log_path,
                &format!("install-rollback-clean-partial-failed error={error}"),
            );
            error.to_string()
        })?;
    }
    std::fs::rename(backup, target).map_err(|error| {
        log(
            log_path,
            &format!("install-rollback-restore-failed error={error}"),
        );
        error.to_string()
    })?;
    log(log_path, "install-rollback-complete");
    Ok(())
}

#[cfg(target_os = "windows")]
fn close_target_cli_windows(
    target: &Path,
    timeout: Duration,
    interval: Duration,
    log_path: &Path,
) -> Result<(), CloseError> {
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
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

        let snapshot =
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|error| {
                log(
                    log_path,
                    &format!(
                        "process-enumeration-failed code={} error={error}",
                        error.code().0
                    ),
                );
                CloseError::Enumeration(error.to_string())
            })?;
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(CloseError::Enumeration(
                "process snapshot returned an invalid handle".to_string(),
            ));
        }

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut pids = Vec::new();
        match unsafe { Process32FirstW(snapshot, &mut entry) } {
            Ok(()) => loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len())],
                );
                if name.eq_ignore_ascii_case("flowix-cli.exe") {
                    pids.push(entry.th32ProcessID);
                }
                match unsafe { Process32NextW(snapshot, &mut entry) } {
                    Ok(()) => {}
                    Err(error)
                        if error.code()
                            == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) =>
                    {
                        break
                    }
                    Err(error) => {
                        unsafe {
                            let _ = CloseHandle(snapshot);
                        }
                        log(
                            log_path,
                            &format!(
                                "process-enumeration-next-failed code={} error={error}",
                                error.code().0
                            ),
                        );
                        return Err(CloseError::Enumeration(error.to_string()));
                    }
                }
            },
            Err(error)
                if error.code() == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) => {}
            Err(error) => {
                unsafe {
                    let _ = CloseHandle(snapshot);
                }
                log(
                    log_path,
                    &format!(
                        "process-enumeration-first-failed code={} error={error}",
                        error.code().0
                    ),
                );
                return Err(CloseError::Enumeration(error.to_string()));
            }
        }
        unsafe {
            let _ = CloseHandle(snapshot);
        }

        let mut found_target = false;
        for pid in pids {
            if Instant::now() >= deadline {
                break;
            }
            let access =
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
            let handle = match unsafe { OpenProcess(access, false, pid) } {
                Ok(handle) => handle,
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
                        Ok(handle) => handle,
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
                    let is_target = image_matches(query, &expected_path);
                    unsafe {
                        let _ = CloseHandle(query);
                    }
                    if !is_target {
                        continue;
                    }
                    match unsafe { OpenProcess(access, false, pid) } {
                        Ok(handle) => handle,
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

            if !image_matches(handle, &expected_path) {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                continue;
            }

            found_target = true;
            log(
                log_path,
                &format!("target-cli-confirmed pid={pid} attempt={attempt}"),
            );
            let already_exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
            if !already_exited {
                if let Err(error) = unsafe { TerminateProcess(handle, 1) } {
                    let exited_during_terminate =
                        unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
                    if !exited_during_terminate {
                        unsafe {
                            let _ = CloseHandle(handle);
                        }
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
                                "target-cli-terminate-failed pid={pid} win32={}",
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
                let waited = unsafe { WaitForSingleObject(handle, wait_ms) };
                if waited == WAIT_TIMEOUT {
                    log(
                        log_path,
                        &format!("target-cli-wait-timeout pid={pid} attempt={attempt}"),
                    );
                } else if waited != WAIT_OBJECT_0 {
                    unsafe {
                        let _ = CloseHandle(handle);
                    }
                    return Err(CloseError::Enumeration(format!(
                        "wait for pid {pid} returned {waited:?}"
                    )));
                }
            }
            unsafe {
                let _ = CloseHandle(handle);
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
fn enumerate_target_pids(expected_path: &str, log_path: &Path) -> Result<Vec<u32>, CloseError> {
    use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| CloseError::Enumeration(error.to_string()))?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut matching = Vec::new();
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    while next.is_ok() {
        let pid = entry.th32ProcessID;
        let name = String::from_utf16_lossy(
            &entry.szExeFile[..entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len())],
        );
        if name.eq_ignore_ascii_case("flowix-cli.exe") {
            if let Ok(handle) =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            {
                if image_matches(handle, expected_path) {
                    matching.push(pid);
                }
                unsafe {
                    let _ = CloseHandle(handle);
                }
            }
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    if let Err(error) = next {
        if error.code() != windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
            log(
                log_path,
                &format!(
                    "final-enumeration-failed code={} error={error}",
                    error.code().0
                ),
            );
            return Err(CloseError::Enumeration(error.to_string()));
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
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
        GENERIC_READ, GENERIC_WRITE,
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
            unsafe {
                let _ = CloseHandle(handle);
            }
            Ok(())
        }
        Err(error)
            if error.code() == windows::core::HRESULT::from_win32(ERROR_SHARING_VIOLATION.0)
                || error.code() == windows::core::HRESULT::from_win32(ERROR_LOCK_VIOLATION.0) =>
        {
            Err(CloseError::FileInUse)
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
