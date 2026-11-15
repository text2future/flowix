use serde::Serialize;
use tauri::Emitter;

/// A saved note's indexed metadata, shared by tree rows, pinned lists and headers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookPathUpdated {
    pub change_id: String,
    pub notebook_id: String,
    pub relative_path: String,
    pub entry: flowix_core::memo_file::NoteEntry,
    pub origin_window_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_favorited: Option<bool>,
}

impl NotebookPathUpdated {
    pub fn from_window(
        notebook_id: String,
        relative_path: String,
        entry: flowix_core::memo_file::NoteEntry,
        origin_window_label: String,
        previous_favorited: Option<bool>,
    ) -> Self {
        Self { change_id: uuid::Uuid::new_v4().to_string(), notebook_id,
            relative_path, entry, origin_window_label, previous_favorited }
    }

    pub fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit("flowix:path-note-changed", self);
    }
}

/// The same confirmed fact is returned by a command and broadcast to windows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookPathMove {
    pub change_id: String,
    pub notebook_id: String,
    pub previous_relative_path: String,
    pub relative_path: String,
    pub directory: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookPathCreated {
    pub change_id: String,
    pub notebook_id: String,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_window_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookPathDeleted {
    pub change_id: String,
    pub notebook_id: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookPathInvalidated {
    pub change_id: String,
    pub notebook_id: String,
    pub relative_path: String,
}

impl NotebookPathCreated {
    pub fn from_window(
        notebook_id: String,
        relative_path: String,
        origin_window_label: String,
    ) -> Self {
        Self {
            change_id: uuid::Uuid::new_v4().to_string(),
            notebook_id,
            relative_path,
            source: None,
            origin_window_label: Some(origin_window_label),
        }
    }

    pub fn from_external_tool(notebook_id: String, relative_path: String) -> Self {
        Self {
            change_id: uuid::Uuid::new_v4().to_string(),
            notebook_id,
            relative_path,
            source: Some("external_tool"),
            origin_window_label: None,
        }
    }

    pub fn emit(&self, app: &tauri::AppHandle) {
        let mut payload = serde_json::json!({
            "changeId": self.change_id,
            "notebookId": self.notebook_id,
            "relativePath": self.relative_path,
            "created": true,
            "deleted": false,
        });
        if let Some(source) = self.source {
            payload["source"] = serde_json::json!(source);
        }
        if let Some(origin) = &self.origin_window_label {
            payload["originWindowLabel"] = serde_json::json!(origin);
        }
        let _ = app.emit("flowix:path-note-changed", payload);
    }
}

impl NotebookPathDeleted {
    pub fn new(notebook_id: String, relative_path: String) -> Self {
        Self { change_id: uuid::Uuid::new_v4().to_string(), notebook_id, relative_path }
    }

    pub fn emit(&self, app: &tauri::AppHandle) {
        let payload = serde_json::json!({
            "changeId": self.change_id,
            "notebookId": self.notebook_id,
            "relativePath": self.relative_path,
            "deleted": true,
        });
        let _ = app.emit("flowix:path-note-changed", payload);
    }
}

impl NotebookPathInvalidated {
    pub fn new(notebook_id: String, relative_path: String) -> Self {
        Self { change_id: uuid::Uuid::new_v4().to_string(), notebook_id, relative_path }
    }

    pub fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit("flowix:path-note-changed", self);
    }
}

impl NotebookPathMove {
    pub fn new(notebook_id: String, previous: String, next: String, directory: bool) -> Self {
        Self {
            change_id: uuid::Uuid::new_v4().to_string(), notebook_id,
            previous_relative_path: previous, relative_path: next, directory,
        }
    }

    pub fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit("flowix:path-note-changed", self);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMutationResult {
    pub path: String,
    pub notebook_change: Option<NotebookPathMove>,
}
