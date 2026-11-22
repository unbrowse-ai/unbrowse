//! Local browser regression: a walk whose caller gave up on it ends then, not when its time runs out, and its browser
//! goes with it.
use agent_browser_core::session::{mint, MintOptions, STOPPED};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_walk_nobody_waits_for_ends_and_closes_its_browser() {
    let profile = tempfile::tempdir().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let walk = tokio::spawn(mint(MintOptions {
        url: "data:text/html,<title>A page</title><body>The page itself.</body>".into(),
        session: "stopped".into(),
        profile: Some(profile.path().to_string_lossy().into_owned()),
        settle_ms: 60_000,
        stop: Some(stop.clone()),
        ..Default::default()
    }));
    // Past the door, into the settle a walk would otherwise sit out.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let asked = Instant::now();
    stop.store(true, Ordering::Relaxed);
    let walked = tokio::time::timeout(Duration::from_secs(5), walk).await.expect("the walk went on after it was stopped").unwrap();
    assert!(asked.elapsed() < Duration::from_secs(2), "stopped within a look or two: {:?}", asked.elapsed());
    assert_eq!(walked.err().as_deref(), Some(STOPPED));
    // Its browser is gone: nothing still runs in its profile.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ps = std::process::Command::new("ps").args(["-A", "-o", "command="]).output().unwrap();
    let left = String::from_utf8_lossy(&ps.stdout).lines().filter(|l| l.contains(&*profile.path().to_string_lossy())).count();
    assert_eq!(left, 0, "the walk's browser outlived it");
}
