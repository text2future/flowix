use super::{
    lookup_key, Reference, MAX_BODY_BYTES, MAX_DESTINATION_BYTES, MAX_REFERENCES,
    MAX_UNIQUE_REFERENCES,
};
use crate::memo_file::NotebookConfig;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use std::{collections::BTreeMap, io, ops::Range, path::Path};

fn decode(value: &str) -> Option<String> {
    let text = percent_decode_str(value).decode_utf8().ok()?.into_owned();
    (!text.chars().any(|c| c.is_control())).then_some(text)
}

/// Lexical only: no stat, canonicalize, symlink traversal or per-link I/O.
fn normalize(value: &str) -> Option<String> {
    let value = value.replace('\\', "/");
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn markdown_path(value: &str) -> bool {
    Path::new(value)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

fn strip_fragment(value: &str) -> &str {
    value.split(['#', '?']).next().unwrap_or_default()
}

/// Compare Windows/UNC roots lexically even when indexing on another platform.
fn absolute_notebook_target(path: &str, book: &NotebookConfig) -> Option<String> {
    let path = path.replace('\\', "/");
    let root = book.path.replace('\\', "/");
    let root = root.trim_end_matches('/');
    let windows = path.as_bytes().get(1) == Some(&b':') || path.starts_with("//");
    let prefix = format!("{root}/");
    let inside = if windows {
        path.get(..prefix.len())?.eq_ignore_ascii_case(&prefix)
    } else {
        path.starts_with(&prefix)
    };
    inside.then_some(())?;
    normalize(path.get(prefix.len()..)?)
}

fn destination(
    source: &str,
    raw: &str,
    wiki: bool,
    book: &NotebookConfig,
) -> Option<(String, String)> {
    if raw.len() > MAX_DESTINATION_BYTES {
        return None;
    }
    let raw = raw.trim();
    let parent = source.rsplit_once('/').map(|p| p.0).unwrap_or_default();
    if raw.starts_with("flowix://") {
        let url = url::Url::parse(raw).ok()?;
        if url.host_str() != Some("open") {
            return None;
        }
        let params: BTreeMap<_, _> = url.query_pairs().collect();
        let id = params.get("notebookId");
        let name = params.get("b").or_else(|| params.get("book"));
        if id.is_some_and(|id| id.as_ref() != book.id)
            || name.is_some_and(|name| name.as_ref() != book.name)
        {
            return None; // First version is scoped to the current notebook.
        }
        if let Some(path) = params
            .get("f")
            .or_else(|| params.get("file"))
            .or_else(|| params.get("relativePath"))
        {
            let target = normalize(path)?;
            return markdown_path(&target).then_some(("path".into(), target));
        }
        if let Some(path) = params.get("path") {
            let relative = Path::new(path.as_ref())
                .strip_prefix(Path::new(&book.path))
                .ok()?
                .to_str()?;
            let target = normalize(relative)?;
            return markdown_path(&target).then_some(("path".into(), target));
        }
        return None;
    }
    if raw.starts_with("file:") {
        let url = url::Url::parse(raw).ok()?;
        let mut path = decode(url.path())?;
        if let Some(host) = url.host_str().filter(|host| *host != "localhost") {
            path = format!("//{host}{path}");
        } else if path.as_bytes().get(2) == Some(&b':') {
            path.remove(0);
        }
        let target = absolute_notebook_target(&path, book)?;
        return markdown_path(&target).then_some(("path".into(), target));
    }
    // Wiki destinations are note names, not URLs: ? is a literal filename
    // character on platforms that support it. Both syntaxes support anchors.
    let mut target = decode(if wiki {
        raw.split('#').next().unwrap_or_default()
    } else {
        strip_fragment(raw)
    })?.replace('\\', "/");
    if target.is_empty() {
        return raw
            .starts_with('#')
            .then_some(("path".into(), source.to_owned()));
    }
    // A bare Markdown destination first addresses a same-named note at notebook root.
    let root_note = !wiki && !target.contains('/') && !target.contains(':')
        && Path::new(&target).extension().is_none();
    if root_note { target.push_str(".md"); }
    if !wiki && !markdown_path(&target) {
        return None;
    }
    if wiki
        && Path::new(&target)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "png"
                        | "jpg"
                        | "jpeg"
                        | "gif"
                        | "webp"
                        | "svg"
                        | "pdf"
                        | "mp3"
                        | "mp4"
                        | "wav"
                        | "mov"
                        | "zip"
                )
            })
    {
        return None;
    }
    if target.starts_with('/') || target.as_bytes().get(1) == Some(&b':') {
        let path = absolute_notebook_target(&target, book)?;
        return Some(("path".into(), path));
    }
    if target.split('/').next().is_some_and(|part| part.contains(':')) {
        return None;
    }
    let target = if wiki && Path::new(&target).extension().is_none() {
        format!("{target}.md")
    } else { target };
    let path = if !root_note && !parent.is_empty() {
        format!("{parent}/{target}")
    } else {
        target
    };
    Some(("path".into(), normalize(&path)?))
}

fn frontmatter_end(body: &str) -> usize {
    let mut lines = body.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return 0;
    };
    if first.trim_end() != "---" {
        return 0;
    }
    let mut offset = first.len();
    for line in lines {
        offset += line.len();
        if matches!(line.trim_end(), "---" | "...") {
            return offset;
        }
    }
    0
}

pub(crate) fn extract(
    source: &str,
    body: &str,
    book: &NotebookConfig,
) -> io::Result<Vec<Reference>> {
    if body.len() > MAX_BODY_BYTES {
        return Err(io::Error::other(
            "document exceeds link-index size limit (4 MiB)",
        ));
    }
    let start = frontmatter_end(body);
    let body = &body[start..];
    let mut refs: BTreeMap<(String, String, String, String), u32> = BTreeMap::new();
    let mut count = 0;
    let mut add = |raw: &str, wiki: bool, embed: bool| -> io::Result<()> {
        if let Some((target_kind, target_key)) = destination(source, raw, wiki, book) {
            count += 1;
            if count > MAX_REFERENCES {
                return Err(io::Error::other(
                    "document exceeds link-index reference limit",
                ));
            }
            let key = (
                if wiki { "wiki" } else { "markdown" }.into(),
                if embed { "embed" } else { "link" }.into(),
                target_kind,
                target_key,
            );
            *refs.entry(key).or_default() += 1;
        }
        Ok(())
    };
    let mut blocked: Vec<Range<usize>> = Vec::new();
    let mut containers: Vec<usize> = Vec::new();
    for (event, span) in Parser::new(body).into_offset_iter() {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                add(&dest_url, false, false)?;
                containers.push(span.start);
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                add(&dest_url, false, true)?;
                containers.push(span.start);
            }
            Event::Start(Tag::CodeBlock(_)) | Event::Start(Tag::HtmlBlock) => {
                containers.push(span.start)
            }
            Event::End(TagEnd::Link | TagEnd::Image | TagEnd::CodeBlock | TagEnd::HtmlBlock) => {
                if let Some(begin) = containers.pop() {
                    blocked.push(begin..span.end);
                }
            }
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) => blocked.push(span),
            _ => {}
        }
    }
    blocked.sort_by_key(|s| s.start);
    let mut blocked_at = 0;
    let mut consumed = 0;
    let mut line_end = 0;
    for (at, _) in body.match_indices("[[") {
        if at < consumed {
            continue;
        }
        while blocked_at < blocked.len() && blocked[blocked_at].end <= at {
            blocked_at += 1;
        }
        if blocked.get(blocked_at).is_some_and(|r| r.start <= at) {
            continue;
        }
        let escaped = body[..at].bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1;
        if escaped {
            continue;
        }
        let remaining = &body[at + 2..];
        // Cache the absolute line boundary: valid links on the same long
        // line must not each rescan the entire remaining suffix.
        if at + 2 >= line_end {
            line_end = at + 2 + remaining.find(['\n', '\r']).unwrap_or(remaining.len());
        }
        let Some(end) = body[at + 2..line_end].find("]]") else {
            // Skip the remainder of this line once. Repeated unclosed [[ must
            // not repeatedly scan the same suffix (quadratic on large input).
            consumed = line_end;
            continue;
        };
        consumed = at + 2 + end + 2;
        let raw = remaining[..end].split('|').next().unwrap_or_default();
        add(raw, true, at > 0 && body.as_bytes()[at - 1] == b'!')?;
    }
    // Bound the replacement transaction as well as parsing work. Preserve the
    // last successful projection with an error rather than publish a partial set.
    if refs.len() > MAX_UNIQUE_REFERENCES {
        return Err(io::Error::other(
            "document exceeds link-index unique-target limit (4096)",
        ));
    }
    Ok(refs
        .into_iter()
        .map(|((syntax, kind, target_kind, target_key), count)| {
            let lookup_key = lookup_key(&target_kind, &target_key);
            Reference {
                syntax,
                kind,
                target_kind,
                target_key,
                lookup_key,
                count,
            }
        })
        .collect())
}
