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
    // 真实 DbBackend + 临时 db 文件, 验证建表 / upsert / query / delete 全链路。
    // 显式走 DbBackend：macOS 上 `SecretStore::new` 会选 Keychain，
    // 单测不应写真实钥匙串。
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
fn migration_moves_rows_into_the_backend_and_clears_the_table() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("default.db");
    let db = DbBackend::new(&db_path);
    db.save("anthropic::default", "sk-1").unwrap();
    db.save("flowix-cloud::default", "rt-2").unwrap();

    let target = MockBackend::new(KeyBackend::Keychain);
    assert_eq!(migrate_db_secrets(&db_path, &target).unwrap(), 2);

    // db 表已清空（secure_delete 下删除即粉碎），新后端读得到值。
    assert!(db.load("anthropic::default").unwrap().is_none());
    assert!(db.load("flowix-cloud::default").unwrap().is_none());
    assert_eq!(
        target.load("anthropic::default").unwrap().unwrap().expose(),
        "sk-1"
    );
    assert_eq!(
        target
            .load("flowix-cloud::default")
            .unwrap()
            .unwrap()
            .expose(),
        "rt-2"
    );

    // 幂等：残留行搬完后再跑是 no-op。
    assert_eq!(migrate_db_secrets(&db_path, &target).unwrap(), 0);
}

#[test]
fn migration_failure_keeps_rows_in_the_database() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("default.db");
    let db = DbBackend::new(&db_path);
    db.save("anthropic::default", "sk-1").unwrap();

    let mut target = MockBackend::new(KeyBackend::Keychain);
    target.fail_unavailable = true;
    assert!(migrate_db_secrets(&db_path, &target).is_err());
    // 行还在 db 里：迁移失败的兜底是继续用 db 后端，凭据不能丢。
    assert_eq!(
        db.load("anthropic::default").unwrap().unwrap().expose(),
        "sk-1"
    );
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
