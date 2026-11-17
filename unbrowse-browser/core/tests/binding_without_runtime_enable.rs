//! A binding reports to the caller without the runtime domain being enabled.
//!
//! `Runtime.enable` is readable from the page being driven, so a flow that
//! needs only a binding should not pay for it. Measured here rather than
//! assumed: attach, add the binding, call it from the page, and require the
//! payload back with no `Runtime.enable` sent at any point.

use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::cdp::client::CdpClient;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_binding_reports_without_enabling_the_runtime_domain() {
    let profile = tempfile::tempdir().unwrap();
    let mut options = LaunchOptions::default();
    options.headless = true;
    options.profile = Some(profile.path().to_string_lossy().into_owned());
    let mut chrome = launch_chrome(&options).unwrap();

    let client = CdpClient::connect(&chrome.ws_url).await.unwrap();
    let mut bindings = client.subscribe_methods(&["Runtime.bindingCalled"]);
    let created = client
        .send_command(
            "Target.createTarget",
            Some(serde_json::json!({ "url": "about:blank" })),
            None,
        )
        .await
        .unwrap();
    let attached = client
        .send_command(
            "Target.attachToTarget",
            Some(serde_json::json!({ "targetId": created["targetId"], "flatten": true })),
            None,
        )
        .await
        .unwrap();
    let session = attached["sessionId"].as_str().unwrap();

    // Deliberately no Runtime.enable before or after this: the binding alone
    // has to carry the page's report back.
    client
        .send_command(
            "Runtime.addBinding",
            Some(serde_json::json!({ "name": "report" })),
            Some(session),
        )
        .await
        .unwrap();
    client
        .send_command(
            "Runtime.evaluate",
            Some(serde_json::json!({ "expression": "report('still-here')", "returnByValue": true })),
            Some(session),
        )
        .await
        .unwrap();

    let event = tokio::time::timeout(Duration::from_secs(5), bindings.recv())
        .await
        .expect("a binding reports without the runtime domain being enabled")
        .expect("the client stays connected");
    assert_eq!(event.params["name"].as_str(), Some("report"));
    assert_eq!(event.params["payload"].as_str(), Some("still-here"));
    chrome.kill();
}