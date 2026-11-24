//! `ListObjectsV2`: the query shape, one page of results, and the fixed-shape
//! XML reader for the response.
//!
//! The reader is deliberately not a general XML parser. It understands exactly
//! the elements the engine consumes and rejects anything it cannot prove is a
//! complete listing, because an incomplete page must never become evidence that
//! remote objects are absent.

use super::credentials::{CredentialResolver, ObjectStoreCredentials};
use super::signing::sign_get;
use super::transport::send_with_credential_renewal;
use crate::error::SyncError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedObject {
    pub key: String,
    pub last_modified: String,
    pub size: u64,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListPage {
    pub objects: Vec<ListedObject>,
    /// First-level child prefixes returned by a delimiter-based listing. S3
    /// uses these to enumerate notebook IDs without listing every file below
    /// `nb/`.
    pub common_prefixes: Vec<String>,
    pub next_cursor: Option<String>,
    /// The response `Date` header, epoch milliseconds.
    ///
    /// This is the only clock the design trusts for ordering (`§4.2`): device
    /// clocks drift, and `LastModified` is produced by the same server, so
    /// every "is this newer than what I last saw" comparison must be made in
    /// the server's frame. `None` only when a gateway omits the header.
    pub server_date_millis: Option<i64>,
}

/// The `ListObjectsV2` query for one page.
///
/// Split out of [`list_prefix`] so the shape is testable without a network —
/// a wrong `prefix` here silently reads another user's keys, and a missing
/// `delimiter` silently turns a directory listing into a whole-notebook one.
pub(crate) fn list_query(
    credentials: &ObjectStoreCredentials,
    prefix: &str,
    cursor: Option<&str>,
    delimiter: Option<&str>,
) -> Vec<(String, String)> {
    let mut query = vec![
        ("list-type".to_string(), "2".to_string()),
        ("prefix".to_string(), credentials.scoped_key(prefix)),
        ("max-keys".to_string(), "1000".to_string()),
    ];
    if let Some(cursor) = cursor {
        query.push(("continuation-token".to_string(), cursor.to_string()));
    }
    if let Some(delimiter) = delimiter {
        query.push(("delimiter".to_string(), delimiter.to_string()));
    }
    query
}

/// Lists one prefix with a request the client signed itself.
///
/// `prefix` is relative to the credential's scope; `cursor` is the
/// `NextContinuationToken` of the previous page.
///
/// `delimiter` is what makes "one directory" expressible on a flat key space.
/// Passing `Some("/")` returns only the direct children of `prefix`, which is
/// the only way `list("…/f/notes/")` means *notes*, not *notes and everything
/// beneath it*. Without it, enumerating the notebook root would return the
/// whole notebook and the L1 gate would lose its point (§4.1). The `s/`
/// listing wants the recursive form, so it passes `None`.
pub async fn list_prefix(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    prefix: &str,
    cursor: Option<&str>,
    delimiter: Option<&str>,
) -> Result<ListPage, SyncError> {
    let response = send_with_credential_renewal(
        credential_resolver,
        crate::telemetry::category(prefix),
        "list",
        |credentials, now| {
            let query = list_query(credentials, prefix, cursor, delimiter);
            let signed = sign_get(credentials, &query, now)?;
            let mut request = http.get(&signed.url);
            for (name, value) in &signed.headers {
                request = request.header(name, value);
            }
            Ok(request)
        },
    )
    .await?;
    // Read `Date` before the body is consumed; it is the pass's server clock.
    let server_date_millis = response
        .headers
        .get("date")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_http_date);
    let body = String::from_utf8_lossy(&response.body);
    if !response.status.is_success() {
        return Err(SyncError::Api {
            status: response.status.as_u16(),
            code: "OBJECT_STORE_LIST_FAILED".to_string(),
            message: body.chars().take(400).collect(),
            details: None,
        });
    }
    validate_list_response(&body)?;
    Ok(ListPage {
        server_date_millis,
        ..parse_list_page(&body)
    })
}

/// An incomplete listing must never become evidence that remote objects are
/// absent. Reject truncated or malformed pages before the caller marks a
/// directory as fully enumerated.
pub(crate) fn validate_list_response(xml: &str) -> Result<(), SyncError> {
    let invalid = || SyncError::InvalidState("incomplete object store listing".into());
    if !xml.contains("<ListBucketResult") || !xml.contains("</ListBucketResult>") {
        return Err(invalid());
    }
    match tag(xml, "IsTruncated").as_deref() {
        Some("false") => {}
        Some("true") if tag(xml, "NextContinuationToken").is_some_and(|v| !v.is_empty()) => {}
        _ => return Err(invalid()),
    }
    for (open, close, required) in [
        (
            "<Contents>",
            "</Contents>",
            &["Key", "LastModified", "Size"][..],
        ),
        ("<CommonPrefixes>", "</CommonPrefixes>", &["Prefix"][..]),
    ] {
        let mut rest = xml;
        while let Some(start) = rest.find(open) {
            let after = &rest[start + open.len()..];
            let end = after.find(close).ok_or_else(invalid)?;
            if required
                .iter()
                .any(|name| tag(&after[..end], name).is_none())
            {
                return Err(invalid());
            }
            if open == "<Contents>"
                && (tag(&after[..end], "Size")
                    .and_then(|s| s.parse::<u64>().ok())
                    .is_none()
                    || tag(&after[..end], "LastModified")
                        .and_then(|s| parse_http_date(&s))
                        .is_none())
            {
                return Err(invalid());
            }
            rest = &after[end + close.len()..];
        }
    }
    Ok(())
}

/// Parses the `Last-Modified` / `Date` shape S3 returns
/// (`Wed, 21 Oct 2015 07:28:00 GMT`).
///
/// Also accepts the ISO form because COS and some S3-compatible gateways emit
/// it. Returns epoch milliseconds: second granularity is the protocol's, so the
/// low three digits are always zero.
pub fn parse_http_date(value: &str) -> Option<i64> {
    let value = value.trim();
    for format in [
        "%a, %d %b %Y %H:%M:%S GMT",
        "%Y-%m-%dT%H:%M:%S%.fZ",
        "%Y-%m-%dT%H:%M:%SZ",
    ] {
        if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return Some(parsed.and_utc().timestamp_millis());
        }
    }
    None
}

/// Extracts the parts of a `ListObjectsV2` response the engine uses.
///
/// This is a fixed-shape reader, not an XML parser: it understands `<Contents>`
/// and `<CommonPrefixes>` blocks plus `<NextContinuationToken>`, and decodes the five
/// predefined entities plus numeric references. S3 escapes keys, so an
/// `&amp;`-heavy name must still round-trip.
pub fn parse_list_page(xml: &str) -> ListPage {
    let mut objects = Vec::new();
    let mut common_prefixes = Vec::new();
    let mut cursor = None;
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let after = &rest[start + "<Contents>".len()..];
        let Some(end) = after.find("</Contents>") else {
            break;
        };
        let block = &after[..end];
        if let (Some(key), Some(last_modified)) = (tag(block, "Key"), tag(block, "LastModified")) {
            objects.push(ListedObject {
                key,
                last_modified,
                size: tag(block, "Size")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                etag: tag(block, "ETag").unwrap_or_default(),
            });
        }
        rest = &after[end + "</Contents>".len()..];
    }
    let mut rest = xml;
    while let Some(start) = rest.find("<CommonPrefixes>") {
        let after = &rest[start + "<CommonPrefixes>".len()..];
        let Some(end) = after.find("</CommonPrefixes>") else {
            break;
        };
        if let Some(prefix) = tag(&after[..end], "Prefix") {
            common_prefixes.push(prefix);
        }
        rest = &after[end + "</CommonPrefixes>".len()..];
    }
    if let Some(value) = tag(xml, "NextContinuationToken") {
        if !value.is_empty() {
            cursor = Some(value);
        }
    }
    let truncated = tag(xml, "IsTruncated")
        .map(|value| value == "true")
        .unwrap_or(false);
    if !truncated {
        cursor = None;
    }
    ListPage {
        objects,
        common_prefixes,
        next_cursor: cursor,
        server_date_millis: None,
    }
}

pub(crate) fn tag(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    Some(decode_entities(&block[start..end]))
}

fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut decoded = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        decoded.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(end) = tail.find(';') else {
            decoded.push_str(tail);
            return decoded;
        };
        let entity = &tail[1..end];
        match entity {
            "amp" => decoded.push('&'),
            "lt" => decoded.push('<'),
            "gt" => decoded.push('>'),
            "quot" => decoded.push('"'),
            "apos" => decoded.push('\''),
            _ => match numeric_entity(entity) {
                Some(character) => decoded.push(character),
                None => decoded.push_str(&tail[..=end]),
            },
        }
        rest = &tail[end + 1..];
    }
    decoded.push_str(rest);
    decoded
}

fn numeric_entity(entity: &str) -> Option<char> {
    let code = match entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
    {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => entity.strip_prefix('#')?.parse().ok()?,
    };
    char::from_u32(code)
}
