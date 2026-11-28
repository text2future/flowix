//! Markdown merging for editor saves and cloud synchronization.
//! Conflicts are never written as markers in the original file.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    Merged(Vec<u8>),
    Conflict,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LineEdit {
    start: usize,
    end: usize,
    replacement: String,
}

fn patch_edits(base: &str, modified: &str) -> Option<Vec<LineEdit>> {
    let patch = diffy::create_patch(base, modified);
    if diffy::apply(base, &patch).ok().as_deref() != Some(modified) {
        return None;
    }
    let base_lines: Vec<&str> = base.split_inclusive('\n').collect();
    let mut edits = Vec::new();
    for hunk in patch.hunks() {
        let range = hunk.old_range();
        let mut position = if range.len() == 0 {
            range.start()
        } else {
            range.start().checked_sub(1)?
        };
        let mut pending: Option<LineEdit> = None;
        for line in hunk.lines() {
            match line {
                diffy::Line::Context(value) => {
                    if base_lines.get(position).copied() != Some(*value) {
                        return None;
                    }
                    if let Some(edit) = pending.take() {
                        edits.push(edit);
                    }
                    position += 1;
                }
                diffy::Line::Delete(value) => {
                    if base_lines.get(position).copied() != Some(*value) {
                        return None;
                    }
                    let edit = pending.get_or_insert_with(|| LineEdit {
                        start: position,
                        end: position,
                        replacement: String::new(),
                    });
                    edit.end += 1;
                    position += 1;
                }
                diffy::Line::Insert(value) => {
                    pending
                        .get_or_insert_with(|| LineEdit {
                            start: position,
                            end: position,
                            replacement: String::new(),
                        })
                        .replacement
                        .push_str(value);
                }
            }
        }
        if let Some(edit) = pending {
            edits.push(edit);
        }
    }
    if apply_line_edits(base, &edits).as_deref() == Some(modified) {
        Some(edits)
    } else {
        None
    }
}

fn edits_overlap(a: &LineEdit, b: &LineEdit) -> bool {
    if a.start == a.end {
        return b.start <= a.start && a.start <= b.end;
    }
    if b.start == b.end {
        return a.start <= b.start && b.start <= a.end;
    }
    a.start < b.end && b.start < a.end
}

fn apply_line_edits(base: &str, edits: &[LineEdit]) -> Option<String> {
    let base_lines: Vec<&str> = base.split_inclusive('\n').collect();
    let mut output = String::new();
    let mut position = 0;
    for edit in edits {
        if edit.start < position || edit.end > base_lines.len() {
            return None;
        }
        for line in &base_lines[position..edit.start] {
            output.push_str(line);
        }
        output.push_str(&edit.replacement);
        position = edit.end;
    }
    for line in &base_lines[position..] {
        output.push_str(line);
    }
    Some(output)
}

fn merge_disjoint_lines(base: &str, local: &str, remote: &str) -> Option<String> {
    let mut local_edits = patch_edits(base, local)?;
    let remote_edits = patch_edits(base, remote)?;
    for remote_edit in remote_edits {
        if local_edits
            .iter()
            .any(|local_edit| *local_edit == remote_edit)
        {
            continue;
        }
        if local_edits
            .iter()
            .any(|local_edit| edits_overlap(local_edit, &remote_edit))
        {
            return None;
        }
        local_edits.push(remote_edit);
    }
    local_edits.sort_by_key(|edit| (edit.start, edit.end));
    apply_line_edits(base, &local_edits)
}

pub fn merge_markdown(base: &[u8], local: &[u8], remote: &[u8]) -> MergeOutcome {
    let (Ok(base), Ok(local), Ok(remote)) = (
        std::str::from_utf8(base),
        std::str::from_utf8(local),
        std::str::from_utf8(remote),
    ) else {
        return MergeOutcome::Unsupported;
    };
    if local == remote {
        return MergeOutcome::Merged(local.as_bytes().to_vec());
    }
    match diffy::merge(base, local, remote) {
        Ok(merged) => MergeOutcome::Merged(merged.into_bytes()),
        Err(_) => merge_disjoint_lines(base, local, remote)
            .map(|merged| MergeOutcome::Merged(merged.into_bytes()))
            .unwrap_or(MergeOutcome::Conflict),
    }
}

mod two_way;
pub use two_way::merge_markdown_two_way;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combines_independent_edits() {
        let base = b"first\nsecond\nthird\n";
        let local = b"FIRST\nsecond\nthird\n";
        let remote = b"first\nsecond\nTHIRD\n";
        assert_eq!(
            merge_markdown(base, local, remote),
            MergeOutcome::Merged(b"FIRST\nsecond\nTHIRD\n".to_vec())
        );
    }

    #[test]
    fn merges_the_two_offline_device_fixture_used_by_cloud_http_e2e() {
        let base = b"# Notes\nleft: old\nright: old\n";
        let device_b = b"# Notes\nleft: old\nright: B\n";
        let device_a = b"# Notes\nleft: A\nright: old\n";
        assert_eq!(
            merge_markdown(base, device_b, device_a),
            MergeOutcome::Merged(b"# Notes\nleft: A\nright: B\n".to_vec())
        );
    }

    #[test]
    fn preserves_both_sides_on_overlap() {
        assert_eq!(
            merge_markdown(b"same\n", b"local\n", b"remote\n"),
            MergeOutcome::Conflict
        );
    }

    #[test]
    fn does_not_auto_merge_two_insertions_at_the_same_position() {
        let base = b"start\nend\n";
        let local = b"start\nfrom local\nend\n";
        let remote = b"start\nfrom remote\nend\n";
        assert_eq!(merge_markdown(base, local, remote), MergeOutcome::Conflict);
    }

    #[test]
    fn merges_disjoint_edits_without_a_final_newline() {
        let base = b"first\nsecond\nthird";
        let local = b"FIRST\nsecond\nthird";
        let remote = b"first\nsecond\nTHIRD";
        assert_eq!(
            merge_markdown(base, local, remote),
            MergeOutcome::Merged(b"FIRST\nsecond\nTHIRD".to_vec())
        );
    }

    #[test]
    fn two_way_keeps_both_differences_and_common_lines_once() {
        let local = b"one\nlocal\nthree\nfour\nLOCAL\n";
        let remote = b"one\nremote\nthree\nfour\nfive\n";
        assert_eq!(
            merge_markdown_two_way(local, remote),
            MergeOutcome::Merged(b"one\nlocal\nremote\nthree\nfour\nLOCAL\nfive\n".to_vec())
        );
    }

    #[test]
    fn two_way_preserves_insertions_and_rejects_non_utf8() {
        assert_eq!(
            merge_markdown_two_way(b"a\nlocal\nb\n", b"a\nremote\nb\n"),
            MergeOutcome::Merged(b"a\nlocal\nremote\nb\n".to_vec())
        );
        assert_eq!(
            merge_markdown_two_way(b"\xff", b"a"),
            MergeOutcome::Unsupported
        );
    }

    #[test]
    fn two_way_handles_empty_files_and_missing_final_newlines() {
        assert_eq!(
            merge_markdown_two_way(b"", b"cloud"),
            MergeOutcome::Merged(b"cloud".to_vec())
        );
        assert_eq!(
            merge_markdown_two_way(b"local", b""),
            MergeOutcome::Merged(b"local".to_vec())
        );
        assert_eq!(
            merge_markdown_two_way(b"same", b"same"),
            MergeOutcome::Merged(b"same".to_vec())
        );
        assert_eq!(
            merge_markdown_two_way(b"local", b"cloud"),
            MergeOutcome::Merged(b"cloud\nlocal".to_vec())
        );
    }

    #[test]
    fn two_way_does_not_duplicate_a_version_already_merged() {
        let local = b"head\nlocal\nend\n";
        let cloud = b"head\ncloud\nend\n";
        let MergeOutcome::Merged(merged) = merge_markdown_two_way(local, cloud) else {
            panic!("merge failed")
        };
        assert_eq!(
            merge_markdown_two_way(local, &merged),
            MergeOutcome::Merged(merged)
        );
    }

    #[test]
    fn opposite_device_order_produces_identical_merge() {
        let a = b"head\na\ntail\n";
        let b = b"head\nb\ntail\n";
        let merged = merge_markdown_two_way(a, b);
        assert_eq!(merged, merge_markdown_two_way(b, a));
        let MergeOutcome::Merged(bytes) = merged else {
            panic!("merge failed")
        };
        assert_eq!(
            merge_markdown_two_way(a, &bytes),
            MergeOutcome::Merged(bytes.clone())
        );
        assert_eq!(
            merge_markdown_two_way(b, &bytes),
            MergeOutcome::Merged(bytes)
        );
    }

    #[test]
    fn two_way_repeated_lines_converge_in_both_directions() {
        let mut texts = vec![String::new()];
        for len in 1..=4 {
            for bits in 0..(1 << len) {
                let mut value = String::new();
                for bit in 0..len {
                    value.push_str(if bits & (1 << bit) == 0 { "a\n" } else { "b\n" });
                }
                texts.push(value);
            }
        }
        for a in &texts {
            for b in &texts {
                let MergeOutcome::Merged(merged) =
                    merge_markdown_two_way(a.as_bytes(), b.as_bytes())
                else {
                    panic!("merge failed")
                };
                assert_eq!(
                    merge_markdown_two_way(b.as_bytes(), a.as_bytes()),
                    MergeOutcome::Merged(merged.clone())
                );
                assert_eq!(
                    merge_markdown_two_way(a.as_bytes(), &merged),
                    MergeOutcome::Merged(merged.clone())
                );
                assert_eq!(
                    merge_markdown_two_way(b.as_bytes(), &merged),
                    MergeOutcome::Merged(merged)
                );
            }
        }
    }

    #[test]
    fn frontmatter_tags_are_combined_without_duplicate_yaml_keys() {
        let a = b"---\ntags: [local]\nstatus: working\n---\nlocal body\n";
        let b = b"---\ntags: [cloud]\nstatus: done\n---\ncloud body\n";
        let merged = merge_markdown_two_way(a, b);
        assert_eq!(merged, merge_markdown_two_way(b, a));
        let MergeOutcome::Merged(bytes) = merged else {
            panic!("merge failed")
        };
        let text = std::str::from_utf8(&bytes).unwrap();
        let metadata = crate::memo_file::extract_document_metadata(text).unwrap();
        assert_eq!(metadata.tags, vec!["cloud", "local"]);
        assert_eq!(text.matches("status:").count(), 1);
        assert!(text.contains("local body") && text.contains("cloud body"));
    }

    #[test]
    fn two_way_preserves_raw_yaml_tag_values() {
        let a = b"---\ntags: [local, 42]\n---\nbody\n";
        let b = b"---\ntags: [remote, 7]\n---\nbody\n";
        let merged = merge_markdown_two_way(a, b);
        assert_eq!(merged, merge_markdown_two_way(b, a));
        let MergeOutcome::Merged(bytes) = merged else {
            panic!("merge failed")
        };
        let text = std::str::from_utf8(&bytes).unwrap();
        let yaml = crate::memo_file::frontmatter::FRONTMATTER_RE
            .captures(text)
            .unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml[1]).unwrap();
        let tags = value["tags"].as_sequence().unwrap();
        assert!(tags.contains(&serde_yaml::Value::from(42)));
        assert!(tags.contains(&serde_yaml::Value::from(7)));
    }
}
