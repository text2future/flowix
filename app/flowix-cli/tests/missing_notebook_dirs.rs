use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn run(config: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .env("FLOWIX_HOME", config)
        .current_dir(cwd)
        .args(args)
        .output()
        .unwrap()
}

fn notebook(id: &str, name: &str, path: &Path, is_default: bool) -> NotebookConfig {
    NotebookConfig {
        id: id.into(),
        name: name.into(),
        icon: None,
        path: path.to_string_lossy().into_owned(),
        is_default,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn missing_notebook_directories_are_filtered_from_global_reads() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let existing_root = temp.path().join("existing");
    let missing_root = temp.path().join("missing");
    let file_root = temp.path().join("not-a-directory");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&existing_root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(&file_root, "not a notebook directory").unwrap();
    fs::write(
        existing_root.join("match.md"),
        "# Existing notebook\n\ndistinct-search-token\n",
    )
    .unwrap();

    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[
        notebook("existing", "Existing", &existing_root, true),
        notebook("missing", "Missing", &missing_root, false),
        notebook("file", "File", &file_root, false),
    ])
    .unwrap();
    memo.write_selected_notebook_id(Some("missing")).unwrap();

    let listed = run(&config, &outside, &["notebooks", "--json"]);
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stdout)
    );
    let listed = json(&listed);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], "existing");

    let searched = run(
        &config,
        &outside,
        &["search", "distinct-search-token", "--json"],
    );
    assert!(
        searched.status.success(),
        "{}",
        String::from_utf8_lossy(&searched.stdout)
    );
    let searched = json(&searched);
    assert_eq!(searched["total"], 1);
    assert_eq!(searched["matches"][0]["notebookId"], "existing");

    let defaulted = run(&config, &outside, &["list", "--limit", "1", "--json"]);
    assert!(
        defaulted.status.success(),
        "{}",
        String::from_utf8_lossy(&defaulted.stdout)
    );
    assert_eq!(json(&defaulted)["notebookId"], "existing");

    let explicit_missing_search = run(
        &config,
        &outside,
        &["search", "token", "--notebook", "Missing", "--json"],
    );
    assert_eq!(json(&explicit_missing_search)["error"]["code"], "NOT_FOUND");

    let explicit_missing_list = run(&config, &outside, &["list", "Missing", "--json"]);
    assert_eq!(json(&explicit_missing_list)["error"]["code"], "NOT_FOUND");

    let explicit_file_list = run(&config, &outside, &["list", "File", "--json"]);
    assert_eq!(json(&explicit_file_list)["error"]["code"], "NOT_FOUND");

    let explicit_missing_show = run(&config, &outside, &["show", "missing::match.md", "--json"]);
    assert_eq!(json(&explicit_missing_show)["error"]["code"], "NOT_FOUND");

    let explicit_file_show = run(&config, &outside, &["show", "file::match.md", "--json"]);
    assert_eq!(json(&explicit_file_show)["error"]["code"], "NOT_FOUND");

    let absent_note_show = run(
        &config,
        &outside,
        &["show", "existing::never-created.md", "--json"],
    );
    assert_eq!(json(&absent_note_show)["error"]["code"], "NOT_FOUND");

    fs::remove_file(existing_root.join("match.md")).unwrap();
    let stale_index_show = run(&config, &outside, &["show", "existing::match.md", "--json"]);
    assert_eq!(json(&stale_index_show)["error"]["code"], "NOT_FOUND");
}
