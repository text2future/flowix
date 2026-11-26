//! Dumps the schema a freshly initialized SyncStore produces, so it can be
//! diffed against an older database file that drifted behind the code.

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: schema_dump <dir-for-fresh-db>");
    let path = std::path::Path::new(&dir).join("fresh-sync.db");
    let _ = std::fs::remove_file(&path);
    let store = flowix_sync::SyncStore::new(&path).expect("store");
    store.initialize_schema().expect("schema");
    let connection = rusqlite::Connection::open(&path).expect("open dump source");
    let mut dump = String::new();
    let mut rows = connection
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .expect("prepare");
    let iterator = rows
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query");
    for (name, sql) in iterator {
        dump.push_str(&format!("-- {name}\n{sql}\n\n"));
    }
    print!("{dump}");
}
