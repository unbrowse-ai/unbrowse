//! What a page a walk captured answers with, and why: the page read, or the state it embeds.
//!
//!     cargo run -p unbrowse-learn --example page_probe -- <capture.jsonl> <url-fragment> [asked-value ...]
//!
//! Prints, for the first captured response whose address holds the fragment: how much the page read says, whether it
//! says each asked value, and which of the two `page::answer_asked` took.

use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(path), Some(fragment)) = (args.first(), args.get(1)) else {
        eprintln!("usage: page_probe <capture.jsonl> <url-fragment> [asked-value ...]");
        std::process::exit(2);
    };
    let asked: Vec<&str> = args.iter().skip(2).map(String::as_str).collect();
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(2);
    });
    let Some((url, body)) = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find_map(|v| {
        let url = v.get("url")?.as_str()?.to_string();
        let body = v.get("body")?.as_str().filter(|b| !b.is_empty())?.to_string();
        (v.get("type")?.as_str()? == "response" && url.contains(fragment.as_str())).then_some((url, body))
    }) else {
        eprintln!("no captured response at an address holding {fragment}");
        std::process::exit(1);
    };
    let base = url::Url::parse(&url).expect("a captured address");
    let page = unbrowse_learn::page::read(&body, &base);
    let said = page["text"].as_str().unwrap_or_default();
    println!("page: {url}\n  {} bytes; read: {} lines, {} words by spaces, {} characters", body.len(), said.lines().count(), said.split_whitespace().count(), said.chars().count());
    for v in &asked {
        println!("  the read says {v:?}: {}", unbrowse_learn::page::says_most_of(said, v));
    }
    let (answer, is_page) = unbrowse_learn::page::answer_asked(&body, &base, &asked);
    let keys: Vec<&String> = answer.as_object().map(|o| o.keys().take(8).collect()).unwrap_or_default();
    println!("  answers with: {} (top keys {keys:?}, {} bytes)", if is_page { "the page read" } else { "the state it embeds" }, answer.to_string().len());
    if !is_page {
        println!("  the state holds the page: {}", unbrowse_learn::page::holds_the_page(&answer, said));
        for v in &asked {
            println!("  the state says {v:?}: {}", unbrowse_learn::trace::carries_text(&answer.to_string(), v));
        }
    }
}
