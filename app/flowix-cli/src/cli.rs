//! CLI 命令定义与 argv 解析。
//!
//! 执行调度在 `dispatch` 模块，具体 memo 操作在 `store` 模块。

use clap::{Arg, ArgAction, Command};

use crate::errors::CliError;

pub(crate) const DISPLAY_BIN: &str = "flowix";

/// 解析后的 CLI 命令。
#[derive(Debug)]
pub enum Cli {
    Version,
    Notebooks {
        json: bool,
    },
    List {
        notebook: Option<String>,
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
        file: Option<String>,
        stdin: bool,
        json: bool,
    },
    Delete {
        id: String,
        json: bool,
    },
    Search {
        query: String,
        notebook: Option<String>,
        tag: Option<String>,
        limit: usize,
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
        Some(("notebooks", _)) => Ok(Some(Cli::Notebooks { json })),
        Some(("list", sub)) => Ok(Some(Cli::List {
            notebook: sub.get_one::<String>("notebook").cloned(),
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
            notebook: sub.get_one::<String>("notebook").cloned(),
            file: sub.get_one::<String>("file").cloned(),
            stdin: sub.get_flag("stdin"),
            json,
        })),
        Some(("delete", sub)) => Ok(Some(Cli::Delete {
            id: required_string(sub, "id")?,
            json,
        })),
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
        .after_help("For Markdown content, --file is recommended (especially on Windows PowerShell 5.1). Files must be UTF-8. On Windows, stdin is opt-in with --stdin because PowerShell may corrupt non-ASCII text. Examples:\n  flowix create <notebook> --file body.md --json\n  flowix write <id> --file body.md --json\n  flowix create <notebook> --stdin --json\n  flowix list\n  flowix search TODO --tag project/flowix --limit 20\n  flowix mcp")
        .arg(
            Arg::new("json")
                .long("json")
                .short('j')
                .global(true)
                .action(ArgAction::SetTrue),
        )
        .subcommand_required(true)
        .subcommand(Command::new("notebooks").about("List notebooks"))
        .subcommand(
            Command::new("list")
                .about("List notes; defaults to the current notebook")
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1)),
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
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1))
                .arg(Arg::new("file").long("file").short('f').value_name("UTF-8-MARKDOWN").help("Recommended: read Markdown content directly from a UTF-8 file").num_args(1))
                .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).help("Read Markdown from stdin; required explicitly on Windows"))
                .group(clap::ArgGroup::new("input").args(["file", "stdin"]).multiple(false)),
        )
        .subcommand(Command::new("delete").about("Delete a note").arg(required_arg("id")))
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
                .arg(Arg::new("file").long("file").short('f').value_name("UTF-8-MARKDOWN").help("Recommended: read Markdown content directly from a UTF-8 file").num_args(1))
                .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).help("Read Markdown from stdin; required explicitly on Windows"))
                .group(clap::ArgGroup::new("input").args(["file", "stdin"]).multiple(false)),
        )
        .subcommand(
            Command::new("search")
                .about("Search memo text")
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
                .about("Manage declared artifact tools")
                .subcommand_required(true)
                .subcommand(Command::new("list"))
                .subcommand(Command::new("describe").arg(required_arg("plugin-id")))
                .subcommand(
                    Command::new("create")
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
        .subcommand(Command::new("mcp").about("Run the Flowix MCP server over stdio"))
}

fn required_arg(name: &'static str) -> Arg {
    Arg::new(name)
        .required(true)
        .allow_hyphen_values(true)
        .num_args(1)
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
