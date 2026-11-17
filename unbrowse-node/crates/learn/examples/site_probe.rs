//! The generalized harness, on any site: mint the host in-process, then call it
//! browserlessly with browser-shaped headers — the shape the door checks.
//!
//!     site_probe <url-to-mint> <url-to-call> [url-to-call...]

use std::collections::HashMap;

use unbrowse_learn::http::ChromeFetch;
use unbrowse_learn::mint::{BrowserMint, Mint};
use unbrowse_learn::replay::{Fetch, Request};

/// The header shape a browser's navigation carries. The door reads this, not
/// only the handshake: the same jar without it draws the interstitial.
fn browser_headers(host: &str, cookies: &str) -> Vec<(String, String)> {
    let origin = format!("https://{host}");
    vec![
        ("accept".into(), "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8".into()),
        ("accept-language".into(), "en-US,en;q=0.9".into()),
        ("cookie".into(), cookies.into()),
        ("referer".into(), format!("{origin}/")),
        ("sec-fetch-dest".into(), "document".into()),
        ("sec-fetch-mode".into(), "navigate".into()),
        ("sec-fetch-site".into(), "same-origin".into()),
        ("sec-fetch-user".into(), "?1".into()),
        ("upgrade-insecure-requests".into(), "1".into()),
    ]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mint_url, calls) = match args.split_first() {
        Some((first, rest)) => (first.clone(), rest.to_vec()),
        None => {
            eprintln!("usage: site_probe <mint-url> [call-url...]");
            return;
        }
    };
    let url: url::Url = mint_url.parse().expect("mint url");
    let host = url.host_str().unwrap_or_default().to_string();
    let session = host.replace('.', "_");
    let profile = dirs::home_dir()
        .map(|h| h.join(format!(".unbrowse/profiles/{host}")))
        .map(|p| p.to_string_lossy().into_owned());

    let mut mint = BrowserMint {
        try_controls: false,
        frames: None,
        seed: Vec::new(),
        browser: "in-process".into(),
        cdp_endpoint: None,
        user_agent: Some("unbrowse-node/0.1.0".to_string()),
        session: session.clone(),
        capture_dir: std::env::temp_dir().join("site-probe-capture"),
        profile,
        _host: host.clone(),
    };
    let t = std::time::Instant::now();
    let jar = match mint.mint(&url) {
        Ok(s) => {
            println!("== mint {host}: {} cookies in {:.1}s", s.cookies.len(), t.elapsed().as_secs_f32());
            s.cookies
        }
        Err(e) => {
            println!("== mint failed: {e:?}");
            HashMap::new()
        }
    };
    let cookies: String = jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");

    // The walk recorded the browser's own requests: the exact shape this site's
    // door expects. Replay that shape (minus cookies, which the jar supplies).
    let capture = std::env::temp_dir().join("site-probe-capture").join(format!("{session}.jsonl"));
    let mut learned_headers: Vec<(String, String)> = Vec::new();
    if let Ok(raw) = std::fs::read_to_string(&capture) {
        for line in raw.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v.get("type").and_then(|t| t.as_str()) != Some("request") {
                continue;
            }
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if !url.contains(&host) || v.get("method").and_then(|m| m.as_str()) != Some("GET") {
                continue;
            }
            // Prefer a document request for the site's root.
            let is_doc = url.trim_end_matches('/').ends_with(&host)
                || url.ends_with(&format!("{host}/"));
            if !is_doc && !learned_headers.is_empty() {
                continue;
            }
            if let Some(h) = v.get("headers").and_then(|h| h.as_object()) {
                learned_headers = h
                    .iter()
                    .filter(|(k, _)| {
                        let k = k.to_ascii_lowercase();
                        !k.starts_with(':') && k != "cookie" && k != "content-length" && k != "host"
                    })
                    .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect();
                if is_doc {
                    break;
                }
            }
        }
    }
    println!("== learned {} request headers from the walk", learned_headers.len());

    // Gates from the walk: the hosts of its door.
    if let Some(trace) = unbrowse_learn::walk::trace_from_walk(&std::env::temp_dir().join("site-probe-capture"), &session) {
        let gates = trace.gates(&unbrowse_learn::identity::site_of(&host));
        if !gates.is_empty() { println!("== gates from the walk: {}", gates.join(", ")); }
    }
    let mut chrome = ChromeFetch::new().unwrap().with_identity("unbrowse-node/0.1.0");
    let targets = if calls.is_empty() { vec![mint_url.clone()] } else { calls };
    for target in targets {
        let req = Request {
            method: "GET".into(),
            url: target.parse().expect("call url"),
            headers: {
                let mut h = browser_headers(&host, &cookies);
                for (k, v) in &learned_headers {
                    if let Some(slot) = h.iter_mut().find(|(hk, _)| hk.eq_ignore_ascii_case(k)) {
                        slot.1 = v.clone();
                    } else {
                        h.push((k.clone(), v.clone()));
                    }
                }
                h
            },
            body: None,
            exchange: 0,
        };
        match chrome.fetch(&req) {
            Ok(e) => {
                let body = e.response_body.as_deref().unwrap_or("");
                // The verdict reads the door's own marks, not words that may
                // simply appear in the page: a challenge page is small and
                // says so in its title.
                let verdict = if e.status == 405
                    || body.contains("Just a moment")
                    || body.contains("Performing security verification")
                    || body.contains("Human Verification")
                {
                    "DOOR"
                } else if e.status >= 400 {
                    "REFUSED"
                } else {
                    "DATA"
                };
                // The general bypass: browserless first, and when a door
                // refuses, the walk's own recorded response — the page the
                // browser already fetched during the mint.
                if verdict != "DATA" {
                    if let Some((status, _mime, walked)) =
                        agent_browser_core::session::walk_response(&std::env::temp_dir().join("site-probe-capture"), &session, &target)
                    {
                        println!(
                            "   {} {} len={} {}  [browserless refused; answered from the walk: {} {} bytes]",
                            e.status, verdict, body.len(),
                            target.chars().take(50).collect::<String>(),
                            status, walked.len()
                        );
                        continue;
                    }
                }
                println!("   {} {} len={} {}", e.status, verdict, body.len(), target.chars().take(70).collect::<String>());
                if verdict != "DATA" {
                    let head: String = body.chars().take(220).collect();
                    println!("      body: {}", head.replace('\n', " "));
                    let srv = e.response_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("server"));
                    let loc = e.response_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("location"));
                    println!("      server: {:?} location: {:?}", srv.map(|(_, v)| v.clone()), loc.map(|(_, v)| v.clone()));
                }
            }
            Err(e) => println!("   error {e:?} {target}"),
        }
    }
}
