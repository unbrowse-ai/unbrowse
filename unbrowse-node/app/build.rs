use std::process::Command;

fn main() {
    usage_descriptions();
    println!("cargo:rerun-if-env-changed=UNBROWSE_RELEASE");
    println!("cargo:rerun-if-changed=src/update.rs");
    let release = std::env::var("UNBROWSE_RELEASE").as_deref() == Ok("1");
    if !release {
        return;
    }
    let date = Command::new("date")
        .args(["-u", "+%F"])
        .output()
        .expect("read UTC build date");
    let date = String::from_utf8(date.stdout)
        .expect("UTC build date is UTF-8")
        .trim()
        .to_owned();
    println!("cargo:rustc-env=UNBROWSE_BUILD_DATE_UTC={date}");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:warning=release build date (UTC): {date}");
    if date.as_str() < "2026-12-15" {
        println!("cargo:warning=UPDATE ROOT TRANSITION DEADLINE: the empty-key online-root exception expires 2026-12-15 UTC");
    }
}

/// On macOS, the node carries the reasons it gives for the hardware it asks the owner about: Bluetooth, to reach their
/// phone when a page asks for their passkey (`owner_authn`). macOS ends a program that asks with no reason given, and
/// the node runs as a program of its own (launchd starts it), not as its bundle's main program, so it carries its own
/// list in its `__info_plist` section. No bundle identifier: the release signs each program under a fixed one
/// (package-macos.sh), and codesign would take one from here otherwise.
fn usage_descriptions() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let plist = out.join("Info.plist");
    std::fs::write(
        &plist,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>Unbrowse uses Bluetooth to reach your phone when a site asks for your passkey.</string>
</dict>
</plist>
"#,
    )
    .expect("write the node's Info.plist");
    println!("cargo:rustc-link-arg-bin=unbrowse-node=-Wl,-sectcreate,__TEXT,__info_plist,{}", plist.display());
}
