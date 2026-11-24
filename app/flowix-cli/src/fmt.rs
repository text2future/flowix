//! Presentation of notebook summaries. Note output uses path-addressed JSON.
use flowix_core::memo_file::NotebookConfig;
use std::collections::HashMap;

pub fn notebooks_to_json(
    configs: &[NotebookConfig],
    note_counts: &HashMap<String, usize>,
    tag_counts: &HashMap<String, usize>,
    selected_notebook_id: Option<&str>,
) -> serde_json::Value {
    serde_json::Value::Array(
        configs
            .iter()
            .map(|config| {
                serde_json::json!({
                    "name": config.name,
                    "id": config.id,
                    "path": config.path,
                    "notes": note_counts.get(&config.id).copied().unwrap_or(0),
                    "tags": tag_counts.get(&config.id).copied().unwrap_or(0),
                    "selected": selected_notebook_id == Some(config.id.as_str()),
                    "updatedAt": config.updated_at,
                })
            })
            .collect(),
    )
}

pub fn print_notebooks_json(
    configs: &[NotebookConfig],
    note_counts: &HashMap<String, usize>,
    tag_counts: &HashMap<String, usize>,
    selected_notebook_id: Option<&str>,
) {
    println!(
        "{}",
        serde_json::to_string_pretty(&notebooks_to_json(
            configs,
            note_counts,
            tag_counts,
            selected_notebook_id,
        ))
        .unwrap_or_default()
    );
}

pub fn print_notebooks(
    configs: &[NotebookConfig],
    note_counts: &HashMap<String, usize>,
    tag_counts: &HashMap<String, usize>,
    selected_notebook_id: Option<&str>,
) {
    if configs.is_empty() {
        println!("(no notebooks)");
        return;
    }
    for config in configs {
        let selected = if selected_notebook_id == Some(config.id.as_str()) {
            "*"
        } else {
            " "
        };
        println!(
            "{selected} {} ({})  {} notes  {} tags  {}",
            config.name,
            config.id,
            note_counts.get(&config.id).copied().unwrap_or(0),
            tag_counts.get(&config.id).copied().unwrap_or(0),
            config.path
        );
    }
}
