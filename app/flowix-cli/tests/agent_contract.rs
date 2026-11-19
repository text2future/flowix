use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::Value;
use std::{fs, path::Path, process::Command};

fn run(config: &Path, root: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_flowix-cli")).env("FLOWIX_HOME", config).current_dir(root).args(args).output().unwrap()
}
fn json(output: &std::process::Output) -> Value { serde_json::from_slice(&output.stdout).unwrap() }

#[test]
fn cli_read_version_pagination_and_search_contract() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("book");
    let config = tmp.path().join("config");
    fs::create_dir_all(root.join("folder")).unwrap();
    MemoFile::new(config.clone()).write_notebook_configs(&[NotebookConfig { id:"book".into(), name:"Book".into(), icon:None, path:root.to_string_lossy().into_owned(), is_default:true, sort:0, created_at:0, updated_at:0 }]).unwrap();
    let input = tmp.path().join("body.md");
    fs::write(&input, "searchneedle original").unwrap();
    let created = run(&config, &root, &["create", "--title", "First", "--folder", "folder", "--file", input.to_str().unwrap(), "--json"]);
    assert!(created.status.success(), "{}", String::from_utf8_lossy(&created.stdout));
    let address = json(&created)["note"]["address"].as_str().unwrap().to_owned();
    assert_eq!(address, "book::folder/First.md");
    let shown = run(&config, &root, &["show", &address, "--json"]);
    let version = json(&shown)["version"].as_str().unwrap().to_owned();
    let plain = run(&config, &root, &["show", &address]);
    assert_eq!(plain.stdout, b"searchneedle original");
    let first = run(&config, &root, &["list", "--limit", "1", "--json"]);
    let snapshot = json(&first)["snapshot"].as_str().unwrap().to_owned();
    fs::write(root.join("folder/First.md"), "searchneedle changed").unwrap();
    fs::write(&input, "replacement").unwrap();
    let rejected = run(&config, &root, &["write", &address, "--file", input.to_str().unwrap(), "--if-version", &version, "--json"]);
    assert_eq!(json(&rejected)["error"]["code"], "VERSION_CONFLICT");
    let rejected_delete = run(&config, &root, &["delete", &address, "--if-version", &version, "--json"]);
    assert_eq!(json(&rejected_delete)["error"]["code"], "VERSION_CONFLICT");
    assert_eq!(fs::read_to_string(root.join("folder/First.md")).unwrap(), "searchneedle changed");
    fs::write(root.join("Second.md"), "searchneedle second").unwrap();
    let changed = run(&config, &root, &["list", "--offset", "1", "--snapshot", &snapshot, "--json"]);
    assert_eq!(json(&changed)["error"]["code"], "DATA_CHANGED");
    let search = run(&config, &root, &["search", "searchneedle", "--limit", "1", "--json"]);
    assert_eq!(json(&search)["truncated"], true);
    let search = run(&config, &root, &["search", "searchneedle", "--limit", "10", "--json"]);
    assert_eq!(json(&search)["truncated"], false);
}
