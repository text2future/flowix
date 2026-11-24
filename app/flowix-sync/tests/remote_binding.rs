use flowix_sync::{remote::S3Remote, PathNotebookMetadata, SyncManager};

fn remote(endpoint: &str) -> S3Remote {
    S3Remote {
        endpoint: endpoint.into(),
        region: "auto".into(),
        bucket: "notes".into(),
        prefix: "flowix".into(),
    }
}

#[tokio::test]
async fn custom_target_is_persistent_and_cannot_be_reused_for_official() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("sync.db");
    let manager = SyncManager::new("https://example.com", &db).unwrap();
    assert!(!manager.cloud_sync_available());
    manager
        .configure_s3_remote(&remote("https://one.example"), "one", "key", "secret")
        .unwrap();
    assert!(manager.cloud_sync_available());
    assert!(manager.require_remote_access().is_ok());
    assert!(manager
        .configure_s3_remote(&remote("https://two.example"), "two", "key", "secret")
        .is_err());
    drop(manager);
    let official = SyncManager::new("https://example.com", &db).unwrap();
    assert!(official
        .remote_notebooks()
        .await
        .unwrap_err()
        .to_string()
        .contains("non-official storage target"));
    drop(official);
    let restored = SyncManager::new("https://example.com", &db).unwrap();
    restored
        .configure_s3_remote(
            &remote("https://one.example"),
            "one",
            "rotated-key",
            "rotated-secret",
        )
        .unwrap();
}

#[test]
fn existing_sync_state_cannot_be_assigned_to_a_new_target() {
    let dir = tempfile::tempdir().unwrap();
    let manager = SyncManager::new("https://example.com", dir.path().join("sync.db")).unwrap();
    manager
        .set_path_notebook_enabled(
            &PathNotebookMetadata {
                id: "nb_one".into(),
                name: "Notes".into(),
                icon: None,
                sort_order: 0,
            },
            true,
        )
        .unwrap();
    assert!(manager
        .configure_s3_remote(&remote("https://one.example"), "one", "key", "secret")
        .unwrap_err()
        .to_string()
        .contains("explicit storage migration"));
}

#[tokio::test]
async fn custom_remote_lists_directly_without_official_login() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = [0u8; 8192];
        let size = stream.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..size]);
        assert!(request.starts_with("GET /notes/?"));
        assert!(request.contains("prefix=flowix%2Fnb%2F"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: aws4-hmac-sha256"));
        let body = "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>";
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let manager = SyncManager::new("https://example.com", dir.path().join("sync.db")).unwrap();
    manager
        .configure_s3_remote(&remote(&endpoint), "local", "key", "secret")
        .unwrap();
    assert!(manager.remote_notebooks().await.unwrap().is_empty());
    server.join().unwrap();
}
