//! The asks the node makes of a site on its own initiative, each family held by one switch, read here and nowhere
//! else. By default the node asks nothing nobody asked for ("browsing is the only fallback", the A/B of 15 November):
//! every family below is held, except the two that serve the agent's own request (`rewalk`, `setups`), and a route of
//! one sighting is confirmed by use (`UNBROWSE_CONFIRM_BY_USE`). The old behaviour is kept for one release:
//! `UNBROWSE_OWN_ASKS=<family>,<family>` (the log's names: second-look, nonsense, shrink, try, paging, recheck, heal,
//! again, page-values; `all` for every one) asks those families again, `UNBROWSE_NO_<FAMILY>=0` the same for one, and
//! `UNBROWSE_ARM_A=1` is the old node whole: every family asked, no confirming browse. `UNBROWSE_NO_<FAMILY>=1` holds a
//! family whatever else is set.
//!
//! - `UNBROWSE_NO_SECOND_LOOK`: the second walk a just-learned route is held to (`verify_learned`).
//! - `UNBROWSE_NO_NONSENSE`: the probes that send the site a made-up value to see whether a call hears its caller.
//! - `UNBROWSE_NO_SHRINK`: the leave-one-out asks that find the least of a walk's chain the site still answers.
//! - `UNBROWSE_NO_TRY`: the page tried again behind a route that needed it (`try_the_page_later`).
//! - `UNBROWSE_NO_PAGING`: the trial that asks the site for a route's next page to learn how it reads on
//!   (`read_on_by_trial_for`). Held, a route reads on only as its walk or the page's own next link says.
//! - `UNBROWSE_NO_RECHECK`: the route asked again for the value it was learned on, at call time, to tell the site
//!   finding nothing for the caller's value from the route gone (`run::still_answers_its_own`, `run::found_nothing`).
//!   Held, the call's failure is its answer as the site said it, and nothing is asked again.
//! - `UNBROWSE_NO_HEAL`: what a failed call does of its own to mend itself: the page fetched again for a fresh
//!   session, a sign-in, a browser's walk of the page and the call made again on what it found
//!   (`RouteClient::call_with_ledger`, told by `RouteClient::holding_the_heal`). Held, the call fails as it failed, and
//!   the ask goes on to the browser as any failed call's does.
//! - `UNBROWSE_NO_AGAIN`: a read that came back with nothing in it sent again at once, the same call
//!   (`api::goal::came_back_empty`). Held, the empty answer is the call's answer.
//! - `UNBROWSE_NO_PAGE_VALUES`: the page's own other values sent to a route just learned without a browser, to see
//!   whether it hears its caller (`api::goal::deaf_to`).
//! - `UNBROWSE_NO_REWALK`: the page walked once more, warm, when the agent's walk ended before the page asked for
//!   anything (`learn::learn_goal_from`). The agent's own request is not yet answered there, so arm B keeps it.
//! - `UNBROWSE_NO_SETUPS`: a choice the owner made on the site (a store, a region, a sign-in) made again because the
//!   site asks it again, during a learn (`setups::run`) or at call time (`setups::earn`). It serves the agent's own
//!   request with the owner's own answer, so arm B keeps it.
//!
//! Beside them, `UNBROWSE_CONFIRM_BY_USE` is the serving path arm B is measured on: a route learned from one sighting
//! answers its first ask for a new value by its own call, the agent's ask, where that answer stands
//! (`confirm::by_its_call`), and through the browser, the route called once beside it (`confirm`), only on doubt.
//! `UNBROWSE_CONFIRM_BY_BROWSE=1` keeps the browser-first path of 15 November for one release (`calls_first`).
//!
//! A switch set to anything but empty or `0` holds its family. A held ask is skipped where it would be made, and one
//! line says so (`   [own-ask] held: <family> at <function>`) on the node's log, so the x-ray and the A/B can count it.

/// A family of the node's own asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ask {
    SecondLook,
    Nonsense,
    Shrink,
    Try,
    Paging,
    Recheck,
    Heal,
    Again,
    PageValues,
    Rewalk,
    Setups,
}

impl Ask {
    /// Every family a switch holds.
    #[cfg(test)]
    pub const EVERY: [Ask; 11] = [Ask::SecondLook, Ask::Nonsense, Ask::Shrink, Ask::Try, Ask::Paging, Ask::Recheck, Ask::Heal, Ask::Again, Ask::PageValues, Ask::Rewalk, Ask::Setups];

    /// The environment switch that holds this family.
    pub fn switch(self) -> &'static str {
        match self {
            Ask::SecondLook => "UNBROWSE_NO_SECOND_LOOK",
            Ask::Nonsense => "UNBROWSE_NO_NONSENSE",
            Ask::Shrink => "UNBROWSE_NO_SHRINK",
            Ask::Try => "UNBROWSE_NO_TRY",
            Ask::Paging => "UNBROWSE_NO_PAGING",
            Ask::Recheck => "UNBROWSE_NO_RECHECK",
            Ask::Heal => "UNBROWSE_NO_HEAL",
            Ask::Again => "UNBROWSE_NO_AGAIN",
            Ask::PageValues => "UNBROWSE_NO_PAGE_VALUES",
            Ask::Rewalk => "UNBROWSE_NO_REWALK",
            Ask::Setups => "UNBROWSE_NO_SETUPS",
        }
    }

    /// The family's name as the log says it.
    pub fn family(self) -> &'static str {
        match self {
            Ask::SecondLook => "second-look",
            Ask::Nonsense => "nonsense",
            Ask::Shrink => "shrink",
            Ask::Try => "try",
            Ask::Paging => "paging",
            Ask::Recheck => "recheck",
            Ask::Heal => "heal",
            Ask::Again => "again",
            Ask::PageValues => "page-values",
            Ask::Rewalk => "rewalk",
            Ask::Setups => "setups",
        }
    }
}

/// Whether a switch read as `value` holds its family: set, and neither empty nor `0`.
pub fn held_by(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|v| !v.is_empty() && v != "0")
}

/// The switch that serves a route's first ask for a new value by the browser, with the route called once beside it
/// (`confirm::confirm_by_use`): arm B's serving path, where the node never asks a site on its own.
pub const CONFIRM_BY_USE: &str = "UNBROWSE_CONFIRM_BY_USE";

/// The switch that asks families again: `UNBROWSE_OWN_ASKS=<family>,…` or `all`.
pub const OWN_ASKS: &str = "UNBROWSE_OWN_ASKS";

/// The old node whole, for the A/B and the matrix: every family asked, no confirming browse.
pub const ARM_A: &str = "UNBROWSE_ARM_A";

/// Whether a route learned from one sighting is confirmed by use on this node: by default, unless `CONFIRM_BY_USE`
/// is `0` or the node runs as arm A.
pub fn confirms_by_use() -> bool {
    !held_by(std::env::var(ARM_A).ok().as_deref()) && std::env::var(CONFIRM_BY_USE).ok().as_deref().map(str::trim) != Some("0") && !asked_here_off()
}

/// The old first new value of a route of one sighting, for one release: `UNBROWSE_CONFIRM_BY_BROWSE=1` has the browser
/// serve it and the route called beside it, before the route's own call is ever served for it.
pub const CONFIRM_BY_BROWSE: &str = "UNBROWSE_CONFIRM_BY_BROWSE";

/// Whether a route of one sighting is called first for a new value, the browser serving it only on doubt
/// (`confirm::by_its_call`): by default, unless `CONFIRM_BY_BROWSE` is `1`. The call is the agent's own ask.
pub fn calls_first() -> bool {
    std::env::var(CONFIRM_BY_BROWSE).ok().as_deref().map(str::trim) != Some("1")
}

impl Ask {
    /// Whether the family is held when nothing is set: every ask nobody asked for. `rewalk` and `setups` serve the
    /// agent's own request (its page not yet answered; the owner's own choice made again), so they run.
    pub fn held_by_default(self) -> bool {
        !matches!(self, Ask::Rewalk | Ask::Setups)
    }
}

/// Whether the family `a` is asked again on this node: `UNBROWSE_OWN_ASKS` names it (or says `all`), its own
/// `UNBROWSE_NO_<FAMILY>` is `0`, or the node runs as arm A.
fn asked_again(a: Ask) -> bool {
    let listed = std::env::var(OWN_ASKS).ok().is_some_and(|v| v.split(',').map(str::trim).any(|f| f.eq_ignore_ascii_case("all") || f.eq_ignore_ascii_case(a.family()) || f.replace('_', "-").eq_ignore_ascii_case(a.family())));
    listed || std::env::var(a.switch()).ok().as_deref().map(str::trim) == Some("0") || held_by(std::env::var(ARM_A).ok().as_deref()) || asked_here(a)
}

/// Whether the family `a` is held on this node: its own switch holds it, or nothing asks it again and it is held by
/// default.
pub fn held(a: Ask) -> bool {
    held_by(std::env::var(a.switch()).ok().as_deref()) || held_here(a) || (a.held_by_default() && !asked_again(a))
}

/// Whether the family `a` is held, said on the log as skipped at `at` when it is. The one call a gate makes.
pub fn held_at(a: Ask, at: &str) -> bool {
    if !held(a) {
        // An ask that serves the agent's own request is said as that, so it is never counted as the node's own.
        if !a.held_by_default() {
            let line = format!("   [own-ask] for the agent's request: {} at {at}", a.family());
            eprintln!("{line}");
            #[cfg(test)]
            SAID.with(|s| s.borrow_mut().push(line));
        }
        return false;
    }
    let line = format!("   [own-ask] held: {} at {at}", a.family());
    eprintln!("{line}");
    #[cfg(test)]
    SAID.with(|s| s.borrow_mut().push(line));
    true
}

/// What shrinking left out of `before` to make `after`, as one line for the node's log, or None where it left out
/// nothing: `   [shrink] left out <n> step(s), <h> header(s), <c> cookie(s): <kinds>`. A step is said by its method and
/// its path with no host and no value (a piece holding a digit is `*`), a header or a cookie by its name alone:
/// never a value, so the line can be counted across sites and kept.
pub fn left_out(before: &unbrowse_learn::Graph, after: &unbrowse_learn::Graph) -> Option<String> {
    use unbrowse_learn::Loc;
    let named = |step: &unbrowse_learn::Step, cookie: bool| -> std::collections::BTreeSet<String> {
        step.fields.iter().map(|f| &f.loc).chain(step.page_producers.iter().map(|p| &p.loc)).filter_map(|loc| match loc {
            Loc::Header(name) if !cookie => Some(name.to_ascii_lowercase()),
            Loc::Cookie(name) if cookie => Some(name.clone()),
            _ => None,
        }).collect()
    };
    let mut kinds: Vec<String> = Vec::new();
    let (mut steps, mut headers, mut cookies) = (0, 0, 0);
    for was in &before.steps {
        let Some(now) = after.steps.iter().find(|s| s.exchange == was.exchange) else {
            steps += 1;
            kinds.push(format!("step {} {}", was.method.to_ascii_uppercase(), path_shape(&was.url)));
            continue;
        };
        for name in named(was, false).difference(&named(now, false)) {
            headers += 1;
            kinds.push(format!("header {name}"));
        }
        for name in named(was, true).difference(&named(now, true)) {
            cookies += 1;
            kinds.push(format!("cookie {name}"));
        }
    }
    (!kinds.is_empty()).then(|| format!("   [shrink] left out {steps} step(s), {headers} header(s), {cookies} cookie(s): {}", kinds.join(", ")))
}

/// Says on the node's log what shrinking left out of `before` to make `after` (`left_out`), where it left out anything.
pub fn say_left_out(before: &unbrowse_learn::Graph, after: &unbrowse_learn::Graph) {
    if let Some(line) = left_out(before, after) {
        eprintln!("{line}");
    }
}

/// An address's path with no host, no query and no value: a piece holding a digit is `*`, a hole the route fills is
/// kept as the route writes it.
fn path_shape(address: &str) -> String {
    let rest = address.split_once("://").map_or(address, |(_, rest)| rest);
    let path = rest.find('/').map_or("/", |at| &rest[at..]);
    let path = path.split(['?', '#']).next().unwrap_or("/");
    path.split('/').map(|piece| if !piece.starts_with('{') && piece.chars().any(|c| c.is_ascii_digit()) { "*" } else { piece }).collect::<Vec<_>>().join("/")
}

// A test holds a family on its own thread, so tests that run side by side never see each other's switch.
#[cfg(test)]
thread_local! {
    static HELD: std::cell::RefCell<std::collections::HashSet<Ask>> = Default::default();
    static SAID: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn held_here(a: Ask) -> bool {
    HELD.with(|h| h.borrow().contains(&a))
}

#[cfg(not(test))]
fn held_here(_: Ask) -> bool {
    false
}

#[cfg(test)]
thread_local! {
    static ASKED: std::cell::RefCell<std::collections::HashSet<Ask>> = Default::default();
    static CONFIRM_OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn asked_here(a: Ask) -> bool {
    ASKED.with(|h| h.borrow().contains(&a))
}

#[cfg(not(test))]
fn asked_here(_: Ask) -> bool {
    false
}

#[cfg(test)]
fn asked_here_off() -> bool {
    CONFIRM_OFF.with(std::cell::Cell::get)
}

#[cfg(not(test))]
fn asked_here_off() -> bool {
    false
}

/// Holds this thread as the old node (arm A) while it lives: every family asked again, no confirming browse. A test
/// of an ask the default holds takes it on its first line.
#[cfg(test)]
pub struct OldNode(bool);

#[cfg(test)]
impl Drop for OldNode {
    fn drop(&mut self) {
        ASKED.with(|h| h.borrow_mut().clear());
        CONFIRM_OFF.with(|c| c.set(self.0));
    }
}

#[cfg(test)]
pub fn as_the_old_node() -> OldNode {
    ASKED.with(|h| h.borrow_mut().extend(Ask::EVERY));
    OldNode(CONFIRM_OFF.with(|c| c.replace(true)))
}

/// Runs `f` as the old node on this thread (arm A): every family in `families` asked again, and no confirming browse.
/// For a test of an ask the default holds: it says which it needs.
#[cfg(test)]
pub fn asking<T>(families: &[Ask], f: impl FnOnce() -> T) -> T {
    ASKED.with(|h| h.borrow_mut().extend(families.iter().copied()));
    let was = CONFIRM_OFF.with(|c| c.replace(true));
    let out = f();
    ASKED.with(|h| families.iter().for_each(|a| { h.borrow_mut().remove(a); }));
    CONFIRM_OFF.with(|c| c.set(was));
    out
}

/// Runs `f` with `a` held on this thread: what it returned, and each `[own-ask]` line it said.
#[cfg(test)]
pub fn holding<T>(a: Ask, f: impl FnOnce() -> T) -> (T, Vec<String>) {
    HELD.with(|h| h.borrow_mut().insert(a));
    SAID.with(|s| s.borrow_mut().clear());
    let out = f();
    HELD.with(|h| h.borrow_mut().remove(&a));
    (out, SAID.with(|s| std::mem::take(&mut *s.borrow_mut())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERY: &[Ask] = &Ask::EVERY;

    #[test]
    fn the_switch_is_off_unless_set() {
        assert!(!held_by(None));
        assert!(!held_by(Some("")));
        assert!(!held_by(Some(" ")));
        assert!(!held_by(Some("0")));
        assert!(held_by(Some("1")));
        assert!(held_by(Some("yes")));
        for &a in EVERY {
            assert!(a.switch().starts_with("UNBROWSE_NO_"));
            if std::env::var_os(a.switch()).is_none() && std::env::var_os(OWN_ASKS).is_none() && std::env::var_os(ARM_A).is_none() {
                // Nothing set: held unless it serves the agent's own request; asked again, it runs.
                assert_eq!(held(a), a.held_by_default(), "{}", a.family());
                assert!(!asking(&[a], || held(a)), "{}", a.family());
            }
        }
    }

    /// What shrinking left out is said by kind and name, never by value: the steps dropped by method and path shape,
    /// the headers and cookies by name.
    #[test]
    fn what_shrinking_left_out_is_said_by_name_never_by_value() {
        let graph = |steps: serde_json::Value| -> unbrowse_learn::Graph { serde_json::from_value(serde_json::json!({ "provisional": false, "steps": steps })).unwrap() };
        let config = serde_json::json!({ "exchange": 0, "method": "get", "status": 200, "url": "https://shop.example/api/config/v2?session=abc123", "needs_browser": false, "fields": [] });
        let search = |headers: &[(&str, &str)], cookies: &[&str]| {
            let mut fields: Vec<serde_json::Value> = headers.iter().map(|(k, v)| serde_json::json!({ "loc": { "in": "header", "key": k }, "class": "constant", "value": v })).collect();
            fields.extend(cookies.iter().map(|c| serde_json::json!({ "loc": { "in": "cookie", "key": c }, "class": "minted", "name": c })));
            fields.push(serde_json::json!({ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }));
            serde_json::json!({ "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false, "fields": fields })
        };
        let before = graph(serde_json::json!([config, search(&[("X-Install-Id", "secret-value-1"), ("accept", "json")], &["sid", "ab"])]));
        let after = graph(serde_json::json!([search(&[("accept", "json")], &["sid"])]));
        let line = left_out(&before, &after).expect("something was left out");
        assert_eq!(line, "   [shrink] left out 1 step(s), 1 header(s), 1 cookie(s): step GET /api/config/*, header x-install-id, cookie ab");
        assert!(!line.contains("secret-value-1") && !line.contains("abc123") && !line.contains("shop.example"));
        assert_eq!(left_out(&before, &before), None, "nothing left out says nothing");
    }

    #[test]
    fn a_held_family_says_where_it_was_skipped() {
        let (was, said) = holding(Ask::SecondLook, || held_at(Ask::SecondLook, "somewhere"));
        assert!(was);
        assert_eq!(said, vec!["   [own-ask] held: second-look at somewhere".to_string()]);
        assert!(!held_here(Ask::SecondLook), "the hold ends with the closure");
    }
}
