use std::process::{Command, Output};

fn cli(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .args(args)
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn binary_prints_version_and_help() {
    let version = cli(&["--version"]);
    assert!(version.status.success());
    assert!(stdout(&version).starts_with("flowix "));

    let help = cli(&["--help"]);
    assert!(help.status.success());
    let text = stdout(&help);
    assert!(text.contains("Usage:"));
    assert!(text.contains("Commands:"));
    assert!(text.contains("create"));
    assert!(text.contains("defaults to the current notebook"));
    assert!(text.contains("--file is recommended"));
}

#[test]
fn content_commands_recommend_utf8_files() {
    let create = cli(&["create", "--help"]);
    assert!(create.status.success());
    assert!(stdout(&create).contains("Recommended"));

    let write = cli(&["write", "--help"]);
    assert!(write.status.success());
    assert!(stdout(&write).contains("Recommended"));
}

#[test]
fn binary_describes_builtin_mindmap_tool() {
    let output = cli(&["plugin", "describe", "mindmap", "--json"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let value: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(value["id"], "mindmap");
    assert_eq!(value["kind"], "artifact-tool");
    assert_eq!(value["input"], "stdin");
}

#[test]
fn binary_describes_builtin_webpage_tool() {
    let output = cli(&["plugin", "describe", "webpage", "--json"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let value: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(value["id"], "webpage");
    assert_eq!(value["contentType"], "text/html");
    assert_eq!(value["renderer"], "webpage");
}

#[test]
fn binary_reports_usage_errors_with_expected_exit_code() {
    let missing = cli(&["show"]);
    assert_eq!(missing.status.code(), Some(2));
    assert!(stderr(&missing).contains("Usage: flowix show"));
    assert!(stderr(&missing).contains("<NOTEBOOK::RELATIVE-PATH-OR-ABSOLUTE-PATH>"));

    let unknown = cli(&["unknown-command"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert!(stderr(&unknown).contains("unrecognized subcommand"));
}

#[test]
fn binary_reports_json_errors_with_stable_shape() {
    let output = cli(&[
        "create",
        "work",
        "--file",
        "definitely-missing-flowix-input.md",
        "--json",
    ]);
    assert_eq!(output.status.code(), Some(5));
    assert!(stderr(&output).is_empty());

    let value: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "IO_ERROR");
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("failed to read input file"));
}

#[cfg(windows)]
#[test]
fn windows_rejects_implicit_create_and_write_stdin() {
    for args in [
        ["create", "any-notebook", "--json"],
        ["write", "any-note", "--json"],
    ] {
        let output = cli(&args);
        assert_eq!(output.status.code(), Some(2));
        assert!(stderr(&output).is_empty());
        let value: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "INVALID_COMMAND");
        assert!(value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("stdin input is disabled by default on Windows"));
    }
}

#[test]
fn binary_generates_shell_completions() {
    let bash = cli(&["completion", "bash"]);
    assert!(bash.status.success());
    let bash_text = stdout(&bash);
    assert!(bash_text.contains("flowix"));
    assert!(bash_text.contains("notebooks"));

    let zsh = cli(&["completion", "zsh"]);
    assert!(zsh.status.success());
    let zsh_text = stdout(&zsh);
    assert!(zsh_text.contains("#compdef flowix"));

    let fish = cli(&["completion", "fish"]);
    assert!(fish.status.success());
    let fish_text = stdout(&fish);
    assert!(fish_text.contains("complete -c flowix"));
}
