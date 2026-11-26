//! One-shot probe: replicate the prod app's login request exactly (same
//! reqwest defaults, no UA, same timeout) and print the raw response, so the
//! "cloud service unavailable" toast can be traced to the wire.

use serde_json::json;

#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("client");
    let response = client
        .post("https://cloud.flowix.cc/v1/auth/login")
        .json(&json!({
            "email": "prod-probe@example.com",
            "password": "not-a-real-password",
        }))
        .send()
        .await;
    match response {
        Ok(response) => {
            println!("status: {}", response.status());
            for (name, value) in response.headers() {
                println!("header {name}: {:?}", value);
            }
            match response.text().await {
                Ok(body) => println!(
                    "body (first 400 bytes): {}",
                    body.chars().take(400).collect::<String>()
                ),
                Err(error) => println!("body read failed: {error}"),
            }
        }
        Err(error) => {
            println!("transport error: {error}");
            println!("is_connect={} is_timeout={} source: {:?}",
                error.is_connect(), error.is_timeout(), std::error::Error::source(&error));
        }
    }
}
