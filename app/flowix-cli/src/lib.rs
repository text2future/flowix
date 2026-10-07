//! `flowix-cli` 库入口.
//!
//! CLI 解析、调度、存储操作和 MCP 协议拆在独立模块里，便于分别测试。

pub mod cli;
pub(crate) mod collection_store;
pub mod errors;
pub mod fmt;
pub mod mcp;
pub(crate) mod operation;
pub(crate) mod output;
pub(crate) mod path_store;
pub mod paths;
pub mod plugin;
pub mod store;

mod dispatch;

pub use dispatch::run_cli;
pub use errors::CliError;
