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
    assert!(text.contains("USAGE:"));
    assert!(text.contains("COMMANDS:"));
    assert!(text.contains("create <notebook>"));
}

#[test]
fn binary_reports_usage_errors_with_expected_exit_code() {
    let missing = cli(&["list"]);
    assert_eq!(missing.status.code(), Some(2));
    assert!(stderr(&missing).contains("usage: flowix list <notebook>"));

    let unknown = cli(&["unknown-command"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert!(stderr(&unknown).contains("unknown command"));
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
