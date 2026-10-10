use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use flowix_core::memo_file::{FileLockIntent, MemoFile, NotebookConfig};

fn wait_until_exit(child: &mut Child, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn write_child(config: &std::path::Path, address: &str, input: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .args(["write", address, "--file", input.to_str().unwrap(), "--json"])
        .env("FLOWIX_HOME", config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn cli_writes_to_other_files_while_one_file_is_locked_by_another_process() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    std::fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[NotebookConfig {
        id: "book".into(),
        name: "Book".into(),
        icon: None,
        path: root.to_string_lossy().into_owned(),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }]).unwrap();
    memo.create_note_by_path("book", None, "A", "old A").unwrap();
    memo.create_note_by_path("book", None, "B", "old B").unwrap();
    let input_a = temp.path().join("new-a.md");
    let input_b = temp.path().join("new-b.md");
    std::fs::write(&input_a, "new A").unwrap();
    std::fs::write(&input_b, "new B").unwrap();

    let held = memo.operation_locks().file_write(
        "book", &root, &root.join("A.md"), FileLockIntent::Existing, "integration_hold_a",
    ).unwrap();
    let mut waiting_a = write_child(&config, "book::A.md", &input_a);
    std::thread::sleep(Duration::from_millis(150));
    assert!(waiting_a.try_wait().unwrap().is_none(), "A write did not wait for its file lock");

    let mut independent_b = write_child(&config, "book::B.md", &input_b);
    if !wait_until_exit(&mut independent_b, Duration::from_secs(3)) {
        independent_b.kill().unwrap();
        drop(held);
        waiting_a.kill().unwrap();
        panic!("B write waited for the unrelated A file lock");
    }
    let b_output = independent_b.wait_with_output().unwrap();
    assert!(b_output.status.success(), "{}", String::from_utf8_lossy(&b_output.stdout));
    assert_eq!(std::fs::read_to_string(root.join("B.md")).unwrap(), "new B");
    assert_eq!(std::fs::read_to_string(root.join("A.md")).unwrap(), "old A");

    drop(held);
    let a_output = waiting_a.wait_with_output().unwrap();
    assert!(a_output.status.success(), "{}", String::from_utf8_lossy(&a_output.stdout));
    assert_eq!(std::fs::read_to_string(root.join("A.md")).unwrap(), "new A");
}

#[test]
fn cli_does_not_recreate_a_removed_notebook_after_waiting_for_structure_lock() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    std::fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[NotebookConfig {
        id: "book".into(),
        name: "Book".into(),
        icon: None,
        path: root.to_string_lossy().into_owned(),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }]).unwrap();
    memo.create_note_by_path("book", None, "A", "old A").unwrap();
    let input = temp.path().join("new-a.md");
    std::fs::write(&input, "new A").unwrap();

    let held = memo.operation_locks().notebook_change(&["book"], "integration_remove_book").unwrap();
    let mut waiting = write_child(&config, "book::A.md", &input);
    std::thread::sleep(Duration::from_millis(150));
    assert!(waiting.try_wait().unwrap().is_none());
    std::fs::remove_dir_all(&root).unwrap();
    memo.write_notebook_configs(&[]).unwrap();
    drop(held);

    assert!(wait_until_exit(&mut waiting, Duration::from_secs(3)));
    let output = waiting.wait_with_output().unwrap();
    assert!(!output.status.success(), "stale CLI save unexpectedly succeeded");
    assert!(!root.exists(), "stale CLI save recreated the deleted notebook");
}

#[test]
fn lock_holder_exits_without_drop() {
    let Some(config) = std::env::var_os("FLOWIX_LOCK_HELPER_CONFIG") else { return };
    let root = std::path::PathBuf::from(std::env::var_os("FLOWIX_LOCK_HELPER_ROOT").unwrap());
    let marker = std::path::PathBuf::from(std::env::var_os("FLOWIX_LOCK_HELPER_MARKER").unwrap());
    let locks = flowix_core::memo_file::OperationLocks::new(config.into());
    let _held = locks.file_write(
        "book", &root, &root.join("A.md"), FileLockIntent::Existing, "exit_without_drop",
    ).unwrap();
    std::fs::write(marker, "ready").unwrap();
    std::thread::sleep(Duration::from_millis(700));
    std::process::exit(17);
}

#[test]
fn cli_resumes_when_a_lock_holder_process_exits() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    std::fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[NotebookConfig {
        id: "book".into(), name: "Book".into(), icon: None,
        path: root.to_string_lossy().into_owned(), is_default: true,
        sort: 0, created_at: 0, updated_at: 0,
    }]).unwrap();
    memo.create_note_by_path("book", None, "A", "old A").unwrap();
    let input = temp.path().join("new-a.md");
    std::fs::write(&input, "new A").unwrap();
    let marker = temp.path().join("holder-ready");

    let mut holder = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "lock_holder_exits_without_drop", "--nocapture"])
        .env("FLOWIX_LOCK_HELPER_CONFIG", &config)
        .env("FLOWIX_LOCK_HELPER_ROOT", &root)
        .env("FLOWIX_LOCK_HELPER_MARKER", &marker)
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap();
    let started = Instant::now();
    while !marker.exists() {
        assert!(started.elapsed() < Duration::from_secs(3), "lock helper never acquired its lock");
        std::thread::sleep(Duration::from_millis(20));
    }

    let mut writer = write_child(&config, "book::A.md", &input);
    std::thread::sleep(Duration::from_millis(150));
    assert!(writer.try_wait().unwrap().is_none(), "CLI did not wait for the other process");
    assert_eq!(holder.wait().unwrap().code(), Some(17));
    assert!(wait_until_exit(&mut writer, Duration::from_secs(3)));
    let output = writer.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    assert_eq!(std::fs::read_to_string(root.join("A.md")).unwrap(), "new A");
}

#[test]
fn cli_search_recovers_a_file_commit_without_a_refresh_marker() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    std::fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[NotebookConfig {
        id: "book".into(), name: "Book".into(), icon: None,
        path: root.to_string_lossy().into_owned(), is_default: true,
        sort: 0, created_at: 0, updated_at: 0,
    }]).unwrap();
    memo.create_note_by_path("book", None, "A", "# A\nold phrase\n").unwrap();
    memo.verify_note_index("book").unwrap();
    // Model a process dying immediately after the atomic body commit.
    std::fs::write(root.join("A.md"), "# A\nnew crash recovery token\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .args(["search", "crash recovery token", "-b", "book", "--json"])
        .env("FLOWIX_HOME", &config)
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["matches"].as_array().unwrap().len(), 1);
}

#[test]
fn conflict_writer_observes_file_change() {
    let Some(config) = std::env::var_os("FLOWIX_CONFLICT_HELPER_CONFIG") else { return };
    let marker = std::path::PathBuf::from(std::env::var_os("FLOWIX_CONFLICT_HELPER_MARKER").unwrap());
    let memo = MemoFile::new(config.into());
    std::fs::write(marker, "ready").unwrap();
    match memo.write_note_by_path("book", "A.md", "child edit", Some("old A")) {
        Ok(flowix_core::memo_file::NoteWriteOutcome::Conflict { .. }) => std::process::exit(19),
        _ => std::process::exit(20),
    }
}

#[test]
fn concurrent_process_save_checks_expected_content_under_file_lock() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    std::fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[NotebookConfig {
        id: "book".into(), name: "Book".into(), icon: None,
        path: root.to_string_lossy().into_owned(), is_default: true,
        sort: 0, created_at: 0, updated_at: 0,
    }]).unwrap();
    memo.create_note_by_path("book", None, "A", "old A").unwrap();
    let held = memo.operation_locks().file_write(
        "book", &root, &root.join("A.md"), FileLockIntent::Existing, "integration_parent_save",
    ).unwrap();
    let marker = temp.path().join("writer-ready");
    let mut writer = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "conflict_writer_observes_file_change", "--nocapture"])
        .env("FLOWIX_CONFLICT_HELPER_CONFIG", &config)
        .env("FLOWIX_CONFLICT_HELPER_MARKER", &marker)
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap();
    let started = Instant::now();
    while !marker.exists() {
        assert!(started.elapsed() < Duration::from_secs(3), "conflict writer never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::fs::write(root.join("A.md"), "parent edit").unwrap();
    drop(held);
    assert_eq!(writer.wait().unwrap().code(), Some(19));
    assert_eq!(std::fs::read_to_string(root.join("A.md")).unwrap(), "parent edit");
}
