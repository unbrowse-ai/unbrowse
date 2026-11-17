//! The in-process mint, live: one library call, no CLI, no daemon.

use unbrowse_learn::mint::{BrowserMint, Mint};

fn main() {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://www.carousell.sg/toys/q/".to_string());
    let mut mint = BrowserMint {
        try_controls: false,
        frames: None,
        seed: Vec::new(),
        browser: "unused-in-process".into(),
        cdp_endpoint: None,
        user_agent: Some("unbrowse-node/0.1.0".to_string()),
        session: "mintprobe".into(),
        capture_dir: std::env::temp_dir().join("mintprobe-capture"),
        profile: dirs::home_dir().map(|h| {
            h.join(".unbrowse/profiles/www.carousell.sg").to_string_lossy().into_owned()
        }),
        _host: url.clone(),
    };
    // One identity end to end: the browser earns the clearance under the
    // node's own name, so the browserless client can present it honestly.
    std::env::set_var("UNBROWSE_MINT_UA", "unbrowse-node/0.1.0");
    let t = std::time::Instant::now();
    match mint.mint(&url.parse().unwrap()) {
        Ok(s) => {
            println!("== in-process mint: {} cookies, {} tokens in {:.1}s",
                s.cookies.len(), s.tokens.len(), t.elapsed().as_secs_f32());
            // Hand the jar to the browserless path: this is the hand-off the
            // whole stack exists for.
            std::fs::create_dir_all("/tmp/unbrowse-jar").ok();
            std::fs::write(
                "/tmp/unbrowse-jar/www.carousell.sg.json",
                serde_json::to_string(&s.cookies).unwrap_or_default(),
            )
            .ok();
            let mut names: Vec<_> = s.cookies.keys().cloned().collect();
            names.sort();
            println!("   {}", names.join(" "));
        }
        Err(e) => println!("== mint failed: {e:?}"),
    }
}
