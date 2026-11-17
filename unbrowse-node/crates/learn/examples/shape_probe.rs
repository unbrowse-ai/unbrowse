//! One request, two shapes: what a site answers the Chrome-profiled transport and the plain one.
//!
//! Both carry the same request the walk shows (method, address, headers, body); only the TLS/HTTP-2 shape under them
//! differs. A site that refuses the emulated browser and answers a plain client is asking for a shape, not a browser —
//! and the plain shape is one the node already has. Measured on ieeexplore.ieee.org, 2026-11-11.
//!
//! The third line is the same POST with the header set a route keeps from that walk, in the order the capture lists it:
//! the walk's own client hints and `x-security-request` ride along, which is what a replay sends.

use unbrowse_learn::http::ChromeFetch;
use unbrowse_learn::replay::{Fetch, HttpFetch, Request};

fn ask<F: Fetch>(label: &str, fetch: &mut F, req: &Request) {
    match fetch.fetch(req) {
        Ok(ex) => {
            let text = ex.response_body.as_deref().unwrap_or("");
            let words: String = text.chars().filter(|c| !c.is_whitespace()).take(60).collect();
            println!("{label}: {} {} bytes :: {}", ex.status, text.len(), words);
        }
        Err(e) => println!("{label}: failed: {e}"),
    }
}

fn search(headers: Vec<(&str, &str)>) -> Request {
    let body = r#"{"queryText":"photonics","highlight":true,"returnFacets":["ALL"],"returnType":"SEARCH"}"#;
    Request {
        method: "POST".into(),
        url: "https://ieeexplore.ieee.org/rest/search".parse().unwrap(),
        headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        body: Some(body.as_bytes().to_vec()),
        exchange: 0,
    }
}

fn main() {
    let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
    let mut plain = HttpFetch::new().unwrap();
    let mut chrome = ChromeFetch::new().unwrap().with_identity(ua);
    // The page's own call as the walk read it, in the capture's order.
    let walked: Vec<(&str, &str)> = vec![
        ("sec-ch-ua-platform", "\"macOS\""),
        ("referer", "https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=antenna"),
        ("accept-language", "en-US,en;q=0.9"),
        ("sec-ch-ua", "\"Chromium\";v=\"155\", \"Not(A:Brand\";v=\"24\""),
        ("sec-ch-ua-mobile", "?0"),
        ("accept", "application/json, text/plain, */*"),
        ("x-security-request", "required"),
        ("content-type", "application/json"),
        ("origin", "https://ieeexplore.ieee.org"),
    ];
    ask("walked-chrome", &mut chrome, &search(walked.clone()));
    ask("walked-plain ", &mut plain, &search(walked));
}
