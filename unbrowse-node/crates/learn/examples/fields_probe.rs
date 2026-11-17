//! Which fields a call would hand back by default for an answer, and which lists of records the answer holds.
//!
//!     cargo run -p unbrowse-learn --example fields_probe -- <answer.json> "<goal>" [asked-value ...]
//!
//! Prints how many fields the answer has, its lists by how many fields each holds, and the defaults chosen.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(path), Some(goal)) = (args.first(), args.get(1)) else {
        eprintln!("usage: fields_probe <answer.json> \"<goal>\" [asked-value ...]");
        std::process::exit(2);
    };
    let asked: Vec<String> = args.iter().skip(2).cloned().collect();
    let answer: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the answer file")).expect("JSON");
    let all = unbrowse_learn::fields::paths(&answer);
    let mut lists: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for f in &all {
        let list = f.path.rfind("[]").into_iter().chain(f.path.rfind("{}")).max().map(|at| f.path[..at + 2].to_string()).unwrap_or_default();
        *lists.entry(list).or_default() += 1;
    }
    println!("{} fields", all.len());
    let mut by_size: Vec<(&String, &usize)> = lists.iter().collect();
    by_size.sort_by(|a, b| b.1.cmp(a.1));
    for (list, n) in by_size.iter().take(8) {
        println!("  {n:>4} in {}", if list.is_empty() { "(the answer itself)" } else { list.as_str() });
    }
    println!("defaults:");
    // PROBE_PAGE names the page the route was learned on: a list that leads back to it is its menu, not its records.
    let page = std::env::var("PROBE_PAGE").unwrap_or_default();
    for p in unbrowse_learn::fields::defaults_on(&all, goal, &asked, &page) {
        println!("  {p}");
    }
}
