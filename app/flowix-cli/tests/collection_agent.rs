use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::{json, Value};
use std::{fs, path::Path, process::{Command, Output, Stdio}};

fn invoke(config: &Path, root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_flowix-cli")).current_dir(root).env("FLOWIX_HOME", config).args(args).arg("--json").output().unwrap()
}
fn parsed(output: Output) -> (bool, Value) {
    (output.status.success(), serde_json::from_slice(&output.stdout).unwrap())
}

#[test]
fn structured_records_are_typed_filterable_and_retry_safe() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("book");
    let config = temp.path().join("config");
    fs::create_dir_all(&root).unwrap();
    MemoFile::new(config.clone()).write_notebook_configs(&[NotebookConfig { id: "book".into(), name: "Book".into(), icon: None, path: root.to_string_lossy().into_owned(), is_default: true, sort: 0, created_at: 0, updated_at: 0 }]).unwrap();
    let fields = temp.path().join("fields.json");
    fs::write(&fields, r#"[{"name":"状态","type":"Select","options":["订阅","免费"]},{"name":"分数","type":"Number"},{"name":"领域","type":"MultiSelect","options":["写作","校对"]}]"#).unwrap();
    let (ok, created) = parsed(invoke(&config, &root, &["collection", "create", "--name", "产品", "--fields-file", fields.to_str().unwrap()]));
    assert!(ok, "{created}");
    let id = created["collectionId"].as_str().unwrap();
    let input = temp.path().join("record.json");
    fs::write(&input, serde_json::to_vec(&json!({"title":"产品 A","properties":{"状态":"订阅","分数":4.5,"领域":["写作"]},"content":"记录正文"})).unwrap()).unwrap();
    let args = ["collection", "add", "--id", id, "--file", input.to_str().unwrap(), "--request-id", "stable-1", "--json"];
    let children: Vec<_> = (0..4).map(|_| Command::new(env!("CARGO_BIN_EXE_flowix-cli")).env("FLOWIX_HOME", &config).current_dir(&root).args(args).stdout(Stdio::piped()).spawn().unwrap()).collect();
    let values: Vec<_> = children.into_iter().map(|child| parsed(child.wait_with_output().unwrap())).collect();
    for (ok, value) in &values { assert!(ok, "{value}"); assert_eq!(value["note"]["address"], values[0].1["note"]["address"]); }
    let address = values[0].1["note"]["address"].as_str().unwrap();
    // Simulate a process dying after creating the note but before linking it.
    let collection = root.join("产品.index.yaml");
    let mut document: Value = serde_yaml::from_str(&fs::read_to_string(&collection).unwrap()).unwrap();
    document["payload"]["dataset"]["records"]["include"] = json!([]);
    fs::write(&collection, serde_yaml::to_string(&document).unwrap()).unwrap();
    let (ok, recovered) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap(), "--request-id", "stable-1"]));
    assert!(ok, "{recovered}");
    assert_eq!(recovered["note"]["address"], address);
    let (ok, shown) = parsed(invoke(&config, &root, &["show", address]));
    assert!(ok, "{shown}");
    assert_eq!(shown["note"]["properties"]["flowix_property_types"]["状态"], "Select");
    let (ok, query) = parsed(invoke(&config, &root, &["collection", "query", "--id", id, "--where", "状态=订阅", "--where", "分数=4.5"]));
    assert!(ok, "{query}");
    assert_eq!(query["page"]["total"], 1);
    assert_eq!(query["items"][0]["propertiesByKey"]["领域"], json!(["写作"]));
    let options = created["fields"].as_array().unwrap().iter().find(|field| field["property_key"] == "状态").unwrap()["options"].as_array().unwrap();
    fs::write(&input, serde_json::to_vec(&json!({"title":"选项 ID","properties":{"状态":options[0]["id"]}})).unwrap()).unwrap();
    let (ok, value) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap(), "--request-id", "option-id"]));
    assert!(ok, "{value}");
    let (ok, by_label) = parsed(invoke(&config, &root, &["collection", "query", "--id", id, "--where", "状态=订阅"]));
    assert!(ok, "{by_label}");
    assert_eq!(by_label["page"]["total"], 2);
    let option_filter = format!("状态={}", options[0]["id"].as_str().unwrap());
    let (ok, by_id) = parsed(invoke(&config, &root, &["collection", "query", "--id", id, "--where", &option_filter]));
    assert!(ok, "{by_id}");
    assert_eq!(by_id["page"]["total"], 2);
    fs::write(&input, r#"{"title":"产品 A","properties":{"状态":"免费"}}"#).unwrap();
    let (ok, conflict) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap(), "--request-id", "stable-1"]));
    assert!(!ok, "{conflict}");
    assert_eq!(conflict["error"]["code"], "REQUEST_ID_CONFLICT");
    fs::write(&input, r#"{"title":"B","properties":{"分数":"错误"}}"#).unwrap();
    let (ok, invalid) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap()]));
    assert!(!ok, "{invalid}");
    assert_eq!(invalid["error"]["code"], "INVALID_FIELD_VALUE");
    assert_eq!(invalid["error"]["details"], json!({"field":"分数","expected":"Number"}));
    fs::write(&input, r#"{"title":"B","properties":{"状态":"不存在"}}"#).unwrap();
    let (ok, invalid_option) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap()]));
    assert!(!ok, "{invalid_option}");
    assert_eq!(invalid_option["error"]["details"]["allowed"], json!(["订阅", "免费"]));
    fs::write(&input, serde_json::to_vec(&json!({"title":"产品 A","properties":{"状态":"订阅","分数":4.5,"领域":["写作"]},"content":"记录正文"})).unwrap()).unwrap();
    let relative = address.split_once("::").unwrap().1;
    let renamed = format!("{}/renamed.md", Path::new(relative).parent().unwrap().display());
    fs::rename(root.join(relative), root.join(&renamed)).unwrap();
    flowix_core::collection_store::rebase_collection_paths(&MemoFile::new(config.clone()), "book", relative, &renamed);
    let (ok, retried) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap(), "--request-id", "stable-1"]));
    assert!(ok, "{retried}");
    assert_eq!(retried["note"]["relativePath"], renamed);
    let (ok, after_rename) = parsed(invoke(&config, &root, &["collection", "query", "--id", id]));
    assert!(ok, "{after_rename}");
    assert_eq!(after_rename["page"]["total"], 2);
    let removed_content = fs::read(root.join(&renamed)).unwrap();
    fs::remove_file(root.join(&renamed)).unwrap();
    let (ok, missing) = parsed(invoke(&config, &root, &["collection", "add", "--id", id, "--file", input.to_str().unwrap(), "--request-id", "stable-1"]));
    assert!(!ok, "{missing}");
    assert_eq!(missing["error"]["code"], "REQUEST_ID_CONFLICT");
    assert!(!root.join(&renamed).exists());
    let (ok, partial) = parsed(invoke(&config, &root, &["collection", "query", "--id", id]));
    assert!(ok, "{partial}");
    assert_eq!(partial["complete"], false);
    assert_eq!(partial["diagnostics"][0]["code"], "NOTE_MISSING");
    let items = partial["items"].as_array().unwrap();
    assert!(items.iter().any(|item| item["state"] == "missing" && item["read"]["available"] == false));
    assert!(items.iter().any(|item| item["state"] == "available"));
    let (ok, filtered) = parsed(invoke(&config, &root, &["collection", "query", "--id", id, "--where", "状态=订阅"]));
    assert!(ok, "{filtered}");
    assert_eq!(filtered["complete"], false);
    assert_eq!(filtered["page"]["total"], 1);
    assert_eq!(filtered["diagnostics"][0]["code"], "NOTE_MISSING");
    let snapshot = filtered["snapshot"].as_str().unwrap();
    fs::write(root.join(&renamed), removed_content).unwrap();
    let (ok, changed) = parsed(invoke(&config, &root, &["collection", "query", "--id", id, "--where", "状态=订阅", "--snapshot", snapshot]));
    assert!(!ok, "{changed}");

    let document: Value = serde_yaml::from_str(&fs::read_to_string(&collection).unwrap()).unwrap();
    let old_schema = document["payload"]["dataset"]["schema"].clone();
    fs::write(&fields, r#"[{"name":"插件","property_key":"flowix_plugin","type":"Text"}]"#).unwrap();
    let (ok, reserved) = parsed(invoke(&config, &root, &["collection", "add-fields", "--id", id, "--fields-file", fields.to_str().unwrap()]));
    assert!(!ok, "{reserved}");
    fs::write(&fields, r#"[{"name":"备注","type":"Text"}]"#).unwrap();
    let (ok, added) = parsed(invoke(&config, &root, &["collection", "add-fields", "--id", id, "--fields-file", fields.to_str().unwrap()]));
    assert!(ok, "{added}");
    let error = flowix_core::collection_store::add_note_with_request_schema(
        &MemoFile::new(config.clone()), "book", Some(id), None, "过期记录", "正文", Some("stale-schema"), Some(&old_schema),
    ).unwrap_err();
    assert!(error.contains("COLLECTION_SCHEMA_CHANGED"), "{error}");
    let (ok, after_conflict) = parsed(invoke(&config, &root, &["collection", "query", "--id", id]));
    assert!(ok, "{after_conflict}");
    assert_eq!(after_conflict["page"]["total"], 2);
}

#[test]
fn current_directory_takes_precedence_over_default_notebook() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    let nested = second.join("nested");
    let config = temp.path().join("config");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&nested).unwrap();
    let notebook = |id: &str, path: &Path, default: bool| NotebookConfig { id: id.into(), name: id.into(), icon: None, path: path.to_string_lossy().into_owned(), is_default: default, sort: 0, created_at: 0, updated_at: 0 };
    MemoFile::new(config.clone()).write_notebook_configs(&[notebook("first", &first, true), notebook("second", &second, false)]).unwrap();
    let (ok, created) = parsed(invoke(&config, &nested, &["collection", "create", "--name", "当前笔记本"]));
    assert!(ok, "{created}");
    assert_eq!(created["notebookId"], "second");
    assert!(second.join("当前笔记本.index.yaml").exists());
    assert!(!first.join("当前笔记本.index.yaml").exists());
}
