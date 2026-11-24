//! Persistent HTTP download. Partial bytes are never treated as a verified package.
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{fs::OpenOptions, io::Write, path::Path};

#[derive(Debug, Serialize, Deserialize)]
struct ResumeMetadata {
    validator: Option<String>,
    total: Option<u64>,
}

pub(super) fn partial_may_be_complete(partial: &Path) -> bool {
    let Ok(file) = std::fs::metadata(partial) else {
        return false;
    };
    if file.len() == 0 {
        return false;
    }
    let saved = std::fs::read(partial.with_extension("resume.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ResumeMetadata>(&bytes).ok());
    saved
        .and_then(|m| m.total)
        .is_none_or(|total| file.len() == total)
}

fn validator(headers: &header::HeaderMap) -> Option<String> {
    headers
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.starts_with('"') && v.ends_with('"'))
        .or_else(|| {
            headers
                .get(header::LAST_MODIFIED)
                .and_then(|v| v.to_str().ok())
        })
        .map(str::to_owned)
}

fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

pub(super) async fn download_to_file(
    client: &Client,
    url: &Url,
    mut headers: header::HeaderMap,
    partial: &Path,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    let metadata_path = partial.with_extension("resume.json");
    let saved = std::fs::read(&metadata_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ResumeMetadata>(&bytes).ok());
    let length = std::fs::metadata(partial).map(|m| m.len()).unwrap_or(0);
    let mut offset = saved
        .as_ref()
        .filter(|m| {
            m.validator.is_some() && length > 0 && m.total.is_none_or(|total| length < total)
        })
        .map(|_| length)
        .unwrap_or(0);
    // Only this downloader may set the resume headers, including on fallback.
    headers.remove(header::RANGE);
    headers.remove(header::IF_RANGE);
    headers
        .entry(header::ACCEPT)
        .or_insert(header::HeaderValue::from_static("application/octet-stream"));

    // A changed resource, ignored Range, or stale local offset must never be appended.
    let mut response = loop {
        let mut request = client
            .get(url.clone())
            .headers(headers.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request
                .header(header::RANGE, format!("bytes={offset}-"))
                .header(
                    header::IF_RANGE,
                    saved.as_ref().unwrap().validator.as_ref().unwrap(),
                );
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("failed to download update: {e}"))?;
        if offset > 0 && response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            offset = 0;
            continue;
        }
        if response.status() == StatusCode::OK {
            break response;
        }
        if offset > 0 && response.status() == StatusCode::PARTIAL_CONTENT {
            let range = response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(content_range);
            let valid = range.is_some_and(|(start, end, total)| {
                start == offset
                    && end + 1 == total
                    && response
                        .content_length()
                        .is_none_or(|n| n == end - start + 1)
                    && saved.as_ref().unwrap().total.is_none_or(|n| n == total)
            }) && validator(response.headers()) == saved.as_ref().unwrap().validator;
            if valid {
                break response;
            }
            offset = 0;
            continue;
        }
        return Err(format!(
            "unexpected update download response: {}",
            response.status()
        ));
    };
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|value| value != "identity")
    {
        return Err("encoded update downloads cannot be resumed safely".into());
    }
    let append = response.status() == StatusCode::PARTIAL_CONTENT;
    if !append {
        offset = 0;
    }
    let total = if append {
        response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(content_range)
            .map(|(_, _, total)| total)
    } else {
        response.content_length()
    };
    tracing::info!(
        event = "app_update.download", resumed_bytes = offset, total_bytes = ?total,
        "application update download started"
    );
    let metadata = ResumeMetadata {
        validator: validator(response.headers()),
        total,
    };
    // Synchronous writes avoid outstanding Tokio file operations after Abortable
    // drops this future. A later download can immediately trust the on-disk length.
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!append)
        .append(append)
        .open(partial)
        .map_err(|e| format!("failed to open partial update: {e}"))?;
    std::fs::write(
        &metadata_path,
        serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("failed to save update resume metadata: {e}"))?;
    on_progress(offset, total);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("failed to download update: {e}"))?
    {
        if total.is_some_and(|total| offset.saturating_add(chunk.len() as u64) > total) {
            return Err("update download exceeded advertised size".into());
        }
        file.write_all(&chunk)
            .map_err(|e| format!("failed to save partial update: {e}"))?;
        offset += chunk.len() as u64;
        on_progress(offset, total);
    }
    file.sync_all()
        .map_err(|e| format!("failed to flush downloaded update: {e}"))?;
    if total.is_some_and(|total| offset != total) {
        return Err("update download ended before the advertised size".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn server(responses: Vec<String>) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/package",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut byte = [0];
                    if socket.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8(request).unwrap().to_lowercase());
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });
        (url, task)
    }

    fn response(status: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n{body}")
    }

    fn seed(partial: &Path, validator: Option<&str>) {
        std::fs::write(partial, b"01234567").unwrap();
        std::fs::write(
            partial.with_extension("resume.json"),
            serde_json::to_vec(&ResumeMetadata {
                validator: validator.map(str::to_owned),
                total: Some(10),
            })
            .unwrap(),
        )
        .unwrap();
    }

    fn client() -> Client {
        Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn interrupted_download_resumes_with_new_client_and_reports_saved_bytes() {
        let (url, task) = server(vec![
            response(
                "200 OK",
                "Content-Length: 10\r\nETag: \"v1\"\r\n",
                "01234567",
            ),
            response(
                "206 Partial Content",
                "Content-Length: 2\r\nContent-Range: bytes 8-9/10\r\nETag: \"v1\"\r\n",
                "89",
            ),
        ])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        assert!(download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |_, _| {}
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&partial).unwrap(), b"01234567");
        let mut progress = Vec::new();
        download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |n, total| progress.push((n, total)),
        )
        .await
        .unwrap();
        assert_eq!(progress.first(), Some(&(8, Some(10))));
        assert_eq!(progress.last(), Some(&(10, Some(10))));
        assert_eq!(std::fs::read(&partial).unwrap(), b"0123456789");
        let requests = task.await.unwrap();
        assert!(!requests[0].contains("range:"));
        assert!(requests[1].contains("range: bytes=8-"));
        assert!(requests[1].contains("if-range: \"v1\""));
    }

    #[tokio::test]
    async fn server_ignoring_range_replaces_old_bytes() {
        let (url, task) = server(vec![response(
            "200 OK",
            "Content-Length: 10\r\nETag: \"v2\"\r\n",
            "abcdefghij",
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        seed(&partial, Some("\"v1\""));
        let mut progress = Vec::new();
        download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |n, _| progress.push(n),
        )
        .await
        .unwrap();
        assert_eq!(progress[0], 0);
        assert_eq!(std::fs::read(&partial).unwrap(), b"abcdefghij");
        assert!(task.await.unwrap()[0].contains("range: bytes=8-"));
    }

    #[tokio::test]
    async fn invalid_ranges_and_changed_validators_restart_without_appending() {
        for headers in [
            "Content-Length: 2\r\nContent-Range: bytes 8-9/10\r\nETag: \"v2\"\r\n",
            "Content-Length: 2\r\nContent-Range: bytes 7-8/10\r\nETag: \"v1\"\r\n",
            "Content-Length: 2\r\nContent-Range: bytes 8-9/11\r\nETag: \"v1\"\r\n",
        ] {
            let (url, task) = server(vec![
                response("206 Partial Content", headers, "XX"),
                response(
                    "200 OK",
                    "Content-Length: 10\r\nETag: \"v2\"\r\n",
                    "abcdefghij",
                ),
            ])
            .await;
            let temp = tempfile::tempdir().unwrap();
            let partial = temp.path().join("update.part");
            seed(&partial, Some("\"v1\""));
            download_to_file(
                &client(),
                &url,
                header::HeaderMap::new(),
                &partial,
                |_, _| {},
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read(&partial).unwrap(), b"abcdefghij");
            let requests = task.await.unwrap();
            assert!(requests[0].contains("range: bytes=8-"));
            assert!(!requests[1].contains("range:"));
        }
    }

    #[tokio::test]
    async fn unsatisfiable_range_restarts() {
        let (url, task) = server(vec![
            response("416 Range Not Satisfiable", "Content-Length: 0\r\n", ""),
            response("200 OK", "Content-Length: 3\r\nETag: \"v2\"\r\n", "new"),
        ])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        seed(&partial, Some("\"v1\""));
        download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&partial).unwrap(), b"new");
        assert!(!task.await.unwrap()[1].contains("range:"));
    }

    #[tokio::test]
    async fn missing_or_corrupt_metadata_and_missing_validator_restart() {
        for metadata in [
            None,
            Some("broken"),
            Some("{\"validator\":null,\"total\":10}"),
        ] {
            let (url, task) =
                server(vec![response("200 OK", "Content-Length: 3\r\n", "new")]).await;
            let temp = tempfile::tempdir().unwrap();
            let partial = temp.path().join("update.part");
            std::fs::write(&partial, b"old bytes").unwrap();
            if let Some(metadata) = metadata {
                std::fs::write(partial.with_extension("resume.json"), metadata).unwrap();
            }
            download_to_file(
                &client(),
                &url,
                header::HeaderMap::new(),
                &partial,
                |_, _| {},
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read(&partial).unwrap(), b"new");
            assert!(!task.await.unwrap()[0].contains("range:"));
        }
    }

    #[tokio::test]
    async fn transient_server_failure_preserves_partial_bytes() {
        let (url, task) = server(vec![response(
            "503 Service Unavailable",
            "Content-Length: 0\r\n",
            "",
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        seed(&partial, Some("\"v1\""));
        assert!(download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |_, _| {}
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&partial).unwrap(), b"01234567");
        task.await.unwrap();
    }
    #[tokio::test]
    async fn cancelling_download_keeps_written_bytes_for_next_attempt() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/package",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (release, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(
                    response(
                        "200 OK",
                        "Content-Length: 10\r\nETag: \"v1\"\r\n",
                        "01234567",
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let _ = wait.await;
        });
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        let http = client();
        let (written, received) = tokio::sync::oneshot::channel();
        let mut written = Some(written);
        let mut pending = Box::pin(download_to_file(
            &http,
            &url,
            header::HeaderMap::new(),
            &partial,
            |n, _| {
                if n == 8 {
                    if let Some(written) = written.take() {
                        let _ = written.send(());
                    }
                }
            },
        ));
        tokio::select! {
            result = &mut pending => panic!("download unexpectedly finished: {result:?}"),
            result = received => result.unwrap(),
        }
        drop(pending);
        release.send(()).unwrap();
        task.await.unwrap();
        assert_eq!(std::fs::read(&partial).unwrap(), b"01234567");
        let (url, task) = server(vec![response(
            "206 Partial Content",
            "Content-Length: 2\r\nContent-Range: bytes 8-9/10\r\nETag: \"v1\"\r\n",
            "89",
        )])
        .await;
        download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&partial).unwrap(), b"0123456789");
        assert!(task.await.unwrap()[0].contains("range: bytes=8-"));
    }

    #[tokio::test]
    async fn last_modified_supports_servers_without_strong_etags() {
        let (url, task) = server(vec![response("206 Partial Content", "Content-Length: 2\r\nContent-Range: bytes 8-9/10\r\nLast-Modified: Sun, 25 Oct 2026 15:54:47 GMT\r\n", "89")]).await;
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        seed(&partial, Some("Sun, 25 Oct 2026 15:54:47 GMT"));
        download_to_file(
            &client(),
            &url,
            header::HeaderMap::new(),
            &partial,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&partial).unwrap(), b"0123456789");
        assert!(task.await.unwrap()[0].contains("if-range: sun, 25 oct 2026 15:54:47 gmt"));
    }

    #[test]
    fn only_attempts_complete_partial_recovery_at_the_expected_size() {
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("update.part");
        assert!(!partial_may_be_complete(&partial));
        seed(&partial, Some("\"v1\""));
        assert!(!partial_may_be_complete(&partial));
        std::fs::write(&partial, b"0123456789").unwrap();
        assert!(partial_may_be_complete(&partial));
    }
}
