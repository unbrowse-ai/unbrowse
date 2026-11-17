//! The proof: what the transport looks like. A plain reqwest client and a
//! Chrome-profiled one fetch a TLS-echo endpoint; the wall-facing fingerprint
//! (JA3/JA4, HTTP/2 settings) is what protection compares, and the profile
//! carries the browser's while the UA stays the node's own.

use unbrowse_learn::http::ChromeFetch;
use unbrowse_learn::replay::{Fetch, HttpFetch, Request};

fn req(url: &str) -> Request {
    Request {
        method: "GET".into(),
        url: url.parse().unwrap(),
        headers: vec![],
        body: None,
        exchange: 0,
    }
}

fn show(label: &str, body: &str) {
    let field = |k: &str| {
        for pat in [format!("\"{k}\":\""), format!("\"{k}\": \"")] {
            if let Some(at) = body.find(&pat) {
                let rest = &body[at + pat.len()..];
                if let Some(end) = rest.find('"') {
                    return rest[..end].to_string();
                }
            }
        }
        String::new()
    };
    println!("{label}: user_agent={:?}", field("user_agent"));
    println!("{label}: ja4={:?}", field("ja4"));
    println!("{label}: peetprint_hash={:?}", field("peetprint_hash"));
    if body.is_empty() || body.starts_with('<') {
        println!("{label}: (body {}) {:?}", body.len(), body.chars().take(80).collect::<String>());
    }
}

fn main() {
    let url = "https://tls.peet.ws/api/all";

    let mut plain = HttpFetch::new().unwrap();
    let r1 = plain.fetch(&req(url)).unwrap();
    show("plain  ", r1.response_body.as_deref().unwrap_or(""));

    let mut chrome = ChromeFetch::new().unwrap().with_identity(concat!("unbrowse-node/", env!("CARGO_PKG_VERSION")));
    let r2 = chrome.fetch(&req(url)).unwrap();
    let body = r2.response_body.as_deref().unwrap_or("");
    show("chrome ", body);
    // What the door reads, side by side with the browser's own numbers:
    // JA4 (TLS), the extension count, and the HTTP/2 fingerprint.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        let ja4 = v.pointer("/tls/ja4").and_then(|x| x.as_str()).unwrap_or("?");
        let exts = v.pointer("/tls/extensions").and_then(|e| e.as_array()).map(|a| a.len()).unwrap_or(0);
        let akamai = v.pointer("/http2/akamai_fingerprint").and_then(|x| x.as_str()).unwrap_or("?");
        println!("chrome fingerprint: ja4={ja4} extensions={exts} h2_akamai={akamai}");
        // The extension list itself, in order: the JA4 hash is over these names, so a diff against the browser's own
        // list (a walk of tls.peet.ws) names the extension that is missing or out of place.
        if let Some(list) = v.pointer("/tls/extensions").and_then(|e| e.as_array()) {
            for (i, e) in list.iter().enumerate() {
                println!("  ext {i}: {}", e.get("name").and_then(|n| n.as_str()).unwrap_or("?"));
            }
        }
        if let Some(j4r) = v.pointer("/tls/ja4_r").and_then(|x| x.as_str()) {
            println!("chrome ja4_r={j4r}");
        }
    }
}
