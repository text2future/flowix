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
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("default.db");
    let store = SecretStore::new(&db_path);

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
