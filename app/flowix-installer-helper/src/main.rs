use std::path::PathBuf;
use std::time::Duration;

use flowix_installer_helper::{
    close_target_cli, log, merge_missing_tree, restore_tree, EXIT_ENUMERATION,
};

fn main() {
    let mut target = None;
    let mut log_path = None;
    let mut source = "installer".to_string();
    let mut version = env!("CARGO_PKG_VERSION").to_string();
    let mut timeout = Duration::from_secs(10);
    let mut interval = Duration::from_millis(200);
    let mut mode = "close-cli".to_string();
    let mut source_path = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--mode" => {
                mode = args
                    .next()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or(mode)
            }
            "--target" => target = args.next().map(PathBuf::from),
            "--source-path" => source_path = args.next().map(PathBuf::from),
            "--log" => log_path = args.next().map(PathBuf::from),
            "--source" => {
                source = args
                    .next()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or(source)
            }
            "--version" => {
                version = args
                    .next()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or(version)
            }
            "--timeout-ms" => timeout = parse_duration(args.next(), timeout),
            "--interval-ms" => interval = parse_duration(args.next(), interval),
            "--help" | "-h" => {
                println!("flowix-installer-helper --mode close-cli --target <flowix-cli.exe> --log <path> [--source installer] [--version <version>] [--timeout-ms 10000] [--interval-ms 200]\nflowix-installer-helper --mode merge-missing --source-path <backup-dir> --target <install-dir> --log <path>\nflowix-installer-helper --mode restore --source-path <backup-dir> --target <install-dir> --log <path>");
                return;
            }
            unexpected => {
                eprintln!("unexpected argument: {unexpected}");
                std::process::exit(EXIT_ENUMERATION);
            }
        }
    }

    let log_path = log_path.unwrap_or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Flowix")
            .join("app-update.log")
    });
    if mode == "merge-missing" || mode == "restore" {
        let (Some(source_path), Some(target)) = (source_path, target) else {
            eprintln!("--mode {mode} requires --source-path and --target");
            std::process::exit(EXIT_ENUMERATION);
        };
        let result = match mode.as_str() {
            "merge-missing" => merge_missing_tree(&source_path, &target, &log_path),
            "restore" => restore_tree(&source_path, &target, &log_path),
            _ => unreachable!(),
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(EXIT_ENUMERATION);
        }
        return;
    }
    if mode != "close-cli" {
        eprintln!("unknown mode: {mode}");
        std::process::exit(EXIT_ENUMERATION);
    }
    let Some(target) = target else {
        eprintln!("missing --target");
        std::process::exit(EXIT_ENUMERATION);
    };
    log(
        &log_path,
        &format!(
            "installer-check-start version={version} source={source} target={} timeout_ms={} interval_ms={}",
            target.display(),
            timeout.as_millis(),
            interval.as_millis()
        ),
    );

    match close_target_cli(&target, timeout, interval, &log_path) {
        Ok(()) => std::process::exit(0),
        Err(error) => {
            log(
                &log_path,
                &format!("close-failed code={} reason={error:?}", error.exit_code()),
            );
            eprintln!("{}", error.user_message());
            std::process::exit(error.exit_code());
        }
    }
}

fn parse_duration(value: Option<std::ffi::OsString>, fallback: Duration) -> Duration {
    value
        .and_then(|value| value.to_string_lossy().parse::<u64>().ok())
        .map(Duration::from_millis)
        .filter(|duration| !duration.is_zero())
        .unwrap_or(fallback)
}
