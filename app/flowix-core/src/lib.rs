//! `flowix-core` — Flowix business core library.
//!
//! Zero Tauri dependencies — can be compiled, tested, and consumed
//! independently by the CLI, the Tauri desktop app, and any future
//! MCP / HTTP frontends.
//!
//! ## Public modules
//!
//! - [`memo_file`] — note / notebook storage layer (index.json / memo.json /
//!   .md on-disk IO). Originally lived inside the backend crate, split out
//!   so the CLI can share it without pulling in the Tauri runtime.
//! - [`search`]    — in-memory full-text search (BigramTokenizer + MemoIndex).

pub mod memo_file;
pub mod search;
