//! Transport-neutral Flowix operations shared by CLI and MCP adapters.

use crate::{collection_store, errors::CliError, fmt, output, path_store, plugin, store};
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum FlowixOperation {
    Notebooks,
    List {
        notebook: Option<String>,
        limit: usize,
        offset: usize,
    },
    Tags {
        notebook: Option<String>,
    },
    Show {
        address: String,
    },
    Search {
        query: String,
        notebook: Option<String>,
        tag: Option<String>,
        limit: usize,
    },
    Create {
        notebook: Option<String>,
        content: String,
    },
    Edit {
        address: String,
        old: String,
        replacement: String,
        dry_run: bool,
    },
    Write {
        address: String,
        content: String,
    },
    Delete {
        address: String,
    },
    CollectionRead {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
    },
    CollectionList {
        notebook: Option<String>,
        collection_type: Option<String>,
        domain: Option<String>,
        query: Option<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
    },
    CollectionDescribe {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
    },
    CollectionQuery {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        domain: Option<String>,
        view_id: Option<String>,
        query: Option<String>,
        fields: Vec<String>,
        sort: Vec<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
    },
    ArtifactList,
    ArtifactDescribe {
        plugin_id: String,
    },
    ArtifactCreate {
        plugin_id: String,
        notebook: Option<String>,
        source_note: Option<String>,
        producer: String,
        content: String,
    },
}

pub(crate) fn execute(operation: FlowixOperation) -> Result<Value, CliError> {
    match operation {
        FlowixOperation::Notebooks => {
            let (configs, selected) = store::notebooks_list_data()?;
            let counts = store::notebook_note_counts(&configs)?;
            let tag_counts = store::notebook_tag_counts(&configs)?;
            Ok(fmt::notebooks_to_json(
                &configs,
                &counts,
                &tag_counts,
                selected.as_deref(),
            ))
        }
        FlowixOperation::List {
            notebook,
            limit,
            offset,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let entries = path_store::list(&notebook)?["notes"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let total = entries.len();
            let notes = entries
                .into_iter()
                .skip(offset)
                .take(limit)
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "ok": true,
                "action": "list",
                "notebook": notebook,
                "notes": notes,
                "total": total,
                "offset": offset,
                "limit": limit,
                "next_offset": (offset + notes.len() < total).then_some(offset + notes.len())
            }))
        }
        FlowixOperation::Tags { notebook } => store::notebook_tags(notebook.as_deref()),
        FlowixOperation::Show { address } => path_store::show(&address),
        FlowixOperation::Search {
            query,
            notebook,
            tag,
            limit,
        } => path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit),
        FlowixOperation::Create { notebook, content } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::create(&notebook, &content)
        }
        FlowixOperation::Edit {
            address,
            old,
            replacement,
            dry_run,
        } => path_store::edit(&address, &old, &replacement, dry_run),
        FlowixOperation::Write { address, content } => path_store::write(&address, &content),
        FlowixOperation::Delete { address } => path_store::delete(&address),
        FlowixOperation::CollectionRead {
            notebook,
            collection_id,
            path,
        } => collection_store::read(&notebook, collection_id.as_deref(), path.as_deref()),
        FlowixOperation::CollectionList {
            notebook,
            collection_type,
            domain,
            query,
            limit,
            offset,
            snapshot,
        } => collection_store::list(
            notebook.as_deref(),
            collection_type.as_deref(),
            domain.as_deref(),
            query.as_deref(),
            limit,
            offset,
            snapshot.as_deref(),
        ),
        FlowixOperation::CollectionDescribe {
            notebook,
            collection_id,
            path,
        } => collection_store::describe(&notebook, collection_id.as_deref(), path.as_deref()),
        FlowixOperation::CollectionQuery {
            notebook,
            collection_id,
            path,
            domain,
            view_id,
            query,
            fields,
            sort,
            limit,
            offset,
            snapshot,
        } => collection_store::query(
            &notebook,
            collection_id.as_deref(),
            path.as_deref(),
            domain.as_deref(),
            view_id.as_deref(),
            query.as_deref(),
            &fields,
            &sort,
            limit,
            offset,
            snapshot.as_deref(),
        ),
        FlowixOperation::ArtifactList => output::to_json_value(&plugin::list_data()),
        FlowixOperation::ArtifactDescribe { plugin_id } => {
            output::to_json_value(&plugin::describe_data(&plugin_id)?)
        }
        FlowixOperation::ArtifactCreate {
            plugin_id,
            notebook,
            source_note,
            producer,
            content,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            output::to_json_value(&plugin::create_data(
                &plugin_id,
                &notebook,
                source_note.as_deref(),
                &producer,
                &content,
            )?)
        }
    }
}
