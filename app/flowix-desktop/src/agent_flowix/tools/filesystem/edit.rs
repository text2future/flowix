use serde::Deserialize;
use std::path::Path;

use super::constants::{
    MAX_EDIT_FUZZY_DISTANCE, MAX_EDIT_MATCH_CANDIDATE_CHARS, MAX_EDIT_MATCH_SCAN_LINES,
};
use super::frontmatter::frontmatter_key_value;
use super::path::{ensure_allowed, ensure_visible, resolve_path};
use crate::agent_flowix::tools::{ToolResult, ToolScope};

fn line_start_offsets(content: &str) -> Vec<usize> {
    let mut offsets = vec![0usize];
    for (index, ch) in content.char_indices() {
        if ch == '\n' {
            offsets.push(index + ch.len_utf8());
        }
    }
    offsets
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn levenshtein_chars(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for (i, a_ch) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, b_ch) in b.iter().enumerate() {
            let cost = usize::from(a_ch != b_ch);
            current[j + 1] = (current[j] + 1)
                .min(previous[j + 1] + 1)
                .min(previous[j] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

fn common_edit_mismatch_hint(needle: &str, candidate: &str) -> Option<&'static str> {
    if needle.replace("\r\n", "\n") == candidate.replace("\r\n", "\n") {
        return Some("line endings differ");
    }
    if needle.split_whitespace().collect::<String>()
        == candidate.split_whitespace().collect::<String>()
    {
        return Some("whitespace differs");
    }
    let normalize_quotes = |value: &str| {
        value
            .chars()
            .map(|ch| match ch {
                '\u{201c}' | '\u{201d}' => '"',
                '\u{2018}' | '\u{2019}' => '\'',
                _ => ch,
            })
            .collect::<String>()
    };
    if normalize_quotes(needle) == normalize_quotes(candidate) {
        return Some("quote style differs");
    }
    None
}

fn is_boundary_punctuation(ch: char) -> bool {
    ch.is_ascii_punctuation()
        || matches!(
            ch,
            '\u{3002}'
                | '\u{ff1f}'
                | '\u{ff01}'
                | '\u{ff0c}'
                | '\u{ff1b}'
                | '\u{ff1a}'
                | '\u{3001}'
                | '\u{300a}'
                | '\u{300b}'
                | '\u{3008}'
                | '\u{3009}'
                | '\u{201c}'
                | '\u{201d}'
                | '\u{2018}'
                | '\u{2019}'
        )
}

fn neighboring_chars(content: &str, start: usize, end: usize) -> (Option<char>, Option<char>) {
    let before = content[..start].chars().next_back();
    let after = content[end..].chars().next();
    (before, after)
}

pub(super) fn exact_match_boundary_error(
    content: &str,
    matched: &str,
    start: usize,
) -> Option<ToolResult> {
    let end = start + matched.len();
    let (before, after) = neighboring_chars(content, start, end);
    let missing_leading = before
        .filter(|ch| is_boundary_punctuation(*ch))
        .filter(|_| {
            !matched
                .chars()
                .next()
                .map(is_boundary_punctuation)
                .unwrap_or(false)
        });
    let missing_trailing = after.filter(|ch| is_boundary_punctuation(*ch)).filter(|_| {
        !matched
            .chars()
            .next_back()
            .map(is_boundary_punctuation)
            .unwrap_or(false)
    });

    if let Some(ch) = missing_trailing {
        return Some(ToolResult::error(format!(
            "old_string matched a substring that is immediately followed by punctuation {:?}; refusing to edit because the old_string likely omitted trailing punctuation. match_type=fuzzy_trailing. Possible cause: trailing punctuation differs. Matched text: {:?}",
            ch, matched
        )));
    }
    if let Some(ch) = missing_leading {
        return Some(ToolResult::error(format!(
            "old_string matched a substring that is immediately preceded by punctuation {:?}; refusing to edit because the old_string likely omitted leading punctuation. match_type=fuzzy_leading. Possible cause: leading punctuation differs. Matched text: {:?}",
            ch, matched
        )));
    }
    None
}

fn best_edit_match_for_line(
    needle: &str,
    line: &str,
    line_number: usize,
    line_byte_offset: usize,
) -> EditMatchCandidates {
    let needle_len = needle.chars().count();
    if needle_len == 0 {
        return EditMatchCandidates::default();
    }

    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let window_len = needle_len
        .min(MAX_EDIT_MATCH_CANDIDATE_CHARS)
        .min(chars.len());
    if window_len == 0 {
        return EditMatchCandidates::default();
    }
    let needle_sample = truncate_chars(needle, MAX_EDIT_MATCH_CANDIDATE_CHARS);
    let step = if chars.len() <= 1_000 {
        1
    } else {
        (window_len / 4).max(1)
    };
    let mut candidates = EditMatchCandidates::default();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + window_len).min(chars.len());
        let byte_start = chars[start].0;
        let byte_end = if end < chars.len() {
            chars[end].0
        } else {
            line.len()
        };
        let text = line[byte_start..byte_end].to_string();
        let distance = levenshtein_chars(&needle_sample, &text);
        candidates.push(EditMatchCandidate {
            line: line_number,
            byte_offset: line_byte_offset + byte_start,
            byte_len: byte_end - byte_start,
            text,
            distance,
        });
        if end == chars.len() {
            break;
        }
        start += step;
    }
    candidates
}

fn find_closest_edit_matches(content: &str, needle: &str) -> EditMatchCandidates {
    let line_offsets = line_start_offsets(content);
    let needle_line_count = needle.lines().count().max(1);
    let lines: Vec<&str> = content.lines().take(MAX_EDIT_MATCH_SCAN_LINES).collect();
    let needle_sample = truncate_chars(needle, MAX_EDIT_MATCH_CANDIDATE_CHARS);
    let mut candidates = EditMatchCandidates::default();

    if needle_line_count > 1 {
        for index in 0..lines.len() {
            let end = (index + needle_line_count).min(lines.len());
            let byte_offset = *line_offsets.get(index).unwrap_or(&0);
            let byte_end = if end < line_offsets.len() {
                line_offsets[end]
            } else {
                content.len()
            };
            let candidate_text = &content[byte_offset..byte_end];
            let text = truncate_chars(candidate_text, MAX_EDIT_MATCH_CANDIDATE_CHARS);
            let distance = levenshtein_chars(&needle_sample, &text);
            let candidate = EditMatchCandidate {
                line: index + 1,
                byte_offset,
                byte_len: byte_end - byte_offset,
                text,
                distance,
            };
            candidates.push(candidate);
        }
        return candidates;
    }

    for (index, line) in lines.iter().enumerate() {
        let line_candidates = best_edit_match_for_line(
            needle,
            line,
            index + 1,
            *line_offsets.get(index).unwrap_or(&0),
        );
        candidates.extend(line_candidates);
    }
    candidates
}

fn edit_not_found_error(content: &str, needle: &str) -> String {
    let candidates = find_closest_edit_matches(content, needle);
    let Some(candidate) = candidates.best.as_ref() else {
        return "old_string was not found exactly. Whitespace, indentation, and line endings must match".to_string();
    };
    let hint = common_edit_mismatch_hint(needle, &candidate.text)
        .map(|hint| format!(" Possible cause: {hint}."))
        .unwrap_or_default();
    format!(
        "old_string was not found exactly. Closest match starts at line {}, byte {} and differs by about {} characters.{} Closest text: {:?}",
        candidate.line,
        candidate.byte_offset,
        candidate.distance,
        hint,
        candidate.text
    )
}

fn fuzzy_distance_threshold(needle: &str) -> usize {
    (needle.chars().count() / 10)
        .max(2)
        .min(MAX_EDIT_FUZZY_DISTANCE)
}

fn fuzzy_confidence(candidate: &EditMatchCandidate, needle: &str) -> f64 {
    let len = needle
        .chars()
        .count()
        .max(candidate.text.chars().count())
        .max(1);
    1.0 - (candidate.distance as f64 / len as f64)
}

fn fuzzy_candidate_is_confident(
    candidate: &EditMatchCandidate,
    second_best_distance: Option<usize>,
    needle: &str,
) -> bool {
    let threshold = fuzzy_distance_threshold(needle);
    if candidate.distance > threshold || fuzzy_confidence(candidate, needle) < 0.9 {
        return false;
    }
    second_best_distance
        .map(|distance| distance >= candidate.distance.saturating_add(3))
        .unwrap_or(true)
}

fn edit_match_result(
    path: &Path,
    updated: &str,
    args: &EditArgs,
    match_type: &str,
    line: Option<usize>,
    byte_offset: Option<usize>,
    matched_text: Option<&str>,
    distance: Option<usize>,
) -> serde_json::Value {
    serde_json::json!({
        "path": path.display().to_string(),
        "key": frontmatter_key_value(updated),
        "dry_run": args.dry_run(),
        "would_write": true,
        "wrote": !args.dry_run(),
        "match_type": match_type,
        "line": line,
        "byte_offset": byte_offset,
        "matched_text": matched_text,
        "distance": distance,
        "old_bytes": args.old_string.len(),
        "new_bytes": args.new_string.len(),
        "bytes_written": if args.dry_run() { 0 } else { updated.len() },
    })
}

struct EditMatchCandidate {
    line: usize,
    byte_offset: usize,
    byte_len: usize,
    text: String,
    distance: usize,
}

#[derive(Default)]
struct EditMatchCandidates {
    best: Option<EditMatchCandidate>,
    second_best: Option<EditMatchCandidate>,
}

impl EditMatchCandidates {
    fn push(&mut self, candidate: EditMatchCandidate) {
        if self
            .best
            .as_ref()
            .map(|best| candidate.distance < best.distance)
            .unwrap_or(true)
        {
            self.second_best = self.best.take();
            self.best = Some(candidate);
            return;
        }
        if self
            .second_best
            .as_ref()
            .map(|second| candidate.distance < second.distance)
            .unwrap_or(true)
        {
            self.second_best = Some(candidate);
        }
    }

    fn extend(&mut self, other: EditMatchCandidates) {
        if let Some(candidate) = other.best {
            self.push(candidate);
        }
        if let Some(candidate) = other.second_best {
            self.push(candidate);
        }
    }
}

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
    dry_run: Option<bool>,
    fuzzy: Option<bool>,
    apply_fuzzy: Option<bool>,
}

impl EditArgs {
    fn dry_run(&self) -> bool {
        self.dry_run.unwrap_or(false)
    }

    fn fuzzy(&self) -> bool {
        self.fuzzy.unwrap_or(false)
    }

    fn apply_fuzzy(&self) -> bool {
        self.apply_fuzzy.unwrap_or(false)
    }
}

pub(super) async fn edit(
    arguments: &str,
    read_snapshot: Option<&str>,
    scope: &ToolScope,
) -> ToolResult {
    let args = match serde_json::from_str::<EditArgs>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    if args.old_string.is_empty() {
        return ToolResult::error("old_string cannot be empty");
    }

    let snapshot = match read_snapshot {
        Some(snapshot) => snapshot,
        None => {
            return ToolResult::error(
                "File must be read in the current conversation before using edit",
            )
        }
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    scope.start_accessing_for_path(&path);
    let current = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) => return ToolResult::error(format!("Failed to read {}: {}", path.display(), e)),
    };

    if current != snapshot {
        return ToolResult::error(format!(
            "File changed on disk since it was last read in this conversation: {}",
            path.display()
        ));
    }

    let mut exact_matches = current.match_indices(&args.old_string);
    let first_exact = exact_matches.next();
    let second_exact = exact_matches.next();
    if second_exact.is_some() {
        return ToolResult::error(format!(
            "old_string matched {} times. Provide a longer old_string with more surrounding context",
            current.matches(&args.old_string).count()
        ));
    }

    if args.fuzzy() {
        if let Some((offset, matched)) = first_exact {
            if let Some(result) = exact_match_boundary_error(&current, matched, offset) {
                return result;
            }
            if !args.apply_fuzzy() || args.dry_run() {
                return ToolResult::success(serde_json::json!({
                    "path": path.display().to_string(),
                    "dry_run": args.dry_run(),
                    "would_write": args.apply_fuzzy(),
                    "wrote": false,
                    "match_type": "exact_candidate",
                    "line": None::<usize>,
                    "byte_offset": offset,
                    "matched_text": matched,
                    "replacement_text": args.new_string,
                    "distance": 0,
                    "second_best_distance": None::<usize>,
                    "confidence": 1.0,
                    "can_apply": true,
                    "error": serde_json::Value::Null,
                }));
            }
        }
    }

    let (updated, match_type, line, byte_offset, matched_text, distance) = if let Some((
        offset,
        matched,
    )) = first_exact
    {
        if let Some(result) = exact_match_boundary_error(&current, matched, offset) {
            return result;
        }
        (
            current.replacen(&args.old_string, &args.new_string, 1),
            "exact",
            None,
            Some(offset),
            Some(matched.to_string()),
            None,
        )
    } else {
        let candidates = find_closest_edit_matches(&current, &args.old_string);
        let Some(candidate) = candidates.best else {
            return ToolResult::error(edit_not_found_error(&current, &args.old_string));
        };
        let threshold = fuzzy_distance_threshold(&args.old_string);
        let second_best_distance = candidates
            .second_best
            .as_ref()
            .map(|candidate| candidate.distance);
        let confidence = fuzzy_confidence(&candidate, &args.old_string);
        let fuzzy_confident =
            fuzzy_candidate_is_confident(&candidate, second_best_distance, &args.old_string);

        if !args.fuzzy() {
            return ToolResult::error(edit_not_found_error(&current, &args.old_string));
        }

        if !args.apply_fuzzy() || args.dry_run() {
            return ToolResult::success(serde_json::json!({
                "path": path.display().to_string(),
                "dry_run": args.dry_run(),
                "would_write": args.apply_fuzzy() && fuzzy_confident,
                "wrote": false,
                "match_type": "fuzzy_candidate",
                "line": candidate.line,
                "byte_offset": candidate.byte_offset,
                "matched_text": candidate.text,
                "replacement_text": args.new_string,
                "distance": candidate.distance,
                "second_best_distance": second_best_distance,
                "confidence": confidence,
                "max_allowed_distance": threshold,
                "can_apply": fuzzy_confident,
                "error": if fuzzy_confident {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String("No exact match. Closest fuzzy candidate is below the confidence threshold.".to_string())
                },
            }));
        }

        if !fuzzy_confident {
            return ToolResult::error(format!(
                "No exact match. Closest fuzzy candidate is below the confidence threshold: distance={}, second_best_distance={:?}, confidence={:.3}, max_allowed_distance={}",
                candidate.distance,
                second_best_distance,
                confidence,
                threshold
            ));
        }

        let start = candidate.byte_offset;
        let end = candidate.byte_offset + candidate.byte_len;
        if start > current.len()
            || end > current.len()
            || !current.is_char_boundary(start)
            || !current.is_char_boundary(end)
        {
            return ToolResult::error("Fuzzy edit candidate did not align to UTF-8 boundaries");
        }
        let mut updated = current.clone();
        updated.replace_range(start..end, &args.new_string);
        (
            updated,
            "fuzzy_close",
            Some(candidate.line),
            Some(candidate.byte_offset),
            Some(candidate.text),
            Some(candidate.distance),
        )
    };

    if args.dry_run() {
        return ToolResult::success(edit_match_result(
            &path,
            &updated,
            &args,
            match_type,
            line,
            byte_offset,
            matched_text.as_deref(),
            distance,
        ));
    }

    match tokio::fs::write(&path, updated.as_bytes()).await {
        Ok(()) => ToolResult::success(edit_match_result(
            &path,
            &updated,
            &args,
            match_type,
            line,
            byte_offset,
            matched_text.as_deref(),
            distance,
        )),
        Err(e) => ToolResult::error(format!("Failed to write {}: {}", path.display(), e)),
    }
}
