//! Plays the agent: browses with the Unbrowse fork of agent-browser while the node's passive
//! capture is on. It never starts or stops a recording; the node reads the session log.

use std::path::PathBuf;
use std::process::Command;

/// The fork's binary: `UNBROWSE_BROWSER`, else the build in this repository. These tests are the
/// node learning from a real browser, so a missing build fails them; it never skips them.
pub fn browser() -> PathBuf {
    let path = std::env::var_os("UNBROWSE_BROWSER").map(PathBuf::from).unwrap_or_else(|| {
        built_browser(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../unbrowse-browser/cli/target/debug"), std::env::consts::EXE_SUFFIX)
    });
    assert!(
        path.exists(),
        "no browser at {}: build it (`cargo build` in unbrowse-browser/cli) or set UNBROWSE_BROWSER",
        path.display()
    );
    path
}

/// The CLI's build in `dir` on a system whose programs end in `suffix` (`.exe` on Windows, nothing elsewhere). Windows,
/// 22 Nov 2026: the name without `.exe` was never there, so the two shop tests failed unless UNBROWSE_BROWSER was set.
pub fn built_browser(dir: &std::path::Path, suffix: &str) -> PathBuf {
    dir.join(format!("agent-browser{suffix}"))
}

pub struct Agent {
    bin: PathBuf,
    session: String,
    capture_dir: PathBuf,
    /// The browser's own profile for this agent. Without one, every session reattaches to the machine's one
    /// browser, cookies and all, and a run would start from what the last one left.
    runtime_dir: PathBuf,
}

impl Agent {
    pub fn new(session: &str) -> Self {
        let session = format!("{session}-{}", std::process::id());
        let capture_dir = std::env::temp_dir().join(format!("unbrowse-capture-{}", std::process::id()));
        let _ = std::fs::remove_file(capture_dir.join(format!("{session}.jsonl")));
        let runtime_dir = std::env::temp_dir().join(format!("unbrowse-runtime-{session}"));
        let _ = std::fs::remove_dir_all(&runtime_dir);
        Self { bin: browser(), session, capture_dir, runtime_dir }
    }

    pub fn run(&self, args: &[&str]) -> String {
        let out = Command::new(&self.bin)
            .env("UNBROWSE_CAPTURE_DIR", &self.capture_dir)
            .env("AGENT_BROWSER_RUNTIME_DIR", &self.runtime_dir)
            .arg("--session")
            .arg(&self.session)
            .args(args)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(out.status.success(), "agent-browser {args:?} failed: {text}{}", String::from_utf8_lossy(&out.stderr));
        text
    }

    /// Ends the session and returns the capture log the node would read.
    pub fn finish(self) -> String {
        self.run(&["close"]);
        let _ = std::fs::remove_dir_all(&self.runtime_dir);
        std::fs::read_to_string(self.capture_dir.join(format!("{}.jsonl", self.session))).unwrap()
    }
}
