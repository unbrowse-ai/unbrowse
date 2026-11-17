// The reader `scripts/older-node/check.sh` builds against an older node's route crate.
// Reads each JSON body given on the command line with the base's route crate (e84b5f48), as an older node's store
// does (`a_body_that_reads`: parse, then refused() is None), and prints whether it would run it.
fn main() {
    for path in std::env::args().skip(1) {
        let text = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let read = serde_json::from_value::<unbrowse_route::Route>(value);
        let runs = match &read { Ok(b) => b.refused().is_none(), Err(_) => false };
        println!("{path}: {}", match read { Ok(_) if runs => "READ AS A BODY".to_string(), Ok(b) => format!("read, refused: {:?}", b.refused()), Err(e) => format!("no body ({e})") });
    }
}
