use std::fs;
use std::path::Path;

/// Ensure `packages/dashboard/out/` exists so `rust-embed` doesn't fail during
/// Rust-only dev builds where the dashboard hasn't been built. The placeholder
/// `index.html` is only written when the directory is completely absent.
fn ensure_dashboard_dir() {
    let dashboard_out = Path::new("../packages/dashboard/out");
    println!("cargo:rerun-if-changed=../packages/dashboard/out");
    if !dashboard_out.join("index.html").exists() {
        let _ = fs::create_dir_all(dashboard_out);
        let _ = fs::write(
            dashboard_out.join("index.html"),
            "<!DOCTYPE html><html><body><p>Dashboard not built. Run: cd packages/dashboard &amp;&amp; pnpm build</p></body></html>\n",
        );
    }
}

fn main() {
    ensure_dashboard_dir();
}
