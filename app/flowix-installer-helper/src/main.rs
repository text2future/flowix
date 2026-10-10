use std::path::PathBuf;
use std::time::Duration;

use flowix_installer_helper::{close_target_executable, log, EXIT_ENUMERATION};

fn main() {
    let mut target = None;
    let mut log_path = None;
    let mut source = "installer".to_string();
    let mut version = env!("CARGO_PKG_VERSION").to_string();
    let mut timeout = Duration::from_secs(10);
    let mut interval = Duration::from_millis(200);
    let mut mode = "close-cli".to_string();
    let mut error_file = None;
    let mut main_executable = None;
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
            "--main-executable" => main_executable = args.next().map(PathBuf::from),
            "--error-file" => error_file = args.next().map(PathBuf::from),
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
                println!("flowix-installer-helper --mode prepare --target <install-dir> --main-executable <filename.exe> --log <path> [--error-file <path>] [--timeout-ms 30000] [--interval-ms 200]\nflowix-installer-helper --mode close-cli --target <executable> --log <path>");
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
            .join("FlowixData")
            .join("app-update.log")
    });
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

    if let Some(path) = &error_file {
        let _ = std::fs::remove_file(path);
    }
    let result: Result<(), (i32, String)> = match mode.as_str() {
        #[cfg(windows)]
        "prepare" => match main_executable.as_deref() {
            Some(name)
                if name.components().count() == 1
                    && matches!(
                        name.components().next(),
                        Some(std::path::Component::Normal(_))
                    ) =>
            {
                flowix_installer_helper::prepare_install(
                    &target, name, timeout, interval, &log_path,
                )
                .map_err(|e| (e.code, e.message))
            }
            _ => Err((
                EXIT_ENUMERATION,
                "prepare requires --main-executable with a filename, not a path".into(),
            )),
        },
        "close-cli" => close_target_executable(&target, timeout, interval, &log_path)
            .map_err(|e| (e.exit_code(), format!("{}: {e:?}", target.display()))),
        _ => Err((EXIT_ENUMERATION, format!("unknown mode: {mode}"))),
    };
    if let Err((code, message)) = result {
        log(
            &log_path,
            &format!("preflight-failed code={code} reason={message}"),
        );
        if let Some(path) = error_file {
            // NSIS Unicode FileReadUTF16LE reads this file without codepage loss.
            let text = message.replace(['\r', '\n'], " ");
            let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let _ = std::fs::write(path, bytes);
        }
        eprintln!("{message}");
        std::process::exit(code);
    }
}

fn parse_duration(value: Option<std::ffi::OsString>, fallback: Duration) -> Duration {
    value
        .and_then(|value| value.to_string_lossy().parse::<u64>().ok())
        .map(Duration::from_millis)
        .filter(|duration| !duration.is_zero())
        .unwrap_or(fallback)
}
