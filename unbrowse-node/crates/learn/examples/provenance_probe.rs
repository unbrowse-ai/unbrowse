//! How long reading a walk's session values takes: loads one kept walk capture and times
//! [`unbrowse_learn::provenance::session_values`] on it, the reading every learn makes of its walk, often more than once.
//!
//!   cargo run -p unbrowse-learn --example provenance_probe -- <capture dir> <session> [times]
//!
//! `<session>` is the capture's file name without `.jsonl`. Prints the walk's size, each run's time and the values found.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(dir), Some(session)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: provenance_probe <capture dir> <session> [times]");
        std::process::exit(2);
    };
    let times: usize = args.get(3).and_then(|t| t.parse().ok()).unwrap_or(1);
    let t0 = std::time::Instant::now();
    let Some(trace) = unbrowse_learn::walk::trace_from_walk(std::path::Path::new(dir), session) else {
        eprintln!("no walk {session} in {dir}");
        std::process::exit(1);
    };
    let bytes: usize = trace.exchanges.iter().map(|e| e.response_body.as_deref().map_or(0, str::len)).sum();
    println!("walk: {} exchanges, {} body bytes, read in {} ms", trace.exchanges.len(), bytes, t0.elapsed().as_millis());
    let sent: Vec<String> = trace
        .exchanges
        .iter()
        .filter(|e| !e.is_asset())
        .flat_map(unbrowse_learn::slots::slots)
        .filter(|s| !matches!(s.loc, unbrowse_learn::slots::Loc::Cookie(_)))
        .map(|s| s.value)
        .filter(|v| v.len() >= unbrowse_learn::provenance::MIN_TRACEABLE && !unbrowse_learn::provenance::a_plain_word(v))
        .collect();
    let distinct: std::collections::HashSet<&String> = sent.iter().collect();
    let longest = sent.iter().map(String::len).max().unwrap_or(0);
    println!("values searched: {} ({} distinct, longest {} bytes)", sent.len(), distinct.len(), longest);
    for run in 1..=times {
        let t = std::time::Instant::now();
        let held = unbrowse_learn::provenance::session_values(&trace);
        let mut sorted = held.clone();
        sorted.sort();
        let digest = sorted.iter().fold(0xcbf29ce484222325u64, |h, v| v.bytes().chain([0]).fold(h, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)));
        println!("session_values run {run}: {} ms, {} values, digest {digest:016x}", t.elapsed().as_millis(), held.len());
    }
}
