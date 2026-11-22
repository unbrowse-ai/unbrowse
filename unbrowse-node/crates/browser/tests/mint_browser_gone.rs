//! Local browser regression: a walk whose browser went ends then, not when its time runs out.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::session::{mint, MintOptions};
use std::time::{Duration, Instant};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_walk_ends_when_its_browser_goes() {
    let profile = tempfile::tempdir().unwrap();
    let options = LaunchOptions {
        headless: true,
        profile: Some(profile.path().to_string_lossy().into_owned()),
        ..Default::default()
    };
    let mut chrome = launch_chrome(&options).expect("a browser to walk in");
    let walk = tokio::spawn(mint(MintOptions {
        url: "data:text/html,<title>A page</title><body>The page itself.</body>".into(),
        session: "gone".into(),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        settle_ms: 60_000,
        ..Default::default()
    }));
    // Past the door, into the settle a walk would otherwise sit out.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let gone = Instant::now();
    chrome.kill();

    let walked = tokio::time::timeout(Duration::from_secs(20), walk).await;
    assert!(walked.is_ok(), "the walk went on for 20 s after its browser went");
    assert!(gone.elapsed() < Duration::from_secs(20));
    assert!(walked.unwrap().unwrap().is_err(), "a walk with no browser left has nothing to hand back");
}
