//! Model Context Protocol stdio frontend for external Agents.
//!
//! The server intentionally exposes exactly one tool, `flowix_memo`. Its input is a
//! restricted Flowix CLI command plus optional stdin content. Commands are parsed into
//! argv and dispatched directly to the typed store layer; no system shell is spawned.

use crate::{cli, errors::CliError, fmt, output, store};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};

pub const TOOL_NAME: &str = "flowix_memo";
const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    LATEST_PROTOCOL_VERSION,
];

pub const TOOL_DESCRIPTION: &str = "Manage Flowix notebooks and Markdown memos using restricted Flowix CLI syntax. Do not include the leading `flowix`. Supported commands: `notebooks`; `list <notebook>`; `show <id>`; `search <query> [--notebook <name|id>] [--limit <1..200>]`; `create <notebook>` with the complete non-empty Markdown body in `stdin`; `edit <id> --old <exact-text> (--new <text> | --new-stdin)` where `--old` must occur exactly once and `stdin` supplies the replacement when `--new-stdin` is used; `edit` also supports `--dry-run`; `write <id>` with the complete replacement Markdown body in `stdin`; and `delete <id>`. Obtain memo IDs from list or search before reading or modifying a memo. Notebook may be a registered notebook name or ID. Quoted arguments are supported. Shell syntax and arbitrary programs are forbidden, including pipes, redirects, semicolons, `&&`, command substitution, and environment expansion. `delete` is destructive. Results are always returned as structured data, so `--json` is unnecessary.";

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
        "instructions": "Use the flowix_memo tool to search, read, create, and edit Flowix Markdown memos."
    })
}

fn tool_definition() -> Value {
    json!({
        "name": TOOL_NAME,
        "title": "Flowix Memo",
        "description": TOOL_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "A supported Flowix command without the leading `flowix`, for example `search \"product plan\" --notebook work --limit 10`."
                },
                "stdin": {
                    "type": "string",
                    "description": "Content passed to the command. Required for `create` and `write`, and for `edit` when `--new-stdin` is used. Do not use it with other commands."
                }
            },
            "required": ["command"],
            "additionalProperties": false
        }
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
        .ok_or_else(|| CliError::Usage("flowix_memo arguments must be an object".into()))?;
    validate_argument_keys(arguments)?;
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Usage("flowix_memo.command must be a string".into()))?;
    let stdin = match arguments.get("stdin") {
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| CliError::Usage("flowix_memo.stdin must be a string".into()))?,
        ),
        None => None,
    };

    match execute_command(command, stdin) {
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
    if let Some(key) = arguments
        .keys()
        .find(|key| key.as_str() != "command" && key.as_str() != "stdin")
    {
        return Err(CliError::Usage(format!(
            "flowix_memo does not accept argument `{key}`"
        )));
    }
    Ok(())
}

fn execute_command(command: &str, stdin: Option<&str>) -> Result<Value, CliError> {
    reject_shell_syntax(command)?;
    let args = shell_words::split(command)
        .map_err(|error| CliError::Usage(format!("invalid command quoting: {error}")))?;
    if args.is_empty() {
        return Err(CliError::Usage(
            "flowix_memo.command cannot be empty".into(),
        ));
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
            "help and version commands are not available through flowix_memo".into(),
        ));
    }

    let parsed = cli::parse(&args)?.ok_or_else(|| CliError::Usage("missing command".into()))?;
    match parsed {
        cli::Cli::Notebooks { .. } => {
            reject_stdin(stdin)?;
            let configs = store::notebooks_list_configs()?;
            let counts = store::notebook_note_counts(&configs)?;
            Ok(fmt::notebooks_to_json(&configs, &counts))
        }
        cli::Cli::List { notebook, .. } => {
            reject_stdin(stdin)?;
            Ok(fmt::notes_to_json(&store::notes_list_entries(&notebook)?))
        }
        cli::Cli::Show { id, .. } => {
            reject_stdin(stdin)?;
            Ok(store::note_show_data(&id)?.to_json())
        }
        cli::Cli::Create { notebook, .. } => {
            let body = require_stdin(stdin, "create")?;
            let (mut memo_file, notebook_config) = store::open_in(&notebook)?;
            output::to_json_value(&store::create_note(&mut memo_file, &notebook_config, body)?)
        }
        cli::Cli::Delete { id, .. } => {
            reject_stdin(stdin)?;
            let (mut memo_file, full_id) = store::resolve_id(&id)?;
            let path = memo_file.find_memo_file_path(&full_id);
            output::to_json_value(&store::delete_note(
                &mut memo_file,
                &full_id,
                path.as_deref(),
            )?)
        }
        cli::Cli::Search {
            query,
            notebook,
            limit,
            ..
        } => {
            reject_stdin(stdin)?;
            let results = store::search_hits(&query, notebook.as_deref(), limit)?;
            output::to_json_value(&store::search_results_to_value(&query, &results))
        }
        cli::Cli::Edit {
            id,
            old,
            new,
            new_from_stdin,
            dry_run,
            ..
        } => {
            let old = old.ok_or_else(|| CliError::Usage("edit requires --old <text>".into()))?;
            let new = if new_from_stdin {
                require_stdin(stdin, "edit --new-stdin")?.to_string()
            } else {
                reject_stdin(stdin)?;
                new.ok_or_else(|| {
                    CliError::Usage("edit requires --new <text> or --new-stdin".into())
                })?
            };
            let (mut memo_file, full_id) = store::resolve_id(&id)?;
            let result = if dry_run {
                store::preview_edit_note(&mut memo_file, &full_id, &old, &new)
            } else {
                store::edit_note(&mut memo_file, &full_id, &old, &new)
            }?;
            output::to_json_value(&result)
        }
        cli::Cli::Write { id, .. } => {
            let body = require_stdin(stdin, "write")?;
            let (mut memo_file, full_id) = store::resolve_id(&id)?;
            output::to_json_value(&store::write_note(&mut memo_file, &full_id, body)?)
        }
        cli::Cli::Version | cli::Cli::Completion { .. } | cli::Cli::Mcp => Err(CliError::Usage(
            "command is not available through flowix_memo".into(),
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
    let text = serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string());
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
        assert!(tools[0]["description"]
            .as_str()
            .unwrap()
            .contains("create <notebook>"));
        assert_eq!(tools[0]["inputSchema"]["required"], json!(["command"]));
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
