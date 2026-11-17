use std::process::Command;

fn main() {
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
