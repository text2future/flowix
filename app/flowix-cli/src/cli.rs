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
        notebook: String,
        json: bool,
    },
    Show {
        id: String,
        json: bool,
    },
    Create {
        notebook: String,
        json: bool,
    },
    Delete {
        id: String,
        json: bool,
    },
    Search {
        query: String,
        notebook: Option<String>,
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
        dry_run: bool,
        json: bool,
    },
    /// 覆盖整个笔记内容 (从 stdin 读) ── `edit` 的非交互等价物。
    /// 第一行 `# title` 变了 → 自动 rename 物理文件 + 同步 memo index。
    Write {
        id: String,
        json: bool,
    },
    Completion {
        shell: String,
    },
    /// JSON-RPC over stdio (line-delimited)。 给 Flowix desktop 做 sidecar 用 ──
    /// 从 stdin 读 `{id, method, params}` 行, 向 stdout 写响应。 走 `serve::run_serve`。
    /// 普通用户不直接调, 是内部协议。
    Serve,
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

    preflight_usage_errors(args)?;

    if matches!(first_command(args).as_deref(), Some("edit" | "e")) {
        return parse_edit_command(args).map(Some);
    }

    let argv = std::iter::once(DISPLAY_BIN.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let matches = cli_command()
        .try_get_matches_from(argv)
        .map_err(clap_to_cli_error)?;
    let json = matches.get_flag("json");

    match matches.subcommand() {
        Some(("notebooks", _)) => Ok(Some(Cli::Notebooks { json })),
        Some(("list", sub)) => Ok(Some(Cli::List {
            notebook: required_string(sub, "notebook")?,
            json,
        })),
        Some(("show", sub)) => Ok(Some(Cli::Show {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("create", sub)) => Ok(Some(Cli::Create {
            notebook: required_string(sub, "notebook")?,
            json,
        })),
        Some(("delete", sub)) => Ok(Some(Cli::Delete {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("edit", sub)) => Ok(Some(Cli::Edit {
            id: required_string(sub, "id")?,
            old: sub.get_one::<String>("old").cloned(),
            new: sub.get_one::<String>("new").cloned(),
            new_from_stdin: sub.get_flag("new-stdin"),
            dry_run: sub.get_flag("dry-run"),
            json,
        })),
        Some(("write", sub)) => Ok(Some(Cli::Write {
            id: required_string(sub, "id")?,
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
                limit,
                json,
            }))
        }
        Some(("completion", sub)) => Ok(Some(Cli::Completion {
            shell: required_string(sub, "shell")?,
        })),
        Some(("serve", _)) => Ok(Some(Cli::Serve)),
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
        .disable_help_flag(true)
        .disable_version_flag(true)
        .arg(
            Arg::new("json")
                .long("json")
                .short('j')
                .global(true)
                .action(ArgAction::SetTrue),
        )
        .subcommand_required(true)
        .subcommand(Command::new("notebooks").alias("nb"))
        .subcommand(
            Command::new("list")
                .alias("ls")
                .arg(required_arg("notebook")),
        )
        .subcommand(Command::new("show").alias("s").arg(required_arg("id")))
        .subcommand(
            Command::new("create")
                .alias("new")
                .alias("c")
                .arg(required_arg("notebook")),
        )
        .subcommand(Command::new("delete").alias("rm").arg(required_arg("id")))
        .subcommand(
            Command::new("edit")
                .alias("e")
                .arg(required_arg("id"))
                .arg(Arg::new("old").long("old").short('o').num_args(1))
                .arg(Arg::new("new").long("new").short('n').num_args(1))
                .arg(
                    Arg::new("new-stdin")
                        .long("new-stdin")
                        .action(ArgAction::SetTrue),
                )
                .arg(
                    Arg::new("dry-run")
                        .long("dry-run")
                        .action(ArgAction::SetTrue),
                ),
        )
        .subcommand(Command::new("write").alias("w").arg(required_arg("id")))
        .subcommand(
            Command::new("search")
                .alias("q")
                .arg(required_arg("query"))
                .arg(Arg::new("notebook").long("notebook").short('b').num_args(1))
                .arg(
                    Arg::new("limit")
                        .long("limit")
                        .short('l')
                        .value_parser(clap::value_parser!(usize))
                        .num_args(1),
                ),
        )
        .subcommand(Command::new("completion").arg(required_arg("shell")))
        .subcommand(Command::new("serve"))
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

fn clap_to_cli_error(err: clap::Error) -> CliError {
    CliError::Usage(err.to_string())
}

fn preflight_usage_errors(args: &[String]) -> Result<(), CliError> {
    let command = first_command(args);
    match command.as_deref() {
        Some("list") | Some("ls") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} list <notebook> [--json]"
                )));
            }
        }
        Some("show") | Some("s") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} show <id> [--json]"
                )));
            }
        }
        Some("delete") | Some("rm") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!("usage: {DISPLAY_BIN} delete <id>")));
            }
        }
        Some("write") | Some("w") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} write <id>  (reads body from stdin)"
                )));
            }
        }
        Some("completion") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} completion <bash|zsh|fish>"
                )));
            }
        }
        Some("edit") | Some("e") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
                )));
            }
            missing_value(args, &["--old", "-o"], "edit: --old/-o requires a value")?;
            missing_value(args, &["--new", "-n"], "edit: --new/-n requires a value")?;
        }
        Some("search") | Some("q") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} search <query> [--notebook|-b <nb>] [--limit|-l <n>]"
                )));
            }
            missing_value(
                args,
                &["--notebook", "-b"],
                "search: --notebook/-b requires a value",
            )?;
            missing_value(
                args,
                &["--limit", "-l"],
                "search: --limit/-l requires a value",
            )?;
            invalid_limit_value(args)?;
            unknown_flags(
                args,
                &["--json", "-j", "--notebook", "-b", "--limit", "-l"],
                |flag| {
                    format!(
                        "search: unknown arg `{flag}`\n\
                         usage: {DISPLAY_BIN} search <query> [--notebook|-b <nb>] [--limit|-l <n>]"
                    )
                },
            )?;
        }
        Some("serve") => {
            let extras = args
                .iter()
                .filter(|a| a.as_str() != "--json" && a.as_str() != "-j")
                .skip_while(|a| a.as_str() != "serve")
                .skip(1)
                .count();
            if extras > 0 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} serve  (no extra args; reads JSON-RPC from stdin)"
                )));
            }
        }
        Some("create") | Some("new") | Some("c") => {
            let positional = command_positionals(args, &["--json", "-j"]);
            if positional.len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} create <notebook>  (body from stdin)\n\
                     (aliases: new, c)"
                )));
            }
            if positional.len() > 2 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} create <notebook>  (body from stdin)\n\
                     (no extra positional args; title is derived from body's first `# heading`)"
                )));
            }
        }
        Some("notebooks") | Some("nb") => {}
        Some(other) => {
            return Err(CliError::Usage(format!(
                "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
            )));
        }
        _ => {}
    }
    Ok(())
}

#[derive(Copy, Clone)]
enum EditValueTarget {
    Old,
    New,
}

fn parse_edit_command(args: &[String]) -> Result<Cli, CliError> {
    let mut json = false;
    let mut seen_command = false;
    let mut id: Option<String> = None;
    let mut old_parts: Vec<String> = Vec::new();
    let mut new_parts: Vec<String> = Vec::new();
    let mut seen_old = false;
    let mut seen_new = false;
    let mut new_from_stdin = false;
    let mut dry_run = false;
    let mut target: Option<EditValueTarget> = None;

    for arg in args {
        let value = arg.as_str();
        if !seen_command {
            match value {
                "--json" | "-j" => json = true,
                "edit" | "e" => seen_command = true,
                other => {
                    return Err(CliError::Usage(format!(
                        "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
                    )))
                }
            }
            continue;
        }

        if matches!(value, "--json" | "-j") {
            json = true;
            continue;
        }

        if id.is_none() {
            id = Some(arg.clone());
            continue;
        }

        match value {
            "--old" | "-o" => {
                seen_old = true;
                target = Some(EditValueTarget::Old);
            }
            "--new" | "-n" => {
                seen_new = true;
                target = Some(EditValueTarget::New);
            }
            "--new-stdin" => {
                new_from_stdin = true;
                target = None;
            }
            "--dry-run" => {
                dry_run = true;
                target = None;
            }
            other if other.starts_with('-') && other.len() > 1 => {
                return Err(CliError::Usage(format!(
                    "edit: unknown arg `{other}`\n\
                     usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin] [--dry-run]"
                )))
            }
            other => match target {
                Some(EditValueTarget::Old) => old_parts.push(other.to_string()),
                Some(EditValueTarget::New) => new_parts.push(other.to_string()),
                None => {
                    return Err(CliError::Usage(format!(
                        "edit: unexpected argument `{other}`\n\
                         usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
                    )))
                }
            },
        }
    }

    if !seen_command {
        return Err(CliError::Usage(format!(
            "usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
        )));
    }

    let id = id.ok_or_else(|| {
        CliError::Usage(format!(
            "usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
        ))
    })?;

    let old = if seen_old {
        Some(old_parts.join(" "))
    } else {
        None
    };
    let new = if seen_new {
        Some(new_parts.join(" "))
    } else {
        None
    };

    Ok(Cli::Edit {
        id,
        old,
        new,
        new_from_stdin,
        dry_run,
        json,
    })
}

fn first_command(args: &[String]) -> Option<String> {
    args.iter()
        .find(|a| a.as_str() != "--json" && a.as_str() != "-j")
        .cloned()
}

fn command_positionals<'a>(args: &'a [String], global_flags: &[&str]) -> Vec<&'a str> {
    args.iter()
        .filter(|a| !global_flags.contains(&a.as_str()))
        .map(String::as_str)
        .collect()
}

fn missing_value(args: &[String], flags: &[&str], message: &str) -> Result<(), CliError> {
    for (idx, arg) in args.iter().enumerate() {
        if flags.contains(&arg.as_str()) {
            let missing = args
                .get(idx + 1)
                .map(|next| next.starts_with('-'))
                .unwrap_or(true);
            if missing {
                return Err(CliError::Usage(message.into()));
            }
        }
    }
    Ok(())
}

fn invalid_limit_value(args: &[String]) -> Result<(), CliError> {
    for (idx, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--limit" | "-l") {
            if let Some(value) = args.get(idx + 1) {
                if value.parse::<usize>().is_err() {
                    return Err(CliError::Usage(format!(
                        "search: --limit/-l requires a positive integer, got `{value}`"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn unknown_flags(
    args: &[String],
    known_flags: &[&str],
    message: impl Fn(&str) -> String,
) -> Result<(), CliError> {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        let value = arg.as_str();
        if known_flags.contains(&value) {
            if matches!(
                value,
                "--old" | "-o" | "--new" | "-n" | "--notebook" | "-b" | "--limit" | "-l"
            ) {
                let _ = iter.next();
            }
            continue;
        }
        if value.starts_with('-') {
            return Err(CliError::Usage(message(value)));
        }
    }
    Ok(())
}

pub fn print_help() {
    let usage = "\
USAGE:
    flowix [GLOBAL FLAGS] <COMMAND> [ARGS]

GLOBAL FLAGS:
    --version, -V      Print version and exit
    --help, -h         Print this help and exit
    --json, -j         Output as JSON where supported

COMMANDS:
    notebooks          List all notebooks                    [alias: nb]
    list <notebook>    List notes in a notebook              [alias: ls]
    show <id>          Print a note to stdout                [alias: s]
    create <notebook>  Create a new note (body from stdin)   [alias: new, c]
                       title derived from first `# heading` line
    delete <id>        Delete a note                         [alias: rm]
    edit <id>          Incremental edit by exact-string replace [alias: e]
                       --old|-o <text> --new|-n <text> [--new-stdin] [--dry-run]
                       old must match exactly once; non-interactive;
                       auto-rename on title change
    write <id>         Overwrite a note (body from stdin)    [alias: w]
                       non-interactive; auto-rename on title change
    search <query>     Full-text search                      [alias: q]
                       [--notebook|-b <nb>] [--limit|-l <n>]
    completion <sh>    Print shell completion (bash|zsh|fish)
    serve             JSON-RPC over stdio (internal: Flowix desktop sidecar)

ENVIRONMENT:
    FLOWIX_HOME        Override config dir (default: ~/.flowix; contains index.db)
    FLOWIX_DATA        Override data dir (default: <OS data dir>/flowix)

EXAMPLES:
    flowix --version
    flowix notebooks
    flowix notebooks --json | jq
    flowix list work
    flowix list work --json | jq '.[] | select(.favorited)'
    flowix show a1b2c3
    flowix show a1b2c3 --json | jq '.body'
    echo \"# hello\" | flowix create work
    printf \"# new title\\nbody\\n\" | flowix write a1b2c3
    flowix edit a1b2c3 --old \"old text\" --new \"new text\"
    flowix search TODO --limit 20
    FLOWIX_HOME=/tmp/fx-test flowix notebooks
";
    print!("{usage}");
}

#[cfg(test)]
mod tests {
    //! `parse()` 全分支覆盖 ── 把 CLI 表面契约锁住。
    //!
    //! 测试的是 **用户感知** 的 arg 解析行为, 不是 cmd_* 函数的具体动作。
    //! 后者要 `MemoFile` 真实环境, 在 store.rs 里加 `#[cfg(test)]` 集成测试
    //! (需要 tempfile + 临时 notebook) ── 见后续工单。

    use super::*;

    /// `&[&str]` → `Vec<String>` 助手, 测试代码更紧凑。
    fn parse_args(args: &[&str]) -> Result<Option<Cli>, CliError> {
        parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    fn assert_err_contains(err: &CliError, needle: &str) {
        let msg = err.to_string();
        assert!(
            msg.contains(needle),
            "error message `{msg}` does not contain `{needle}`"
        );
    }

    // ===== Help / Version =====

    #[test]
    fn empty_args_prints_help() {
        // 0 args → 打印 help, 正常退出 (Ok(None) 是 print_help 路径)
        assert!(matches!(parse_args(&[]), Ok(None)));
    }

    #[test]
    fn help_variants() {
        for flag in ["--help", "-h", "help"] {
            assert!(
                matches!(parse_args(&[flag]), Ok(None)),
                "`{flag}` should print help"
            );
        }
    }

    #[test]
    fn version_variants() {
        for flag in ["--version", "-V"] {
            assert!(
                matches!(parse_args(&[flag]), Ok(Some(Cli::Version))),
                "`{flag}` should return Cli::Version"
            );
        }
    }

    // ===== Notebooks =====

    #[test]
    fn notebooks_basic_and_alias() {
        assert!(matches!(
            parse_args(&["notebooks"]),
            Ok(Some(Cli::Notebooks { json: false }))
        ));
        assert!(matches!(
            parse_args(&["nb"]),
            Ok(Some(Cli::Notebooks { json: false }))
        ));
    }

    #[test]
    fn notebooks_json_anywhere() {
        // --json 在 verb 前 / 后 / -j 短选项, 都应被识别
        assert!(matches!(
            parse_args(&["notebooks", "--json"]),
            Ok(Some(Cli::Notebooks { json: true }))
        ));
        assert!(matches!(
            parse_args(&["--json", "notebooks"]),
            Ok(Some(Cli::Notebooks { json: true }))
        ));
        assert!(matches!(
            parse_args(&["-j", "notebooks"]),
            Ok(Some(Cli::Notebooks { json: true }))
        ));
    }

    #[test]
    fn notebook_alias_removed() {
        // 旧别名 `notebook` (单数) 已删除, 应该报 unknown command
        let err = parse_args(&["notebook"]).unwrap_err();
        assert_err_contains(&err, "unknown command");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== List =====

    #[test]
    fn list_basic_and_alias() {
        assert!(matches!(
            parse_args(&["list", "Default Notebook"]),
            Ok(Some(Cli::List {
                notebook,
                json: false,
            })) if notebook == "Default Notebook"
        ));
        assert!(matches!(
            parse_args(&["ls", "Default Notebook"]),
            Ok(Some(Cli::List {
                notebook,
                json: false,
            })) if notebook == "Default Notebook"
        ));
    }

    #[test]
    fn list_missing_arg_errors() {
        let err = parse_args(&["list"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Show =====

    #[test]
    fn show_basic_and_alias() {
        assert!(matches!(
            parse_args(&["show", "abc123"]),
            Ok(Some(Cli::Show { id, json: false })) if id == "abc123"
        ));
        assert!(matches!(
            parse_args(&["s", "abc123"]),
            Ok(Some(Cli::Show { id, json: false })) if id == "abc123"
        ));
    }

    #[test]
    fn show_missing_arg_errors() {
        let err = parse_args(&["show"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Create =====

    #[test]
    fn create_basic_and_aliases() {
        // 主命令 `create` + 旧别名 `new` + 短别名 `c` 都工作
        for verb in ["create", "new", "c"] {
            assert!(
                matches!(
                    parse_args(&[verb, "Default Notebook"]),
                    Ok(Some(Cli::Create {
                        notebook,
                        json: false,
                    })) if notebook == "Default Notebook"
                ),
                "`{verb}` should be a valid alias for create"
            );
        }
    }

    #[test]
    fn create_missing_arg_errors() {
        for verb in ["create", "new", "c"] {
            let err = parse_args(&[verb]).unwrap_err();
            assert_err_contains(&err, "usage:");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn create_extra_positional_errors() {
        // 多余位置参数 (旧 `new <nb> name` 走编辑器的用法) 现在严格拒绝
        let err = parse_args(&["create", "Default Notebook", "extra"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_err_contains(&err, "no extra positional args");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn create_dash_suffix_no_longer_special() {
        // 旧 `new <nb> -` 用法已废, `-` 现在被当 notebook 名, 但仍走 stdin
        assert!(matches!(
            parse_args(&["create", "-"]),
            Ok(Some(Cli::Create {
                notebook,
                json: false,
            })) if notebook == "-"
        ));
    }

    // ===== Delete =====

    #[test]
    fn delete_basic_and_alias() {
        assert!(matches!(
            parse_args(&["delete", "abc123"]),
            Ok(Some(Cli::Delete { id, json: false })) if id == "abc123"
        ));
        assert!(matches!(
            parse_args(&["rm", "abc123"]),
            Ok(Some(Cli::Delete { id, json: false })) if id == "abc123"
        ));
    }

    #[test]
    fn delete_missing_arg_errors() {
        let err = parse_args(&["delete"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Edit (B 风格: --old / --new) =====

    #[test]
    fn edit_basic_old_and_new_long() {
        assert!(matches!(
            parse_args(&["edit", "abc123", "--old", "foo", "--new", "bar"]),
            Ok(Some(Cli::Edit {
                id,
                old: Some(o),
                new: Some(n),
                new_from_stdin: false,
                dry_run: false,
                json: false,
            })) if id == "abc123" && o == "foo" && n == "bar"
        ));
    }

    #[test]
    fn edit_joins_split_old_and_new_values() {
        assert!(matches!(
            parse_args(&[
                "edit", "abc123", "--old", "line", "A:", "original", "alpha", "--new", "line",
                "A:", "EDITED", "alpha"
            ]),
            Ok(Some(Cli::Edit {
                id,
                old: Some(o),
                new: Some(n),
                ..
            })) if id == "abc123" && o == "line A: original alpha" && n == "line A: EDITED alpha"
        ));
    }

    #[test]
    fn edit_alias_e() {
        assert!(matches!(
            parse_args(&["e", "abc123", "-o", "foo", "-n", "bar"]),
            Ok(Some(Cli::Edit {
                id,
                old: Some(o),
                new: Some(n),
                ..
            })) if id == "abc123" && o == "foo" && n == "bar"
        ));
    }

    #[test]
    fn edit_short_flags() {
        assert!(matches!(
            parse_args(&["edit", "id", "-o", "x", "-n", "y"]),
            Ok(Some(Cli::Edit {
                old: Some(o),
                new: Some(n),
                ..
            })) if o == "x" && n == "y"
        ));
    }

    #[test]
    fn edit_new_stdin_flag() {
        assert!(matches!(
            parse_args(&["edit", "id", "--old", "foo", "--new-stdin"]),
            Ok(Some(Cli::Edit {
                old: Some(o),
                new: None,
                new_from_stdin: true,
                ..
            })) if o == "foo"
        ));
    }

    #[test]
    fn edit_json_flag() {
        assert!(matches!(
            parse_args(&["edit", "id", "--old", "x", "--new", "y", "--json"]),
            Ok(Some(Cli::Edit { json: true, .. }))
        ));
    }

    #[test]
    fn edit_dry_run_flag() {
        assert!(matches!(
            parse_args(&["edit", "id", "--old", "x", "--new", "y", "--dry-run"]),
            Ok(Some(Cli::Edit { dry_run: true, .. }))
        ));
    }

    #[test]
    fn edit_missing_id_errors() {
        let err = parse_args(&["edit"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_err_contains(&err, "--old");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn edit_missing_old_errors() {
        // parse 层只校验 id 存在, --old 缺失由 cmd_edit 阶段报错
        // (parse 不能区分 "后面会从 stdin 给" 还是 "真的漏了")
        assert!(matches!(
            parse_args(&["edit", "abc123"]),
            Ok(Some(Cli::Edit { id, old: None, .. })) if id == "abc123"
        ));
    }

    #[test]
    fn edit_old_missing_value_errors() {
        let err = parse_args(&["edit", "id", "--old"]).unwrap_err();
        assert_err_contains(&err, "--old/-o requires a value");
        assert_eq!(err.exit_code(), 2);
        let err = parse_args(&["edit", "id", "-o"]).unwrap_err();
        assert_err_contains(&err, "--old/-o requires a value");
    }

    #[test]
    fn edit_new_missing_value_errors() {
        let err = parse_args(&["edit", "id", "--old", "x", "--new"]).unwrap_err();
        assert_err_contains(&err, "--new/-n requires a value");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn edit_unknown_flag_errors() {
        let err = parse_args(&["edit", "id", "--old", "x", "--new", "y", "--foo"]).unwrap_err();
        assert_err_contains(&err, "edit: unknown arg `--foo`");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn edit_old_with_stdin_combo_works() {
        // --old 参数 + --new-stdin 都合法, parse 不互斥
        assert!(matches!(
            parse_args(&["edit", "id", "-o", "x", "--new-stdin"]),
            Ok(Some(Cli::Edit {
                old: Some(o),
                new: None,
                new_from_stdin: true,
                ..
            })) if o == "x"
        ));
    }

    // ===== Write =====

    #[test]
    fn write_basic_and_alias() {
        assert!(matches!(
            parse_args(&["write", "abc123"]),
            Ok(Some(Cli::Write { id, json: false })) if id == "abc123"
        ));
        assert!(matches!(
            parse_args(&["w", "abc123"]),
            Ok(Some(Cli::Write { id, json: false })) if id == "abc123"
        ));
    }

    #[test]
    fn write_missing_arg_errors() {
        let err = parse_args(&["write"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Search =====

    #[test]
    fn search_basic() {
        assert!(matches!(
            parse_args(&["search", "TODO"]),
            Ok(Some(Cli::Search {
                query,
                notebook: None,
                limit: 20,
                json: false,
            })) if query == "TODO"
        ));
    }

    #[test]
    fn search_alias_q() {
        assert!(matches!(
            parse_args(&["q", "TODO"]),
            Ok(Some(Cli::Search { query, .. })) if query == "TODO"
        ));
    }

    #[test]
    fn search_with_notebook_long_and_short() {
        // --notebook / -b 都接受, json flag 可以插在中间
        assert!(matches!(
            parse_args(&["search", "TODO", "--notebook", "work"]),
            Ok(Some(Cli::Search {
                query,
                notebook: Some(nb),
                limit: 20,
                ..
            })) if query == "TODO" && nb == "work"
        ));
        assert!(matches!(
            parse_args(&["search", "--json", "TODO", "-b", "work"]),
            Ok(Some(Cli::Search {
                notebook: Some(nb),
                json: true,
                ..
            })) if nb == "work"
        ));
    }

    #[test]
    fn search_with_limit_long_and_short() {
        assert!(matches!(
            parse_args(&["search", "TODO", "--limit", "5"]),
            Ok(Some(Cli::Search { limit: 5, .. }))
        ));
        assert!(matches!(
            parse_args(&["search", "TODO", "-l", "5"]),
            Ok(Some(Cli::Search { limit: 5, .. }))
        ));
    }

    #[test]
    fn search_with_both_flags() {
        assert!(matches!(
            parse_args(&["search", "TODO", "-b", "work", "-l", "3"]),
            Ok(Some(Cli::Search {
                query,
                notebook: Some(nb),
                limit: 3,
                ..
            })) if query == "TODO" && nb == "work"
        ));
    }

    #[test]
    fn search_missing_arg_errors() {
        let err = parse_args(&["search"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn search_notebook_missing_value_errors() {
        // 旧 bug: --notebook 不带值时静默成 None, 现在严格报错
        let err = parse_args(&["search", "TODO", "--notebook"]).unwrap_err();
        assert_err_contains(&err, "--notebook/-b requires a value");
        assert_eq!(err.exit_code(), 2);
        let err = parse_args(&["search", "TODO", "-b"]).unwrap_err();
        assert_err_contains(&err, "--notebook/-b requires a value");
    }

    #[test]
    fn search_limit_non_integer_errors() {
        let err = parse_args(&["search", "TODO", "--limit", "abc"]).unwrap_err();
        assert_err_contains(&err, "positive integer");
        assert_err_contains(&err, "`abc`");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn search_limit_zero_errors() {
        let err = parse_args(&["search", "TODO", "--limit", "0"]).unwrap_err();
        assert_err_contains(&err, "positive integer");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn search_limit_missing_value_errors() {
        let err = parse_args(&["search", "TODO", "--limit"]).unwrap_err();
        assert_err_contains(&err, "--limit/-l requires a value");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn search_unknown_flag_errors() {
        let err = parse_args(&["search", "TODO", "--foo"]).unwrap_err();
        assert_err_contains(&err, "unknown arg `--foo`");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn search_old_n_alias_no_longer_valid() {
        // 修复 B: search 短选项 -n 已改为 -b, 旧 -n 应该是 unknown arg
        let err = parse_args(&["search", "TODO", "-n", "work"]).unwrap_err();
        assert_err_contains(&err, "unknown arg `-n`");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Completion =====

    #[test]
    fn completion_basic() {
        assert!(matches!(
            parse_args(&["completion", "bash"]),
            Ok(Some(Cli::Completion { shell })) if shell == "bash"
        ));
    }

    #[test]
    fn completion_missing_arg_errors() {
        let err = parse_args(&["completion"]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Serve =====

    #[test]
    fn serve_basic() {
        assert!(matches!(parse_args(&["serve"]), Ok(Some(Cli::Serve))));
    }

    #[test]
    fn serve_rejects_extra_args() {
        let err = parse_args(&["serve", "extra"]).unwrap_err();
        assert_err_contains(&err, "no extra args");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== Unknown command =====

    #[test]
    fn unknown_command_errors() {
        let err = parse_args(&["foo"]).unwrap_err();
        assert_err_contains(&err, "unknown command: `foo`");
        assert_err_contains(&err, "--help");
        assert_eq!(err.exit_code(), 2);
    }

    // ===== 退出码契约 =====

    #[test]
    fn exit_codes() {
        // 4 个 CliError 变体各自映射到约定的退出码
        assert_eq!(CliError::Usage("x".into()).exit_code(), 2);
        assert_eq!(CliError::NotFound("x".into()).exit_code(), 3);
        assert_eq!(
            CliError::Io(std::io::Error::new(std::io::ErrorKind::Other, "x")).exit_code(),
            5
        );
        assert_eq!(CliError::Other("x".into()).exit_code(), 1);
    }
}
