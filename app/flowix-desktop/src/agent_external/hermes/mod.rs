mod history;

// History API 鈹€鈹€ 璇?~/.hermes/ 涓嬬殑 session 瀵煎嚭 / list 鍛戒护杈撳嚭銆?
pub use history::{get_session, get_session_page, is_hermes_session_id, list_sessions};

// CLI runtime 鈹€鈹€ spawn `hermes` binary 瀛愯繘绋? stdout 涓嶈В鏋愪负 JSON, 鎸?plain
// assistant text 绱姞 (鏈?8 MiB 鍏滃簳)銆傚悓 claude 涓€鏍峰鐢?shared 妯″潡銆?
pub mod cli;
pub use cli::HermesCliManager;
