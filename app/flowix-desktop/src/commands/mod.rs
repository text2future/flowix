//! Tauri IPC commands grouped by business domain.
//! Commands are registered with their module paths in `app::bootstrap`.
//! Trusted system file-open ingress and its IPC live in `app::open_targets`.

pub mod agent;
pub mod agent_workspace;
pub mod artifact;
pub mod boot;
pub mod cli;
pub mod cloud;
pub mod collection;
pub mod dialog;
pub mod document_list;
pub mod document_operations;
pub mod dsh;
pub mod export;
pub mod external_document;
pub mod external_document_watch;
pub mod file;
pub mod file_browser_watch;
pub mod font;
pub mod helpers;
pub mod kv;
pub mod media;
pub mod market_package;
pub mod memo;
pub mod notebook;
pub mod notebook_template;
pub mod path_change;
pub mod pinned;
pub mod plugin;
pub mod product;
pub mod recovery;
pub mod settings;
pub mod tag;
pub mod thread;
pub mod web;
pub mod window;
pub mod window_input;
pub mod window_shutdown;
