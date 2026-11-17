//! The owner's hands on the node's browser. A site's browser runs with no window, so a page only a person can get
//! past (a sign-in the vault has no login for, a two-step code, a check that wants a person) waits on the owner. The
//! window shows that browser's page as a live picture, and the owner clicks and types on the picture: each click is
//! the same point on the page, each key goes to the page. An agent can ask for this (`ask_owner`) and waits until the
//! owner gives the page back; the owner can also take a page over whenever they like.
//!
//! Only the owner's window drives it: these are `/owner/*` commands, behind the owner's token. Nothing the owner types
//! is told to an agent or kept as typed. What they type into a password or one-time-code field leaves the walk record
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
    waits_on_owner(site, tab, why, agent, wait, pay, false, told).await.unwrap_or(Answer::NoAnswer)
}

/// [`ask`], unless `site`'s page is already waiting on the owner: read and joined under one lock, since reaching the
/// owner takes a while and two asks checked before it would both go on. `None` when it was.
pub async fn ask_alone(site: &str, tab: Option<&str>, why: &str, agent: &str, wait: Duration, told: impl FnOnce(&Ask)) -> Option<Answer> {
    waits_on_owner(site, tab, why, agent, wait, None, true, told).await
}

#[allow(clippy::too_many_arguments)]
async fn waits_on_owner(site: &str, tab: Option<&str>, why: &str, agent: &str, wait: Duration, pay: Option<Pay>, alone: bool, told: impl FnOnce(&Ask)) -> Option<Answer> {
    let (tx, rx) = oneshot::channel();
    let now = store::now();
    let n = ASKED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let a = Ask { id: format!("ask-{now}-{n}"), site: site.to_string(), why: why.to_string(), agent: agent.to_string(), asked_at: now, expires_at: now + wait.as_secs(), pay, tab: tab.map(String::from) };
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
    told(&a);
    Some(tokio::time::timeout(wait, rx).await.ok().and_then(Result::ok).unwrap_or(Answer::NoAnswer))
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
        return Some(format!("the owner has {site}'s page in the node's window: wait until they give it back (ask_owner answers when they do)"));
    }
    ASKS.locked()
        .iter()
        .find(|(a, _)| a.site == site)
        .map(|(a, _)| format!("{site}'s page is waiting on the owner ({}: \"{}\"): ask_owner answers when they give it back", a.agent, a.why))
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
    /// A password or one-time-code field, with what it holds.
    Secret(String),
    /// A field that holds no secret: a search box, an email address.
    Plain,
    /// Nothing that takes text has the focus.
    None,
    /// A frame from another site has it, which the page can't see into: what was typed is taken as a secret.
    Unknown,
}

/// Reads where the focus is: through open shadow roots and same-site frames to the field itself.
const FOCUS_JS: &str = r#"(() => {
  const deep = (d) => { let e = d.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return e; };
  let e = deep(document);
  try {
    while (e && /^(IFRAME|FRAME)$/.test(e.tagName)) { const d = e.contentDocument; if (!d) return { kind: "unknown" }; e = deep(d); }
  } catch (_) { return { kind: "unknown" }; }
  if (!e || !("value" in e)) return { kind: "none" };
  const type = String(e.type || "").toLowerCase();
  const ac = String((e.getAttribute && e.getAttribute("autocomplete")) || "").toLowerCase();
  const secret = type === "password" || /(current|new)-password|one-time-code/.test(ac);
  return secret ? { kind: "secret", value: String(e.value) } : { kind: "plain" };
})()"#;

fn field_of(v: &Value) -> Field {
    let r = v.pointer("/result/value").unwrap_or(&Value::Null);
    match r.get("kind").and_then(|k| k.as_str()) {
        Some("secret") => Field::Secret(r.get("value").and_then(|v| v.as_str()).unwrap_or_default().to_string()),
        Some("plain") => Field::Plain,
        Some("none") => Field::None,
        _ => Field::Unknown,
    }
}

/// What leaves the walk record when typing into `field` ends: a secret field's whole value (what the owner typed,
/// pasted or picked from autofill), or what was typed into a field nobody can read.
pub fn secrets_of(field: &Field, typed: &str) -> Vec<String> {
    let mut out = Vec::new();
    match field {
        Field::Secret(v) => {
            out.push(v.clone());
            if !typed.is_empty() && !v.contains(typed) {
                out.push(typed.to_string());
            }
        }
        Field::Unknown => out.push(typed.to_string()),
        Field::Plain | Field::None => {}
    }
    out.retain(|s| !s.trim().is_empty());
    out.dedup();
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
    let client = Arc::new(CdpClient::connect(&ws).await?);
    let targets = client.send_command("Target.getTargets", Some(json!({})), None).await?;
    let target = pick_page(&targets, front.as_deref()).ok_or("no page is open in that browser")?;
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
    put_away(&w.site, secrets_of(&field, &typed), &page).await;
}

/// `secrets` leave the walk record of `site`, and every reply says them as the owner's.
async fn put_away(site: &str, secrets: Vec<String>, page: &str) {
    for secret in secrets {
        let (s, page) = (site.to_string(), page.to_string());
        let forgot = tokio::task::spawn_blocking(move || {
            // Said as the owner's in every reply whether or not the record could be rewritten.
            crate::browse::owner_typed(&s, &secret, &page);
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
    put_away(site, secrets_of(&Field::Unknown, &run.text), &run.page).await;
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
        Ask { id: "a".into(), site: site.into(), why: "".into(), agent: "a".into(), asked_at: 0, expires_at: 0, pay, tab: None }
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

    #[tokio::test]
    async fn an_ask_nobody_answers_ends_with_no_answer() {
        let started = Instant::now();
        let answer = ask("late.example", None, "pass the check", "agent", Duration::from_millis(150), None, |_| {}).await;
        assert_eq!(answer, Answer::NoAnswer);
        assert!(started.elapsed() >= Duration::from_millis(150), "it waited the whole time");
        assert!(!asks().iter().any(|a| a.site == "late.example"), "a lapsed ask leaves the list");
        assert!(busy("late.example").is_none(), "and the page is the agents' again");
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
        let plain = Ask { id: "a".into(), site: "s.example".into(), why: "sign in".into(), agent: "x".into(), asked_at: 0, expires_at: 1, pay: None, tab: None };
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
        assert_eq!(field_of(&v(json!({ "kind": "secret", "value": "pw" }))), Field::Secret("pw".into()));
        assert_eq!(field_of(&v(json!({ "kind": "plain" }))), Field::Plain);
        assert_eq!(field_of(&v(json!({ "kind": "none" }))), Field::None);
        assert_eq!(field_of(&json!({ "exceptionDetails": {} })), Field::Unknown, "a page that won't say is taken as holding a secret");
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
}
