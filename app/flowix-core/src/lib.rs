//! `flowix-core` — Flowix business core library.
//!
//! Zero Tauri dependencies — can be compiled, tested, and consumed
//! independently by the CLI, the Tauri desktop app, and any future
//! MCP / HTTP frontends.
//!
//! ## Public modules
//!
//! - [`memo_file`] — note / notebook storage layer (memo index / todo metadata /
//!   .md on-disk IO). Originally lived inside the backend crate, split out
//!   so the CLI can share it without pulling in the Tauri runtime.
//! - [`search`]    — in-memory full-text search (BigramTokenizer + MemoIndex).
//! - [`secret`]    - 敏感凭据存储适配层 (本地 SQLite `default.db` 的
//!   key-value 表), 通过 `SecretStore` 抽象让 desktop 与 CLI 共用。

pub mod memo_file;
pub mod search;
pub mod secret;
pub mod service;

pub use service::{FlowixError, MemoService};
