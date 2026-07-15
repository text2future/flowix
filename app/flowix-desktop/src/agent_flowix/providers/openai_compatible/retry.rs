use std::time::Duration;

pub(super) fn format_reqwest_error(e: &reqwest::Error) -> String {
    let mut chain = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        chain.push_str(" <- ");
        chain.push_str(&s.to_string());
        source = s.source();
    }
    chain
}

pub(super) fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

pub(super) fn retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(match attempt {
        0 => 400,
        1 => 1_000,
        _ => 2_000,
    })
}
