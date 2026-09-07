//! obscura-capture — unbrowse's route-learning capture engine, re-expressed on
//! obscura's native primitives instead of Chrome + CDP.
//!
//! CDP surface it replaces (see src/capture/index.ts):
//!   Network.requestWillBeSent / responseReceived / getResponseBody  -> on_response
//!   Page.addScriptToEvaluateOnNewDocument (INTERCEPTOR_SCRIPT)       -> add_preload_script
//!   Network.setCookies / cross-browser cookie import                -> CookieStore.load_from_file
//!
//! Emits NDJSON on stdout: one {"kind":"response",...} line per captured request/
//! response pair (navigation + in-page fetch/XHR, WITH bodies), then a final
//! {"kind":"page",...} line carrying the settled URL, HTML length, and cookie jar.
//! Chrome is never launched; no CDP socket is ever opened.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use obscura::{Browser, RequestInfo, ResourceType, Response};
use serde_json::json;

fn resource_type_str(rt: &ResourceType) -> &'static str {
    match rt {
        ResourceType::Document => "document",
        ResourceType::Script => "script",
        ResourceType::Stylesheet => "stylesheet",
        ResourceType::Image => "image",
        ResourceType::Font => "font",
        ResourceType::Xhr => "xhr",
        ResourceType::Fetch => "fetch",
        ResourceType::Other => "other",
    }
}

fn is_textual(ct: Option<&str>) -> bool {
    match ct {
        Some(ct) => {
            let ct = ct.to_ascii_lowercase();
            ct.contains("json")
                || ct.contains("javascript")
                || ct.contains("text")
                || ct.contains("graphql")
                || ct.contains("xml")
                || ct.contains("protobuf")
                || ct.contains("x-www-form-urlencoded")
        }
        None => false,
    }
}

struct Args {
    url: String,
    cookies: Option<String>,
    settle_ms: u64,
    wait_selector: Option<String>,
    max_body: usize,
    stealth: bool,
    storage_dir: Option<String>,
    // Interaction pass (endpoint discovery via clicks/scroll). Any fetch/XHR the
    // interaction fires is captured by the already-attached on_response callback.
    clicks: Vec<String>,
    scrolls: u32,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        url: String::new(),
        cookies: None,
        settle_ms: 3000,
        wait_selector: None,
        max_body: 512 * 1024,
        stealth: false,
        storage_dir: None,
        clicks: Vec::new(),
        scrolls: 0,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--cookies" => a.cookies = it.next(),
            "--settle" => a.settle_ms = it.next().and_then(|s| s.parse().ok()).unwrap_or(3000),
            "--wait" => a.wait_selector = it.next(),
            "--max-body" => a.max_body = it.next().and_then(|s| s.parse().ok()).unwrap_or(a.max_body),
            "--stealth" => a.stealth = true,
            "--storage-dir" => a.storage_dir = it.next(),
            // Repeatable: click a safe CSS selector (pagination/filter/detail).
            "--click" => {
                if let Some(sel) = it.next() {
                    a.clicks.push(sel);
                }
            }
            // Scroll to the bottom N times to trigger lazy/infinite-scroll fetches.
            "--scroll" => a.scrolls = it.next().and_then(|s| s.parse().ok()).unwrap_or(1),
            other => {
                if a.url.is_empty() && !other.starts_with("--") {
                    a.url = other.to_string();
                }
            }
        }
    }
    if a.url.is_empty() {
        return Err("usage: obscura-capture <url> [--cookies file] [--storage-dir dir] [--settle ms] [--wait css] [--click css]... [--scroll n] [--max-body bytes] [--stealth]".into());
    }
    Ok(a)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let mut builder = Browser::builder().stealth(args.stealth);
    if let Some(dir) = &args.storage_dir {
        builder = builder.storage_dir(dir.clone());
    }
    let browser = match builder.build() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("browser build failed: {e}");
            std::process::exit(1);
        }
    };

    // Auth injection: load a cookie jar ripped from another real browser
    // (obscura camelCase cookies.json). This is the same jar shape obscura's
    // --storage-dir persists, so it round-trips with the shipped CLI too.
    if let Some(path) = &args.cookies {
        match browser.cookies().load_from_file(std::path::Path::new(path)) {
            Ok(n) => eprintln!("loaded {n} cookies from {path}"),
            Err(e) => eprintln!("cookie load failed ({path}): {e}"),
        }
    }

    let mut page = match browser.new_page().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("new_page failed: {e}");
            std::process::exit(1);
        }
    };

    // The capture buffer. on_response fires for navigation AND in-page
    // fetch()/XHR, with the response body — the exact data the CDP capture
    // engine assembled from requestWillBeSent + responseReceived + getResponseBody.
    let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = captured.clone();
    let max_body = args.max_body;
    page.on_response(Arc::new(move |req: &RequestInfo, resp: &Response| {
        let ct = resp.content_type().map(|s| s.to_string());
        let (body_text, body_truncated) = if is_textual(ct.as_deref()) {
            let mut t = resp.text();
            let truncated = t.len() > max_body;
            if truncated {
                t.truncate(max_body);
            }
            (Some(t), truncated)
        } else {
            (None, false)
        };
        // Real capture-order timestamp (epoch millis). reveng-local reads these
        // as the entry's own clock; it never draws its own, staying deterministic.
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let rec = json!({
            "kind": "response",
            "url": req.url.to_string(),
            "method": req.method,
            "resourceType": resource_type_str(&req.resource_type),
            "reqHeaders": req.headers,
            "status": resp.status,
            "respHeaders": resp.headers,
            "contentType": ct,
            "bodyText": body_text,
            "bodyLen": resp.body.len(),
            "bodyTruncated": body_truncated,
            "ts": ts,
        });
        if let Ok(mut v) = sink.lock() {
            v.push(rec);
        }
    }));

    if let Err(e) = page.goto(&args.url).await {
        eprintln!("navigation failed: {e}");
        // still emit whatever we captured
    }

    if let Some(sel) = &args.wait_selector {
        let _ = page
            .wait_for_selector(sel, Duration::from_millis(args.settle_ms.max(1000)))
            .await;
    }
    page.settle(args.settle_ms).await;

    // Interaction pass — the (b) discovery path: safe clicks + scroll to make the
    // page fire its internal fetch/XHR routes that a passive load never triggers
    // (pagination, filters, infinite scroll). on_response is already attached, so
    // every request the interaction fires lands in the same capture buffer. A run
    // with no --click/--scroll is a no-op, so the passive behavior is unchanged.
    let interact_settle = args.settle_ms.clamp(1000, 4000);
    for sel in &args.clicks {
        match page.query_selector(sel) {
            Some(el) => match el.click() {
                Ok(()) => eprintln!("clicked {sel}"),
                Err(e) => eprintln!("click {sel} failed: {e}"),
            },
            None => eprintln!("selector not found: {sel}"),
        }
        page.settle(interact_settle).await;
    }
    for _ in 0..args.scrolls {
        let _ = page.evaluate("window.scrollTo(0, document.body.scrollHeight);");
        page.settle(interact_settle).await;
    }

    // Flush captured request/response pairs as NDJSON.
    let out = std::io::stdout();
    use std::io::Write;
    let mut w = out.lock();
    if let Ok(v) = captured.lock() {
        for rec in v.iter() {
            let _ = writeln!(w, "{}", rec);
        }
    }

    // Final page record: settled URL, HTML size, and the full cookie jar
    // (including HttpOnly session tokens set during the visit).
    let html = page.content();
    let cookies: Vec<serde_json::Value> = browser
        .cookies()
        .get_all()
        .into_iter()
        .map(|c| {
            json!({
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path,
                "secure": c.secure,
                "httpOnly": c.http_only,
            })
        })
        .collect();
    let page_rec = json!({
        "kind": "page",
        "url": page.url(),
        "requestedUrl": args.url,
        "htmlLen": html.len(),
        "cookies": cookies,
    });
    let _ = writeln!(w, "{}", page_rec);
}
