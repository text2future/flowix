//! One signed request, buffered, with a single renewal retry.
//!
//! Keeping the execution loop here rather than in the caller means the renewal
//! rule ("retry once, and only if the signing material actually changed") is
//! written down in exactly one place.

use chrono::{DateTime, Utc};

use super::credentials::{CredentialResolver, ObjectStoreCredentials};
use super::listing::tag;
use crate::error::SyncError;

/// A fully buffered object-store response. Object downloads already have to
/// materialize their body for reconciliation; buffering here also lets the
/// signer inspect a small S3 XML error body before deciding to renew once.
pub(crate) struct BufferedObjectResponse {
    pub credentials: ObjectStoreCredentials,
    pub status: reqwest::StatusCode,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

/// Sends a signed request and retries exactly once when S3 explicitly reports
/// an expired temporary token. Permission failures and ordinary 403/400
/// responses pass through unchanged.
///
/// Also retries exactly once when the send fails at the connect stage, which
/// is what a stale system-proxy snapshot looks like after a VPN toggle (see
/// [`crate::http`]): the client is rebuilt, then the request is rebuilt
/// against it through `build` — re-signing is harmless and streaming bodies
/// are re-materialized, which is why the client reaches the closure as a
/// parameter instead of being captured.
pub(crate) async fn send_with_credential_renewal<F>(
    http: &crate::http::HttpClient,
    resolver: &dyn CredentialResolver,
    category: &'static str,
    operation: &'static str,
    mut build: F,
) -> Result<BufferedObjectResponse, SyncError>
where
    F: FnMut(
        &reqwest::Client,
        &ObjectStoreCredentials,
        DateTime<Utc>,
    ) -> Result<reqwest::RequestBuilder, SyncError>,
{
    let mut credentials = resolver.resolve(resolver.now().timestamp_millis()).await?;
    // One renewal and one rebuild may combine: connect-stage failure, then an
    // expired token on the retried request. Three attempts covers both.
    let mut renewed = false;
    let mut rebuilt = false;
    for _attempt in 0..3 {
        let request = build(&http.get(), &credentials, resolver.now())?;
        let mut measurement = crate::telemetry::RequestMeasurement::start(category, operation);
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                measurement.finish(false);
                if !rebuilt && crate::http::is_stale_snapshot_error(&error) {
                    rebuilt = true;
                    http.rebuild();
                    continue;
                }
                return Err(error.into());
            }
        };
        let status = response.status();
        // Every response carries the store's own clock. Feeding it back makes
        // the next signature and the next freshness check independent of the
        // device clock.
        if let Some(server_millis) = response
            .headers()
            .get(reqwest::header::DATE)
            .and_then(|value| value.to_str().ok())
            .and_then(super::listing::parse_http_date)
        {
            resolver.observe_server_time(server_millis);
        }
        let headers = response.headers().clone();
        let mut body = Vec::new();
        let progress = crate::telemetry::progress_callback();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    body.extend_from_slice(&chunk);
                    if !chunk.is_empty() {
                        if let Some(progress) = &progress {
                            progress();
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    measurement.finish(false);
                    return Err(error.into());
                }
            }
        }
        measurement.finish(status.is_success() || status.as_u16() == 404);
        drop(measurement);
        if !renewed && is_expired_token_response(status, &body) {
            renewed = true;
            let refreshed = resolver
                .refresh_after_rejection(resolver.now().timestamp_millis(), &credentials)
                .await?;
            if !credentials.same_signing_material(&refreshed) {
                credentials = refreshed;
                continue;
            }
        }
        return Ok(BufferedObjectResponse {
            credentials,
            status,
            headers,
            body,
        });
    }
    unreachable!("the renewal and rebuild loop returns after at most three attempts")
}

pub(crate) fn is_expired_token_response(status: reqwest::StatusCode, body: &[u8]) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST && status != reqwest::StatusCode::FORBIDDEN {
        return false;
    }
    let body = String::from_utf8_lossy(body);
    matches!(
        tag(&body, "Code").as_deref(),
        Some("ExpiredToken" | "InvalidToken" | "TokenRefreshRequired")
    )
}
