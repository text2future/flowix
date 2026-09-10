//! Non-agent plugin artifact runtime shared by the Desktop host and Flowix CLI.
//!
//! This crate deliberately has no Tauri or model-runtime dependency. Callers
//! provide final artifact content; the runtime validates it, writes the hidden
//! artifact, and creates the user-facing Flowix pointer note.

use flowix_core::memo_file::{atomic_write_bytes, MemoFile, NotebookConfig};
use flowix_core::MemoService;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

mod manifest;
pub use manifest::*;

pub const MINDMAP_PLUGIN_ID: &str = "mindmap";
pub const MINDMAP_VERSION: &str = "0.2.0";
pub const MINDMAP_NOTE_TYPE: &str = "mindmap";
pub const MINDMAP_RENDERER: &str = "markmap";
pub const MINDMAP_PARSER: &str = "mindmap-markdown";
pub const MINDMAP_OUTPUT_DIRECTORY: &str = ".flowix/plugin/mindmap";

pub const WEBPAGE_PLUGIN_ID: &str = "webpage";
pub const WEBPAGE_VERSION: &str = "0.1.0";
pub const WEBPAGE_NOTE_TYPE: &str = "webpage";
pub const WEBPAGE_RENDERER: &str = "webpage";
pub const WEBPAGE_PARSER: &str = "html";
pub const WEBPAGE_OUTPUT_DIRECTORY: &str = ".flowix/plugin/webpage";

pub const MINDMAP_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "mindmap",
  "name": "思维导图",
  "version": "0.2.0",
  "kind": "artifact-tool",
  "ui": { "placement": "sidebar", "order": 100, "icon": "mindmap" },
  "input": { "fields": [] },
  "tool": {
    "command": "flowix plugin create mindmap",
    "input": "stdin",
    "contentType": "text/markdown",
    "instructions": "SKILL.md"
  },
  "discovery": { "noteType": "mindmap" },
  "output": {
    "format": "markdown",
    "directory": ".flowix/plugin/mindmap",
    "extension": ".md",
    "renderer": "markmap",
    "parser": "mindmap-markdown"
  }
}"#;

pub const WEBPAGE_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "webpage",
  "name": "网页",
  "version": "0.1.0",
  "kind": "artifact-tool",
  "ui": { "placement": "sidebar", "order": 110, "icon": "webpage" },
  "input": { "fields": [] },
  "tool": {
    "command": "flowix plugin create webpage",
    "input": "stdin",
    "contentType": "text/html",
    "instructions": "SKILL.md"
  },
  "discovery": { "noteType": "webpage" },
  "output": {
    "format": "html",
    "directory": ".flowix/plugin/webpage",
    "extension": ".html",
    "renderer": "webpage",
    "parser": "html"
  }
}"#;

pub const MINDMAP_SKILL: &str = r#"# Mindmap Artifact Tool

Use this tool only when the user explicitly asks to create or generate a mind map.

Prepare the complete Markmap-compatible Markdown yourself, then pass it to
`flowix plugin create mindmap --notebook <name|id|path>` through stdin.

Input contract:

1. The input must contain exactly one level-one heading, used as the root node.
2. Use level-two/level-three headings and unordered lists for branches.
3. Keep node text concise; do not place explanatory paragraphs around the map.
4. Do not wrap the input in a Markdown code fence.
5. The CLI creates the artifact and its Flowix document. Do not create either file manually.
"#;

pub const WEBPAGE_SKILL: &str = r#"# Webpage Artifact Tool

Use this tool only when the user explicitly asks to create a webpage artifact.

Prepare one complete, self-contained HTML document, then pass it to
`flowix plugin create webpage --notebook <name|id|path>` through stdin.

Input contract:

1. Include `<!doctype html>`, `<html>`, `<head>`, a non-empty `<title>`, and `<body>`.
2. Inline required CSS, JavaScript, images, and data whenever practical.
3. Do not use Markdown code fences or explanatory text around the HTML.
4. Do not depend on Flowix or Tauri APIs, the parent window, or local filesystem paths.
5. The CLI creates the artifact and its Flowix index document. Do not create either file manually.
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolDescription {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub command: String,
    pub input: String,
    pub content_type: String,
    pub parser: String,
    pub renderer: String,
    pub output_directory: String,
    pub instructions: String,
}

pub fn builtin_tools() -> Vec<PluginToolDescription> {
    vec![mindmap_description(), webpage_description()]
}

pub fn describe_tool(id: &str) -> Option<PluginToolDescription> {
    match id {
        MINDMAP_PLUGIN_ID => Some(mindmap_description()),
        WEBPAGE_PLUGIN_ID => Some(webpage_description()),
        _ => None,
    }
}

fn webpage_description() -> PluginToolDescription {
    PluginToolDescription {
        id: WEBPAGE_PLUGIN_ID.into(),
        name: "网页".into(),
        version: WEBPAGE_VERSION.into(),
        kind: "artifact-tool".into(),
        command: "flowix plugin create webpage --notebook <name|id|path>".into(),
        input: "stdin".into(),
        content_type: "text/html".into(),
        parser: WEBPAGE_PARSER.into(),
        renderer: WEBPAGE_RENDERER.into(),
        output_directory: WEBPAGE_OUTPUT_DIRECTORY.into(),
        instructions: WEBPAGE_SKILL.into(),
    }
}

fn mindmap_description() -> PluginToolDescription {
    PluginToolDescription {
        id: MINDMAP_PLUGIN_ID.into(),
        name: "思维导图".into(),
        version: MINDMAP_VERSION.into(),
        kind: "artifact-tool".into(),
        command: "flowix plugin create mindmap --notebook <name|id|path>".into(),
        input: "stdin".into(),
        content_type: "text/markdown".into(),
        parser: MINDMAP_PARSER.into(),
        renderer: MINDMAP_RENDERER.into(),
        output_directory: MINDMAP_OUTPUT_DIRECTORY.into(),
        instructions: MINDMAP_SKILL.into(),
    }
}

#[derive(Debug, Clone)]
struct ArtifactDefinition {
    description: PluginToolDescription,
    note_type: String,
    extension: String,
}

#[derive(Debug, Default, Deserialize)]
struct InstalledPluginState {
    #[serde(default)]
    disabled: HashSet<String>,
}

pub fn plugin_is_enabled(config_dir: &Path, id: &str) -> bool {
    fs::read_to_string(config_dir.join("plugin").join("state.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<InstalledPluginState>(&raw).ok())
        .is_none_or(|state| !state.disabled.contains(id))
}

/// Discover declaration-only artifact tools from `<config>/plugin`.
/// Invalid packages are ignored so one broken third-party plugin cannot make
/// the CLI unavailable.
pub fn installed_tools(config_dir: &Path) -> Vec<PluginToolDescription> {
    let root = config_dir.join("plugin");
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut tools = entries
        .filter_map(Result::ok)
        .filter_map(|entry| load_installed_definition(&entry.path()).ok())
        .filter(|definition| plugin_is_enabled(config_dir, &definition.description.id))
        .map(|definition| definition.description)
        .collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    tools
}

pub fn describe_installed_tool(config_dir: &Path, id: &str) -> Option<PluginToolDescription> {
    if !plugin_is_enabled(config_dir, id) {
        return None;
    }
    load_installed_definition(&config_dir.join("plugin").join(id))
        .ok()
        .map(|definition| definition.description)
}

fn load_installed_definition(path: &Path) -> Result<ArtifactDefinition, String> {
    let root = path
        .parent()
        .ok_or_else(|| "plugin path is invalid".to_string())?;
    let root_metadata =
        fs::symlink_metadata(root).map_err(|error| format!("inspect plugin directory: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("plugin directory is invalid".into());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("inspect plugin: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("plugin path is invalid".into());
    }
    let expected_id = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "plugin path is invalid".to_string())?;
    let raw = fs::read_to_string(path.join("plugin.json"))
        .map_err(|error| format!("read plugin manifest: {error}"))?;
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|error| format!("parse plugin manifest: {error}"))?;
    let validated = validate_manifest(&manifest)?;
    verify_plugin_integrity(path, &manifest)?;
    if manifest.schema_version != 2 || manifest.kind != "artifact-tool" {
        return Err("CLI supports schema v2 artifact-tool plugins".into());
    }
    if expected_id != manifest.id || !valid_plugin_id(&manifest.id) {
        return Err("plugin id does not match its installation directory".into());
    }
    let tool = manifest
        .tool
        .ok_or_else(|| "artifact-tool requires tool".to_string())?;
    let instruction_path = path.join(&tool.instructions);
    let instruction_metadata = fs::symlink_metadata(&instruction_path)
        .map_err(|error| format!("inspect plugin instructions: {error}"))?;
    if instruction_metadata.file_type().is_symlink()
        || !instruction_metadata.is_file()
        || !path_is_inside(&instruction_path, path)
    {
        return Err("plugin instructions are invalid".into());
    }
    let instructions = fs::read_to_string(&instruction_path)
        .map_err(|error| format!("read plugin instructions: {error}"))?;
    let parser = validated.parser.key().to_string();
    let extension = validated.extension.trim_start_matches('.').to_string();
    let note_type = validated.note_type;
    let output_directory = format!(".flowix/plugin/{}", manifest.id);
    Ok(ArtifactDefinition {
        description: PluginToolDescription {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            kind: manifest.kind,
            command: tool.command,
            input: tool.input,
            content_type: tool.content_type,
            parser,
            renderer: manifest.output.renderer,
            output_directory,
            instructions,
        },
        note_type,
        extension,
    })
}

fn verify_plugin_integrity(path: &Path, manifest: &PluginManifest) -> Result<(), String> {
    let Some(integrity) = &manifest.integrity else {
        return Ok(());
    };
    for (relative, expected) in &integrity.files {
        let file = path.join(relative);
        let metadata = fs::symlink_metadata(&file)
            .map_err(|error| format!("inspect integrity file {relative}: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || !path_is_inside(&file, path)
        {
            return Err(format!("plugin integrity file is invalid: {relative}"));
        }
        let actual = format!(
            "{:x}",
            Sha256::digest(
                &fs::read(&file)
                    .map_err(|error| format!("read integrity file {relative}: {error}"))?,
            )
        );
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("plugin integrity mismatch: {relative}"));
        }
    }
    Ok(())
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    path.starts_with(root)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMindmap {
    pub content: String,
    pub title: String,
}

/// Normalize Agent output before applying the artifact contract. Direct CLI
/// input remains strict; Agent output may contain a short explanation and a
/// single Markdown code fence.
pub fn parse_agent_artifact(parser: PluginParser, raw: &str) -> Result<ParsedMindmap, String> {
    let normalized = raw.trim().replace("\r\n", "\n");
    let content = if let Some(start) = normalized.find("```") {
        let after_open = normalized[start..]
            .find('\n')
            .map(|offset| start + offset + 1)
            .ok_or_else(|| "plugin response has an invalid code fence".to_string())?;
        let end = normalized[after_open..]
            .find("```")
            .ok_or_else(|| "plugin response has an unclosed code fence".to_string())?;
        normalized[after_open..after_open + end].trim().to_string()
    } else {
        normalized
    };
    match parser {
        PluginParser::MindmapMarkdown => {
            let root = content
                .lines()
                .position(|line| line.trim_start().starts_with("# "))
                .ok_or_else(|| "mindmap response must contain a level-one heading".to_string())?;
            let content = content
                .lines()
                .skip(root)
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            if content.len() > 200_000 {
                return Err("mindmap response is too large".into());
            }
            let title = artifact_title(&content, "mindmap");
            Ok(ParsedMindmap { content, title })
        }
        PluginParser::Markdown => {
            if content.is_empty() {
                return Err("plugin markdown output is empty".into());
            }
            if content.len() > 200_000 {
                return Err("plugin markdown output is too large".into());
            }
            let title = artifact_title(&content, "output");
            Ok(ParsedMindmap { content, title })
        }
        PluginParser::Json => {
            let value: serde_json::Value = serde_json::from_str(&content)
                .map_err(|error| format!("plugin output is invalid JSON: {error}"))?;
            let title = value
                .get("title")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("JSON output")
                .to_string();
            let content = serde_json::to_string_pretty(&value)
                .map_err(|error| format!("format plugin JSON output: {error}"))?;
            Ok(ParsedMindmap { content, title })
        }
        PluginParser::Html | PluginParser::Text => {
            if content.is_empty() {
                return Err("plugin output is empty".into());
            }
            if content.len() > 1_000_000 {
                return Err("plugin output is too large".into());
            }
            Ok(ParsedMindmap {
                content,
                title: if parser == PluginParser::Html {
                    "HTML output"
                } else {
                    "Plugin output"
                }
                .into(),
            })
        }
    }
}

fn artifact_title(content: &str, fallback: &str) -> String {
    content
        .lines()
        .find(|line| line.trim_start().starts_with("# "))
        .map(|line| line.trim_start_matches('#').trim())
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// Validate final tool input. Unlike the legacy agent-output parser, this is
/// intentionally strict: a tool caller must submit only the final map.
pub fn parse_mindmap_input(raw: &str) -> Result<ParsedMindmap, String> {
    let content = raw.trim().replace("\r\n", "\n");
    if content.is_empty() {
        return Err("mindmap input is empty".to_string());
    }
    if content.len() > 200_000 {
        return Err("mindmap input is too large (maximum 200000 bytes)".to_string());
    }
    if content.contains("```") {
        return Err("mindmap input must not use Markdown code fences".to_string());
    }

    let roots = content
        .lines()
        .filter_map(|line| line.strip_prefix("# ").map(str::trim))
        .collect::<Vec<_>>();
    if roots.is_empty() {
        return Err("mindmap input must contain one level-one heading".to_string());
    }
    if roots.len() != 1 {
        return Err("mindmap input must contain exactly one level-one heading".to_string());
    }
    if roots[0].is_empty() {
        return Err("mindmap root heading cannot be empty".to_string());
    }
    let first_non_empty = content.lines().find(|line| !line.trim().is_empty());
    if first_non_empty
        .and_then(|line| line.strip_prefix("# "))
        .is_none()
    {
        return Err("mindmap input must start with its level-one root heading".to_string());
    }

    let title = roots[0].to_string();
    Ok(ParsedMindmap { content, title })
}

pub fn parse_webpage_input(raw: &str) -> Result<ParsedMindmap, String> {
    let content = raw.trim().replace("\r\n", "\n");
    if content.is_empty() {
        return Err("webpage input is empty".to_string());
    }
    if content.len() > 1_000_000 {
        return Err("webpage input is too large (maximum 1000000 bytes)".to_string());
    }
    if content.contains("```") {
        return Err("webpage input must not use Markdown code fences".to_string());
    }
    let lower = content.to_ascii_lowercase();
    for required in ["<!doctype html", "<html", "<head", "<body"] {
        if !lower.contains(required) {
            return Err(format!("webpage input must contain {required}"));
        }
    }
    let title_start = lower
        .find("<title")
        .and_then(|start| lower[start..].find('>').map(|offset| start + offset + 1))
        .ok_or_else(|| "webpage input must contain a title element".to_string())?;
    let title_end = lower[title_start..]
        .find("</title>")
        .map(|offset| title_start + offset)
        .ok_or_else(|| "webpage input must contain a closed title element".to_string())?;
    let title = content[title_start..title_end].trim().to_string();
    if title.is_empty() || title.contains('<') || title.contains('>') {
        return Err("webpage title must be non-empty plain text".to_string());
    }
    Ok(ParsedMindmap { content, title })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArtifactPointer {
    pub path: String,
    pub format: String,
    pub parser: String,
    pub renderer: String,
    pub title: String,
    pub content_hash: String,
    pub created_at: String,
    #[serde(default)]
    pub source_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginNoteFrontmatter {
    pub flowix_note_type: String,
    pub flowix_plugin: String,
    pub flowix_plugin_version: String,
    pub flowix_artifact: PluginArtifactPointer,
}

#[derive(Debug, Clone)]
pub struct CreateArtifactRequest<'a> {
    pub plugin_id: &'a str,
    pub notebook: &'a str,
    pub content: &'a str,
    pub source_note: Option<&'a str>,
    pub producer: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPluginArtifact {
    pub ok: bool,
    pub action: &'static str,
    pub plugin_id: String,
    pub note_id: String,
    pub notebook_id: String,
    pub notebook: String,
    pub title: String,
    pub renderer: String,
    pub artifact_path: String,
    pub note_path: String,
}

pub fn create_artifact(
    memo_file: &MemoFile,
    request: CreateArtifactRequest<'_>,
) -> Result<CreatedPluginArtifact, String> {
    let definition = match request.plugin_id {
        MINDMAP_PLUGIN_ID => ArtifactDefinition {
            description: mindmap_description(),
            note_type: MINDMAP_NOTE_TYPE.into(),
            extension: "md".into(),
        },
        WEBPAGE_PLUGIN_ID => ArtifactDefinition {
            description: webpage_description(),
            note_type: WEBPAGE_NOTE_TYPE.into(),
            extension: "html".into(),
        },
        _ => return Err(format!("plugin tool not found: {}", request.plugin_id)),
    };
    create_artifact_from_definition(memo_file, request, definition)
}

pub fn create_installed_artifact(
    memo_file: &MemoFile,
    config_dir: &Path,
    request: CreateArtifactRequest<'_>,
) -> Result<CreatedPluginArtifact, String> {
    if !plugin_is_enabled(config_dir, request.plugin_id) {
        return Err(format!("plugin is disabled: {}", request.plugin_id));
    }
    let definition = load_installed_definition(&config_dir.join("plugin").join(request.plugin_id))
        .map_err(|error| format!("load plugin '{}': {error}", request.plugin_id))?;
    create_artifact_from_definition(memo_file, request, definition)
}

fn create_artifact_from_definition(
    memo_file: &MemoFile,
    request: CreateArtifactRequest<'_>,
    definition: ArtifactDefinition,
) -> Result<CreatedPluginArtifact, String> {
    let description = &definition.description;
    let parsed = parse_final_input(&description.parser, &description.renderer, request.content)?;
    let version = description.version.as_str();
    let note_type = definition.note_type.as_str();
    let renderer = description.renderer.as_str();
    let parser = description.parser.as_str();
    let output_directory = description.output_directory.as_str();
    let format = match parser {
        "mindmap-markdown" | "markdown" => "markdown",
        other => other,
    };
    let extension = definition.extension.as_str();
    let notebook = resolve_notebook(memo_file, request.notebook)?;
    let notebook_path = PathBuf::from(&notebook.path);
    if !notebook_path.is_dir() {
        return Err(format!("notebook path is unavailable: {}", notebook.path));
    }

    let relative_output = Path::new(output_directory);
    if !is_safe_relative_path(relative_output) {
        return Err("plugin output directory is invalid".to_string());
    }
    let output_dir = notebook_path.join(relative_output);
    std::fs::create_dir_all(&output_dir)
        .map_err(|error| format!("create plugin output directory: {error}"))?;
    let canonical_notebook = notebook_path
        .canonicalize()
        .map_err(|error| format!("resolve notebook path: {error}"))?;
    let canonical_output = output_dir
        .canonicalize()
        .map_err(|error| format!("resolve plugin output directory: {error}"))?;
    if !canonical_output.starts_with(&canonical_notebook) {
        return Err("plugin output directory escaped notebook root".to_string());
    }
    let artifact_path = output_file_path(&output_dir, &parsed.title, extension);
    let artifact_document = serialize_artifact_document(
        request.plugin_id,
        version,
        format,
        &parsed.content,
        request.producer,
        request.source_note,
    );
    atomic_write_bytes(&artifact_path, artifact_document.as_bytes())
        .map_err(|error| format!("write plugin artifact: {error}"))?;

    let relative_path = artifact_path
        .strip_prefix(&notebook_path)
        .map_err(|_| "plugin artifact escaped notebook root".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let now = chrono::Local::now().to_rfc3339();
    let pointer = PluginArtifactPointer {
        path: relative_path,
        format: format.to_string(),
        parser: parser.to_string(),
        renderer: renderer.to_string(),
        title: parsed.title.clone(),
        content_hash: artifact_content_hash(&parsed.content),
        created_at: now,
        source_note: request
            .source_note
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    };
    let pointer_body = serialize_pointer_document(request.plugin_id, version, note_type, &pointer)?;
    let created = MemoService::new(memo_file)
        .create_external_memo_named(&notebook.id, &parsed.title, &pointer_body)
        .map_err(|error| {
            let _ = std::fs::remove_file(&artifact_path);
            format!("create plugin document: {error}")
        })?;

    Ok(CreatedPluginArtifact {
        ok: true,
        action: "pluginArtifactCreated",
        plugin_id: request.plugin_id.to_string(),
        note_id: created.memo.id,
        notebook_id: notebook.id,
        notebook: notebook.name,
        title: parsed.title,
        renderer: renderer.to_string(),
        artifact_path: artifact_path.to_string_lossy().to_string(),
        note_path: created.path.to_string_lossy().to_string(),
    })
}

fn parse_final_input(parser: &str, renderer: &str, raw: &str) -> Result<ParsedMindmap, String> {
    match parser {
        "mindmap-markdown" => parse_mindmap_input(raw),
        "html" if renderer == "webpage" => parse_webpage_input(raw),
        "html" => {
            let content = raw.trim().replace("\r\n", "\n");
            if content.is_empty() {
                return Err("html input is empty".into());
            }
            if content.len() > 1_000_000 {
                return Err("html input is too large".into());
            }
            Ok(ParsedMindmap {
                content,
                title: "HTML output".into(),
            })
        }
        "markdown" | "text" => {
            let content = raw.trim().replace("\r\n", "\n");
            if content.is_empty() {
                return Err(format!("{parser} input is empty"));
            }
            if content.len() > 1_000_000 {
                return Err(format!("{parser} input is too large"));
            }
            if content.contains("```") {
                return Err(format!("{parser} input must not use code fences"));
            }
            let title = content
                .lines()
                .find_map(|line| line.strip_prefix("# ").map(str::trim))
                .filter(|title| !title.is_empty())
                .unwrap_or("Plugin output")
                .to_string();
            Ok(ParsedMindmap { content, title })
        }
        "json" => {
            let value: serde_json::Value = serde_json::from_str(raw.trim())
                .map_err(|error| format!("json input is invalid: {error}"))?;
            let title = value
                .get("title")
                .and_then(serde_json::Value::as_str)
                .filter(|title| !title.trim().is_empty())
                .unwrap_or("JSON output")
                .to_string();
            let content = serde_json::to_string_pretty(&value)
                .map_err(|error| format!("format json input: {error}"))?;
            Ok(ParsedMindmap { content, title })
        }
        _ => Err(format!("unsupported plugin output parser: {parser}")),
    }
}

fn resolve_notebook(memo_file: &MemoFile, key: &str) -> Result<NotebookConfig, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("plugin create requires a notebook name, id, or path".to_string());
    }
    let notebooks = memo_file
        .read_notebook_configs()
        .map_err(|error| format!("read notebooks: {error}"))?;
    notebooks
        .into_iter()
        .find(|notebook| {
            notebook.id == key
                || notebook.name == key
                || paths_equal(Path::new(&notebook.path), Path::new(key))
        })
        .ok_or_else(|| format!("notebook not found: {key}"))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if !right.is_absolute() {
        return false;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn output_file_path(output_dir: &Path, title: &str, extension: &str) -> PathBuf {
    let safe_title = title
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(60)
        .collect::<String>();
    output_dir.join(format!(
        "{}-{}-{}.{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        if safe_title.is_empty() {
            "mindmap"
        } else {
            &safe_title
        },
        &uuid::Uuid::new_v4().to_string()[..8],
        extension,
    ))
}

pub fn artifact_content_hash(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

pub fn serialize_artifact_document(
    plugin_id: &str,
    plugin_version: &str,
    format: &str,
    content: &str,
    producer: &str,
    source_note: Option<&str>,
) -> String {
    if format != "markdown" {
        return content.to_string();
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ArtifactMetadata<'a> {
        flowix_plugin: &'a str,
        plugin_version: &'a str,
        agent_type: &'a str,
        created_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_note: Option<&'a str>,
    }

    let source_note = source_note.map(str::trim).filter(|value| !value.is_empty());
    let producer = producer.trim();
    let metadata = ArtifactMetadata {
        flowix_plugin: plugin_id,
        plugin_version,
        agent_type: if producer.is_empty() {
            "agent-cli"
        } else {
            producer
        },
        created_at: chrono::Local::now().to_rfc3339(),
        source_note,
    };
    let yaml = serde_yaml::to_string(&metadata).expect("artifact metadata is serializable");
    format!("---\n{yaml}---\n\n{content}")
}

pub fn serialize_pointer_document(
    plugin_id: &str,
    plugin_version: &str,
    note_type: &str,
    pointer: &PluginArtifactPointer,
) -> Result<String, String> {
    let frontmatter = PluginNoteFrontmatter {
        flowix_note_type: note_type.to_string(),
        flowix_plugin: plugin_id.to_string(),
        flowix_plugin_version: plugin_version.to_string(),
        flowix_artifact: pointer.clone(),
    };
    let yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| format!("serialize plugin document: {error}"))?;
    Ok(format!("---\n{yaml}---\n"))
}

#[cfg(test)]
mod tests {
    use super::{
        create_artifact, create_installed_artifact, describe_installed_tool, installed_tools,
        parse_mindmap_input, parse_webpage_input, serialize_artifact_document,
        CreateArtifactRequest,
    };
    use flowix_core::memo_file::{MemoFile, NotebookConfig};
    use std::path::Path;

    #[test]
    fn accepts_one_root() {
        let parsed = parse_mindmap_input("# Root\n\n## Branch\n- Leaf\n").unwrap();
        assert_eq!(parsed.title, "Root");
    }

    #[test]
    fn rejects_multiple_roots_and_explanation() {
        assert!(parse_mindmap_input("# One\n# Two").is_err());
        assert!(parse_mindmap_input("Here it is\n# Root").is_err());
    }

    #[test]
    fn serializes_markdown_artifact_without_extra_trailing_newline() {
        let content = "# Root\n\n## Branch";
        let document =
            serialize_artifact_document("mindmap", "0.2.0", "markdown", content, "codex", None);
        assert!(document.ends_with(content));
        assert!(!document.ends_with(&format!("{content}\n")));
    }

    #[test]
    fn validates_complete_webpage_and_reads_title() {
        let parsed = parse_webpage_input(
            "<!doctype html><html><head><title>Project Board</title></head><body></body></html>",
        )
        .unwrap();
        assert_eq!(parsed.title, "Project Board");
        assert!(parse_webpage_input("<html><body>missing title</body></html>").is_err());
        assert!(parse_webpage_input("```html\n<!doctype html>\n```").is_err());
    }

    #[test]
    fn creates_artifact_and_external_pointer_note() {
        let temp = tempfile::tempdir().unwrap();
        let notebook_path = temp.path().join("notes");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let memo_file = MemoFile::new(temp.path().join("config"));
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: "work".to_string(),
                name: "Work Notes".to_string(),
                icon: None,
                path: format!("{}/", notebook_path.display()),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();

        let created = create_artifact(
            &memo_file,
            CreateArtifactRequest {
                plugin_id: "mindmap",
                notebook: notebook_path.to_str().unwrap(),
                content: "# Product Plan\n\n## Goals\n- Reliable tools\n",
                source_note: Some("source.md"),
                producer: "codex",
            },
        )
        .unwrap();

        assert!(Path::new(&created.artifact_path).is_file());
        assert!(Path::new(&created.note_path).is_file());
        let artifact = std::fs::read_to_string(&created.artifact_path).unwrap();
        assert!(artifact.contains("flowixPlugin: mindmap"));
        assert!(artifact.contains("agentType: codex"));
        assert!(artifact.contains("# Product Plan"));
        let pointer = std::fs::read_to_string(&created.note_path).unwrap();
        assert!(pointer.contains("flowix_note_type: mindmap"));
        assert!(pointer.contains("renderer: markmap"));
        assert_eq!(
            memo_file.read_all_memos_for_notebook_id(Some("work")).len(),
            1
        );
    }

    #[test]
    fn discovers_and_creates_a_third_party_declaration_tool() {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        let plugin_dir = config_dir.join("plugin").join("plain-report");
        let notebook_path = temp.path().join("notes");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::create_dir_all(&notebook_path).unwrap();
        std::fs::write(plugin_dir.join("SKILL.md"), "# Plain report\n").unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
              "schemaVersion": 2,
              "id": "plain-report",
              "name": "Plain Report",
              "version": "1.0.0",
              "kind": "artifact-tool",
              "ui": { "placement": "sidebar", "order": 200, "icon": "document" },
              "input": { "fields": [] },
              "tool": { "command": "flowix plugin create plain-report", "input": "stdin", "contentType": "text/plain", "instructions": "SKILL.md" },
              "discovery": { "noteType": "plain-report" },
              "output": { "format": "text", "directory": "ignored-by-host", "extension": "txt", "renderer": "text", "parser": "text" }
            }"#,
        )
        .unwrap();

        let tools = installed_tools(&config_dir);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "plain-report");
        assert_eq!(
            describe_installed_tool(&config_dir, "plain-report")
                .unwrap()
                .renderer,
            "text"
        );

        let memo_file = MemoFile::new(&config_dir);
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: "work".into(),
                name: "Work".into(),
                icon: None,
                path: format!("{}/", notebook_path.display()),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();
        let created = create_installed_artifact(
            &memo_file,
            &config_dir,
            CreateArtifactRequest {
                plugin_id: "plain-report",
                notebook: "work",
                content: "# Weekly report\nDone",
                source_note: None,
                producer: "test",
            },
        )
        .unwrap();
        assert_eq!(created.plugin_id, "plain-report");
        assert_eq!(created.renderer, "text");
        assert!(Path::new(&created.artifact_path).is_file());
    }

    #[test]
    fn creates_webpage_artifact_and_pointer_note() {
        let temp = tempfile::tempdir().unwrap();
        let notebook_path = temp.path().join("notes");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let memo_file = MemoFile::new(temp.path().join("config"));
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: "work".to_string(),
                name: "Work Notes".to_string(),
                icon: None,
                path: format!("{}/", notebook_path.display()),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();

        let html = "<!doctype html><html><head><title>Dashboard</title></head><body><script>document.body.dataset.ready='yes'</script></body></html>";
        let created = create_artifact(
            &memo_file,
            CreateArtifactRequest {
                plugin_id: "webpage",
                notebook: notebook_path.to_str().unwrap(),
                content: html,
                source_note: None,
                producer: "codex",
            },
        )
        .unwrap();

        assert_eq!(created.renderer, "webpage");
        assert_eq!(
            std::fs::read_to_string(&created.artifact_path).unwrap(),
            html
        );
        let pointer = std::fs::read_to_string(&created.note_path).unwrap();
        assert!(pointer.contains("flowix_note_type: webpage"));
        assert!(pointer.contains("renderer: webpage"));
        assert!(created.artifact_path.ends_with(".html"));
    }
}
