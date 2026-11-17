//! Local browser regression: a launch on a profile a running Chrome holds leaves that Chrome where it can be found.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};

#[test]
#[ignore = "requires installed Chrome"]
fn a_launch_on_a_held_profile_leaves_the_running_browser_findable() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("site.example");
    let options = LaunchOptions {
        headless: true,
        profile: Some(profile.to_string_lossy().into_owned()),
        ..Default::default()
    };
    let running = launch_chrome(&options).expect("the first browser opens");
    let port_file = profile.join("DevToolsActivePort");
    let found = std::fs::read_to_string(&port_file).expect("the running browser can be found");
    let preferences = profile.join("Default").join("Preferences");
    let written = std::fs::metadata(&preferences).and_then(|m| m.modified()).ok();

    let error = launch_chrome(&options).err().expect("a profile opens in one browser at a time");

    assert_eq!(std::fs::read_to_string(&port_file).ok().as_deref(), Some(found.as_str()), "the running browser can't be found any more");
    assert_eq!(std::fs::metadata(&preferences).and_then(|m| m.modified()).ok(), written, "the running browser's preferences were written over");
    assert!(error.contains("already open in a running browser"), "{error}");

    // A browser that went without closing leaves its marks in the profile, and they hold nothing.
    drop(running);
    let next = launch_chrome(&options);
    assert!(next.is_ok(), "{:?}", next.err());
}
