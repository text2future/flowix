//! Transport-neutral Flowix operations shared by CLI and MCP adapters.

use crate::{collection_store, errors::CliError, fmt, output, path_store, plugin, store};
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum FlowixOperation {
    RequestList {
        state: Option<String>,
        limit: usize,
    },
    RequestShow {
        notebook: String,
        operation: String,
        request_id: String,
    },
    Notebooks,
    List {
        notebook: Option<String>,
        limit: usize,
        offset: usize,
        snapshot: Option<String>,
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
        offset: usize,
        snapshot: Option<String>,
    },
    Create {
        notebook: Option<String>,
        folder: Option<String>,
        title: Option<String>,
        content: String,
        request_id: Option<String>,
    },
    Edit {
        address: String,
        old: String,
        replacement: String,
        dry_run: bool,
    },
    Write {
        address: String,
        expected_version: Option<String>,
        content: String,
    },
    Delete {
        address: String,
        expected_version: Option<String>,
    },
    CollectionRead {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
    },
    CollectionCreate {
        notebook: String,
        path: String,
        fields: Option<String>,
    },
    CollectionAddFields {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        fields: String,
    },
    CollectionAdd {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        record: String,
        request_id: Option<String>,
    },
    CollectionAddNote {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        title: String,
        content: String,
        request_id: Option<String>,
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
        filters: Vec<String>,
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
        request_id: Option<String>,
    },
}

pub(crate) fn execute(operation: FlowixOperation) -> Result<Value, CliError> {
    match operation {
        FlowixOperation::RequestList { state, limit } => {
            crate::idempotency::list(state.as_deref(), limit)
        }
        FlowixOperation::RequestShow {
            notebook,
            operation,
            request_id,
        } => crate::idempotency::show(&notebook, &operation, &request_id),
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
            snapshot,
        } => {
            if limit == 0 || limit > 200 {
                return Err(CliError::Usage(
                    "list limit must be between 1 and 200".into(),
                ));
            }
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let data = path_store::list(&notebook)?;
            let notebook_id = data["notebookId"]
                .as_str()
                .ok_or_else(|| CliError::Other("missing notebook ID".into()))?;
            let entries = data["notes"].as_array().cloned().unwrap_or_default();
            let token = path_store::version(
                &serde_json::to_string(&(notebook_id, &entries))
                    .map_err(|e| CliError::Other(e.to_string()))?,
            );
            if snapshot.as_deref().is_some_and(|value| value != token) {
                return Err(CliError::DataChanged(
                    "notes changed during pagination; restart at offset 0".into(),
                ));
            }
            let total = entries.len();
            let notes = entries
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|mut note| {
                    if let Some(path) = note["relativePath"].as_str() {
                        note["address"] = serde_json::json!(format!("{notebook_id}::{path}"));
                    }
                    note
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "ok": true,
                "action": "list",
                "notebook": notebook,
                "notebookId": notebook_id,
                "notes": notes,
                "total": total,
                "offset": offset,
                "limit": limit,
                "next_offset": (offset.saturating_add(notes.len()) < total).then_some(offset.saturating_add(notes.len())),
                "snapshot": token
            }))
        }
        FlowixOperation::Tags { notebook } => store::notebook_tags(notebook.as_deref()),
        FlowixOperation::Show { address } => path_store::show(&address),
        FlowixOperation::Search {
            query,
            notebook,
            tag,
            limit,
            offset,
            snapshot,
        } => path_store::search(
            &query,
            notebook.as_deref(),
            tag.as_deref(),
            limit,
            offset,
            snapshot.as_deref(),
        ),
        FlowixOperation::Create {
            notebook,
            folder,
            title,
            content,
            request_id,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let mf = store::open()?;
            let notebook = store::resolve_notebook_config(&mf, &notebook)?.id;
            let run = || {
                path_store::create_in_folder(
                    &notebook,
                    title.as_deref(),
                    folder.as_deref(),
                    &content,
                )
            };
            if let Some(id) = request_id.as_deref() {
                let payload =
                    serde_json::json!({"folder":folder, "title":title, "content":content});
                crate::idempotency::execute(&notebook, "create", id, &payload, run)
            } else {
                run()
            }
        }
        FlowixOperation::Edit {
            address,
            old,
            replacement,
            dry_run,
        } => path_store::edit(&address, &old, &replacement, dry_run),
        FlowixOperation::Write {
            address,
            content,
            expected_version,
        } => path_store::write(&address, &content, expected_version.as_deref()),
        FlowixOperation::Delete {
            address,
            expected_version,
        } => path_store::delete(&address, expected_version.as_deref()),
        FlowixOperation::CollectionRead {
            notebook,
            collection_id,
            path,
        } => collection_store::read(&notebook, collection_id.as_deref(), path.as_deref()),
        FlowixOperation::CollectionCreate {
            notebook,
            path,
            fields,
        } => collection_store::create_with_fields(&notebook, &path, fields.as_deref()),
        FlowixOperation::CollectionAddFields {
            notebook,
            collection_id,
            path,
            fields,
        } => collection_store::add_fields_with_json(
            &notebook,
            collection_id.as_deref(),
            path.as_deref(),
            &fields,
        ),
        FlowixOperation::CollectionAdd {
            notebook,
            collection_id,
            path,
            record,
            request_id,
        } => collection_store::add_record(
            &notebook,
            collection_id.as_deref(),
            path.as_deref(),
            &record,
            request_id.as_deref(),
        ),
        FlowixOperation::CollectionAddNote {
            notebook,
            collection_id,
            path,
            title,
            content,
            request_id,
        } => {
            let memo = store::open()?;
            let notebook = store::resolve_notebook_config(&memo, &notebook)?;
            let result = flowix_core::collection_store::add_note_with_request(
                &memo,
                &notebook.id,
                collection_id.as_deref(),
                path.as_deref(),
                &title,
                &content,
                request_id.as_deref(),
            )
            .map_err(CliError::collection_error)?;
            Ok(serde_json::json!({
                "ok": true,
                "action": "collection.add-note",
                "notebookId": result.notebook_id,
                "collectionId": result.collection_id,
                "collectionPath": result.collection_path,
                "collectionRevision": result.collection_revision,
                "note": {
                    "address": result.address,
                    "relativePath": result.note_path,
                },
            }))
        }
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
            filters,
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
            &filters,
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
            request_id,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let mf = store::open()?;
            let notebook = store::resolve_notebook_config(&mf, &notebook)?.id;
            let run = || {
                output::to_json_value(&plugin::create_data(
                    &plugin_id,
                    &notebook,
                    source_note.as_deref(),
                    &producer,
                    &content,
                )?)
            };
            if let Some(id) = request_id.as_deref() {
                let payload = serde_json::json!({"pluginId":plugin_id,"sourceNote":source_note,"producer":producer,"content":content});
                crate::idempotency::execute(&notebook, "artifact.create", id, &payload, run)
            } else {
                run()
            }
        }
    }
}
