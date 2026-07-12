//! Configuration & access-control layer for the agent runtime.
//!
//! Four closely related concerns live here:
//!
//! - [`user`] — user-level settings: AI model config (toml), preferences
//!   (json), theme, agent persona. Persisted at `~/.flowix/agent-config.toml`
//!   and `~/.flowix/boot/preference.json`. Owns the `atomic_write_json`
//!   helper used by sibling stores.
//! - [`access`] — agent-access registry: which folders + notebooks the AI
//!   agent is allowed to see. Persisted at `~/.flowix/agent-access.json`.
//!   Distinct from notebook.json so users can grant/revoke AI access without
//!   touching the notebook registry itself.
//! - [`path_scope`] — tiny pure helper: is `path` inside `root`? Used by
//!   access checks, dialog code, and security-bookmark filtering.
//! - [`security_bookmark`] — macOS security-scoped bookmarks for
//!   user-selected directories that survive across launches. Sibling of
//!   `user`/`access` but only meaningful on macOS; on other platforms the
//!   store is still constructed but never gains entries.
//!
//! All four write through `user::atomic_write_json` so disk failures never
//! leave the in-memory state ahead of disk.

pub mod access;
pub mod path_scope;
pub mod security_bookmark;
pub mod user;

// Re-export the public surface at the `config::` namespace so callers can
// write `crate::config::UserConfigStore` without dropping into `user`.
pub use access::{AgentAccessConfig, AgentAccessEntry, AgentAccessKind, AgentAccessStore};
pub use path_scope::path_is_inside;
pub use security_bookmark::{pick_directory_with_bookmark, SecurityBookmarkStore};
pub use user::{
    AiConfigFile, AiModelConfig, PersonalizeConfig, PreferenceFile, ProductUpdatesConfig,
    PropertiesConfig, PropertyFieldConfig, FormatConfig, AgentsConfig, Theme, UserConfigError,
    UserConfigStore,
};