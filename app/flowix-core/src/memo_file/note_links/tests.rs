use super::*;
use crate::memo_file::{MemoFile, NotebookConfig};
use std::{cell::Cell, fs};

fn fixture() -> (tempfile::TempDir, MemoFile, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notes");
    fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(temp.path().join("config"));
    memo.initialize_current_registry_storage().unwrap();
    memo.write_notebook_configs(&[NotebookConfig {
        id: "links".into(),
        name: "Vault".into(),
        icon: None,
        path: root.to_string_lossy().into(),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }])
    .unwrap();
    memo.initialize_note_index_schema("links").unwrap();
    (temp, memo, root)
}
fn put(memo: &MemoFile, root: &std::path::Path, path: &str, body: &str) {
    let file = root.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, body).unwrap();
    memo.refresh_note_path_with_content("links", path, body)
        .unwrap();
}
fn drain(memo: &MemoFile) {
    for _ in 0..100 {
        let batch = memo
            .process_note_links_batch("links", 32, &|| true)
            .unwrap();
        assert_eq!(batch.failed, 0, "{batch:?}");
        if !batch.pending {
            return;
        }
    }
    panic!("queue did not settle");
}
fn extract(body: &str) -> Vec<Reference> {
    let (_temp, memo, _root) = fixture();
    parser::extract(
        "目录/来源.md",
        body,
        &memo.get_notebook_config_by_id("links").unwrap(),
    )
    .unwrap()
}
#[test]
fn parser_handles_markdown_wiki_references_embeds_and_code_boundaries() {
    let links=extract("---\nexample: '[[frontmatter]]'\n---\n[来源](../目标%20文档.md#段落) [来源2][ref]\n\n[ref]: ../目标%20文档.md\n\n[[目标文档|别名]] ![[目标文档#标题]]\n`[[inline]]`\n```md\n[[fenced]]\n[x](fake.md)\n```\n\\[[escaped]]\n<!-- [[comment]] -->\n![[photo.png]] [web](https://example.com)\n");
    assert_eq!(links.len(), 3, "{links:?}");
    assert!(links
        .iter()
        .any(|r| r.target_key == "目标 文档.md" && r.count == 2));
    assert!(links
        .iter()
        .any(|r| r.target_key == "目标文档" && r.kind == "embed"));
}
#[test]
fn parser_supports_flowix_links_and_ignores_other_vaults() {
    let links=extract("[a](flowix://open?b=Vault&f=folder%2Fa.md) [b](flowix://open?b=Other&f=b.md) [[../相对]] [[#当前标题]]");
    assert_eq!(links.len(), 3, "{links:?}");
    assert!(links.iter().any(|r| r.target_key == "folder/a.md"));
    assert!(links.iter().any(|r| r.target_key == "相对"));
    assert!(links.iter().any(|r| r.target_key == "目录/来源.md"));
}
#[test]
fn save_only_marks_dirty_and_worker_coalesces_latest_content() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[old]]");
    put(&memo, &root, "a.md", "[[new]] [[new]]");
    let conn = memo.open_note_index_connection("links").unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM note_links", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(memo.note_link_status("links").unwrap().pending, 1);
    drain(&memo);
    let links = memo
        .query_note_outlinks("links", "a.md", None, 50)
        .unwrap()
        .links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_key, "new");
    assert_eq!(links[0].reference_count, 2);
    assert!(links[0].fresh);
}
#[test]
fn targets_appear_disappear_and_backlinks_resolve_without_reindexing_sources() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "source.md", "[a](target.md) [[target]]");
    drain(&memo);
    memo.reconcile_note_index_blocking("links").unwrap();
    assert!(memo
        .query_note_outlinks("links", "source.md", None, 50)
        .unwrap()
        .links
        .iter()
        .all(|l| l.resolution == "missing"));
    put(&memo, &root, "target.md", "body");
    assert_eq!(
        memo.query_note_backlinks("links", "target.md", None, 50)
            .unwrap()
            .links
            .len(),
        2
    );
    memo.delete_note_by_path("links", "target.md").unwrap();
    let links = memo
        .query_note_outlinks("links", "source.md", None, 50)
        .unwrap()
        .links;
    assert_eq!(links.len(), 2);
    assert!(links.iter().all(|l| l.resolution == "missing" && l.fresh));
    memo.delete_note_by_path("links", "source.md").unwrap();
    let conn = memo.open_note_index_connection("links").unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM note_links", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(memo.note_link_status("links").unwrap().pending, 0);
}
#[test]
fn wiki_ambiguity_changes_without_source_body_io() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "source.md", "[[same]]");
    put(&memo, &root, "a/same.md", "");
    drain(&memo);
    fs::remove_file(root.join("source.md")).unwrap(); // Queries must use only DB state.
    assert_eq!(
        memo.query_note_outlinks("links", "source.md", None, 50)
            .unwrap()
            .links[0]
            .resolved_path
            .as_deref(),
        Some("a/same.md")
    );
    put(&memo, &root, "b/same.md", "");
    assert_eq!(
        memo.query_note_outlinks("links", "source.md", None, 50)
            .unwrap()
            .links[0]
            .resolution,
        "ambiguous"
    );
}
#[test]
fn source_directory_move_recomputes_relative_links_even_when_hash_is_unchanged() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a/source.md", "[target](target.md)");
    put(&memo, &root, "a/target.md", "a");
    put(&memo, &root, "b/target.md", "b");
    drain(&memo);
    memo.move_note_by_path("links", "a/source.md", "b").unwrap();
    drain(&memo);
    let links = memo
        .query_note_outlinks("links", "b/source.md", None, 50)
        .unwrap()
        .links;
    assert_eq!(links[0].resolved_path.as_deref(), Some("b/target.md"));
}
#[test]
fn indexed_folder_rebase_cascades_sources_and_dirties_relative_references() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a/source.md", "[[target]]");
    put(&memo, &root, "a/target.md", "a");
    drain(&memo);
    memo.rename_indexed_path(&root.join("a"), &root.join("b"))
        .unwrap();
    drain(&memo);
    let link = &memo
        .query_note_outlinks("links", "b/source.md", None, 50)
        .unwrap()
        .links[0];
    assert!(link.fresh);
    assert_eq!(link.resolved_path.as_deref(), Some("b/target.md"));
}
#[test]
fn pending_work_survives_a_new_facade_and_same_link_edits_do_not_rewrite_edges() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[target]]");
    let other = MemoFile::new(root.parent().unwrap().join("config"));
    drain(&other);
    let conn = memo.open_note_index_connection("links").unwrap();
    conn.execute_batch("CREATE TABLE edge_writes(value INTEGER); CREATE TRIGGER count_edge_writes AFTER INSERT ON note_links BEGIN INSERT INTO edge_writes VALUES(1); END;").unwrap();
    put(&memo, &root, "a.md", "new prose [[target]]");
    assert!(
        !memo
            .query_note_outlinks("links", "a.md", None, 50)
            .unwrap()
            .links[0]
            .fresh
    );
    drain(&other);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM edge_writes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn old_parser_result_cannot_overwrite_a_new_save() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[old]]");
    let calls = Cell::new(0);
    memo.process_note_links_batch("links", 1, &|| {
        calls.set(calls.get() + 1);
        if calls.get() == 2 {
            put(&memo, &root, "a.md", "[[new]]");
        }
        true
    })
    .unwrap();
    drain(&memo);
    assert_eq!(
        memo.query_note_outlinks("links", "a.md", None, 50)
            .unwrap()
            .links[0]
            .target_key,
        "new"
    );
}
#[test]
fn pagination_is_bounded_and_cursors_advance_without_duplicates() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[a]] [[b]] [[c]]");
    drain(&memo);
    let first = memo.query_note_outlinks("links", "a.md", None, 1).unwrap();
    assert!(first.has_more);
    let second = memo
        .query_note_outlinks("links", "a.md", first.next_cursor.as_deref(), 1)
        .unwrap();
    assert_ne!(first.links[0].target_key, second.links[0].target_key);
    let third = memo
        .query_note_outlinks("links", "a.md", second.next_cursor.as_deref(), 1)
        .unwrap();
    assert!(!third.has_more);
    assert!(memo
        .query_note_outlinks("links", "../a.md", None, 50)
        .is_err());
    assert!(memo
        .query_note_outlinks("links", "a.md", Some("bad"), 50)
        .is_err());
}
#[test]
fn migration_backfills_existing_notes_and_repairs_missing_relation_objects() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[target]]");
    drain(&memo);
    let conn = memo.open_note_index_connection("links").unwrap();
    conn.execute_batch("DROP TRIGGER note_links_insert; DROP TRIGGER note_links_move; DROP TRIGGER note_links_content; DROP TABLE note_links; DROP TABLE note_link_state;").unwrap();
    memo.initialize_note_index_schema("links").unwrap();
    assert_eq!(memo.note_link_status("links").unwrap().pending, 1);
    drain(&memo);
    assert_eq!(
        memo.query_note_outlinks("links", "a.md", None, 50)
            .unwrap()
            .links
            .len(),
        1
    );
}
#[test]
fn failed_parse_keeps_old_edges_and_new_edits_clear_retry_backoff() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[target]]");
    drain(&memo);
    put(&memo, &root, "a.md", &"x".repeat(MAX_BODY_BYTES + 1));
    let batch = memo.process_note_links_batch("links", 1, &|| true).unwrap();
    assert_eq!(batch.failed, 1);
    assert!(batch.retry_after_ms.unwrap() > 1000);
    assert!(
        !memo
            .query_note_outlinks("links", "a.md", None, 50)
            .unwrap()
            .links[0]
            .fresh
    );
    put(&memo, &root, "a.md", "[[fixed]]");
    drain(&memo);
    assert_eq!(memo.note_link_status("links").unwrap().failed, 0);
    assert_eq!(
        memo.query_note_outlinks("links", "a.md", None, 50)
            .unwrap()
            .links[0]
            .target_key,
        "fixed"
    );
}

#[test]
fn cached_saved_snapshot_avoids_reading_the_source_file_again() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "cached.md", "[[target]]");
    fs::remove_file(root.join("cached.md")).unwrap();
    drain(&memo);
    assert_eq!(
        memo.query_note_outlinks("links", "cached.md", None, 20)
            .unwrap()
            .links
            .len(),
        1
    );
}
#[test]
fn parser_handles_crlf_frontmatter_dotted_names_and_unclosed_wiki_input() {
    let links = extract("---\r\nexample: '[[not-a-link]]'\r\n---\r\n[[v1.2]] [[folder/v2.0]]\n");
    assert_eq!(links.len(), 2, "{links:?}");
    let links = extract(&format!("{}\n[[valid]]", "[[".repeat(100_000)));
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_key, "valid");
}
#[test]
fn newer_relation_schema_is_never_silently_downgraded() {
    let (_temp, memo, _root) = fixture();
    let conn = memo.open_note_index_connection("links").unwrap();
    conn.execute(
        "UPDATE note_index_meta SET value='999' WHERE key='links_schema_version'",
        [],
    )
    .unwrap();
    assert!(memo.initialize_note_index_schema("links").is_err());
    assert_eq!(
        conn.query_row(
            "SELECT value FROM note_index_meta WHERE key='links_schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "999"
    );
}
#[test]
fn batch_resolution_and_backlink_cursor_handle_ambiguous_candidates() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "one/a.md", "[[target]]");
    put(&memo, &root, "one/target.md", "body");
    put(&memo, &root, "two/a.md", "[[target]]");
    put(&memo, &root, "two/target.md", "body");
    put(&memo, &root, "a.md", "[[target]]");
    drain(&memo);
    let mut cursor = None;
    let mut sources = Vec::new();
    loop {
        let page = memo
            .query_note_backlinks("links", "one/target.md", cursor.as_deref(), 1)
            .unwrap();
        sources.extend(page.links.into_iter().map(|l| l.source_path));
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }
    assert_eq!(sources, vec!["one/a.md"]);
    let conn = memo.open_note_index_connection("links").unwrap();
    let mut stmt=conn.prepare("EXPLAIN QUERY PLAN SELECT source_path FROM note_links WHERE target_kind='wiki' AND lookup_key='target'").unwrap();
    let plan = stmt
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join(" ");
    assert!(plan.contains("idx_note_links_target"), "{plan}");
}

#[test]
#[ignore = "manual temporary-database performance measurement"]
fn report_relation_index_performance() {
    use std::time::Instant;
    let (_temp, memo, root) = fixture();
    let mut conn = memo.open_note_index_connection("links").unwrap();
    // Indexed-only corpus: database query scale, separately from filesystem cost.
    {
        let tx = conn.transaction().unwrap();
        for i in 0..10_000 {
            let path = format!("folder/n-{i}.md");
            let name = format!("n-{i}.md");
            tx.execute("INSERT INTO notes(relative_path,size_bytes,content_hash,title,preview,properties_json,indexed_at,filename,filename_lower)
                VALUES(?1,0,'seed',?1,'','{}',0,?2,?2)",rusqlite::params![path,name]).unwrap();
        }
        tx.execute(
            "UPDATE note_link_state SET dirty=0,indexed_content_hash='seed',parser_version=?1",
            [PARSER_VERSION],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let body = (0..100)
        .map(|i| format!("[[n-{i}]]"))
        .collect::<Vec<_>>()
        .join("\n");
    put(&memo, &root, "source.md", &body);
    let start = Instant::now();
    memo.process_note_links_batch("links", 1, &|| true).unwrap();
    println!(
        "link worker, 100 references: {:.3}ms",
        start.elapsed().as_secs_f64() * 1000.
    );
    for backlinks in [false, true] {
        let mut samples = Vec::new();
        for _ in 0..100 {
            let start = Instant::now();
            let page = if backlinks {
                memo.query_note_backlinks("links", "folder/n-0.md", None, 200)
                    .unwrap()
            } else {
                memo.query_note_outlinks("links", "source.md", None, 200)
                    .unwrap()
            };
            assert_eq!(page.links.len(), if backlinks { 1 } else { 100 });
            samples.push(start.elapsed().as_secs_f64() * 1000.);
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "10k indexed notes, {}: median {:.3}ms p95 {:.3}ms",
            if backlinks {
                "backlinks"
            } else {
                "100 outlinks"
            },
            samples[50],
            samples[95]
        );
    }
    // Isolate trigger cost with identical schema checks, FTS and snapshot cache.
    // No-op triggers exist only inside this disposable benchmark database.
    for enabled in [false, true] {
        conn.execute_batch("DROP TRIGGER note_links_content;")
            .unwrap();
        if enabled {
            conn.execute_batch("CREATE TRIGGER note_links_content AFTER UPDATE OF content_hash ON notes
                WHEN OLD.content_hash<>NEW.content_hash BEGIN UPDATE note_link_state SET dirty=1,
                request_id=lower(hex(randomblob(16))),last_error=NULL,retry_after=0 WHERE source_path=NEW.relative_path; END;").unwrap();
        } else {
            conn.execute_batch("CREATE TRIGGER note_links_content AFTER UPDATE OF content_hash ON notes BEGIN SELECT 1; END;").unwrap();
        }
        let mut samples = Vec::new();
        for i in 0..100 {
            let body = format!(
                "{}\nedit {enabled}-{i}",
                "sample text [[n-0]]\n".repeat(1000)
            );
            let start = Instant::now();
            memo.write_note_by_path("links", "source.md", &body, None)
                .unwrap();
            if i >= 10 {
                samples.push(start.elapsed().as_secs_f64() * 1000.);
            }
        }
        samples.sort_by(f64::total_cmp);
        println!("~20KiB save, dirty trigger {}: median {:.3}ms p95 {:.3}ms (snapshot cache included in both)",enabled,samples[45],samples[85]);
    }
    let stop = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        let worker = MemoFile::new(root.parent().unwrap().join("config"));
        let stop_ref = &stop;
        scope.spawn(move || {
            while !stop_ref.load(std::sync::atomic::Ordering::Acquire) {
                worker
                    .process_note_links_background_batch("links", 8, &|| {
                        !stop_ref.load(std::sync::atomic::Ordering::Acquire)
                    })
                    .unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        let mut samples = Vec::new();
        for i in 0..100 {
            let body = format!(
                "{}\nconcurrent edit {i}",
                "sample text [[n-0]]\n".repeat(1000)
            );
            let start = Instant::now();
            memo.write_note_by_path("links", "source.md", &body, None)
                .unwrap();
            if i >= 10 {
                samples.push(start.elapsed().as_secs_f64() * 1000.);
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Release);
        samples.sort_by(f64::total_cmp);
        println!(
            "~20KiB save with background extraction: median {:.3}ms p95 {:.3}ms",
            samples[45], samples[85]
        );
    });
}

#[test]
fn background_work_yields_to_active_save_and_post_save_quiet_window() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[target]]");
    {
        let _save = store::foreground_save(&root);
        let report = memo
            .process_note_links_background_batch("links", 8, &|| true)
            .unwrap();
        assert_eq!(report.processed, 0);
        assert!(report.pending);
        assert!(report.retry_after_ms.unwrap() > 0);
    }
    let report = memo
        .process_note_links_background_batch("links", 8, &|| true)
        .unwrap();
    assert_eq!(report.processed, 0);
    assert!(report.retry_after_ms.unwrap() > 0);
    // Explicit maintenance is still available without a wall-clock sleep.
    drain(&memo);
    assert_eq!(memo.note_link_status("links").unwrap().pending, 0);
}
#[test]
fn delete_and_recreate_same_path_and_hash_rejects_the_old_request() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[same]]");
    let calls = Cell::new(0);
    memo.process_note_links_batch("links", 1, &|| {
        calls.set(calls.get() + 1);
        if calls.get() == 2 {
            memo.delete_note_by_path("links", "a.md").unwrap();
            put(&memo, &root, "a.md", "[[same]]");
        }
        true
    })
    .unwrap();
    assert!(memo
        .query_note_outlinks("links", "a.md", None, 20)
        .unwrap()
        .links
        .is_empty());
    drain(&memo);
    assert_eq!(
        memo.query_note_outlinks("links", "a.md", None, 20)
            .unwrap()
            .links
            .len(),
        1
    );
}
#[test]
fn parser_upgrade_marks_only_relation_state_and_rebuilds_from_markdown() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "a.md", "[[target]]");
    drain(&memo);
    let conn = memo.open_note_index_connection("links").unwrap();
    conn.execute("UPDATE note_link_state SET parser_version=0", [])
        .unwrap();
    conn.execute(
        "UPDATE note_index_meta SET value='0' WHERE key='links_parser_version'",
        [],
    )
    .unwrap();
    memo.initialize_note_index_schema("links").unwrap();
    assert_eq!(memo.note_link_status("links").unwrap().pending, 1);
    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "[[target]]");
    drain(&memo);
    assert!(
        memo.query_note_outlinks("links", "a.md", None, 20)
            .unwrap()
            .links[0]
            .fresh
    );
}

#[test]
fn zero_outlinks_exposes_source_freshness_without_guessing_from_global_counts() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "empty.md", "plain prose");
    let before = memo
        .query_note_outlinks("links", "empty.md", None, 20)
        .unwrap();
    assert!(before.links.is_empty());
    assert_eq!(before.source_fresh, Some(false));
    drain(&memo);
    let after = memo
        .query_note_outlinks("links", "empty.md", None, 20)
        .unwrap();
    assert!(after.links.is_empty());
    assert_eq!(after.source_fresh, Some(true));
}

#[test]
fn long_single_line_wiki_links_and_line_boundaries() {
    let mut body = "[[a]] ".repeat(50_000);
    let links = extract(&body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].count, 50_000);
    body = "[[unclosed\n[[a]] [[b]]\r[[c]]\n[[d]]".into();
    let links = extract(&body);
    assert_eq!(links.len(), 4);
}

#[test]
fn backlinks_merge_all_four_target_ranges_without_losing_cursor_rows() {
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "target.md", "");
    // All four lookup ranges, plus multiple primary-key suffixes per source.
    for name in ["a", "b", "c"] {
        put(
            &memo,
            &root,
            &format!("{name}.md"),
            "[[target]] [[target.md]] [[/target]] [[/target.md]] ![[target]] [x](target.md)",
        );
    }
    drain(&memo);
    let all = memo
        .query_note_backlinks("links", "target.md", None, 200)
        .unwrap();
    assert_eq!(all.links.len(), 18);
    for limit in [1, 2, 5] {
        let mut cursor = None;
        let mut got = Vec::new();
        loop {
            let page = memo
                .query_note_backlinks("links", "target.md", cursor.as_deref(), limit)
                .unwrap();
            got.extend(page.links.into_iter().map(|l| {
                (
                    l.source_path,
                    l.syntax,
                    l.link_kind,
                    l.target_kind,
                    l.target_key,
                )
            }));
            if !page.has_more {
                break;
            }
            cursor = page.next_cursor;
        }
        let expected: Vec<_> = all
            .links
            .iter()
            .map(|l| {
                (
                    l.source_path.clone(),
                    l.syntax.clone(),
                    l.link_kind.clone(),
                    l.target_kind.clone(),
                    l.target_key.clone(),
                )
            })
            .collect();
        assert_eq!(got, expected);
    }
}

#[test]
#[ignore = "manual high-degree backlink performance measurement"]
fn report_high_degree_backlink_performance() {
    use std::time::Instant;
    let (_temp, memo, root) = fixture();
    put(&memo, &root, "target.md", "");
    let mut conn = memo.open_note_index_connection("links").unwrap();
    let old_sql = "SELECT l.source_path,l.syntax,l.link_kind,l.target_kind,l.target_key,l.reference_count,
        s.dirty=0 AND s.last_error IS NULL AND s.indexed_content_hash=n.content_hash AND s.parser_version=1
        FROM note_links l JOIN note_link_state s ON s.source_path=l.source_path JOIN notes n ON n.relative_path=l.source_path
        WHERE ((l.target_kind='path' AND l.lookup_key IN ('target.md','target')) OR
               (l.target_kind='wiki' AND l.lookup_key IN ('target.md','target')))
        ORDER BY l.source_path,l.syntax,l.link_kind,l.target_kind,l.target_key LIMIT 201";
    for plan in conn
        .prepare(&format!("EXPLAIN QUERY PLAN {old_sql}"))
        .unwrap()
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
    {
        println!("original plan: {}", plan.unwrap());
    }
    let mut inserted = 0;
    for count in [1_000, 10_000, 100_000] {
        let tx = conn.transaction().unwrap();
        for i in inserted..count {
            let path = format!("source-{i:06}.md");
            tx.execute("INSERT INTO notes(relative_path,size_bytes,content_hash,title,preview,properties_json,indexed_at,filename,filename_lower)
                VALUES(?1,0,'seed',?1,'','{}',0,?1,?1)", [&path]).unwrap();
            tx.execute(
                "INSERT INTO note_links VALUES(?1,'wiki','link','wiki','target','target',1)",
                [&path],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        inserted = count;
        let mut old = Vec::new();
        let mut new = Vec::new();
        for _ in 0..12 {
            let start = Instant::now();
            let rows: Vec<String> = conn
                .prepare(old_sql)
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            old.push(start.elapsed().as_secs_f64() * 1000.);
            let start = Instant::now();
            let page = memo
                .query_note_backlinks("links", "target.md", None, 200)
                .unwrap();
            new.push(start.elapsed().as_secs_f64() * 1000.);
            assert_eq!(page.links.len(), 200);
            assert_eq!(page.links[0].source_path, rows[0]);
        }
        old.sort_by(f64::total_cmp);
        new.sort_by(f64::total_cmp);
        println!(
            "{count} incoming edges: original SQL median {:.3}ms; new full API median {:.3}ms",
            old[6], new[6]
        );
    }
    let book = memo.get_notebook_config_by_id("links").unwrap();
    for count in [10_000, 50_000] {
        let body = "[[a]] ".repeat(count);
        let start = Instant::now();
        let links = parser::extract("source.md", &body, &book).unwrap();
        assert_eq!(links[0].count, count as u32);
        println!(
            "{count} same-line wiki links: {:.3}ms",
            start.elapsed().as_secs_f64() * 1000.
        );
    }
}
