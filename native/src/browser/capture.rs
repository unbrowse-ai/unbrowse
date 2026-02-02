//! Network capture from browser - converts to HAR format

use crate::parser::parse_har;
use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

/// Convert browser requests to HAR format
fn requests_to_har(requests: &[BrowserRequest]) -> Har {
    let entries: Vec<HarEntry> = requests
        .iter()
        .map(|req| {
            let request_headers: Vec<HarHeader> = req
                .headers
                .iter()
                .map(|(k, v)| HarHeader {
                    name: k.clone(),
                    value: v.clone(),
                })
                .collect();

            let response_headers: Vec<HarHeader> = req
                .response_headers
                .as_ref()
                .map(|h| {
                    h.iter()
                        .map(|(k, v)| HarHeader {
                            name: k.clone(),
                            value: v.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();

            HarEntry {
                request: HarRequest {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    headers: request_headers,
                    cookies: None,
                    post_data: req.body.as_ref().map(|b| HarPostData {
                        mime_type: Some("application/json".to_string()),
                        text: Some(b.clone()),
                    }),
                },
                response: HarResponse {
                    status: req.status,
                    headers: response_headers,
                    content: req.response_body.as_ref().map(|b| HarContent {
                        size: Some(b.len() as i64),
                        mime_type: Some("application/json".to_string()),
                        text: Some(b.clone()),
                    }),
                },
                started_date_time: None,
                time: None,
            }
        })
        .collect();

    Har {
        log: HarLog { entries },
    }
}

/// Capture API traffic from browser and parse into ApiData
#[napi]
pub async fn capture_from_browser(
    seed_url: Option<String>,
    filter: Option<String>,
    clear: Option<bool>,
    port: Option<u32>,
) -> Result<ApiData> {
    // Get requests from browser
    let requests = super::browser_get_requests(filter, clear, port).await?;

    if requests.is_empty() {
        return Err(Error::from_reason("No requests captured from browser"));
    }

    // Convert to HAR
    let har = requests_to_har(&requests);
    let har_json = serde_json::to_string(&har)
        .map_err(|e| Error::from_reason(format!("Failed to serialize HAR: {}", e)))?;

    // Parse HAR
    parse_har(har_json, seed_url)
}

/// Capture and generate skill in one operation
#[napi]
pub async fn capture_and_generate_skill(
    seed_url: String,
    output_dir: Option<String>,
    port: Option<u32>,
) -> Result<SkillResult> {
    // Capture API data
    let api_data = capture_from_browser(Some(seed_url), Some("api".to_string()), Some(true), port).await?;

    // Generate skill
    crate::skill::generate_skill(api_data, output_dir, None)
}

/// Visit URLs and capture API traffic
#[napi]
pub async fn capture_from_urls(
    urls: Vec<String>,
    port: Option<u32>,
) -> Result<ApiData> {
    use super::{browser_navigate, browser_get_requests, browser_status, browser_start};

    // Ensure browser is running
    if !browser_status(port).await? {
        browser_start(port).await?;
        // Wait for browser to start
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }

    // Visit each URL
    for url in &urls {
        browser_navigate(url.clone(), port).await?;
        // Wait for page to load and make API calls
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    }

    // Capture requests
    let seed_url = urls.first().cloned();
    capture_from_browser(seed_url, Some("api".to_string()), Some(true), port).await
}

/// Extract auth from current browser session
#[napi]
pub async fn extract_browser_auth(
    domain: String,
    port: Option<u32>,
) -> Result<AuthJson> {
    use super::{browser_get_cookies, browser_get_requests};

    // Get cookies
    let cookies = browser_get_cookies(port).await?;

    // Get recent requests to extract headers
    let requests = browser_get_requests(Some(domain.clone()), None, port).await?;

    // Find auth headers from requests
    let mut auth_headers: HashMap<String, String> = HashMap::new();
    for req in &requests {
        for (key, value) in &req.headers {
            let lower = key.to_lowercase();
            if crate::parser::filters::is_auth_like_header(&lower) {
                auth_headers.insert(key.clone(), value.clone());
            }
        }
    }

    // Determine base URL and service
    let base_url = if domain.starts_with("http") {
        domain.clone()
    } else {
        format!("https://{}", domain)
    };
    let service = crate::parser::filters::derive_service_name(&domain);

    // Detect auth method
    let auth_method = crate::parser::detect_auth_method(auth_headers.clone(), cookies.clone());

    Ok(AuthJson {
        service,
        base_url,
        auth_method,
        headers: if auth_headers.is_empty() {
            None
        } else {
            Some(auth_headers)
        },
        cookies: if cookies.is_empty() { None } else { Some(cookies) },
        context: None,
        refresh: None,
    })
}
