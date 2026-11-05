use super::{
    parser, NoteLinkBatch, NoteLinkStatus, Reference, MAX_BODY_BYTES, PARSER_VERSION,
    SCHEMA_VERSION,
};
use crate::memo_file::{notebook_path_from_relative, MemoFile};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    collections::VecDeque,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

// Cache only small snapshots. One key per source, bounded both by bytes and
// count; persistence is in dirty rows, not in this best-effort acceleration.
struct Snapshot {
    root: PathBuf,
    source: String,
    hash: String,
    body: String,
}
static SNAPSHOTS: OnceLock<Mutex<VecDeque<Snapshot>>> = OnceLock::new();

struct Activity {
    root: PathBuf,
    active_saves: usize,
    last_change: Instant,
}
static ACTIVITY: OnceLock<Mutex<VecDeque<Activity>>> = OnceLock::new();
const IDLE_WINDOW: Duration = Duration::from_millis(500);
const MAX_ACTIVITY_ROOTS: usize = 128;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_SNAPSHOTS: usize = 64;
const MAX_SNAPSHOT_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_SOURCES: usize = 32;
const BATCH_BUDGET: Duration = Duration::from_millis(25);
const ERROR_RETRY_MS: i64 = 30_000;
const MIN_RETRY_MS: i64 = 100;
fn change_activity(root: &Path, change: i32) {
    let mut entries = ACTIVITY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut item = entries
        .iter()
        .position(|a| a.root == root)
        .and_then(|at| entries.remove(at))
        .unwrap_or_else(|| Activity {
            root: root.to_owned(),
            active_saves: 0,
            last_change: Instant::now(),
        });
    if change > 0 {
        item.active_saves += 1;
    } else if change < 0 {
        item.active_saves = item.active_saves.saturating_sub(1);
    }
    item.last_change = Instant::now();
    entries.push_back(item);
    while entries.len() > MAX_ACTIVITY_ROOTS {
        let Some(at) = entries.iter().position(|a| a.active_saves == 0) else {
            break;
        };
        entries.remove(at);
    }
}
fn idle_delay(root: &Path) -> Option<u64> {
    let entries = ACTIVITY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let activity = entries.iter().find(|a| a.root == root)?;
    if activity.active_saves > 0 {
        return Some(IDLE_WINDOW.as_millis() as u64);
    }
    IDLE_WINDOW
        .checked_sub(activity.last_change.elapsed())
        .map(|d| d.as_millis().max(1) as u64)
}
/// In-memory admission only; no I/O or waiting on the foreground save path.
pub(crate) struct SaveAdmission(PathBuf);
pub(crate) fn foreground_save(root: &Path) -> SaveAdmission {
    change_activity(root, 1);
    SaveAdmission(root.to_owned())
}
impl Drop for SaveAdmission {
    fn drop(&mut self) {
        change_activity(&self.0, -1);
    }
}

pub(crate) fn remember_snapshot(root: &Path, source: &str, hash: &str, body: &str) {
    change_activity(root, 0);
    if body.len() > MAX_SNAPSHOT_BYTES {
        return;
    }
    let mut cache = SNAPSHOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache.retain(|s| s.root != root || s.source != source);
    while cache.len() >= MAX_SNAPSHOTS
        || cache.iter().map(|s| s.body.len()).sum::<usize>() + body.len() > MAX_SNAPSHOT_TOTAL_BYTES
    {
        cache.pop_front();
    }
    cache.push_back(Snapshot {
        root: root.to_owned(),
        source: source.into(),
        hash: hash.into(),
        body: body.into(),
    });
}

fn take_snapshot(root: &Path, source: &str, hash: &str) -> Option<String> {
    let mut cache = SNAPSHOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let at = cache
        .iter()
        .position(|s| s.root == root && s.source == source && s.hash == hash)?;
    Some(cache.remove(at)?.body)
}

/// Additive, atomic migration. Source FKs clean up deletions; target keys have
/// no FK so unresolved references survive deletion of the target document.
pub(crate) fn initialize_schema(conn: &mut Connection) -> io::Result<()> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(io::Error::other)?;
    for (key, supported) in [
        (
            "links_schema_version",
            SCHEMA_VERSION.parse::<i64>().unwrap(),
        ),
        ("links_parser_version", PARSER_VERSION),
    ] {
        let stored: Option<String> = tx
            .query_row(
                "SELECT value FROM note_index_meta WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        if stored.as_deref().is_some_and(|value| {
            value
                .parse::<i64>()
                .map_or(true, |version| version > supported)
        }) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "document link index belongs to a newer version",
            ));
        }
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_links (
          source_path TEXT NOT NULL REFERENCES notes(relative_path) ON DELETE CASCADE ON UPDATE CASCADE,
          syntax TEXT NOT NULL, link_kind TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('path','wiki')),
          target_key TEXT NOT NULL, lookup_key TEXT NOT NULL,
          reference_count INTEGER NOT NULL CHECK(reference_count>0),
          PRIMARY KEY(source_path,syntax,link_kind,target_kind,target_key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_kind,lookup_key,source_path);
        CREATE TABLE IF NOT EXISTS note_link_state (
          source_path TEXT PRIMARY KEY REFERENCES notes(relative_path) ON DELETE CASCADE ON UPDATE CASCADE,
          indexed_content_hash TEXT,
          parser_version INTEGER NOT NULL DEFAULT 0,
          dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0,1)),
          request_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
          last_error TEXT, retry_after INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_note_links_pending ON note_link_state(retry_after,source_path) WHERE dirty=1;
        CREATE INDEX IF NOT EXISTS idx_notes_link_filename ON notes(filename_lower,relative_path);
        CREATE TRIGGER IF NOT EXISTS note_links_insert AFTER INSERT ON notes BEGIN
          INSERT INTO note_link_state(source_path) VALUES(NEW.relative_path)
          ON CONFLICT(source_path) DO UPDATE SET dirty=1,request_id=lower(hex(randomblob(16))),last_error=NULL,retry_after=0;
        END;
        CREATE TRIGGER IF NOT EXISTS note_links_content AFTER UPDATE OF content_hash ON notes
        WHEN OLD.content_hash<>NEW.content_hash BEGIN
          INSERT INTO note_link_state(source_path) VALUES(NEW.relative_path)
          ON CONFLICT(source_path) DO UPDATE SET dirty=1,request_id=lower(hex(randomblob(16))),last_error=NULL,retry_after=0;
        END;
        CREATE TRIGGER IF NOT EXISTS note_links_move AFTER UPDATE OF relative_path ON notes
        WHEN OLD.relative_path<>NEW.relative_path BEGIN
          UPDATE note_link_state SET dirty=1,indexed_content_hash=NULL,request_id=lower(hex(randomblob(16))),last_error=NULL,retry_after=0
          WHERE source_path=NEW.relative_path;
        END;
        INSERT OR IGNORE INTO note_link_state(source_path) SELECT relative_path FROM notes;"
    ).map_err(io::Error::other)?;
    // Only Windows needs this additional lookup index; other platforms keep
    // their existing case-sensitive primary-key lookup and save cost.
    #[cfg(windows)]
    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_notes_link_path_nocase ON notes(relative_path COLLATE NOCASE);")
        .map_err(io::Error::other)?;
    tx.execute("UPDATE note_link_state SET dirty=1,request_id=lower(hex(randomblob(16))),last_error=NULL,retry_after=0
                WHERE parser_version<>?1 AND dirty=0", [PARSER_VERSION]).map_err(io::Error::other)?;
    for (key, value) in [
        ("links_schema_version", SCHEMA_VERSION.to_owned()),
        ("links_parser_version", PARSER_VERSION.to_string()),
    ] {
        tx.execute("INSERT INTO note_index_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])
            .map_err(io::Error::other)?;
    }
    tx.commit().map_err(io::Error::other)
}

pub(crate) fn stored_references(conn: &Connection, source: &str) -> io::Result<Vec<Reference>> {
    let mut stmt = conn.prepare("SELECT syntax,link_kind,target_kind,target_key,lookup_key,reference_count FROM note_links
        WHERE source_path=?1 ORDER BY syntax,link_kind,target_kind,target_key").map_err(io::Error::other)?;
    let rows = stmt
        .query_map([source], |r| {
            Ok(Reference {
                syntax: r.get(0)?,
                kind: r.get(1)?,
                target_kind: r.get(2)?,
                target_key: r.get(3)?,
                lookup_key: r.get(4)?,
                count: r.get(5)?,
            })
        })
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;
    Ok(rows)
}

impl MemoFile {
    pub fn note_link_status(&self, notebook_id: &str) -> io::Result<NoteLinkStatus> {
        let conn = self.open_note_index_connection(notebook_id)?;
        conn.query_row(
            "SELECT COALESCE(SUM(dirty=1),0),COALESCE(SUM(last_error IS NOT NULL),0),
            COALESCE(SUM(dirty=0 AND last_error IS NULL),0) FROM note_link_state",
            [],
            |r| {
                Ok(NoteLinkStatus {
                    pending: r.get(0)?,
                    failed: r.get(1)?,
                    indexed: r.get(2)?,
                })
            },
        )
        .map_err(io::Error::other)
    }

    /// Yield to active saves and to a quiet window following watcher bursts.
    /// Explicit maintenance may use process_note_links_batch without this gate.
    pub fn process_note_links_background_batch(
        &self,
        notebook_id: &str,
        limit: usize,
        keep_running: &dyn Fn() -> bool,
    ) -> io::Result<NoteLinkBatch> {
        let root = PathBuf::from(
            self.get_notebook_config_by_id(notebook_id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?
                .path,
        );
        if let Some(delay) = idle_delay(&root) {
            return Ok(NoteLinkBatch {
                pending: true,
                retry_after_ms: Some(delay),
                ..Default::default()
            });
        }
        let mut report = self.process_note_links_batch(notebook_id, limit, &|| {
            keep_running() && idle_delay(&root).is_none()
        })?;
        if report.pending {
            if let Some(delay) = idle_delay(&root) {
                report.retry_after_ms = Some(delay);
            }
        }
        Ok(report)
    }

    /// At most `limit` sources and about 25ms between sources; a single document
    /// is bounded to 4MiB/50k references. Never called by the save or read APIs.
    pub fn process_note_links_batch(
        &self,
        notebook_id: &str,
        limit: usize,
        keep_running: &dyn Fn() -> bool,
    ) -> io::Result<NoteLinkBatch> {
        let mut conn = self.open_note_index_connection(notebook_id)?;
        conn.busy_timeout(Duration::ZERO)
            .map_err(io::Error::other)?;
        let book = self
            .get_notebook_config_by_id(notebook_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let root = Path::new(&book.path);
        let now = chrono::Utc::now().timestamp_millis();
        let jobs = {
            let mut stmt = conn.prepare("SELECT s.source_path,n.content_hash,s.request_id FROM note_link_state s JOIN notes n ON n.relative_path=s.source_path
                WHERE s.dirty=1 AND s.retry_after<=?1 ORDER BY s.retry_after,s.source_path LIMIT ?2").map_err(io::Error::other)?;
            let rows = stmt
                .query_map(params![now, limit.clamp(1, MAX_BATCH_SOURCES)], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(io::Error::other)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io::Error::other)?;
            rows
        };
        let started = Instant::now();
        let mut report = NoteLinkBatch::default();
        for (source, hash, request) in jobs {
            if !keep_running() || (report.processed > 0 && started.elapsed() > BATCH_BUDGET) {
                break;
            }
            // All body I/O, hashing and Markdown parsing occurs outside a DB write transaction.
            let parsed = (|| {
                let body = if let Some(body) = take_snapshot(root, &source, &hash) {
                    body
                } else {
                    let path =
                        notebook_path_from_relative(root, &source).map_err(io::Error::other)?;
                    let meta = fs::symlink_metadata(&path)?;
                    if !meta.is_file()
                        || meta.file_type().is_symlink()
                        || meta.len() > MAX_BODY_BYTES as u64
                    {
                        return Err(io::Error::other(
                            "not a regular note or exceeds link-index size limit",
                        ));
                    }
                    if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "note leaves notebook",
                        ));
                    }
                    let mut body = String::new();
                    fs::File::open(path)?
                        .take((MAX_BODY_BYTES + 1) as u64)
                        .read_to_string(&mut body)?;
                    if body.len() > MAX_BODY_BYTES {
                        return Err(io::Error::other("document exceeds link-index size limit"));
                    }
                    if format!("{:x}", Sha256::digest(body.as_bytes())) != hash {
                        return Err(io::Error::other(
                            "note snapshot differs from document index; awaiting refresh",
                        ));
                    }
                    body
                };
                parser::extract(&source, &body, &book)
            })();
            if !keep_running() {
                break;
            }
            // Share the existing structure lock order; never acquire it with a
            // SQLite writer transaction held. This also serializes directory rebase.
            let _guard = self
                .operation_locks()
                .notebook_read(notebook_id, "note_links_commit")?;
            let tx = match conn.transaction_with_behavior(TransactionBehavior::Immediate) {
                Ok(tx) => tx,
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if matches!(
                        e.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
                {
                    break
                }
                Err(e) => return Err(io::Error::other(e)),
            };
            if !keep_running() {
                break;
            }
            let current: Option<(String,String)> = tx.query_row("SELECT n.content_hash,s.request_id FROM notes n JOIN note_link_state s ON s.source_path=n.relative_path
                WHERE n.relative_path=?1 AND s.dirty=1",[&source],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(io::Error::other)?;
            if current.as_ref() != Some(&(hash.clone(), request.clone())) {
                continue;
            }
            // A newer binary may have migrated the parser while this job was running.
            let parser: String = tx
                .query_row(
                    "SELECT value FROM note_index_meta WHERE key='links_parser_version'",
                    [],
                    |r| r.get(0),
                )
                .map_err(io::Error::other)?;
            if parser != PARSER_VERSION.to_string() {
                continue;
            }
            match parsed {
                Ok(references) => {
                    if stored_references(&tx, &source)? != references {
                        tx.execute("DELETE FROM note_links WHERE source_path=?1", [&source])
                            .map_err(io::Error::other)?;
                        {
                            let mut insert = tx.prepare_cached("INSERT INTO note_links(source_path,syntax,link_kind,target_kind,target_key,lookup_key,reference_count)
                                VALUES(?1,?2,?3,?4,?5,?6,?7)").map_err(io::Error::other)?;
                            for r in references {
                                insert
                                    .execute(params![
                                        source,
                                        r.syntax,
                                        r.kind,
                                        r.target_kind,
                                        r.target_key,
                                        r.lookup_key,
                                        r.count
                                    ])
                                    .map_err(io::Error::other)?;
                            }
                        }
                        report.changed += 1;
                    }
                    tx.execute("UPDATE note_link_state SET indexed_content_hash=?2,parser_version=?3,dirty=0,last_error=NULL,retry_after=0 WHERE source_path=?1",
                        params![source,hash,PARSER_VERSION]).map_err(io::Error::other)?;
                }
                Err(error) => {
                    let message: String = error.to_string().chars().take(512).collect();
                    tx.execute("UPDATE note_link_state SET last_error=?2,retry_after=?3 WHERE source_path=?1",params![source,message,now+ERROR_RETRY_MS]).map_err(io::Error::other)?;
                    report.failed += 1;
                }
            }
            tx.commit().map_err(io::Error::other)?;
            report.processed += 1;
        }
        let next: Option<i64> = conn.query_row("SELECT retry_after FROM note_link_state WHERE dirty=1 ORDER BY retry_after,source_path LIMIT 1",[],|r|r.get(0)).optional().map_err(io::Error::other)?;
        report.pending = next.is_some();
        report.retry_after_ms =
            next.map(|at| (at - chrono::Utc::now().timestamp_millis()).max(MIN_RETRY_MS) as u64);
        Ok(report)
    }
}
