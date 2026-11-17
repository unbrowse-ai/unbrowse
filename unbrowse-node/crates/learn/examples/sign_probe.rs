//! What a walk's own code did to a request's signature headers, read from a capture log.
//!
//! A site's anti-bot headers are computed by the page's scripts from values the walk already holds: the request's
//! body, the page's identities (a UBT vid, a GUID), a token the site issued. The producer is a function in one of the
//! walk's scripts; this prints the script, the code around the header it fills, and the recorded requests that
//! carried it — the facts a replay needs to run that code again instead of opening a browser.
//!
//!     cargo run -p unbrowse-learn --example sign_probe -- <capture.jsonl> [header ...]
//!
//! The capture is `<node home>/tmp/unbrowse-node-walks/learn_<id>.jsonl` (one JSON object per line: requests with
//! their headers and body, responses with their body). With no header named it reads the ones that look signed:
//! `w-`, `x-ctx-`, `x-`, `token`.

use serde_json::Value;
use std::path::PathBuf;

/// The header a site signs its calls with: its own name for it, never a standard one the browser sets.
fn is_signature(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    (n.starts_with("x-") || n.starts_with("w-") || n == "token") && !matches!(n.as_str(), "x-requested-with")
}

fn headers(v: &Value) -> Vec<(String, String)> {
    match v.get("headers") {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.as_str().unwrap_or_default().to_string())).collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|h| Some((h.get("name")?.as_str()?.to_ascii_lowercase(), h.get("value")?.as_str()?.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first().map(PathBuf::from) else {
        eprintln!("usage: sign_probe <capture.jsonl> [header ...]");
        std::process::exit(2);
    };
    let wanted: Vec<String> = args.iter().skip(1).map(|h| h.to_ascii_lowercase()).collect();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("{}: {e}", path.display());
        std::process::exit(2);
    });
    let lines: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    // The walk's scripts, as the browser fetched them: the producer sits in one of these.
    let scripts: Vec<(&str, &str)> = lines
        .iter()
        .filter(|v| v.get("type").and_then(Value::as_str) == Some("response"))
        .filter_map(|v| {
            let url = v.get("url").and_then(Value::as_str)?;
            let body = v.get("body").and_then(Value::as_str).filter(|b| !b.is_empty())?;
            Some((url, body))
        })
        .filter(|(url, _)| url.ends_with(".js") || url.contains(".js?"))
        .collect();
    // The requests the walk made, and the signature headers each carried.
    let calls: Vec<(String, String, Vec<(String, String)>, usize)> = lines
        .iter()
        .filter(|v| v.get("type").and_then(Value::as_str) == Some("request"))
        .map(|v| {
            let url = v.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            let method = v.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
            let body = v
                .get("postData")
                .map(|p| match p {
                    Value::String(s) => s.clone(),
                    other => other.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
                })
                .unwrap_or_default();
            let hs: Vec<(String, String)> = headers(v).into_iter().filter(|(n, _)| is_signature(n)).collect();
            (method, url, hs, body.len())
        })
        .filter(|(_, _, hs, _)| !hs.is_empty())
        .collect();

    println!("== {} scripts, {} signed calls", scripts.len(), calls.len());
    let mut first = true;
    for (method, url, hs, body_len) in &calls {
        let named: Vec<&(String, String)> = hs.iter().filter(|(n, _)| wanted.is_empty() || wanted.contains(n)).collect();
        if named.is_empty() {
            continue;
        }
        println!("\n-- {method} {url}\n   body {body_len} bytes");
        for (name, value) in named {
            println!("   {name} = {value}");
            // Where the page's own code writes that header: the bundle that names it, and the line around it.
            for (script, body) in &scripts {
                let Some(at) = body.find(name.as_str()) else { continue };
                let mut start = body[..at].rfind('\n').map(|i| i + 1).unwrap_or(at.saturating_sub(400));
                while !body.is_char_boundary(start) {
                    start -= 1;
                }
                let mut end = at + body[at..].find('\n').unwrap_or(body.len().min(at + 400) - at);
                while !body.is_char_boundary(end) {
                    end -= 1;
                }
                let code: String = body[start..end].chars().take(700).collect();
                println!("   producer: {script} @ {at}");
                println!("   {}", code.trim());
                if first {
                    first = false;
                }
            }
        }
    }
}
