//! An ask: one tool call an agent made, from the moment the node takes it to the end of the work it set off, its reply
//! and whatever goes on behind it (a second look at the page, a try of its controls). Each has an id, said on the reply
//! of every tool that names its outcome (`ask`), and the stop flag every walk it starts ends on (`mint::stops_with`):
//! the id lives with the flag. Its life is written to `asks.jsonl` in the node's home, a line per event, names and
//! shapes only, never a value: `started` (the tool), `reply` (its outcome), `behind` (the work still going on after
//! the reply, by name) and `ended` (when the last of it ended, and whether its stop flag was set).
//!
//! An ask is answered before its caller's wait ends (`answer_within`): an `unbrowse_do` whose work is still going on
//! when the wait it was given runs out (`wait_ms`, `DEFAULT_WAIT` unsaid, at most `MOST_WAIT`) replies `still_working`
//! with its ask and the call that collects the answer, and the work goes on: the reply was given, so its stop flag is
//! not set, until the work behind the reply has run `WALL`, when it is. The answer is kept `KEPT` after the work ends,
//! for its ask to collect (`collect`), and a second ask of the same goal on the same page joins the work in flight.
//!
//! A batch (`unbrowse_do` with `pages`) is one ask, answered within its caller's wait like one do, its still-working
//! reply the pages answered so far (`Ask::so_far`); each of its pages is an ask too (`enlist`), adopted by the batch
//! (`Ask::adopt`), collected alone by its id, and joined by a later do of that page.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::sync::Locked;

/// One ask.
pub(crate) struct Ask {
    /// What its replies and its log lines name it by: `ask_` and 16 hex digits drawn at random.
    pub(crate) id: String,
    /// The tool asked.
    pub(crate) tool: &'static str,
    /// Set when the ask gives up (cancelled, or its request dropped unanswered): every walk it started ends.
    pub(crate) stop: Arc<AtomicBool>,
    started: std::time::Instant,
    /// `asks.jsonl` in the home of the node that took it (read once, where it was taken).
    log: std::path::PathBuf,
    state: Mutex<State>,
    /// What the work is doing now, as a still-working reply says it (`phase`).
    phase: Mutex<&'static str>,
    /// Set, with the reader that says why, when the work knows it can't answer within its caller's wait (a profile
    /// another walk holds): the caller is answered still working at once.
    hurry: tokio::sync::watch::Sender<Option<&'static str>>,
    /// Set when the work behind its reply ran its wall and its stop flag was set for it.
    walled: AtomicBool,
    /// How long the work behind its reply may go on before its stop flag is set: `WALL`, or longer for work bounded
    /// by a wait of its own (`goes_on_for`).
    wall: Mutex<std::time::Duration>,
    /// The asks of the pages a batch's work asked for (`enlist`): each said to have replied when the batch replies, so
    /// its work behind the reply is bounded as the batch's own is.
    children: Mutex<Vec<Arc<Ask>>>,
    /// What a batch's work has answered so far: what a still-working reply of the batch says (`so_far`).
    so_far: Mutex<Option<Value>>,
    /// The words its caller asked with (`session_held::callers_words`): what an answer collected later leaves as it is.
    words: Mutex<Vec<String>>,
}

/// How long `unbrowse_do` waits for its work before it answers still working, when the call says no `wait_ms`:
/// 15 s under the minute an MCP client waits, for the time the reply takes to reach it on a loaded machine.
pub(crate) const DEFAULT_WAIT: std::time::Duration = std::time::Duration::from_millis(45_000);

/// The longest wait a call may ask for (`wait_ms`), inside the SDKs' own wait (`CALL_WAIT_SECS`).
pub(crate) const MOST_WAIT: std::time::Duration = std::time::Duration::from_millis(300_000);

/// How long an ask's work goes on behind its reply before its stop flag is set (`param.ask.wall`): what it holds goes
/// back, and its answer says the work was ended there.
pub(crate) const LIVE_WALL: std::time::Duration = std::time::Duration::from_secs(120);
pub(crate) const WALL: std::time::Duration = if cfg!(test) { std::time::Duration::from_millis(800) } else { LIVE_WALL };

/// How long an answer is kept for its ask to collect, after its work ends.
pub(crate) const KEPT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Default)]
struct State {
    replied: bool,
    /// The work going on for it, each with a number of its own and its name.
    behind: Vec<(u64, &'static str)>,
    next: u64,
    ended: bool,
}

tokio::task_local! {
    /// The ask the task works for.
    static ASK: Arc<Ask>;
}

/// The asks not yet ended: what a thread that has only an ask's stop flag finds it by (`by_stop`).
static LIVE: Mutex<Vec<Arc<Ask>>> = Mutex::new(Vec::new());

impl Ask {
    /// A new ask of `tool`, its `started` written.
    pub(crate) fn begin(tool: &'static str) -> Arc<Ask> {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).expect("the OS gives no randomness");
        let ask = Arc::new(Ask {
            id: format!("ask_{}", hex::encode(bytes)),
            tool,
            stop: Arc::default(),
            started: std::time::Instant::now(),
            log: crate::store::home().join("asks.jsonl"),
            state: Mutex::default(),
            phase: Mutex::new("started"),
            hurry: tokio::sync::watch::Sender::new(None),
            walled: AtomicBool::new(false),
            wall: Mutex::new(WALL),
            children: Mutex::default(),
            so_far: Mutex::default(),
            words: Mutex::default(),
        });
        ask.write(json!({ "event": "started", "tool": tool }));
        LIVE.locked().push(ask.clone());
        ask
    }

    /// One line of `asks.jsonl`: the event, when, the ask and how long since it began.
    fn write(&self, mut line: Value) {
        use std::io::Write;
        line["at"] = json!(crate::store::now());
        line["ask"] = json!(self.id);
        line["ms"] = json!(self.started.elapsed().as_millis() as u64);
        // One write of the whole line, one writer at a time: asks run side by side, and a line written in pieces (as
        // `writeln!` of a value does) is interleaved with another's into lines neither reader can parse.
        static WRITING: Mutex<()> = Mutex::new(());
        let whole = format!("{line}\n");
        let _one = WRITING.locked();
        let wrote = std::fs::OpenOptions::new().create(true).append(true).open(&self.log).and_then(|mut f| f.write_all(whole.as_bytes()));
        if let Err(e) = wrote {
            eprintln!("asks: {} not written to {}: {e}", line["event"], self.log.display());
        }
    }

    /// The reply is given, having come to `outcome`: said once. The work still going on for the ask is said as
    /// behind it; with none, the ask has ended.
    /// The work behind it is bounded: past `WALL` its stop flag is set.
    pub(crate) fn replied(self: &Arc<Self>, outcome: Option<&str>) {
        let mut st = self.state.locked();
        if st.replied {
            return;
        }
        st.replied = true;
        self.write(json!({ "event": "reply", "tool": self.tool, "outcome": outcome }));
        // A page not yet answered when its batch replies goes on behind that reply, still working; one answered has
        // replied already, with its own outcome.
        for child in std::mem::take(&mut *self.children.locked()) {
            child.replied(Some(crate::outcome::Outcome::StillWorking.word()));
        }
        if st.behind.is_empty() {
            self.end(&mut st);
            return;
        }
        let work: Vec<&str> = st.behind.iter().map(|(_, w)| *w).collect();
        self.write(json!({ "event": "behind", "work": work }));
        drop(st);
        let ask = Arc::downgrade(self);
        let replied_at = std::time::Instant::now();
        std::thread::spawn(move || loop {
            let Some(ask) = ask.upgrade() else { return };
            if ask.has_ended() {
                return;
            }
            // The wall is read again each turn: work that learns its own wait after the reply went (`goes_on_for`, set
            // by work that started late) is held to that, not to the wall it had when the reply went.
            let wall = *ask.wall.locked();
            let Some(left) = (replied_at + wall).checked_duration_since(std::time::Instant::now()).filter(|l| !l.is_zero()) else {
                eprintln!("asks: {}'s work ran {} s behind its reply: its stop flag is set (param.ask.wall)", ask.id, wall.as_secs());
                ask.walled.store(true, Ordering::Relaxed);
                ask.stop.store(true, Ordering::Relaxed);
                return;
            };
            drop(ask);
            std::thread::sleep(left.min(std::time::Duration::from_millis(250)));
        });
    }

    /// Keeps `words`, which its caller asked with, beside those it has.
    pub(crate) fn hear(&self, words: &[String]) {
        let mut kept = self.words.locked();
        for w in words {
            if !kept.contains(w) {
                kept.push(w.clone());
            }
        }
    }

    /// The words its callers asked with.
    pub(crate) fn words(&self) -> Vec<String> {
        self.words.locked().clone()
    }

    /// `child` is the ask of a page this batch's work asked for: it replies when the batch does, if not before. It
    /// takes the batch's words, which asked for its page.
    pub(crate) fn adopt(&self, child: Arc<Ask>) {
        child.hear(&self.words());
        // Under the batch's own lock: a batch replying now takes the child with it, or has replied before it came.
        let st = self.state.locked();
        if st.replied {
            drop(st);
            child.replied(Some(crate::outcome::Outcome::StillWorking.word()));
        } else {
            self.children.locked().push(child);
        }
    }

    /// What its work has answered so far, for a still-working reply to say.
    pub(crate) fn so_far(&self, v: Value) {
        *self.so_far.locked() = Some(v);
    }

    /// Whether its work was ended at `WALL` behind its reply.
    pub(crate) fn walled(&self) -> bool {
        self.walled.load(Ordering::Relaxed)
    }

    /// What its work is doing now.
    pub(crate) fn set_phase(&self, phase: &'static str) {
        *self.phase.locked() = phase;
    }

    /// What its work is doing now.
    pub(crate) fn phase_now(&self) -> &'static str {
        *self.phase.locked()
    }

    /// Its caller is to be answered now, still working, for the reason `from` names.
    pub(crate) fn hurry(&self, from: &'static str) {
        self.hurry.send_replace(Some(from));
    }

    /// The work behind its reply may go on `wall` before its stop flag is set, not `WALL`: work that ends by a wait of
    /// its own, which its caller set (the owner's answer to `ask_owner`, waited for as long as the agent asked). Never
    /// shorter than `WALL`; set before or after the reply, so long as the wall has not yet been met.
    pub(crate) fn goes_on_for(&self, wall: std::time::Duration) {
        let mut w = self.wall.locked();
        *w = wall.max(*w);
    }

    /// Whether the ask and all its work have ended.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn has_ended(&self) -> bool {
        self.state.locked().ended
    }

    /// Work for this ask named `what`, going on until the token is dropped: said as behind the reply when it is still
    /// going on once the reply is given.
    pub(crate) fn behind(self: &Arc<Self>, what: &'static str) -> Behind {
        let mut st = self.state.locked();
        let n = st.next;
        st.next += 1;
        st.behind.push((n, what));
        if st.replied {
            self.write(json!({ "event": "behind", "work": [what] }));
        }
        Behind { ask: self.clone(), n }
    }

    fn end(&self, st: &mut State) {
        if st.ended {
            return;
        }
        st.ended = true;
        self.write(json!({ "event": "ended", "stopped": self.stop.load(Ordering::Relaxed), "walled": self.walled() }));
        LIVE.locked().retain(|a| !std::ptr::eq(Arc::as_ptr(a), self));
    }
}

/// Work going on for an ask (`Ask::behind`): when the last of it ends after the reply, so has the ask.
pub(crate) struct Behind {
    ask: Arc<Ask>,
    n: u64,
}

impl Drop for Behind {
    fn drop(&mut self) {
        let mut st = self.ask.state.locked();
        st.behind.retain(|(n, _)| *n != self.n);
        if st.replied && st.behind.is_empty() {
            self.ask.end(&mut st);
        }
    }
}

/// The ask this task works for, if it works for one.
pub(crate) fn current() -> Option<Arc<Ask>> {
    ASK.try_with(Arc::clone).ok()
}

/// `fut`, working for `ask`: what it starts is the ask's (`current`, `ask_stop`).
pub(crate) async fn within<F: std::future::Future>(ask: Arc<Ask>, fut: F) -> F::Output {
    ASK.scope(ask, fut).await
}

/// The ask whose stop flag is `stop`, while it has not ended: the one a thread working under that flag works for.
pub(crate) fn by_stop(stop: &Arc<AtomicBool>) -> Option<Arc<Ask>> {
    LIVE.locked().iter().find(|a| Arc::ptr_eq(&a.stop, stop)).cloned()
}

/// The ask this task or thread works for: the task's, else the one whose stop flag the thread's walks end on.
pub(crate) fn this_one() -> Option<Arc<Ask>> {
    current().or_else(|| unbrowse_learn::mint::stop_flag().and_then(|s| by_stop(&s)))
}

/// Runs `work` on a thread of its own, as work of the ask this task or thread works for (`this_one`), named `what`:
/// said as behind its reply while it goes on, and its walks ending on the ask's stop flag. Outside an ask it is a
/// thread like any other.
pub(crate) fn spawn_behind<T: Send + 'static>(what: &'static str, work: impl FnOnce() -> T + Send + 'static) -> std::thread::JoinHandle<T> {
    match this_one() {
        Some(ask) => {
            let behind = ask.behind(what);
            let stop = ask.stop.clone();
            let setting = crate::learn::own_asks::carried();
            std::thread::spawn(move || {
                let _behind = behind;
                setting.over(|| unbrowse_learn::mint::stops_with(stop, work))
            })
        }
        None => {
            let setting = crate::learn::own_asks::carried();
            std::thread::spawn(move || setting.over(work))
        }
    }
}

/// A reply as it leaves the node, naming the ask it answers (`ask`): one that names one already (the kept answer of an
/// earlier ask, collected) keeps it.
pub(crate) fn put(id: &str, r: &mut Result<Value, crate::outcome::Failed>) {
    match r {
        Ok(v) => {
            if let Some(o) = v.as_object_mut() {
                o.entry("ask").or_insert(json!(id));
            }
        }
        Err(f) => {
            f.ask.get_or_insert_with(|| id.to_string());
        }
    }
}

/// What the work of the ask this task or thread works for is doing now, as a still-working reply says it.
pub(crate) fn phase(phase: &'static str) {
    if let Some(ask) = this_one() {
        ask.set_phase(phase);
    }
}

/// The work going on, or done, for one `unbrowse_do`: its ask, whose agent asked it, what makes another ask the same
/// one (`pages::in_flight`), and its answer once there is one.
struct Doing {
    ask: Arc<Ask>,
    agent: String,
    key: String,
    done: tokio::sync::watch::Sender<Option<Result<Value, crate::outcome::Failed>>>,
    /// When the work ended.
    ended: Option<std::time::Instant>,
    /// Whether a caller has had the answer: a kept answer nobody had goes to the next ask of the same key too.
    had: bool,
}

static DOING: Mutex<Vec<Doing>> = Mutex::new(Vec::new());

/// Lets go of the answers kept longer than `KEPT` after their work ended.
pub(super) fn forget_kept(now: std::time::Instant) {
    DOING.locked().retain(|d| d.ended.is_none_or(|at| now.duration_since(at) < KEPT));
}

/// The wait a call asks for in `wait_ms` (a number, or its text), at most `MOST_WAIT`; `DEFAULT_WAIT` when it says
/// none that reads.
pub(crate) fn wait_of(args: &Value) -> std::time::Duration {
    let ms = match args.get("wait_ms") {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    };
    ms.map(std::time::Duration::from_millis).unwrap_or(DEFAULT_WAIT).min(MOST_WAIT)
}

/// `unbrowse_do`'s answer within `wait`: the work `start` makes, for the ask this task works for, run in a task of its
/// own that outlives the call; or the work already going on for the same agent and `key`, joined, or its answer kept
/// and not yet had. When the wait runs out first, or the work says it can't answer within it (`Ask::hurry`), the
/// reply is still working (`still_working`), and the work goes on.
pub(crate) async fn answer_within<F>(agent: &str, key: String, wait: std::time::Duration, start: impl FnOnce() -> F) -> Result<Value, crate::outcome::Failed>
where
    F: std::future::Future<Output = Result<Value, crate::outcome::Failed>> + Send + 'static,
{
    let Enlisted { ask, done, starter } = enlist(agent, key, || current().unwrap_or_else(|| Ask::begin("unbrowse_do")));
    if let Some(starter) = starter {
        starter.start(start());
    }
    waited(ask, done, wait).await
}

/// The work for `agent` and `key`, found or made (`enlist`): its ask, its answer once there is one, and, when this
/// caller made it, what starts it.
pub(crate) struct Enlisted {
    pub(crate) ask: Arc<Ask>,
    pub(crate) done: tokio::sync::watch::Receiver<Option<Result<Value, crate::outcome::Failed>>>,
    /// None when the work was already going on, or its answer kept and not yet had: it is joined.
    pub(crate) starter: Option<Starter>,
}

/// The work already going on for `agent` and `key`, or its answer kept and not yet had; else work of a new ask (`ask`
/// makes it), enlisted now so that a later ask of the same key joins it, to be started by the caller (`Starter`).
pub(crate) fn enlist(agent: &str, key: String, ask: impl FnOnce() -> Arc<Ask>) -> Enlisted {
    forget_kept(std::time::Instant::now());
    let mut doing = DOING.locked();
    // An ask whose stop flag is set (its caller hung up or cancelled, or its work ran its wall) is no answer for a new
    // caller: joining it hands that caller another's stop. Its work is left to end; the new caller's starts afresh.
    let joinable = |d: &&Doing| d.agent == agent && d.key == key && (d.ended.is_none() || !d.had) && !d.ask.stop.load(Ordering::Relaxed);
    if let Some(d) = doing.iter().find(joinable) {
        return Enlisted { ask: d.ask.clone(), done: d.done.subscribe(), starter: None };
    }
    let ask = ask();
    let (tx, rx) = tokio::sync::watch::channel(None);
    doing.push(Doing { ask: ask.clone(), agent: agent.to_string(), key, done: tx, ended: None, had: false });
    let behind = Some(ask.behind("do"));
    Enlisted { ask: ask.clone(), done: rx, starter: Some(Starter { ask, behind }) }
}

/// What starts an enlisted ask's work. Dropped unstarted, its ask answers that the work never started.
pub(crate) struct Starter {
    ask: Arc<Ask>,
    behind: Option<Behind>,
}

impl Starter {
    /// Runs `work` in a task of its own, working for the ask; its answer is kept for the ask (`collect`) and goes to
    /// every ask that joined it.
    pub(crate) fn start<F>(mut self, work: F)
    where
        F: std::future::Future<Output = Result<Value, crate::outcome::Failed>> + Send + 'static,
    {
        let (a, behind) = (self.ask.clone(), self.behind.take());
        // The starting thread's old-node setting goes with the work (a test's own, `own_asks::carried`).
        let setting = crate::learn::own_asks::carried();
        tokio::spawn(async move {
            // Its own task, so a panic in the work is an answer too, not a wait for ever.
            let ran = tokio::spawn(setting.carry(within(a.clone(), work))).await;
            let mut r = ran.unwrap_or_else(|e| Err(crate::outcome::Failed::from((axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("the work stopped: {e}")))));
            // What it came to, read as the tool that did the work reads it: an answer collected later by
            // `unbrowse_do`'s ask is still an `unbrowse_browse` answer (the owner's done), never read as a do's call.
            crate::outcome::stamp(a.tool, &mut r);
            answered(&a, r);
            drop(behind);
        });
    }

    /// The work's answer, had without running it (one kept elsewhere).
    pub(crate) fn finish(mut self, r: Result<Value, crate::outcome::Failed>) {
        answered(&self.ask, r);
        self.behind.take();
    }
}

impl Drop for Starter {
    fn drop(&mut self) {
        if self.behind.take().is_some() {
            answered(&self.ask, Err(crate::outcome::Failed::from((axum::http::StatusCode::INTERNAL_SERVER_ERROR, "the work was never started".to_string()))));
        }
    }
}

/// The work of `ask` ended with `r`: kept for it, and heard by every ask that waits on it. Work ended at its wall says
/// so, its own words kept.
fn answered(ask: &Arc<Ask>, mut r: Result<Value, crate::outcome::Failed>) {
    if ask.walled() {
        if let Err(f) = &mut r {
            let said = crate::outcome::Said::new(crate::outcome::Outcome::BudgetSpent, "param.ask.wall");
            *f = crate::outcome::Failed::new(axum::http::StatusCode::GATEWAY_TIMEOUT, format!("the work went on {} s behind its reply and was ended there: {}", ask.wall.locked().as_secs(), f.error), said);
        }
    }
    let mut doing = DOING.locked();
    if let Some(d) = doing.iter_mut().find(|d| Arc::ptr_eq(&d.ask, ask)) {
        d.ended = Some(std::time::Instant::now());
        d.done.send_replace(Some(r));
    }
}

/// The answer of enlisted work, waited for as long as it takes, and said to have been had: the work of a batch's page
/// hears it this way, and hands it on in the batch's reply.
pub(crate) async fn heard(ask: &Arc<Ask>, mut done: tokio::sync::watch::Receiver<Option<Result<Value, crate::outcome::Failed>>>) -> Result<Value, crate::outcome::Failed> {
    let r = done.wait_for(Option::is_some).await.ok().and_then(|r| r.clone());
    let r = r.unwrap_or_else(|| Err(crate::outcome::Failed::from((axum::http::StatusCode::INTERNAL_SERVER_ERROR, "the work ended with no answer".to_string()))));
    if let Some(d) = DOING.locked().iter_mut().find(|d| Arc::ptr_eq(&d.ask, ask)) {
        d.had = true;
    }
    r
}

/// The words the callers of the ask `id` of `agent` asked with, while its answer is kept: none for another agent's ask.
pub(crate) fn words_of(agent: &str, id: &str) -> Vec<String> {
    DOING.locked().iter().find(|d| d.ask.id == id && d.agent == agent).map(|d| d.ask.words()).unwrap_or_default()
}

/// The answer kept for the ask `id` of `agent`, waited for within `wait` while its work goes on.
pub(crate) async fn collect(agent: &str, id: &str, wait: std::time::Duration) -> Result<Value, crate::outcome::Failed> {
    forget_kept(std::time::Instant::now());
    let found = DOING.locked().iter().find(|d| d.ask.id == id && d.agent == agent).map(|d| (d.ask.clone(), d.done.subscribe()));
    match found {
        Some((ask, done)) => waited(ask, done, wait).await,
        None => Err(crate::outcome::Failed::new(
            axum::http::StatusCode::NOT_FOUND,
            format!("no answer is kept for ask {id}: one is kept {} minutes after its work ends, for the agent that asked", KEPT.as_secs() / 60),
            crate::outcome::Said::new(crate::outcome::Outcome::BadRequest, "ask"),
        )),
    }
}

/// The work's answer once there is one, or still working when `wait` runs out or the work hurries its caller.
async fn waited(ask: Arc<Ask>, mut done: tokio::sync::watch::Receiver<Option<Result<Value, crate::outcome::Failed>>>, wait: std::time::Duration) -> Result<Value, crate::outcome::Failed> {
    let mut hurry = ask.hurry.subscribe();
    let from = tokio::select! {
        r = done.wait_for(Option::is_some) => {
            let r = r.ok().and_then(|r| r.clone());
            if let Some(r) = r {
                if let Some(d) = DOING.locked().iter_mut().find(|d| Arc::ptr_eq(&d.ask, &ask)) {
                    d.had = true;
                }
                let mut r = r;
                put(&ask.id, &mut r);
                return r;
            }
            "ask.wait"
        }
        _ = tokio::time::sleep(wait) => "ask.wait",
        h = hurry.wait_for(Option::is_some) => h.ok().and_then(|h| *h).unwrap_or("ask.wait"),
    };
    Ok(still_working(&ask, from))
}

/// The reply of an ask whose work goes on: its ask, what the work is doing, and the call that collects its answer.
fn still_working(ask: &Ask, from: &'static str) -> Value {
    // A batch's work: the pages answered so far, and the ones still pending, each with its own ask.
    if let Some(mut reply) = ask.so_far.locked().clone() {
        let pending = reply["pending"].as_array().map_or(0, Vec::len);
        reply["ask"] = json!(ask.id);
        reply["note"] = json!(format!("The node is still working on {pending} of these pages (in pending) and goes on after this reply. Call unbrowse_do with ask (as in next) to collect the whole batch, or with a pending page's own ask to collect that page alone: each waits for the work again, and the answer is kept {} minutes after the work ends.", KEPT.as_secs() / 60));
        let from = if from == "ask.wait" { "pages.pending" } else { from };
        crate::outcome::Said::new(crate::outcome::Outcome::StillWorking, from).then("unbrowse_do", json!({ "ask": ask.id })).put(&mut reply);
        return reply;
    }
    let phase = *ask.phase.locked();
    let mut reply = json!({ "how": "working", "ask": ask.id, "phase": phase,
        "note": format!("The node is still working on this ask ({phase}) and goes on after this reply. Call unbrowse_do with ask (as in next) to collect its answer: it waits for the work again, and the answer is kept {} minutes after the work ends.", KEPT.as_secs() / 60) });
    crate::outcome::Said::new(crate::outcome::Outcome::StillWorking, from).then("unbrowse_do", json!({ "ask": ask.id })).put(&mut reply);
    reply
}

/// What a reply came to, as its log line says it.
pub(crate) fn outcome_word(r: &Result<Value, crate::outcome::Failed>) -> Option<String> {
    match r {
        Ok(v) => v.get("outcome").and_then(Value::as_str).map(String::from),
        Err(f) => f.said.as_ref().map(|s| s.outcome.word().to_string()),
    }
}

/// Says an ask replied when dropped before it did (its request dropped unanswered): its reply is `stopped`.
pub(crate) struct Replying(pub(crate) Arc<Ask>);

impl Drop for Replying {
    fn drop(&mut self) {
        self.0.replied(Some(crate::outcome::Outcome::Stopped.word()));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The lines of `asks.jsonl` in `home` for the ask `id`, by event.
    pub(crate) fn events(home: &std::path::Path, id: &str) -> Vec<Value> {
        std::fs::read_to_string(home.join("asks.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["ask"] == id)
            .collect()
    }

    /// The run that exposed it: a caller hung up on its ask at 5 s, the walk stopped, and the next caller with the same
    /// arguments was handed "stopped: whoever waited on this walk gave up on it" under the first one's ask, in 2 ms. An
    /// ask whose stop flag is set is never joined; the new caller's ask starts its own work.
    #[test]
    fn a_new_caller_never_joins_an_ask_whose_caller_gave_up() {
        let home = crate::store::scratch_home("asks-gave-up");
        crate::store::use_home(&home);
        let key = "do|https://shop.example/items|list the items".to_string();
        let first = enlist("agent-a", key.clone(), || Ask::begin("unbrowse_do"));
        assert!(first.starter.is_some());
        let joined = enlist("agent-a", key.clone(), || Ask::begin("unbrowse_do"));
        assert_eq!(joined.ask.id, first.ask.id, "a running ask is joined");
        assert!(joined.starter.is_none());
        first.ask.stop.store(true, Ordering::Relaxed);
        let fresh = enlist("agent-a", key, || Ask::begin("unbrowse_do"));
        assert_ne!(fresh.ask.id, first.ask.id, "the given-up ask is not handed on");
        assert!(fresh.starter.is_some(), "the new caller's work starts");
    }

    /// The run that exposed it: a batch asked Amazon for "b550m" and its answer, collected later by its ask, came back
    /// with the search word as `{session}`. An ask keeps the words its caller asked with, a batch's page takes the
    /// batch's, and an answer collected by its ask is spared them; another agent's ask gives none.
    #[test]
    fn an_answer_collected_later_keeps_the_words_its_caller_asked_with() {
        let home = crate::store::scratch_home("asks-words");
        crate::store::use_home(&home);
        let batch = enlist("agent-a", "do|pages|b550m".to_string(), || Ask::begin("unbrowse_do"));
        batch.ask.hear(&["https://www.amazon.sg/s?k=b550m".to_string(), "b550m".to_string()]);
        let page = enlist("agent-a", "do|https://www.amazon.sg/s?k=b550m|boards".to_string(), || Ask::begin("unbrowse_do"));
        batch.ask.adopt(page.ask.clone());
        for id in [&batch.ask.id, &page.ask.id] {
            assert!(words_of("agent-a", id).contains(&"b550m".to_string()), "{id}");
            assert!(words_of("agent-b", id).is_empty(), "another agent's ask gives none: {id}");
        }
    }

    /// The run that exposed it: two asks of one page at once wrote their lines into each other, a character at a time,
    /// and neither reader could parse them. Asks written side by side leave every line whole.
    #[test]
    fn asks_side_by_side_leave_every_line_whole() {
        let home = crate::store::scratch_home("asks-side-by-side");
        crate::store::use_home(&home);
        let asks: Vec<Arc<Ask>> = (0..8).map(|_| Ask::begin("unbrowse_do")).collect();
        let threads: Vec<_> = asks
            .iter()
            .cloned()
            .map(|ask| std::thread::spawn(move || (0..100).for_each(|n| ask.write(json!({ "event": "behind", "work": "a second look", "n": n, "pad": "x".repeat(300) })))))
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        let log = std::fs::read_to_string(home.join("asks.jsonl")).unwrap();
        assert_eq!(log.lines().count(), 8 * 101);
        assert!(log.lines().all(|l| serde_json::from_str::<Value>(l).is_ok()), "a line was written into another");
    }

    /// An ask's work that goes on after its reply is said as behind it, and the ask ends only when that work does:
    /// `started`, `reply` with its outcome, `behind` naming the work, then `ended`, each line naming the ask and
    /// nothing of what was asked. The work ran under the ask's stop flag.
    #[test]
    fn an_asks_own_work_behind_its_reply_says_when_it_ended() {
        let home = crate::store::scratch_home("asks-behind");
        crate::store::use_home(&home);
        let ask = Ask::begin("unbrowse_do");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (go, wait) = std::sync::mpsc::channel::<()>();
        let stop_seen = Arc::new(Mutex::new(None));
        let seen = stop_seen.clone();
        let work = rt.block_on(within(ask.clone(), async move {
            spawn_behind("second_look", move || {
                *seen.locked() = Some(unbrowse_learn::mint::stop_flag().is_some());
                let _ = wait.recv();
            })
        }));
        ask.replied(Some("answered"));
        let names = |evs: &[Value]| evs.iter().map(|e| e["event"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>();
        let so_far = events(&home, &ask.id);
        assert_eq!(names(&so_far), ["started", "reply", "behind"], "{so_far:?}");
        assert_eq!(so_far[1]["outcome"], "answered");
        assert_eq!(so_far[2]["work"], json!(["second_look"]));
        assert!(!ask.has_ended(), "its work goes on");
        go.send(()).unwrap();
        work.join().unwrap();
        let all = events(&home, &ask.id);
        assert_eq!(names(&all), ["started", "reply", "behind", "ended"], "{all:?}");
        assert_eq!(all[3]["stopped"], false);
        assert!(all.iter().all(|e| e["ms"].is_u64() && e["at"].is_u64()));
        assert_eq!(*stop_seen.locked(), Some(true), "the work's walks end on the ask's stop flag");
        assert!(ask.has_ended() && by_stop(&ask.stop).is_none());

        // With nothing behind it, an ask ends as it replies; one dropped before it replied says it stopped.
        let quick = Ask::begin("unbrowse_call");
        quick.replied(Some("call_failed"));
        assert_eq!(names(&events(&home, &quick.id)), ["started", "reply", "ended"]);
        let dropped = Ask::begin("unbrowse_do");
        drop(Replying(dropped.clone()));
        assert_eq!(events(&home, &dropped.id)[1]["outcome"], "stopped");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Work that hurries its caller (`Ask::hurry`) is answered still working at once, from where it said so, whatever
    /// the wait its caller gave; the work goes on.
    #[test]
    fn work_that_hurries_its_caller_is_answered_still_working_from_where_it_said_so() {
        let home = crate::store::scratch_home("asks-hurry");
        crate::store::use_home(&home);
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let t = std::time::Instant::now();
        let r = rt
            .block_on(answer_within("agent-hurry", "key-hurry".into(), std::time::Duration::from_secs(30), || async {
                current().expect("the work is its ask's").hurry("ask.profile");
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                Ok(json!({ "how": "called" }))
            }))
            .unwrap();
        assert!(t.elapsed() < std::time::Duration::from_secs(10), "{:?}", t.elapsed());
        assert_eq!((r["how"].as_str(), r["outcome"].as_str(), r["outcome_from"].as_str()), (Some("working"), Some("still_working"), Some("ask.profile")), "{r}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Work that ends by a wait of its own, longer than a client waits (the owner's answer to `ask_owner`), is answered
    /// still working within its caller's wait and goes on behind the reply past the wall other work meets, its stop
    /// flag unset, until its ask collects what it came to, though it learned its own wait only after the reply went.
    /// The same work not given its own wait is stopped at the wall.
    #[test]
    fn work_given_its_own_wait_goes_on_past_the_wall_and_is_collected() {
        let home = crate::store::scratch_home("asks-own-wait");
        crate::store::use_home(&home);
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let run = |agent: &'static str, own: Option<std::time::Duration>| {
            rt.block_on(async move {
                let ask = Ask::begin("unbrowse_browse");
                let r = within(ask.clone(), answer_within(agent, "ask_owner|shop.example|s".into(), std::time::Duration::from_millis(200), move || async move {
                    let me = current().expect("the work is its ask's");
                    if let Some(own) = own {
                        // Learned after the reply went (its caller waited 200 ms), as `ask_owner` learns it once the
                        // browser is ready: the wall already running is held to it.
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        me.goes_on_for(own);
                    }
                    // As the owner's wait does (`hands::waits_on_owner`): it ends early, unanswered, on its stop flag.
                    for _ in 0..20 {
                        if me.stop.load(Ordering::Relaxed) {
                            return Ok(json!({ "owner": "no_answer" }));
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    Ok(json!({ "owner": "done" }))
                }))
                .await
                .unwrap();
                ask.replied(Some("still_working"));
                assert_eq!((r["outcome"].as_str(), r["next"]["tool"].as_str()), (Some("still_working"), Some("unbrowse_do")), "{r}");
                collect(agent, r["ask"].as_str().unwrap(), std::time::Duration::from_secs(60)).await.unwrap()
            })
        };
        let own = run("agent-own-wait", Some(std::time::Duration::from_secs(60)));
        assert_eq!(own["owner"], "done", "its own wait outlasts the wall: {own}");
        // Collected by unbrowse_do's ask, it is still the browse tool's answer: the owner did it.
        assert_eq!((own["outcome"].as_str(), own["outcome_from"].as_str()), (Some("answered"), Some("owner")), "{own}");
        assert_eq!(run("agent-walled", None)["owner"], "no_answer", "work not given its own wait meets the wall ({} ms here)", WALL.as_millis());
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// An answer kept elsewhere and had without running anything (`Starter::finish`) is the answer of every ask that
    /// joined it and of the one that collects it, and only for the agent that asked; and work started outside any ask is
    /// a thread like any other.
    #[test]
    fn an_answer_kept_elsewhere_is_the_answer_of_every_ask_that_joined_it() {
        let home = crate::store::scratch_home("asks-finish");
        crate::store::use_home(&home);
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let kept = enlist("agent-kept", "key-kept".into(), || Ask::begin("unbrowse_do"));
        let (id, joined) = (kept.ask.id.clone(), enlist("agent-kept", "key-kept".into(), || Ask::begin("unbrowse_do")));
        assert_eq!(joined.ask.id, id, "the work is joined");
        kept.starter.expect("this caller made the work").finish(Ok(json!({ "how": "called", "result": { "ok": true } })));
        let answer = rt.block_on(waited(joined.ask.clone(), joined.done.clone(), std::time::Duration::from_secs(5))).unwrap();
        assert_eq!((answer["how"].as_str(), answer["ask"].as_str()), (Some("called"), Some(id.as_str())), "{answer}");
        let collected = rt.block_on(collect("agent-kept", &id, std::time::Duration::from_secs(5))).unwrap();
        assert_eq!(collected["result"], answer["result"]);
        assert_eq!(rt.block_on(collect("another-agent", &id, std::time::Duration::from_millis(10))).unwrap_err().status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(spawn_behind("no_ask", || 41 + 1).join().unwrap(), 42);
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }
}
