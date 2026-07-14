//! File IPC — 任意 in-notebook 文件的 tree / read / write / create。
//!
//! 跟 `memo.rs::read_document` / `write_document` 的区别: 那两个走单文件路径
//! (`can_access_document_path` 守卫, 包括 `.md` 后缀绕过), 这八个走
//! `space_path` 作用域 (`can_access_scoped_file` 守卫, 必须落在声明的
//! notebook 根下)。

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::config::path_is_inside;

use super::helpers::{
    can_access_scoped_file, is_registered_notebook_path, start_security_bookmark_access,
};
use super::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTreeItem {
    pub id: String,
    pub full_path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub parent_id: Option<String>,
    pub children: Option<Vec<DocTreeItem>>,
}

// ==================== 域内 helper ====================

fn generate_stable_id(full_path: &str) -> String {
    format!(
        "file-{}",
        full_path.replace(['\\', '/', '#', '%', '?', '&'], "_")
    )
}

fn read_dir_recursive(dir_path: &Path, parent_id: Option<String>) -> Vec<DocTreeItem> {
    let mut items = Vec::new();

    if !dir_path.exists() {
        return items;
    }

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files
            if name.starts_with('.') {
                continue;
            }

            let is_dir = path.is_dir();
            let item = DocTreeItem {
                id: generate_stable_id(&path.to_string_lossy()),
                full_path: path.to_string_lossy().to_string(),
                name,
                item_type: if is_dir {
                    "folder".to_string()
                } else {
                    "document".to_string()
                },
                parent_id: parent_id.clone(),
                children: if is_dir {
                    Some(read_dir_recursive(&path, None))
                } else {
                    None
                },
            };

            items.push(item);
        }
    }

    // Sort: folders first, then by name
    items.sort_by(|a, b| {
        if a.item_type != b.item_type {
            if a.item_type == "folder" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            a.name.cmp(&b.name)
        }
    });

    items
}

// ==================== IPC ====================

#[tauri::command]
pub fn get_file_tree(space_path: String, state: State<AppState>) -> Option<Vec<DocTreeItem>> {
    let path = Path::new(&space_path);
    start_security_bookmark_access(&state, path);
    if !path.exists() || !is_registered_notebook_path(path, &state) {
        return None;
    }
    Some(read_dir_recursive(path, None))
}

#[tauri::command]
pub fn get_dir_children(dir_path: String, state: State<AppState>) -> Vec<DocTreeItem> {
    let path = Path::new(&dir_path);
    start_security_bookmark_access(&state, path);
    if !path.exists() || !is_registered_notebook_path(path, &state) {
        return vec![];
    }
    read_dir_recursive(path, None)
}

#[tauri::command]
pub fn read_file(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[read_file] refused out-of-scope path: {}", file_path);
        return None;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    fs::read_to_string(&file_path).ok()
}

#[tauri::command]
pub fn write_file(
    file_path: String,
    content: String,
    _skip_validation: Option<bool>,
    space_path: Option<String>,
    state: State<AppState>,
) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[write_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    if let Some(parent) = Path::new(&file_path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&file_path, content).is_ok()
}

#[tauri::command]
pub fn delete_file(file_path: String, space_path: Option<String>, state: State<AppState>) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[delete_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    fs::remove_file(&file_path).is_ok()
}

#[tauri::command]
pub fn create_folder(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Option<DocTreeItem> {
    let target_path = Path::new(&space_path).join(&name);
    if !is_registered_notebook_path(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
    {
        eprintln!(
            "[create_folder] refused out-of-scope path: {}",
            target_path.display()
        );
        return None;
    }
    start_security_bookmark_access(&state, &target_path);
    fs::create_dir_all(&target_path).ok()?;

    Some(DocTreeItem {
        id: generate_stable_id(&target_path.to_string_lossy()),
        full_path: target_path.to_string_lossy().to_string(),
        name,
        item_type: "folder".to_string(),
        parent_id: None,
        children: Some(vec![]),
    })
}

#[tauri::command]
pub fn create_document(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Option<DocTreeItem> {
    let file_name = if name.ends_with(".md") {
        name.clone()
    } else {
        format!("{}.md", name)
    };
    let target_path = Path::new(&space_path).join(&file_name);
    if !is_registered_notebook_path(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
    {
        eprintln!(
            "[create_document] refused out-of-scope path: {}",
            target_path.display()
        );
        return None;
    }
    start_security_bookmark_access(&state, &target_path);
    fs::write(&target_path, "").ok()?;

    Some(DocTreeItem {
        id: generate_stable_id(&target_path.to_string_lossy()),
        full_path: target_path.to_string_lossy().to_string(),
        name: file_name,
        item_type: "document".to_string(),
        parent_id: None,
        children: None,
    })
}
