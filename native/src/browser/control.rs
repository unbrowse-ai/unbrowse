//! OpenClaw browser control API client

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

const DEFAULT_PORT: u16 = 18791;

/// Browser control client for OpenClaw/Clawdbot browser API
pub struct BrowserControl {
    port: u16,
    base_url: String,
}

impl BrowserControl {
    pub fn new(port: Option<u16>) -> Self {
        let port = port.unwrap_or(DEFAULT_PORT);
        Self {
            port,
            base_url: format!("http://127.0.0.1:{}", port),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

/// Check if browser is running
#[napi]
pub async fn browser_status(port: Option<u32>) -> Result<bool> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    match client.get(ctrl.url("/")).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// Start the browser
#[napi]
pub async fn browser_start(port: Option<u32>) -> Result<bool> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    match client.post(ctrl.url("/start")).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(e) => Err(Error::from_reason(format!("Failed to start browser: {}", e))),
    }
}

/// Navigate to a URL
#[napi]
pub async fn browser_navigate(url: String, port: Option<u32>) -> Result<bool> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let body = serde_json::json!({ "url": url });

    match client
        .post(ctrl.url("/navigate"))
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(e) => Err(Error::from_reason(format!("Navigation failed: {}", e))),
    }
}

/// Get page snapshot with interactive elements
#[napi]
pub async fn browser_snapshot(port: Option<u32>) -> Result<PageSnapshot> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let resp = client
        .get(ctrl.url("/snapshot?interactive=true"))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Snapshot failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Snapshot failed: {}",
            resp.status()
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse snapshot: {}", e)))?;

    let url = json
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let elements: Vec<PageElement> = json
        .get("elements")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    Some(PageElement {
                        index: e.get("index")?.as_i64()? as i32,
                        tag: e.get("tag")?.as_str()?.to_string(),
                        element_type: e.get("type").and_then(|v| v.as_str()).map(String::from),
                        role: e.get("role").and_then(|v| v.as_str()).map(String::from),
                        text: e.get("text").and_then(|v| v.as_str()).map(String::from),
                        placeholder: e
                            .get("placeholder")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        href: e.get("href").and_then(|v| v.as_str()).map(String::from),
                        value: e.get("value").and_then(|v| v.as_str()).map(String::from),
                        name: e.get("name").and_then(|v| v.as_str()).map(String::from),
                        aria_label: e
                            .get("ariaLabel")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(PageSnapshot {
        url,
        title,
        elements,
    })
}

/// Perform an action (click, type, select)
#[napi]
pub async fn browser_act(
    action: String,
    element_index: Option<i32>,
    text: Option<String>,
    port: Option<u32>,
) -> Result<bool> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let mut body = serde_json::json!({ "action": action });

    if let Some(idx) = element_index {
        body["element"] = serde_json::json!(idx);
    }
    if let Some(t) = text {
        body["text"] = serde_json::json!(t);
    }

    match client.post(ctrl.url("/act")).json(&body).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(e) => Err(Error::from_reason(format!("Action failed: {}", e))),
    }
}

/// Wait for a condition
#[napi]
pub async fn browser_wait(
    condition: String,
    timeout_ms: Option<i32>,
    port: Option<u32>,
) -> Result<bool> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let body = serde_json::json!({
        "condition": condition,
        "timeout": timeout_ms.unwrap_or(30000)
    });

    match client.post(ctrl.url("/wait")).json(&body).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(e) => Err(Error::from_reason(format!("Wait failed: {}", e))),
    }
}

/// Get captured requests from browser
#[napi]
pub async fn browser_get_requests(
    filter: Option<String>,
    clear: Option<bool>,
    port: Option<u32>,
) -> Result<Vec<BrowserRequest>> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let mut url = ctrl.url("/requests");
    let mut params = Vec::new();

    if let Some(f) = filter {
        params.push(format!("filter={}", urlencoding::encode(&f)));
    }
    if let Some(true) = clear {
        params.push("clear=true".to_string());
    }

    if !params.is_empty() {
        url = format!("{}?{}", url, params.join("&"));
    }

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to get requests: {}", e)))?;

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Failed to get requests: {}",
            resp.status()
        )));
    }

    let json: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse requests: {}", e)))?;

    let requests: Vec<BrowserRequest> = json
        .iter()
        .filter_map(|r| {
            Some(BrowserRequest {
                id: r.get("id")?.as_str()?.to_string(),
                method: r.get("method")?.as_str()?.to_string(),
                url: r.get("url")?.as_str()?.to_string(),
                headers: r
                    .get("headers")
                    .and_then(|h| serde_json::from_value(h.clone()).ok())
                    .unwrap_or_default(),
                body: r.get("body").and_then(|v| v.as_str()).map(String::from),
                status: r.get("status").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                response_body: r
                    .get("responseBody")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                response_headers: r
                    .get("responseHeaders")
                    .and_then(|h| serde_json::from_value(h.clone()).ok()),
            })
        })
        .collect();

    Ok(requests)
}

/// Get cookies from browser
#[napi]
pub async fn browser_get_cookies(port: Option<u32>) -> Result<HashMap<String, String>> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let resp = client
        .get(ctrl.url("/cookies"))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to get cookies: {}", e)))?;

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Failed to get cookies: {}",
            resp.status()
        )));
    }

    let cookies: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse cookies: {}", e)))?;

    let mut result: HashMap<String, String> = HashMap::new();
    for cookie in cookies {
        if let (Some(name), Some(value)) = (
            cookie.get("name").and_then(|v| v.as_str()),
            cookie.get("value").and_then(|v| v.as_str()),
        ) {
            result.insert(name.to_string(), value.to_string());
        }
    }

    Ok(result)
}

/// Get localStorage from browser
#[napi]
pub async fn browser_get_local_storage(port: Option<u32>) -> Result<HashMap<String, String>> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let resp = client
        .get(ctrl.url("/storage/local"))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to get localStorage: {}", e)))?;

    if !resp.status().is_success() {
        return Ok(HashMap::new());
    }

    resp.json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse localStorage: {}", e)))
}

/// Get sessionStorage from browser
#[napi]
pub async fn browser_get_session_storage(port: Option<u32>) -> Result<HashMap<String, String>> {
    let port = port.map(|p| p as u16);
    let client = reqwest::Client::new();
    let ctrl = BrowserControl::new(port);

    let resp = client
        .get(ctrl.url("/storage/session"))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to get sessionStorage: {}", e)))?;

    if !resp.status().is_success() {
        return Ok(HashMap::new());
    }

    resp.json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse sessionStorage: {}", e)))
}
