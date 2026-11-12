use super::update_download::{download_to_file, partial_may_be_complete};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::Update;

#[derive(Clone)]
pub(super) struct PreparedUpdate {
    update: Update,
    package_path: PathBuf,
    attempt_id: String,
}

/// Only this module can create a package. The bytes are immutable after verification.
pub(super) struct VerifiedUpdate {
    prepared: PreparedUpdate,
    bytes: Vec<u8>,
}

impl PreparedUpdate {
    pub(super) fn version(&self) -> &str {
        &self.update.version
    }

    pub(super) async fn read_verified(&self, app: &AppHandle) -> Result<VerifiedUpdate, String> {
        let bytes = tokio::fs::read(&self.package_path)
            .await
            .map_err(|e| format!("failed to read cached application update: {e}"))?;
        match VerifiedUpdate::verify(app, self.clone(), bytes) {
            Ok(package) => Ok(package),
            Err(error) => {
                let _ = tokio::fs::remove_file(&self.package_path).await;
                Err(error)
            }
        }
    }
}

impl VerifiedUpdate {
    fn verify(app: &AppHandle, prepared: PreparedUpdate, bytes: Vec<u8>) -> Result<Self, String> {
        verify_cached_package(app, &prepared.update, &bytes)?;
        Ok(Self { prepared, bytes })
    }

    pub(super) fn prepared(&self) -> PreparedUpdate {
        self.prepared.clone()
    }
    pub(super) fn version(&self) -> &str {
        self.prepared.version()
    }
    pub(super) fn attempt_id(&self) -> &str {
        &self.prepared.attempt_id
    }
    pub(super) fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(super) fn install(self) -> Result<(), String> {
        self.prepared
            .update
            .install(self.bytes)
            .map_err(|e| format!("failed to install update: {e}"))
    }
}

fn update_cache_location(app: &AppHandle, update: &Update) -> Result<PathBuf, String> {
    let mut hasher = Sha256::new();
    for value in [
        update.target.as_str(),
        update.version.as_str(),
        update.download_url.as_str(),
        update.signature.as_str(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    let mut package_key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(package_key, "{byte:02x}");
    }

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to locate application cache directory: {error}"))?
        .join("app-updates");
    Ok(directory.join(format!("update-{package_key}.bundle")))
}

fn verify_cached_package(app: &AppHandle, update: &Update, bytes: &[u8]) -> Result<(), String> {
    use base64::Engine as _;

    let encoded_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            "updater public key is missing from application configuration".to_string()
        })?;
    let key_text = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|error| format!("failed to decode updater public key: {error}"))?;
    let key_text = std::str::from_utf8(&key_text)
        .map_err(|error| format!("updater public key is not valid UTF-8: {error}"))?;
    let public_key = minisign_verify::PublicKey::decode(key_text)
        .map_err(|error| format!("failed to parse updater public key: {error}"))?;

    let signature_text = base64::engine::general_purpose::STANDARD
        .decode(&update.signature)
        .map_err(|error| format!("failed to decode update signature: {error}"))?;
    let signature_text = std::str::from_utf8(&signature_text)
        .map_err(|error| format!("update signature is not valid UTF-8: {error}"))?;
    let signature = minisign_verify::Signature::decode(signature_text)
        .map_err(|error| format!("failed to parse update signature: {error}"))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|error| format!("cached update signature verification failed: {error}"))
}

async fn remove_old_update_packages(directory: &std::path::Path, keep: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path != keep {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

pub(super) async fn prepare_update_package(
    app: &AppHandle,
    update: Update,
    report_progress: bool,
    attempt_id: String,
) -> Result<VerifiedUpdate, String> {
    let package_path = update_cache_location(app, &update)?;
    let prepared = PreparedUpdate {
        update,
        package_path: package_path.clone(),
        attempt_id,
    };
    let update = &prepared.update;
    let directory = package_path
        .parent()
        .ok_or_else(|| "application update cache path has no parent directory".to_string())?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("failed to create application update cache: {error}"))?;

    match tokio::fs::read(&package_path).await {
        Ok(bytes) => match VerifiedUpdate::verify(app, prepared.clone(), bytes) {
            Ok(package) => {
                remove_old_update_packages(directory, &package_path).await;
                return Ok(package);
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&package_path).await;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("failed to read cached application update: {error}"));
        }
    }

    let partial_path = package_path.with_extension("part");
    let metadata_path = partial_path.with_extension("resume.json");
    // An exit after the last byte but before publication needs no new request.
    let resumed = if partial_may_be_complete(&partial_path) {
        tokio::fs::read(&partial_path)
            .await
            .ok()
            .and_then(|bytes| VerifiedUpdate::verify(app, prepared.clone(), bytes).ok())
    } else {
        None
    };
    let package = if let Some(package) = resumed {
        package
    } else {
        let mut builder = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(10 * 60))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .user_agent(concat!("Flowix/", env!("CARGO_PKG_VERSION")));
        if update.no_proxy {
            builder = builder.no_proxy();
        } else if let Some(proxy) = &update.proxy {
            builder =
                builder.proxy(reqwest::Proxy::all(proxy.as_str()).map_err(|e| e.to_string())?);
        }
        let client = builder
            .build()
            .map_err(|e| format!("failed to configure update download: {e}"))?;
        let mut last_progress = Instant::now();
        let mut started = false;
        download_to_file(&client, &update.download_url, update.headers.clone(), &partial_path, |downloaded, total| {
            if !report_progress { return; }
            if !started {
                started = true;
                let _ = app.emit("app-update-progress", json!({ "phase": "started", "contentLength": total }));
            } else if last_progress.elapsed() < Duration::from_millis(150) && Some(downloaded) != total {
                return;
            }
            last_progress = Instant::now();
            let _ = app.emit("app-update-progress", json!({
                "phase": "progress", "downloadedBytes": downloaded, "contentLength": total,
            }));
        }).await.map_err(|error| {
            tracing::warn!(event = "app_update.download_failed", version = %update.version, %error, "application update download failed; partial file retained");
            error
        })?;
        let bytes = tokio::fs::read(&partial_path)
            .await
            .map_err(|e| format!("failed to read downloaded application update: {e}"))?;
        match VerifiedUpdate::verify(app, prepared.clone(), bytes) {
            Ok(package) => package,
            Err(error) => {
                tracing::warn!(event = "app_update.verification_failed", version = %update.version, %error, "discarding invalid application update");
                let _ = tokio::fs::remove_file(&partial_path).await;
                let _ = tokio::fs::remove_file(&metadata_path).await;
                return Err(error);
            }
        }
    };
    tokio::fs::rename(&partial_path, &package_path)
        .await
        .map_err(|e| format!("failed to publish cached application update: {e}"))?;
    let _ = tokio::fs::remove_file(&metadata_path).await;
    if report_progress {
        let _ = app.emit(
            "app-update-progress",
            json!({ "phase": "finished", "downloadedBytes": package.len() }),
        );
    }
    remove_old_update_packages(directory, &package_path).await;

    Ok(package)
}
