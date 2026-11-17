//! Telling a call that answers the page from one that only gates or reports it: properties of the URL and the
//! body, never vendor names.

use serde_json::Value;
use url::Url;

/// A response whose body is a puzzle, an interstitial, or an access gate --
/// not site data. Detected by properties of the URL path and body shape, never
/// by vendor name.
pub fn challenge_response(url: &Url, body: &Value) -> bool {
    // Path contains segments whose purpose is bot-gating or interstitial challenge.
    let path_challenge = url.path_segments().into_iter().flatten().any(|segment| {
        let s = segment.to_ascii_lowercase();
        s.contains("captcha")
            || s == "challenge"
            || (s.starts_with("__") && s.contains("challenge"))
            || s.starts_with("__cf_chl")
            || s == "cdn-cgi"
            || s.starts_with("_incapsula_")
    });

    // Body (when JSON) has keys that name challenge/captcha artefacts
    // rather than site content.
    let body_challenge = body.as_object().is_some_and(|o| {
        o.keys().any(|k| {
            let k = k.to_ascii_lowercase();
            k.contains("challenge") || k.contains("captcha")
        })
    });

    // A very small JSON body whose only keys are token/challenge-shaped is a
    // puzzle payload, not data.
    let tiny_token_body = body.as_object().is_some_and(|o| {
        o.len() <= 3
            && !o.is_empty()
            && o.keys().all(|k| {
                let k = k.to_ascii_lowercase();
                k.contains("token")
                    || k.contains("challenge")
                    || k.contains("captcha")
                    || k.contains("nonce")
                    || k.contains("key")
                    || k == "action"
                    || k == "type"
            })
    });

    path_challenge || body_challenge || tiny_token_body
}

/// A call that reports the page rather than answering it: analytics beacons,
/// consent checks, health pings. Detected by properties of the URL path and
/// request shape, never by vendor name.
pub fn telemetry_endpoint(url: &Url, request_body: Option<&Value>, page_url: Option<&str>) -> bool {
    // Path segments that name a telemetry, tracking, or health purpose.
    let telemetry_path = url.path_segments().into_iter().flatten().any(|segment| {
        let s = segment.to_ascii_lowercase();
        matches!(
            s.as_str(),
            "beacon"
                | "collect"
                | "track"
                | "pixel"
                | "telemetry"
                | "analytics"
                | "metrics"
                | "healthcheck"
                | "health"
                | "isalive"
                | "consent"
                | "sink"
                | "collector"
                | "log"
                | "logs"
        )
    });

    // The host's leading label names a telemetry role.
    let host = url.host_str().unwrap_or("");
    let label = host.split('.').next().unwrap_or("");
    let telemetry_host = matches!(
        label,
        "telemetry" | "analytics" | "metrics" | "sink" | "collector" | "beacon"
    );

    // A request that sends the walked page's own address is reporting the
    // page, not answering it.
    let reports_page = page_url.is_some_and(|page| {
        request_body.is_some_and(|b| {
            let s = b.to_string();
            s.contains(page)
        }) || url
            .query_pairs()
            .any(|(_, v)| v.as_ref() == page)
    });

    // POST with no meaningful response body: a fire-and-forget beacon.
    let empty_fire_and_forget = request_body.is_some()
        && url.path().to_ascii_lowercase().contains("event");

    telemetry_path || telemetry_host || reports_page || empty_fire_and_forget
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn challenge_response_detects_path_markers() {
        let url = Url::parse("https://example.com/cdn-cgi/challenge").unwrap();
        assert!(challenge_response(&url, &json!({})));

        let url = Url::parse("https://example.com/__cf_chl_jschl_tk__/something").unwrap();
        assert!(challenge_response(&url, &json!({})));

        let url = Url::parse("https://example.com/api/data").unwrap();
        assert!(!challenge_response(&url, &json!({"results": [1,2,3]})));
    }

    #[test]
    fn challenge_response_detects_body_keys() {
        let url = Url::parse("https://example.com/api/verify").unwrap();
        let body = json!({"challengeToken": "abc123", "action": "solve"});
        assert!(challenge_response(&url, &body));
    }

    #[test]
    fn challenge_response_detects_tiny_token_body() {
        let url = Url::parse("https://example.com/api/check").unwrap();
        let body = json!({"token": "xyz", "nonce": "123"});
        assert!(challenge_response(&url, &body));
    }

    #[test]
    fn telemetry_detects_path_segments() {
        let url = Url::parse("https://example.com/api/beacon").unwrap();
        assert!(telemetry_endpoint(&url, None, None));

        let url = Url::parse("https://example.com/collect/events").unwrap();
        assert!(telemetry_endpoint(&url, None, None));

        let url = Url::parse("https://example.com/api/products").unwrap();
        assert!(!telemetry_endpoint(&url, None, None));
    }

    #[test]
    fn telemetry_detects_host_label() {
        let url = Url::parse("https://analytics.example.com/v1/send").unwrap();
        assert!(telemetry_endpoint(&url, None, None));

        let url = Url::parse("https://beacon.example.com/ping").unwrap();
        assert!(telemetry_endpoint(&url, None, None));
    }

    #[test]
    fn telemetry_detects_page_url_in_request() {
        let url = Url::parse("https://example.com/api/track").unwrap();
        let body = json!({"page": "https://shop.example.com/products"});
        assert!(telemetry_endpoint(
            &url,
            Some(&body),
            Some("https://shop.example.com/products")
        ));
    }
}
