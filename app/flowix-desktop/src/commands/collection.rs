//! Collection IPC commands.
//!
//! The catalog, the mutation journal and the index refresh entry points live in
//! [`flowix_core::collection_store`]; this module only adapts them to Tauri
//! commands and broadcasts the resulting events to windows.
use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::{
    collection::{CollectionDocument, CollectionPlacement, CollectionType},
    collection_store::{
        mutate_with_completion, with_catalog, CollectionIndexItem, CollectionMutation,
        CollectionMutationResult,
    },
    memo_file::{atomic_write_bytes, MemoFile},
};
use std::{fs, path::Path};
use tauri::{Emitter, Manager, State};
#[tauri::command]
pub async fn list_collections(
    notebook_id: String,
    collection_type: Option<CollectionType>,
    state: State<'_, AppState>,
) -> Result<Vec<CollectionIndexItem>, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        with_catalog(&memo, &notebook_id, |catalog| catalog.list(collection_type))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn resolve_collection(
    notebook_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<CollectionIndexItem, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        with_catalog(&memo, &notebook_id, |catalog| {
            catalog.resolve(&collection_id)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn mutate_collection(
    operation_id: Option<String>,
    window: tauri::WebviewWindow,
    request: CollectionMutation,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<CollectionMutationResult, String> {
    let memo = state.memo_file.clone();
    crate::commands::document_operations::run(
        "mutate_collection",
        operation_id,
        window.label().to_owned(),
        move || {
            let memo = read_lock(&memo, "memo_file");
            // Recovery may finish a prior directory move too, so protect the
            // notebook's open documents until completion has rebased their leases.
            let _watch_move = memo
                .get_notebook_config_by_id(&request.notebook_id)
                .and_then(|notebook| {
                    crate::external_watch::begin_path_move(
                        &app,
                        Path::new(&notebook.path),
                    )
                });
            let result = mutate_with_completion(&memo, &request, &|result| {
                emit_mutation_result(&app, &request.notebook_id, result)
            })?;
            Ok(result)
        },
    )
    .await
}

pub(crate) fn path_change_for_result(
    notebook_id: &str,
    result: &CollectionMutationResult,
) -> Option<crate::events::path_change::NotebookPathMove> {
    let (previous, next, directory) = match &result.directory_move {
        Some(moved) => (&moved.previous_relative_path, &moved.relative_path, true),
        None if result.previous_relative_path != result.actual_relative_path => (
            &result.previous_relative_path,
            &result.actual_relative_path,
            false,
        ),
        None => return None,
    };
    Some(crate::events::path_change::NotebookPathMove {
        change_id: format!("collection:{}:{}", notebook_id, result.operation_id),
        notebook_id: notebook_id.to_owned(),
        previous_relative_path: previous.clone(),
        relative_path: next.clone(),
        directory,
    })
}

pub(crate) fn emit_mutation_result(
    app: &tauri::AppHandle,
    notebook_id: &str,
    result: &CollectionMutationResult,
) {
    if let Some(moved) = &result.directory_move {
        let root = Path::new(&result.notebook_path);
        crate::external_watch::rebase_path(
            app,
            &root.join(&moved.previous_relative_path),
            &root.join(&moved.relative_path),
        );
    }
    let _=app.emit("collection-changed",serde_json::json!({"notebookId":notebook_id,"collectionId":result.collection_id,"operationId":result.operation_id,"indexSequence":result.index_sequence,"relativePath":result.actual_relative_path,"previousRelativePath":result.previous_relative_path,"notebookPath":result.notebook_path,"name":result.actual_name,"revision":result.actual_revision,"directoryMove":result.directory_move}));
    if let Some(moved) = &result.directory_move {
        if let Some(state) = app.try_state::<AppState>() {
            let root = Path::new(&result.notebook_path);
            if let Err(error) = state.thread_manager.rebase_agent_note_paths(
                notebook_id,
                notebook_id,
                &moved.previous_relative_path,
                &moved.relative_path,
                &root.join(&moved.previous_relative_path).to_string_lossy(),
                &root.join(&moved.relative_path).to_string_lossy(),
            ) {
                tracing::warn!(
                    notebook_id,
                    "agent references after collection folder move failed: {error}"
                );
            }
        }
        let _ = app.emit("file-management-changed", serde_json::json!({ "notebookId": notebook_id, "notebookPath": result.notebook_path, "operationId": result.operation_id }));
    }
    if let Some(change) = path_change_for_result(notebook_id, result) {
        change.emit(app);
    }
}

/// Tree and title actions share the same collection operation when the directory owns an index.
pub(crate) fn rename_folder_collection_at_path(
    memo: &MemoFile,
    folder: &Path,
    name: &str,
    app: &tauri::AppHandle,
) -> Result<Option<(String, CollectionMutationResult)>, String> {
    let index = folder.join(".index.yaml");
    if !index.is_file() {
        return Ok(None);
    }
    let document =
        CollectionDocument::parse(&fs::read_to_string(&index).map_err(|error| error.to_string())?)?;
    if document.collection.placement != CollectionPlacement::Folder {
        return Ok(None);
    }
    let folder = dunce::canonicalize(folder).map_err(|error| error.to_string())?;
    let notebook = memo
        .read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|config| {
            let root = dunce::canonicalize(&config.path).ok()?;
            folder
                .starts_with(&root)
                .then_some((root.components().count(), config))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, notebook)| notebook)
        .ok_or("NOTEBOOK_NOT_FOUND")?;
    let request = CollectionMutation {
        notebook_id: notebook.id.clone(),
        collection_id: document.collection.id.clone(),
        expected_revision: document.collection.revision,
        operation_id: uuid::Uuid::now_v7().to_string(),
        new_name: Some(name.to_owned()),
        target_relative_path: None,
        properties: None,
    };
    let _watch_move =
        crate::external_watch::begin_path_move(app, Path::new(&notebook.path));
    let result = mutate_with_completion(memo, &request, &|result| {
        emit_mutation_result(app, &request.notebook_id, result)
    })?;
    Ok(Some((notebook.id, result)))
}
#[tauri::command]
pub async fn set_collection_display_state(
    notebook_id: String,
    collection_id: String,
    in_views: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let memo=read_lock(&memo,"memo_file");
        let _guard = memo.operation_locks().notebook_read(&notebook_id, "set_collection_display_state")
            .map_err(|error| error.to_string())?;
        with_catalog(&memo,&notebook_id,|catalog|{
        catalog.set_display_state(&collection_id, in_views)
    })}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn set_collection_pinned(
    notebook_id: String,
    collection_id: String,
    pinned: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        let _guard = memo
            .operation_locks()
            .notebook_read(&notebook_id, "set_collection_pinned")
            .map_err(|error| error.to_string())?;
        with_catalog(&memo, &notebook_id, |catalog| {
            catalog.set_pinned(&collection_id, pinned)
        })?;
        let _ = app.emit(
            "notebook-pinned-changed",
            serde_json::json!({ "notebookId": notebook_id }),
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn make_collection_identity_unique(
    notebook_id: String,
    relative_path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        let id = memo
            .with_notebook_change(&[&notebook_id], "make_collection_identity_unique", || {
                Ok(with_catalog(&memo, &notebook_id, |catalog| {
                    catalog.recover(&memo)?;
                    let path = catalog.checked_path(&relative_path)?;
                    let source = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                    let mut document = CollectionDocument::parse(&source)?;
                    document.validate()?;
                    catalog.reconcile()?;
                    let duplicates = catalog.identity_duplicates(&document.collection.id)?;
                    if duplicates < 2 {
                        return Err("COLLECTION_ID_NOT_DUPLICATED".into());
                    }
                    document = document.normalized_v2()?;
                    document.normalize_media_resource_ids(&notebook_id)?;
                    document.collection.id = format!("col_{}", uuid::Uuid::now_v7().simple());
                    document.revise()?;
                    atomic_write_bytes(&path, document.serialize()?.as_bytes())
                        .map_err(|e| e.to_string())?;
                    catalog.refresh(&[path])?;
                    Ok(document.collection.id)
                }))
            })
            .map_err(|error| error.to_string())??;
        let _ = app.emit(
            "file-management-changed",
            serde_json::json!({"notebookId":notebook_id}),
        );
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}
