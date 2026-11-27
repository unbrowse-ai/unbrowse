//! What the browser says it is.
//!
//! A launch mode is not a product. Chrome's headless build labels itself
//! `HeadlessChrome` in the user agent, so a page learns the session is
//! machine-driven before any script runs. The browser is Chrome; how it was
//! started is an internal detail, not part of its identity.
//!
//! Nothing here names a site, and nothing pretends to be a different browser:
//! the product, brands and version reported are the ones this browser reports
//! about itself, minus the launch switch. An identity worked out from the user
//! agent string is a guess at what the browser is, and a guess that names a
//! product the browser is not (a branded build it isn't, a brand list it never
//! sends) is a browser no real one matches.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::cdp::client::CdpClient;

/// What the identity needs of a browser connection: one command, to a session or to the browser. The engine's own
/// client has it, and so does any program that drives a browser of the node's (the browser CLI the agent's hands go
/// through), so every browser the node runs is given its identity by the same code (`apply_browser_identity`) and not
/// by a copy that knows fewer cases.
pub trait Commands: Sync {
    fn command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send;
}

impl Commands for CdpClient {
    fn command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        self.send_command(method, params, session_id)
    }
}

/// The same browser without the launch mode in its name.
pub fn honest_user_agent(ua: &str) -> String {
    ua.replace("HeadlessChrome/", "Chrome/")
}

/// The browser's own account of itself, as a page of its own reads it: the
/// brands, versions and platform it sends as client hints.
const OWN_REPORT: &str = r#"(async () => {
  const d = navigator.userAgentData;
  if (!d) return null;
  const h = await d.getHighEntropyValues(
    ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'wow64']);
  return { brands: d.brands, mobile: d.mobile, platform: d.platform, ...h };
})()"#;

/// Client hints for the override, taken from what the browser reported about
/// itself. Every field is the browser's own; none is filled in.
pub fn hints_from_report(report: &Value) -> Option<Value> {
    let brands = report.get("brands")?.as_array()?;
    if brands.is_empty() {
        return None;
    }
    let mut hints = json!({
        "brands": brands,
        "platform": report.get("platform")?.as_str()?,
        "mobile": report.get("mobile")?.as_bool()?,
    });
    for key in [
        "fullVersionList",
        "platformVersion",
        "architecture",
        "model",
        "bitness",
        "wow64",
        "formFactors",
    ] {
        if let Some(value) = report.get(key) {
            hints[key] = value.clone();
        }
    }
    // CDP requires these three; a browser that reported none of them has said
    // too little to be repeated faithfully.
    for key in ["platformVersion", "architecture", "model"] {
        hints.get(key)?;
    }
    Some(hints)
}

/// What each browser build said about itself, keyed by the build. `None` while
/// it is being asked: the page the browser is asked on is itself a new target,
/// and a caller that prepares every new target must not ask again for it.
fn reports() -> &'static Mutex<HashMap<String, Option<Value>>> {
    static REPORTS: OnceLock<Mutex<HashMap<String, Option<Value>>>> = OnceLock::new();
    REPORTS.get_or_init(Default::default)
}

/// How long a page waits for an answer another page is already getting. Asking takes a fraction of a second; a browser
/// that takes longer goes as it would have if it couldn't say.
const ASKED_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The report the build is being asked for by someone else, once it is in.
async fn asked_elsewhere(build: &str) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + ASKED_WAIT;
    while tokio::time::Instant::now() < deadline {
        match reports().lock().unwrap_or_else(|e| e.into_inner()).get(build) {
            Some(Some(report)) => return Some(report.clone()),
            Some(None) => {}
            // Whoever was asking gave up, and the next page asks.
            None => return None,
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    None
}

/// Marks a build as being asked, and takes the mark back unless an answer replaced it: a caller can drop the asking
/// mid-way, and a mark left behind would have every later page wait for an answer nobody is getting.
struct Asking(String);

impl Drop for Asking {
    fn drop(&mut self) {
        let mut reports = reports().lock().unwrap_or_else(|e| e.into_inner());
        if matches!(reports.get(&self.0), Some(None)) {
            reports.remove(&self.0);
        }
    }
}

/// Ask the browser what it is, on a page of its own. Client hints are only
/// offered to secure documents, and the walked tab is not one yet; the
/// browser's own `chrome://version` is, opens without the network, and is a
/// browser page, not a tab anyone is driving.
pub async fn own_identity<C: Commands>(client: &C) -> Result<Value, String> {
    let created = client
        .command(
            "Target.createTarget",
            Some(json!({ "url": "chrome://version", "background": true })),
            None,
        )
        .await?;
    let target = created
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or("Target.createTarget returned no targetId")?
        .to_string();
    let read = async {
        let attached = client
            .command(
                "Target.attachToTarget",
                Some(json!({ "targetId": target, "flatten": true })),
                None,
            )
            .await?;
        let session = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("Target.attachToTarget returned no sessionId")?;
        // A browser that holds new targets for its debugger holds this one too.
        let _ = client
            .command("Runtime.runIfWaitingForDebugger", None, Some(session))
            .await;
        for _ in 0..40 {
            let evaluated = client
                .command(
                    "Runtime.evaluate",
                    Some(json!({ "expression": OWN_REPORT, "awaitPromise": true, "returnByValue": true })),
                    Some(session),
                )
                .await?;
            if let Some(report) = evaluated.pointer("/result/value").filter(|v| v.is_object()) {
                return Ok(report.clone());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err("the browser did not report its own identity".to_string())
    }
    .await;
    let _ = client
        .command("Target.closeTarget", Some(json!({ "targetId": target })), None)
        .await;
    read
}

/// Make the session report the browser it is, without the launch mode.
///
/// A browser with a window already reports itself, and is left alone. A
/// headless one is given its own report back with the switch taken out of the
/// name; when it cannot say what it is, it is left as it is rather than made
/// into something it is not.
pub async fn apply_browser_identity<C: Commands>(client: &C, session_id: &str) -> Result<(), String> {
    let version = client
        .command("Browser.getVersion", None, None)
        .await
        .map_err(|e| format!("Browser.getVersion: {e}"))?;
    let ua = version
        .get("userAgent")
        .and_then(Value::as_str)
        .ok_or("Browser.getVersion returned no userAgent")?;
    let honest = honest_user_agent(ua);
    if honest == ua {
        return Ok(());
    }
    let build = format!(
        "{} {} {ua}",
        version.get("product").and_then(Value::as_str).unwrap_or_default(),
        version.get("revision").and_then(Value::as_str).unwrap_or_default(),
    );
    let known = {
        let mut reports = reports().lock().unwrap_or_else(|e| e.into_inner());
        match reports.get(&build) {
            Some(known) => Some(known.clone()),
            None => {
                reports.insert(build.clone(), None);
                None
            }
        }
    };
    let report = match known {
        Some(Some(report)) => report,
        // Being asked right now, and the mark is process-wide: this may be the page it is asked on, or another walk's
        // page in another browser of the same build. Either can wait for the answer; the second must, or it goes out
        // as what it was launched as.
        Some(None) => match asked_elsewhere(&build).await {
            Some(report) => report,
            None => return Ok(()),
        },
        None => {
            let asking = Asking(build.clone());
            let report = own_identity(client).await?;
            reports().lock().unwrap_or_else(|e| e.into_inner()).insert(build, Some(report.clone()));
            drop(asking);
            report
        }
    };
    let hints = hints_from_report(&report)
        .ok_or_else(|| format!("the browser's own report is incomplete: {report}"))?;
    client
        .command(
            "Emulation.setUserAgentOverride",
            Some(json!({ "userAgent": honest, "userAgentMetadata": hints })),
            Some(session_id),
        )
        .await
        .map_err(|e| format!("Emulation.setUserAgentOverride: {e}"))?;
    Ok(())
}

/// The window a browser shows: bigger than its page (the tab strip and the
/// address bar are not page) and never bigger than the screen it is on.
/// Headless Chrome reports a page as tall as its window and a screen smaller
/// than both, which no real display produces.
pub async fn apply_window_metrics(
    client: &CdpClient,
    session_id: &str,
    window: (u32, u32),
) -> Result<(), String> {
    let (window_w, window_h) = window;
    // Chrome's own furniture around the page, at the default zoom.
    let furniture = 88u32;
    let page_h = window_h.saturating_sub(furniture);
    let screen_w = window_w.max(1920);
    let screen_h = (window_h + furniture).max(1080);
    client
        .send_command(
            "Emulation.setDeviceMetricsOverride",
            Some(json!({
                "width": window_w,
                "height": page_h,
                "deviceScaleFactor": 1,
                "mobile": false,
                "screenWidth": screen_w,
                "screenHeight": screen_h,
                "screenOrientation": { "type": "landscapePrimary", "angle": 90 },
                "positionX": 0,
                "positionY": 0,
                "dontSetVisibleSize": true
            })),
            Some(session_id),
        )
        .await
        .map_err(|e| format!("Emulation.setDeviceMetricsOverride: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mark left by an asking that was dropped would have every later page wait on nobody; an answer stays.
    #[test]
    fn a_dropped_asking_takes_its_mark_back_and_an_answer_stays() {
        let key = "a-build-nobody-else-tests";
        reports().lock().unwrap().insert(key.to_string(), None);
        drop(Asking(key.to_string()));
        assert!(!reports().lock().unwrap().contains_key(key));

        reports().lock().unwrap().insert(key.to_string(), Some(json!({ "said": true })));
        drop(Asking(key.to_string()));
        assert!(matches!(reports().lock().unwrap().get(key), Some(Some(_))));
        reports().lock().unwrap().remove(key);
    }

    /// A page that finds the build being asked gets the answer the other page got, once it comes.
    #[tokio::test]
    async fn a_page_waits_for_the_answer_another_page_is_getting() {
        let key = "a-build-asked-elsewhere";
        reports().lock().unwrap().insert(key.to_string(), None);
        let answer = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            reports().lock().unwrap().insert(key.to_string(), Some(json!({ "said": true })));
        });
        assert_eq!(asked_elsewhere(key).await, Some(json!({ "said": true })));
        answer.await.unwrap();
        reports().lock().unwrap().remove(key);
    }

    const HEADLESS: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36";
    const HEADED: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

    /// What an unbranded Chrome build reported about itself on its own page.
    fn report() -> Value {
        json!({
            "brands": [{ "brand": "Chromium", "version": "155" }, { "brand": "Not(A:Brand", "version": "24" }],
            "mobile": false,
            "platform": "macOS",
            "architecture": "arm",
            "bitness": "64",
            "formFactors": ["Desktop"],
            "fullVersionList": [{ "brand": "Chromium", "version": "155.0.8059.79" }, { "brand": "Not(A:Brand", "version": "24.0.0.0" }],
            "model": "",
            "platformVersion": "26.3.1",
            "wow64": false
        })
    }

    #[test]
    fn a_launch_mode_leaves_the_product_name() {
        assert_eq!(honest_user_agent(HEADLESS), HEADED);
    }

    #[test]
    fn a_headed_user_agent_is_unchanged() {
        assert_eq!(honest_user_agent(HEADED), HEADED);
    }

    #[test]
    fn hints_are_the_brands_the_browser_reported_and_no_others() {
        let hints = hints_from_report(&report()).unwrap();
        assert_eq!(hints["brands"], report()["brands"]);
        assert_eq!(hints["fullVersionList"], report()["fullVersionList"]);
    }

    #[test]
    fn hints_carry_the_platform_the_browser_reported() {
        let hints = hints_from_report(&report()).unwrap();
        for key in ["platform", "platformVersion", "architecture", "bitness", "model", "mobile", "wow64", "formFactors"] {
            assert_eq!(hints[key], report()[key], "{key}");
        }
    }

    #[test]
    fn a_report_without_brands_yields_no_hints() {
        let mut silent = report();
        silent["brands"] = json!([]);
        assert!(hints_from_report(&silent).is_none());
        assert!(hints_from_report(&json!({})).is_none());
    }

    #[test]
    fn a_report_missing_what_cdp_requires_yields_no_hints() {
        let mut partial = report();
        partial.as_object_mut().unwrap().remove("platformVersion");
        assert!(hints_from_report(&partial).is_none());
    }
}
