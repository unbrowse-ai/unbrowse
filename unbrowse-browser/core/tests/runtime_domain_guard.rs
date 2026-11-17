//! The engine never enables the runtime domain.
//!
//! That domain is readable from the page a walk drives, so the code that
//! visits sites must not send the command that turns it on. This reads the
//! engine's own source rather than replaying a walk, because the property
//! holds for every path through it — including the ones no live fixture
//! reaches.

use std::path::Path;

#[test]
fn the_engine_never_enables_the_runtime_domain() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    scan(&root, &mut offenders);
    assert!(
        offenders.is_empty(),
        "the runtime domain must stay off in engine code: {offenders:?}"
    );
}

fn scan(dir: &Path, offenders: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan(&path, offenders);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        if source.contains("\"Runtime.enable\"") {
            offenders.push(path.display().to_string());
        }
    }
}