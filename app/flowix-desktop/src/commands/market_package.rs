//! Shared transport and IPC errors for market packages; package validation stays domain-owned.
pub(crate) fn is_market_archive_origin(url: &url::Url) -> bool {
    (url.scheme() == "https"
        && matches!(url.host_str(), Some("skills.flowix.cc" | "flowix.cc"))
        && url.port_or_known_default() == Some(443))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallError {
    pub code: &'static str,
    pub message: String,
}
impl MarketInstallError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl From<String> for MarketInstallError {
    fn from(message: String) -> Self {
        // Existing filesystem validators return strings. Normalize them at the IPC boundary.
        let lower = message.to_lowercase();
        let code = if lower.contains("already exists") {
            "already_exists"
        } else if lower.contains("permission denied") || lower.contains("operation not permitted") {
            "permission_denied"
        } else if lower.contains("invalid")
            || lower.contains("unsafe")
            || lower.contains("must ")
            || lower.contains("exceeds")
        {
            "invalid_package"
        } else {
            "installation_failed"
        };
        Self::new(code, message)
    }
}

pub async fn download_market_zip(
    mut url: url::Url,
    max_bytes: usize,
) -> Result<Vec<u8>, MarketInstallError> {
    let local = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if local && url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1")).map_err(|_| {
            MarketInstallError::new("invalid_package", "Invalid local archive address")
        })?;
    }
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60));
    if local {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|error| MarketInstallError::new("installation_failed", error.to_string()))?;
    let mut response = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|error| {
            MarketInstallError::new(
                "installation_failed",
                format!("Package download failed: {error:?}"),
            )
        })?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(MarketInstallError::new(
            "installation_failed",
            format!("Package download returned {}", response.status()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(MarketInstallError::new(
            "invalid_package",
            "Package exceeds download size limit",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| MarketInstallError::new("installation_failed", error.to_string()))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(MarketInstallError::new(
                "invalid_package",
                "Package exceeds download size limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn response_url(response: &'static [u8]) -> url::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            stream.read(&mut buffer).await.unwrap();
            let _ = stream.write_all(response).await;
        });
        url::Url::parse(&format!("http://localhost:{port}/archive.zip")).unwrap()
    }

    #[tokio::test]
    async fn downloads_local_archive_on_an_arbitrary_port() {
        let url =
            response_url(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nzip")
                .await;
        assert_eq!(download_market_zip(url, 3).await.unwrap(), b"zip");
    }

    #[tokio::test]
    async fn enforces_header_and_streaming_size_limits() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nlong".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nlong\r\n0\r\n\r\n".as_slice(),
        ] {
            let error = download_market_zip(response_url(response).await, 3).await.unwrap_err();
            assert_eq!(error.code, "invalid_package");
        }
    }

    #[tokio::test]
    async fn rejects_redirect_without_following_another_origin() {
        let url = response_url(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        let error = download_market_zip(url, 3).await.unwrap_err();
        assert_eq!(error.code, "installation_failed");
        assert!(error.message.contains("302"));
    }
}
