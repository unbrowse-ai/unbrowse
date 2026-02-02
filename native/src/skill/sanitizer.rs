//! Skill sanitization for publishing - strips credentials

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;

/// Sanitize api.ts template by replacing token values with placeholders
#[napi]
pub fn sanitize_api_template(api_ts: String) -> String {
    let mut result = api_ts;

    // Replace Bearer tokens
    let bearer_re = Regex::new(r#"Bearer\s+[A-Za-z0-9\-_\.]+[A-Za-z0-9\-_\.]+"#).unwrap();
    result = bearer_re.replace_all(&result, "Bearer ${TOKEN}").to_string();

    // Replace API keys (common patterns)
    let api_key_re = Regex::new(r#"["']([A-Za-z0-9]{20,})["']"#).unwrap();
    result = api_key_re.replace_all(&result, "\"${API_KEY}\"").to_string();

    // Replace hardcoded URLs with baseUrl reference
    let url_re = Regex::new(r#"https?://[a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}(?:/[^\s"']*)?(?=["'])"#).unwrap();

    // Don't replace the baseUrl assignment itself
    let lines: Vec<&str> = result.lines().collect();
    let mut new_lines: Vec<String> = Vec::new();

    for line in lines {
        if line.contains("this.baseUrl") || line.contains("baseUrl:") || line.contains("baseUrl =") {
            new_lines.push(line.to_string());
        } else {
            new_lines.push(url_re.replace_all(line, "${baseUrl}").to_string());
        }
    }

    new_lines.join("\n")
}

/// Extract endpoints list from SKILL.md content
#[napi]
pub fn extract_endpoints(skill_md: String) -> Vec<EndpointInfo> {
    let mut endpoints: Vec<EndpointInfo> = Vec::new();

    // Pattern: ### `METHOD /path`
    let endpoint_re = Regex::new(r"###\s+`(\w+)\s+([^`]+)`").unwrap();

    for cap in endpoint_re.captures_iter(&skill_md) {
        let method = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let path = cap.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();

        if !method.is_empty() && !path.is_empty() {
            endpoints.push(EndpointInfo {
                method,
                path,
                description: None,
                response_type: None,
            });
        }
    }

    endpoints
}

/// Merge new endpoints with existing ones (never lose endpoints)
#[napi]
pub fn merge_endpoints(existing: Vec<EndpointInfo>, new: Vec<EndpointInfo>) -> Vec<EndpointInfo> {
    use std::collections::HashSet;

    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<EndpointInfo> = Vec::new();

    // Add existing first
    for ep in existing {
        let key = format!("{}:{}", ep.method, ep.path);
        if !seen.contains(&key) {
            seen.insert(key);
            result.push(ep);
        }
    }

    // Add new ones that don't exist
    for ep in new {
        let key = format!("{}:{}", ep.method, ep.path);
        if !seen.contains(&key) {
            seen.insert(key);
            result.push(ep);
        }
    }

    // Sort by method then path
    result.sort_by(|a, b| {
        let method_order = |m: &str| match m {
            "GET" => 0,
            "POST" => 1,
            "PUT" => 2,
            "PATCH" => 3,
            "DELETE" => 4,
            _ => 5,
        };
        method_order(&a.method)
            .cmp(&method_order(&b.method))
            .then(a.path.cmp(&b.path))
    });

    result
}

/// Prepare skill for publishing (strip all secrets)
#[napi]
pub fn prepare_for_publish(
    skill_md: String,
    api_ts: Option<String>,
    auth_json: String,
) -> Result<PublishPayload> {
    // Extract service from SKILL.md
    let service_re = Regex::new(r"\*\*Service\*\*:\s*(\S+)").unwrap();
    let service = service_re
        .captures(&skill_md)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    // Extract base URL
    let base_url_re = Regex::new(r"\*\*Base URL\*\*:\s*(\S+)").unwrap();
    let base_url = base_url_re
        .captures(&skill_md)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "https://api.example.com".to_string());

    // Extract auth method
    let auth_method_re = Regex::new(r"\*\*Auth Method\*\*:\s*(.+)").unwrap();
    let auth_method = auth_method_re
        .captures(&skill_md)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Extract endpoints
    let endpoints = extract_endpoints(skill_md.clone());

    // Sanitize api.ts if present
    let sanitized_api_ts = api_ts.map(sanitize_api_template);

    Ok(PublishPayload {
        service,
        skill_md,
        api_ts: sanitized_api_ts,
        reference_md: None,
        auth_method,
        base_url,
        endpoints,
        description: None,
        tags: None,
        price_usdc: None,
    })
}
