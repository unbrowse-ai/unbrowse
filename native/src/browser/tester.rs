//! Endpoint testing - validate discovered endpoints

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::time::Instant;

/// Analyze response shape
fn analyze_response_shape(body: &str) -> String {
    if body.trim().is_empty() {
        return "empty".to_string();
    }

    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(json) => {
            if let Some(arr) = json.as_array() {
                format!("array[{}]", arr.len())
            } else if let Some(obj) = json.as_object() {
                let fields: Vec<&str> = obj.keys().map(|k| k.as_str()).take(5).collect();
                if obj.keys().len() > 5 {
                    format!("object{{{},...}}", fields.join(","))
                } else {
                    format!("object{{{}}}", fields.join(","))
                }
            } else {
                "json-primitive".to_string()
            }
        }
        Err(_) => {
            if body.contains("<!DOCTYPE") || body.contains("<html") {
                "html".to_string()
            } else {
                "text".to_string()
            }
        }
    }
}

/// Test a single endpoint
#[napi]
pub async fn test_endpoint(
    base_url: String,
    method: String,
    path: String,
    auth_headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
    timeout_ms: Option<i32>,
) -> Result<EndpointTestResult> {
    let url = format!("{}{}", base_url, path);
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000) as u64);

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| Error::from_reason(format!("Failed to create client: {}", e)))?;

    // Build request
    let mut req = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    // Add auth headers
    for (key, value) in &auth_headers {
        req = req.header(key, value);
    }

    // Add cookies
    if !cookies.is_empty() {
        let cookie_str: String = cookies
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("; ");
        req = req.header("Cookie", cookie_str);
    }

    let start = Instant::now();

    match req.send().await {
        Ok(resp) => {
            let latency_ms = start.elapsed().as_millis() as i64;
            let status = resp.status().as_u16() as i32;

            let body = resp.text().await.unwrap_or_default();
            let response_size = body.len() as i64;
            let response_shape = analyze_response_shape(&body);

            Ok(EndpointTestResult {
                url,
                method,
                status,
                latency_ms,
                response_shape: Some(response_shape),
                response_size: Some(response_size),
                error: None,
            })
        }
        Err(e) => {
            let latency_ms = start.elapsed().as_millis() as i64;

            Ok(EndpointTestResult {
                url,
                method,
                status: 0,
                latency_ms,
                response_shape: Some("error".to_string()),
                response_size: None,
                error: Some(e.to_string()),
            })
        }
    }
}

/// Test multiple GET endpoints
#[napi]
pub async fn test_get_endpoints(
    base_url: String,
    endpoints: Vec<EndpointInfo>,
    auth_headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
    concurrency: Option<i32>,
    timeout_ms: Option<i32>,
) -> Result<Vec<EndpointTestResult>> {
    let _concurrency = concurrency.unwrap_or(3) as usize;

    // Filter to GET endpoints only
    let get_endpoints: Vec<&EndpointInfo> = endpoints
        .iter()
        .filter(|e| e.method == "GET")
        .collect();

    let mut results: Vec<EndpointTestResult> = Vec::new();

    // Test sequentially for now (could parallelize with tokio::spawn)
    for ep in get_endpoints {
        let result = test_endpoint(
            base_url.clone(),
            ep.method.clone(),
            ep.path.clone(),
            auth_headers.clone(),
            cookies.clone(),
            timeout_ms,
        )
        .await?;
        results.push(result);
    }

    Ok(results)
}

/// Validate auth by testing a known endpoint
#[napi]
pub async fn validate_auth(
    base_url: String,
    test_path: Option<String>,
    auth_headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
) -> Result<bool> {
    let path = test_path.unwrap_or_else(|| "/".to_string());

    let result = test_endpoint(
        base_url,
        "GET".to_string(),
        path,
        auth_headers,
        cookies,
        Some(10000),
    )
    .await?;

    // Consider auth valid if we get a 2xx or 3xx response
    Ok(result.status >= 200 && result.status < 400)
}
