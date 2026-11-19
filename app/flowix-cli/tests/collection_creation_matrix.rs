use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, process::{Command, Output, Stdio}};

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let root = temp.path().join("book");
    fs::create_dir_all(&root).unwrap();
    MemoFile::new(config.clone()).write_notebook_configs(&[NotebookConfig {
        id: "book".into(), name: "Book".into(), icon: None,
        path: root.to_string_lossy().into_owned(), is_default: true,
        sort: 0, created_at: 0, updated_at: 0,
    }]).unwrap();
    (temp, config, root)
}

fn command(config: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_flowix-cli"));
    cmd.env("FLOWIX_HOME", config).args(args).arg("--json");
    cmd
}

fn result(output: Output) -> (bool, Value) {
    let value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&output.stderr)));
    (output.status.success(), value)
}

#[test]
fn all_supported_field_types_round_trip() {
    let (temp, config, _) = fixture();
    let fields_path = temp.path().join("fields.json");
    fs::write(&fields_path, serde_json::to_vec(&json!([
        {"name":"文本","type":"Text"}, {"name":"网站","type":"URL"},
        {"name":"图标","type":"Icon"}, {"name":"启用","type":"Boolean"},
        {"name":"分数","type":"Number"}, {"name":"日期","type":"Date"},
        {"name":"状态","type":"Select","options":["待办","完成"]},
        {"name":"场景","type":"MultiSelect","options":["写作","营销"]},
        {"name":"主题","type":"Tag"}, {"name":"颜色","type":"Color"},
        {"name":"图片","type":"Image"}
    ])).unwrap()).unwrap();
    let (ok, created) = result(command(&config, &["collection", "create", "--notebook", "book", "--path", "全部类型.index.yaml", "--fields-file", fields_path.to_str().unwrap()]).output().unwrap());
    assert!(ok, "{created}");
    let id = created["collectionId"].as_str().unwrap();
    let (ok, listed) = result(command(&config, &["collection", "list", "book"]).output().unwrap());
    assert!(ok, "{listed}");
    assert!(listed["items"].as_array().unwrap().iter().any(|item| item["collectionId"] == id));
    let (ok, described) = result(command(&config, &["collection", "describe", "--notebook", "book", "--id", id]).output().unwrap());
    assert!(ok, "{described}");
    assert_eq!(described["domains"][0]["schema"]["fields"].as_array().unwrap().len(), 12);
    assert_eq!(described["views"][0]["config"]["visible_fields"].as_array().unwrap().len(), 12);
    let (ok, read) = result(command(&config, &["collection", "read", "--notebook", "book", "--id", id]).output().unwrap());
    assert!(ok, "{read}");
    assert_eq!(read["collection"]["id"], id);
    let input = temp.path().join("note.md");
    fs::write(&input, "---\n文本: 说明\n网站: https://example.com\n图标: star\n启用: false\n分数: 3.25\n日期: '2026-11-19'\n状态: 完成\n场景: [写作, 营销]\n主题: [研究, 产品]\n颜色: [red, blue]\n图片: [one.png, two.png]\n---\n# 产品\n").unwrap();
    let (ok, added) = result(command(&config, &["collection", "add-note", "--notebook", "book", "--id", id, "--title", "产品", "--file", input.to_str().unwrap()]).output().unwrap());
    assert!(ok, "{added}");
    let (ok, shown) = result(command(&config, &["show", added["note"]["address"].as_str().unwrap()]).output().unwrap());
    assert!(ok, "{shown}");
    assert_eq!(shown["note"]["properties"]["分数"], 3.25);
    let (ok, queried) = result(command(&config, &["collection", "query", "--notebook", "book", "--id", id]).output().unwrap());
    assert!(ok, "{queried}");
    let expected = json!({"文本":"说明","网站":"https://example.com","图标":"star","启用":false,"分数":3.25,"日期":"2026-11-19","状态":"完成","场景":["写作","营销"],"主题":["研究","产品"],"颜色":["red","blue"],"图片":["one.png","two.png"]});
    for field in created["fields"].as_array().unwrap().iter().skip(1) {
        let key = field["property_key"].as_str().unwrap();
        let field_id = field["id"].as_str().unwrap();
        assert_eq!(queried["items"][0]["properties"][field_id], expected[key], "{key}");
    }
}

#[test]
fn concurrent_create_does_not_overwrite_winner() {
    let (_temp, config, root) = fixture();
    let args = ["collection", "create", "--notebook", "book", "--path", "并发.index.yaml"];
    let children: Vec<_> = (0..4).map(|_| command(&config, &args).stdout(Stdio::piped()).spawn().unwrap()).collect();
    let outcomes: Vec<_> = children.into_iter().map(|child| result(child.wait_with_output().unwrap())).collect();
    assert_eq!(outcomes.iter().filter(|(ok, _)| *ok).count(), 1, "{outcomes:?}");
    let winner = outcomes.iter().find(|(ok, _)| *ok).unwrap().1["collectionId"].as_str().unwrap();
    let (ok, described) = result(command(&config, &["collection", "describe", "--notebook", "book", "--path", "并发.index.yaml"]).output().unwrap());
    assert!(ok, "{described}");
    assert_eq!(described["collection"]["id"], winner);
    assert!(root.join("并发.index.yaml").exists());
}

#[test]
fn parallel_field_and_note_writes_preserve_successful_changes() {
    let (temp, config, _) = fixture();
    let (ok, created) = result(command(&config, &["collection", "create", "--notebook", "book", "--path", "并发写入.index.yaml"]).output().unwrap());
    assert!(ok, "{created}");
    let id = created["collectionId"].as_str().unwrap();
    let a = temp.path().join("a.json");
    let b = temp.path().join("b.json");
    fs::write(&a, r#"[{"name":"甲","type":"Text"}]"#).unwrap();
    fs::write(&b, r#"[{"name":"乙","type":"Boolean"}]"#).unwrap();
    let children: Vec<_> = [&a, &b].iter().map(|file| command(&config, &["collection", "add-fields", "--notebook", "book", "--id", id, "--fields-file", file.to_str().unwrap()]).stdout(Stdio::piped()).spawn().unwrap()).collect();
    let outcomes: Vec<_> = children.into_iter().map(|child| result(child.wait_with_output().unwrap())).collect();
    assert!(outcomes.iter().any(|(ok, _)| *ok), "{outcomes:?}");
    for (ok, value) in &outcomes {
        if !ok { assert_eq!(value["error"]["code"], "CONFLICT", "{value}"); }
    }
    let (ok, described) = result(command(&config, &["collection", "describe", "--notebook", "book", "--id", id]).output().unwrap());
    assert!(ok, "{described}");
    let fields = described["domains"][0]["schema"]["fields"].as_array().unwrap();
    for (ok, value) in &outcomes {
        if *ok { assert!(fields.iter().any(|field| field["id"] == value["fields"][0]["id"]), "{value}"); }
    }
    let input = temp.path().join("note.md");
    fs::write(&input, "# 正文\n").unwrap();
    let children: Vec<_> = (0..4).map(|n| command(&config, &["collection", "add-note", "--notebook", "book", "--id", id, "--title", &format!("记录{n}"), "--file", input.to_str().unwrap()]).stdout(Stdio::piped()).spawn().unwrap()).collect();
    for child in children {
        let (ok, value) = result(child.wait_with_output().unwrap());
        assert!(ok, "{value}");
    }
    let (ok, queried) = result(command(&config, &["collection", "query", "--notebook", "book", "--id", id]).output().unwrap());
    assert!(ok, "{queried}");
    assert_eq!(queried["page"]["total"], 4);
}

#[test]
fn invalid_definitions_do_not_create_partial_collections() {
    let (temp, config, root) = fixture();
    let file = temp.path().join("fields.json");
    for raw in [
        "invalid json",
        r#"{}"#,
        r#"[]"#,
        r#"[{"name":"评分","type":"numeric"}]"#,
        r#"[{"name":"状态","type":"Select","options":["完成","完成"]}]"#,
        r#"[{"name":"状态","type":"Select"}]"#,
        r#"[{"name":"a","property_key":"X","type":"Text"},{"name":"b","property_key":"x","type":"Text"}]"#,
        r#"[{"name":"x","property_key":"flowix_property_types","type":"Text"}]"#,
    ] {
        fs::write(&file, raw).unwrap();
        let (ok, value) = result(command(&config, &["collection", "create", "--notebook", "book", "--path", "invalid.index.yaml", "--fields-file", file.to_str().unwrap()]).output().unwrap());
        assert!(!ok, "{raw}: {value}");
        assert!(!root.join("invalid.index.yaml").exists());
    }
}
