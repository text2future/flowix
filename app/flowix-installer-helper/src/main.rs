mod cli;

use clap::ArgMatches;
use flowix_installer_helper::{close_target_executable, log, update_result, EXIT_ENUMERATION};
use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};

fn main() {
    let matches = cli::command().try_get_matches().unwrap_or_else(|error| {
        let code = if error.use_stderr() {
            EXIT_ENUMERATION
        } else {
            0
        };
        let _ = error.print();
        std::process::exit(code);
    });
    let (name, args) = matches.subcommand().expect("clap requires a subcommand");
    let log_path = matches
        .get_one::<PathBuf>("log")
        .cloned()
        .unwrap_or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("FlowixData/app-update.log")
        });
    let source = matches.get_one::<String>("source").unwrap();
    log(
        &log_path,
        &format!(
            "installer-check-start command={name} source={source} version={}",
            env!("CARGO_PKG_VERSION")
        ),
    );

    // Only prepare owns this error handoff. Other subcommands cannot erase it.
    let error_file = if name == "prepare" {
        args.get_one::<PathBuf>("error-file")
    } else {
        None
    };
    if let Some(path) = error_file {
        let _ = std::fs::remove_file(path);
    }
    if let Err((code, message)) = execute(name, args, &log_path) {
        log(
            &log_path,
            &format!("helper-failed command={name} code={code} reason={message}"),
        );
        if let Some(path) = error_file {
            let text = message.replace(['\r', '\n'], " ");
            let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let _ = std::fs::write(path, bytes);
        }
        eprintln!("{message}");
        std::process::exit(code);
    }
}

fn execute(name: &str, args: &ArgMatches, log_path: &Path) -> Result<(), (i32, String)> {
    let io_error = |error: io::Error| (EXIT_ENUMERATION, error.to_string());
    match name {
        #[cfg(windows)]
        "prepare" => flowix_installer_helper::prepare_install(
            args.get_one::<PathBuf>("target").unwrap(),
            args.get_one::<PathBuf>("main-executable").unwrap(),
            duration(args, "timeout-ms"),
            duration(args, "interval-ms"),
            log_path,
        )
        .map_err(|e| (e.code, e.message)),
        "close-cli" => close_target_executable(
            args.get_one::<PathBuf>("target").unwrap(),
            duration(args, "timeout-ms"),
            duration(args, "interval-ms"),
            log_path,
        )
        .map_err(|e| (e.exit_code(), format!("{e:?}"))),
        "record-update" => {
            let status = match args.get_one::<String>("status").unwrap().as_str() {
                "success" => update_result::Status::Success,
                "failed" => update_result::Status::Failed,
                _ => unreachable!("clap validates status"),
            };
            let message = read_message(args).map_err(io_error)?;
            update_result::finish(
                args.get_one::<PathBuf>("state-dir").unwrap(),
                args.get_one::<String>("version").unwrap(),
                args.get_one::<String>("attempt-id")
                    .filter(|id| !id.is_empty())
                    .map(String::as_str),
                status,
                &message,
            )
            .map_err(io_error)
        }
        "clear-update" => {
            update_result::clear(args.get_one::<PathBuf>("state-dir").unwrap()).map_err(io_error)
        }
        _ => Err((EXIT_ENUMERATION, format!("unsupported command: {name}"))),
    }
}

fn duration(args: &ArgMatches, name: &str) -> Duration {
    Duration::from_millis(*args.get_one::<u64>(name).unwrap())
}

fn read_message(args: &ArgMatches) -> io::Result<String> {
    if let Some(path) = args.get_one::<PathBuf>("message-file") {
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() % 2 == 0 => {
                let text: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|v| u16::from_le_bytes([v[0], v[1]]))
                    .collect();
                return String::from_utf16(&text)
                    .map(|s| s.trim().to_string())
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid UTF-16 installer error file",
                ))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(args.get_one::<String>("message").unwrap().clone())
}
