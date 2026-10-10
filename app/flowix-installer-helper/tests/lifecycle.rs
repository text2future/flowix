#![cfg(windows)]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    children: Vec<Child>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "flowix lifecycle {} {}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        Self {
            root,
            children: vec![],
        }
    }
    fn program(&self, relative: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        path
    }
    fn start(&mut self, path: &Path) {
        self.children.push(
            Command::new(path)
                .args(["--exact", "fixture_process", "--ignored"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
    }
    fn prepare(&self, install: &Path) -> std::process::Output {
        self.prepare_named(install, "Flowix.exe")
    }
    fn prepare_named(&self, install: &Path, main_executable: &str) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_flowix-installer-helper"))
            .args(["--mode", "prepare", "--target"])
            .arg(install)
            .args(["--main-executable", main_executable])
            .args(["--timeout-ms", "600", "--interval-ms", "50", "--log"])
            .arg(self.root.join("update.log"))
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Only this test's unique temp directory is removed.
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore]
fn fixture_process() {
    std::thread::sleep(Duration::from_secs(60));
}

#[test]
#[ignore]
fn fixture_graceful() {
    flowix_installer_helper::listen_for_shutdown(|| {
        std::fs::write(
            std::env::current_exe().unwrap().with_extension("saved"),
            "saved",
        )
        .unwrap();
        std::process::exit(0);
    });
    std::thread::sleep(Duration::from_secs(60));
}

#[test]
fn requests_normal_desktop_exit_before_replacing_files() {
    normal_desktop_exit("Flowix.exe");
}

#[test]
fn requests_normal_exit_for_main_executable_with_spaces() {
    normal_desktop_exit("Flowix Dev.exe");
}

fn normal_desktop_exit(main_executable: &str) {
    let mut f = Fixture::new();
    let app = f.program(&format!("install/{main_executable}"));
    f.children.push(
        Command::new(&app)
            .args(["--exact", "fixture_graceful", "--ignored"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let result = f.prepare_named(app.parent().unwrap(), main_executable);
    assert!(result.status.success(), "{:?}", result);
    assert_eq!(
        std::fs::read_to_string(app.with_extension("saved")).unwrap(),
        "saved"
    );
    assert!(f.children[0].try_wait().unwrap().is_some());
}

#[test]
fn prepare_requires_a_scoped_main_executable() {
    let f = Fixture::new();
    for name in [None, Some("../other/Flowix.exe"), Some("C:\\Flowix.exe")] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_flowix-installer-helper"));
        command
            .args(["--mode", "prepare", "--target"])
            .arg(&f.root)
            .arg("--log")
            .arg(f.root.join("update.log"));
        if let Some(name) = name {
            command.args(["--main-executable", name]);
        }
        let result = command.output().unwrap();
        assert_eq!(result.status.code(), Some(24));
    }
}

#[test]
fn closes_orphaned_bundled_pi_but_not_external_pi() {
    let mut f = Fixture::new();
    let bundled = f.program("install/pi/windows-x64/pi.exe");
    let other = f.program("external/pi.exe");
    f.start(&bundled);
    f.start(&other);
    let result = f.prepare(&f.root.join("install"));
    assert!(result.status.success(), "{:?}", result);
    assert!(f.children[0].try_wait().unwrap().is_some());
    assert!(f.children[1].try_wait().unwrap().is_none());
}

#[test]
fn first_install_needs_no_existing_files() {
    let f = Fixture::new();
    let result = f.prepare(&f.root.join("missing install"));
    assert!(result.status.success(), "{:?}", result);
}

#[test]
fn closes_all_target_instances_but_keeps_another_installation() {
    let mut f = Fixture::new();
    let cli = f.program("install/flowix-cli.exe");
    let other = f.program("other/flowix-cli.exe");
    f.start(&cli);
    f.start(&cli);
    f.start(&other);
    let result = f.prepare(cli.parent().unwrap());
    assert!(result.status.success(), "{:?}", result);
    assert!(f.children[0].try_wait().unwrap().is_some());
    assert!(f.children[1].try_wait().unwrap().is_some());
    assert!(f.children[2].try_wait().unwrap().is_none());
}

#[test]
fn unresponsive_desktop_blocks_install_without_losing_drafts() {
    let mut f = Fixture::new();
    let app = f.program("install/Flowix.exe");
    f.start(&app);
    let result = f.prepare(app.parent().unwrap());
    assert_eq!(result.status.code(), Some(20));
    assert!(f.children[0].try_wait().unwrap().is_none());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Flowix.exe"));
}

#[test]
fn locked_bundled_library_reports_path_and_blocks_install() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    let file = f.root.join("install/pi/runtime.dll");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, b"library fixture").unwrap();
    let _lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&file)
        .unwrap();
    let result = f.prepare(&f.root.join("install"));
    assert_eq!(result.status.code(), Some(22));
    assert!(String::from_utf8_lossy(&result.stderr).contains("runtime.dll"));
}
