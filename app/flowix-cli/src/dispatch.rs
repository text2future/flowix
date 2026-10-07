//! CLI 命令调度层。
//!
//! `cli` 模块只负责把 argv 解析成结构化命令；这里负责把命令转给执行层。

use crate::{cli, errors::CliError, mcp, operation, path_store, plugin, store};

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
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::print(path_store::list(&notebook)?, json)
        }
        cli::Cli::Tags { notebook, json } => store::cmd_tags(notebook.as_deref(), json),
        cli::Cli::Show { id, json } => path_store::print(path_store::show(&id)?, json),
        cli::Cli::Create {
            notebook,
            file,
            stdin,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "create")?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::print(path_store::create(&notebook, &content)?, json)
        }
        cli::Cli::Delete { id, json } => path_store::print(path_store::delete(&id)?, json),
        cli::Cli::CollectionRead { notebook, collection_id, path, json } => {
            let data = operation::execute(operation::FlowixOperation::CollectionRead {
                notebook, collection_id, path,
            })?;
            path_store::print(data, json)
        }
        cli::Cli::Search {
            query,
            notebook,
            tag,
            limit,
            json,
        } => path_store::print(path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit)?, json),
        cli::Cli::Edit {
            id,
            old,
            new,
            new_from_stdin,
            new_file,
            dry_run,
            json,
        } => {
            let old = old.ok_or_else(|| CliError::Usage("edit requires --old".into()))?;
            let replacement = if new_from_stdin {
                path_store::read_input(None, true, "edit")?
            } else if let Some(file) = new_file {
                path_store::read_input(Some(&file), false, "edit")?
            } else { new.ok_or_else(|| CliError::Usage("edit requires --new, --new-file or --new-stdin".into()))? };
            path_store::print(path_store::edit(&id, &old, &replacement, dry_run)?, json)
        },
        cli::Cli::Write {
            id,
            file,
            stdin,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "write")?;
            path_store::print(path_store::write(&id, &content)?, json)
        },
        cli::Cli::PluginList { json } => plugin::cmd_list(json),
        cli::Cli::PluginDescribe { plugin_id, json } => plugin::cmd_describe(&plugin_id, json),
        cli::Cli::PluginCreate {
            plugin_id,
            notebook,
            source_note,
            producer,
            json,
        } => plugin::cmd_create(
            &plugin_id,
            notebook.as_deref(),
            source_note.as_deref(),
            &producer,
            json,
        ),
        cli::Cli::Completion { shell } => store::cmd_completion(&shell),
        cli::Cli::Mcp => {
            use std::io::{stdin, stdout};
            mcp::run_mcp(stdin().lock(), stdout().lock())
        }
    }
}
