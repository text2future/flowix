//! Typed output contracts shared by human CLI JSON and stdio JSON-RPC.

use crate::errors::CliError;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct NoteCreated {
    pub ok: bool,
    pub action: &'static str,
    pub id: String,
    pub key: String,
    pub notebook: String,
    pub notebook_id: String,
    pub title: String,
    pub filename: String,
    pub file: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct NoteDeleted {
    pub ok: bool,
    pub action: &'static str,
    pub id: String,
    pub key: String,
    pub file: Option<String>,
    pub path: Option<String>,
    pub file_removed: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct NoteEdited {
    pub ok: bool,
    pub action: &'static str,
    pub id: String,
    pub key: String,
    pub filename: Option<String>,
    pub file: String,
    pub path: String,
    pub old_bytes: usize,
    pub new_bytes: usize,
    pub dry_run: bool,
    pub would_write: bool,
    pub wrote: bool,
    pub match_type: &'static str,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct NoteWritten {
    pub ok: bool,
    pub action: &'static str,
    pub id: String,
    pub key: String,
    pub filename: String,
    pub file: String,
    pub path: String,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct SearchOutput {
    pub ok: bool,
    pub action: &'static str,
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub total: usize,
    pub shown: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct SearchMatch {
    pub notebook: String,
    pub notebook_id: String,
    pub id: String,
    pub title: String,
    pub score: f32,
    pub snippet: String,
}

pub(crate) fn to_json_value<T: Serialize>(value: &T) -> Result<serde_json::Value, CliError> {
    serde_json::to_value(value).map_err(|e| CliError::Other(format!("json serialize: {e}")))
}

pub(crate) fn print_pretty_json<T: Serialize>(value: &T) -> Result<(), CliError> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
    );
    Ok(())
}
