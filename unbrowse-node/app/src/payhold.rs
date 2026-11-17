//! The checkout hold: from the moment the owner is asked about paying with a card on a site until the owner says the
//! checkout is finished or dismissed, nothing an agent sets off reaches that site, nor any host the checkout names.
//!
//! One rule, one record. A hold is begun when the node first asks the owner about a card for a site
//! (`api::browse::approve_checkout`) and grows with every host the checkout is measured to name: its frames, its forms'
//! actions, and the hosts the browser's own record shows its pages submitting to. It is crossed by every agent
//! command on a site (`browse::card_gate`) and every request the node sends (`unbrowse_learn::hold`, through
//! `browse::card_holds_host`). Nothing an agent does ends it, nor does time: not closing the tab, not navigating, not
//! waiting, not the node restarting. It ends only by the owner: a "done" or "dismiss" in their window or dialog
//! (`checkout_release`), the owner's own "done" on the hand-off of the page, or their "no" to the card. A hold a day
//! old is said again to the owner in the activity log, once a day, and stays on.
//!
//! The record is kept on disk, the owner's alone, sealed with a key derived from the node's root key
//! (`owner_pass::text_seal_key`) over a sequence number and the holds: a file another program wrote, edited, emptied or
//! put back from before doesn't pass, and holds every site until the owner dismisses all. While the node runs it also
//! keeps the last record it read or wrote: a file deleted, or an older sealed copy put back, can't take away a hold it
//! knows. A hold that can't be written isn't begun, and no card is filled.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};

use crate::store;
use crate::sync::Locked;

/// How often a hold nobody released is said again to the owner, in seconds. It is never released by time.
pub const REMIND_EVERY: u64 = 24 * 60 * 60;

/// The most other hosts one checkout can add to its hold: a page can name any number, and every host held is one the
/// agent can't even read while the hold lasts, so the list stays short enough for the owner to read in full.
pub const MOST_HOSTS: usize = 8;

/// The label the record's seal is made under.
const SEAL_LABEL: &str = "checkout-holds";

/// One site's checkout hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    /// The site of the browser the checkout is in.
    pub site: String,
    /// Every other site the checkout names, as far as the browser shows: frames, form actions, submissions.
    #[serde(default)]
    pub hosts: Vec<String>,
    pub since: u64,
    /// When the owner is next told the hold is still on. It is never an end.
    pub remind_at: u64,
    /// What the owner is told when the page is handed to them: what changed that the node didn't do.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// How many other hosts the checkout named past the most a hold lists ([`MOST_HOSTS`]): not held for reads, and
    /// told to the owner. Nothing that changes state reaches them either way while any checkout waits.
    #[serde(default)]
    pub more: usize,
}

impl Hold {
    /// Whether this hold covers `site`.
    pub fn covers(&self, site: &str) -> bool {
        self.site == site || self.hosts.iter().any(|h| h == site)
    }
}

/// The record as it is on disk: the holds, a sequence number that only grows, and the seal over both.
#[derive(Serialize, Deserialize)]
struct Sealed {
    seq: u64,
    holds: Vec<Hold>,
    seal: String,
}

fn sealed_text(seq: u64, holds: &[Hold]) -> String {
    format!("{seq}\n{}", serde_json::to_string(holds).unwrap_or_default())
}

/// The holds: `Err` when the record doesn't read or isn't the node's, which holds every site.
#[derive(Debug)]
pub struct Holds {
    list: Result<Vec<Hold>, String>,
    seq: u64,
    path: Option<PathBuf>,
    key: Option<[u8; 32]>,
    /// Why the record's lock couldn't be taken, if it couldn't: then nothing is begun or written (`unlocked`).
    unlocked: Option<String>,
}

impl Holds {
    /// The holds kept at `path`, sealed with `key`. `known` is the last record this process read or wrote (its sequence
    /// and holds): a file gone, or older than that, is that record instead. A missing file with nothing known is none;
    /// a file that doesn't read, isn't sealed, or whose seal `key` doesn't make (or with no `key` to check it) is `Err`.
    pub fn load(path: &Path, key: Option<[u8; 32]>, known: Option<&(u64, Vec<Hold>)>) -> Holds {
        let from_known = |k: &(u64, Vec<Hold>)| Holds { list: Ok(k.1.clone()), seq: k.0, path: Some(path.to_path_buf()), key, unlocked: None };
        let read = match std::fs::read_to_string(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return match known {
                    Some(k) => from_known(k),
                    None => Holds { list: Ok(Vec::new()), seq: 0, path: Some(path.to_path_buf()), key, unlocked: None },
                }
            }
            Err(e) => Err(e.to_string()),
            Ok(t) => serde_json::from_str::<Sealed>(&t).map_err(|_| "it isn't a sealed record of the node's".to_string()),
        };
        let checked = read.and_then(|r| {
            let k = key.ok_or("the node's key isn't at hand to check its seal")?;
            if unbrowse_core::owner_pass::sealed_text_with(&k, &sealed_text(r.seq, &r.holds), &r.seal) {
                Ok(r)
            } else {
                Err("its seal isn't the node's: another program wrote or changed it".to_string())
            }
        });
        match (checked, known) {
            (Ok(r), Some(k)) if r.seq < k.0 => from_known(k),
            (Ok(r), _) => Holds { list: Ok(r.holds), seq: r.seq, path: Some(path.to_path_buf()), key, unlocked: None },
            (Err(e), _) => Holds { list: Err(e), seq: known.map(|k| k.0).unwrap_or(0), path: Some(path.to_path_buf()), key, unlocked: None },
        }
    }

    /// The record while another process holds its lock past the wait (`with`): it can't be read as it stands, so it
    /// holds every site, and nothing is begun, released or written until the lock is free.
    fn unlocked(path: &Path, key: Option<[u8; 32]>, why: &str) -> Holds {
        let why = format!("the record of checkouts is being changed by another process and its lock couldn't be taken ({why})");
        Holds { list: Err(why.clone()), seq: 0, path: Some(path.to_path_buf()), key, unlocked: Some(why) }
    }

    /// Holds kept in memory only: a test's, away from any home.
    #[cfg(test)]
    pub fn in_memory() -> Holds {
        Holds { list: Ok(Vec::new()), seq: 0, path: None, key: None, unlocked: None }
    }

    /// What this record says, for the process to keep (`known`); `None` when it didn't read.
    fn known(&self) -> Option<(u64, Vec<Hold>)> {
        self.list.as_ref().ok().map(|l| (self.seq, l.clone()))
    }

    fn live(&mut self) -> Option<&mut Vec<Hold>> {
        self.list.as_mut().ok()
    }

    /// Why `site` is held, if it is.
    pub fn held(&mut self, site: &str) -> Option<String> {
        let Some(list) = self.live() else {
            let why = self.list.as_ref().err().cloned().unwrap_or_default();
            return Some(format!("the node's record of checkouts in progress can't be trusted ({why}), so every site is held until the owner dismisses them all (unbrowse-node checkout dismiss all)"));
        };
        list.iter().find(|h| h.covers(site)).map(|h| format!("a card checkout on {} is in the owner's hands until they say it is finished or dismissed", h.site))
    }

    /// The sites whose hold is due to be said again to the owner at `now`, each now due a day later.
    pub fn remind(&mut self, now: u64) -> Result<Vec<String>, String> {
        let Some(list) = self.live() else { return Ok(Vec::new()) };
        let mut due = Vec::new();
        for h in list.iter_mut().filter(|h| h.remind_at <= now) {
            h.remind_at = now + REMIND_EVERY;
            due.push(h.site.clone());
        }
        if !due.is_empty() {
            self.save()?;
        }
        Ok(due)
    }

    /// Begins a hold on `site`, or adds `hosts` to the one it has. Err when it can't be kept: the caller fills no card.
    pub fn begin(&mut self, site: &str, hosts: &[String], now: u64) -> Result<(), String> {
        if let Some(why) = &self.unlocked {
            return Err(why.clone());
        }
        let Some(list) = self.live() else { return Ok(()) };
        let at = match list.iter().position(|h| h.site == site) {
            Some(at) => at,
            None => {
                list.push(Hold { site: site.into(), hosts: Vec::new(), since: now, remind_at: now + REMIND_EVERY, warnings: Vec::new(), more: 0 });
                list.len() - 1
            }
        };
        for host in hosts {
            if !host.is_empty() && *host != list[at].site && !list[at].hosts.contains(host) {
                if list[at].hosts.len() < MOST_HOSTS {
                    list[at].hosts.push(host.clone());
                } else {
                    list[at].more += 1;
                }
            }
        }
        self.save()
    }

    /// Notes what the owner must be told about `site`'s checkout when it is handed to them.
    pub fn warn(&mut self, site: &str, warning: &str) -> Result<(), String> {
        let Some(list) = self.live() else { return Ok(()) };
        if let Some(h) = list.iter_mut().find(|h| h.site == site) {
            if !h.warnings.iter().any(|w| w == warning) {
                h.warnings.push(warning.to_string());
            }
        }
        self.save()
    }

    /// The hold `site` is in, if any.
    pub fn of(&mut self, site: &str) -> Option<Hold> {
        self.live()?.iter().find(|h| h.covers(site)).cloned()
    }

    /// Every hold; `Err` when the record can't be trusted.
    pub fn list(&mut self) -> Result<Vec<Hold>, String> {
        match self.live() {
            Some(l) => Ok(l.clone()),
            None => Err(self.list.as_ref().err().cloned().unwrap_or_default()),
        }
    }

    /// Ends the hold on `site` (`*`: every hold, and a record that couldn't be trusted, which is written afresh). Only
    /// the owner's own act calls this. Returns how many ended.
    pub fn release(&mut self, site: &str) -> Result<usize, String> {
        if site == "*" {
            let n = self.list.as_ref().map(Vec::len).unwrap_or(1);
            self.list = Ok(Vec::new());
            self.save()?;
            return Ok(n);
        }
        let Some(list) = self.live() else { return Err("the record of checkouts in progress can't be trusted: dismiss all of them".into()) };
        let before = list.len();
        list.retain(|h| h.site != site);
        let n = before - list.len();
        self.save()?;
        Ok(n)
    }

    /// Writes the record, sealed, with its sequence one higher. With no key to seal it, nothing is written: Err.
    fn save(&mut self) -> Result<(), String> {
        if let Some(why) = &self.unlocked {
            return Err(why.clone());
        }
        let (Some(path), Ok(list)) = (&self.path, &self.list) else { return Ok(()) };
        let key = self.key.ok_or("the node's key isn't at hand to seal the record of checkouts")?;
        let seq = self.seq + 1;
        let record = Sealed { seq, holds: list.clone(), seal: unbrowse_core::owner_pass::seal_text_with(&key, &sealed_text(seq, list)) };
        let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        let part = path.with_extension("json.part");
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        o.open(&part).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes())).map_err(|e| e.to_string())?;
        std::fs::rename(&part, path).map_err(|e| e.to_string())?;
        let _ = unbrowse_core::keystore::keep_private(path);
        self.seq = seq;
        Ok(())
    }
}

fn file() -> PathBuf {
    store::home().join("checkout-holds.json")
}

/// The key the record is sealed with, derived from the node's root key once it is loaded (`seal_with`).
static KEY: RwLock<Option<[u8; 32]>> = RwLock::new(None);
/// The last record this process read or wrote, by the file it is kept in: what that file gone, or put back from
/// before, is held to.
static KNOWN: Mutex<Vec<(PathBuf, (u64, Vec<Hold>))>> = Mutex::new(Vec::new());
/// One reader or writer of the holds at a time in this process.
static ONE: Mutex<()> = Mutex::new(());

/// Keeps the key the record is sealed with, derived from `root` under its own label: opens and seals nothing else.
pub fn seal_with(root: &unbrowse_core::RootKey) {
    let key = unbrowse_core::owner_pass::text_seal_key(root, SEAL_LABEL);
    *KEY.write().unwrap_or_else(|e| e.into_inner()) = Some(*key);
}

type RootSource = dyn Fn() -> Option<unbrowse_core::RootKey> + Send + Sync;
/// Where the root key is loaded from when the seal key isn't kept yet (a node whose key is made after it starts).
static ROOT: std::sync::OnceLock<Box<RootSource>> = std::sync::OnceLock::new();

/// Says where to load the root key from to seal the record: loaded once, for the seal key alone, then let go.
pub fn seal_from(root: impl Fn() -> Option<unbrowse_core::RootKey> + Send + Sync + 'static) {
    let _ = ROOT.set(Box::new(root));
}

fn seal_key() -> Option<[u8; 32]> {
    if let Some(k) = *KEY.read().unwrap_or_else(|e| e.into_inner()) {
        return Some(k);
    }
    let root = ROOT.get()?()?;
    seal_with(&root);
    *KEY.read().unwrap_or_else(|e| e.into_inner())
}

/// One seal key for every test that keeps holds in a scratch home: tests running side by side never seal with
/// different keys.
#[cfg(test)]
pub fn seal_for_tests() {
    KEY.write().unwrap_or_else(|e| e.into_inner()).get_or_insert([7u8; 32]);
}

#[cfg(test)]
thread_local! {
    /// A test thread's own holds, when it has no home of its own: no test sees another's.
    static MEMORY: std::cell::RefCell<Option<Holds>> = const { std::cell::RefCell::new(None) };
}

/// The holds, read from disk each time: the node, the owner's window and the owner's shell (`checkout`) are one record,
/// and a release from any of them holds at once everywhere. The file is small: a site or two.
fn with<T>(f: impl FnOnce(&mut Holds) -> T) -> T {
    with_waiting(store::MONEY_LOCK_WAIT, f)
}

/// `with`, waiting at most `wait` for the record's lock. The node and a shell's `checkout` are two processes that each
/// read the record, change it and write it back, so each holds the lock across processes from the read to the write:
/// otherwise a release in one, written over a hold begun in the other, would end a hold nobody released. A lock not
/// taken in time fails closed (`Holds::unlocked`).
fn with_waiting<T>(wait: std::time::Duration, f: impl FnOnce(&mut Holds) -> T) -> T {
    #[cfg(test)]
    if !store::has_scratch_home() {
        return MEMORY.with(|m| f(m.borrow_mut().get_or_insert_with(Holds::in_memory)));
    }
    let _one = ONE.locked();
    let key = seal_key();
    let path = file();
    let file_lock = store::hold_money_file(&path, wait);
    let mut known = KNOWN.locked();
    let at = known.iter().position(|(p, _)| *p == path);
    let mut holds = match &file_lock {
        Ok(_) => Holds::load(&path, key, at.map(|i| &known[i].1)),
        Err(e) => Holds::unlocked(&path, key, e),
    };
    let out = f(&mut holds);
    if let Some(k) = holds.known() {
        match at {
            Some(i) => known[i].1 = k,
            None => known.push((path, k)),
        }
    }
    out
}

/// Says, at the node's start, a record that can't be trusted: every site is held until the owner dismisses them all.
pub fn restore() {
    if let Err(e) = list() {
        eprintln!("{} can't be trusted ({e}): every site is held until the owner dismisses the checkouts (unbrowse-node checkout dismiss all)", file().display());
    }
}

/// Why `site` is held, if it is. A hold a day old is said again to the owner here, in the activity log.
pub fn held(site: &str) -> Option<String> {
    let (why, due) = with(|h| (h.held(site), h.remind(store::now())));
    for s in due.unwrap_or_default() {
        store::log_activity(&store::Activity {
            at: store::now(),
            who: "the node".into(),
            site: s.clone(),
            what: format!("The card checkout on {s} is still held for you: agents can't act on the site until you say it is finished or dismissed (unbrowse-node checkout done|dismiss {s})"),
            kind: "vault".into(),
            result: "waiting".into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
    why
}

/// Begins a hold on `site`, or adds `hosts` to it. Err when it can't be kept: no card is filled then.
pub fn begin(site: &str, hosts: &[String]) -> Result<(), String> {
    // Never in the middle of a browser visit the node drives (a signing page's): it waits for one to end, and none
    // starts meanwhile (`unbrowse_learn::hold::with_no_visit`).
    // The hold is made durable and said under the commit lock every browser connection's final authorisation reads
    // (`unbrowse_learn::hold::committing`): no connection checked before it can be committed after it. The visit lock is
    // taken first, so a visit's own connections, which need the commit lock to be authorised, finish rather than wait.
    unbrowse_learn::hold::with_no_visit(|| unbrowse_learn::hold::committing(|| with(|h| h.begin(site, hosts, store::now()))))
        .map_err(|e| format!("the node couldn't keep the checkout hold on {site} ({e}), so it fills no card there"))
}

/// Notes `warning` for the owner about `site`'s checkout.
pub fn warn(site: &str, warning: &str) {
    let _ = with(|h| h.warn(site, warning));
}

/// The hold covering `site`, if any.
pub fn of(site: &str) -> Option<Hold> {
    with(|h| h.of(site))
}

/// Every hold.
pub fn list() -> Result<Vec<Hold>, String> {
    with(|h| h.list())
}

/// Why nothing that changes state may be sent anywhere now: a checkout waits for the owner (any hold, or a record that
/// can't be trusted). `None` when none does.
pub fn waiting() -> Option<String> {
    match list() {
        Err(e) => Some(format!("the node's record of card checkouts can't be trusted ({e}), so it changes nothing anywhere until the owner dismisses them all")),
        Ok(holds) => holds.first().map(|h| format!("a card checkout on {} is waiting for the owner: until they say it is finished or dismissed, the node calls no route of any kind on any site (a GET can commit an order as well as a POST) and runs no command in any page of any site but close and the tab's address and title (a read of a page runs the page's own code)", h.site)),
    }
}

/// What the owner is shown of a hold: the site, the other hosts it holds, and how many more the checkout named.
pub fn shown(h: &Hold) -> String {
    let mut said = h.site.clone();
    if !h.hosts.is_empty() {
        said.push_str(&format!(" and {}", h.hosts.join(", ")));
    }
    if h.more > 0 {
        said.push_str(&format!(" ({} more the checkout named aren't listed, and aren't held for reads)", h.more));
    }
    said
}

/// Ends the hold on `site` (`*`: all). The owner's own act only: a command in their window or dialog, their "done" on
/// the hand-off, or their "no" to the card.
pub fn release(site: &str) -> Result<usize, String> {
    let released = unbrowse_learn::hold::committing(|| with(|h| h.release(site)));
    // The last hold released: every page the hold paused runs again (`quiet::wake`).
    if released.is_ok() && list().is_ok_and(|l| l.is_empty()) {
        crate::quiet::wake();
    }
    released
}

/// [`release`], said in the activity log as the owner's: the checkout `how` they called it (finished or dismissed).
pub fn release_by(site: &str, how: &str) -> Result<usize, String> {
    let n = release(site)?;
    if n > 0 {
        store::log_activity(&store::Activity {
            at: store::now(),
            who: "you".into(),
            site: site.to_string(),
            what: format!("Said the card checkout was {how}: agents may act on the site again"),
            kind: "vault".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("payhold-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("checkout-holds.json")
    }

    /// A hold covers its site and every host the checkout named, outlives a restart (read back, sealed, from disk), and
    /// nothing ends it but the owner's release: not a day, not a week. A hold a day old is said again to the owner,
    /// once a day, and stays on.
    #[test]
    fn a_checkout_hold_ends_only_by_the_owner_and_never_by_time() {
        let path = temp("time");
        let key = Some([1u8; 32]);
        let mut h = Holds::load(&path, key, None);
        assert!(h.held("shop.example").is_none());
        h.begin("shop.example", &["payments.example".into(), "provider.example".into()], 100).unwrap();
        for site in ["shop.example", "payments.example", "provider.example"] {
            assert!(h.held(site).is_some(), "{site}");
        }
        assert!(h.held("other.example").is_none());
        // A restart: the hold is read back.
        let mut again = Holds::load(&path, key, None);
        assert!(again.held("payments.example").is_some(), "the hold outlived the restart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A day and a week later it is still held; a day after it began, the owner is told again, once.
        assert!(again.remind(100 + REMIND_EVERY - 1).unwrap().is_empty());
        assert_eq!(again.remind(100 + REMIND_EVERY).unwrap(), ["shop.example"]);
        assert!(again.remind(100 + REMIND_EVERY + 60).unwrap().is_empty(), "once a day");
        assert!(Holds::load(&path, key, None).held("shop.example").is_some(), "a day on, still held");
        assert_eq!(again.remind(100 + 7 * REMIND_EVERY).unwrap(), ["shop.example"]);
        assert!(Holds::load(&path, key, None).held("shop.example").is_some(), "a week on, still held");
        // Only release ends it.
        assert_eq!(Holds::load(&path, key, None).release("shop.example"), Ok(1));
        assert!(Holds::load(&path, key, None).held("shop.example").is_none());
    }

    /// The record is the node's own: sealed with its key over the holds and a sequence that only grows. A file another
    /// program edited (a host taken out), emptied (`[]`), wrote in the old unsealed form, or sealed with another key
    /// holds every site, until the owner dismisses them all. While the node runs, a file deleted or an older sealed copy
    /// put back is the record it last knew, so neither takes a hold away. A hold that can't be sealed isn't begun.
    #[test]
    fn a_checkout_hold_cant_be_cleared_or_shrunk_by_editing_its_file() {
        let path = temp("seal");
        let key = Some([2u8; 32]);
        let mut h = Holds::load(&path, key, None);
        h.begin("shop.example", &["payments.example".into()], 1).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        h.begin("shop.example", &["more.example".into()], 2).unwrap();
        let known = h.known();
        // Edited: a host taken out, the seal left as it was.
        let edited = std::fs::read_to_string(&path).unwrap().replace("\"payments.example\",", "");
        std::fs::write(&path, &edited).unwrap();
        assert!(Holds::load(&path, key, None).held("anything.example").is_some(), "an edited record holds every site");
        for forged in ["[]", "{\"seq\":9,\"holds\":[],\"seal\":\"00\"}"] {
            std::fs::write(&path, forged).unwrap();
            assert!(Holds::load(&path, key, None).held("payments.example").is_some(), "{forged}");
        }
        // Sealed with another key.
        let other_path = temp("seal-other");
        let mut other = Holds::load(&other_path, Some([3u8; 32]), None);
        other.begin("x.example", &[], 1).unwrap();
        std::fs::copy(&other_path, &path).unwrap();
        assert!(Holds::load(&path, key, None).held("payments.example").is_some(), "another key's record");
        // Deleted, or the older sealed copy put back, while the node runs: the record it knew.
        std::fs::remove_file(&path).unwrap();
        let mut gone = Holds::load(&path, key, known.as_ref());
        assert!(gone.held("more.example").is_some() && gone.held("payments.example").is_some(), "a deleted file takes no hold away");
        std::fs::write(&path, &first).unwrap();
        assert!(Holds::load(&path, key, known.as_ref()).held("more.example").is_some(), "an older copy takes no hold away");
        // With no key to seal it, a hold isn't begun: the caller fills no card.
        let mut keyless = Holds::load(&temp("seal-keyless"), None, None);
        assert!(keyless.begin("shop.example", &[], 1).is_err());
        // The owner's dismiss-all writes it afresh.
        std::fs::write(&path, "[]").unwrap();
        let mut broken = Holds::load(&path, key, None);
        assert!(broken.release("payments.example").is_err());
        assert!(broken.release("*").is_ok());
        assert!(Holds::load(&path, key, None).held("payments.example").is_none());
    }

    /// The record is changed under a lock other processes take too (a shell's `checkout`), held from the read to the
    /// write: while another holds it past the wait, every site is held, and nothing is begun, released or written, so a
    /// release can never be written over a hold begun meanwhile. Once the lock is free, the record is as it was.
    #[test]
    fn a_checkout_hold_is_changed_only_under_its_lock_and_fails_closed_without_it() {
        seal_for_tests();
        let _home = store::scratch_home("payhold-locked");
        let short = std::time::Duration::from_millis(50);
        with(|h| h.begin("shop.example", &[], 1)).unwrap();
        let other = store::hold_money_file(&file(), store::MONEY_LOCK_WAIT).unwrap();
        assert!(with_waiting(short, |h| h.held("elsewhere.example")).is_some(), "every site is held");
        assert!(with_waiting(short, |h| h.begin("new.example", &[], 2)).is_err(), "no hold is begun: the caller fills no card");
        assert!(with_waiting(short, |h| h.release("*")).is_err(), "nothing is released");
        drop(other);
        assert!(with(|h| h.held("shop.example")).is_some(), "the hold stands");
        assert!(with(|h| h.held("elsewhere.example")).is_none());
        assert_eq!(with(|h| h.release("shop.example")), Ok(1));
    }

    /// A test's holds are its own: one kept in a scratch home is seen there alone, and a thread with no home has its
    /// own in memory, so tests running side by side never see each other's.
    #[test]
    fn a_tests_checkout_hold_is_its_own() {
        seal_for_tests();
        let _home = store::scratch_home("payhold-own");
        begin("isolated.example", &[]).unwrap();
        assert!(held("isolated.example").is_some());
        let elsewhere = std::thread::spawn(|| {
            let other = held("isolated.example").is_none();
            let _home = store::scratch_home("payhold-other");
            other && held("isolated.example").is_none()
        });
        assert!(elsewhere.join().unwrap(), "another test's thread, with a home or without, sees no hold of this one's");
        release("isolated.example").unwrap();
    }
}
