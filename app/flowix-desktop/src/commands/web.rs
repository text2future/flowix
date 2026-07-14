use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPageMetadata {
    pub url: String,
    pub title: String,
    pub description: String,
    pub image: String,
}

#[tauri::command]
pub async fn parse_web_page(url: String) -> Result<WebPageMetadata, String> {
    let normalized_url = normalize_url(&url)?;
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Flowix Web Card")
        .redirect(reqwest::redirect::Policy::limited(6))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&normalized_url)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(|e| format!("failed to fetch page: {e}"))?
        .error_for_status()
        .map_err(|e| format!("page request failed: {e}"))?;

    let final_url = response.url().to_string();
    let html = response
        .text()
        .await
        .map_err(|e| format!("failed to read page: {e}"))?;

    Ok(extract_metadata(&html, &final_url))
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("url is empty".into());
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let parsed = reqwest::Url::parse(&candidate).map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        _ => Err("only http and https urls are supported".into()),
    }
}

fn extract_metadata(html: &str, page_url: &str) -> WebPageMetadata {
    let title = first_non_empty(&[
        meta_content(html, "property", "og:title"),
        meta_content(html, "name", "twitter:title"),
        title_tag(html),
    ]);
    let description = first_non_empty(&[
        meta_content(html, "property", "og:description"),
        meta_content(html, "name", "twitter:description"),
        meta_content(html, "name", "description"),
    ]);
    let image = first_non_empty(&[
        meta_content(html, "property", "og:image"),
        meta_content(html, "name", "twitter:image"),
    ])
    .and_then(|value| resolve_url(page_url, &value));

    WebPageMetadata {
        url: page_url.to_string(),
        title: title.unwrap_or_else(|| page_url.to_string()),
        description: description.unwrap_or_default(),
        image: image.unwrap_or_default(),
    }
}

fn first_non_empty(values: &[Option<String>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .map(|value| html_unescape(value.trim()))
        .find(|value| !value.is_empty())
}

fn title_tag(html: &str) -> Option<String> {
    Regex::new(r#"(?is)<title[^>]*>(.*?)</title>"#)
        .ok()?
        .captures(html)?
        .get(1)
        .map(|m| strip_tags(m.as_str()))
}

fn meta_content(html: &str, key_attr: &str, key_value: &str) -> Option<String> {
    let tag_re = Regex::new(r#"(?is)<meta\b[^>]*>"#).ok()?;
    let result = tag_re.find_iter(html).find_map(|tag| {
        let tag_text = tag.as_str();
        let key = attr_value(tag_text, key_attr)?;
        if !key.eq_ignore_ascii_case(key_value) {
            return None;
        }
        attr_value(tag_text, "content")
    });
    result
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        regex::escape(name)
    );
    let captures = Regex::new(&pattern).ok()?.captures(tag)?;
    for index in 1..=3 {
        if let Some(value) = captures.get(index) {
            return Some(value.as_str().to_string());
        }
    }
    None
}

fn strip_tags(value: &str) -> String {
    Regex::new(r#"(?is)<[^>]+>"#)
        .map(|re| re.replace_all(value, "").to_string())
        .unwrap_or_else(|_| value.to_string())
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .trim()
        .to_string()
}

fn resolve_url(base: &str, value: &str) -> Option<String> {
    let base_url = reqwest::Url::parse(base).ok()?;
    base_url.join(value.trim()).ok().map(|url| url.to_string())
}
