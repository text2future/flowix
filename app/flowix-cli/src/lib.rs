//! `flowix-cli` 库入口.
//!
//! CLI 解析、调度、存储操作和 stdio sidecar 协议拆在独立模块里，便于分别测试。

pub mod cli;
pub mod errors;
pub mod fmt;
pub(crate) mod output;
pub mod paths;
pub mod serve;
pub mod store;

mod dispatch;

pub use dispatch::run_cli;
pub use errors::CliError;
