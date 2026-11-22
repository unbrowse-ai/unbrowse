//! Reads saved answers and says what wall each is (`refusal::read`), one line each: `<file>\t<status>\t<wall or page>`.
//! Each file is JSON with `status`, `html` and the address it was answered at (`final`, else `url`): what a walk of
//! the page kept. Nothing is asked of any site.
use unbrowse_learn::refusal::{read, Answer};

fn main() {
    for path in std::env::args().skip(1) {
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let status = v["status"].as_u64().unwrap_or(0) as u16;
        let at = v["final"].as_str().filter(|u| u.starts_with("http")).or(v["url"].as_str()).unwrap_or_default();
        let Ok(url) = url::Url::parse(at) else { continue };
        let asked = v["url"].as_str().and_then(|u| url::Url::parse(u).ok());
        let wall = read(&Answer { status, body: v["html"].as_str().unwrap_or_default(), url: &url, asked: asked.as_ref() });
        let name = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or(&path);
        println!("{name}\t{status}\t{}", wall.map_or("page".to_string(), |w| serde_json::to_value(&w).ok().and_then(|j| j["wall"].as_str().map(String::from)).unwrap_or_default()));
    }
}
