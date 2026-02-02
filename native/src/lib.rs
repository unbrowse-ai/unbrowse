//! Unbrowse Core - Native HAR parsing and auth extraction
//!
//! This module contains the proprietary algorithms for:
//! - HAR file parsing and API endpoint extraction
//! - Third-party domain filtering
//! - Auth header detection and classification
//! - Service name derivation

use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use url::Url;

// ============================================================================
// Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarHeader {
    pub name: String,
    pub value: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarCookie {
    pub name: String,
    pub value: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HarHeader>,
    #[napi(ts_type = "HarCookie[] | undefined")]
    pub cookies: Option<Vec<HarCookie>>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarResponse {
    pub status: i32,
    pub headers: Vec<HarHeader>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarEntry {
    pub request: HarRequest,
    pub response: HarResponse,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarLog {
    pub entries: Vec<HarEntry>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Har {
    pub log: HarLog,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedRequest {
    pub method: String,
    pub url: String,
    pub path: String,
    pub domain: String,
    pub status: i32,
    #[napi(ts_type = "string | undefined")]
    pub response_content_type: Option<String>,
    #[napi(ts_type = "boolean | undefined")]
    pub from_spec: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiData {
    pub service: String,
    pub base_urls: Vec<String>,
    pub base_url: String,
    pub auth_headers: HashMap<String, String>,
    pub auth_method: String,
    pub cookies: HashMap<String, String>,
    pub auth_info: HashMap<String, String>,
    pub requests: Vec<ParsedRequest>,
    pub endpoints: HashMap<String, Vec<ParsedRequest>>,
}

// ============================================================================
// Static Data (compiled into binary - not visible in source)
// ============================================================================

/// Static asset extensions to skip
static STATIC_EXTS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg",
        ".woff", ".woff2", ".ico", ".map", ".ttf", ".eot",
    ]
});

/// Third-party domains to skip (analytics, payments, social, etc.)
static SKIP_DOMAINS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        // Analytics & tracking
        "google-analytics.com", "analytics.google.com", "www.google-analytics.com",
        "mixpanel.com", "api-js.mixpanel.com", "mparticle.com", "jssdks.mparticle.com",
        "segment.io", "segment.com", "cdn.segment.com", "api.segment.io",
        "amplitude.com", "api.amplitude.com", "heap.io", "heapanalytics.com",
        "posthog.com", "i.posthog.com", "eu.i.posthog.com", "us.i.posthog.com",
        "plausible.io", "matomo.org",
        // Ads & attribution
        "doubleclick.net", "googletagmanager.com", "googlesyndication.com",
        "facebook.com", "instagram.com", "connect.facebook.net",
        "appsflyer.com", "wa.appsflyer.com", "intentiq.com", "api.intentiq.com",
        "id5-sync.com", "diagnostics.id5-sync.com", "33across.com",
        "btloader.com", "api.btloader.com", "hbwrapper.com",
        // Payments
        "stripe.com", "js.stripe.com", "r.stripe.com", "m.stripe.com",
        // Support & engagement
        "intercom.io", "api-iam.intercom.io",
        // UX & monitoring
        "hotjar.com", "clarity.ms", "sentry.io",
        // CDNs
        "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
        // Consent
        "onetrust.com", "geolocation.onetrust.com", "cookielaw.org", "cdn.cookielaw.org",
        // Auth providers (third-party SSO)
        "accounts.google.com", "play.google.com", "stack-auth.com", "api.stack-auth.com",
        // Cloudflare
        "cdn-cgi",
        // TikTok analytics
        "analytics.tiktok.com", "analytics-sg.tiktok.com", "mon.tiktokv.com",
        "mcs.tiktokw.com", "lf16-tiktok-web.tiktokcdn-us.com",
        // Google services
        "www.googletagmanager.com", "www.google.com", "google.com",
        "fonts.googleapis.com", "fonts.gstatic.com", "maps.googleapis.com",
        "www.gstatic.com", "apis.google.com", "ssl.gstatic.com",
        "pagead2.googlesyndication.com", "adservice.google.com",
        // Facebook/Meta
        "graph.facebook.com", "www.facebook.com",
        // Twitter
        "platform.twitter.com", "syndication.twitter.com",
        // Other common third-party
        "newrelic.com", "nr-data.net", "bam.nr-data.net",
        "fullstory.com", "rs.fullstory.com",
        "launchdarkly.com", "app.launchdarkly.com",
        "datadoghq.com", "browser-intake-datadoghq.com",
        "bugsnag.com", "sessions.bugsnag.com",
    ]
});

/// Auth header names to capture (exact matches)
static AUTH_HEADER_NAMES: Lazy<HashSet<&str>> = Lazy::new(|| {
    [
        "authorization", "x-api-key", "api-key", "apikey",
        "x-auth-token", "access-token", "x-access-token",
        "token", "x-token", "authtype", "mudra",
        "bearer", "jwt", "x-jwt", "x-jwt-token", "id-token", "id_token",
        "x-id-token", "refresh-token", "x-refresh-token",
        "x-apikey", "x-key", "key", "secret", "x-secret",
        "api-secret", "x-api-secret", "client-secret", "x-client-secret",
        "session", "session-id", "sessionid", "x-session", "x-session-id",
        "x-session-token", "session-token", "csrf", "x-csrf", "x-csrf-token",
        "csrf-token", "x-xsrf-token", "xsrf-token",
        "x-oauth-token", "oauth-token", "x-oauth", "oauth",
        "x-amz-security-token", "x-amz-access-token",
        "x-goog-api-key", "x-rapidapi-key",
        "ocp-apim-subscription-key", "x-functions-key",
        "x-auth", "x-authentication", "x-authorization",
        "x-user-token", "x-app-token", "x-client-token",
        "x-access-key", "x-secret-key", "x-signature",
        "x-request-signature", "signature",
    ].iter().copied().collect()
});

/// Patterns that indicate an auth-related header
static AUTH_HEADER_PATTERNS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        "auth", "token", "key", "secret", "bearer", "jwt",
        "session", "credential", "password", "signature", "sign",
        "api-", "apikey", "access", "oauth", "csrf", "xsrf",
    ]
});

/// Standard browser headers that are NOT custom API auth
static STANDARD_HEADERS: Lazy<HashSet<&str>> = Lazy::new(|| {
    [
        "x-requested-with", "x-forwarded-for", "x-forwarded-host",
        "x-forwarded-proto", "x-real-ip", "x-frame-options",
        "x-content-type-options", "x-xss-protection", "x-ua-compatible",
        "x-dns-prefetch-control", "x-download-options", "x-permitted-cross-domain-policies",
        "x-powered-by", "x-request-id", "x-correlation-id", "x-trace-id",
    ].iter().copied().collect()
});

/// Context header names to capture
static CONTEXT_HEADER_NAMES: Lazy<HashSet<&str>> = Lazy::new(|| {
    ["outletid", "userid", "supplierid", "companyid"].iter().copied().collect()
});

/// Path prefixes to skip
static SKIP_PATHS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        "/cdn-cgi/", "/_next/data/", "/__nextjs", "/sockjs-node/",
        "/favicon", "/manifest.json", "/robots.txt", "/sitemap",
    ]
});

// ============================================================================
// Helper Functions
// ============================================================================

fn is_auth_like_header(name: &str) -> bool {
    let lower = name.to_lowercase();
    if AUTH_HEADER_NAMES.contains(lower.as_str()) {
        return true;
    }
    AUTH_HEADER_PATTERNS.iter().any(|p| lower.contains(p))
}

fn is_standard_header(name: &str) -> bool {
    STANDARD_HEADERS.contains(name.to_lowercase().as_str())
}

fn is_http2_pseudo_header(name: &str) -> bool {
    name.starts_with(':')
}

fn is_static_asset(url_str: &str) -> bool {
    if let Ok(url) = Url::parse(url_str) {
        let path = url.path().to_lowercase();
        if STATIC_EXTS.iter().any(|ext| path.ends_with(ext)) {
            return true;
        }
        if SKIP_PATHS.iter().any(|prefix| path.starts_with(prefix)) {
            return true;
        }
    }
    false
}

fn is_skipped_domain(domain: &str) -> bool {
    SKIP_DOMAINS.iter().any(|skip| domain.contains(skip))
}

fn is_html_content_type(content_type: &str) -> bool {
    let ct = content_type.to_lowercase();
    ct.contains("text/html") || ct.contains("application/xhtml")
}

fn get_response_content_type(entry: &HarEntry) -> Option<String> {
    for header in &entry.response.headers {
        if header.name.to_lowercase() == "content-type" {
            return Some(header.value.clone());
        }
    }
    None
}

fn is_api_like(url_str: &str, method: &str, domain: &str, content_type: Option<&str>) -> bool {
    if let Some(ct) = content_type {
        if ct.contains("application/json") || ct.contains("text/json") {
            return true;
        }
    }

    let url_lower = url_str.to_lowercase();
    url_lower.contains("/api/")
        || url_lower.contains("/services/")
        || url_lower.contains("/v1/")
        || url_lower.contains("/v2/")
        || url_lower.contains("/v3/")
        || url_lower.contains("/graphql")
        || url_lower.contains("/order")
        || url_lower.contains("/quote")
        || url_lower.contains("/swap")
        || url_lower.contains("/tokens")
        || url_lower.contains("/markets")
        || url_lower.contains("/user")
        || url_lower.contains("/auth")
        || ["POST", "PUT", "DELETE", "PATCH"].contains(&method)
        || domain.contains("api.")
        || domain.contains("service")
        || domain.contains("quote")
        || domain.starts_with("dev-")
}

fn get_root_domain(domain: &str) -> String {
    let parts: Vec<&str> = domain.split('.').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2..].join(".")
    } else {
        domain.to_string()
    }
}

fn is_same_root_domain(domain1: &str, domain2: &str) -> bool {
    get_root_domain(domain1) == get_root_domain(domain2)
}

fn derive_service_name(domain: &str) -> String {
    let name = domain
        .trim_start_matches("www.")
        .trim_start_matches("api.");

    // Remove common TLDs
    let name = regex::Regex::new(r"\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$")
        .unwrap()
        .replace_all(name, "");

    let name = name.replace('.', "-").to_lowercase();

    if name.is_empty() {
        "unknown-api".to_string()
    } else {
        name
    }
}

// ============================================================================
// Auth Method Detection
// ============================================================================

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

    // Mudra token
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

// ============================================================================
// Main Parser
// ============================================================================

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

        // Extract response set-cookie
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

        requests.push(ParsedRequest {
            method: method.clone(),
            url: url_str.clone(),
            path: parsed.path().to_string(),
            domain: domain.clone(),
            status: response_status,
            response_content_type,
            from_spec: None,
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
