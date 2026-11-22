//! How long shaping one answer for its caller takes: `fields::paths`, `fields::defaults` and `fields::shown_for` on an
//! answer kept as a file, the work every call of a route does before its reply goes out.
//!
//!     cargo run -p unbrowse-learn --example shown_probe -- <answer.json> "<goal>" [times]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(path), Some(goal)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: shown_probe <answer.json> \"<goal>\" [times]");
        std::process::exit(2);
    };
    let times: usize = args.get(3).and_then(|t| t.parse().ok()).unwrap_or(3);
    let answer: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the answer file")).expect("JSON");
    let t = std::time::Instant::now();
    let all = unbrowse_learn::fields::paths(&answer);
    println!("paths: {} fields in {} ms", all.len(), t.elapsed().as_millis());
    let defaults = unbrowse_learn::fields::defaults(&all, goal, &[]);
    for run in 1..=times {
        let t = std::time::Instant::now();
        let (kept, shown) = unbrowse_learn::fields::shown_for(&answer, &defaults, &[], goal);
        println!("shown_for run {run}: {} ms, {} bytes kept, {} more", t.elapsed().as_millis(), kept.to_string().len(), shown.more_total);
    }
}
