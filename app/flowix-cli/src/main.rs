//! `flowix-cli` 独立二进制入口。
//!
//! 与桌面端二进制 `flowix` 共用 `flowix-core` 业务核心, 但**不**启动 Tauri
//! runtime、不注册 plugin、不绑端口 ── 仅做命令行解析 + memo_file IO。
//!
//! 用法见 `print_help()` 或运行 `flowix --help`。

use std::process::ExitCode;

use flowix_cli::run_cli;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run_cli(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("flowix: {e}");
            ExitCode::from(e.exit_code())
        }
    }
}
