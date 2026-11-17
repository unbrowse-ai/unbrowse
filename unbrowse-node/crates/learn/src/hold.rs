//! Sites on hold: where the owner is paying, the node sends nothing.
//!
//! While a card sits in a page of a site's browser (or the owner is deciding whether to pay with one there), the
//! payment is the owner's to submit: nothing the node sends on an agent's behalf may reach that site, since a route's
//! request (a checkout's confirm call, sent under the same session) could commit the order the owner hasn't checked.
//! The rule is the node's to state ([`set`]); every way this crate reaches a site asks it at the point the request
//! leaves, keyed by the host the request goes to: both transports on every hop ([`crate::http::ChromeFetch`],
//! [`crate::replay::HttpFetch`]), and the browser the node drives for a walled step, a heal's walk, a signing page and
//! a mint ([`crate::mint::BrowserMint`]). A request it refuses is never sent.
//!
//! A second rule covers what no host list can: while any checkout waits for the owner ([`set_waiting`]), the node sends
//! no request at all, of any method, to any host ([`check_request`]), runs no route (`RouteClient`), and drives no page
//! in its own browser, since the order may be committed through a host the checkout reaches only later, and a `GET`
//! can commit as well as a `POST`: a request's method is no evidence that it changes nothing. The agent's own reads of
//! pages in the browser on sites the hold doesn't cover are judged apart (`browse::reads_a_page`).

use std::sync::{Arc, RwLock};

type Rule = dyn Fn(&str) -> Option<String> + Send + Sync;

static RULE: RwLock<Option<Arc<Rule>>> = RwLock::new(None);

/// Sets the rule: for a request to `host`, why it may not be sent, or `None` when it may.
pub fn set(rule: impl Fn(&str) -> Option<String> + Send + Sync + 'static) {
    *RULE.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(rule));
}

type Waiting = dyn Fn() -> Option<String> + Send + Sync;

static WAITING: RwLock<Option<Arc<Waiting>>> = RwLock::new(None);

/// Sets the second rule: why nothing that changes state may be sent anywhere now (a checkout waits for the owner), or
/// `None` when it may.
pub fn set_waiting(rule: impl Fn() -> Option<String> + Send + Sync + 'static) {
    *WAITING.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(rule));
}

/// Why nothing that changes state may be sent anywhere now, if it may not.
pub fn waiting() -> Option<String> {
    let rule = WAITING.read().unwrap_or_else(|e| e.into_inner()).clone()?;
    rule()
}


type BrowserRule = dyn Fn(Option<&str>, &str) -> Option<String> + Send + Sync;

static BROWSER_RULE: RwLock<Option<Arc<BrowserRule>>> = RwLock::new(None);

/// Sets the rule the browsers' egress proxy meets (`proxy`): for a connection from the browser labelled `label` (a
/// site's own browser) to `host`, why it may not be made now, or `None` when it may.
pub fn set_browser(rule: impl Fn(Option<&str>, &str) -> Option<String> + Send + Sync + 'static) {
    *BROWSER_RULE.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(rule));
}

/// Why a connection from the browser labelled `label` to `host` may not be made now, if it may not.
pub fn browser_refused(label: Option<&str>, host: &str) -> Option<String> {
    let rule = BROWSER_RULE.read().unwrap_or_else(|e| e.into_inner()).clone()?;
    rule(label, host)
}

fn changes() -> &'static tokio::sync::watch::Sender<u64> {
    static CHANGES: std::sync::OnceLock<tokio::sync::watch::Sender<u64>> = std::sync::OnceLock::new();
    CHANGES.get_or_init(|| tokio::sync::watch::channel(0).0)
}

/// Says the hold changed (begun, grown, released): every connection the browsers' proxy carries meets the rule again,
/// and one it now refuses is closed.
pub fn changed() {
    changes().send_modify(|n| *n += 1);
}

/// The commit lock: a hold made durable (begun, released) and the change said under it ([`committing`]), and every
/// browser connection's final authorisation read under it ([`browser_authorized`]). A connection either is authorised
/// before a hold is durable, and then hears the change it subscribed to before its first check, or it sees the hold.
static COMMIT: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The hold's generation: even while it is settled, odd while a commit is under way. Every commit moves it on twice.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How many carried writes are under way (`Writing`): a commit waits for them before it makes a hold durable.
static WRITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Runs `f` (making a hold durable, or releasing one) and says the hold changed, under the commit lock. The generation
/// is made odd first, so no carried write starts from here on (`Writing::may`); the commit waits for the writes already
/// under way, which began before it and finish before the hold is durable; then `f` runs and the generation is even
/// again, a step on.
pub fn committing<T>(f: impl FnOnce() -> T) -> T {
    use std::sync::atomic::Ordering::SeqCst;
    let _commit = COMMIT.lock().unwrap_or_else(|e| e.into_inner());
    GENERATION.fetch_add(1, SeqCst);
    while WRITING.load(SeqCst) != 0 {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let out = f();
    GENERATION.fetch_add(1, SeqCst);
    changed();
    out
}

/// A browser connection's authorisation, read under the commit lock: the settled generation it holds for, or Err with
/// why it may not be made.
pub fn browser_authorized(label: Option<&str>, host: &str) -> Result<u64, String> {
    let _commit = COMMIT.lock().unwrap_or_else(|e| e.into_inner());
    match browser_refused(label, host) {
        Some(why) => Err(why),
        None => Ok(GENERATION.load(std::sync::atomic::Ordering::SeqCst)),
    }
}

/// One carried write under way, from before the generation is read until its bytes are written: a commit waits for it.
pub struct Writing(());

impl Writing {
    /// Starts a write for a connection authorised at generation `seen`: `Some` when nothing changed since, so the bytes
    /// may go; `None` when a commit is under way or came since, and the connection must be authorised again first.
    pub fn may(seen: u64) -> Option<Writing> {
        use std::sync::atomic::Ordering::SeqCst;
        WRITING.fetch_add(1, SeqCst);
        if GENERATION.load(SeqCst) == seen {
            Some(Writing(()))
        } else {
            WRITING.fetch_sub(1, SeqCst);
            None
        }
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        WRITING.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What a carried connection listens on to hear that the hold changed.
pub fn watch() -> tokio::sync::watch::Receiver<u64> {
    changes().subscribe()
}

/// Browser visits the node drives in progress (a signing page, a walled step, a heal's walk, a mint): each holds this
/// shared for its whole length, and a checkout hold begins only holding it alone ([`with_no_visit`]), so a hold never
/// begins in the middle of one.
static VISITS: RwLock<()> = RwLock::new(());

/// Starts a browser visit to `url`, held until the guard drops: refused when the host is held or a checkout waits,
/// checked once the visit lock is taken, so a hold that began while it waited for the lock is seen.
pub fn visit(url: &url::Url) -> Result<std::sync::RwLockReadGuard<'static, ()>, String> {
    let guard = VISITS.read().unwrap_or_else(|e| e.into_inner());
    match refused_in_a_browser(url) {
        Some(why) => Err(why),
        None => Ok(guard),
    }
}

/// Runs `f` (beginning a checkout hold) with no browser visit in progress: it waits for any running visit to end, and
/// none starts until it is done.
pub fn with_no_visit<T>(f: impl FnOnce() -> T) -> T {
    let _alone = VISITS.write().unwrap_or_else(|e| e.into_inner());
    f()
}

/// Why a request to `url` may not be sent now, if it may not.
pub fn refused(url: &url::Url) -> Option<String> {
    let rule = RULE.read().unwrap_or_else(|e| e.into_inner()).clone()?;
    rule(url.host_str().unwrap_or_default())
}

/// [`refused`], as a replay's refusal: nothing was sent.
pub fn check(url: &url::Url) -> Result<(), crate::replay::ReplayError> {
    match refused(url) {
        Some(why) => Err(crate::replay::ReplayError::Refused(why)),
        None => Ok(()),
    }
}

/// Both rules for one request: refused to a held host, and, while a checkout waits, refused to every host, whatever
/// its method (`_method` is no evidence of safety: a `GET` can commit an order). Nothing refused is sent.
pub fn check_request(url: &url::Url, _method: &str) -> Result<(), crate::replay::ReplayError> {
    check(url)?;
    match waiting() {
        Some(why) => Err(crate::replay::ReplayError::Refused(why)),
        None => Ok(()),
    }
}

/// Why the browser the node drives (a walled step, a heal's walk, a signing page, a mint) may not go to `url` now: a
/// held host, or any host while a checkout waits, since a page it drives can send anything.
pub fn refused_in_a_browser(url: &url::Url) -> Option<String> {
    refused(url).or_else(waiting)
}

#[cfg(test)]
thread_local! {
    static WAITS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// For a test: whether a checkout waits, on this thread alone, so tests running beside it never see it.
#[cfg(test)]
pub fn wait_here(on: bool) {
    static SET: std::sync::Once = std::sync::Once::new();
    SET.call_once(|| set_waiting(|| WAITS.with(|w| w.get()).then(|| "a card checkout is waiting for the owner".to_string())));
    WAITS.with(|w| w.set(on));
}

#[cfg(test)]
mod tests {
    /// A site the rule holds is sent nothing by either transport: the request is refused before it leaves, on its
    /// first hop.
    #[test]
    fn a_held_site_is_sent_nothing_by_either_transport() {
        super::set(|host| (host == "held.invalid").then(|| "a card sits in a checkout there".to_string()));
        let req = crate::replay::Request { method: "POST".into(), url: url::Url::parse("https://held.invalid/checkout/confirm").unwrap(), exchange: 0, headers: vec![], body: Some(b"go".to_vec()) };
        let mut plain = crate::replay::HttpFetch::new().unwrap();
        let mut chrome = crate::http::ChromeFetch::new().unwrap();
        for e in [crate::replay::Fetch::fetch(&mut plain, &req).unwrap_err(), crate::replay::Fetch::fetch(&mut chrome, &req).unwrap_err()] {
            assert!(matches!(&e, crate::replay::ReplayError::Refused(why) if why.contains("card")), "{e:?}");
        }
        assert!(super::refused(&url::Url::parse("https://other.invalid/").unwrap()).is_none());
    }

    /// While a checkout waits for the owner, no request of any method leaves for any host, however unrelated: a GET to
    /// a processor's `/confirm?order=…` commits as surely as a POST, so method is no evidence of safety. Both transports
    /// refuse a GET and a HEAD as they refuse a POST, before anything leaves, and so does the browser the node drives.
    /// When nothing waits, they go as before.
    #[test]
    fn a_state_changing_get_to_an_unheld_destination_is_blocked_while_any_hold_waits() {
        super::wait_here(true);
        let url = url::Url::parse("https://ninth-processor.invalid/confirm?order=42").unwrap();
        for method in ["GET", "HEAD", "get", "POST", "PUT", "PATCH", "DELETE", "PURGE"] {
            let e = super::check_request(&url, method).unwrap_err();
            assert!(matches!(&e, crate::replay::ReplayError::Refused(why) if why.contains("waiting")), "{method}: {e:?}");
        }
        for method in ["GET", "HEAD", "POST"] {
            let req = crate::replay::Request { method: method.into(), url: url.clone(), exchange: 0, headers: vec![], body: None };
            let mut plain = crate::replay::HttpFetch::new().unwrap();
            let mut chrome = crate::http::ChromeFetch::new().unwrap();
            for e in [crate::replay::Fetch::fetch(&mut plain, &req).unwrap_err(), crate::replay::Fetch::fetch(&mut chrome, &req).unwrap_err()] {
                assert!(matches!(&e, crate::replay::ReplayError::Refused(why) if why.contains("waiting")), "{method}: {e:?}");
            }
        }
        assert!(super::refused_in_a_browser(&url).is_some(), "the browser the node drives takes no step");
        super::wait_here(false);
        assert!(super::check_request(&url, "GET").is_ok() && super::check_request(&url, "POST").is_ok());
    }

    /// A hold never begins in the middle of a browser visit the node drives (a signing page's): beginning it waits for
    /// the visit to end, and a visit that starts once the hold is on is refused, so no request of the visit's goes out
    /// during the hold. The browsers' proxy refuses its page's traffic too (`proxy`).
    #[test]
    fn a_hold_beginning_during_a_signing_visit_lets_no_request_out() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let url = url::Url::parse("https://signing-visit.invalid/page").unwrap();
        let visiting = super::visit(&url).expect("a visit with nothing held");
        let visit_over = Arc::new(AtomicBool::new(false));
        let begun_while_visiting = Arc::new(AtomicBool::new(false));
        let (over, early) = (visit_over.clone(), begun_while_visiting.clone());
        let begins = std::thread::spawn(move || {
            super::with_no_visit(|| early.store(!over.load(Ordering::SeqCst), Ordering::SeqCst));
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        visit_over.store(true, Ordering::SeqCst);
        drop(visiting);
        begins.join().unwrap();
        assert!(!begun_while_visiting.load(Ordering::SeqCst), "the hold began only once the visit was over");
        super::wait_here(true);
        assert!(super::visit(&url).is_err(), "a visit that starts during the hold is refused");
        super::wait_here(false);
        assert!(super::visit(&url).is_ok(), "released, visits go");
    }
}
