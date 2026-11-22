//! The node's browser, driven by hand: an agent that has to act on a page (log in, fill a form, send a message)
//! opens, reads, clicks and types through the node, never a browser of its own. Every action runs in the node's
//! browser, in the site's own profile, with capture on, so the flow is the node's to learn from
//! (`learn::learn_auto`): the call the agent's typing set off becomes a route, and the logins it used stay here.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use unbrowse_learn::identity::{at_or_under, on_site, same_site, site_of};

use crate::store::{self, Activity};
use crate::sync::Locked;

/// What an agent may ask the browser to do: the page-driving commands, never the ones that pick another browser,
/// profile or session.
/// `frame <ref|selector>` points the selectors that follow into an iframe's document (a card form a payment provider
/// hosts in its own frame), and `frame main` back at the page: what the page is (its address, its document, the holds
/// and marks the node keeps on it) stays the top page's whichever frame is selected.
const COMMANDS: &[&str] = &[
    "open", "goto", "navigate", "snapshot", "click", "dblclick", "fill", "type", "press", "select", "check", "uncheck",
    "hover", "focus", "scroll", "scrollintoview", "upload", "get", "is", "find", "wait", "back", "forward", "reload",
    "eval", "screenshot", "close", "frame",
];

/// The flags each command reads, as the browser reads them for that command. A flag means what its command makes of
/// it (`-d` is a snapshot's depth, and a download's path to a wait), and the browser takes any other flag, anywhere in
/// the command, as one that launches the browser some other way.
const FLAGS: &[(&str, &[&str])] = &[
    ("snapshot", &["-i", "--interactive", "-c", "--compact", "-d", "--depth", "-s", "--selector", "--full", "-u", "--urls"]),
    ("scroll", &["-s", "--selector"]),
    ("screenshot", &["--full", "--annotate"]),
    ("wait", &["--text", "--url", "--load", "--fn", "--timeout"]),
    ("find", &["--name", "--exact"]),
    ("eval", &["--timeout"]),
];

/// What the commands that ask the page something may ask: the page's own facts, never the browser's (its DevTools
/// address is the whole browser, every command the node holds back included).
const ASKS: &[(&str, &[&str])] = &[
    ("get", &["text", "html", "value", "attr", "url", "title", "count", "box", "styles"]),
    ("is", &["visible", "enabled", "checked"]),
    ("find", &["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"]),
];

/// Whether a command runs a script of the agent's in the page: `eval`, and a wait on a script's answer.
pub fn runs_script(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("eval") => true,
        Some("wait") => args.iter().any(|a| a == "--fn" || a == "-f"),
        _ => false,
    }
}

/// The site each browsing session last browsed, for a command that names none: (session, site), newest last.
static LAST: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
/// How many sessions' last sites are kept: a client that makes a session per run never grows it past this.
const LAST_KEPT: usize = 512;

/// A session's tab in a site's browser, as the node notes it: which tab, whose, and when it last acted.
struct Held {
    site: String,
    tab: String,
    /// The browsing session the tab is; empty for a tab the browser had open when the node first looked (it restarted
    /// since).
    session: String,
    at: std::time::Instant,
}

/// The tabs sessions hold in each site's browser, the one that acted last at the end: the owner's window shows a
/// site's last one. Kept in memory only: a node that restarts finds the browsers' tabs by name again ([`sweep`]).
static TABS: Mutex<Vec<Held>> = Mutex::new(Vec::new());

/// How long a session's tab may sit unused before the node closes it: a client that went away without closing its
/// tab (an MCP session, an SDK client) leaves no page open for good.
pub(crate) const TAB_IDLE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The most sessions' tabs one site's browser holds. A new session past it takes the place of the one that has gone
/// longest without acting.
const TABS_PER_SITE: usize = 8;

/// How often the node looks over a site's tabs for ones gone idle, at most.
pub(crate) const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// The tab a browsing session has in each site's browser. A session is one agent's own run of commands
/// (`api::browse_session`: the agent's key, and the MCP session or the session it names); it gets its own tab in the
/// site's browser the first time it acts there, and every command it gives acts on that tab. Tabs share the site's
/// profile, so a login holds across sessions; the page is each session's own. A tab's name is drawn from the session
/// and says nothing of it.
pub fn tab_of(session: &str) -> String {
    use sha3::{Digest, Keccak256};
    format!("u{}", hex::encode(&Keccak256::digest(session.as_bytes())[..8]))
}

/// Notes that `session`'s tab acted on `site`'s browser last.
fn in_front(site: &str, session: &str) {
    let tab = tab_of(session);
    let mut tabs = TABS.locked();
    tabs.retain(|h| !(h.site == site && h.tab == tab));
    tabs.push(Held { site: site.to_string(), tab, session: session.to_string(), at: std::time::Instant::now() });
}

/// Brings `session`'s tab on `site` to the front: the one the owner's window shows, as for an agent asking them.
pub fn to_front(site: &str, session: &str) {
    in_front(site, session);
}

/// The tab of `site`'s browser the owner sees: the one whose session acted there last.
pub fn front_tab(site: &str) -> Option<String> {
    TABS.locked().iter().rev().find(|h| h.site == site).map(|h| h.tab.clone())
}

/// Which of a site's sessions' tabs close before the tab `tab` acts: each that has gone [`TAB_IDLE`] without acting,
/// and, when `tab` is new and the browser holds [`TABS_PER_SITE`] already, the ones that have gone longest without
/// acting until there is room. `open` is each open tab with how long it has gone without acting. Never `tab`
/// itself, nor `asked` (the tab an ask waiting on the owner is about). With no `tab`, nothing is about to act, so only
/// the idle ones close.
fn to_close(open: &[(String, std::time::Duration)], tab: Option<&str>, asked: Option<&str>) -> Vec<String> {
    let mut stay: Vec<&(String, std::time::Duration)> = open.iter().filter(|(t, _)| Some(t.as_str()) != tab).collect();
    let mut close: Vec<String> = Vec::new();
    stay.retain(|(t, idle)| {
        let idle_out = *idle >= TAB_IDLE && Some(t.as_str()) != asked;
        if idle_out {
            close.push(t.clone());
        }
        !idle_out
    });
    if tab.is_some_and(|tab| !open.iter().any(|(t, _)| t == tab)) {
        stay.sort_by_key(|(_, idle)| std::cmp::Reverse(*idle));
        for (t, _) in stay.iter() {
            // The tabs left open, which the new one joins.
            if open.len() - close.len() < TABS_PER_SITE {
                break;
            }
            if Some(t.as_str()) != asked {
                close.push(t.clone());
            }
        }
    }
    close
}

/// Whether closing `going`, the idle tabs, closes the site's browser: nothing is about to act there (`tab`), and they
/// are every tab it has (`every`, the node's heal tab among them). A browser refuses to close its last tab, so the
/// browser itself is closed instead.
fn closes_the_browser(every: &[String], going: &[String], tab: Option<&str>) -> bool {
    tab.is_none() && !going.is_empty() && every.iter().all(|l| going.contains(l))
}

/// Looks over `site`'s browser before the tab `tab` acts there: closes the sessions' tabs that went idle, and makes
/// room under the cap for a new one ([`to_close`]). At most once a [`SWEEP_EVERY`], and always before a new tab is
/// made.
fn sweep(site: &str, tab: Option<&str>) {
    static SWEPT: Mutex<Vec<(String, std::time::Instant)>> = Mutex::new(Vec::new());
    let new = tab.is_some_and(|tab| !TABS.locked().iter().any(|h| h.site == site && h.tab == tab));
    {
        let mut swept = SWEPT.locked();
        let due = swept.iter().find(|(s, _)| s == site).is_none_or(|(_, at)| at.elapsed() >= SWEEP_EVERY);
        if !(new || due) || !running(site) {
            return;
        }
        swept.retain(|(s, _)| s != site);
        swept.push((site.to_string(), std::time::Instant::now()));
    }
    let Some(labels) = tab_labels(site) else { return };
    let every = labels.clone();
    let heal = heal_tab();
    let now = std::time::Instant::now();
    let open: Vec<(String, std::time::Duration)> = {
        let mut tabs = TABS.locked();
        labels
            .into_iter()
            .filter(|l| *l != heal)
            .map(|l| {
                // A tab the node has no note of (it restarted since) counts from now.
                if !tabs.iter().any(|h| h.site == site && h.tab == l) {
                    tabs.insert(0, Held { site: site.to_string(), tab: l.clone(), session: String::new(), at: now });
                }
                let idle = tabs.iter().find(|h| h.site == site && h.tab == l).map_or(std::time::Duration::ZERO, |h| now.duration_since(h.at));
                (l, idle)
            })
            .collect()
    };
    let asked = crate::hands::asking_tab(site);
    let going = to_close(&open, tab, asked.as_deref());
    // A browser never closes its last tab, so a page handed to an agent that never came back would keep the site's
    // browser running for good: with nothing about to act, the browser whose every tab went idle closes whole.
    if closes_the_browser(&every, &going, tab) {
        let last = going[0].clone();
        if run(site, Some(last.as_str()), &["close"]).is_ok_and(|o| o.status.success()) {
            closed(&sockets(), site);
            OPENED.locked().retain(|s| s != site);
            let sessions: Vec<String> = TABS.locked().iter().filter(|h| h.site == site && !h.session.is_empty()).map(|h| h.session.clone()).collect();
            // Each session hears why its page went, as when only its tab closes, not "open a page first".
            for session in &sessions {
                tab_taken(site, &tab_of(session), Gone::Idled);
            }
            TABS.locked().retain(|h| h.site != site);
            scripts_closed(site, None);
            for session in sessions {
                forget_session(site, &session);
            }
        }
        return;
    }
    for t in going {
        if run(site, None, &["tab", "close", t.as_str()]).is_ok_and(|o| o.status.success()) {
            let idled = open.iter().any(|(l, idle)| *l == t && *idle >= TAB_IDLE);
            tab_taken(site, &t, if idled { Gone::Idled } else { Gone::Room });
        }
    }
}

/// Why a session's tab went without the session closing it: what the session hears at its next command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gone {
    /// The node closed it: it went [`TAB_IDLE`] without a command.
    Idled,
    /// The node closed it: the site's browser needed room for another session's.
    Room,
    /// Someone closed it outside the node: by hand in the browser's window, or the page closed itself.
    ByHand,
    /// The site's whole browser stopped outside the node: it crashed, or its window was closed.
    Stopped,
}

impl Gone {
    /// What the session hears, after "your tab in <site>'s browser was closed".
    fn why(self, site: &str) -> String {
        match self {
            Gone::Idled => format!("it went {} minutes without a command", TAB_IDLE.as_secs() / 60),
            Gone::Room => format!("it was the one unused longest when {site}'s browser, which holds {TABS_PER_SITE}, needed room for another session"),
            Gone::ByHand => "it was closed outside the node, by hand in the browser's window or by the page itself".to_string(),
            Gone::Stopped => format!("{site}'s browser stopped (it crashed, or its window was closed)"),
        }
    }
}

/// The node closed `tab` of `site` itself, or found it gone: nobody asked, so its session is told at its next command
/// (`tab_taken_from`), and everything noted of it goes.
fn tab_taken(site: &str, tab: &str, gone: Gone) {
    let mut tabs = TABS.locked();
    let session = tabs.iter().find(|h| h.site == site && h.tab == tab).map(|h| h.session.clone()).unwrap_or_default();
    tabs.retain(|h| !(h.site == site && h.tab == tab));
    drop(tabs);
    scripts_closed(site, Some(tab));
    if !session.is_empty() {
        forget_session(site, &session);
        forget_learned(site, &session);
    }
    let why = gone.why(site);
    let mut taken = TAKEN.locked();
    taken.retain(|(t, _)| t != tab);
    taken.push((tab.to_string(), format!("your tab was closed: this session's tab in {site}'s browser is gone, because {why}. Its page is gone with it: open the page again")));
    let n = taken.len();
    if n > TAKEN_KEPT {
        taken.drain(..n - TAKEN_KEPT);
    }
    drop(taken);
    store::log_activity(&Activity {
        at: store::now(),
        who: "Node".into(),
        site: site.to_string(),
        what: match gone {
            Gone::Idled | Gone::Room => format!("Closed a tab: {why}"),
            Gone::ByHand | Gone::Stopped => format!("Found a session's tab gone: {why}"),
        },
        kind: "browse".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
}

/// The tabs the node closed itself, and why: what their sessions hear. Without it a session's next command would make
/// a new, empty tab under the same name and answer from that as if nothing had happened.
static TAKEN: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
const TAKEN_KEPT: usize = 512;

/// Why command `args` from the session whose tab is `tab` can't go ahead: the node closed that tab since the session
/// last acted. Opening a page, or closing what's left, is the session moving on, and ends it.
fn tab_taken_from(tab: &str, args: &[String]) -> Option<String> {
    let mut taken = TAKEN.locked();
    let why = taken.iter().find(|(t, _)| t == tab).map(|(_, why)| why.clone())?;
    if matches!(args.first().map(String::as_str), Some("open" | "goto" | "navigate" | "close")) {
        taken.retain(|(t, _)| t != tab);
        return None;
    }
    Some(why)
}

/// Whether what the node holds of a site's browser goes after `close`: the browser said it closed, or isn't there
/// whatever it said. A close that failed on a browser still running leaves its pages open, secrets and scripts included,
/// and every hold on them stands.
fn browser_went(closed: bool, running: bool) -> bool {
    closed || !running
}

/// `site`'s browser has gone, by a close or by itself: what the node noted of it goes the same way each time.
fn browser_gone(site: &str) {
    closed(&sockets(), site);
    OPENED.locked().retain(|s| s != site);
    TABS.locked().retain(|h| h.site != site);
    GOALS.locked().retain(|(s, ..)| s != site);
    LAST.locked().retain(|(_, s)| s != site);
    forget_approvals(site, None);
    scripts_closed(site, None);
}

/// Looks over every site's tabs for ones gone idle, with no command needed to ask: a page handed to an agent that never
/// came back to that site would otherwise stay open, since `sweep` runs when a tab acts there. From the node's
/// background pass.
pub fn sweep_idle() {
    let mut sites: Vec<String> = TABS.locked().iter().map(|h| h.site.clone()).collect();
    // A browser found after a restart has no tab noted until this looks at it.
    sites.extend(OPENED.locked().iter().cloned());
    sites.sort();
    sites.dedup();
    for site in sites {
        if running(&site) {
            sweep(&site, None);
            continue;
        }
        // Gone by itself (a crash, its own idle limit): a command launching it again has the turn, and goes first.
        let gate = gate(&format!("site:{site}"));
        let turn = hold(&gate, std::time::Duration::ZERO);
        if turn.is_some() && !running(&site) {
            browser_stopped(&site);
            forget_learned(&site, "");
        }
    }
}

/// `site`'s browser stopped with nobody asking (a crash, its window closed): each session that had a tab in it hears
/// so at its next command, not "open a page first", and what the node noted of the browser goes.
fn browser_stopped(site: &str) {
    let tabs: Vec<String> = TABS.locked().iter().filter(|h| h.site == site && !h.session.is_empty()).map(|h| h.tab.clone()).collect();
    for tab in tabs {
        tab_taken(site, &tab, Gone::Stopped);
    }
    browser_gone(site);
}

/// Whether `session`'s tab on `site`, which the node noted open, is gone since its last command, and why: the site's
/// browser stopped, or the tab isn't among the browser's own. Without this the command would make a new, empty tab
/// under the same name and answer from it ("about:blank") as if nothing had happened. Opening a page, or closing,
/// needs no tab; a browser that can't list its tabs is taken at its word.
fn tab_gone(site: &str, session: &str, args: &[String], running: impl Fn() -> bool, labels: impl Fn() -> Option<Vec<String>>) -> Option<Gone> {
    if matches!(args.first().map(String::as_str), Some("open" | "goto" | "navigate" | "close")) || session == HEAL {
        return None;
    }
    let tab = tab_of(session);
    if !TABS.locked().iter().any(|h| h.site == site && h.tab == tab && h.session == session) {
        return None;
    }
    if !running() {
        return Some(Gone::Stopped);
    }
    labels().filter(|l| !l.contains(&tab)).map(|_| Gone::ByHand)
}

/// Forgets what the node noted of `session` on `site`: its tab there has closed.
fn forget_session(site: &str, session: &str) {
    LEARNED.locked().retain(|(s, w, _)| !(s == site && w == session));
    GOALS.locked().retain(|(s, w, _)| !(s == site && w == session));
    LAST.locked().retain(|(w, s)| !(w == session && s == site));
    TABS.locked().retain(|h| !(h.site == site && h.session == session));
}

/// The tab of `site`'s browser the owner's window shows: while an agent's ask waits on them, the asking session's,
/// whichever session's command acted there since; else the one whose session acted there last.
pub fn shown_tab(site: &str) -> Option<String> {
    crate::hands::asking_tab(site).or_else(|| front_tab(site))
}

/// The other sessions' tabs open in `site`'s browser. The node's own tab for healing a route is nobody's session.
fn others(site: &str, tab: &str) -> usize {
    let heal = heal_tab();
    TABS.locked().iter().filter(|h| h.site == site && h.tab != tab && h.tab != heal).count()
}

/// The browsing session the node opens a page in to heal a route (`socket::call`): its own tab of the site's browser,
/// never the page an agent is driving there, closed once the heal is done ([`heal_done`]).
pub const HEAL: &str = "node:heal";

/// The tab [`HEAL`] browses in.
fn heal_tab() -> String {
    tab_of(HEAL)
}

/// The node is done healing a route on `site`: its tab closes, and the browser with it when no session has a tab
/// there.
pub fn heal_done(site: &str) {
    let site = site_of(site);
    if running(&site) {
        let _ = close(&site, &heal_tab());
    }
    forget_session(&site, HEAL);
}

/// The sites whose browser agents have opened since the node started, oldest first: the ones the owner can take
/// over from the window.
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// What each session said it is doing on each site, (site, session, goal), the newest last: what the node names the
/// routes it learns there.
static GOALS: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());
const GOALS_KEPT: usize = 512;

/// What the agent read off each site's pages (a snapshot, a value, a script's answer), newest last, with when: the
/// call whose answer holds it is the one that answered the page. Kept in memory only, never logged.
static READS: Mutex<Vec<(String, f64, String)>> = Mutex::new(Vec::new());

/// How much of one read is kept, and how many reads.
const READ_LIMIT: usize = 32 << 10;
const READS_KEPT: usize = 40;

/// The passwords the node filled from the vault on each site, with the login's name and the page they went into:
/// what the browser says back (a field's value, a snapshot) never shows one to the agent, and no script runs on
/// that page while it may hold one. Kept in memory only.
static FILLED: Mutex<Vec<(String, String, String, String)>> = Mutex::new(Vec::new());
/// How many values one name on one site keeps once the pages they went into are no longer held (a code is a new value
/// every half minute; a card's number is said two ways). The count is per name, never across them, and it never
/// counts a value whose page is still held ([`keep_filled`]): filling the same login again, or others, here or on
/// other sites, never pushes a secret out while its page may still show it.
const FILLED_PER_NAME: usize = 8;

/// Keeps every value whose page is still held (`held(site, page)`: a [`Place`] names it, so its browser is still
/// open), and of the rest the newest [`FILLED_PER_NAME`] of each (site, name), whatever else was filled since.
fn keep_filled(filled: &mut Vec<(String, String, String, String)>, held: &dyn Fn(&str, &str) -> bool) {
    let mut seen: std::collections::HashMap<(String, String), usize> = std::collections::HashMap::new();
    let mut keep = vec![false; filled.len()];
    for (i, (site, _, name, page)) in filled.iter().enumerate().rev() {
        if held(site, page) {
            keep[i] = true;
            continue;
        }
        let n = seen.entry((site.clone(), name.clone())).or_default();
        *n += 1;
        keep[i] = *n <= FILLED_PER_NAME;
    }
    let mut i = 0;
    filled.retain(|_| {
        i += 1;
        keep[i - 1]
    });
}

/// The pages held on each site now, (site, page), read once so [`keep_filled`] takes no other lock while it runs.
fn held_pages() -> impl Fn(&str, &str) -> bool {
    let held: Vec<(String, String)> = PLACES.locked().iter().map(|p| (p.site.clone(), place_of(&p.page))).collect();
    move |site: &str, page: &str| held.iter().any(|(s, p)| s == site && *p == place_of(page))
}

/// The vault's passwords for each site, (site, password, login name), read once a site is browsed and before anything
/// is filled there: a page can show a login's password itself (a demo site's hint, an account page), and nothing the
/// browser says back shows one to the agent, filled or not (QA check 5). Kept in memory only.
static KNOWN: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());
/// A vault value shorter than this is too common a string to hide everywhere a page says it.
const KNOWN_SHORTEST: usize = 4;

/// Reads the vault's passwords for `site`'s logins once, so [`unsaid`] hides them before any is filled. Fails closed:
/// a login whose password can't be read can't be hidden, so the caller shows nothing of the site.
pub fn know_vault(site: &str, keys: &dyn unbrowse_core::KeyStore) -> Result<(), String> {
    let logins: Vec<_> = crate::vault::list()
        .into_iter()
        .map(|l| crate::vault::Ref { site: l.site, account: l.account, new: false, code: false })
        .filter(|r| r.fits(site))
        .filter(|r| !KNOWN.locked().iter().any(|(s, _, name)| s == site && *name == r.name()))
        .collect();
    if logins.is_empty() {
        return Ok(());
    }
    let unread = |e: String| format!("the vault's passwords for {site} can't be read ({e}), so the node can't hide them in what it shows of the site: it shows nothing of it until they can be");
    let keep = crate::vault_keep(Ok(keys)).map_err(unread)?;
    for r in logins {
        if let Some(password) = crate::vault::held_secret(&keep, keys, &r).map_err(unread)? {
            know(site, &password, &r.name());
        }
    }
    Ok(())
}

/// Notes that `secret` is `site`'s vault login `name`, for [`unsaid`] to hide.
pub(crate) fn know(site: &str, secret: &str, name: &str) {
    if secret.chars().count() < KNOWN_SHORTEST {
        return;
    }
    let mut known = KNOWN.locked();
    known.retain(|(s, _, n)| !(s == site && n == name));
    known.push((site.to_string(), secret.to_string(), name.to_string()));
}

/// `text` from `site`'s browser, with every password the node filled there from the vault, and every one the vault
/// holds for the site, said as its login's name, whether the page says it as itself or as an address carries it.
pub(crate) fn unsaid(site: &str, text: String) -> String {
    let said = |t: String, password: &str, name: &str| unbrowse_learn::trace::Written::of(password).replace_all(&t, name);
    let text = FILLED.locked().iter().filter(|(s, ..)| s == site).fold(text, |t, (_, password, name, _)| said(t, password, name));
    KNOWN.locked().iter().filter(|(s, ..)| s == site).fold(text, |t, (_, password, name)| said(t, password, name))
}

/// A page's address as the place a secret was typed: without its fragment, which the page or a link can change
/// without loading another document.
fn place_of(url: &str) -> String {
    url.split('#').next().unwrap_or_default().to_string()
}

/// The document `tab` of `site`'s browser shows, as the browser names it (`document`: its main frame's loader id),
/// which only a new load changes. `None` for a browser that can't say.
fn document_of(site: &str, tab: &str) -> Option<String> {
    let said = send(site, serde_json::json!({ "id": format!("document-{}", store::now()), "action": "document", "tab": tab })).ok()?;
    said.get("document").and_then(|d| d.as_str()).filter(|d| !d.is_empty()).map(|d| format!("document:{d}"))
}

/// The document `tab` of `site`'s browser shows, as the browser names it, asked without waiting for the site's turn
/// and never of a browser that isn't running.
fn document_without_the_turn(site: &str, tab: &str) -> Option<String> {
    if !running(site) {
        return None;
    }
    let said = send_now(site, serde_json::json!({ "id": format!("document-{}", store::now()), "action": "document", "tab": tab }), ASK_WAIT).ok()?;
    said.get("document").and_then(|d| d.as_str()).filter(|d| !d.is_empty()).map(|d| format!("document:{d}"))
}

/// The address `tab` of `site`'s browser is at, from the browser's own list of its tabs: empty when it can't say.
fn address_without_the_turn(site: &str, tab: &str) -> String {
    tab_info(site, tab).and_then(|t| t["url"].as_str().map(String::from)).unwrap_or_default()
}

/// The tabs of each site's browser an agent's script ran in, (site, tab), since they opened: a script can leave a
/// listener behind that hears whatever the node types next (the page sees a field's value change), so no vault
/// secret goes into such a tab until it is closed. Kept on disk with the holds (`restore_holds`), since a node's browsers
/// keep running while it restarts.
static SCRIPTED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Notes that an agent's script runs in `tab` on `site`, before it runs.
pub(crate) fn mark_scripted(site: &str, tab: &str) -> bool {
    let mut s = SCRIPTED.locked();
    if !s.iter().any(|(a, b)| a == site && b == tab) {
        s.push((site.to_string(), tab.to_string()));
        drop(s);
        save_holds();
        return true;
    }
    false
}

/// Takes back a mark `mark_scripted` just made for a script that was then refused, so it never ran.
fn unmark_scripted(site: &str, tab: &str) {
    SCRIPTED.locked().retain(|(a, b)| !(a == site && b == tab));
    save_holds();
}

/// The mark a closed scripted tab leaves on its site while pages it may have opened (popups, which no session's tab
/// names) stay open: what its scripts left there went with them, not with the tab.
const OPENED_BY_A_SCRIPT: &str = "pages a scripted tab opened";

/// The sites with a tab open that an agent's script ran in, or a page such a tab opened. A site's mark for pages a
/// closed tab opened goes once its browser has no page that no session's tab names.
pub(crate) fn scripted_sites() -> Vec<String> {
    let orphans: Vec<String> = SCRIPTED.locked().iter().filter(|(_, t)| t == OPENED_BY_A_SCRIPT).map(|(s, _)| s.clone()).collect();
    for site in orphans {
        if unnamed_pages(&site) == Some(0) {
            SCRIPTED.locked().retain(|(s, t)| !(s == &site && t == OPENED_BY_A_SCRIPT));
            save_holds();
        }
    }
    SCRIPTED.locked().iter().map(|(site, _)| site.clone()).collect()
}

/// What a caller asks whether an agent's script may have run in.
#[derive(Clone, Copy)]
pub(crate) enum Scope<'a> {
    /// A session's tab: where the node fills a secret, or which it hands to the owner.
    Tab(&'a str),
    /// The page the owner's window is attached to (`target`, the browser's id for it): the window types into the page
    /// it attached to, whichever tab is in front now.
    Page(&'a str),
}

/// Whether an agent's script may have run where `scope` names on `site`, as far as the node can say. Fails closed:
/// holds the last run left that couldn't be read (`restore_holds`) count as a script in every browser that lived through
/// it, and so does a page a scripted tab opened (a popup, which no tab names). Otherwise a tab counts when a script ran in it since it opened,
/// and a page when a scripted tab of the site is that page, or is one whose page the node can't name.
pub(crate) fn script_may_have_run(site: &str, scope: Scope) -> bool {
    let marks: Vec<String> = SCRIPTED.locked().iter().filter(|(a, _)| a == site).map(|(_, t)| t.clone()).collect();
    may_have_run(in_doubt(site), &marks, scope, |tab| target_of(site, tab))
}

/// [`script_may_have_run`] on any site `covers` takes (a passkey's site and the hosts under it), anywhere on it.
pub(crate) fn script_may_have_run_on_any(covers: impl Fn(&str) -> bool) -> bool {
    !DOUBTED.locked().is_empty() || scripted_sites().iter().any(|s| covers(s))
}

/// The rule [`script_may_have_run`] reads, over the marks of one site and what each marked tab's page is.
fn may_have_run(unsure: bool, marks: &[String], scope: Scope, page_of: impl Fn(&str) -> Option<String>) -> bool {
    if unsure || marks.iter().any(|t| t == OPENED_BY_A_SCRIPT) {
        return true;
    }
    match scope {
        Scope::Tab(tab) => marks.iter().any(|t| t == tab),
        Scope::Page(target) => marks.iter().any(|tab| page_of(tab).is_none_or(|t| t == target)),
    }
}

/// What the owner and the asking agent are told when a page an agent's script ran in would be handed to the owner.
pub(crate) const SCRIPTED_FOR_THE_OWNER: &str = "an agent script ran in this tab since it opened, and what it left on the page could read what the owner types there: the node hands no such page to the owner. Close this tab (close), open the page again, and ask the owner before running any script";

/// What the owner and the asking agent are told when a checkout an agent's script ran in would be shown for a card.
pub(crate) const SCRIPTED_FOR_A_CARD: &str = "an agent script ran in this tab since it opened, and it could have changed what the checkout shows the owner (its total, its items, the shop's name): the node asks the owner about a card on no such page. Close this tab (close), open the checkout again, and ask for the card before running any script";

/// Refuses to show the owner `tab`'s page on `site` to approve a card when an agent's script may have run there: the
/// owner reads the amount and the order on the page itself, since the node can't vouch for them, and a script could
/// have redrawn them. The same check a hand-over to the owner makes ([`SCRIPTED_FOR_THE_OWNER`]), for the same page.
pub(crate) fn unscripted_for_a_card(site: &str, tab: &str) -> Result<(), String> {
    match script_may_have_run(site, Scope::Tab(tab)) {
        true => Err(SCRIPTED_FOR_A_CARD.to_string()),
        false => Ok(()),
    }
}

/// How many pages `site`'s browser has open that no session's tab names (popups a tab opened): `None` when it can't
/// say, or isn't running.
fn unnamed_pages(site: &str) -> Option<usize> {
    if !running(site) {
        return Some(0);
    }
    Some(tabs(site)?.iter().filter(|t| t["label"].as_str().is_none_or(str::is_empty)).count())
}

/// Refuses an agent's script where a passkey is in reach (`passkey::holds_scripts`): it could have the node's
/// authenticator sign a challenge of its own and carry the assertion off the node.
pub(crate) fn no_script_near_a_passkey(site: &str, args: &[String]) -> Result<(), String> {
    if runs_script(args) && crate::passkey::holds_scripts(site) {
        return Err("the node keeps a passkey for this site (or the owner is enrolling one), so no agent script runs on its pages: a script could use the passkey outside the site's own sign-in. Use snapshot, get and click instead; the owner can keep passkeys off this site with `unbrowse-node passkey never <site>`".into());
    }
    Ok(())
}

/// Forgets the scripts of `tab` on `site` (every tab, for `None`): the tab closed, and what they left went with it.
/// A tab's popups outlive it, though: while its browser has a page no session's tab names, the site keeps a mark
/// ([`OPENED_BY_A_SCRIPT`]). The whole browser closing forgets every mark and every hold of the site.
fn scripts_closed(site: &str, tab: Option<&str>) {
    scripts_closed_with(site, tab, || unnamed_pages(site));
}

fn scripts_closed_with(site: &str, tab: Option<&str>, unnamed: impl FnOnce() -> Option<usize>) {
    let mut s = SCRIPTED.locked();
    match tab {
        None => {
            s.retain(|(a, _)| a != site);
            drop(s);
            // A sign-up the site never accepted while its browser was open made no account: nothing is kept.
            SIGN_UPS.locked().retain(|u| u.site != site);
            PLACES.locked().retain(|p| p.site != site);
            UNHEARD.locked().retain(|p| p.site != site);
            let gone = door_name(site);
            DOUBTED.locked().retain(|d| *d != gone);
        }
        Some(t) => {
            let was = s.iter().any(|(a, b)| a == site && b == t);
            s.retain(|(a, b)| !(a == site && b == t));
            drop(s);
            if was && unnamed() != Some(0) {
                let mut s = SCRIPTED.locked();
                if !s.iter().any(|(a, b)| a == site && b == OPENED_BY_A_SCRIPT) {
                    s.push((site.to_string(), OPENED_BY_A_SCRIPT.to_string()));
                }
            }
        }
    }
    save_holds();
}

/// Refuses a vault secret in a tab an agent's script ran in since it opened.
fn no_secret_after_a_script(site: &str, tab: &str) -> Result<(), String> {
    if script_may_have_run(site, Scope::Tab(tab)) {
        return Err("an agent script ran in this tab since it opened, and what it left on the page could read what the node types: the node fills no secret here. Close this tab (close), open the page again, and fill before running any script: click, type, press and unbrowse_challenge's steps for a human check run no code of yours, so they keep the tab fillable".into());
    }
    Ok(())
}

/// Refuses a script on a page the node filled a vault secret into: a script can read the field and send it anywhere,
/// which no scrubbing of what comes back can stop. The hold lasts for the whole life of the document the secret went
/// into, whatever the page does to its fields: a page's own "show password" button turns a password field into a text
/// field without the value leaving it, so no count of password fields can say the secret has gone. Once the browser
/// loads another document (the sign-in went through, or the agent opened something else), scripts run again.
fn no_script_near_a_login(site: &str, tab: &str, args: &[String]) -> Result<(), String> {
    // The node's own sign-in waits for, clicks and counts its fields by the selectors its walk recorded, on the page it
    // just filled: none of them is an agent's question.
    let own = tab == tab_of(HEAL);
    if !(if own { shows_the_field(args) } else { held_near_a_secret(args) }) {
        return Ok(());
    }
    if !FILLED.locked().iter().any(|(s, ..)| s == site) && !PLACES.locked().iter().any(|p| p.site == site) && !in_doubt(site) {
        return Ok(());
    }
    // The node's fills are held to the document they went into, which a fragment or pushState doesn't change; what
    // the owner typed by hand, and a fill a browser couldn't name the document of, to the page's address. Both are
    // asked of the browser itself (its frame tree, its list of tabs), never of the page, without waiting for the site's
    // turn (a caller may hold it) and never starting a browser: with none, the page can't be named and the check fails
    // closed (`holds_at`).
    let document = document_without_the_turn(site, tab);
    let now = address_without_the_turn(site, tab);
    let holds = holds_at(site, document.as_deref(), &now);
    if holds {
        if !shows_the_field(args) {
            return Err(format!("this page holds a secret the node filled from the vault or the owner typed by hand, so it takes no selector here that tests more than an element's kind, id or class (an attribute, a pseudo-class, an escape): such a selector asks the page about a field's value. Use a reference from a snapshot (@e3) or a plain selector. {HOLD_RELEASES}"));
        }
        return Err(held_from_scripts());
    }
    Ok(())
}

/// What an agent hears when a page holding a secret refuses its script, its picture or a raw read of its fields.
pub(crate) const HELD_FROM_SCRIPTS: &str = "this page holds a secret the node filled from the vault or the owner typed by hand, so it runs no script, takes no picture and reads no field's value, attribute or markup here while it may still hold it: a script could read it, and a picture or a raw read shows it. Read the page's text or a snapshot, or submit the form. ";

/// What releases a hold, said wherever one refuses: true to [`holds_at`] and [`scripts_closed`]. A hold is kept by the
/// site and the page's address, not by the tab: a reload, a new tab or another session at the same address holds
/// still (going back in history may give the fields what was typed back), and only the site's whole browser closing
/// ends it. Another address is another page.
pub(crate) const HOLD_RELEASES: &str = "The hold is kept for this address while the site's browser is open, whatever tab or session opens it, reloaded or not: scripts and pictures work on another address of the site (submitting the form usually lands on one). To use this address again, close the site's browser (close, from the only session with a tab on the site) and open the page again.";

/// [`HELD_FROM_SCRIPTS`] with what releases it.
pub(crate) fn held_from_scripts() -> String {
    format!("{HELD_FROM_SCRIPTS}{HOLD_RELEASES}")
}

// The two safeguards around a secret, and what neither is about.
//
// 1. **No listener before a secret** ([`no_secret_after_a_script`]): no vault secret is typed into a tab an agent's
//    own script ran in since it opened, since what the script left behind hears what the node types.
// 2. **No reader after a secret** ([`no_script_near_a_login`], [`picture_hides_secrets`]): on a page that may hold a
//    secret, no agent script runs (it could read the field and send it anywhere), and no picture is handed out that
//    could show it.
//
// Neither is about the node's own fixed reads and the agent's hands: a click, a drag, a key, typed text the agent
// gave, and the node's own read of the page run no code of the agent's, so they leave a tab fillable and may touch a
// held page. That is the order a sign-up with a human check takes, either way round: the check met with
// `unbrowse_challenge` (its steps are hands and its reads the node's) before the fill keeps the tab fillable; a page
// that may hold a secret is pictured by no one (`page_policy` refuses a `screenshot` there, judged without asking the
// page), and a picture the check tool takes is read once more at its moment ([`may_picture`]).

/// What the node reads of a page to say whether a picture of it could show a secret: the page's text, the value of
/// every field that paints its value (any but a hidden one, or a password box still masked), in the page and every
/// frame it can enter; and whether a frame it can't enter could be the site's own (a secret goes only into a field of
/// the login's own site, so another site's frame, such as a check's widget, holds none). `{site}` is the site's name.
const SHOWN_JS: &str = r#"JSON.stringify((()=>{const site={site};const texts=[];let unread=false;const walk=(d)=>{if(!d)return;texts.push((d.body&&d.body.innerText)||'');for(const e of d.querySelectorAll('input,textarea')){const t=String(e.type||'').toLowerCase();if(t==='hidden')continue;if(t==='password'){const st=getComputedStyle(e);const sec=st.webkitTextSecurity||st.getPropertyValue('-webkit-text-security');if(sec&&sec!=='none')continue;}texts.push(String(e.value||''));}for(const f of d.querySelectorAll('iframe,frame')){let c=null;try{c=f.contentDocument}catch(_){}if(c){walk(c);continue;}let h='';try{h=new URL(f.src||'',d.baseURI).hostname}catch(_){}if(!h||h===site||h.endsWith('.'+site))unread=true;}};walk(document);return {texts:texts,unread:unread};})())"#;

/// [`SHOWN_JS`] for `site`.
pub(crate) fn shown_js(site: &str) -> String {
    SHOWN_JS.replace("{site}", &serde_json::to_string(site).unwrap_or_else(|_| "\"\"".into()))
}

/// What the node's own read found a page paints: its texts and field values, and whether a frame of the site's own
/// could not be read.
#[derive(Debug, Default, serde::Deserialize)]
pub(crate) struct Shown {
    #[serde(default)]
    pub texts: Vec<String>,
    #[serde(default)]
    pub unread: bool,
}

impl Shown {
    /// The read's answer, as a script's value: the JSON object itself, or a string holding it. `None` for anything else.
    pub(crate) fn of(said: &str) -> Option<Shown> {
        let v: serde_json::Value = serde_json::from_str(said.trim()).ok()?;
        let v = match v {
            serde_json::Value::String(inner) => serde_json::from_str(&inner).ok()?,
            v => v,
        };
        v.is_object().then(|| serde_json::from_value(v).ok()).flatten()
    }
}

/// Whether a picture of a page holding `site`'s secrets would show none of them, from what the node's own read found
/// it paints (`shown`). Fails closed: a browser in doubt, a hold the node no longer knows the secret of, a read that
/// failed, or a frame of the site's own it could not read, and the picture waits. Otherwise it waits only when a
/// secret held or known on the site is painted, as itself or in any way a page says a value back (`trace::Written`).
/// What a page paints outside its text and fields (a canvas, a pseudo-element's content) is the site's own page
/// showing it, which no agent's code wrote: no agent script runs on a held page.
pub(crate) fn picture_hides_secrets(site: &str, shown: Option<Shown>) -> bool {
    if in_doubt(site) || UNHEARD.locked().iter().any(|p| p.site == site) {
        return false;
    }
    let mut secrets: Vec<(String, String)> = FILLED.locked().iter().filter(|(s, ..)| s == site).map(|(_, secret, name, _)| (secret.clone(), name.clone())).collect();
    secrets.extend(KNOWN.locked().iter().filter(|(s, ..)| s == site).map(|(_, secret, name)| (secret.clone(), name.clone())));
    if PLACES.locked().iter().filter(|p| p.site == site).any(|p| !secrets.iter().any(|(_, name)| *name == p.name)) {
        return false;
    }
    let Some(shown) = shown.filter(|s| !s.unread) else {
        return false;
    };
    // Every form a page may say the secret in (`trace::Written`), found anywhere in what is painted, inside a longer
    // word too: a picture shows a secret wherever it stands.
    !secrets.iter().any(|(secret, _)| {
        let written = unbrowse_learn::trace::Written::of(secret);
        shown.texts.iter().any(|t| written.carries(t) || written.forms().iter().any(|(form, _)| t.contains(form.as_str())))
    })
}

/// Refuses a picture of `tab` on `site` while the page may hold a secret a picture could show ([`picture_hides_secrets`],
/// over `shown`, the node's own read of what the page paints). For a caller that pictures the page itself, as the
/// check tool does: a picture is a picture whoever takes it.
pub(crate) fn may_picture(site: &str, tab: &str, shown: impl FnOnce() -> Option<Shown>) -> Result<(), String> {
    if !FILLED.locked().iter().any(|(s, ..)| s == site) && !PLACES.locked().iter().any(|p| p.site == site) && !in_doubt(site) {
        return Ok(());
    }
    // Asked of the browser without waiting for the site's turn: the check tool pictures the page inside its own turn.
    let now = address_without_the_turn(site, tab);
    if !holds_at(site, document_without_the_turn(site, tab).as_deref(), &now) || picture_hides_secrets(site, shown()) {
        return Ok(());
    }
    Err(format!("this page holds a secret the node filled from the vault or the owner typed by hand, and the node can't say the secret is painted nowhere on it (a field showing it as text, the page saying it, a frame of the site's it can't read), so it takes no picture of it: a picture shows what is painted. Mask the field again (the page's own show/hide), or meet the check before the fill next time. {HOLD_RELEASES}"))
}

/// Whether a command only reads the page, and so goes on while the owner has it (`page_policy`): its address, its
/// title, its text, a count, a box or a style, whether an element is visible, enabled or checked, a snapshot, a
/// picture. Not a field's value, its markup or an attribute (the owner may be typing into that field), a `find` (it can
/// click or fill), a wait, or a script.
fn only_reads(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("snapshot" | "screenshot" | "is") => true,
        Some("get") => matches!(args.get(1).map(String::as_str), Some("url" | "title" | "text" | "count" | "box" | "styles")),
        _ => false,
    }
}

/// Whether a command's answer says what is on the page: its fields, its markup, its text, or the address a form sent by
/// GET leaves a value in. A count, a box or a style says nothing a field holds, and the node's own replay of a sign-in
/// reads a count.
fn says_the_page(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("snapshot" | "find") => true,
        Some("get") => !matches!(args.get(1).map(String::as_str), Some("count" | "box" | "styles")),
        _ => false,
    }
}

/// Refuses a read of a page holding a secret the node no longer knows: what comes back is scrubbed from memory
/// (`unsaid`), and a restart empties that while the browser keeps the page. A hold that outlives its scrubbing would
/// hand the field's value to the first `get value`, so the page says nothing until it is left.
fn no_read_where_nothing_hides(site: &str, tab: &str, args: &[String]) -> Result<(), String> {
    if !says_the_page(args) || !(in_doubt(site) || UNHEARD.locked().iter().any(|p| p.site == site)) {
        return Ok(());
    }
    let now = address_without_the_turn(site, tab);
    let places: Vec<Place> = UNHEARD.locked().iter().filter(|p| p.site == site).cloned().collect();
    let known = KNOWN.locked();
    if unhidden_at(in_doubt(site), &places, &|name| known.iter().any(|(s, _, n)| s == site && n == name), document_without_the_turn(site, tab).as_deref(), &now) {
        return Err(format!("this page held a secret when the node restarted, and the node no longer has what it would hide from you, so it says nothing of this page: anything it read back could be that secret. {HOLD_RELEASES}"));
    }
    Ok(())
}

/// The rule [`no_read_where_nothing_hides`] reads: whether a page may show a secret nothing can hide. `places` are the
/// holds the last run left on the site; one the vault's logins still name (`known`) can be hidden after all. Fails
/// closed as [`holds_at`] does: a browser in doubt holds every page, a page the browser can't name holds what the site
/// held, and a page at a held address holds it too, though it is another document.
fn unhidden_at(doubted: bool, places: &[Place], known: &dyn Fn(&str) -> bool, document: Option<&str>, now: &str) -> bool {
    if doubted {
        return true;
    }
    let mut lost = places.iter().filter(|p| !known(&p.name)).peekable();
    if lost.peek().is_none() {
        return false;
    }
    let Some(d) = document else { return true };
    lost.any(|p| now.is_empty() || place_of(&p.page) == place_of(d) || place_of(&p.page) == place_of(now) || place_of(&p.at) == place_of(now))
}

/// Whether a command waits while a page may hold a secret: one that runs the agent's script (it could read the
/// field), one that makes a picture of the page (a picture can't be said back with references), and one that reads a
/// field's value, an attribute or the markup as they are. Those last hand back what the page holds in whatever form
/// the page put it, and scrubbing ([`unsaid`]) knows only the forms it lists: a page that writes the value reversed,
/// split or in an encoding of its own gets it past them. So they are refused where a secret sits, not scrubbed. The
/// page's text and its snapshot still go, said back with references: they show what a person reads, not the fields.
/// A selector that asks the page a question ([`asks_by_selector`]) waits too.
fn held_near_a_secret(args: &[String]) -> bool {
    shows_the_field(args) || asks_by_selector(args)
}

/// [`held_near_a_secret`] without the selector rule: a script, a picture, or a raw read of a field's value, an
/// attribute or the markup. The node's own sign-in is held to this alone: its selectors are the walk's, not an agent's.
fn shows_the_field(args: &[String]) -> bool {
    runs_script(args)
        || matches!(args.first().map(String::as_str), Some("screenshot"))
        || (args.first().map(String::as_str) == Some("get") && matches!(args.get(1).map(String::as_str), Some("value" | "html" | "attr")))
}

/// The selectors a command carries, by the place each verb takes one: the element it acts on or reads, what it waits
/// for, the part of the page a snapshot covers.
fn selectors(args: &[String]) -> Vec<&str> {
    let at = |i: usize| args.get(i).map(String::as_str);
    let mut out: Vec<&str> = match (at(0), at(1)) {
        (Some("click" | "dblclick" | "hover" | "focus" | "check" | "uncheck" | "fill" | "type" | "select" | "scrollintoview" | "upload"), _) => at(1).into_iter().collect(),
        (Some("drag"), _) => at(1).into_iter().chain(at(2)).collect(),
        (Some("get"), Some("text" | "html" | "value" | "attr" | "count" | "box" | "styles")) | (Some("is"), _) | (Some("find"), Some("first" | "last")) => at(2).into_iter().collect(),
        (Some("find"), Some("nth")) => at(3).into_iter().collect(),
        (Some("wait"), Some(w)) if !w.starts_with('-') && !w.chars().all(|c| c.is_ascii_digit()) => vec![w],
        _ => Vec::new(),
    };
    out.extend(args.windows(2).filter(|w| w[0] == "-s" || w[0] == "--selector").map(|w| w[1].as_str()));
    out
}

/// Whether a command carries a selector the agent wrote that asks more of the page than which elements are of a kind,
/// an id or a class: an attribute test, a pseudo-class, an escape. `input[value^="a"]` counted, waited for, clicked or
/// checked is a question the page answers yes or no, and where a framework mirrors a field into its `value` attribute
/// (the classic CSS keylogger) a few such questions spell a held password out letter by letter with no script and no
/// text to scrub (audit 1118 review R5). So on a held page the agent asks with a reference from a snapshot (`@e3`) or
/// a plain selector (`body`, `#login`, `form .submit`); the selector's text isn't filtered for words, which escapes
/// get round, only held to that small alphabet.
fn asks_by_selector(args: &[String]) -> bool {
    selectors(args).into_iter().any(|s| !s.starts_with('@') && !s.chars().all(|c| c.is_ascii_alphanumeric() || " -_#.>+~,*".contains(c)))
}

/// Whether the page at `now` (a document's name, or an address) in `site`'s browser may still hold a secret the node
/// typed, or the owner typed by hand. It holds every secret typed into it for as long as the agent is on it: a field
/// that changes kind (a "show password" button), or takes another name, still holds the value, so nothing the page
/// says of its fields can let scripts back. An unknown place holds whatever was typed on the site.
fn holds_a_secret(site: &str, now: &str) -> bool {
    FILLED.locked().iter().filter(|(s, ..)| s == site).any(|(.., page)| now.is_empty() || place_of(page) == place_of(now))
        || PLACES.locked().iter().filter(|p| p.site == site).any(|p| now.is_empty() || place_of(&p.page) == place_of(now))
}

/// Whether the page `tab` shows (the browser's name for its document, `None` when it couldn't say, and its address
/// `now`) may hold a secret typed on `site`. Fails closed: a site with a secret held anywhere holds every page whose
/// document the browser can't name; and a page at the address a held document was at holds too, though it is another
/// document (going back in history may give the fields what was typed back, with or without the old document).
fn holds_at(site: &str, document: Option<&str>, now: &str) -> bool {
    let any = FILLED.locked().iter().any(|(s, ..)| s == site) || PLACES.locked().iter().any(|p| p.site == site) || in_doubt(site);
    if !any {
        return false;
    }
    let Some(d) = document.filter(|_| !in_doubt(site)) else {
        return true;
    };
    holds_a_secret(site, d) || holds_a_secret(site, now) || PLACES.locked().iter().filter(|p| p.site == site).any(|p| !now.is_empty() && place_of(&p.at) == place_of(now))
}

/// Where a secret was typed on a site, without the secret: the page it is held to (the browser's name for the
/// document, or an address) and the address that page was at. Kept on disk (`secret-holds.json`, the owner's alone)
/// with the tabs scripts ran in, so a node that restarts while its browsers keep running holds them still.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Place {
    site: String,
    name: String,
    page: String,
    at: String,
}

static PLACES: Mutex<Vec<Place>> = Mutex::new(Vec::new());

/// The holds the last run left: a secret went into these pages, and what it was went with the run, so nothing the page
/// says can be scrubbed of it (`no_read_where_nothing_hides`). A whole browser closing forgets its own.
static UNHEARD: Mutex<Vec<Place>> = Mutex::new(Vec::new());

/// The owner's hands are typing into these pages, (site, address), and the typing hasn't ended: what they typed is
/// only read when it does (`hands::end_typing`), and a restart in between would leave no hold at all. On disk with the
/// holds, so the next run holds the page, without knowing whether the field was a secret.
static TYPING: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Notes that the owner started typing on `site`'s page at `page`.
pub fn owner_typing(site: &str, page: &str) {
    let mut typing = TYPING.locked();
    if !typing.iter().any(|(s, p)| s == site && p == page) {
        typing.push((site.to_string(), page.to_string()));
        drop(typing);
        save_holds();
    }
}

/// The owner's typing on `site` ended, and what it held was read.
pub fn owner_done_typing(site: &str) {
    let mut typing = TYPING.locked();
    if typing.iter().any(|(s, _)| s == site) {
        typing.retain(|(s, _)| s != site);
        drop(typing);
        save_holds();
    }
}

/// [`hold_secret`], for a test elsewhere in the node.
#[cfg(test)]
pub(crate) fn hold_secret_for_test(site: &str, secret: &str, name: &str, page: &str, at: &str) {
    hold_secret(site, secret, name, page, at);
}

/// Holds `secret`, the vault's `name`, on `site`'s page `page` (a document's name or an address) at address `at`:
/// what comes back from the browser says the name instead, and no agent script runs there while it may hold it. The
/// page is held before its value is noted, and the same value typed into another page holds both pages: a hold is
/// one per value and page, never one per value (audit 1118 H5: the ninth fill of a login freed the first page).
fn hold_secret(site: &str, secret: &str, name: &str, page: &str, at: &str) {
    keep_place(site, name, page, at);
    let held = held_pages();
    let mut filled = FILLED.locked();
    filled.retain(|(s, p, _, g)| !(s == site && p == secret && g == page));
    filled.push((site.to_string(), secret.to_string(), name.to_string(), page.to_string()));
    keep_filled(&mut filled, &held);
}

/// Holds `secret` on its page (`hold_secret`), then has the browser type it (`type_it`): whatever the browser answers, even
/// an error after it typed, the page is held already.
fn held_then_typed<T>(site: &str, tab: &str, secret: &str, name: &str, page: &str, at: &str, type_it: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    hold_secret(site, secret, name, page, at);
    // Read again now that the page is held: a script sent at once with this fill may have marked the tab after the
    // first check, and from here on any script sees the hold.
    no_secret_after_a_script(site, tab)?;
    type_it()
}

/// Holds `page` on `site` for `name` until the site's whole browser closes ([`scripts_closed`] with no tab): never by
/// count. A document lives on where the browser can bring it back whole (back and forward keep it, with its fields as
/// typed) for as long as the browser runs, and the node can't see when that ends, so no newer fill, of this login or
/// any other, ends an older page's hold (audit 1118 H5: kept to eight a login, the ninth fill of one login freed the
/// first page with its password still in the field, for any agent script to read).
fn keep_place(site: &str, name: &str, page: &str, at: &str) {
    let mut places = PLACES.locked();
    let p = Place { site: site.into(), name: name.into(), page: page.into(), at: place_of(at) };
    if !places.contains(&p) {
        places.push(p);
    }
    drop(places);
    save_holds();
}

/// What is kept on disk of the holds: where secrets were typed and the tabs scripts ran in, never a secret.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Holds {
    places: Vec<Place>,
    scripted: Vec<(String, String)>,
    #[serde(default)]
    typing: Vec<(String, String)>,
    /// The browsers in doubt (`DOUBTED`): a file rewritten after a bad one still says what the bad one couldn't.
    #[serde(default)]
    doubted: Vec<String>,
}

fn holds_file() -> std::path::PathBuf {
    store::home().join("secret-holds.json")
}

fn save_holds() {
    #[cfg(test)]
    if !store::has_scratch_home() {
        return;
    }
    // One save at a time, each writing what is held as it writes: two at once could rename an older copy over a newer
    // one, or interleave into a file that doesn't read.
    static SAVING: Mutex<()> = Mutex::new(());
    let _one = SAVING.locked();
    let h = Holds { places: PLACES.locked().clone(), scripted: SCRIPTED.locked().clone(), typing: TYPING.locked().clone(), doubted: DOUBTED.locked().clone() };
    let path = holds_file();
    let Ok(text) = serde_json::to_string(&h) else { return };
    let part = path.with_extension("json.part");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let written = o.open(&part).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
    if written.is_ok() && std::fs::rename(&part, &path).is_ok() {
        let _ = unbrowse_core::keystore::keep_private(&path);
    } else {
        eprintln!("couldn't keep the browser's secret holds in {}", path.display());
    }
}

/// The browsers, by their door's file name, that lived through a run whose holds couldn't be read: nothing says what
/// their pages hold, so every page of theirs holds, as though a secret were in it. A browser that starts later has
/// nothing of that run in it. Kept in the holds' file, so the next start stays in doubt until the browser has gone.
static DOUBTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn door_name(site: &str) -> String {
    door(site).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Whether `site`'s browser is one the node has lost track of.
fn in_doubt(site: &str) -> bool {
    let doubted = DOUBTED.locked();
    !doubted.is_empty() && doubted.contains(&door_name(site))
}

/// The browsers in doubt, given what the last run kept (`None` when it couldn't be read) and the `doors` of the browsers
/// running now: every one after a file that doesn't read, else those the file already doubted that are still here.
fn still_doubted(kept: Option<&Holds>, doors: Vec<String>) -> Vec<String> {
    match kept {
        None => doors,
        Some(h) => h.doubted.iter().filter(|d| doors.contains(d)).cloned().collect(),
    }
}

/// The doors of the browsers running now.
fn doors() -> Vec<String> {
    let Ok(dir) = std::fs::read_dir(sockets()) else { return Vec::new() };
    dir.flatten()
        .filter(|f| f.path().extension().is_some_and(|x| x == "sock" || x == "port") && answers(&f.path()))
        .map(|f| f.file_name().to_string_lossy().into_owned())
        .collect()
}

/// The site a browser's files name: its profile is named for a host of the site, and its files for the site. None
/// where the two don't agree (`session_of`, as the folder fits it): nothing here is taken on a file's word.
fn site_of_files(session: &str, profile: &str, session_of: impl Fn(&str) -> String) -> Option<String> {
    let host = Path::new(profile.trim()).file_name()?.to_str()?;
    let site = site_of(host);
    (session_of(&site) == session).then_some(site)
}

/// At the node's start: the browsers that outlived the last run, found by their files, come back to the node's notice.
/// What it knew of them was in memory, so without this their pages would never close and the owner couldn't reach them.
pub fn find_browsers() {
    let Ok(dir) = std::fs::read_dir(sockets()) else { return };
    let mut found: Vec<String> = dir
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|x| x == "profile"))
        .filter_map(|f| site_of_files(f.path().file_stem()?.to_str()?, &std::fs::read_to_string(f.path()).ok()?, session_of))
        .filter(|site| running(site))
        .collect();
    found.sort();
    let mut opened = OPENED.locked();
    found.retain(|s| !opened.contains(s));
    opened.extend(found);
}

/// At the node's start: the holds the last run kept, for the sites whose browser kept running. A file that is there
/// but can't be read puts every running browser in doubt.
pub fn restore_holds() {
    let path = holds_file();
    let read = match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => Err(e.to_string()),
        Ok(t) => serde_json::from_str::<Holds>(&t).map_err(|e| e.to_string()),
    };
    if let Err(e) = &read {
        eprintln!("{} can't be read ({e}): every page of the browsers still running is held as holding a secret until they close", path.display());
    }
    *DOUBTED.locked() = still_doubted(read.as_ref().ok(), doors());
    let Ok(h) = read else {
        save_holds();
        return;
    };
    let mut places = PLACES.locked();
    let mut unheard = UNHEARD.locked();
    let typed = h.typing.into_iter().map(|(site, page)| Place { site, name: crate::hands::BY_OWNER.to_string(), at: place_of(&page), page });
    for p in h.places.into_iter().chain(typed).filter(|p| running(&p.site)) {
        if !unheard.contains(&p) {
            unheard.push(p.clone());
        }
        if !places.contains(&p) {
            places.push(p);
        }
    }
    drop(unheard);
    drop(places);
    let mut scripted = SCRIPTED.locked();
    for m in h.scripted.into_iter().filter(|(site, _)| running(site)) {
        if !scripted.contains(&m) {
            scripted.push(m);
        }
    }
    drop(scripted);
    save_holds();
}

/// The secrets the node typed, or the vault holds, for `site`, each with its name: what a route's answer on that site
/// says as the name instead (`run::call_with`), as a browse reply does.
pub(crate) fn secrets_of(site: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = FILLED.locked().iter().filter(|(s, ..)| s == site).map(|(_, secret, name, _)| (secret.clone(), name.clone())).collect();
    out.extend(KNOWN.locked().iter().filter(|(s, ..)| s == site).map(|(_, secret, name)| (secret.clone(), name.clone())));
    // One value held on several pages is said once.
    let mut seen = std::collections::HashSet::new();
    out.retain(|pair| seen.insert(pair.clone()));
    out
}

/// How many secrets the owner has typed by hand on each site this run ([`owner_typed`]): a hand-over in which the
/// count grew was one where the owner signed in or answered a code themselves (`owner_signed_in_since`).
static OWNER_SECRETS: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

/// How many secrets the owner has typed by hand on `site` this run, for [`owner_signed_in_since`].
pub fn owner_secrets_typed(site: &str) -> u64 {
    OWNER_SECRETS.locked().iter().find(|(s, _)| s == site).map_or(0, |(_, n)| *n)
}

/// Whether the owner typed a secret by hand on `site` since [`owner_secrets_typed`] read `before`: their own sign-in
/// (a password, a code) on the page they were handed. A hand-over where they only clicked, solved a check or looked
/// is not one, and neither is a page an agent filled from the vault.
pub fn owner_signed_in_since(site: &str, before: u64) -> bool {
    owner_secrets_typed(site) > before
}

/// Something the owner typed by hand into a secret field of `site`'s page (`hands`): said as `[typed by the owner]`
/// in everything the browser returns to an agent, and no agent script runs on that page while it may hold it. Held by
/// its address alone: the node's own hands say the document too ([`owner_typed_in`]).
#[cfg(test)]
pub(crate) fn owner_typed(site: &str, secret: &str, page: &str) {
    owner_typed_in(site, secret, page, None);
}

/// [`owner_typed`], with the document the page was (`document:<loader id>`, as [`document_of`] names it) when the
/// owner's line to the page could say: the document is held as well as its address, as a vault fill's is, so a page
/// that changes its address without loading another document (a single-page checkout's `pushState`) still holds
/// what the owner typed (audit 1118 H5: holds are keyed by document).
pub fn owner_typed_in(site: &str, secret: &str, page: &str, document: Option<&str>) {
    if secret.is_empty() {
        return;
    }
    // A password the node filled from the vault keeps its login's name.
    if FILLED.locked().iter().any(|(s, p, name, _)| s == site && p == secret && name.starts_with("vault:")) {
        return;
    }
    {
        let mut typed = OWNER_SECRETS.locked();
        match typed.iter_mut().find(|(s, _)| s == site) {
            Some((_, n)) => *n += 1,
            None => typed.push((site.to_string(), 1)),
        }
    }
    // Held before it is noted, one hold per value and page, as a fill is (`hold_secret`).
    keep_place(site, crate::hands::BY_OWNER, page, page);
    if let Some(d) = document.filter(|d| !d.is_empty()) {
        keep_place(site, crate::hands::BY_OWNER, d, page);
    }
    let held = held_pages();
    let mut filled = FILLED.locked();
    // A card number is noted as every way a page may write it back too, as the vault's fill notes it (audit 1118
    // review R8): the owner's `4242424242424242` comes back from the page as `4242 4242 4242 4242`.
    let digits: String = secret.chars().filter(|c| !matches!(c, ' ' | '-')).collect();
    let mut forms = vec![secret.to_string()];
    if (13..=19).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) && unbrowse_detector::card::luhn(digits.as_bytes()) {
        forms.push(digits.clone());
        forms.extend(card_groupings(&digits));
    }
    forms.dedup();
    for form in forms {
        filled.retain(|(s, p, _, g)| !(s == site && *p == form && g == page));
        filled.push((site.to_string(), form, crate::hands::BY_OWNER.to_string(), page.to_string()));
    }
    keep_filled(&mut filled, &held);
}

/// What the agent read on `site`, with when.
pub fn reads(site: &str) -> Vec<(f64, String)> {
    READS.locked().iter().filter(|(s, _, _)| s == site).map(|(_, t, text)| (*t, text.clone())).collect()
}

/// What the agent typed on each site lately, held in memory only: a click waits for the request that carries it.
static TYPED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
const TYPED_KEPT: usize = 8;

/// The routes each session's browsing learned on each site since it opened its tab there, (site, session, route).
/// Each browse reply names its own session's, so the agent calls a route as soon as its steps made one instead of
/// clicking through the flow again, and never hears of a route another session's steps made.
static LEARNED: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());
/// How many (site, session, route) notes are kept, the oldest going first.
const LEARNED_KEPT: usize = 1024;

/// When each session's commands started on each site, (site, session, time): a learned route is the session's whose
/// step was running when the route's call went out (`acting_at`). One browser serves a site's sessions and keeps one
/// log, so the learner can't tell their requests apart itself.
static ACTED: Mutex<Vec<(String, String, f64)>> = Mutex::new(Vec::new());

/// Notes that `session` started a command on `site` at `t`.
pub fn note_acted(site: &str, session: &str, t: f64) {
    let mut acted = ACTED.locked();
    acted.push((site.to_string(), session.to_string(), t));
    let n = acted.len();
    if n > LEARNED_KEPT {
        acted.drain(..n - LEARNED_KEPT);
    }
}

/// The session whose command on `site` was the latest to start at or before `t`: the one whose step sent a call made
/// then. None when no session's command had started on the site by then.
pub fn acting_at(site: &str, t: f64) -> Option<String> {
    ACTED.locked().iter().filter(|(s, _, at)| s == site && *at <= t).max_by(|a, b| a.2.total_cmp(&b.2)).map(|(_, w, _)| w.clone())
}

/// Whether a session other than `session` started a command on `site` after `since`.
pub fn others_acted(site: &str, session: &str, since: f64) -> bool {
    ACTED.locked().iter().any(|(s, w, at)| s == site && w != session && *at > since)
}

/// Notes a route learned on `site` from a call sent at `sent`, for the session whose step sent it; `asking`'s, the
/// session whose command ran the learn, when no session had acted on the site by then.
pub fn credit_learned(site: &str, asking: &str, id: &str, sent: f64) {
    let by = acting_at(site, sent).unwrap_or_else(|| asking.to_string());
    note_learned(site, &by, id);
}

/// Notes a route `session`'s browsing of `site` learned (or found already known).
pub fn note_learned(site: &str, session: &str, id: &str) {
    let mut learned = LEARNED.locked();
    if !learned.iter().any(|(s, w, i)| s == site && w == session && i == id) {
        learned.push((site.to_string(), session.to_string(), id.to_string()));
        let n = learned.len();
        if n > LEARNED_KEPT {
            learned.drain(..n - LEARNED_KEPT);
        }
    }
}

/// The routes `session`'s browsing of `site` learned since it opened its tab there, oldest first.
pub fn learned(site: &str, session: &str) -> Vec<String> {
    LEARNED.locked().iter().filter(|(s, w, _)| s == site && w == session).map(|(.., i)| i.clone()).collect()
}

/// Waits for what a command set off to land. A request carrying something typed on the site ends the wait as soon
/// as it is logged (it was sent and answered); else the wait ends once the site's own hosts have been quiet for
/// `quiet`. Other hosts' calls (a page's ads and beacons, which never stop) keep nothing waiting. `most` at the
/// longest.
pub fn settle(site: &str, quiet: std::time::Duration, most: std::time::Duration) {
    use std::io::{Read, Seek, SeekFrom};
    let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
    let suffix = site_of(site);
    let typed: Vec<String> = TYPED.locked().iter().filter(|(s, _)| *s == site).map(|(_, v)| v.clone()).collect();
    let mut at = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
    let mut partial = Vec::new();
    let (start, mut still) = (std::time::Instant::now(), std::time::Instant::now());
    while start.elapsed() < most {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let mut fresh = Vec::new();
        if let Ok(mut f) = std::fs::File::open(&log) {
            if f.seek(SeekFrom::Start(at)).is_ok() && f.read_to_end(&mut fresh).is_ok() {
                at += fresh.len() as u64;
            }
        }
        partial.extend(fresh);
        let mut own = false;
        if let Some(end) = partial.iter().rposition(|&b| b == b'\n') {
            let lines: Vec<u8> = partial.drain(..=end).collect();
            for line in String::from_utf8_lossy(&lines).lines() {
                if carries_typed(line, &typed) {
                    return;
                }
                own |= own_exchange(line, &suffix);
            }
        }
        if own {
            still = std::time::Instant::now();
        } else if still.elapsed() >= quiet {
            return;
        }
    }
}

/// Whether a browsing log line is a request that sent one of the typed values, as typed or as a URL carries it.
fn carries_typed(line: &str, typed: &[String]) -> bool {
    if typed.is_empty() || !line.contains("\"exchange\"") {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return false };
    if v["type"] != "exchange" {
        return false;
    }
    let request = v.pointer("/entry/request").map(|r| r.to_string()).unwrap_or_default();
    typed.iter().any(|t| unbrowse_learn::trace::carries_text(&request, t))
}

/// Whether a browsing log line is an exchange with one of the site's own hosts.
fn own_exchange(line: &str, suffix: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return false };
    v["type"] == "exchange"
        && v.pointer("/entry/request/url")
            .and_then(|u| u.as_str())
            .is_some_and(|u| on_site(u, suffix))
}

/// Whether anything was typed on `site` lately.
pub fn typed_on(site: &str) -> bool {
    TYPED.locked().iter().any(|(s, _)| s == site)
}

/// Forgets what `session`'s browsing of `site` learned: it closed its tab. Once the site's whole browser has closed,
/// what was typed there goes too.
pub fn forget_learned(site: &str, session: &str) {
    LEARNED.locked().retain(|(s, w, _)| !(s == site && w == session));
    if !TABS.locked().iter().any(|h| h.site == site) {
        LEARNED.locked().retain(|(s, ..)| s != site);
        ACTED.locked().retain(|(s, ..)| s != site);
        TYPED.locked().retain(|(s, _)| s != site);
    }
}

/// Remembers what `session` is doing on `site`.
pub fn set_goal(site: &str, session: &str, goal: &str) {
    let mut goals = GOALS.locked();
    goals.retain(|(s, w, _)| !(s == site && w == session));
    if !goal.trim().is_empty() {
        goals.push((site.to_string(), session.to_string(), goal.trim().to_string()));
        let n = goals.len();
        if n > GOALS_KEPT {
            goals.drain(..n - GOALS_KEPT);
        }
    }
}

/// What `session` said it is doing on `site`, and nothing another session said: what it browses is learned under its own
/// goal, so one agent's page is never kept as what another came to do.
pub fn goal_of(site: &str, session: &str) -> Option<String> {
    GOALS.locked().iter().rev().find(|(s, w, _)| s == site && w == session).map(|(.., g)| g.clone())
}

/// Where every browsing session's log lands: the node's to learn from, beside its other data.
pub fn capture_dir() -> PathBuf {
    store::home().join("browse")
}

/// Where the page a site's browser last opened is noted.
pub fn page_file(site: &str) -> PathBuf {
    capture_dir().join(format!("{}.page", session_of(site)))
}

/// The session for a site: one browser per site, so a login holds across the agent's steps. Two sites never share
/// one: the name spells the site out in what a session name may hold (lower-case letters, digits, `_` and `-`), a dot
/// as `_`, a hyphen as `--` and any other byte as `-` and its hex, so the name is that site's and no other's.
///
/// The name is also the site's socket in `sockets()`, and a Unix socket's path holds at most 103 bytes: a long host
/// under a long home would be a session the browser refuses to start. A name that doesn't fit there keeps as much of
/// itself as fits and ends in a hash of the whole name, so it is still that site's alone; a name that fits is
/// unchanged, and so are the profile and logs kept under it.
pub fn session_of(site: &str) -> String {
    fitted(spelled(site), sockets().as_os_str().len())
}

/// The longest a Unix socket's path may be (`sun_path` less its terminating NUL, on macOS the shorter).
const SOCKET_PATH_MAX: usize = 103;

/// `name` cut to fit, with its socket, in a folder whose path is `dir` bytes long: its head, `-`, and 12 hex digits of
/// the whole name's SHA-256. Unchanged when it fits, or when the folder leaves no room for even a cut one.
fn fitted(name: String, dir: usize) -> String {
    use sha2::Digest;
    let room = SOCKET_PATH_MAX.saturating_sub(dir + "/".len() + ".sock".len());
    const HASH: usize = 12;
    let head = room.saturating_sub(HASH + 1);
    if name.len() <= room || head < "browse_".len() + 1 {
        return name;
    }
    let hash = sha2::Sha256::digest(name.as_bytes());
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}", &name[..head], &hex[..HASH])
}

/// The site spelled out as a session name, before it is fitted to its socket.
fn spelled(site: &str) -> String {
    let mut name = String::from("browse_");
    for b in site.bytes() {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => name.push(b as char),
            b'.' => name.push('_'),
            b'-' => name.push_str("--"),
            _ => name.push_str(&format!("-{b:02x}")),
        }
    }
    name
}

/// The browser engine's CLI, the browser add-on's program (`browsers.rs`): `UNBROWSE_BROWSER` when it names one, else
/// `agent-browser` beside the node (an install from before the browser was an add-on), else the one the node
/// installed (`unbrowse browser install`), else the CLI built beside the engine the node links. Never the PATH's: an
/// `agent-browser` there may be a build without capture, and browsing through it would teach the node nothing.
/// The browser program a route's browser step and a fallback mint run: the node's own (`binary`). A step that runs
/// in the page (a call that needs the page's context, a value only its code computes) shells out to it, so naming
/// anything else (the in-process engine has no program) fails every such step with "No such file or directory".
pub(crate) fn step_program() -> Option<String> {
    binary().ok().map(|p| std::path::absolute(&p).unwrap_or(p).display().to_string())
}

pub(crate) fn binary() -> Result<PathBuf, String> {
    let name = crate::browsers::program_file();
    let named = std::env::var_os("UNBROWSE_BROWSER").map(PathBuf::from);
    let beside = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join(&name)));
    // The CLI built beside the engine is a developer's: its path is the build machine's, which on an installed node
    // may be a folder another user of this computer can make and put a program in. Only a debug build looks there.
    let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../unbrowse-browser/cli/target");
    let built = cfg!(debug_assertions).then(|| [engine.join("release").join(&name), engine.join("debug").join(&name)]).into_iter().flatten().map(Some);
    [named, beside, Some(crate::browsers::addon_program())]
        .into_iter()
        .chain(built)
        .flatten()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("the node's browser program isn't installed: run `{}`, or set UNBROWSE_BROWSER to it", crate::browsers::INSTALL))
}

/// A command the node's browser doesn't take, ending with the door that does what it was for (UNB-148). The site's
/// cookies and storage are its session, which the node keeps and the owner gives it: `session import` takes the
/// owner's own sign-in for a site, and `session forget` drops the node's.
fn not_taken(verb: &str, host: Option<&str>) -> String {
    match verb {
        "cookies" | "storage" | "state" | "session" => {
            let host = host.filter(|h| !h.is_empty()).unwrap_or("<host>");
            format!(
                "the node's browser doesn't take {verb}: a site's cookies are the node's session for it, which the owner sets. To sign the node in as the owner, the owner runs `unbrowse-node session import {host}` (or `session forget {host}` to drop it); to sign in here, open the site's sign-in page and fill it"
            )
        }
        _ => format!("the node's browser doesn't take {verb}; it takes {}", COMMANDS.join(", ")),
    }
}

/// A flag the command doesn't read, ending with what to give instead (UNB-148): the flags the command does read, and
/// for a flag that would pick the browser, its profile or its proxy, the owner's setting that does.
fn flag_refused(verb: &str, flag: &str, flags: &[&str]) -> String {
    let takes = if flags.is_empty() { format!("{verb} takes no flags: send it without {flag}") } else { format!("{verb} takes {}", flags.join(", ")) };
    format!("{flag} isn't for agents here: the node picks the browser, its profile and its session (the owner picks the browser program with UNBROWSE_BROWSER); {takes}")
}

/// A command sent as one item with its words run together (`"open https://…"`, as the tool's text writes it): the node
/// takes each word as its own item. What to send instead, when the first word is a command it takes; nothing for a
/// command already in words.
pub fn words_run_together(args: &[String]) -> Option<String> {
    let [one, rest @ ..] = args else { return None };
    let (verb, tail) = one.trim().split_once(char::is_whitespace)?;
    if !COMMANDS.contains(&verb) {
        return None;
    }
    let words: Vec<String> = std::iter::once(verb).chain(tail.split_whitespace()).map(|w| w.to_string()).chain(rest.iter().cloned()).collect();
    Some(format!(
        "each word of a command is its own item of do: send {} instead of [{}]",
        serde_json::to_string(&words).unwrap_or_default(),
        serde_json::to_string(one).unwrap_or_default()
    ))
}

/// Checks the command is one an agent may give, and says which site it acts on: the opened page's, else the one
/// named, else the last one `session` browsed.
fn site_for(args: &[String], site: Option<&str>, session: &str) -> Result<(String, Option<url::Url>), String> {
    let verb = args.first().ok_or("say what to do, e.g. [\"open\", \"https://example.com\"] or [\"snapshot\", \"-i\"]")?;
    if !COMMANDS.contains(&verb.as_str()) {
        let named = site.map(str::trim).filter(|s| !s.is_empty()).map(|s| site_of(s.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or(s)));
        let host = named.or_else(|| LAST.locked().iter().find(|(w, _)| w == session).map(|(_, s)| s.clone()));
        return Err(not_taken(verb, host.as_deref()));
    }
    if let Some((_, asks)) = ASKS.iter().find(|(v, _)| v == verb) {
        if let Some(what) = args.get(1).filter(|w| !asks.contains(&w.as_str())) {
            return Err(format!("{verb} {what} isn't for agents; {verb} takes {}", asks.join(", ")));
        }
    }
    // The browser reads its own flags from anywhere in the command, a value's place included, so every argument that
    // reads as a flag is checked, each on its own: a number (`scroll down -500`) is none.
    let flags = FLAGS.iter().find(|(v, _)| v == verb).map_or(&[][..], |(_, f)| *f);
    let number = |a: &str| a[1..].chars().any(|c| c.is_ascii_digit()) && a[1..].chars().all(|c| c.is_ascii_digit() || c == '.');
    if let Some(flag) = args[1..].iter().find(|a| a.starts_with('-') && a.len() > 1 && !flags.contains(&a.as_str()) && !number(a)) {
        return Err(flag_refused(verb, flag, flags));
    }
    let opened = matches!(verb.as_str(), "open" | "goto" | "navigate")
        .then(|| args.get(1))
        .flatten()
        .map(|u| u.parse::<url::Url>().map_err(|e| format!("not a URL: {e}")))
        .transpose()?;
    if let Some(u) = &opened {
        if !matches!(u.scheme(), "http" | "https") {
            return Err("only http and https pages can be browsed".into());
        }
        if this_machine(u) {
            return Err("the node's browser browses the web, never this machine's own services".into());
        }
    }
    // A vault login or card is typed by the node, into its own field: anywhere else its name would go to the page as
    // text.
    if args.iter().enumerate().any(|(n, a)| crate::vault::is_ref(a) && !(verb == "fill" && n == 2 && args.len() == 3)) {
        return Err("a vault login or card goes in with fill <ref> vault:…, one field at a time".into());
    }
    let site = match (&opened, site.filter(|s| !s.trim().is_empty())) {
        (Some(u), _) => u.host_str().map(site_of),
        (None, Some(s)) => Some(site_of(s.trim().trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or(s))),
        (None, None) => LAST.locked().iter().find(|(w, _)| w == session).map(|(_, s)| s.clone()).or_else(|| tab_found(session)),
    }
    .filter(|s| !s.is_empty())
    .ok_or_else(|| {
        tab_taken_from(&tab_of(session), args).unwrap_or_else(|| {
            "open a page first: [\"open\", \"https://…\"]. This session has no tab open in any of the node's browsers: it never opened a page, or closed it".to_string()
        })
    })?;
    Ok((site, opened))
}

/// The site whose running browser has `session`'s tab open, when the node has no note of the site (it restarted since:
/// its notes were in memory, and the browsers outlived it). Asks only the browsers already running, and starts none.
fn tab_found(session: &str) -> Option<String> {
    let tab = tab_of(session);
    let sites = OPENED.locked().clone();
    sites.into_iter().find(|site| running(site) && tab_labels(site).is_some_and(|l| l.contains(&tab)))
}

/// A command that failed because the page it ran on left under it, said with what to do: the browser's words
/// ("Inspected target navigated or closed") read as if the tab had gone, and agents opened the page again, or gave up.
/// Measured on the Deck's sessions: each such failure was a script that clicked a link, sent a form or set
/// `location` and then waited for an answer from the page it had left; the tab was open, on the new page.
fn left_while_running(said: String) -> String {
    if !said.contains("Inspected target navigated or closed") {
        return said;
    }
    format!(
        "{said}: the page went to another page while the command ran (a script that clicks a link, sends a form or sets location ends there), so this command's answer is lost. Your tab is still open, on the page it went to: read it with [\"get\", \"url\"] or [\"snapshot\", \"-i\"]. To move to another page and read it, move in one command and read in the next"
    )
}

/// Whether a page's address is this machine: a loopback or unspecified address, or a name under `localhost`, which
/// the browser answers from this machine without asking anyone. What listens there is the node's own (its browsers'
/// control servers, its API), never a page of the web.
fn this_machine(u: &url::Url) -> bool {
    use std::net::IpAddr;
    let own = |ip: IpAddr| match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    };
    match u.host() {
        Some(url::Host::Ipv4(ip)) => own(ip.into()),
        Some(url::Host::Ipv6(ip)) => own(ip.into()),
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        None => false,
    }
}

/// Which site a command of `session`'s acts on, once it is known to be one an agent may give.
pub fn site(args: &[String], site: Option<&str>, session: &str) -> Result<String, String> {
    site_for(args, site, session).map(|(s, _)| s)
}

/// Notes the site `session` browsed last.
fn browsed(session: &str, site: &str) {
    let mut last = LAST.locked();
    last.retain(|(w, _)| w != session);
    last.push((session.to_string(), site.to_string()));
    let n = last.len();
    if n > LAST_KEPT {
        last.drain(..n - LAST_KEPT);
    }
}

/// Runs one command in the node's browser for `who`, in `session`'s own tab of the site's browser, and returns what
/// the browser printed (a snapshot, a value, a confirmation). The first page of a site opens headless in the site's
/// profile: no window appears unless the door needs a person. `close` closes the session's tab, and the browser with
/// it once no other session has a tab there.
pub fn act(args: &[String], site: Option<&str>, who: &str, session: &str) -> Result<String, String> {
    let (site, opened) = site_for(args, site, session)?;
    // An ask on a site whose browser has gone has no page for the owner to act on: it would lock every agent out of
    // the site until it lapsed. Opening the page again ends it (the asker hears no_answer) and starts afresh.
    if args.first().is_some_and(|c| c == "open") && !crate::hands::held(&site) && cdp_of(&site).is_none() {
        crate::hands::answer(&site, crate::hands::Answer::NoAnswer);
    }
    if let Some(answer) = page_policy(&site, session, args)? {
        return Ok(answer);
    }
    let tab = tab_of(session);
    if let Some(u) = &opened {
        runs_in(&sockets(), &site, &store::profile_dir(u.host_str().unwrap_or_default()));
        // The page it is on, for the learner: its log grows with every answer the page loads, and the part of it a
        // later learn reads may start after the page was opened (`learn::learn_with`).
        let _ = std::fs::write(page_file(&site), u.as_str());
    }
    let closes = args.first().is_some_and(|v| v == "close");
    // A read while the owner has the page (`page_policy` let it by) leaves their window as it is: no tab is closed
    // under them, and the page they see stays in front.
    let owners = crate::hands::busy(&site).is_some();
    let out = if closes {
        close(&site, &tab)?
    } else {
        // Tabs gone idle close, and a new one finds room, before this one acts.
        if session != HEAL && !owners {
            sweep(&site, Some(&tab));
        }
        let out = Said::of(run(&site, Some(&tab), &script_timeout_first(args))?);
        if out.ok {
            let mut opened = OPENED.locked();
            if !opened.contains(&site) {
                opened.push(site.clone());
            }
            drop(opened);
            // The node's own heal is never the page the owner is shown, nor is an agent's read while they have it.
            if session != HEAL && !owners {
                in_front(&site, session);
            }
        }
        out
    };
    // A session that closed what it had has no last site: its next command says to open a page, and starts no browser.
    if closes && out.ok {
        LAST.locked().retain(|(w, s)| !(w == session && *s == site));
    } else {
        browsed(session, &site);
    }
    let out = Said { out: unsaid(&site, out.out), err: unsaid(&site, out.err), ..out };
    let (text, err) = (out.out.trim_end().to_string(), out.err.trim_end().to_string());
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: site.clone(),
        what: described(args),
        kind: "browse".into(),
        result: if out.ok { "done" } else { "failed" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: (!out.ok).then(|| err.chars().take(200).collect()),
    });
    if !out.ok {
        let said = if err.is_empty() { text } else { err };
        // A ref that went stale, or an element something covers: the page's elements now come with the error, so the
        // next step is one that works, not the same click again (UNB-144).
        let fresh = fresh_refs(&site, session, &said, || run(&site, Some(&tab), &["snapshot", "-i"]).ok().map(Said::of));
        return Err(left_while_running(with_fresh_refs(said, fresh.as_deref())));
    }
    if let (Some("fill" | "type"), Some(value)) = (args.first().map(String::as_str), args.get(2).filter(|v| v.trim().len() >= 2)) {
        let mut typed = TYPED.locked();
        typed.push((site.clone(), value.clone()));
        let n = typed.len();
        if n > TYPED_KEPT {
            typed.drain(..n - TYPED_KEPT);
        }
    }
    if matches!(args.first().map(String::as_str), Some("snapshot" | "get" | "eval")) && !text.is_empty() {
        let mut reads = READS.locked();
        let mut end = text.len().min(READ_LIMIT);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        reads.push((site.clone(), store::now() as f64, text[..end].to_string()));
        let n = reads.len();
        if n > READS_KEPT {
            reads.drain(..n - READS_KEPT);
        }
    }
    Ok(text)
}

/// Whether a failed command's error is one a fresh look at the page answers: a ref from a snapshot the page has
/// moved on from, or an element another one covers.
fn needs_fresh_refs(said: &str) -> bool {
    said.contains("Unknown ref: ") || said.contains("is covered by <")
}

/// The page's elements now (`look`, a `snapshot -i`), for an error a fresh look answers ([`needs_fresh_refs`]),
/// scrubbed. Only a read [`page_policy`] would let by comes back: the command that failed may have been one the
/// policy lets through where a read isn't (a click on a page holding a secret the node can no longer hide), and an
/// error is no way round it (audit 1118 M10).
fn fresh_refs(site: &str, session: &str, said: &str, look: impl FnOnce() -> Option<Said>) -> Option<String> {
    if !needs_fresh_refs(said) || !matches!(page_policy(site, session, &["snapshot".to_string(), "-i".to_string()]), Ok(None)) {
        return None;
    }
    look().filter(|s| s.ok).map(|s| unsaid(site, s.out).trim_end().to_string())
}

/// A stale or covered ref's error, said with the next step that works. Measured on the Deck's sessions (1 to 15 Nov):
/// "Unknown ref" came after a click or `open` that loaded another page, the agent still holding the refs of the one
/// before; a covered element was most often under a banner, a dialog or a cookie notice, whose control the agent
/// never got. `snapshot` is the page's elements now (`snapshot -i`), when the browser could give them: the refs in it
/// are the ones the browser holds from here on.
fn with_fresh_refs(said: String, snapshot: Option<&str>) -> String {
    let mut out = said.clone();
    if said.contains("Unknown ref: ") {
        out.push_str(": the page changed since the snapshot that ref came from (a click or a page load renumbers its elements), so that ref is gone.");
    } else if said.contains("is covered by <") {
        if said.contains("(a cookie or consent banner)") {
            out.push_str("\nIt is a cookie or consent banner: accept or close it, then try again.");
        }
        if let Some(r) = covering_ref(&said, snapshot.unwrap_or_default()) {
            out.push_str(&format!("\nThe cover's control is {r}: click it to get the cover out of the way, then try again."));
        }
    } else {
        return said;
    }
    match snapshot.filter(|s| !s.trim().is_empty()) {
        Some(s) => out.push_str(&format!("\nThe page's elements now, with the refs to use:\n{s}")),
        None => out.push_str(" Take a new snapshot (snapshot -i) for the page's elements now."),
    }
    out
}

/// The ref, in `snapshot`, of the control the browser says the cover holds (`which holds button "Accept all"`):
/// the first element of that role and name.
fn covering_ref(said: &str, snapshot: &str) -> Option<String> {
    let held = said.split(", which holds ").nth(1)?;
    let (role, rest) = held.split_once(' ')?;
    let name = rest.strip_prefix('"')?.split('"').next()?;
    let line = snapshot.lines().find(|l| l.trim_start().starts_with(&format!("- {role} \"{name}\"")))?;
    let at = line.find("ref=")? + 4;
    let r: String = line[at..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    (!r.is_empty()).then(|| format!("@{r}"))
}

/// What the browser said to one command: whether it did it, and what it printed.
struct Said {
    ok: bool,
    out: String,
    err: String,
}

impl Said {
    fn of(o: std::process::Output) -> Said {
        Said { ok: o.status.success(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
    }
}

/// What `close` from a session closes.
#[derive(Debug, PartialEq, Eq)]
enum Closing {
    /// The session's own tab: other sessions still have theirs.
    Tab,
    /// Nothing: the session has no tab there, and other sessions do.
    Nothing,
    /// The site's whole browser: no other session has a tab in it.
    Browser,
}

/// What `close` from the session whose tab is `tab` closes, given the labels of the tabs the site's browser has open
/// (`None` when it couldn't say) and how many other sessions' tabs the node noted there. A tab another session holds
/// keeps the browser open, whether or not this session has one of its own: closing never takes another session's
/// page. The node's own tab for healing a route (`heal_tab`) is nobody's session.
fn closing(labels: Option<&[String]>, tab: &str, others_noted: usize) -> Closing {
    let Some(labels) = labels else {
        return if others_noted > 0 { Closing::Nothing } else { Closing::Browser };
    };
    let heal = heal_tab();
    let others = labels.iter().any(|l| l != tab && *l != heal);
    match (labels.iter().any(|l| l == tab), others) {
        (_, false) => Closing::Browser,
        (true, true) => Closing::Tab,
        (false, true) => Closing::Nothing,
    }
}

/// `close` from the session whose tab is `tab`: its own tab while another session has one, else the site's browser.
fn close(site: &str, tab: &str) -> Result<Said, String> {
    let up = running(site);
    let labels = up.then(|| tab_labels(site)).flatten();
    let what = if up { closing(labels.as_deref(), tab, others(site, tab)) } else { Closing::Browser };
    match what {
        Closing::Tab => {
            let out = Said::of(run(site, None, &["tab", "close", tab])?);
            if out.ok {
                TABS.locked().retain(|h| !(h.site == site && h.tab == tab));
                forget_approvals(site, Some(tab));
                scripts_closed(site, Some(tab));
                return Ok(Said { out: format!("Closed this session's tab. {site}'s browser stays open for the other sessions browsing it."), ..out });
            }
            Ok(out)
        }
        Closing::Nothing => {
            TABS.locked().retain(|h| !(h.site == site && h.tab == tab));
            scripts_closed(site, Some(tab));
            Ok(Said { ok: true, out: format!("This session has no tab open in {site}'s browser, so nothing was closed: other sessions' tabs stay open."), err: String::new() })
        }
        Closing::Browser => {
            let said = run(site, Some(tab), &["close"]);
            if browser_went(said.as_ref().is_ok_and(|o| o.status.success()), running(site)) {
                browser_gone(site);
            }
            Ok(Said::of(said?))
        }
    }
}

/// How long an agent's script is given when it names no time: a page command's 30 s, said as such when it runs out.
const SCRIPT_MS: &str = "30000";

/// An eval's `--timeout <ms>` where the browser reads it, before the script, wherever the agent put it; and an eval
/// that names none gets `SCRIPT_MS`. Without one the browser waits on the script with no time of its own, and the
/// agent got the socket's read timeout, "Failed to read: Resource temporarily unavailable (os error 35)", in place of
/// "the script was given 30 s and hadn't answered" (QA check 11, staging QA 44912147606).
fn script_timeout_first(args: &[String]) -> Vec<String> {
    let mut args = args.to_vec();
    if args.first().map(String::as_str) == Some("eval") {
        match args.iter().position(|a| a == "--timeout") {
            Some(at) if at > 1 && at + 1 < args.len() => {
                let ms = args.remove(at + 1);
                args.remove(at);
                args.splice(1..1, ["--timeout".to_string(), ms]);
            }
            Some(_) => {}
            None => {
                args.splice(1..1, ["--timeout".to_string(), SCRIPT_MS.to_string()]);
            }
        }
    }
    args
}

/// Refuses a site the owner excluded. The site's browser goes anywhere on the site, so a host of it that was excluded
/// excludes the whole site's browser.
fn excluded(settings: &store::Settings, site: &str) -> Result<(), String> {
    if settings.excluded.iter().any(|e| at_or_under(site, e) || same_site(site, e)) {
        return Err(format!("{site} is excluded from mapping in Settings"));
    }
    Ok(())
}

/// The vault login a command fills, if it is `fill <target> vault:…`.
pub fn vault_fill(args: &[String]) -> Option<crate::vault::Ref> {
    (args.len() == 3 && args[0] == "fill").then(|| crate::vault::Ref::parse(&args[2])).flatten()
}

/// What the browser's own frame check holds the field to: the login's site, and for a port-scoped login its whole
/// origin (https, that port), so a frame of the right site on another port or scheme gets nothing either.
fn frame_site(r: &crate::vault::Ref) -> String {
    let site = unbrowse_learn::identity::site_of(&r.site);
    match r.port() {
        Some(port) => format!("https://{site}:{port}"),
        None => site,
    }
}

/// Fills a login from the vault into `target`, for `who`. The node types the password itself, and only into a field
/// whose page and own frame are on the login's site: a page elsewhere (a lookalike, a redirect) or another site's
/// frame inside the right page gets nothing. The password goes to
/// the browser over its own socket, never on a command line, and the walk record says the login's name instead.
/// `whole`: the sign-in is done in one go (account name and code beside the password, the form submitted, the page
/// cleared of what it still holds); without it only the one field is filled, as a learned route's own steps expect.
pub fn fill_from_vault(args: &[String], site: Option<&str>, who: &str, session: &str, keys: &dyn unbrowse_core::KeyStore, whole: bool) -> Result<String, String> {
    let settings = store::load_settings();
    if settings.paused {
        return Err(crate::outcome::PAUSED.into());
    }
    let r = vault_fill(args).ok_or("fill <target> vault:<site>:<account>")?;
    let (site, _) = site_for(args, site, session)?;
    let tab = tab_of(session);
    if let Some(why) = crate::hands::busy(&site) {
        return Err(why);
    }
    excluded(&settings, &site)?;
    no_secret_after_a_script(&site, &tab)?;
    if site_holds_a_card(&site) {
        return Err(CARD_IS_THE_OWNERS.into());
    }
    // A login typed into a page is a step in it: none while a checkout waits.
    if let Some(why) = crate::payhold::waiting() {
        return Err(why);
    }
    let target = &args[1];
    let page = run(&site, Some(&tab), &["get", "url"])?;
    let page = String::from_utf8_lossy(&page.stdout).trim().to_string();
    let at = url::Url::parse(&page).ok().and_then(|u| Some(format!("{}://{}", u.scheme(), u.host_str()?))).ok_or("open the login page first")?;
    if !r.fits_page(&page) {
        return Err(format!(
            "{} is the login for {}, and this page is on {at}: the node fills a login only into its own site, over https (and its own port, for a port-scoped login)",
            r.name(),
            r.site
        ));
    }
    let keep = crate::vault_keep(Ok(keys))?;
    let password = crate::vault::secret_for(&keep, keys, &r)?;
    // The page's address is on the login's site, and the browser checks the field's own frame too: a frame from
    // another site inside a page of the right one gets nothing.
    let on = frame_site(&r);
    // A password goes only into a password field, a code only into a field made for one: the browser checks the
    // field it writes into, so a comment box on the right site never takes the login and posts it.
    let field = if r.code { "code" } else { "password" };
    // Held before it is typed, whatever the browser answers: a browser that types it and then fails (one too old to
    // check the field, a reply that times out) leaves the page holding it, and the hold must already be there.
    let held = document_of(&site, &tab).unwrap_or_else(|| place_of(&page));
    let mut cmd = serde_json::json!({ "id": format!("vault-{}", store::now()), "action": "fill", "selector": target, "value": password.as_str(), "as": r.name(), "site": on, "field": field, "tab": tab });
    // A login kept in the vault goes in whole and is sent at once: its account name beside the password, its
    // one-time code where the form asks for one on the same page, then the form's own submit. What the page still
    // holds of it afterwards the browser clears, so a sign-in that didn't go through leaves no password in a page
    // the agent goes on driving. A login being made (`vault:new:`) is one field of a longer form the agent fills.
    let code_name = crate::vault::Ref { code: true, new: false, ..r.clone() }.name();
    let mut code = None;
    if whole && !r.new {
        cmd["submit"] = serde_json::json!(true);
        if !r.code {
            cmd["username"] = serde_json::json!(r.account);
            if crate::vault::list().iter().any(|l| l.site == r.site && l.account == r.account && l.code) {
                code = crate::vault::secret_for(&keep, keys, &crate::vault::Ref { code: true, new: false, ..r.clone() }).ok();
            }
        }
    }
    if let Some(code) = &code {
        cmd["code"] = serde_json::json!(code.as_str());
        cmd["codeAs"] = serde_json::json!(code_name);
        hold_secret(&site, code, &code_name, &held, &page);
    }
    let sent = held_then_typed(&site, &tab, &password, &r.name(), &held, &page, || send(&site, cmd).and_then(|said| checked_field(&said)));
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: site.clone(),
        what: format!("Filled the vault login {} into {target}", r.name()),
        kind: "vault".into(),
        result: if sent.is_ok() { "done" } else { "failed" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: sent.as_ref().err().map(|e| e.chars().take(200).collect()),
    });
    let sent = sent?;
    // A login the node makes is kept once the site accepts the sign-up, never once its password is typed: a sign-up
    // stopped at a check, or refused, leaves no login with no account behind it (`sign_ups_accepted`). Until then the
    // same reference derives the same password, so a second box or a retry fills the same one.
    if r.new && !crate::vault::list().iter().any(|l| l.site == r.site && l.account == r.account) {
        wait_for_sign_up(&site, &tab, &r, &password, who, log_mark(&site));
    }
    browsed(session, &site);
    in_front(&site, session);
    // What a request carries of this typing is the login's name, as the walk record writes it.
    let mut typed = TYPED.locked();
    typed.push((site, r.name()));
    let n = typed.len();
    if n > TYPED_KEPT {
        typed.drain(..n - TYPED_KEPT);
    }
    Ok(format!("Filled {target} with {}{}", r.name(), sent_on(&sent)))
}

/// What a vault fill says of the rest of the sign-in the browser did with it: the fields filled beside the secret,
/// that the form was submitted, and what was cleared from a page that still held the secret afterwards.
fn sent_on(said: &serde_json::Value) -> String {
    let mut told = String::new();
    let beside = |what: &str| said["beside"][what].as_str().is_some_and(|b| b != "none");
    match (beside("username"), beside("code")) {
        (true, true) => told.push_str(", with its account name and one-time code"),
        (true, false) => told.push_str(", with its account name"),
        (false, true) => told.push_str(", with its one-time code"),
        (false, false) => {}
    }
    if said["submitted"].as_bool() == Some(true) {
        told.push_str(", and submitted the form: don't click its button. Take a snapshot to see where the sign-in landed");
    }
    if said["cleared"].as_u64().is_some_and(|n| n > 0) {
        told.push_str(". The page still held the secret afterwards (the sign-in didn't go through, or the site showed it back), so the node cleared it from the page");
    }
    told
}

/// A login a `vault:new:` fill made, waiting for the site's word: the reference, its password (in memory only, to tell
/// the request that sent it), who filled it, the tab, where the site's browsing log stood at the fill, and whether a
/// request that carried it was answered as accepted.
struct SignUp {
    site: String,
    tab: String,
    r: crate::vault::Ref,
    secret: String,
    who: String,
    mark: u64,
    answered: bool,
}

static SIGN_UPS: Mutex<Vec<SignUp>> = Mutex::new(Vec::new());

/// Notes a `vault:new:` fill on `site`'s `tab`, to keep its login once the site accepts the sign-up.
fn wait_for_sign_up(site: &str, tab: &str, r: &crate::vault::Ref, secret: &str, who: &str, mark: u64) {
    let mut ups = SIGN_UPS.locked();
    if let Some(up) = ups.iter_mut().find(|u| u.site == site && u.r == *r) {
        up.tab = tab.to_string();
        return;
    }
    ups.push(SignUp { site: site.into(), tab: tab.into(), r: r.clone(), secret: secret.into(), who: who.into(), mark, answered: false });
}

/// What the site's answer to a sign-up said, read from the browsing log's lines: `Some(true)` when the last answer to
/// the sign-up was a success (below 400), `Some(false)` when it was a refusal, `None` when there is none yet. The
/// sign-up is each request that carried the new password (as itself, or as its login's name, as the walk record writes
/// it), and any later one of the same method to the same address: a door that held the sign-up sends it again once
/// it lets the browser through, and the log need not hold that request's body. A door's own page (`page::a_door`) is
/// no answer either way: the site has not said yet.
fn sign_up_answer(lines: &str, carried: &[String]) -> Option<bool> {
    let mut sent: Vec<(String, String)> = Vec::new();
    let mut answer = None;
    for (_, v) in exchange_lines(lines) {
        let request = v.pointer("/entry/request").map(|r| r.to_string()).unwrap_or_default();
        let method = v.pointer("/entry/request/method").and_then(|m| m.as_str()).unwrap_or_default().to_string();
        let url = v.pointer("/entry/request/url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
        let carries = carried.iter().any(|c| unbrowse_learn::trace::carries_text(&request, c));
        if carries && !sent.contains(&(method.clone(), url.clone())) {
            sent.push((method.clone(), url.clone()));
        }
        if !(carries || (method != "GET" && sent.contains(&(method, url.clone())))) {
            continue;
        }
        let status = v.pointer("/entry/response/status").and_then(|s| s.as_u64()).unwrap_or(0) as u16;
        let body = v.pointer("/entry/response/content/text").and_then(|t| t.as_str()).unwrap_or_default();
        let door = url::Url::parse(&url).is_ok_and(|at| unbrowse_learn::page::a_door(status, body, &at));
        if !door && status != 0 {
            answer = Some((200..400).contains(&status));
        }
    }
    answer
}

/// Keeps every login a `vault:new:` fill made on `site` that the site has accepted: a request that carried its
/// password was answered with success, and the page now asks for no password (`asks_a_password`, the node's count of
/// password boxes in the tab; a form put back with its errors asks again). Both, never one: a page that answered 200
/// with the form again made no account. Returns the logins kept, by name.
pub fn sign_ups_accepted(site: &str, asks_a_password: impl Fn(&str) -> Option<bool>, keep_it: impl Fn(&crate::vault::Ref, &str) -> Result<(), String>) -> Vec<String> {
    let waiting: Vec<(usize, String, u64, Vec<String>)> =
        SIGN_UPS.locked().iter().enumerate().filter(|(_, u)| u.site == site).map(|(i, u)| (i, u.tab.clone(), u.mark, vec![u.secret.clone(), u.r.name()])).collect();
    let mut kept = Vec::new();
    for (i, tab, mark, carried) in waiting.into_iter().rev() {
        let answer = sign_up_answer(&lines_since(site, mark), &carried);
        let answered = {
            let mut ups = SIGN_UPS.locked();
            let Some(up) = ups.get_mut(i) else { continue };
            if let Some(a) = answer {
                up.answered = a;
            }
            up.answered
        };
        if answered && asks_a_password(&tab) == Some(false) {
            let up = SIGN_UPS.locked().remove(i);
            if keep_it(&up.r, &up.who).is_ok() {
                kept.push(up.r.name());
            }
        }
    }
    kept
}

/// Whether `tab` on `site` shows a password box, by the node's own count: `None` when the browser can't say.
pub fn asks_a_password(site: &str, tab: &str) -> Option<bool> {
    let out = run(site, Some(tab), &["get", "count", "input[type=password]"]).ok().filter(|o| o.status.success())?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok().map(|n| n > 0)
}

/// The sign-ups waiting on `site`, by login name: what a reply says is not kept yet.
pub fn sign_ups_waiting(site: &str) -> Vec<String> {
    SIGN_UPS.locked().iter().filter(|u| u.site == site).map(|u| u.r.name()).collect()
}

/// The browser's answer to a fill whose field it was asked to check: Ok only when it says it checked it. A browser
/// too old to check a field says nothing of it, and the fill counts as failed.
fn checked_field(said: &serde_json::Value) -> Result<serde_json::Value, String> {
    match said.get("field_checked").and_then(|c| c.as_bool()) {
        Some(true) => Ok(said.clone()),
        _ => Err("the node's browser didn't say it checked the field the secret went into: update the browser (unbrowse browser install) before filling from the vault".into()),
    }
}

/// What an agent may still ask of a site while a card sits in one of its pages, or the owner is deciding on one: the
/// commands proven to send the page no event and run no script in it. Closing the tab (the owner's page then goes),
/// and the address and title of the agent's tab, which the node answers itself from the browser's own list of its
/// tabs, not by asking the page. Everything else is refused, a command named tomorrow included: a read the browser
/// makes by running script in the page (a snapshot, a text, a check), a focus, a hover, a scroll, a key or a wait
/// can each set off a handler the page armed to change the order or submit it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CardSafe {
    Close,
    Url,
    Title,
}

/// The command `args` is, if it is one [`CardSafe`] names exactly, flags and all.
fn card_safe(args: &[String]) -> Option<CardSafe> {
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["close"] => Some(CardSafe::Close),
        ["get", "url"] => Some(CardSafe::Url),
        ["get", "title"] => Some(CardSafe::Title),
        _ => None,
    }
}


/// Whether `site` is held for a checkout (`payhold`): the owner was asked about a card there, or it is a host that
/// checkout names, and the owner hasn't yet said it is finished or dismissed. Nothing an agent does ends it.
pub(crate) fn site_holds_a_card(site: &str) -> bool {
    crate::payhold::held(site).is_some()
}


/// The rule every agent command on `site` crosses, from any session and any tab, the node's own heal included: while
/// a card sits in a page of the site, or the owner is deciding on one, only what [`card_safe`] names goes. `Ok(None)`:
/// the command goes on to the browser. `Ok(Some(answer))`: the node answered it itself, from the browser's own list of
/// its tabs. `Err`: refused, nothing sent.
fn card_gate(site: &str, tab: &str, args: &[String]) -> Result<Option<String>, String> {
    // On a held site, and on every other site while a checkout waits anywhere, only what [`card_safe`] names goes: a
    // read of a page runs code the page defines (a getter behind `innerText`), and that code can send a request.
    let why = if site_holds_a_card(site) {
        CARD_IS_THE_OWNERS.to_string()
    } else {
        match crate::payhold::waiting() {
            Some(why) => why,
            None => return Ok(None),
        }
    };
    let answer = |field: &str| tab_info(site, tab).and_then(|t| t[field].as_str().map(String::from)).map(|v| Some(unsaid(site, v))).ok_or_else(|| why.clone());
    match card_safe(args) {
        Some(CardSafe::Close) => Ok(None),
        Some(CardSafe::Url) => answer("url"),
        Some(CardSafe::Title) => answer("title"),
        None => Err(why.clone()),
    }
}

/// The one page policy every agent read and step on a page crosses: `unbrowse_browse` (`act`) and the challenge tool
/// call this same function, so no path to a page has a list of its own. In order:
/// - the tab is the session's own (`tab_taken_from`), the owner doesn't have the page (`hands::busy`), the node isn't
///   paused, and the site isn't excluded;
/// - a card checkout: on a held site only what [`card_safe`] names, and while any checkout waits only reads elsewhere
///   (`card_gate`); a node-answered url or title comes back as `Ok(Some(answer))`;
/// - a secret: no agent script and no picture where a secret the node filled or the owner typed may sit
///   (`no_script_near_a_login`, `holds_at`), none near a passkey ceremony (`no_script_near_a_passkey`), and nothing
///   read back from a page holding a secret the node can no longer hide (`no_read_where_nothing_hides`). A script's
///   mark goes on before the holds are read, and comes off again when it is refused.
///
/// `Ok(None)`: the command may go to the page. What it reads back is the caller's to scrub ([`unsaid`]).
pub(crate) fn page_policy(site: &str, session: &str, args: &[String]) -> Result<Option<String>, String> {
    let tab = tab_of(session);
    // A tab closed outside the node, or a browser that stopped, is found out here, so the session hears why below.
    if let Some(gone) = tab_gone(site, session, args, || running(site), || tab_labels(site)) {
        if gone == Gone::Stopped {
            browser_stopped(site);
        } else {
            tab_taken(site, &tab, gone);
        }
    }
    if let Some(why) = tab_taken_from(&tab, args) {
        return Err(why);
    }
    // The owner has the page: it is theirs to change until they give it back. An agent still reads it (B04, Lewis, 18
    // Nov 2026): a read changes nothing the owner sees, and the holds below still keep a secret out of what it reads.
    if let Some(why) = crate::hands::busy(site) {
        if !only_reads(args) {
            return Err(why);
        }
    }
    let settings = store::load_settings();
    if settings.paused {
        return Err(crate::outcome::PAUSED.into());
    }
    excluded(&settings, site)?;
    // A card in a page of the site, or one the owner is deciding on: the payment is theirs, and only what is proven
    // to reach no page goes, from any session, the node's own heal included (`card_gate`).
    if let Some(answer) = card_gate(site, &tab, args)? {
        return Ok(Some(answer));
    }
    // The script's mark goes on before the holds are read, and a fill holds the page before it reads the marks
    // (`held_then_typed`), so of a script and a fill sent at once one always sees the other: never a script that ran
    // beside a secret typed after its check (external security review round 4, on #223).
    let marked = runs_script(args) && mark_scripted(site, &tab);
    if let Err(e) = no_script_near_a_login(site, &tab, args).and_then(|_| no_script_near_a_passkey(site, args)).and_then(|_| no_read_where_nothing_hides(site, &tab, args)) {
        if marked {
            unmark_scripted(site, &tab);
        }
        return Err(e);
    }
    Ok(None)
}

/// `text` read from `site`'s pages with every secret the node filled there, or the owner typed, or the vault holds
/// for the site, said as its name ([`unsaid`]): what any reply carrying a page's words says.
pub(crate) fn scrubbed(site: &str, text: String) -> String {
    unsaid(site, text)
}

/// Refuses, before anything else runs, a command [`card_gate`] would refuse on `site`: the caller does nothing of its
/// own in the site's pages first.
pub(crate) fn refuse_where_a_card_sits(site: &str, args: &[String]) -> Result<(), String> {
    if card_safe(args).is_some() {
        return Ok(());
    }
    if site_holds_a_card(site) {
        return Err(CARD_IS_THE_OWNERS.into());
    }
    match crate::payhold::waiting() {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

/// Runs `f` in a turn of `site`'s browser: no agent command (each takes the same turn, `run`) and no card fill (which
/// measures, types and measures again in one, `fill_card`) comes between its steps. The caller checks its gate again
/// inside the turn, so a hold begun while it waited is seen. `what` says what holds the turn, as a person reads it.
pub(crate) fn in_the_sites_turn<T>(site: &str, what: String, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let gate = gate(&format!("site:{site}"));
    let _turn = take_turn(&gate, site, what)?;
    f()
}

/// Why a request the node would send to `host` waits (`unbrowse_learn::hold`): it is on a site a checkout hold covers
/// (`payhold`). The payment is the owner's, so no route, heal, shared route or signing page of the node's reaches the
/// site, nor any host the checkout names, until the owner says the checkout is finished or dismissed.
pub fn card_holds_host(host: &str) -> Option<String> {
    crate::payhold::held(&site_of(host))
}

/// Every host the measured checkout names, by site: its own page's, its frames', its forms' actions (each control's
/// `action` and `formaction`, read against the page's address), and every host the browser's own record of `browser`
/// shows its pages submitting to (a request that isn't a plain fetch of a resource) since `since`. What the page's
/// server does once it has the order can't be known here.
fn checkout_hosts(browser: &str, measured: &crate::checkout::Measured, since: u64) -> (Vec<String>, bool) {
    let base = url::Url::parse(&measured.url).ok();
    let host_site = |u: &str| -> Option<String> {
        let at = match &base {
            Some(b) => b.join(u).ok()?,
            None => url::Url::parse(u).ok()?,
        };
        at.host_str().map(site_of)
    };
    let mut hosts: Vec<String> = Vec::new();
    let mut add = |h: Option<String>| {
        if let Some(h) = h.filter(|h| !h.is_empty()) {
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        }
    };
    add(host_site(&measured.url));
    for f in &measured.frames {
        add(host_site(f));
    }
    for c in &measured.controls {
        for (k, v) in &c.attrs {
            if matches!(k.as_str(), "action" | "formaction") {
                add(host_site(if v.is_empty() { &measured.url } else { v }));
            }
        }
    }
    let (submitted, whole) = submitted_to(browser, since);
    for h in submitted {
        add(Some(h));
    }
    (hosts, whole)
}

/// The sites the browser's own record of `browser` shows its pages sending something to (a request whose method isn't
/// `GET`, `HEAD` or `OPTIONS`) since `since`, an hour back from it at most: the hosts a checkout submits to.
fn submitted_to(browser: &str, since: u64) -> (Vec<String>, bool) {
    use std::io::{Read, Seek, SeekFrom};
    let path = capture_dir().join(format!("{}.jsonl", session_of(browser)));
    let Ok(mut f) = std::fs::File::open(path) else { return (Vec::new(), false) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(16 << 20)));
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return (Vec::new(), false);
    }
    let from = since.saturating_sub(3600) as f64;
    // Whole when the file fit, or the part read reaches back past where the checkout began.
    let mut whole = len <= 16 << 20;
    let mut out: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&bytes).lines().filter(|l| l.contains("\"exchange\"")) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v["type"] != "exchange" || v["t"].as_f64().is_some_and(|t| t < from) {
            whole = true;
            continue;
        }
        let req = &v["entry"]["request"];
        let method = req["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
        if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
            continue;
        }
        if let Some(site) = req["url"].as_str().and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(site_of)) {
            if !out.contains(&site) {
                out.push(site);
            }
        }
    }
    (out, whole)
}

/// Holds `browser`'s site, and every host its checkout as measured names, from now until the owner releases it. Err
/// when the hold can't be kept: the caller fills no card.
pub fn hold_checkout(browser: &str, measured: &crate::checkout::Measured) -> Result<(), String> {
    let since = crate::payhold::of(browser).map(|h| h.since).unwrap_or_else(store::now);
    let (hosts, whole) = checkout_hosts(browser, measured, since);
    crate::payhold::begin(browser, &hosts)?;
    // A record cut short or missing can't say every host the checkout sent to: the owner is told. Nothing that
    // changes state goes anywhere while the hold lasts (`payhold::waiting`), so what it misses is only a read.
    if !whole {
        crate::payhold::warn(browser, "the browser's record of what the checkout sent was cut short or missing, so the hosts it sent to may not all be listed; nothing that changes state goes to any site while the hold lasts");
    }
    Ok(())
}

/// Why a connection from one of the node's browsers (`label`: the site whose own browser it is, `None` for one with no
/// listener of its own) to `host` may not be made now: while any card checkout waits, only the checkout's own browser
/// connects, to any host its page needs (its card issuer's 3-D Secure page, a provider's). Every other browser gets no
/// connection at all, to the checkout's hosts as much as to any other: what runs in it (a page whose freeze failed, a
/// worker, a service worker, a tab opened since) can send nothing, whatever the freeze managed (`quiet`). Fails closed:
/// a hold record that can't be trusted refuses every connection.
pub fn browser_may_connect(label: Option<&str>, host: &str) -> Option<String> {
    let holds = match crate::payhold::list() {
        Err(e) => return Some(format!("the node's record of card checkouts can't be trusted ({e}), so its browsers reach nothing until the owner dismisses them all")),
        Ok(holds) => holds,
    };
    if holds.is_empty() || label.is_some_and(|l| holds.iter().any(|h| h.site == l)) {
        return None;
    }
    Some(format!("a card checkout on {} is waiting for the owner: until they say it is finished or dismissed, only the checkout's own browser connects, and {host} was asked for by another", holds[0].site))
}

/// Sets [`card_holds_host`] as the rule every request the node sends crosses. Once a process is enough.
pub fn hold_requests_where_a_card_sits() {
    static SET: std::sync::Once = std::sync::Once::new();
    SET.call_once(|| {
        unbrowse_learn::hold::set(card_holds_host);
        // While any checkout waits, nothing that changes state goes anywhere (`payhold::waiting`).
        unbrowse_learn::hold::set_waiting(crate::payhold::waiting);
        // And the node's browsers reach only what the hold lets them (`browser_may_connect`).
        unbrowse_learn::hold::set_browser(browser_may_connect);
    });
}


/// What an agent hears when a card is in a page of the site, or the owner is deciding on one.
pub(crate) const CARD_IS_THE_OWNERS: &str = "a card is in a checkout on this site, or the owner is deciding whether to pay with one: the payment is theirs to submit, so the node runs nothing on the site that could reach the page (every command but get url, get title and close is refused, a snapshot and a scroll included) and sends the site no route. Fill every other field before the card. To pay, ask_owner \"submit the payment\": the owner checks the order on the live page and submits it themselves. To leave the checkout, close the tab";

/// The card field a command fills, if it is `fill <target> vault:card:…`.
pub fn card_fill(args: &[String]) -> Option<crate::vault::CardRef> {
    (args.len() == 3 && args[0] == "fill").then(|| crate::vault::CardRef::parse(&args[2])).flatten()
}

/// The owner's yes to paying with one card on one checkout page, and what they were shown there: the page as the
/// browser measured it (`checkout::measure`, over its own protocol, never by script in the page) once the tab was
/// locked and before they were asked, and again after they answered. Every fill of the card's fields measures the page
/// again and goes in only while it reads as approved, the card's own fields aside (`checkout::same_order`); the
/// hand-off to the owner to submit does the same. The yes lives for one fill sequence; the record of what was approved
/// lives as long as the tab, so the hand-off can still be held to it.
#[derive(Clone, Debug)]
struct CardApproval {
    /// The browser the checkout is in, and the site the page is on.
    browser: String,
    site: String,
    label: String,
    session: String,
    approved: crate::checkout::Measured,
    /// The controls of this page the node filled from the card, and what went in (`checkout::filled_by`).
    typed: Vec<crate::checkout::CardControl>,
    filled: bool,
    first_by: u64,
    until: u64,
}

static CARD_APPROVALS: Mutex<Vec<CardApproval>> = Mutex::new(Vec::new());

/// How long an owner's yes to paying with a card on a page lives, in seconds: one fill sequence of the card's fields.
pub(crate) const CARD_APPROVAL_LIFE: u64 = 60;
/// How soon after the yes the first field must go in.
const CARD_FIRST_FILL: u64 = 20;

/// Notes the owner's yes to paying with card `label` on `site`'s checkout, as it was measured in `approved`.
pub fn approve_card(browser: &str, site: &str, label: &str, session: &str, approved: crate::checkout::Measured) {
    let now = store::now();
    let mut approvals = CARD_APPROVALS.locked();
    approvals.retain(|a| !(a.site == site && a.label == label && a.session == session && a.approved.document == approved.document));
    approvals.push(CardApproval { browser: browser.into(), site: site.into(), label: label.into(), session: session.into(), approved, typed: Vec::new(), filled: false, first_by: now + CARD_FIRST_FILL, until: now + CARD_APPROVAL_LIFE });
}

/// Whether a live yes covers card `label` in `document`, so a fill of another of its fields asks nothing.
pub fn card_approved_here(site: &str, label: &str, session: &str, document: &str) -> bool {
    let now = store::now();
    CARD_APPROVALS.locked().iter().any(|a| a.site == site && a.label == label && a.session == session && a.approved.document == document && a.until > now && (a.filled || a.first_by > now))
}

/// Takes the owner's yes for one fill of card `label` into the page measured as `now`: a live yes for that very
/// document, and every control reading as approved, the fields this card already filled aside.
fn take_card_fill(site: &str, label: &str, session: &str, now: &crate::checkout::Measured) -> Result<(), String> {
    let t = store::now();
    let approvals = CARD_APPROVALS.locked();
    let a = approvals
        .iter()
        .find(|a| a.site == site && a.label == label && a.session == session && a.approved.document == now.document && a.until > t && (a.filled || a.first_by > t))
        .ok_or("the owner hasn't approved paying with this card on this page, or their yes lapsed: use the node's agent API, which asks them again")?;
    let typed: Vec<crate::checkout::CardControl> = approvals.iter().filter(|o| o.session == session && o.approved.document == now.document).flat_map(|o| o.typed.clone()).collect();
    crate::checkout::same_order(&a.approved, now, &typed)
}

/// Notes the controls a fill of card `label` into `document` made the card's (`checkout::filled_by`).
fn note_card_typed(site: &str, label: &str, session: &str, document: &str, filled: Vec<crate::checkout::CardControl>) {
    if let Some(a) = CARD_APPROVALS.locked().iter_mut().find(|a| a.site == site && a.label == label && a.session == session && a.approved.document == document) {
        a.filled = true;
        a.typed.extend(filled);
    }
}

/// Whether the page `session`'s tab of `browser` shows, measured as `now`, may be handed to the owner to submit:
/// every card approved there finds it as approved, the card's own fields aside. `Ok(false)` when no card was approved
/// in this document.
fn as_approved_for_the_owner(browser: &str, session: &str, now: &crate::checkout::Measured) -> Result<bool, String> {
    let approvals = CARD_APPROVALS.locked();
    let here: Vec<&CardApproval> = approvals.iter().filter(|a| a.browser == browser && a.session == session && a.approved.document == now.document).collect();
    if here.is_empty() {
        return Ok(false);
    }
    let typed: Vec<crate::checkout::CardControl> = here.iter().flat_map(|a| a.typed.clone()).collect();
    for a in &here {
        crate::checkout::same_order(&a.approved, now, &typed)?;
    }
    Ok(true)
}

/// Forgets what the owner approved in `browser` (in its tab `tab`, or in all of it): the page it was on is gone.
fn forget_approvals(browser: &str, tab: Option<&str>) {
    CARD_APPROVALS.locked().retain(|a| !(a.browser == browser && tab.is_none_or(|t| tab_of(&a.session) == t)));
}

/// The page `session`'s tab of `site`'s browser shows, measured by the browser (`checkout::measure`), with the site
/// it is on and its address, if it came over https: the only page a card goes into.
pub fn checkout_of(site: &str, session: &str) -> Result<(String, String, crate::checkout::Measured), String> {
    let measured = crate::checkout::measure(site, &tab_of(session))?;
    let u = url::Url::parse(&measured.url).map_err(|_| "open the checkout page first")?;
    let host = u.host_str().ok_or("open the checkout page first")?.to_string();
    if u.scheme() != "https" {
        return Err(format!("this page is on {}://{host}: a card goes only into a page that came over https", u.scheme()));
    }
    Ok((site_of(&host), measured.url.clone(), measured))
}

/// What the owner is told when the page `session`'s tab shows on held `site` is handed to them to submit: measured
/// again now, against what they approved, together with everything noted against the checkout since (`payhold::warn`:
/// a change the page made beside a card fill). `None` for a site with no hold. The page goes to them either way: they
/// are the one who submits it and the one who ends the hold; this says what the node could and couldn't check.
pub fn hand_over_note(site: &str, session: &str) -> Option<String> {
    let hold = crate::payhold::of(site)?;
    let mut said = vec![format!("The node can't vouch for the amount or the order the page shows: check them on the page before you pay. Held for this checkout: {}. Until you say it is finished or dismissed, the agent can't act on any site, its other pages are paused, the node calls no route, and none of the node's other browsers connects anywhere; this page's own browser reaches any host it needs.", crate::payhold::shown(&hold))];
    // Paused again: a page or worker started since the hold began is caught here. What couldn't be is said below.
    for failed in crate::quiet::quiet(target_of(site, &tab_of(session)).as_deref()) {
        crate::payhold::warn(site, &format!("the node couldn't pause one of the agent's other pages or workers ({failed}); it connects nowhere while the checkout waits all the same"));
    }
    let measured = crate::checkout::measure(site, &tab_of(session));
    // What the checkout names now (a host it submitted to since the last look) is held with it too.
    if let Ok(now) = &measured {
        let _ = hold_checkout(site, now);
    }
    let hold = crate::payhold::of(site).unwrap_or(hold);
    match measured {
        Ok(now) => match as_approved_for_the_owner(site, session, &now) {
            Ok(true) => said.push("The form reads as you approved it, apart from the card the node typed.".into()),
            Ok(false) => said.push("The node has no record of what you approved on this page (it may have restarted): check every field.".into()),
            Err(why) => said.push(format!("Warning: {why}. Check every field.")),
        },
        Err(why) => said.push(format!("Warning: the node couldn't measure the page ({why}). Check every field.")),
    }
    said.extend(hold.warnings.iter().map(|w| format!("Warning: {w}.")));
    Some(said.join(" "))
}

/// Fills a card field from the vault into `target`, for `who`, once the owner approved this exact field fill. The node
/// types the value itself, and only into a field whose own frame is on the page's site, or into a payment provider's
/// hosted field: a field marked for a card, in a frame served over https that the checkout page itself holds (the
/// browser checks all three, `interaction::hosted_card_field`). Any other frame from another site inside the checkout
/// gets nothing, and so does a frame inside such a frame. The value goes to the browser over its own socket, never on a
/// command line; the walk record says the reference, and what the browser says back says the reference where the page
/// shows the number, the expiry or the code.
pub fn fill_card(args: &[String], site: Option<&str>, who: &str, session: &str, keys: &dyn unbrowse_core::KeyStore) -> Result<String, String> {
    let settings = store::load_settings();
    if settings.paused {
        return Err(crate::outcome::PAUSED.into());
    }
    let r = card_fill(args).ok_or("fill <target> vault:card:<label>:<field>")?;
    let (site, _) = site_for(args, site, session)?;
    let tab = tab_of(session);
    if let Some(why) = crate::hands::busy(&site) {
        return Err(why);
    }
    excluded(&settings, &site)?;
    no_secret_after_a_script(&site, &tab)?;
    let target = &args[1];
    let (on, page, before) = checkout_of(&site, session)?;
    let document = before.document.clone();
    let keep = crate::vault_keep(Ok(keys))?;
    let value = crate::vault::card_value(&keep, &r, settings.keep_card_codes)?;
    // The number, code and expiry go in under their reference, so the walk record and every request after say it
    // instead. A month, a year or a name goes in as itself: naming it would rename every "12" the record holds.
    let mut cmd = serde_json::json!({ "id": format!("vault-{}", store::now()), "action": "fill", "selector": target, "value": value.as_str(), "site": on, "tab": tab });
    if r.field.is_secret() {
        cmd["as"] = serde_json::json!(r.name());
        // The number, code and expiry go only into an input, never free text or editable content.
        cmd["field"] = serde_json::json!("card");
    }
    let checks = r.field.is_secret();
    if r.field.is_secret() {
        // Held before it is typed, as a vault login is; the number also as the page may show it back, in fours.
        hold_secret(&site, &value, &r.name(), &document, &page);
        if r.field == unbrowse_core::CardField::Number {
            // Every way a page groups the number: what the browser says back says the reference for each, and the
            // browser's walk record names each before the number is typed, so a page that reformats it before posting
            // never leaves its digits there. The browser's own record matches the digits however they are separated;
            // this names them where an older browser doesn't.
            for grouped in card_groupings(&value) {
                hold_secret(&site, &grouped, &r.name(), &document, &page);
                forget(&site, &grouped).map_err(|e| format!("the card wasn't filled: {e}"))?;
            }
        }
        // The expiry also as a hosted card field shows it back, spaced ("MM / YY").
        if r.field == unbrowse_core::CardField::Expiry && value.contains('/') {
            hold_secret(&site, &value.replace('/', " / "), &r.name(), &document, &page);
        }
        // As for a login (`held_then_typed`): read the marks again now the page is held.
        no_secret_after_a_script(&site, &tab)?;
    }
    // The last measurement, the keystrokes and the measurement after them are one turn of the site's browser: no
    // agent command (each takes the same turn, `run`) comes between them.
    let gate = gate(&format!("site:{site}"));
    let turn = take_turn(&gate, &site, "the node filling the owner's card".to_string())?;
    // Measured right before the value goes in: the same document, and every control as the owner approved it, the
    // fields this card already filled aside.
    let (_, _, now) = checkout_of(&site, session)?;
    take_card_fill(&on, &r.label, session, &now).map_err(|why| format!("{why}: nothing was filled ({} on {on})", r.shown().unwrap_or_default()))?;
    let sent = send_now(&site, cmd, std::time::Duration::from_secs(60)).and_then(|said| if checks { checked_field(&said) } else { Ok(said) });
    // Measured again before the turn ends: which control took the value, and whether the page changed anything else
    // as it was typed (its own handlers can). Anything else is told to the owner at the hand-off; the site stays held.
    let after = checkout_of(&site, session).map(|(_, _, after)| after);
    let filled = after.as_ref().map(|after| crate::checkout::filled_by(&now, after, &value, r.field.is_secret())).unwrap_or_default();
    note_card_typed(&on, &r.label, session, &document, filled);
    match &after {
        Ok(after) => {
            if let Err(why) = hold_checkout(&site, after) {
                crate::payhold::warn(&site, &why);
            }
            if let Err(why) = as_approved_for_the_owner(&site, session, after) {
                crate::payhold::warn(&site, &format!("as the card's {} went in, {why}", r.field.name()));
            }
        }
        Err(why) => crate::payhold::warn(&site, &format!("the node couldn't measure the page after the card's {} went in ({why})", r.field.name())),
    }
    drop(turn);
    // A payment provider's frame the checkout holds is named, so the owner reads where their card went.
    let hosted = sent.as_ref().ok().and_then(hosted_in);
    let into = match &hosted {
        Some(origin) => format!("{target}, a field of {origin}'s frame on {on}'s checkout"),
        None => target.to_string(),
    };
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: site.clone(),
        what: format!("Filled {} from {} into {into}", r.field.name(), r.shown()?),
        kind: "vault".into(),
        result: if sent.is_ok() { "done" } else { "failed" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: sent.as_ref().err().map(|e| e.chars().take(200).collect()),
    });
    sent?;
    browsed(session, &site);
    in_front(&site, session);
    // What a request carries of this typing: the reference for a named field, the value itself for the others.
    let mut typed = TYPED.locked();
    typed.push((site, if r.field.is_secret() { r.name() } else { value.to_string() }));
    let n = typed.len();
    if n > TYPED_KEPT {
        typed.drain(..n - TYPED_KEPT);
    }
    Ok(format!("Filled {into} with {}. The site is the owner's now: once the card's fields are in, ask_owner \"submit the payment\" and they check the order and pay on the live page. Nothing else reaches the site until they say the checkout is finished or dismissed.", r.name()))
}

/// The origin of the payment provider's frame a card fill went into, when the browser says it went into one the
/// checkout page holds rather than a field of the page's own site.
fn hosted_in(said: &serde_json::Value) -> Option<String> {
    said.get("frame_origin").and_then(|o| o.as_str()).filter(|o| !o.is_empty()).map(String::from)
}

/// The ways a page may write a card number back with separators: in fours, and as four, six and the rest (the 15- and
/// 14-digit layout), each with a space and with a dash between groups. Derived from the number's length, not from
/// any issuer.
fn card_groupings(number: &str) -> Vec<String> {
    let groups = |sizes: &mut dyn Iterator<Item = usize>| {
        let mut out = Vec::new();
        let mut at = 0;
        for n in sizes {
            if at >= number.len() {
                break;
            }
            let end = (at + n).min(number.len());
            out.push(&number[at..end]);
            at = end;
        }
        if at < number.len() {
            out.push(&number[at..]);
        }
        out
    };
    let mut layouts = vec![groups(&mut std::iter::repeat(4))];
    layouts.push(groups(&mut [4usize, 6].into_iter()));
    let mut all = Vec::new();
    for parts in layouts {
        for sep in [" ", "-"] {
            let g = parts.join(sep);
            if g != number && !all.contains(&g) {
                all.push(g);
            }
        }
    }
    all
}

/// Has `site`'s browser name `value` in its walk record, in what it already wrote and from now on: for a secret the
/// owner typed by hand, or a value the learner found the site only checks. A browser that isn't running has nothing
/// open to rewrite; its record is read again only by the learner, which keeps no secret's value. This is the node's
/// own housekeeping: it never waits behind the agents' commands on the site ([`send_now`]), a browser busy with a
/// long one names it before it writes anything else, and an attempt that fails is tried again. Err says the record
/// may still hold it.
pub fn forget(site: &str, value: &str) -> Result<(), String> {
    let mut last = String::new();
    for wait in [0, 250, 1000] {
        // The file, not `running`: a door nothing answers at may be a browser that hung, so this says the value may
        // still be in the record rather than call it done.
        if !door(site).exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(wait));
        let cmd = serde_json::json!({ "id": format!("forget-{}", store::now()), "action": "capture_forget", "value": value });
        match send_now(site, cmd, FORGET_WAIT) {
            Ok(_) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(format!("{site}'s browser didn't take the value out of its walk record: {last}"))
}

/// How long one try at [`forget`] waits for the browser's answer. A browser busy with another command answers at
/// once (the value is named before it writes anything else), so a wait this long is a browser that hung.
const FORGET_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// One request to a site's browser over its socket, as the CLI sends it, in its turn behind other sessions' commands:
/// for what must never be on a command line.
fn send(site: &str, cmd: serde_json::Value) -> Result<serde_json::Value, String> {
    let gate = gate(&format!("site:{site}"));
    let _turn = take_turn(&gate, site, format!("the node's own `{}`", cmd["action"].as_str().unwrap_or("request")))?;
    send_now(site, cmd, std::time::Duration::from_secs(60))
}

/// One request to a site's browser over its socket now, waiting up to `wait` for its answer: for the node's own
/// housekeeping (a secret to forget, the browser's tabs and DevTools address), which never waits its turn behind
/// the agents' commands. A browser busy with one answers these without waiting for it. Never launches a browser.
fn send_now(site: &str, cmd: serde_json::Value, wait: std::time::Duration) -> Result<serde_json::Value, String> {
    send_at(&door(site), cmd, wait)
}

/// [`send_now`] to the browser answering at the door file `door`.
fn send_at(door: &Path, mut cmd: serde_json::Value, wait: std::time::Duration) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, BufReader, Write};
    cmd["noLaunch"] = serde_json::json!(true);
    let not_running = || "open the login page first: the site's browser isn't running".to_string();
    #[cfg(unix)]
    let mut stream = std::os::unix::net::UnixStream::connect(door).map_err(|_| not_running())?;
    #[cfg(windows)]
    let mut stream = {
        let port: u16 = std::fs::read_to_string(door).ok().and_then(|p| p.trim().parse().ok()).ok_or_else(not_running)?;
        // A daemon that writes a key beside its port file takes a command only with it; upstream's daemon writes none.
        if let Ok(key) = std::fs::read_to_string(door.with_extension("key")) {
            cmd["doorKey"] = serde_json::json!(key.trim());
        }
        std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|_| not_running())?
    };
    let _ = stream.set_read_timeout(Some(wait));
    stream.write_all(format!("{cmd}\n").as_bytes()).map_err(|e| format!("the node's browser didn't take it: {e}"))?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|e| format!("the node's browser didn't answer: {e}"))?;
    let reply: serde_json::Value = serde_json::from_str(&line).map_err(|_| "the node's browser answered with something else".to_string())?;
    if reply["success"].as_bool() == Some(true) {
        Ok(reply["data"].clone())
    } else {
        Err(reply["error"].as_str().unwrap_or("the browser couldn't fill it").to_string())
    }
}

/// The action as the activity log shows it: what was done and where, never what was typed or run.
fn described(args: &[String]) -> String {
    let verb = args.first().map(String::as_str).unwrap_or_default();
    let target = args.get(1).map(String::as_str).unwrap_or_default();
    match verb {
        "fill" | "type" => format!("Typed into {target}"),
        "eval" => "Ran a script on the page".into(),
        "upload" => format!("Uploaded a file to {target}"),
        "open" | "goto" | "navigate" => format!("Opened {}", target.split('?').next().unwrap_or(target)),
        _ if target.is_empty() => format!("Browser: {verb}"),
        _ => format!("Browser: {verb} {target}"),
    }
}

/// Where the node's browsers listen: their own folder, apart from any other agent-browser on this machine.
fn sockets() -> PathBuf {
    store::home().join("browser")
}

/// Where a site's running browser answers: its socket, or on Windows the file holding its port on 127.0.0.1.
fn door(site: &str) -> PathBuf {
    sockets().join(format!("{}.{}", session_of(site), if cfg!(windows) { "port" } else { "sock" }))
}

/// Whether something answers at the door file `file`. The file alone says nothing: a browser that died left it behind.
fn answers(file: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::net::UnixStream::connect(file).is_ok();
    #[cfg(windows)]
    return std::fs::read_to_string(file).ok().and_then(|p| p.trim().parse::<u16>().ok()).is_some_and(|port| std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
}

/// Whether `site`'s browser is running: it answers at its door. Connecting costs a browser nothing, and only a command
/// counts as use of it.
fn running(site: &str) -> bool {
    answers(&door(site))
}

/// Where a site's session keeps the profile its browser runs in, beside its socket in `sockets`.
fn profile_file(sockets: &Path, site: &str) -> PathBuf {
    sockets.join(format!("{}.profile", session_of(site)))
}

/// Has a site's browser run in `profile` from the next command until it is closed. A session already running in a
/// profile keeps it: a page of another host on the same site opens in the browser that is open.
fn runs_in(sockets: &Path, site: &str, profile: &Path) {
    let file = profile_file(sockets, site);
    if !file.exists() {
        let _ = std::fs::create_dir_all(sockets);
        let _ = std::fs::write(&file, profile.to_string_lossy().as_bytes());
    }
}

/// A closed browser is launched afresh by the next page opened.
fn closed(sockets: &Path, site: &str) {
    let _ = std::fs::remove_file(profile_file(sockets, site));
}

/// How a site's browser is launched, given on every command alike: a command that names a launch the browser isn't
/// running relaunches it, and the page it had open is gone. Always in the site's own profile, from `profiles`: the
/// one its first page opened in, else the site's own before any page has (a browser with no profile named would be
/// the one every other profile-less browser on this machine shares).
fn launch(sockets: &Path, profiles: &Path, site: &str) -> Result<Vec<String>, String> {
    let mut switches: Vec<String> = vec!["--disable-blink-features=AutomationControlled".into()];
    // Every connection the browser makes goes through the node's egress rule (`unbrowse_learn::proxy`), so a page an
    // agent opens, a redirect or a script can't take it to this machine, the owner's network or a metadata address.
    // The tunnel carries the browser's own TLS, so a site still reads the browser's handshake. No proxy, no browser:
    // the command is refused rather than launched outside the rule.
    // On a listener of the site's own, so the checkout hold can tell this browser's connections from every other's.
    switches.extend(unbrowse_learn::proxy::switches_for(&site_of(site))?);
    // The CLI takes one value after `--args`, its switches separated by commas: a second argument after it is read as
    // the command, and every command fails ("Unknown command: --proxy-server=…", 13.16.0).
    Ok(vec!["--profile".into(), profile_of(sockets, profiles, site), "--args".into(), switches.join(",")])
}

/// The DevTools address of every site's browser the node runs now: what pausing the agent's pages while a checkout
/// waits reaches (`quiet`).
pub fn devtools_of_running_browsers() -> Vec<String> {
    let mut sites: Vec<String> = OPENED.locked().clone();
    sites.extend(TABS.locked().iter().map(|h| h.site.clone()));
    sites.sort();
    sites.dedup();
    sites.into_iter().filter(|s| running(s)).filter_map(|s| cdp_of(&s)).collect()
}

/// The profile a site's browser runs in: the one its first page opened in, else the site's own.
fn profile_of(sockets: &Path, profiles: &Path, site: &str) -> String {
    match std::fs::read_to_string(profile_file(sockets, site)) {
        Ok(profile) if !profile.trim().is_empty() => profile.trim().to_string(),
        _ => profiles.join(site).to_string_lossy().into_owned(),
    }
}

/// The browser CLI for a site's session. Every command the node gives goes through this, with capture on: the
/// first command starts the session's browser (the one `browsers` picks), and a browser started without capture
/// would record nothing for the node to learn. With a `tab`, the command acts on that tab of the browser, made the
/// first time it is named; without, on whichever tab the browser has in front.
fn cli(site: &str, tab: Option<&str>) -> Result<Command, String> {
    let (dir, sockets) = (capture_dir(), sockets());
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::create_dir_all(&sockets);
    let chromium = crate::browsers::current().ok_or_else(crate::browsers::missing)?;
    // Named whole: the CLI runs in the node's folder, where a relative name would be another file.
    let binary = binary()?;
    let mut cmd = Command::new(std::path::absolute(&binary).unwrap_or(binary));
    unbrowse_learn::mint::on_its_own(&mut cmd, &store::home())?;
    cmd.env("UNBROWSE_CAPTURE_DIR", &dir).env("AGENT_BROWSER_SOCKET_DIR", &sockets).env("AGENT_BROWSER_EXECUTABLE_PATH", chromium);
    in_tab(&mut cmd, tab);
    unbrowse_learn::mint::noted_program_session(&cmd.get_program().to_string_lossy(), &session_of(site), Some(&sockets));
    cmd.args(["--session", &session_of(site)]).args(launch(&sockets, &store::profiles_dir(), site)?);
    Ok(cmd)
}

/// Has the browser run `cmd` in `tab`: the CLI names it on the command (`AGENT_BROWSER_TAB`), and the browser switches
/// to that tab, making it the first time, before running it. Never inherited: `on_its_own` drops what the node was
/// started with.
fn in_tab(cmd: &mut Command, tab: Option<&str>) {
    match tab {
        Some(tab) => cmd.env("AGENT_BROWSER_TAB", tab),
        None => cmd.env_remove("AGENT_BROWSER_TAB"),
    };
}

/// How long a command waits its turn at a site's browser, behind other sessions' commands, before saying it's busy.
const TURN_WAIT: std::time::Duration = std::time::Duration::from_secs(if cfg!(test) { 1 } else { 90 });

/// A turn held this long is written to the node's log with what held it, so a browser found busy can be traced to
/// its holder afterwards.
const LONG_TURN: std::time::Duration = std::time::Duration::from_secs(60);

/// How long the first command of a site's browser, or a walk, waits for another walk working in the site's profile
/// to end before its ask is answered still working (`asks::Ask::hurry`): inside the caller's wait (`asks::DEFAULT_WAIT`)
/// with room for the reply. The wait goes on behind the reply, never into a profile a browser still holds, until the
/// profile is given back or the ask's stop flag is set (its work's wall, `asks::WALL`, or the agent giving up).
pub const LIVE_PROFILE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
const PROFILE_WAIT: std::time::Duration = if cfg!(test) { std::time::Duration::from_millis(300) } else { LIVE_PROFILE_WAIT };

/// How long a wait for a profile that no ask holds (a walk of the node's own) waits before it goes ahead without it,
/// as every wait did before an ask could be answered while it waited.
const UNASKED_PROFILE_WAIT: std::time::Duration = std::time::Duration::from_secs(if cfg!(test) { 2 } else { 120 });

/// How often a wait for a profile looks whether its ask has given up.
const STOP_LOOK: std::time::Duration = std::time::Duration::from_millis(250);

/// One lock per name: a site's browser (`site:<site>`), a profile (`profile:<path>`).
fn gate(name: &str) -> std::sync::Arc<Mutex<()>> {
    static GATES: Mutex<Vec<(String, std::sync::Arc<Mutex<()>>)>> = Mutex::new(Vec::new());
    let mut gates = GATES.locked();
    if let Some((_, g)) = gates.iter().find(|(n, _)| n == name) {
        return g.clone();
    }
    let g = std::sync::Arc::new(Mutex::new(()));
    gates.push((name.to_string(), g.clone()));
    g
}

/// Holds `gate` once it is free, waiting up to `most`.
fn hold(gate: &Mutex<()>, most: std::time::Duration) -> Option<std::sync::MutexGuard<'_, ()>> {
    let since = std::time::Instant::now();
    loop {
        match gate.try_lock() {
            Ok(held) => return Some(held),
            Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
            Err(_) if since.elapsed() < most => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

/// What holds each site's browser now: the site, what holds it (said as a person reads it) and since when. Noted by
/// [`take_turn`] and cleared when the turn ends, so a command that waits too long is told what it waited behind
/// (issue #545: "busy with other sessions' commands" when no other session existed).
static TURNS: Mutex<Vec<(String, String, std::time::Instant)>> = Mutex::new(Vec::new());

/// A site's turn, held: given back when dropped, and what holds it noted until then.
struct Turn<'a> {
    _held: std::sync::MutexGuard<'a, ()>,
    site: String,
}

impl Turn<'_> {
    /// Says what the turn's holder is doing now.
    fn doing(&self, what: String) {
        if let Some(t) = TURNS.locked().iter_mut().find(|t| t.0 == self.site) {
            t.1 = what;
        }
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        let mut turns = TURNS.locked();
        if let Some(at) = turns.iter().position(|t| t.0 == self.site) {
            let (site, what, since) = turns.remove(at);
            if since.elapsed() >= LONG_TURN {
                eprintln!("browser: {what} held {site}'s browser for {} s", since.elapsed().as_secs());
            }
        }
    }
}

/// What holds `site`'s browser and for how long, when a turn is noted for it.
fn holder(site: &str) -> Option<String> {
    TURNS.locked().iter().find(|t| t.0 == site).map(|(_, what, since)| format!("{what}, which has held it {} s", since.elapsed().as_secs()))
}

/// Waits this command's turn at `site`'s browser, for `what` (said as a person reads it). The browser runs one command
/// at a time; waiting here instead of at its socket keeps another session's long command from running out the time
/// this one's answer is given. A command that waits too long is told what holds the browser.
fn take_turn<'a>(gate: &'a Mutex<()>, site: &str, what: String) -> Result<Turn<'a>, String> {
    // A turn's label is said in the log and to whoever waits behind it: never an address's query or fragment.
    let what = unbrowse_learn::identity::said_addresses(&what);
    let Some(held) = hold(gate, TURN_WAIT) else {
        let why = match holder(site) {
            Some(h) => format!("{site}'s browser was busy for {} s with {h}: try again once it ends", TURN_WAIT.as_secs()),
            None => format!("{site}'s browser was busy with another command for {} s: try again shortly", TURN_WAIT.as_secs()),
        };
        eprintln!("browser: {why}");
        return Err(why);
    };
    let mut turns = TURNS.locked();
    turns.retain(|t| t.0 != site);
    turns.push((site.to_string(), what, std::time::Instant::now()));
    Ok(Turn { _held: held, site: site.to_string() })
}

/// Whose command in `tab` of `site`'s browser is, said as a person reads it: an agent's session, the node healing a
/// route, or the node itself (no tab).
fn whose(site: &str, tab: Option<&str>) -> String {
    let Some(tab) = tab else { return "the node itself".into() };
    if tab == heal_tab() {
        return "the node, healing a route".into();
    }
    let session = TABS.locked().iter().find(|h| h.site == site && h.tab == tab).map(|h| h.session.clone());
    match session.as_deref().map(|s| s.split_once(':').unwrap_or(("", s))) {
        Some((agent, "")) if !agent.is_empty() => format!("agent {agent}"),
        Some(("", "")) => "a session".into(),
        Some(("", name)) => format!("session \"{name}\""),
        Some((agent, name)) => format!("agent {agent}'s session \"{name}\""),
        None => "a new session".into(),
    }
}

/// Runs one command of the browser CLI on `site`'s browser, in `tab`, in its turn. The first command, which starts the
/// browser, waits for a walk working in the profile it opens (`hold_profile`): the profile opens in one browser at a
/// time. The command ends when the CLI does, at the latest at its bound (`mint::most_for`), never when the browser or
/// the daemon it left running lets go of its output (`mint::ran`).
fn run<S: AsRef<std::ffi::OsStr>>(site: &str, tab: Option<&str>, args: &[S]) -> Result<std::process::Output, String> {
    let gate = gate(&format!("site:{site}"));
    let verb = args.first().map(|a| a.as_ref().to_string_lossy().into_owned()).unwrap_or_default();
    let what = format!("`{verb}` for {}", whose(site, tab));
    let turn = take_turn(&gate, site, what.clone())?;
    let _profile = (!running(site)).then(|| {
        let profile = launch_profile(site);
        if let Some(walk) = profile_holder(&profile) {
            turn.doing(format!("{what}, waiting for {walk} to give the site's profile back"));
        }
        hold_profile(&profile, &what)
    });
    turn.doing(what.clone());
    let mut cmd = cli(site, tab)?;
    cmd.args(args);
    unbrowse_learn::mint::ran(cmd, unbrowse_learn::mint::most_for(args)).map_err(|e| format!("the node's browser didn't run {what}: {e}"))
}

/// The profile `site`'s browser runs in, or starts in.
fn launch_profile(site: &str) -> PathBuf {
    PathBuf::from(profile_of(&sockets(), &store::profiles_dir(), site))
}

/// The profiles held now by a browser launched in them (`hold_profile`), each with what holds it and since when.
static PROFILES: Mutex<Vec<(PathBuf, String, std::time::Instant)>> = Mutex::new(Vec::new());
static PROFILE_FREED: std::sync::Condvar = std::sync::Condvar::new();

/// Holds the profile at `profile` for `what` (said as a person reads it) while a browser launched in it works: a walk
/// (`learn::walk_as`), or a site's browser while it starts. Another that wants the profile waits for it instead of
/// failing on the profile's lock. One working for an ask has its ask answered still working once it has waited
/// `PROFILE_WAIT`, and waits on until the profile is given back or its ask's stop flag is set: it never goes ahead into
/// a profile a browser still holds. One working for no ask goes ahead after `UNASKED_PROFILE_WAIT`, as it did.
pub fn hold_profile(profile: &Path, what: &str) -> ProfileHeld {
    // What holds a profile is said in the log and to whoever waits: never an address's query or fragment.
    let what = &unbrowse_learn::identity::said_addresses(what);
    let since = std::time::Instant::now();
    let mut held = PROFILES.locked();
    // A wait is said once, with who is waited for: a walk that sits behind another for two minutes otherwise reads as a
    // slow site, and nothing in the log says the browser was never asked.
    let mut said = false;
    let mut hurried = false;
    let ask = unbrowse_learn::mint::stop_flag().and_then(|s| crate::api::asks::by_stop(&s));
    while let Some((_, holder, held_since)) = held.iter().find(|p| p.0 == profile) {
        if !said {
            eprintln!("   [profile] {what} waits for {holder} ({} s so far) to give the profile back", held_since.elapsed().as_secs());
            said = true;
        }
        // An ask that has given up waits no more: its walk will stop at once, and the profile is not its to take.
        if unbrowse_learn::mint::asked_to_stop() {
            eprintln!("   [profile] {what} stops waiting after {} s: its ask gave up", since.elapsed().as_secs());
            return ProfileHeld(None);
        }
        match &ask {
            // Its caller hears it is still working, and the wait goes on behind the reply.
            Some(ask) if !hurried && since.elapsed() >= PROFILE_WAIT => {
                eprintln!("   [profile] {what} has waited {} s for {holder}: its ask is answered still working, and it waits on", since.elapsed().as_secs());
                ask.set_phase("waiting for the site's profile, which another walk holds");
                ask.hurry("ask.profile");
                hurried = true;
            }
            None if since.elapsed() >= UNASKED_PROFILE_WAIT => {
                eprintln!("   [profile] {what} waited {} s and goes ahead without it: {holder} still holds the profile", since.elapsed().as_secs());
                return ProfileHeld(None);
            }
            _ => {}
        }
        held = PROFILE_FREED.wait_timeout(held, STOP_LOOK).unwrap_or_else(|p| p.into_inner()).0;
    }
    if said {
        eprintln!("   [profile] {what} has the profile after {} s", since.elapsed().as_secs());
    }
    held.push((profile.to_path_buf(), what.to_string(), std::time::Instant::now()));
    ProfileHeld(Some(profile.to_path_buf()))
}

/// Holds the profile at `profile` for `what` as [`hold_profile`] does, only when nothing holds it now: one that is held
/// is in use, and the caller leaves it, never waits for it (`prune`).
pub fn try_hold_profile(profile: &Path, what: &str) -> Option<ProfileHeld> {
    let mut held = PROFILES.locked();
    if held.iter().any(|p| p.0 == profile) {
        return None;
    }
    held.push((profile.to_path_buf(), what.to_string(), std::time::Instant::now()));
    Some(ProfileHeld(Some(profile.to_path_buf())))
}

/// What holds the profile at `profile` and for how long, when something does.
pub(crate) fn profile_holder(profile: &Path) -> Option<String> {
    PROFILES.locked().iter().find(|p| p.0 == profile).map(|(_, what, since)| format!("{what} ({} s so far)", since.elapsed().as_secs()))
}

/// A profile held by [`hold_profile`], given back when dropped.
pub struct ProfileHeld(Option<PathBuf>);

impl Drop for ProfileHeld {
    fn drop(&mut self) {
        if let Some(profile) = self.0.take() {
            let mut held = PROFILES.locked();
            if let Some(at) = held.iter().position(|p| p.0 == profile) {
                held.remove(at);
            }
            PROFILE_FREED.notify_all();
        }
    }
}

/// The DevTools address of a browser already running in the profile at `profile`, if one is: the node's browser for
/// the site, else any other the profile is open in (one a walk left open for a person), found by the address the
/// browser writes into its profile. A walk works in it, in a tab of its own, since the profile opens in one browser at
/// a time.
pub fn browser_in(host: &str, profile: &Path) -> Option<String> {
    cdp_of(host).or_else(|| listening_in(profile))
}

/// The DevTools address the browser running in `profile` wrote there (`DevToolsActivePort`: its port, then its
/// path), when a browser answers at it as that one.
pub(crate) fn listening_in(profile: &Path) -> Option<String> {
    use std::io::{Read, Write};
    let written = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = written.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim().to_string();
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).ok()?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
    stream.write_all(format!("GET /json/version HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).ok()?;
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    let ws = format!("ws://127.0.0.1:{port}{path}");
    // Another process that took the port since answers with another browser's address, or none.
    answer.contains(&path).then_some(ws)
}

/// The tabs `site`'s browser has open, as it lists them (`label`, `targetId`, `url`, `title`). Asking never starts a
/// browser.
fn tabs(site: &str) -> Option<Vec<serde_json::Value>> {
    if !running(site) {
        return None;
    }
    let data = send_now(site, serde_json::json!({ "id": format!("tabs-{}", store::now()), "action": "tab_list" }), ASK_WAIT).ok()?;
    data.get("tabs")?.as_array().cloned()
}

/// How long the node's own questions to a browser (its tabs, its DevTools address) wait for an answer. A browser busy
/// with an agent's command answers them as they were after its last one.
const ASK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The labels of the tabs `site`'s browser has open: the sessions' tabs.
fn tab_labels(site: &str) -> Option<Vec<String>> {
    Some(tabs(site)?.iter().filter_map(|t| t["label"].as_str().map(String::from)).collect())
}

/// What `site`'s browser says of the tab named `tab` (its `targetId`, `url`, `title`), when it has one. Asking never
/// starts a browser, nor makes the tab.
fn tab_info(site: &str, tab: &str) -> Option<serde_json::Value> {
    tabs(site)?.into_iter().find(|t| t["label"] == tab)
}

/// The DevTools target of the tab named `tab` in `site`'s browser, when it has one: the page the owner's window shows
/// for the session that tab is.
pub fn target_of(site: &str, tab: &str) -> Option<String> {
    tab_info(site, tab)?["targetId"].as_str().map(String::from)
}

/// The browser's own answer about the cookies it holds for a site, as it gave it: their values, domains, paths and
/// which are HttpOnly, the session a route learned from this browsing runs with. Empty when no browser of the site is
/// running: asking never starts one.
pub fn cookies_answer(site: &str) -> String {
    if !running(site) {
        return String::new();
    }
    let Ok(out) = run(site, None, &["--json", "cookies", "get"]) else { return String::new() };
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Every cookie value the cookie store of each of the node's running site browsers holds, HttpOnly or not, whatever
/// its domain: what the node holds as the sites' sessions, read now (`session_held`). The browser's own store is asked
/// (`Storage.getCookies` at its DevTools address), not a page, which holds only what it can send. The browsers are
/// asked at once, and all of them within [`ASK_WAIT`]: one that answers at its door but whose cookies aren't read by
/// then fails the whole, since its session can't be hidden.
pub(crate) fn session_cookies() -> Result<Vec<String>, String> {
    // No browser folder is no browser running; one that is there and can't be read may hold running browsers whose
    // sessions can't be hidden.
    let dir = match std::fs::read_dir(sockets()) {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("the node couldn't list its running browsers ({e}), so it can't keep their sessions out of this answer")),
    };
    let entries: Vec<std::fs::DirEntry> = dir.collect::<Result<_, _>>().map_err(|e| format!("the node couldn't list its running browsers ({e}), so it can't keep their sessions out of this answer"))?;
    let doors: Vec<PathBuf> = entries
        .into_iter()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some(if cfg!(windows) { "port" } else { "sock" }) && answers(p))
        .collect();
    if doors.is_empty() {
        return Ok(Vec::new());
    }
    let unread = |e: String| format!("the node couldn't read what a running browser holds as a site's session ({e}), so it can't keep it out of this answer");
    let (tx, rx) = std::sync::mpsc::channel();
    let started = std::time::Instant::now();
    let asked = doors.len();
    for door in doors {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let read = match send_at(&door, serde_json::json!({ "id": format!("cdp-{}", store::now()), "action": "cdp_url" }), ASK_WAIT) {
                // A browser's daemon whose browser never started, or went (a cancelled ask can leave one, core #643),
                // holds no session to keep out: it is passed over, where it used to fail every answer.
                Err(e) if e == NOT_LAUNCHED => Ok(Vec::new()),
                read => read.and_then(|data| {
                    let ws = data.get("cdpUrl").and_then(|u| u.as_str()).filter(|u| u.starts_with("ws")).ok_or_else(|| "no DevTools address".to_string())?.to_string();
                    // A daemon whose browser is gone (it crashed or was killed, and its daemon lived on) gives a
                    // DevTools address on this machine that nothing listens at: no browser holds a session there, so
                    // it is passed over too. Left to fail, one dead site browser failed every agent's every answer
                    // until someone closed it (audit 1118 N2). A browser that listens but can't be read still fails.
                    if gone_at(&ws) {
                        return Ok(Vec::new());
                    }
                    cookie_values_at(&ws)
                }),
            };
            let _ = tx.send(read);
        });
    }
    drop(tx);
    let mut out = Vec::new();
    for _ in 0..asked {
        let left = ASK_WAIT.saturating_sub(started.elapsed());
        match rx.recv_timeout(left) {
            Ok(Ok(values)) => out.extend(values),
            Ok(Err(e)) => return Err(unread(e)),
            Err(_) => return Err(unread(format!("it didn't answer within {} s", ASK_WAIT.as_secs()))),
        }
    }
    Ok(out)
}

/// What a browser's daemon says when it has no browser (`unbrowse-browser`'s `native/actions.rs`).
const NOT_LAUNCHED: &str = "Browser not launched";

/// Whether the browser at the DevTools address `ws` is gone: the address is this machine's own and refuses a
/// connection, so no browser listens there. Anything less certain (another host, no answer in time, a connection
/// taken) is not gone, and the caller reads it as a live browser.
fn gone_at(ws: &str) -> bool {
    let Ok(u) = url::Url::parse(ws) else { return false };
    let Some(port) = u.port_or_known_default() else { return false };
    let ip = match u.host() {
        Some(url::Host::Ipv4(ip)) => std::net::IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => std::net::IpAddr::V6(ip),
        Some(url::Host::Domain("localhost")) => std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        _ => return false,
    };
    ip.is_loopback() && std::net::TcpStream::connect_timeout(&(ip, port).into(), std::time::Duration::from_secs(2)).is_err_and(|e| e.kind() == std::io::ErrorKind::ConnectionRefused)
}

/// The value of every cookie the browser at the DevTools address `ws` holds (`Storage.getCookies`), asked on a thread
/// of its own so a caller inside the node's runtime can wait for it.
pub(crate) fn cookie_values_at(ws: &str) -> Result<Vec<String>, String> {
    let ws = ws.to_string();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let cdp = agent_browser_core::cdp::client::CdpClient::connect(&ws).await.map_err(|e| e.to_string())?;
            let said = tokio::time::timeout(ASK_WAIT, cdp.send_command("Storage.getCookies", None, None)).await.map_err(|_| "it didn't answer".to_string())??;
            cookie_values_of(&said)
        })
    })
    .join()
    .map_err(|_| "the read stopped".to_string())?
}

/// The values in a browser's answer to which cookies it holds, read by the one reader of that answer
/// (`mint::browser_cookie_list`: a list of cookies, each with a name, a value and a domain as text). An answer of any
/// other shape is the browser not saying, never a browser that holds nothing: an error, and the answer to the agent
/// isn't given.
fn cookie_values_of(said: &serde_json::Value) -> Result<Vec<String>, String> {
    let list = unbrowse_learn::mint::browser_cookie_list(&said.to_string()).ok_or("its answer wasn't a list of cookies")?;
    Ok(list.iter().filter_map(|c| c["value"].as_str().map(String::from)).collect())
}

/// The DevTools address of the node's browser for a site, when one is running: a walk or a heal on that site
/// works in it, since the site's profile can only be open in one browser at a time.
///
/// The node's own question: it never waits behind the agents' commands on the site ([`send_now`]).
pub fn cdp_of(site: &str) -> Option<String> {
    let site = site_of(site);
    if !running(&site) {
        return None;
    }
    let data = send_now(&site, serde_json::json!({ "id": format!("cdp-{}", store::now()), "action": "cdp_url" }), ASK_WAIT).ok()?;
    data.get("cdpUrl").and_then(|u| u.as_str()).filter(|u| u.starts_with("ws")).map(String::from)
}

/// The profile the node's browser for a site is running in, when one is running: a profile is open in one browser at
/// a time, so anything else that writes to it goes through that browser.
pub fn profile_in_use(site: &str) -> Option<PathBuf> {
    let site = site_of(site);
    if !running(&site) {
        return None;
    }
    let p = std::fs::read_to_string(profile_file(&sockets(), &site)).ok()?;
    (!p.trim().is_empty()).then(|| PathBuf::from(p.trim()))
}

/// The sites with a browser open that agents opened, oldest first.
pub fn open_sites() -> Vec<String> {
    OPENED.locked().iter().filter(|s| running(s)).cloned().collect()
}

/// The address of the page open in `tab` of `site`'s browser, else in the tab it has in front. Asking never starts
/// a browser that isn't running, nor makes the tab.
pub fn page_url(site: &str, tab: Option<&str>) -> Option<String> {
    if !running(site) {
        return None;
    }
    let url = match tab {
        Some(tab) => tab_info(site, tab)?["url"].as_str()?.to_string(),
        None => {
            let out = run(site, None, &["get", "url"]).ok().filter(|o| o.status.success())?;
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
    };
    url.starts_with("http").then_some(url)
}

/// What `tab` of `site`'s browser shows: the page's address, and its readable text (the body's) with the state of its
/// controls (what is checked, selected, typed: the snapshot's), compared by a digest. A click on a radio or a box
/// changes no text, only a control's state. None when the browser can't say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Look {
    pub url: String,
    pub content: u64,
}

/// What `tab` of `site`'s browser shows now. Asking never starts a browser that isn't running.
pub fn look(site: &str, tab: &str) -> Option<Look> {
    use std::hash::{Hash, Hasher};
    let url = page_url(site, Some(tab))?;
    let out = run(site, Some(tab), &["get", "text", "body"]).ok().filter(|o| o.status.success())?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    String::from_utf8_lossy(&out.stdout).split_whitespace().for_each(|w| w.hash(&mut h));
    if let Some(controls) = run(site, Some(tab), &["snapshot", "-i"]).ok().filter(|o| o.status.success()) {
        controls_state(&String::from_utf8_lossy(&controls.stdout)).hash(&mut h);
    }
    Some(Look { url, content: h.finish() })
}

/// The state of a page's controls, from its interactive snapshot (`snapshot -i`), without the refs the browser numbers
/// them by: the same controls in the same state read the same, whatever refs a new snapshot hands out.
fn controls_state(snapshot: &str) -> String {
    snapshot
        .lines()
        .map(|l| {
            let mut out = String::new();
            let mut rest = l;
            while let Some(at) = rest.find("ref=") {
                out.push_str(&rest[..at]);
                rest = rest[at..].trim_start_matches("ref=").trim_start_matches(|c: char| c.is_alphanumeric());
            }
            out.push_str(rest);
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a step came to, read from the walk: what it asked for, against what landed.
#[derive(Debug, PartialEq, Eq)]
pub enum Came {
    /// It did something: the page went somewhere or showed something else.
    Done,
    /// A click that changed nothing: the same address, the same content. A signed-out page often leaves a control
    /// for its members that way (a list's next page), with nothing to say why.
    Unchanged,
    /// The site sent the page elsewhere instead of the one asked for, naming it to come back to (`answer::detour`):
    /// a sign-in, a wall.
    Walled { at: String },
    /// The page landed on isn't there: its document answered an error (`status` 400 and up), or none came at all
    /// (`status` 0: the browser's own page for a site it couldn't reach).
    Gone { status: u16 },
    /// The page landed on asks for a person: a door that only waits on its own code, or a check's widget
    /// (`page::a_door`, `challenge::asks_a_person`).
    Check { at: String },
    /// The page landed on is another than the one asked for, and asks for a password (`answer::sent_to_sign_in`).
    SignIn { at: String },
    /// The page asked for, carrying a check for a person among its own content (`challenge::a_page_with_a_check`):
    /// done, and said to carry it.
    CarriesCheck { at: String },
}

/// What a step of `verb` came to: `asked` is the page it opened (for open, goto and navigate), `before` and `after`
/// what the tab showed around it. A step that landed on a page naming the one it was on or asked for, to come back
/// to, was walled; a click after which the tab shows the same address and the same content changed nothing. Anything
/// the browser couldn't say counts as done, as the browser said.
pub fn came_to(verb: &str, asked: Option<&str>, before: Option<&Look>, after: Option<&Look>) -> Came {
    let Some(after) = after else { return Came::Done };
    let Ok(landed) = url::Url::parse(&after.url) else { return Came::Done };
    let wanted = asked.map(String::from).or_else(|| before.map(|b| b.url.clone()));
    if let Some(wanted) = wanted.and_then(|w| url::Url::parse(&w).ok()) {
        if unbrowse_learn::answer::detour(&wanted, &landed) {
            return Came::Walled { at: after.url.clone() };
        }
    }
    match before {
        Some(b) if matches!(verb, "click" | "dblclick") && b == after => Came::Unchanged,
        _ => Came::Done,
    }
}

/// What a step came to, reading the main document it landed on (`landed`, from the step's own lines of the browsing
/// log) before the addresses: a document that answered an error or never came is gone; one that asks for a person is
/// a check; one on another page than asked, asking for a password, a sign-in. With no document read, the addresses
/// say it (`came_to`).
pub fn came_to_page(verb: &str, asked: Option<&str>, before: Option<&Look>, after: Option<&Look>, landed: Option<&unbrowse_learn::trace::Exchange>) -> Came {
    let Some(doc) = landed else { return came_to(verb, asked, before, after) };
    let body = doc.response_body.as_deref().unwrap_or_default();
    if doc.status == 0 {
        return Came::Gone { status: 0 };
    }
    // An error the site answered with a status no door uses while it decides (`trace::REFUSED`) is the site's own
    // answer, whatever the page carries beside it: another site's frame on an error page is not a check's widget.
    if doc.status >= 400 && !unbrowse_learn::trace::REFUSED.contains(&doc.status) {
        return Came::Gone { status: doc.status };
    }
    if unbrowse_learn::page::a_door(doc.status, body, &doc.url) || unbrowse_learn::challenge::asks_a_person(body, &doc.url) {
        // The page itself, with a check among its own content (a form with a person check before its submit):
        // the page asked for, said as carrying a check.
        if unbrowse_learn::challenge::a_page_with_a_check(body, &doc.url) && doc.status < 400 {
            return match came_to(verb, asked, before, after) {
                Came::Done => Came::CarriesCheck { at: doc.url.to_string() },
                other => other,
            };
        }
        return Came::Check { at: doc.url.to_string() };
    }
    if doc.status >= 400 {
        return Came::Gone { status: doc.status };
    }
    match came_to(verb, asked, before, after) {
        Came::Done => {
            let wanted = asked.map(String::from).or_else(|| before.map(|b| b.url.clone())).and_then(|w| url::Url::parse(&w).ok());
            match wanted {
                Some(wanted) if unbrowse_learn::answer::sent_to_sign_in(&wanted, doc) => Came::SignIn { at: doc.url.to_string() },
                _ => Came::Done,
            }
        }
        other => other,
    }
}

/// The browsing log's lines of one kind: exchanges, each with its top-level resource type.
fn exchange_lines(lines: &str) -> impl Iterator<Item = (String, serde_json::Value)> + '_ {
    lines.lines().filter(|l| l.contains("\"exchange\"")).filter_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        (v["type"] == "exchange").then(|| (v["resourceType"].as_str().or(v["entry"]["_resourceType"].as_str()).unwrap_or_default().to_string(), v))
    })
}

/// The file a step downloaded, when it did. The browser says so itself (a `download` line of the browsing log, with
/// the name it saves the file under): it never finishes loading a download as an answer, so a live download leaves no
/// exchange. Failing that, an answer the site sent as an attachment (`Content-Disposition: attachment`), named as the
/// site named it, else by the last piece of its address. A click that sets one off leaves the page as it was, and is
/// done, not a control that did nothing.
pub fn downloaded_in(lines: &str) -> Option<String> {
    let last_piece = |address: &str| url::Url::parse(address).ok()?.path_segments()?.next_back().filter(|s| !s.is_empty()).map(String::from);
    let said = lines.lines().filter(|l| l.contains("\"download\"")).find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        (v["type"] == "download").then(|| {
            let named = v["name"].as_str().filter(|n| !n.is_empty()).map(String::from);
            named.or_else(|| last_piece(v["url"].as_str()?)).unwrap_or_else(|| "a file".into())
        })
    });
    if said.is_some() {
        return said;
    }
    exchange_lines(lines).find_map(|(_, v)| {
        let headers = v["entry"]["response"]["headers"].as_array()?;
        let disposition = headers.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case("content-disposition")))?["value"].as_str()?.to_string();
        if !disposition.trim_start().to_ascii_lowercase().starts_with("attachment") {
            return None;
        }
        let named = disposition.split(';').map(str::trim).find_map(|p| p.strip_prefix("filename=").map(|f| f.trim_matches('"').to_string())).filter(|f| !f.is_empty());
        let by_address = || {
            let url = url::Url::parse(v["entry"]["request"]["url"].as_str()?).ok()?;
            url.path_segments()?.next_back().filter(|s| !s.is_empty()).map(String::from)
        };
        Some(named.or_else(by_address).unwrap_or_else(|| "a file".into()))
    })
}

/// The main document at `at` among a step's lines of the browsing log, the last one if it was loaded more than once:
/// the page the step landed on, with its status and body. A frame's document at another address is not it.
pub fn landed_in(lines: &str, at: &str) -> Option<unbrowse_learn::trace::Exchange> {
    let bare = |u: &str| url::Url::parse(u).ok().map(|mut u| {
        u.set_fragment(None);
        u
    });
    let at = bare(at)?;
    exchange_lines(lines)
        .filter(|(kind, v)| kind == "Document" && v["entry"]["request"]["url"].as_str().and_then(bare).as_ref() == Some(&at))
        .last()
        .and_then(|(_, v)| unbrowse_learn::session::Session::from_log(&v.to_string()).ok()?.trace.exchanges.pop())
        .filter(|e| e.resource_type.is_none() || e.is_main_document())
}

/// Whether a step's lines of the browsing log hold a request sent from a script (a fetch or an XHR): for an eval, a
/// request the agent's own script may have sent.
pub fn sent_a_request(lines: &str) -> bool {
    exchange_lines(lines).any(|(kind, _)| matches!(kind.as_str(), "Fetch" | "XHR"))
}

/// Whether a step's lines hold a request sent from a script in `tab`: the site's tabs share one browsing log, and the
/// browser program names on each line the tab whose page sent it. A line naming no tab is a frame's or a worker's, not
/// the tab's script; lines from a program that names none at all are read as before (`sent_a_request`).
pub fn sent_a_request_in(lines: &str, tab: &str) -> bool {
    match exchange_lines(lines).any(|(_, v)| v.get("tab").is_some()) {
        true => exchange_lines(lines).any(|(kind, v)| matches!(kind.as_str(), "Fetch" | "XHR") && v["tab"] == tab),
        false => sent_a_request(lines),
    }
}

/// The longest an eval's reply looks for a request its script sent: the browser program writes a finished request
/// once it has settled (`SETTLE`, 750 ms: Chrome may report the headers it sent after the answer) and on its next tick
/// (100 ms), so a fetch the script already had its answer to is not in the log when the eval returns.
pub const SCRIPT_SENT_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);

/// Whether `found` holds, looked at again every 50 ms (`pause`) until it does or `most` has been paused in all.
pub fn holds_within(found: impl Fn() -> bool, most: std::time::Duration, mut pause: impl FnMut(std::time::Duration)) -> bool {
    let step = std::time::Duration::from_millis(50);
    let mut paused = std::time::Duration::ZERO;
    loop {
        if found() {
            return true;
        }
        if paused + step > most {
            return false;
        }
        pause(step);
        paused += step;
    }
}

/// Whether a script run in `tab` on `site` since `mark` sent a request (a fetch or an XHR), looked for as long as the
/// browser program takes to write one (`SCRIPT_SENT_WAIT`), and no longer once one is there. Another tab's requests,
/// and a frame's, are not this script's (`sent_a_request_in`).
pub fn script_sent(site: &str, tab: &str, mark: u64) -> bool {
    holds_within(|| sent_a_request_in(&lines_since(site, mark), tab), SCRIPT_SENT_WAIT, std::thread::sleep)
}

/// Where `site`'s browsing log ends now: a step's own lines are the ones after it.
pub fn log_mark(site: &str) -> u64 {
    std::fs::metadata(capture_dir().join(format!("{}.jsonl", session_of(site)))).map(|m| m.len()).unwrap_or(0)
}

/// The whole lines `site`'s browsing log gained since `mark`.
pub fn lines_since(site: &str, mark: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let mut bytes = Vec::new();
    if let Ok(mut f) = std::fs::File::open(capture_dir().join(format!("{}.jsonl", session_of(site)))) {
        if f.seek(SeekFrom::Start(mark)).is_ok() {
            let _ = f.read_to_end(&mut bytes);
        }
    }
    let whole = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |end| end + 1);
    String::from_utf8_lossy(&bytes[..whole]).into_owned()
}

/// The longest a step that navigated waits for its landed document's line, past the moment its command returned: the
/// program returns once the page has loaded, so the line is there already or being written. It is looked for again
/// only while the browsing log is still being written (`LOOK_EVERY`), and never past this.
pub const LANDED_WAIT: std::time::Duration = std::time::Duration::from_millis(200);

/// How often a step that navigated looks again for its landed document, and how lately the log must have been written
/// to count as still being written.
const LOOK_EVERY: std::time::Duration = std::time::Duration::from_millis(25);

/// What `read` finds, looked for again (every `LOOK_EVERY`, at most `LANDED_WAIT` in all) only while `writing` says the
/// log is still being written: a log that is complete when the command returns is read once, and nothing waits. The
/// answer, and how many times it paused.
pub fn read_while_written<T>(read: impl Fn() -> Option<T>, mut writing: impl FnMut() -> bool, mut pause: impl FnMut(std::time::Duration)) -> (Option<T>, u32) {
    let mut looks = 0u32;
    loop {
        if let Some(found) = read() {
            return (Some(found), looks);
        }
        if LOOK_EVERY * (looks + 1) > LANDED_WAIT || !writing() {
            return (None, looks);
        }
        pause(LOOK_EVERY);
        looks += 1;
    }
}

/// Whether `site`'s browsing log was written within the last two looks: the browser is still writing what it finished.
fn log_being_written(site: &str) -> bool {
    std::fs::metadata(capture_dir().join(format!("{}.jsonl", session_of(site))))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|ago| ago < LOOK_EVERY * 2)
}

/// What `read` finds in the lines `site`'s browsing log gained since `mark`, for a step that navigated: read when its
/// command returns, and again only while the log is still being written, for at most `LANDED_WAIT`.
pub fn landed_read<T>(site: &str, mark: u64, read: impl Fn(&str) -> Option<T>) -> Option<T> {
    read_while_written(|| read(&lines_since(site, mark)), || log_being_written(site), std::thread::sleep).0
}

/// The longest an open waits on a page that only waits on its own code (`page::a_door`, and no check for a person on
/// it): such a page runs its script and moves on by itself, most within a second or two, to the page the site answers.
/// An open that replied on it would call the door the page, or a check that never asked anyone anything.
pub const DOOR_PASSES_WITHIN: std::time::Duration = std::time::Duration::from_secs(8);

/// The longest an open looks for its landed document when its lines hold none yet: the program may return before the
/// browser has written the document it loaded.
pub const LANDED_FIRST_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

/// How often an open looks again at where it landed, while it waits (`landed_settled`).
const SETTLE_LOOK: std::time::Duration = std::time::Duration::from_millis(250);

/// Whether a landed document is a page that only waits on its own code: a door (`page::a_door`) with no check for a
/// person on it, and an answer that came (a document that got no status is a page that never loaded, not a door).
pub fn waits_on_its_own_code(doc: &unbrowse_learn::trace::Exchange) -> bool {
    let body = doc.response_body.as_deref().unwrap_or_default();
    doc.status != 0 && unbrowse_learn::page::a_door(doc.status, body, &doc.url) && !unbrowse_learn::challenge::shows_a_widget(body, &doc.url)
}

/// Where a step that navigated landed, read (`read`: what the tab shows, and the document it landed on) until it is a
/// page: looked at again every `SETTLE_LOOK` while no document is in the step's lines (at most `LANDED_FIRST_WAIT`), and
/// while the document is a page that only waits on its own code (at most `DOOR_PASSES_WITHIN`). What it read last, and
/// how many times it paused. The pauses are the caller's (`pause`), so a test counts them.
pub fn landed_settled<T>(mut read: impl FnMut() -> (T, Option<unbrowse_learn::trace::Exchange>), mut pause: impl FnMut(std::time::Duration)) -> (T, Option<unbrowse_learn::trace::Exchange>, u32) {
    let mut looks = 0u32;
    loop {
        let (tab, doc) = read();
        let waited = SETTLE_LOOK * looks;
        let again = match &doc {
            None => waited < LANDED_FIRST_WAIT,
            Some(d) => waits_on_its_own_code(d) && waited < DOOR_PASSES_WITHIN,
        };
        if !again {
            return (tab, doc, looks);
        }
        pause(SETTLE_LOOK);
        looks += 1;
    }
}

/// What a step says of the page it landed on, as the browser program says it (a tick, the page's title, its address),
/// read from the landed document: for a step whose program returned on another document (a door it waited past).
pub fn landed_said(doc: &unbrowse_learn::trace::Exchange) -> String {
    let page = unbrowse_learn::page::read(doc.response_body.as_deref().unwrap_or_default(), &doc.url);
    format!("✓ {}\n  {}", page["title"].as_str().unwrap_or_default().trim(), doc.url)
}

/// Whether a navigation's error says the browser never got the page from the site: Chrome's own network error for
/// it (`net::ERR_…`: no address, refused, reset, no proxy tunnel, a certificate it won't trust). One the browser
/// aborted itself, for a newer navigation, is not one: the page went on elsewhere.
pub fn never_reached(error: &str) -> bool {
    error.contains("net::ERR_") && !error.contains("net::ERR_ABORTED")
}

/// The site `session` browsed last, if any.
pub fn last_site(session: &str) -> Option<String> {
    LAST.locked().iter().find(|(w, _)| w == session).map(|(_, s)| s.clone())
}

#[cfg(test)]
mod tests {
    /// External security review (round 4 follow-up, untangle 2026-11-06): every check of where a script ran fails
    /// closed the same way. A holds file that couldn't be read, or a page a scripted tab opened, counts for a tab the
    /// node fills a secret into, a tab it hands the owner, and the page the owner's window types into alike.
    #[test]
    fn every_scope_fails_closed_on_unreadable_holds_and_a_scripted_tabs_popup() {
        let page = |t: &str| (t == "t-1").then(|| "T-1".to_string());
        let none: [String; 0] = [];
        for scope in [Scope::Tab("t-2"), Scope::Page("T-2")] {
            assert!(!may_have_run(false, &none, scope, page), "nothing ran");
            assert!(may_have_run(true, &none, scope, page), "the holds couldn't be read");
            assert!(may_have_run(false, &[OPENED_BY_A_SCRIPT.to_string()], scope, page), "a popup a scripted tab opened is open");
            assert!(!may_have_run(false, &["t-1".to_string()], scope, page), "another tab, on another page");
        }
        assert!(may_have_run(false, &["t-2".to_string()], Scope::Tab("t-2"), page), "this tab");
        assert!(may_have_run(false, &["t-3".to_string()], Scope::Page("T-2"), page), "a scripted tab whose page can't be named");
    }

    /// A click on a radio or a box changes what the page's controls hold, not its text: read without their refs, the
    /// snapshot tells the two apart, and two snapshots of the same state read the same whatever refs they hand out.
    #[test]
    fn a_control_that_changed_state_is_a_change() {
        let before = "- radio \"Small\" [checked=false, ref=e5]\n- radio \"Large\" [checked=false, ref=e7]";
        let after = "- radio \"Small\" [checked=false, ref=e5]\n- radio \"Large\" [checked=true, ref=e7]";
        let renumbered = "- radio \"Small\" [checked=false, ref=e15]\n- radio \"Large\" [checked=false, ref=e17]";
        assert_ne!(controls_state(before), controls_state(after));
        assert_eq!(controls_state(before), controls_state(renumbered));
    }

    /// A walled step (a call the site answers 403) runs in the browser by shelling out to the node's browser program:
    /// it is named by a file that exists, never by the in-process engine's placeholder, which no machine can run.
    #[test]
    fn a_walled_step_runs_a_browser_program_that_exists() {
        match binary() {
            Ok(_) => {
                let program = step_program().expect("a program");
                assert!(std::path::Path::new(&program).is_file() && std::path::Path::new(&program).is_absolute(), "{program}");
                assert_ne!(program, "in-process");
            }
            Err(_) => assert!(step_program().is_none()),
        }
    }

    /// The walk that exposed it: a company's reviews, signed out. Clicking the list's Next left the page as it was
    /// (the same address, the same "Viewing 1 - 3 of 52"), and the reply said done; opening page 2's address landed on
    /// the sign-in, naming page 2 to come back to. Both need the owner. A click that changed the page, and a page
    /// that opened as asked, are done.
    #[test]
    fn a_click_that_changes_nothing_says_it_needs_the_owner() {
        use super::{came_to, Came, Look};
        let reviews = "https://www.glassdoor.sg/Reviews/Open-Government-Products-Reviews-E2503777.htm?sort.sortType=RD&sort.ascending=false";
        let on = Look { url: reviews.into(), content: 52 };
        assert_eq!(came_to("click", None, Some(&on), Some(&on.clone())), Came::Unchanged);
        assert_eq!(came_to("click", None, Some(&on), Some(&Look { content: 53, ..on.clone() })), Came::Done, "the content changed");
        assert_eq!(came_to("click", None, Some(&on), Some(&Look { url: format!("{reviews}#reviews"), ..on.clone() })), Came::Done, "the address changed");
        assert_eq!(came_to("fill", None, Some(&on), Some(&on.clone())), Came::Done, "typing changes no address");
        assert_eq!(came_to("click", None, None, Some(&on)), Came::Done, "what the browser couldn't say is done, as it said");
        let page2 = "https://www.glassdoor.sg/Reviews/Open-Government-Products-Reviews-E2503777_P2.htm?sort.sortType=RD&sort.ascending=false";
        let login = Look { url: "https://www.glassdoor.com/member/profile/login?reason=bot-detection&postLoginUrl=https%3A%2F%2Fwww.glassdoor.sg%2FReviews%2FOpen-Government-Products-Reviews-E2503777_P2.htm%3Fsort.sortType%3DRD%26sort.ascending%3Dfalse".into(), content: 1 };
        assert_eq!(came_to("open", Some(page2), Some(&on), Some(&login)), Came::Walled { at: login.url.clone() });
        assert_eq!(came_to("click", None, Some(&Look { url: page2.into(), content: 2 }), Some(&login)), Came::Walled { at: login.url.clone() }, "a click that lands on a wall");
        assert_eq!(came_to("open", Some(page2), None, Some(&Look { url: page2.into(), content: 3 })), Came::Done);
    }

    /// The same rule on another site's walk: a registrar's control panel, opened signed out, landed on its sign-in on
    /// another host of the site, which names the panel by its path alone.
    /// A click that downloads a file (Apple's "Download" for a new certificate) leaves the page as it was, and used to
    /// read as a control that did nothing, needing a sign-in. A step's own traffic says it downloaded: an answer sent as
    /// an attachment, named as the site named it, else by its address; an ordinary answer downloaded nothing.
    #[test]
    fn a_click_that_downloaded_a_file_did_something() {
        let line = |url: &str, headers: serde_json::Value| format!("{}\n", serde_json::json!({ "type": "exchange", "resourceType": "Document", "entry": { "request": { "method": "GET", "url": url, "headers": [] }, "response": { "status": 200, "headers": headers, "content": { "mimeType": "application/octet-stream" } } } }));
        let cert = line("https://developer.apple.example/services-account/download?type=cer", serde_json::json!([{ "name": "Content-Disposition", "value": "attachment; filename=\"developerID_application.cer\"" }]));
        assert_eq!(downloaded_in(&cert).as_deref(), Some("developerID_application.cer"));
        let unnamed = line("https://files.example/reports/q3.pdf", serde_json::json!([{ "name": "content-disposition", "value": "attachment" }]));
        assert_eq!(downloaded_in(&unnamed).as_deref(), Some("q3.pdf"), "named by its address when the site names nothing");
        let page = line("https://files.example/reports", serde_json::json!([{ "name": "Content-Disposition", "value": "inline" }]));
        assert_eq!(downloaded_in(&page), None, "an answer shown in the page is no download");
        assert_eq!(downloaded_in(&line("https://files.example/", serde_json::json!([]))), None);
        // Live, the browser writes no exchange for a download (GitHub's release files, sent through a redirect to
        // another host, left only the redirect): its own word that it started one is what the step goes on.
        let redirect = line("https://code.example/releases/download/v2/checksums.txt", serde_json::json!([{ "name": "location", "value": "https://assets.example/blob/82d5?sig=x" }]));
        let said = |name: &str| format!("{redirect}{}\n", serde_json::json!({ "type": "download", "t": 1.0, "url": "https://assets.example/blob/82d5?sig=x", "name": name }));
        assert_eq!(downloaded_in(&redirect), None, "a redirect alone downloaded nothing");
        assert_eq!(downloaded_in(&said("checksums.txt")).as_deref(), Some("checksums.txt"));
        assert_eq!(downloaded_in(&said("")).as_deref(), Some("82d5"), "unnamed, it goes by its address");
    }

    #[test]
    fn a_page_opened_onto_a_sign_in_that_names_it_needs_the_owner() {
        use super::{came_to, Came, Look};
        let panel = "https://ap.www.namecheap.com/domains/domaincontrolpanel/example.si/domain";
        let signin = Look { url: "https://www.namecheap.com/myaccount/login/?ReturnUrl=%2fdomains%2fdomaincontrolpanel%2fexample.si%2fdomain".into(), content: 7 };
        assert_eq!(came_to("open", Some(panel), None, Some(&signin)), Came::Walled { at: signin.url.clone() });
    }

    /// Each browsing session has its own tab, named so the browser takes it as a label, and every command of the
    /// session names it; a command for no session names none, never one the node was started with.
    #[test]
    fn each_session_acts_in_its_own_tab() {
        let (a, b) = (super::tab_of("1:mcp:aaa"), super::tab_of("1:mcp:bbb"));
        assert_ne!(a, b);
        assert_ne!(super::tab_of("1:x"), super::tab_of("2:x"), "one name on two keys");
        for t in [&a, &b] {
            assert!(t.starts_with(|c: char| c.is_ascii_alphabetic()) && t.chars().all(|c| c.is_ascii_alphanumeric()), "{t}");
            assert!(!t.contains("mcp"), "a tab's name says nothing of its session");
        }
        let env = |tab: Option<&str>| {
            let mut cmd = std::process::Command::new("agent-browser");
            super::in_tab(&mut cmd, tab);
            cmd.get_envs().find(|(k, _)| *k == "AGENT_BROWSER_TAB").map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
        };
        assert_eq!(env(Some(&a)), Some(Some(a.clone())));
        assert_eq!(env(None), Some(None), "removed, not inherited");
    }

    /// A command that names no site acts on the site its own session browsed last, never the one another session did.
    #[test]
    fn a_command_naming_no_site_acts_where_its_own_session_was() {
        super::browsed("7:mcp:one", "one.example");
        super::browsed("7:mcp:two", "two.example");
        assert_eq!(super::site_for(&args(&["get", "url"]), None, "7:mcp:one").unwrap().0, "one.example");
        assert_eq!(super::site_for(&args(&["get", "url"]), None, "7:mcp:two").unwrap().0, "two.example");
        assert!(super::site_for(&args(&["get", "url"]), None, "7:mcp:three").is_err(), "a session that browsed nothing opens a page first");
        assert_eq!(super::last_site("7:mcp:one").as_deref(), Some("one.example"));
    }

    /// A home short enough for a socket under it: a test's usual folder can run past what a socket's path may hold.
    fn short_home(name: &str) -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = if cfg!(unix) { std::path::PathBuf::from("/tmp") } else { std::env::temp_dir() };
        let dir = root.join(format!("ub-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        store::use_home(&dir);
        dir
    }

    /// A browser answering at `site`'s door, for as long as what this returns is held.
    #[cfg(unix)]
    fn browser_at(site: &str) -> std::os::unix::net::UnixListener {
        std::os::unix::net::UnixListener::bind(door(site)).unwrap()
    }
    #[cfg(windows)]
    fn browser_at(site: &str) -> std::net::TcpListener {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(door(site), l.local_addr().unwrap().port().to_string()).unwrap();
        l
    }

    /// A browser that died leaves its door file behind, and that file is no browser: not to the owner's window, to what
    /// a restart holds on to, or to the list of what is running.
    #[test]
    fn a_door_file_nothing_answers_at_is_no_browser() {
        let home = short_home("dead-door");
        std::fs::create_dir_all(sockets()).unwrap();
        let site = "dead-door.example";
        drop(browser_at(site));
        assert!(door(site).exists(), "the file stays");
        assert!(!running(site));
        OPENED.locked().push(site.to_string());
        assert!(!open_sites().contains(&site.to_string()), "nothing for the owner to take over");
        assert!(!doors().contains(&door_name(site)));
        let browser = browser_at("live-door.example");
        assert!(running("live-door.example") && doors().contains(&door_name("live-door.example")));
        drop(browser);
        OPENED.locked().retain(|s| s != site);
        let _ = std::fs::remove_dir_all(home);
    }

    /// The node's notes of its browsers are memory; the browsers outlive it. The one still answering comes back to its
    /// notice, so its pages can close and the owner can reach it; one that died since doesn't, and neither does a file
    /// that names another site's browser.
    #[test]
    fn a_browser_that_outlived_the_node_is_found_again() {
        let home = short_home("found");
        std::fs::create_dir_all(sockets()).unwrap();
        let (alive, dead) = ("found-alive.example", "found-dead.example");
        runs_in(&sockets(), alive, &store::profile_dir("www.found-alive.example"));
        runs_in(&sockets(), dead, &store::profile_dir(dead));
        let _browser = browser_at(alive);
        drop(browser_at(dead));
        find_browsers();
        assert!(open_sites().contains(&alive.to_string()));
        assert!(!OPENED.locked().contains(&dead.to_string()));
        find_browsers();
        assert_eq!(OPENED.locked().iter().filter(|s| *s == alive).count(), 1, "found once");
        OPENED.locked().retain(|s| s != alive);
        assert_eq!(site_of_files(&spelled("shop.example"), "/p/www.shop.example", spelled).as_deref(), Some("shop.example"));
        assert_eq!(site_of_files(&spelled("shop.example"), "/p/other.example", spelled), None);
        let _ = std::fs::remove_dir_all(home);
    }

    /// A browser that went by itself leaves nothing behind for the next one to inherit, just as one closed does: no tab
    /// the owner's window would show, and no hold on a page that no longer exists.
    #[test]
    fn what_the_node_held_of_a_browser_goes_with_it_however_it_went() {
        let home = short_home("went");
        std::fs::create_dir_all(sockets()).unwrap();
        let site = "went-away.example";
        runs_in(&sockets(), site, &store::profile_dir(site));
        OPENED.locked().push(site.to_string());
        in_front(site, "1:went");
        set_goal(site, "1:went", "read the page");
        browsed("1:went", site);
        TYPED.locked().push((site.to_string(), "hello".to_string()));
        keep_place(site, "vault:went-away.example:me", "document:W1", "https://went-away.example/a");
        assert!(holds_a_secret(site, "document:W1"));
        sweep_idle();
        assert!(!holds_a_secret(site, "document:W1"), "the page went with it");
        assert_eq!(front_tab(site), None);
        assert!(!OPENED.locked().contains(&site.to_string()));
        assert_eq!(last_site("1:went"), None);
        assert!(!typed_on(site));
        assert!(!profile_file(&sockets(), site).exists(), "the next browser is launched afresh");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A browser's answer to which cookies it holds is read only in its own shape: a list of cookies each with a name, a
    /// value and a domain as text. A missing list, another shape, or a cookie whose value isn't text is the browser not
    /// saying, and an error.
    #[test]
    fn a_cookie_answer_of_any_other_shape_is_no_answer() {
        let good = serde_json::json!({ "cookies": [{ "name": "sid", "value": "Zq9xSession", "domain": "shop.example" }] });
        assert_eq!(cookie_values_of(&good), Ok(vec!["Zq9xSession".to_string()]));
        assert_eq!(cookie_values_of(&serde_json::json!({ "cookies": [] })), Ok(vec![]));
        for odd in [
            serde_json::json!({}),
            serde_json::json!({ "cookies": {} }),
            serde_json::json!({ "cookies": "none" }),
            serde_json::json!({ "cookies": [{ "name": "sid", "value": 7, "domain": "shop.example" }] }),
            serde_json::json!({ "cookies": [{ "name": "sid", "domain": "shop.example" }] }),
        ] {
            assert!(cookie_values_of(&odd).is_err(), "{odd}");
        }
    }

    /// The running browsers are asked for their cookies at once, within one bound: two that answer at their door and then
    /// say nothing fail the read once [`ASK_WAIT`] has passed, not one wait after the other, and fail it closed.
    #[cfg(unix)]
    #[test]
    fn running_browsers_are_asked_at_once_and_a_silent_one_fails_closed() {
        let home = short_home("silent");
        std::fs::create_dir_all(sockets()).unwrap();
        for site in ["a.example", "b.example"] {
            let l = std::os::unix::net::UnixListener::bind(door(site)).unwrap();
            std::thread::spawn(move || {
                let mut held = Vec::new();
                for s in l.incoming().flatten() {
                    held.push(s);
                }
            });
        }
        let started = std::time::Instant::now();
        let read = session_cookies();
        let took = started.elapsed();
        assert!(read.unwrap_err().contains("can't keep it out of this answer"));
        assert!(took < ASK_WAIT + ASK_WAIT / 2, "asked at once: {took:?}");
        let _ = std::fs::remove_dir_all(home);
    }

    /// core #643: a browser's daemon that answers at its door but has no browser ("Browser not launched", as one a
    /// cancelled ask left behind does) holds no session, so it is passed over and the answer goes out; one that answers
    /// with any other error still fails it closed.
    #[cfg(unix)]
    #[test]
    fn a_browser_that_is_not_launched_holds_no_session_and_fails_no_answer() {
        use std::io::{BufRead, BufReader, Write};
        let home = short_home("notlaunched");
        std::fs::create_dir_all(sockets()).unwrap();
        let saying = |site: &str, error: &'static str| {
            let l = std::os::unix::net::UnixListener::bind(door(site)).unwrap();
            std::thread::spawn(move || {
                for mut s in l.incoming().flatten() {
                    let mut line = String::new();
                    if BufReader::new(&s).read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let _ = s.write_all(format!("{}\n", serde_json::json!({ "id": "cdp", "success": false, "error": error })).as_bytes());
                }
            });
        };
        saying("idle.example", NOT_LAUNCHED);
        assert_eq!(session_cookies(), Ok(Vec::new()), "no session to keep out, and the answer goes out");
        saying("broken.example", "the page crashed");
        assert!(session_cookies().unwrap_err().contains("can't keep it out of this answer"), "another error still fails closed");
        let _ = std::fs::remove_dir_all(home);
    }

    /// Audit 1118 N2. A site browser's daemon that is alive but whose Chrome is gone gives a DevTools address on this
    /// machine nothing listens at: that browser holds no session, so it is passed over and every other answer goes out.
    /// The control: a DevTools address something listens at but that can't be read still fails the answer closed.
    #[cfg(unix)]
    #[test]
    fn a_site_browser_whose_chrome_is_gone_fails_no_answer() {
        use std::io::{BufRead, BufReader, Write};
        let home = short_home("chromegone");
        std::fs::create_dir_all(sockets()).unwrap();
        let saying = |site: &str, ws: String| {
            let l = std::os::unix::net::UnixListener::bind(door(site)).unwrap();
            std::thread::spawn(move || {
                for mut s in l.incoming().flatten() {
                    let mut line = String::new();
                    if BufReader::new(&s).read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let _ = s.write_all(format!("{}\n", serde_json::json!({ "id": "cdp", "success": true, "data": { "cdpUrl": ws } })).as_bytes());
                }
            });
        };
        // A port nothing listens at: bound, read, let go.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        saying("dead.example", format!("ws://127.0.0.1:{dead}/devtools/browser/gone"));
        let read = session_cookies();
        // Something listens, and hangs up: a browser there that can't be read.
        let live = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = live.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in live.incoming().flatten() {
                drop(s);
            }
        });
        saying("unread.example", format!("ws://127.0.0.1:{port}/devtools/browser/live"));
        let unread = session_cookies();
        let _ = std::fs::remove_dir_all(home);
        assert_eq!(read, Ok(Vec::new()), "a browser that is gone holds no session, and the answer goes out");
        assert!(unread.unwrap_err().contains("can't keep it out of this answer"), "a live browser that can't be read still fails closed");
        assert!(!gone_at("ws://10.0.0.1:1/x") && !gone_at("not a url"), "only this machine's own address is judged");
    }

    /// A close that failed on a browser still running changes nothing the node holds of it; a browser that isn't there
    /// is gone whatever the close said.
    #[test]
    fn a_close_counts_when_the_browser_went() {
        assert!(browser_went(true, true), "it said it closed, and its door lingers a moment");
        assert!(browser_went(false, false), "the close failed on a browser that died");
        assert!(!browser_went(false, true), "still running, every hold stands");
    }

    /// UNB-145: a tab closed outside the node (by hand in the window, or by the page) and a browser that stopped are
    /// said to the session in those words at its next command, where it used to get a new, empty tab ("about:blank")
    /// or "open a page first". Opening a page moves on.
    #[test]
    fn a_session_hears_its_tab_was_closed_by_hand_or_its_browser_stopped() {
        let home = short_home("byhand");
        let (site, session) = ("byhand.example", "1:byhand");
        let tab = tab_of(session);
        let (up, down) = (|| true, || false);
        in_front(site, session);
        browsed(session, site);
        let others = || Some(vec![tab_of("2:other")]);
        let mine = || Some(vec![tab.clone(), tab_of("2:other")]);
        assert_eq!(tab_gone(site, session, &args(&["snapshot", "-i"]), up, mine), None, "its tab is there");
        assert_eq!(tab_gone(site, session, &args(&["snapshot", "-i"]), up, || None), None, "a browser that can't list its tabs is taken at its word");
        assert_eq!(tab_gone(site, session, &args(&["open", "https://byhand.example/"]), up, others), None, "opening needs no tab");
        assert_eq!(tab_gone(site, session, &args(&["close"]), up, others), None);
        assert_eq!(tab_gone(site, "9:never", &args(&["get", "url"]), up, others), None, "a session with no tab noted has nothing to lose");
        assert_eq!(tab_gone(site, session, &args(&["get", "url"]), up, others), Some(Gone::ByHand));
        assert_eq!(tab_gone(site, session, &args(&["get", "url"]), down, mine), Some(Gone::Stopped));
        tab_taken(site, &tab, Gone::ByHand);
        let said = tab_taken_from(&tab, &args(&["get", "url"])).expect("told");
        assert!(said.starts_with("your tab was closed: ") && said.contains("by hand") && said.contains("open the page again"), "{said}");
        assert_eq!(tab_taken_from(&tab, &args(&["open", "https://byhand.example/"])), None, "opening a page moves on");
        // A browser that stopped by itself: every session with a tab there hears it, and none hears "open a page first".
        in_front(site, session);
        browsed(session, site);
        browser_stopped(site);
        let said = act(&args(&["snapshot", "-i"]), None, "agent", session).unwrap_err();
        assert!(said.starts_with("your tab was closed: ") && said.contains("browser stopped"), "{said}");
        let _ = std::fs::remove_dir_all(home);
    }

    /// UNB-145: an eval whose script took the page elsewhere says the tab is still open and how to read the new page.
    #[test]
    fn a_page_that_left_under_a_command_says_the_tab_is_still_open() {
        let said = left_while_running("✗ CDP error (Runtime.evaluate): Inspected target navigated or closed".into());
        assert!(said.contains("Your tab is still open") && said.contains("[\"get\", \"url\"]"), "{said}");
        assert_eq!(left_while_running("✗ Unknown ref: e3".into()), "✗ Unknown ref: e3");
    }

    /// UNB-144, the Deck's cases replayed on what the browser says: a stale ref comes back with the page's elements
    /// now, and a covered one with what covers it and the ref of the control that moves it.
    #[test]
    fn a_stale_or_covered_ref_comes_back_with_the_next_step() {
        let now = "- link \"Homepage\" [ref=e1]\n- button \"Accept all\" [ref=e7]\n- button \"Sign in\" [ref=e8]";
        let said = with_fresh_refs("✗ Unknown ref: e33".into(), Some(now));
        assert!(said.starts_with("✗ Unknown ref: e33: the page changed") && said.ends_with(now), "{said}");
        let said = with_fresh_refs("✗ Unknown ref: e33".into(), None);
        assert!(said.contains("snapshot -i"), "{said}");
        let covered = "✗ Element '@e8' is covered by <div.cc-window inside div#cookieConsent (a cookie or consent banner), which holds button \"Accept all\"> at its click point, so the input would land on that element instead.";
        let said = with_fresh_refs(covered.into(), Some(now));
        assert!(said.contains("It is a cookie or consent banner") && said.contains("The cover's control is @e7") && said.ends_with(now), "{said}");
        let plain = "✗ Element '@e81' is covered by <div.r7fnGb inside div#yDmH0d> at its click point";
        let said = with_fresh_refs(plain.into(), Some(now));
        assert!(!said.contains("cover's control") && said.ends_with(now), "no control named, none guessed: {said}");
        assert_eq!(with_fresh_refs("✗ Element not found: #x".into(), Some(now)), "✗ Element not found: #x");
        assert!(needs_fresh_refs("✗ Unknown ref: e3") && needs_fresh_refs(plain) && !needs_fresh_refs("✗ Timeout"));
    }

    /// Audit 1118 M10: a stale ref's error brings back only a page the agent may read. Where the page policy refuses
    /// every read (a hold whose secret the node no longer knows), the error says to take a snapshot and the page is
    /// never looked at; elsewhere it carries the page's elements, scrubbed.
    #[test]
    fn a_stale_ref_brings_back_no_page_the_policy_refuses_to_read() {
        let site = "stale-held.example";
        let said = "✗ Unknown ref: e33";
        let page = || Some(Said { ok: true, out: "- textbox \"Password\" [ref=e4]: hunter2-unhidden\n".into(), err: String::new() });
        UNHEARD.locked().push(Place { site: site.into(), name: "vault:stale-held.example:me".into(), page: "document:S1".into(), at: "https://stale-held.example/in".into() });
        assert!(page_policy(site, "1:stale", &args(&["snapshot", "-i"])).is_err(), "the fixture refuses every read");
        let looked = std::cell::Cell::new(false);
        let fresh = fresh_refs(site, "1:stale", said, || {
            looked.set(true);
            page()
        });
        UNHEARD.locked().retain(|p| p.site != site);
        assert_eq!(fresh, None, "a page the policy refuses to read comes back with no error");
        assert!(!looked.get(), "and is never looked at");
        assert_eq!(fresh_refs(site, "1:stale", said, page).as_deref(), Some("- textbox \"Password\" [ref=e4]: hunter2-unhidden"), "a readable page still comes back");
        assert_eq!(fresh_refs(site, "1:stale", "✗ Timeout", page), None);
    }

    /// A tab the node closed itself is said to its session, by the command that would otherwise have found a new, empty
    /// tab under the same name, until it opens another page.
    #[test]
    fn a_session_hears_that_the_node_took_its_tab() {
        let home = short_home("taken");
        let (site, session) = ("taken.example", "1:taken");
        let tab = tab_of(session);
        in_front(site, session);
        browsed(session, site);
        tab_taken(site, &tab, Gone::Room);
        let said = tab_taken_from(&tab, &args(&["snapshot"])).expect("told");
        assert!(said.contains("room") && said.contains("open the page again"), "{said}");
        assert!(act(&args(&["snapshot"]), None, "agent", session).unwrap_err().contains("closed"), "with no last site left, the same");
        assert!(tab_taken_from(&tab, &args(&["get", "url"])).is_some(), "until it moves on");
        assert_eq!(tab_taken_from(&tab, &args(&["open", "https://taken.example/"])), None);
        assert_eq!(tab_taken_from(&tab, &args(&["snapshot"])), None);
        tab_taken(site, &tab, Gone::Idled);
        assert!(tab_taken_from(&tab, &args(&["snapshot"])).unwrap().contains("without a command"));
        let _ = std::fs::remove_dir_all(home);
    }

    /// A page that shows a vault password before the node filled it (the QA login page's hint) still never shows it
    /// to the agent: the reply says the login's name (QA check 5).
    #[test]
    fn a_vault_password_a_page_shows_before_any_fill_is_hidden() {
        super::know("hint.example", "SuperSecretPassword!", "vault:hint.example:tomsmith");
        assert_eq!(
            super::unsaid("hint.example", "Enter tomsmith for the username and SuperSecretPassword! for the password.".into()),
            "Enter tomsmith for the username and vault:hint.example:tomsmith for the password."
        );
        assert_eq!(super::unsaid("other.example", "SuperSecretPassword!".into()), "SuperSecretPassword!", "only on the login's own site");
        super::know("short.example", "abc", "vault:short.example:me");
        assert_eq!(super::unsaid("short.example", "abc".into()), "abc", "too short to hide everywhere a page says it");
    }

    /// Two agents on one site share its browser and its log. A route is named to the session whose step sent its
    /// call, not to the one whose later command ran the learn (QA check 10: a "sign in" one session drove was named
    /// in another's reply to `close`).
    #[test]
    fn a_learned_route_goes_to_the_session_whose_step_sent_it() {
        let site = "shared.example";
        super::note_acted(site, "10:default", 100.0); // opens the login page, signs in
        super::note_acted(site, "10:qa-b", 200.0); // opens another page, then closes its tab
        super::credit_learned(site, "10:qa-b", "sign-in", 150.0);
        assert_eq!(super::learned(site, "10:default"), ["sign-in"], "the sign-in call went out during the default session's step");
        assert!(super::learned(site, "10:qa-b").is_empty(), "qa-b's close ran the learn but sent nothing");
        super::credit_learned(site, "10:qa-b", "dropdown", 210.0);
        assert_eq!(super::learned(site, "10:qa-b"), ["dropdown"]);
        assert_eq!(super::acting_at(site, 50.0), None, "nobody had acted on the site yet");
        super::credit_learned(site, "10:qa-c", "early", 50.0);
        assert_eq!(super::learned(site, "10:qa-c"), ["early"], "with no session acting yet, the asking session's");
    }

    /// A browse reply names the routes its own session's browsing learned, never another session's on the same site;
    /// one session closing its tab forgets only its own.
    #[test]
    fn a_route_one_session_learned_is_never_named_to_another() {
        let site = "learned.example";
        super::in_front(site, "8:a");
        super::in_front(site, "8:b");
        super::note_learned(site, "8:a", "read-archive");
        super::note_learned(site, "8:b", "post-listing");
        super::note_learned(site, "8:a", "read-archive");
        assert_eq!(super::learned(site, "8:a"), ["read-archive"]);
        assert_eq!(super::learned(site, "8:b"), ["post-listing"]);
        assert!(super::learned(site, "8:c").is_empty());
        super::TABS.locked().retain(|h| !(h.site == site && h.tab == super::tab_of("8:a")));
        super::forget_learned(site, "8:a");
        assert!(super::learned(site, "8:a").is_empty());
        assert_eq!(super::learned(site, "8:b"), ["post-listing"], "the other session's stays");
    }

    /// Goals are each session's: one session closing (its goal cleared) leaves another's in place, and a session that
    /// gave none has none, whatever another came to do on the site.
    #[test]
    fn a_goal_is_the_session_s_that_gave_it() {
        let site = "goals.example";
        super::set_goal(site, "9:a", "read archived snapshots");
        super::set_goal(site, "9:b", "post a listing");
        assert_eq!(super::goal_of(site, "9:a").as_deref(), Some("read archived snapshots"));
        assert_eq!(super::goal_of(site, "9:b").as_deref(), Some("post a listing"));
        assert_eq!(super::goal_of(site, "9:c"), None);
        super::set_goal(site, "9:b", "");
        assert_eq!(super::goal_of(site, "9:b"), None);
        assert_eq!(super::goal_of(site, "9:a").as_deref(), Some("read archived snapshots"));
    }

    /// The owner's window shows the tab of the session that acted on the site last, or asked for the owner.
    #[test]
    fn the_owner_sees_the_tab_of_the_session_that_asked() {
        let site = "front.example";
        assert_eq!(super::front_tab(site), None);
        super::in_front(site, "10:a");
        super::in_front(site, "10:b");
        assert_eq!(super::front_tab(site), Some(super::tab_of("10:b")));
        super::to_front(site, "10:a");
        assert_eq!(super::front_tab(site), Some(super::tab_of("10:a")));
        assert_eq!(super::others(site, &super::tab_of("10:a")), 1);
    }

    /// While an agent's ask waits on the owner, the window shows the asking session's tab, though another session's
    /// command (one already under way when the ask came) acted on the site since; once the ask is answered, the last
    /// to act is shown again.
    #[test]
    fn while_an_ask_waits_the_owner_sees_the_asking_sessions_tab() {
        let site = "asking.example";
        super::in_front(site, "12:a");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let asking = super::tab_of("12:a");
        let waiting = rt.spawn(async move { crate::hands::ask("asking.example", Some(&asking), "sign in", "agent", std::time::Duration::from_secs(30), None, |_| {}).await });
        while !crate::hands::asks().iter().any(|a| a.site == site) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        super::in_front(site, "12:b");
        assert_eq!(super::shown_tab(site), Some(super::tab_of("12:a")), "the asking session's page, not the last to act");
        crate::hands::answer(site, crate::hands::Answer::Done);
        rt.block_on(waiting).unwrap();
        assert_eq!(super::shown_tab(site), Some(super::tab_of("12:b")));
    }

    /// `close` from a session closes its own tab while another session has one, and closes nothing when it has no
    /// tab there itself: never the browser other sessions' pages are open in. The node's heal tab is nobody's.
    #[test]
    fn close_never_closes_the_browser_under_another_sessions_tab() {
        use super::Closing;
        let (mine, other, heal) = (super::tab_of("13:a"), super::tab_of("13:b"), super::heal_tab());
        let labels = |l: &[&String]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::closing(Some(&labels(&[&mine, &other])), &mine, 0), Closing::Tab);
        assert_eq!(super::closing(Some(&labels(&[&other])), &mine, 0), Closing::Nothing, "no tab of its own: nothing, not the browser");
        assert_eq!(super::closing(Some(&labels(&[&other])), &mine, 1), Closing::Nothing);
        assert_eq!(super::closing(Some(&labels(&[&mine])), &mine, 0), Closing::Browser, "the last session closes the browser");
        assert_eq!(super::closing(Some(&labels(&[&mine, &heal])), &mine, 0), Closing::Browser, "the heal tab keeps nothing open");
        assert_eq!(super::closing(Some(&[]), &mine, 0), Closing::Browser);
        assert_eq!(super::closing(None, &mine, 1), Closing::Nothing, "a browser that can't list its tabs, with others noted, stays");
        assert_eq!(super::closing(None, &mine, 0), Closing::Browser);
        // The heal tab is never another session's.
        let site = "heal.example";
        super::in_front(site, super::HEAL);
        assert_eq!(super::others(site, &mine), 0);
    }

    /// A page handed to an agent that never came back is the browser's last tab, which a browser won't close: when every
    /// tab of a site's browser has gone idle and nothing is about to act, the browser closes, never only its tabs.
    #[test]
    fn a_browser_whose_every_tab_went_idle_closes_whole() {
        let s = |v: &[&str]| v.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert!(super::closes_the_browser(&s(&["t0"]), &s(&["t0"]), None), "the one page nobody came back to");
        assert!(super::closes_the_browser(&s(&["t0", "t1"]), &s(&["t1", "t0"]), None));
        assert!(!super::closes_the_browser(&s(&["t0", "t1"]), &s(&["t1"]), None), "another session's tab keeps it open");
        assert!(!super::closes_the_browser(&s(&["t0", "heal"]), &s(&["t0"]), None), "a heal in progress keeps it open");
        assert!(!super::closes_the_browser(&s(&["t0"]), &s(&["t0"]), Some("t1")), "a tab about to act keeps it open");
        assert!(!super::closes_the_browser(&s(&["t0"]), &s(&[]), None), "nothing idle, nothing closes");
    }

    /// A session's tab that went unused for a while closes; past the cap, a new session's tab takes the place of the
    /// one unused longest. Never the tab acting now, nor the one an ask waiting on the owner is about.
    #[test]
    fn idle_tabs_close_and_a_site_holds_a_few() {
        use std::time::Duration;
        let idle = super::TAB_IDLE;
        let open = |n: usize, f: &dyn Fn(usize) -> Duration| (0..n).map(|i| (format!("t{i}"), f(i))).collect::<Vec<_>>();
        assert_eq!(super::to_close(&open(3, &|i| if i == 1 { idle } else { Duration::ZERO }), Some("t0"), None), ["t1"]);
        assert!(super::to_close(&open(3, &|_| idle), Some("t0"), Some("t1")).iter().all(|t| t != "t0" && t != "t1"), "acting and asked stay");
        let full = open(super::TABS_PER_SITE, &|i| Duration::from_secs(i as u64));
        assert_eq!(super::to_close(&full, Some("new"), None), [format!("t{}", super::TABS_PER_SITE - 1)], "the one unused longest makes room");
        assert!(super::to_close(&full, Some("t0"), None).is_empty(), "a tab already open needs no room");
        assert!(super::to_close(&open(super::TABS_PER_SITE - 1, &|_| Duration::from_secs(5)), Some("new"), None).is_empty());
        // With nothing about to act, the background pass: only what went idle closes, and a full browser keeps the rest.
        assert_eq!(super::to_close(&open(3, &|i| if i == 1 { idle } else { Duration::ZERO }), None, None), ["t1"], "a page nobody came back to");
        assert!(super::to_close(&open(3, &|_| Duration::from_secs(5)), None, None).is_empty(), "pages in use stay");
        assert!(super::to_close(&full, None, None).is_empty(), "no new tab needs room");
        assert_eq!(super::to_close(&open(2, &|_| idle), None, Some("t0")), ["t1"], "an ask waiting on the owner keeps its tab");
    }

    /// The node's own housekeeping (a secret the owner typed, taken out of the walk record) never waits its turn
    /// behind the agents' commands on the site, and a browser that doesn't take it is said, never passed over.
    #[cfg(unix)]
    #[test]
    fn forgetting_a_secret_never_waits_behind_the_agents_commands() {
        use std::io::{BufRead, BufReader, Write};
        // A short home: a socket's path has to fit in a few dozen bytes.
        let home = std::path::PathBuf::from(format!("/tmp/ubf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        crate::store::use_home(&home);
        let site = "f.example";
        std::fs::create_dir_all(super::sockets()).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(super::door(site)).unwrap();
        let heard = std::thread::spawn(move || loop {
            let (mut s, _) = listener.accept().unwrap();
            let mut line = String::new();
            // Asking whether a browser is there sends nothing.
            if BufReader::new(&s).read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            s.write_all(b"{\"success\":true,\"data\":{\"named\":null,\"queued\":true}}\n").unwrap();
            return line;
        });
        // An agent's long command holds the site's turn.
        let gate = super::gate(&format!("site:{site}"));
        let _agents = gate.locked();
        let (tx, rx) = std::sync::mpsc::channel();
        let h = home.clone();
        std::thread::spawn(move || {
            crate::store::use_home(&h);
            let _ = tx.send(super::forget(site, "Owner-Typed-77"));
        });
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)), Ok(Ok(())), "answered without waiting for the agents' turn");
        let sent: serde_json::Value = serde_json::from_str(&heard.join().unwrap()).unwrap();
        assert_eq!((sent["action"].as_str(), sent["value"].as_str(), sent["noLaunch"].as_bool()), (Some("capture_forget"), Some("Owner-Typed-77"), Some(true)));
        // Nothing answers at the browser's socket any more: the secret may still be in the record, and that is said.
        assert!(super::forget(site, "Owner-Typed-77").is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// What the node notes per session stays bounded however many sessions come and go.
    #[test]
    fn per_session_notes_stay_bounded() {
        for n in 0..(super::LAST_KEPT + 50) {
            super::browsed(&format!("14:{n}"), "bounded.example");
        }
        assert!(super::LAST.locked().len() <= super::LAST_KEPT);
        assert_eq!(super::last_site(&format!("14:{}", super::LAST_KEPT + 49)).as_deref(), Some("bounded.example"), "the newest stay");
        for n in 0..(super::LEARNED_KEPT + 50) {
            super::note_learned("bounded.example", &format!("14:{n}"), "r");
        }
        assert!(super::LEARNED.locked().len() <= super::LEARNED_KEPT);
        super::in_front("bounded.example", "14:gone");
        super::note_learned("bounded.example", "14:gone", "r2");
        super::set_goal("bounded.example", "14:gone", "read");
        super::forget_session("bounded.example", "14:gone");
        assert!(super::learned("bounded.example", "14:gone").is_empty());
        assert!(!super::TABS.locked().iter().any(|h| h.session == "14:gone"));
    }

    /// An eval's `--timeout <ms>` goes where the browser reads it, before the script, wherever the agent put it.
    #[test]
    fn an_evals_timeout_goes_before_its_script() {
        let want = args(&["eval", "--timeout", "60000", "await slow()"]);
        assert_eq!(super::script_timeout_first(&args(&["eval", "await slow()", "--timeout", "60000"])), want);
        assert_eq!(super::script_timeout_first(&want), want);
        // One that names no time is given 30 s, so running out is said plainly, not as the socket's read timeout.
        assert_eq!(super::script_timeout_first(&args(&["eval", "1"])), args(&["eval", "--timeout", "30000", "1"]));
        assert_eq!(super::script_timeout_first(&args(&["eval", "-b", "MQ=="])), args(&["eval", "--timeout", "30000", "-b", "MQ=="]));
        assert_eq!(super::script_timeout_first(&args(&["wait", "--text", "x", "--timeout", "5"])), args(&["wait", "--text", "x", "--timeout", "5"]));
        assert!(super::site_for(&args(&["eval", "--timeout", "60000", "1"]), Some("a.example"), "").is_ok());
    }

    /// A command that waits too long for a site's browser is told what holds it and for how long, never "other
    /// sessions" when there are none (issue #545); the holder is forgotten when its turn ends.
    #[test]
    fn a_busy_browser_says_what_holds_it() {
        let site = "turn-holder.example";
        let gate = super::gate(&format!("site:{site}"));
        let turn = super::take_turn(&gate, site, "`open` for agent 0".into()).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let gate = super::gate(&format!("site:{site}"));
            tx.send(super::take_turn(&gate, site, "`snapshot -i` for agent 0".into()).err()).unwrap();
        });
        let said = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap().expect("the turn is held");
        assert!(said.starts_with(&format!("{site}'s browser was busy for 1 s with `open` for agent 0, which has held it ")), "{said}");
        assert!(!said.contains("other sessions"), "{said}");
        turn.doing("`open` for agent 0, waiting for this node's walk of https://turn-holder.example/s (95 s so far) to give the site's profile back".into());
        assert!(super::holder(site).unwrap().contains("waiting for this node's walk of https://turn-holder.example/s"));
        drop(turn);
        assert_eq!(super::holder(site), None, "forgotten once the turn ends");
        assert!(super::take_turn(&gate, site, "`snapshot -i` for agent 0".into()).is_ok(), "and the next takes it at once");
    }

    /// What holds a profile is said with how long it has: the walk a starting browser waits for.
    #[test]
    fn a_held_profile_says_what_holds_it() {
        let profile = std::env::temp_dir().join(format!("unbrowse-profile-holder-{}", std::process::id()));
        assert_eq!(super::profile_holder(&profile), None);
        let walk = super::hold_profile(&profile, "this node's walk of https://shop.example/search");
        assert_eq!(super::profile_holder(&profile).as_deref(), Some("this node's walk of https://shop.example/search (0 s so far)"));
        drop(walk);
        assert_eq!(super::profile_holder(&profile), None);
    }

    /// A browser that wants a profile another holds waits for it to be given back, instead of failing on the
    /// profile's lock; one held past the wait goes ahead as it would have.
    #[test]
    fn a_second_browser_waits_for_the_profile_instead_of_failing_on_its_lock() {
        let profile = std::env::temp_dir().join(format!("unbrowse-profile-hold-{}", std::process::id()));
        let first = super::hold_profile(&profile, "a walk");
        let (tx, rx) = std::sync::mpsc::channel();
        let p2 = profile.clone();
        let second = std::thread::spawn(move || {
            let held = super::hold_profile(&p2, "a walk");
            tx.send(held.0.is_some()).unwrap();
        });
        assert!(rx.recv_timeout(std::time::Duration::from_millis(300)).is_err(), "the second waits while the first holds it");
        drop(first);
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)), Ok(true), "and has it once given back");
        second.join().unwrap();
        let other = super::hold_profile(&profile.join("other"), "a walk");
        assert!(other.0.is_some(), "another profile is never held up");
    }

    /// An ask waiting for a profile that gives up stops waiting at once, rather than at the end of `PROFILE_WAIT`
    /// behind a walk nobody waits for; an ask that hasn't given up still waits.
    #[test]
    fn a_wait_for_a_profile_ends_when_its_ask_gives_up() {
        let profile = std::env::temp_dir().join(format!("unbrowse-profile-giveup-{}", std::process::id()));
        let first = super::hold_profile(&profile, "a walk nobody waits for");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel();
        let (p2, s2) = (profile.clone(), stop.clone());
        let second = std::thread::spawn(move || {
            let held = unbrowse_learn::mint::stops_with(s2, || super::hold_profile(&p2, "a retry"));
            tx.send(held.0.is_some()).unwrap();
        });
        assert!(rx.recv_timeout(std::time::Duration::from_millis(400)).is_err(), "the retry waits while its ask stands");
        let gave_up = std::time::Instant::now();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)), Ok(false), "it stops waiting, and takes nothing");
        assert!(gave_up.elapsed() <= super::STOP_LOOK * 3, "within a look or two of its ask giving up: {:?}", gave_up.elapsed());
        second.join().unwrap();
        drop(first);
    }

    /// A browser already running in a profile is found by the address it wrote there, and only when the browser
    /// answering at that port is the one that wrote it.
    #[test]
    fn a_browser_running_in_a_profile_is_found_by_the_address_it_wrote() {
        use std::io::{Read, Write};
        let profile = std::env::temp_dir().join(format!("unbrowse-profile-port-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&profile);
        assert_eq!(super::listening_in(&profile), None, "no browser wrote one");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten().take(2) {
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\n\r\n{\"webSocketDebuggerUrl\": \"ws://127.0.0.1/devtools/browser/abc\"}");
            }
        });
        std::fs::write(profile.join("DevToolsActivePort"), format!("{port}\n/devtools/browser/abc\n")).unwrap();
        assert_eq!(super::listening_in(&profile), Some(format!("ws://127.0.0.1:{port}/devtools/browser/abc")));
        std::fs::write(profile.join("DevToolsActivePort"), format!("{port}\n/devtools/browser/other\n")).unwrap();
        assert_eq!(super::listening_in(&profile), None, "another browser took the port");
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn a_request_carrying_what_was_typed_is_one_that_landed() {
        let line = |u: &str, body: &str| format!(r#"{{"type":"exchange","entry":{{"request":{{"url":"{u}","postData":{{"text":{body}}}}}}}}}"#);
        let typed = vec!["rust async".to_string()];
        assert!(super::carries_typed(&line("https://api.search.example/q?query=rust%20async", "\"\""), &typed));
        assert!(super::carries_typed(&line("https://api.search.example/q?query=rust+async", "\"\""), &typed));
        assert!(super::carries_typed(&line("https://api.search.example/q", r#""{\"params\":\"rust async\"}""#), &typed));
        assert!(!super::carries_typed(&line("https://ads.tracker.example/pixel", "\"\""), &typed));
        assert!(!super::carries_typed(&line("https://api.search.example/q?query=rust%20async", "\"\""), &[]));
    }

    #[test]
    fn only_the_sites_own_calls_keep_a_click_waiting() {
        let line = |u: &str| format!(r#"{{"type":"exchange","entry":{{"request":{{"url":"{u}"}}}}}}"#);
        assert!(super::own_exchange(&line("https://www.shop.example/api/send"), "shop.example"));
        assert!(super::own_exchange(&line("https://shop.example/"), "shop.example"));
        assert!(!super::own_exchange(&line("https://ads.tracker.example/pixel"), "shop.example"));
        assert!(!super::own_exchange(&line("https://notshop.example/"), "shop.example"));
        assert!(!super::own_exchange(r#"{"type":"action","kind":"click"}"#, "shop.example"));
    }

    use super::*;

    #[test]
    fn every_command_after_a_page_opens_launches_the_browser_the_same() {
        let sockets = std::env::temp_dir().join(format!("unbrowse-launch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sockets);
        let profiles = Path::new("/p");
        runs_in(&sockets, "shop.example", Path::new("/p/www.shop.example"));
        let first = launch(&sockets, profiles, "shop.example").unwrap();
        assert_eq!(first[..2], ["--profile".to_string(), "/p/www.shop.example".to_string()]);
        // A page of another host of the site opens in the browser that is open, and the next command says the same.
        runs_in(&sockets, "shop.example", Path::new("/p/help.shop.example"));
        assert_eq!(launch(&sockets, profiles, "shop.example").unwrap(), first);
        let _ = std::fs::remove_dir_all(&sockets);
    }

    /// 13.16.0 passed the egress proxy's switches as arguments of their own after `--args`, and the browser CLI read the
    /// first of them as the command: every browse answered "Unknown command: --proxy-server=…". The launch is flag and
    /// value pairs only, and every switch, the proxy's among them, rides in the one comma-separated `--args` value.
    #[test]
    fn the_browsers_switches_ride_in_one_args_value() {
        let sockets = std::env::temp_dir().join(format!("unbrowse-launch-args-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sockets);
        let l = launch(&sockets, Path::new("/p"), "shop.example").expect("the egress proxy starts");
        assert_eq!(l.len(), 4, "flag and value pairs only, nothing the CLI would read as a command: {l:?}");
        assert_eq!((l[0].as_str(), l[2].as_str()), ("--profile", "--args"), "{l:?}");
        let switches: Vec<&str> = l[3].split(',').collect();
        assert!(switches.iter().all(|s| s.starts_with("--")), "every switch whole, none split by a comma: {switches:?}");
        assert!(switches.contains(&"--disable-blink-features=AutomationControlled"), "{switches:?}");
        // The site's own listener (`proxy::switches_for`), so the checkout hold can tell this browser's connections.
        for f in &unbrowse_learn::proxy::switches_for("shop.example").expect("the egress proxy starts") {
            assert!(switches.contains(&f.as_str()), "the egress proxy's {f} goes in --args: {switches:?}");
        }
        let _ = std::fs::remove_dir_all(&sockets);
    }

    /// A command before any page of the site has opened, or after its browser closed, still runs in the site's own
    /// profile: a browser launched with none would be the one every profile-less browser on this machine shares.
    #[test]
    fn a_session_always_runs_in_its_sites_own_profile() {
        let sockets = std::env::temp_dir().join(format!("unbrowse-own-profile-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sockets);
        let profiles = Path::new("/p");
        let own = |site: &str| launch(&sockets, profiles, site).unwrap()[..2].to_vec();
        assert_eq!(own("shop.example"), ["--profile", "/p/shop.example"]);
        runs_in(&sockets, "shop.example", Path::new("/p/www.shop.example"));
        assert_eq!(own("shop.example"), ["--profile", "/p/www.shop.example"]);
        assert_eq!(own("news.example"), ["--profile", "/p/news.example"], "another site's browser is its own");
        closed(&sockets, "shop.example");
        assert_eq!(own("shop.example"), ["--profile", "/p/shop.example"]);
        let _ = std::fs::remove_dir_all(&sockets);
    }

    /// A site's socket always fits the 103 bytes a Unix socket's path may hold, however long its host or the node's
    /// home: a name that fits stays as it was, a longer one is cut and ends in a hash of the whole, so two long hosts
    /// that share their first labels still get two sessions.
    #[test]
    fn a_long_host_under_a_long_home_still_gets_a_socket() {
        let short = spelled("news.ycombinator.com");
        assert_eq!(fitted(short.clone(), "/Users/a/.unbrowse/browser".len()), short);
        let long_home = "/Users/someone.with.a.long.name/.unbrowse/browser".len();
        let hosts = ["accounts.a-very-long-subdomain.example-company.co.uk", "accounts.a-very-long-subdomain.example-company.co.nz"];
        let names: Vec<String> = hosts.iter().map(|h| fitted(spelled(h), long_home)).collect();
        for name in &names {
            assert!(long_home + 1 + name.len() + ".sock".len() <= SOCKET_PATH_MAX, "{name}");
            assert!(name.starts_with("browse_accounts_a"), "{name}");
            assert!(name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'), "{name}");
        }
        assert_ne!(names[0], names[1]);
        assert_eq!(names[0], fitted(spelled(hosts[0]), long_home), "the same site, the same session");
        // A folder with no room even for a cut name leaves the name whole, for the browser to say why.
        assert_eq!(fitted(spelled(hosts[0]), 100), spelled(hosts[0]));
    }

    /// Two sites never share a browser: whatever separates their names separates their sessions, and so their
    /// profiles, logs and the guards kept for each.
    #[test]
    fn two_sites_never_share_a_session() {
        let sites = ["shop.co.uk", "shop-co.uk", "shop_co.uk", "shop--co.uk", "shop.co-uk", "foo.github.io", "foo-github.io", "[::1]", "xn--bcher-kva.example"];
        for (n, a) in sites.iter().enumerate() {
            let name = session_of(a);
            assert!(name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'), "{name}");
            for b in &sites[n + 1..] {
                assert_ne!(name, session_of(b), "{a} and {b}");
            }
        }
        // A site's name stays what it was where nothing but dots separates its labels.
        assert_eq!(spelled("shop.co.uk"), "browse_shop_co_uk");
        // A name that holds no site is no session at all.
        assert!(site_for(&args(&["snapshot"]), Some("/"), "").is_err());
    }

    /// The browser CLI runs on the node's settings alone: no agent-browser variable this process inherited, nor a
    /// config file beside it or in the user's home, picks the browser a session attaches to or what it loads.
    #[test]
    fn the_browser_never_takes_settings_from_around_the_node() {
        let home = std::env::temp_dir().join(format!("unbrowse-own-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("AGENT_BROWSER_CDP_PROBE_FOR_TEST", "9222");
        let mut cmd = Command::new("agent-browser");
        unbrowse_learn::mint::on_its_own(&mut cmd, &home).unwrap();
        let envs: Vec<_> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_owned()))).collect();
        assert!(envs.contains(&("AGENT_BROWSER_CDP_PROBE_FOR_TEST".into(), None)), "an inherited agent-browser variable is dropped");
        assert!(envs.iter().any(|(k, v)| k == "AGENT_BROWSER_RUNTIME_DIR" && v.as_deref() == Some(home.join("browser-runtime").as_os_str())));
        assert_eq!(cmd.get_current_dir(), Some(home.as_path()));
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let config = home.join("browser-config.json");
        assert_eq!(args, ["--config".to_string(), config.to_string_lossy().into_owned()]);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{}");
        std::env::remove_var("AGENT_BROWSER_CDP_PROBE_FOR_TEST");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// What the browser says back never shows a password the node filled from the vault: a field's value or a
    /// script's answer says the login's name.
    /// A page the node typed a one-time code into runs no script while the agent is on it: the code's field is an
    /// ordinary one, so no field count can say the code has gone.
    #[test]
    fn no_script_runs_where_a_code_was_typed() {
        let page = "https://d.example/two-step";
        FILLED.locked().push(("d.example".into(), "492039".into(), "vault:code:d.example:me".into(), page.into()));
        assert!(holds_a_secret("d.example", page), "no password field, and still the code");
        assert!(!holds_a_secret("d.example", "https://d.example/home"), "another address: the code went with the page");
        assert!(no_script_near_a_login("d.example", "t", &args(&["click", "@e1"])).is_ok(), "only scripts");
        assert!(no_script_near_a_login("d.example", "t", &args(&["wait", "--text", "Welcome"])).is_ok(), "a wait on text runs none");
        assert_eq!(unsaid("d.example", "code: 492039".into()), "code: vault:code:d.example:me");
    }

    /// External security review round 2, 2026-11-04, item 1. A page's own "show password" button turns the password
    /// field into a text field (a click, not a script): the page then has no password field, but the value is still
    /// in it. The document the node filled stays held for its whole life, so the agent's script never runs there to
    /// read it, and what comes back says the login's name however a script encodes the value.
    #[test]
    fn a_shown_password_still_holds_its_page() {
        FILLED.locked().push(("show.example".into(), "Sh0w-Me-Pass!".into(), "vault:show.example:me".into(), "document:S1".into()));
        assert!(holds_a_secret("show.example", "document:S1"), "the field became a text field; the password is still in it");
        assert!(!holds_a_secret("show.example", "document:S2"), "a new load took it");
        // A browser that can't name the document: held to the address, whatever the page has done to its fields.
        FILLED.locked().push(("show2.example".into(), "Sh0w-Me-Too".into(), "vault:show2.example:me".into(), "https://show2.example/login".into()));
        assert!(holds_a_secret("show2.example", "https://show2.example/login"));
        assert!(holds_a_secret("show2.example", "https://show2.example/login#shown"));
        assert!(!holds_a_secret("show2.example", "https://show2.example/feed"));
    }

    /// Audit 1118 H5 (16 Nov H11). A hold is per value and page, and ends only when its browser closes: filling one
    /// login on page after page, or other logins after it, never frees the first page with the password still in its
    /// field. Ported from c7b1a22b.
    #[test]
    fn a_held_password_stays_held_while_its_page_is_open() {
        let site = "again.example";
        let login = |n: usize| (format!("document:G{n}"), format!("https://again.example/login/{n}"));
        for n in 1..=12 {
            let (doc, at) = login(n);
            hold_secret(site, "Again-Pass-61", "vault:again.example:me", &doc, &at);
        }
        for n in 12..=20 {
            hold_secret(site, &format!("Other-Pass-{n:02}"), "vault:again.example:other", &format!("document:O{n}"), "https://again.example/other");
        }
        let freed: Vec<usize> = (1..=12).filter(|n| !holds_at(site, Some(&format!("document:G{n}")), "https://again.example/feed")).collect();
        let secrets_said = secrets_of(site).iter().filter(|(s, _)| s == "Again-Pass-61").count();
        FILLED.locked().retain(|(s, ..)| s != site);
        PLACES.locked().retain(|p| p.site != site);
        assert!(freed.is_empty(), "pages let go while still open: {freed:?}");
        assert!(secrets_said >= 1, "the password left the hold list");
    }

    /// Audit 1118 H5. What is kept of the values: every one whose page is still held, and of the rest the newest few
    /// per login.
    #[test]
    fn a_value_is_dropped_by_count_only_once_its_page_is_let_go() {
        let entry = |n: usize| ("count.example".to_string(), format!("Code-{n:04}"), "vault:count.example:me:code".to_string(), format!("document:N{n}"));
        let mut filled: Vec<_> = (1..=12).map(entry).collect();
        keep_filled(&mut filled, &|_, page| page == "document:N1");
        assert!(filled.iter().any(|(.., p)| p == "document:N1"), "a held page keeps its value");
        assert_eq!(filled.len(), 1 + FILLED_PER_NAME, "of the rest, the newest {FILLED_PER_NAME}");
        assert!(filled.iter().any(|(.., p)| p == "document:N12") && !filled.iter().any(|(.., p)| p == "document:N2"));
    }

    /// Audit 1118 H5. What the owner typed by hand is held by its document as well as its address: a single-page
    /// checkout that moves to `/review` with `pushState` keeps the same document, so scripts and value reads stay
    /// refused there. A new document at another address is not held by it.
    #[test]
    fn what_the_owner_typed_stays_held_when_the_page_changes_its_address_in_place() {
        let site = "spa-typed.example";
        owner_typed_in(site, "Owner-Card-Code-731", "https://spa-typed.example/checkout", Some("document:SPA1"));
        let same_doc_moved = holds_at(site, Some("document:SPA1"), "https://spa-typed.example/review");
        let new_doc_held_address = holds_at(site, Some("document:NEW2"), "https://spa-typed.example/checkout");
        let elsewhere = holds_at(site, Some("document:NEW3"), "https://spa-typed.example/thanks");
        FILLED.locked().retain(|(s, ..)| s != site);
        PLACES.locked().retain(|p| p.site != site);
        assert!(same_doc_moved, "the same document at its new address");
        assert!(new_doc_held_address, "a new document at the held address");
        assert!(!elsewhere, "another document elsewhere");
    }

    /// The second line behind the hold: a password said back as markup, a JSON string, or base64 (whole, or inside
    /// a longer encoding at any offset) comes back as its login's name.
    #[test]
    fn a_password_in_markup_or_base64_still_comes_back_as_its_name() {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine;
        let pw = "p<a>ss&\"w'd\u{a0}9";
        FILLED.locked().push(("enc.example".into(), pw.into(), "vault:enc.example:me".into(), "document:E1".into()));
        let name = "vault:enc.example:me";
        for said in [
            "p&lt;a&gt;ss&amp;\"w'd&nbsp;9".to_string(),
            "p<a>ss&amp;&quot;w'd&nbsp;9".to_string(),
            "p&lt;a&gt;ss&amp;&quot;w&#39;d&nbsp;9".to_string(),
            "p&lt;a&gt;ss&amp;&quot;w&#x27;d&nbsp;9".to_string(),
            "p&lt;a&gt;ss&amp;&#34;w&#39;d&nbsp;9".to_string(),
            serde_json::to_string(pw).unwrap().trim_matches('"').to_string(),
            STANDARD.encode(pw),
            URL_SAFE_NO_PAD.encode(pw),
        ] {
            let back = unsaid("enc.example", format!("value: {said}"));
            assert_eq!(back, format!("value: {name}"), "{said}");
        }
        // Inside a longer encoding, at each of the three offsets: no run of it that only the password makes is left.
        for prefix in ["", "u=", "pw="] {
            for suffix in ["", "&x", "&ok=1"] {
                let blob = STANDARD.encode(format!("{prefix}{pw}{suffix}"));
                let back = unsaid("enc.example", blob.clone());
                assert!(back.contains(name), "{prefix}|{suffix}: {back}");
                let rest = STANDARD.decode(back.replace(name, "").as_bytes()).unwrap_or_default();
                assert!(!String::from_utf8_lossy(&rest).contains("ss&\"w"), "{prefix}|{suffix}");
            }
        }
    }

    /// A card sits in an ordinary field, like a code: the checkout page runs no script while the agent is on it, and
    /// what comes back says the reference where the page shows the number, whole or in groups of four.
    #[test]
    fn no_script_runs_where_a_card_was_typed() {
        let page = "https://f.example/checkout";
        for v in ["4242424242424242", "4242 4242 4242 4242"] {
            FILLED.locked().push(("f.example".into(), v.into(), "vault:card:visa:number".into(), page.into()));
        }
        assert!(holds_a_secret("f.example", page));
        assert!(!holds_a_secret("f.example", "https://f.example/thanks"), "the card went with the page");
        assert_eq!(unsaid("f.example", "Card 4242 4242 4242 4242 (4242424242424242)".into()), "Card vault:card:visa:number (vault:card:visa:number)");
    }

    /// One owner approval is bound to the exact checkout, field and target and can be consumed only once.
    /// The action that sends a filled card is the owner's: once a card sits in a page (its document, or a page at its
    /// address), and from the moment the owner is asked until their approval lapses, an agent's command that could
    /// change the order or submit it is refused (a fill, a choice, a click, a key, a script, a navigation); reads,
    /// waits, scrolls and close go. A page the card isn't in is the agent's again.
    #[test]
    fn an_agent_cannot_change_or_submit_a_checkout_after_a_card_is_filled() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        crate::payhold::begin("closing.example", &["closing-pay.example".into()]).unwrap();
        // The agent closes the checkout's tab, then the whole browser goes: the hold stands through both.
        forget_approvals("closing.example", Some(&tab_of("1:pay")));
        browser_gone("closing.example");
        assert!(site_holds_a_card("closing.example"), "closing never ends the hold");
        assert!(card_gate("closing.example", &tab_of("2:new"), &args(&["open", "https://closing.example/checkout/confirm"])).is_err(), "nor does a new tab, from another session");
        assert!(card_holds_host("www.closing.example").is_some(), "a route to the site is held");
        assert!(card_holds_host("payments.closing-pay.example").is_some(), "and to a host the checkout named");
        // Only the owner's release ends it.
        assert_eq!(crate::payhold::release("closing.example"), Ok(1));
        assert!(!site_holds_a_card("closing.example"));
        assert!(card_holds_host("payments.closing-pay.example").is_none());
    }

    /// Default-deny at the one place every agent command crosses: while a card sits in a page of a site, or the owner
    /// is deciding on one, only `close`, `get url` and `get title` (answered by the node from the browser's own tab
    /// list) go. Every command the node lets agents send, and every action the browser's daemon accepts, is either one
    /// of those exactly or refused: a focus, a hover, a scroll (each of which runs a handler the page can arm to change
    /// the order or submit it), a snapshot or a text (which the browser reads by running script in the page), and any
    /// command named after today.
    #[test]
    fn a_card_lock_refuses_focus_hover_and_scroll_event_actions() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        let daemon = include_str!("../../../unbrowse-browser/cli/src/native/actions.rs");
        let mut names: Vec<String> = daemon
            .lines()
            .filter_map(|l| {
                let l = l.trim_start();
                let rest = l.strip_prefix('"')?;
                let (name, tail) = rest.split_once('"')?;
                (tail.trim_start().starts_with("=> handle_") && !name.is_empty()).then(|| name.to_string())
            })
            .collect();
        assert!(names.len() > 50, "the daemon's actions were read: {names:?}");
        names.extend(COMMANDS.iter().map(|c| c.to_string()));
        names.extend(["focus", "hover", "scroll", "scrollintoview", "snapshot", "wait", "screenshot", "tomorrows_command"].map(String::from));
        names.sort();
        names.dedup();
        crate::payhold::begin("gate.example", &[]).unwrap();
        for name in &names {
            for a in [args(&[name.as_str()]), args(&[name.as_str(), "@e1"]), args(&[name.as_str(), "@e1", "990"]), args(&[name.as_str(), "url"]), args(&[name.as_str(), "down", "500"])] {
                let allowed = matches!(a.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), ["close"] | ["get", "url"] | ["get", "title"]);
                assert_eq!(card_safe(&a).is_some(), allowed, "{a:?}");
                if !allowed {
                    assert_eq!(card_gate("gate.example", &tab_of("1:pay"), &a), Err(CARD_IS_THE_OWNERS.to_string()), "{a:?} is refused");
                    // From any other session's tab of the site too.
                    assert!(card_gate("gate.example", &tab_of("2:other"), &a).is_err(), "{a:?} from another session");
                }
            }
        }
        assert_eq!(card_gate("gate.example", &tab_of("1:pay"), &args(&["close"])), Ok(None), "close goes on to the browser");
        // The address is the browser's own list's; with no browser to list it, nothing is said.
        assert!(card_gate("gate.example", &tab_of("1:pay"), &args(&["get", "url"])).is_err());
        assert!(card_gate("gate.example", &tab_of("1:pay"), &args(&["get", "url", "--extra"])).is_err(), "only the exact form");
        crate::payhold::release("gate.example").unwrap();
        assert_eq!(card_gate("gate.example", &tab_of("1:pay"), &args(&["click", "@pay"])), Ok(None), "once the owner released it, the site is the agent's");
    }

    /// A route to the site of a frame the checkout page holds (a payment provider's) is held with the checkout: a
    /// payment on that page may be confirmed through either. Once the checkout is gone, it isn't.
    #[test]
    fn a_payment_providers_frame_is_held_with_its_checkout() {
        use crate::checkout::fixture;
        let mut measured = fixture("document:FR1", "10.00", "");
        measured.url = "https://frames.example/checkout".into();
        measured.controls[0].attrs.push(("action".into(), "https://pay.other-processor.example/charge".into()));
        hold_checkout("frames.example", &measured).unwrap();
        assert!(card_holds_host("js.provider.example").is_some(), "the provider whose frame the checkout holds");
        assert!(card_holds_host("pay.other-processor.example").is_some(), "the host its form posts to");
        assert!(card_holds_host("www.frames.example").is_some(), "the checkout's own site");
        assert!(card_holds_host("unrelated.example").is_none());
        crate::payhold::release("frames.example").unwrap();
        assert!(card_holds_host("js.provider.example").is_none(), "once the owner released it");
    }

    /// The hosts a checkout submits to are held with it, as far as the browser's own record shows: a request that
    /// sends something (a POST to a payment processor no frame or form names) is; a plain fetch of a resource isn't.
    #[test]
    fn the_hosts_a_checkout_submits_to_are_held_with_it() {
        let _home = store::scratch_home("checkout-submits");
        crate::payhold::seal_for_tests();
        let log = capture_dir().join(format!("{}.jsonl", session_of("netcheck.example")));
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let line = |method: &str, url: &str| serde_json::json!({ "type": "exchange", "t": store::now() as f64, "entry": { "request": { "method": method, "url": url } } }).to_string();
        std::fs::write(&log, [line("GET", "https://cdn.static-files.example/app.js"), line("POST", "https://api.netpay-processor.example/v1/charges"), line("POST", "https://netcheck.example/cart")].join("\n")).unwrap();
        let mut measured = crate::checkout::fixture("document:N1", "10.00", "");
        measured.url = "https://netcheck.example/checkout".into();
        measured.frames.clear();
        hold_checkout("netcheck.example", &measured).unwrap();
        assert!(card_holds_host("api.netpay-processor.example").is_some(), "where the checkout's page sent something");
        assert!(card_holds_host("cdn.static-files.example").is_none(), "a resource it only fetched");
        crate::payhold::release("netcheck.example").unwrap();
    }

    /// What the page changed beside a card fill is told to the owner when the page is handed to them, with what the node
    /// can't vouch for; a site with no hold is handed over with nothing added.
    #[test]
    fn the_owner_is_told_at_the_hand_off_what_the_node_could_not_check() {
        crate::payhold::begin("handoff.example", &[]).unwrap();
        crate::payhold::warn("handoff.example", "as the card's number went in, a value on the checkout (field 1) changed since the owner approved the card");
        let note = hand_over_note("handoff.example", "1:pay").unwrap();
        assert!(note.contains("can't vouch for the amount") && note.contains("field 1") && note.contains("couldn't measure"), "{note}");
        assert!(hand_over_note("nothing-held.example", "1:pay").is_none());
        crate::payhold::release("handoff.example").unwrap();
    }

    /// While any checkout waits for the owner, no agent command takes a step in any page of any site, however
    /// unrelated (the order may be committed through a host the checkout reaches only later): every command the node
    /// lets agents send and every action the browser's daemon accepts is either a read of the page or refused, a
    /// vault login fill included. Reads of other sites go on, and once the owner releases the hold, so do steps.
    #[test]
    fn while_a_checkout_waits_the_agent_takes_no_step_on_any_site() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        crate::payhold::begin("waiting-shop.example", &[]).unwrap();
        let tab = tab_of("1:elsewhere");
        let daemon = include_str!("../../../unbrowse-browser/cli/src/native/actions.rs");
        let mut names: Vec<String> = daemon
            .lines()
            .filter_map(|l| {
                let rest = l.trim_start().strip_prefix('"')?;
                let (name, tail) = rest.split_once('"')?;
                (tail.trim_start().starts_with("=> handle_") && !name.is_empty()).then(|| name.to_string())
            })
            .collect();
        names.extend(COMMANDS.iter().map(|c| c.to_string()));
        names.extend(["focus", "hover", "scroll", "open", "find", "snapshot", "get", "is", "screenshot", "wait", "tomorrows_command"].map(String::from));
        for name in &names {
            for a in [args(&[name.as_str()]), args(&[name.as_str(), "text", "body"]), args(&[name.as_str(), "@e1"])] {
                if card_safe(&a).is_some() {
                    continue;
                }
                let why = card_gate("unrelated.example", &tab, &a).unwrap_err();
                assert!(why.contains("waiting for the owner"), "{a:?}: {why}");
                assert!(refuse_where_a_card_sits("unrelated.example", &a).is_err(), "{a:?}");
            }
        }
        // A read of a page runs code the page defines (a getter behind innerText): none goes, on any site.
        for read in [&["snapshot", "-i"][..], &["get", "text", "body"], &["is", "visible", "@e2"], &["screenshot"], &["wait", "1000"]] {
            assert!(card_gate("unrelated.example", &tab, &args(read)).is_err(), "{read:?} is refused while a checkout waits");
        }
        assert_eq!(card_gate("unrelated.example", &tab, &args(&["close"])), Ok(None), "close goes");
        crate::payhold::release("waiting-shop.example").unwrap();
        assert_eq!(card_gate("unrelated.example", &tab, &args(&["get", "text", "body"])), Ok(None), "released, reads go");
        assert_eq!(card_gate("unrelated.example", &tab, &args(&["click", "@e1"])), Ok(None), "and steps");
    }

    /// While a checkout waits, only the checkout's own browser connects, to any host its page needs; every other
    /// browser connects nowhere, the checkout's own site and the hosts its hold lists included (a worker or a page there
    /// could send a write to a listed host), and so does one with no listener of its own. Released, every browser
    /// reaches every host again.
    #[test]
    fn only_the_checkouts_own_browser_connects_while_it_waits() {
        crate::payhold::begin("proxy-shop.example", &["proxy-pay.example".into()]).unwrap();
        for (label, host) in [
            (Some("unheld-site.example"), "www.unheld-site.example"),
            (None, "api.unheld-site.example"),
            (Some("unheld-site.example"), "checkout.proxy-shop.example"),
            (Some("unheld-site.example"), "js.proxy-pay.example"),
            (None, "js.proxy-pay.example"),
        ] {
            assert!(browser_may_connect(label, host).is_some(), "{label:?} -> {host}");
        }
        assert!(browser_may_connect(Some("proxy-shop.example"), "acs.card-issuer.example").is_none(), "the checkout's own browser reaches its issuer");
        assert!(browser_may_connect(Some("proxy-shop.example"), "js.proxy-pay.example").is_none());
        crate::payhold::release("proxy-shop.example").unwrap();
        assert!(browser_may_connect(Some("unheld-site.example"), "www.unheld-site.example").is_none(), "released");
    }

    /// A checkout adds at most a few other hosts to its hold, and the owner is shown every one it holds and how many
    /// more it named: a hostile page that names many sites holds only those few for reads (writes go nowhere while it
    /// waits, whichever host they are for).
    #[test]
    fn a_checkout_names_at_most_n_other_hosts_and_the_owner_sees_them() {
        let named: Vec<String> = (0..20).map(|i| format!("named-{i}.example")).collect();
        crate::payhold::begin("many-hosts.example", &named).unwrap();
        let hold = crate::payhold::of("many-hosts.example").unwrap();
        assert_eq!(hold.hosts.len(), crate::payhold::MOST_HOSTS);
        assert_eq!(hold.more, 20 - crate::payhold::MOST_HOSTS);
        let shown = crate::payhold::shown(&hold);
        for h in &hold.hosts {
            assert!(shown.contains(h.as_str()), "the owner sees {h}: {shown}");
            assert!(card_holds_host(h).is_some(), "{h} is held for reads");
        }
        assert!(shown.contains(&format!("{} more", 20 - crate::payhold::MOST_HOSTS)), "{shown}");
        assert!(card_holds_host("named-19.example").is_none(), "a host past the few isn't held, and the owner was told how many");
        assert!(crate::payhold::waiting().is_some(), "but nothing that changes state goes to it, or anywhere");
        crate::payhold::release("many-hosts.example").unwrap();
    }

    /// The agent API refuses a command on a site a card sits in before the node does anything of its own in its pages
    /// (its passkey guard, a look before a click), so what `act` would refuse sets off no page code first; the three
    /// safe commands and the card's own approved fill go on to their gates.
    #[test]
    fn nothing_runs_in_a_held_site_before_its_refusal() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        crate::payhold::begin("early.example", &[]).unwrap();
        for refused in [&["snapshot", "-i"][..], &["click", "@pay"], &["scroll", "down"], &["focus", "@pan"], &["get", "text", "body"]] {
            assert_eq!(refuse_where_a_card_sits("early.example", &args(refused)), Err(CARD_IS_THE_OWNERS.to_string()), "{refused:?}");
        }
        for safe in [&["close"][..], &["get", "url"], &["get", "title"]] {
            assert!(refuse_where_a_card_sits("early.example", &args(safe)).is_ok(), "{safe:?}");
        }
        crate::payhold::release("early.example").unwrap();
        assert!(refuse_where_a_card_sits("early.example", &args(&["click", "@pay"])).is_ok());
    }

    #[test]
    fn every_grouping_of_a_card_number_is_named() {
        let g = super::card_groupings("4242424242424242");
        for want in ["4242 4242 4242 4242", "4242-4242-4242-4242", "4242 424242 424242", "4242-424242-424242"] {
            assert!(g.iter().any(|x| x == want), "{want}: {g:?}");
        }
        let amex = super::card_groupings("378282246310005");
        assert!(amex.iter().any(|x| x == "3782 822463 10005") && amex.iter().any(|x| x == "3782-822463-10005"), "{amex:?}");
        assert!(!amex.iter().any(|x| x == "378282246310005"), "the number as it is is named by the fill itself");
    }

    #[test]
    fn a_checkout_approval_lapses_when_a_form_value_changes() {
        use crate::checkout::fixture;
        approve_card("shop.example", "shop.example", "visa", "1:a", fixture("document:C1", "10.00", ""));
        // Only the card, the session and the page the owner approved, read as they approved it.
        assert!(take_card_fill("shop.example", "amex", "1:a", &fixture("document:C1", "10.00", "")).is_err());
        assert!(take_card_fill("shop.example", "visa", "2:a", &fixture("document:C1", "10.00", "")).is_err());
        assert!(take_card_fill("other.example", "visa", "1:a", &fixture("document:C1", "10.00", "")).is_err());
        assert!(take_card_fill("shop.example", "visa", "1:a", &fixture("document:C2", "10.00", "")).is_err(), "another load of the page");
        assert!(take_card_fill("shop.example", "visa", "1:a", &fixture("document:C1", "990.00", "")).is_err(), "an amount changed meanwhile");
        assert!(take_card_fill("shop.example", "visa", "1:a", &fixture("document:C1", "10.00", "")).is_ok());
        // A yes that wasn't used in time lapses, whatever the page reads.
        CARD_APPROVALS.locked().iter_mut().filter(|a| a.site == "shop.example").for_each(|a| a.first_by = store::now() - 1);
        assert!(take_card_fill("shop.example", "visa", "1:a", &fixture("document:C1", "10.00", "")).is_err());
    }

    /// One yes per checkout page covers the card's fields there for one fill sequence: each fill measures the page
    /// again, the card's typed fields aside, and every other control must read as approved; the hand-off to the owner
    /// is held to the same. The yes lapses with its life, and covers that page alone.
    #[test]
    fn one_approval_covers_the_cards_fields_on_its_checkout_page() {
        use crate::checkout::fixture;
        let pan = "4242424242424242";
        approve_card("pay.example", "pay.example", "visa", "1:p", fixture("document:Q1", "10.00", ""));
        assert!(card_approved_here("pay.example", "visa", "1:p", "document:Q1"));
        assert!(take_card_fill("pay.example", "visa", "1:p", &fixture("document:Q1", "10.00", "")).is_ok(), "the number");
        note_card_typed("pay.example", "visa", "1:p", "document:Q1", crate::checkout::filled_by(&fixture("document:Q1", "10.00", ""), &fixture("document:Q1", "10.00", pan), pan, true));
        assert!(take_card_fill("pay.example", "visa", "1:p", &fixture("document:Q1", "10.00", "4242 4242 4242 4242")).is_ok(), "the expiry, after the number went in");
        assert!(take_card_fill("pay.example", "visa", "1:p", &fixture("document:Q1", "11.00", pan)).is_err(), "the page changed the amount between fields");
        assert_eq!(as_approved_for_the_owner("pay.example", "1:p", &fixture("document:Q1", "10.00", pan)), Ok(true), "handed over as approved");
        assert!(as_approved_for_the_owner("pay.example", "1:p", &fixture("document:Q1", "11.00", pan)).is_err(), "not when it changed");
        assert_eq!(as_approved_for_the_owner("pay.example", "1:p", &fixture("document:Q9", "10.00", "")), Ok(false), "another page has no card approved");
        assert!(!card_approved_here("pay.example", "visa", "1:p", "document:Q2"), "another page asks again");
        assert!(!card_approved_here("pay.example", "amex", "1:p", "document:Q1"), "another card asks again");
        CARD_APPROVALS.locked().iter_mut().filter(|a| a.site == "pay.example").for_each(|a| a.until = store::now() - 1);
        assert!(!card_approved_here("pay.example", "visa", "1:p", "document:Q1"));
        assert!(take_card_fill("pay.example", "visa", "1:p", &fixture("document:Q1", "10.00", pan)).is_err(), "a lapsed yes covers nothing");
        assert_eq!(as_approved_for_the_owner("pay.example", "1:p", &fixture("document:Q1", "10.00", pan)), Ok(true), "the record of what was approved outlives the yes");
    }

    /// A caller-stated amount is not evidence; card fills have only the node-controlled fill syntax.
    #[test]
    fn a_card_fill_rejects_an_unbound_amount_claim() {
        assert!(card_fill(&args(&["fill", "@e4", "vault:card:visa:number"])).is_some());
        assert!(card_fill(&args(&["fill", "@e4", "vault:card:visa:number", "--amount", "0.01"])).is_none());
    }

    #[test]
    fn a_card_reference_goes_in_only_by_fill() {
        assert_eq!(card_fill(&args(&["fill", "@e4", "vault:card:visa:number"])).map(|r| r.name()), Some("vault:card:visa:number".into()));
        assert!(card_fill(&args(&["fill", "@e4", "vault:github.com:me"])).is_none());
        assert!(site_for(&args(&["type", "@e4", "vault:card:visa:number"]), Some("f.example"), "").is_err());
    }

    /// What the owner typed by hand into a secret field (`hands`) never comes back to an agent, and no agent script
    /// runs on that page while the agent is on it: like a code, it may sit in a field no count can tell apart.
    #[test]
    fn what_the_owner_typed_by_hand_never_comes_back() {
        let page = "https://h.example/login";
        owner_typed("h.example", "Owner-Pass-77", page);
        assert_eq!(unsaid("h.example", "value: Owner-Pass-77".into()), format!("value: {}", crate::hands::BY_OWNER));
        assert!(holds_a_secret("h.example", page), "on its page, even once the field has gone");
        assert!(!holds_a_secret("h.example", "https://h.example/feed"), "signed in and moved on: scripts run again");
        // A password the node filled from the vault, still in its field when the owner clicks on, keeps its name.
        FILLED.locked().push(("h.example".into(), "Vault-Pass-12".into(), "vault:h.example:me".into(), page.into()));
        owner_typed("h.example", "Vault-Pass-12", page);
        assert_eq!(unsaid("h.example", "Vault-Pass-12".into()), "vault:h.example:me");
        owner_typed("h.example", "", page);
        assert_eq!(FILLED.locked().iter().filter(|(s, ..)| s == "h.example").count(), 2, "nothing typed, nothing kept");
    }

    /// B04 (Lewis, 18 Nov 2026: yes): while the owner holds a site's page, or an agent's ask waits on them, an agent
    /// still reads the page (its address, its title, its text, a snapshot, a picture), and reading leaves the ask
    /// waiting. What would change the page, run a script in it or read a field's value waits for the owner.
    #[test]
    fn an_agent_reads_but_does_not_act_while_the_owner_has_the_page() {
        let reads: &[&[&str]] = &[&["get", "url"], &["get", "title"], &["get", "text", "h1"], &["snapshot", "-i"], &["screenshot"], &["is", "visible", "@e1"]];
        let steps: &[&[&str]] = &[&["click", "@e1"], &["fill", "@e2", "hello"], &["press", "Enter"], &["goto", "https://busy.example/next"], &["eval", "1"], &["get", "value", "@e2"], &["find", "role", "button", "click"]];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let waiting = rt.spawn(crate::hands::ask("busy.example", None, "sign in", "agent", std::time::Duration::from_secs(30), None, |_| {}));
        while !crate::hands::asks().iter().any(|a| a.site == "busy.example") {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        for read in reads {
            assert_eq!(page_policy("busy.example", "1:", &args(read)), Ok(None), "{read:?} reads on while an ask waits");
        }
        for step in steps {
            let refused = page_policy("busy.example", "1:", &args(step)).unwrap_err();
            assert!(refused.contains("waiting on the owner"), "{step:?}: {refused}");
        }
        assert!(crate::hands::asks().iter().any(|a| a.site == "busy.example"), "a read leaves the ask waiting");
        crate::hands::answer("busy.example", crate::hands::Answer::Done);
        assert_eq!(rt.block_on(waiting).unwrap(), crate::hands::Answer::Done);

        // The owner took the page by hand in the node's window: the same.
        crate::hands::hold_for_test("held.example", true);
        for read in reads {
            assert_eq!(page_policy("held.example", "1:", &args(read)), Ok(None), "{read:?} reads on while the owner holds the page");
        }
        for step in steps {
            let refused = page_policy("held.example", "1:", &args(step)).unwrap_err();
            assert!(refused.contains("the owner has held.example's page"), "{step:?}: {refused}");
        }
        crate::hands::hold_for_test("held.example", false);
    }

    /// An ask left on a site whose browser has gone doesn't lock the site: opening its page again ends the ask.
    #[test]
    fn opening_a_closed_site_ends_an_ask_with_no_page() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let waiting = rt.spawn(crate::hands::ask("closed.example", None, "sign in", "agent", std::time::Duration::from_secs(30), None, |_| {}));
        while !crate::hands::asks().iter().any(|a| a.site == "closed.example") {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let _ = act(&args(&["open", "https://closed.example/"]), Some("closed.example"), "agent", "1:");
        assert_eq!(rt.block_on(waiting).unwrap(), crate::hands::Answer::NoAnswer);
        assert!(crate::hands::busy("closed.example").is_none());
    }

    /// External security review round 3, 2026-11-04 (an older browser types the secret, then the node errors before
    /// it holds the page). The page is held before the browser is asked to type: a fill that fails after it typed,
    /// or one whose answer never comes, leaves the page held, never open to scripts.
    #[test]
    fn a_fill_that_fails_after_typing_still_holds_its_page() {
        let failed: Result<(), String> = held_then_typed("late.example", "t-late", "Late-Pass-51", "vault:late.example:me", "document:L1", "https://late.example/login", || Err("the browser didn't say it checked the field".into()));
        assert!(failed.is_err());
        assert!(holds_a_secret("late.example", "document:L1"), "held though the fill failed");
        assert_eq!(unsaid("late.example", "value=Late-Pass-51".into()), "value=vault:late.example:me", "and said as its name");
    }

    /// A script marked on the tab between a fill's first check and its hold (the two sent at once) stops the fill
    /// before anything is typed: the fill reads the marks again once the page is held.
    #[test]
    fn a_script_sent_with_a_fill_stops_it_before_anything_is_typed() {
        mark_scripted("race.example", "t-race");
        let mut typed = false;
        let r: Result<(), String> = held_then_typed("race.example", "t-race", "Race-Pass-71", "vault:race.example:me", "document:R1", "https://race.example/login", || {
            typed = true;
            Ok(())
        });
        assert!(r.is_err() && !typed, "nothing typed into a tab a script ran in");
        assert!(held_then_typed("race.example", "t-other", "Race-Pass-71", "vault:race.example:me", "document:R2", "https://race.example/login", || Ok(())).is_ok(), "another tab");
        scripts_closed("race.example", None);
    }

    /// External security review round 3, 2026-11-04 (the hold is tied to the document only). It fails closed: when
    /// the browser can't name the page's document, a site with a secret held anywhere holds the page; and a page at
    /// the address a held document was at holds too, though it is another document (going back in history can give
    /// its fields back what was typed). Another site, or another address, is not held.
    #[test]
    fn a_hold_survives_a_lost_document_name_and_going_back() {
        hold_secret("back.example", "Back-Pass-61", "vault:back.example:me", "document:K1", "https://back.example/login#step2");
        assert!(holds_at("back.example", None, "https://back.example/feed"), "the browser couldn't name the document");
        assert!(holds_at("back.example", Some("document:K1"), "https://back.example/elsewhere"), "the same document, moved by pushState");
        assert!(holds_at("back.example", Some("document:K9"), "https://back.example/login"), "another document at the held address: back in history");
        assert!(!holds_at("back.example", Some("document:K9"), "https://back.example/feed"), "another page");
        assert!(!holds_at("elsewhere.example", None, "https://elsewhere.example/"), "a site with nothing held");
    }

    /// External security review round 3, 2026-11-04 (a restart forgets every hold while browsers keep running). The
    /// holds and the scripted tabs are kept on disk, never the secrets, and a node that starts again with the site's
    /// browser still running holds its pages as before.
    #[test]
    fn holds_and_scripted_tabs_outlive_a_restart_of_the_node() {
        let home = short_home("holds-restart");
        std::fs::create_dir_all(sockets()).unwrap();
        let _browser = browser_at("restart.example");
        hold_secret("restart.example", "Restart-Pass-71", "vault:restart.example:me", "document:R1", "https://restart.example/login");
        mark_scripted("restart.example", "t-71");
        let kept = std::fs::read_to_string(home.join("secret-holds.json")).unwrap();
        assert!(!kept.contains("Restart-Pass-71"), "no secret on disk");
        // The node restarts: what it held in memory is gone.
        FILLED.locked().retain(|(s, ..)| s != "restart.example");
        PLACES.locked().retain(|p| p.site != "restart.example");
        SCRIPTED.locked().retain(|(s, _)| s != "restart.example");
        assert!(!holds_a_secret("restart.example", "document:R1"));
        restore_holds();
        assert!(holds_a_secret("restart.example", "document:R1"), "held again");
        assert!(no_secret_after_a_script("restart.example", "t-71").is_err(), "the scripted tab is still marked");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A hold outlives a restart and what it scrubbed with doesn't: a page whose secret the node no longer knows says
    /// nothing a field could hold, wherever that secret came from, until it is left.
    #[test]
    fn a_page_holding_a_secret_the_node_forgot_says_nothing() {
        let place = |name: &str| Place { site: "s.example".into(), name: name.into(), page: "document:P1".into(), at: "https://s.example/pay".into() };
        let nothing = |_: &str| false;
        for read in [&["get", "value", "#card"][..], &["get", "html", "body"], &["get", "text", "#card"], &["get", "attr", "#card", "value"], &["get", "url"], &["snapshot"], &["find", "label", "Card"]] {
            assert!(says_the_page(&args(read)), "{read:?}");
        }
        for quiet in [&["get", "count", "#card"][..], &["get", "box", "#card"], &["click", "#pay"], &["open", "https://s.example/"], &["is", "visible", "#card"]] {
            assert!(!says_the_page(&args(quiet)), "{quiet:?}");
        }
        let card = [place("vault:card:visa:number")];
        assert!(unhidden_at(false, &card, &nothing, Some("document:P1"), "https://s.example/pay"), "the document it went into");
        assert!(unhidden_at(false, &card, &nothing, Some("document:P2"), "https://s.example/pay"), "going back may fill the field again");
        assert!(unhidden_at(false, &card, &nothing, None, "https://s.example/other"), "a page the browser can't name");
        assert!(!unhidden_at(false, &card, &nothing, Some("document:P2"), "https://s.example/done"), "left: another page holds nothing");
        // A vault login the node can read again is said as its name, as it always was.
        let login = [place("vault:s.example:me")];
        assert!(!unhidden_at(false, &login, &|n| n == "vault:s.example:me", Some("document:P1"), "https://s.example/pay"));
        assert!(unhidden_at(true, &[], &nothing, Some("document:P9"), "https://s.example/done"), "a browser in doubt holds every page");
        assert!(!unhidden_at(false, &[], &nothing, Some("document:P1"), "https://s.example/pay"));
    }

    /// The restart that empties the scrubbing: a page held before it is one no read gets past, and one the owner was
    /// still typing into is held though nothing ever read the field.
    #[test]
    fn a_restart_leaves_a_page_held_with_nothing_to_hide_it() {
        let home = short_home("holds-unheard");
        std::fs::create_dir_all(sockets()).unwrap();
        let _browser = browser_at("unheard.example");
        hold_secret("unheard.example", "Unheard-Pass-61", "vault:card:visa:number", "document:U1", "https://unheard.example/pay");
        owner_typing("unheard.example", "https://unheard.example/code");
        FILLED.locked().retain(|(s, ..)| s != "unheard.example");
        PLACES.locked().retain(|p| p.site != "unheard.example");
        TYPING.locked().retain(|(s, _)| s != "unheard.example");
        restore_holds();
        let places: Vec<Place> = UNHEARD.locked().iter().filter(|p| p.site == "unheard.example").cloned().collect();
        assert!(unhidden_at(false, &places, &|_| false, Some("document:U1"), "https://unheard.example/pay"));
        assert!(unhidden_at(false, &places, &|_| false, Some("document:U2"), "https://unheard.example/code"), "typing a restart cut short");
        assert!(holds_at("unheard.example", Some("document:U2"), "https://unheard.example/code"), "and scripts stay away from it too");
        scripts_closed_with("unheard.example", None, || Some(0));
        assert!(!UNHEARD.locked().iter().any(|p| p.site == "unheard.example"), "a browser closed takes its pages with it");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A bad file used to be overwritten by the next mark with only that mark, and the next start read a good file: the
    /// doubt it raised was gone with the browsers still running. It now stays in the file for as long as they do.
    #[test]
    fn a_holds_file_that_didnt_read_stays_in_doubt_while_its_browsers_run() {
        let doors = || vec!["a.sock".to_string(), "b.sock".to_string()];
        assert_eq!(still_doubted(None, doors()), doors(), "every browser running");
        let rewritten: Holds = serde_json::from_str(&serde_json::to_string(&Holds { doubted: doors(), ..Holds::default() }).unwrap()).unwrap();
        assert_eq!(still_doubted(Some(&rewritten), doors()), doors(), "the start after it reads a good file that remembers");
        assert_eq!(still_doubted(Some(&rewritten), vec!["b.sock".to_string(), "new.sock".to_string()]), ["b.sock"], "one that has gone, and one started since");
        assert!(still_doubted(Some(&Holds::default()), doors()).is_empty());
        let older: Holds = serde_json::from_str(r#"{"places":[],"scripted":[]}"#).unwrap();
        assert!(older.doubted.is_empty() && older.typing.is_empty(), "a file from before reads");
    }

    /// External security review round 3, 2026-11-04 (closing a scripted tab clears its mark while popups it opened stay
    /// open). A scripted tab that closes while its browser still has a page no session's tab names (a popup it opened)
    /// leaves its site marked, so the passkey never comes back to that browser while the popup is open.
    #[test]
    fn a_scripted_tabs_popups_keep_its_mark_after_it_closes() {
        mark_scripted("popup.example", "t-81");
        scripts_closed_with("popup.example", Some("t-81"), || Some(1));
        assert!(SCRIPTED.locked().iter().any(|(s, t)| s == "popup.example" && t == OPENED_BY_A_SCRIPT), "a popup is still open");
        mark_scripted("nopopup.example", "t-82");
        scripts_closed_with("nopopup.example", Some("t-82"), || Some(0));
        assert!(!SCRIPTED.locked().iter().any(|(s, _)| s == "nopopup.example"), "nothing it opened is left");
        mark_scripted("unsure.example", "t-83");
        scripts_closed_with("unsure.example", Some("t-83"), || None);
        assert!(SCRIPTED.locked().iter().any(|(s, _)| s == "unsure.example"), "a browser that can't say keeps the mark");
        scripts_closed_with("popup.example", None, || Some(1));
        assert!(!SCRIPTED.locked().iter().any(|(s, _)| s == "popup.example"), "the whole browser closed");
    }

    /// A secret is held by the document it went into, not by the address the page shows: a fragment a link or the
    /// page adds is the same document, with the same field still holding it.
    #[test]
    fn a_fragment_never_lets_scripts_back_onto_a_filled_page() {
        FILLED.locked().push(("frag.example".into(), "Frag-Pass-31".into(), "vault:frag.example:me".into(), "https://frag.example/login".into()));
        assert!(holds_a_secret("frag.example", "https://frag.example/login#done"), "the same page, its field still there");
        assert!(holds_a_secret("frag.example", "https://frag.example/login#"));
        assert!(!holds_a_secret("frag.example", "https://frag.example/home"), "another page");
        // The node's own fills are held to the browser's name for the document, which no fragment or pushState moves.
        FILLED.locked().push(("doc.example".into(), "Doc-Pass-32".into(), "vault:doc.example:me".into(), "document:A1".into()));
        assert!(holds_a_secret("doc.example", "document:A1"));
        assert!(!holds_a_secret("doc.example", "document:B2"), "a new load");
    }

    /// The redaction of a secret never runs out while other things are filled: filling other logins, here or on
    /// other sites, and the owner typing by hand, never push a password out of what the agent is told.
    #[test]
    fn other_fills_never_push_a_password_out_of_what_comes_back() {
        FILLED.locked().push(("keep.example".into(), "Keep-Pass-41".into(), "vault:keep.example:me".into(), "https://keep.example/login".into()));
        for n in 0..40 {
            owner_typed("keep.example", &format!("owner-typed-{n:02}"), "https://keep.example/login");
            owner_typed(&format!("other{n}.example"), &format!("elsewhere-{n:02}"), "https://other.example/");
        }
        assert_eq!(unsaid("keep.example", "value: Keep-Pass-41".into()), "value: vault:keep.example:me");
        assert_eq!(unsaid("keep.example", "owner-typed-39".into()), crate::hands::BY_OWNER, "the newest of a name stay");
    }

    /// A password the page says back inside an address (a form sent by GET, a fragment) is said as its login's name
    /// too, however the address encodes it.
    #[test]
    fn a_password_in_an_address_still_comes_back_as_its_name() {
        FILLED.locked().push(("addr.example".into(), "p@ss w0rd!&x".into(), "vault:addr.example:me".into(), "https://addr.example/login".into()));
        assert_eq!(unsaid("addr.example", "https://addr.example/in?pw=p%40ss+w0rd%21%26x".into()), "https://addr.example/in?pw=vault:addr.example:me");
        assert_eq!(unsaid("addr.example", "https://addr.example/in#p%40ss%20w0rd%21%26x".into()), "https://addr.example/in#vault:addr.example:me");
        assert_eq!(unsaid("addr.example", "p@ss w0rd!&x".into()), "vault:addr.example:me");
    }

    /// A screenshot waits like a script while a page may hold a secret: a picture shows a card or a code as it is,
    /// and can't be said back with references.
    #[test]
    fn no_picture_is_taken_where_a_secret_may_sit() {
        assert!(held_near_a_secret(&args(&["screenshot"])));
        assert!(held_near_a_secret(&args(&["screenshot", "--full"])));
        assert!(held_near_a_secret(&args(&["eval", "1"])));
        assert!(!held_near_a_secret(&args(&["snapshot", "-i"])), "a snapshot is said back with references");
        assert!(!held_near_a_secret(&args(&["click", "@e1"])));
    }

    /// A page holding a secret answers no read of a field's value, an attribute or its markup: those come back in
    /// whatever form the page wrote the secret, which no list of forms covers. Its text and snapshot still go, said
    /// back with references, and a page holding nothing answers every read.
    #[test]
    fn no_field_value_attribute_or_markup_is_read_where_a_secret_may_sit() {
        let site = "rawread.example";
        for read in [&["get", "value", "#pw"][..], &["get", "html", "body"], &["get", "attr", "#pw", "value"]] {
            assert!(held_near_a_secret(&args(read)), "{read:?}");
            assert!(no_script_near_a_login(site, "1:t", &args(read)).is_ok(), "nothing held yet: {read:?}");
        }
        FILLED.locked().push((site.into(), "Raw-Read-Pass-19".into(), "vault:rawread.example:me".into(), "https://rawread.example/login".into()));
        for read in [&["get", "value", "#pw"][..], &["get", "html", "body"], &["get", "attr", "#pw", "value"]] {
            assert!(no_script_near_a_login(site, "1:t", &args(read)).is_err_and(|e| e.contains("reads no field's value")), "{read:?}");
        }
        for read in [&["get", "text", "body"][..], &["snapshot"], &["get", "url"], &["get", "count", "input"], &["click", "@e3"], &["click", "form .submit"]] {
            assert!(no_script_near_a_login(site, "1:t", &args(read)).is_ok(), "{read:?}");
        }
        let asked = no_script_near_a_login(site, "1:t", &args(&["get", "count", "input[value^=\"Hun\"]"])).unwrap_err();
        assert!(asked.contains("takes no selector here"), "{asked}");
        assert!(no_script_near_a_login(site, &tab_of(HEAL), &args(&["get", "count", "input[name=password]"])).is_ok(), "the node's own sign-in counts its field");
        assert!(no_script_near_a_login(site, &tab_of(HEAL), &args(&["eval", "1"])).is_err(), "and runs no script there either");
        FILLED.locked().retain(|(s, ..)| s != site);
    }

    /// A checkout page an agent's script ran in is never shown to the owner for a card: what they read there (the
    /// total, the order) the script could have drawn. Another tab of the site, untouched, still may be.
    #[test]
    fn no_card_is_asked_for_on_a_page_an_agent_script_ran_in() {
        let site = "scriptedpay.example";
        assert!(unscripted_for_a_card(site, "1:pay").is_ok());
        mark_scripted(site, "1:pay");
        assert_eq!(unscripted_for_a_card(site, "1:pay"), Err(SCRIPTED_FOR_A_CARD.to_string()));
        assert!(unscripted_for_a_card(site, "1:other").is_ok(), "another tab, no script in it");
        SCRIPTED.locked().retain(|(s, _)| s != site);
    }

    /// Only the owner's own typing of a secret counts as their sign-in: a vault password the node filled, typed back,
    /// or nothing typed at all, is not.
    #[test]
    fn only_a_secret_the_owner_typed_counts_as_their_sign_in() {
        let site = "handsign.example";
        let before = owner_secrets_typed(site);
        assert!(!owner_signed_in_since(site, before), "nothing typed");
        FILLED.locked().push((site.into(), "Vault-Pass-31".into(), "vault:handsign.example:me".into(), "https://handsign.example/login".into()));
        owner_typed(site, "Vault-Pass-31", "https://handsign.example/login");
        assert!(!owner_signed_in_since(site, before), "the vault's own password, filled by the node");
        owner_typed(site, "", "https://handsign.example/login");
        assert!(!owner_signed_in_since(site, before), "nothing");
        owner_typed(site, "Owner-Pass-88", "https://handsign.example/login");
        assert!(owner_signed_in_since(site, before), "the owner's own password");
        assert!(!owner_signed_in_since("elsewhere.example", owner_secrets_typed("elsewhere.example")), "another site");
        FILLED.locked().retain(|(s, ..)| s != site);
    }

    /// No vault secret goes into a tab an agent's script ran in since it opened: the script could have left a listener
    /// that hears the value the node types. Closing the tab ends it; another tab on the site is unaffected.
    #[test]
    fn no_secret_goes_into_a_tab_a_script_ran_in() {
        let keys = unbrowse_core::MemoryStore::default();
        store::scratch_home("scripted-tab");
        unbrowse_core::load_or_create(&keys).unwrap();
        let session = "1:scripted";
        let tab = tab_of(session);
        mark_scripted("scripted.example", &tab);
        let refused = fill_from_vault(&args(&["fill", "@e1", "vault:scripted.example:me"]), Some("scripted.example"), "agent", session, &keys, true).unwrap_err();
        assert!(refused.contains("script ran in this tab"), "{refused}");
        let refused = fill_card(&args(&["fill", "@e1", "vault:card:visa:number"]), Some("scripted.example"), "agent", session, &keys).unwrap_err();
        assert!(refused.contains("script ran in this tab"), "{refused}");
        assert!(no_secret_after_a_script("scripted.example", &tab_of("1:other")).is_ok(), "another session's tab");
        scripts_closed("scripted.example", Some(&tab));
        assert!(no_secret_after_a_script("scripted.example", &tab).is_ok(), "closed, and what it left went with it");
        mark_scripted("scripted.example", &tab);
        scripts_closed("scripted.example", None);
        assert!(no_secret_after_a_script("scripted.example", &tab).is_ok(), "the site's browser closed");
    }

    /// Nor is a page an agent's script ran in handed to the owner: the window types into the page it attached to, so
    /// that page counts as scripted when a scripted tab is it, when the node can't name a scripted tab's page (no
    /// browser answers here, as when it has closed or can't say), or when a scripted tab left pages it opened.
    #[test]
    fn the_owner_is_never_shown_a_page_a_script_ran_in() {
        let site = "owner-scripted.example";
        assert!(!script_may_have_run(site, Scope::Page("T-front")), "no script ran on the site");
        mark_scripted(site, &tab_of("2:a"));
        assert!(script_may_have_run(site, Scope::Page("T-front")), "the scripted tab's page can't be named, so any page of the site counts");
        assert!(!script_may_have_run("other-site.example", Scope::Page("T-front")));
        scripts_closed(site, None);
        SCRIPTED.locked().push((site.to_string(), OPENED_BY_A_SCRIPT.to_string()));
        assert!(script_may_have_run(site, Scope::Page("T-front")), "a page a scripted tab opened");
        SCRIPTED.locked().retain(|(a, _)| a != site);
        assert!(!script_may_have_run(site, Scope::Page("T-front")));
    }

    /// A fill the browser was asked to check counts only when the browser says it checked the field.
    #[test]
    fn a_secret_fill_counts_only_when_the_browser_checked_its_field() {
        assert!(checked_field(&serde_json::json!({ "filled": "@e1", "field_checked": true })).is_ok());
        assert!(checked_field(&serde_json::json!({ "filled": "@e1" })).is_err(), "a browser too old to check");
        assert!(checked_field(&serde_json::json!({ "filled": "@e1", "field_checked": false })).is_err());
    }

    #[test]
    fn a_filled_password_never_comes_back() {
        FILLED.locked().push(("b.example".into(), "Zq9-long-pass".into(), "vault:b.example:me".into(), "https://b.example/login".into()));
        assert_eq!(unsaid("b.example", "value: Zq9-long-pass".into()), "value: vault:b.example:me");
        assert_eq!(unsaid("c.example", "Zq9-long-pass".into()), "Zq9-long-pass", "only the site it was filled on");
    }

    /// Every command that runs the agent's script in the page is a script, whatever its verb: a wait on a script's
    /// answer runs it and says it back as eval does.
    #[test]
    fn every_command_that_runs_page_script_is_held_near_a_login() {
        assert!(runs_script(&args(&["eval", "1"])));
        assert!(runs_script(&args(&["wait", "--fn", "document.title"])));
        assert!(runs_script(&args(&["wait", "--timeout", "500", "--fn", "1"])));
        assert!(!runs_script(&args(&["wait", "--text", "Welcome"])));
        assert!(!runs_script(&args(&["get", "url"])));
    }

    /// A vault login goes into one field by fill, never as text anywhere else, where the page would get its name.
    #[test]
    fn a_vault_login_goes_in_only_by_fill() {
        let refused = |a: &[&str]| site_for(&args(a), Some("a.example"), "").is_err();
        assert!(!refused(&["fill", "@e3", "vault:a.example:me"]));
        assert!(vault_fill(&args(&["fill", "@e3", "vault:a.example:me"])).is_some());
        assert!(refused(&["type", "@e3", "vault:a.example:me"]));
        assert!(refused(&["find", "label", "Password", "fill", "vault:a.example:me"]));
        assert!(refused(&["fill", "@e3", "vault:a.example:me", "extra"]));
        assert!(vault_fill(&args(&["fill", "@e3", "hunter22"])).is_none());
    }

    /// UNB-148: a refused command or flag ends with the door that does what the agent wanted, never the refusal alone.
    /// Mined on the Deck, 1 to 15 Nov: `cookies clear` and `--executable-path` were refused with nothing to do next.
    #[test]
    fn a_refused_command_or_flag_names_the_door_that_works() {
        let err = site_for(&args(&["cookies", "clear"]), Some("https://www.shop.co.uk/cart"), "").unwrap_err();
        assert!(err.contains("`unbrowse-node session import shop.co.uk`"), "{err}");
        assert!(err.contains("session forget shop.co.uk"), "{err}");
        let err = site_for(&args(&["cookies", "get"]), None, "").unwrap_err();
        assert!(err.contains("`unbrowse-node session import <host>`"), "{err}");
        let err = site_for(&args(&["auth", "login"]), Some("a.example"), "").unwrap_err();
        assert!(err.ends_with(&COMMANDS.join(", ")), "another verb still lists what the browser takes: {err}");
        let err = site_for(&args(&["open", "https://example.com", "--executable-path", "/bin/sh"]), None, "").unwrap_err();
        assert!(err.contains("UNBROWSE_BROWSER") && err.ends_with("open takes no flags: send it without --executable-path"), "{err}");
        let err = site_for(&args(&["snapshot", "--profile", "x"]), Some("a.example"), "").unwrap_err();
        assert!(err.ends_with("snapshot takes -i, --interactive, -c, --compact, -d, --depth, -s, --selector, --full, -u, --urls"), "{err}");
        // A link's address, which `get attr <ref> href` already reads one at a time: a list of events or results whose
        // links the agent must hand on (ticketmaster.com's search, gate bank) needs them all at once.
        assert!(site_for(&args(&["snapshot", "-i", "--urls"]), Some("a.example"), "").is_ok(), "a snapshot may name its links' addresses");
        assert!(site_for(&args(&["open", "https://example.com"]), None, "").is_ok(), "the door named opens");
    }

    /// An agent drives pages; the browser, its profile and its session are the node's.
    #[test]
    fn an_agent_drives_the_page_never_the_browser() {
        let (site, opened) = site_for(&args(&["open", "https://www.shop.co.uk/item/1"]), None, "").unwrap();
        assert_eq!(site, "shop.co.uk");
        assert!(opened.is_some());
        assert_eq!(site_for(&args(&["snapshot", "-i"]), Some("www.shop.co.uk"), "").unwrap().0, "shop.co.uk");
        assert!(site_for(&args(&["open", "https://a.example", "--profile", "/tmp/x"]), None, "").is_err());
        assert!(site_for(&args(&["click", "@e1", "--cdp", "9222"]), Some("a.example"), "").is_err());
        assert!(site_for(&args(&["auth", "login", "x"]), Some("a.example"), "").is_err());
        assert!(site_for(&args(&["open", "file:///etc/passwd"]), None, "").is_err());
        assert!(site_for(&args(&["scroll", "down", "-500"]), Some("a.example"), "").is_ok(), "a negative number is no flag");
        // Every argument is read as the browser reads it: a number hides no flag after it, and a value's place holds none.
        for after in ["--session", "--executable-path", "--profile", "--cdp", "--config"] {
            assert!(site_for(&args(&["scroll", "down", "-1", after, "x"]), Some("a.example"), "").is_err(), "{after}");
            assert!(site_for(&args(&["snapshot", "-s", after, "x"]), Some("a.example"), "").is_err(), "{after}");
        }
        assert!(site_for(&args(&["scroll", "-.", "--session", "x"]), Some("a.example"), "").is_err());
        // A flag is what its own command makes of it: a snapshot's depth is a wait's download path.
        assert!(site_for(&args(&["snapshot", "-d", "3"]), Some("a.example"), "").is_ok());
        assert!(site_for(&args(&["wait", "-d", "/tmp/x"]), Some("a.example"), "").is_err());
        assert!(site_for(&args(&["click", "@e1", "--timeout", "5"]), Some("a.example"), "").is_err());
        assert!(site_for(&args(&["wait", "--text", "Sent", "--timeout", "5000"]), Some("a.example"), "").is_ok());
        assert!(site_for(&args(&["screenshot", "--full", "--annotate"]), Some("a.example"), "").is_ok());
        // Flags that narrow what a command finds act on the page, not the browser.
        assert!(site_for(&args(&["find", "role", "button", "click", "--name", "Submit", "--exact"]), Some("a.example"), "").is_ok());
        // `--state` reads like wait's, but the browser takes it as a saved session to load: it picks the session.
        assert!(site_for(&args(&["wait", "#spinner", "--state", "/tmp/other-session.json"]), Some("a.example"), "").is_err());
    }

    /// An agent asks the page about itself, never the browser about its own address: that address is the whole
    /// browser, every command the node holds back included.
    #[test]
    fn an_agent_never_learns_where_the_browser_listens() {
        let on = |a: &[&str]| site_for(&args(a), Some("a.example"), "");
        assert!(on(&["get", "cdp-url"]).is_err());
        assert!(on(&["get", "url"]).is_ok() && on(&["get", "text", "@e1"]).is_ok() && on(&["get", "count", "input"]).is_ok());
        assert!(on(&["is", "visible", "@e1"]).is_ok());
        assert!(on(&["find", "role", "button", "click"]).is_ok());
        assert!(on(&["is", "anything", "@e1"]).is_err() && on(&["find", "anything", "x"]).is_err());
    }

    /// The node's browser browses the web, never this machine: what listens on its own addresses is the node's
    /// (its browsers' control servers, its API).
    #[test]
    fn an_agent_never_opens_this_machines_own_services() {
        for page in ["http://127.0.0.1:9333/", "http://127.8.0.1/", "http://[::1]:80/", "http://0.0.0.0:8080/", "http://localhost:3000/", "http://app.localhost./", "http://[::ffff:127.0.0.1]/"] {
            assert!(site_for(&args(&["open", page]), None, "").is_err(), "{page}");
        }
        assert!(site_for(&args(&["open", "https://shop.example/"]), None, "").is_ok());
        assert!(site_for(&args(&["goto", "http://localhost.shop.example/"]), None, "").is_ok(), "a name that only starts with it is the web's");
    }

    /// A host the owner excluded excludes its whole site's browser, which goes anywhere on the site.
    #[test]
    fn an_excluded_host_excludes_its_sites_browser() {
        let settings = store::Settings { excluded: vec!["www.bank.example".into()], ..Default::default() };
        assert!(excluded(&settings, "bank.example").is_err());
        assert!(excluded(&settings, "shop.example").is_ok());
        let settings = store::Settings { excluded: vec!["bank.example".into()], ..Default::default() };
        assert!(excluded(&settings, "bank.example").is_err());
        assert!(excluded(&settings, "notbank.example").is_ok());
    }

    /// What was typed never reaches the activity log.
    #[test]
    fn the_log_never_holds_what_was_typed() {
        assert_eq!(described(&args(&["fill", "@e4", "hunter2"])), "Typed into @e4");
        assert_eq!(described(&args(&["eval", "document.cookie"])), "Ran a script on the page");
        assert_eq!(described(&args(&["open", "https://a.example/s?q=secret"])), "Opened https://a.example/s");
    }

    /// UNB-119. A checkout's card form can sit in a payment provider's frame. `frame <ref|selector>` points the
    /// selectors that follow into it and `frame main` back; it takes no flag and no vault reference, and a card field
    /// inside a frame goes in by `fill <ref> vault:card:…` like any other, which the agent API asks the owner for
    /// first (`approve_checkout` runs for every `card_fill`, whatever its target).
    #[test]
    fn an_agent_can_point_its_selectors_into_a_frame() {
        let on = |a: &[&str]| site_for(&args(a), Some("shop.example"), "");
        assert!(on(&["frame", "@e3"]).is_ok());
        assert!(on(&["frame", "iframe[title=\"Secure payment input frame\"]"]).is_ok());
        assert!(on(&["frame", "main"]).is_ok());
        assert!(on(&["frame", "@e3", "--url", "https://elsewhere.example"]).is_err(), "a flag picks nothing here");
        assert!(on(&["frame", "vault:card:visa:number"]).is_err(), "a card goes in only by fill");
        assert!(on(&["mainframe"]).is_err(), "frame main is the way back");
        // A field found in a frame (a snapshot's ref, or a selector after `frame`) is a card fill all the same.
        for target in ["@e9", "input[name=number]"] {
            let fill = args(&["fill", target, "vault:card:visa:number"]);
            assert_eq!(card_fill(&fill).map(|r| r.name()), Some("vault:card:visa:number".into()), "{target}");
        }
    }

    /// UNB-119. A script an agent runs while a frame is selected (it still runs in the top page) marks the whole tab:
    /// no card goes into any field of it afterwards, in a frame or not.
    #[test]
    fn a_script_run_in_a_frame_marks_the_whole_tab() {
        let keys = unbrowse_core::MemoryStore::default();
        store::scratch_home("scripted-frame");
        unbrowse_core::load_or_create(&keys).unwrap();
        let (site, session) = ("framed-checkout.example", "1:framed");
        let tab = tab_of(session);
        // `frame` itself runs nothing of the agent's; the eval after it does.
        assert!(!runs_script(&args(&["frame", "@e3"])));
        assert!(runs_script(&args(&["eval", "document.querySelector('input').value"])));
        mark_scripted(site, &tab);
        for target in ["@e9", "input[name=number]"] {
            let refused = fill_card(&args(&["fill", target, "vault:card:visa:number"]), Some(site), "agent", session, &keys).unwrap_err();
            assert!(refused.contains("script ran in this tab"), "{target}: {refused}");
        }
        scripts_closed(site, Some(&tab));
    }

    /// UNB-119. A secret typed into a frame is held to the tab's top document, which no frame's load changes (the
    /// browser names a page by its main frame, whichever frame is selected; `e2e_frame_selection_leaves_the_page_the_top_ones`
    /// in the browser checks it), so no script or picture follows while the checkout is open, whichever frame the
    /// field was in.
    #[test]
    fn a_secret_typed_into_a_frame_holds_the_whole_page() {
        let site = "hosted-field.example";
        let page = "https://hosted-field.example/checkout";
        hold_secret(site, "4242424242424242", "vault:card:visa:number", "document:TOP1", page);
        assert!(holds_at(site, Some("document:TOP1"), page));
        assert!(holds_at(site, Some("document:TOP1"), "https://hosted-field.example/checkout#pay"), "a fragment is the same document");
        assert!(held_near_a_secret(&args(&["eval", "1"])) && held_near_a_secret(&args(&["screenshot"])));
        assert_eq!(unsaid(site, "textbox \"Card number\": 4242424242424242".into()), "textbox \"Card number\": vault:card:visa:number");
        FILLED.locked().retain(|(s, ..)| s != site);
        PLACES.locked().retain(|p| p.site != site);
    }

    /// UNB-119. The browser names the payment provider's frame a card went into, and only that.
    #[test]
    fn a_card_in_a_hosted_field_names_its_frame() {
        assert_eq!(hosted_in(&serde_json::json!({ "filled": "@e9", "field_checked": true, "frame_origin": "https://pay.example" })), Some("https://pay.example".into()));
        assert_eq!(hosted_in(&serde_json::json!({ "filled": "@e9", "field_checked": true })), None);
        assert_eq!(hosted_in(&serde_json::json!({ "frame_origin": "" })), None);
    }

    #[test]
    fn a_port_scoped_login_holds_the_field_to_its_whole_origin() {
        let p = crate::vault::Ref::parse("vault:example.org:2083:admin").unwrap();
        assert_eq!(frame_site(&p), "https://example.org:2083");
        let g = crate::vault::Ref::parse("vault:github.com:me").unwrap();
        assert_eq!(frame_site(&g), "github.com");
    }
}

#[cfg(test)]
mod order_tests {
    use super::*;

    fn shown(texts: &[&str]) -> Option<Shown> {
        Some(Shown { texts: texts.iter().map(|t| t.to_string()).collect(), unread: false })
    }

    /// The run that exposed it: a sign-up with a password box and a human check had no order of steps. After the fill
    /// no picture was taken, so the check could not be seen; after a script no fill went in. The order kept here: the
    /// agent's hands and the node's own reads touch a held page, the agent's code never does, and a picture of a held
    /// page waits whenever the secret could be painted on it.
    #[test]
    fn a_held_page_is_pictured_only_while_its_secret_is_painted_nowhere() {
        let site = "order.example";
        hold_secret(site, "Order-Pass-83", "vault:new:order.example:me", "document:O1", "https://order.example/signup");
        // The password box paints dots: the read never sees a masked box's value, so the page's text and the other
        // fields say nothing of it, and the check above it can be pictured.
        assert!(picture_hides_secrets(site, shown(&["Create your account\nI am human", "me@mail.example", ""])));
        // The page's own "show password" made the box a text field: its value is painted, so no picture.
        assert!(!picture_hides_secrets(site, shown(&["Create your account", "Order-Pass-83"])));
        // Said back in any way a page says a value: the picture waits.
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "Order-Pass-83");
        assert!(!picture_hides_secrets(site, shown(&[&format!("token {b64}")])));
        assert!(!picture_hides_secrets(site, shown(&["pw=Order%2DPass%2D83"])));
        // A read that failed, or a frame of the site's own the read could not enter, can't say: the picture waits.
        assert!(!picture_hides_secrets(site, None));
        assert!(!picture_hides_secrets(site, Some(Shown { texts: vec![], unread: true })));
        // A script stays refused on the held page whatever it paints: no browser here, so the page can't be named and
        // holds (fail closed), and an eval is code, never a picture.
        assert_eq!(no_script_near_a_login(site, "t-o1", &[ "eval".into(), "1".into() ]), Err(held_from_scripts()));
    }

    /// A hold whose secret the node no longer knows (the last run's, `UNHEARD`), or a browser in doubt, can't be
    /// checked against what the page paints: no picture.
    #[test]
    fn a_hold_the_node_cannot_read_takes_no_picture() {
        let site = "unread-hold.example";
        UNHEARD.locked().push(Place { site: site.into(), name: "vault:unread-hold.example:me".into(), page: "document:U1".into(), at: "https://unread-hold.example/in".into() });
        assert!(!picture_hides_secrets(site, shown(&["nothing of it"])));
        UNHEARD.locked().retain(|p| p.site != site);
        // A place held by a name the node keeps no secret for is one it can't check either.
        keep_place(site, "vault:unread-hold.example:gone", "document:U2", "https://unread-hold.example/in");
        assert!(!picture_hides_secrets(site, shown(&["nothing of it"])));
    }

    /// The check met before the fill: the node's own read and the agent's hands mark no tab, so the tab the check was
    /// passed in still takes the fill. An agent's script marks it, and the fill is refused, as before.
    #[test]
    fn a_check_met_with_hands_before_the_fill_leaves_the_tab_fillable() {
        let site = "check-first.example";
        for hands in [&["click", "@e3"][..], &["press", "Enter"], &["type", "@e2", "me@mail.example"], &["screenshot"]] {
            assert!(!runs_script(&args(hands)), "{hands:?} runs no code of the agent's");
        }
        assert!(no_secret_after_a_script(site, "t-c1").is_ok(), "a tab only hands touched takes the fill");
        mark_scripted(site, "t-c2");
        assert!(no_secret_after_a_script(site, "t-c2").is_err(), "a tab an agent's script ran in takes none");
        scripts_closed_with(site, Some("t-c2"), || Some(0));
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// The read's answer comes as a script's value: the object, or a string holding it.
    #[test]
    fn what_a_page_paints_is_read_from_either_form_of_the_answer() {
        let obj = r#"{"texts":["a","b"],"unread":true}"#;
        let s = Shown::of(obj).unwrap();
        assert_eq!((s.texts.len(), s.unread), (2, true));
        let quoted = serde_json::to_string(obj).unwrap();
        assert_eq!(Shown::of(&quoted).unwrap().texts, vec!["a", "b"]);
        assert!(Shown::of("undefined").is_none() && Shown::of("42").is_none());
        assert!(shown_js("a\"b.example").contains(r#"const site="a\"b.example";"#), "the site goes in as a string, quoted");
    }

    /// The run that exposed it: the refusal said "submit the form or open another page first", and the agent reloaded,
    /// opened a new tab and a new session at the same address, each refused. What the refusal says releases the hold
    /// is what does: another address is free at once, the same address (another document, reloaded) holds, and the
    /// site's browser closing ends it.
    #[test]
    fn a_hold_says_what_releases_it_and_that_is_what_does() {
        let site = "release.example";
        hold_secret(site, "Release-Pass-62", "vault:release.example:me", "document:R1", "https://release.example/signup");
        keep_place(site, "vault:release.example:me", "document:R1", "https://release.example/signup");
        assert!(holds_at(site, Some("document:R2"), "https://release.example/signup"), "reloaded, or opened in a new tab: held");
        assert!(!holds_at(site, Some("document:R3"), "https://release.example/welcome"), "another address: free");
        let said = held_from_scripts();
        assert!(said.contains("another address") && said.contains("close the site's browser"), "{said}");
        assert!(!said.contains("open another page first"), "{said}");
        scripts_closed_with(site, None, || Some(0));
        assert!(!holds_at(site, Some("document:R4"), "https://release.example/signup"), "the site's browser closed: free");
    }

    /// The run that exposed it: vault:new: kept the login the moment the password was typed, the sign-up stopped at a
    /// check, and unbrowse_logins listed a login with no account behind it. A made login is kept once the site accepts
    /// the sign-up: a request that carried the password answered with success, and the page asking for no password.
    #[test]
    fn a_made_login_is_kept_once_the_site_accepts_the_sign_up() {
        let site = "signup-accept.example";
        let r = crate::vault::Ref::parse("vault:new:signup-accept.example:me").unwrap();
        let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
        std::fs::create_dir_all(capture_dir()).unwrap();
        std::fs::write(&log, "").unwrap();
        let line = |status: u64, body: &str| format!("{}\n", serde_json::json!({ "type": "exchange", "resourceType": "Document", "entry": { "request": { "url": "https://signup-accept.example/account/register", "method": "POST", "postData": { "text": body } }, "response": { "status": status } } }));
        wait_for_sign_up(site, "t-s1", &r, "Made-Pass-4417", "agent", log_mark(site));
        let kept = std::cell::RefCell::new(Vec::new());
        let keep = |r: &crate::vault::Ref, who: &str| {
            kept.borrow_mut().push((r.name(), who.to_string()));
            Ok(())
        };
        // Typed, nothing sent yet: nothing kept, and the reply says it waits.
        assert!(sign_ups_accepted(site, |_| Some(true), keep).is_empty());
        assert_eq!(sign_ups_waiting(site), vec!["vault:signup-accept.example:me".to_string()]);
        // Sent, and the site put the form back (the check failed): 200 with a password box again is no account.
        std::fs::OpenOptions::new().append(true).open(&log).and_then(|mut f| std::io::Write::write_all(&mut f, line(200, "user=me&password=vault:signup-accept.example:me&h-captcha-response=").as_bytes())).unwrap();
        assert!(sign_ups_accepted(site, |_| Some(true), keep).is_empty(), "the form again: not accepted");
        // Refused outright: not kept, however the page looks after.
        std::fs::OpenOptions::new().append(true).open(&log).and_then(|mut f| std::io::Write::write_all(&mut f, line(400, "user=me&password=vault:signup-accept.example:me").as_bytes())).unwrap();
        assert!(sign_ups_accepted(site, |_| Some(false), keep).is_empty(), "refused: not kept");
        // Accepted: answered with success, and the page asks for no password. Kept once, by who filled it.
        std::fs::OpenOptions::new().append(true).open(&log).and_then(|mut f| std::io::Write::write_all(&mut f, line(303, "user=me&password=vault:signup-accept.example:me&h-captcha-response=tok").as_bytes())).unwrap();
        assert_eq!(sign_ups_accepted(site, |_| Some(true), keep), Vec::<String>::new(), "the page still asks: wait");
        assert_eq!(sign_ups_accepted(site, |_| None, keep), Vec::<String>::new(), "the browser can't say: wait");
        assert_eq!(sign_ups_accepted(site, |_| Some(false), keep), vec!["vault:signup-accept.example:me".to_string()]);
        assert_eq!(*kept.borrow(), vec![("vault:signup-accept.example:me".to_string(), "agent".to_string())]);
        assert!(sign_ups_waiting(site).is_empty() && sign_ups_accepted(site, |_| Some(false), keep).is_empty(), "kept once");
        // The run that exposed it: the site answered the sign-up with a door that only runs its own code, then the
        // door sent the same request again (its body not in the log) and the site answered it 303. The door's page is
        // no answer; the request sent again to the same address is the sign-up's answer.
        let door = |body: &str| format!("{}\n", serde_json::json!({ "type": "exchange", "resourceType": "Document", "entry": { "request": { "url": "https://signup-accept.example/account/register", "method": "POST", "postData": { "text": body } }, "response": { "status": 200, "content": { "mimeType": "text/html", "text": "<html><head><title>One moment</title></head><body><noscript>Please enable JavaScript to proceed.</noscript><script>document.body.appendChild(document.createElement('script')).src='/_x/script.js'</script></body></html>" } } } }));
        let again = |status: u64| format!("{}\n", serde_json::json!({ "type": "exchange", "resourceType": "Document", "entry": { "request": { "url": "https://signup-accept.example/account/register", "method": "POST" }, "response": { "status": status } } }));
        let held = "user=other&password=vault:signup-accept.example:other";
        assert_eq!(sign_up_answer(&door(held), &["vault:signup-accept.example:other".into()]), None, "a door's page says nothing yet");
        assert_eq!(sign_up_answer(&(door(held) + &again(303)), &["vault:signup-accept.example:other".into()]), Some(true), "sent again past the door: accepted");
        assert_eq!(sign_up_answer(&(door(held) + &again(400)), &["vault:signup-accept.example:other".into()]), Some(false));
        assert_eq!(sign_up_answer(&again(303), &["vault:signup-accept.example:other".into()]), None, "a request that never carried it is not its answer");
        // A sign-up never accepted before the site's browser closed made no account: nothing is kept after.
        wait_for_sign_up(site, "t-s2", &crate::vault::Ref::parse("vault:new:signup-accept.example:other").unwrap(), "Other-Pass-9921", "agent", log_mark(site));
        scripts_closed_with(site, None, || Some(0));
        assert!(sign_ups_waiting(site).is_empty());
        let _ = std::fs::remove_file(&log);
    }

    // ---- audit 1118 review (R5, R8): bypasses the first fixes left open ----
    /// Audit 1118 H5 (adversarial). A selector the agent writes asks the page about a field's value without a script:
    /// `input[value^="a"]` counted, waited for, or checked is a prefix oracle on a held password. None of these may
    /// reach a page that holds a secret.
    #[test]
    fn a_selector_the_agent_writes_is_no_way_to_read_a_held_field() {
        for probe in [
            &["get", "count", "input[value^=\"Hun\"]"][..],
            &["wait", "input[value^=\"Hun\"]"],
            &["is", "visible", "input[value^=\"Hun\"]"],
            &["snapshot", "-i", "-s", "input[value^=\"Hun\"]"],
            &["get", "count", "input:valid"],
        ] {
            assert!(held_near_a_secret(&args(probe)), "{probe:?} reads a field through its selector and must wait where a secret sits");
        }
    }

    /// Audit 1118 H6 (adversarial). A card number the owner typed is hidden however the page groups it.
    #[test]
    fn an_owner_typed_card_number_is_hidden_as_the_page_groups_it() {
        let site = "typed-card.example";
        owner_typed_in(site, "4242424242424242", "https://typed-card.example/pay", Some("document:TC1"));
        let said = unsaid(site, "textbox \"Card number\": 4242 4242 4242 4242".to_string());
        FILLED.locked().retain(|(s, ..)| s != site);
        PLACES.locked().retain(|p| p.site != site);
        assert!(!said.contains("4242 4242"), "{said}");
    }
}
