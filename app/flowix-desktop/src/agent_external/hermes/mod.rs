mod history;

// History API ── 读 ~/.hermes/ 下的 session 导出 / list 命令输出。
pub use history::{get_session, get_session_page, is_hermes_session_id, list_sessions};

// CLI runtime ── spawn `hermes` binary 子进程, stdout 不解析为 JSON, 按 plain
// assistant text 累加 (有 8 MiB 兜底)。同 claude 一样复用 shared 模块。
pub mod cli;
pub use cli::HermesCliManager;
