//! Compatibility boundary for the Desktop plugin module.
//!
//! Manifest parsing is shared with the CLI in `flowix-plugin-runtime`; this
//! module keeps the existing Desktop import paths stable while the host-only
//! plugin code continues to own lifecycle and IPC concerns.

pub(crate) use flowix_plugin_runtime::{
    validate_manifest, PluginDefinition, PluginManifest, PluginParser, PluginRuntime,
};
