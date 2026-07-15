use std::path::Path;
use std::time::Instant;

use flowix_core::memo_file::{extract_body_content, extract_frontmatter_key};

use super::constants::{WRITE_KEY_REREAD_INTERVAL, WRITE_KEY_REREAD_TIMEOUT};

pub(super) fn frontmatter_key_value(content: &str) -> serde_json::Value {
    extract_frontmatter_key(content)
        .map(serde_json::Value::String)
        .unwrap_or(serde_json::Value::Null)
}

fn split_frontmatter_block(content: &str) -> Option<(&str, &str)> {
    let mut offset = 0usize;
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    offset += first.len();

    for line in lines {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some((&content[..offset], &content[offset..]));
        }
    }
    None
}

async fn content_for_append(path: &Path, requested_content: &str) -> String {
    if requested_content.is_empty() {
        return String::new();
    }

    let Ok(existing_content) = tokio::fs::read_to_string(path).await else {
        return requested_content.to_string();
    };
    if existing_content.is_empty()
        || existing_content.ends_with('\n')
        || requested_content.starts_with('\n')
    {
        requested_content.to_string()
    } else {
        format!("\n{requested_content}")
    }
}

pub(super) async fn content_for_write(
    path: &Path,
    requested_content: &str,
    append: bool,
) -> String {
    if append {
        return content_for_append(path, requested_content).await;
    }

    let Ok(existing_content) = tokio::fs::read_to_string(path).await else {
        return requested_content.to_string();
    };
    let Some((existing_frontmatter, _)) = split_frontmatter_block(&existing_content) else {
        return requested_content.to_string();
    };

    let requested_body = extract_body_content(requested_content);
    format!("{existing_frontmatter}{requested_body}")
}

pub(super) async fn reread_frontmatter_key_after_write(path: &Path) -> Option<String> {
    let deadline = Instant::now() + WRITE_KEY_REREAD_TIMEOUT;
    loop {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            if let Some(key) = extract_frontmatter_key(&content) {
                return Some(key);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(WRITE_KEY_REREAD_INTERVAL).await;
    }
}
