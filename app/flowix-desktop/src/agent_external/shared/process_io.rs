use super::*;
use crate::agent_wire::AgentErrorDetails;

/// Hard cap (in bytes) on a single line of stdout read from an external CLI.
/// Without this, a single tool output that happens to land on a child's
/// stdout without a trailing newline — e.g. a giant heredoc — would force the
/// reader to accumulate the whole payload in memory before parsing. 512 KiB
/// covers every realistic tool result; anything larger goes through the
/// truncated path and is recorded in `runtime_log`.
pub const MAX_STDOUT_LINE_BYTES: usize = 512 * 1024;
/// Maximum diagnostic stderr retained per child. The reader keeps draining
/// after this limit so the child cannot block on a full pipe.
pub const MAX_STDERR_CHARS: usize = 256 * 1024;
/// Errors persisted into a conversation should be useful but never become a
/// transport for an entire stack trace or response body.
pub const MAX_USER_ERROR_CHARS: usize = 8 * 1024;

/// Read a single line from a stdout-style async reader with a hard byte cap.
/// Returns `Ok(None)` at clean EOF, `Ok(Some((line, truncated)))` otherwise.
/// `truncated == true` means the source line exceeded the cap and the
/// returned string is the cap-sized prefix; the reader's internal cursor has
/// been advanced past the newline (if any) so subsequent calls resume cleanly.
pub async fn read_capped_line<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<(String, bool)>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut out = Vec::new();
    let mut truncated = false;
    loop {
        let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            if out.is_empty() && !truncated {
                return Ok(None);
            }
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }

        let newline_pos = available.iter().position(|byte| *byte == b'\n');
        let take_len = newline_pos.map(|pos| pos + 1).unwrap_or(available.len());
        if out.len() < max_bytes {
            let remaining = max_bytes - out.len();
            out.extend_from_slice(&available[..take_len.min(remaining)]);
            if take_len > remaining {
                truncated = true;
            }
        } else {
            truncated = true;
        }

        reader.consume(take_len);
        if newline_pos.is_some() {
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }
    }
}

/// 流式文本合并的定时 flush 间隔。partial 模式 (`claude --include-partial-messages`)
/// 一 token 一 stream_event, 后端做帧级合并后, `agent-chunk` IPC emit 频率从
/// "每 token 一次" 降到 "每 flush 一次"。200ms (~5fps): 配合前端
/// syncLiveMessageState 的 fast path (每事件 O(1) swap), 大幅减少 IPC 与前端
/// store set 次数, 视觉顿挫可接受 (burst 间隙无感)。stop 时末尾 200ms 文本可能
/// 成 late data 被 UI 丢弃 (DB 仍持久化, 重载可见)。
/// EOF / 工具边界 / 64KB burst 仍强制 flush, 保证数据不丢。
pub const STREAM_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// 合并 buffer 的硬上限 ── burst 期间持续高速文�?���? 超过此值立�?flush,
/// 既防 buffer 无限增长, 也避免单条合�?chunk 过大�?4 KiB 远大于一帧的文本�?
/// 正常�?��不会触达�?
pub const STREAM_FLUSH_MAX_BYTES: usize = 64 * 1024;

/// 帧级文本合并 buffer ── 把高�?`Text` / `Reasoning` chunk 攒批, 减少
/// `emit_chunk_with_run_id` �?IPC 次数�?///
/// 顺序不变�? `Text` / `Reasoning` �?buffer; 其它 chunk (`ToolCall` /
/// `ToolResult` / `Error` / `SessionResolved` / `Usage` / ...) 鐢辫皟鐢ㄦ柟鍏堣皟
/// [`flush`](Self::flush) 拿走缓冲文本 emit, �?emit �?chunk, 保证
/// `text -> tool_call -> text -> tool_result -> text` 鐨勫憟鐜伴『搴忎笌鍚庣鍙戝嚭椤哄簭
/// 一致。`flush` 先产�?`Reasoning` 再产�?`Text`, 与前�?`streaming-buffer` �?/// reasoning-first �?��对齐 (reasoning chunk 先于 text 出现, text 落地�?close
/// reasoning 琛?銆?///
/// �?thread / �?run: 每个 stdout 读取�?��持有�?��实例, 无需并发保护。`flush`
/// 返回 `Vec<AgentChunk>` 而非直接 emit ── �?IPC 交给调用�?(沿用
/// `emit_chunk_with_run_id`), buffer �?��保持�?��辑、可单测�?
pub struct StreamingEmitBuffer {
    thread_id: String,
    text: String,
    reasoning: String,
    text_metadata: Option<AgentChunkMetadata>,
    reasoning_metadata: Option<AgentChunkMetadata>,
}

impl StreamingEmitBuffer {
    pub fn new(thread_id: String) -> Self {
        Self {
            thread_id,
            text: String::new(),
            reasoning: String::new(),
            text_metadata: None,
            reasoning_metadata: None,
        }
    }

    /// 当前缓冲的文�?��节数。调用方�??判断�?��该在阈值�?强制 flush�?
    pub fn pending_bytes(&self) -> usize {
        self.text.len() + self.reasoning.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.reasoning.is_empty()
    }

    pub fn has_text(&self) -> bool {
        !self.text.is_empty()
    }

    pub fn has_reasoning(&self) -> bool {
        !self.reasoning.is_empty()
    }

    #[allow(dead_code)]
    pub fn append_text(&mut self, text: &str) {
        self.append_text_with_metadata(text, AgentChunkMetadata::default());
    }

    #[allow(dead_code)]
    pub fn append_reasoning(&mut self, text: &str) {
        self.append_reasoning_with_metadata(text, AgentChunkMetadata::default());
    }

    pub fn append_text_with_metadata(&mut self, text: &str, metadata: AgentChunkMetadata) {
        if self.text_metadata.is_none() {
            self.text_metadata = Some(metadata);
        }
        self.text.push_str(text);
    }

    pub fn append_reasoning_with_metadata(&mut self, text: &str, metadata: AgentChunkMetadata) {
        if self.reasoning_metadata.is_none() {
            self.reasoning_metadata = Some(metadata);
        }
        self.reasoning.push_str(text);
    }

    pub fn text_message_id(&self) -> Option<&str> {
        self.text_metadata
            .as_ref()
            .and_then(|metadata| metadata.message_id.as_deref())
    }

    pub fn reasoning_message_id(&self) -> Option<&str> {
        self.reasoning_metadata
            .as_ref()
            .and_then(|metadata| metadata.message_id.as_deref())
    }

    /// 取走缓冲文本, �?reasoning �?text, 各自拼成单条 `AgentChunk` 返回�?    /// 空缓冲返回空 vec (调用方无需判空)�?
    #[allow(dead_code)]
    pub fn flush(&mut self) -> Vec<AgentChunk> {
        self.flush_with_metadata()
            .into_iter()
            .map(|(chunk, _)| chunk)
            .collect()
    }

    pub fn flush_with_metadata(&mut self) -> Vec<(AgentChunk, AgentChunkMetadata)> {
        let mut out = Vec::new();
        if !self.reasoning.is_empty() {
            out.push((
                AgentChunk::Reasoning {
                    thread_id: self.thread_id.clone(),
                    text: std::mem::take(&mut self.reasoning),
                },
                self.reasoning_metadata.take().unwrap_or_default(),
            ));
        }
        if !self.text.is_empty() {
            out.push((
                AgentChunk::Text {
                    thread_id: self.thread_id.clone(),
                    text: std::mem::take(&mut self.text),
                },
                self.text_metadata.take().unwrap_or_default(),
            ));
        }
        out
    }
}

pub async fn read_stderr_to_string<R>(
    thread_id: &str,
    expected_run_id: Option<&str>,
    runs: &ExternalRunRegistry,
    reader: R,
) -> Result<String, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut reader = reader;
    let mut out = String::new();
    let mut remaining = MAX_STDERR_CHARS;
    let mut truncated = false;
    while let Some((line, line_truncated)) =
        read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await?
    {
        runs.touch(thread_id, expected_run_id).await;
        if remaining == 0 {
            truncated = true;
            continue;
        }
        let mut chars = line.chars();
        let retained: String = chars.by_ref().take(remaining).collect();
        remaining = remaining.saturating_sub(retained.chars().count());
        out.push_str(&retained);
        let exceeded_remaining = chars.next().is_some();
        if !exceeded_remaining && remaining > 0 && !out.ends_with('\n') {
            out.push('\n');
            remaining = remaining.saturating_sub(1);
        }
        truncated |= line_truncated || exceeded_remaining;
    }
    if truncated {
        out.push_str("\n...[stderr truncated]");
    }
    Ok(redact_sensitive_text(&out))
}

/// Truncate `text` to at most `max_chars` Unicode chars, appending a sentinel
/// when truncation occurred. Used for log/preview fields that must stay bounded.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}

/// Soft cap on text dropped into `runtime_log` / stderr-preview fields. Large
/// enough to diagnose, small enough to keep logs readable. Single source of
/// truth shared by every sidecar CLI.
pub const MAX_LOG_TEXT_CHARS: usize = 2048;

/// [`truncate_chars`] bound by [`MAX_LOG_TEXT_CHARS`] — the standard "preview
/// this for the log" helper shared by every sidecar CLI.
pub fn truncate_for_log(text: &str) -> String {
    truncate_chars(&redact_sensitive_text(text), MAX_LOG_TEXT_CHARS)
}

/// Redact common credential shapes before diagnostics cross the process
/// boundary. This intentionally errs toward hiding a value after a sensitive
/// label; request ids and status codes remain untouched.
pub fn redact_sensitive_text(text: &str) -> String {
    static PATTERNS: once_cell::sync::Lazy<Vec<(regex::Regex, &'static str)>> =
        once_cell::sync::Lazy::new(|| {
            vec![
                (
                    regex::Regex::new(r#"(?i)(\"(?:api[_-]?key|authorization|token|password|passwd|secret|cookie)\"\s*:\s*\")[^\"]*"#)
                        .expect("valid JSON credential regex"),
                    "$1[REDACTED]",
                ),
                (
                    regex::Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}")
                        .expect("valid bearer credential regex"),
                    "$1[REDACTED]",
                ),
                (
                    regex::Regex::new(r"(?i)((?:api[_ -]?key|authorization|token|password|passwd|secret|cookie)\s*[:=]\s*)[^\s,;]+")
                        .expect("valid labeled credential regex"),
                    "$1[REDACTED]",
                ),
                (
                    regex::Regex::new(r"\bsk-[A-Za-z0-9_-]{12,}\b")
                        .expect("valid API key regex"),
                    "[REDACTED]",
                ),
            ]
        });

    PATTERNS
        .iter()
        .fold(text.to_string(), |value, (pattern, replacement)| {
            pattern.replace_all(&value, *replacement).into_owned()
        })
}

pub fn safe_user_error_message(text: &str) -> String {
    truncate_chars(&redact_sensitive_text(text), MAX_USER_ERROR_CHARS)
}

/// Extract the human-readable provider failure from a structured JSON event.
///
/// External CLIs do not agree on one envelope. Claude uses `is_error` plus
/// `result`, while OpenAI-compatible tools commonly use `error.message` or a
/// top-level `message`. This helper only returns a value for an event that is
/// explicitly marked as an error; ordinary successful result events are never
/// treated as failures.
pub fn provider_error_from_json(value: &Value) -> Option<String> {
    let has_error_field = value
        .get("error")
        .map(|error| !error.is_null())
        .unwrap_or(false);
    let is_error = value.get("is_error").and_then(Value::as_bool) == Some(true)
        || has_error_field
        || matches!(
            value.get("subtype").and_then(Value::as_str),
            Some("error" | "error_during_execution" | "failed")
        );
    if !is_error {
        return None;
    }

    let error = value.get("error");
    let candidates = [
        error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str),
        error.and_then(Value::as_str),
        value.get("result").and_then(Value::as_str),
        value.get("message").and_then(Value::as_str),
        value.get("detail").and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|message| !message.is_empty())
        .map(str::to_string)
}

/// Find a provider error in unstructured CLI output. This is used only after
/// a non-zero process exit, so a plain stdout response cannot be mistaken for
/// an error during a successful run.
pub fn provider_error_from_text(text: &str) -> Option<String> {
    for line in text
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(message) = provider_error_from_json(&value) {
                return Some(message);
            }
        }
        let lower = line.to_ascii_lowercase();
        if [
            "api error",
            "request rejected",
            "rate limit",
            "rate-limited",
            "usage limit",
            "too many requests",
            "quota",
            // Flowix Cloud refuses a zero AI credit balance with a plain
            // English sentence; it is a spendable-balance error, not a
            // transport failure.
            "credit balance",
            "unauthorized",
            "authentication",
            "invalid api key",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
        {
            return Some(line.to_string());
        }
    }
    None
}

/// Resolve one user-facing failure using the common source priority:
/// provider payload > protocol error > stderr > process exit status.
///
/// The process status is deliberately the final fallback. It remains useful
/// for diagnostics, but it is not a substitute for an upstream explanation.
pub fn resolve_external_failure(
    provider_message: Option<&str>,
    protocol_message: Option<&str>,
    stderr: &str,
    process_label: &str,
    status: &str,
) -> String {
    let stderr_provider_message = provider_error_from_text(stderr);
    let candidate = provider_message
        .or(protocol_message)
        .or(stderr_provider_message.as_deref())
        .or_else(|| {
            let detail = stderr.trim();
            (!detail.is_empty()).then_some(detail)
        })
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(safe_user_error_message);

    let message = candidate
        .map(|detail| format!("{process_label} exited with status {status}: {detail}"))
        .unwrap_or_else(|| format!("{process_label} exited with status {status}"));
    safe_user_error_message(&message)
}

/// Convert vendor/CLI text into provider-agnostic diagnostics without
/// replacing the vendor's original wording. This is intentionally tolerant:
/// CLI versions differ in whether status/request ids are printed as JSON,
/// labels, or bracketed tokens.
pub fn classify_agent_error(message: &str, source: &str) -> AgentErrorDetails {
    let status_code = extract_status_code(message);
    let lower = message.to_ascii_lowercase();
    // A provider may use HTTP 429 for both transient throttling and a hard
    // plan/quota ceiling. Keep those states distinct: retrying the latter is
    // noisy and cannot succeed until the user changes the account/plan.
    let quota_exhausted = lower.contains("token plan")
        || lower.contains("usage limit")
        || lower.contains("usage_limit")
        || lower.contains("quota exceeded")
        || lower.contains("quota_exceeded")
        || lower.contains("insufficient balance")
        || lower.contains("insufficient_balance")
        || lower.contains("insufficient credit")
        // Flowix Cloud answers a zero AI balance with "Your Flowix credit
        // balance must be greater than zero" and HTTP 402. Retrying cannot fix
        // it, so it must be a quota failure, never a transient one.
        || lower.contains("credit balance")
        || lower.contains("out of credits")
        || lower.contains("no credits")
        || lower.contains("balance insufficient")
        || lower.contains("5 hour")
        || lower.contains("5-hour")
        || message.contains("用量上限")
        || message.contains("套餐")
        || message.contains("积分补充")
        || message.contains("积分不足")
        || message.contains("余额不足")
        || message.contains("配额耗尽")
        || message.contains("配额不足")
        || message.contains("额度不足");
    let category = if quota_exhausted {
        "quota_exhausted"
    } else if status_code == Some(429)
        || lower.contains("rate limit")
        || lower.contains("rate-limited")
        || lower.contains("too many requests")
    {
        "rate_limited"
    } else if matches!(status_code, Some(401 | 403))
        || lower.contains("unauthorized")
        || lower.contains("authentication")
        || lower.contains("invalid api key")
    {
        "authentication"
    } else if lower.contains("no conversation found")
        || lower.contains("session not found")
        || lower.contains("unknown session")
    {
        "session_not_found"
    } else if lower.contains("model not found")
        || lower.contains("unknown model")
        || (lower.contains("model") && lower.contains("does not exist"))
    {
        "model_not_found"
    } else if lower.contains("context length")
        || lower.contains("context window")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
    {
        "context_length"
    } else if lower.contains("content filter")
        || lower.contains("content policy")
        || lower.contains("safety policy")
    {
        "content_policy"
    } else if matches!(status_code, Some(400 | 422))
        || lower.contains("invalid request")
        || lower.contains("bad request")
    {
        "invalid_request"
    } else if matches!(status_code, Some(code) if code >= 500)
        || lower.contains("internal server error")
        || lower.contains("bad gateway")
        || lower.contains("service unavailable")
    {
        "provider"
    } else if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("network")
    {
        "network"
    } else if lower.contains("exited with status") {
        "process"
    } else {
        "unknown"
    };

    let retryable = match category {
        "quota_exhausted" => false,
        "rate_limited" | "provider" | "network" => true,
        _ => false,
    };

    AgentErrorDetails {
        category: category.to_string(),
        status_code,
        request_id: extract_request_id(message),
        retry_after: extract_retry_after(message),
        exit_code: extract_exit_code(message),
        upstream_message: extract_upstream_message(message),
        source: Some(source.to_string()),
        retryable,
    }
}

#[cfg(test)]
mod error_tests {
    use super::{
        classify_agent_error, provider_error_from_json, provider_error_from_text,
        redact_sensitive_text, resolve_external_failure, safe_user_error_message,
    };

    #[test]
    fn extracts_claude_result_error_without_confusing_success() {
        let error = serde_json::json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "API Error: Request rejected (429)"
        });
        let success = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done"
        });

        assert_eq!(
            provider_error_from_json(&error).as_deref(),
            Some("API Error: Request rejected (429)")
        );
        assert_eq!(provider_error_from_json(&success), None);
    }

    #[test]
    fn failure_priority_prefers_provider_over_exit_status() {
        assert_eq!(
            resolve_external_failure(
                Some("provider quota exceeded"),
                Some("protocol failed"),
                "",
                "Claude Code CLI",
                "exit status: 1",
            ),
            "Claude Code CLI exited with status exit status: 1: provider quota exceeded"
        );
        assert_eq!(
            resolve_external_failure(None, None, "", "Claude Code CLI", "exit status: 1"),
            "Claude Code CLI exited with status exit status: 1"
        );
    }

    #[test]
    fn detects_unstructured_provider_error_in_stdout() {
        assert_eq!(
            provider_error_from_text("working\nAPI Error: quota exceeded\n").as_deref(),
            Some("API Error: quota exceeded")
        );
    }

    #[test]
    fn keeps_the_upstream_message_behind_the_cli_wrapper() {
        let details = classify_agent_error(
            "Claude Code CLI exited with status exit status: 1: 5 hour usage limit reached (request_id: req-1)",
            "runtime",
        );
        assert_eq!(details.status_code, None);
        assert_eq!(
            details.upstream_message.as_deref(),
            Some("5 hour usage limit reached (request_id: req-1)")
        );
        assert_eq!(details.request_id.as_deref(), Some("req-1"));
        assert!(!details.retryable);
    }

    #[test]
    fn classifies_provider_rate_limits_and_preserves_request_metadata() {
        let details = classify_agent_error(
            "HTTP 429 Too Many Requests; retry-after: 60; request_id=req-2",
            "stderr",
        );
        assert_eq!(details.category, "rate_limited");
        assert_eq!(details.status_code, Some(429));
        assert_eq!(details.retry_after.as_deref(), Some("60"));
        assert_eq!(details.request_id.as_deref(), Some("req-2"));
        assert!(details.retryable);
    }

    #[test]
    fn separates_hard_quota_exhaustion_from_transient_429s() {
        let quota = classify_agent_error(
            "HTTP 429: Token Plan usage limit reached; please top up credits",
            "protocol",
        );
        assert_eq!(quota.category, "quota_exhausted");
        assert!(!quota.retryable);

        let chinese_quota = classify_agent_error("余额不足，无法继续请求", "protocol");
        assert_eq!(chinese_quota.category, "quota_exhausted");
        assert!(!chinese_quota.retryable);

        let transient =
            classify_agent_error("HTTP 429 Too Many Requests; retry-after: 3", "protocol");
        assert_eq!(transient.category, "rate_limited");
        assert!(transient.retryable);
    }

    #[test]
    fn treats_a_zero_cloud_balance_as_hard_quota_exhaustion() {
        // Flowix Cloud refuses the request itself; Pi must not spend its agent
        // retries on a balance only a top-up can change.
        let details = classify_agent_error(
            "Your Flowix credit balance must be greater than zero",
            "pi",
        );
        assert_eq!(details.category, "quota_exhausted");
        assert!(!details.retryable);
    }

    #[test]
    fn extracts_message_from_an_upstream_json_envelope() {
        let details = classify_agent_error(
            "OpenCode ACP request failed\nOpenCode stderr: {\"error\":{\"message\":\"quota exceeded\"},\"request_id\":\"req-3\"}",
            "runtime",
        );
        assert_eq!(details.upstream_message.as_deref(), Some("quota exceeded"));
        assert_eq!(details.request_id.as_deref(), Some("req-3"));
    }

    #[test]
    fn status_detection_requires_http_or_status_context() {
        assert_eq!(
            classify_agent_error("failure near line 500", "stderr").status_code,
            None
        );
        assert_eq!(
            classify_agent_error(r#"request failed: {"status":503}"#, "stderr").status_code,
            Some(503)
        );
    }

    #[test]
    fn classifies_actionable_model_errors() {
        assert_eq!(
            classify_agent_error("The model 'gpt-x' does not exist", "stdout").category,
            "model_not_found"
        );
        assert_eq!(
            classify_agent_error("maximum context length exceeded", "stdout").category,
            "context_length"
        );
        assert_eq!(
            classify_agent_error("request blocked by content policy", "stdout").category,
            "content_policy"
        );
    }

    #[test]
    fn persisted_error_text_is_bounded_and_redacted() {
        let secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
        let long = format!("Authorization: Bearer {secret}\n{}", "x".repeat(20_000));
        let safe = safe_user_error_message(&long);
        assert!(!safe.contains(secret));
        assert!(safe.contains("[REDACTED]"));
        assert!(safe.chars().count() <= super::MAX_USER_ERROR_CHARS + 20);
        assert_eq!(
            redact_sensitive_text(r#"{"api_key":"super-secret-value"}"#),
            r#"{"api_key":"[REDACTED]"}"#
        );
    }
}

fn extract_status_code(message: &str) -> Option<u16> {
    static STATUS_PATTERNS: once_cell::sync::Lazy<Vec<regex::Regex>> = once_cell::sync::Lazy::new(
        || {
            vec![
                regex::Regex::new(
                    r#"(?i)\bhttp(?:\s+status)?\s*[:=]?\s*([45]\d{2})\b"#,
                )
                .expect("valid HTTP status regex"),
                regex::Regex::new(
                    r#"(?i)[\"']?(?:status|status_code|statusCode|status code)[\"']?\s*[:=]\s*([45]\d{2})\b"#,
                )
                .expect("valid labeled status regex"),
                regex::Regex::new(r#"(?i)\bapi error[^\n]{0,96}?\b([45]\d{2})\b"#)
                    .expect("valid API status regex"),
            ]
        },
    );
    STATUS_PATTERNS.iter().find_map(|pattern| {
        pattern
            .captures(message)
            .and_then(|captures| captures.get(1))
            .and_then(|value| value.as_str().parse::<u16>().ok())
    })
}

fn extract_exit_code(message: &str) -> Option<i32> {
    let lower = message.to_ascii_lowercase();
    let marker = "exit status:";
    let start = lower.find(marker)? + marker.len();
    let digits = lower[start..]
        .trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()?;
    digits.parse().ok()
}

fn extract_request_id(message: &str) -> Option<String> {
    let lower = message.to_ascii_lowercase();
    for marker in ["request_id", "request-id", "request id", "requestid"] {
        if let Some(index) = lower.find(marker) {
            let tail = message[index + marker.len()..].trim_start_matches([' ', ':', '=', '"']);
            let value = tail
                .split(|c: char| c.is_whitespace() || matches!(c, ',' | '"' | ')' | ']'))
                .next()
                .unwrap_or_default();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    message
        .rsplit_once('[')
        .and_then(|(_, tail)| tail.split(']').next())
        .filter(|value| {
            value.len() >= 20
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(str::to_string)
}

fn extract_retry_after(message: &str) -> Option<String> {
    static RETRY_AFTER: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r#"(?i)[\"']?retry(?:-|_)?after[\"']?\s*[:=]\s*[\"']?([^\"'\s,;}]+)"#)
            .expect("valid retry-after regex")
    });
    RETRY_AFTER
        .captures(message)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_string())
}

fn extract_upstream_message(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    for marker in [
        "claude code cli exited with status",
        "codex cli exited with status",
    ] {
        if let Some(index) = lower.find(marker) {
            let mut suffix = trimmed[index + marker.len()..].trim_start();
            // The status itself can be rendered as `exit status: 1`, so the
            // first colon is not necessarily the wrapper/detail separator.
            if let Some(rest) = suffix.strip_prefix("exit status:") {
                suffix = rest.trim_start();
            }
            if let Some((_, detail)) = suffix.split_once(": ") {
                if !detail.trim().is_empty() {
                    return Some(clean_upstream_message(detail));
                }
            }
        }
    }
    Some(clean_upstream_message(trimmed))
}

/// Prefer the provider's human-readable message when stderr contains a JSON
/// error envelope, and keep plain stderr bounded before it reaches the wire.
/// This preserves useful upstream wording without turning the chat transcript
/// into a stack trace or an unbounded raw response dump.
fn clean_upstream_message(message: &str) -> String {
    let candidate = if let Some((protocol, stderr)) = message.split_once("\nOpenCode stderr:") {
        let lower = stderr.to_ascii_lowercase();
        if stderr.contains('{')
            || lower.contains("rate limit")
            || lower.contains("usage limit")
            || lower.contains("unauthorized")
            || lower.contains("api key")
            || lower.contains("http 4")
            || lower.contains("http 5")
        {
            stderr.trim()
        } else {
            protocol.trim()
        }
    } else {
        message.trim()
    };

    if let Some(json_message) = extract_json_error_message(candidate) {
        return truncate_chars(&json_message, MAX_LOG_TEXT_CHARS);
    }

    let compact = candidate
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(12)
        .collect::<Vec<_>>()
        .join("\n");
    truncate_chars(&compact, MAX_LOG_TEXT_CHARS)
}

fn extract_json_error_message(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let value: serde_json::Value = serde_json::from_str(&text[start..=end]).ok()?;
    let object = value.as_object()?;
    if let Some(error) = object.get("error") {
        if let Some(message) = error
            .as_object()
            .and_then(|error| error.get("message"))
            .and_then(serde_json::Value::as_str)
        {
            return Some(message.to_string());
        }
        if let Some(message) = error.as_str() {
            return Some(message.to_string());
        }
    }
    object
        .get("message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| object.get("detail").and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

/// Read a `BufReader<R>` to a single `String`. The async analogue of reading a
/// child's full stderr when no line-protocol parsing is needed.
pub async fn read_to_string<R>(reader: BufReader<R>) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut out = String::new();
    reader
        .read_to_string(&mut out)
        .await
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Derive a default thread title from the user prompt: collapse whitespace,
/// cap at 28 chars, fall back to `"{display_name} session"` when empty. Shared
/// by runtimes that do not get a title back from the CLI.
pub fn default_thread_title(display_name: &str, prompt: &str) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        format!("{display_name} session")
    } else {
        title.chars().take(28).collect()
    }
}

/// Put an external-CLI child in its own process group so `kill_child_tree`
/// can signal the whole group (and its grandchildren) on Unix. No-op on
/// Windows, where `taskkill /T /F` already reaps the tree.
#[cfg(unix)]
pub fn configure_unix_process_group(cmd: &mut tokio::process::Command) {
    // `process_group(0)` => setpgid(0, 0): the child becomes leader of a new
    // group whose pgid == child pid. `kill_child_tree` then `kill(-pgid)` to
    // reap grandchildren (Node CLIs spawn their own shells/tools).
    cmd.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
pub fn configure_unix_process_group(_cmd: &mut tokio::process::Command) {}

/// Kill an external-CLI child process tree. On Windows we use `taskkill /T /F`
/// to take down the whole tree (the child typically spawns its own helpers);
/// on Unix we signal the child's whole process group (set up at spawn via
/// `configure_unix_process_group`) so grandchildren are reaped too. Either
/// way we finish with `Child::kill` to also reap the leader handle.
pub async fn kill_child_tree(child: &mut Child, label: &str, thread_id: &str) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut cmd = Command::new("taskkill");
        crate::process_window::hide_command_window(&mut cmd);
        match cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await
        {
            Ok(output) if output.status.success() => return,
            Ok(output) => tracing::warn!(
                "[{label}] taskkill failed for {thread_id}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(err) => tracing::warn!("[{label}] failed to run taskkill for {thread_id}: {err}"),
        }
    }

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The child was spawned with `process_group(0)`, so it leads a new
        // process group whose pgid == its pid. Signal the whole group to reap
        // grandchildren (Node CLIs spawn their own shells/tools); a bare
        // `child.kill()` would orphan them. SIGTERM for a graceful chance,
        // then SIGKILL. We still fall through to `child.kill()` below to reap
        // the leader handle.
        let pgid = pid as i32;
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGTERM);
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }

    if let Err(err) = child.kill().await {
        tracing::warn!("[{label}] failed to kill child for {thread_id}: {err}");
    }
}
