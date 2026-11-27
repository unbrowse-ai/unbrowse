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

/// The solver the node uses: the owner's own (`owners`), else, for a node whose owner signed in on unbrowse.ai,
/// Unbrowse's gateway (`gateway::solver_url`). `None` when neither: the solver source is then unavailable, and the
/// clearance flow moves on without it.
pub(crate) fn configured() -> Option<Solver> {
    chosen(owners(), crate::gateway::solver_url())
}

/// What a node sends the gateway as its key: the gateway drops it and puts Unbrowse's own in, for members only.
const GATEWAY_KEY: &str = "unbrowse-member";

/// The owner's solver wins over the gateway's.
fn chosen(owners: Option<Solver>, gateway: Option<String>) -> Option<Solver> {
    owners.or_else(|| gateway.and_then(|url| from_url_key(&url, GATEWAY_KEY)))
}

/// The solver the owner configured, or `None`. From env `UNBROWSE_CAPTCHA_SOLVER` as `"<url>|<key>"`, else
/// `~/.config/unbrowse/solver.json` (`{"url": ..., "key": ...}`). `None` when unset or either field is blank.
fn owners() -> Option<Solver> {
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

/// A solver at `url` with `key`, for a test that stands one up.
#[cfg(test)]
pub(crate) fn at(url: &str, key: &str) -> Solver {
    Solver { url: url.to_string(), key: key.to_string() }
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

/// A check a page shows, as the solver needs it: the document it sits in, its public key, and its kind.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Check {
    pub page_url: String,
    pub key: String,
    pub kind: Kind,
    /// The page's own action for it (`data-action`), when it names one.
    pub action: Option<String>,
    /// A check that shows no box and answers when the page asks it (`size=invisible` in its frame's address).
    pub invisible: bool,
}

/// The kinds of check the solver protocol has a token task for. A widget is told by the name of the response field it
/// puts in the page (`<widget>-response`, the field a token is handed back in) and by its frame's address.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Kind {
    RecaptchaV2,
    RecaptchaV2Enterprise,
    Turnstile,
}

/// The widgets the solver answers, by the response field each puts in the page: the protocol's vocabulary, kept here
/// with the protocol, never in the engine.
const FIELDS: &[(&str, bool)] = &[("g-recaptcha-response", false), ("cf-turnstile-response", true)];

/// What `FIND_JS` saw in one document: its address, the public key on a widget's container (`data-sitekey`) or in a
/// widget frame's address (`k` or `sitekey`), the response fields it holds, the frame's own address facts, and the
/// page's action.
const FIND_JS: &str = "JSON.stringify((()=>{const o={url:location.href,key:null,action:null,fields:[],enterprise:false,invisible:false};const el=document.querySelector('[data-sitekey]');if(el){o.key=el.getAttribute('data-sitekey');o.action=el.getAttribute('data-action');}for(const f of document.querySelectorAll('iframe[src]')){let u;try{u=new URL(f.src,location.href)}catch(e){continue}const k=u.searchParams.get('k')||u.searchParams.get('sitekey');if(!k)continue;if(!o.key)o.key=k;if(/enterprise/i.test(u.pathname))o.enterprise=true;if(u.searchParams.get('size')==='invisible')o.invisible=true;}for(const s of document.querySelectorAll('script[src]')){if(/enterprise/i.test(s.src))o.enterprise=true;}o.fields=[...new Set([...document.querySelectorAll('textarea,input')].map(e=>e.name||e.id||'').filter(n=>/-response$/i.test(n)))];return o})())";

/// The script that reads a document for a check (`check_of` reads its answer).
pub(crate) fn find_js() -> &'static str {
    FIND_JS
}

/// The check one document holds, from what `FIND_JS` saw there: a public key, and a response field of a widget the
/// solver answers. `None` for a document with no check, or one whose widget the solver has no task for.
pub(crate) fn check_of(found: &Value) -> Option<Check> {
    let key = found.get("key").and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty())?;
    let page_url = found.get("url").and_then(Value::as_str).filter(|u| u.starts_with("http"))?;
    let fields: Vec<String> = found.get("fields").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect();
    let is = |k: &str| found.get(k).and_then(Value::as_bool).unwrap_or(false);
    let turnstile = FIELDS.iter().find(|(f, _)| fields.iter().any(|g| g == f)).map(|(_, t)| *t)?;
    let kind = match (turnstile, is("enterprise")) {
        (true, _) => Kind::Turnstile,
        (false, true) => Kind::RecaptchaV2Enterprise,
        (false, false) => Kind::RecaptchaV2,
    };
    let action = found.get("action").and_then(Value::as_str).map(str::trim).filter(|a| !a.is_empty()).map(String::from);
    Some(Check { page_url: page_url.to_string(), key: key.to_string(), kind, action, invisible: is("invisible") })
}

/// The check a page's markup holds, read without running it: its public key, on the widget's container
/// (`data-sitekey`), in a widget frame's address (`k`, `sitekey`), or handed to the widget by the page's own script
/// (`sitekey: "…"`); its kind, from the widget's code the page loads. `None` for a page with no key, or a widget the
/// solver has no task for. The document the key is in is the check's page (`page_url`).
pub(crate) fn check_in_html(html: &str, at: &url::Url) -> Option<Check> {
    let attr = regex::Regex::new(r#"data-sitekey\s*=\s*["']([\w-]{10,})["']"#).ok()?;
    let in_script = regex::Regex::new(r#"(?i)site_?key["']?\s*[:=]\s*["']([\w-]{20,})["']"#).ok()?;
    let in_frame = regex::Regex::new(r#"<iframe[^>]+src\s*=\s*["']([^"']+)["']"#).ok()?;
    let from_frame = in_frame.captures_iter(html).filter_map(|c| at.join(&c[1].replace("&amp;", "&")).ok()).find_map(|u| u.query_pairs().find(|(k, _)| k == "k" || k == "sitekey").map(|(_, v)| v.into_owned()));
    let key = attr.captures(html).map(|c| c[1].to_string()).or_else(|| in_script.captures(html).map(|c| c[1].to_string())).or(from_frame)?;
    let lower = html.to_ascii_lowercase();
    let kind = if lower.contains("turnstile") {
        Kind::Turnstile
    } else if lower.contains("recaptcha/enterprise") || lower.contains("grecaptcha.enterprise") || lower.contains("enterprise.js") {
        Kind::RecaptchaV2Enterprise
    } else if lower.contains("recaptcha") {
        Kind::RecaptchaV2
    } else {
        return None;
    };
    let action = regex::Regex::new(r#"data-action\s*=\s*["']([^"']{1,64})["']"#).ok()?.captures(html).map(|c| c[1].to_string());
    Some(Check { page_url: at.to_string(), key, kind, action, invisible: lower.contains("size=invisible") || lower.contains("data-size=\"invisible\"") })
}

/// The frames a page's markup holds on its own site, in order: where a check drawn in a frame is read next.
pub(crate) fn frames_in_html(html: &str, at: &url::Url) -> Vec<url::Url> {
    let Ok(in_frame) = regex::Regex::new(r#"<iframe[^>]+src\s*=\s*["']([^"']+)["']"#) else { return Vec::new() };
    let here = at.host_str().unwrap_or_default().to_string();
    in_frame
        .captures_iter(html)
        .filter_map(|c| at.join(&c[1].replace("&amp;", "&")).ok())
        .filter(|u| u.host_str().is_some_and(|h| unbrowse_learn::identity::same_site(h, &here)))
        .collect()
}

impl Check {
    /// The proxyless token task for this check, in the protocol's words.
    pub(crate) fn task(&self) -> Value {
        let mut task = json!({ "websiteURL": self.page_url, "websiteKey": self.key });
        task["type"] = json!(match self.kind {
            Kind::RecaptchaV2 => "RecaptchaV2TaskProxyless",
            Kind::RecaptchaV2Enterprise => "RecaptchaV2EnterpriseTaskProxyless",
            Kind::Turnstile => "TurnstileTaskProxyless",
        });
        if self.invisible && self.kind != Kind::Turnstile {
            task["isInvisible"] = json!(true);
        }
        if let Some(a) = &self.action {
            task[if self.kind == Kind::Turnstile { "action" } else { "pageAction" }] = json!(a);
        }
        task
    }
}

/// The function, run in the check's own document (its main world, where the widget's code is), that hands the token
/// over as the widget does: into every response field, then to the callback the page gave the widget, by the name on
/// its container (`data-callback`) or as the widget keeps it in its own configuration (a page-wide object holding a
/// `callback`); with no callback, the field's own form is submitted. It answers what it did.
pub(crate) const HAND_JS: &str = "(function(tok){const fs=[...document.querySelectorAll('textarea,input')].filter(e=>/-response$/i.test(e.name||e.id||''));for(const e of fs){e.value=tok;if(e.tagName==='TEXTAREA')e.textContent=tok;}let called=0;const named=n=>{if(typeof n==='string'&&typeof window[n]==='function'){try{window[n](tok);called++}catch(e){}return true}return false};for(const el of document.querySelectorAll('[data-callback]'))named(el.getAttribute('data-callback'));if(!called){const seen=new Set();const walk=(o,d)=>{if(!o||typeof o!=='object'||d>6||seen.has(o)||o===window||(typeof Node!=='undefined'&&o instanceof Node))return;seen.add(o);let ks;try{ks=Object.keys(o)}catch(e){return}for(const k of ks){let v;try{v=o[k]}catch(e){continue}if(k==='callback'){if(typeof v==='function'){try{v(tok);called++}catch(e){}}else named(v)}else if(v&&typeof v==='object')walk(v,d+1)}};for(const k of Object.getOwnPropertyNames(window)){if(!/^_{2,}/.test(k))continue;let v;try{v=window[k]}catch(e){continue}walk(v,0)}}let submitted=false;if(!called&&fs[0]&&fs[0].form){const f=fs[0].form;try{f.requestSubmit?f.requestSubmit():f.submit();submitted=true}catch(e){}}return JSON.stringify({filled:fs.length,called:called,submitted:submitted})})";

/// What `HAND_JS` did, said in a line; an error when it reached no field, since a token handed to nothing is no pass.
pub(crate) fn handed(said: &Value) -> Result<String, String> {
    let n = |k: &str| said.get(k).and_then(Value::as_u64).unwrap_or(0);
    let submitted = said.get("submitted").and_then(Value::as_bool).unwrap_or(false);
    if n("filled") == 0 {
        return Err("the token had no field to go in: the check is drawn somewhere the node doesn't read".into());
    }
    Ok(format!(
        "a token from the solver went into {} field(s){}",
        n("filled"),
        match (n("called"), submitted) {
            (0, true) => ", and its form was submitted".to_string(),
            (0, false) => ", with no callback or form to hand it on: the page may still need its own button".to_string(),
            (c, _) => format!(", and the page's callback was called ({c})"),
        }
    ))
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
    #[allow(dead_code)] // the clearance flow's source (`clearance_token`); the agent's solve step uses `token_for`
    pub(crate) fn token(&self, sitekey: &str, page_url: &str, action: Option<&str>) -> Result<String, String> {
        self.solved(create_task_body(&self.key, sitekey, page_url, action))
    }

    /// A token for `check`, the same way.
    pub(crate) fn token_for(&self, check: &Check) -> Result<String, String> {
        self.solved(json!({ "clientKey": self.key, "task": check.task() }))
    }

    /// The task's token. A failed request repeats its URL, and the gateway's carries the node's pass: every error
    /// leaves here scrubbed of it.
    fn solved(&self, body: Value) -> Result<String, String> {
        self.solve_task(body).map_err(|e| crate::gateway::scrub(&e))
    }

    fn solve_task(&self, body: Value) -> Result<String, String> {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let created: Value = http
            .post(format!("{}/createTask", self.url))
            .json(&body)
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
            // A failed request repeats its URL, and the gateway's carries the node's pass.
            eprintln!("   [solver] no token for {page_url}: {}", crate::gateway::scrub(&e));
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

    /// The owner's own solver wins; a node with none uses the gateway's address, under a stand-in key the gateway
    /// replaces; with neither there is none.
    #[test]
    fn a_member_node_with_no_solver_of_its_own_uses_the_gateways() {
        let gw = Some("https://rpc.example/arc-testnet/0xabc.1.0xdef".to_string());
        let own = chosen(from_url_key("https://solver.example/api", "owners-key"), gw.clone()).unwrap();
        assert_eq!((own.url.as_str(), own.key.as_str()), ("https://solver.example/api", "owners-key"));
        let member = chosen(None, gw).unwrap();
        assert_eq!((member.url.as_str(), member.key.as_str()), ("https://rpc.example/arc-testnet/0xabc.1.0xdef", GATEWAY_KEY));
        assert!(chosen(None, None).is_none());
    }

    /// A check is a public key beside a response field of a widget the solver answers; its kind comes from that field
    /// and its frame's address, and each kind is asked for as the protocol names it.
    #[test]
    fn a_check_is_read_from_its_key_and_its_response_field_and_asked_for_by_kind() {
        let seen = |fields: Value, enterprise: bool, invisible: bool, action: Value| {
            json!({ "url": "https://guard.shop.example/punish?x=1", "key": " 6LeKEY ", "action": action, "fields": fields, "enterprise": enterprise, "invisible": invisible })
        };
        let v2 = check_of(&seen(json!(["g-recaptcha-response"]), false, false, Value::Null)).unwrap();
        assert_eq!((v2.kind, v2.key.as_str(), v2.page_url.as_str()), (Kind::RecaptchaV2, "6LeKEY", "https://guard.shop.example/punish?x=1"));
        assert_eq!(v2.task(), json!({ "type": "RecaptchaV2TaskProxyless", "websiteURL": "https://guard.shop.example/punish?x=1", "websiteKey": "6LeKEY" }));
        let ent = check_of(&seen(json!(["G-Recaptcha-Response"]), true, true, json!("login"))).unwrap();
        assert_eq!(ent.task()["type"], "RecaptchaV2EnterpriseTaskProxyless");
        assert_eq!((ent.task()["isInvisible"].clone(), ent.task()["pageAction"].clone()), (json!(true), json!("login")));
        let ts = check_of(&seen(json!(["cf-turnstile-response"]), false, true, json!("signup"))).unwrap();
        assert_eq!(ts.kind, Kind::Turnstile);
        assert_eq!(ts.task(), json!({ "type": "TurnstileTaskProxyless", "websiteURL": "https://guard.shop.example/punish?x=1", "websiteKey": "6LeKEY", "action": "signup" }));
        // No key, no field the solver answers, a field of a widget it has no task for, or no web address: no check.
        assert!(check_of(&json!({ "url": "https://a.example/", "key": null, "fields": ["g-recaptcha-response"] })).is_none());
        assert!(check_of(&seen(json!([]), false, false, Value::Null)).is_none());
        assert!(check_of(&seen(json!(["h-captcha-response"]), false, false, Value::Null)).is_none());
        assert!(check_of(&json!({ "url": "about:blank", "key": "k", "fields": ["g-recaptcha-response"] })).is_none());
    }

    /// A hand-over says what it reached; one that reached no field is an error, never a pass.
    #[test]
    fn a_hand_over_says_what_it_reached_and_reaching_nothing_is_no_pass() {
        assert!(handed(&json!({ "filled": 1, "called": 2, "submitted": false })).unwrap().contains("callback was called (2)"));
        assert!(handed(&json!({ "filled": 2, "called": 0, "submitted": true })).unwrap().contains("form was submitted"));
        assert!(handed(&json!({ "filled": 1, "called": 0, "submitted": false })).unwrap().contains("its own button"));
        assert!(handed(&json!({ "filled": 0, "called": 1 })).is_err());
        assert!(handed(&Value::Null).is_err());
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
        assert!(owners().is_none());
        assert!(chosen(owners(), None).is_none(), "and no gateway: no solver");

        // config_dir prefers XDG, and falls back to HOME when XDG is unset
        assert_eq!(config_dir(), Some(empty.clone()));
        std::env::remove_var("XDG_CONFIG_HOME");
        assert!(config_dir().is_some()); // HOME is set in any normal environment
        std::env::remove_var("UNBROWSE_CAPTCHA_SOLVER");
    }
}
