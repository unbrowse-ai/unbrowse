//! One page, asked as a navigation by each transport, with and without a header: which shape a site refuses.
//!
//!     cargo run -p unbrowse-learn --example get_probe -- <url> [header-to-leave-out ...]
//!
//! Prints the status each transport gets with the full navigation header set, then with each named header left out.
//! `PROBE_UA` names the user agent the Chrome-shaped transport asks as.

use unbrowse_learn::http::ChromeFetch;
use unbrowse_learn::replay::{Fetch, HttpFetch, Request};

fn ask<F: Fetch>(label: &str, fetch: &mut F, req: &Request) {
    match fetch.fetch(req) {
        Ok(ex) => {
            let text = ex.response_body.as_deref().unwrap_or("");
            let words: String = text.chars().filter(|c| !c.is_whitespace()).take(70).collect();
            println!("{label}: {} {} bytes :: {}", ex.status, text.len(), words);
        }
        Err(e) => println!("{label}: failed: {e}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(url) = args.first().and_then(|u| u.parse::<url::Url>().ok()) else {
        eprintln!("usage: get_probe <url> [header-to-leave-out ...]");
        std::process::exit(2);
    };
    // PROBE_UA names another identity to ask as (a headless browser's, an older version's).
    let ua = std::env::var("PROBE_UA").unwrap_or_else(|_| "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36".into());
    let ua = ua.as_str();
    let all: Vec<(&str, &str)> = vec![
        ("sec-ch-ua", "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\""),
        ("sec-ch-ua-mobile", "?0"),
        ("sec-ch-ua-platform", "\"macOS\""),
        ("upgrade-insecure-requests", "1"),
        ("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"),
        ("sec-fetch-site", "none"),
        ("sec-fetch-mode", "navigate"),
        ("sec-fetch-user", "?1"),
        ("sec-fetch-dest", "document"),
        ("accept-language", "en-US,en;q=0.9"),
        ("priority", "u=0, i"),
    ];
    let req = |without: Option<&str>| Request {
        method: "GET".into(),
        url: url.clone(),
        headers: all.iter().filter(|(k, _)| Some(*k) != without).map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        body: None,
        exchange: 0,
    };
    // PROBE_ORDER names the headers in the order to send them (`sec-fetch-user,priority,…`), the rest after: a door
    // may read the order a browser sends its headers in.
    let order: Vec<String> = std::env::var("PROBE_ORDER").map(|o| o.split(',').map(|h| h.trim().to_ascii_lowercase()).collect()).unwrap_or_default();
    let req = |without: Option<&str>| {
        let mut r = req(without);
        r.headers.sort_by_key(|(k, _)| order.iter().position(|o| o == k).unwrap_or(usize::MAX));
        r
    };
    let mut plain = HttpFetch::new().unwrap();
    let mut chrome = ChromeFetch::new().unwrap().with_identity(ua);
    ask("chrome, all headers", &mut chrome, &req(None));
    ask("plain,  all headers", &mut plain, &req(None));
    for h in args.iter().skip(1) {
        ask(&format!("chrome, without {h}"), &mut chrome, &req(Some(h.as_str())));
        ask(&format!("plain,  without {h}"), &mut plain, &req(Some(h.as_str())));
    }
}
