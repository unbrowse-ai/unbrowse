//! Auth method detection and auth.json generation

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

/// Generate auth.json content from parsed API data
#[napi]
pub fn generate_auth_json(
    service: String,
    base_url: String,
    auth_method: String,
    auth_headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
    auth_info: HashMap<String, String>,
) -> Result<AuthJson> {
    // Separate headers into auth headers and context headers
    let mut headers: HashMap<String, String> = HashMap::new();
    let mut context: HashMap<String, String> = HashMap::new();

    // Context header patterns
    let context_patterns = [
        "outletid", "userid", "supplierid", "companyid", "tenantid",
        "organizationid", "accountid", "workspaceid", "projectid",
    ];

    for (key, value) in &auth_headers {
        let lower = key.to_lowercase();
        if context_patterns.iter().any(|p| lower.contains(p)) {
            context.insert(key.clone(), value.clone());
        } else {
            headers.insert(key.clone(), value.clone());
        }
    }

    // Extract context from auth_info (request headers)
    for (key, value) in &auth_info {
        if key.starts_with("request_header_") {
            let header_name = key.strip_prefix("request_header_").unwrap_or(key);
            let lower = header_name.to_lowercase();
            if context_patterns.iter().any(|p| lower.contains(p)) {
                context.insert(header_name.to_string(), value.clone());
            }
        }
    }

    // Handle Mudra token specially (extract userId)
    if let Some(mudra) = auth_headers.get("mudra").or(auth_headers.get("Mudra")) {
        if let Some(sep_pos) = mudra.find("--") {
            let user_id = &mudra[..sep_pos];
            context.insert("userId".to_string(), user_id.to_string());
        }
    }

    // Filter cookies to only include auth-relevant ones
    let auth_cookie_patterns = [
        "session", "token", "auth", "jwt", "access", "refresh",
        "csrf", "xsrf", "sid", "id_token",
    ];
    let filtered_cookies: HashMap<String, String> = cookies
        .into_iter()
        .filter(|(name, _)| {
            let lower = name.to_lowercase();
            auth_cookie_patterns.iter().any(|p| lower.contains(p))
        })
        .collect();

    Ok(AuthJson {
        service,
        base_url,
        auth_method,
        headers: if headers.is_empty() { None } else { Some(headers) },
        cookies: if filtered_cookies.is_empty() { None } else { Some(filtered_cookies) },
        context: if context.is_empty() { None } else { Some(context) },
        refresh: None,
    })
}

/// Extract only publishable auth info (no secrets)
#[napi]
pub fn extract_publishable_auth(auth_json: String) -> Result<String> {
    let auth: AuthJson = serde_json::from_str(&auth_json)
        .map_err(|e| Error::from_reason(format!("Invalid auth.json: {}", e)))?;

    // Only keep service, base_url, auth_method
    let publishable = serde_json::json!({
        "service": auth.service,
        "baseUrl": auth.base_url,
        "authMethod": auth.auth_method,
    });

    serde_json::to_string_pretty(&publishable)
        .map_err(|e| Error::from_reason(format!("Failed to serialize: {}", e)))
}

/// Detect refresh endpoint from HAR traffic
#[napi]
pub fn detect_refresh_endpoint(
    url: String,
    method: String,
    request_body: Option<String>,
    response_body: Option<String>,
) -> Option<RefreshConfig> {
    let url_lower = url.to_lowercase();

    // URL patterns that indicate token refresh
    let refresh_url_patterns = [
        "/oauth/token",
        "/oauth2/v1/token",
        "/oauth2/v2/token",
        "/oauth2/v3/token",
        "/oauth2/v4/token",
        "/auth/refresh",
        "/auth/token/refresh",
        "/token/refresh",
        "/refresh",
        "/api/auth/refresh",
        "/api/token/refresh",
        "/securetoken.googleapis.com",
        "/v1/token",
        "/v2/token",
    ];

    let is_refresh_url = refresh_url_patterns.iter().any(|p| url_lower.contains(p));

    // Check request body for refresh patterns
    let has_refresh_grant = request_body.as_ref().map_or(false, |body| {
        let lower = body.to_lowercase();
        lower.contains("grant_type=refresh_token")
            || lower.contains("\"grant_type\":\"refresh_token\"")
            || lower.contains("refresh_token=")
    });

    if !is_refresh_url && !has_refresh_grant {
        return None;
    }

    // Parse response to find token info
    let (token_path, expires_in) = if let Some(ref body) = response_body {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
            let token_path = if json.get("access_token").is_some() {
                Some("access_token".to_string())
            } else if json.get("token").is_some() {
                Some("token".to_string())
            } else if json.get("id_token").is_some() {
                Some("id_token".to_string())
            } else {
                None
            };

            let expires_in = json.get("expires_in")
                .and_then(|v| v.as_i64())
                .or_else(|| json.get("expiresIn").and_then(|v| v.as_i64()));

            (token_path, expires_in)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    // Parse request body to extract body template
    let body_template = if let Some(ref body) = request_body {
        if body.contains('=') && !body.starts_with('{') {
            // URL-encoded form
            let mut params: HashMap<String, String> = HashMap::new();
            for pair in body.split('&') {
                if let Some((key, value)) = pair.split_once('=') {
                    // Mask actual tokens
                    let masked_value = if key.to_lowercase().contains("token") {
                        "${refreshToken}".to_string()
                    } else {
                        value.to_string()
                    };
                    params.insert(key.to_string(), masked_value);
                }
            }
            Some(params)
        } else {
            None
        }
    } else {
        None
    };

    Some(RefreshConfig {
        endpoint: url,
        method,
        body: body_template,
        token_path,
        expires_in,
    })
}

/// Extract refresh config from full HAR data
#[napi]
pub fn extract_refresh_config(
    har_json: String,
    auth_headers: HashMap<String, String>,
) -> Option<RefreshConfig> {
    let har: Har = match serde_json::from_str(&har_json) {
        Ok(h) => h,
        Err(_) => return None,
    };

    for entry in &har.log.entries {
        let request_body = entry.request.post_data.as_ref().and_then(|pd| pd.text.clone());
        let response_body = entry.response.content.as_ref().and_then(|c| c.text.clone());

        if let Some(config) = detect_refresh_endpoint(
            entry.request.url.clone(),
            entry.request.method.clone(),
            request_body,
            response_body,
        ) {
            return Some(config);
        }
    }

    None
}
