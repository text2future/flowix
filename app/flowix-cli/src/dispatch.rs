//! CLI 命令调度层。
//!
//! `cli` 模块只负责把 argv 解析成结构化命令；这里负责把命令转给执行层。

use crate::{cli, errors::CliError, serve, store};

/// 跑 CLI 主入口。
pub fn run_cli(args: &[String]) -> Result<(), CliError> {
    let command = match cli::parse(args)? {
        Some(command) => command,
        None => return Ok(()),
    };

    match command {
        cli::Cli::Version => {
            println!("{} {}", cli::DISPLAY_BIN, env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        cli::Cli::Notebooks { json } => {
            if json {
                store::cmd_notebooks_json()
            } else {
                store::cmd_notebooks()
            }
        }
        cli::Cli::List { notebook, json } => {
            if json {
                store::cmd_list_json(&notebook)
            } else {
                store::cmd_list(&notebook)
            }
        }
        cli::Cli::Show { id, json } => {
            if json {
                store::cmd_show_json(&id)
            } else {
                store::cmd_show(&id)
            }
        }
        cli::Cli::Create { notebook, json } => store::cmd_create(&notebook, json),
        cli::Cli::Delete { id, json } => store::cmd_delete(&id, json),
        cli::Cli::Search {
            query,
            notebook,
            limit,
            json,
        } => store::cmd_search(&query, notebook.as_deref(), limit, json),
        cli::Cli::Edit {
            id,
            old,
            new,
            new_from_stdin,
            dry_run,
            json,
        } => store::cmd_edit(
            &id,
            old.as_deref(),
            new.as_deref(),
            new_from_stdin,
            dry_run,
            json,
        ),
        cli::Cli::Write { id, json } => store::cmd_write(&id, json),
        cli::Cli::Completion { shell } => store::cmd_completion(&shell),
        cli::Cli::Serve => {
            use std::io::{stdin, stdout};
            serve::run_serve(stdin().lock(), stdout().lock())
        }
    }
}
