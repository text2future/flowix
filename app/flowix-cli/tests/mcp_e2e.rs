use flowix_core::{
    memo_file::{MemoFile, NotebookConfig},
    NoteService,
};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

fn seed_notebook(config_dir: &std::path::Path, notebook_dir: &std::path::Path) {
    std::fs::create_dir_all(notebook_dir).unwrap();
    let memo_file = MemoFile::new(config_dir.to_path_buf());
    memo_file
        .write_notebook_configs(&[NotebookConfig {
            id: "work".to_string(),
            name: "work".to_string(),
            icon: None,
            path: format!("{}/", notebook_dir.display()),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        }])
        .unwrap();
}

fn spawn_mcp(config_dir: &std::path::Path) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .arg("mcp")
        .env("FLOWIX_HOME", config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, stdout)
}

fn request(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    )
    .unwrap();
    stdin.flush().unwrap();

    let mut response = String::new();
    stdout.read_line(&mut response).unwrap();
    assert!(!response.trim().is_empty());
    serde_json::from_str(&response).unwrap()
}

fn call_tool(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    command: &str,
    content: Option<&str>,
) -> Value {
    let mut arguments = json!({"command": command});
    if let Some(content) = content {
        arguments["stdin"] = Value::String(content.to_string());
    }
    request(
        stdin,
        stdout,
        id,
        "tools/call",
        json!({"name": "memo", "arguments": arguments}),
    )
}

fn call_structured(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    arguments: Value,
) -> Value {
    request(
        stdin,
        stdout,
        id,
        "tools/call",
        json!({"name": "memo", "arguments": arguments}),
    )
}

#[test]
fn mcp_collection_structured_write_and_retry() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config);
    let created = call_structured(
        &mut stdin,
        &mut stdout,
        1,
        json!({"action":"collection.create","path":"产品.index.yaml","fieldDefinitions":[{"name":"状态","type":"Select","options":["完成"]}]}),
    );
    let data = &created["result"]["structuredContent"];
    assert_eq!(data["ok"], true, "{created}");
    let id = data["collectionId"].as_str().unwrap();
    let fields = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({"action":"collection.add-fields","collectionId":id,"fieldDefinitions":[{"name":"评分","type":"Number"}]}),
    );
    assert_eq!(
        fields["result"]["structuredContent"]["ok"], true,
        "{fields}"
    );
    let args = json!({"action":"collection.add","collectionId":id,"requestId":"one","record":{"title":"A","properties":{"状态":"完成","评分":4.5}}});
    let first = call_structured(&mut stdin, &mut stdout, 2, args.clone());
    let retry = call_structured(&mut stdin, &mut stdout, 3, args);
    assert_eq!(first["result"]["structuredContent"]["ok"], true, "{first}");
    assert_eq!(
        first["result"]["structuredContent"]["note"]["address"],
        retry["result"]["structuredContent"]["note"]["address"]
    );
    let queried = call_structured(
        &mut stdin,
        &mut stdout,
        4,
        json!({"action":"collection.query","collectionId":id,"where":["状态=完成"]}),
    );
    assert_eq!(
        queried["result"]["structuredContent"]["page"]["total"], 1,
        "{queried}"
    );
    assert_eq!(
        queried["result"]["structuredContent"]["items"][0]["propertiesByKey"]["状态"],
        "完成"
    );
    assert_eq!(
        queried["result"]["structuredContent"]["items"][0]["propertiesByKey"]["评分"],
        4.5
    );
    let args = json!({"action":"collection.add-note","collectionId":id,"title":"B","content":"body","requestId":"note-1"});
    let first = request(
        &mut stdin,
        &mut stdout,
        6,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    let retry = request(
        &mut stdin,
        &mut stdout,
        7,
        "tools/call",
        json!({"name":"flowix_write","arguments":args}),
    );
    assert_eq!(first["result"]["isError"], false, "{first}");
    assert_eq!(
        first["result"]["structuredContent"]["note"]["address"],
        retry["result"]["structuredContent"]["note"]["address"],
        "{retry}"
    );
    drop(stdin);
    child.wait().unwrap();
}

#[test]
fn mcp_process_initializes_and_exposes_scoped_and_legacy_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let initialized = request(
        &mut stdin,
        &mut stdout,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "flowix-test", "version": "1"}
        }),
    );
    assert_eq!(initialized["jsonrpc"], "2.0");
    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(initialized["result"]["serverInfo"]["name"], "flowix-memo");

    let listed = request(&mut stdin, &mut stdout, 2, "tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 4);
    let tools = vec![tools.last().unwrap().clone()];
    assert_eq!(tools[0]["name"], "memo");
    assert!(tools[0]["inputSchema"]["properties"]["action"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action == "create"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn mcp_tool_creates_reads_and_rejects_shell_syntax() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let created = call_tool(
        &mut stdin,
        &mut stdout,
        1,
        "create work",
        Some("# MCP note\n\ncreated through one tool\n"),
    );
    assert_eq!(created["result"]["isError"], false);
    let address = created["result"]["structuredContent"]["note"]["address"]
        .as_str()
        .unwrap()
        .to_string();

    let shown = call_tool(&mut stdin, &mut stdout, 2, &format!("show {address}"), None);
    assert_eq!(shown["result"]["isError"], false);
    assert!(shown["result"]["structuredContent"]["body"]
        .as_str()
        .unwrap()
        .contains("created through one tool"));

    let rejected = call_tool(&mut stdin, &mut stdout, 3, "show note; rm -rf ~", None);
    assert_eq!(rejected["result"]["isError"], true);
    assert_eq!(
        rejected["result"]["structuredContent"]["error"]["code"],
        "INVALID_COMMAND"
    );
    assert!(rejected["result"]["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("shell syntax"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn structured_actions_create_edit_list_and_show_without_cli_strings() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let created = call_structured(
        &mut stdin,
        &mut stdout,
        1,
        json!({"action":"create", "content":"# 结构化 MCP\n\n首次正确生成\n"}),
    );
    assert_eq!(created["result"]["isError"], false, "{created}");
    let address = created["result"]["structuredContent"]["note"]["address"]
        .as_str()
        .unwrap()
        .to_string();

    let edited = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({"action":"edit", "address":address, "old":"首次正确生成", "content":"结构化编辑成功"}),
    );
    assert_eq!(edited["result"]["isError"], false, "{edited}");

    let listed = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({"action":"list", "limit":1, "offset":0}),
    );
    assert_eq!(
        listed["result"]["structuredContent"]["notes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let tags = call_structured(&mut stdin, &mut stdout, 4, json!({"action":"tags"}));
    assert_eq!(tags["result"]["isError"], false, "{tags}");
    assert!(tags["result"]["structuredContent"]["tags"].is_array());

    let shown = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({"action":"show", "address":address}),
    );
    assert!(shown["result"]["structuredContent"]["body"]
        .as_str()
        .unwrap()
        .contains("结构化编辑成功"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn search_tag_filter_is_shared_by_structured_and_legacy_mcp() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let tagged = call_tool(
        &mut stdin,
        &mut stdout,
        1,
        "create work",
        Some("---\ntags: [项目/Flowix/CLI]\n---\n# 发布计划\n"),
    );
    assert_eq!(tagged["result"]["isError"], false, "{tagged}");

    let untagged = call_tool(
        &mut stdin,
        &mut stdout,
        2,
        "create work",
        Some("# 其他笔记\n\n发布计划在正文中，但没有项目标签。\n"),
    );
    assert_eq!(untagged["result"]["isError"], false, "{untagged}");

    let structured = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({
            "action": "search",
            "query": "发布计划",
            "tag": "#项目/Flowix",
            "limit": 20
        }),
    );
    assert_eq!(structured["result"]["isError"], false, "{structured}");
    assert_eq!(
        structured["result"]["structuredContent"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "{structured}"
    );

    let legacy = call_tool(
        &mut stdin,
        &mut stdout,
        4,
        "search 发布计划 --tag 项目/Flowix --json",
        None,
    );
    assert_eq!(legacy["result"]["isError"], false, "{legacy}");
    assert_eq!(
        legacy["result"]["structuredContent"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let invalid = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({
            "action": "search",
            "query": "发布计划",
            "tag": "项目//Flowix"
        }),
    );
    assert_eq!(invalid["result"]["isError"], true, "{invalid}");
    assert_eq!(
        invalid["result"]["structuredContent"]["error"]["code"],
        "INVALID_COMMAND"
    );
    assert!(invalid["result"]["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("valid tag path"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn concurrent_mcp_processes_do_not_overwrite_each_other() {
    use std::collections::HashSet;
    use std::sync::{Arc, Barrier};
    use std::thread;

    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let barrier = Arc::new(Barrier::new(2));
    let handles = ["first process", "second process"]
        .into_iter()
        .map(|marker| {
            let barrier = barrier.clone();
            let config_dir = config_dir.clone();
            thread::spawn(move || {
                let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
                barrier.wait();
                let response = call_tool(
                    &mut stdin,
                    &mut stdout,
                    1,
                    "create work",
                    Some(&format!("# Concurrent note\n\n{marker}\n")),
                );
                assert_eq!(response["result"]["isError"], false, "{response}");
                drop(stdin);
                assert!(child.wait().unwrap().success());
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().expect("MCP process thread");
    }

    let memo_file = MemoFile::new(config_dir);
    let notes = NoteService::new(&memo_file).list("work").unwrap();
    assert_eq!(notes.len(), 2);
    let filenames = notes
        .iter()
        .map(|note| note.relative_path.clone())
        .collect::<HashSet<_>>();
    assert_eq!(filenames.len(), 2);
    let bodies = notes
        .iter()
        .map(|note| std::fs::read_to_string(notebook_dir.join(&note.relative_path)).unwrap())
        .collect::<Vec<_>>();
    assert!(bodies.iter().any(|body| body.contains("first process")));
    assert!(bodies.iter().any(|body| body.contains("second process")));
}

#[test]
fn structured_create_version_and_argument_error_contract() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    std::fs::create_dir_all(notebook.join("folder")).unwrap();
    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config);
    let created = call_structured(
        &mut stdin,
        &mut stdout,
        1,
        json!({"action":"create","title":"Named","folder":"folder","content":"original"}),
    );
    assert_eq!(
        created["result"]["structuredContent"]["note"]["relativePath"], "folder/Named.md",
        "{created}"
    );
    let address = created["result"]["structuredContent"]["note"]["address"]
        .as_str()
        .unwrap();
    let shown = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({"action":"show","address":address}),
    );
    let version = shown["result"]["structuredContent"]["version"]
        .as_str()
        .unwrap();
    std::fs::write(notebook.join("folder/Named.md"), "external").unwrap();
    let conflict = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({"action":"write","address":address,"content":"replacement","expectedVersion":version}),
    );
    assert_eq!(
        conflict["result"]["structuredContent"]["error"]["code"], "VERSION_CONFLICT",
        "{conflict}"
    );
    let invalid = call_structured(&mut stdin, &mut stdout, 4, json!({"action":"show"}));
    assert_eq!(invalid["result"]["isError"], true, "{invalid}");
    assert_eq!(
        invalid["result"]["structuredContent"]["error"]["code"],
        "INVALID_COMMAND"
    );
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn scoped_tools_enforce_access_and_preconditions() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let mut child = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .arg("mcp")
        .env("FLOWIX_HOME", &config)
        .env("FLOWIX_MCP_ACCESS", "read")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let listed = request(&mut stdin, &mut stdout, 1, "tools/list", json!({}));
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 1);
    for (id, name, action) in [
        (2, "memo", "create"),
        (3, "flowix_write", "create"),
        (4, "flowix_read", "delete"),
    ] {
        let result = request(
            &mut stdin,
            &mut stdout,
            id,
            "tools/call",
            json!({"name":name,"arguments":{"action":action,"content":"x","address":"work::x.md"}}),
        );
        assert_eq!(
            result["result"]["structuredContent"]["error"]["code"], "PERMISSION_DENIED",
            "{result}"
        );
    }
    drop(stdin);
    child.wait().unwrap();

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config);
    for (id, name, args) in [
        (
            5,
            "flowix_write",
            json!({"action":"write","address":"work::x.md","content":"x"}),
        ),
        (
            6,
            "flowix_delete",
            json!({"action":"delete","address":"work::x.md"}),
        ),
        (
            7,
            "flowix_write",
            json!({"action":"collection.add","record":{}}),
        ),
        (
            8,
            "flowix_write",
            json!({"action":"collection.add-note","title":"x","content":"x"}),
        ),
    ] {
        let result = request(
            &mut stdin,
            &mut stdout,
            id,
            "tools/call",
            json!({"name":name,"arguments":args}),
        );
        assert_eq!(
            result["result"]["structuredContent"]["error"]["code"], "PRECONDITION_REQUIRED",
            "{result}"
        );
    }
    drop(stdin);
    child.wait().unwrap();
}

#[test]
fn create_receipt_survives_restart_and_rejects_key_reuse() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let args = json!({"action":"create","title":"Stable","content":"body","requestId":"request-1"});
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let first = request(
        &mut input,
        &mut output,
        1,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    assert_eq!(first["result"]["isError"], false, "{first}");
    drop(input);
    child.wait().unwrap();
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let retry = request(
        &mut input,
        &mut output,
        2,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    assert_eq!(
        first["result"]["structuredContent"],
        retry["result"]["structuredContent"]
    );
    let mut changed = args;
    changed["content"] = json!("different");
    let conflict = request(
        &mut input,
        &mut output,
        3,
        "tools/call",
        json!({"name":"flowix_write","arguments":changed}),
    );
    assert_eq!(
        conflict["result"]["structuredContent"]["error"]["code"], "REQUEST_ID_CONFLICT",
        "{conflict}"
    );
    assert!(!notebook.join("Stable-1.md").exists());
    drop(input);
    child.wait().unwrap();
}

#[test]
fn create_interrupted_or_failed_request_is_not_reexecuted() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let args = json!({"action":"create","folder":"missing","title":"Stable","content":"body","requestId":"unknown"});
    let first = request(
        &mut input,
        &mut output,
        1,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    assert_eq!(first["result"]["isError"], true);
    assert_eq!(
        first["result"]["structuredContent"]["error"]["code"],
        "REQUEST_INDETERMINATE"
    );
    assert!(
        first["result"]["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("io error"),
        "{first}"
    );
    drop(input);
    child.wait().unwrap();
    std::fs::create_dir(notebook.join("missing")).unwrap();
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let second = request(
        &mut input,
        &mut output,
        2,
        "tools/call",
        json!({"name":"flowix_write","arguments":args}),
    );
    assert_eq!(
        second["result"]["structuredContent"]["error"]["code"], "REQUEST_INDETERMINATE",
        "{second}"
    );
    assert!(!notebook.join("missing/Stable.md").exists());
    drop(input);
    child.wait().unwrap();
}

#[test]
fn concurrent_create_with_same_request_id_does_not_duplicate() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let config = config.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let (mut child, mut input, mut output) = spawn_mcp(&config);
            barrier.wait();
            let result = request(&mut input, &mut output, 1, "tools/call", json!({"name":"flowix_write","arguments":{"action":"create","title":"Race","content":"body","requestId":"race"}}));
            drop(input);
            child.wait().unwrap();
            result
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(
        results.iter().any(|r| r["result"]["isError"] == false),
        "{results:?}"
    );
    for result in &results {
        if result["result"]["isError"] == true {
            assert_eq!(
                result["result"]["structuredContent"]["error"]["code"], "REQUEST_INDETERMINATE",
                "{result}"
            );
        }
    }
    assert!(notebook.join("Race.md").exists());
    assert!(!notebook.join("Race-1.md").exists());
}

#[test]
fn artifact_request_replays_across_process_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let plugin = config.join("plugin/plain-report");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("SKILL.md"), "# Plain report\n").unwrap();
    std::fs::write(plugin.join("plugin.json"), r#"{
        "schemaVersion":2,"id":"plain-report","name":"Plain Report","version":"1.0.0","kind":"artifact-tool",
        "ui":{"placement":"sidebar","order":200,"icon":"document"},"input":{"fields":[]},
        "tool":{"command":"flowix plugin create plain-report","input":"stdin","contentType":"text/plain","instructions":"SKILL.md"},
        "discovery":{"noteType":"plain-report"},
        "output":{"format":"text","directory":"ignored-by-host","extension":"txt","renderer":"text","parser":"text"}
    }"#).unwrap();
    let args = json!({"action":"artifact.create","pluginId":"plain-report","content":"# Report\nDone","requestId":"artifact-1"});
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let first = request(
        &mut input,
        &mut output,
        1,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    assert_eq!(first["result"]["isError"], false, "{first}");
    drop(input);
    child.wait().unwrap();
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let retry = request(
        &mut input,
        &mut output,
        2,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    assert_eq!(
        first["result"]["structuredContent"],
        retry["result"]["structuredContent"]
    );
    let mut different = args;
    different["content"] = json!("# Different");
    let conflict = request(
        &mut input,
        &mut output,
        3,
        "tools/call",
        json!({"name":"flowix_write","arguments":different}),
    );
    assert_eq!(
        conflict["result"]["structuredContent"]["error"]["code"],
        "REQUEST_ID_CONFLICT"
    );
    drop(input);
    child.wait().unwrap();
}

#[test]
fn request_inspection_and_review_preserve_the_retry_guard() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let args = json!({"action":"create","folder":"missing","title":"Stable","content":"body","requestId":"review-1"});
    let fail = request(
        &mut input,
        &mut output,
        1,
        "tools/call",
        json!({"name":"flowix_write","arguments":args.clone()}),
    );
    assert_eq!(
        fail["result"]["structuredContent"]["error"]["code"],
        "REQUEST_INDETERMINATE"
    );
    let shown = request(
        &mut input,
        &mut output,
        2,
        "tools/call",
        json!({"name":"flowix_read","arguments":{"action":"request.show","notebook":"work","operation":"create","requestId":"review-1"}}),
    );
    let receipt = &shown["result"]["structuredContent"];
    assert_eq!(receipt["state"], "uncertain", "{shown}");
    assert_eq!(receipt["targetHint"]["title"], "Stable");
    assert!(receipt["createdAt"].is_string());
    assert!(receipt["errorSummary"].is_string());
    let cli_list = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .env("FLOWIX_HOME", &config)
        .args(["request", "list", "--state", "uncertain", "--json"])
        .output()
        .unwrap();
    assert!(
        cli_list.status.success(),
        "{}",
        String::from_utf8_lossy(&cli_list.stderr)
    );
    let cli_list: Value = serde_json::from_slice(&cli_list.stdout).unwrap();
    assert_eq!(cli_list["requests"][0]["requestId"], "review-1");
    let cli_show = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .env("FLOWIX_HOME", &config)
        .args([
            "request",
            "show",
            "review-1",
            "--notebook",
            "work",
            "--operation",
            "create",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        cli_show.status.success(),
        "{}",
        String::from_utf8_lossy(&cli_show.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&cli_show.stdout).unwrap()["state"],
        "uncertain"
    );
    let listing = request(
        &mut input,
        &mut output,
        3,
        "tools/call",
        json!({"name":"flowix_read","arguments":{"action":"request.list","state":"uncertain"}}),
    );
    assert_eq!(
        listing["result"]["structuredContent"]["requests"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    std::fs::write(notebook.join("Evidence.md"), "evidence").unwrap();
    let review = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .env("FLOWIX_HOME", &config)
        .args([
            "request",
            "review",
            "review-1",
            "--notebook",
            "work",
            "--operation",
            "create",
            "--outcome",
            "confirmed",
            "--actor",
            "test",
            "--evidence",
            "work::Evidence.md",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        review.status.success(),
        "{}",
        String::from_utf8_lossy(&review.stdout)
    );
    let reviewed: Value = serde_json::from_slice(&review.stdout).unwrap();
    assert_eq!(reviewed["state"], "uncertain");
    assert_eq!(reviewed["reviews"][0]["outcome"], "confirmed");
    let retry = request(
        &mut input,
        &mut output,
        4,
        "tools/call",
        json!({"name":"flowix_write","arguments":args}),
    );
    assert_eq!(
        retry["result"]["structuredContent"]["error"]["code"],
        "REQUEST_INDETERMINATE"
    );
    drop(input);
    child.wait().unwrap();
}

#[test]
fn legacy_receipts_are_readable_and_migrated_without_fabricated_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let db = rusqlite::Connection::open(config.join("agent-requests.sqlite3")).unwrap();
    db.execute_batch("CREATE TABLE requests(notebook_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT, PRIMARY KEY(notebook_id,operation,request_id)); INSERT INTO requests VALUES('work','create','old','hash',NULL);").unwrap();
    drop(db);
    let (mut child, mut input, mut output) = spawn_mcp(&config);
    let shown = request(
        &mut input,
        &mut output,
        1,
        "tools/call",
        json!({"name":"flowix_read","arguments":{"action":"request.show","notebook":"work","operation":"create","requestId":"old"}}),
    );
    assert_eq!(
        shown["result"]["structuredContent"]["state"], "uncertain",
        "{shown}"
    );
    assert!(shown["result"]["structuredContent"]["createdAt"].is_null());
    let review = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .env("FLOWIX_HOME", &config)
        .args([
            "request",
            "review",
            "old",
            "--notebook",
            "work",
            "--operation",
            "create",
            "--outcome",
            "unresolved",
            "--actor",
            "test",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        review.status.success(),
        "{}",
        String::from_utf8_lossy(&review.stdout)
    );
    let shown = request(
        &mut input,
        &mut output,
        2,
        "tools/call",
        json!({"name":"flowix_read","arguments":{"action":"request.show","notebook":"work","operation":"create","requestId":"old"}}),
    );
    assert_eq!(
        shown["result"]["structuredContent"]["reviews"][0]["outcome"],
        "unresolved"
    );
    drop(input);
    child.wait().unwrap();
}

#[test]
fn readonly_receipt_queries_do_not_create_a_ledger() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let notebook = tmp.path().join("work");
    seed_notebook(&config, &notebook);
    let mut child = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .arg("mcp")
        .env("FLOWIX_HOME", &config)
        .env("FLOWIX_MCP_ACCESS", "read")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let result = request(
        &mut input,
        &mut output,
        1,
        "tools/call",
        json!({"name":"flowix_read","arguments":{"action":"request.list"}}),
    );
    assert_eq!(
        result["result"]["structuredContent"]["requests"],
        json!([]),
        "{result}"
    );
    assert!(!config.join("agent-requests.sqlite3").exists());
    drop(input);
    child.wait().unwrap();
}
