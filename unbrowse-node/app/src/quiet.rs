//! Quieting the agent's other pages while a card checkout waits for the owner: belt and braces.
//!
//! What holds is the browsers' egress proxy (`browse::browser_may_connect`): while a hold is active, only the checkout's
//! own browser makes any connection. On top of that, when a hold begins, every page of the node's browsers but the
//! checkout's own tab is frozen through the browser's own protocol (`Page.setWebLifecycleState {state: "frozen"}`,
//! after `Page.stopLoading`): its timers, its tasks and its dedicated workers stop. A service worker or a shared worker
//! has no frozen state, so it is closed (`Target.closeTarget`); the site starts it again when it is next needed. When
//! the last hold is released every page is made active again. What couldn't be enumerated or frozen is said to the
//! owner at the hand-off; the proxy refuses it all the same.

use serde_json::{json, Value};
use unbrowse_learn::cdp::client::CdpClient;

/// What a pass over one browser did: how many targets it froze or closed, and what it couldn't.
#[derive(Debug, Default)]
pub struct Quieted {
    pub done: usize,
    pub failed: Vec<String>,
}

/// Sets every page target of the browser at `ws` but `keep` to `state` (`frozen` or `active`); when freezing, also
/// closes every service worker and shared worker. Says each target it couldn't.
pub async fn set_pages(ws: &str, keep: Option<&str>, state: &str) -> Result<Quieted, String> {
    let cdp = CdpClient::connect(ws).await.map_err(|e| format!("couldn't reach the browser's DevTools: {e}"))?;
    let targets = cdp.send_command("Target.getTargets", None, None).await;
    let out = match targets {
        Err(e) => Err(format!("couldn't list the browser's pages and workers: {e}")),
        Ok(targets) => {
            let mut q = Quieted::default();
            for t in targets["targetInfos"].as_array().into_iter().flatten() {
                let id = t["targetId"].as_str().unwrap_or_default();
                let kind = t["type"].as_str().unwrap_or_default();
                if Some(id) == keep {
                    continue;
                }
                let done = match kind {
                    "page" => set_page(&cdp, id, state).await.map(|_| ()),
                    "service_worker" | "shared_worker" if state == "frozen" => cdp.send_command("Target.closeTarget", Some(json!({ "targetId": id })), None).await.map(|_| ()),
                    _ => continue,
                };
                match done {
                    Ok(()) => q.done += 1,
                    Err(e) => q.failed.push(format!("{kind} at {}: {e}", t["url"].as_str().unwrap_or_default())),
                }
            }
            Ok(q)
        }
    };
    cdp.close().await;
    out
}

async fn set_page(cdp: &CdpClient, target: &str, state: &str) -> Result<Value, String> {
    let attached = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": target, "flatten": true })), None).await?;
    let session = attached["sessionId"].as_str().ok_or("no session")?.to_string();
    if state == "frozen" {
        let _ = cdp.send_command("Page.stopLoading", None, Some(&session)).await;
    }
    let set = cdp.send_command("Page.setWebLifecycleState", Some(json!({ "state": state })), Some(&session)).await;
    let _ = cdp.send_command("Target.detachFromTarget", Some(json!({ "sessionId": session })), None).await;
    set
}

/// Freezes every page, and closes every service and shared worker, of every browser the node runs but `keep` (the
/// checkout's own tab): when a hold begins, and again at the hand-off, so a target created during the hold is caught
/// then. Blocking. Says what it couldn't; the proxy holds those all the same.
pub fn quiet(keep: Option<&str>) -> Vec<String> {
    let mut failed = Vec::new();
    for ws in crate::browse::devtools_of_running_browsers() {
        match run(set_pages(&ws, keep, "frozen")) {
            Ok(q) => failed.extend(q.failed),
            Err(e) => failed.push(e),
        }
    }
    failed
}

/// Makes every page of every browser the node runs active again, once no hold remains. Blocking.
pub fn wake() {
    for ws in crate::browse::devtools_of_running_browsers() {
        let _ = run(set_pages(&ws, None, "active"));
    }
}

fn run<T>(f: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A page timer and a dedicated worker's timer, started before a hold, send nothing while the page is frozen
    /// through the browser's protocol, though the node's DevTools session has let go of the page; made active again,
    /// both send again. Driven against real Chrome.
    #[test]
    #[ignore = "drives Chrome: cargo test -p unbrowse-node-app a_page_timer_started_before -- --ignored"]
    fn a_page_timer_started_before_the_hold_sends_nothing_during_it() {
        use std::io::{Read, Write};
        let ticks = Arc::new(AtomicUsize::new(0));
        let worker_ticks = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (t, w) = (ticks.clone(), worker_ticks.clone());
        let page = format!(
            r#"<!doctype html><html><body><script>
  setInterval(() => fetch('/tick', {{ method: 'POST', body: 'x' }}), 100);
  const src = "setInterval(() => fetch('http://127.0.0.1:{port}/wtick', {{ method: 'POST', body: 'w' }}), 100);";
  new Worker(URL.createObjectURL(new Blob([src], {{ type: 'text/javascript' }})));
</script></body></html>"#
        );
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                if req.starts_with("POST /tick") {
                    t.fetch_add(1, Ordering::SeqCst);
                } else if req.starts_with("POST /wtick") {
                    w.fetch_add(1, Ordering::SeqCst);
                }
                let body = if req.starts_with("GET /") { page.clone() } else { String::new() };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\naccess-control-allow-origin: *\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let path = agent_browser_core::cdp::chrome::find_chrome().expect("Chrome");
        let profile = std::env::temp_dir().join(format!("quiet-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let mut child = std::process::Command::new(path)
            .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu"])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("http://127.0.0.1:{port}/"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut ws = None;
        for _ in 0..150 {
            if let Some((p, path)) = agent_browser_core::cdp::chrome::read_devtools_active_port(&profile) {
                ws = Some(format!("ws://127.0.0.1:{p}{path}"));
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let ws = ws.expect("Chrome opened its DevTools");
        // Chrome is let go of whatever an assertion says.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            std::thread::sleep(Duration::from_millis(1500));
            let (a, b) = (ticks.load(Ordering::SeqCst), worker_ticks.load(Ordering::SeqCst));
            assert!(a > 3 && b > 3, "the page and its worker send before the hold: {a} {b}");
            let frozen = run(set_pages(&ws, None, "frozen")).unwrap();
            assert!(frozen.done >= 1 && frozen.failed.is_empty(), "a page was frozen: {frozen:?}");
            std::thread::sleep(Duration::from_millis(400));
            let (a0, b0) = (ticks.load(Ordering::SeqCst), worker_ticks.load(Ordering::SeqCst));
            std::thread::sleep(Duration::from_millis(1500));
            let (a1, b1) = (ticks.load(Ordering::SeqCst), worker_ticks.load(Ordering::SeqCst));
            assert_eq!(a1, a0, "the page's timer sent nothing while frozen, the DevTools session gone");
            assert_eq!(b1, b0, "nor its worker's");
            run(set_pages(&ws, None, "active")).unwrap();
            // A page made active again runs its timers as a background tab does (about once a second) until it is
            // brought forward; its worker at full rate.
            std::thread::sleep(Duration::from_millis(4000));
            let (a2, b2) = (ticks.load(Ordering::SeqCst), worker_ticks.load(Ordering::SeqCst));
            assert!(a2 >= a1 + 2 && b2 > b1 + 10, "made active, both send again: {a1}->{a2} {b1}->{b2}");
        }));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&profile);
        if let Err(failed) = result {
            std::panic::resume_unwind(failed);
        }
    }
}

#[cfg(test)]
#[path = "quiet_cov_tests.rs"]
mod quiet_cov_tests;
