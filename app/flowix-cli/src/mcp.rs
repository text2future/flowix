//! Model Context Protocol stdio frontend for external Agents.
//!
//! The server intentionally exposes exactly one tool, `memo`. Its input is a
//! restricted Flowix CLI command plus optional stdin content. Commands are parsed into
//! argv and dispatched directly to the typed store layer; no system shell is spawned.

use crate::{cli, errors::CliError, fmt, operation, output, path_store, plugin, store};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};

pub const TOOL_NAME: &str = "memo";
const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    LATEST_PROTOCOL_VERSION,
];

pub const TOOL_DESCRIPTION: &str = "Search and manage Flowix Markdown notes, read table and media library collection datasets by collection ID or notebook-relative path, and use declared artifacts. Delete is destructive.";

/// Run the MCP line-delimited JSON-RPC loop until stdin reaches EOF.
pub fn run_mcp<R: BufRead, W: Write>(reader: R, mut writer: W) -> Result<(), CliError> {
    for line in reader.lines() {
        let line = line.map_err(CliError::Io)?;
        if line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_json_line(
                    &mut writer,
                    &rpc_error(Value::Null, -32700, format!("parse error: {error}")),
                )?;
                continue;
            }
        };

        // MCP notifications do not receive responses.
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

        let response = match method {
            "initialize" => rpc_result(id, initialize_result(&params)),
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({"tools": [tool_definition()]})),
            "tools/call" => match call_tool(&params) {
                Ok(result) => rpc_result(id, result),
                Err(error) => rpc_error(id, -32602, error.to_string()),
            },
            _ => rpc_error(id, -32601, format!("method not found: {method}")),
        };
        write_json_line(&mut writer, &response)?;
    }
    Ok(())
}

fn initialize_result(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let protocol_version = requested
        .filter(|version| SUPPORTED_PROTOCOL_VERSIONS.contains(version))
        .unwrap_or(LATEST_PROTOCOL_VERSION);
    json!({
        "protocolVersion": protocol_version,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {
            "name": "flowix-memo",
            "title": "Flowix Memo",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": "Use the memo tool to search and manage Flowix Markdown memos, read collection datasets with collection.read by collectionId or notebook-relative path, and create declared plugin artifacts such as mind maps."
    })
}

fn tool_definition() -> Value {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../dsh-flowix-memory/memo-tool-schema.json"
    ))
    .expect("memo tool schema must be valid JSON");
    json!({
        "name": TOOL_NAME,
        "title": "Flowix Memo",
        "description": TOOL_DESCRIPTION,
        "inputSchema": schema,
        "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}
    })
}

fn call_tool(params: &Value) -> Result<Value, CliError> {
    let object = params
        .as_object()
        .ok_or_else(|| CliError::Usage("tools/call params must be an object".into()))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Usage("tools/call params.name must be a string".into()))?;
    if name != TOOL_NAME {
        return Err(CliError::Usage(format!("unknown tool: `{name}`")));
    }
    let arguments = object
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Usage("memo arguments must be an object".into()))?;
    validate_argument_keys(arguments)?;
    if arguments.contains_key("action") && arguments.contains_key("command") {
        return Err(CliError::Usage(
            "memo accepts either structured `action` or legacy `command`, not both".into(),
        ));
    }
    let stdin = match arguments.get("stdin") {
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| CliError::Usage("memo.stdin must be a string".into()))?,
        ),
        None => None,
    };

    let execution = if arguments.contains_key("action") {
        if stdin.is_some() {
            return Err(CliError::Usage(
                "structured actions use `content`; legacy `stdin` is not allowed".into(),
            ));
        }
        operation::execute(parse_structured_operation(arguments)?)
    } else {
        let command = arguments
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::Usage("memo requires `action` or legacy `command`".into()))?;
        execute_command(command, stdin)
    };

    match execution {
        Ok(data) => Ok(tool_result(data, false)),
        Err(error) => {
            let error_data = json!({
                "ok": false,
                "error": {
                    "code": error_code(&error),
                    "message": error.to_string()
                }
            });
            Ok(tool_result(error_data, true))
        }
    }
}

fn validate_argument_keys(arguments: &Map<String, Value>) -> Result<(), CliError> {
    const KEYS: &[&str] = &[
        "action",
        "notebook",
        "address",
        "query",
        "content",
        "old",
        "limit",
        "offset",
        "dryRun",
        "pluginId",
        "sourceNote",
        "producer",
        "collectionId",
        "path",
        "tag",
        "command",
        "stdin",
    ];
    if let Some(key) = arguments.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(CliError::Usage(format!(
            "memo does not accept argument `{key}`"
        )));
    }
    Ok(())
}

fn parse_structured_operation(
    arguments: &Map<String, Value>,
) -> Result<operation::FlowixOperation, CliError> {
    use operation::FlowixOperation;
    let action = required_string(arguments, "action")?;
    let notebook = optional_string(arguments, "notebook")?;
    let content = || required_string(arguments, "content");
    let address = || required_string(arguments, "address");
    let limit = integer(arguments, "limit", 50, 1, 200)?;
    let offset = integer(arguments, "offset", 0, 0, usize::MAX)?;
    let dry_run = boolean(arguments, "dryRun", false)?;
    match action.as_str() {
        "notebooks" => Ok(FlowixOperation::Notebooks),
        "collection.read" => {
            let notebook = required_string(arguments, "notebook")?;
            Ok(FlowixOperation::CollectionRead {
                notebook,
                collection_id: optional_string(arguments, "collectionId")?,
                path: optional_string(arguments, "path")?,
            })
        }
        "list" => Ok(FlowixOperation::List {
            notebook,
            limit,
            offset,
        }),
        "tags" => Ok(FlowixOperation::Tags { notebook }),
        "show" => Ok(FlowixOperation::Show { address: address()? }),
        "search" => Ok(FlowixOperation::Search {
            query: required_string(arguments, "query")?,
            notebook,
            tag: optional_string(arguments, "tag")?,
            limit,
        }),
        "create" => Ok(FlowixOperation::Create {
            notebook,
            content: content()?,
        }),
        "edit" => Ok(FlowixOperation::Edit {
            address: address()?,
            old: required_string(arguments, "old")?,
            replacement: content()?,
            dry_run,
        }),
        "write" => Ok(FlowixOperation::Write {
            address: address()?,
            content: content()?,
        }),
        "delete" => Ok(FlowixOperation::Delete { address: address()? }),
        "artifact.list" => Ok(FlowixOperation::ArtifactList),
        "artifact.describe" => Ok(FlowixOperation::ArtifactDescribe {
            plugin_id: required_string(arguments, "pluginId")?,
        }),
        "artifact.create" => Ok(FlowixOperation::ArtifactCreate {
            plugin_id: required_string(arguments, "pluginId")?,
            notebook,
            source_note: optional_string(arguments, "sourceNote")?,
            producer: optional_string(arguments, "producer")?.unwrap_or_else(|| "agent-mcp".into()),
            content: content()?,
        }),
        _ => Err(CliError::Usage(format!("unknown memo action: `{action}`"))),
    }
}

fn required_string(arguments: &Map<String, Value>, key: &str) -> Result<String, CliError> {
    optional_string(arguments, key)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::Usage(format!("memo.{key} must be a non-empty string")))
}

fn optional_string(arguments: &Map<String, Value>, key: &str) -> Result<Option<String>, CliError> {
    arguments
        .get(key)
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| CliError::Usage(format!("memo.{key} must be a string")))
        })
        .transpose()
}

fn integer(
    arguments: &Map<String, Value>,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, CliError> {
    let value = match arguments.get(key) {
        Some(value) => value
            .as_u64()
            .ok_or_else(|| CliError::Usage(format!("memo.{key} must be an integer")))?
            as usize,
        None => default,
    };
    if value < min || value > max {
        return Err(CliError::Usage(format!(
            "memo.{key} must be between {min} and {max}"
        )));
    }
    Ok(value)
}

fn boolean(arguments: &Map<String, Value>, key: &str, default: bool) -> Result<bool, CliError> {
    arguments
        .get(key)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| CliError::Usage(format!("memo.{key} must be a boolean")))
        })
        .transpose()
        .map(|value| value.unwrap_or(default))
}

fn execute_command(command: &str, stdin: Option<&str>) -> Result<Value, CliError> {
    reject_shell_syntax(command)?;
    let args = shell_words::split(command)
        .map_err(|error| CliError::Usage(format!("invalid command quoting: {error}")))?;
    if args.is_empty() {
        return Err(CliError::Usage("memo.command cannot be empty".into()));
    }
    if args[0] == "flowix" || args[0] == "flowix-cli" {
        return Err(CliError::Usage(
            "omit the leading `flowix`; pass only the subcommand".into(),
        ));
    }
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "help" | "--help" | "-h" | "--version" | "-V"))
    {
        return Err(CliError::Usage(
            "help and version commands are not available through memo".into(),
        ));
    }

    let parsed = cli::parse(&args)?.ok_or_else(|| CliError::Usage("missing command".into()))?;
    match parsed {
        cli::Cli::Notebooks { .. } => {
            reject_stdin(stdin)?;
            let (configs, selected_notebook_id) = store::notebooks_list_data()?;
            let counts = store::notebook_note_counts(&configs)?;
            let tag_counts = store::notebook_tag_counts(&configs)?;
            Ok(fmt::notebooks_to_json(
                &configs,
                &counts,
                &tag_counts,
                selected_notebook_id.as_deref(),
            ))
        }
        cli::Cli::List { notebook, .. } => {
            reject_stdin(stdin)?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            Ok(path_store::list(&notebook)?["notes"].clone())
        }
        cli::Cli::Tags { notebook, .. } => {
            reject_stdin(stdin)?;
            store::notebook_tags(notebook.as_deref())
        }
        cli::Cli::Show { id, .. } => {
            reject_stdin(stdin)?;
            path_store::show(&id)
        }
        cli::Cli::Create { notebook, file, .. } => {
            if file.is_some() {
                return Err(CliError::Usage(
                    "MCP cannot read client-local --file paths; use structured `content`".into(),
                ));
            }
            let body = require_stdin(stdin, "create")?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::create(&notebook, body)
        }
        cli::Cli::Delete { id, .. } => {
            reject_stdin(stdin)?;
            path_store::delete(&id)
        }
        cli::Cli::CollectionRead { notebook, collection_id, path, .. } => {
            reject_stdin(stdin)?;
            operation::execute(operation::FlowixOperation::CollectionRead {
                notebook, collection_id, path,
            })
        }
        cli::Cli::Search {
            query,
            notebook,
            tag,
            limit,
            ..
        } => {
            reject_stdin(stdin)?;
            path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit)
        }
        cli::Cli::Edit {
            id,
            old,
            new,
            new_from_stdin,
            new_file,
            dry_run,
            ..
        } => {
            if new_file.is_some() {
                return Err(CliError::Usage(
                    "MCP cannot read client-local --new-file paths; use structured `content`"
                        .into(),
                ));
            }
            let old = old.ok_or_else(|| CliError::Usage("edit requires --old <text>".into()))?;
            let new = if new_from_stdin {
                require_stdin(stdin, "edit --new-stdin")?.to_string()
            } else {
                reject_stdin(stdin)?;
                new.ok_or_else(|| {
                    CliError::Usage("edit requires --new <text> or --new-stdin".into())
                })?
            };
            path_store::edit(&id, &old, &new, dry_run)
        }
        cli::Cli::Write { id, file, .. } => {
            if file.is_some() {
                return Err(CliError::Usage(
                    "MCP cannot read client-local --file paths; use structured `content`".into(),
                ));
            }
            let body = require_stdin(stdin, "write")?;
            path_store::write(&id, body)
        }
        cli::Cli::PluginList { .. } => {
            reject_stdin(stdin)?;
            output::to_json_value(&plugin::list_data())
        }
        cli::Cli::PluginDescribe { plugin_id, .. } => {
            reject_stdin(stdin)?;
            output::to_json_value(&plugin::describe_data(&plugin_id)?)
        }
        cli::Cli::PluginCreate {
            plugin_id,
            notebook,
            source_note,
            producer,
            ..
        } => {
            let content = require_stdin(stdin, "plugin create")?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            output::to_json_value(&plugin::create_data(
                &plugin_id,
                &notebook,
                source_note.as_deref(),
                &producer,
                content,
            )?)
        }
        cli::Cli::Version | cli::Cli::Completion { .. } | cli::Cli::Mcp => Err(CliError::Usage(
            "command is not available through memo".into(),
        )),
    }
}

fn reject_shell_syntax(command: &str) -> Result<(), CliError> {
    const FORBIDDEN: &[&str] = &["|", ";", "&&", ">", "<", "`", "$(", "${"];
    if let Some(operator) = FORBIDDEN
        .iter()
        .find(|operator| command.contains(**operator))
    {
        return Err(CliError::Usage(format!(
            "shell syntax `{operator}` is not allowed"
        )));
    }
    Ok(())
}

fn require_stdin<'a>(stdin: Option<&'a str>, command: &str) -> Result<&'a str, CliError> {
    let value = stdin.ok_or_else(|| CliError::Usage(format!("{command} requires `stdin`")))?;
    if value.trim().is_empty() {
        return Err(CliError::Usage(format!(
            "{command} requires non-empty `stdin`"
        )));
    }
    Ok(value)
}

fn reject_stdin(stdin: Option<&str>) -> Result<(), CliError> {
    if stdin.is_some() {
        Err(CliError::Usage(
            "stdin is only allowed for create, write, or edit --new-stdin".into(),
        ))
    } else {
        Ok(())
    }
}

fn tool_result(data: Value, is_error: bool) -> Value {
    let text = if is_error {
        data.pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Flowix operation failed")
            .to_string()
    } else {
        let action = data
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let id = data
            .get("address")
            .and_then(Value::as_str)
            .map(|id| format!(" ({id})"))
            .unwrap_or_default();
        format!("Flowix {action}{id}")
    };
    json!({
        "content": [{"type": "text", "text": text}],
        "structuredContent": data,
        "isError": is_error
    })
}

fn error_code(error: &CliError) -> &'static str {
    match error {
        CliError::Usage(_) => "INVALID_COMMAND",
        CliError::NotFound(_) => "NOT_FOUND",
        CliError::Io(_) => "IO_ERROR",
        CliError::Other(_) => "EXECUTION_ERROR",
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i32, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn write_json_line<W: Write>(writer: &mut W, value: &Value) -> Result<(), CliError> {
    serde_json::to_writer(&mut *writer, value)
        .map_err(|error| CliError::Other(format!("json write: {error}")))?;
    writer.write_all(b"\n").map_err(CliError::Io)?;
    writer.flush().map_err(CliError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run(input: &str) -> Vec<Value> {
        let mut output = Vec::new();
        run_mcp(Cursor::new(input.as_bytes()), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn lists_exactly_one_tool_with_command_rules() {
        let responses = run(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#);
        let tools = responses[0]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], TOOL_NAME);
        assert!(tools[0]["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action == "create"));
        assert!(tools[0]["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action == "artifact.create"));
        assert!(tools[0]["inputSchema"]["properties"]["tag"].is_object());
        assert_eq!(
            tools[0]["inputSchema"]["anyOf"],
            json!([{"required":["action"]},{"required":["command"]}])
        );
    }

    #[test]
    fn rejects_shell_syntax_without_executing_it() {
        for command in ["show abc; rm -rf ~", "show abc | cat", "show $(whoami)"] {
            let error = execute_command(command, None).unwrap_err();
            assert!(matches!(error, CliError::Usage(_)));
            assert!(error.to_string().contains("shell syntax"));
        }
    }

    #[test]
    fn validates_stdin_contract() {
        assert!(require_stdin(None, "create").is_err());
        assert!(require_stdin(Some("  "), "write").is_err());
        assert!(reject_stdin(Some("unexpected")).is_err());
        assert_eq!(require_stdin(Some("# note"), "create").unwrap(), "# note");
    }
}
