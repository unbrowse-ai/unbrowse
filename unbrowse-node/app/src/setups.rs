//! Runs what a site needs done by hand (`unbrowse_learn::setup`) in the site's own browser: a sign-in when a call finds
//! its session gone, a choice when the site asks it again. What the steps earn lands in the site's jar, and the call
//! goes on from there.
//!
//! A sign-in typed again and again is how an account gets locked. A login field that went away doesn't say the session
//! came back (a page that only says "wrong password" has none either), so typing starts the rest and only a call that
//! then passes ends it (`took`); else it isn't tried again for an hour, whatever the node does meanwhile, and the owner
//! hears of it. A choice rests the same way: nothing locks, but a site that keeps asking would open a browser for every
//! call. A secret goes in through the vault's own checked fill (`browse::fill_from_vault`), which
//! holds it to the login's site and to a password or code field; only a route this node learned reaches here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use unbrowse_learn::setup::{self, Kind, Setup, Step};

use crate::store;
use crate::sync::Locked;

/// How long, in seconds, a sign-in that didn't take rests before the node tries it again.
const REST_AFTER_FAILING: u64 = 3600;

/// How long a step waits for the element it aims at, and how long the last step gets to land.
const STEP_WAIT_MS: &str = "15000";
const LANDING_MS: &str = "2500";

/// How often, and how many times, the node looks for the page a sign-in lands on before calling it failed.
const LOOK_EVERY_MS: &str = "1000";
const LOOKS_AFTER_SENDING: usize = 20;

/// One rest being read or written at a time: the file is the only copy, so a restart ends no rest.
static RESTS: Mutex<()> = Mutex::new(());

fn rests_path() -> PathBuf {
    store::home().join("setup-rests.json")
}

/// When each site's sign-in, or its choice (`rest_key`), last started to rest, in seconds.
fn rests() -> HashMap<String, u64> {
    std::fs::read(rests_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn keep_rests(rests: &HashMap<String, u64>) {
    let path = rests_path();
    let part = path.with_extension("json.part");
    let written = serde_json::to_vec(rests).map_err(|e| e.to_string()).and_then(|b| std::fs::write(&part, b).map_err(|e| e.to_string())).and_then(|_| std::fs::rename(&part, &path).map_err(|e| e.to_string()));
    if let Err(e) = written {
        eprintln!("   [setup] couldn't keep when sign-ins rest: {e}");
    }
}

/// What a site's rest is kept under: a sign-in and a choice rest apart, as one going wrong says nothing of the other.
fn rest_key(site: &str, kind: Kind) -> String {
    match kind {
        Kind::SignIn => site.to_string(),
        Kind::Choice => format!("{site} choice"),
    }
}

/// Whether a rest that started at `at` still runs at `now`. A clock moved back keeps it running.
fn rest_runs(at: Option<u64>, now: u64) -> bool {
    at.is_some_and(|at| now.saturating_sub(at) < REST_AFTER_FAILING)
}

fn path(site: &str) -> PathBuf {
    store::home().join("setups").join(format!("{site}.json"))
}

pub fn load(site: &str) -> Vec<Setup> {
    store::read_json(&path(site), &unbrowse_files::SETUPS)
}

/// Keeps what the browsing in `session` shows `site` needs done.
pub fn note(site: &str, session: &unbrowse_learn::session::Session) {
    let fresh = setup::read(session, site);
    if fresh.is_empty() {
        return;
    }
    let kept = load(site);
    let merged = setup::merge(kept.clone(), fresh);
    if merged != kept {
        if let Err(e) = store::write_json(&path(site), &unbrowse_files::SETUPS, &merged) {
            eprintln!("   [setup] {site}: {e}");
        }
    }
}

fn resting(site: &str, kind: Kind) -> bool {
    let _one = RESTS.locked();
    rest_runs(rests().get(&rest_key(site, kind)).copied(), store::now())
}

/// Starts `site`'s rest. Older rests that have run out leave the file with it, so it holds only those that count.
fn rest(site: &str, kind: Kind) {
    let _one = RESTS.locked();
    let now = store::now();
    let mut all = rests();
    all.retain(|_, at| rest_runs(Some(*at), now));
    all.insert(rest_key(site, kind), now);
    keep_rests(&all);
}

/// Types a login, `site`'s rest started first: a crash, or a page that goes on to say nothing, has typed it all the same.
fn typed_at_rest<T>(site: &str, kind: Kind, type_it: impl FnOnce() -> T) -> T {
    rest(site, kind);
    type_it()
}

/// A call passed on what `site`'s sign-in or choice earned: it took, and nothing rests.
pub fn took(site: &str) {
    let _one = RESTS.locked();
    let mut all = rests();
    let before = all.len();
    all.remove(&rest_key(site, Kind::SignIn));
    all.remove(&rest_key(site, Kind::Choice));
    if all.len() != before {
        keep_rests(&all);
    }
}

fn command(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

/// How many elements the browser's answer to `get count` says it found.
fn counted(said: &str) -> usize {
    said.split(|c: char| !c.is_ascii_digit()).find(|p| !p.is_empty()).and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// Takes `s`'s steps through `act` (a browser command) and `vault` (a fill the vault types). A sign-in's first field
/// not being on its page means the site didn't ask: the session is alive, and nothing is typed. One whose last login
/// field is still there after it was sent didn't take.
fn steps(s: &Setup, act: &mut dyn FnMut(&[String]) -> Result<String, String>, vault: &mut dyn FnMut(&[String]) -> Result<String, String>) -> Result<(), String> {
    act(&command(&["open", &s.page]))?;
    let aimed = |f: fn(&Step) -> bool| s.steps.iter().filter(|x| f(x)).filter_map(Step::at).next_back();
    if s.kind == Kind::SignIn {
        if let Some(first) = s.steps.iter().find_map(Step::at) {
            let _ = act(&command(&["wait", first, "--timeout", LANDING_MS]));
            if counted(&act(&command(&["get", "count", first]))?) == 0 {
                return Ok(());
            }
        }
    }
    for step in &s.steps {
        if let Some(at) = step.at() {
            act(&command(&["wait", at, "--timeout", STEP_WAIT_MS])).map_err(|e| format!("the page has no {at}: {e}"))?;
        }
        match step {
            Step::Fill { at, value } if value.starts_with("vault:") => vault(&command(&["fill", at, value])).map(drop)?,
            Step::Fill { at, value } => act(&command(&["fill", at, value])).map(drop)?,
            Step::Select { at, value } => act(&command(&["select", at, value])).map(drop)?,
            Step::Check { at } => act(&command(&["check", at])).map(drop)?,
            Step::Uncheck { at } => act(&command(&["uncheck", at])).map(drop)?,
            Step::Click { at } => act(&command(&["click", at])).map(drop)?,
            Step::Press { key } => act(&command(&["press", key])).map(drop)?,
        }
    }
    // A site takes its time over a sign-in: the page it lands on is watched for, never assumed after a fixed wait, since a
    // slow answer read as a failed one rests a login that worked.
    let Some(login) = aimed(|x| matches!(x, Step::Fill { value, .. } if value.starts_with("vault:"))).filter(|_| s.kind == Kind::SignIn) else {
        act(&command(&["wait", LANDING_MS]))?;
        return Ok(());
    };
    for _ in 0..LOOKS_AFTER_SENDING {
        act(&command(&["wait", LOOK_EVERY_MS]))?;
        if counted(&act(&command(&["get", "count", login]))?) == 0 {
            return Ok(());
        }
    }
    Err("the login was sent, and the page still asks for it".into())
}

/// Runs `s` for `site`, leaving the browser open: the caller ends it with `browse::heal_done`. `node` opens the vault; a
/// choice needs none.
pub fn run(s: &Setup, site: &str, who: &str, node: Option<&crate::Node>) -> Result<(), String> {
    if resting(site, s.kind) {
        return Err(match s.kind {
            Kind::SignIn => "signing in didn't take a while ago, so the node isn't trying again yet".into(),
            Kind::Choice => "making the site's choice didn't take a while ago, so the node isn't trying again yet".to_string(),
        });
    }
    let mut act = |args: &[String]| crate::browse::act(args, Some(site), who, crate::browse::HEAL);
    let mut vault = |args: &[String]| {
        let node = node.ok_or("nothing here can open the vault")?;
        typed_at_rest(site, s.kind, || crate::browse::fill_from_vault(args, Some(site), who, crate::browse::HEAL, node.key()?))
    };
    if s.kind == Kind::Choice {
        rest(site, s.kind);
    }
    let done = steps(s, &mut act, &mut vault);
    if done.is_err() {
        rest(site, s.kind);
    }
    store::log_activity(&store::Activity {
        at: store::now(),
        who: who.to_string(),
        site: site.to_string(),
        what: match s.kind {
            Kind::SignIn => "Signed in again with the steps it learned".to_string(),
            Kind::Choice => format!("Answered \"{}\" as the owner's browsing did", s.asks.as_deref().unwrap_or("the site's question")),
        },
        kind: "setup".into(),
        result: if done.is_ok() { "done" } else { "failed" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: done.as_ref().err().map(|e| e.chars().take(200).collect()),
    });
    done
}

/// Runs `s`, ends the browsing, and hands back the session it left for `host`.
pub fn earn(s: &Setup, host: &str, site: &str, who: &str, node: Option<&crate::Node>) -> Option<HashMap<String, String>> {
    let done = run(s, site, who, node);
    if done.is_ok() {
        crate::learn::refresh_jar(host, site);
    }
    crate::browse::heal_done(site);
    match done {
        Ok(()) => Some(store::read_json(&store::jar_path(host), &unbrowse_files::JAR)),
        Err(e) => {
            eprintln!("   [setup] {site}: {e}");
            None
        }
    }
}

/// What a call hands the route client: signs the site in again, when the node knows how. `tried` says the call went
/// through it, for the caller to read the call's own answer as whether it took (`judged_by_the_call`).
pub fn signing_in(site: String, host: String, who: String, node: Option<Arc<crate::Node>>, tried: Arc<AtomicBool>) -> Option<Box<dyn FnMut() -> Option<HashMap<String, String>> + Send>> {
    let s = load(&site).into_iter().find(|s| s.kind == Kind::SignIn)?;
    Some(Box::new(move || {
        tried.store(true, Ordering::Relaxed);
        earn(&s, &host, &site, &who, node.as_deref())
    }))
}

/// A call that went through a sign-in or a choice has ended: `passed` is the only word on whether the session came back.
/// One that failed leaves the rest running and tells the owner, since the steps themselves may have read as done.
pub fn judged_by_the_call(site: &str, who: &str, passed: bool) {
    if passed {
        took(site);
        return;
    }
    store::log_activity(&store::Activity {
        at: store::now(),
        who: who.to_string(),
        site: site.to_string(),
        what: "What the node redid on the site's page didn't bring the session back".into(),
        kind: "setup".into(),
        result: "failed".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some("It isn't tried again for an hour, so a login isn't typed over and over: check the login in the vault, or sign in by hand.".into()),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn sign_in() -> Setup {
        Setup {
            kind: Kind::SignIn,
            page: "https://shop.example/login".into(),
            asks: None,
            earns: Vec::new(),
            steps: vec![
                Step::Fill { at: "#email".into(), value: "me@mail.example".into() },
                Step::Fill { at: "#password".into(), value: "vault:shop.example:me".into() },
                Step::Click { at: "#go".into() },
            ],
        }
    }

    /// Plays the browser: `fields` says how many of each selector the page holds, before and after the login is sent.
    fn play(s: &Setup, before: usize, after: usize) -> (Result<(), String>, Vec<String>, Vec<String>) {
        let sent = RefCell::new(false);
        let (log, typed) = (RefCell::new(Vec::new()), RefCell::new(Vec::new()));
        let mut act = |a: &[String]| {
            log.borrow_mut().push(a.join(" "));
            if a[0] == "click" {
                *sent.borrow_mut() = true;
            }
            Ok(if a[0] == "get" { format!("{}", if *sent.borrow() { after } else { before }) } else { String::new() })
        };
        let mut vault = |a: &[String]| {
            typed.borrow_mut().push(a.join(" "));
            Ok(String::new())
        };
        let done = steps(s, &mut act, &mut vault);
        (done, log.into_inner(), typed.into_inner())
    }

    /// The login goes through the vault's fill, as its name: the browser command line never holds it.
    #[test]
    fn a_login_goes_in_through_the_vault() {
        let (done, log, typed) = play(&sign_in(), 1, 0);
        assert_eq!(done, Ok(()));
        assert_eq!(typed, ["fill #password vault:shop.example:me"]);
        assert!(log.iter().any(|l| l == "fill #email me@mail.example"));
        assert!(!log.iter().any(|l| l.contains("vault:")), "{log:?}");
    }

    /// The site didn't ask: the session is alive, and a sign-in typed over it would only risk it.
    #[test]
    fn a_session_still_alive_types_nothing() {
        let (done, log, typed) = play(&sign_in(), 0, 0);
        assert_eq!(done, Ok(()));
        assert!(typed.is_empty());
        assert!(!log.iter().any(|l| l.starts_with("fill") || l.starts_with("click")));
    }

    /// The login field still there after sending is a wrong password or a new question: that's a failure, whatever the
    /// browser said of each step.
    #[test]
    fn a_page_still_asking_after_the_login_went_is_a_failure() {
        let (done, _, _) = play(&sign_in(), 1, 1);
        assert!(done.unwrap_err().contains("still asks"));
    }

    /// The walk that exposed it: a slow site was still on the sign-in page at a fixed wait, which read as a wrong password
    /// and rested a login that worked. The page is watched until the field goes.
    #[test]
    fn a_slow_sign_in_is_waited_for() {
        let looks = RefCell::new(0);
        let mut act = |a: &[String]| {
            if a[0] == "get" {
                *looks.borrow_mut() += 1;
                return Ok(if *looks.borrow() < 6 { "1" } else { "0" }.to_string());
            }
            Ok(String::new())
        };
        let mut vault = |_: &[String]| Ok(String::new());
        assert_eq!(steps(&sign_in(), &mut act, &mut vault), Ok(()));
    }

    /// Failing rests the site, so calls that keep failing never keep typing a login.
    #[test]
    fn a_sign_in_that_failed_rests() {
        store::scratch_home("setup-rest");
        assert!(!resting("rest.example", Kind::SignIn));
        rest("rest.example", Kind::SignIn);
        assert!(resting("rest.example", Kind::SignIn));
        assert!(run(&sign_in(), "rest.example", "agent", None).unwrap_err().contains("isn't trying again"));
    }

    /// A page that answers a bad password with no login field on it reads as "the field went": the steps can't tell it
    /// from a session that came back, so the login's rest starts when it is typed and only a call that passes ends it.
    /// The sign-in that typed it never gets to type it again on the next call.
    #[test]
    fn a_login_typed_on_a_page_with_no_field_after_it_rests_until_a_call_passes() {
        store::scratch_home("setup-typed");
        let s = sign_in();
        let (site, typed) = ("typed.example", RefCell::new(0));
        let sent = RefCell::new(false);
        let mut act = |a: &[String]| {
            if a[0] == "click" {
                *sent.borrow_mut() = true;
            }
            Ok(if a[0] == "get" { if *sent.borrow() { "0" } else { "1" }.to_string() } else { String::new() })
        };
        let mut vault = |_: &[String]| {
            typed_at_rest(site, s.kind, || *typed.borrow_mut() += 1);
            Ok(String::new())
        };
        assert_eq!(steps(&s, &mut act, &mut vault), Ok(()), "the steps read as done");
        assert_eq!(*typed.borrow(), 1);
        assert!(resting(site, Kind::SignIn), "and the call hasn't said yet");
        assert!(run(&s, site, "agent", None).unwrap_err().contains("isn't trying again"));
        judged_by_the_call(site, "agent", false);
        assert!(resting(site, Kind::SignIn), "a call that still fails leaves it resting");
        judged_by_the_call(site, "agent", true);
        assert!(!resting(site, Kind::SignIn), "a call that passes ends it");
    }

    /// The rest is the guard against a lockout, and a restart isn't a reason to type again: it lives on disk, and runs its
    /// hour by the clock.
    #[test]
    fn a_rest_outlives_a_restart_and_runs_out() {
        store::scratch_home("setup-restart");
        rest("restart.example", Kind::SignIn);
        let kept: HashMap<String, u64> = serde_json::from_slice(&std::fs::read(rests_path()).unwrap()).unwrap();
        assert!(kept.contains_key("restart.example"));
        assert!(rest_runs(Some(1000), 1000 + REST_AFTER_FAILING - 1));
        assert!(!rest_runs(Some(1000), 1000 + REST_AFTER_FAILING));
        assert!(rest_runs(Some(5000), 1000), "a clock moved back");
        assert!(!rest_runs(None, 1000));
    }

    /// A site that goes on asking the same question opens a browser for no more than one call an hour, and resting a
    /// choice doesn't stop a sign-in.
    #[test]
    fn a_choice_that_didnt_take_rests_apart_from_the_sign_in() {
        store::scratch_home("setup-choice");
        let choice = Setup { kind: Kind::Choice, page: "https://shop.example/store".into(), asks: None, earns: Vec::new(), steps: Vec::new() };
        rest("choice.example", Kind::Choice);
        assert!(run(&choice, "choice.example", "agent", None).unwrap_err().contains("isn't trying again"));
        assert!(!resting("choice.example", Kind::SignIn));
        took("choice.example");
        assert!(!resting("choice.example", Kind::Choice));
    }

    #[test]
    fn counts_are_read_from_what_the_browser_said() {
        assert_eq!(counted("3"), 3);
        assert_eq!(counted("{\"count\":12}"), 12);
        assert_eq!(counted(""), 0);
    }
}
