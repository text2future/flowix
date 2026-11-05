use super::{lookup_key, NoteLink, NoteLinkPage, PARSER_VERSION};
use crate::memo_file::MemoFile;
use rusqlite::{params_from_iter, types::Value, Connection, OptionalExtension};
use std::{
    collections::{BTreeSet, HashMap},
    io,
};

const LOOKUP_BATCH_SIZE: usize = 300;
const MAX_PAGE_SIZE: usize = 200;
const MAX_CURSOR_BYTES: usize = 32 * 1024;
const LINK_ORDER: &str = "l.source_path,l.syntax,l.link_kind,l.target_kind,l.target_key";
const LINK_FIELDS: &str = "l.source_path,l.syntax,l.link_kind,l.target_kind,l.target_key,l.reference_count,
    s.dirty=0 AND s.last_error IS NULL AND s.indexed_content_hash=n.content_hash AND s.parser_version=?1";
const SOURCE_JOINS: &str = "JOIN note_link_state s ON s.source_path=l.source_path
    JOIN notes n ON n.relative_path=l.source_path";

// This indexed collation follows SQLite's ASCII case folding on Windows;
// Unicode paths still retain exact spelling rather than silently conflating names.
const PATH_COLLATION: &str = if cfg!(windows) { "NOCASE" } else { "BINARY" };
fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_ascii_lowercase()
    } else {
        path.to_owned()
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LinkCursor {
    notebook_id: String,
    path: String,
    backlinks: bool,
    after: [String; 5],
}

fn valid_path(path: &str) -> io::Result<()> {
    if path.is_empty()
        || path.contains('\\')
        || path.starts_with('/')
        || path.split('/').any(|s| matches!(s, "" | "." | ".."))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected notebook-relative note path",
        ));
    }
    Ok(())
}

fn variants(path: &str) -> Vec<String> {
    if path.to_lowercase().ends_with(".md") || path.to_lowercase().ends_with(".markdown") {
        vec![path.to_owned()]
    } else {
        vec![format!("{path}.md"), format!("{path}.markdown")]
    }
}

// Resolve each page with batched lookups. No per-reference IPC, filesystem
// access or SELECT loop. Cache only the candidates needed by this bounded page.
struct Resolver {
    paths: HashMap<String, Option<String>>,
    names: HashMap<String, Vec<String>>,
    ready: bool,
}
impl Resolver {
    fn load(conn: &Connection, links: &[NoteLink], ready: bool) -> io::Result<Self> {
        let mut requested = BTreeSet::new();
        for link in links {
            if link.target_kind == "path" {
                requested.extend(variants(&link.target_key));
            } else {
                requested.extend(variants(&link.target_key));
                if let Some((parent, _)) = link.source_path.rsplit_once('/') {
                    requested.extend(variants(&format!("{parent}/{}", link.target_key)));
                }
            }
        }
        let requested: Vec<_> = requested.into_iter().collect();
        let mut paths: HashMap<_, _> = requested.iter().map(|p| (path_key(p), None)).collect();
        for chunk in requested.chunks(LOOKUP_BATCH_SIZE) {
            let sql = format!(
                "SELECT relative_path FROM notes WHERE relative_path COLLATE {PATH_COLLATION} IN ({})",
                vec!["?"; chunk.len()].join(",")
            );
            let mut stmt = conn.prepare(&sql).map_err(io::Error::other)?;
            let rows = stmt
                .query_map(params_from_iter(chunk), |r| r.get::<_, String>(0))
                .map_err(io::Error::other)?;
            for row in rows {
                let path = row.map_err(io::Error::other)?;
                paths.insert(path_key(&path), Some(path));
            }
        }
        let mut resolver = Self {
            paths,
            names: HashMap::new(),
            ready,
        };
        let mut names = BTreeSet::new();
        for link in links {
            if link.target_kind == "wiki" && resolver.path_candidates(link).is_empty() {
                names.extend(variants(&link.target_key.to_lowercase()));
            }
        }
        let names: Vec<_> = names.into_iter().collect();
        let mut matches: HashMap<String, Vec<String>> = HashMap::new();
        for chunk in names.chunks(LOOKUP_BATCH_SIZE) {
            // One bounded index seek per distinct filename, batched in one SQL
            // call. Two matches suffice to distinguish unique from ambiguous.
            let sql = chunk
                .iter()
                .enumerate()
                .map(|(at, _)| {
                    let param = at + 1;
                    format!(
                        "SELECT * FROM (SELECT filename_lower,relative_path FROM notes
                    WHERE filename_lower=?{param} ORDER BY relative_path LIMIT 2)"
                    )
                })
                .collect::<Vec<_>>()
                .join(" UNION ALL ");
            let mut stmt = conn.prepare(&sql).map_err(io::Error::other)?;
            let rows = stmt
                .query_map(params_from_iter(chunk), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(io::Error::other)?;
            for row in rows {
                let (name, path) = row.map_err(io::Error::other)?;
                matches.entry(name).or_default().push(path);
            }
        }
        for link in links.iter().filter(|l| l.target_kind == "wiki") {
            let key = link.target_key.to_lowercase();
            resolver.names.entry(key.clone()).or_insert_with(|| {
                variants(&key)
                    .into_iter()
                    .flat_map(|name| matches.get(&name).cloned().unwrap_or_default())
                    .take(2)
                    .collect()
            });
        }
        Ok(resolver)
    }
    fn candidates(&self, key: &str) -> Vec<String> {
        variants(key)
            .iter()
            .filter_map(|p| self.paths.get(&path_key(p)).cloned().flatten())
            .collect()
    }
    fn path_candidates(&self, link: &NoteLink) -> Vec<String> {
        if link.target_kind == "path" {
            return self.candidates(&link.target_key);
        }
        if let Some((parent, _)) = link.source_path.rsplit_once('/') {
            let local = self.candidates(&format!("{parent}/{}", link.target_key));
            if !local.is_empty() {
                return local;
            }
        }
        self.candidates(&link.target_key)
    }
    fn resolve(&self, link: &NoteLink) -> Vec<String> {
        let paths = self.path_candidates(link);
        if !paths.is_empty() || link.target_kind == "path" {
            paths
        } else {
            self.names
                .get(&link.target_key.to_lowercase())
                .cloned()
                .unwrap_or_default()
        }
    }
}

impl MemoFile {
    pub fn query_note_outlinks(
        &self,
        notebook_id: &str,
        source_path: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> io::Result<NoteLinkPage> {
        self.query_note_links(notebook_id, source_path, false, cursor, limit)
    }
    pub fn query_note_backlinks(
        &self,
        notebook_id: &str,
        target_path: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> io::Result<NoteLinkPage> {
        self.query_note_links(notebook_id, target_path, true, cursor, limit)
    }
    fn query_note_links(
        &self,
        notebook_id: &str,
        path: &str,
        backlinks: bool,
        cursor: Option<&str>,
        limit: usize,
    ) -> io::Result<NoteLinkPage> {
        valid_path(path)?;
        let mut conn = self.open_note_index_connection(notebook_id)?;
        // Read a consistent DB snapshot; never reconcile/read note bodies here.
        let tx = conn.transaction().map_err(io::Error::other)?;
        let source_fresh: Option<bool> = tx.query_row(
            "SELECT COALESCE(s.dirty=0 AND s.last_error IS NULL AND s.indexed_content_hash=n.content_hash AND s.parser_version=?2,0)
             FROM notes n LEFT JOIN note_link_state s ON s.source_path=n.relative_path WHERE n.relative_path=?1",
            rusqlite::params![path,PARSER_VERSION], |r|r.get(0),
        ).optional().map_err(io::Error::other)?;
        let source_fresh = source_fresh
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "note not indexed"))?;
        let ready: bool = tx
            .query_row(
                "SELECT value='ready' FROM note_index_meta WHERE key='build_state'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(io::Error::other)?
            .unwrap_or(false);
        let mut values: Vec<Value> = vec![Value::Integer(PARSER_VERSION)];
        if backlinks {
            let filename = path.rsplit('/').next().unwrap_or(path);
            let stem = if path.to_lowercase().ends_with(".markdown") {
                &path[..path.len() - 9]
            } else {
                &path[..path.len() - 3]
            };
            let name_stem = stem.rsplit('/').next().unwrap_or(stem);
            for key in [
                lookup_key("path", path),
                lookup_key("path", stem),
                lookup_key("wiki", filename),
                lookup_key("wiki", name_stem),
            ] {
                values.push(Value::Text(key));
            }
        } else {
            values.push(Value::Text(path.to_owned()));
        }
        let mut seek = String::new();
        if let Some(cursor) = cursor {
            if cursor.len() > MAX_CURSOR_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid link cursor",
                ));
            }
            let key: LinkCursor = serde_json::from_str(cursor)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid link cursor"))?;
            if key.notebook_id != notebook_id || key.path != path || key.backlinks != backlinks {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cursor belongs to a different link query",
                ));
            }
            let at = values.len() + 1;
            seek = format!(" AND (l.source_path,l.syntax,l.link_kind,l.target_kind,l.target_key)>(?{},?{},?{},?{},?{})",at,at+1,at+2,at+3,at+4);
            values.extend(key.after.into_iter().map(Value::Text));
        }
        let limit = limit.clamp(1, MAX_PAGE_SIZE);
        let order = LINK_ORDER;
        let limit_param = values.len() + 1;
        let sql = if backlinks {
            // Each equality range follows the target index's implicit primary-key
            // suffix. Limit it before merging: at most 4*(limit+1) rows are sorted
            // and joined, regardless of the target's total number of references.
            let branches: Vec<_> = [("path", 2), ("path", 3), ("wiki", 4), ("wiki", 5)]
                .into_iter()
                .map(|(kind, param)| {
                    format!(
                    "SELECT * FROM (SELECT l.* FROM note_links l INDEXED BY idx_note_links_target
                     WHERE l.target_kind='{kind}' AND l.lookup_key=?{param}{seek}
                     ORDER BY {order} LIMIT ?{limit_param})"
                )
                })
                .collect();
            format!(
                "SELECT {LINK_FIELDS} FROM ({}) l {SOURCE_JOINS}
                ORDER BY {order} LIMIT ?{limit_param}",
                branches.join(" UNION ALL ")
            )
        } else {
            format!(
                "SELECT {LINK_FIELDS} FROM note_links l {SOURCE_JOINS}
                WHERE l.source_path=?2{seek} ORDER BY {order} LIMIT ?{limit_param}"
            )
        };
        values.push(Value::Integer((limit + 1) as i64));
        let mut raw = {
            let mut stmt = tx.prepare(&sql).map_err(io::Error::other)?;
            let rows = stmt
                .query_map(params_from_iter(values), |r| {
                    Ok(NoteLink {
                        source_path: r.get(0)?,
                        syntax: r.get(1)?,
                        link_kind: r.get(2)?,
                        target_kind: r.get(3)?,
                        target_key: r.get(4)?,
                        reference_count: r.get(5)?,
                        fresh: r.get(6)?,
                        resolved_path: None,
                        resolution: String::new(),
                    })
                })
                .map_err(io::Error::other)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io::Error::other)?;
            rows
        };
        let has_more = raw.len() > limit;
        raw.truncate(limit);
        // Backlink pages advance over candidates, including ambiguous/nonmatching
        // references. This bounds work and may legitimately return an empty page
        // with nextCursor; callers must use the cursor rather than item count.
        let next_cursor = if has_more {
            raw.last().map(|r| {
                serde_json::to_string(&LinkCursor {
                    notebook_id: notebook_id.into(),
                    path: path.into(),
                    backlinks,
                    after: [
                        r.source_path.clone(),
                        r.syntax.clone(),
                        r.link_kind.clone(),
                        r.target_kind.clone(),
                        r.target_key.clone(),
                    ],
                })
                .unwrap()
            })
        } else {
            None
        };
        let resolver = Resolver::load(&tx, &raw, ready)?;
        let mut links = Vec::new();
        for mut link in raw {
            let found = resolver.resolve(&link);
            link.resolution = match found.len() {
                0 => {
                    if resolver.ready {
                        "missing"
                    } else {
                        "index-pending"
                    }
                }
                1 => {
                    link.resolved_path = Some(found[0].clone());
                    "resolved"
                }
                _ => "ambiguous",
            }
            .into();
            if !backlinks || link.resolved_path.as_deref() == Some(path) {
                links.push(link);
            }
        }
        tx.commit().map_err(io::Error::other)?;
        Ok(NoteLinkPage {
            links,
            source_fresh: (!backlinks).then_some(source_fresh),
            next_cursor,
            has_more,
        })
    }
}
