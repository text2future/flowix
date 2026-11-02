//! Real filesystem + SQLite measurements; opt in with --ignored --nocapture.
use flowix_core::{
    memo_file::{save_probe, MemoFile, NotebookConfig},
    service::{NoteSaveOutcome, NoteService},
};
use std::{fs, time::Instant};

#[test]
#[ignore = "manual disk performance probe"]
fn report_real_save_cycle_cost() {
    let dir = tempfile::tempdir().unwrap();
    let notebook_path = dir.path().join("notebook");
    fs::create_dir_all(&notebook_path).unwrap();
    let store = MemoFile::new(dir.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "perf".into(),
            name: "Performance".into(),
            icon: None,
            path: notebook_path.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        }])
        .unwrap();
    let mut service = NoteService::new(&store);
    for kb in [2, 20, 60] {
        let unit = "## Section\n\nThe quick brown fox jumps over the lazy dog. 中文内容用于保存测试。\n\n";
        let mut body = unit.repeat((kb * 1024 / unit.len()) + 1);
        let note = service
            .create("perf", None, &format!("perf-{kb}"), &body)
            .unwrap();
        let relative = note
            .path
            .strip_prefix(&notebook_path)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for round in 0..12 {
            let next = format!("{body}edit-{round}\n");
            let start = Instant::now();
            let outcome = service
                .save("perf", &relative, &next, Some(&body))
                .unwrap();
            let service_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert!(matches!(outcome, NoteSaveOutcome::Saved(_)));
            assert_eq!(fs::read_to_string(&note.path).unwrap(), next);
            let profile = save_probe::take_last().expect("save profile");
            println!("[perf:real-save] {{\"kb\":{kb},\"round\":{round},\"serviceMs\":{service_ms:.3},\"stages\":{}}}", profile.to_json());
            body = next;
        }
    }
}
