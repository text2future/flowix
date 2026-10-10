//! Notebook configuration shared by the path-addressed CLI and MCP commands.
use crate::{errors::CliError, fmt, paths};
use flowix_core::{memo_file::{MemoFile, NotebookConfig}, MemoService, NoteService};
use std::collections::HashMap;

pub fn open() -> Result<MemoFile, CliError> {
    let paths = paths::resolve()?;
    Ok(MemoFile::new(paths.config_dir))
}

pub(crate) fn notebooks_list_data() -> Result<(Vec<NotebookConfig>, Option<String>), CliError> {
    let mf = open()?;
    let notebooks = MemoService::new(&mf).list_notebooks()?;
    let selected = mf.read_selected_notebook_id()?;
    Ok((notebooks, selected))
}

pub(crate) fn notebook_note_counts(configs: &[NotebookConfig]) -> Result<HashMap<String, usize>, CliError> {
    let mf = open()?;
    let mut counts = HashMap::new();
    for config in configs {
        // CLI is a fresh process on every invocation. Reconcile disk content so
        // a crash between file commit and refresh marker cannot leave stale
        // counts. Stat-based reconcile hashes only changed files, so a fresh
        // index is cheap while the crash window is still covered.
        mf.reconcile_note_index_blocking(&config.id)?;
        counts.insert(config.id.clone(), NoteService::new(&mf).list(&config.id)?.len());
    }
    Ok(counts)
}

pub(crate) fn notebook_tag_counts(configs: &[NotebookConfig]) -> Result<HashMap<String, usize>, CliError> {
    let mf = open()?;
    Ok(configs.iter().map(|config| {
        (config.id.clone(), mf.read_notebook_tag_paths(Some(&config.id)).unwrap_or_default().len())
    }).collect())
}

pub fn find_notebook<'a>(configs: &'a [NotebookConfig], key: &str) -> Option<&'a NotebookConfig> {
    configs.iter().find(|config| config.id == key)
        .or_else(|| configs.iter().find(|config| config.name == key))
}

pub(crate) fn resolve_notebook_key(notebook: Option<&str>) -> Result<String, CliError> {
    if let Some(value) = notebook.filter(|value| !value.trim().is_empty()) {
        return Ok(value.to_owned());
    }
    let mf = open()?;
    if let Some(selected) = mf.read_selected_notebook_id()? { return Ok(selected); }
    let configs = mf.read_notebook_configs()?;
    configs.iter().find(|config| config.is_default).or_else(|| configs.first())
        .map(|config| config.id.clone())
        .ok_or_else(|| CliError::NotFound("no notebook is configured".into()))
}

pub(crate) fn notebook_tags(notebook: Option<&str>) -> Result<serde_json::Value, CliError> {
    let key = resolve_notebook_key(notebook)?;
    let mf = open()?;
    let config = MemoService::new(&mf).resolve_notebook(&key)?;
    mf.reconcile_note_index_blocking(&config.id)?;
    let tags = mf.read_used_tag_ids_for_notebook_id(Some(&config.id))?;
    Ok(serde_json::json!({"ok": true, "action": "tags", "notebook": config.name,
        "notebookId": config.id, "total": tags.len(), "tags": tags}))
}

pub fn cmd_notebooks_json() -> Result<(), CliError> {
    let (configs, selected) = notebooks_list_data()?;
    fmt::print_notebooks_json(&configs, &notebook_note_counts(&configs)?,
        &notebook_tag_counts(&configs)?, selected.as_deref());
    Ok(())
}

pub fn cmd_notebooks() -> Result<(), CliError> {
    let (configs, selected) = notebooks_list_data()?;
    fmt::print_notebooks(&configs, &notebook_note_counts(&configs)?,
        &notebook_tag_counts(&configs)?, selected.as_deref());
    Ok(())
}

pub fn cmd_tags(notebook: Option<&str>, json: bool) -> Result<(), CliError> {
    let payload = notebook_tags(notebook)?;
    if json { println!("{}", serde_json::to_string_pretty(&payload).map_err(|error| CliError::Other(error.to_string()))?); }
    else if let Some(tags) = payload["tags"].as_array() {
        for tag in tags { if let Some(name) = tag.as_str() { println!("{name}"); } }
    }
    Ok(())
}

pub fn cmd_completion(shell: &str) -> Result<(), CliError> {
    let mut command = crate::cli::cli_command();
    let mut output = std::io::stdout();
    match shell {
        "bash" => clap_complete::generate(clap_complete::shells::Bash, &mut command, "flowix", &mut output),
        "zsh" => clap_complete::generate(clap_complete::shells::Zsh, &mut command, "flowix", &mut output),
        "fish" => clap_complete::generate(clap_complete::shells::Fish, &mut command, "flowix", &mut output),
        other => return Err(CliError::Usage(format!("unknown shell: {other}"))),
    }
    Ok(())
}
