//! The owner's hands on the node's browser. A site's browser runs with no window, so a page only a person can get
//! past (a sign-in the vault has no login for, a two-step code, a check that wants a person) waits on the owner. The
//! window shows that browser's page as a live picture, and the owner clicks and types on the picture: each click is
//! the same point on the page, each key goes to the page. An agent can ask for this (`ask_owner`) and waits until the
//! owner gives the page back; the owner can also take a page over whenever they like.
//!
//! Only the owner's window drives it: these are `/owner/*` commands, behind the owner's token. Nothing the owner types
//! is told to an agent or kept as typed. What they type into a secret field (a password, a one-time code, a card's
//! number, expiry or code: `is_secret_field`), and a card number they type anywhere, leaves the walk record
//! (the browser names it, as it names a vault login) and is said as `[typed by the owner]` in anything the browser
//! returns to an agent, and the page runs no agent script while it may still hold it. The learner's flow ends where
//! the owner took the page and again where they gave it back, so a sign-in done by hand never becomes a route. The
//! cookies it earned stay in the site's profile: the agent's next step is signed in.

use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use unbrowse_learn::cdp::client::CdpClient;
use unbrowse_learn::screencast;

use crate::api::Events;
use crate::frames::Frames;
use crate::store::{self, Activity};
use crate::sync::Locked;

/// How long an agent's ask waits for the owner by default, and the bounds it may set with `--timeout`.
pub const ASK_WAIT: u64 = 300;
const ASK_LEAST: u64 = 10;
const ASK_MOST: u64 = 1800;

/// The fewest milliseconds between two pictures passed on: a few a second, enough to see what one is typing into.
const EVERY_MS: u64 = 150;
/// The widest picture, in pixels: big enough to read a sign-in form.
const MAX_WIDTH: u32 = 1280;
const QUALITY: u32 = 70;
/// A picture nobody has touched or asked for in this long stops: a window closed without saying so.
const IDLE: Duration = Duration::from_secs(300);
/// The most text one keystroke event may carry (a paste).
const TEXT_MOST: usize = 4096;

/// What the owner's typing is said as, in anything the browser returns to an agent.
pub const BY_OWNER: &str = "[typed by the owner]";

// ---- an agent asks for the owner ----

/// An agent's ask, as the window shows it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Ask {
    pub id: String,
    pub site: String,
    /// What the agent needs, in its words.
    pub why: String,
    pub agent: String,
    pub asked_at: u64,
    pub expires_at: u64,
    /// A payment the owner is asked to approve, when the ask is one: done approves it, declined refuses it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pay: Option<Pay>,
    /// A login the owner is asked to add to the vault, when the ask is one (`vault:ask:`): the window opens its Add login
    /// form for it, and the ask is answered once the vault holds it ([`login_added`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<Login>,
    /// The tab of the session asking (`browse::tab_of`), when the ask is about a page: the one the owner's window
    /// shows while the ask waits, whichever session's command acted on the site last. The node's own.
    #[serde(skip)]
    pub tab: Option<String>,
}

/// A payment with a card from the vault, as the owner is asked to approve it. The owner reads the checkout live for
/// page fills. Route calls include their non-secret sent values; when the graph does not bind a charge amount and
/// currency to those values, the owner must decide each time.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Pay {
    /// The card, as the owner knows it: its label and last four digits.
    pub card: String,
    /// The site the card goes to.
    pub merchant: String,
    /// What the route does, for a route call; none for a page in the browser.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    /// The call's other values (`name: value`), for a route call.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<String>,
    /// Why this one asks though the owner set a limit on this card and site: it is more than expected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub over: Option<String>,
    /// What the agent says it costs, when it says: its word, not the site's. The page, or the values sent, are the
    /// truth the owner checks it against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

/// A login an agent asked the owner for (`vault:ask:<site>:<account>`): the site and account it names, never a password.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Login {
    pub site: String,
    pub account: String,
}

/// How an ask ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // `NoAnswer` is the name the window and agents are sent
pub enum Answer {
    /// The owner did what was asked and gave the page back.
    Done,
    /// The owner gave the page back without doing it.
    Declined,
    /// Nobody answered in time.
    NoAnswer,
}

static ASKS: Mutex<Vec<(Ask, oneshot::Sender<Answer>)>> = Mutex::new(Vec::new());
static ASKED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The sites whose page the owner holds, and when their window last showed it was there: they took it, and haven't
/// given it back.
static HELD: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

/// How long a page stays the owner's with nothing from their window. A window can go without saying so (a crash, a lid
/// closed), and one click must not then refuse every agent on the site until the node restarts.
const HELD_QUIET: Duration = Duration::from_secs(900);

fn quiet_too_long(touched: Instant, now: Instant) -> bool {
    now.saturating_duration_since(touched) >= HELD_QUIET
}

/// Gives back the pages whose window went quiet: the flow ends where the owner took it, as a give-back ends it, and the
/// owner reads what happened.
fn lapse_held() {
    let now = Instant::now();
    let mut held = HELD.locked();
    let quiet: Vec<String> = held.iter().filter(|(_, t)| quiet_too_long(*t, now)).map(|(s, _)| s.clone()).collect();
    if quiet.is_empty() {
        return;
    }
    held.retain(|(_, t)| !quiet_too_long(*t, now));
    drop(held);
    for site in quiet {
        crate::learn::end_flow(&site);
        store::log_activity(&Activity {
            at: store::now(),
            who: "You".into(),
            site,
            what: "The page went back to the agents: nothing came from your window for 15 minutes".into(),
            kind: "hands".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
}

/// The owner's window is there for `site`.
fn touch_held(site: &str) {
    if let Some((_, t)) = HELD.locked().iter_mut().find(|(s, _)| s == site) {
        *t = Instant::now();
    }
}

/// Whether the owner holds a page or is asked for something: a restart would cut either short.
pub fn owner_busy() -> bool {
    !ASKS.locked().is_empty() || !HELD.locked().is_empty()
}

/// The asks waiting on the owner, oldest first.
pub fn asks() -> Vec<Ask> {
    ASKS.locked().iter().map(|(a, _)| a.clone()).collect()
}

/// The payment waiting on the owner's approval for `site`, if one is: a give-back that says done approves it.
pub fn payment_waiting(site: &str) -> Option<Pay> {
    ASKS.locked().iter().find_map(|(a, _)| a.pay.clone().filter(|_| a.site == site))
}

/// The payment the ask `id` waits on at `site`, if that ask still waits and is one: what an approval from outside the
/// node's dialog names, so a tap on one question never approves another that came after it on the same site.
pub fn payment_asked(site: &str, id: &str) -> Option<Pay> {
    ASKS.locked().iter().find_map(|(a, _)| a.pay.clone().filter(|_| a.site == site && a.id == id))
}

/// `["ask_owner", what…, "--timeout", seconds]`: what the agent needs and how long it waits.
pub fn parse_ask(args: &[String]) -> Result<(String, Duration), String> {
    let mut words = Vec::new();
    let mut wait = ASK_WAIT;
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        if a == "--timeout" {
            let s = it.next().ok_or("--timeout takes seconds, e.g. --timeout 600")?;
            wait = s.parse::<f64>().ok().filter(|s| s.is_finite() && *s > 0.0).ok_or("--timeout takes seconds, e.g. --timeout 600")? as u64;
        } else {
            words.push(a.as_str());
        }
    }
    let why = words.join(" ").trim().to_string();
    if why.is_empty() {
        return Err("say what you need from the owner: [\"ask_owner\", \"sign in to the site\"]".into());
    }
    Ok((why.chars().take(300).collect(), Duration::from_secs(wait.clamp(ASK_LEAST, ASK_MOST))))
}

/// Waits for the owner to give `site`'s page back, up to `wait`, or to answer the payment `pay` asks them to approve.
/// `tab` is the asking session's tab of the site's browser, the page the window shows them. `told` hears the ask once
/// it is waiting.
pub async fn ask(site: &str, tab: Option<&str>, why: &str, agent: &str, wait: Duration, pay: Option<Pay>, told: impl FnOnce(&Ask)) -> Answer {
    waits_on_owner(site, tab, why, agent, wait, pay, None, false, told).await.unwrap_or(Answer::NoAnswer)
}

/// Waits for the owner to add `login` to the vault, up to `wait`: the window shows them its Add login form with the site
/// and account filled in, and the ask is answered when the vault holds it ([`login_added`]) or they say they can't.
/// `None` when `site`'s page already waits on the owner.
pub async fn ask_login(site: &str, tab: Option<&str>, why: &str, agent: &str, wait: Duration, login: Login, told: impl FnOnce(&Ask)) -> Option<Answer> {
    waits_on_owner(site, tab, why, agent, wait, None, Some(login), true, told).await
}

/// Answers, as done, every ask waiting on the owner to add `account` on `site` to the vault: they just did. Returns how
/// many there were.
pub fn login_added(site: &str, account: &str) -> usize {
    let on: Vec<(String, String)> = ASKS
        .locked()
        .iter()
        .filter(|(a, _)| a.login.as_ref().is_some_and(|l| l.site == site && l.account == account))
        .map(|(a, _)| (a.site.clone(), a.id.clone()))
        .collect();
    on.iter().map(|(s, id)| answer_where(s, Answer::Done, |a| &a.id == id)).sum()
}

/// [`ask`], unless `site`'s page is already waiting on the owner: read and joined under one lock, since reaching the
/// owner takes a while and two asks checked before it would both go on. `None` when it was.
pub async fn ask_alone(site: &str, tab: Option<&str>, why: &str, agent: &str, wait: Duration, told: impl FnOnce(&Ask)) -> Option<Answer> {
    waits_on_owner(site, tab, why, agent, wait, None, None, true, told).await
}

#[allow(clippy::too_many_arguments)]
async fn waits_on_owner(site: &str, tab: Option<&str>, why: &str, agent: &str, wait: Duration, pay: Option<Pay>, login: Option<Login>, alone: bool, told: impl FnOnce(&Ask)) -> Option<Answer> {
    let (tx, rx) = oneshot::channel();
    let now = store::now();
    let n = ASKED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let a = Ask { id: format!("ask-{now}-{n}"), site: site.to_string(), why: why.to_string(), agent: agent.to_string(), asked_at: now, expires_at: now + wait.as_secs(), pay, login, tab: tab.map(String::from) };
    {
        let mut asks = ASKS.locked();
        if alone && asks.iter().any(|(x, _)| x.site == site) {
            return None;
        }
        asks.push((a.clone(), tx));
    }
    // The ask leaves the list however the wait ends: answered, timed out, or dropped because the agent's request went
    // away. Left behind, it would hold the site's page for an agent that is no longer waiting.
    struct Leaves(String);
    impl Drop for Leaves {
        fn drop(&mut self) {
            ASKS.locked().retain(|(a, _)| a.id != self.0);
        }
    }
    let _leaves = Leaves(a.id.clone());
    // The agent's call can be cancelled while its request stays open (MCP `notifications/cancelled` sets its stop
    // flag): the wait ends then, with no answer, and the page is the agents' again (B07).
    let stop = crate::api::asks::current().map(|c| c.stop.clone());
    let cancelled = async move {
        let Some(stop) = stop else { return std::future::pending().await };
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    told(&a);
    Some(tokio::select! {
        answer = tokio::time::timeout(wait, rx) => answer.ok().and_then(Result::ok).unwrap_or(Answer::NoAnswer),
        () = cancelled => Answer::NoAnswer,
    })
}

/// How long an ask waits for the owner's window to come up, once it has been opened, before saying the owner can't
/// be reached.
pub const WINDOW_WAIT: Duration = Duration::from_secs(20);

/// An ask must reach the owner, and it reaches them in a window watching the node's events (`GET /owner/events`: the
/// native window or the web one). With none watching (`watchers`), the window is opened (`open`) and given `wait` to
/// connect. When none can be opened or none connects, the ask is refused at once, saying so, instead of waiting for an
/// answer nobody can give.
pub async fn reach_owner(watchers: impl Fn() -> usize, open: impl FnOnce() -> Result<(), String>, wait: Duration) -> Result<(), String> {
    if watchers() > 0 {
        return Ok(());
    }
    let why = match open() {
        Ok(()) => {
            let until = Instant::now() + wait;
            while Instant::now() < until {
                if watchers() > 0 {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            format!("the window was opened but didn't connect within {} s", wait.as_secs())
        }
        Err(e) => format!("it couldn't be opened here ({e})"),
    };
    Err(format!(
        "the owner can't see this: no Unbrowse window is open, and {why}. Nothing was asked. The owner can open the window (`unbrowse-window`, or `unbrowse app`) and you ask again; or tell the user what you need them to do."
    ))
}

/// Whether an ask can reach the owner, as an agent is told before it asks (`unbrowse_whoami`): a window of theirs is
/// `watching`; none is, and the node opens one at the ask (`can_open`); or the owner keeps windows off this node
/// (`off`), where [`reach_owner`] refuses every ask at once. Said up front so an agent doesn't find out by asking.
pub fn owner_reach(watchers: usize, windows_off: bool) -> &'static str {
    match (watchers > 0, windows_off) {
        (true, _) => "watching",
        (false, false) => "can_open",
        (false, true) => "off",
    }
}

/// Opens the owner's window, `unbrowse-window`: the one beside this program, else the one on the PATH. The window is
/// the owner's, not the node's: it runs in its own process group (and, under a service manager, its own scope), so
/// stopping or restarting the node leaves it open, and it isn't told it runs under the node's service.
pub fn open_window() -> Result<(), String> {
    if cfg!(test) {
        return Err("a test opens no window".into());
    }
    if crate::browsers::headless_only() {
        return Err("the owner keeps windows off this node".into());
    }
    let name = if cfg!(windows) { "unbrowse-window.exe" } else { "unbrowse-window" };
    let beside = std::env::current_exe().ok().map(|e| e.with_file_name(name)).filter(|p| p.exists());
    let program = beside.unwrap_or_else(|| std::path::PathBuf::from(name));
    // Under systemd the node's service stops every process in its group, so the window gets a scope of its own.
    let scoped = std::env::var_os("INVOCATION_ID").is_some() && which("systemd-run");
    let mut c = if scoped {
        let mut c = std::process::Command::new("systemd-run");
        c.args(["--user", "--scope", "--quiet", "--collect", "--"]).arg(&program);
        c
    } else {
        std::process::Command::new(&program)
    };
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    c.env_remove("INVOCATION_ID").env_remove("JOURNAL_STREAM");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let mut child = c.spawn().map_err(|e| format!("{}: {e}", program.display()))?;
    // Reaped when it exits, so a window closed never lingers as a zombie of the node's.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Whether `program` is on the PATH.
fn which(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|d| d.join(program).is_file()))
}

/// Answers every ask waiting on `site`; returns how many there were.
pub fn answer(site: &str, how: Answer) -> usize {
    answer_where(site, how, |_| true)
}

/// Whether a give-back that says `how`, approving `approved`, ends a payment among `asks` of `site`: an ask for a payment
/// it leaves waiting isn't what this give-back did.
fn ends_a_payment<'a>(mut asks: impl Iterator<Item = &'a Ask>, site: &str, how: Answer, approved: Option<&Pay>) -> bool {
    asks.any(|a| a.site == site && a.pay.is_some() && answers(a, how, approved))
}

/// Whether a give-back that says `how`, approving `approved`, answers `a`.
fn answers(a: &Ask, how: Answer, approved: Option<&Pay>) -> bool {
    how != Answer::Done || a.pay.as_ref().is_none_or(|p| approved == Some(p))
}

/// `answer`, for the asks on `site` that `which` picks; the rest wait on.
fn answer_where(site: &str, how: Answer, which: impl Fn(&Ask) -> bool) -> usize {
    let mut asks = ASKS.locked();
    let (on, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *asks).into_iter().partition(|(a, _)| a.site == site && which(a));
    *asks = rest;
    let n = on.len();
    for (_, tx) in on {
        let _ = tx.send(how);
    }
    n
}

/// Why an agent's command on `site` waits, if the page is the owner's now: they hold it, or an agent asked for them.
pub fn busy(site: &str) -> Option<String> {
    if held(site) {
        return Some(format!("the owner has {site}'s page in the node's window: you can read it (snapshot, screenshot, get url/title/text), and anything that would change it waits until they give it back (ask_owner answers when they do)"));
    }
    ASKS.locked()
        .iter()
        .find(|(a, _)| a.site == site)
        .map(|(a, _)| format!("{site}'s page is waiting on the owner ({}: \"{}\"): you can read it (snapshot, screenshot, get url/title/text), and anything that would change it waits until ask_owner answers", a.agent, a.why))
}

/// The tab of `site`'s browser an ask waiting on the owner is about: the asking session's.
pub fn asking_tab(site: &str) -> Option<String> {
    ASKS.locked().iter().find(|(a, _)| a.site == site).and_then(|(a, _)| a.tab.clone())
}

/// Whether the owner holds `site`'s page.
pub fn held(site: &str) -> bool {
    lapse_held();
    HELD.locked().iter().any(|(s, _)| s == site)
}

/// Held by a test that keeps the one picture of the node's browser running, and by the test that runs every owner
/// command (`hands_stop` among them), so the second never stops the first's picture midway.
#[cfg(test)]
pub(crate) static WATCH_FOR_TEST: Mutex<()> = Mutex::new(());

/// The owner takes `site`'s page (`on`) or gives it back, for a test elsewhere in the node: no window, no flow.
#[cfg(test)]
pub(crate) fn hold_for_test(site: &str, on: bool) {
    let mut held = HELD.locked();
    held.retain(|(s, _)| s != site);
    if on {
        held.push((site.to_string(), Instant::now()));
    }
}

// ---- where a click lands, what a key is ----

/// A point on the picture, as fractions of its width and height from its top left, as a point on the page in CSS
/// pixels: the picture is the page's viewport, `vw` × `vh`, scaled.
pub fn to_page(fx: f64, fy: f64, vw: f64, vh: f64) -> Result<(f64, f64), String> {
    if !(fx.is_finite() && fy.is_finite()) || !(0.0..=1.0).contains(&fx) || !(0.0..=1.0).contains(&fy) {
        return Err("a point on the picture is two fractions between 0 and 1".into());
    }
    if !(vw.is_finite() && vh.is_finite()) || vw <= 0.0 || vh <= 0.0 {
        return Err("the page's size isn't known yet: wait for its first picture".into());
    }
    // The last pixel's far edge is no pixel: a click there is on the last one.
    Ok(((fx * vw).min(vw - 1.0).max(0.0), (fy * vh).min(vh - 1.0).max(0.0)))
}

/// A key the window passes on, as DevTools takes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub key: &'static str,
    pub code: &'static str,
    pub vk: u32,
    /// What the key types, for the keys that type something.
    pub text: Option<&'static str>,
}

/// The keys the window passes on by name: the ones that move about a form and send it. Letters and the rest go as
/// text.
pub fn key_of(name: &str) -> Option<Key> {
    let k = |key, code, vk, text| Some(Key { key, code, vk, text });
    match name {
        "Enter" => k("Enter", "Enter", 13, Some("\r")),
        "Tab" => k("Tab", "Tab", 9, None),
        "Backspace" => k("Backspace", "Backspace", 8, None),
        "Delete" => k("Delete", "Delete", 46, None),
        "Escape" => k("Escape", "Escape", 27, None),
        "ArrowLeft" => k("ArrowLeft", "ArrowLeft", 37, None),
        "ArrowUp" => k("ArrowUp", "ArrowUp", 38, None),
        "ArrowRight" => k("ArrowRight", "ArrowRight", 39, None),
        "ArrowDown" => k("ArrowDown", "ArrowDown", 40, None),
        "Home" => k("Home", "Home", 36, None),
        "End" => k("End", "End", 35, None),
        "PageUp" => k("PageUp", "PageUp", 33, None),
        "PageDown" => k("PageDown", "PageDown", 34, None),
        _ => None,
    }
}

/// Whether a key ends what is being typed into a field: it sends the form or moves to another field.
fn ends_typing(name: &str) -> bool {
    matches!(name, "Enter" | "Tab" | "Escape")
}

// ---- what the owner is typing ----

/// What the owner has typed into one field since they last clicked, sent or moved on: held in memory only, so that
/// once it turns out to be a secret it can leave the walk record and every reply.
#[derive(Default, Debug, PartialEq)]
pub struct Run {
    pub site: String,
    pub page: String,
    pub text: String,
}

impl Run {
    pub fn push(&mut self, site: &str, page: &str, text: &str) {
        if self.site != site {
            *self = Run { site: site.to_string(), page: page.to_string(), text: String::new() };
        }
        self.text.push_str(text);
    }

    pub fn backspace(&mut self) {
        self.text.pop();
    }
}

static RUN: Mutex<Run> = Mutex::new(Run { site: String::new(), page: String::new(), text: String::new() });

/// The field the page's focus is in, as the owner's own line to it reads it.
#[derive(Debug, PartialEq)]
pub enum Field {
    /// A secret field ([`is_secret_field`]: a password, a one-time code, a card's number, expiry or security code),
    /// with what it holds.
    Secret(String),
    /// A field that holds no secret: a search box, an email address.
    Plain,
    /// Nothing that takes text has the focus.
    None,
    /// A frame from another site has it, which the page can't see into: what was typed is taken as a secret.
    Unknown,
}

/// Reads where the focus is: through open shadow roots and same-site frames to the field itself, and what the field
/// says of itself (its type, its autocomplete, its name, id, label and placeholder) with its value. It decides
/// nothing: [`is_secret_field`] does, in the node, where a test reads it. A plain field's value is dropped there.
const FOCUS_JS: &str = r#"(() => {
  const deep = (d) => { let e = d.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return e; };
  let e = deep(document);
  try {
    while (e && /^(IFRAME|FRAME)$/.test(e.tagName)) { const d = e.contentDocument; if (!d) return { kind: "unknown" }; e = deep(d); }
  } catch (_) { return { kind: "unknown" }; }
  if (!e || !("value" in e)) return { kind: "none" };
  const attr = (n) => String((e.getAttribute && e.getAttribute(n)) || "");
  let labels = "";
  try { labels = Array.from(e.labels || []).map((l) => l.textContent || "").join(" "); } catch (_) {}
  let named = "";
  try { named = attr("aria-labelledby").split(/\s+/).map((id) => { const l = id && document.getElementById(id); return (l && l.textContent) || ""; }).join(" "); } catch (_) {}
  return {
    kind: "field",
    type: String(e.type || ""),
    autocomplete: attr("autocomplete"),
    words: [attr("name"), String(e.id || ""), attr("aria-label"), attr("placeholder"), attr("title"), attr("data-elements-stable-field-name"), labels, named].join(" "),
    value: String(e.value),
  };
})()"#;

/// The autocomplete tokens of a secret field (WHATWG autofill): a password, a one-time code, and a card's number,
/// expiry (whole or in parts) and security code. A card's holder name and type are not secret.
const SECRET_AUTOCOMPLETE: &[&str] = &["current-password", "new-password", "one-time-code", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc"];

/// What a card's number, expiry or security code field, or a password or PIN shown as text, calls itself in its name,
/// id, label, title or placeholder, letters and digits only, run together: what a checkout that sets no autocomplete,
/// or a sign-in whose "show password" made the field text, still says of the field.
const CARD_WORDS: &[&str] = &[
    "cardnumber", "cardnum", "cardno", "ccnumber", "ccnum", "numberoncard", "pan",
    "cvc", "cvv", "cvn", "csc", "securitycode", "cardcode", "cardverification", "verificationcode",
    "expiry", "expiration", "expdate", "expmonth", "expyear", "ccexp", "cardexp", "mmyy", "mmyyyy", "validthru", "validuntil",
    "cvv2", "cvc2", "ccv", "cardcvv", "cardcvc", "securitynumber", "cardidentification", "cid",
    "password", "passwd", "pwd", "passcode", "pin",
];

/// Word starts that say a card's expiry or code however the rest of the word runs (`Expires`, `cvvCode`, `cvcNumber`):
/// a field's name or label word that begins with one ([`is_secret_field`]).
const CARD_STEMS: &[&str] = &["expir", "cvv", "cvc", "csc", "ccv"];

/// Whether a field is secret from what it says of itself: a password field, a field whose autocomplete names a
/// secret ([`SECRET_AUTOCOMPLETE`]), or one whose name, id, label or placeholder says a card's number, expiry or code
/// ([`CARD_WORDS`], read as whole words or run together). What the owner types into one leaves the walk record and is
/// held and masked as a vault fill is (audit 1118 H6: only password and one-time-code fields were, so a card typed by
/// hand came back as typed, and its page let scripts in).
pub fn is_secret_field(kind: &str, autocomplete: &str, words: &str) -> bool {
    if kind.eq_ignore_ascii_case("password") {
        return true;
    }
    let ac = autocomplete.to_ascii_lowercase();
    if ac.split_ascii_whitespace().any(|t| SECRET_AUTOCOMPLETE.contains(&t)) {
        return true;
    }
    let lower = words.to_lowercase();
    let tokens: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let joined: String = tokens.concat();
    // A short word ("pan", "cvc", "csc") only as a word of its own; a longer one anywhere, run together or not.
    CARD_WORDS.iter().any(|w| tokens.contains(w) || (w.len() > 3 && joined.contains(w)))
        || tokens.contains(&"exp")
        || tokens.iter().any(|t| CARD_STEMS.iter().any(|s| t.starts_with(s)))
}

fn field_of(v: &Value) -> Field {
    let r = v.pointer("/result/value").unwrap_or(&Value::Null);
    let text = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or_default();
    match r.get("kind").and_then(|k| k.as_str()) {
        Some("field") if is_secret_field(text("type"), text("autocomplete"), text("words")) => Field::Secret(text("value").to_string()),
        Some("field") => Field::Plain,
        Some("none") => Field::None,
        _ => Field::Unknown,
    }
}

/// The card numbers in what the owner typed, as typed: each run of digits with at most one separator (a space, a
/// dash, a dot or a slash) between two: the whole run when it is 12 to 19 digits that pass the Luhn check, and each
/// of the first 13 to 19 digits of a longer run that pass it. Typing runs on until a click, Tab or Enter, so a page
/// that moves the focus itself from the number to the expiry, the code and on to a name field leaves one run whose
/// digits start with the number and go on with the rest.
fn card_numbers_in(typed: &str) -> Vec<String> {
    let b = typed.as_bytes();
    let separator = |c: u8| matches!(c, b' ' | b'-' | b'.' | b'/');
    let (mut out, mut i) = (Vec::new(), 0);
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        // Each digit of the run, with the byte just past it.
        let (mut digits, mut ends) = (Vec::new(), Vec::new());
        while i < b.len() {
            if b[i].is_ascii_digit() {
                digits.push(b[i]);
                i += 1;
                ends.push(i);
            } else if separator(b[i]) && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                i += 1;
            } else {
                break;
            }
        }
        let n = digits.len();
        // A run that is a number's length is one whole or not at all; a longer one (17 digits or more: a number and
        // what followed it) holds one in any of its first 13 to 19 digits, each kept, since which is the number
        // can't be told.
        let lengths: Vec<usize> = if n >= 17 { (13..=19.min(n)).collect() } else if n >= 12 { vec![n] } else { vec![] };
        for k in lengths {
            if unbrowse_detector::card::luhn(&digits[..k]) {
                out.push(typed[start..ends[k - 1]].to_string());
            }
        }
    }
    out
}

/// What leaves the walk record when typing into `field` ends: a secret field's whole value (what the owner typed,
/// pasted or picked from autofill), what was typed into a field nobody can read, and a card number typed anywhere,
/// whatever the field the focus ended in says of itself (a page that moves the focus from the card's fields to a
/// plain one, or a card field named in words no list holds, would let the number through as plain text).
pub fn secrets_of(field: &Field, typed: &str) -> Vec<String> {
    let mut out = Vec::new();
    let cards = card_numbers_in(typed);
    match field {
        Field::Secret(v) => {
            out.push(v.clone());
            if !typed.is_empty() && !v.contains(typed) {
                out.push(typed.to_string());
            }
        }
        Field::Unknown => out.push(typed.to_string()),
        Field::Plain | Field::None if !cards.is_empty() => out.push(typed.to_string()),
        Field::Plain | Field::None => {}
    }
    // The number on its own too: the record keeps it as its own field's value, apart from what came after it.
    out.extend(cards);
    out.retain(|s| !s.trim().is_empty());
    let mut seen = Vec::new();
    out.retain(|s| if seen.contains(s) { false } else { seen.push(s.clone()); true });
    out
}

// ---- the picture, and the line to the page ----

/// The latest picture of each page the owner watches: `GET /owner/frame?walk=hands:<site>`.
static FRAMES: LazyLock<Frames> = LazyLock::new(Frames::default);

/// What the window fetches a site's picture as.
pub fn walk_of(site: &str) -> String {
    format!("hands:{site}")
}

/// The latest picture of `walk` (`hands:<site>`).
pub fn frame(walk: &str) -> Option<Vec<u8>> {
    let site = walk.strip_prefix("hands:")?;
    // A window fetching pictures is a window that is there.
    touch_held(site);
    FRAMES.get(walk)
}

/// The line to the page of the site the owner is watching.
#[derive(Clone)]
struct Watch {
    site: String,
    /// The page shown: the tab of the session that acted on the site last or asked for the owner.
    target: String,
    client: Arc<CdpClient>,
    session: String,
    /// The page's viewport in CSS pixels, from its latest picture.
    viewport: Arc<Mutex<(f64, f64)>>,
    url: Arc<Mutex<String>>,
    touched: Arc<Mutex<Instant>>,
    stop: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

/// The page target to show: `front` (the tab of the session that acted on the site last, or asked for the owner),
/// else the one the node's browsing has attached to, else the first page.
pub fn pick_page(targets: &Value, front: Option<&str>) -> Option<String> {
    let pages: Vec<&Value> = targets
        .pointer("/targetInfos")
        .and_then(|t| t.as_array())
        .map(|t| t.iter().filter(|t| t["type"] == "page" && !t["url"].as_str().unwrap_or_default().starts_with("devtools://")).collect())
        .unwrap_or_default();
    pages
        .iter()
        .find(|t| front.is_some() && t["targetId"].as_str() == front)
        .or(pages.iter().find(|t| t["attached"] == true))
        .or(pages.first())
        .and_then(|t| t["targetId"].as_str())
        .map(String::from)
}

fn current(site: &str) -> Option<Watch> {
    WATCH.locked().as_ref().filter(|w| w.site == site).cloned()
}

/// Shows `site`'s page to the owner: a live picture, a few a second, until `stop` or another site is watched.
pub async fn watch(site: &str, events: &Events) -> Result<Value, String> {
    let s = site.to_string();
    let (ws, front) = tokio::task::spawn_blocking(move || {
        let front = crate::browse::shown_tab(&s).and_then(|tab| crate::browse::target_of(&s, &tab));
        (crate::browse::cdp_of(&s), front)
    })
    .await
    .map_err(|e| e.to_string())?;
    // The picture already shows this site's page: kept, unless another session's tab has come to the front.
    touch_held(site);
    if let Some(w) = current(site).filter(|w| front.as_ref().is_none_or(|f| *f == w.target)) {
        *w.touched.locked() = Instant::now();
        return Ok(state(site, &w));
    }
    stop();
    let ws = ws.ok_or_else(|| format!("{site}'s browser isn't open: it opens when an agent browses the site (unbrowse_browse open <url>)"))?;
    watch_on(site, &ws, front.as_deref(), events).await
}

/// Shows the owner `site`'s page in the browser at DevTools address `ws`: the tab `front` names, else the one attached,
/// else the first.
async fn watch_on(site: &str, ws: &str, front: Option<&str>, events: &Events) -> Result<Value, String> {
    let client = Arc::new(CdpClient::connect(ws).await?);
    let targets = client.send_command("Target.getTargets", Some(json!({})), None).await?;
    let target = pick_page(&targets, front).ok_or("no page is open in that browser")?;
    let attached = client.send_command("Target.attachToTarget", Some(json!({ "targetId": target, "flatten": true })), None).await?;
    let session = attached["sessionId"].as_str().ok_or("the browser didn't let the window attach")?.to_string();
    let _ = client.send_command("Page.enable", None, Some(&session)).await;
    let mut viewport = (0.0, 0.0);
    if let Ok(m) = client.send_command("Page.getLayoutMetrics", None, Some(&session)).await {
        let dim = |k: &str| m.pointer(&format!("/cssVisualViewport/{k}")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        viewport = (dim("clientWidth"), dim("clientHeight"));
    }
    let url = targets
        .pointer("/targetInfos")
        .and_then(|t| t.as_array())
        .and_then(|t| t.iter().find(|t| t["targetId"] == target.as_str()))
        .and_then(|t| t["url"].as_str())
        .unwrap_or_default()
        .to_string();
    client
        .send_command(
            "Page.startScreencast",
            // In a format the owner's window on this machine can draw (`screencast::FORMAT`): PNG off a Mac.
            Some({
                let mut p = screencast::encoding(QUALITY);
                p["maxWidth"] = MAX_WIDTH.into();
                p["maxHeight"] = MAX_WIDTH.into();
                p["everyNthFrame"] = 1.into();
                p
            }),
            Some(&session),
        )
        .await?;
    let (stop_tx, stop_rx) = oneshot::channel();
    let w = Watch {
        site: site.to_string(),
        target: target.clone(),
        client,
        session,
        viewport: Arc::new(Mutex::new(viewport)),
        url: Arc::new(Mutex::new(url)),
        touched: Arc::new(Mutex::new(Instant::now())),
        stop: Arc::new(Mutex::new(Some(stop_tx))),
    };
    *WATCH.locked() = Some(w.clone());
    tokio::spawn(pictures(w.clone(), stop_rx, events.clone()));
    Ok(state(site, &w))
}

fn state(site: &str, w: &Watch) -> Value {
    let (vw, vh) = *w.viewport.locked();
    json!({ "site": site, "url": *w.url.locked(), "walk": walk_of(site), "width": vw, "height": vh, "held": held(site) })
}

/// Why the pictures of a page stopped, for the dev log.
#[derive(Debug)]
enum Stopped {
    Asked,
    Idle,
    Detached,
    Closed,
}

/// Takes the page's pictures and its moves to other addresses, and passes them on, until told to stop, the browser
/// goes away, or nobody has looked for a while.
async fn pictures(w: Watch, mut stop_rx: oneshot::Receiver<()>, events: Events) {
    let mut rx = w.client.subscribe_raw();
    let mut tick = tokio::time::interval(Duration::from_millis(EVERY_MS));
    let mut held_frame: Option<screencast::Frame> = None;
    let walk = walk_of(&w.site);
    let why = loop {
        tokio::select! {
            _ = &mut stop_rx => break Stopped::Asked,
            _ = tick.tick() => {
                if let Some(f) = held_frame.take() {
                    events.emit("hands_frame", FRAMES.put(&walk, f));
                }
                let idle = w.touched.locked().elapsed() > IDLE;
                if idle && !held(&w.site) && !asks().iter().any(|a| a.site == w.site) {
                    break Stopped::Idle;
                }
            }
            m = rx.recv() => match m {
                Ok(m) if m.session_id.as_deref() == Some(w.session.as_str()) => {
                    let Ok(v) = serde_json::from_str::<Value>(&m.text) else { continue };
                    match v["method"].as_str() {
                        Some("Page.screencastFrame") => {
                            if let Some(ack) = v.pointer("/params/sessionId").and_then(|s| s.as_u64()) {
                                let _ = w.client.send_command_no_wait("Page.screencastFrameAck", Some(json!({ "sessionId": ack })), Some(&w.session)).await;
                            }
                            let dim = |k: &str| v.pointer(&format!("/params/metadata/{k}")).and_then(|d| d.as_f64()).unwrap_or(0.0);
                            if dim("deviceWidth") > 0.0 && dim("deviceHeight") > 0.0 {
                                *w.viewport.locked() = (dim("deviceWidth"), dim("deviceHeight"));
                            }
                            if let Some(f) = screencast::frame_of(&v) {
                                held_frame = Some(f);
                            }
                        }
                        Some("Page.frameNavigated") if v.pointer("/params/frame/parentId").is_none() => {
                            let url = v.pointer("/params/frame/url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
                            *w.url.locked() = url.clone();
                            events.emit("hands", json!({ "kind": "page", "site": w.site, "url": url }));
                        }
                        Some("Inspector.detached") => break Stopped::Detached,
                        _ => {}
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break Stopped::Closed,
            },
        }
    };
    // The picture can stop with typing unfinished (the window's screen closed, a page the owner still holds): what was
    // typed is put away now, while the line to the page can still read the field.
    end_typing(&w).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), w.client.send_command("Page.stopScreencast", None, Some(&w.session))).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), w.client.send_command("Target.detachFromTarget", Some(json!({ "sessionId": w.session })), None)).await;
    w.client.close().await;
    let mut cur = WATCH.locked();
    if cur.as_ref().is_some_and(|c| Arc::ptr_eq(&c.client, &w.client)) {
        *cur = None;
    }
    drop(cur);
    events.tell("hands", &json!({ "kind": "stopped", "site": w.site, "why": format!("{why:?}") }));
}

/// Stops the picture. The page stays as it is, and the owner keeps it if they hold it.
pub fn stop() {
    if let Some(w) = WATCH.locked().take() {
        if let Some(tx) = w.stop.locked().take() {
            let _ = tx.send(());
        }
    }
}

/// One thing the owner did on the picture: a click or a scroll at a point, text typed, or a key. The first one takes
/// the page: the agents' commands on the site wait until the owner gives it back.
pub async fn input(site: &str, ev: &Value, events: &Events) -> Result<Value, String> {
    let w = match current(site) {
        Some(w) => w,
        None => {
            watch(site, events).await?;
            current(site).ok_or("the page went away")?
        }
    };
    *w.touched.locked() = Instant::now();
    touch_held(site);
    // What the owner types goes to the page, and a script an agent left on it could hear it: nothing typed reaches a
    // page an agent's script ran in. Looking, scrolling and clicking still work.
    if matches!(ev["kind"].as_str(), Some("text" | "key")) {
        let (s, target) = (site.to_string(), w.target.clone());
        if tokio::task::spawn_blocking(move || crate::browse::script_may_have_run(&s, crate::browse::Scope::Page(&target))).await.unwrap_or(true) {
            return Err(format!("nothing was typed: {}", crate::browse::SCRIPTED_FOR_THE_OWNER));
        }
    }
    // Scrolling only looks; a click or a key takes the page.
    if ev["kind"] != "scroll" {
        take(site, events);
    }
    let at = |w: &Watch| -> Result<(f64, f64), String> {
        let (vw, vh) = *w.viewport.locked();
        to_page(ev["x"].as_f64().unwrap_or(f64::NAN), ev["y"].as_f64().unwrap_or(f64::NAN), vw, vh)
    };
    let send = |method: &'static str, params: Value| {
        let w = w.clone();
        async move { w.client.send_command(method, Some(params), Some(&w.session)).await.map(|_| ()) }
    };
    match ev["kind"].as_str().unwrap_or_default() {
        "click" => {
            let (x, y) = at(&w)?;
            end_typing(&w).await;
            let clicks = ev["clicks"].as_u64().unwrap_or(1).clamp(1, 3);
            send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y })).await?;
            for n in 1..=clicks {
                send("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": n })).await?;
                send("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": n })).await?;
            }
        }
        "scroll" => {
            let (x, y) = at(&w)?;
            let dy = ev["dy"].as_f64().filter(|d| d.is_finite()).unwrap_or(0.0).clamp(-5000.0, 5000.0);
            let dx = ev["dx"].as_f64().filter(|d| d.is_finite()).unwrap_or(0.0).clamp(-5000.0, 5000.0);
            send("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy })).await?;
        }
        "text" => {
            let text = ev["text"].as_str().unwrap_or_default();
            if text.is_empty() || text.len() > TEXT_MOST || text.chars().any(|c| c.is_control()) {
                return Err("text is up to 4096 printable characters; send keys such as Enter by name".into());
            }
            let page = w.url.locked().clone();
            crate::browse::owner_typing(site, &page);
            RUN.locked().push(site, &page, text);
            send("Input.insertText", json!({ "text": text })).await?;
        }
        "key" => {
            let name = ev["key"].as_str().unwrap_or_default();
            let k = key_of(name).ok_or_else(|| format!("the window passes on Enter, Tab, Backspace, Delete, Escape, the arrows, Home, End, PageUp and PageDown, not {name:?}"))?;
            if ends_typing(name) {
                end_typing(&w).await;
            } else if name == "Backspace" {
                RUN.locked().backspace();
            }
            let mut down = json!({ "type": if k.text.is_some() { "keyDown" } else { "rawKeyDown" }, "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.vk, "nativeVirtualKeyCode": k.vk });
            if let Some(t) = k.text {
                down["text"] = json!(t);
                down["unmodifiedText"] = json!(t);
            }
            send("Input.dispatchKeyEvent", down).await?;
            send("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.vk, "nativeVirtualKeyCode": k.vk })).await?;
        }
        other => return Err(format!("the owner's hands click, scroll, type text or press a key, not {other:?}")),
    }
    Ok(state(site, &w))
}

/// The owner takes `site`'s page. The learner's flow ends here: nothing the agent did before is run together with
/// what the owner does now.
fn take(site: &str, events: &Events) {
    let mut held = HELD.locked();
    if held.iter().any(|(s, _)| s == site) {
        return;
    }
    held.push((site.to_string(), Instant::now()));
    drop(held);
    crate::learn::end_flow(site);
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: site.to_string(),
        what: "Took over the page in the node's browser".into(),
        kind: "hands".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    events.emit("hands", json!({ "kind": "held", "site": site }));
    events.emit("activity", ());
}

/// The owner's typing into a field ends (a click, a send, a move to another field, giving the page back): if the
/// field holds a secret, it leaves the walk record before anything sends it, and every reply says it as
/// `[typed by the owner]`.
async fn end_typing(w: &Watch) {
    read_what_was_typed(w).await;
    crate::browse::owner_done_typing(&w.site);
}

async fn read_what_was_typed(w: &Watch) {
    let run = std::mem::take(&mut *RUN.locked());
    let asked = w.client.send_command("Runtime.evaluate", Some(json!({ "expression": FOCUS_JS, "returnByValue": true })), Some(&w.session));
    let field = match tokio::time::timeout(Duration::from_secs(2), asked).await {
        Ok(Ok(v)) => field_of(&v),
        _ => Field::Unknown,
    };
    // A field that holds a secret the owner didn't type here (a password manager's fill, typing before the window
    // looked) is a secret all the same.
    let typed = if run.site == w.site { run.text } else { String::new() };
    if typed.is_empty() && !matches!(field, Field::Secret(_)) {
        return;
    }
    let page = w.url.locked().clone();
    let secrets = secrets_of(&field, &typed);
    // The document is held with its address: a page can change its address without loading another (`pushState`).
    let document = if secrets.is_empty() { None } else { document_of(w).await };
    put_away(&w.site, secrets, &page, document.as_deref()).await;
}

/// The document the watched page shows, as the browse side names it (`document:<loader id>`, the main frame's loader
/// id, which only a new load changes). `None` when the page doesn't say within 2 s.
async fn document_of(w: &Watch) -> Option<String> {
    let asked = w.client.send_command("Page.getFrameTree", None, Some(&w.session));
    let tree = tokio::time::timeout(Duration::from_secs(2), asked).await.ok()?.ok()?;
    tree.pointer("/frameTree/frame/loaderId").and_then(|d| d.as_str()).filter(|d| !d.is_empty()).map(|d| format!("document:{d}"))
}

/// `secrets` leave the walk record of `site`, and every reply says them as the owner's.
async fn put_away(site: &str, secrets: Vec<String>, page: &str, document: Option<&str>) {
    for secret in secrets {
        let (s, page, document) = (site.to_string(), page.to_string(), document.map(str::to_string));
        let forgot = tokio::task::spawn_blocking(move || {
            // Said as the owner's in every reply whether or not the record could be rewritten.
            crate::browse::owner_typed_in(&s, &secret, &page, document.as_deref());
            crate::browse::forget(&s, &secret)
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
        if let Err(why) = forgot {
            forget_failed(site, &why);
        }
    }
}

/// Typing on `site` with no line to its page left to read the field through: what was typed may be a secret, and is
/// taken for one.
async fn put_away_unread(site: &str) {
    let run = {
        let mut run = RUN.locked();
        if run.site != site {
            return;
        }
        std::mem::take(&mut *run)
    };
    put_away(site, secrets_of(&Field::Unknown, &run.text), &run.page, None).await;
    crate::browse::owner_done_typing(site);
}

/// What the owner typed couldn't be taken out of the site's walk record: the owner hears it, the learner's flow
/// ends here so nothing learned carries it, and the activity log says so.
fn forget_failed(site: &str, why: &str) {
    crate::learn::end_flow(site);
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: site.to_string(),
        what: "What you typed into a secret field may still be in the node's walk record of this page".into(),
        kind: "hands".into(),
        result: "failed".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(why.chars().take(200).collect()),
    });
}

/// The owner gives `site`'s page back: what they typed is put away, the learner's next flow starts from here, and an
/// agent waiting on them hears how it went.
/// What the owner is asked before a give-back approves `pay`: the merchant, the card, what the call does and sends.
pub fn payment_question(pay: &Pay) -> String {
    let what = pay.route.as_ref().map(|r| format!(" for \"{r}\"")).unwrap_or_default();
    let sent = if pay.inputs.is_empty() { String::new() } else { format!(" The call sends: {}.", pay.inputs.join(", ").chars().take(300).collect::<String>()) };
    let amount = pay.amount.map(|x| format!(" The agent says it costs {x}: check that on the page.")).unwrap_or_default();
    let over = pay.over.as_ref().map(|o| format!(" It's over what you set: {}.", o.chars().take(160).collect::<String>())).unwrap_or_default();
    format!("Something on this computer is asking Unbrowse to pay {} with {}{what}.{amount}{sent}{over} Allow it only if you asked for this yourself just now.", pay.merchant, pay.card)
}

/// Gives `site`'s page back. A give-back that says done approves a payment waiting there only when it is `approved`,
/// the payment the owner said yes to in the node's dialog: any other payment, one that came after the question was
/// asked among them, waits on. A decline answers every ask.
pub async fn give_back_approving(site: &str, how: Answer, approved: Option<&Pay>, events: &Events) -> Result<Value, String> {
    give_back_inner(site, how, approved, events).await
}

pub async fn give_back(site: &str, how: Answer, events: &Events) -> Result<Value, String> {
    give_back_inner(site, how, None, events).await
}

async fn give_back_inner(site: &str, how: Answer, approved: Option<&Pay>, events: &Events) -> Result<Value, String> {
    match current(site) {
        Some(w) => end_typing(&w).await,
        None => put_away_unread(site).await,
    }
    let was_held = {
        let mut held = HELD.locked();
        let before = held.len();
        held.retain(|(s, _)| s != site);
        before != held.len()
    };
    // Approving a payment leaves the page as the agent had it: the flow it is learning carries on through the
    // checkout. Only a turn in which the owner held the page (and may have typed into it) is cut out of the flow.
    let paying = ends_a_payment(ASKS.locked().iter().map(|(a, _)| a), site, how, approved);
    if was_held || !paying {
        crate::learn::end_flow(site);
    }
    let answered = answer_where(site, how, |a| answers(a, how, approved));
    if was_held || answered > 0 {
        let what = match (paying, how == Answer::Declined) {
            (true, false) => "Approved the payment",
            (true, true) => "Declined the payment",
            (false, false) => "Gave the page back",
            (false, true) => "Gave the page back without doing it",
        };
        store::log_activity(&Activity {
            at: store::now(),
            who: "You".into(),
            site: site.to_string(),
            what: what.into(),
            kind: "hands".into(),
            result: if how == Answer::Declined { "declined" } else { "done" }.into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
    events.emit("hands", json!({ "kind": "given_back", "site": site, "answer": how }));
    events.emit("activity", ());
    Ok(json!({ "site": site, "answered": answered }))
}

// ---- the owner answers from another device (UNB-147) ----

/// When a device of the owner's that answers asks away from the machine (the daemon hub's Telegram bot) last said it
/// was there (`remote_answers` with `via`).
static AWAY_SEEN: Mutex<Option<Instant>> = Mutex::new(None);

/// How long that device counts as there after it last said so: it says so every few seconds while it runs.
pub const AWAY_FRESH: Duration = Duration::from_secs(30);

/// A device of the owner's that answers asks away from the machine is there now.
pub fn away_seen() {
    *AWAY_SEEN.locked() = Some(Instant::now());
}

/// Whether such a device said it was there within [`AWAY_FRESH`]: then an ask reaches the owner with no window open.
pub fn away_there() -> bool {
    AWAY_SEEN.locked().is_some_and(|t| away_fresh(t, Instant::now()))
}

fn away_fresh(seen: Instant, now: Instant) -> bool {
    now.saturating_duration_since(seen) < AWAY_FRESH
}

/// The most a code from another device may be: a two-step code, a backup code, a short word.
pub const CODE_MOST: usize = 64;

/// Finds the page's field for a code and puts the focus in it: one marked `one-time-code`, else one named for a code
/// (otp, 2fa, verification, passcode, pin, token), else a numeric one, else the field that has the focus. Through
/// same-site frames. Answers which it found, never what it holds.
pub const CODE_FIELD_JS: &str = r#"(() => {
  const docs = [document];
  for (const f of document.querySelectorAll("iframe,frame")) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (_) {} }
  const seen = (e) => { const r = e.getBoundingClientRect(); const st = e.ownerDocument.defaultView.getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const skip = /^(hidden|checkbox|radio|submit|button|file|image|reset|range|color|email|search|url|date|time|password)$/i;
  const fields = docs.flatMap((d) => [...d.querySelectorAll("input")]).filter((e) => !e.disabled && !e.readOnly && !skip.test(e.type || "") && seen(e));
  const words = (e) => [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), e.className].join(" ").toLowerCase();
  const score = (e) => {
    if (String(e.autocomplete || "").toLowerCase() === "one-time-code") return 3;
    if (/otp|totp|2fa|mfa|one.?time|verif|passcode|security.?code|sms.?code|\bcode\b|\bpin\b|token/.test(words(e))) return 2;
    if (String(e.inputMode || "").toLowerCase() === "numeric" || e.type === "tel" || e.type === "number") return 1;
    return 0;
  };
  let best = null, top = 0;
  for (const e of fields) { const n = score(e); if (n > top) { top = n; best = e; } }
  if (!best) { const a = document.activeElement; if (a && fields.includes(a)) best = a; }
  if (!best) return { found: false, fields: fields.length };
  best.focus();
  if (best.select) best.select();
  return { found: true, field: String(best.name || best.id || best.placeholder || best.type || "field").slice(0, 40), boxes: fields.filter((e) => e.maxLength === 1).length };
})()"#;

/// Whether a code from another device may be typed: printable, one line, up to [`CODE_MOST`] characters.
pub fn code_ok(code: &str) -> bool {
    let code = code.trim();
    !code.is_empty() && code.chars().count() <= CODE_MOST && !code.chars().any(char::is_control)
}

/// Answers the ask `id` waiting at `site` with a code the owner sent from another device: typed into the page's code
/// field as the owner's own typing (`input`), said as [typed by the owner] in anything the browser returns to an agent
/// and kept out of the walk record before anything can send it, Enter pressed when `submit`, and the page given back
/// with done, which tells the asking agent the owner did it, and nothing of what they typed. Refused, with nothing
/// typed, when the ask no longer waits, is a card payment, or the page has no field for a code.
pub async fn answer_code(site: &str, id: &str, code: &str, submit: bool, via: &str, events: &Events) -> Result<Value, String> {
    if !code_ok(code) {
        return Err(format!("a code is 1 to {CODE_MOST} printable characters on one line: nothing was typed"));
    }
    let code = code.trim();
    let ask = asks().into_iter().find(|a| a.site == site && a.id == id).ok_or_else(|| {
        format!("the ask {} on {site} isn't waiting any more (it was answered or it lapsed): nothing was typed", crate::owner_dialog::plain(id).chars().take(60).collect::<String>())
    })?;
    if ask.pay.is_some() {
        return Err("that ask is a card payment: answer it with hands_give_back, which the payment approver decides on. Nothing was typed".into());
    }
    let w = match current(site) {
        Some(w) => w,
        None => {
            watch(site, events).await?;
            current(site).ok_or("the page went away: nothing was typed")?
        }
    };
    let asked = w.client.send_command("Runtime.evaluate", Some(json!({ "expression": CODE_FIELD_JS, "returnByValue": true })), Some(&w.session));
    let found = match tokio::time::timeout(Duration::from_secs(5), asked).await {
        Ok(Ok(v)) => v.pointer("/result/value").cloned().unwrap_or(Value::Null),
        _ => return Err(format!("{site}'s page didn't answer: nothing was typed")),
    };
    if found["found"] != true {
        return Err(format!("{site}'s page has no field for a code that the node could find: nothing was typed. The owner can type it in the node's window"));
    }
    let field = found["field"].as_str().unwrap_or("field").to_string();
    // A code split into one-character boxes takes one character at a time: the page moves the focus on after each,
    // and a box that holds one character would keep only the first of the whole code.
    if found["boxes"].as_u64().unwrap_or(0) > 1 {
        for c in code.chars() {
            input(site, &json!({ "kind": "text", "text": c.to_string() }), events).await?;
        }
    } else {
        input(site, &json!({ "kind": "text", "text": code }), events).await?;
    }
    // A code field the page doesn't mark as one (no one-time-code) reads as plain to the window's own check: the code
    // leaves the walk record here, before Enter can send it.
    let page = w.url.locked().clone();
    let document = document_of(&w).await;
    put_away(site, vec![code.to_string()], &page, document.as_deref()).await;
    if submit {
        input(site, &json!({ "kind": "key", "key": "Enter" }), events).await?;
    }
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: site.to_string(),
        what: format!("Typed a code from {via} into the page {} asked about", ask.agent),
        kind: "hands".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    let mut given = give_back(site, Answer::Done, events).await?;
    given["field"] = json!(field);
    Ok(given)
}

/// The browsers the owner can take over (the sites agents have open), the asks waiting, and the site watched.
pub async fn list() -> Value {
    let watching = WATCH.locked().as_ref().map(|w| (w.site.clone(), w.url.locked().clone()));
    let asks = asks();
    let mut sites = crate::browse::open_sites();
    for a in &asks {
        // A route call's payment has no page: the window shows the ask alone.
        let pageless = a.pay.as_ref().is_some_and(|p| p.route.is_some());
        if !sites.contains(&a.site) && !pageless {
            sites.push(a.site.clone());
        }
    }
    let w2 = watching.clone();
    let browsers = tokio::task::spawn_blocking(move || {
        sites
            .into_iter()
            .map(|site| {
                let url = match &w2 {
                    Some((s, u)) if *s == site && !u.is_empty() => u.clone(),
                    _ => crate::browse::page_url(&site, crate::browse::shown_tab(&site).as_deref()).unwrap_or_default(),
                };
                json!({ "site": site, "url": url, "held": held(&site), "walk": walk_of(&site) })
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    json!({ "browsers": browsers, "asks": asks, "watching": watching.map(|(s, _)| s) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Audit 1118 H6 (16 Nov H12). A card's number, expiry and security code fields are secret fields, as a password is:
    /// what the owner types there is held and masked. Runs the shipped `FOCUS_JS` in node against a stub focus, then
    /// reads the answer as the hands do. Ported in spirit from c7b1a22b.
    #[test]
    fn a_card_field_the_owner_types_into_is_secret_whatever_the_page_calls_it() {
        let focus = |kind: &str, ac: &str, name: &str, value: &str| -> Field {
            let stub = format!(
                "const el = {{ value: {value:?}, type: {kind:?}, name: {name:?}, id: {name:?}, placeholder: '', tagName: 'INPUT', \
                 getAttribute: (a) => ({{ autocomplete: {ac:?}, name: {name:?}, id: {name:?} }})[a] || null }}; \
                 const document = {{ activeElement: el }}; \
                 console.log(JSON.stringify({{ result: {{ value: {FOCUS_JS} }} }}));"
            );
            let out = std::process::Command::new("node").arg("-e").arg(&stub).output().expect("this test runs FOCUS_JS in node");
            assert!(out.status.success(), "node: {}", String::from_utf8_lossy(&out.stderr));
            field_of(&serde_json::from_slice(&out.stdout).expect("FOCUS_JS answers JSON"))
        };
        assert_eq!(focus("password", "", "pw", "hunter2"), Field::Secret("hunter2".into()), "the control: a password is secret");
        for (kind, ac, name, value) in [
            ("text", "cc-number", "", "4111 1111 1111 1111"),
            ("tel", "cc-number", "cardnumber", "4111111111111111"),
            ("text", "cc-exp", "", "12 / 29"),
            ("text", "cc-exp-month", "", "12"),
            ("text", "cc-exp-year", "", "2029"),
            ("text", "cc-csc", "", "123"),
            ("text", "", "cvc", "123"),
        ] {
            assert_eq!(focus(kind, ac, name, value), Field::Secret(value.into()), "a {ac} {name} field the owner types is a secret");
        }
        assert_eq!(focus("text", "cc-name", "", "A Person"), Field::Plain, "a card's holder name stays plain");
        assert_eq!(focus("email", "email", "email", "me@example.com"), Field::Plain);
    }

    /// Audit 1118 H6. What a card field calls itself when it sets no autocomplete is read too, and a card's holder
    /// name, an email or a search box stays plain.
    #[test]
    fn a_card_field_named_only_in_words_is_a_secret_field() {
        for words in ["cardnumber", "card-number Card number", "ccnum", "cvc", "CVV", "Security code", "exp-date", "Expiration date", "MM / YY", "exp", "cvv2", "cc_cvv2", "CVC2", "ccv", "card-cvv"] {
            assert!(is_secret_field("text", "", words), "{words}");
        }
        for (kind, ac, words) in [("email", "email", "Email"), ("text", "cc-name", "Name on card"), ("search", "", "q Search"), ("text", "", "experience"), ("text", "organization", "company")] {
            assert!(!is_secret_field(kind, ac, words), "{kind} {ac} {words}");
        }
    }

    /// Audit 1118 H6. A card number the owner types leaves the walk record whatever the field the focus ended in: a
    /// checkout that moves the focus itself from the number to the expiry, the code and a name field ends the typing
    /// on a plain field. A number that fails the Luhn check, an email or a phone number typed into a plain field
    /// stays plain.
    #[test]
    fn a_card_number_typed_before_a_plain_field_is_still_the_owners_secret() {
        let run = "4242 4242 4242 42421226123Ada Lovelace";
        let out = secrets_of(&Field::Plain, run);
        assert!(out.contains(&run.to_string()), "{out:?}");
        assert!(out.contains(&"4242 4242 4242 4242".to_string()), "the number on its own: {out:?}");
        assert_eq!(secrets_of(&Field::None, "4111-1111-1111-1111"), vec!["4111-1111-1111-1111".to_string()]);
        assert_eq!(secrets_of(&Field::Plain, "378282246310005"), vec!["378282246310005".to_string()], "a 15-digit Amex");
        let typed = secrets_of(&Field::Secret("123".into()), "42424242424242421226123");
        assert!(typed.contains(&"4242424242424242".to_string()), "{typed:?}");
        for plain in ["me@example.com", "4242 4242 4242 4241", "+65 6123 4567", "order 12345678"] {
            assert!(secrets_of(&Field::Plain, plain).is_empty(), "{plain}");
        }
    }

    /// UNB-147: a device away from the machine counts as there for 30 s after it last said so, and a code it sends is
    /// one printable line of up to 64 characters.
    #[test]
    fn an_away_device_counts_while_fresh_and_a_code_is_one_short_line() {
        let now = Instant::now();
        assert!(away_fresh(now, now + Duration::from_secs(29)));
        assert!(!away_fresh(now, now + AWAY_FRESH));
        assert!(code_ok("482913") && code_ok(" ABCD-1234 ") && code_ok(&"9".repeat(CODE_MOST)));
        assert!(!code_ok("") && !code_ok("   ") && !code_ok("48\n29") && !code_ok(&"9".repeat(CODE_MOST + 1)));
    }

    /// A window that went away without giving the page back ends its hold: one click no longer refuses every agent on
    /// the site until the node restarts. A window that still shows the page keeps it.
    #[test]
    fn a_page_goes_back_once_the_owners_window_goes_quiet() {
        let _home = store::scratch_home("held-quiet");
        let long_ago = Instant::now().checked_sub(HELD_QUIET + Duration::from_secs(1)).expect("the clock has run this long");
        HELD.locked().push(("quiet.example".to_string(), long_ago));
        HELD.locked().push(("still.example".to_string(), long_ago));
        touch_held("still.example");
        assert!(busy("still.example").is_some(), "the owner's window is there");
        assert!(busy("quiet.example").is_none());
        assert!(!held("quiet.example"));
        HELD.locked().retain(|(s, _)| s != "still.example");
    }

    /// The picture stopping before the give-back (the window's screen closed) used to skip the secrets' clean-up, and a
    /// later submit put what was typed into the walk record. With no line to read the field, what was typed is taken for
    /// a secret at the give-back.
    #[test]
    fn typing_left_unread_when_the_picture_stopped_is_put_away_at_the_give_back() {
        let home = store::scratch_home("typed-unread");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        RUN.locked().push("unread.example", "https://unread.example/code", "typed-Secret-77");
        rt.block_on(give_back("unread.example", Answer::Done, &Events::default())).unwrap();
        assert!(crate::browse::secrets_of("unread.example").iter().any(|(secret, name)| secret == "typed-Secret-77" && name == BY_OWNER));
        assert!(RUN.locked().text.is_empty());
    }

    fn asked(site: &str, card: Option<&str>) -> Ask {
        let pay = card.map(|c| Pay { card: c.into(), merchant: site.into(), route: None, inputs: Vec::new(), over: None, amount: None });
        Ask { id: "a".into(), site: site.into(), why: "".into(), agent: "a".into(), asked_at: 0, expires_at: 0, pay, login: None, tab: None }
    }

    /// The owner's plain give-back of a page with a payment still waiting on it approved nothing, and the log says what
    /// happened: a done that leaves a payment waiting isn't "Approved the payment". A decline ends it, and one approved does.
    #[test]
    fn a_plain_give_back_never_reads_as_approving_a_payment() {
        let asks = [asked("pay.example", None), asked("pay.example", Some("visa"))];
        let ends = |how, approved: Option<&Pay>| ends_a_payment(asks.iter(), "pay.example", how, approved);
        assert!(!ends(Answer::Done, None));
        assert!(ends(Answer::Declined, None));
        assert!(ends(Answer::Done, asks[1].pay.as_ref()));
        assert!(!ends_a_payment(asks.iter(), "other.example", Answer::Declined, None));
    }

    /// Two agents' asks for one page, both past the check before either waits: the second hears the page is taken.
    #[tokio::test]
    async fn only_one_ask_for_a_page_waits_on_the_owner() {
        let _home = store::scratch_home("one-ask");
        let first = tokio::spawn(async { ask_alone("one.example", None, "first", "a", Duration::from_secs(30), |_| {}).await });
        while !asks().iter().any(|a| a.site == "one.example") {
            tokio::task::yield_now().await;
        }
        assert_eq!(ask_alone("one.example", None, "second", "b", Duration::from_secs(30), |_| {}).await, None);
        assert_eq!(answer("one.example", Answer::Declined), 1, "the one ask");
        assert_eq!(first.await.unwrap(), Some(Answer::Declined));
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_point_on_the_picture_is_the_same_point_on_the_page() {
        // A 1280 × 720 viewport shown at any size: the fractions say where.
        assert_eq!(to_page(0.5, 0.5, 1280.0, 720.0).unwrap(), (640.0, 360.0));
        assert_eq!(to_page(0.0, 0.0, 1280.0, 720.0).unwrap(), (0.0, 0.0));
        assert_eq!(to_page(0.25, 0.75, 1280.0, 720.0).unwrap(), (320.0, 540.0));
        // The far edge is the last pixel, never one past it.
        assert_eq!(to_page(1.0, 1.0, 1280.0, 720.0).unwrap(), (1279.0, 719.0));
        // Off the picture, or before the page's size is known, nothing is clicked.
        assert!(to_page(1.01, 0.5, 1280.0, 720.0).is_err());
        assert!(to_page(-0.1, 0.5, 1280.0, 720.0).is_err());
        assert!(to_page(f64::NAN, 0.5, 1280.0, 720.0).is_err());
        assert!(to_page(0.5, 0.5, 0.0, 0.0).is_err());
    }

    #[test]
    fn keys_that_move_about_a_form_go_by_name() {
        let enter = key_of("Enter").unwrap();
        assert_eq!((enter.vk, enter.text), (13, Some("\r")));
        assert_eq!(key_of("Tab").unwrap().vk, 9);
        assert_eq!(key_of("Backspace").unwrap().vk, 8);
        assert!(key_of("a").is_none(), "letters go as text");
        assert!(key_of("Meta").is_none());
        assert!(ends_typing("Enter") && ends_typing("Tab") && !ends_typing("Backspace"));
    }

    #[test]
    fn an_ask_says_what_it_needs_and_waits_within_bounds() {
        let (why, wait) = parse_ask(&args(&["ask_owner", "sign", "in", "to", "the", "site"])).unwrap();
        assert_eq!((why.as_str(), wait.as_secs()), ("sign in to the site", ASK_WAIT));
        let (_, wait) = parse_ask(&args(&["ask_owner", "pass the check", "--timeout", "600"])).unwrap();
        assert_eq!(wait.as_secs(), 600);
        assert_eq!(parse_ask(&args(&["ask_owner", "x", "--timeout", "1"])).unwrap().1.as_secs(), ASK_LEAST);
        assert_eq!(parse_ask(&args(&["ask_owner", "x", "--timeout", "99999"])).unwrap().1.as_secs(), ASK_MOST);
        assert!(parse_ask(&args(&["ask_owner"])).is_err());
        assert!(parse_ask(&args(&["ask_owner", "x", "--timeout"])).is_err());
        assert!(parse_ask(&args(&["ask_owner", "x", "--timeout", "soon"])).is_err());
    }

    #[tokio::test]
    async fn an_ask_waits_for_the_owner_and_holds_the_page_meanwhile() {
        let told = Arc::new(Mutex::new(None));
        let t = told.clone();
        let waiting = tokio::spawn(async move { ask("wait.example", None, "sign in", "agent", Duration::from_secs(30), None, move |a| *t.locked() = Some(a.clone())).await });
        while told.locked().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let a = told.locked().clone().unwrap();
        assert_eq!((a.site.as_str(), a.why.as_str()), ("wait.example", "sign in"));
        assert_eq!(a.expires_at - a.asked_at, 30);
        assert!(asks().iter().any(|x| x.id == a.id), "the window lists it");
        assert!(busy("wait.example").is_some(), "another agent's command waits");
        assert!(busy("other.example").is_none());
        assert_eq!(answer("wait.example", Answer::Done), 1);
        assert_eq!(waiting.await.unwrap(), Answer::Done);
        assert!(!asks().iter().any(|x| x.id == a.id), "answered, it's gone");
        assert!(busy("wait.example").is_none());
        assert_eq!(answer("wait.example", Answer::Done), 0, "nothing left to answer");
    }

    /// A login asked of the owner (`vault:ask:`) is answered by the vault taking it, not by the page coming back: adding
    /// that login answers it, and adding another one, or another account's, doesn't.
    #[tokio::test]
    async fn a_login_ask_is_answered_when_the_vault_takes_that_login() {
        let told = Arc::new(Mutex::new(None));
        let t = told.clone();
        let login = Login { site: "signin.example".into(), account: "me".into() };
        let waiting = tokio::spawn(async move { ask_login("signin.example", None, "add the login", "agent", Duration::from_secs(30), login, move |a| *t.locked() = Some(a.clone())).await });
        while told.locked().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let a = told.locked().clone().unwrap();
        assert_eq!(a.login, Some(Login { site: "signin.example".into(), account: "me".into() }));
        let shown = serde_json::to_value(&a).unwrap();
        assert_eq!(shown["login"], json!({ "site": "signin.example", "account": "me" }), "the window is told which login to ask for");
        assert_eq!(login_added("signin.example", "someone-else"), 0);
        assert_eq!(login_added("other.example", "me"), 0);
        assert!(asks().iter().any(|x| x.id == a.id), "still waiting");
        assert_eq!(login_added("signin.example", "me"), 1);
        assert_eq!(waiting.await.unwrap(), Some(Answer::Done));
        assert!(!asks().iter().any(|x| x.id == a.id));
        // A plain ask says nothing of a login.
        let plain = Ask { id: "p".into(), site: "s.example".into(), why: "sign in".into(), agent: "x".into(), asked_at: 0, expires_at: 1, pay: None, login: None, tab: None };
        assert!(serde_json::to_value(&plain).unwrap().get("login").is_none());
    }

    #[tokio::test]
    async fn an_ask_nobody_answers_ends_with_no_answer() {
        let started = Instant::now();
        let answer = ask("late.example", None, "pass the check", "agent", Duration::from_millis(150), None, |_| {}).await;
        assert_eq!(answer, Answer::NoAnswer);
        assert!(started.elapsed() >= Duration::from_millis(150), "it waited the whole time");
        assert!(!asks().iter().any(|a| a.site == "late.example"), "a lapsed ask leaves the list");
        assert!(busy("late.example").is_none(), "and the page is the agents' again");
    }

    /// An agent is told before it asks whether an ask can reach the owner: a window watching takes it whatever the
    /// setting, none watching is opened at the ask, and with windows kept off the ask would only be refused.
    #[test]
    fn an_agent_is_told_before_it_asks_whether_the_owner_can_be_asked() {
        assert_eq!(owner_reach(1, false), "watching");
        assert_eq!(owner_reach(2, true), "watching");
        assert_eq!(owner_reach(0, false), "can_open");
        assert_eq!(owner_reach(0, true), "off");
    }

    /// An ask reaches the owner or says at once that it can't: a window already watching takes it; with none, the
    /// window is opened and the ask goes on once it connects; one that can't be opened, or never connects, refuses the
    /// ask saying why, instead of a wait nobody can answer.
    #[tokio::test]
    async fn an_ask_reaches_the_owner_or_says_it_cant() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let opened = AtomicUsize::new(0);
        let open = || {
            opened.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        assert_eq!(reach_owner(|| 1, open, Duration::from_secs(5)).await, Ok(()));
        assert_eq!(opened.load(Ordering::SeqCst), 0, "a window watching: nothing is opened");

        let started = Instant::now();
        let refused = reach_owner(|| 0, || Err("no unbrowse-window here".into()), Duration::from_secs(5)).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1), "a window that can't open refuses at once, not after the wait");
        assert!(refused.contains("no Unbrowse window is open") && refused.contains("no unbrowse-window here"), "{refused}");
        assert!(refused.contains("Nothing was asked"), "{refused}");

        let watching = Arc::new(AtomicUsize::new(0));
        let w = watching.clone();
        let comes_up = || {
            let w = w.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                w.store(1, Ordering::SeqCst);
            });
            Ok(())
        };
        let seen = watching.clone();
        assert_eq!(reach_owner(move || seen.load(Ordering::SeqCst), comes_up, Duration::from_secs(5)).await, Ok(()), "the window opened and connected");

        let refused = reach_owner(|| 0, || Ok(()), Duration::from_millis(300)).await.unwrap_err();
        assert!(refused.contains("didn't connect"), "{refused}");
        assert!(open_window().is_err(), "a test opens no window");
    }

    #[tokio::test]
    async fn the_owner_can_decline() {
        let waiting = tokio::spawn(ask("no.example", None, "sign in", "agent", Duration::from_secs(30), None, |_| {}));
        while !asks().iter().any(|a| a.site == "no.example") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        answer("no.example", Answer::Declined);
        assert_eq!(waiting.await.unwrap(), Answer::Declined);
    }

    /// An agent that stops waiting (its request went away) takes its ask with it: the page is the agents' again. Its
    /// site is its own: the list of asks is the process's, and `browse.rs` tests another ask that goes away at once.
    #[tokio::test]
    async fn an_ask_nobody_waits_for_leaves_the_list() {
        let waiting = tokio::spawn(ask("left-behind.example", None, "sign in", "agent", Duration::from_secs(30), None, |_| {}));
        while !asks().iter().any(|a| a.site == "left-behind.example") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        waiting.abort();
        let _ = waiting.await;
        assert!(!asks().iter().any(|a| a.site == "left-behind.example"));
        assert!(busy("left-behind.example").is_none());
    }

    /// B07: an agent can cancel its ask_owner while its request is still open (MCP `notifications/cancelled` sets the
    /// call's stop flag): the wait ends at once with no answer, and the page is the agents' again. Before, the flag was
    /// never read, and the site stayed held until the owner answered or the ask's time ran out.
    #[tokio::test]
    async fn an_ask_its_agent_cancels_ends_and_frees_the_page() {
        let call = crate::api::asks::Ask::begin("unbrowse_browse");
        let stop = call.stop.clone();
        let waiting = tokio::spawn(crate::api::asks::within(call, ask_alone("cancelled.example", None, "sign in", "agent", Duration::from_secs(30), |_| {})));
        while !asks().iter().any(|a| a.site == "cancelled.example") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let ended = tokio::time::timeout(Duration::from_secs(5), waiting).await;
        assert_eq!(ended.ok().map(Result::unwrap), Some(Some(Answer::NoAnswer)), "the ask still waited 5 s after its agent cancelled it");
        assert!(busy("cancelled.example").is_none(), "the page is the agents' again");
    }

    /// A payment ask carries what the owner approves (the card, the site, and for a route what it does and sends),
    /// and an ordinary ask carries none of it.
    #[tokio::test]
    async fn a_payment_ask_shows_the_owner_what_they_approve() {
        let pay = Pay { over: None, card: "visa (card ending 4242)".into(), merchant: "pay.example".into(), route: Some("buy tickets".into()), inputs: vec!["qty: 2".into()], amount: None };
        let waiting = tokio::spawn(ask("pay.example", None, "approve paying", "agent", Duration::from_secs(30), Some(pay.clone()), |_| {}));
        while !asks().iter().any(|a| a.site == "pay.example") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let shown = serde_json::to_value(asks().into_iter().find(|a| a.site == "pay.example").unwrap()).unwrap();
        assert_eq!(shown["pay"], json!({ "card": "visa (card ending 4242)", "merchant": "pay.example", "route": "buy tickets", "inputs": ["qty: 2"] }));
        // A give-back that says done approves only the payment the owner said yes to: with none, or another, the payment
        // waits on (external security review round 4, H5).
        let q = payment_question(&payment_waiting("pay.example").unwrap());
        assert!(q.contains("pay.example") && q.contains("4242") && q.contains("qty: 2"), "{q}");
        let events = Events::default();
        give_back("pay.example", Answer::Done, &events).await.unwrap();
        let other = Pay { card: "visa (card ending 1111)".into(), ..pay.clone() };
        give_back_approving("pay.example", Answer::Done, Some(&other), &events).await.unwrap();
        assert!(payment_waiting("pay.example").is_some(), "not approved by the token alone, nor by a yes to another payment");
        give_back_approving("pay.example", Answer::Done, Some(&pay), &events).await.unwrap();
        assert_eq!(waiting.await.unwrap(), Answer::Done);
        let plain = Ask { id: "a".into(), site: "s.example".into(), why: "sign in".into(), agent: "x".into(), asked_at: 0, expires_at: 1, pay: None, login: None, tab: None };
        assert!(serde_json::to_value(plain).unwrap().get("pay").is_none());
    }

    #[test]
    fn the_owners_typing_is_kept_until_it_ends_and_backspace_takes_from_it() {
        let mut r = Run::default();
        r.push("a.example", "https://a.example/login", "hunter");
        r.push("a.example", "https://a.example/login", "23");
        r.backspace();
        assert_eq!(r.text, "hunter2");
        // Typing on another site starts afresh.
        r.push("b.example", "https://b.example/", "x");
        assert_eq!((r.site.as_str(), r.text.as_str()), ("b.example", "x"));
    }

    #[test]
    fn only_a_secret_fields_value_leaves_the_record() {
        // A password field: its whole value, however it got there.
        assert_eq!(secrets_of(&Field::Secret("Zq9-long-pass".into()), "Zq9-long-pass"), vec!["Zq9-long-pass".to_string()]);
        assert_eq!(secrets_of(&Field::Secret("filled-by-manager".into()), ""), vec!["filled-by-manager".to_string()]);
        // A field nobody can read (another site's frame): what was typed is taken as the secret.
        assert_eq!(secrets_of(&Field::Unknown, "pass1234"), vec!["pass1234".to_string()]);
        // An email or a search box keeps what was typed: it is no secret.
        assert!(secrets_of(&Field::Plain, "me@example.com").is_empty());
        assert!(secrets_of(&Field::None, "stray").is_empty());
        assert!(secrets_of(&Field::Secret(String::new()), "").is_empty());
    }

    #[test]
    fn the_focus_is_read_as_the_field_it_is() {
        let v = |r: Value| json!({ "result": { "type": "object", "value": r } });
        assert_eq!(field_of(&v(json!({ "kind": "field", "type": "password", "autocomplete": "", "words": "", "value": "pw" }))), Field::Secret("pw".into()));
        assert_eq!(field_of(&v(json!({ "kind": "field", "type": "email", "autocomplete": "email", "words": "email", "value": "me@example.com" }))), Field::Plain);
        assert_eq!(field_of(&v(json!({ "kind": "none" }))), Field::None);
        assert_eq!(field_of(&json!({ "exceptionDetails": {} })), Field::Unknown, "a page that won't say is taken as holding a secret");
    }

    /// W03: the owner's live view follows the site's page across a navigation to another site (its own process under
    /// site isolation): the window hears the new address, and pictures of the new page keep coming. Before, a view that
    /// lost its page on such a move showed the last picture of the old one.
    #[test]
    #[ignore = "drives Chrome: cargo test -p unbrowse-node-app --bin unbrowse-node the_live_view_follows -- --ignored"]
    fn the_live_view_follows_the_page_to_another_site() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                // Each page paints, and keeps painting, so a live view of it has pictures to send.
                let (title, colour) = if req.starts_with("GET /second") { ("second", "#36c") } else { ("first", "#c63") };
                let body = format!(
                    r#"<!doctype html><html><head><title>{title}</title></head><body style="background:{colour}"><h1 id="n">0</h1>
<script>let n = 0; setInterval(() => document.getElementById('n').textContent = ++n, 100);</script></body></html>"#
                );
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let path = agent_browser_core::cdp::chrome::find_chrome().expect("Chrome, or Chrome for Testing from `agent-browser install`");
        let profile = std::env::temp_dir().join(format!("live-view-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let mut chrome = std::process::Command::new(path)
            .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--site-per-process", "--no-sandbox"])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("http://127.0.0.1:{port}/first"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut ws = None;
        for _ in 0..150 {
            if let Some((p, path)) = agent_browser_core::cdp::chrome::read_devtools_active_port(&profile) {
                ws = Some(format!("ws://127.0.0.1:{p}{path}"));
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let ws = ws.expect("Chrome opened its DevTools");
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let result: Result<(), String> = rt.block_on(async {
            let events = Events::default();
            let mut heard = events.subscribe_for_test();
            let site = "live-view.example";
            // The first page has loaded and painted before the view starts.
            let cdp = CdpClient::connect(&ws).await?;
            for _ in 0..100 {
                let t = cdp.send_command("Target.getTargets", Some(json!({})), None).await?;
                if t["targetInfos"].as_array().is_some_and(|ts| ts.iter().any(|t| t["type"] == "page" && t["title"] == "first")) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            watch_on(site, &ws, None, &events).await?;
            let mut before = 0;
            let until = tokio::time::Instant::now() + Duration::from_secs(10);
            while before < 3 {
                let Ok(Ok((event, _))) = tokio::time::timeout_at(until, heard.recv()).await else { break };
                before += usize::from(event == "hands_frame");
            }
            assert!(before >= 3, "the view shows the first page: {before} pictures in 10 s");
            // The page moves itself to another site: 127.0.0.1 and localhost are two sites, so two processes.
            let targets = cdp.send_command("Target.getTargets", Some(json!({})), None).await?;
            let page = targets["targetInfos"].as_array().and_then(|ts| ts.iter().find(|t| t["type"] == "page")).and_then(|t| t["targetId"].as_str()).unwrap().to_string();
            let s = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": page, "flatten": true })), None).await?;
            let session = s["sessionId"].as_str().unwrap().to_string();
            cdp.send_command("Runtime.evaluate", Some(json!({ "expression": format!("location.href = 'http://localhost:{port}/second'") })), Some(&session)).await?;
            let mut moved = None;
            let mut after = 0;
            let until = tokio::time::Instant::now() + Duration::from_secs(15);
            while after < 3 {
                let Ok(Ok((event, payload))) = tokio::time::timeout_at(until, heard.recv()).await else { break };
                match event.as_str() {
                    "hands" if payload["kind"] == "page" => moved = payload["url"].as_str().map(String::from),
                    "hands_frame" if moved.is_some() => after += 1,
                    _ => {}
                }
            }
            assert_eq!(moved.as_deref(), Some(format!("http://localhost:{port}/second").as_str()), "the window hears the page's new address");
            assert!(after >= 3, "pictures of the new page keep coming: {after} in 15 s after the move");
            assert_eq!(current(site).map(|w| w.url.locked().clone()), moved, "and the view says where the page is");
            stop();
            Ok(())
        });
        let _ = chrome.kill();
        let _ = chrome.wait();
        let _ = std::fs::remove_dir_all(&profile);
        result.unwrap();
    }

    #[test]
    fn the_page_shown_is_the_one_being_browsed() {
        let targets = json!({ "targetInfos": [
            { "targetId": "sw", "type": "service_worker", "url": "https://a.example/sw.js", "attached": true },
            { "targetId": "t1", "type": "page", "url": "https://a.example/other", "attached": false },
            { "targetId": "t2", "type": "page", "url": "https://a.example/login", "attached": true },
        ]});
        assert_eq!(pick_page(&targets, None).as_deref(), Some("t2"));
        // The tab of the session that asked for the owner is the one shown, whichever the node attached to.
        assert_eq!(pick_page(&targets, Some("t1")).as_deref(), Some("t1"));
        assert_eq!(pick_page(&targets, Some("sw")).as_deref(), Some("t2"), "only a page is shown");
        assert_eq!(pick_page(&targets, Some("gone")).as_deref(), Some("t2"));
        let none_attached = json!({ "targetInfos": [{ "targetId": "t1", "type": "page", "url": "https://a.example/", "attached": false }] });
        assert_eq!(pick_page(&none_attached, None).as_deref(), Some("t1"));
        assert_eq!(pick_page(&json!({ "targetInfos": [] }), None), None);
    }

    #[test]
    fn only_the_hands_pictures_are_served_as_hands() {
        assert_eq!(walk_of("a.example"), "hands:a.example");
        assert!(frame("w-123").is_none(), "a walk's id isn't one of these");
    }

    /// A panic while the owner's held pages were locked used to poison the lock, so every later question about any
    /// site's page panicked too, until the node restarted.
    #[test]
    fn a_panic_holding_the_pages_never_takes_the_node_down() {
        let _ = std::thread::spawn(|| {
            let _held = HELD.lock();
            panic!("a request panics while it holds the pages");
        })
        .join();
        assert!(!held("never-held.example"));
        assert!(busy("never-held.example").is_none());
    }

    /// A DevTools endpoint that answers as a browser with one page open does, and keeps every command it was sent.
    struct FakeBrowser {
        ws: String,
        seen: Arc<Mutex<Vec<(String, Value)>>>,
        code_field: Arc<std::sync::atomic::AtomicBool>,
    }

    impl FakeBrowser {
        /// The params of every command named `method` it was sent, in order.
        fn got(&self, method: &str) -> Vec<Value> {
            self.seen.locked().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
        }
    }

    /// The page it shows is `https://fakecdp.example/login`, 1000 x 500; once a screencast starts it sends pictures
    /// of a 1200 x 600 page and, now and then, a move to `/code`. What the focus holds, as the page reads it, is `focus`.
    async fn fake_browser(focus: Value) -> FakeBrowser {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws = format!("ws://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let code_field = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (log, field) = (seen.clone(), code_field.clone());
        tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else { return };
            let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
            let (mut write, mut read) = socket.split();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            tokio::spawn(async move {
                while let Some(m) = rx.recv().await {
                    if write.send(Message::Text(m)).await.is_err() {
                        break;
                    }
                }
            });
            while let Some(Ok(Message::Text(text))) = read.next().await {
                let Ok(cmd) = serde_json::from_str::<Value>(&text) else { continue };
                let method = cmd["method"].as_str().unwrap_or_default().to_string();
                let params = cmd["params"].clone();
                log.locked().push((method.clone(), params.clone()));
                let result = match method.as_str() {
                    "Target.getTargets" => json!({ "targetInfos": [{ "targetId": "T1", "type": "page", "url": "https://fakecdp.example/login", "attached": true }] }),
                    "Target.attachToTarget" => json!({ "sessionId": "S1" }),
                    "Page.getLayoutMetrics" => json!({ "cssVisualViewport": { "clientWidth": 1000.0, "clientHeight": 500.0 } }),
                    "Runtime.evaluate" if params["expression"] == CODE_FIELD_JS => {
                        let found = field.load(std::sync::atomic::Ordering::SeqCst);
                        json!({ "result": { "type": "object", "value": { "found": found, "field": "otp", "boxes": 0 } } })
                    }
                    "Runtime.evaluate" => json!({ "result": { "type": "object", "value": focus.clone() } }),
                    "Page.getFrameTree" => json!({ "frameTree": { "frame": { "id": "F1", "loaderId": "LOADER1" } } }),
                    _ => json!({}),
                };
                let _ = tx.send(json!({ "id": cmd["id"], "result": result }).to_string());
                if method == "Page.startScreencast" {
                    let pictures = tx.clone();
                    tokio::spawn(async move {
                        for n in 0u64.. {
                            tokio::time::sleep(Duration::from_millis(40)).await;
                            let frame = json!({ "method": "Page.screencastFrame", "sessionId": "S1",
                                "params": { "data": "anBlZw==", "sessionId": n + 1, "metadata": { "deviceWidth": 1200, "deviceHeight": 600 } } });
                            let moved = json!({ "method": "Page.frameNavigated", "sessionId": "S1", "params": { "frame": { "url": "https://fakecdp.example/code" } } });
                            let sent = pictures.send(frame.to_string()).is_ok() && (n % 5 != 4 || pictures.send(moved.to_string()).is_ok());
                            if !sent {
                                break;
                            }
                        }
                    });
                }
            }
        });
        FakeBrowser { ws, seen, code_field }
    }

    /// The owner takes a page of the node's browser from their window: they see its pictures and its moves, scroll
    /// (which only looks), click (which takes the page), type and press keys. What they type into a secret field is
    /// kept out of the walk record and said as theirs; a second device's code is typed the same way, only into a page
    /// that has a field for it and an ask that still waits; and once stopped the pictures end and the browser is let go.
    #[test]
    fn the_owner_drives_the_page_and_what_they_type_is_kept_out_of_the_record() {
        let _one = WATCH_FOR_TEST.locked();
        let home = store::scratch_home("hands-fake-cdp");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        let site = "fakecdp.example";
        rt.block_on(async {
            let browser = fake_browser(json!({ "kind": "field", "type": "password", "autocomplete": "current-password", "words": "password", "value": "hunter2" })).await;
            let events = Events::default();
            let mut heard = events.subscribe_for_test();
            let shown = watch_on(site, &browser.ws, None, &events).await.unwrap();
            assert_eq!((shown["url"].as_str(), shown["width"].as_f64(), shown["height"].as_f64(), shown["held"].as_bool()), (Some("https://fakecdp.example/login"), Some(1000.0), Some(500.0), Some(false)), "{shown}");
            // Its pictures reach the window, and so does the page's move to another address.
            let (mut frames, mut moved) = (0, None);
            let until = tokio::time::Instant::now() + Duration::from_secs(10);
            while frames == 0 || moved.is_none() {
                match tokio::time::timeout_at(until, heard.recv()).await {
                    Ok(Ok((event, payload))) => match event.as_str() {
                        "hands_frame" => frames += 1,
                        "hands" if payload["kind"] == "page" => moved = payload["url"].as_str().map(String::from),
                        _ => {}
                    },
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                    _ => break,
                }
            }
            assert!(frames > 0, "pictures of the page reach the window");
            assert_eq!(moved.as_deref(), Some("https://fakecdp.example/code"), "and the page's move");
            // `watch` asks the node's own browser for the site, which a test has none of: the picture already shown is kept.
            let now = watch(site, &events).await.unwrap();
            assert_eq!((now["url"].as_str(), now["width"].as_f64(), now["height"].as_f64()), (Some("https://fakecdp.example/code"), Some(1200.0), Some(600.0)), "{now}");
            assert!(frame(&walk_of(site)).is_some_and(|f| f == b"jpeg"), "the window fetches the latest picture");

            // Scrolling only looks; a click takes the page, as many times as it says, up to a triple.
            input(site, &json!({ "kind": "scroll", "x": 0.5, "y": 0.5, "dy": 99999 }), &events).await.unwrap();
            assert_eq!(browser.got("Input.dispatchMouseEvent")[0]["deltaY"], 5000.0, "a scroll is held to what a page can take");
            assert!(!held(site), "scrolling takes nothing");
            input(site, &json!({ "kind": "click", "x": 0.25, "y": 0.5, "clicks": 2 }), &events).await.unwrap();
            assert!(held(site), "a click takes the page");
            let mouse = browser.got("Input.dispatchMouseEvent");
            let pressed: Vec<(f64, f64, u64)> = mouse.iter().filter(|m| m["type"] == "mousePressed").map(|m| (m["x"].as_f64().unwrap(), m["y"].as_f64().unwrap(), m["clickCount"].as_u64().unwrap())).collect();
            assert_eq!(pressed, [(300.0, 300.0, 1), (300.0, 300.0, 2)], "a double click is two presses at the point on the page the picture shows");
            // Refused: a point off the picture, text a keyboard can't make, a key the window doesn't pass, anything else.
            for bad in [json!({ "kind": "click", "x": 1.5, "y": 0.5 }), json!({ "kind": "text", "text": "a\nb" }), json!({ "kind": "text", "text": "" }), json!({ "kind": "key", "key": "F13" }), json!({ "kind": "drag" })] {
                assert!(input(site, &bad, &events).await.is_err(), "{bad}");
            }
            assert!(browser.got("Input.insertText").is_empty(), "nothing refused was typed");

            // What they type goes to the page; ending the typing reads the field, and a secret leaves the record.
            input(site, &json!({ "kind": "text", "text": "hunter2" }), &events).await.unwrap();
            assert_eq!(browser.got("Input.insertText"), [json!({ "text": "hunter2" })]);
            input(site, &json!({ "kind": "key", "key": "Backspace" }), &events).await.unwrap();
            input(site, &json!({ "kind": "key", "key": "Enter" }), &events).await.unwrap();
            let keys: Vec<String> = browser.got("Input.dispatchKeyEvent").iter().map(|k| format!("{}:{}", k["type"].as_str().unwrap(), k["key"].as_str().unwrap())).collect();
            assert_eq!(keys.len(), 4, "{keys:?}");
            assert!(keys[2].ends_with(":Enter") && keys[3] == "keyUp:Enter", "{keys:?}");
            assert!(crate::browse::secrets_of(site).iter().any(|(secret, name)| secret == "hunter2" && name == BY_OWNER), "what they typed is said as theirs");

            // A code from the owner's other device: refused before anything is typed unless an ask for the page waits
            // and the page has a field for it.
            let waiting = tokio::spawn(async move { ask_alone(site, None, "type the two-step code", "claude-code", Duration::from_secs(30), |_| {}).await });
            while !asks().iter().any(|a| a.site == site) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(owner_busy());
            let id = asks().into_iter().find(|a| a.site == site).unwrap().id;
            let listed = list().await;
            assert_eq!(listed["watching"], site, "{listed}");
            assert!(listed["asks"].as_array().unwrap().iter().any(|a| a["id"] == id.as_str()), "{listed}");
            let refused = |why: Result<Value, String>| why.unwrap_err();
            assert!(refused(answer_code(site, &id, "   ", false, "telegram", &events).await).contains("1 to 64"));
            assert!(refused(answer_code(site, "ask-gone", "482913", false, "telegram", &events).await).contains("isn't waiting"));
            browser.code_field.store(false, std::sync::atomic::Ordering::SeqCst);
            assert!(refused(answer_code(site, &id, "482913", false, "telegram", &events).await).contains("no field for a code"));
            assert!(browser.got("Input.insertText").iter().all(|t| t["text"] != "482913"), "nothing was typed into a page with no field for it");
            browser.code_field.store(true, std::sync::atomic::Ordering::SeqCst);
            let paying = tokio::spawn(async move {
                let pay = Pay { card: "visa (card ending 4242)".into(), merchant: "paycode.example".into(), route: None, inputs: Vec::new(), over: None, amount: None };
                ask("paycode.example", None, "approve paying", "agent", Duration::from_secs(30), Some(pay), |_| {}).await
            });
            while !asks().iter().any(|a| a.site == "paycode.example") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let pay_id = asks().into_iter().find(|a| a.site == "paycode.example").unwrap().id;
            assert!(refused(answer_code("paycode.example", &pay_id, "482913", false, "telegram", &events).await).contains("card payment"), "a code never approves a payment");
            assert_eq!(answer("paycode.example", Answer::Declined), 1);
            assert_eq!(paying.await.unwrap(), Answer::Declined);

            let entered = |b: &FakeBrowser| b.got("Input.dispatchKeyEvent").iter().filter(|k| k["key"] == "Enter" && k["type"] == "keyUp").count();
            let before = entered(&browser);
            let given = answer_code(site, &id, "482913", true, "telegram", &events).await.unwrap();
            assert_eq!((given["answered"].as_u64(), given["field"].as_str()), (Some(1), Some("otp")), "{given}");
            assert_eq!(waiting.await.unwrap(), Some(Answer::Done), "the agent's ask hears the owner did it");
            assert!(browser.got("Input.insertText").iter().any(|t| t["text"] == "482913"), "the code was typed");
            assert_eq!(entered(&browser), before + 1, "and sent, with Enter");
            assert!(!held(site), "the page went back to the agents");

            // Stopped, the pictures end, the browser is let go, and the window can't drive a page that isn't shown.
            stop();
            let until = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut stopped = false;
            while !stopped {
                match tokio::time::timeout_at(until, heard.recv()).await {
                    Ok(Ok((event, payload))) => stopped = event == "hands" && payload["kind"] == "stopped" && payload["why"] == "Asked",
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                    _ => break,
                }
            }
            assert!(stopped, "the picture said why it stopped");
            assert!(current(site).is_none());
            assert!(!browser.got("Page.stopScreencast").is_empty() && !browser.got("Target.detachFromTarget").is_empty(), "the browser is let go of the page");
            let err = input(site, &json!({ "kind": "click", "x": 0.5, "y": 0.5 }), &events).await.unwrap_err();
            assert!(err.contains("isn't open"), "{err}");
        });
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---- audit 1118 review (R7): words the first list missed ----
    /// Audit 1118 H6 (adversarial). Words a card's expiry, code or a visible password field go by that the first list missed.
    #[test]
    fn more_names_a_card_expiry_code_or_password_goes_by() {
        for words in ["Expires", "Expire date", "cvvCode", "cvcCode", "cvvNumber", "securityNumber", "CID", "Card Identification Number", "password", "pwd", "PIN"] {
            assert!(is_secret_field("text", "", words), "{words}");
        }
        for words in ["Email", "Search", "Company", "experience", "Phone"] {
            assert!(!is_secret_field("text", "", words), "{words}");
        }
    }
}
