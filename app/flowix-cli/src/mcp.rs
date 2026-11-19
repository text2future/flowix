//! Model Context Protocol stdio frontend for external Agents.
//!
//! The server exposes scoped structured tools plus a legacy `memo` tool in full mode.
//! Legacy commands are parsed directly; no system shell is spawned.

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

pub const TOOL_DESCRIPTION: &str = "Search and manage Flowix notes and collections. Use collection.create with path and fieldDefinitions, collection.add-fields to extend a table, and collection.add with a record and process-local requestId for structured writes. Discover with collection.list and describe, and query with collection.query. Delete is destructive.";

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
            "tools/list" => rpc_result(id, json!({"tools": tool_definitions()})),
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
        "instructions": "Prefer flowix_read, flowix_write and flowix_delete. For notes, show returns version; scoped write and delete require expectedVersion. Reuse the same requestId and arguments when retrying create or artifact.create; REQUEST_INDETERMINATE requires inspecting the result before further action; use request.show or request.list to inspect local receipts. For collection.add and collection.add-note, requestId deduplicates only while this server process is running; after a restart, check for an existing note before retrying. Paginate list with next_offset and snapshot; search reports truncated. Create accepts title and folder. Use collection.list and collection.describe to inspect tables. Create a notes table with collection.create using path and optional fieldDefinitions; use collection.add-fields to extend an existing notes table. Add a structured record with collection.add using collectionId or path, record {title, properties, content?}, and a requestId. The title names the note file. Within this process, a reused requestId with different content is an error. collection.query accepts where as an array of field=value strings and returns propertiesByKey as well as field-ID properties. collection.add-note remains available for complete Markdown. Use collection.read for the raw collection definition."
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

const READ_ACTIONS: &[&str] = &["notebooks", "list", "tags", "show", "search", "collection.read", "collection.list", "collection.describe", "collection.query", "artifact.list", "artifact.describe", "request.list", "request.show"];
const WRITE_ACTIONS: &[&str] = &["create", "edit", "write", "collection.create", "collection.add-fields", "collection.add", "collection.add-note", "artifact.create"];
const DELETE_ACTIONS: &[&str] = &["delete"];

// The same preconditions drive the scoped schema and the execution guard.
fn required_precondition(action: &str) -> Option<&'static str> {
    match action {
        "write" | "delete" => Some("expectedVersion"),
        "create" | "artifact.create" | "collection.add" | "collection.add-note" => Some("requestId"),
        _ => None,
    }
}

// MCP access is not a filesystem sandbox. Hosts must restrict other entry points separately.
fn mcp_access() -> &'static str {
    match std::env::var("FLOWIX_MCP_ACCESS").as_deref() {
        Ok("read") => "read",
        Ok("write") => "write",
        Ok("full") | Err(std::env::VarError::NotPresent) => "full",
        _ => "none",
    }
}

fn permitted(name: &str) -> bool {
    match mcp_access() {
        "full" => true,
        "write" => matches!(name, "flowix_read" | "flowix_write"),
        "read" => name == "flowix_read",
        _ => false,
    }
}

fn tool_definitions() -> Vec<Value> {
    let mut result = Vec::new();
    for (name, actions, read_only) in [
        ("flowix_read", READ_ACTIONS, true),
        ("flowix_write", WRITE_ACTIONS, false),
        ("flowix_delete", DELETE_ACTIONS, false),
    ] {
        if !permitted(name) { continue; }
        let mut definition = tool_definition();
        definition["name"] = json!(name);
        definition["title"] = json!(name);
        definition["description"] = json!(format!("Flowix operations: {}", actions.join(", ")));
        definition["annotations"] = json!({"readOnlyHint": read_only, "destructiveHint": !read_only, "idempotentHint": read_only});
        let schema = &mut definition["inputSchema"];
        schema["properties"]["state"] = json!({"type":"string","enum":["uncertain","completed"]});
        schema["properties"]["operation"] = json!({"type":"string","enum":["create","artifact.create"]});
        schema["properties"]["action"]["enum"] = json!(actions);
        schema["properties"]["requestId"]["pattern"] = json!("\\S");
        schema["properties"]["requestId"]["maxLength"] = json!(256);
        schema["properties"]["expectedVersion"]["pattern"] = json!("\\S");
        schema.as_object_mut().unwrap().remove("anyOf");
        schema["required"] = json!(["action"]);
        schema["properties"].as_object_mut().unwrap().remove("command");
        schema["properties"].as_object_mut().unwrap().remove("stdin");
        let rules = schema["allOf"].as_array_mut().unwrap();
        for action in actions {
            let mut properties = Map::new();
            properties.insert("action".into(), json!({}));
            for key in action_fields(action).expect("all exposed actions are defined") {
                properties.insert((*key).to_owned(), json!({}));
            }
            rules.push(json!({"if":{"properties":{"action":{"const":action}},"required":["action"]},"then":{"properties":properties,"additionalProperties":false}}));
            if let Some(field) = required_precondition(action) {
                rules.push(json!({"if":{"properties":{"action":{"const":action}},"required":["action"]},"then":{"required":[field]}}));
            }
        }
        for (action, required) in [
            ("show", vec!["address"]), ("search", vec!["query"]),
            ("create", vec!["content"]), ("edit", vec!["address", "old", "content"]),
            ("write", vec!["address", "content"]), ("delete", vec!["address"]),
            ("collection.add", vec!["record"]), ("collection.add-note", vec!["title", "content"]),
            ("artifact.describe", vec!["pluginId"]), ("artifact.create", vec!["pluginId", "content"]),
            ("request.show", vec!["notebook", "operation", "requestId"]),
        ] {
            if actions.contains(&action) {
                rules.push(json!({"if":{"properties":{"action":{"const":action}},"required":["action"]},"then":{"required":required}}));
            }
        }
        result.push(definition);
    }
    if mcp_access() == "full" { result.push(tool_definition()); }
    result
}

fn call_tool(params: &Value) -> Result<Value, CliError> {
    let object = params
        .as_object()
        .ok_or_else(|| CliError::Usage("tools/call params must be an object".into()))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Usage("tools/call params.name must be a string".into()))?;
    if !matches!(name, TOOL_NAME | "flowix_read" | "flowix_write" | "flowix_delete") {
        return Err(CliError::Usage(format!("unknown tool: `{name}`")));
    }
    let arguments = object
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Usage("memo arguments must be an object".into()))?;
    let execution = (|| -> Result<Value, CliError> {
        if !permitted(name) { return Err(CliError::PermissionDenied("MCP access policy denies this tool".into())); }
        validate_argument_keys(arguments)?;
        if name != TOOL_NAME {
            let action = required_string(arguments, "action")?;
            let allowed = match name { "flowix_read" => READ_ACTIONS, "flowix_write" => WRITE_ACTIONS, _ => DELETE_ACTIONS };
            if !allowed.contains(&action.as_str()) { return Err(CliError::PermissionDenied("action is not allowed by this tool".into())); }
            if let Some(field) = required_precondition(&action) {
                if arguments.get(field).and_then(Value::as_str).filter(|v| !v.trim().is_empty()).is_none() {
                    return Err(CliError::PreconditionRequired(format!("{field} is required")));
                }
            }
        }
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

        if arguments.contains_key("action") {
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
        }
    })();

    match execution {
        Ok(data) => Ok(tool_result(data, false)),
        Err(error) => {
            let error_data = json!({
                "ok": false,
                "error": {
                    "code": error_code(&error),
                    "message": error.to_string(),
                    "details": error.details()
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
        "title",
        "old",
        "limit",
        "offset",
        "dryRun",
        "pluginId",
        "sourceNote",
        "producer",
        "collectionId",
        "collectionType",
        "domain",
        "viewId",
        "fields",
        "sort",
        "snapshot",
        "where",
        "fieldDefinitions",
        "record",
        "requestId",
        "expectedVersion",
        "folder",
        "path",
        "tag",
        "command",
        "stdin",
        "state",
        "operation",
    ];
    if let Some(key) = arguments.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(CliError::Usage(format!(
            "memo does not accept argument `{key}`"
        )));
    }
    Ok(())
}

fn action_fields(action: &str) -> Option<&'static [&'static str]> {
    Some(match action {
        "notebooks" | "artifact.list" => &[],
        "request.list" => &["state", "limit"],
        "request.show" => &["notebook", "operation", "requestId"],
        "list" => &["notebook", "limit", "offset", "snapshot"],
        "tags" => &["notebook"],
        "show" => &["address"],
        "search" => &["query", "notebook", "tag", "limit", "offset", "snapshot"],
        "create" => &["notebook", "folder", "title", "content", "requestId"],
        "edit" => &["address", "old", "content", "dryRun"],
        "write" => &["address", "content", "expectedVersion"],
        "delete" => &["address", "expectedVersion"],
        "collection.create" => &["notebook", "path", "fieldDefinitions"],
        "collection.add-fields" => &["notebook", "collectionId", "path", "fieldDefinitions"],
        "collection.add" => &["notebook", "collectionId", "path", "record", "requestId"],
        "collection.add-note" => &["notebook", "collectionId", "path", "title", "content", "requestId"],
        "collection.read" | "collection.describe" => &["notebook", "collectionId", "path"],
        "collection.list" => &["notebook", "collectionType", "domain", "query", "limit", "offset", "snapshot"],
        "collection.query" => &["notebook", "collectionId", "path", "domain", "viewId", "query", "where", "fields", "sort", "limit", "offset", "snapshot"],
        "artifact.describe" => &["pluginId"],
        "artifact.create" => &["pluginId", "notebook", "sourceNote", "producer", "content", "requestId"],
        _ => return None,
    })
}

fn parse_structured_operation(
    arguments: &Map<String, Value>,
) -> Result<operation::FlowixOperation, CliError> {
    use operation::FlowixOperation;
    let action = required_string(arguments, "action")?;
    let allowed = action_fields(&action).ok_or_else(|| CliError::Usage(format!("unknown memo action: `{action}`")))?;
    if let Some(key) = arguments.keys().find(|key| key.as_str() != "action" && !allowed.contains(&key.as_str())) {
        return Err(CliError::Usage(format!("memo.{key} is not valid for {action}")));
    }
    let notebook = optional_string(arguments, "notebook")?;
    let content = || required_string(arguments, "content");
    let address = || required_string(arguments, "address");
    let limit = integer(arguments, "limit", 50, 1, 200)?;
    let offset = integer(arguments, "offset", 0, 0, usize::MAX)?;
    let dry_run = boolean(arguments, "dryRun", false)?;
    match action.as_str() {
        "request.list" => Ok(FlowixOperation::RequestList { state: optional_string(arguments, "state")?, limit }),
        "request.show" => Ok(FlowixOperation::RequestShow { notebook: required_string(arguments, "notebook")?, operation: required_string(arguments, "operation")?, request_id: required_string(arguments, "requestId")? }),
        "notebooks" => Ok(FlowixOperation::Notebooks),
        "collection.create" => Ok(FlowixOperation::CollectionCreate {
            notebook: notebook.clone().unwrap_or_default(), path: required_string(arguments, "path")?,
            fields: arguments.get("fieldDefinitions").map(Value::to_string),
        }),
        "collection.add-fields" => Ok(FlowixOperation::CollectionAddFields {
            notebook: notebook.clone().unwrap_or_default(), collection_id: optional_string(arguments, "collectionId")?, path: optional_string(arguments, "path")?,
            fields: arguments.get("fieldDefinitions").ok_or_else(|| CliError::Usage("fieldDefinitions is required".into()))?.to_string(),
        }),
        "collection.add" => Ok(FlowixOperation::CollectionAdd {
            notebook: notebook.clone().unwrap_or_default(), collection_id: optional_string(arguments, "collectionId")?, path: optional_string(arguments, "path")?,
            record: arguments.get("record").ok_or_else(|| CliError::Usage("record is required".into()))?.to_string(), request_id: optional_string(arguments, "requestId")?,
        }),
        "collection.read" => {
            let notebook = notebook.clone().unwrap_or_default();
            Ok(FlowixOperation::CollectionRead {
                notebook,
                collection_id: optional_string(arguments, "collectionId")?,
                path: optional_string(arguments, "path")?,
            })
        }
        "collection.add-note" => Ok(FlowixOperation::CollectionAddNote {
            notebook: notebook.clone().unwrap_or_default(),
            collection_id: optional_string(arguments, "collectionId")?,
            path: optional_string(arguments, "path")?,
            title: required_string(arguments, "title")?,
            content: content()?,
            request_id: optional_string(arguments, "requestId")?,
        }),
        "collection.list" => Ok(FlowixOperation::CollectionList {
            notebook,
            collection_type: optional_string(arguments, "collectionType")?,
            domain: optional_string(arguments, "domain")?,
            query: optional_string(arguments, "query")?,
            limit,
            offset,
            snapshot: optional_string(arguments, "snapshot")?,
        }),
        "collection.describe" => Ok(FlowixOperation::CollectionDescribe {
            notebook: notebook.clone().unwrap_or_default(),
            collection_id: optional_string(arguments, "collectionId")?,
            path: optional_string(arguments, "path")?,
        }),
        "collection.query" => {
            let fields = string_array(arguments, "fields")?;
            let sort = sort_arguments(arguments)?;
            Ok(FlowixOperation::CollectionQuery {
                notebook: notebook.clone().unwrap_or_default(),
                collection_id: optional_string(arguments, "collectionId")?,
                path: optional_string(arguments, "path")?,
                domain: optional_string(arguments, "domain")?,
                view_id: optional_string(arguments, "viewId")?,
                query: optional_string(arguments, "query")?,
                filters: string_array(arguments, "where")?,
                fields,
                sort,
                limit,
                offset,
                snapshot: optional_string(arguments, "snapshot")?,
            })
        }
        "list" => Ok(FlowixOperation::List {
            notebook,
            limit,
            offset,
            snapshot: optional_string(arguments, "snapshot")?,
        }),
        "tags" => Ok(FlowixOperation::Tags { notebook }),
        "show" => Ok(FlowixOperation::Show {
            address: address()?,
        }),
        "search" => Ok(FlowixOperation::Search {
            query: required_string(arguments, "query")?,
            notebook,
            tag: optional_string(arguments, "tag")?,
            limit,
            offset,
            snapshot: optional_string(arguments, "snapshot")?,
        }),
        "create" => Ok(FlowixOperation::Create {
            notebook,
            folder: optional_string(arguments, "folder")?,
            title: optional_string(arguments, "title")?,
            content: content()?,
            request_id: optional_string(arguments, "requestId")?,
        }),
        "edit" => Ok(FlowixOperation::Edit {
            address: address()?,
            old: required_string(arguments, "old")?,
            replacement: optional_string(arguments, "content")?.ok_or_else(|| CliError::Usage("memo.content is required".into()))?,
            dry_run,
        }),
        "write" => Ok(FlowixOperation::Write {
            address: address()?,
            expected_version: optional_string(arguments, "expectedVersion")?,
            content: content()?,
        }),
        "delete" => Ok(FlowixOperation::Delete {
            address: address()?,
            expected_version: optional_string(arguments, "expectedVersion")?,
        }),
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
            request_id: optional_string(arguments, "requestId")?,
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

fn string_array(arguments: &Map<String, Value>, key: &str) -> Result<Vec<String>, CliError> {
    let Some(value) = arguments.get(key) else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| CliError::Usage(format!("memo.{key} must be an array of strings")))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| CliError::Usage(format!("memo.{key} must contain only strings")))
        })
        .collect()
}

fn sort_arguments(arguments: &Map<String, Value>) -> Result<Vec<String>, CliError> {
    let Some(value) = arguments.get("sort") else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| CliError::Usage("memo.sort must be an array".into()))?
        .iter()
        .map(|item| {
            if let Some(text) = item.as_str() {
                return Ok(text.to_owned());
            }
            let object = item.as_object().ok_or_else(|| {
                CliError::Usage("memo.sort entries must be {field,direction}".into())
            })?;
            if object.keys().any(|key| key != "field" && key != "direction") {
                return Err(CliError::Usage("memo.sort entries only accept field and direction".into()));
            }
            let field = object
                .get("field")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::Usage("memo.sort.field must be a string".into()))?;
            let direction = match object.get("direction") {
                None => "asc",
                Some(value) => value.as_str().ok_or_else(|| CliError::Usage("memo.sort.direction must be a string".into()))?,
            };
            if !matches!(direction, "asc" | "desc") {
                return Err(CliError::Usage(
                    "memo.sort.direction must be asc or desc".into(),
                ));
            }
            Ok(format!("{field}:{direction}"))
        })
        .collect()
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
        cli::Cli::RequestList { .. } | cli::Cli::RequestShow { .. } | cli::Cli::RequestReview { .. } => Err(CliError::Usage("use structured request actions; manual reviews are CLI-only".into())),
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
        cli::Cli::List { notebook, limit, offset, snapshot, .. } => {
            reject_stdin(stdin)?;
            operation::execute(operation::FlowixOperation::List { notebook, limit, offset, snapshot })
        }
        cli::Cli::Tags { notebook, .. } => {
            reject_stdin(stdin)?;
            store::notebook_tags(notebook.as_deref())
        }
        cli::Cli::Show { id, .. } => {
            reject_stdin(stdin)?;
            path_store::show(&id)
        }
        cli::Cli::Create { notebook, title, folder, file, request_id, .. } => {
            if file.is_some() {
                return Err(CliError::Usage(
                    "MCP cannot read client-local --file paths; use structured `content`".into(),
                ));
            }
            let body = require_stdin(stdin, "create")?;
            operation::execute(operation::FlowixOperation::Create { notebook, title, folder, content: body.to_owned(), request_id })
        }
        cli::Cli::Delete { id, expected_version, .. } => {
            reject_stdin(stdin)?;
            path_store::delete(&id, expected_version.as_deref())
        }
        cli::Cli::CollectionRead {
            notebook,
            collection_id,
            path,
            ..
        } => {
            reject_stdin(stdin)?;
            operation::execute(operation::FlowixOperation::CollectionRead {
                notebook,
                collection_id,
                path,
            })
        }
        cli::Cli::CollectionAddNote {
            notebook,
            collection_id,
            path,
            title,
            file,
            stdin: _,
            request_id,
            ..
        } => {
            if file.is_some() {
                return Err(CliError::Usage(
                    "MCP cannot read client-local --file paths; use structured `content`".into(),
                ));
            }
            let content = require_stdin(stdin, "collection add-note")?;
            operation::execute(operation::FlowixOperation::CollectionAddNote {
                notebook,
                collection_id,
                path,
                title,
                content: content.to_owned(),
                request_id,
            })
        }
        cli::Cli::CollectionList {
            notebook,
            collection_type,
            domain,
            query,
            limit,
            offset,
            snapshot,
            ..
        } => {
            reject_stdin(stdin)?;
            operation::execute(operation::FlowixOperation::CollectionList {
                notebook,
                collection_type,
                domain,
                query,
                limit,
                offset,
                snapshot,
            })
        }
        cli::Cli::CollectionDescribe {
            notebook,
            collection_id,
            path,
            ..
        } => {
            reject_stdin(stdin)?;
            operation::execute(operation::FlowixOperation::CollectionDescribe {
                notebook,
                collection_id,
                path,
            })
        }
        cli::Cli::CollectionQuery {
            notebook,
            collection_id,
            path,
            domain,
            view_id,
            query,
            filters,
            fields,
            sort,
            limit,
            offset,
            snapshot,
            ..
        } => {
            reject_stdin(stdin)?;
            operation::execute(operation::FlowixOperation::CollectionQuery {
                notebook,
                collection_id,
                path,
                domain,
                view_id,
                query,
                filters,
                fields,
                sort,
                limit,
                offset,
                snapshot,
            })
        }
        cli::Cli::Search {
            query,
            notebook,
            tag,
            limit,
            offset,
            snapshot,
            ..
        } => {
            reject_stdin(stdin)?;
            path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit, offset, snapshot.as_deref())
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
        cli::Cli::Write { id, file, expected_version, .. } => {
            if file.is_some() {
                return Err(CliError::Usage(
                    "MCP cannot read client-local --file paths; use structured `content`".into(),
                ));
            }
            let body = require_stdin(stdin, "write")?;
            path_store::write(&id, body, expected_version.as_deref())
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
        // Artifact authoring (HTML pages and reusable components) stays in the
        // direct CLI; the restricted memo grammar does not expose those commands.
        cli::Cli::Version
        | cli::Cli::CollectionCreate { .. }
        | cli::Cli::CollectionAddFields { .. }
        | cli::Cli::CollectionAdd { .. }
        | cli::Cli::Completion { .. }
        | cli::Cli::Html { .. }
        | cli::Cli::ComponentCatalog { .. }
        | cli::Cli::ComponentCreate { .. }
        | cli::Cli::ComponentList { .. }
        | cli::Cli::ComponentValidate { .. }
        | cli::Cli::Mcp => Err(CliError::Usage(
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
    error.code()
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
    fn lists_scoped_tools_and_legacy_command_rules() {
        let responses = run(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#);
        let tools = responses[0]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
        let tools = vec![tools.last().unwrap().clone()];
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
    fn scoped_schemas_use_executor_action_fields() {
        for tool in tool_definitions().into_iter().filter(|tool| tool["name"] != TOOL_NAME) {
            let schema = &tool["inputSchema"];
            for action in schema["properties"]["action"]["enum"].as_array().unwrap() {
                let name = action.as_str().unwrap();
                let rule = schema["allOf"].as_array().unwrap().iter().find(|rule| {
                    rule.pointer("/if/properties/action/const") == Some(action)
                        && rule.pointer("/then/additionalProperties") == Some(&json!(false))
                }).unwrap();
                let properties = rule["then"]["properties"].as_object().unwrap();
                assert_eq!(properties.len(), action_fields(name).unwrap().len() + 1);
                for field in action_fields(name).unwrap() { assert!(properties.contains_key(*field)); }
            }
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
