//! Path-addressed note operations shared by the CLI, MCP and operation API.
use crate::{errors::CliError, store};
use flowix_core::{memo_file::NotebookConfig, MemoService, NoteService};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

fn address(
    raw: &str,
) -> Result<(flowix_core::memo_file::MemoFile, NotebookConfig, String), CliError> {
    let mf = store::open()?;
    let configs = mf.read_notebook_configs()?;
    let (notebook, relative) = if let Some((key, relative)) = raw.split_once("::") {
        let notebook = store::find_notebook(&configs, key)
            .ok_or_else(|| CliError::NotFound(format!("notebook not found: {key}")))?;
        (notebook, relative.replace('\\', "/"))
    } else if Path::new(raw).is_absolute() {
        let absolute = std::fs::canonicalize(raw)?;
        let notebook = configs
            .iter()
            .filter_map(|config| {
                let root = std::fs::canonicalize(&config.path).ok()?;
                absolute
                    .strip_prefix(&root)
                    .ok()
                    .map(|relative| (config, relative.to_path_buf(), root.components().count()))
            })
            .max_by_key(|(_, _, depth)| *depth)
            .ok_or_else(|| {
                CliError::NotFound(format!("note is outside configured notebooks: {raw}"))
            })?;
        (notebook.0, notebook.1.to_string_lossy().replace('\\', "/"))
    } else {
        let key = store::resolve_notebook_key(None)?;
        let notebook = store::find_notebook(&configs, &key)
            .ok_or_else(|| CliError::NotFound(format!("notebook not found: {key}")))?;
        (notebook, raw.replace('\\', "/"))
    };
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(CliError::Usage(
            "note address must be a notebook-relative Markdown path".into(),
        ));
    }
    let notebook = notebook.clone();
    Ok((mf, notebook, relative))
}

fn locator(notebook_id: &str, relative_path: &str) -> String {
    format!("{notebook_id}::{relative_path}")
}

fn document_json(document: &flowix_core::service::NoteDocument) -> Value {
    json!({
        "notebookId": document.notebook.id,
        "notebook": document.notebook.name,
        "relativePath": document.entry.relative_path,
        "address": locator(&document.notebook.id, &document.entry.relative_path),
        "path": document.path,
        "note": document.entry,
        "body": document.body,
    })
}

pub(crate) fn list(notebook_key: &str) -> Result<Value, CliError> {
    let mf = store::open()?;
    let notebook = MemoService::new(&mf).resolve_notebook(notebook_key)?;
    mf.reconcile_note_index(&notebook.id)?;
    let notes = NoteService::new(&mf).list(&notebook.id)?;
    Ok(json!({"notebookId": notebook.id, "notes": notes}))
}

pub(crate) fn show(raw: &str) -> Result<Value, CliError> {
    let (mf, notebook, relative) = address(raw)?;
    let document = NoteService::new(&mf).get(&notebook.id, &relative)?;
    Ok(document_json(&document))
}

pub(crate) fn create(notebook_key: &str, content: &str) -> Result<Value, CliError> {
    if content.trim().is_empty() {
        return Err(CliError::Usage("create: content is empty".into()));
    }
    let mf = store::open()?;
    let notebook = MemoService::new(&mf).resolve_notebook(notebook_key)?;
    let parent = flowix_core::memo_file::default_create_folder_for_notebook(Path::new(&notebook.path))
        .map_err(CliError::Other)?;
    let document = NoteService::new(&mf).create(
        &notebook.id,
        parent.as_deref(),
        "Untitled",
        content,
    )?;
    Ok(json!({"ok": true, "action": "created", "note": document_json(&document)}))
}

pub(crate) fn edit(
    raw: &str,
    old: &str,
    replacement: &str,
    dry_run: bool,
) -> Result<Value, CliError> {
    if old.is_empty() {
        return Err(CliError::Usage("edit: --old cannot be empty".into()));
    }
    let (mf, notebook, relative) = address(raw)?;
    let current = NoteService::new(&mf).get(&notebook.id, &relative)?;
    let matches = current.body.match_indices(old).count();
    if matches != 1 {
        return Err(CliError::Usage(format!(
            "edit: expected exactly one match, found {matches}"
        )));
    }
    let next = current.body.replacen(old, replacement, 1);
    if !dry_run {
        match NoteService::new(&mf).save(&notebook.id, &relative, &next, Some(&current.body))? {
            flowix_core::service::NoteSaveOutcome::Saved(_) => {}
            flowix_core::service::NoteSaveOutcome::Conflict { .. } => {
                return Err(CliError::Other(
                    "note changed on disk; edit was not applied".into(),
                ))
            }
        }
    }
    Ok(
        json!({"ok": true, "action": if dry_run {"edit_preview"} else {"edited"},
        "notebookId": notebook.id, "relativePath": relative, "address": locator(&notebook.id, &relative),
        "path": current.path, "oldBytes": old.len(), "newBytes": replacement.len(), "wrote": !dry_run}),
    )
}

pub(crate) fn write(raw: &str, content: &str) -> Result<Value, CliError> {
    if content.trim().is_empty() {
        return Err(CliError::Usage("write: content is empty".into()));
    }
    let (mf, notebook, relative) = address(raw)?;
    let current = NoteService::new(&mf).get(&notebook.id, &relative)?;
    let saved =
        NoteService::new(&mf).save(&notebook.id, &relative, content, Some(&current.body))?;
    match saved {
        flowix_core::service::NoteSaveOutcome::Saved(document) => {
            Ok(json!({"ok": true, "action": "written", "note": document_json(&document)}))
        }
        flowix_core::service::NoteSaveOutcome::Conflict { .. } => Err(CliError::Other(
            "note changed on disk; write was not applied".into(),
        )),
    }
}

pub(crate) fn delete(raw: &str) -> Result<Value, CliError> {
    let (mf, notebook, relative) = address(raw)?;
    let document = NoteService::new(&mf).get(&notebook.id, &relative)?;
    let removed = NoteService::new(&mf).delete(&notebook.id, &relative)?;
    Ok(
        json!({"ok": removed, "action": "deleted", "notebookId": notebook.id,
        "relativePath": relative, "address": locator(&notebook.id, &relative), "path": document.path}),
    )
}

pub(crate) fn search(
    query: &str,
    notebook_filter: Option<&str>,
    tag_filter: Option<&str>,
    limit: usize,
) -> Result<Value, CliError> {
    if query.trim().is_empty() || limit == 0 {
        return Err(CliError::Usage(
            "search requires a query and positive limit".into(),
        ));
    }
    let mf = store::open()?;
    let configs = MemoService::new(&mf).list_notebooks()?;
    let selected = if let Some(key) = notebook_filter {
        vec![MemoService::new(&mf).resolve_notebook(key)?]
    } else {
        configs
    };
    let mut hits = Vec::new();
    for notebook in selected {
        mf.reconcile_note_index(&notebook.id)?;
        for hit in NoteService::new(&mf).search_with_tag_filter(
            &notebook.id,
            query,
            tag_filter,
            limit.saturating_sub(hits.len()),
        )? {
            hits.push(
                json!({"notebookId": notebook.id, "relativePath": hit.relative_path,
                "address": locator(&notebook.id, &hit.relative_path), "title": hit.title,
                "snippet": hit.snippet}),
            );
            if hits.len() >= limit {
                break;
            }
        }
        if hits.len() >= limit {
            break;
        }
    }
    Ok(json!({"ok": true, "action": "search", "query": query, "matches": hits}))
}

pub(crate) fn read_input(
    file: Option<&str>,
    stdin: bool,
    operation: &str,
) -> Result<String, CliError> {
    if file.is_some() == stdin {
        return Err(CliError::Usage(format!(
            "{operation}: provide exactly one of --file or --stdin"
        )));
    }
    if let Some(path) = file {
        return String::from_utf8(std::fs::read(path)?)
            .map_err(|error| CliError::Other(format!("input is not UTF-8: {error}")));
    }
    let mut content = String::new();
    std::io::stdin().read_to_string(&mut content)?;
    Ok(content)
}

pub(crate) fn print(value: Value, json: bool) -> Result<(), CliError> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&value)
                .map_err(|error| CliError::Other(error.to_string()))?
        );
    } else if let Some(note) = value.get("note") {
        println!(
            "{}",
            note.get("address")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        if let Some(body) = note.get("body").and_then(Value::as_str) {
            print!("{body}");
        }
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&value)
                .map_err(|error| CliError::Other(error.to_string()))?
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn path_crud_does_not_create_memo_identity() {
        let _lock = ENV_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "flowix-cli-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = root.join("config");
        let notebook_path = root.join("notebook");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let mf = flowix_core::memo_file::MemoFile::new(config.clone());
        mf.write_notebook_configs(&[NotebookConfig {
            id: "work".into(),
            name: "Work".into(),
            icon: None,
            path: notebook_path.to_string_lossy().to_string(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
        let previous = std::env::var_os("FLOWIX_HOME");
        std::env::set_var("FLOWIX_HOME", &config);
        let result = (|| -> Result<(), CliError> {
            let created = create("work", "# Hello\nBody\n")?;
            let address = created["note"]["address"].as_str().unwrap();
            assert!(address.starts_with("work::Untitled.md"));
            let shown = show(address)?;
            assert_eq!(shown["body"], "# Hello\nBody\n");
            assert!(!shown["body"].as_str().unwrap().contains("flowix_key"));
            assert_eq!(list("work")?["notes"].as_array().unwrap().len(), 1);
            edit(address, "Body", "Changed", false)?;
            assert!(show(address)?["body"].as_str().unwrap().contains("Changed"));
            assert_eq!(
                search("Changed", None, None, 10)?["matches"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            delete(address)?;
            assert!(list("work")?["notes"].as_array().unwrap().is_empty());
            Ok(())
        })();
        if let Some(previous) = previous {
            std::env::set_var("FLOWIX_HOME", previous);
        } else {
            std::env::remove_var("FLOWIX_HOME");
        }
        let _ = std::fs::remove_dir_all(root);
        result.unwrap();
    }
}
