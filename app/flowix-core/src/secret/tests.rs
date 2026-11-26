//! SecretStore 单测 ── MockBackend 走内存 map, 不依赖真实磁盘 db。

use super::*;

#[test]
fn mock_backend_round_trip() {
    let backend = Box::new(MockBackend::new(KeyBackend::Database));
    let store = SecretStore::with_backend(backend);

    // 初始不存在
    assert!(!store.exists("anthropic::default"));

    // 保存 + 加载
    store.save("anthropic::default", "sk-ant-1234").unwrap();
    assert!(store.exists("anthropic::default"));
    let loaded = store.load("anthropic::default").unwrap().unwrap();
    assert_eq!(loaded.expose(), "sk-ant-1234");

    // 删除
    assert!(store.delete("anthropic::default").unwrap());
    assert!(!store.exists("anthropic::default"));

    // 二次删除返 false (no-op)
    assert!(!store.delete("anthropic::default").unwrap());
}

#[test]
fn db_backend_round_trip_against_real_sqlite() {
    // Encrypted DbBackend + 临时 db 文件, 验证建表 / upsert / query / delete 全链路。
    // Use a temporary encrypted SQLite database instead of user config.
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("default.db");
    let store = SecretStore::with_backend(Box::new(DbBackend::new(&db_path)));

    assert_eq!(store.backend(), KeyBackend::Database);
    assert!(!store.exists("openai_responses::default"));

    store
        .save("openai_responses::default", "sk-real-1")
        .unwrap();
    assert_eq!(
        store
            .load("openai_responses::default")
            .unwrap()
            .unwrap()
            .expose(),
        "sk-real-1"
    );

    // upsert 覆盖旧值
    store
        .save("openai_responses::default", "sk-real-2")
        .unwrap();
    assert_eq!(
        store
            .load("openai_responses::default")
            .unwrap()
            .unwrap()
            .expose(),
        "sk-real-2"
    );

    // 删除后再读 -> None
    assert!(store.delete("openai_responses::default").unwrap());
    assert!(store.load("openai_responses::default").unwrap().is_none());

    // db 文件确实落盘
    assert!(db_path.exists());
}

#[test]
fn entry_name_format_is_provider_account() {
    assert_eq!(
        entry_name("openai_responses", "default"),
        "openai_responses::default"
    );
    assert_eq!(entry_name("anthropic", "team_a"), "anthropic::team_a");
}

#[test]
fn database_connections_enable_secure_delete() {
    let directory = tempfile::tempdir().unwrap();
    let backend = DbBackend::new(directory.path().join("secrets.db"));
    let connection = backend.open().unwrap();
    let secure_delete: i64 = connection
        .query_row("PRAGMA secure_delete", [], |row| row.get(0))
        .unwrap();
    assert_eq!(secure_delete, 1);
}

#[cfg(unix)]
#[test]
fn database_permissions_are_restricted_before_storing_secrets() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("secrets.db");
    let store = SecretStore::with_backend(Box::new(DbBackend::new(&path)));
    store.save("account", "secret").unwrap();
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn legacy_plaintext_migration_waits_for_wal_readers_then_cleans_up() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local.db");
    let reader = Connection::open(&path).unwrap();
    reader
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
         CREATE TABLE secret_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO secret_kv VALUES ('account', 'legacy-secret');
         BEGIN; SELECT value FROM secret_kv;",
        )
        .unwrap();
    let backend = DbBackend::new_shared_database(&path);
    assert_eq!(
        backend.load("account").unwrap().unwrap().expose(),
        "legacy-secret"
    );
    let check = Connection::open(&path).unwrap();
    let pending: bool = check
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM secret_store_metadata WHERE key='legacy_wal_cleanup')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(pending);
    drop(check);
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    assert_eq!(
        backend.load("account").unwrap().unwrap().expose(),
        "legacy-secret"
    );
    let check = Connection::open(&path).unwrap();
    let (stored, pending): (String, bool) = check.query_row(
        "SELECT value, EXISTS(SELECT 1 FROM secret_store_metadata WHERE key='legacy_wal_cleanup') FROM secret_kv WHERE key='account'",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert!(stored.starts_with(ENCRYPTED_SECRET_PREFIX));
    assert!(!pending);
}

#[test]
fn initialized_store_reads_during_an_unrelated_wal_write() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local.db");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE unrelated (value TEXT);")
        .unwrap();
    let store = DbBackend::new_shared_database(&path);
    store.save("account", "secret").unwrap();
    connection
        .execute_batch("BEGIN IMMEDIATE; INSERT INTO unrelated VALUES ('pending');")
        .unwrap();
    // S3 calls construct a fresh backend for each read.
    let reopened = DbBackend::new_shared_database(&path);
    assert_eq!(
        reopened.load("account").unwrap().unwrap().expose(),
        "secret"
    );
    connection.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn rebuilt_database_is_initialized_again_in_the_same_process() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("default.db");
    let backend = DbBackend::new(&path);
    backend.save("old", "secret").unwrap();
    std::fs::write(&path, b"not a database").unwrap();
    assert!(backend.load("old").unwrap().is_none());
    backend.save("new", "new-secret").unwrap();
    assert_eq!(backend.load("new").unwrap().unwrap().expose(), "new-secret");
}

#[test]
fn missing_or_wrong_key_never_overwrites_existing_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("default.db");
    let backend = DbBackend::new(&path);
    backend.save("account", "secret").unwrap();
    let key_path = sidecar_key_path(&path);
    let original_key = std::fs::read(&key_path).unwrap();
    std::fs::remove_file(&key_path).unwrap();
    assert!(backend.save("account", "replacement").is_err());
    std::fs::write(&key_path, [7; ENCRYPTION_KEY_BYTES]).unwrap();
    assert!(backend.save("account", "replacement").is_err());
    std::fs::write(&key_path, original_key).unwrap();
    assert_eq!(backend.load("account").unwrap().unwrap().expose(), "secret");
}

#[test]
fn save_rejects_empty_inputs() {
    let store = SecretStore::with_backend(Box::new(MockBackend::new(KeyBackend::Database)));
    assert!(store.save("", "sk-x").is_err());
    assert!(store.save("anthropic::default", "").is_err());
}

#[test]
fn unavailable_backend_returns_backend_unavailable_error() {
    let backend = MockBackend {
        store: Mutex::new(Default::default()),
        backend_kind: KeyBackend::Unavailable,
        fail_unavailable: true,
    };
    let store = SecretStore::with_backend(Box::new(backend));

    // save / load 都返 BackendUnavailable ── 这是降级路径的触发信号
    let save_err = store.save("x::default", "y").unwrap_err();
    assert!(matches!(save_err, SecretStoreError::BackendUnavailable(_)));

    let load_err = store.load("x::default").unwrap_err();
    assert!(matches!(load_err, SecretStoreError::BackendUnavailable(_)));
}

#[test]
fn secret_string_debug_redacts_value() {
    let s = SecretString::new("sk-very-secret".into());
    let dbg = format!("{:?}", s);
    // 不能包含原始 secret
    assert!(!dbg.contains("sk-very-secret"));
    // 至少应包含 "SecretString"
    assert!(dbg.contains("SecretString"));
}

#[test]
fn backend_name_propagates_from_mock() {
    let store = SecretStore::with_backend(Box::new(MockBackend::new(KeyBackend::Database)));
    assert_eq!(store.backend(), KeyBackend::Database);

    let store = SecretStore::with_backend(Box::new(MockBackend::new(KeyBackend::Unavailable)));
    assert_eq!(store.backend(), KeyBackend::Unavailable);
}

#[test]
fn provider_key_status_serializes_as_camel_case() {
    let status = ProviderKeyStatus {
        provider: "anthropic".into(),
        source: KeySource::Database,
        backend: KeyBackend::Database,
    };
    let json = serde_json::to_string(&status).unwrap();
    // 字段名走 camelCase, source 走 snake_case ("plaintext"), backend 走 lowercase
    assert!(json.contains("\"provider\":\"anthropic\""));
    assert!(json.contains("\"backend\":\"database\""));
    assert!(json.contains("\"source\":\"database\""));
}
