//! `flowix-cli` 独立二进制入口。
//!
//! 与桌面端二进制 `flowix` 共用 `flowix-core` 业务核心, 但**不**启动 Tauri
//! runtime、不注册 plugin、不绑端口 ── 仅做命令行解析 + memo_file IO。
//!
//! 用法见 `print_help()` 或运行 `flowix --help`。

use std::process::ExitCode;

use flowix_cli::run_cli;

fn main() -> ExitCode {
    ensure_utf8_console();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--json" | "-j"));
    match run_cli(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if json {
                // Keep errors parseable for agents/scripts even when the
                // failure happens during argument parsing or input selection.
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": {
                            "code": e.code(),
                            "message": e.to_string(),
                            "details": e.details()
                        }
                    })
                );
            } else {
                eprintln!("flowix: {e}");
            }
            ExitCode::from(e.exit_code())
        }
    }
}

/// Windows: 把当前 console 的输入 / 输出 codepage 切到 UTF-8。
///
/// 笔记一律按 UTF-8 写盘, 但中文 Windows 默认 console 是 GBK (CP936),
/// `println!` 写出的 UTF-8 字节会被终端按 GBK 解码 -> 显示乱码。启动时切一次
/// CP_UTF8 即可; 失败 (无 console / 已是 UTF-8) 静默忽略, 不影响正确性。
///
/// 注意: 这只管 flowix 自己的 console I/O ── 修不了 PowerShell 管道把内容压成
/// ASCII 的 `$OutputEncoding` 问题 (字节到 stdin 前已损毁), 那是调用方责任,
/// 见 `flowix --help` 的 ENCODING 段。
#[cfg(windows)]
fn ensure_utf8_console() {
    use windows_sys::Win32::System::Console::{SetConsoleCP, SetConsoleOutputCP};
    // CP_UTF8 = 65007 ── Win32 codepage 标识符, 跨 SDK 版本稳定。
    // (windows-sys 0.59 没把 CP_UTF8 暴露在 Console 模块, 故就地定义, 免引额外 feature)
    const CP_UTF8: u32 = 65007;
    // SAFETY: 这两个 setter 只设当前进程 console 的 codepage, 无内存 / 句柄风险。
    unsafe {
        let _ = SetConsoleOutputCP(CP_UTF8);
        let _ = SetConsoleCP(CP_UTF8);
    }
}

#[cfg(not(windows))]
fn ensure_utf8_console() {}
