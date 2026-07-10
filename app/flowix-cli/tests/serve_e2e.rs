use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

fn write_notebook_config(config_dir: &std::path::Path, nb_dir: &std::path::Path) {
    std::fs::create_dir_all(config_dir).unwrap();
    std::fs::create_dir_all(nb_dir).unwrap();
    let config = json!([{
        "id": "work",
        "name": "work",
        "icon": null,
        "path": format!("{}/", nb_dir.display()),
        "isDefault": true,
        "createdAt": 1,
        "updatedAt": 1
    }]);
    std::fs::write(
        config_dir.join("notebook.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
}

fn spawn_server(
    config_dir: &std::path::Path,
    data_dir: &std::path::Path,
) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .arg("serve")
        .env("FLOWIX_HOME", config_dir)
        .env("FLOWIX_DATA", data_dir)
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
    let req = json!({
        "id": id,
        "method": method,
        "params": params,
    });
    writeln!(stdin, "{}", serde_json::to_string(&req).unwrap()).unwrap();
    stdin.flush().unwrap();

    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(
        !line.trim().is_empty(),
        "server should emit a response line"
    );
    serde_json::from_str(line.trim()).unwrap()
}

fn raw_request(stdin: &mut ChildStdin, stdout: &mut BufReader<ChildStdout>, line: &str) -> Value {
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();

    let mut response = String::new();
    stdout.read_line(&mut response).unwrap();
    assert!(
        !response.trim().is_empty(),
        "server should emit a response line"
    );
    serde_json::from_str(response.trim()).unwrap()
}

#[test]
fn serve_process_handles_create_list_and_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let data_dir = tmp.path().join("data");
    let nb_dir = tmp.path().join("notebooks").join("work");
    write_notebook_config(&config_dir, &nb_dir);

    let (mut child, mut stdin, mut stdout) = spawn_server(&config_dir, &data_dir);

    let notebooks = request(&mut stdin, &mut stdout, 1, "notebooks.list", json!({}));
    assert_eq!(notebooks["id"], 1);
    assert_eq!(notebooks["result"][0]["id"], "work");

    let created = request(
        &mut stdin,
        &mut stdout,
        2,
        "memo.create",
        json!({"notebook": "work", "body": "# Hello\nbody\n"}),
    );
    assert_eq!(created["id"], 2);
    let note_id = created["result"]["id"].as_str().unwrap().to_string();
    assert!(!note_id.is_empty());

    let listed = request(
        &mut stdin,
        &mut stdout,
        3,
        "memo.list",
        json!({"notebook": "work"}),
    );
    assert_eq!(listed["id"], 3);
    assert_eq!(listed["result"].as_array().unwrap().len(), 1);
    assert_eq!(listed["result"][0]["id"], note_id);

    let shutdown = request(&mut stdin, &mut stdout, 4, "shutdown", json!({}));
    assert_eq!(shutdown["id"], 4);
    assert!(shutdown.get("result").is_some());

    let status = child.wait().unwrap();
    assert!(
        status.success(),
        "serve process should exit cleanly: {status}"
    );
}

#[test]
fn serve_process_reports_error_envelopes() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let data_dir = tmp.path().join("data");
    let nb_dir = tmp.path().join("notebooks").join("work");
    write_notebook_config(&config_dir, &nb_dir);

    let (mut child, mut stdin, mut stdout) = spawn_server(&config_dir, &data_dir);

    let unknown = request(&mut stdin, &mut stdout, 10, "does.not.exist", json!({}));
    assert_eq!(unknown["id"], 10);
    assert_eq!(unknown["error"]["code"], -32601);

    let invalid_params = request(&mut stdin, &mut stdout, 11, "memo.list", json!({}));
    assert_eq!(invalid_params["id"], 11);
    assert_eq!(invalid_params["error"]["code"], -32602);
    assert!(invalid_params["error"]["message"]
        .as_str()
        .unwrap()
        .contains("notebook"));

    let not_found = request(
        &mut stdin,
        &mut stdout,
        12,
        "memo.show",
        json!({"id": "missing"}),
    );
    assert_eq!(not_found["id"], 12);
    assert_eq!(not_found["error"]["code"], -32004);

    let parse_error = raw_request(&mut stdin, &mut stdout, "not json at all");
    assert_eq!(parse_error["error"]["code"], -32700);

    let shutdown = request(&mut stdin, &mut stdout, 13, "shutdown", json!({}));
    assert_eq!(shutdown["id"], 13);
    assert!(shutdown.get("result").is_some());

    let status = child.wait().unwrap();
    assert!(
        status.success(),
        "serve process should exit cleanly after errors: {status}"
    );
}
