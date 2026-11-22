//! The captcha-solver transport: the last-resort clearance source.
//!
//! When the node cannot earn a site's clearance any other way — its own walk is flagged and walled, and the owner
//! holds no clean session to take in ([`crate::import::when_signed_out`]) — a wall is met with a transport or a
//! solver, as the engine's own words say (`client.rs`: "a wall, a transport or a solver"). This is that solver,
//! behind a config pointer: the node asks a configured service for a token for the page's challenge and submits it
//! the way the page does; the earned clearance cookie is then harvested like any session value.
//!
//! Pointer, not payload: the engine holds only where the solver is (the config) and the de-facto
//! createTask / getTaskResult protocol it speaks (anti-captcha / capsolver / 2captcha-compatible). No vendor is
//! named in the engine. Absent config means no solver source, so a wall the node cannot clear another way is an
//! honest failure, never a user prompt — the owner is never asked to solve it.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Where a solver lives and the key to use it.
pub(crate) struct Solver {
    url: String,
    key: String,
}

/// The solver the owner configured, or `None`. From env `UNBROWSE_CAPTCHA_SOLVER` as `"<url>|<key>"`, else
/// `~/.config/unbrowse/solver.json` (`{"url": ..., "key": ...}`). `None` when unset or either field is blank: the
/// solver source is then unavailable, and the clearance flow moves on without it.
pub(crate) fn configured() -> Option<Solver> {
    if let Ok(v) = std::env::var("UNBROWSE_CAPTCHA_SOLVER") {
        if let Some(s) = from_pair(&v) {
            return Some(s);
        }
    }
    let path = config_dir()?.join("unbrowse/solver.json");
    let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    from_url_key(v.get("url").and_then(Value::as_str)?, v.get("key").and_then(Value::as_str)?)
}

fn config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
}

fn from_pair(v: &str) -> Option<Solver> {
    let (url, key) = v.split_once('|')?;
    from_url_key(url, key)
}

fn from_url_key(url: &str, key: &str) -> Option<Solver> {
    let (url, key) = (url.trim().trim_end_matches('/'), key.trim());
    (!url.is_empty() && !key.is_empty()).then(|| Solver { url: url.to_string(), key: key.to_string() })
}

/// The createTask body for a reCAPTCHA Enterprise challenge on `page_url` with `sitekey` (proxyless: the solver uses
/// its own network). A page action the site named is passed through as `pageAction`.
fn create_task_body(key: &str, sitekey: &str, page_url: &str, action: Option<&str>) -> Value {
    let mut task = json!({
        "type": "RecaptchaV2EnterpriseTaskProxyless",
        "websiteURL": page_url,
        "websiteKey": sitekey,
    });
    if let Some(a) = action.filter(|a| !a.is_empty()) {
        task["pageAction"] = json!(a);
    }
    json!({ "clientKey": key, "task": task })
}

/// What one getTaskResult answer says: the token is ready, the task is still working, or it failed.
enum Poll {
    Ready(String),
    Working,
    Failed(String),
}

/// Read a getTaskResult answer. An `errorId` other than 0 is a failure; `status: ready` carries the token under one
/// of the names the compatible services use; anything else is still working.
fn token_from_result(v: &Value) -> Poll {
    if v.get("errorId").and_then(Value::as_i64).unwrap_or(0) != 0 {
        return Poll::Failed(v.get("errorCode").and_then(Value::as_str).unwrap_or("solver error").to_string());
    }
    match v.get("status").and_then(Value::as_str) {
        Some("ready") => {
            let tok = v.get("solution").and_then(|s| {
                s.get("gRecaptchaResponse")
                    .or_else(|| s.get("token"))
                    .or_else(|| s.get("text"))
                    .and_then(Value::as_str)
            });
            match tok {
                Some(t) if !t.is_empty() => Poll::Ready(t.to_string()),
                _ => Poll::Failed("solver answered ready with no token".into()),
            }
        }
        Some("processing") | Some("idle") | None => Poll::Working,
        Some(other) => Poll::Failed(format!("solver status {other}")),
    }
}

impl Solver {
    /// A reCAPTCHA token for the challenge at `page_url` with `sitekey`, by `createTask` then polling
    /// `getTaskResult` up to ~120 s. Blocking: the caller runs it off the async runtime (`spawn_blocking`). The token
    /// is only produced here; the page's own call submits it.
    #[allow(dead_code)] // wired at the browse clearance seam once the live inject+submit is verified (DEFERRED-CLEARANCE-solver-submit)
    pub(crate) fn token(&self, sitekey: &str, page_url: &str, action: Option<&str>) -> Result<String, String> {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let created: Value = http
            .post(format!("{}/createTask", self.url))
            .json(&create_task_body(&self.key, sitekey, page_url, action))
            .send()
            .and_then(reqwest::blocking::Response::json)
            .map_err(|e| format!("createTask: {e}"))?;
        if created.get("errorId").and_then(Value::as_i64).unwrap_or(0) != 0 {
            return Err(format!("createTask: {}", created.get("errorCode").and_then(Value::as_str).unwrap_or("error")));
        }
        let task_id = created.get("taskId").cloned().ok_or("createTask: no taskId in the answer")?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let res: Value = http
                .post(format!("{}/getTaskResult", self.url))
                .json(&json!({ "clientKey": self.key, "taskId": task_id }))
                .send()
                .and_then(reqwest::blocking::Response::json)
                .map_err(|e| format!("getTaskResult: {e}"))?;
            match token_from_result(&res) {
                Poll::Ready(t) => return Ok(t),
                Poll::Failed(e) => return Err(e),
                Poll::Working => {
                    if Instant::now() > deadline {
                        return Err("solver did not answer in time".into());
                    }
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    }
}

/// A token for the challenge, when a solver is configured; `None` when none is (the honest no-op). The clearance
/// flow calls this as its last source, after its own walk and the owner's session; a `None` here, with nothing else
/// left, is a wall that honestly still holds.
#[allow(dead_code)] // the clearance flow's last source; the live inject+submit wiring is DEFERRED-CLEARANCE-solver-submit
pub(crate) fn clearance_token(sitekey: &str, page_url: &str, action: Option<&str>) -> Option<String> {
    let solver = configured()?;
    match solver.token(sitekey, page_url, action) {
        Ok(t) => Some(t),
        Err(e) => {
            eprintln!("   [solver] no token for {page_url}: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The config pointer: read from the env pair or a blank/absent config. No vendor name here — only where it is
    /// and the key.
    #[test]
    fn a_solver_is_configured_from_a_url_and_key_or_not_at_all() {
        assert!(from_pair("https://solver.example/api | abc123 ").is_some(), "url|key pair");
        assert!(from_pair("https://solver.example/api").is_none(), "no key, no solver");
        assert!(from_pair("| abc").is_none() && from_pair("https://x |").is_none(), "a blank half is no solver");
        // the url is kept without a trailing slash so createTask/getTaskResult join cleanly
        let s = from_url_key("https://solver.example/api/", "k").unwrap();
        assert_eq!(s.url, "https://solver.example/api");
    }

    /// The createTask body names the challenge generically: the page, the site key, and a page action when given.
    #[test]
    fn the_create_task_body_names_the_challenge_generically() {
        let b = create_task_body("k", "6LeSITE", "https://shop.example/_____tmd_____/punish?x=1", Some("login"));
        assert_eq!(b["clientKey"], "k");
        assert_eq!(b["task"]["type"], "RecaptchaV2EnterpriseTaskProxyless");
        assert_eq!(b["task"]["websiteKey"], "6LeSITE");
        assert_eq!(b["task"]["websiteURL"], "https://shop.example/_____tmd_____/punish?x=1");
        assert_eq!(b["task"]["pageAction"], "login");
        assert!(create_task_body("k", "s", "u", None)["task"].get("pageAction").is_none(), "no action, no field");
    }

    /// A getTaskResult answer reads as ready-with-token, still-working, or a failure; a ready answer with no token is
    /// a failure, not a silent pass.
    #[test]
    fn a_task_result_is_read_as_ready_working_or_failed() {
        let ready = json!({ "errorId": 0, "status": "ready", "solution": { "gRecaptchaResponse": "0cAFtok" } });
        assert!(matches!(token_from_result(&ready), Poll::Ready(t) if t == "0cAFtok"));
        assert!(matches!(token_from_result(&json!({ "errorId": 0, "status": "processing" })), Poll::Working));
        assert!(matches!(token_from_result(&json!({ "errorId": 0 })), Poll::Working), "no status yet is still working");
        assert!(matches!(token_from_result(&json!({ "errorId": 1, "errorCode": "ERROR_KEY_DOES_NOT_EXIST" })), Poll::Failed(e) if e.contains("KEY")));
        assert!(matches!(token_from_result(&json!({ "errorId": 0, "status": "ready", "solution": {} })), Poll::Failed(_)), "ready with no token is a failure");
        // the alternate token field names the compatible services use
        assert!(matches!(token_from_result(&json!({ "errorId": 0, "status": "ready", "solution": { "token": "T" } })), Poll::Ready(t) if t == "T"));
        // an unknown status is a failure, not a silent pass
        assert!(matches!(token_from_result(&json!({ "errorId": 0, "status": "queued" })), Poll::Failed(e) if e.contains("queued")));
    }

    /// A tiny HTTP stand-in for a solver: it answers `createTask` and `getTaskResult` with whatever the responder
    /// returns for each, one TCP connection per request (the client sends `Connection: close`).
    fn mock_solver(responder: impl Fn(&str) -> String + Send + 'static) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let which = if req.contains("createTask") { "createTask" } else { "getTaskResult" };
                let body = responder(which);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        url
    }

    /// The solver end to end through the config pointer: a configured endpoint drives a token; a solver that refuses
    /// the task is an honest `None`; absent config is an honest `None`. No vendor, no site, no owner prompt.
    #[test]
    fn the_configured_solver_drives_clearance_end_to_end() {
        assert!(from_pair("").is_none());

        // (a) a configured solver that makes a task and returns a ready token
        let ok = mock_solver(|which| match which {
            "createTask" => r#"{"errorId":0,"taskId":7}"#.to_string(),
            _ => r#"{"errorId":0,"status":"ready","solution":{"gRecaptchaResponse":"0cAFok"}}"#.to_string(),
        });
        std::env::set_var("UNBROWSE_CAPTCHA_SOLVER", format!("{ok}|key"));
        assert_eq!(clearance_token("6LeKEY", "https://shop.example/punish", Some("walk")).as_deref(), Some("0cAFok"));

        // (b) a solver that refuses the task — an honest None, never a prompt
        let bad = mock_solver(|_| r#"{"errorId":1,"errorCode":"ERROR_KEY_DOES_NOT_EXIST"}"#.to_string());
        std::env::set_var("UNBROWSE_CAPTCHA_SOLVER", format!("{bad}|key"));
        assert!(clearance_token("s", "https://shop.example/punish", None).is_none());

        // (d) a task still processing on the first poll, ready on the second — exercises the wait-and-retry path
        let polls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = polls.clone();
        let slow = mock_solver(move |which| match which {
            "createTask" => r#"{"errorId":0,"taskId":9}"#.to_string(),
            _ if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 => r#"{"errorId":0,"status":"processing"}"#.to_string(),
            _ => r#"{"errorId":0,"status":"ready","solution":{"gRecaptchaResponse":"0cAFlate"}}"#.to_string(),
        });
        std::env::set_var("UNBROWSE_CAPTCHA_SOLVER", format!("{slow}|key"));
        assert_eq!(clearance_token("s", "https://shop.example/punish", None).as_deref(), Some("0cAFlate"));

        // (c) no solver configured (blank env, a config dir with no solver.json) — an honest None
        std::env::set_var("UNBROWSE_CAPTCHA_SOLVER", "");
        let empty = std::env::temp_dir().join(format!("ub-no-solver-{}", std::process::id()));
        std::env::set_var("XDG_CONFIG_HOME", &empty);
        assert!(configured().is_none());
        assert!(clearance_token("s", "u", None).is_none());

        // config_dir prefers XDG, and falls back to HOME when XDG is unset
        assert_eq!(config_dir(), Some(empty.clone()));
        std::env::remove_var("XDG_CONFIG_HOME");
        assert!(config_dir().is_some()); // HOME is set in any normal environment
        std::env::remove_var("UNBROWSE_CAPTCHA_SOLVER");
    }
}
