use clap::{builder::StringValueParser, value_parser, Arg, Command};
use std::path::{Component, PathBuf};

fn path(name: &'static str) -> Arg {
    Arg::new(name)
        .long(name)
        .value_parser(value_parser!(PathBuf))
}

fn version() -> Arg {
    // Empty is intentional for extraction failures before NSIS captures VERSION.
    Arg::new("version")
        .long("version")
        .value_parser(StringValueParser::new())
}

fn process_options(command: Command, timeout: &'static str) -> Command {
    command
        .arg(path("target").required(true))
        .arg(
            Arg::new("timeout-ms")
                .long("timeout-ms")
                .default_value(timeout)
                .value_parser(value_parser!(u64).range(1..)),
        )
        .arg(
            Arg::new("interval-ms")
                .long("interval-ms")
                .default_value("200")
                .value_parser(value_parser!(u64).range(1..)),
        )
}

fn executable_name(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.components().count() == 1
        && matches!(path.components().next(), Some(Component::Normal(_)))
    {
        Ok(path)
    } else {
        Err("main-executable must be a filename under target, not a path".into())
    }
}

pub fn command() -> Command {
    Command::new("flowix-installer-helper")
        .about("Coordinate Flowix installation and update results")
        .subcommand_required(true)
        .arg(path("log").global(true))
        .arg(
            Arg::new("source")
                .long("source")
                .global(true)
                .default_value("installer"),
        )
        .subcommand(
            process_options(
                Command::new("prepare").about("Save/exit Flowix and check replacement files"),
                "30000",
            )
            .arg(
                Arg::new("main-executable")
                    .long("main-executable")
                    .required(true)
                    .value_parser(executable_name),
            )
            .arg(path("error-file")),
        )
        .subcommand(process_options(
            Command::new("close-cli").about("Close only the CLI at the exact target path"),
            "10000",
        ))
        .subcommand(
            Command::new("record-update")
                .about("Complete the matching updater attempt")
                .arg(path("state-dir").required(true))
                .arg(version().required(true))
                .arg(
                    Arg::new("attempt-id")
                        .long("attempt-id")
                        .value_parser(StringValueParser::new()),
                )
                .arg(
                    Arg::new("status")
                        .long("status")
                        .required(true)
                        .value_parser(["success", "failed"]),
                )
                .arg(
                    Arg::new("message")
                        .long("message")
                        .default_value("")
                        .allow_hyphen_values(true),
                )
                .arg(path("message-file")),
        )
        .subcommand(
            Command::new("clear-update")
                .about("Clear stale state after a manual installation")
                .arg(path("state-dir").required(true)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_options_cannot_leak_into_another_operation() {
        for args in [
            vec![
                "helper",
                "clear-update",
                "--state-dir",
                "state",
                "--main-executable",
                "Flowix.exe",
            ],
            vec![
                "helper",
                "prepare",
                "--target",
                "app",
                "--main-executable",
                "Flowix.exe",
                "--status",
                "success",
            ],
            vec![
                "helper",
                "record-update",
                "--state-dir",
                "state",
                "--version",
                "2.0",
                "--status",
                "pending",
            ],
            vec!["helper", "--mode", "prepare"],
            vec!["helper"],
        ] {
            assert!(command().try_get_matches_from(args).is_err());
        }
    }
    #[test]
    fn malformed_or_missing_durations_are_rejected() {
        for values in [
            vec!["--timeout-ms", "0"],
            vec!["--interval-ms", "abc"],
            vec!["--timeout-ms"],
        ] {
            let mut args = vec!["helper", "close-cli", "--target", "Flowix.exe"];
            args.extend(values);
            assert!(command().try_get_matches_from(args).is_err());
        }
    }
    #[test]
    fn early_failure_accepts_an_explicit_empty_version_and_attempt() {
        assert!(command()
            .try_get_matches_from([
                "helper",
                "record-update",
                "--state-dir",
                "state",
                "--version",
                "",
                "--attempt-id",
                "",
                "--status",
                "failed",
            ])
            .is_ok());
    }
}
