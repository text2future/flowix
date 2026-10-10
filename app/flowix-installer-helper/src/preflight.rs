use super::{
    can_replace_file, close_target_executable, enumerate_target_pids, log, normalize_path,
    CloseError,
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, WAIT_OBJECT_0},
        System::{RestartManager::*, Threading::*},
    },
};

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}

fn shutdown_event(pid: u32) -> Vec<u16> {
    wide(std::ffi::OsStr::new(&format!(
        "Local\\Flowix.Maintenance.Exit.{pid}"
    )))
}

/// Route maintenance through the app's existing save/exit/child-cleanup path.
/// A cancelled document save leaves the application running and blocks setup.
pub fn listen_for_shutdown(request_exit: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        let name = shutdown_event(std::process::id());
        let Ok(event) = (unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr())) }) else {
            return;
        };
        while unsafe { WaitForSingleObject(event, INFINITE) } == WAIT_OBJECT_0 {
            request_exit();
        }
        unsafe {
            let _ = CloseHandle(event);
        }
    });
}

pub struct PreflightError {
    pub code: i32,
    pub message: String,
}
fn failure(path: &Path, error: CloseError) -> PreflightError {
    let owners = locking_processes(path).unwrap_or_else(|e| format!("occupant lookup failed: {e}"));
    PreflightError { code: error.exit_code(), message: format!("Cannot replace {}: {error:?}. {owners} Close the listed app or pause its Flowix MCP connection and retry.", path.display()) }
}

pub fn prepare_install(
    root: &Path,
    main_executable: &Path,
    timeout: Duration,
    interval: Duration,
    log_path: &Path,
) -> Result<(), PreflightError> {
    let desktop = root.join(main_executable);
    let deadline = Instant::now() + timeout;
    let mut requested = std::collections::HashSet::new();
    loop {
        let pids = enumerate_target_pids(&normalize_path(&desktop), log_path)
            .map_err(|e| failure(&desktop, e))?;
        if pids.is_empty() {
            break;
        }
        for pid in &pids {
            if !requested.contains(pid) {
                let name = shutdown_event(*pid);
                match unsafe { OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(name.as_ptr())) } {
                    Ok(event) => unsafe { if SetEvent(event).is_ok() { requested.insert(*pid); } let _ = CloseHandle(event); },
                    Err(error) => log(log_path, &format!("desktop-exit-request-unavailable pid={pid} error={error}; exit Flowix manually")),
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(PreflightError { code: 20, message: format!("{} is still running (PID {pids:?}). Save your documents and exit Flowix, then retry. Older versions must be exited manually.", main_executable.display()) });
        }
        std::thread::sleep(interval.min(deadline.saturating_duration_since(Instant::now())));
    }
    let files = program_files(root).map_err(|e| PreflightError {
        code: 23,
        message: format!("Cannot inspect {}: {e}", root.display()),
    })?;
    // Only product-owned executables are terminated; external hosts and other
    // installations are never killed by name or through Restart Manager.
    for file in &files {
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        if (file.parent() == Some(root) && name.eq_ignore_ascii_case("flowix-cli.exe"))
            || (file.starts_with(root.join("pi")) && name.eq_ignore_ascii_case("pi.exe"))
        {
            close_target_executable(file, timeout, interval, log_path)
                .map_err(|e| failure(file, e))?;
        }
    }
    for file in &files {
        can_replace_file(file).map_err(|e| failure(file, e))?;
    }
    log(
        log_path,
        &format!(
            "preflight-ready target={} files={}",
            root.display(),
            files.len()
        ),
    );
    Ok(())
}

fn program_files(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                collect(&entry.path(), files)?;
            } else if entry
                .path()
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("dll"))
            {
                files.push(entry.path());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("dll"))
            && !entry.file_name().eq_ignore_ascii_case("uninstall.exe")
        {
            files.push(entry.path());
        }
    }
    let pi = root.join("pi");
    if pi.is_dir() && !std::fs::symlink_metadata(&pi)?.file_type().is_symlink() {
        collect(&pi, &mut files)?;
    }
    Ok(files)
}

/// Diagnostic only: never call RmShutdown on another application's processes.
fn locking_processes(path: &Path) -> Result<String, String> {
    let mut session = 0;
    let mut key = [0u16; 33];
    let code = unsafe { RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) };
    if code != ERROR_SUCCESS {
        return Err(format!("RmStartSession Win32={}", code.0));
    }
    struct Session(u32);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                let _ = RmEndSession(self.0);
            }
        }
    }
    let _session = Session(session);
    let path = wide(path.as_os_str());
    let code = unsafe { RmRegisterResources(session, Some(&[PCWSTR(path.as_ptr())]), None, None) };
    if code != ERROR_SUCCESS {
        return Err(format!("RmRegisterResources Win32={}", code.0));
    }
    let (mut needed, mut count, mut reasons) = (0, 0, 0);
    let mut entries = Vec::new();
    for _ in 0..4 {
        let code = unsafe {
            RmGetList(
                session,
                &mut needed,
                &mut count,
                if entries.is_empty() {
                    None
                } else {
                    Some(entries.as_mut_ptr())
                },
                &mut reasons,
            )
        };
        if code == ERROR_SUCCESS {
            entries.truncate(count as usize);
            let owners = entries
                .iter()
                .map(|p: &RM_PROCESS_INFO| {
                    let len = p
                        .strAppName
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(p.strAppName.len());
                    format!(
                        "{} (PID {})",
                        String::from_utf16_lossy(&p.strAppName[..len]),
                        p.Process.dwProcessId
                    )
                })
                .collect::<Vec<_>>();
            return Ok(if owners.is_empty() {
                "No owning application identified.".into()
            } else {
                format!("In use by: {}.", owners.join(", "))
            });
        }
        if code != ERROR_MORE_DATA {
            return Err(format!("RmGetList Win32={}", code.0));
        }
        entries.resize(needed as usize, RM_PROCESS_INFO::default());
        count = needed;
    }
    Err("process list changed repeatedly".into())
}
