//! Configuration and access-control layer for the agent runtime.
//!
//! `user` stores user-level preferences; `db/local.db` stores notebook mounts,
//! and `path_scope` provides the shared path containment checks.

pub mod path_scope;
pub mod property_presets;
pub mod security_bookmark;
pub mod user;

pub use path_scope::{path_is_inside, path_is_inside_reserved_directory};
pub use property_presets::{PropertyPresetChange, PropertyPresetRegistry, PropertyPresetStore};
pub use security_bookmark::SecurityBookmarkStore;
pub use user::{
    dsh_credential_ref_for_route, AiConfigFile, AiMemoryLocation, AiModelConfig, AiModelEntry,
    CloudDevRefreshTokenStore, DevCloudEnvironment, PreferenceFile, Theme, UserConfigError,
    UserConfigStore, DSH_SETTINGS_FILE_NAME,
};
pub(crate) use user::{
    merge_harness_provider, DeepSeekHarnessProviderSettings, DeepSeekHarnessSettingsFile,
};
