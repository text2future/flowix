//! Durable at-most-once guard for operations whose side effects cannot share a
//! transaction with the receipt database. An interrupted operation stays
//! indeterminate instead of being executed a second time.
use crate::{errors::CliError, paths};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) fn execute(
    notebook_id: &str,
    operation: &str,
    request_id: &str,
    payload: &Value,
    run: impl FnOnce() -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    if request_id.trim().is_empty()
        || request_id.len() > 256
        || request_id.chars().any(char::is_control)
    {
        return Err(CliError::Usage(
            "requestId must be 1–256 bytes and contain no control characters".into(),
        ));
    }
    let db = open()?;
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(payload).map_err(|e| CliError::Other(e.to_string()))?)
    );
    let inserted = db.execute("INSERT OR IGNORE INTO requests (notebook_id, operation, request_id, payload_hash, created_at, updated_at, target_hint) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)", params![notebook_id, operation, request_id, hash, now(), target_hint(operation, payload).to_string()])
        .map_err(|error| CliError::Other(format!("request ledger: {error}")))?;
    if inserted == 0 {
        let (previous, result): (String, Option<String>) = db.query_row(
            "SELECT payload_hash, result FROM requests WHERE notebook_id=?1 AND operation=?2 AND request_id=?3",
            params![notebook_id, operation, request_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| CliError::Other(format!("request ledger: {error}")))?
         .ok_or_else(|| CliError::Other("request receipt disappeared".into()))?;
        if previous != hash {
            return Err(CliError::RequestIdConflict);
        }
        return match result {
            Some(result) => serde_json::from_str(&result)
                .map_err(|error| CliError::Other(format!("invalid request receipt: {error}"))),
            None => Err(CliError::RequestIndeterminate(String::new())),
        };
    }
    // On any error leave the reservation in place: the operation might already
    // have committed a side effect before reporting failure.
    let result = match run() {
        Ok(result) => result,
        Err(error) => {
            let summary = error.to_string();
            let _ = db.execute("UPDATE requests SET error_summary=?4, updated_at=?5 WHERE notebook_id=?1 AND operation=?2 AND request_id=?3 AND result IS NULL", params![notebook_id, operation, request_id, summary, now()]);
            return Err(CliError::RequestIndeterminate(format!(": {error}")));
        }
    };
    let encoded =
        serde_json::to_string(&result).map_err(|error| CliError::Other(error.to_string()))?;
    db.execute(
        "UPDATE requests SET result=?4, updated_at=?5 WHERE notebook_id=?1 AND operation=?2 AND request_id=?3",
        params![notebook_id, operation, request_id, encoded, now()],
    )
    .map_err(|error| CliError::RequestIndeterminate(format!(": receipt update failed: {error}")))?;
    Ok(result)
}

fn db_error(error: rusqlite::Error) -> CliError {
    CliError::Other(format!("request ledger: {error}"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn open() -> Result<Connection, CliError> {
    let directory = paths::resolve()?.config_dir;
    std::fs::create_dir_all(&directory)?;
    let mut db = Connection::open(directory.join("agent-requests.sqlite3")).map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    // Serialize schema upgrades across independent CLI/MCP processes.
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS requests (notebook_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT, PRIMARY KEY(notebook_id, operation, request_id));").map_err(db_error)?;
    let columns: Vec<String> = {
        let mut statement = tx
            .prepare("PRAGMA table_info(requests)")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| row.get(1))
            .map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    for (name, sql) in [
        (
            "created_at",
            "ALTER TABLE requests ADD COLUMN created_at TEXT",
        ),
        (
            "updated_at",
            "ALTER TABLE requests ADD COLUMN updated_at TEXT",
        ),
        (
            "target_hint",
            "ALTER TABLE requests ADD COLUMN target_hint TEXT",
        ),
        (
            "error_summary",
            "ALTER TABLE requests ADD COLUMN error_summary TEXT",
        ),
    ] {
        if !columns.iter().any(|column| column == name) {
            tx.execute(sql, []).map_err(db_error)?;
        }
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS request_reviews (id INTEGER PRIMARY KEY, notebook_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, outcome TEXT NOT NULL, actor TEXT NOT NULL, evidence TEXT, reviewed_at TEXT NOT NULL);").map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(db)
}

fn target_hint(operation: &str, payload: &Value) -> Value {
    match operation {
        "create" => serde_json::json!({"folder":payload["folder"], "title":payload["title"]}),
        "artifact.create" => {
            serde_json::json!({"pluginId":payload["pluginId"], "sourceNote":payload["sourceNote"]})
        }
        _ => Value::Null,
    }
}

fn validate_operation(operation: &str) -> Result<(), CliError> {
    if matches!(operation, "create" | "artifact.create") {
        Ok(())
    } else {
        Err(CliError::Usage(
            "request operation must be create or artifact.create".into(),
        ))
    }
}

fn row_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let result: Option<String> = row.get(3)?;
    let hint: Option<String> = row.get(6)?;
    Ok(serde_json::json!({
        "notebookId":row.get::<_, String>(0)?, "operation":row.get::<_, String>(1)?,
        "requestId":row.get::<_, String>(2)?, "state":if result.is_some() {"completed"} else {"uncertain"},
        "createdAt":row.get::<_, Option<String>>(4)?, "updatedAt":row.get::<_, Option<String>>(5)?,
        "targetHint":hint.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "errorSummary":row.get::<_, Option<String>>(7)?
    }))
}

fn open_read() -> Result<Option<Connection>, CliError> {
    let path = paths::resolve()?.config_dir.join("agent-requests.sqlite3");
    if !path.exists() {
        return Ok(None);
    }
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    Ok(Some(db))
}

fn select_query(db: &Connection) -> Result<String, CliError> {
    let mut stmt = db
        .prepare("PRAGMA table_info(requests)")
        .map_err(db_error)?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get(1))
        .map_err(db_error)?
        .collect::<Result<_, _>>()
        .map_err(db_error)?;
    let column = |name: &str| {
        if columns.iter().any(|value| value == name) {
            name.to_owned()
        } else {
            "NULL".to_owned()
        }
    };
    Ok(format!(
        "SELECT notebook_id,operation,request_id,result,{},{},{},{} FROM requests",
        column("created_at"),
        column("updated_at"),
        column("target_hint"),
        column("error_summary")
    ))
}

pub(crate) fn list(state: Option<&str>, limit: usize) -> Result<Value, CliError> {
    if !matches!(state, None | Some("uncertain") | Some("completed")) || !(1..=200).contains(&limit)
    {
        return Err(CliError::Usage(
            "request list: state must be uncertain or completed; limit must be 1–200".into(),
        ));
    }
    let Some(db) = open_read()? else {
        return Ok(serde_json::json!({"ok":true,"requests":[],"truncated":false}));
    };
    let select = select_query(&db)?;
    let query = format!("{select} WHERE (?1 IS NULL OR (?1='uncertain' AND result IS NULL) OR (?1='completed' AND result IS NOT NULL)) ORDER BY 5 DESC, notebook_id, operation, request_id LIMIT ?2");
    let mut stmt = db.prepare(&query).map_err(db_error)?;
    let mut entries = stmt
        .query_map(params![state, (limit + 1) as i64], row_json)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(serde_json::json!({"ok":true,"requests":entries,"truncated":truncated}))
}

pub(crate) fn show(notebook: &str, operation: &str, request_id: &str) -> Result<Value, CliError> {
    validate_operation(operation)?;
    let Some(db) = open_read()? else {
        return Err(CliError::NotFound("request not found".into()));
    };
    let select = select_query(&db)?;
    let query = format!("{select} WHERE notebook_id=?1 AND operation=?2 AND request_id=?3");
    let mut entry = db
        .query_row(&query, params![notebook, operation, request_id], row_json)
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| CliError::NotFound("request not found".into()))?;
    let has_reviews: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_reviews')", [], |row| row.get(0)).map_err(db_error)?;
    if !has_reviews {
        entry["reviews"] = serde_json::json!([]);
        return Ok(entry);
    }
    let mut stmt = db.prepare("SELECT outcome, actor, evidence, reviewed_at FROM request_reviews WHERE notebook_id=?1 AND operation=?2 AND request_id=?3 ORDER BY id").map_err(db_error)?;
    let reviews = stmt.query_map(params![notebook, operation, request_id], |row| Ok(serde_json::json!({"outcome":row.get::<_, String>(0)?,"actor":row.get::<_, String>(1)?,"evidence":row.get::<_, Option<String>>(2)?,"reviewedAt":row.get::<_, String>(3)?}))).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
    entry["reviews"] = serde_json::json!(reviews);
    Ok(entry)
}

/// Records an observation only. It never modifies the reservation or permits a retry.
pub(crate) fn review(
    notebook: &str,
    operation: &str,
    request_id: &str,
    outcome: &str,
    actor: &str,
    evidence: Option<&str>,
) -> Result<Value, CliError> {
    validate_operation(operation)?;
    if !matches!(outcome, "confirmed" | "unresolved") || actor.trim().is_empty() {
        return Err(CliError::Usage(
            "review requires an actor and outcome confirmed or unresolved".into(),
        ));
    }
    let evidence = match outcome {
        "confirmed" => {
            if operation != "create" {
                return Err(CliError::Usage(
                    "confirmed review currently supports ordinary note creation only".into(),
                ));
            }
            let address = evidence
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    CliError::Usage("confirmed review requires --evidence note address".into())
                })?;
            let note = crate::path_store::show(address)?;
            if note["notebookId"].as_str() != Some(notebook) {
                return Err(CliError::Usage(
                    "evidence note must belong to the request notebook".into(),
                ));
            }
            Some(
                note["address"]
                    .as_str()
                    .ok_or_else(|| CliError::Other("note address missing".into()))?
                    .to_owned(),
            )
        }
        _ => evidence.map(str::to_owned),
    };
    let mut db = open()?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let pending: Option<bool> = tx.query_row("SELECT result IS NULL FROM requests WHERE notebook_id=?1 AND operation=?2 AND request_id=?3", params![notebook, operation, request_id], |row| row.get(0)).optional().map_err(db_error)?;
    match pending {
        None => return Err(CliError::NotFound("request not found".into())),
        Some(false) => {
            return Err(CliError::Conflict(
                "completed request does not need review".into(),
            ))
        }
        Some(true) => {}
    }
    tx.execute("INSERT INTO request_reviews(notebook_id,operation,request_id,outcome,actor,evidence,reviewed_at) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![notebook,operation,request_id,outcome,actor,evidence,now()]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    show(notebook, operation, request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_never_reexecutes_reserved_request() {
        if let Ok(stage) = std::env::var("FLOWIX_REQUEST_TEST_STAGE") {
            let marker =
                std::path::PathBuf::from(std::env::var_os("FLOWIX_REQUEST_TEST_MARKER").unwrap());
            let result = execute(
                "nb",
                "create",
                "id",
                &serde_json::json!({"title":"a"}),
                || {
                    if stage == "before" {
                        std::process::exit(91);
                    }
                    if stage == "after" {
                        std::fs::write(&marker, "created").unwrap();
                        std::process::exit(91);
                    }
                    panic!("a retry must never execute the operation")
                },
            );
            assert!(matches!(result, Err(CliError::RequestIndeterminate(_))));
            return;
        }
        for stage in ["before", "after"] {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("created");
            let run = |stage: &str| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "idempotency::tests::crash_never_reexecutes_reserved_request",
                        "--nocapture",
                    ])
                    .env("FLOWIX_HOME", dir.path())
                    .env("FLOWIX_REQUEST_TEST_MARKER", &marker)
                    .env("FLOWIX_REQUEST_TEST_STAGE", stage)
                    .output()
                    .unwrap()
            };
            let interrupted = run(stage);
            assert_eq!(
                interrupted.status.code(),
                Some(91),
                "{}",
                String::from_utf8_lossy(&interrupted.stderr)
            );
            let retry = run("retry");
            assert!(
                retry.status.success(),
                "{}",
                String::from_utf8_lossy(&retry.stdout)
            );
            assert_eq!(marker.exists(), stage == "after");
        }
    }
}
