//! CLI 命令调度层。
//!
//! `cli` 模块只负责把 argv 解析成结构化命令；这里负责把命令转给执行层。

use crate::{cli, component, errors::CliError, html, mcp, operation, path_store, plugin, store};

/// 跑 CLI 主入口。
pub fn run_cli(args: &[String]) -> Result<(), CliError> {
    let command = match cli::parse(args)? {
        Some(command) => command,
        None => return Ok(()),
    };

    match command {
        cli::Cli::RequestList { state, limit, json } => {
            path_store::print(crate::idempotency::list(state.as_deref(), limit)?, json)
        }
        cli::Cli::RequestShow {
            notebook,
            operation,
            request_id,
            json,
        } => path_store::print(
            crate::idempotency::show(&notebook, &operation, &request_id)?,
            json,
        ),
        cli::Cli::RequestReview {
            notebook,
            operation,
            request_id,
            outcome,
            actor,
            evidence,
            json,
        } => path_store::print(
            crate::idempotency::review(
                &notebook,
                &operation,
                &request_id,
                &outcome,
                &actor,
                evidence.as_deref(),
            )?,
            json,
        ),
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
        cli::Cli::List {
            notebook,
            limit,
            offset,
            snapshot,
            json,
        } => path_store::print(
            operation::execute(operation::FlowixOperation::List {
                notebook,
                limit,
                offset,
                snapshot,
            })?,
            json,
        ),
        cli::Cli::Tags { notebook, json } => store::cmd_tags(notebook.as_deref(), json),
        cli::Cli::Show { id, json } => path_store::print(path_store::show(&id)?, json),
        cli::Cli::Create {
            notebook,
            folder,
            title,
            file,
            stdin,
            request_id,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "create")?;
            path_store::print(
                operation::execute(operation::FlowixOperation::Create {
                    notebook,
                    title,
                    folder,
                    content,
                    request_id,
                })?,
                json,
            )
        }
        cli::Cli::Delete {
            id,
            expected_version,
            json,
        } => path_store::print(path_store::delete(&id, expected_version.as_deref())?, json),
        cli::Cli::CollectionCreate {
            notebook,
            path,
            fields_file,
            json,
        } => {
            let data = crate::collection_store::create(&notebook, &path, fields_file.as_deref())?;
            path_store::print(data, json)
        }
        cli::Cli::CollectionAdd {
            notebook,
            collection_id,
            path,
            file,
            stdin,
            request_id,
            json,
        } => {
            let input = path_store::read_input(file.as_deref(), stdin, "collection add")?;
            let data = crate::collection_store::add_record(
                &notebook,
                collection_id.as_deref(),
                path.as_deref(),
                &input,
                request_id.as_deref(),
            )?;
            path_store::print(data, json)
        }
        cli::Cli::CollectionAddFields {
            notebook,
            collection_id,
            path,
            fields_file,
            json,
        } => {
            let data = crate::collection_store::add_fields(
                &notebook,
                collection_id.as_deref(),
                path.as_deref(),
                &fields_file,
            )?;
            path_store::print(data, json)
        }
        cli::Cli::CollectionRead {
            notebook,
            collection_id,
            path,
            json,
        } => {
            let data = operation::execute(operation::FlowixOperation::CollectionRead {
                notebook,
                collection_id,
                path,
            })?;
            path_store::print(data, json)
        }
        cli::Cli::CollectionAddNote {
            notebook,
            collection_id,
            path,
            title,
            file,
            stdin,
            request_id,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "collection add-note")?;
            let data = operation::execute(operation::FlowixOperation::CollectionAddNote {
                notebook,
                collection_id,
                path,
                title,
                content,
                request_id,
            })?;
            path_store::print(data, json)
        }
        cli::Cli::CollectionList {
            notebook,
            collection_type,
            domain,
            query,
            limit,
            offset,
            snapshot,
            json,
        } => {
            let data = operation::execute(operation::FlowixOperation::CollectionList {
                notebook,
                collection_type,
                domain,
                query,
                limit,
                offset,
                snapshot,
            })?;
            path_store::print(data, json)
        }
        cli::Cli::CollectionDescribe {
            notebook,
            collection_id,
            path,
            json,
        } => {
            let data = operation::execute(operation::FlowixOperation::CollectionDescribe {
                notebook,
                collection_id,
                path,
            })?;
            path_store::print(data, json)
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
            json,
        } => {
            let data = operation::execute(operation::FlowixOperation::CollectionQuery {
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
            })?;
            path_store::print(data, json)
        }
        cli::Cli::Search {
            query,
            notebook,
            tag,
            limit,
            offset,
            snapshot,
            json,
        } => path_store::print(
            path_store::search(
                &query,
                notebook.as_deref(),
                tag.as_deref(),
                limit,
                offset,
                snapshot.as_deref(),
            )?,
            json,
        ),
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
            } else {
                new.ok_or_else(|| {
                    CliError::Usage("edit requires --new, --new-file or --new-stdin".into())
                })?
            };
            path_store::print(path_store::edit(&id, &old, &replacement, dry_run)?, json)
        }
        cli::Cli::Write {
            id,
            expected_version,
            file,
            stdin,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "write")?;
            path_store::print(
                path_store::write(&id, &content, expected_version.as_deref())?,
                json,
            )
        }
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
        cli::Cli::Html {
            template,
            out,
            force,
            json,
        } => html::cmd(template.as_deref(), out.as_deref(), force, json),
        cli::Cli::ComponentCatalog { json } => component::cmd_catalog(json),
        cli::Cli::ComponentCreate {
            notebook,
            id,
            name,
            file,
            stdin,
            json,
        } => component::cmd_create(
            notebook.as_deref(),
            &id,
            &name,
            file.as_deref(),
            stdin,
            json,
        ),
        cli::Cli::ComponentList { notebook, json } => {
            component::cmd_list(notebook.as_deref(), json)
        }
        cli::Cli::ComponentValidate { file, json } => component::cmd_validate(&file, json),
        cli::Cli::Mcp => {
            use std::io::{stdin, stdout};
            mcp::run_mcp(stdin().lock(), stdout().lock())
        }
    }
}
