//! CLI adapter for declaration-driven artifact tools.

use crate::errors::CliError;
use crate::output::print_pretty_json;
use flowix_plugin_runtime::{
    builtin_tools, create_artifact, create_installed_artifact, describe_installed_tool,
    describe_tool, installed_tools, plugin_is_enabled, CreateArtifactRequest,
    CreatedPluginArtifact, PluginToolDescription,
};

pub fn cmd_list(json: bool) -> Result<(), CliError> {
    let tools = list_data();
    if json {
        print_pretty_json(&tools)
    } else {
        for tool in tools {
            println!("{}\t{}\t{}", tool.id, tool.name, tool.kind);
        }
        Ok(())
    }
}

pub fn cmd_describe(plugin_id: &str, json: bool) -> Result<(), CliError> {
    let tool = describe_data(plugin_id)?;
    if json {
        print_pretty_json(&tool)
    } else {
        println!("{} ({})", tool.name, tool.id);
        println!("  kind:      {}", tool.kind);
        println!("  command:   {}", tool.command);
        println!("  input:     {} ({})", tool.input, tool.content_type);
        println!("  renderer:  {}", tool.renderer);
        println!("  parser:    {}", tool.parser);
        println!("\n{}", tool.instructions.trim());
        Ok(())
    }
}

pub fn cmd_create(
    plugin_id: &str,
    notebook: Option<&str>,
    source_note: Option<&str>,
    producer: &str,
    json: bool,
) -> Result<(), CliError> {
    use std::io::Read;
    let mut content = String::new();
    std::io::stdin()
        .read_to_string(&mut content)
        .map_err(CliError::Io)?;
    let content = content.strip_prefix('\u{FEFF}').unwrap_or(&content);
    let notebook = crate::store::resolve_notebook_key(notebook)?;
    let created = create_data(plugin_id, &notebook, source_note, producer, content)?;
    if json {
        print_pretty_json(&created)
    } else {
        println!("created plugin document: {}", created.note_id);
        println!("  plugin:    {}", created.plugin_id);
        println!("  notebook:  {}", created.notebook);
        println!("  title:     {}", created.title);
        println!("  document:  {}", created.note_path);
        println!("  artifact:  {}", created.artifact_path);
        Ok(())
    }
}

pub(crate) fn list_data() -> Vec<PluginToolDescription> {
    let mut tools = builtin_tools();
    if let Ok(paths) = crate::paths::resolve() {
        tools.retain(|tool| plugin_is_enabled(&paths.config_dir, &tool.id));
        for installed in installed_tools(&paths.config_dir) {
            if !tools.iter().any(|tool| tool.id == installed.id) {
                tools.push(installed);
            }
        }
    }
    tools
}

pub(crate) fn describe_data(plugin_id: &str) -> Result<PluginToolDescription, CliError> {
    if let Ok(paths) = crate::paths::resolve() {
        if !plugin_is_enabled(&paths.config_dir, plugin_id) {
            return Err(CliError::Usage(format!("plugin is disabled: {plugin_id}")));
        }
    }
    describe_tool(plugin_id)
        .or_else(|| {
            crate::paths::resolve()
                .ok()
                .and_then(|paths| describe_installed_tool(&paths.config_dir, plugin_id))
        })
        .ok_or_else(|| CliError::NotFound(format!("plugin tool not found: {plugin_id}")))
}

pub(crate) fn create_data(
    plugin_id: &str,
    notebook: &str,
    source_note: Option<&str>,
    producer: &str,
    content: &str,
) -> Result<CreatedPluginArtifact, CliError> {
    let memo_file = crate::store::open()?;
    let paths = crate::paths::resolve()?;
    if !plugin_is_enabled(&paths.config_dir, plugin_id) {
        return Err(CliError::Usage(format!("plugin is disabled: {plugin_id}")));
    }
    let request = CreateArtifactRequest {
        plugin_id,
        notebook,
        content,
        source_note,
        producer,
    };
    let result = if describe_tool(plugin_id).is_some() {
        create_artifact(&memo_file, request)
    } else {
        create_installed_artifact(&memo_file, &paths.config_dir, request)
    };
    result.map_err(map_runtime_error)
}

fn map_runtime_error(message: String) -> CliError {
    if message.starts_with("plugin tool not found:") || message.starts_with("notebook not found:") {
        CliError::NotFound(message)
    } else if message.starts_with("mindmap ")
        || message.starts_with("webpage ")
        || message.starts_with("load plugin '")
        || message.starts_with("plugin is disabled:")
        || message.starts_with("plugin create requires")
    {
        CliError::Usage(message)
    } else {
        CliError::Other(message)
    }
}
