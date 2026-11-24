//! CLI 命令定义与 argv 解析。
//!
//! 执行调度在 `dispatch` 模块，具体 memo 操作在 `store` 模块。

use clap::{Arg, ArgAction, Command};

use crate::errors::CliError;

pub(crate) const DISPLAY_BIN: &str = "flowix";

/// 解析后的 CLI 命令。
#[derive(Debug)]
pub enum Cli {
    RequestList {
        state: Option<String>,
        limit: usize,
        json: bool,
    },
    RequestShow {
        notebook: String,
        operation: String,
        request_id: String,
        json: bool,
    },
    RequestReview {
        notebook: String,
        operation: String,
        request_id: String,
        outcome: String,
        actor: String,
        evidence: Option<String>,
        json: bool,
    },
    Version,
    Notebooks {
        json: bool,
    },
    List {
        notebook: Option<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
        json: bool,
    },
    Tags {
        notebook: Option<String>,
        json: bool,
    },
    Show {
        id: String,
        json: bool,
    },
    Create {
        notebook: Option<String>,
        folder: Option<String>,
        title: Option<String>,
        file: Option<String>,
        stdin: bool,
        request_id: Option<String>,
        json: bool,
    },
    Delete {
        id: String,
        expected_version: Option<String>,
        json: bool,
    },
    CollectionCreate {
        notebook: String,
        path: String,
        fields_file: Option<String>,
        json: bool,
    },
    CollectionAddFields {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        fields_file: String,
        json: bool,
    },
    CollectionAdd {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        file: Option<String>,
        stdin: bool,
        request_id: Option<String>,
        json: bool,
    },
    CollectionRead {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        json: bool,
    },
    CollectionAddNote {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        title: String,
        file: Option<String>,
        stdin: bool,
        request_id: Option<String>,
        json: bool,
    },
    CollectionList {
        notebook: Option<String>,
        collection_type: Option<String>,
        domain: Option<String>,
        query: Option<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
        json: bool,
    },
    CollectionDescribe {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        json: bool,
    },
    CollectionQuery {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        domain: Option<String>,
        view_id: Option<String>,
        query: Option<String>,
        filters: Vec<String>,
        fields: Vec<String>,
        sort: Vec<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
        json: bool,
    },
    Search {
        query: String,
        notebook: Option<String>,
        tag: Option<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
        json: bool,
    },
    Edit {
        id: String,
        /// 旧字符串 (精确匹配, 必须唯一)
        old: Option<String>,
        /// 新字符串
        new: Option<String>,
        /// 从 stdin 读 new (避免歧义)
        new_from_stdin: bool,
        /// 从 UTF-8 文件读取 new
        new_file: Option<String>,
        dry_run: bool,
        json: bool,
    },
    /// 覆盖整个笔记内容 (从 stdin 读) ── `edit` 的非交互等价物。
    /// 覆盖 Markdown 内容，不改变物理文件名；标题改名使用独立操作。
    Write {
        id: String,
        expected_version: Option<String>,
        file: Option<String>,
        stdin: bool,
        json: bool,
    },
    PluginList {
        json: bool,
    },
    PluginDescribe {
        plugin_id: String,
        json: bool,
    },
    PluginCreate {
        plugin_id: String,
        notebook: Option<String>,
        source_note: Option<String>,
        producer: String,
        json: bool,
    },
    Completion {
        shell: String,
    },
    /// 笔记本内 HTML 页面的能力目录（`window.flowix` 能读什么、怎么读）。
    /// 内容由 `scripts/gen-embed-catalog.mjs` 从契约生成。
    Html {
        template: Option<String>,
        out: Option<String>,
        force: bool,
        json: bool,
    },
    ComponentCatalog {
        json: bool,
    },
    ComponentCreate {
        notebook: Option<String>,
        id: String,
        name: String,
        file: Option<String>,
        stdin: bool,
        json: bool,
    },
    ComponentList {
        notebook: Option<String>,
        json: bool,
    },
    ComponentValidate {
        file: String,
        json: bool,
    },
    /// Model Context Protocol over stdio。向外部 Agent 暴露唯一工具
    /// `memo`，工具参数采用受限的 Flowix CLI 语法。
    Mcp,
}

/// 解析 argv。`Ok(None)` 表示"打印了 help 正常退出"。
pub(crate) fn parse(args: &[String]) -> Result<Option<Cli>, CliError> {
    if args.is_empty() {
        print_help();
        return Ok(None);
    }
    if matches!(
        args.first().map(String::as_str),
        Some("--help" | "-h" | "help")
    ) {
        print_help();
        return Ok(None);
    }
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        return Ok(Some(Cli::Version));
    }

    let argv = std::iter::once(DISPLAY_BIN.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let matches = match cli_command().try_get_matches_from(argv) {
        Ok(matches) => matches,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return Ok(None);
        }
        Err(error) => return Err(clap_to_cli_error(error)),
    };
    let json = matches.get_flag("json");

    match matches.subcommand() {
        Some(("request", sub)) => match sub.subcommand() {
            Some(("list", command)) => Ok(Some(Cli::RequestList { state: command.get_one::<String>("state").cloned(), limit: *command.get_one::<usize>("limit").unwrap_or(&50), json })),
            Some(("show", command)) => Ok(Some(Cli::RequestShow { notebook: required_string(command, "notebook")?, operation: required_string(command, "operation")?, request_id: required_string(command, "request-id")?, json })),
            Some(("review", command)) => Ok(Some(Cli::RequestReview { notebook: required_string(command, "notebook")?, operation: required_string(command, "operation")?, request_id: required_string(command, "request-id")?, outcome: required_string(command, "outcome")?, actor: required_string(command, "actor")?, evidence: command.get_one::<String>("evidence").cloned(), json })),
            _ => Err(CliError::Usage("request requires list, show, or review".into())),
        },
        Some(("notebooks", _)) => Ok(Some(Cli::Notebooks { json })),
        Some(("list", sub)) => Ok(Some(Cli::List {
            notebook: sub.get_one::<String>("notebook").cloned(),
            limit: *sub.get_one::<u32>("limit").unwrap_or(&50) as usize,
            offset: *sub.get_one::<usize>("offset").unwrap_or(&0),
            snapshot: sub.get_one::<String>("snapshot").cloned(),
            json,
        })),
        Some(("tags", sub)) => Ok(Some(Cli::Tags {
            notebook: sub.get_one::<String>("notebook").cloned(),
            json,
        })),
        Some(("show", sub)) => Ok(Some(Cli::Show {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("create", sub)) => Ok(Some(Cli::Create {
            folder: sub.get_one::<String>("folder").cloned(),
            notebook: sub.get_one::<String>("notebook").cloned(),
            title: sub.get_one::<String>("title").cloned(),
            file: sub.get_one::<String>("file").cloned(),
            stdin: sub.get_flag("stdin"),
            request_id: sub.get_one::<String>("request-id").cloned(),
            json,
        })),
        Some(("delete", sub)) => Ok(Some(Cli::Delete {
            id: required_string(sub, "id")?,
            expected_version: sub.get_one::<String>("if-version").cloned(),
            json,
        })),
        Some(("collection", sub)) => match sub.subcommand() {
            Some(("add", command)) => Ok(Some(Cli::CollectionAdd {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(), file: command.get_one::<String>("file").cloned(),
                stdin: command.get_flag("stdin"), request_id: command.get_one::<String>("request-id").cloned(), json,
            })),
            Some(("add-fields", command)) => Ok(Some(Cli::CollectionAddFields {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(),
                fields_file: required_string(command, "fields-file")?, json,
            })),
            Some(("create", command)) => Ok(Some(Cli::CollectionCreate {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                path: if let Some(path) = command.get_one::<String>("path") { path.clone() } else {
                    let name = required_string(command, "name")?;
                    if name.trim().is_empty() || name.contains(['/', '\\']) || matches!(name.trim(), "." | "..") { return Err(CliError::Usage("invalid collection name".into())); }
                    format!("{}.index.yaml", name.trim())
                },
                fields_file: command.get_one::<String>("fields-file").cloned(),
                json,
            })),
            Some(("list", command)) => Ok(Some(Cli::CollectionList {
                notebook: command.get_one::<String>("notebook").cloned(),
                collection_type: command.get_one::<String>("collection-type").cloned(),
                domain: command.get_one::<String>("domain").cloned(),
                query: command.get_one::<String>("query").cloned(),
                limit: *command.get_one::<usize>("limit").unwrap_or(&50),
                offset: *command.get_one::<usize>("offset").unwrap_or(&0),
                snapshot: command.get_one::<String>("snapshot").cloned(),
                json,
            })),
            Some(("describe", command)) => Ok(Some(Cli::CollectionDescribe {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(),
                json,
            })),
            Some(("query", command)) => Ok(Some(Cli::CollectionQuery {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(),
                domain: command.get_one::<String>("domain").cloned(),
                view_id: command.get_one::<String>("view-id").cloned(),
                query: command.get_one::<String>("query").cloned(),
                filters: command.get_many::<String>("where").map(|v| v.cloned().collect()).unwrap_or_default(),
                fields: command
                    .get_many::<String>("fields")
                    .map(|values| {
                        values
                            .flat_map(|value| value.split(',').map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                sort: command
                    .get_many::<String>("sort")
                    .map(|values| values.cloned().collect())
                    .unwrap_or_default(),
                limit: *command.get_one::<usize>("limit").unwrap_or(&50),
                offset: *command.get_one::<usize>("offset").unwrap_or(&0),
                snapshot: command.get_one::<String>("snapshot").cloned(),
                json,
            })),
            Some(("read", command)) => Ok(Some(Cli::CollectionRead {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(),
                json,
            })),
            Some(("add-note", command)) => Ok(Some(Cli::CollectionAddNote {
                notebook: command.get_one::<String>("notebook").cloned().unwrap_or_default(),
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(),
                title: required_string(command, "title")?,
                file: command.get_one::<String>("file").cloned(),
                stdin: command.get_flag("stdin"),
                request_id: command.get_one::<String>("request-id").cloned(),
                json,
            })),
            Some((other, _)) => Err(CliError::Usage(format!(
                "unknown collection command: `{other}`"
            ))),
            None => Err(CliError::Usage(format!(
                "usage: {DISPLAY_BIN} collection <create|add-fields|list|describe|query|read|add-note>"
            ))),
        },
        Some(("edit", sub)) => Ok(Some(Cli::Edit {
            id: required_string(sub, "id")?,
            old: joined_values(sub, "old"),
            new: joined_values(sub, "new"),
            new_from_stdin: sub.get_flag("new-stdin"),
            new_file: sub.get_one::<String>("new-file").cloned(),
            dry_run: sub.get_flag("dry-run"),
            json,
        })),
        Some(("write", sub)) => Ok(Some(Cli::Write {
            id: required_string(sub, "id")?,
            expected_version: sub.get_one::<String>("if-version").cloned(),
            file: sub.get_one::<String>("file").cloned(),
            stdin: sub.get_flag("stdin"),
            json,
        })),
        Some(("search", sub)) => {
            let limit = *sub.get_one::<usize>("limit").unwrap_or(&20);
            if limit == 0 {
                return Err(CliError::Usage(
                    "search: --limit/-l requires a positive integer".into(),
                ));
            }
            Ok(Some(Cli::Search {
                query: required_string(sub, "query")?,
                notebook: sub.get_one::<String>("notebook").cloned(),
                tag: sub.get_one::<String>("tag").cloned(),
                limit,
                offset: *sub.get_one::<usize>("offset").unwrap_or(&0),
                snapshot: sub.get_one::<String>("snapshot").cloned(),
                json,
            }))
        }
        Some(("plugin", sub)) => match sub.subcommand() {
            Some(("list", _)) => Ok(Some(Cli::PluginList { json })),
            Some(("describe", command)) => Ok(Some(Cli::PluginDescribe {
                plugin_id: required_string(command, "plugin-id")?,
                json,
            })),
            Some(("create", command)) => Ok(Some(Cli::PluginCreate {
                plugin_id: required_string(command, "plugin-id")?,
                notebook: command.get_one::<String>("notebook").cloned(),
                source_note: command.get_one::<String>("source-note").cloned(),
                producer: command
                    .get_one::<String>("producer")
                    .cloned()
                    .unwrap_or_else(|| "agent-cli".to_string()),
                json,
            })),
            Some((other, _)) => Err(CliError::Usage(format!(
                "unknown plugin command: `{other}`"
            ))),
            None => Err(CliError::Usage(format!(
                "usage: {DISPLAY_BIN} plugin <list|describe|create>"
            ))),
        },
        Some(("completion", sub)) => Ok(Some(Cli::Completion {
            shell: required_string(sub, "shell")?,
        })),
        Some(("html", sub)) => Ok(Some(Cli::Html {
            template: sub.get_one::<String>("template").cloned(),
            out: sub.get_one::<String>("out").cloned(),
            force: sub.get_flag("force"),
            json,
        })),
        Some(("component", sub)) => match sub.subcommand() {
            Some(("create", command)) => Ok(Some(Cli::ComponentCreate {
                notebook: command.get_one::<String>("notebook").cloned(),
                id: required_string(command, "component-id")?,
                name: required_string(command, "name")?,
                file: command.get_one::<String>("file").cloned(),
                stdin: command.get_flag("stdin"),
                json,
            })),
            Some(("list", command)) => Ok(Some(Cli::ComponentList {
                notebook: command.get_one::<String>("notebook").cloned(),
                json,
            })),
            Some(("validate", command)) => Ok(Some(Cli::ComponentValidate {
                file: required_string(command, "file")?,
                json,
            })),
            Some((other, _)) => Err(CliError::Usage(format!(
                "unknown component command: `{other}`"
            ))),
            None => Ok(Some(Cli::ComponentCatalog { json })),
        },
        Some(("mcp", _)) => Ok(Some(Cli::Mcp)),
        Some((other, _)) => Err(CliError::Usage(format!(
            "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
        ))),
        None => {
            print_help();
            Ok(None)
        }
    }
}

pub(crate) fn cli_command() -> Command {
    Command::new(DISPLAY_BIN)
        .version(env!("CARGO_PKG_VERSION"))
        .about("Manage local Flowix notebooks, Markdown notes, and artifacts")
        .after_help("For Markdown content, --file is recommended (especially on Windows PowerShell 5.1). Files must be UTF-8. Note addresses use <notebook-id>::<relative-path> or an absolute path. Examples:\n  flowix create <notebook> --title \"My note\" --file body.md --json\n  flowix show work::Notes/Example.md --json\n  flowix write work::Notes/Example.md --file body.md --json\n  flowix list\n  flowix search TODO --tag project/flowix --limit 20\n  flowix collection list work --json\n  flowix collection describe --notebook work --id <collection-id> --json\n  flowix collection query --notebook work --id <collection-id> --domain notes --json\n  flowix collection add-note --notebook work --id <collection-id> --title \"New note\" --file body.md --json\n  flowix collection read --notebook <notebook-id> --id <collection-id> --json\n  flowix html\n  flowix mcp")
        .arg(
            Arg::new("json")
                .long("json")
                .short('j')
                .global(true)
                .action(ArgAction::SetTrue),
        )
        .subcommand_required(true)
        .subcommand(Command::new("request").about("Inspect and record manual review of request receipts").subcommand_required(true)
            .subcommand(Command::new("list").arg(Arg::new("state").long("state").value_parser(["uncertain", "completed"])).arg(Arg::new("limit").long("limit").value_parser(clap::value_parser!(usize)).default_value("50")))
            .subcommand(Command::new("show").arg(required_arg("request-id")).arg(Arg::new("notebook").long("notebook").required(true)).arg(Arg::new("operation").long("operation").required(true)))
            .subcommand(Command::new("review").arg(required_arg("request-id")).arg(Arg::new("notebook").long("notebook").required(true)).arg(Arg::new("operation").long("operation").required(true)).arg(Arg::new("outcome").long("outcome").value_parser(["confirmed", "unresolved"]).required(true)).arg(Arg::new("actor").long("actor").required(true)).arg(Arg::new("evidence").long("evidence"))))
        .subcommand(Command::new("notebooks").about("List notebooks"))
        .subcommand(
            Command::new("list")
                .about("List notes; defaults to the current notebook")
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1))
                .arg(Arg::new("limit").long("limit").value_parser(clap::value_parser!(u32).range(1..=200)).default_value("50"))
                .arg(Arg::new("offset").long("offset").value_parser(clap::value_parser!(usize)).default_value("0"))
                .arg(Arg::new("snapshot").long("snapshot").help("Snapshot from the first page; rejects changed data")),
        )
        .subcommand(
            Command::new("tags")
                .about("List all tags in a notebook; defaults to the current notebook")
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1)),
        )
        .subcommand(Command::new("show").about("Show a note").arg(required_arg("id")))
        .subcommand(
            Command::new("create")
                .about("Create a note; use --file for UTF-8 Markdown (recommended), or --stdin explicitly; defaults to the current notebook")
                .arg(Arg::new("title").long("title").value_name("TITLE").help("Document name (defaults to Untitled)").num_args(1))
                .arg(Arg::new("request-id").long("request-id").help("Stable ID for safe retries").num_args(1))
                .arg(Arg::new("folder").long("folder").help("Notebook-relative destination folder; . means notebook root").num_args(1))
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1))
                .arg(Arg::new("file").long("file").short('f').value_name("UTF-8-MARKDOWN").help("Recommended: read Markdown content directly from a UTF-8 file").num_args(1))
                .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).help("Read Markdown from stdin; required explicitly on Windows"))
                .group(clap::ArgGroup::new("input").args(["file", "stdin"]).multiple(false)),
        )
        .subcommand(Command::new("delete").about("Delete a note").arg(required_arg("id")).arg(Arg::new("if-version").long("if-version").help("Require the version returned by show")))
        .subcommand(
            Command::new("collection")
                .about("Read and update collection datasets")
                .subcommand_required(true)
                .subcommand(
                    Command::new("create")
                        .about("Create a standalone notes table with an optional JSON field definition")
                        .after_help("Fields file format: [{\"name\":\"Status\",\"type\":\"Select\",\"options\":[\"Todo\",\"Done\"]},{\"name\":\"Score\",\"type\":\"Number\"}]. Supported types: Text, URL, Icon, Boolean, Number, Date, Select, MultiSelect, Tag, Color, Image. The path must end in .index.yaml and its parent must exist.")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .arg(Arg::new("name").long("name").num_args(1))
                        .group(clap::ArgGroup::new("destination").args(["path", "name"]).required(true).multiple(false))
                        .arg(Arg::new("fields-file").long("fields-file").num_args(1)),
                )
                .subcommand(
                    Command::new("add-fields")
                        .about("Add fields from a JSON definition to an existing notes table")
                        .after_help("Use the same JSON array format as collection create --fields-file; see collection create --help.")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .arg(Arg::new("fields-file").long("fields-file").required(true).num_args(1))
                        .group(clap::ArgGroup::new("selector").args(["collection-id", "path"]).required(true).multiple(false)),
                )
                .subcommand(
                    Command::new("list")
                        .about("List collections in a notebook")
                        .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1))
                        .arg(Arg::new("collection-type").long("type").num_args(1))
                        .arg(Arg::new("domain").long("domain").num_args(1))
                        .arg(Arg::new("query").long("query").num_args(1))
                        .arg(Arg::new("limit").long("limit").value_parser(clap::value_parser!(usize)).num_args(1))
                        .arg(Arg::new("offset").long("offset").value_parser(clap::value_parser!(usize)).num_args(1))
                        .arg(Arg::new("snapshot").long("snapshot").num_args(1)),
                )
                .subcommand(
                    Command::new("describe")
                        .about("Describe collection domains, fields, and views")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .group(clap::ArgGroup::new("selector").args(["collection-id", "path"]).required(true).multiple(false)),
                )
                .subcommand(
                    Command::new("query")
                        .about("Query collection records")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .arg(Arg::new("domain").long("domain").num_args(1))
                        .arg(Arg::new("view-id").long("view").num_args(1))
                        .arg(Arg::new("query").long("query").num_args(1))
                        .arg(Arg::new("where").long("where").help("Exact field=value filter; may be repeated").action(ArgAction::Append).num_args(1))
                        .arg(Arg::new("fields").long("fields").help("Comma-separated field IDs or property keys").num_args(1))
                        .arg(Arg::new("sort").long("sort").help("Sort by field ID or property key, followed by :asc or :desc").action(ArgAction::Append).num_args(1))
                        .arg(Arg::new("limit").long("limit").value_parser(clap::value_parser!(usize)).num_args(1))
                        .arg(Arg::new("offset").long("offset").value_parser(clap::value_parser!(usize)).num_args(1))
                        .arg(Arg::new("snapshot").long("snapshot").num_args(1))
                        .group(clap::ArgGroup::new("selector").args(["collection-id", "path"]).required(true).multiple(false)),
                )
                .subcommand(
                    Command::new("read")
                        .about("Read one table or media library collection")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .group(
                            clap::ArgGroup::new("selector")
                                .args(["collection-id", "path"])
                                .required(true)
                                .multiple(false),
                        ),
                )
                .subcommand(
                    Command::new("add").about("Create a record from JSON with title, properties and optional content")
                        .after_help("Input JSON: {\"title\":\"Product\",\"properties\":{\"Status\":\"Done\"},\"content\":\"Optional Markdown\"}. Title names the note file. Property keys must exist in the collection. Request IDs deduplicate only within one process; separate CLI invocations can create duplicates.")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .arg(Arg::new("file").long("file").num_args(1))
                        .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue))
                        .arg(Arg::new("request-id").long("request-id").help("Deduplication key for this process only").num_args(1))
                        .group(clap::ArgGroup::new("selector").args(["collection-id", "path"]).required(true).multiple(false))
                        .group(clap::ArgGroup::new("input").args(["file", "stdin"]).required(true).multiple(false)),
                )
                .subcommand(
                    Command::new("add-note")
                        .about("Create and link a Markdown note in a table collection")
                        .arg(Arg::new("notebook").long("notebook").num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .arg(Arg::new("title").long("title").help("Note title and filename").required(true).num_args(1))
                        .arg(Arg::new("request-id").long("request-id").help("Deduplication key for this process only").num_args(1))
                        .arg(Arg::new("file").long("file").num_args(1))
                        .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue))
                        .group(clap::ArgGroup::new("selector").args(["collection-id", "path"]).required(true).multiple(false))
                        .group(clap::ArgGroup::new("input").args(["file", "stdin"]).required(true).multiple(false)),
                ),
        )
        .subcommand(
            Command::new("edit")
                .about("Replace one exact occurrence in a note")
                .arg(required_arg("id"))
                .arg(
                    Arg::new("old")
                        .long("old")
                        .short('o')
                        .required(true)
                        .num_args(1..),
                )
                .arg(Arg::new("new").long("new").short('n').num_args(1..))
                .arg(
                    Arg::new("new-stdin")
                        .long("new-stdin")
                        .action(ArgAction::SetTrue),
                )
                .arg(Arg::new("new-file").long("new-file").num_args(1))
                .arg(
                    Arg::new("dry-run")
                        .long("dry-run")
                        .action(ArgAction::SetTrue),
                )
                .group(
                    clap::ArgGroup::new("replacement")
                        .args(["new", "new-stdin", "new-file"])
                        .required(true)
                        .multiple(false),
                ),
        )
        .subcommand(
            Command::new("write")
                .about("Replace a complete note; use --file for UTF-8 Markdown (recommended), or --stdin explicitly")
                .arg(required_arg("id"))
                .arg(Arg::new("if-version").long("if-version").help("Require the version returned by show"))
                .arg(Arg::new("file").long("file").short('f').value_name("UTF-8-MARKDOWN").help("Recommended: read Markdown content directly from a UTF-8 file").num_args(1))
                .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).help("Read Markdown from stdin; required explicitly on Windows"))
                .group(clap::ArgGroup::new("input").args(["file", "stdin"]).multiple(false)),
        )
        .subcommand(
            Command::new("search")
                .about("Search Markdown note text; paginate using next_offset and snapshot")
                .arg(Arg::new("offset").long("offset").value_parser(clap::value_parser!(usize)).default_value("0"))
                .arg(Arg::new("snapshot").long("snapshot").help("Snapshot from the first page; rejects changed results"))
                .arg(required_arg("query"))
                .arg(Arg::new("notebook").long("notebook").short('b').num_args(1))
                .arg(
                    Arg::new("tag")
                        .long("tag")
                        .short('t')
                        .value_name("TAG-PATH")
                        .help("Only return notes tagged with this path or one of its sub-tags")
                        .num_args(1),
                )
                .arg(
                    Arg::new("limit")
                        .long("limit")
                        .short('l')
                        .value_parser(clap::value_parser!(usize))
                        .num_args(1),
                ),
        )
        .subcommand(
            Command::new("plugin")
                .about("Discover plugin artifact tools and create their documents")
                .after_help("Use only when the user explicitly requests a plugin artifact.\n\n  flowix plugin list\n  flowix plugin describe <plugin-id>\n  flowix plugin create <plugin-id> --notebook <name|id|path> --json\n\nRead the tool description before creating an artifact. Create reads the complete input from stdin; do not create plugin output files manually. For a mind map, provide Markmap Markdown with exactly one H1 root, using H2/H3 headings and unordered lists for branches. On success, return title, notebookId, and notePath from the JSON result.")
                .subcommand_required(true)
                .subcommand(Command::new("list").about("List available artifact tools"))
                .subcommand(Command::new("describe").about("Show a tool's input contract and usage").arg(required_arg("plugin-id")))
                .subcommand(
                    Command::new("create")
                        .about("Create an artifact from complete input read from stdin")
                        .arg(required_arg("plugin-id"))
                        .arg(
                            Arg::new("notebook")
                                .long("notebook")
                                .short('b')
                                .allow_hyphen_values(true)
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("source-note")
                                .long("source-note")
                                .allow_hyphen_values(true)
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("producer")
                                .long("producer")
                                .allow_hyphen_values(true)
                                .num_args(1),
                        ),
                ),
        )
        .subcommand(Command::new("completion").about("Generate shell completion").arg(required_arg("shell")))
        .subcommand(
            Command::new("html")
                .about("Describe what a page inside a notebook can read (window.flowix), and print runnable templates")
                .after_help("Write the page into the notebook directory: a file outside it opens as an external file and every request answers E_SCOPE. Examples:\n  flowix html\n  flowix html --template workbench --out board.html\n  flowix html --json")
                .arg(Arg::new("template").long("template").value_name("ID").num_args(1).help("Print a runnable page template instead of the catalog; run `flowix html` to see the IDs"))
                .arg(Arg::new("out").long("out").value_name("PATH").num_args(1).allow_hyphen_values(true).help("Write the template to PATH as UTF-8 instead of stdout (avoids Windows shell encoding); refuses to overwrite"))
                .arg(Arg::new("force").long("force").action(ArgAction::SetTrue).help("Allow --out to overwrite an existing file")),
        )
        .subcommand(
            Command::new("component")
                .about("Create and list reusable notebook HTML components")
                .subcommand(
                    Command::new("create")
                        .about("Create a static HTML component in <notebook>/.flowix/editor-components")
                        .arg(required_arg("component-id"))
                        .arg(Arg::new("name").long("name").required(true).num_args(1))
                        .arg(Arg::new("notebook").long("notebook").short('b').allow_hyphen_values(true).num_args(1))
                        .arg(Arg::new("file").long("file").num_args(1).conflicts_with("stdin"))
                        .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).conflicts_with("file"))
                )
                .subcommand(
                    Command::new("list")
                        .about("List components in a notebook")
                        .arg(Arg::new("notebook").long("notebook").short('b').allow_hyphen_values(true).num_args(1)),
                )
                .subcommand(
                    Command::new("validate")
                        .about("Validate a static HTML component source file")
                        .arg(required_arg("file")),
                ),
        )
        .subcommand(Command::new("mcp").about("Run the Flowix MCP server over stdio"))
}

fn required_arg(name: &'static str) -> Arg {
    let arg = Arg::new(name)
        .required(true)
        .allow_hyphen_values(true)
        .num_args(1);
    if name == "id" {
        arg.value_name("NOTEBOOK::RELATIVE-PATH-OR-ABSOLUTE-PATH")
    } else {
        arg
    }
}

fn required_string(matches: &clap::ArgMatches, name: &str) -> Result<String, CliError> {
    matches
        .get_one::<String>(name)
        .cloned()
        .ok_or_else(|| CliError::Usage(format!("missing required argument `{name}`")))
}

fn joined_values(matches: &clap::ArgMatches, name: &str) -> Option<String> {
    matches
        .get_many::<String>(name)
        .map(|values| values.map(String::as_str).collect::<Vec<_>>().join(" "))
}

fn clap_to_cli_error(err: clap::Error) -> CliError {
    CliError::Usage(err.to_string())
}
pub fn print_help() {
    let mut command = cli_command();
    let _ = command.print_long_help();
    println!();
}

#[cfg(test)]
mod tests;
