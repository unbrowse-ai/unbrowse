//! The page's own function for each value a route's page writes, run offline on the route's own page.
//!
//! For every page producer of a route, the program `slice::module_call` builds from its write site is printed and run
//! in the page-shaped sandbox on the page the route carries (its address, its markup, its scripts), with the step's own
//! request as the call. No site is asked: what it shows is whether the page's function answers off the route alone.
//! Run with UNBROWSE_SIGN_DEBUG=1 to see the page's console and the sandbox's errors.
//!
//!     cargo run -p unbrowse-learn --example page_call_probe -- <route.json>
fn main() {
    let path = std::env::args().nth(1).expect("a route file");
    let route: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("the route")).expect("JSON");
    let g = &route["graph"];
    let page = g["page"].as_str().unwrap_or_default().to_string();
    let html = g["page_html"].as_str().unwrap_or_default().to_string();
    let scripts: Vec<(String, String)> = g["scripts"].as_array().into_iter().flatten().map(|s| (s["url"].as_str().unwrap_or_default().to_string(), s["body"].as_str().unwrap_or_default().to_string())).collect();
    let borrowed: Vec<(&str, &str)> = scripts.iter().map(|(u, b)| (u.as_str(), b.as_str())).collect();
    for step in g["steps"].as_array().into_iter().flatten() {
        let url = step["url"].as_str().unwrap_or_default().split('?').next().unwrap_or_default().to_string();
        let method = step["method"].as_str().unwrap_or("GET");
        for p in step["page_producers"].as_array().into_iter().flatten() {
            let (Some(header), Ok(producer)) = (p["loc"]["key"].as_str(), serde_json::from_value::<unbrowse_learn::signing::Producer>(p["producer"].clone())) else { continue };
            // The function the route keeps for the value, where it keeps one; else the one read off the write site.
            let kept = serde_json::from_value::<unbrowse_learn::graph::PageFunction>(p["function"].clone()).ok().map(|f| unbrowse_learn::slice::render(&f));
            let Some(program) = kept.or_else(|| unbrowse_learn::slice::module_call(&borrowed, &producer, header)) else {
                println!("{header}: no module call at the write site");
                continue;
            };
            println!("{header}: {program}");
            let n: usize = std::env::var("PROBE_CALLS").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
            let ctxs: Vec<serde_json::Value> = (0..n).map(|_| unbrowse_learn::generated::context_of(method, &url, None, &[], &[])).collect();
            let t = std::time::Instant::now();
            let made = unbrowse_learn::sandbox::run_program_on_page_many(&program, &ctxs, &serde_json::Value::Null, &Default::default(), &page, &html, &[], &scripts);
            println!("{header}: {:?} in {} ms", made, t.elapsed().as_millis());
        }
    }
}
