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
    let keys = NODE.get().and_then(|n| n.key().ok());
    note_with(site, session, keys.map(|k| k as &dyn unbrowse_core::KeyStore));
}

/// Whether `s`, read as a sign-in, is the sign-up that made its login: the login it typed from the vault is not one the
/// vault holds, or the vault made it after it was typed (a `vault:new:` fill is kept once the site accepts the sign-up,
/// `browse::wait_for_sign_up`). Replayed, a sign-up asks for the account again, and the site's own sign-in, read on a
/// later walk, would not be known for one. A login the vault held before it was typed (one added, imported or made on
/// an earlier walk) signs in.
fn a_sign_up(s: &Setup, session: &unbrowse_learn::session::Session) -> bool {
    if s.kind != Kind::SignIn {
        return false;
    }
    let login = s.steps.iter().find_map(|step| match step {
        Step::Fill { value, .. } => crate::vault::Ref::parse(value).filter(|r| !r.code),
        _ => None,
    });
    let Some(r) = login else { return false };
    let typed = session.actions.iter().filter(|a| a.secret && a.value.as_deref().is_some_and(|v| crate::vault::Ref::parse(v).is_some_and(|t| t.site == r.site && t.account == r.account))).map(|a| a.t).fold(f64::NEG_INFINITY, f64::max);
    match crate::vault::list().into_iter().find(|l| l.site == r.site && l.account == r.account) {
        None => true,
        Some(l) => typed.is_finite() && l.created as f64 >= typed.floor(),
    }
}

/// [`note`], sealing with `keys`: a sign-in's own request goes into the vault (`seal`), never into the setups file.
fn note_with(site: &str, session: &unbrowse_learn::session::Session, keys: Option<&dyn unbrowse_core::KeyStore>) {
    let fresh: Vec<Setup> = setup::read(session, site).into_iter().filter(|s| !a_sign_up(s, session)).map(|s| seal(site, s, keys)).collect();
    if fresh.is_empty() {
        return;
    }
    // A request an earlier build wrote into the setups file in the clear is not kept there.
    let kept: Vec<Setup> = load(site).into_iter().map(|k| Setup { native: None, ..k }).collect();
    // A later reading of the same sign-in that found no request of its own (the record by then hides what was typed
    // beside the login) is the same sign-in: the request the vault keeps for it stands.
    let fresh: Vec<Setup> = fresh
        .into_iter()
        .map(|mut f| {
            if f.kind == Kind::SignIn && f.sealed.is_none() {
                f.sealed = kept.iter().find(|k| k.kind == Kind::SignIn && k.page == f.page).and_then(|k| k.sealed.clone());
            }
            f
        })
        .collect();
    // A sign-in kept under another login than the one now standing is let go from the vault.
    if let (Some(keys), Some(new)) = (keys, fresh.iter().find(|f| f.kind == Kind::SignIn)) {
        for old in kept.iter().filter(|k| k.kind == Kind::SignIn).filter_map(|k| k.sealed.as_deref()).filter(|o| new.sealed.as_deref() != Some(*o)) {
            if let (Ok(keep), Some(r)) = (crate::vault_keep(Ok(keys)), crate::vault::Ref::parse(old)) {
                crate::vault::forget_sign_in(&keep, &r);
            }
        }
    }
    let merged = setup::merge(kept.clone(), fresh);
    if merged != kept {
        if let Err(e) = store::write_json(&path(site), &unbrowse_files::SETUPS, &merged) {
            eprintln!("   [setup] {site}: {e}");
        }
    }
}

/// The running node, for the vault a sign-in's own request is sealed into as browsing is read (`note`): set as the node
/// starts. A test has none, and a sign-in read with none keeps its steps alone.
static NODE: std::sync::OnceLock<Arc<crate::Node>> = std::sync::OnceLock::new();

pub fn set_node(node: Arc<crate::Node>) {
    let _ = NODE.set(node);
}

/// `s` as it may be written to the setups file: a sign-in's own request (`Setup::native`) sealed into the vault under
/// the login it carries and named there by that login (`Setup::sealed`), never left in the setups file. Where it can't
/// be sealed (no node's key yet, a login the vault doesn't hold), it isn't kept: the sign-in is its steps alone.
fn seal(site: &str, mut s: Setup, keys: Option<&dyn unbrowse_core::KeyStore>) -> Setup {
    let login = s.native_login();
    let Some(native) = s.native.take() else { return s };
    let sealed = (|| -> Result<String, String> {
        let keys = keys.ok_or("the node's key isn't open")?;
        let login = login.ok_or("it carries no vault login")?;
        let r = crate::vault::Ref::parse(&login).ok_or("it carries no vault login")?;
        crate::vault::keep_sign_in(&crate::vault_keep(Ok(keys))?, &r, &native.to_string())?;
        Ok(r.name())
    })();
    match sealed {
        Ok(name) => s.sealed = Some(name),
        Err(why) => eprintln!("   [setup] {site}: its sign-in's own request isn't kept ({why}): it signs in by its steps"),
    }
    s
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
        typed_at_rest(site, s.kind, || crate::browse::fill_from_vault(args, Some(site), who, crate::browse::HEAL, node.key()?, false))
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
pub fn signing_in(site: String, host: String, who: String, node: Option<Arc<crate::Node>>, tried: Arc<AtomicBool>, spent: Arc<AtomicBool>) -> Option<Box<dyn FnMut() -> Option<HashMap<String, String>> + Send>> {
    let s = load(&site).into_iter().find(|s| s.kind == Kind::SignIn)?;
    Some(Box::new(move || {
        // The login this call sent by the sign-in's own request and the site didn't take (`signing_in_plainly`) is the
        // call's one try: the browser never types it again behind that.
        if spent.load(Ordering::Relaxed) {
            return None;
        }
        tried.store(true, Ordering::Relaxed);
        earn(&s, &host, &site, &who, node.as_deref())
    }))
}

/// What a call hands the route client to sign the site in again with no browser, when the node holds the sign-in's
/// own request (`Setup::native`): `natively`. `tried` says the call went through it; `spent` says the login was sent
/// and the sign-in didn't end as the walk's did, so nothing types it again in this call.
pub fn signing_in_plainly(site: String, host: String, who: String, node: Option<Arc<crate::Node>>, tried: Arc<AtomicBool>, spent: Arc<AtomicBool>) -> Option<Box<dyn FnMut() -> Option<HashMap<String, String>> + Send>> {
    let s = load(&site).into_iter().find(|s| s.kind == Kind::SignIn && s.sealed.is_some())?;
    Some(Box::new(move || match natively(&s, &host, &site, &who, node.as_deref().and_then(|n| n.key().ok()).map(|k| k as &dyn unbrowse_core::KeyStore)) {
        Native::Earned(jar) => {
            tried.store(true, Ordering::Relaxed);
            Some(jar)
        }
        Native::Sent => {
            tried.store(true, Ordering::Relaxed);
            spent.store(true, Ordering::Relaxed);
            None
        }
        Native::NotSent => None,
    }))
}

/// What sending a kept sign-in's own requests came to.
enum Native {
    /// The site answered them as it did on the walk: the session it set is in the jar, handed back.
    Earned(HashMap<String, String>),
    /// The login was sent, or may have been, and the sign-in did not end as the walk's did.
    Sent,
    /// Nothing that carries the login left the node: none is kept, the vault wouldn't fill it, or it rests.
    NotSent,
}

/// Signs `site` in again by the requests its sign-in made on the walk (`Setup::native`), sent over the node's own
/// transport with no browser: the sign-in page read again for what it hands a visitor now, then the request that
/// carries the login, the vault's value where the walk's record wrote its name. The login passes the same checks a
/// call's does (`vault::fill_inputs`: a route this node learned, a secret input, the login's own site, an encrypted
/// connection), and the client holds it to that site whatever it sends (`with_held_inputs`). The site's rest starts
/// before the login leaves, as it does before the browser types it, and ends only when a call then passes
/// (`judged_by_the_call`); it is lifted here only where nothing was sent.
fn natively(s: &Setup, host: &str, site: &str, who: &str, keys: Option<&dyn unbrowse_core::KeyStore>) -> Native {
    let (Some(login), Some(keys)) = (s.sealed.as_deref().and_then(crate::vault::Ref::parse), keys) else { return Native::NotSent };
    if s.kind != Kind::SignIn || resting(site, s.kind) || store::load_settings().paused {
        return Native::NotSent;
    }
    // The request as the vault keeps it, opened only here, where the node sends it itself.
    let graph = crate::vault_keep(Ok(keys))
        .and_then(|keep| crate::vault::sign_in(&keep, &login))
        .ok()
        .flatten()
        .and_then(|g| serde_json::from_str::<unbrowse_learn::graph::Graph>(&g).ok());
    let Some(graph) = graph else { return Native::NotSent };
    let filled = (|| -> Result<crate::vault::Filled, String> {
        let route = as_a_route(&graph, host, &s.page)?;
        crate::browse::know_vault(site, keys)?;
        crate::vault::fill_inputs(&crate::vault_keep(Ok(keys))?, keys, &route, &HashMap::new(), false, false)
    })();
    let filled = match filled {
        Ok(filled) if !filled.held.is_empty() => filled,
        Ok(_) => return Native::NotSent,
        Err(why) => {
            eprintln!("   [setup] {site}: its sign-in is not sent with no browser: {why}");
            return Native::NotSent;
        }
    };
    let writes = unbrowse_learn::ledger::route_writes(&graph);
    let mut client = unbrowse_learn::client::RouteClient::new(graph)
        .with_chrome_transport()
        .with_egress(unbrowse_learn::egress::Egress::Own)
        .with_excluded(store::load_settings().excluded)
        .with_session_store(store::jars_dir())
        .with_held_inputs(filled.held.clone(), host);
    let (answer, ledger) = typed_at_rest(site, s.kind, || client.call_with_ledger(&filled.values));
    let sent = ledger.retry(writes) != unbrowse_learn::Retry::AsIs;
    let came_to = match (&answer, sent) {
        (Ok(_), _) => Native::Earned(store::read_json(&store::jar_path(host), &unbrowse_files::JAR)),
        (Err(_), true) => {
            // A request the site didn't take as it took the walk's is not the site's sign-in as it is now: it is not
            // kept, and the steps in the browser are what is left once the rest ends.
            forget_native(site, Some(keys));
            Native::Sent
        }
        (Err(_), false) => {
            // Nothing that changes the site left the node: no login was tried, so nothing rests for it.
            took(site);
            Native::NotSent
        }
    };
    // What the site said is never written here: an answer to a sign-in may say the login back.
    eprintln!("   [setup] {site}: its sign-in, sent with no browser: {}", match came_to {
        Native::Earned(_) => "the site answered as it did on the walk",
        Native::Sent => "sent, and it did not end as the walk's did: not typed again in this call",
        Native::NotSent => "nothing was sent",
    });
    if !matches!(came_to, Native::NotSent) {
        store::log_activity(&store::Activity {
            at: store::now(),
            who: who.to_string(),
            site: site.to_string(),
            what: "Signed in again by the sign-in's own request, with no browser".into(),
            kind: "setup".into(),
            result: if matches!(came_to, Native::Earned(_)) { "done" } else { "failed" }.into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
    came_to
}

/// Whether `route` is the call the site's kept sign-in makes (`Setup::sealed`): the vault keeps that one, and the node
/// sends it itself, so it is never kept as a route an agent can list or call with a login (`learn::save_learned`). The
/// same call: its target's method and address, the sign-in's own address read with the values the walk gave it. With
/// the vault shut, a call that sends a secret and sets the session on a site whose sign-in the vault keeps is taken to
/// be it.
pub fn is_the_sign_in(route: &store::Route) -> bool {
    let keys = NODE.get().and_then(|n| n.key().ok()).map(|k| k as &dyn unbrowse_core::KeyStore);
    is_the_sign_in_with(route, keys)
}

fn is_the_sign_in_with(route: &store::Route, keys: Option<&dyn unbrowse_core::KeyStore>) -> bool {
    use unbrowse_learn::graph::{Class, Graph, Step as Call};
    let Some(target) = route.graph.steps.last() else { return false };
    let sealed: Vec<crate::vault::Ref> = load(&unbrowse_learn::identity::site_of(&route.site))
        .into_iter()
        .filter(|s| s.kind == Kind::SignIn)
        .filter_map(|s| s.sealed.as_deref().and_then(crate::vault::Ref::parse))
        .collect();
    if sealed.is_empty() {
        return false;
    }
    // An address as the walk sent it: each `{name}` of it the value the walk gave that name.
    let as_sent = |step: &Call| {
        step.fields.iter().fold(step.url.clone(), |url, f| match &f.class {
            Class::Input { name, default: Some(d), .. } => url.replace(&format!("{{{name}}}"), d),
            _ => url,
        })
    };
    let at = |u: &str| url::Url::parse(u).ok().map(|u| (u.host_str().unwrap_or_default().to_string(), u.path().trim_end_matches('/').to_string()));
    let ours = (target.method.clone(), at(&as_sent(target)));
    let keep = keys.map(|k| crate::vault_keep(Ok(k)));
    match keep {
        Some(Ok(keep)) => sealed.iter().any(|r| {
            let request = crate::vault::sign_in(&keep, r).ok().flatten().and_then(|g| serde_json::from_str::<Graph>(&g).ok());
            request.and_then(|g| g.steps.last().cloned()).is_some_and(|theirs| (theirs.method.clone(), at(&as_sent(&theirs))) == ours)
        }),
        _ => !matches!(target.method.as_str(), "GET" | "HEAD") && target.sets_cookie && target.fields.iter().any(|f| matches!(f.class, Class::Input { secret: true, .. })),
    }
}

/// Lets go of `site`'s sign-in request (`Setup::native`), keeping its steps.
fn forget_native(site: &str, keys: Option<&dyn unbrowse_core::KeyStore>) {
    let mut kept = load(site);
    if kept.iter().any(|s| s.sealed.is_some() || s.native.is_some()) {
        if let Ok(keep) = keys.ok_or_else(String::new).and_then(|k| crate::vault_keep(Ok(k))) {
            for r in kept.iter().filter_map(|s| s.sealed.as_deref()).filter_map(crate::vault::Ref::parse) {
                crate::vault::forget_sign_in(&keep, &r);
            }
        }
        kept.iter_mut().for_each(|s| {
            s.native = None;
            s.sealed = None;
        });
        if let Err(e) = store::write_json(&path(site), &unbrowse_files::SETUPS, &kept) {
            eprintln!("   [setup] {site}: {e}");
        }
    }
}

/// The site's sign-in as a route's body may carry it to other nodes (`Recipe::sign_in`): the node's own kept sign-in
/// for `site` (`Setup::sealed`), opened from the vault, with nothing of its owner's in it. Its password is the secret
/// `login.secret` and the account it typed `login.account`, neither with a value; every other value the walk's
/// sign-in had is the site's (a constant, a page's token read again at call time), or it isn't shared. Then the
/// account, the login's name and the password are looked for in the whole body, and a body that still says one is not
/// shared, as nothing of a sign-in is that doesn't pass `recipe::sign_in_admitted`. None when the node keeps no such
/// sign-in for the site, its vault is shut, or anything here refuses: the route is listed without one.
pub fn shared(site: &str) -> Option<crate::recipe::Recipe> {
    let keys = NODE.get().and_then(|n| n.key().ok())?;
    shared_with(site, keys)
}

fn shared_with(site: &str, keys: &dyn unbrowse_core::KeyStore) -> Option<crate::recipe::Recipe> {
    use unbrowse_learn::graph::Class;
    let site = unbrowse_learn::identity::site_of(site);
    let setup = load(&site).into_iter().find(|s| s.kind == Kind::SignIn && s.sealed.is_some())?;
    let login = crate::vault::Ref::parse(setup.sealed.as_deref()?)?;
    let keep = crate::vault_keep(Ok(keys)).ok()?;
    let mut graph: unbrowse_learn::graph::Graph = serde_json::from_str(&crate::vault::sign_in(&keep, &login).ok()??).ok()?;
    let mut typed: Vec<String> = vec![login.account.clone(), login.name()];
    let mut accounts = 0;
    for field in graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
        if let Class::Input { name, secret, default, optional } = &mut field.class {
            typed.extend(default.take());
            *optional = false;
            if *secret {
                *name = crate::recipe::LOGIN_SECRET.to_string();
            } else {
                *name = crate::recipe::LOGIN_ACCOUNT.to_string();
                accounts += 1;
            }
        }
    }
    let why_not = |why: &str| {
        eprintln!("   [setup] {site}: its sign-in isn't shared with the routes it serves: {why}");
        None
    };
    if accounts > 1 {
        return why_not("it types more than an account and a password");
    }
    let host = graph.steps.last().and_then(|s| unbrowse_learn::replay::step_host(&s.url))?;
    let route = match as_a_route(&graph, &host, &setup.page) {
        Ok(route) => route,
        Err(e) => return why_not(&e),
    };
    let mut recipe = match crate::recipe::compile(&route) {
        Ok(r) => r,
        Err(e) => return why_not(&e),
    };
    recipe.sign_in = None;
    let text = String::from_utf8(crate::recipe::canonical(&recipe)).unwrap_or_default();
    if typed.iter().filter(|t| t.chars().count() >= 3).any(|t| crate::recipe::still_carries(&text, t)) {
        return why_not("it would still say the account it signs in as");
    }
    if let Err(e) = crate::recipe::sign_in_admitted(&recipe, &site) {
        return why_not(&e);
    }
    Some(recipe)
}

/// Takes a route's shared sign-in for `site` (`Recipe::sign_in`, someone else's) as this node's own kept sign-in, filled
/// from `login`, a login of this node's own vault for the site: what the owner said yes to. The sign-in's requests are
/// held to `recipe::sign_in_admitted` first; then they are the node's own sign-in, sealed under `login` as a sign-in
/// it walked itself is, and sent by the same path (`natively`): the login's own site, an encrypted connection, the
/// vault's checks. So a node signs in with someone else's sign-in only as its own owner's account.
pub fn adopt(site: &str, sign_in: &crate::recipe::Recipe, login: &crate::vault::Ref, keys: &dyn unbrowse_core::KeyStore) -> Result<(), String> {
    use unbrowse_learn::graph::Class;
    let site = unbrowse_learn::identity::site_of(site);
    if login.new || login.code || !login.fits(&site) {
        return Err(format!("{} isn't a login for {site}", login.name()));
    }
    let mut graph = crate::recipe::sign_in_graph(sign_in, &site)?;
    for step in &mut graph.steps {
        step.foreign = false;
        for field in &mut step.fields {
            if let Class::Input { name, default, .. } = &mut field.class {
                *default = Some(if name == crate::recipe::LOGIN_SECRET { login.name() } else { login.account.clone() });
            }
        }
    }
    let page = sign_in.root.clone();
    let setup = Setup { kind: Kind::SignIn, page, asks: None, earns: Vec::new(), steps: Vec::new(), native: Some(serde_json::to_value(&graph).map_err(|e| e.to_string())?), sealed: None };
    let sealed = seal(&site, setup, Some(keys));
    if sealed.sealed.is_none() {
        return Err(format!("the sign-in couldn't be kept under {}", login.name()));
    }
    let mut kept: Vec<Setup> = load(&site).into_iter().filter(|s| !s.same_as(&sealed)).collect();
    kept.push(sealed);
    store::write_json(&path(&site), &unbrowse_files::SETUPS, &kept).map_err(|e| e.to_string())
}

/// Lets go of a sign-in taken from another node's route ([`adopt`]) that didn't sign in. It has no steps of its own, so
/// with its request let go (as a kept sign-in's is when it fails) nothing would be left of it but its name, and the node
/// would take that for a sign-in of its own and never ask its owner again: it goes whole, and the next call asks.
pub fn drop_adopted(site: &str, keys: &dyn unbrowse_core::KeyStore) {
    let site = unbrowse_learn::identity::site_of(site);
    forget_native(&site, Some(keys));
    let kept = load(&site);
    let left: Vec<Setup> = kept.iter().filter(|s| !(s.kind == Kind::SignIn && s.steps.is_empty())).cloned().collect();
    if left.len() != kept.len() {
        if let Err(e) = store::write_json(&path(&site), &unbrowse_files::SETUPS, &left) {
            eprintln!("   [setup] {site}: {e}");
        }
    }
}

/// Signs `site` in now by its kept sign-in's own requests (`natively`), as a call that found its session gone would:
/// whether the site answered as it does to a sign-in that took.
pub fn sign_in_now(site: &str, host: &str, who: &str, keys: &dyn unbrowse_core::KeyStore) -> bool {
    let site = unbrowse_learn::identity::site_of(site);
    let Some(s) = load(&site).into_iter().find(|s| s.kind == Kind::SignIn && s.sealed.is_some()) else { return false };
    matches!(natively(&s, host, &site, who, Some(keys)), Native::Earned(_))
}

/// A kept sign-in's graph as a route of this node's own, for the vault's checks: its inputs are the graph's, a login
/// bound to each secret one by its vault name, and its site the sign-in's. Never stored, listed or called by an agent.
fn as_a_route(graph: &unbrowse_learn::graph::Graph, host: &str, page: &str) -> Result<store::Route, String> {
    use unbrowse_learn::graph::Class;
    let mut inputs: Vec<serde_json::Value> = Vec::new();
    for class in graph.steps.iter().flat_map(|s| &s.fields).map(|f| &f.class) {
        if let Class::Input { name, secret, default, .. } = class {
            if !inputs.iter().any(|i| i["name"] == name.as_str()) {
                inputs.push(serde_json::json!({ "name": name, "secret": secret, "default": default }));
            }
        }
    }
    let last = graph.steps.last().ok_or("the sign-in holds no request")?;
    serde_json::from_value(serde_json::json!({
        "id": "sign-in", "site": host, "what": "Sign in", "method": last.method, "path": "/", "root": page, "inputs": inputs,
        "steps": graph.steps.len(), "browser_assisted": false, "walk_without_fragment": true, "read_by": store::ReadBy::current(), "write": true,
        "provisional": graph.provisional, "learned_at": 0, "graph": graph,
    }))
    .map_err(|e| e.to_string())
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
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;

    fn sign_in() -> Setup {
        Setup {
            kind: Kind::SignIn,
            page: "https://shop.example/login".into(),
            asks: None,
            earns: Vec::new(),
            native: None,
            sealed: None,
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

    /// A kept sign-in's own request, as the vault's checks read it: a route of this node's own, on the sign-in's
    /// site, whose secret input is bound to the login by its vault name and holds no value of it.
    fn native() -> serde_json::Value {
        serde_json::json!({ "provisional": false, "steps": [{
            "exchange": 0, "method": "POST", "status": 302, "url": "https://shop.example/session", "needs_browser": false,
            "fields": [
                { "loc": { "in": "form", "key": "email" }, "class": "input", "name": "email", "secret": false, "default": "me@mail.example" },
                { "loc": { "in": "form", "key": "password" }, "class": "input", "name": "password", "secret": true, "default": "vault:shop.example:me" },
            ] }] })
    }

    #[test]
    fn a_kept_sign_in_is_read_by_the_vault_as_a_route_of_the_nodes_own() {
        store::scratch_home("setup-native-route");
        let graph: unbrowse_learn::graph::Graph = serde_json::from_value(native()).unwrap();
        let route = as_a_route(&graph, "shop.example", "https://shop.example/login").unwrap();
        assert_eq!(route.site, "shop.example");
        assert_eq!(crate::share::egress(&route), unbrowse_learn::egress::Egress::Own, "a login goes only into a route this node learned");
        let password = route.inputs.iter().find(|i| i.name == "password").expect("the secret input");
        assert!(password.secret && password.default.as_deref() == Some("vault:shop.example:me"));
        assert!(route.inputs.iter().any(|i| i.name == "email" && !i.secret));
    }

    /// A node's key, and a login of `site` the vault holds for the kept sign-in's own request (`native`).
    fn keys_with_login(site: &str) -> unbrowse_core::MemoryStore {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), site, "me", "stored", Some("hunter2-pass"), "You").unwrap();
        keys
    }

    /// A sign-in read from browsing, its own request as the walk made it: what `setup::read` hands `note`.
    fn read_sign_in() -> Setup {
        Setup { native: Some(native()), ..sign_in() }
    }

    /// A sign-in's own request is the owner's as the password is: it names the account and carries what the site's page
    /// handed the walk. So it is kept in the vault, sealed under the node's key and bound to the login it signs in
    /// with, and the setups file says only which login that is. Nothing on the disk holds it in the clear, a sign-in
    /// read with no key open keeps its steps alone, and removing the login removes it.
    #[test]
    fn a_sign_ins_own_request_is_kept_in_the_vault_and_nowhere_else() {
        let _one = crate::testchain::one_at_a_time_blocking();
        let home = store::scratch_home("setup-native-sealed");
        let keys = keys_with_login("shop.example");
        let s = seal("shop.example", read_sign_in(), Some(&keys));
        assert!(s.native.is_none() && s.sealed.as_deref() == Some("vault:shop.example:me"), "{s:?}");
        store::write_json(&path("shop.example"), &unbrowse_files::SETUPS, &vec![s]).unwrap();
        let on_disk = |needle: &str| {
            walk(&home).into_iter().filter(|p| std::fs::read(p).is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes()))).collect::<Vec<_>>()
        };
        assert!(on_disk("shop.example/session").is_empty() && on_disk("me@mail.example").len() <= 1, "the request is in no file in the clear: {:?}", on_disk("shop.example/session"));
        let keep = crate::vault_keep(Ok(&keys)).unwrap();
        let r = crate::vault::Ref::parse("vault:shop.example:me").unwrap();
        let opened: unbrowse_learn::graph::Graph = serde_json::from_str(&crate::vault::sign_in(&keep, &r).unwrap().expect("the vault keeps it")).unwrap();
        assert_eq!(opened.steps.last().map(|s| s.url.as_str()), Some("https://shop.example/session"));
        // No key open: the sign-in is its steps alone, and nothing of the request is written.
        let none = seal("shop.example", read_sign_in(), None);
        assert!(none.native.is_none() && none.sealed.is_none() && none.steps.len() == 3);
        // A login the vault doesn't hold keeps no request either.
        assert!(seal("other.example", Setup { native: Some(native().to_string().replace("shop.example:me", "other.example:me").parse().unwrap()), ..sign_in() }, Some(&keys)).sealed.is_none());
        // The login goes, and its sign-in with it.
        crate::vault::remove(&keep, "shop.example", "me").unwrap();
        assert!(crate::vault::sign_in(&keep, &r).unwrap().is_none());
    }

    /// The site the shared sign-in tests sign in on: a name under a public suffix, as a route from another node needs.
    const SITE: &str = "shop.example.com";

    /// [`read_sign_in`] on [`SITE`].
    fn public_sign_in() -> Setup {
        serde_json::from_str(&serde_json::to_string(&read_sign_in()).unwrap().replace("shop.example", SITE)).unwrap()
    }

    /// A route's body may carry the site's sign-in so another node can sign in as its own owner: what it carries says
    /// nothing of this node's owner. Their account and the login's name are out of it, the password was never in it,
    /// and its only caller values are an account and a secret, each with no value.
    #[test]
    fn a_shared_sign_in_says_nothing_of_its_owner() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-shared-sign-in");
        let keys = keys_with_login(SITE);
        let kept = seal(SITE, public_sign_in(), Some(&keys));
        store::write_json(&path(&unbrowse_learn::identity::site_of(SITE)), &unbrowse_files::SETUPS, &vec![kept]).unwrap();
        let shared = shared_with(SITE, &keys).expect("the site's sign-in is shared");
        let text = String::from_utf8(crate::recipe::canonical(&shared)).unwrap();
        for owners in ["me@mail.example", "vault:", "hunter2-pass", "shop.example.com:me"] {
            assert!(!text.contains(owners), "{owners} in {text}");
        }
        let params: Vec<(&str, bool, bool)> = shared.params.iter().map(|p| (p.name.as_str(), p.secret, p.default.is_none())).collect();
        assert_eq!(params, vec![(crate::recipe::LOGIN_ACCOUNT, false, true), (crate::recipe::LOGIN_SECRET, true, true)], "{text}");
        assert!(crate::recipe::sign_in_admitted(&shared, SITE).is_ok());
        // No sign-in kept for a site: nothing to share.
        assert!(shared_with("other.example", &keys).is_none());
    }

    /// What both nodes hold a shared sign-in to (`recipe::sign_in_admitted`), each rule broken alone on the real shared
    /// sign-in and refused for its own reason: the account and the password go only to the site whose sign-in it is,
    /// in the body of a last request that changes the site, and the caller is asked for nothing else.
    #[test]
    fn a_shared_sign_in_that_breaks_a_rule_is_refused_for_it() {
        use crate::recipe::{sign_in_admitted, Source, LOGIN_ACCOUNT, LOGIN_SECRET};
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-shared-sign-in-rules");
        let keys = keys_with_login(SITE);
        let kept = seal(SITE, public_sign_in(), Some(&keys));
        store::write_json(&path(&unbrowse_learn::identity::site_of(SITE)), &unbrowse_files::SETUPS, &vec![kept]).unwrap();
        let shared = shared_with(SITE, &keys).expect("the site's sign-in is shared");
        assert!(sign_in_admitted(&shared, SITE).is_ok());
        let refused = |broken: &dyn Fn(&mut crate::recipe::Recipe), why: &str| {
            let mut s = shared.clone();
            broken(&mut s);
            let e = sign_in_admitted(&s, SITE).expect_err(why);
            assert!(e.contains(why), "{why}: {e}");
        };
        refused(&|s| s.sign_in = Some(Box::new(shared.clone())), "holds a sign-in of its own");
        refused(&|s| s.steps.last_mut().unwrap().url = "https://collector.example.net/session".into(), "not to example.com");
        refused(&|s| s.steps.last_mut().unwrap().method = "GET".into(), "changes nothing");
        refused(&|s| s.params.retain(|p| p.name != LOGIN_SECRET), "sends no login.secret");
        refused(
            &|s| {
                let mut card = s.params[0].clone();
                card.name = "card".into();
                s.params.push(card);
            },
            "asks its caller for card",
        );
        refused(&|s| s.params.iter_mut().find(|p| p.name == LOGIN_ACCOUNT).unwrap().default = Some("someone".into()), "asks its caller for login.account");
        refused(
            &|s| {
                let last = s.steps.last_mut().unwrap();
                let f = last.fields.iter_mut().find(|f| matches!(&f.from, Source::Param { name } if name == LOGIN_SECRET)).unwrap();
                f.loc = unbrowse_learn::Loc::Header("x-password".into());
            },
            "outside the body of its last request",
        );
        // An address the template builds at call time is no fixed host of the site's.
        let mut built = shared.clone();
        built.steps.last_mut().unwrap().url = "https://{host}/session".into();
        assert!(sign_in_admitted(&built, SITE).is_err());
    }

    /// Another node takes a shared sign-in only as its own owner's: filled from a login its own vault holds for the
    /// site, sealed under that login as a sign-in it walked itself is. A login of another site, and a sign-in that
    /// would send the account or the password anywhere but the site's own last request, are refused.
    #[test]
    fn a_node_takes_a_shared_sign_in_only_as_its_owners_own_login() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-shared-sign-in-a");
        let a_keys = keys_with_login(SITE);
        store::write_json(&path(&unbrowse_learn::identity::site_of(SITE)), &unbrowse_files::SETUPS, &vec![seal(SITE, public_sign_in(), Some(&a_keys))]).unwrap();
        let shared = shared_with(SITE, &a_keys).unwrap();
        // Node B: another home, another key, its own owner's login.
        store::scratch_home("setup-shared-sign-in-b");
        let b_keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&b_keys).unwrap();
        crate::vault::add(&crate::vault_keep(Ok(&b_keys)).unwrap(), SITE, "bob@mail.example", "stored", Some("bobs-own-pass"), "You").unwrap();
        let bob = crate::vault::Ref::parse("vault:shop.example.com:bob@mail.example").unwrap();
        adopt(SITE, &shared, &bob, &b_keys).expect("taken as B's own sign-in");
        let kept = load(&unbrowse_learn::identity::site_of(SITE));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].sealed.as_deref(), Some("vault:shop.example.com:bob@mail.example"), "{kept:?}");
        let opened: unbrowse_learn::graph::Graph = serde_json::from_str(&crate::vault::sign_in(&crate::vault_keep(Ok(&b_keys)).unwrap(), &bob).unwrap().unwrap()).unwrap();
        let defaults: Vec<(String, Option<String>)> = opened.steps.iter().flat_map(|s| &s.fields).filter_map(|f| match &f.class {
            unbrowse_learn::graph::Class::Input { name, default, .. } => Some((name.clone(), default.clone())),
            _ => None,
        }).collect();
        assert_eq!(defaults, vec![(crate::recipe::LOGIN_ACCOUNT.into(), Some("bob@mail.example".into())), (crate::recipe::LOGIN_SECRET.into(), Some("vault:shop.example.com:bob@mail.example".into()))]);
        assert!(opened.steps.iter().all(|s| !s.foreign), "B's own sign-in now");
        // A login of another site is not B's login for this one.
        let elsewhere = crate::vault::Ref::parse("vault:other.example:bob@mail.example").unwrap();
        assert!(adopt(SITE, &shared, &elsewhere, &b_keys).is_err());
        // A sign-in that sends the account elsewhere, or the password in an address, is no sign-in of the site's.
        let mut off_site = shared.clone();
        off_site.steps[0].url = "https://collector.example.net/session".into();
        assert!(adopt(SITE, &off_site, &bob, &b_keys).is_err());
        let mut in_the_address = shared.clone();
        for f in &mut in_the_address.steps[0].fields {
            if matches!(&f.from, crate::recipe::Source::Param { name } if name == crate::recipe::LOGIN_SECRET) {
                f.loc = unbrowse_learn::Loc::Query("password".into());
            }
        }
        assert!(adopt(SITE, &in_the_address, &bob, &b_keys).is_err());
        let mut by_get = shared.clone();
        by_get.steps[0].method = "GET".into();
        assert!(adopt(SITE, &by_get, &bob, &b_keys).is_err());
    }

    /// A route node A listed on [`SITE`], as node B holds it once fetched: B's own route, `fetched`, whose body (kept in
    /// B's home under its content id) carries A's shared sign-in. A's sign-in is kept in a home of its own, and B's home
    /// is `b_home` again when this returns.
    pub(crate) fn a_fetched_route_with_its_sites_sign_in(b_home: &std::path::Path) -> store::Route {
        store::scratch_home("setup-shared-route-lister");
        let a_keys = keys_with_login(SITE);
        store::write_json(&path(&unbrowse_learn::identity::site_of(SITE)), &unbrowse_files::SETUPS, &vec![seal(SITE, public_sign_in(), Some(&a_keys))]).unwrap();
        let sign_in = shared_with(SITE, &a_keys).unwrap();
        store::use_home(b_home);
        let graph: unbrowse_learn::graph::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": format!("https://{SITE}/orders"), "needs_browser": false, "foreign": true, "fields": [] }] })).unwrap();
        let mut route = as_a_route(&graph, SITE, &format!("https://{SITE}/orders")).unwrap();
        route.id = "shared-orders".into();
        route.what = "the orders on my account".into();
        let mut body = crate::recipe::compile(&route).unwrap();
        body.sign_in = Some(Box::new(sign_in));
        let content = crate::recipe::save_body(&crate::recipe::canonical(&body)).unwrap();
        route.fetched = Some(store::Fetched { entry_id: format!("0x{}", "ab".repeat(32)), route_id: "r".into(), agent_id: "7".into(), content_id: content, listed_as: "orders".into(), fetched_at: 1 });
        route
    }

    /// [`SITE`], for a test outside this module.
    pub(crate) const SHARED_SITE: &str = SITE;

    /// A route from another node that carries its site's sign-in signs this node in only as its own owner: with no
    /// login of the site in its vault the call says how to add one, a no from the owner takes nothing, and a node that
    /// already holds a session there isn't asked at all.
    #[test]
    fn a_shared_route_signs_in_only_with_its_owners_yes_and_own_login() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-shared-route-a");
        let a_keys = keys_with_login(SITE);
        store::write_json(&path(&unbrowse_learn::identity::site_of(SITE)), &unbrowse_files::SETUPS, &vec![seal(SITE, public_sign_in(), Some(&a_keys))]).unwrap();
        let sign_in = shared_with(SITE, &a_keys).unwrap();
        // B fetched A's route: its body, kept under its content id, carries the sign-in.
        store::scratch_home("setup-shared-route-b");
        let graph: unbrowse_learn::graph::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": format!("https://{SITE}/orders"), "needs_browser": false, "foreign": true, "fields": [] }] })).unwrap();
        let mut route = as_a_route(&graph, SITE, &format!("https://{SITE}/orders")).unwrap();
        let mut body = crate::recipe::compile(&route).unwrap();
        body.sign_in = Some(Box::new(sign_in));
        let content = crate::recipe::save_body(&crate::recipe::canonical(&body)).unwrap();
        route.fetched = Some(store::Fetched { entry_id: "0x1".into(), route_id: "r".into(), agent_id: "7".into(), content_id: content, listed_as: "orders".into(), fetched_at: 1 });
        let asked = std::cell::Cell::new(0);
        // No login of the site in B's vault: told how to add one, nothing asked.
        let none = crate::run::signs_in_as_its_owner(&route, "You", None, &mut |_| { asked.set(asked.get() + 1); Ok(()) });
        assert!(none.as_ref().is_err_and(|e| e.contains("holds no login") && e.contains("vault:new:")), "{none:?}");
        assert_eq!(asked.get(), 0);
        // With B's own login: asked, naming B's account and where it goes; a no takes nothing.
        let b_keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&b_keys).unwrap();
        crate::vault::add(&crate::vault_keep(Ok(&b_keys)).unwrap(), SITE, "bob@mail.example", "stored", Some("bobs-own-pass"), "You").unwrap();
        let mut shown = String::new();
        let no = crate::run::signs_in_as_its_owner(&route, "You", None, &mut |q| { shown = q; Err("no".into()) });
        assert_eq!(no, Ok(false));
        assert!(shown.contains("bob@mail.example") && shown.contains(&format!("POST https://{SITE}/session")) && !shown.contains("me@mail.example"), "{shown}");
        assert!(load(&unbrowse_learn::identity::site_of(SITE)).is_empty(), "a no takes nothing");
        // A node that holds a session on the site already isn't asked.
        let host = unbrowse_learn::client::jar_name(&route.graph).unwrap();
        std::fs::create_dir_all(store::jars_dir()).unwrap();
        store::write_json(&store::jar_path(&host), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid".to_string(), "bobs-session".to_string())])).unwrap();
        let held = crate::run::signs_in_as_its_owner(&route, "You", None, &mut |_| { asked.set(asked.get() + 1); Ok(()) });
        assert_eq!((held, asked.get()), (Ok(false), 0));
    }

    /// The site's sign-in is the vault's: the same call learned from the browsing that signed in is no route an agent
    /// can call with a login. Another call that sends a secret on the site (a different address) is not it, and with no
    /// sign-in kept nothing is taken for one.
    #[test]
    fn the_sites_sign_in_is_never_a_route() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-native-route-refused");
        let keys = keys_with_login("shop.example");
        let route_at = |url: &str| -> store::Route {
            serde_json::from_value(serde_json::json!({
                "id": "r", "site": "shop.example", "what": "Send session on shop.example", "method": "POST", "path": "/session", "root": "https://shop.example/login",
                "inputs": [{ "name": "password", "secret": true, "default": null }], "steps": 1, "browser_assisted": false, "walk_without_fragment": true,
                "read_by": store::ReadBy::current(), "write": true, "provisional": false, "learned_at": 0,
                "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "POST", "status": 302, "url": url, "needs_browser": false, "sets_cookie": true,
                    "fields": [{ "loc": { "in": "form", "key": "password" }, "class": "input", "name": "password", "secret": true, "default": null }] }] }
            }))
            .unwrap()
        };
        assert!(!is_the_sign_in_with(&route_at("https://shop.example/session"), Some(&keys)), "no sign-in kept yet");
        let kept = seal("shop.example", read_sign_in(), Some(&keys));
        store::write_json(&path("shop.example"), &unbrowse_files::SETUPS, &vec![kept]).unwrap();
        assert!(is_the_sign_in_with(&route_at("https://shop.example/session"), Some(&keys)));
        assert!(is_the_sign_in_with(&route_at("https://shop.example/session/"), Some(&keys)), "the same address");
        assert!(!is_the_sign_in_with(&route_at("https://shop.example/account/password"), Some(&keys)), "another call that sends a secret");
        assert!(is_the_sign_in_with(&route_at("https://shop.example/account/password"), None), "with the vault shut, one that sends a secret and sets the session is taken for it");
    }

    /// A sign-up types its new login from the vault as a sign-in does, so its steps read as the site's sign-in. Kept as
    /// one, it was replayed as the sign-in (asking for the account again), and the site's real sign-in, read on a later
    /// walk, was no longer known for one and was kept as a route any agent could call (Fandom). A login the vault made
    /// after it was typed, or doesn't hold, is a sign-up; one it held before signs in.
    #[test]
    fn a_sign_up_is_never_kept_as_the_sites_sign_in() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-sign-up");
        let typed_at = |t: f64| {
            let line = serde_json::json!({ "type": "action", "t": t, "action": "fill", "selector": "@e2", "locator": "#password", "value": "vault:shop.example:me", "secret": true });
            unbrowse_learn::session::Session::from_log(&line.to_string()).unwrap()
        };
        let now = store::now() as f64;
        assert!(a_sign_up(&sign_in(), &typed_at(now)), "a login the vault doesn't hold: a sign-up the site hasn't taken yet");
        keys_with_login("shop.example");
        assert!(a_sign_up(&sign_in(), &typed_at(now - 600.0)), "the vault made the login after it was typed");
        assert!(!a_sign_up(&sign_in(), &typed_at(now + 600.0)), "a login the vault held before it was typed signs in");
        let choice = Setup { kind: Kind::Choice, ..sign_in() };
        assert!(!a_sign_up(&choice, &typed_at(now - 600.0)), "only a sign-in is read for one");
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(dir).into_iter().flatten().flatten().flat_map(|e| if e.path().is_dir() { walk(&e.path()) } else { vec![e.path()] }).collect()
    }

    /// A later reading of the same sign-in that found no request of its own (by then the record hides what was typed
    /// beside the login) keeps the one the vault holds: when the walk is read doesn't decide whether the node can sign in.
    #[test]
    fn a_later_reading_of_the_sign_in_keeps_the_request_the_vault_holds() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-native-later");
        let keys = keys_with_login("shop.example");
        let first = seal("shop.example", read_sign_in(), Some(&keys));
        store::write_json(&path("shop.example"), &unbrowse_files::SETUPS, &vec![first]).unwrap();
        let kept = load("shop.example");
        let later = Setup { sealed: kept.iter().find(|k| k.kind == Kind::SignIn && k.page == sign_in().page).and_then(|k| k.sealed.clone()), ..sign_in() };
        assert_eq!(later.sealed.as_deref(), Some("vault:shop.example:me"));
    }

    /// A sign-in request the site didn't take is let go, from the vault too, and its steps in the browser stay: what
    /// is left once the rest ends is the sign-in as the owner made it.
    #[test]
    fn a_sign_in_request_the_site_refused_is_let_go_and_its_steps_kept() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-native-forget");
        let keys = keys_with_login("forget.example");
        let kept = seal("forget.example", Setup { native: Some(native().to_string().replace("shop.example", "forget.example").parse().unwrap()), ..sign_in() }, Some(&keys));
        store::write_json(&path("forget.example"), &unbrowse_files::SETUPS, &vec![kept]).unwrap();
        assert!(signing_in_plainly("forget.example".into(), "forget.example".into(), "agent".into(), None, Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false))).is_some());
        forget_native("forget.example", Some(&keys));
        let after = load("forget.example");
        assert!(after.len() == 1 && after[0].sealed.is_none() && after[0].steps.len() == 3, "{after:?}");
        let r = crate::vault::Ref::parse("vault:forget.example:me").unwrap();
        assert!(crate::vault::sign_in(&crate::vault_keep(Ok(&keys)).unwrap(), &r).unwrap().is_none(), "the vault holds it no more");
        assert!(signing_in_plainly("forget.example".into(), "forget.example".into(), "agent".into(), None, Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false))).is_none(), "nothing is left to send with no browser");
    }

    /// The login a call already sent by the sign-in's own request, and the site didn't take, is that call's one try:
    /// the browser's sign-in hands back nothing and types nothing behind it. A sign-in with no request kept, a node
    /// whose key isn't open, or a site at rest sends nothing, and says it wasn't sent.
    #[test]
    fn a_login_the_call_already_sent_is_never_typed_again_in_it() {
        let _one = crate::testchain::one_at_a_time_blocking();
        store::scratch_home("setup-native-spent");
        let keys = keys_with_login("shop.example");
        let kept = seal("shop.example", read_sign_in(), Some(&keys));
        store::write_json(&path("spent.example"), &unbrowse_files::SETUPS, &vec![kept.clone()]).unwrap();
        let (tried, spent) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(true)));
        let mut by_the_browser = signing_in("spent.example".into(), "spent.example".into(), "agent".into(), None, tried.clone(), spent).expect("a sign-in is kept");
        assert!(by_the_browser().is_none() && !tried.load(Ordering::Relaxed), "nothing was typed");
        // The node's key isn't open: nothing is sent, and no login is spent.
        assert!(matches!(natively(&kept, "spent.example", "spent.example", "agent", None), Native::NotSent));
        let (tried, spent) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        let mut plainly = signing_in_plainly("spent.example".into(), "spent.example".into(), "agent".into(), None, tried.clone(), spent.clone()).unwrap();
        assert!(plainly().is_none() && !tried.load(Ordering::Relaxed) && !spent.load(Ordering::Relaxed));
        assert!(!resting("spent.example", Kind::SignIn), "a sign-in that sent nothing rests nothing");
        assert!(matches!(natively(&sign_in(), "spent.example", "spent.example", "agent", Some(&keys)), Native::NotSent), "no request kept: the steps alone");
    }

    /// A site that goes on asking the same question opens a browser for no more than one call an hour, and resting a
    /// choice doesn't stop a sign-in.
    #[test]
    fn a_choice_that_didnt_take_rests_apart_from_the_sign_in() {
        store::scratch_home("setup-choice");
        let choice = Setup { kind: Kind::Choice, page: "https://shop.example/store".into(), asks: None, earns: Vec::new(), steps: Vec::new(), native: None, sealed: None };
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
