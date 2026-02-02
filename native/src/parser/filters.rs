//! Domain and header filtering for HAR parsing
//!
//! Contains static filter lists compiled into the binary.

use once_cell::sync::Lazy;
use std::collections::HashSet;

/// Static asset extensions to skip
pub static STATIC_EXTS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
        ".woff", ".woff2", ".ico", ".map", ".ttf", ".eot", ".otf",
        ".mp4", ".webm", ".mp3", ".wav", ".ogg",
    ]
});

/// Third-party domains to skip (analytics, payments, social, etc.)
pub static SKIP_DOMAINS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        // Analytics & tracking
        "google-analytics.com", "analytics.google.com", "www.google-analytics.com",
        "mixpanel.com", "api-js.mixpanel.com", "mparticle.com", "jssdks.mparticle.com",
        "segment.io", "segment.com", "cdn.segment.com", "api.segment.io",
        "amplitude.com", "api.amplitude.com", "heap.io", "heapanalytics.com",
        "posthog.com", "i.posthog.com", "eu.i.posthog.com", "us.i.posthog.com",
        "plausible.io", "matomo.org", "stats.wp.com",
        // Ads & attribution
        "doubleclick.net", "googletagmanager.com", "googlesyndication.com",
        "facebook.com", "instagram.com", "connect.facebook.net",
        "appsflyer.com", "wa.appsflyer.com", "intentiq.com", "api.intentiq.com",
        "id5-sync.com", "diagnostics.id5-sync.com", "33across.com",
        "btloader.com", "api.btloader.com", "hbwrapper.com",
        "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
        // Payments (third-party, not target APIs)
        "stripe.com", "js.stripe.com", "r.stripe.com", "m.stripe.com",
        "paypal.com", "braintreegateway.com", "adyen.com",
        // Support & engagement
        "intercom.io", "api-iam.intercom.io", "widget.intercom.io",
        "zendesk.com", "freshdesk.com", "drift.com", "crisp.chat",
        // UX & monitoring
        "hotjar.com", "script.hotjar.com", "clarity.ms", "sentry.io",
        "logrocket.io", "smartlook.com", "mouseflow.com",
        // CDNs
        "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
        "ajax.googleapis.com", "code.jquery.com",
        // Consent
        "onetrust.com", "geolocation.onetrust.com", "cookielaw.org", "cdn.cookielaw.org",
        "trustarc.com", "evidon.com",
        // Auth providers (third-party SSO - not the target)
        "accounts.google.com", "play.google.com", "stack-auth.com", "api.stack-auth.com",
        "auth0.com", "okta.com", "onelogin.com", "ping.com",
        // Cloudflare
        "cdn-cgi", "challenges.cloudflare.com",
        // TikTok analytics
        "analytics.tiktok.com", "analytics-sg.tiktok.com", "mon.tiktokv.com",
        "mcs.tiktokw.com", "lf16-tiktok-web.tiktokcdn-us.com",
        // Google services
        "www.googletagmanager.com", "www.google.com", "google.com",
        "fonts.googleapis.com", "fonts.gstatic.com", "maps.googleapis.com",
        "www.gstatic.com", "apis.google.com", "ssl.gstatic.com",
        "pagead2.googlesyndication.com", "adservice.google.com",
        "translate.googleapis.com", "firebaseinstallations.googleapis.com",
        // Facebook/Meta
        "graph.facebook.com", "www.facebook.com", "pixel.facebook.com",
        // Twitter
        "platform.twitter.com", "syndication.twitter.com", "analytics.twitter.com",
        // Other common third-party
        "newrelic.com", "nr-data.net", "bam.nr-data.net",
        "fullstory.com", "rs.fullstory.com",
        "launchdarkly.com", "app.launchdarkly.com",
        "datadoghq.com", "browser-intake-datadoghq.com",
        "bugsnag.com", "sessions.bugsnag.com",
        "rollbar.com", "raygun.io", "trackjs.com",
        // Captcha
        "recaptcha.net", "hcaptcha.com", "challenges.cloudflare.com",
        // Other
        "branch.io", "app.link", "adjust.com", "kochava.com",
        "applovin.com", "unity3d.com", "chartboost.com",
    ]
});

/// Auth header names to capture (exact matches, lowercase)
pub static AUTH_HEADER_NAMES: Lazy<HashSet<&str>> = Lazy::new(|| {
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
pub static AUTH_HEADER_PATTERNS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        "auth", "token", "key", "secret", "bearer", "jwt",
        "session", "credential", "password", "signature", "sign",
        "api-", "apikey", "access", "oauth", "csrf", "xsrf",
    ]
});

/// Standard browser headers that are NOT custom API auth
pub static STANDARD_HEADERS: Lazy<HashSet<&str>> = Lazy::new(|| {
    [
        "x-requested-with", "x-forwarded-for", "x-forwarded-host",
        "x-forwarded-proto", "x-real-ip", "x-frame-options",
        "x-content-type-options", "x-xss-protection", "x-ua-compatible",
        "x-dns-prefetch-control", "x-download-options", "x-permitted-cross-domain-policies",
        "x-powered-by", "x-request-id", "x-correlation-id", "x-trace-id",
        "x-amz-cf-id", "x-amz-cf-pop", "x-cache", "x-cache-hits",
    ].iter().copied().collect()
});

/// Context header names to capture (business identifiers)
pub static CONTEXT_HEADER_NAMES: Lazy<HashSet<&str>> = Lazy::new(|| {
    [
        "outletid", "userid", "supplierid", "companyid", "tenantid",
        "organizationid", "accountid", "workspaceid", "projectid",
        "x-tenant-id", "x-org-id", "x-workspace-id",
    ].iter().copied().collect()
});

/// Path prefixes to skip
pub static SKIP_PATHS: Lazy<Vec<&str>> = Lazy::new(|| {
    vec![
        "/cdn-cgi/", "/_next/data/", "/__nextjs", "/sockjs-node/",
        "/favicon", "/manifest.json", "/robots.txt", "/sitemap",
        "/.well-known/", "/apple-app-site-association",
        "/service-worker", "/sw.js", "/workbox-",
    ]
});

/// Check if a header name looks like an auth header
pub fn is_auth_like_header(name: &str) -> bool {
    let lower = name.to_lowercase();
    if AUTH_HEADER_NAMES.contains(lower.as_str()) {
        return true;
    }
    AUTH_HEADER_PATTERNS.iter().any(|p| lower.contains(p))
}

/// Check if a header is a standard browser header (not auth)
pub fn is_standard_header(name: &str) -> bool {
    STANDARD_HEADERS.contains(name.to_lowercase().as_str())
}

/// Check if a header is an HTTP/2 pseudo-header
pub fn is_http2_pseudo_header(name: &str) -> bool {
    name.starts_with(':')
}

/// Check if URL points to a static asset
pub fn is_static_asset(url_str: &str) -> bool {
    if let Ok(url) = url::Url::parse(url_str) {
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

/// Check if a domain should be filtered out (third-party)
pub fn is_skipped_domain(domain: &str) -> bool {
    let lower = domain.to_lowercase();
    SKIP_DOMAINS.iter().any(|skip| lower.contains(skip))
}

/// Check if content-type indicates HTML
pub fn is_html_content_type(content_type: &str) -> bool {
    let ct = content_type.to_lowercase();
    ct.contains("text/html") || ct.contains("application/xhtml")
}

/// Check if URL/method/content looks like an API call
pub fn is_api_like(url_str: &str, method: &str, domain: &str, content_type: Option<&str>) -> bool {
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
        || url_lower.contains("/account")
        || url_lower.contains("/profile")
        || url_lower.contains("/data")
        || url_lower.contains("/query")
        || url_lower.contains("/mutation")
        || url_lower.contains("/rpc")
        || ["POST", "PUT", "DELETE", "PATCH"].contains(&method)
        || domain.contains("api.")
        || domain.contains("service")
        || domain.contains("quote")
        || domain.starts_with("dev-")
        || domain.starts_with("staging-")
}

/// Get root domain (e.g., "api.example.com" -> "example.com")
pub fn get_root_domain(domain: &str) -> String {
    let parts: Vec<&str> = domain.split('.').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2..].join(".")
    } else {
        domain.to_string()
    }
}

/// Check if two domains share the same root
pub fn is_same_root_domain(domain1: &str, domain2: &str) -> bool {
    get_root_domain(domain1) == get_root_domain(domain2)
}

/// Derive a service name from a domain
pub fn derive_service_name(domain: &str) -> String {
    let name = domain
        .trim_start_matches("www.")
        .trim_start_matches("api.")
        .trim_start_matches("app.")
        .trim_start_matches("m.");

    // Remove common TLDs
    let re = regex::Regex::new(r"\.(com|org|net|co|io|ai|app|sg|dev|xyz|gg|fm|tv|me|so|to)\.?$")
        .unwrap();
    let name = re.replace_all(name, "");

    let name = name.replace('.', "-").to_lowercase();

    if name.is_empty() {
        "unknown-api".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_auth_like_header() {
        assert!(is_auth_like_header("Authorization"));
        assert!(is_auth_like_header("x-api-key"));
        assert!(is_auth_like_header("X-Auth-Token"));
        assert!(is_auth_like_header("mudra"));
        assert!(!is_auth_like_header("Content-Type"));
        assert!(!is_auth_like_header("Accept"));
    }

    #[test]
    fn test_is_skipped_domain() {
        assert!(is_skipped_domain("google-analytics.com"));
        assert!(is_skipped_domain("api.segment.io"));
        assert!(is_skipped_domain("www.googletagmanager.com"));
        assert!(!is_skipped_domain("api.myapp.com"));
        assert!(!is_skipped_domain("example.com"));
    }

    #[test]
    fn test_derive_service_name() {
        assert_eq!(derive_service_name("api.github.com"), "github");
        assert_eq!(derive_service_name("www.stripe.com"), "stripe");
        assert_eq!(derive_service_name("app.linear.app"), "linear");
    }
}
