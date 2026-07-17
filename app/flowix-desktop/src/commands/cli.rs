//! Standalone CLI installation/status IPC commands.
//!
//! The desktop no longer starts a `flowix-cli serve` sidecar. The packaged CLI remains
//! available for terminal and MCP use, and this module only manages its PATH entry.

#[tauri::command]
pub fn cli_link_status() -> crate::cli_link::CliLinkStatus {
    crate::cli_link::cli_link_status()
}

#[tauri::command]
pub fn install_cli_path() -> Result<crate::cli_link::CliLinkStatus, String> {
    crate::cli_link::install_cli_path()
}
