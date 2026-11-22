//! Usage telemetry: which tools agents call, whether they worked, how long they took, and the node's version and OS,
//! sent to Unbrowse's telemetry worker (`unbrowse-telemetry/`) so it can see the network is used and fix what breaks.
//!
//! Every route use that ran and failed is counted too (`decide.failures-reported-off-chain`: a failed call is never
//! reported on the chain): `route_failed` for a route run from what this node keeps, `fetch_failed` for a paid fetch
//! of another identity's entry, or one whose body no node served. Each says only how it failed, as a class from
//! [`ERROR_CLASSES`] ([`failure_class`]), never which route, entry or site.
//!
//! On by default in a release build, off in a dev build. The owner turns it off with `unbrowse-node telemetry off`
//! (kept in `telemetry.json`) or `UNBROWSE_TELEMETRY=0`, which wins over the file.
//!
//! An event holds the fields in [`FIELDS`] and nothing else, each one from a fixed list or of a fixed shape, and is
//! checked against them before it is queued ([`check`]); the worker checks the same lists again
//! (`unbrowse-telemetry/schema.json` holds both sides' copy). No URL, host, page, body, cookie, credential, passkey,
//! vault entry, name or address can be one of those values.
//!
//! `node_start` alone may also carry `from`: the source tag the node was first started with (`unbrowse start --from
//! <tag>` or `UNBROWSE_FROM`), such as `hn-c`. The tag is chosen by whoever wrote the install line, is visible in it,
//! and is shared by everyone who copied that line: it says where an install came from, never who made it. The first
//! tag seen is kept in `from.json` and never replaced ([`keep_from`]); a tag of any other shape ([`is_from`]) is ignored
//! with a warning.
//!
//! It never holds anything up. Recording is a non-blocking push onto a queue of [`BUFFER`] events; when the queue is
//! full the event is dropped. One thread sends what's queued in batches, each with a short timeout and no retry: a
//! batch the worker didn't take is dropped, so a worker that is down, slow or refusing costs a dropped batch and
//! nothing else.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store;

/// Where events go, unless `UNBROWSE_TELEMETRY_URL` says otherwise.
pub const ENDPOINT: &str = "https://telemetry.unbrowse.ai/v1/events";

/// Every field an event may carry. Anything else is refused here and at the worker.
pub const FIELDS: &[&str] = &["event", "version", "os", "install_id", "tool", "outcome", "duration_ms", "error_class", "from"];
/// The one event that may carry `from`.
pub const FROM_EVENT: &str = "node_start";
/// The longest source tag.
pub const FROM_MAX: usize = 40;
/// The fields every event carries.
const REQUIRED: &[&str] = &["event", "version", "os", "install_id", "outcome"];
pub const EVENTS: &[&str] = &["node_start", "tool_call", "route_failed", "fetch_failed"];
/// The agent API's tools (MCP) and routes (HTTP, as templates: a route's id is never sent).
pub const TOOLS: &[&str] = &[
    "unbrowse_search",
    "unbrowse_do",
    "unbrowse_browse",
    "unbrowse_call",
    "/v1/routes",
    "/v1/do",
    "/v1/browse",
    "/v1/routes/{id}/call",
    "/v1/remote/call/{id}",
];
pub const OUTCOMES: &[&str] = &["ok", "failed", "error"];
pub const ERROR_CLASSES: &[&str] = &[
    "bad_request",
    "unauthorized",
    "payment_required",
    "forbidden",
    "not_found",
    "conflict",
    "unavailable",
    "internal",
    "site",
    "other",
    // How a route use failed (`failure_class`), one for each of `run::failure_variant`'s variants.
    "step_status",
    "door",
    "not_an_answer",
    "needs_browser",
    "source_missing",
    "unsupported_body",
    "breaks_body",
    "missing_input",
    "missing_minted",
    "shape_mismatch",
    "http",
    "transport",
    "bad_url",
    "refused",
    "refused_hop",
    "file",
    "socket",
    // A paid fetch whose body no node served.
    "no_body",
];
pub const OSES: &[&str] = &["macos", "linux", "windows", "other"];
/// The longest duration sent: a day. Longer is a clock that jumped.
const MAX_MS: u64 = 86_400_000;

/// Events queued at most; more are dropped until the sender catches up.
pub const BUFFER: usize = 256;
/// Events sent at most in one request.
const BATCH: usize = 50;

/// One event, as it is sent.
#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub event: &'static str,
    pub version: String,
    pub os: &'static str,
    pub install_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<&'static str>,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<&'static str>,
    /// The source tag, on `node_start` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Whether a value looks like an address of any kind: a URL, a host name, a host and port, an email or an IP
/// address. None of the allowed values does; this is the check that keeps one out if a list ever grows wrong.
pub fn url_like(s: &str) -> bool {
    if s.contains(':') || s.contains('@') || s.contains('?') || s.contains('#') || s.contains('\\') || s.chars().any(char::is_whitespace) {
        return true;
    }
    // A dot between a label and a word of letters: example.com, www.site.co.uk.
    let labels: Vec<&str> = s.split('.').collect();
    let host = labels.windows(2).any(|w| {
        w[0].chars().last().is_some_and(|c| c.is_ascii_alphanumeric())
            && w[1].chars().take_while(|c| c.is_ascii_alphabetic()).count() >= 2
    });
    // Four numbers with dots: an IPv4 address.
    let ipv4 = labels.len() == 4 && labels.iter().all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_digit()));
    host || ipv4
}

/// `X.Y.Z`, with an optional `-pre` of letters, digits, dots and dashes.
pub fn is_version(s: &str) -> bool {
    let (core, pre) = s.split_once('-').map_or((s, None), |(c, p)| (c, Some(p)));
    let parts: Vec<&str> = core.split('.').collect();
    s.len() <= 32
        && parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

/// A source tag's shape: `^[a-z0-9][a-z0-9-]{0,39}$`, a lowercase letter or digit, then up to 39 more of those or dashes.
pub fn is_from(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= FROM_MAX
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_install_id(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Checks an event as it will be sent: only the allowed fields, every required one, every value from its list or of
/// its shape, nothing that looks like an address. `from` goes on `node_start` alone.
pub fn check(v: &Value) -> Result<(), String> {
    let o = v.as_object().ok_or("an event is an object")?;
    for k in o.keys() {
        if !FIELDS.contains(&k.as_str()) {
            return Err(format!("field not allowed: {k}"));
        }
    }
    if o.contains_key("from") && o.get("event").and_then(Value::as_str) != Some(FROM_EVENT) {
        return Err(format!("from goes on {FROM_EVENT} only"));
    }
    for k in REQUIRED {
        if !o.contains_key(*k) {
            return Err(format!("missing field: {k}"));
        }
    }
    for (k, v) in o {
        if k == "duration_ms" {
            match v.as_u64() {
                Some(ms) if ms <= MAX_MS => continue,
                _ => return Err("duration_ms is a whole number of milliseconds up to a day".into()),
            }
        }
        let s = v.as_str().ok_or_else(|| format!("{k} is a string"))?;
        if url_like(s) {
            return Err(format!("{k} looks like an address"));
        }
        let fits = match k.as_str() {
            "event" => EVENTS.contains(&s),
            "tool" => TOOLS.contains(&s),
            "outcome" => OUTCOMES.contains(&s),
            "error_class" => ERROR_CLASSES.contains(&s),
            "os" => OSES.contains(&s),
            "version" => is_version(s),
            "install_id" => is_install_id(s),
            "from" => is_from(s),
            _ => false,
        };
        if !fits {
            return Err(format!("{k} is not an allowed value"));
        }
    }
    Ok(())
}

/// This machine's OS, as the list names it.
pub fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => "other",
    }
}

/// The tool's name from the list, for a name an agent sent.
pub fn tool(name: &str) -> Option<&'static str> {
    TOOLS.iter().find(|t| **t == name).copied()
}

/// What a refused call's status says went wrong, coarsely.
pub fn error_class(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 | 422 => "bad_request",
        401 => "unauthorized",
        402 => "payment_required",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        503 => "unavailable",
        500..=599 => "internal",
        _ => "other",
    }
}

/// The class a failed route use is counted under, from its variant as `run::failure_variant` says it (`Failed: step 2
/// of 3 answered 403`): the variant's name alone, never its step or status. One this list doesn't know is `site`.
pub fn failure_class(variant: Option<&str>) -> &'static str {
    let name = variant.unwrap_or_default().split(':').next().unwrap_or_default().trim();
    match name {
        "Failed" => "step_status",
        "Door" => "door",
        "NotAnAnswer" => "not_an_answer",
        "NeedsBrowser" => "needs_browser",
        "SourceMissing" => "source_missing",
        "UnsupportedBody" => "unsupported_body",
        "BreaksBody" => "breaks_body",
        "MissingInput" => "missing_input",
        "MissingMinted" => "missing_minted",
        "ShapeMismatch" => "shape_mismatch",
        "Http" => "http",
        "Transport" => "transport",
        "BadUrl" => "bad_url",
        "Refused" => "refused",
        "RefusedHop" => "refused_hop",
        "File" => "file",
        "Socket" => "socket",
        _ => "site",
    }
}

/// The event a failed route use is counted as: `fetch_failed` for a paid fetch of another identity's entry, else
/// `route_failed`.
pub fn failed_use_event(paid: bool) -> &'static str {
    if paid {
        "fetch_failed"
    } else {
        "route_failed"
    }
}

/// How a tool call ended: answered (`ok`), answered with the site's call failing (`failed`, class `site`), or
/// refused (`error`, with the status's class). Nothing from the answer itself is kept.
pub fn outcome(r: &Result<Value, (StatusCode, String)>) -> (&'static str, Option<&'static str>) {
    match r {
        Err((status, _)) => ("error", Some(error_class(*status))),
        Ok(v) if v.get("ok").or_else(|| v.pointer("/result/ok")).and_then(Value::as_bool) == Some(false) => ("failed", Some("site")),
        Ok(_) => ("ok", None),
    }
}

// ---- the owner's choice ----

/// What `telemetry.json` keeps: whether it's on, and a random id for this install that is drawn once and names no
/// person, machine or name. Linking a wallet sends it with that wallet on the node's signed events to the site
/// (`link::tell`), which joins this install's counts to the wallet; the telemetry events themselves never carry one.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Saved {
    pub on: bool,
    pub install_id: String,
    /// Whether a start has told the owner in full what is sent. Kept apart from the file's own making: anything that
    /// reads the choice first makes the file, and the notice would then never be shown.
    #[serde(default)]
    pub told: bool,
}

fn path() -> std::path::PathBuf {
    store::home().join("telemetry.json")
}

/// What `from.json` keeps: the first source tag the node was started with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromTag {
    pub from: String,
}

fn from_path() -> std::path::PathBuf {
    store::home().join("from.json")
}

/// The source tag a start offers, from `--from` (which wins) or `UNBROWSE_FROM`, and a one-line warning when what was
/// given is not a tag. An empty `UNBROWSE_FROM` is no tag, not a wrong one.
pub fn offered_from(arg: Option<&str>, env: Option<&str>) -> (Option<String>, Option<String>) {
    let (given, by) = match (arg, env.filter(|e| !e.trim().is_empty())) {
        (Some(a), _) => (a, "--from"),
        (None, Some(e)) => (e, "UNBROWSE_FROM"),
        (None, None) => return (None, None),
    };
    if is_from(given) {
        (Some(given.to_string()), None)
    } else {
        let shown: String = given.chars().take(FROM_MAX).collect();
        (None, Some(format!("unbrowse-node: {by} {shown:?} ignored: a source tag is 1 to {FROM_MAX} lowercase letters, digits and dashes, starting with a letter or digit")))
    }
}

/// The source tag this node keeps: the first one it was ever given, kept in `path`. A later tag never replaces it. A
/// kept file that doesn't read (damaged, or a newer node's) is left as it is, and no tag is sent.
pub fn keep_from(path: &std::path::Path, offered: Option<&str>) -> Option<String> {
    match unbrowse_files::FROM.read_at::<FromTag>(path) {
        Ok(Some(kept)) if is_from(&kept.from) => Some(kept.from),
        Ok(Some(_)) => None,
        Ok(None) => {
            let tag = offered.filter(|t| is_from(t))?;
            let kept = FromTag { from: tag.to_string() };
            if let Err(e) = store::write_json(path, &unbrowse_files::FROM, &kept) {
                eprintln!("unbrowse-node: keeping the source tag: {e}");
            }
            Some(kept.from)
        }
        Err(r) => {
            eprintln!("{}", r.message(path));
            None
        }
    }
}

fn new_install_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the OS gives no randomness");
    hex::encode(bytes)
}

/// The saved choice, made on first use: on, with a fresh install id. Whether it was made just now.
/// A choice that can't be read, damaged or saved by a newer node, is never read as on, nor written over: it may be an
/// owner's off, so telemetry is off while that file stands (`unbrowse-node telemetry on|off` writes it whole again).
pub fn load_or_create(path: &std::path::Path) -> (Saved, bool) {
    let saved: Option<Saved> = match unbrowse_files::TELEMETRY.read_at(path) {
        Ok(s) => s,
        Err(r) => {
            eprintln!("{}", r.message(path));
            return (Saved { on: false, install_id: new_install_id(), told: true }, false);
        }
    };
    match saved {
        Some(s) if is_install_id(&s.install_id) => (s, false),
        old => {
            let s = Saved { on: old.as_ref().is_none_or(|o| o.on), install_id: new_install_id(), told: old.is_some_and(|o| o.told) };
            let _ = store::write_json(path, &unbrowse_files::TELEMETRY, &s);
            (s, true)
        }
    }
}

/// This install's random id, made on first use. Bug reports use it for the relay's daily count; a linked node's events to the site (`link::tell`) carry it, so the owner's sign-in joins it to their wallet (UNB-179).
pub fn install_id() -> String {
    load_or_create(&path()).0.install_id
}

/// Whether the owner's saved choice is on (the file; the environment may override it).
pub fn saved_on() -> bool {
    load_or_create(&path()).0.on
}

/// Whether a node that started with telemetry on still sends: the owner's choice as it stands now, unless the
/// environment set it. Turning it on takes a start, which makes the sender.
fn choice_stands(env: Option<bool>, saved_on: bool) -> bool {
    env.unwrap_or(saved_on)
}

/// `choice_stands`, read now.
fn stands_now() -> bool {
    choice_stands(env_choice(std::env::var("UNBROWSE_TELEMETRY").ok().as_deref()), saved_on())
}

/// Whether what is counted may leave now: while the owner's choice stands, and the node is on the network, or nothing
/// leaves the machine (R1.35). What is counted meanwhile is dropped, never sent later.
fn may_send_now() -> bool {
    stands_now() && crate::link::on_network_now().is_some()
}

/// `UNBROWSE_TELEMETRY`'s say: `0`, `false`, `off` or `no` turns it off; `1`, `true`, `on` or `yes` turns it on.
pub fn env_choice(v: Option<&str>) -> Option<bool> {
    match v?.trim().to_ascii_lowercase().as_str() {
        "0" | "false" | "off" | "no" => Some(false),
        "1" | "true" | "on" | "yes" => Some(true),
        _ => None,
    }
}

/// Whether to send: the environment's say, else the saved choice in a release build. A dev build sends only when the
/// environment asks, so developers' runs never count as use.
pub fn decide(env: Option<bool>, saved_on: bool, dev: bool) -> bool {
    env.unwrap_or(saved_on && !dev)
}

/// What's sent, in one line, for the first-run notice and `unbrowse-node telemetry`.
pub const WHAT: &str = "which agent tool ran, whether it worked, how long it took, how a route call or a paid fetch failed (its kind \
of failure alone), the node's version and OS, a random install id drawn once that names no person (though \
linking a wallet sends it with that wallet to the website, joining this install's counts to that wallet), and \
on start the source tag the node was first started with (`--from`), if any. Never a URL, site, page, request \
or answer, cookie, password, passkey, vault entry, name or IP address";
pub const HOW_TO_STOP: &str = "turn it off with `unbrowse-node telemetry off` or UNBROWSE_TELEMETRY=0";

/// `unbrowse-node telemetry [on|off]`.
pub fn cli(args: &[String]) -> i32 {
    let file = path();
    let (mut saved, _) = load_or_create(&file);
    match args.first().map(String::as_str) {
        None => {
            let env = env_choice(std::env::var("UNBROWSE_TELEMETRY").ok().as_deref());
            let on = decide(env, saved.on, cfg!(debug_assertions));
            println!("telemetry: {}{}", if on { "on" } else { "off" }, if env.is_some() { " (set by UNBROWSE_TELEMETRY)" } else { "" });
            println!("sends: {WHAT}");
            println!("install id: {}", saved.install_id);
            println!(
                "{}",
                if on {
                    HOW_TO_STOP
                } else if env.is_none() && saved.on {
                    "a dev build sends only with UNBROWSE_TELEMETRY=1"
                } else {
                    "turn it on with `unbrowse-node telemetry on`"
                }
            );
            0
        }
        Some(c @ ("on" | "off")) => {
            saved.on = c == "on";
            match store::write_json(&file, &unbrowse_files::TELEMETRY, &saved) {
                Ok(()) => {
                    println!("telemetry {c}; {}", if c == "off" { "a running node stops sending at once" } else { "a running node takes it at its next start" });
                    0
                }
                Err(e) => {
                    eprintln!("saving the choice: {e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: unbrowse-node telemetry [on | off]");
            2
        }
    }
}

// ---- sending ----

pub struct Config {
    pub endpoint: String,
    /// How long events wait to be batched.
    pub every: Duration,
    /// The longest a send may take, connecting included.
    pub timeout: Duration,
    /// Asked before every send (`may_send_now`).
    pub may_send: fn() -> bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            endpoint: std::env::var("UNBROWSE_TELEMETRY_URL").ok().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| ENDPOINT.into()),
            every: Duration::from_secs(60),
            timeout: Duration::from_secs(3),
            may_send: may_send_now,
        }
    }
}

pub struct Telemetry {
    queue: Option<SyncSender<Event>>,
    version: String,
    install_id: String,
    /// The kept source tag, sent on `node_start`.
    from: Option<String>,
    /// Events dropped because the queue was full or the sender had stopped.
    pub dropped: AtomicU64,
}

impl Telemetry {
    /// Sends nothing.
    pub fn off() -> Self {
        Self { queue: None, version: String::new(), install_id: String::new(), from: None, dropped: AtomicU64::new(0) }
    }

    /// On, with its sender running; or off, with nothing started.
    pub fn new(on: bool, install_id: &str, version: &str, config: Config) -> Self {
        if !on {
            return Self::off();
        }
        let (tx, rx) = mpsc::sync_channel(BUFFER);
        let started = std::thread::Builder::new().name("telemetry".into()).spawn(move || ship(rx, config));
        Self {
            queue: started.is_ok().then_some(tx),
            version: version.into(),
            install_id: install_id.into(),
            from: None,
            dropped: AtomicU64::new(0),
        }
    }

    /// The same, sending `from` on `node_start`.
    pub fn with_from(mut self, from: Option<String>) -> Self {
        self.from = from;
        self
    }

    pub fn on(&self) -> bool {
        self.queue.is_some()
    }

    /// Queues an event, or drops it: never waits.
    pub fn record(&self, event: &'static str, tool: Option<&'static str>, outcome: &'static str, took: Option<Duration>, class: Option<&'static str>) {
        let Some(queue) = &self.queue else { return };
        let e = Event {
            event,
            version: self.version.clone(),
            os: os(),
            install_id: self.install_id.clone(),
            tool,
            outcome,
            duration_ms: took.map(|d| (d.as_millis() as u64).min(MAX_MS)),
            error_class: class,
            from: if event == FROM_EVENT { self.from.clone() } else { None },
        };
        if serde_json::to_value(&e).ok().is_none_or(|v| check(&v).is_err()) {
            return;
        }
        if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) = queue.try_send(e) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// A route use that ran and failed (`failed_use_event`, `failure_class`).
    pub fn failed_use(&self, paid: bool, took: Option<Duration>, class: &'static str) {
        self.record(failed_use_event(paid), None, "failed", took, Some(class));
    }

    /// A tool call that just ended.
    pub fn tool_call(&self, tool: &'static str, took: Duration, r: &Result<Value, (StatusCode, String)>) {
        let (outcome, class) = outcome(r);
        self.record("tool_call", Some(tool), outcome, Some(took), class);
    }
}

/// Sends what's queued, a batch at a time, until the node stops. A send that fails is not tried again.
fn ship(rx: mpsc::Receiver<Event>, config: Config) {
    let Ok(client) = reqwest::blocking::Client::builder().timeout(config.timeout).connect_timeout(config.timeout).build() else { return };
    let send = |batch: &[Event]| {
        if !(config.may_send)() {
            return;
        }
        let _ = client.post(&config.endpoint).json(&json!({ "events": batch })).send();
    };
    let mut batch: Vec<Event> = Vec::with_capacity(BATCH);
    let mut due = Instant::now() + config.every;
    loop {
        match rx.recv_timeout(due.saturating_duration_since(Instant::now())) {
            Ok(e) => {
                batch.push(e);
                if batch.len() < BATCH {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !batch.is_empty() {
                    send(&batch);
                }
                return;
            }
        }
        if !batch.is_empty() {
            send(&batch);
            batch.clear();
        }
        due = Instant::now() + config.every;
    }
}

static GLOBAL: OnceLock<Telemetry> = OnceLock::new();

/// Starts the node's telemetry from the owner's choice, and says on stderr whether it's on, what it sends and how to
/// turn it off: in full the first time, in a line after that. `from` is the source tag the start was given (`--from`),
/// else `UNBROWSE_FROM`'s; the first ever given is kept, whether telemetry is on or not.
pub fn start(version: &str, dev: bool, from: Option<&str>) {
    let (offered, warning) = offered_from(from, std::env::var("UNBROWSE_FROM").ok().as_deref());
    if let Some(w) = warning {
        eprintln!("{w}");
    }
    let from = keep_from(&from_path(), offered.as_deref());
    let (mut saved, _) = load_or_create(&path());
    let on = decide(env_choice(std::env::var("UNBROWSE_TELEMETRY").ok().as_deref()), saved.on, dev);
    let t = Telemetry::new(on, &saved.install_id, version, Config::default()).with_from(from);
    if t.on() {
        if !saved.told {
            eprintln!("telemetry: while the node is on the network, it sends Unbrowse usage counts: {WHAT}. Off the network it sends nothing.");
            eprintln!("telemetry: once you link a wallet, the node's start, link and unlink events also name it, in place of an API key.");
            eprintln!("telemetry: {HOW_TO_STOP}. What's sent, exactly: the README's \"Usage telemetry\" section.");
            saved.told = true;
            let _ = store::write_json(&path(), &unbrowse_files::TELEMETRY, &saved);
        } else {
            eprintln!("telemetry: on (usage counts while on the network, and your linked wallet on start/link events; {HOW_TO_STOP})");
        }
        t.record("node_start", None, "ok", None, None);
    } else {
        eprintln!("telemetry: off");
    }
    let _ = GLOBAL.set(t);
}

/// Whether the node's telemetry was started and is on: the owner's choice, as `start` read it, and as it stands now, so
/// `telemetry off` stops at once whatever would have gone next, a link event naming the wallet included.
pub fn on() -> bool {
    GLOBAL.get().is_some_and(Telemetry::on) && stands_now()
}

/// Records a route use that ran and failed on the node's telemetry, if it was started and is on.
pub fn failed_use(paid: bool, took: Option<Duration>, class: &'static str) {
    if let Some(t) = GLOBAL.get() {
        t.failed_use(paid, took, class);
    }
}

/// Records a tool call on the node's telemetry, if it was started and is on.
pub fn tool_call(tool: &'static str, took: Duration, r: &Result<Value, (StatusCode, String)>) {
    if let Some(t) = GLOBAL.get() {
        t.tool_call(tool, took, r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file that doesn't read may hold an owner's off: it never turns telemetry on, and it stays for them to see.
    #[test]
    fn a_damaged_choice_reads_as_off_and_is_left_alone() {
        let dir = store::scratch_home("telemetry-damaged");
        let path = dir.join("telemetry.json");
        std::fs::write(&path, "{ not json").unwrap();
        let (saved, made) = load_or_create(&path);
        assert!(!saved.on && !made, "off, and nothing made");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json", "not written over");
    }
    use crate::sync::Locked;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn event() -> Value {
        json!({ "event": "tool_call", "version": "1.4.2", "os": "macos", "install_id": ID, "tool": "unbrowse_do",
                "outcome": "ok", "duration_ms": 120 })
    }

    fn fast(endpoint: String) -> Config {
        Config { endpoint, every: Duration::from_millis(50), timeout: Duration::from_millis(500), may_send: || true }
    }

    /// A worker that takes every request and keeps its body.
    fn worker() -> (String, Arc<Mutex<Vec<Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/events", listener.local_addr().unwrap());
        let got = Arc::new(Mutex::new(Vec::new()));
        let kept = got.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Some(body) = read_request(stream) {
                    kept.locked().push(body);
                }
            }
        });
        (url, got)
    }

    fn read_request(mut stream: TcpStream) -> Option<Value> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let len: usize = text[..end]
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                    .unwrap_or(0);
                if buf.len() >= end + 4 + len {
                    let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n");
                    return serde_json::from_slice(&buf[end + 4..end + 4 + len]).ok();
                }
            }
        }
    }

    /// A worker that takes the connection and never answers.
    fn hung_worker() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/events", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().flatten() {
                held.push(stream);
            }
        });
        url
    }

    fn wait_for(got: &Arc<Mutex<Vec<Value>>>, n: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while got.locked().len() < n && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn an_event_holds_the_allowed_fields_only() {
        assert_eq!(check(&event()), Ok(()));
        for (field, value) in [("url", json!("x")), ("host", json!("x")), ("ip", json!("x")), ("name", json!("x")), ("body", json!({}))] {
            let mut e = event();
            e[field] = value;
            assert_eq!(check(&e), Err(format!("field not allowed: {field}")), "{field}");
        }
        let mut e = event();
        e.as_object_mut().unwrap().remove("install_id");
        assert!(check(&e).is_err());
        // What the node sends has exactly those fields.
        let sent = serde_json::to_value(Event {
            event: "tool_call",
            version: "1.0.0".into(),
            os: "linux",
            install_id: ID.into(),
            tool: Some("/v1/do"),
            outcome: "error",
            duration_ms: Some(3),
            error_class: Some("not_found"),
            from: None,
        })
        .unwrap();
        assert_eq!(check(&sent), Ok(()));
        // With `from`, which only a start carries, that is every field.
        let mut keys: Vec<&str> = sent.as_object().unwrap().keys().map(String::as_str).chain(["from"]).collect();
        keys.sort();
        let mut fields = FIELDS.to_vec();
        fields.sort();
        assert_eq!(keys, fields);
    }

    #[test]
    fn a_source_tag_has_one_shape() {
        for ok in ["hn", "hn-c", "x", "0", "ai-chatgpt-b", "door-7", "a-", &"a".repeat(40)] {
            assert!(is_from(ok), "{ok}");
        }
        for bad in [
            "",
            "-hn",
            "HN",
            // An upper-case first letter alone: the first character has its own check.
            "H",
            "Hn",
            "hn_c",
            "hn.c",
            "hn c",
            "hn.com",
            "lewis@unbrowse.ai",
            "https://x.com",
            "10.0.0.1",
            "é",
            &"a".repeat(41),
        ] {
            assert!(!is_from(bad), "{bad:?}");
        }
    }

    /// `from` goes on `node_start` and nowhere else, and only in a tag's shape.
    #[test]
    fn from_rides_on_node_start_only() {
        let start = json!({ "event": "node_start", "version": "1.4.2", "os": "linux", "install_id": ID, "outcome": "ok", "from": "hn-c" });
        assert_eq!(check(&start), Ok(()));
        let mut e = event();
        e["from"] = json!("hn-c");
        assert_eq!(check(&e), Err("from goes on node_start only".into()));
        for (bad, why) in [("hn.example.com", "from looks like an address"), ("lewis@unbrowse.ai", "from looks like an address"), ("HN", "from is not an allowed value"), ("hn_c", "from is not an allowed value")] {
            let mut s = start.clone();
            s["from"] = json!(bad);
            assert_eq!(check(&s), Err(why.into()), "{bad}");
        }
        let mut s = start.clone();
        s["from"] = json!(7);
        assert!(check(&s).is_err());

        // Sent as the node records it: on its start, not on its calls.
        let (url, got) = worker();
        let t = Telemetry::new(true, ID, "1.4.2", fast(url)).with_from(Some("hn-c".into()));
        t.record("node_start", None, "ok", None, None);
        t.tool_call("unbrowse_do", Duration::from_millis(5), &Ok(json!({ "ok": true })));
        t.failed_use(false, None, "door");
        wait_for(&got, 1);
        let got = got.locked();
        let events: Vec<&Value> = got.iter().flat_map(|b| b["events"].as_array().unwrap()).collect();
        assert_eq!(events.len(), 3, "{events:?}");
        for e in &events {
            assert_eq!(check(e), Ok(()));
            assert_eq!(e.get("from").and_then(Value::as_str), (e["event"] == "node_start").then_some("hn-c"), "{e}");
        }
    }

    /// `--from` wins over `UNBROWSE_FROM`; anything not in a tag's shape is ignored, with a line saying why.
    #[test]
    fn a_wrong_tag_is_ignored_with_a_warning() {
        assert_eq!(offered_from(Some("hn-c"), Some("x")), (Some("hn-c".into()), None));
        assert_eq!(offered_from(None, Some("reddit")), (Some("reddit".into()), None));
        assert_eq!(offered_from(None, None), (None, None));
        assert_eq!(offered_from(None, Some("  ")), (None, None), "an empty variable is no tag");
        for (arg, env, by) in [(Some("https://evil.example/?q=1"), None, "--from"), (Some(""), Some("x"), "--from"), (None, Some("Me@Home"), "UNBROWSE_FROM")] {
            let (tag, warning) = offered_from(arg, env);
            assert_eq!(tag, None, "{arg:?} {env:?}");
            let w = warning.expect("a warning");
            assert!(w.contains(by) && w.contains("ignored") && !w.contains('\n'), "{w}");
        }
    }

    /// The first tag a node is given is the one it keeps: a later start's tag, right or wrong, never replaces it.
    #[test]
    fn the_first_tag_is_kept() {
        let dir = store::scratch_home("telemetry-from");
        let file = dir.join("from.json");
        assert_eq!(keep_from(&file, None), None, "no tag, nothing kept");
        assert!(!file.exists());
        assert_eq!(keep_from(&file, Some("BAD")), None, "a wrong tag is not kept");
        assert!(!file.exists());
        assert_eq!(keep_from(&file, Some("hn-c")), Some("hn-c".into()));
        assert_eq!(keep_from(&file, Some("reddit")), Some("hn-c".into()), "first write wins");
        assert_eq!(keep_from(&file, None), Some("hn-c".into()));
        let kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(kept["from"], "hn-c");
        // A file that doesn't read is left alone, and sends no tag.
        std::fs::write(&file, "{ torn").unwrap();
        assert_eq!(keep_from(&file, Some("reddit")), None);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ torn");
    }

    #[test]
    fn a_value_that_looks_like_an_address_is_refused() {
        for s in [
            "https://hn.algolia.com/?q=rust",
            "hn.algolia.com",
            "www.example.co.uk",
            "localhost:7788",
            "10.0.0.1",
            "::1",
            "lewis@unbrowse.ai",
            "/v1/routes/abc?x=1",
            "a b",
        ] {
            assert!(url_like(s), "{s}");
            for field in ["tool", "event", "outcome", "error_class", "os", "version"] {
                let mut e = event();
                e[field] = json!(s);
                assert_eq!(check(&e), Err(format!("{field} looks like an address")), "{field}={s}");
            }
        }
        for s in ["1.4.2", "1.0.0-rc.1", "/v1/routes/{id}/call", "unbrowse_do", ID] {
            assert!(!url_like(s), "{s}");
        }
        // Off the list, even when it doesn't look like an address.
        let mut e = event();
        e["tool"] = json!("unbrowse_vault");
        assert!(check(&e).is_err());
        e = event();
        e["duration_ms"] = json!(-1);
        assert!(check(&e).is_err());
    }

    #[test]
    fn the_lists_are_the_workers_lists() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../unbrowse-telemetry/schema.json");
        let schema: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let list = |k: &str| schema[k].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let ours = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(list("fields"), ours(FIELDS));
        assert_eq!(list("required"), ours(REQUIRED));
        assert_eq!(list("events"), ours(EVENTS));
        assert_eq!(list("tools"), ours(TOOLS));
        assert_eq!(list("outcomes"), ours(OUTCOMES));
        assert_eq!(list("error_classes"), ours(ERROR_CLASSES));
        assert_eq!(list("oses"), ours(OSES));
        assert_eq!(schema["max_duration_ms"].as_u64(), Some(MAX_MS));
    }

    #[test]
    fn turned_off_sends_nothing() {
        assert_eq!(env_choice(Some("0")), Some(false));
        assert_eq!(env_choice(Some("off")), Some(false));
        assert_eq!(env_choice(Some("1")), Some(true));
        assert_eq!(env_choice(Some("")), None);
        assert!(!decide(Some(false), true, false), "the environment's off wins over the file's on");
        assert!(!decide(None, false, false), "the file's off");
        assert!(!decide(None, true, true), "a dev build sends only when asked");
        assert!(decide(None, true, false), "on by default in a release");

        let (url, got) = worker();
        let off = Telemetry::new(decide(Some(false), true, false), ID, "1.4.2", fast(url.clone()));
        assert!(!off.on());
        for _ in 0..20 {
            off.tool_call("unbrowse_do", Duration::from_millis(5), &Ok(json!({ "ok": true })));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(got.locked().is_empty(), "nothing reached the worker");

        // The same worker does hear from a node that's on, so the silence above is the choice's.
        let on = Telemetry::new(true, ID, "1.4.2", fast(url));
        on.tool_call("unbrowse_call", Duration::from_millis(5), &Ok(json!({ "ok": false, "data": { "secret": "x" } })));
        wait_for(&got, 1);
        let got = got.locked();
        let events = got[0]["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(check(&events[0]), Ok(()));
        assert_eq!(events[0]["outcome"], "failed");
        assert_eq!(events[0]["error_class"], "site");
        assert!(!got[0].to_string().contains("secret"), "nothing of the answer is sent");
    }

    #[test]
    fn a_dead_or_hung_worker_never_holds_a_tool_call() {
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/v1/events", l.local_addr().unwrap())
        };
        let hung = hung_worker();
        for url in [hung.clone(), closed, "http://telemetry.invalid/v1/events".into()] {
            let t = Telemetry::new(true, ID, "1.4.2", fast(url.clone()));
            // Calls that waited for the sender would go at its pace behind a hung worker: one batch of 50 per 500 ms
            // timeout, about 100 s for these 10,000. Not waiting takes well under a second, and a busy test runner
            // can pause any thread for a few hundred ms, so the line is drawn far from both.
            let started = Instant::now();
            for _ in 0..10_000 {
                t.tool_call("unbrowse_do", Duration::from_millis(5), &Err((StatusCode::NOT_FOUND, "no route".into())));
            }
            assert!(started.elapsed() < Duration::from_secs(5), "{url}: recording took {:?}", started.elapsed());
            if url == hung {
                // The sender is stuck on its first batch: what couldn't be queued was dropped, not kept.
                assert!(t.dropped.load(Ordering::Relaxed) >= (10_000 - BUFFER - 2 * BATCH) as u64);
            }
        }
    }

    #[test]
    fn the_install_id_is_random_and_kept() {
        let dir = std::env::temp_dir().join(format!("unbrowse-telemetry-{}", new_install_id()));
        let file = dir.join("telemetry.json");
        let (a, first) = load_or_create(&file);
        assert!(first && a.on && is_install_id(&a.install_id));
        let (b, again) = load_or_create(&file);
        assert!(!again);
        assert_eq!(a.install_id, b.install_id);
        store::write_json(&file, &unbrowse_files::TELEMETRY, &Saved { on: false, ..b }).unwrap();
        let (c, _) = load_or_create(&file);
        assert!(!c.on, "off stays off");
        assert_ne!(load_or_create(&dir.join("other.json")).0.install_id, a.install_id);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An owner's off holds from the moment it is saved, as `reports off` does, not from the next start: it stops the
    /// sender's next batch, and every event that asks `on`. Only the environment speaks over it.
    #[test]
    fn a_saved_off_stops_a_running_node_at_once() {
        let _home = store::scratch_home("telemetry-off-now");
        let (saved, _) = load_or_create(&path());
        store::write_json(&path(), &unbrowse_files::TELEMETRY, &Saved { on: false, ..saved }).unwrap();
        assert!(!stands_now());
        assert!(!choice_stands(None, false) && choice_stands(None, true));
        assert!(choice_stands(Some(true), false) && !choice_stands(Some(false), true), "the environment set it");
    }

    /// A sender that may not send drops what it counted.
    #[test]
    fn a_sender_that_may_not_send_sends_nothing() {
        let (url, got) = worker();
        let t = Telemetry::new(true, ID, "1.0.0", Config { may_send: || false, ..fast(url) });
        t.record("node_start", None, "ok", None, None);
        drop(t);
        std::thread::sleep(Duration::from_millis(200));
        assert!(got.locked().is_empty());
    }

    /// Reading the choice makes the file, and that isn't telling the owner: the first start after any read still does,
    /// and only that start does.
    #[test]
    fn an_earlier_read_doesnt_use_up_the_first_notice() {
        let dir = store::scratch_home("telemetry-notice");
        let file = dir.join("telemetry.json");
        let (saved, made) = load_or_create(&file);
        assert!(made && !saved.told, "a command read the choice first");
        let (saved, made) = load_or_create(&file);
        assert!(!made && !saved.told, "the start after it still owes the notice");
        store::write_json(&file, &unbrowse_files::TELEMETRY, &Saved { told: true, ..saved }).unwrap();
        assert!(load_or_create(&file).0.told);
    }

    /// A failed route use is an event of its own, `route_failed` or `fetch_failed`, outcome `failed`, with its
    /// variant's class: every class `failure_class` gives is on the list, and no variant's step or status goes with it.
    #[test]
    fn a_failed_route_use_is_counted_by_its_class_alone() {
        let names = [
            "Failed", "Door", "NotAnAnswer", "NeedsBrowser", "SourceMissing", "UnsupportedBody", "BreaksBody", "MissingInput", "MissingMinted",
            "ShapeMismatch", "Http", "Transport", "BadUrl", "Refused", "RefusedHop", "File", "Socket",
        ];
        let mut seen = std::collections::BTreeSet::new();
        for n in names {
            let class = failure_class(Some(&format!("{n}: step 2 of 3 answered 403")));
            assert_ne!(class, "site", "{n} has a class of its own");
            assert!(seen.insert(class), "{n}: one class each");
            for paid in [false, true] {
                let e = Event {
                    event: failed_use_event(paid),
                    version: "1.4.2".into(),
                    os: "macos",
                    install_id: ID.into(),
                    tool: None,
                    outcome: "failed",
                    duration_ms: Some(40),
                    error_class: Some(class),
                    from: None,
                };
                let v = serde_json::to_value(&e).unwrap();
                assert_eq!(check(&v), Ok(()), "{v}");
                assert!(!v.to_string().contains("403"), "no status goes with it");
            }
        }
        assert_eq!(failure_class(None), "site");
        assert_eq!(failure_class(Some("Something new")), "site");
        assert_eq!((failed_use_event(false), failed_use_event(true)), ("route_failed", "fetch_failed"));
        let mut e = event();
        e["event"] = json!("fetch_failed");
        e["error_class"] = json!("no_body");
        e.as_object_mut().unwrap().remove("tool");
        assert_eq!(check(&e), Ok(()));

        // Sent as it is counted.
        let (url, got) = worker();
        let on = Telemetry::new(true, ID, "1.4.2", fast(url));
        on.failed_use(true, Some(Duration::from_millis(7)), failure_class(Some("Door: step 1 of 1 answered 403 (Challenge)")));
        wait_for(&got, 1);
        let got = got.locked();
        let sent = &got[0]["events"][0];
        assert_eq!((sent["event"].as_str(), sent["outcome"].as_str(), sent["error_class"].as_str()), (Some("fetch_failed"), Some("failed"), Some("door")));
        assert!(sent.get("tool").is_none());
    }

    #[test]
    fn a_refused_call_says_only_its_class() {
        assert_eq!(outcome(&Err((StatusCode::SERVICE_UNAVAILABLE, "the node is paused by its owner".into()))), ("error", Some("unavailable")));
        assert_eq!(outcome(&Err((StatusCode::IM_A_TEAPOT, "x".into()))), ("error", Some("other")));
        assert_eq!(outcome(&Ok(json!({ "how": "called", "result": { "ok": false } }))), ("failed", Some("site")));
        assert_eq!(outcome(&Ok(json!({ "how": "browse" }))), ("ok", None));
        assert_eq!(tool("unbrowse_do"), Some("unbrowse_do"));
        assert_eq!(tool("https://example.com"), None);
    }
}
