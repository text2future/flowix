use flowix_core::memo_file::{MemoFile, NotebookConfig};
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
        json!({"name": "flowix_memo", "arguments": arguments}),
    )
}

#[test]
fn mcp_process_initializes_and_exposes_one_tool() {
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
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "flowix_memo");
    assert!(tools[0]["description"]
        .as_str()
        .unwrap()
        .contains("Shell syntax"));

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
    let note_id = created["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let shown = call_tool(&mut stdin, &mut stdout, 2, &format!("show {note_id}"), None);
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
    let list = memo_file
        .read_index_for_notebook_id(Some("work"))
        .unwrap()
        .unwrap();
    assert_eq!(list.memos.len(), 2);
    let filenames = list
        .memos
        .iter()
        .map(|memo| memo.filename.clone())
        .collect::<HashSet<_>>();
    assert_eq!(filenames.len(), 2);
    let bodies = list
        .memos
        .iter()
        .map(|memo| std::fs::read_to_string(notebook_dir.join(&memo.filename)).unwrap())
        .collect::<Vec<_>>();
    assert!(bodies.iter().any(|body| body.contains("first process")));
    assert!(bodies.iter().any(|body| body.contains("second process")));
}
