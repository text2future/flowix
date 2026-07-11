use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::runtime_log;

const DEFAULT_UPDATE_NOTICE_ENDPOINT: &str =
    "https://fqvruyesgivjlwhojyya.supabase.co/functions/v1/product-update-notices";
const DEFAULT_SUPABASE_ANON_KEY: &str =
    "sb_publishable_l6AmH0K0Uq8_roThQHSnnQ_2xxxl0o1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInfo {
    pub product_name: &'static str,
    pub version: &'static str,
    pub config_dir: String,
    pub data_dir: String,
    pub log_dir: String,
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUpdateNotice {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub cta_url: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUpdateNoticeResponse {
    #[serde(default)]
    pub notice: Option<ProductUpdateNotice>,
}

fn update_notice_endpoint() -> Option<String> {
    std::env::var("FLOWIX_PRODUCT_UPDATES_URL")
        .ok()
        .or_else(|| option_env!("FLOWIX_PRODUCT_UPDATES_URL").map(str::to_string))
        .or_else(|| Some(DEFAULT_UPDATE_NOTICE_ENDPOINT.to_string()))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn supabase_anon_key() -> Option<String> {
    std::env::var("FLOWIX_SUPABASE_ANON_KEY")
        .ok()
        .or_else(|| option_env!("FLOWIX_SUPABASE_ANON_KEY").map(str::to_string))
        .or_else(|| Some(DEFAULT_SUPABASE_ANON_KEY.to_string()))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn product_info() -> ProductInfo {
    ProductInfo {
        product_name: runtime_log::PRODUCT_NAME,
        version: runtime_log::APP_VERSION,
        config_dir: runtime_log::user_config_dir().display().to_string(),
        data_dir: runtime_log::app_data_dir().display().to_string(),
        log_dir: runtime_log::log_dir().display().to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[tauri::command]
pub fn get_product_info() -> ProductInfo {
    product_info()
}

#[tauri::command]
pub fn get_diagnostics() -> String {
    let info = product_info();
    format!(
        "Product: {}\nVersion: {}\nOS: {}\nArch: {}\nConfig dir: {}\nData dir: {}\nLog dir: {}",
        info.product_name,
        info.version,
        info.os,
        info.arch,
        info.config_dir,
        info.data_dir,
        info.log_dir
    )
}

#[tauri::command]
pub async fn check_product_update_notice(
    language: Option<String>,
    region: Option<String>,
) -> Result<Option<ProductUpdateNotice>, String> {
    let Some(endpoint) = update_notice_endpoint() else {
        return Ok(None);
    };
    let mut url = reqwest::Url::parse(&endpoint).map_err(|err| err.to_string())?;
    {
        let info = product_info();
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("version", info.version);
        pairs.append_pair("os", info.os);
        pairs.append_pair("arch", info.arch);
        pairs.append_pair("channel", "stable");
        if let Some(language) = language.as_deref().filter(|value| !value.trim().is_empty()) {
            pairs.append_pair("language", language);
        }
        if let Some(region) = region.as_deref().filter(|value| !value.trim().is_empty()) {
            pairs.append_pair("region", region);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|err| err.to_string())?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");

    if let Some(key) = supabase_anon_key() {
        request = request.header("apikey", key.as_str()).bearer_auth(key);
    }

    let response = request.send().await.map_err(|err| err.to_string())?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "update notice request failed: {}",
            response.status()
        ));
    }

    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|err| err.to_string())?;
    if value.is_null() {
        return Ok(None);
    }
    if value.get("notice").is_some() {
        let parsed: ProductUpdateNoticeResponse =
            serde_json::from_value(value).map_err(|err| err.to_string())?;
        return Ok(parsed.notice);
    }
    let notice: ProductUpdateNotice =
        serde_json::from_value(value).map_err(|err| err.to_string())?;
    Ok(Some(notice))
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = runtime_log::ensure_log_dir().map_err(|err| err.to_string())?;
    runtime_log::record_event("info", "logs.opened", "User opened the log directory");
    app.opener()
        .open_path(dir.display().to_string(), None::<String>)
        .map_err(|err| err.to_string())
}
