//! HAR file parsing and API endpoint extraction

use crate::parser::filters::*;
use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};
use url::Url;

/// Get response content-type from HAR entry
fn get_response_content_type(entry: &HarEntry) -> Option<String> {
    for header in &entry.response.headers {
        if header.name.to_lowercase() == "content-type" {
            return Some(header.value.clone());
        }
    }
    None
}

/// Guess auth method from headers and cookies
fn guess_auth_method(
    auth_headers: &HashMap<String, String>,
    cookies: &HashMap<String, String>,
) -> String {
    let header_names: Vec<String> = auth_headers.keys().map(|h| h.to_lowercase()).collect();
    let header_values: Vec<&String> = auth_headers.values().collect();

    // Check for Bearer token
    for value in &header_values {
        if value.to_lowercase().starts_with("bearer ") {
            return "Bearer Token".to_string();
        }
    }

    // API Key variants
    let api_key_headers: Vec<&String> = header_names
        .iter()
        .filter(|h| h.contains("api-key") || h.contains("apikey") || *h == "x-api-key" || *h == "x-key")
        .collect();
    if !api_key_headers.is_empty() {
        return format!("API Key ({})", api_key_headers[0]);
    }

    // JWT variants
    let jwt_headers: Vec<&String> = header_names
        .iter()
        .filter(|h| h.contains("jwt") || h.contains("id-token") || h.contains("id_token"))
        .collect();
    if !jwt_headers.is_empty() {
        return format!("JWT ({})", jwt_headers[0]);
    }

    // Standard Authorization header
    if header_names.contains(&"authorization".to_string()) {
        if let Some(auth_value) = auth_headers.get("authorization").or(auth_headers.get("Authorization")) {
            let lower = auth_value.to_lowercase();
            if lower.starts_with("basic ") {
                return "Basic Auth".to_string();
            }
            if lower.starts_with("digest ") {
                return "Digest Auth".to_string();
            }
            return "Authorization Header".to_string();
        }
    }

    // Session/CSRF tokens
    let session_headers: Vec<&String> = header_names
        .iter()
        .filter(|h| h.contains("session") || h.contains("csrf") || h.contains("xsrf"))
        .collect();
    if !session_headers.is_empty() {
        return format!("Session Token ({})", session_headers[0]);
    }

    // AWS specific
    if header_names.iter().any(|h| h.contains("amz")) {
        return "AWS Signature".to_string();
    }

    // Mudra token (Zeemart-specific)
    if auth_headers.contains_key("mudra") {
        return "Mudra Token".to_string();
    }

    // OAuth tokens
    let oauth_headers: Vec<&String> = header_names.iter().filter(|h| h.contains("oauth")).collect();
    if !oauth_headers.is_empty() {
        return format!("OAuth ({})", oauth_headers[0]);
    }

    // Generic auth/token headers
    let auth_token_headers: Vec<&String> = header_names
        .iter()
        .filter(|h| h.contains("auth") || h.contains("token"))
        .collect();
    if !auth_token_headers.is_empty() {
        return format!("Custom Token ({})", auth_token_headers[0]);
    }

    // Custom x-* headers
    let custom_headers: Vec<&String> = header_names.iter().filter(|h| h.starts_with("x-")).collect();
    if !custom_headers.is_empty() {
        return format!("Custom Header ({})", custom_headers[0]);
    }

    // Cookie-based auth
    let auth_cookie_names = [
        "session", "sessionid", "token", "authtoken", "jwt", "auth",
        "access_token", "accesstoken", "id_token", "refresh_token",
    ];
    for name in auth_cookie_names {
        if cookies.keys().any(|c| c.to_lowercase() == name) {
            return format!("Cookie-based ({})", name);
        }
    }

    // Any auth-like cookie
    let auth_cookies: Vec<&String> = cookies
        .keys()
        .filter(|c| {
            let lower = c.to_lowercase();
            lower.contains("auth") || lower.contains("token") || lower.contains("session")
        })
        .collect();
    if !auth_cookies.is_empty() {
        return format!("Cookie-based ({})", auth_cookies[0]);
    }

    "Unknown (may need login)".to_string()
}

/// Parse a HAR file into structured API data.
///
/// This is the main entry point for HAR parsing. It filters out static assets
/// and third-party domains, extracts auth headers/cookies, groups endpoints,
/// and determines the service name.
#[napi]
pub fn parse_har(har_json: String, seed_url: Option<String>) -> Result<ApiData> {
    let har: Har = serde_json::from_str(&har_json)
        .map_err(|e| Error::from_reason(format!("Failed to parse HAR JSON: {}", e)))?;

    let mut requests: Vec<ParsedRequest> = Vec::new();
    let mut auth_headers: HashMap<String, String> = HashMap::new();
    let mut cookies: HashMap<String, String> = HashMap::new();
    let mut auth_info: HashMap<String, String> = HashMap::new();
    let mut base_urls: HashSet<String> = HashSet::new();
    let mut target_domains: HashSet<String> = HashSet::new();

    // Extract seed domain if provided
    let (seed_domain, seed_base_url) = if let Some(ref url) = seed_url {
        if let Ok(parsed) = Url::parse(url) {
            (
                parsed.host_str().map(String::from),
                Some(format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""))),
            )
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    for entry in &har.log.entries {
        let url_str = &entry.request.url;
        let method = &entry.request.method;
        let response_status = entry.response.status;
        let response_content_type = get_response_content_type(entry);

        // Skip static assets
        if is_static_asset(url_str) {
            continue;
        }

        let parsed = match Url::parse(url_str) {
            Ok(u) => u,
            Err(_) => continue,
        };

        let domain = match parsed.host_str() {
            Some(h) => h.to_string(),
            None => continue,
        };

        // Skip third-party
        if is_skipped_domain(&domain) {
            continue;
        }

        // Skip HTML page navigations
        if method == "GET" {
            if let Some(ref ct) = response_content_type {
                if is_html_content_type(ct) {
                    continue;
                }
            }
        }

        // Check if related to seed domain
        let is_seed_related = seed_domain
            .as_ref()
            .map(|sd| is_same_root_domain(&domain, sd))
            .unwrap_or(false);

        // Only keep API-like requests
        let is_target_domain = target_domains.contains(&domain) || is_seed_related;
        if !is_api_like(url_str, method, &domain, response_content_type.as_deref())
            && !target_domains.is_empty()
            && !is_target_domain
        {
            continue;
        }

        target_domains.insert(domain.clone());
        base_urls.insert(format!("{}://{}", parsed.scheme(), domain));

        // Extract auth headers
        for header in &entry.request.headers {
            let name = header.name.to_lowercase();
            let value = &header.value;

            if is_http2_pseudo_header(&name) {
                continue;
            }

            if is_auth_like_header(&name) {
                auth_headers.insert(name.clone(), value.clone());
                auth_info.insert(format!("request_header_{}", name), value.clone());
            }

            if CONTEXT_HEADER_NAMES.contains(name.as_str()) {
                auth_info.insert(format!("request_header_{}", name), value.clone());
            }

            if name.starts_with("x-") && !is_standard_header(&name) && !value.is_empty() {
                auth_info
                    .entry(format!("request_header_{}", name))
                    .or_insert_with(|| value.clone());
            }
        }

        // Extract request cookies
        if let Some(ref entry_cookies) = entry.request.cookies {
            for cookie in entry_cookies {
                cookies.insert(cookie.name.clone(), cookie.value.clone());
                auth_info.insert(
                    format!("request_cookie_{}", cookie.name),
                    cookie.value.clone(),
                );
            }
        }

        // Extract response set-cookie (DO NOT split on commas - dates contain commas!)
        for header in &entry.response.headers {
            if header.name.to_lowercase() == "set-cookie" {
                let cookie_str = &header.value;
                if let Some(eq_pos) = cookie_str.find('=') {
                    let cookie_name = cookie_str[..eq_pos].trim();
                    let rest = &cookie_str[eq_pos + 1..];
                    let cookie_value = if let Some(semi_pos) = rest.find(';') {
                        rest[..semi_pos].trim()
                    } else {
                        rest.trim()
                    };
                    if !cookie_name.is_empty() && !cookie_value.is_empty() {
                        auth_info.insert(
                            format!("response_setcookie_{}", cookie_name),
                            cookie_value.to_string(),
                        );
                    }
                }
            }
        }

        // Extract request/response bodies if present
        let request_body = entry.request.post_data.as_ref().and_then(|pd| pd.text.clone());
        let response_body = entry.response.content.as_ref().and_then(|c| c.text.clone());

        requests.push(ParsedRequest {
            method: method.clone(),
            url: url_str.clone(),
            path: parsed.path().to_string(),
            domain: domain.clone(),
            status: response_status,
            response_content_type,
            from_spec: None,
            request_body,
            response_body,
        });
    }

    // Group by domain:path
    let mut endpoints: HashMap<String, Vec<ParsedRequest>> = HashMap::new();
    for req in &requests {
        let key = format!("{}:{}", req.domain, req.path);
        endpoints.entry(key).or_default().push(req.clone());
    }

    // Determine service name and base URL
    let (service, base_url) = {
        // Find best API domain
        let api_domains: Vec<&String> = target_domains
            .iter()
            .filter(|d| {
                d.contains("api.") || d.contains("quote") || d.contains("service") || d.starts_with("dev-")
            })
            .collect();

        let best_api_domain = if !api_domains.is_empty() {
            let mut domain_counts: HashMap<&String, usize> = HashMap::new();
            for req in &requests {
                if api_domains.contains(&&req.domain) {
                    *domain_counts.entry(&req.domain).or_default() += 1;
                }
            }
            domain_counts
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .map(|(domain, _)| domain.clone())
        } else {
            None
        };

        if let (Some(ref best), Some(ref sd)) = (&best_api_domain, &seed_domain) {
            if is_same_root_domain(best, sd) {
                (derive_service_name(sd), format!("https://{}", best))
            } else if let Some(ref sbu) = seed_base_url {
                (derive_service_name(sd), sbu.clone())
            } else {
                ("unknown-api".to_string(), "https://api.example.com".to_string())
            }
        } else if let Some(ref sd) = seed_domain {
            (derive_service_name(sd), seed_base_url.clone().unwrap_or_else(|| "https://api.example.com".to_string()))
        } else if !target_domains.is_empty() {
            let mut domain_counts: HashMap<&String, usize> = HashMap::new();
            for req in &requests {
                *domain_counts.entry(&req.domain).or_default() += 1;
            }
            if let Some((main_domain, _)) = domain_counts.into_iter().max_by_key(|(_, c)| *c) {
                (derive_service_name(main_domain), format!("https://{}", main_domain))
            } else {
                ("unknown-api".to_string(), "https://api.example.com".to_string())
            }
        } else if let Some(first) = base_urls.iter().next() {
            if let Ok(parsed) = Url::parse(first) {
                let domain = parsed.host_str().unwrap_or("unknown");
                (derive_service_name(domain), first.clone())
            } else {
                ("unknown-api".to_string(), "https://api.example.com".to_string())
            }
        } else {
            ("unknown-api".to_string(), "https://api.example.com".to_string())
        }
    };

    let auth_method = guess_auth_method(&auth_headers, &cookies);

    Ok(ApiData {
        service,
        base_urls: base_urls.into_iter().collect(),
        base_url,
        auth_headers,
        auth_method,
        cookies,
        auth_info,
        requests,
        endpoints,
    })
}

/// Check if a domain should be filtered out (third-party analytics, etc.)
#[napi]
pub fn is_third_party_domain(domain: String) -> bool {
    is_skipped_domain(&domain)
}

/// Detect the authentication method from headers and cookies
#[napi]
pub fn detect_auth_method(
    headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
) -> String {
    guess_auth_method(&headers, &cookies)
}

/// Extract the service name from a domain
#[napi]
pub fn get_service_name(domain: String) -> String {
    derive_service_name(&domain)
}

/// Check if a header name looks like an auth header
#[napi]
pub fn is_auth_header(name: String) -> bool {
    is_auth_like_header(&name)
}
