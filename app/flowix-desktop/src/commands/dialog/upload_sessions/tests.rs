use super::*;

#[test]
fn requests_are_bounded_before_entering_the_blocking_queue() {
    let id = uuid::Uuid::new_v4().to_string();
    assert!(admit_request("not-a-session", None).is_err());
    assert!(admit_request(&id, Some("")).is_err());
    let oversized = "A".repeat(CHUNK_BYTES.div_ceil(3) * 4 + 1);
    assert!(admit_request(&id, Some(&oversized)).is_err());
    let permits = (0..4)
        .map(|_| admit_request(&id, Some("YQ==")).unwrap())
        .collect::<Vec<_>>();
    assert!(admit_request(&id, None).is_err());
    drop(permits);
    assert!(admit_request(&id, None).is_ok());
}

#[test]
fn sessions_enforce_owner_order_limits_expiry_and_release() {
    let sessions = UploadSessions::default();
    let begin = |size| {
        sessions.begin(
            "main",
            0,
            Some("notes/memo.md".into()),
            "notebook".into(),
            "file.bin".into(),
            size,
        )
    };
    assert!(begin(base64_input::MAX_CONTENT_BYTES as u64 + 1).is_err());
    let first = begin(3).unwrap();
    let second = begin(0).unwrap();
    assert!(begin(0).is_err());
    assert!(sessions.append("other", &first, 0, "YWJj").is_err());
    sessions.cancel("other", &first).unwrap();
    assert!(sessions.take("other", &first).is_err());
    sessions.append("main", &first, 0, "YWJj").unwrap();
    let mut uploaded = sessions.take("main", &first).unwrap();
    let mut bytes = Vec::new();
    uploaded.file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"abc");
    assert!(begin(0).is_err());
    drop(uploaded);
    drop(sessions.take("main", &second).unwrap());
    assert!(sessions.take("main", &first).is_err());

    let incomplete = begin(1).unwrap();
    assert!(sessions.take("main", &incomplete).is_err());
    let reordered = begin(3).unwrap();
    assert!(sessions.append("main", &reordered, 1, "YWJj").is_err());
    assert!(sessions.take("main", &reordered).is_err());
    let malformed = begin(3).unwrap();
    assert!(sessions.append("main", &malformed, 0, "!!!!").is_err());
    let oversized = begin(1).unwrap();
    assert!(sessions.append("main", &oversized, 0, "YWJj").is_err());
    let chunk = begin(CHUNK_BYTES as u64 + 1).unwrap();
    assert!(sessions
        .append(
            "main",
            &chunk,
            0,
            &"A".repeat(CHUNK_BYTES.div_ceil(3) * 4 + 1)
        )
        .is_err());
    let expired = begin(0).unwrap();
    sessions
        .uploads
        .lock()
        .unwrap()
        .get_mut(&expired)
        .unwrap()
        .created = Instant::now() - SESSION_TTL;
    assert!(sessions.take("main", &expired).is_err());
    let closed = begin(0).unwrap();
    sessions.revoke("main");
    assert!(sessions.take("main", &closed).is_err());
    assert!(begin(0).is_err());
    let reopened = sessions
        .begin(
            "main",
            sessions.generation("main").unwrap(),
            Some("notes/memo.md".into()),
            "notebook".into(),
            "empty".into(),
            0,
        )
        .unwrap();
    sessions.cancel("main", &reopened).unwrap();
    assert!(sessions.take("main", &reopened).is_err());
}
