//! Compatibility boundary for the Desktop plugin module.
//!
//! Manifest parsing is shared with the CLI in `flowix-plugin-runtime`; this
//! module keeps the existing Desktop import paths stable while the host-only
//! plugin code continues to own lifecycle and IPC concerns.

pub(crate) use flowix_plugin_runtime::{
    is_relative_plugin_path, valid_plugin_id, validate_manifest, PluginAgent, PluginDefinition,
    PluginDiscovery, PluginEngines, PluginExecution, PluginField, PluginInput, PluginIntegrity,
    PluginManifest, PluginOption, PluginOutput, PluginParser, PluginRuntime, PluginTool, PluginUi,
};
