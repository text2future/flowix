use std::path::{Path, PathBuf};

use super::manifest::PluginParser;
use super::PluginDescriptor;

pub(super) use crate::artifact::{
    ArtifactPointer as PluginArtifactPointer, ArtifactPointerMemo as PluginNoteFrontmatter,
};

#[derive(Debug, Clone)]
pub(super) struct ParsedPluginOutput {
    pub(super) content: String,
    pub(super) title: String,
}

pub(super) fn parse_plugin_output(
    plugin: &PluginDescriptor,
    raw: &str,
) -> Result<ParsedPluginOutput, String> {
    let parsed = flowix_plugin_runtime::parse_agent_artifact(plugin.definition.parser, raw)?;
    Ok(ParsedPluginOutput {
        content: parsed.content,
        title: parsed.title,
    })
}

#[cfg(test)]
pub(super) fn parse_mindmap_markdown(raw: &str) -> Result<ParsedPluginOutput, String> {
    shared_parse(PluginParser::MindmapMarkdown, raw)
}

#[cfg(test)]
pub(super) fn parse_json(raw: &str) -> Result<ParsedPluginOutput, String> {
    shared_parse(PluginParser::Json, raw)
}

#[cfg(test)]
pub(super) fn parse_html(raw: &str) -> Result<ParsedPluginOutput, String> {
    shared_parse(PluginParser::Html, raw)
}

#[cfg(test)]
fn shared_parse(parser: PluginParser, raw: &str) -> Result<ParsedPluginOutput, String> {
    let parsed = flowix_plugin_runtime::parse_agent_artifact(parser, raw)?;
    Ok(ParsedPluginOutput {
        content: parsed.content,
        title: parsed.title,
    })
}

#[cfg(test)]
pub(super) fn clean_markdown(raw: &str) -> Result<String, String> {
    parse_mindmap_markdown(raw).map(|parsed| parsed.content)
}

pub(super) fn output_extension(extension: &str) -> String {
    let trimmed = extension.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('.') {
        trimmed.to_string()
    } else {
        format!(".{trimmed}")
    }
}

pub(super) fn output_file_path(output_dir: &Path, title: &str, extension: &str) -> PathBuf {
    let safe_title: String = title
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    let now = chrono::Local::now();
    output_dir.join(format!(
        "{}-{}-{}{}",
        now.format("%Y%m%d-%H%M%S"),
        if safe_title.is_empty() {
            "output"
        } else {
            &safe_title
        },
        &uuid::Uuid::new_v4().to_string()[..8],
        output_extension(extension)
    ))
}

pub(super) fn artifact_document(
    plugin: &PluginDescriptor,
    clean: &str,
    agent_type: &str,
    source_note: Option<&str>,
) -> String {
    flowix_plugin_runtime::serialize_artifact_document(
        &plugin.manifest.id,
        &plugin.manifest.version,
        &plugin.manifest.output.format,
        clean,
        agent_type,
        source_note,
    )
}

pub(super) fn pointer_document(
    plugin: &PluginDescriptor,
    pointer: &PluginArtifactPointer,
) -> Result<String, String> {
    let shared_pointer = flowix_plugin_runtime::PluginArtifactPointer {
        path: pointer.path.clone(),
        format: pointer.format.clone(),
        parser: pointer.parser.clone(),
        renderer: pointer.renderer.clone(),
        title: pointer.title.clone(),
        content_hash: pointer.content_hash.clone(),
        created_at: pointer.created_at.clone(),
        source_note: pointer.source_note.clone(),
    };
    flowix_plugin_runtime::serialize_pointer_document(
        &plugin.manifest.id,
        &plugin.manifest.version,
        &plugin.definition.note_type,
        &shared_pointer,
    )
}

#[cfg(test)]
mod tests {
    use super::{clean_markdown, pointer_document, PluginArtifactPointer};
    use crate::plugin::manifest::{validate_manifest, PluginManifest};
    use crate::plugin::{PluginDescriptor, MINDMAP_MANIFEST};

    #[test]
    fn cleans_markdown_code_fence() {
        assert_eq!(
            clean_markdown("```markdown\n# Root\n\n## Child\n```").unwrap(),
            "# Root\n\n## Child"
        );
    }

    #[test]
    fn serializes_pointer_metadata_as_frontmatter_only() {
        let manifest: PluginManifest = serde_json::from_str(MINDMAP_MANIFEST).unwrap();
        let definition = validate_manifest(&manifest).unwrap();
        let plugin = PluginDescriptor {
            manifest,
            installed_path: "/tmp/mindmap".to_string(),
            skill: String::new(),
            is_system: true,
            enabled: true,
            permissions: Vec::new(),
            integrity_status: "unverified".to_string(),
            definition,
        };
        let pointer = PluginArtifactPointer {
            path: ".flowix/plugin/mindmap/output.md".to_string(),
            format: "markdown".to_string(),
            parser: "mindmap-markdown".to_string(),
            renderer: "markmap".to_string(),
            title: "Roadmap".to_string(),
            content_hash: "sha256:abc".to_string(),
            created_at: "2026-08-13T00:00:00Z".to_string(),
            source_note: None,
        };
        let document = pointer_document(&plugin, &pointer).unwrap();
        assert!(document.starts_with("---\nflowix_note_type: mindmap\n"));
        assert!(document.ends_with("---\n"));
        assert!(!document.contains("# Roadmap"));
    }
}
