//! Public web search tool.
//!
//! This is intentionally lightweight: it queries DuckDuckGo's HTML endpoint and
//! returns a small structured list the agent can cite. Parsing is best-effort and
//! covered by fixture tests so the tool fails cleanly if the provider markup
//! changes.

use regex::Regex;
use reqwest::Url;
use rllm::chat::Tool;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::{function_tool, ToolResult};

pub const TOOL_NAME: &str = "web_search";

const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 10;

pub fn web_search_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "Search the public web for current information. Returns a list of results with title, url, and snippet. Use this when the user asks for current, external, or source-backed information.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The public web search query."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Maximum number of results to return. Defaults to 5."
                }
            },
            "required": ["query"]
        }),
    )
}

#[derive(Debug, Deserialize)]
struct Args {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WebSearchResult {
    title: String,
    url: String,
    snippet: String,
}

#[derive(Debug, Serialize)]
struct WebSearchResponse {
    query: String,
    provider: &'static str,
    result_count: usize,
    results: Vec<WebSearchResult>,
}

pub async fn execute_tool(arguments: &str) -> ToolResult {
    let args: Args = match serde_json::from_str(arguments) {
        Ok(a) => a,
        Err(e) => {
            return ToolResult::error(format!(
                "web_search: invalid arguments - expected {{\"query\":\"...\",\"limit\":5}}: {e}"
            ))
        }
    };

    let query = args.query.trim();
    if query.is_empty() {
        return ToolResult::error("web_search: `query` must be a non-empty string");
    }

    let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut url = match Url::parse("https://duckduckgo.com/html/") {
        Ok(url) => url,
        Err(e) => return ToolResult::error(format!("web_search: invalid provider URL: {e}")),
    };
    url.query_pairs_mut().append_pair("q", query);

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 Flowix Agent Web Search")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
    {
        Ok(client) => client,
        Err(e) => return ToolResult::error(format!("web_search: failed to build client: {e}")),
    };

    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(e) => return ToolResult::error(format!("web_search: request failed: {e}")),
    };

    if !response.status().is_success() {
        return ToolResult::error(format!(
            "web_search: provider returned HTTP {}",
            response.status()
        ));
    }

    let html = match response.text().await {
        Ok(text) => text,
        Err(e) => return ToolResult::error(format!("web_search: failed to read response: {e}")),
    };

    let results = parse_duckduckgo_html(&html, limit);
    ToolResult::success(WebSearchResponse {
        query: query.to_string(),
        provider: "duckduckgo_html",
        result_count: results.len(),
        results,
    })
}

fn parse_duckduckgo_html(html: &str, limit: usize) -> Vec<WebSearchResult> {
    let anchor_re =
        Regex::new(r#"(?is)<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>.*?</a>"#).unwrap();
    let snippet_re = Regex::new(
        r#"(?is)<(?:a|div)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)</(?:a|div)>"#,
    )
    .unwrap();

    let mut results = Vec::new();
    for anchor in anchor_re.find_iter(html) {
        if results.len() >= limit {
            break;
        }

        let tag = anchor.as_str();
        let href = match attr_value(tag, "href").and_then(|raw| normalize_result_url(&raw)) {
            Some(url) => url,
            None => continue,
        };

        let title = collapse_ws(&html_unescape(&strip_tags(tag)));
        if title.is_empty() {
            continue;
        }

        let nearby_end = (anchor.end() + 2500).min(html.len());
        let nearby = &html[anchor.end()..nearby_end];
        let snippet = snippet_re
            .captures(nearby)
            .and_then(|caps| caps.get(1))
            .map(|m| collapse_ws(&html_unescape(&strip_tags(m.as_str()))))
            .unwrap_or_default();

        results.push(WebSearchResult {
            title,
            url: href,
            snippet,
        });
    }

    results
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let double_pattern = format!(r#"(?is)\b{}\s*=\s*"([^"]*)""#, regex::escape(name));
    if let Some(value) = Regex::new(&double_pattern)
        .ok()?
        .captures(tag)
        .and_then(|captures| captures.get(1))
    {
        return Some(html_unescape(value.as_str()));
    }

    let single_pattern = format!(r#"(?is)\b{}\s*=\s*'([^']*)'"#, regex::escape(name));
    Regex::new(&single_pattern)
        .ok()?
        .captures(tag)?
        .get(1)
        .map(|m| html_unescape(m.as_str()))
}

fn normalize_result_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let base = Url::parse("https://duckduckgo.com").ok()?;
    let url = match Url::parse(raw) {
        Ok(url) => url,
        Err(_) => base.join(raw).ok()?,
    };

    if let Some((_, uddg)) = url.query_pairs().find(|(key, _)| key == "uddg") {
        let decoded = uddg.into_owned();
        if Url::parse(&decoded).is_ok() {
            return Some(decoded);
        }
    }

    Some(url.to_string())
}

fn strip_tags(input: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .unwrap()
        .replace_all(input, " ")
        .to_string()
}

fn collapse_ws(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn html_unescape(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_duckduckgo_html_results() {
        let html = r#"
            <div class="result">
              <h2 class="result__title">
                <a rel="nofollow" class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Falpha%3Fx%3D1%26y%3D2">Alpha &amp; Beta</a>
              </h2>
              <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">First <b>snippet</b>.</a>
            </div>
            <div class="result">
              <h2 class="result__title">
                <a class="result__a" href="https://example.org/direct">Direct Result</a>
              </h2>
              <div class="result__snippet">Second &quot;snippet&quot;.</div>
            </div>
        "#;

        let results = parse_duckduckgo_html(html, 10);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Alpha & Beta");
        assert_eq!(results[0].url, "https://example.com/alpha?x=1&y=2");
        assert_eq!(results[0].snippet, "First snippet .");
        assert_eq!(results[1].title, "Direct Result");
        assert_eq!(results[1].url, "https://example.org/direct");
        assert_eq!(results[1].snippet, "Second \"snippet\".");
    }

    #[test]
    fn parse_respects_limit() {
        let html = r#"
            <a class="result__a" href="https://example.com/one">One</a>
            <a class="result__a" href="https://example.com/two">Two</a>
        "#;

        let results = parse_duckduckgo_html(html, 1);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "One");
    }

    #[test]
    fn normalizes_duckduckgo_redirect_url() {
        let url = normalize_result_url("/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc").unwrap();
        assert_eq!(url, "https://example.com/doc");
    }
}
