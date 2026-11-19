//! `flowix component` ── notebook-local static HTML component catalog.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{errors::CliError, path_store, store};

const FORMAT_VERSION: u32 = 1;
const MAX_SOURCE_BYTES: usize = 64 * 1024;
const HEADER_PREFIX: &str = "<!-- flowix:component ";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentMeta {
    format_version: u32,
    id: String,
    name: String,
    version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentEntry {
    id: String,
    name: String,
    version: u32,
    file: String,
}

pub(crate) fn cmd_catalog(json: bool) -> Result<(), CliError> {
    let catalog = serde_json::json!({
        "protocol": "flowix.component",
        "version": FORMAT_VERSION,
        "storage": "<notebook>/.flowix/editor-components/<id>.html",
        "source": "A static HTML fragment with its CSS in a <style> element or style attributes.",
        "preview": "Rendered in a sandboxed iframe; scripts are disabled. An optional data-flowix-preview-height attribute on the root element sets the preview height in pixels (clamped to 160–960).",
        "limits": { "maxSourceBytes": MAX_SOURCE_BYTES },
        "sourceFile": "Pass a plain UTF-8 HTML fragment; the CLI adds the Flowix metadata header.",
        "commands": [
            "flowix component create <id> --name <name> --file <utf8-html-file> [--notebook <name|id>]",
            "flowix component list --notebook <name|id> --json",
            "flowix component validate <utf8-html-file> --json"
        ],
        "rules": [
            "Use a stable id containing only ASCII letters, digits, hyphens, or underscores.",
            "Keep all visual styles inside the component's HTML; do not rely on the editor's page CSS.",
            "Set data-flowix-preview-height on the root element when the component needs more or less than the default preview height.",
            "Markdown stores the readable HTML/CSS snapshot inside a <flowix-component-block> HTML block (not a Base64 comment).",
            "Use static HTML and CSS. JavaScript, script elements, inline event handlers, and javascript: URLs are rejected.",
            "The editor stores a source snapshot when a component is inserted; later library edits do not change existing notes.",
            "Component ids are unique in a notebook; choose a new id to create another component."
        ],
        "example": "<article style=\"font: 14px/1.5 system-ui; padding: 20px; border-radius: 16px; background: linear-gradient(135deg,#172554,#2563eb); color: white\"><p style=\"margin:0 0 8px;opacity:.72\">TODAY</p><h2 style=\"margin:0 0 12px\">今日计划</h2><p style=\"margin:0\">聚焦一件重要的事，给它留出完整时间。</p></article>"
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&catalog).unwrap());
    } else {
        println!("Flowix HTML components (flowix.component v{FORMAT_VERSION})\n");
        println!("Create:  flowix component create <id> --notebook <name|id> --name <name> --file card.html");
        println!("List:    flowix component list --notebook <name|id>");
        println!("Check:   flowix component validate card.html");
        println!("Example: flowix component create today-plan --name \"今日计划\" --file today-plan.html");
        println!("Storage: <notebook>/.flowix/editor-components/<id>.html");
        println!("Source:  static HTML fragment; keep styles in <style> or style attributes.");
        println!("Preview: sandboxed iframe; scripts and event handlers are not supported.");
        println!("Height:  optional root data-flowix-preview-height=\"560\" (160–960 px).");
        println!("Markdown: readable HTML/CSS snapshot inside a <flowix-component-block> HTML block.");
        println!("Limit:   {MAX_SOURCE_BYTES} source bytes per component.");
        println!("The inserted node stores a snapshot. Replacing a library component does not change existing notes.");
    }
    Ok(())
}

pub(crate) fn cmd_create(
    notebook: Option<&str>,
    id: &str,
    name: &str,
    file: Option<&str>,
    stdin: bool,
    json: bool,
) -> Result<(), CliError> {
    validate_id(id)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.contains("--") {
        return Err(CliError::Usage(
            "component name must contain 1–120 characters and cannot include `--`".into(),
        ));
    }
    let input = path_store::read_input(file, stdin, "component create")?;
    let source = strip_component_header(&input)
        .unwrap_or(input.as_str())
        .trim();
    validate_source(source)?;

    let notebook_id = store::resolve_notebook_key(notebook)?;
    let mf = store::open()?;
    let notebook_config = store::resolve_notebook_config(&mf, &notebook_id)?;
    if !Path::new(&notebook_config.path).is_dir() {
        return Err(CliError::NotFound(format!(
            "notebook directory does not exist: {}",
            notebook_config.path
        )));
    }
    let directory = Path::new(&notebook_config.path).join(".flowix/editor-components");
    fs::create_dir_all(&directory).map_err(|error| io_error(&directory, error))?;
    let target = directory.join(format!("{id}.html"));
    if target.exists() {
        return Err(CliError::Usage(format!(
            "component `{id}` already exists; choose another id"
        )));
    }
    let metadata = ComponentMeta {
        format_version: FORMAT_VERSION,
        id: id.to_owned(),
        name: name.to_owned(),
        version: 1,
    };
    let mut contents = serde_json::to_string(&metadata).map_err(|error| {
        CliError::Other(format!("failed to encode component metadata: {error}"))
    })?;
    contents.insert_str(0, HEADER_PREFIX);
    contents.push_str(" -->\n");
    contents.push_str(source);
    contents.push('\n');
    fs::write(&target, contents.as_bytes()).map_err(|error| io_error(&target, error))?;

    let relative_file = format!(".flowix/editor-components/{id}.html");
    let payload = serde_json::json!({
        "ok": true,
        "action": "component.create",
        "notebook": notebook_config.name,
        "notebookId": notebook_config.id,
        "id": id,
        "name": name,
        "version": 1,
        "file": relative_file,
        "path": target,
    });
    print_payload(payload, json);
    Ok(())
}

pub(crate) fn cmd_list(notebook: Option<&str>, json: bool) -> Result<(), CliError> {
    let notebook_id = store::resolve_notebook_key(notebook)?;
    let mf = store::open()?;
    let notebook_config = store::resolve_notebook_config(&mf, &notebook_id)?;
    let directory = Path::new(&notebook_config.path).join(".flowix/editor-components");
    let mut components = Vec::new();
    if directory.is_dir() {
        let entries = fs::read_dir(&directory).map_err(|error| io_error(&directory, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&directory, error))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("html") {
                continue;
            }
            if let Ok((metadata, _)) = read_component(&path) {
                components.push(ComponentEntry {
                    id: metadata.id,
                    name: metadata.name,
                    version: metadata.version,
                    file: format!(
                        ".flowix/editor-components/{}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    ),
                });
            }
        }
    }
    components.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    let payload = serde_json::json!({
        "ok": true,
        "action": "component.list",
        "notebook": notebook_config.name,
        "notebookId": notebook_config.id,
        "total": components.len(),
        "components": components,
    });
    if json {
        print_payload(payload, true);
    } else if components.is_empty() {
        println!("No components in notebook `{}`.", notebook_config.name);
    } else {
        println!("Components in `{}`:", notebook_config.name);
        for component in components {
            println!(
                "  {} ({}) v{} — {}",
                component.name, component.id, component.version, component.file
            );
        }
    }
    Ok(())
}

pub(crate) fn cmd_validate(file: &str, json: bool) -> Result<(), CliError> {
    let path = PathBuf::from(file);
    let contents = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
    let source = strip_component_header(&contents)
        .unwrap_or(&contents)
        .trim();
    validate_source(source)?;
    let payload = serde_json::json!({ "ok": true, "action": "component.validate", "file": file, "bytes": source.len() });
    print_payload(payload, json);
    Ok(())
}

fn validate_id(id: &str) -> Result<(), CliError> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(CliError::Usage(
            "component id must be 1–80 ASCII letters, digits, hyphens, or underscores".into(),
        ));
    }
    Ok(())
}

fn validate_source(source: &str) -> Result<(), CliError> {
    if source.trim().is_empty() {
        return Err(CliError::Usage("component HTML source is empty".into()));
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(CliError::Usage(format!(
            "component source exceeds the {MAX_SOURCE_BYTES}-byte limit"
        )));
    }
    let lower = source.to_ascii_lowercase();
    if lower.contains("<script") {
        return Err(CliError::Usage(
            "script elements are not supported; components use static HTML and CSS".into(),
        ));
    }
    if lower.contains("javascript:") {
        return Err(CliError::Usage(
            "javascript: URLs are not supported in components".into(),
        ));
    }
    if lower.contains("<flowix-component-block") || lower.contains("</flowix-component-block") {
        return Err(CliError::Usage(
            "the <flowix-component-block> wrapper is reserved for Markdown serialization".into(),
        ));
    }
    if has_inline_event_handler(&lower) {
        return Err(CliError::Usage(
            "inline event handlers are not supported; components use static HTML and CSS".into(),
        ));
    }
    Ok(())
}

fn has_inline_event_handler(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() || bytes[index] == b'<' || bytes[index] == b'/' {
            index += 1;
            continue;
        }
        if (index == 0 || bytes[index - 1].is_ascii_whitespace() || bytes[index - 1] == b'<')
            && bytes[index] == b'o'
            && bytes.get(index + 1) == Some(&b'n')
        {
            let mut end = index + 2;
            while bytes.get(end).is_some_and(u8::is_ascii_alphabetic) {
                end += 1;
            }
            if end > index + 2 {
                while bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
                    end += 1;
                }
                if bytes.get(end) == Some(&b'=') {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

fn strip_component_header(contents: &str) -> Option<&str> {
    let line_end = contents.find('\n')?;
    let header = contents[..line_end].trim_end_matches('\r');
    let encoded = header.strip_prefix(HEADER_PREFIX)?.strip_suffix(" -->")?;
    let metadata: ComponentMeta = serde_json::from_str(encoded).ok()?;
    (metadata.format_version == FORMAT_VERSION).then_some(&contents[line_end + 1..])
}

fn read_component(path: &Path) -> Result<(ComponentMeta, String), CliError> {
    let contents = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let line_end = contents.find('\n').ok_or_else(|| {
        CliError::Usage(format!(
            "{} has no Flowix component metadata header",
            path.display()
        ))
    })?;
    let header = contents[..line_end].trim_end_matches('\r');
    let encoded = header
        .strip_prefix(HEADER_PREFIX)
        .and_then(|value| value.strip_suffix(" -->"))
        .ok_or_else(|| {
            CliError::Usage(format!(
                "{} has no Flowix component metadata header",
                path.display()
            ))
        })?;
    let metadata: ComponentMeta = serde_json::from_str(encoded).map_err(|error| {
        CliError::Usage(format!(
            "invalid component metadata in {}: {error}",
            path.display()
        ))
    })?;
    if metadata.format_version != FORMAT_VERSION {
        return Err(CliError::Usage(format!(
            "unsupported component format in {}",
            path.display()
        )));
    }
    let source = contents[line_end + 1..].trim().to_owned();
    validate_id(&metadata.id)?;
    validate_source(&source)?;
    Ok((metadata, source))
}

fn io_error(path: &Path, error: std::io::Error) -> CliError {
    CliError::Io(std::io::Error::new(
        error.kind(),
        format!("{}: {error}", path.display()),
    ))
}

fn print_payload(payload: serde_json::Value, json: bool) {
    if json {
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
    } else {
        println!(
            "{}",
            payload["path"]
                .as_str()
                .or_else(|| payload["file"].as_str())
                .unwrap_or("ok")
        );
    }
}
