use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::Value;
use std::{fs, path::Path, process::Command};

fn run(config: &Path, args: &[&str]) -> (bool, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .env("FLOWIX_HOME", config).args(args).arg("--json").output().unwrap();
    (output.status.success(), serde_json::from_slice(&output.stdout).unwrap())
}

#[test]
fn creates_typed_table_and_checks_values_before_linking() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(config.clone());
    memo.write_notebook_configs(&[NotebookConfig { id: "book".into(), name: "Book".into(), icon: None, path: root.to_string_lossy().into_owned(), is_default: true, sort: 0, created_at: 0, updated_at: 0 }]).unwrap();
    let fields = temp.path().join("fields.json");
    fs::write(&fields, r#"[{"name":"状态","type":"Select","options":["待办","完成"]},{"name":"评分","type":"Number"},{"name":"标签","type":"MultiSelect","options":["写作","营销"]},{"name":"已核验","type":"Boolean"},{"name":"日期","type":"Date"}]"#).unwrap();
    let (ok, created) = run(&config, &["collection", "create", "--notebook", "book", "--path", "产品.index.yaml", "--fields-file", fields.to_str().unwrap()]);
    assert!(ok, "{created}");
    let id = created["collectionId"].as_str().unwrap();
    let extra = temp.path().join("extra.json");
    fs::write(&extra, r#"[{"name":"网址","type":"URL"}]"#).unwrap();
    let (ok, added_fields) = run(&config, &["collection", "add-fields", "--notebook", "book", "--id", id, "--fields-file", extra.to_str().unwrap()]);
    assert!(ok, "{added_fields}");
    assert_eq!(added_fields["revision"], 1);
    let (ok, _) = run(&config, &["collection", "add-fields", "--notebook", "book", "--id", id, "--fields-file", extra.to_str().unwrap()]);
    assert!(!ok);
    let (_, duplicate) = run(&config, &["collection", "create", "--notebook", "book", "--path", "产品.index.yaml"]);
    assert_eq!(duplicate["ok"], false);
    let invalid_fields = temp.path().join("invalid.json");
    fs::write(&invalid_fields, r#"[{"name":"分数","type":"Number","options":["高"]}]"#).unwrap();
    let (ok, invalid) = run(&config, &["collection", "create", "--notebook", "book", "--path", "invalid.index.yaml", "--fields-file", invalid_fields.to_str().unwrap()]);
    assert!(!ok, "{invalid}");
    assert!(!root.join("invalid.index.yaml").exists());
    let (ok, _) = run(&config, &["collection", "create", "--notebook", "book", "--path", "../outside.index.yaml"]);
    assert!(!ok);
    let bad = temp.path().join("bad.md");
    fs::write(&bad, "---\n状态: 未知\n评分: wrong\n---\n# Bad\n").unwrap();
    let (ok, rejected) = run(&config, &["collection", "add-note", "--notebook", "book", "--id", id, "--title", "Bad", "--file", bad.to_str().unwrap()]);
    assert!(!ok, "{rejected}");
    assert!(rejected.to_string().contains("INVALID_FIELD_VALUE"));
    for (name, content) in [
        ("bad-number", "---\n评分: '4'\n---\n# Bad\n"),
        ("bad-boolean", "---\n已核验: 'true'\n---\n# Bad\n"),
        ("bad-date", "---\n日期: '2026-02-30'\n---\n# Bad\n"),
        ("bad-multi", "---\n标签: [其他]\n---\n# Bad\n"),
        ("bad-url", "---\n网址: 'https://bad url'\n---\n# Bad\n"),
        ("bad-type", "---\n评分: 4\nflowix_property_types:\n  评分: Text\n---\n# Bad\n"),
        ("bad-null-type", "---\n评分: null\nflowix_property_types:\n  评分: Text\n---\n# Bad\n"),
        ("bad-type-mapping", "---\n评分: 4\nflowix_property_types: Text\n---\n# Bad\n"),
    ] {
        fs::write(&bad, content).unwrap();
        let (ok, result) = run(&config, &["collection", "add-note", "--notebook", "book", "--id", id, "--title", name, "--file", bad.to_str().unwrap()]);
        assert!(!ok, "{name}: {result}");
    }
    let note = temp.path().join("good.md");
    fs::write(&note, "---\n状态: 完成\n评分: 4.5\n标签: [写作]\n已核验: true\n日期: '2026-11-19'\nflowix_property_types:\n  状态: Select\n  评分: Number\n  标签: MultiSelect\n  已核验: Boolean\n  日期: Date\n---\n# 测试产品\n").unwrap();
    let (ok, added) = run(&config, &["collection", "add-note", "--notebook", "book", "--id", id, "--title", "测试产品", "--file", note.to_str().unwrap()]);
    assert!(ok, "{added}");
    let (ok, result) = run(&config, &["collection", "query", "--notebook", "book", "--id", id]);
    assert!(ok, "{result}");
    assert_eq!(result["page"]["total"], 1);
    assert!(result["items"][0]["modifiedMs"].as_u64().is_some());
    for field in created["fields"].as_array().unwrap() {
        let id = field["id"].as_str().unwrap();
        match field["property_key"].as_str().unwrap() {
            "状态" => assert_eq!(result["items"][0]["properties"][id], "完成"),
            "评分" => assert_eq!(result["items"][0]["properties"][id], 4.5),
            "标签" => assert_eq!(result["items"][0]["properties"][id], serde_json::json!(["写作"])),
            "已核验" => assert_eq!(result["items"][0]["properties"][id], true),
            "日期" => assert_eq!(result["items"][0]["properties"][id], "2026-11-19"),
            _ => {}
        }
    }
    let (ok, selected) = run(&config, &["collection", "query", "--notebook", "book", "--id", id, "--fields", "评分,状态", "--sort", "评分:desc"]);
    assert!(ok, "{selected}");
    assert_eq!(selected["items"][0]["properties"].as_object().unwrap().len(), 2);
}
