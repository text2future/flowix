use super::{patch_edits, MergeOutcome};

/// Merge two text bodies in a stable order regardless of which device runs it.
fn merge_two_way_body(first: &str, second: &str) -> Option<String> {
    if first == second {
        return Some(first.to_owned());
    }
    let (remote, local) = if first <= second {
        (first, second)
    } else {
        (second, first)
    };
    let edits = patch_edits(remote, local)?;
    let lines: Vec<&str> = remote.split_inclusive('\n').collect();
    let mut output = String::new();
    let mut position = 0;
    for edit in edits {
        for line in &lines[position..edit.end] {
            output.push_str(line);
        }
        if !edit.replacement.is_empty() {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&edit.replacement);
            if edit.end < lines.len() && !output.ends_with('\n') {
                output.push('\n');
            }
        }
        position = edit.end;
    }
    for line in &lines[position..] {
        output.push_str(line);
    }
    Some(output)
}

fn split_frontmatter(input: &str) -> (Option<&str>, &str) {
    match crate::memo_file::frontmatter::FRONTMATTER_RE.captures(input) {
        Some(captures) => {
            let body = captures.get(2).expect("frontmatter body");
            (Some(&input[..body.start()]), body.as_str())
        }
        None => (None, input),
    }
}

/// Merge metadata as a mapping. Tags are unioned; other conflicting values
/// have a stable winner so concurrent devices produce the same document.
fn merge_frontmatter(first: Option<&str>, second: Option<&str>) -> Option<String> {
    match (first, second) {
        (None, None) => Some(String::new()),
        (Some(value), None) | (None, Some(value)) => Some(value.to_string()),
        (Some(a), Some(b)) if a == b => Some(a.to_string()),
        (Some(a), Some(b)) => {
            // Start from a stable side and parse the raw YAML rather than the
            // indexer's normalized metadata, which may discard tag values.
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            let mut left = parse_mapping(a)?;
            let right = parse_mapping(b)?;
            for (key, value) in right {
                match left.get_mut(&key) {
                    None => {
                        left.insert(key, value);
                    }
                    Some(serde_yaml::Value::Sequence(tags))
                        if key.as_str() == Some("tags") && value.is_sequence() =>
                    {
                        for tag in value.as_sequence()? {
                            if !tags.contains(tag) {
                                tags.push(tag.clone());
                            }
                        }
                        tags.sort_by_key(|tag| serde_yaml::to_string(tag).unwrap_or_default());
                    }
                    Some(existing)
                        if serde_yaml::to_string(&value).ok()?
                            < serde_yaml::to_string(&*existing).ok()? =>
                    {
                        *existing = value
                    }
                    Some(_) => {}
                }
            }
            let yaml = serde_yaml::to_string(&serde_yaml::Value::Mapping(left)).ok()?;
            Some(format!("---\n{}---\n", yaml))
        }
    }
}

fn parse_mapping(header: &str) -> Option<serde_yaml::Mapping> {
    let captures = crate::memo_file::frontmatter::FRONTMATTER_RE.captures(header)?;
    let source = captures.get(1)?.as_str().trim();
    if source.is_empty() {
        return Some(serde_yaml::Mapping::new());
    }
    match serde_yaml::from_str(source).ok()? {
        serde_yaml::Value::Mapping(mapping) => Some(mapping),
        _ => None,
    }
}

/// Retain both versions' differing body lines without a historical baseline.
pub fn merge_markdown_two_way(local: &[u8], remote: &[u8]) -> MergeOutcome {
    let (Ok(local), Ok(remote)) = (std::str::from_utf8(local), std::str::from_utf8(remote)) else {
        return MergeOutcome::Unsupported;
    };
    if local == remote {
        return MergeOutcome::Merged(local.as_bytes().to_vec());
    }
    let (local_header, local_body) = split_frontmatter(local);
    let (remote_header, remote_body) = split_frontmatter(remote);
    let Some(header) = merge_frontmatter(local_header, remote_header) else {
        return MergeOutcome::Unsupported;
    };
    let Some(body) = merge_two_way_body(local_body, remote_body) else {
        return MergeOutcome::Unsupported;
    };
    let mut output = header;
    if !output.is_empty() && !body.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(&body);
    if crate::memo_file::frontmatter::extract_document_metadata_tolerant(&output).is_err() {
        return MergeOutcome::Unsupported;
    }
    MergeOutcome::Merged(output.into_bytes())
}
