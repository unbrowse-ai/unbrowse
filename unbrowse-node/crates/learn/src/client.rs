//! The calling harness: a learned route plus the machinery to call it, with the
//! browser only where a site insists.
//!
//! Everything per-site is data — the [`Graph`] and the session store. The
//! mechanisms are general:
//!
//! - every step is plain HTTP first;
//! - a step the site walls (403) is re-run in the node's browser, whose cookies
//!   refresh the session store;
//! - browser-minted values (`Class::Minted`, cookies and session header tokens)
//!   come from the store, so a minted session carries across calls;
//! - the jar's cookies go where the browser that earned them sent them: to the
//!   session's own host whole, and down the site as far as each cookie's
//!   recorded `Domain` reaches, so the clearance a walk earned carries every
//!   step of the chain and the browser stays shut.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde_json::Value;

use crate::graph::{Class, Graph};
use crate::ledger::{route_writes, Ledger, Retry};
use crate::mint::BrowserMint;
use crate::replay::{replay_ledgered, Fetch, HttpFetch, ReplayError, Request, Within};
use crate::trace::Exchange;
use crate::slots::Loc;

/// A learned route plus the machinery to call it.
pub struct RouteClient {
    graph: Graph,
    /// Where minted session values persist, one file per site: `<dir>/<host>.json`.
    store: Option<PathBuf>,
    /// The node's browser, used for steps a site walls. None: plain only.
    browser: Option<BrowserMint>,
    /// Loaded minted values, by name (cookie or header).
    jar: HashMap<String, String>,
    /// The jar as this client last read or wrote it, None when there was no file: what a save measures its changes
    /// against, so it writes what this client changed and not everything it remembers.
    loaded: Option<HashMap<String, String>>,
    /// How far each of the jar's cookies goes: the `Domain` the walk, the site's own answers or an import set it
    /// for, kept beside the jar in its own file (`scope_path`) so a call can send a cookie where the browser that
    /// earned it would — down the site, never off it. A name with no entry is a host-only cookie: the jar's own
    /// host and nowhere else, as the jar alone would have it.
    jar_domains: HashMap<String, String>,
    /// The scope file as this client last read it, for the same measure at a save as [`RouteClient::loaded`].
    loaded_scope: Option<HashMap<String, String>>,
    /// Cookies read from the site's other hosts' jars (`take_in_the_sites_other_jars`), by the value read: sent as
    /// this jar's, never written into its file unless a call changed them.
    borrowed: HashMap<String, String>,
    /// Each cookie's path, expiry and place in the jar's order: what a browser uses to order the cookies it sends,
    /// kept beside the jar in its own file (`meta_path`).
    cookie_meta: HashMap<String, CookieMeta>,
    /// The metadata file as this client last read or wrote it, for the same measure at a save as the jar's.
    loaded_meta: Option<HashMap<String, CookieMeta>>,
    /// What the page had in front of it when the route was learned: its `localStorage` and `sessionStorage`, kept
    /// beside the jar (`storage_path`). A signing bridge boots the page's own scripts with this, or a bundle that
    /// keeps its key or a nonce there signs for a page it never saw.
    storage: crate::sandbox::Storage,
    /// What the page's own code saw when it fingerprinted the browser (canvas, WebGL, screen, navigator, timezone),
    /// kept beside the jar (`fingerprint_path`): a producer that samples the environment gets the same sample back.
    fingerprint: serde_json::Value,
    /// Whether a route this node didn't learn itself may open its browser to mint its own session: the owner's
    /// setting, off unless they turn it on. With it off, a shared route runs browserless only.
    shared_mint: bool,
    /// A browser was opened for this call: a heal, a walled step or a signing page. The caller logs it when the route
    /// was someone else's.
    used_browser: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// What the calls made on this client cost (`learn.rung`): the rung of each step of the run that answered, and the
    /// highest rung anything done for them reached.
    made: crate::rung::Made,
    /// What the call fell back on, and why, in the order it happened: the sandbox skipped, a step the browser ran, the
    /// page walked again. A fallback that still answers is otherwise silent, and a route that only ever answers through
    /// one looks healthy. The caller hands these back with the answer.
    fell_back: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    /// Why the sandbox ran no page's code for this call, where that is why it was skipped (`sandbox::unheld`): the
    /// reader's own answer, for a reply to name, never its words to parse.
    unheld: std::sync::Arc<std::sync::Mutex<Option<crate::sandbox::Unheld>>>,
    /// Chrome-shaped transport for the plain side of every call.
    chrome: bool,
    /// The page where the flow starts. When a call fails because the site has
    /// drifted, the browser walks this root again, the chain is recomputed
    /// from the fresh sighting, and the call is retried: a route works across
    /// time by tracing back to the root, not by going stale.
    root: Option<String>,
    /// The target's method and a distinctive path fragment, so the recomputed
    /// chain can find it in the fresh trace.
    target: Option<(String, String)>,
    /// Whether the route writes: a read may be healed and retried, a write only when it sent nothing.
    writes: bool,
    /// Someone saw a call of the route change the site, whatever the rule reads of its requests ([`Ledger::of_route`]).
    judged_write: bool,
    /// Whose rule every request of the call is held to: whose route this is.
    egress: crate::egress::Egress,
    /// The hosts the owner keeps the node off: a heal whose fresh chain reaches one is refused.
    excluded: Vec<String>,
    /// The chain a heal found and a retry proved, for the caller to keep as the route.
    healed: Option<Graph>,
    /// The browser already running to walk in, and where pictures of a walk go, kept here so the order the builder's
    /// calls come in doesn't matter: `with_browser` takes them up whenever it comes.
    cdp: Option<String>,
    frames: Option<agent_browser_core::screencast::FrameSink>,
    /// Signs the site in again in its browser, handing back the session that earned: tried before a re-walk when an
    /// answer says the session is gone, since a walk signed out can only learn the signed-out page.
    sign_in: Option<SignIn>,
    /// Signs the site in again by the sign-in's own request, with no browser, handing back the session that earned
    /// (`with_plain_sign_in`): tried as soon as an answer says the session is gone, before anything that opens a browser.
    plain_sign_in: Option<SignIn>,
    /// What the node around this client can do against a wall that the client can't do itself: take in the owner's own
    /// browser session, ask a solver, ask the owner (`with_clearer`). Each is tried where the wall's own list names
    /// it (`refusal::Wall::sources`), in that list's order.
    clearers: Vec<(crate::refusal::Source, Clearer)>,
    /// The profile a route that came from another node walks in, when the owner lets it open the browser: made for this
    /// client alone, empty, and removed with it. Never the site's own profile, where the owner is signed in.
    scratch_profile: Option<ScratchProfile>,
    /// The owner said yes to this call's write carrying what an earlier step read under their session, for a route
    /// that came from another node (`with_session_reads_in_writes`).
    session_reads_approved: bool,
    /// The owner has allowed this route, a route that came from another node, to act in their session on its site
    /// (`with_owner_consent`), as the graph it was shown. Without it such a route runs with nothing of the owner's session.
    owner_consent: Option<Consent>,
    /// Inputs whose values the owner's vault filled in (a login, a card), and the one site they may go to
    /// (`with_held_inputs`): checked on every graph the call sends, a healed one included.
    held: Option<(Vec<String>, String)>,
    /// The wire a test's call goes over, in place of the node's: a fake site.
    #[cfg(test)]
    wire: Option<fn() -> Box<dyn Fetch>>,
    /// The body the route was learned as by example, run in the graph's place (`with_body`): each step's request is
    /// the body's, and the graph keeps what the node keeps beside a body. Let go when a heal rebuilds the graph from
    /// another walk.
    body: Option<unbrowse_route::Route>,
    /// The last run was the body's.
    ran_body: bool,
    /// Where the site drifted, the call is not healed in place: the route is learned again from its plan, as a new
    /// route, by whoever called (`learning_again`).
    learn_again: bool,
    /// What the site answered that says it drifted, where a call learning again stopped for it.
    drifted: Option<String>,
    /// A failed call is not mended by anything of the node's own: no session fetched again, no sign-in, no walk and no
    /// retry (`holding_the_heal`).
    heal_held: bool,
}

impl RouteClient {
    pub fn new(mut graph: Graph) -> Self {
        // A graph read without its page's code (a listing's) runs with it: the signing bridge boots on it.
        graph.rejoined();
        let writes = route_writes(&graph);
        // A step made from someone else's body says so: such a route is held to their rule unless a caller says otherwise.
        let egress = if graph.steps.iter().any(|s| s.foreign) { crate::egress::Egress::Foreign } else { Default::default() };
        Self { cdp: None, frames: None, sign_in: None, plain_sign_in: None, clearers: Vec::new(), body: None, ran_body: false, graph, store: None, browser: None, jar: HashMap::new(), loaded: None, jar_domains: HashMap::new(), loaded_scope: None, borrowed: HashMap::new(), cookie_meta: HashMap::new(), loaded_meta: None, storage: Default::default(), fingerprint: serde_json::Value::Null, shared_mint: false, used_browser: Default::default(), made: Default::default(), fell_back: Default::default(), unheld: Default::default(), chrome: false, root: None, target: None, writes, judged_write: false, egress, excluded: Vec::new(), healed: None, scratch_profile: None, session_reads_approved: false, owner_consent: None, held: None, learn_again: false, drifted: None, heal_held: false, #[cfg(test)] wire: None }
    }

    /// A call that, where the site drifted (`a_drift`), does not heal the route in place: no browser re-walks the
    /// root and no chain is rebuilt. The call fails and says what drifted (`drifted`), for the caller to learn the
    /// route again from its plan as a new route. Every other failure is met as it is without this: a session renewed,
    /// a sign-in, a door's credential earned, and a wall, a transport or a site out of asks reported as they are.
    pub fn learning_again(mut self) -> Self {
        self.learn_again = true;
        self
    }

    /// A call that, failed, is not mended by anything the node does of its own: the route's page is not fetched again
    /// for a fresh session, no one is signed in, no door's credential is earned, no browser walks the root and the
    /// call is not made again. The call fails as it failed, said as the site said it, for whoever called to take on
    /// (an A/B's arm that holds the node's own asks, `UNBROWSE_NO_HEAL` on the node). One line says so on the log
    /// where a heal would have begun: `   [own-ask] held: heal at RouteClient::call_with_ledger`.
    pub fn holding_the_heal(mut self) -> Self {
        self.heal_held = true;
        self
    }

    /// What the site answered that says it drifted, where a call learning again stopped for it (`learning_again`).
    pub fn drifted(&self) -> Option<&str> {
        self.drifted.as_deref()
    }

    /// Runs the body the route was learned as (`stored`) where it says what the graph cannot: the graph as it stands,
    /// said as a body, with the stored body's holes a graph cannot say laid over it (`body::overlay`), so every pass
    /// the node made on the graph after the learn is in what runs. Each step's request is that body's
    /// (`replay::replay_body_ledgered`), and the run reads everything else off its skeleton with the graph's page
    /// context on it (`body::skeleton_beside`). The session store, a heal, the door, a sign-in and the browser read
    /// the graph as they do without a body. One `[call]` line says what of the stored body had nowhere to go; where
    /// nothing of it is left that the graph cannot say, or the body is one this build will not run, the graph runs.
    pub fn with_body(mut self, stored: unbrowse_route::Route) -> Self {
        let laid = crate::body::overlay(&self.graph, Some(&stored));
        let body = laid.body;
        // The site's own code unpacks the reply: the body holds the decoder a graph cannot, so it runs even when its
        // request holes are all the graph can say (`body::overlay` carried the decoder onto it).
        let unrun = if laid.laid.is_empty() && body.answer.decode.is_none() {
            Some("nothing is left of it that the graph cannot say".to_string())
        } else {
            body.refused().or_else(|| (body.steps.last().map(|s| s.id.as_str()) != Some(body.answer.step.as_str())).then(|| format!("its answer {} is not its last step", body.answer.step)))
        };
        let dropped = if laid.dropped.is_empty() { String::new() } else { format!("; dropped from it: {}", laid.dropped.join("; ")) };
        match unrun {
            // A body a graph says lays nothing: the graph runs, as it does for every such route, and there is nothing
            // to say.
            Some(_) if laid.laid.is_empty() && laid.dropped.is_empty() => {}
            Some(why) => eprintln!("   [call] the route's body is not run, so its graph is: {why}{dropped}"),
            None => {
                if !dropped.is_empty() {
                    eprintln!("   [call] the route's body runs with {} of its holes laid over the graph{dropped}", laid.laid.len());
                }
                self.body = Some(body);
            }
        }
        self
    }

    /// Whether the last run of this client was the body's (`with_body`), and not the graph's.
    pub fn ran_body(&self) -> bool {
        self.ran_body
    }

    /// Holds the route to the write rules when someone saw a call of it change the site (an agent's judgement, R1.25),
    /// though the rule reads its requests as reads: its target is a commit, never sent twice by a retry or a heal.
    pub fn with_judged_write(mut self, judged: bool) -> Self {
        self.judged_write = judged;
        self.writes |= judged;
        self
    }

    /// Holds every request the call makes to `egress`: its steps, their redirects and the addresses they resolve to.
    /// A route this node didn't learn itself (`Egress::Foreign`) never runs in the browser, neither a walled step nor
    /// a heal's re-walk: the browser connects by itself, where no per-call rule is checked, and a re-walk would walk
    /// a page someone else named. Such a route that fails is let go and fetched afresh instead.
    pub fn with_egress(mut self, egress: crate::egress::Egress) -> Self {
        self.egress = egress;
        if egress == crate::egress::Egress::Foreign {
            self.browser = None;
            self.cdp = None;
        }
        self
    }

    /// The owner's yes, for this call, to a route that came from another node sending in a write what an earlier step
    /// of it read under the owner's session. Without it such a write is refused before it is sent.
    pub fn with_session_reads_in_writes(mut self, approved: bool) -> Self {
        self.session_reads_approved = approved;
        self
    }

    /// The owner's yes to this route, one that came from another node, acting in their session on its site: only then
    /// does a call of it send the owner's cookies and session tokens. A request's method says nothing about what it
    /// does to the account (a sign-out, an unsubscribe and a "mark as read" are all GETs), so without that yes the route
    /// runs with none of the owner's session at all: no cookie, no token, no page storage of theirs. The node's own
    /// route always runs in the owner's session.
    ///
    /// The yes is for the route the owner was shown: `body`, the content identifier of the body it came from, and
    /// `digest`, [`consent_digest`] of that body and the graph they were asked about. It is checked against the graph
    /// each request is actually sent from, at the moment it is sent ([`RouteClient::owner_material_for`]): a graph a
    /// heal rebuilt, or any other the call comes to run, is not the one consented to, and runs with none of the owner's
    /// session.
    pub fn with_owner_consent(mut self, body: &str, digest: &str) -> Self {
        self.owner_consent = Some(Consent { body: body.to_string(), digest: digest.to_string() });
        self
    }

    /// Whether a request sent from `graph`, for a route that came from another node, may carry the owner's session
    /// (their cookies and tokens, the page storage of theirs, what the site sets during the call): only when the graph
    /// the client holds is the one the owner consented to, measured here from its own bytes ([`consent_digest`]), and
    /// `graph` is that graph or its target alone (the fast path, a part of what was shown). Everything else is refused
    /// by default: a heal's rebuilt chain, a graph built any other way. The node's own route always may.
    fn owner_material_for(&self, graph: &Graph) -> bool {
        if self.egress == crate::egress::Egress::Own {
            return true;
        }
        let Some(c) = &self.owner_consent else { return false };
        if consent_digest(&c.body, &self.graph) != c.digest {
            return false;
        }
        let same = |a: &Graph, b: &Graph| serde_json::to_value(a).ok() == serde_json::to_value(b).ok();
        if same(graph, &self.graph) {
            return true;
        }
        let mut target = self.graph.clone();
        let last = target.steps.pop();
        target.steps = last.into_iter().collect();
        same(graph, &target)
    }

    /// Holds `inputs`, whose values the owner's vault filled in, to `site`: whatever graph the call sends (the route's
    /// own, its target alone, or the chain a heal rebuilt from a fresh walk), a step that carries one of them goes over
    /// an encrypted connection to a host on `site`, or nothing of that graph is sent. The caller checked the route
    /// before it filled the values; a heal makes a new graph after that check, so the check is made again here, on the
    /// graph at the point its values are put in.
    pub fn with_held_inputs(mut self, inputs: Vec<String>, site: &str) -> Self {
        self.held = (!inputs.is_empty()).then(|| (inputs, crate::identity::site_of(site)));
        self
    }

    /// Holds a heal to the hosts the owner excluded: the route was checked before the call, the chain a heal finds
    /// is new, and it never takes the owner's session where they said not to.
    pub fn with_excluded(mut self, excluded: Vec<String>) -> Self {
        self.excluded = excluded;
        self
    }

    /// Teaches the client where the flow starts: on a failed call, the browser
    /// walks `root` once more, the graph is rebuilt from that sighting (root to
    /// `target_path`), and the call is retried with the recomputed chain.
    pub fn with_root(mut self, root: &str, target_method: &str, target_path: &str) -> Self {
        self.root = Some(root.to_string());
        self.walk_in_the_roots_profile();
        self.target = Some((target_method.to_string(), target_path.to_string()));
        self
    }

    /// The heal walks the root, so it walks in the root's own profile, the one the route was learned in: a page of one
    /// site never runs in a profile kept for another. The profile is the node's own (`UNBROWSE_HOME/profiles/<host>`,
    /// the folder a walk opens): a home under another name (`$HOME/.unbrowse`) is the owner's node's, and a scratch
    /// node that healed there would read and write the owner's profile for the site.
    ///
    /// A route that came from another node never walks there: the site's profile is where the owner is signed in, and
    /// its root is a page someone else named. It walks in a profile of its own, empty and thrown away with the client
    /// ([`RouteClient::scratch_profile`]).
    fn walk_in_the_roots_profile(&mut self) {
        let host = self.root.as_deref().and_then(|r| url::Url::parse(r).ok()).and_then(|u| u.host_str().map(String::from));
        let scratch = self.scratch_profile.as_ref().map(|p| p.0.clone());
        if let (Some(b), Some(host)) = (self.browser.as_mut(), host) {
            b.profile = Some(match scratch {
                Some(dir) => dir.to_string_lossy().into_owned(),
                None => unbrowse_files::private::home().join("profiles").join(&host).to_string_lossy().into_owned(),
            });
            b._host = host;
        }
    }

    /// A profile for this client alone, in the node's own folder (its owner's alone, 0700), empty: where a route that
    /// came from another node walks. None when it can't be made, and then no browser opens for the route.
    fn fresh_profile(own: &str) -> Option<ScratchProfile> {
        let dir = unbrowse_files::private::home().join("scratch-profiles").join(own);
        let _ = std::fs::remove_dir_all(&dir);
        unbrowse_files::private::dir_at(&dir).ok()?;
        Some(ScratchProfile(dir))
    }

    /// Persists minted session values under `dir`, one JSON file per host, loaded
    /// before each call and saved after it: a minted session carries across calls.
    /// Chrome-shaped transport: the wire speaks as a browser does while the
    /// client stays itself. For walls that judge the transport before any
    /// challenge runs.
    pub fn with_chrome_transport(mut self) -> Self {
        self.chrome = true;
        self
    }

    /// How to sign the site in again. A route this node didn't learn itself never takes one: it never runs in the
    /// browser, and the owner's login is never spent on someone else's route.
    pub fn with_sign_in(mut self, sign_in: Option<SignIn>) -> Self {
        self.sign_in = sign_in.filter(|_| self.egress == crate::egress::Egress::Own);
        self
    }

    /// How to sign the site in again with no browser: the sign-in's own request, as the node kept it from the walk
    /// that signed in. Held to routes this node learned itself, as `with_sign_in` is.
    pub fn with_plain_sign_in(mut self, sign_in: Option<SignIn>) -> Self {
        self.plain_sign_in = sign_in.filter(|_| self.egress == crate::egress::Egress::Own);
        self
    }

    /// A way to clear a wall that the node around this client has (`refusal::Source`): the owner's own browser
    /// session, a solver, the owner. Only for the node's own routes: a route that came from another node is cleared
    /// by nothing of the owner's.
    pub fn with_clearer(mut self, source: crate::refusal::Source, clearer: Clearer) -> Self {
        if self.egress == crate::egress::Egress::Own {
            self.clearers.push((source, clearer));
        }
        self
    }

    /// The client this call looks like to a site (`refusal::identity_of`): the browser it presents as and the
    /// address it leaves from. A pass earned in this call is this client's.
    fn identity(&self) -> String {
        crate::refusal::identity_of(&self.fingerprint, &self.local_proxy().unwrap_or_else(|| "direct".into()))
    }

    /// The node's engine walks the route's page once, and what the walk earned joins the call's session: its cookies
    /// the jar (each with what the browser said of it), what the page kept for its own code the storages, and the
    /// browser it presented as the fingerprint the call's wire is shaped to from now on. The walk's trace is handed
    /// back for a caller that rebuilds the chain from it. None when there is no engine, when the page is not on the
    /// route's site (a route this node didn't learn mints only on its own site: its root is the contributor's URL,
    /// and a browser here is the owner's), or when the walk failed.
    fn sight_the_root(&mut self, root: &str, why: &str) -> Option<crate::trace::Trace> {
        if !self.on_the_routes_site(root) {
            eprintln!("   [heal] {root} is not on the route's site: a shared route mints nowhere else");
            return None;
        }
        let home = self.home().map(|(_, h)| h);
        let mint = self.browser.as_mut()?;
        self.used_browser.store(true, std::sync::atomic::Ordering::Relaxed);
        self.made.reach(crate::rung::Rung::Browser);
        said(&self.fell_back, why.to_string());
        let sighting = mint.sight(root);
        let _ = std::fs::remove_dir_all(&mint.capture_dir);
        let sighting = match sighting {
            Ok(s) => s,
            Err(e) => {
                eprintln!("   [heal] root sighting failed: {e}");
                return None;
            }
        };
        // The fresh walk's session values join the jar: the recomputed chain's Minted fields draw from the session
        // that just minted them. What the page kept for its own code joins the storages the signing bridge boots the
        // page's scripts with: the bridge now sees the page this walk saw, not the one the last walk did.
        if !sighting.session.local_storage.is_empty() || !sighting.session.session_storage.is_empty() {
            self.storage.local.extend(sighting.session.local_storage.clone());
            self.storage.session.extend(sighting.session.session_storage.clone());
            self.save_storage();
        }
        if let Some(fp) = sighting.session.fingerprint.clone().filter(|v| !v.is_null()) {
            self.fingerprint = fp;
            self.save_fingerprint();
        }
        let facts = sighting.session.facts.clone();
        let before = self.jar.clone();
        merge_sighting(&mut self.jar, home.as_deref(), root, sighting.session, &minted_tokens(&self.graph), &mut self.jar_domains);
        note_facts(&mut self.cookie_meta, &facts, &self.jar, &before);
        Some(sighting.trace)
    }

    /// Tries what may clear `wall`, in the wall's own order, until the chain answers. The site's page asked again and
    /// the door's page run in the sandbox are the client's own (`refresh_session` does both, once). The rest are the
    /// node's (`with_clearer`): what one hands back joins the jar as this client's pass, and the chain runs again. A
    /// source nobody gave is passed over. None when nothing cleared it; the answer and its ledger when something did,
    /// or when a retry may have written.
    fn clear(&mut self, wall: &crate::refusal::Wall, door: &crate::graph::Door, inputs: &HashMap<String, String>) -> Option<(Result<Value, ReplayError>, Ledger)> {
        use crate::refusal::Source;
        let mut asked_the_page = false;
        for source in wall.sources() {
            let cleared = match source {
                Source::Page | Source::Sandbox => {
                    if std::mem::replace(&mut asked_the_page, true) || !self.refresh_session() {
                        continue;
                    }
                    true
                }
                Source::Wait => false,
                // The node's own engine, unless the node gave another: the page is walked once, at most one walk of a
                // page at a time, and only for a pass the jar does not already hold alive. What the walk earned is the
                // engine's, and the call's wire is shaped to that engine from here on (`sight_the_root`).
                Source::Engine if !self.clearers.iter().any(|(s, _)| *s == Source::Engine) => {
                    // A door whose own page re-issues its pass never opens the engine: asking the page was the whole
                    // of what there was to do. Nor does one whose pass the jar still holds inside its life: the refusal
                    // is not about that pass, and the engine would earn the same one again.
                    if door.earn == crate::graph::Earn::Recompute || holds_the_credential(&self.jar, &self.cookie_meta, door) {
                        continue;
                    }
                    // The engine runs the page the wall stood at in the walk (`Door::at`), and the route's own page
                    // where the walk kept none.
                    let Some(root) = door.at.clone().or_else(|| self.root.clone()).filter(|_| self.browser.is_some()) else { continue };
                    let Some(_walking) = HealGuard::take(&root) else { continue };
                    let before = self.jar.clone();
                    if self.sight_the_root(&root, "the site's door stood in the way, so the node's engine ran the page for its pass").is_none() {
                        continue;
                    }
                    let me = self.identity();
                    let gained: Vec<String> = self.jar.iter().filter(|(k, v)| before.get(*k) != Some(*v)).map(|(k, _)| k.clone()).collect();
                    for k in &gained {
                        if let Some(meta) = self.cookie_meta.get_mut(k) {
                            meta.bound_to = Some(me.clone());
                        }
                    }
                    !gained.is_empty()
                }
                other => {
                    let Some((_, clearer)) = self.clearers.iter_mut().find(|(s, _)| s == other) else { continue };
                    match clearer(wall) {
                        Some(pass) if !pass.cookies.is_empty() => {
                            let (now, me) = (now_secs(), self.identity());
                            for (k, v) in pass.cookies {
                                let order = self.cookie_meta.values().map(|m| m.order).max().unwrap_or(0) + 1;
                                let meta = self.cookie_meta.entry(k.clone()).or_insert_with(|| CookieMeta { path: "/".into(), expires: None, order, http_only: None, bound_to: None });
                                meta.expires = pass.ttl.map(|ttl| now + ttl as f64);
                                meta.bound_to = Some(pass.bound_to.clone().unwrap_or_else(|| me.clone()));
                                self.jar.insert(k, v);
                            }
                            eprintln!("   [door] {wall:?}: cleared by {other:?}");
                            said(&self.fell_back, format!("the site's check was cleared by {}", said_source(*other)));
                            true
                        }
                        _ => false,
                    }
                }
            };
            if !cleared {
                continue;
            }
            let (again, ledger) = self.run(inputs);
            if again.is_ok() {
                self.save_jar();
                return Some((again, ledger));
            }
            if ledger.retry(self.writes) != Retry::AsIs {
                return Some((again, ledger));
            }
        }
        None
    }

    /// Takes in a session the browser earned since this client read its jar.
    pub fn absorb(&mut self, jar: HashMap<String, String>) {
        self.jar.extend(jar);
    }

    pub fn with_session_store(mut self, dir: impl Into<PathBuf>) -> Self {
        self.store = Some(dir.into());
        self.load_jar();
        self
    }

    /// The owner's allowance for a shared route: it may open this node's browser to mint its own session (its own
    /// credential, its own address). Off, a route this node didn't learn runs browserless, and one that needs a browser
    /// says so. The owner's login is never spent on such a route either way (`with_sign_in`).
    pub fn with_shared_mint(mut self, allow: bool) -> Self {
        self.shared_mint = allow;
        self
    }

    /// What this call fell back on and why, in order (`fell_back`). Empty for a call that ran as the route says.
    pub fn fell_back(&self) -> Vec<String> {
        self.fell_back.lock().map(|f| f.clone()).unwrap_or_default()
    }

    /// Why the sandbox ran no page's code for this call, when it was skipped for that (`sandbox::unheld`).
    pub fn unheld(&self) -> Option<crate::sandbox::Unheld> {
        self.unheld.lock().ok().and_then(|u| u.clone())
    }

    /// Whether a browser was opened for this call (a heal, a walled step or a signing page).
    pub fn used_browser(&self) -> bool {
        self.used_browser.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// What the call cost: the rung that made each step of the run that answered, and the highest rung anything done
    /// for the call reached (`learn.rung`). A walk to mend the route is the browser's work, though the steps that
    /// then answered were plain.
    pub fn made(&self) -> &crate::rung::Made {
        &self.made
    }

    /// Whether `url` is on the route's own site, for a route this node didn't learn: the only place its browser may
    /// go. A shared route never opens a browser at a host of its own choosing.
    fn on_the_routes_site(&self, url: &str) -> bool {
        if self.egress != crate::egress::Egress::Foreign {
            return true;
        }
        let (Some((_, home)), Ok(u)) = (self.home(), url::Url::parse(url)) else { return false };
        u.scheme() == "https" && u.host_str().is_some_and(|h| crate::identity::same_site(&home, h))
    }

    /// Uses the node's browser (the fork's `agent-browser` CLI) for steps the
    /// site walls. Without it, a walled step fails the call honestly.
    pub fn with_browser(mut self, browser: &str) -> Self {
        if self.egress == crate::egress::Egress::Foreign && !self.shared_mint {
            return self;
        }
        let host = self.graph.steps.last().map(|s| s.url.split('/').nth(2).unwrap_or("site").to_string());
        // Each client's walk is its own: its log is written and read back under a name no other heal shares, so one
        // heal never reads another's walk as its sighting.
        static CLIENTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let own = format!("route-client-{}-{}", std::process::id(), CLIENTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        // The walk's log is read back as the heal's sighting, so it is kept where only the owner can write: a folder
        // someone else made first would hand the heal their walk. No such folder, no browser.
        let Ok(scratch) = unbrowse_files::private::scratch() else { return self };
        // Someone else's route walks in an empty profile of its own, and never in a browser already running: that one is
        // the owner's, signed in.
        let foreign = self.egress == crate::egress::Egress::Foreign;
        if foreign {
            self.cdp = None;
            self.scratch_profile = Self::fresh_profile(&own);
            if self.scratch_profile.is_none() {
                return self;
            }
        }
        let profile = match &self.scratch_profile {
            Some(dir) => dir.0.to_string_lossy().into_owned(),
            None => unbrowse_files::private::home().join("profiles").join(host.as_deref().unwrap_or("site")).to_string_lossy().into_owned(),
        };
        // A browser already holding the site's own profile is the one to sign in: connecting to it skips the 20–30 s
        // launch per call and keeps the page's own state. Only for the owner's own route in the owner's profile: someone
        // else's route never reaches a running browser (it walks in a fresh profile, above).
        let cdp = match (foreign, &self.scratch_profile) {
            (false, None) => self.cdp.clone().or_else(|| crate::mint::live_endpoint_of(&profile)),
            _ => self.cdp.clone(),
        };
        self.browser = host.map(|host| {
            BrowserMint {
            try_controls: false,
            frames: self.frames.clone(),
            seed: Vec::new(),
            browser: browser.to_string(),
            cdp_endpoint: cdp,
            user_agent: Some("unbrowse-node/0.1.0".to_string()),
            capture_dir: scratch.join(format!("{own}-capture")),
            session: own,
            profile: Some(profile),
            _host: host,
            }
        });
        self.walk_in_the_roots_profile();
        self
    }

    /// Walks in a browser already running, at its DevTools address, rather than launching one: the site's profile
    /// can only be open in one browser at a time.
    ///
    /// A route that came from another node never does: the running browser is the owner's.
    pub fn with_cdp(mut self, endpoint: Option<String>) -> Self {
        let endpoint = endpoint.filter(|_| self.egress == crate::egress::Egress::Own);
        self.cdp = endpoint.clone();
        if let Some(b) = self.browser.as_mut() {
            b.cdp_endpoint = endpoint;
        }
        self
    }

    /// Sends pictures of a heal's walk to `sink`, for whoever watches it.
    pub fn with_frames(mut self, sink: agent_browser_core::screencast::FrameSink) -> Self {
        self.frames = Some(sink.clone());
        if let Some(b) = self.browser.as_mut() {
            b.frames = Some(sink);
        }
        self
    }

    fn load_jar(&mut self) {
        if let (Some(dir), Some(host)) = (&self.store, self.host()) {
            let path = dir.join(format!("{host}.json"));
            if let Ok(Some(jar)) = unbrowse_files::JAR.read_at(&path) {
                self.loaded = Some(jar);
                self.jar = self.loaded.clone().unwrap_or_default();
            }
            // How far each cookie goes is kept beside the jar, in its own file: what the walk recorded before it
            // was written, and what later calls kept. An entry for a name the jar doesn't hold says nothing about
            // anything sent, so it goes.
            let file: Option<HashMap<String, String>> = unbrowse_files::JAR.read_at(&scope_path(dir, &host)).ok().flatten();
            if let Some(mut scope) = file {
                scope.retain(|k, _| self.jar.contains_key(k));
                self.jar_domains = scope.clone();
                self.loaded_scope = Some(scope);
            }
            // Each cookie's path, expiry and place in the order, for the cookies the jar still holds.
            let meta: HashMap<String, CookieMeta> = unbrowse_files::JAR.read_at(&meta_path(dir, &host)).ok().flatten().unwrap_or_default();
            self.cookie_meta = meta.into_iter().filter(|(k, _)| self.jar.contains_key(k)).collect();
            self.loaded_meta = Some(self.cookie_meta.clone());
            // What the page had in front of it: a signing bridge boots the page's scripts with this, so a bundle that
            // keeps a key or a nonce there signs what this call asks.
            self.storage = unbrowse_files::JAR.read_at(&storage_path(dir, &host)).ok().flatten().unwrap_or_default();
            // And what its own code saw when it fingerprinted the browser.
            self.fingerprint = unbrowse_files::JAR.read_at(&fingerprint_path(dir, &host)).ok().flatten().unwrap_or(serde_json::Value::Null);
        }
        if let (Some(dir), Some(host)) = (self.store.clone(), self.host()) {
            self.take_in_the_sites_other_jars(&dir, &host);
        }
    }

    /// Reads into this jar the cookies the site's other hosts hold that reach `host` too: a cookie set for the domain
    /// (`Domain=.site.example`) is the browser's for every host under it, whichever host's answer set it. A sign-in on
    /// `auth.site.example` sets the session the calls on `www.site.example` send. Each jar is a host's own, so without
    /// this a route on one host never had what a call on another earned. Only a cookie whose recorded reach takes in
    /// `host` (`mint::sent_to`), on the same site, and only where this jar holds none of the name: its own stands. Read
    /// apart from what this jar's own file held (`borrowed`), so it is no change of this run's, and the file is not
    /// written for it.
    fn take_in_the_sites_other_jars(&mut self, dir: &std::path::Path, host: &str) {
        for other in other_jars_of_the_site(dir, host) {
            let jar: HashMap<String, String> = unbrowse_files::JAR.read_at(&dir.join(format!("{other}.json"))).ok().flatten().unwrap_or_default();
            let scope: HashMap<String, String> = unbrowse_files::JAR.read_at(&scope_path(dir, &other)).ok().flatten().unwrap_or_default();
            let meta: HashMap<String, CookieMeta> = unbrowse_files::JAR.read_at(&meta_path(dir, &other)).ok().flatten().unwrap_or_default();
            for (name, value) in jar {
                let Some(domain) = scope.get(&name).filter(|d| reaches_another_host(d, &other, host)) else { continue };
                if self.jar.contains_key(&name) {
                    continue;
                }
                self.jar.insert(name.clone(), value.clone());
                self.jar_domains.insert(name.clone(), domain.clone());
                self.borrowed.insert(name.clone(), value);
                if let Some(m) = meta.get(&name) {
                    self.cookie_meta.insert(name, m.clone());
                }
            }
        }
    }

    /// Writes into the site's other jars what this run changed of a cookie set for the domain: a value it was given
    /// anew, or a cookie the site took away. Only jars that are there, of hosts on the same site its recorded reach
    /// takes in; a host with no jar yet reads it when it is first called (`take_in_the_sites_other_jars`). A cookie of
    /// one host's own is never written anywhere but its own jar.
    fn give_the_sites_other_jars(&self, dir: &std::path::Path, host: &str, was: &HashMap<String, String>, was_scope: &HashMap<String, String>) {
        let given: Vec<(&String, &String, &String)> = self
            .jar
            .iter()
            .filter(|(k, v)| was.get(*k) != Some(*v))
            .filter_map(|(k, v)| Some((k, v, self.jar_domains.get(k).filter(|d| d.starts_with('.'))?)))
            .collect();
        let taken: Vec<(&String, &String)> = was.keys().filter(|k| !self.jar.contains_key(*k)).filter_map(|k| Some((k, was_scope.get(k).filter(|d| d.starts_with('.'))?))).collect();
        if given.is_empty() && taken.is_empty() {
            return;
        }
        for other in other_jars_of_the_site(dir, host) {
            let path = dir.join(format!("{other}.json"));
            if unbrowse_files::JAR.writable(&path).is_err() {
                continue;
            }
            let Ok(Some(mut jar)) = unbrowse_files::JAR.read_at::<HashMap<String, String>>(&path) else { continue };
            let mut scope: HashMap<String, String> = unbrowse_files::JAR.read_at(&scope_path(dir, &other)).ok().flatten().unwrap_or_default();
            let mut changed = false;
            for (name, value, domain) in given.iter().filter(|(_, _, d)| crate::mint::sent_to(d, &other)) {
                // A cookie of the name the other host holds for itself alone is its own: never written over.
                if jar.contains_key(*name) && scope.get(*name).is_none_or(|d| !d.eq_ignore_ascii_case(domain)) {
                    continue;
                }
                jar.insert((*name).clone(), (*value).clone());
                scope.insert((*name).clone(), (*domain).clone());
                changed = true;
            }
            for (name, domain) in taken.iter().filter(|(_, d)| crate::mint::sent_to(d, &other)) {
                if scope.get(*name).is_some_and(|d| d.eq_ignore_ascii_case(domain)) && jar.remove(*name).is_some() {
                    scope.remove(*name);
                    changed = true;
                }
            }
            if changed {
                if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&jar) {
                    let _ = unbrowse_files::private::write(&path, &json);
                }
                if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&scope) {
                    let _ = unbrowse_files::private::write(&scope_path(dir, &other), &json);
                }
            }
        }
    }

    /// Writes what this run changed onto the jar as it stands now ([`jar_after`]): calls and sign-outs run beside each
    /// other, and one that read the jar earlier never puts back what another took out. The reach of each cookie goes
    /// beside the jar the same way — with the same measure, and never at all when the session itself was dropped.
    fn save_jar(&mut self) {
        if !self.keeps_the_session() {
            return;
        }
        let (Some(dir), Some(host)) = (self.store.clone(), self.host()) else { return };
        // A jar a newer node saved is never written over.
        let path = dir.join(format!("{host}.json"));
        let _held = JAR_WRITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if unbrowse_files::JAR.writable(&path).is_err() {
            return;
        }
        let Ok(on_disk) = unbrowse_files::JAR.read_at(&path) else { return };
        // What the call began with, the cookies borrowed from the site's other hosts with it: what it changed of
        // either is measured against this.
        let mut was = self.loaded.clone().unwrap_or_default();
        let mut was_scope = self.loaded_scope.clone().unwrap_or_default();
        for (k, v) in &self.borrowed {
            was.entry(k.clone()).or_insert_with(|| v.clone());
            if let Some(d) = self.jar_domains.get(k) {
                was_scope.entry(k.clone()).or_insert_with(|| d.clone());
            }
        }
        // A borrowed cookie the call left as it was stays the other host's: it isn't written into this jar.
        let unborrowed = |k: &String, v: &String| self.borrowed.get(k) != Some(v) || self.loaded.as_ref().is_some_and(|l| l.contains_key(k));
        let own: HashMap<String, String> = self.jar.iter().filter(|(k, v)| unborrowed(k, v)).map(|(k, v)| (k.clone(), v.clone())).collect();
        let own_domains: HashMap<String, String> = self.jar_domains.iter().filter(|(k, _)| own.contains_key(*k) || !self.borrowed.contains_key(*k)).map(|(k, v)| (k.clone(), v.clone())).collect();
        let Some(jar) = jar_after(on_disk, self.loaded.as_ref(), &own) else {
            eprintln!("   [call] the session for {host} was dropped during the call; it stays dropped");
            self.jar.clear();
            self.loaded = None;
            self.jar_domains.clear();
            self.loaded_scope = None;
            return;
        };
        if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&jar) {
            let _ = unbrowse_files::private::write(&path, &json);
            let _ = unbrowse_files::private::narrow(&dir);
        }
        // What this run gave or took of a cookie set for the domain reaches the site's other hosts as it reaches a browser.
        self.give_the_sites_other_jars(&dir, &host, &was, &was_scope);
        self.jar = jar.clone();
        self.loaded = Some(jar);
        let scope_file = scope_path(&dir, &host);
        let on_scope: Option<HashMap<String, String>> = unbrowse_files::JAR.read_at(&scope_file).ok().flatten();
        let had_file = on_scope.is_some();
        if let Some(scope) = jar_after(on_scope, self.loaded_scope.as_ref(), &own_domains) {
            // No scope file and nothing to put in it is no file to make; anything else is written the way the jar is
            // (the folder was narrowed with it).
            if (had_file || !scope.is_empty()) && unbrowse_files::JAR.writable(&scope_file).is_ok() {
                if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&scope) {
                    let _ = unbrowse_files::private::write(&scope_file, &json);
                }
            }
            // No file was made for an empty scope, so none is loaded: a later save that has reach to keep makes the
            // file, where a loaded one that went would read as the session's reach dropped.
            let made = had_file || !scope.is_empty();
            self.jar_domains = scope.clone();
            self.loaded_scope = made.then_some(scope);
        } else {
            // The scope file went while this ran, as a sign-out takes both: its reach stays gone too.
            self.jar_domains.clear();
            self.loaded_scope = None;
        }
        self.save_meta(&dir, &host);
        self.borrowed.clear();
        // The jar in hand is this host's file now: what the site's other hosts hold for this one too is read in again,
        // so a call that goes on after a save (a retry after a sign-in) still sends it.
        self.take_in_the_sites_other_jars(&dir, &host);
    }

    /// Writes the fingerprint sample beside the jar after a heal: the page the bridge boots sees the browser the walk
    /// that just minted the session used.
    fn save_fingerprint(&self) {
        if !self.keeps_the_session() {
            return;
        }
        let (Some(dir), Some(host)) = (self.store.clone(), self.host()) else { return };
        let path = fingerprint_path(&dir, &host);
        if self.fingerprint.is_null() {
            let _ = std::fs::remove_file(&path);
            return;
        }
        if unbrowse_files::JAR.writable(&path).is_ok() {
            if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&self.fingerprint) {
                let _ = unbrowse_files::private::write(&path, &json);
            }
        }
    }

    /// Writes the page's storages beside the jar after a heal: the page the signing bridge boots is the one the walk
    /// that just minted the session saw, so a bundle reads the state its own code last left.
    fn save_storage(&self) {
        if !self.keeps_the_session() {
            return;
        }
        let (Some(dir), Some(host)) = (self.store.clone(), self.host()) else { return };
        let path = storage_path(&dir, &host);
        if self.storage.local.is_empty() && self.storage.session.is_empty() {
            let _ = std::fs::remove_file(&path);
            return;
        }
        if unbrowse_files::JAR.writable(&path).is_ok() {
            if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&self.storage) {
                let _ = unbrowse_files::private::write(&path, &json);
            }
        }
    }

    /// Writes what this run changed of the cookies' metadata: a name the jar no longer holds leaves, a name it just
    /// set takes its path and place, and everything else stays as another call left it (the ponytail of the jar's
    /// own save, for the file beside it).
    fn save_meta(&mut self, dir: &std::path::Path, host: &str) {
        let path = meta_path(dir, host);
        if unbrowse_files::JAR.writable(&path).is_err() {
            return;
        }
        let mut on_disk: HashMap<String, CookieMeta> = unbrowse_files::JAR.read_at(&path).ok().flatten().unwrap_or_default();
        for name in self.loaded_meta.iter().flat_map(|m| m.keys()) {
            if !self.jar.contains_key(name) {
                on_disk.remove(name);
            }
        }
        for (name, meta) in &self.cookie_meta {
            if self.jar.contains_key(name) {
                on_disk.insert(name.clone(), meta.clone());
            }
        }
        on_disk.retain(|name, _| self.jar.contains_key(name));
        if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&on_disk) {
            let _ = unbrowse_files::private::write(&path, &json);
        }
        self.cookie_meta = on_disk.clone();
        self.loaded_meta = Some(on_disk);
    }

    fn host(&self) -> Option<String> {
        jar_name(&self.graph)
    }

    /// Whether what a call's answers set is kept beside the owner's session: only for a route this node learned
    /// itself. A route that came from another node reads the owner's session for its site and never writes it: the
    /// cookies, tokens, storages and fingerprint its answers, its heal or its page's code set live for its call alone,
    /// so nothing a stranger's route earns (their own sign-in, a sign-out) is what the owner's own routes send next.
    fn keeps_the_session(&self) -> bool {
        self.egress == crate::egress::Egress::Own
    }

    /// The owner's session as the store holds it now, in place of whatever an earlier call of this client left in
    /// memory: a route that came from another node starts every call from the owner's session, never from what a
    /// previous call of it earned, and from none of it unless the owner allowed the route to act in it
    /// ([`RouteClient::owner_material_for`]).
    fn start_from_the_owners_session(&mut self) {
        self.jar.clear();
        self.loaded = None;
        self.jar_domains.clear();
        self.loaded_scope = None;
        self.cookie_meta.clear();
        self.loaded_meta = None;
        self.storage = Default::default();
        self.fingerprint = serde_json::Value::Null;
        let graph = self.graph.clone();
        if self.owner_material_for(&graph) {
            self.load_jar();
        }
    }

    /// The owner's own values for the site, for a route that came from another node: what its call must never replace.
    /// None for the node's own route, whose answers are the session's to update.
    fn owners_session(&self) -> Option<HashMap<String, String>> {
        (!self.keeps_the_session()).then(|| self.loaded.clone().unwrap_or_default())
    }

    /// The renewal a browser would make at a door, computed: the page the door answered with is booted in the sandbox
    /// with this call's session, its scripts fetched and its calls sent over this call's transport, and the cookies
    /// it earns join the jar (`mint::earned_at_the_door`, the same pass a walk makes when it first meets a door). The
    /// page's own code is the producer and the site's next answer the judge: nothing is trusted here, and a page that
    /// asks a person (a puzzle in another site's frame) is not run at all. `true` when the jar gained something.
    ///
    /// The pass is held to every rule a step of the call is ([`DoorRule`]): each request it makes (a script the page
    /// names, a call the page's code sends) goes through [`Held::send_on`] with the call's [`Within`], so a route that
    /// came from another node reaches only the origins its graph names, every redirect hop included; a request carries
    /// the jar's cookies a browser would send it ([`Sent::goes_to`]) and only what this call may carry ([`sendable`]);
    /// the page's script reads only the cookies known not to be HttpOnly; and what it earns joins the jar through the
    /// same checks an answer's cookies do ([`keep_set_cookies_of`]): only from the door's own site, a `Domain` the
    /// setting host is in and not a public suffix, and never a replacement of the owner's session ([`Sent::replaced_by`]),
    /// which earns nothing at all.
    fn compute_the_door(&mut self, transport: &mut dyn Fetch, door: &Exchange, rule: &DoorRule<'_>) -> bool {
        if !crate::sandbox::available() {
            return false;
        }
        // Before the page's scripts are asked for, not after: a door pass that is off sends the site nothing.
        if !crate::sandbox::door_pass_enabled() {
            eprintln!("   [door] {}: its page's scripts are not run (UNBROWSE_DOOR_PASS=1 turns the door pass on)", door.url.path());
            return false;
        }
        let Some((scheme, home)) = self.home() else { return false };
        let Some(html) = door.response_body.clone().filter(|b| b.contains("<script")) else { return false };
        let Some(site) = door.url.host_str().map(str::to_ascii_lowercase) else { return false };
        let alone = crate::trace::Trace { exchanges: vec![door.clone()], inputs: Vec::new() };
        if crate::mint::asks_a_person(&html, &alone, &door.url) {
            eprintln!("   [door] {} asks a person: its page is not run", door.url.path());
            return false;
        }
        let not_cookies = minted_tokens(&self.graph);
        // The jar's cookies this call may carry at all: a token the route names is not a cookie, a cookie whose life
        // ran out is gone, and a route that came from another node carries only what `sendable` lets it.
        let alive = |k: &str| self.cookie_meta.get(k).is_none_or(|m| m.expires.is_none_or(|e| e > now_secs()));
        let carried: Vec<(&String, &String)> = self
            .jar
            .iter()
            .filter(|(k, v)| !not_cookies.contains(*k) && !k.ends_with("-response") && alive(k) && sendable(rule.owner, rule.material, k, v))
            .collect();
        // The scripts the page names, fetched as the page would fetch them: a door's work is in them. A few, and not
        // large: a door's page is small, and a site's whole app is not a door.
        const MOST_SCRIPTS: usize = 12;
        const MOST_BYTES: usize = 4_000_000;
        let named: Vec<url::Url> = {
            let doc = scraper::Html::parse_document(&html);
            let sel = scraper::Selector::parse("script[src]").expect("static selector");
            doc.select(&sel).filter_map(|s| s.value().attr("src")).filter_map(|src| door.url.join(src).ok()).filter(|u| matches!(u.scheme(), "http" | "https")).take(MOST_SCRIPTS).collect()
        };
        let mut bundle: crate::sandbox::Bundle = Vec::new();
        let mut held = 0usize;
        {
            let jar = Sent { scheme: &scheme, home: &home, jar: &self.jar, domains: &self.jar_domains, meta: &self.cookie_meta, not_cookies: &not_cookies };
            for url in named {
                // The script is asked as the page asks it: with the cookies a browser would send to its address.
                let cookies: Vec<String> = carried.iter().filter(|(k, _)| jar.goes_to(k, &url)).map(|(k, v)| format!("{k}={v}")).collect();
                let mut headers = vec![("referer".to_string(), crate::identity::said_address(door.url.as_str()))];
                if !cookies.is_empty() {
                    headers.push(("cookie".to_string(), cookies.join("; ")));
                }
                let asked = Request { method: "GET".into(), url: url.clone(), exchange: usize::MAX, headers, body: None };
                let Ok(ex) = door_sends(transport, rule.within, &asked) else { continue };
                let Some(body) = ex.response_body.filter(|_| (200..300).contains(&ex.status)) else { continue };
                held += body.len();
                if held > MOST_BYTES {
                    break;
                }
                bundle.push((url.to_string(), body));
            }
        }
        // The page's session, as a browser holds it: each cookie with its reach, path and whether its script may read
        // it (unknown is HttpOnly). The pass sends each only where it goes and shows the script only what it may read.
        let seed: Vec<agent_browser_core::session::SeedCookie> = carried
            .iter()
            .map(|(k, v)| agent_browser_core::session::SeedCookie {
                name: (*k).clone(),
                value: (*v).clone(),
                domain: self.jar_domains.get(*k).cloned(),
                path: self.cookie_meta.get(*k).map(|m| m.path.clone()),
                http_only: self.cookie_meta.get(*k).and_then(|m| m.http_only),
            })
            .collect();
        let fingerprint = self.fingerprint.clone();
        // What the page's calls were answered with, by where: the lines that set what it earns, read again below by the
        // jar's own rules rather than taken as the pass reports them.
        let mut answered: Vec<Exchange> = Vec::new();
        let earned = crate::mint::earned_at_the_door(&door.url, &html, &bundle, door.url.as_str(), &fingerprint, &site, &seed, |req, _until| {
            let ex = door_sends(transport, rule.within, req).map_err(|e| e.to_string())?;
            answered.push(Exchange { response_body: None, ..ex.clone() });
            Ok(ex)
        });
        let Some((earned, _)) = earned else { return false };
        // What the page's script wrote itself is set at the page's own address, for the page's own host and path, and
        // its script may read it: a line as a browser would make it.
        let written: Vec<(String, String)> = earned
            .iter()
            .filter(|(name, _, domain)| domain.is_none() && !answered.iter().any(|e| e.cookie_changes_whole().iter().any(|c| &c.name == name)))
            .map(|(name, value, _)| ("set-cookie".to_string(), format!("{name}={value}; Path=/")))
            .collect();
        let own_site = |e: &Exchange| e.url.host_str().is_some_and(|h| crate::identity::same_site(h, &site));
        let mut setters: Vec<Exchange> = answered.into_iter().filter(own_site).collect();
        if !written.is_empty() {
            setters.push(Exchange { response_headers: written, response_body: None, ..door.clone() });
        }
        // An answer that would replace the owner's session ends the pass with nothing kept, as one to a step does.
        if let Some(owner) = rule.owner {
            let jar = Sent { scheme: &scheme, home: &home, jar: &self.jar, domains: &self.jar_domains, meta: &self.cookie_meta, not_cookies: &not_cookies };
            if let Some(name) = setters.iter().find_map(|e| jar.replaced_by(owner, e)) {
                eprintln!("   [door] the door's page replaced the owner's {name} cookie: a shared route never changes whose session it runs in");
                return false;
            }
        }
        let before = self.jar.clone();
        for e in &setters {
            keep_set_cookies_of(&home, &mut self.jar, &mut self.jar_domains, &mut self.cookie_meta, e);
        }
        let gained: Vec<String> = self.jar.iter().filter(|(k, v)| before.get(*k) != Some(*v)).map(|(k, _)| k.clone()).collect();
        if gained.is_empty() {
            return false;
        }
        eprintln!("   [door] {} answered {}; its own page, run in the sandbox, earned {}", door.url.path(), door.status, gained.join(", "));
        said(&self.fell_back, format!("the site's door answered {}; its own page was run in the sandbox and earned {}, with no browser", door.status, gained.join(", ")));
        true
    }

    /// The session, re-minted browserless: the route's root page is fetched once over the transport this call uses,
    /// with the navigation headers a browser sends and the jar's cookies, and the cookies it answers with join the
    /// jar. A session that went stale (a clearance rotated, a session cookie re-issued) is the jar's business alone;
    /// a page that refuses or hands back nothing new leaves the walk to the browser. `true` when the jar changed: the
    /// chain is worth running again.
    fn refresh_session(&mut self) -> bool {
        #[cfg(test)]
        if let Some(wire) = self.wire {
            return self.refresh_with(wire().as_mut());
        }
        let proxy = self.local_proxy();
        let mut transport: Box<dyn Fetch> = match self.chrome {
            true => match crate::http::ChromeFetch::held_to_proxy(self.egress, proxy.as_deref()) {
                Ok(t) => Box::new(t.as_sampled(&self.fingerprint)),
                Err(_) => return false,
            },
            false => match HttpFetch::held_to_proxy(self.egress, proxy.as_deref()) {
                Ok(t) => Box::new(t),
                Err(_) => return false,
            },
        };
        self.refresh_with(transport.as_mut())
    }

    /// [`Self::refresh_session`], over a transport the caller holds: the same run for the node's Chrome-shaped wire and
    /// for a test's own.
    fn refresh_with(&mut self, transport: &mut dyn Fetch) -> bool {
        let (Some(root), Some((scheme, home))) = (self.root.clone(), self.home()) else { return false };
        let Ok(url) = url::Url::parse(&root) else { return false };
        if url.scheme() != scheme || !secure_context(&url) {
            return false;
        }
        let to = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let own = to.eq_ignore_ascii_case(&home);
        if !own && !crate::identity::same_site(&home, &to) {
            return false;
        }
        // The jar's cookies for the page: the session's own host gets the jar whole, another host of the site only
        // what a recorded `Domain` reaches, as every step's request is sent (`with_session_cookies`).
        let not_cookies = minted_tokens(&self.graph);
        // The page is fetched for the graph the client holds: with the owner's session only when that graph is the one
        // they consented to.
        let graph = self.graph.clone();
        // ... and only when the start page is at an origin the graph names: the owner was shown those origins.
        let named = self.egress == crate::egress::Egress::Own || origins_of(&graph).is_some_and(|o| o.contains(&url.origin().ascii_serialization()));
        let material = named && self.owner_material_for(&graph);
        let owner = if material { self.owners_session() } else { self.owners_session().map(|_| HashMap::new()) };
        let held = Sent { scheme: &scheme, home: &home, jar: &self.jar, domains: &self.jar_domains, meta: &self.cookie_meta, not_cookies: &not_cookies };
        let pairs: Vec<String> = self
            .jar
            .iter()
            .filter(|(k, _)| held.goes_to(k, &url))
            .filter(|(k, v)| sendable(owner.as_ref(), material, k, v))
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        let headers = crate::site::Site::browser_headers(&to, &pairs.join("; "));
        let req = Request { method: "GET".into(), url, exchange: usize::MAX, headers, body: None };
        if transport.allows(&req).is_err() {
            return false;
        }
        // For a route that came from another node, every hop of the page's redirects is held to the origins its graph
        // names, as each step of its call is (`Held`).
        let within = (self.egress != crate::egress::Egress::Own).then(|| Within::new(origins_of(&graph).unwrap_or_default(), Some((scheme.clone(), home.clone())), owner.clone().unwrap_or_default()));
        let Ok(ex) = Held::send_on(transport, within.as_ref(), &req) else { return false };
        // A refusal is the wall's. What the wall's own page would have a browser do is computed first
        // (`compute_the_door`); only a door that asks more than its scripts can give is left for a browser.
        // A door may also answer inside the 2xx: a page that runs code and says nothing (`page::a_door`), served
        // `202` until the code has run.
        if !(200..400).contains(&ex.status) || crate::page::a_door(ex.status, ex.response_body.as_deref().unwrap_or_default(), &ex.url) {
            let rule = DoorRule { within: within.as_ref(), owner: owner.as_ref(), material };
            return self.compute_the_door(transport, &ex, &rule);
        }
        // A page that replaces the owner's session it was sent with, for a route that came from another node, is a site
        // changing whose session the call runs in: nothing of its answer is taken, and the call fails as it stood.
        if let Some(owner) = self.owners_session() {
            let sent = Sent { scheme: &scheme, home: &home, jar: &self.jar, domains: &self.jar_domains, meta: &self.cookie_meta, not_cookies: &not_cookies };
            if let Some(name) = sent.replaced_by(&owner, &ex) {
                eprintln!("   [call] the route's page replaced the owner's {name} cookie: a shared route never changes whose session it runs in");
                return false;
            }
        }
        let before = self.jar.clone();
        let before_meta = self.cookie_meta.clone();
        keep_set_cookies_of(&home, &mut self.jar, &mut self.jar_domains, &mut self.cookie_meta, &ex);
        // A token the route names in a header is also the session's when the page hands it over: the page's own
        // answer is the freshest copy of what the route sends, and the jar is where a step finds it.
        for (name, value) in self.page_tokens(&ex) {
            if self.jar.get(&name) != Some(&value) {
                self.jar.insert(name, value);
            }
        }
        // News is a value the jar didn't hold: a line that re-sets the same cookie (`Same`) changes no value, and
        // the call is not worth running again for it. The metadata is still kept, beside it.
        let changed = self.jar != before;
        if changed || self.cookie_meta != before_meta {
            self.save_jar();
        }
        changed
    }

    /// The route's named tokens that `ex` hands over: a header with the token's own name, or a `<meta name="..."
    /// content="...">` in the page. A token the page sets in its own script's storage is the sandbox's
    /// (`sandbox::Storage`), not this.
    fn page_tokens(&self, ex: &Exchange) -> Vec<(String, String)> {
        let body = ex.response_body.as_deref().unwrap_or_default();
        minted_tokens(&self.graph)
            .into_iter()
            .filter_map(|name| {
                let header = ex.response_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(&name)).map(|(_, v)| v.trim().to_string());
                let found = header.or_else(|| crate::page::meta_content(body, &name)).filter(|v| !v.is_empty());
                found.map(|value| (name, value))
            })
            .collect()
    }

    /// The node's own proxy, when this route's site is pinned and the proxy is up: the browser and the call then leave
    /// from one public address, so a credential the browser earned is spent by the call that sends it.
    ///
    /// The proxy resolves each name under the node's own rule. A route that came from another node is held to more (a
    /// public address, whatever Settings say), so when the owner's setting lets a public name resolve inside the network
    /// it never goes through the proxy: it resolves under its own rule, on the address it connects to.
    pub fn local_proxy(&self) -> Option<String> {
        let pinned = self.home().and_then(|(_, host)| crate::proxy::pinned(&host));
        pinned.filter(|_| resolves_under_its_own_rule(self.egress, crate::egress::private_allowed())).and(crate::proxy::local_url())
    }

    /// The route's own place: the scheme and host of its target, whose jar this client holds.
    fn home(&self) -> Option<(String, String)> {
        let u = url::Url::parse(&origin_of(&self.graph.steps.last()?.url)).ok()?;
        Some((u.scheme().to_string(), u.host_str()?.to_ascii_lowercase()))
    }

    /// Calls the route with `inputs` and returns the target's parsed JSON body.
    pub fn call(&mut self, inputs: &HashMap<String, String>) -> Result<Value, ReplayError> {
        self.call_with_ledger(inputs).0
    }

    /// The chain as it stands after a call: a heal that re-walked the root replaces it, even when its retry failed.
    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    /// The chain a heal found, once a retry on it answered: what the route is from now on, so the next call doesn't pay
    /// for the same walk. A chain whose retry failed proves nothing and is never handed back.
    pub fn healed(&self) -> Option<&Graph> {
        self.healed.as_ref()
    }

    /// Calls the route, and says what the call did to the site whether or not it answered: a write that may have
    /// reached the site is never sent twice, and the ledger is how the caller learns it must check before retrying.
    pub fn call_with_ledger(&mut self, inputs: &HashMap<String, String>) -> (Result<Value, ReplayError>, Ledger) {
        // What a run reads besides each step's request: the graph, or the body's skeleton beside it.
        let (writes, refused, alone) = {
            let runs = self.runs();
            let writes = self.judged_write || route_writes(&self.graph) || route_writes(&runs);
            // Every step the route says enough about is checked against the call's rule before any is sent: a step the
            // rule refuses fails the call with nothing sent, not after the steps before it ran. A body's steps are what
            // is sent when it runs, and are checked too.
            let sent = self.graph.steps.iter().enumerate().chain(self.body.is_some().then_some(runs.steps.iter().enumerate()).into_iter().flatten());
            let refused = sent.into_iter().find_map(|(n, s)| {
                let why = self.egress.template(&s.url).err().map(|e| format!("step {} of the route: {e}", n + 1)).or_else(|| crate::replay::chosen_credential(n + 1, s)).or_else(|| crate::replay::misplaced_session(n + 1, s));
                why.map(|why| (ReplayError::Refused(why), Ledger::of_route(&runs, self.judged_write)))
            });
            (writes, refused, target_may_run_alone(&runs, self.judged_write))
        };
        self.writes = writes;
        if !self.keeps_the_session() {
            self.start_from_the_owners_session();
        }
        if let Some((refused, ledger)) = refused {
            return (Err(refused), ledger);
        }
        // Target-first: the chain's job is to mint the session, and a warm jar
        // may already carry it. The target exchange runs alone; its fields that
        // derive from earlier steps fail fast (SourceMissing) and the full
        // chain runs instead — so the fast path only wins when it can, and a
        // route's side effects (a login POST that refreshes the session) are
        // only skipped when the minted values already answer.
        if alone {
            let (answer, ledger) = match self.body.clone() {
                // A body's target alone is its last step: the steps before it, which its reads name, have not answered.
                Some(mut body) => {
                    let target = body.steps.pop().expect("steps.len() > 1");
                    body.steps = vec![target];
                    let graph = self.graph.clone();
                    self.run_with(&graph, Some(&body), inputs)
                }
                None => {
                    let mut target_only = self.graph.clone();
                    let target = target_only.steps.pop().expect("steps.len() > 1");
                    target_only.steps = vec![target];
                    self.run_with(&target_only, None, inputs)
                }
            };
            if let Ok(v) = answer {
                return (Ok(v), ledger);
            }
            // The target alone may have been the route's commit. Running the full chain would send it a second
            // time, so a target-first attempt that may have written ends the call here.
            if ledger.retry(self.writes) != Retry::AsIs {
                eprintln!("   [call] the target-first attempt may have committed; the chain is not run again");
                return (answer, ledger);
            }
        }
        let (first, first_ledger) = self.run(inputs);
        if first.is_ok() {
            return (first, first_ledger);
        }
        if let Err(e) = &first {
            eprintln!("   [call] failed before any heal: {}", e.to_string().chars().take(300).collect::<String>());
        }
        // What the caller or the rule got wrong, and a site that is down, a walk can't mend: no browser opens for it.
        // A door is the one of those with a mend of its own that is no walk: the site's page, asked again over this
        // call's wire, may hand the pass back (`refresh_session`). It goes on to that, and no further (below).
        let at_a_door = matches!(first, Err(ReplayError::Door { .. }));
        if first.as_ref().err().is_some_and(|e| !a_walk_can_mend(e)) && !at_a_door {
            return (first, first_ledger);
        }
        // A write the site may already hold is not healed: a re-walk and a retry would send the commit twice.
        let retry = first_ledger.retry(self.writes);
        if retry != Retry::AsIs {
            eprintln!("   [call] the site may hold this write ({}); a heal would send it again", match retry {
                Retry::Never => "confirmed",
                _ => "unconfirmed",
            });
            return (first, first_ledger);
        }
        // An answer that says the session is gone, on a site whose sign-in the node holds as a request of its own: that
        // request is sent, with no browser, and the call made again on the session it earned. It is the owner's own
        // sign-in made again for the agent's own request, as a choice the site asks again is (`setups`), not a mend of
        // the route: it is tried where a heal is held and where no browser may open. Sent once, whatever comes of it.
        if first.as_ref().err().is_some_and(session_gone) {
            if let Some(jar) = self.plain_sign_in.as_mut().and_then(|sign_in| sign_in()) {
                self.jar.extend(jar);
                // The sign-in's own host may be another of the site's (`auth.` beside `www.`): what it earned there for
                // the domain is in that host's jar.
                if let (Some(dir), Some(host)) = (self.store.clone(), self.host()) {
                    self.take_in_the_sites_other_jars(&dir, &host);
                }
                let (again, ledger) = self.run(inputs);
                if again.is_ok() || ledger.retry(self.writes) != Retry::AsIs {
                    return (again, ledger);
                }
            }
        }
        // Held, nothing of the node's own mends the call: it fails as it failed (`holding_the_heal`).
        if self.heal_held {
            eprintln!("   [own-ask] held: heal at RouteClient::call_with_ledger");
            return (first, first_ledger);
        }
        // The call failed. If the site has drifted — a step now answers 422, a
        // field the site renamed — the recorded chain is no longer the site's
        // truth. Trace to the root: one fresh browser sighting, the chain
        // recomputed from it, and one retry.
        let (Some(root), Some((method, frag))) = (self.root.clone(), self.target.clone()) else {
            return (first, first_ledger);
        };
        // A stale session is re-minted browserless first: the route's page fetched once over the same transport, the
        // cookies it hands back into the jar, the chain run again. Only a page that hands back nothing new — or one
        // behind a wall — costs the browser a walk (the Eden report's Lazada call, which opened a browser for a
        // session cookie that the page itself had re-issued).
        // A door is cleared by what its own answer says may clear it, in that order (`Wall::sources`): the page asked
        // again is first on every list that has it, so a door whose answer was not read is still asked its page.
        let wall = match &first {
            Err(ReplayError::Door { wall, door, .. }) => Some((wall.clone().unwrap_or(crate::refusal::Wall::Refused), door.clone())),
            _ => None,
        };
        if let Some((wall, door)) = &wall {
            if let Some(cleared) = self.clear(wall, door, inputs) {
                return cleared;
            }
        } else if first.as_ref().err().is_some_and(|e| e.is_stale()) && self.refresh_session() {
            let (again, ledger) = self.run(inputs);
            if again.is_ok() || ledger.retry(self.writes) != Retry::AsIs {
                return (again, ledger);
            }
        }
        // A wall whose credential the site's own page re-issues never opens a browser: the refresh above is the whole
        // of what there was to do, and a browser would only be a cost for no new value.
        if let Err(ReplayError::Door { door, .. }) = &first {
            if door.earn == crate::graph::Earn::Recompute {
                eprintln!("   [door] {:?}: the site's own page re-issues it; no browser opened", door.kind);
                return (first, first_ledger);
            }
            // The jar's own credential, still inside the life its line gave, is not what the refusal is about: a
            // browser would earn the same cookie again for the same call. The call fails as it stands, and the next
            // one, after the credential lapses, is the visit's.
            if holds_the_credential(&self.jar, &self.cookie_meta, door) {
                eprintln!("   [door] {:?}: the jar holds {}, still inside its life; no browser opened", door.kind, door.credential.as_deref().unwrap_or_default());
                return (first, first_ledger);
            }
        }
        // A walk can't mend a wall (`a_walk_can_mend`): a fresh sighting is the same browser at the same wall, and a
        // wall is not the site drifting, so the chain is neither walked again nor rebuilt for one.
        if at_a_door {
            return (first, first_ledger);
        }
        // Where the site drifted and the route can be learned again, it is not healed in place: the call fails here,
        // before any browser walks, and says so. The caller learns the route again as a new one.
        if self.learn_again {
            if let Some(e) = first.as_ref().err().filter(|e| a_drift(e)) {
                let why = e.to_string().chars().take(200).collect::<String>();
                eprintln!("   [call] the site drifted ({why}): the route is learned again, not healed in place");
                self.drifted = Some(why);
                return (first, first_ledger);
            }
        }
        if self.browser.is_none() {
            return (first, first_ledger);
        }
        // One re-walk per site at a time: a burst of calls that all fail must not open a browser each.
        let Some(_healing) = HealGuard::take(&root) else {
            eprintln!("   [heal] {root} is already being re-walked; this call fails instead of opening another browser");
            return (first, first_ledger);
        };
        // An answer that says the session is gone wants signing in, not a re-walk: a walk signed out reads the signed-out
        // page. A retry that may have written stands as it is, as anywhere else.
        if first.as_ref().err().is_some_and(session_gone) {
            if let Some(jar) = self.sign_in.as_mut().and_then(|sign_in| sign_in()) {
                self.jar.extend(jar);
                let (again, ledger) = self.run(inputs);
                if again.is_ok() || ledger.retry(self.writes) != Retry::AsIs {
                    return (again, ledger);
                }
            }
        }
        let why = first.as_ref().err().map(|e| e.to_string().chars().take(160).collect::<String>()).unwrap_or_default();
        let Some(trace) = self.sight_the_root(&root, &format!("the call failed ({why}), so the node's browser walked the page again")) else {
            return (first, first_ledger);
        };
        // What the sighting changed may be only the session (a door's credential): the same chain, called again with
        // it, is the cheapest answer. Only a chain that still fails is rebuilt from the sighting. Nothing was sent by
        // the failed call (the heal is reached only then), so this sends nothing twice.
        let (again, again_ledger) = self.run(inputs);
        if again.is_ok() {
            self.save_jar();
            return (again, again_ledger);
        }
        // The route's target is on its own origin: the fresh chain's target must be the same origin's call, so a heal
        // never moves the route, and its session, onto another host the root page also called.
        let origin = self.graph.steps.last().map(|s| origin_of(&s.url));
        let fresh_trace = trace.clone();
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            let on_path: Vec<String> = fresh_trace.exchanges.iter().filter(|e| e.url.path().contains(frag.as_str())).map(|e| format!("{} {} {}", e.method, e.status, e.url.as_str().chars().take(110).collect::<String>())).collect();
            eprintln!("   [heal] the walk of {root} saw {} calls, {} at {frag}: {:?}", fresh_trace.exchanges.len(), on_path.len(), on_path.iter().take(4).collect::<Vec<_>>());
        }
        let mut g = match rebuilt(&self.graph, trace, &method, &frag, origin.as_deref(), &self.excluded) {
            Ok(g) => g,
            Err(why) => {
                eprintln!("   [heal] {why}");
                return (first, first_ledger);
            }
        };
        // A header seen once with no source is the session's: the jar keeps it, the graph only names it. A cookie a
        // later step derived from an earlier response but the fresh walk's own call carried is the session's too: the
        // jar keeps it, and the bootstrap that set it has nothing left reading its response.
        for (k, v) in crate::graph::session_headers(&mut g, &fresh_trace) {
            self.jar.insert(k, v);
        }
        for (k, v) in crate::graph::walked_cookies(&mut g, &fresh_trace) {
            self.jar.insert(k, v);
        }
        eprintln!("   [heal] route drifted; chain recomputed from a fresh root sighting ({} steps)", g.steps.len());
        self.graph = g;
        // The body was learned from the walks the old graph was, not this one: the rebuilt graph runs alone.
        if self.body.take().is_some() {
            eprintln!("   [heal] the route's learned body is let go: the rebuilt chain is from another walk");
        }
        let (retried, retried_ledger) = self.run(inputs);
        match retried {
            Ok(v) => {
                self.healed = Some(self.graph.clone());
                (Ok(v), retried_ledger)
            }
            Err(e) => {
                eprintln!("   [heal] retry: {e}");
                (first, first_ledger.fold(retried_ledger))
            }
        }
    }

    fn run(&mut self, inputs: &HashMap<String, String>) -> (Result<Value, ReplayError>, Ledger) {
        let graph = self.graph.clone();
        let body = self.body.clone();
        self.run_with(&graph, body.as_ref(), inputs)
    }

    /// What a run reads besides each step's request: the graph, or with a body, the body's skeleton with the graph's
    /// page context on it.
    fn runs(&self) -> std::borrow::Cow<'_, Graph> {
        match &self.body {
            Some(body) => std::borrow::Cow::Owned(crate::body::skeleton_beside(body, &self.graph)),
            None => std::borrow::Cow::Borrowed(&self.graph),
        }
    }

    /// One replay of the given graph, or of `body` beside it (each step's request the body's, everything else read off
    /// its skeleton with the graph's page context): the fast path's single step and the full chain share this.
    fn run_with(&mut self, graph: &Graph, body: Option<&unbrowse_route::Route>, inputs: &HashMap<String, String>) -> (Result<Value, ReplayError>, Ledger) {
        let beside;
        let graph = match body {
            Some(body) => {
                beside = crate::body::skeleton_beside(body, graph);
                &beside
            }
            None => graph,
        };
        self.ran_body = body.is_some();
        let session_steps = session_steps(graph, self.judged_write);
        let mut ledger = Ledger::of_route(graph, self.judged_write);
        if let Some((held, site)) = &self.held {
            if let Some(why) = held_input_leaves(graph, held, site) {
                return (Err(ReplayError::Refused(why)), ledger);
            }
        }
        // While a checkout waits for the owner, no route sends anything anywhere, whatever its methods and however it is
        // judged: a GET can commit an order (`hold`). Read on the graph about to be sent, a heal's included.
        if let Some(why) = crate::hold::waiting() {
            return (Err(ReplayError::Refused(why)), ledger);
        }
        let proxy = self.local_proxy();
        let transport: Box<dyn Fetch> = match self.chrome {
            true => match crate::http::ChromeFetch::held_to_proxy(self.egress, proxy.as_deref()) {
                // The request shape the walk's browser had: a Chrome-shaped ClientHello, the client hints that browser
                // sent on every request, and the user agent that names the same browser. A sample from a mint that
                // recorded none says nothing.
                Ok(t) => Box::new(t.as_sampled(&self.fingerprint)),
                Err(e) => return (Err(e), ledger),
            },
            false => match HttpFetch::held_to_proxy(self.egress, proxy.as_deref()) {
                Ok(t) => Box::new(t),
                Err(e) => return (Err(e), ledger),
            },
        };
        #[cfg(test)]
        let transport = match self.wire {
            Some(wire) => wire(),
            None => transport,
        };
        // The one place a run is handed the owner's session: for a route that came from another node, only when the
        // graph about to be sent is the one the owner consented to (`owner_material_for`). Otherwise the run gets none
        // of it: an empty owner snapshot (so `may_send` passes nothing from the jar, the owner's or the call's), and none
        // of the page storage or fingerprint the owner's session holds.
        let material = self.owner_material_for(graph);
        let (storage, fingerprint) = match material {
            true => (std::mem::take(&mut self.storage), std::mem::take(&mut self.fingerprint)),
            false => (Default::default(), serde_json::Value::Null),
        };
        let mut runner = Runner {
            began: Default::default(),
            owner: if material { self.owners_session() } else { self.owners_session().map(|_| HashMap::new()) },
            replaced: None,
            under_owner: HashSet::new(),
            steps: graph.steps.iter().map(|s| (s.exchange, s.clone())).collect(),
            session_reads_approved: self.session_reads_approved,
            session_allowed: material,
            transport: Held {
                fetch: transport,
                within: (self.egress != crate::egress::Egress::Own)
                    .then(|| Within::new(origins_of(graph).unwrap_or_default(), self.home(), if material { self.owners_session() } else { None }.unwrap_or_default())),
            },
            browser: self.browser.take(),
            jar: std::mem::take(&mut self.jar),
            jar_domains: std::mem::take(&mut self.jar_domains),
            cookie_meta: std::mem::take(&mut self.cookie_meta),
            storage,
            fingerprint,
            session_steps,
            walled: HashSet::new(),
            refused_on_the_walk: graph.steps.iter().filter(|s| s.status == 403).map(|s| s.exchange).collect(),
            home: self.home(),
            not_cookies: minted_tokens(graph),
            page: graph.page.clone(),
            scripts: graph.scripts.clone(),
            answers: graph.api.clone(),
            page_html: graph.page_html.clone(),
            egress: self.egress,
            used_browser: self.used_browser.clone(),
            reached: Default::default(),
            fell_back: self.fell_back.clone(),
            unheld: self.unheld.clone(),
            signed: std::cell::RefCell::new(HashMap::new()),
            page_read: std::cell::Cell::new(false),
            sandbox_off: std::cell::Cell::new(false),
            sandbox_pages: std::cell::RefCell::new(HashMap::new()),
            sandbox_retried: std::cell::RefCell::new(HashSet::new()),
            signing_targets: graph.steps.iter().filter(|s| s.is_page_signed()).map(|s| {
                // The path is what a recorded call is keyed by; the step's query may hold `{loc}` holes, which no URL
                // parser accepts, so the hole text is removed before the path is read.
                let mut clean = String::new();
                let mut hole = false;
                for c in s.url.chars() {
                    match c {
                        '{' => hole = true,
                        '}' => hole = false,
                        _ if !hole => clean.push(c),
                        _ => {}
                    }
                }
                (s.method.to_uppercase(), url::Url::parse(&clean).map(|u| u.path().to_string()).unwrap_or_default())
            }).collect(),
        };
        let run = match body {
            Some(body) => crate::replay::replay_body_ledgered(body, graph, inputs, &mut runner, &mut ledger),
            None => replay_ledgered(graph, inputs, &mut runner, &mut ledger),
        };
        // A walled step kept the browser open for the steps after it. Its session is this client's alone: the next
        // call opens its own, so this one is closed with the run.
        if !runner.walled.is_empty() {
            if let Some(b) = &runner.browser {
                b.close();
            }
        }
        self.jar = runner.jar;
        self.jar_domains = runner.jar_domains;
        self.cookie_meta = runner.cookie_meta;
        if material {
            self.storage = runner.storage;
            self.fingerprint = runner.fingerprint;
        }
        self.browser = runner.browser;
        self.save_jar();
        // What the run reached counts whether or not it answered: a page opened to sign a call that then failed was
        // still opened.
        self.made.reach(runner.reached.get());
        let run = match run {
            Ok(r) => r,
            Err(e) => return (Err(e), ledger),
        };
        self.made.answered(run.rungs.clone());
        // A reply the site's own code unpacks was turned into its answer by the replay (`replay::run`), which counts the
        // decoder's rung on the answer's step: the target here is already what the page read.
        let body = run.target.response_body.as_deref().unwrap_or_default();
        let content_type = run.target.response_header("content-type").unwrap_or(&run.target.response_mime).to_string();
        // The route's target is the site's page, or a piece of one (its results are rendered into the HTML): answer
        // with the state it embeds when that holds what the page shows, else with the page read (`page::answer`).
        let like = graph.steps.last().and_then(|s| s.response_shape.as_ref());
        if crate::page::is_markup(&content_type, body) && serde_json::from_str::<Value>(body).is_err() {
            // A page read for its text keeps its script's shape as a guard, never as the answer to read.
            let like = like.filter(|_| !graph.steps.last().is_some_and(|s| s.reads_page));
            let asked: Vec<&str> = inputs.values().map(String::as_str).collect();
            let (answer, read) = crate::page::answer_like(body, &run.target.url, like, &asked);
            // A page that says nothing now is the site's answer to a value it found nothing for, when the page the
            // route was learned on said something: usatoday's nonsense query answers a 22-character "search -
            // usatoday.com", and the route's own page read (its walks' HTML) is a page of results. A walk that met a
            // block page never had such a page, so the check still refuses it at learn time.
            let walked_said = graph.page_html.as_deref().is_some_and(|h| {
                let page = crate::page::read(h, &run.target.url);
                page["links"].as_array().map_or(0, Vec::len) > 0 || page["text"].as_str().map_or(0, str::len) > 200
            });
            // ...and only a reply that says *something* is that answer: a reply with no title and no text at all is a
            // stub the site served instead of a page (amazon.co.jp's client gets an empty body), not "nothing found".
            let said_something = answer["title"].as_str().is_some_and(|t| !t.trim().is_empty()) || answer["text"].as_str().is_some_and(|t| !t.trim().is_empty());
            if let Some(why) = read.then(|| crate::page::a_check_not_the_page(&answer, &asked)).flatten().filter(|_| !(walked_said && said_something)) {
                return (Err(ReplayError::NotAnAnswer { status: run.target.status, why, challenge: true }), ledger);
            }
            // A page served as 404 that said back what was asked (`answer::found_nothing`) says so beside what it shows.
            let mut answer = answer;
            if let (true, Some(page)) = (run.target.status >= 400, answer.as_object_mut()) {
                page.insert("status".into(), Value::from(run.target.status));
            }
            return (Ok(answer), ledger);
        }
        // Its data, or a target that serves its data as text (a feed, XML, Markdown, plain text): the one reading of a
        // reply as the call's answer (`answer::data_of`), which a walk's record of the same call is read by too.
        if let Some(v) = crate::answer::data_of(&run.target, like) {
            return (Ok(v), ledger);
        }
        let answer = serde_json::from_str(body).map_err(|_| {
            eprintln!("   [debug] target body not JSON: {} bytes, head: {}", body.len(), body.chars().take(100).collect::<String>());
            ReplayError::ShapeMismatch {
                expected: Value::Null,
                got: Value::String(body.chars().take(120).collect()),
            }
        });
        (answer, ledger)
    }
}

/// Why `graph` may not be sent with `held` filled in, if it may not: a step that carries one of them goes somewhere
/// other than an encrypted connection to a host on `site`. Read on the graph about to be sent, so a chain rebuilt
/// after the caller's own check is held to the same rule.
fn held_input_leaves(graph: &Graph, held: &[String], site: &str) -> Option<String> {
    for (n, step) in graph.steps.iter().enumerate() {
        let Some(name) = step.fields.iter().find_map(|f| match &f.class {
            Class::Input { name, .. } if held.contains(name) => Some(name),
            _ => None,
        }) else {
            continue;
        };
        let to = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")).ok();
        let fits = to.as_ref().is_some_and(|u| matches!(u.scheme(), "https" | "wss") && u.host_str().is_some_and(|h| !site.is_empty() && crate::identity::site_of(h) == site));
        if !fits {
            let host = to.as_ref().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| "an address it can't name".into());
            return Some(format!("step {} of the route would send {name}, which the owner's vault filled in, to {host}: a vault value goes only to {site}, encrypted, so nothing was sent", n + 1));
        }
    }
    None
}

/// Whether a call under `egress` may go through the node's local proxy, which resolves names under the node's own rule:
/// always for the node's own route, and for a route that came from another node only while that rule refuses a public
/// name resolving inside the network (the owner's setting off), as its own rule does.
fn resolves_under_its_own_rule(egress: crate::egress::Egress, private_allowed: bool) -> bool {
    egress == crate::egress::Egress::Own || !private_allowed
}

/// The exact origins a graph's steps are addressed to (scheme, host and port, as `Url::origin` writes them), or None
/// when a step builds its host at call time. A route that came from another node sends to these and nowhere else, and
/// the owner is shown them when asked to let it act in their session.
pub fn origins_of(graph: &Graph) -> Option<std::collections::BTreeSet<String>> {
    graph
        .steps
        .iter()
        .map(|s| {
            crate::replay::step_host(&s.url)?;
            let o = origin_of(&s.url);
            url::Url::parse(&o).ok().map(|u| u.origin().ascii_serialization())
        })
        .collect()
}

/// The owner's yes to a route that came from another node: the body it came from and the digest of what they were shown.
#[derive(Clone, Debug)]
struct Consent {
    body: String,
    digest: String,
}

/// What the owner's yes to a route that came from another node is bound to: the content identifier of the body it came
/// from and the graph it runs, hashed (SHA-256, hex). The node computes it from the graph itself, never from anything
/// the route or its page says; the app keys the yes it keeps by it, and the client checks it again at send time.
pub fn consent_digest(body: &str, graph: &Graph) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    h.update(b"\n");
    h.update(serde_json::to_vec(graph).unwrap_or_default());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A throwaway profile, removed with whatever holds it.
struct ScratchProfile(PathBuf);

impl Drop for ScratchProfile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The run policy: plain HTTP first; a step the site walls (403) is re-run in
/// the browser; minted values come from the jar, which the browser refreshes.
/// The roots being re-walked right now, process-wide.
static HEALING: std::sync::Mutex<Option<HashSet<String>>> = std::sync::Mutex::new(None);

struct HealGuard(String);

impl HealGuard {
    fn take(root: &str) -> Option<Self> {
        let mut set = HEALING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        set.get_or_insert_with(HashSet::new).insert(root.to_string()).then(|| HealGuard(root.to_string()))
    }
}

impl Drop for HealGuard {
    fn drop(&mut self) {
        if let Some(set) = HEALING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
            set.remove(&self.0);
        }
    }
}

/// A call's wire and the rule its requests are held to, as one thing: every request the call makes through it, and
/// every hop a redirect leads one to, is checked against `within` where the transport follows it
/// ([`Fetch::fetch_within`]). A path that sends through the call's transport can't leave the rule behind.
struct Held {
    fetch: Box<dyn Fetch>,
    /// None for the node's own route; for a route that came from another node, the origins its graph names.
    within: Option<Within>,
}

impl Held {
    /// `req` over `fetch`, held to `within` hop by hop when there is one.
    fn send_on(fetch: &mut dyn Fetch, within: Option<&Within>, req: &Request) -> Result<Exchange, ReplayError> {
        match within {
            Some(w) => fetch.fetch_within(req, w),
            None => fetch.fetch(req),
        }
    }

    /// `req` alone, its redirect the answer and never followed, admitted by `within` when there is one: what a page's
    /// own call is sent as, so the page is never handed what another address answered.
    fn send_once(fetch: &mut dyn Fetch, within: Option<&Within>, req: &Request) -> Result<Exchange, ReplayError> {
        if let Some(w) = within {
            w.admits(&req.url).map_err(ReplayError::Refused)?;
        }
        fetch.fetch_unredirected(req)
    }
}

impl Fetch for Held {
    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        Held::send_on(self.fetch.as_mut(), self.within.as_ref(), req)
    }

    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        if let Some(w) = &self.within {
            w.admits(&req.url).map_err(ReplayError::Refused)?;
        }
        self.fetch.fetch_unredirected(req)
    }

    fn allows(&self, req: &Request) -> Result<(), ReplayError> {
        if let Some(w) = &self.within {
            w.admits(&req.url).map_err(ReplayError::Refused)?;
        }
        self.fetch.allows(req)
    }
}

/// What a door's pass is held to: the call's [`Within`] (None for the node's own route), the owner's session as the call
/// began (None for the node's own route), and whether the owner allowed this route to act in it.
struct DoorRule<'a> {
    within: Option<&'a Within>,
    owner: Option<&'a HashMap<String, String>>,
    material: bool,
}

/// One request of a door's pass: refused before anything is sent when the call's rule refuses it, else sent through
/// [`Held::send_on`], every redirect hop held to the call's [`Within`].
fn door_sends(transport: &mut dyn Fetch, within: Option<&Within>, req: &Request) -> Result<Exchange, ReplayError> {
    if let Some(w) = within {
        w.admits(&req.url).map_err(ReplayError::Refused)?;
    }
    transport.allows(req)?;
    Held::send_once(transport, within, req)
}

struct Runner {
    /// The owner's own session for the site, when the route came from another node: the values its answers must never
    /// replace. None for the node's own route.
    owner: Option<HashMap<String, String>>,
    /// The jar as the call's first request went out: a value the site handed the call after (a gateway's token issued
    /// to the request that lacked it, `replay::resigned`) is not in it, and is the call's own, not the owner's.
    began: std::cell::RefCell<Option<HashMap<String, String>>>,
    /// The cookie of the owner's session an answer replaced or removed, for a route that came from another node: the
    /// call ends at the step that saw it, and no request is sent after.
    replaced: Option<String>,
    /// The steps whose request carried the owner's session (a cookie or a token of theirs), by exchange: what their
    /// answers hold may be the owner's own data.
    under_owner: HashSet<usize>,
    /// The route's steps, by exchange: what a request is, to the rule above.
    steps: HashMap<usize, crate::graph::Step>,
    /// The owner said yes to this call's write carrying what a step read under their session.
    session_reads_approved: bool,
    /// The owner allowed this route, one that came from another node, to act in their session on its site: then it may
    /// also carry what the site sets during the call ([`Runner::may_send`]).
    session_allowed: bool,
    /// The wire, with the rule every request of the call is held to: for a route that came from another node, the
    /// exact origins its graph names ([`origins_of`]), hop by hop. The only places a request of it goes, and the only
    /// ones a cookie of the jar is attached for.
    transport: Held,
    browser: Option<BrowserMint>,
    jar: HashMap<String, String>,
    /// How far each of the jar's cookies goes (its `Domain`, when the site set it for more than one host): the
    /// reach a step's host is checked against, beside the value it sends.
    jar_domains: HashMap<String, String>,
    /// Each cookie's path, expiry and place in the jar's order: what a browser sends them in.
    cookie_meta: HashMap<String, CookieMeta>,
    /// What the page had in front of it when the route was learned: the signing bridge boots the page's scripts
    /// with this, so a bundle that keeps a key or a nonce there signs what this call asks.
    storage: crate::sandbox::Storage,
    /// The browser the page's own code saw, for a producer that samples the environment.
    fingerprint: serde_json::Value,
    /// Steps that only carry session values, by exchange, with the names they
    /// serve: answered from the store, never the network.
    session_steps: HashMap<usize, Vec<String>>,
    /// Exchanges the site answered with a wall, now browser-served.
    walled: HashSet<usize>,
    /// Exchanges the walk itself saw answered 403: the recorded answer, not a wall to run a browser at.
    refused_on_the_walk: HashSet<usize>,
    /// The session's own place, scheme and host: the jar holds what the browser sends there.
    home: Option<(String, String)>,
    /// Jar entries that are not cookies: the header and body tokens the route mints.
    not_cookies: HashSet<String>,
    /// The page the route was learned on, with the caller's values as `{name}`, and the scripts that produce its
    /// computed values: the signing bridge's input (`crate::sandbox`).
    page: Option<String>,
    scripts: Vec<crate::signing::Script>,
    /// The answers the walk's page read, by address: a bundle's start-up asks its own config, and this is what the
    /// site said. The data layer first, the line second, the page's markup only for what needs paint.
    answers: Vec<crate::signing::Answer>,
    /// The page as the walk saw it: what the scripts read when the bridge runs them again.
    page_html: Option<String>,
    /// Whose route this is: a route this node didn't learn opens no browser off its own site.
    egress: crate::egress::Egress,
    /// Shared with the client: a browser was opened for this call.
    used_browser: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The highest rung anything this run did reached (`learn.rung`), answered or not.
    reached: std::cell::Cell<crate::rung::Rung>,
    /// Shared with the client: what the call fell back on, and why.
    fell_back: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    /// Why the sandbox ran no page's code for this call, where that is why it was skipped (`sandbox::unheld`): the
    /// reader's own answer, for a reply to name, never its words to parse.
    unheld: std::sync::Arc<std::sync::Mutex<Option<crate::sandbox::Unheld>>>,
    /// The requests the page's own code made, by `METHOD path`: read once per run, from the page opened with the
    /// caller's values (the browser bridge), and reused for every signed step after it.
    signed: std::cell::RefCell<HashMap<String, crate::sandbox::Signed>>,
    /// The warm page has been read in this run: a call it did not make is not one asking it again would produce.
    page_read: std::cell::Cell<bool>,
    /// The sandbox could not sign this bundle: it answers the same nothing for every later step of this run.
    sandbox_off: std::cell::Cell<bool>,
    /// Every call one sandbox boot made at a page address, by `METHOD path`: a route with several signed steps loads
    /// the page once when the page makes them all, and a later step reads its call from that run.
    sandbox_pages: std::cell::RefCell<HashMap<String, HashMap<String, crate::sandbox::Signed>>>,
    /// Page addresses already booted with fresh storage after a cached miss: one fresh boot per page, never a loop.
    sandbox_retried: std::cell::RefCell<HashSet<String>>,
    /// The method and path of every step whose value the page's own code makes: the boot stops shortly after the page
    /// has made them all, instead of waiting out its quiet window.
    signing_targets: Vec<(String, String)>,
}

impl Runner {
    /// Whether the jar's `name` may go out with a request of this call. A route that came from another node carries
    /// only what the owner's jar held when the call began, unless the owner allowed the route to act in their session:
    /// a cookie or token the site set during the call may be a session the route made for itself (a sign-in fixed in
    /// it, under a name the owner's jar never held), and the caller's values would then go to that account. Without
    /// the owner's yes the route sends no such value; the node's own route sends what its jar holds.
    fn may_send(&self, name: &str, value: &str) -> bool {
        sendable(self.owner.as_ref(), self.session_allowed, name, value)
    }

    /// Whether `url` is an origin the run's graph names, for a route that came from another node: scheme, host and port
    /// exactly as a step of it is addressed. Another host of the same site (a sibling subdomain, which may be someone
    /// else's) is not; the node's own route has no such bound here.
    ///
    /// It must also be on the route's own site: a graph that names another site's origin (admission refuses one, a
    /// rebuilt chain could) is still sent nothing there.
    fn in_scope(&self, url: &url::Url) -> bool {
        self.transport.within.as_ref().is_none_or(|w| w.names(url))
    }

    /// Counts something this run did at `rung`, answered or not (`learn.rung`).
    fn reach(&self, rung: crate::rung::Rung) {
        self.reached.set(self.reached.get().max(rung));
    }

    /// Whether `url` is on the route's own site, for a route this node didn't learn: the only place its browser may
    /// go.
    fn on_the_routes_site(&self, url: &str) -> bool {
        if self.egress != crate::egress::Egress::Foreign {
            return true;
        }
        let (Some((_, home)), Ok(u)) = (self.home.as_ref(), url::Url::parse(url)) else { return false };
        u.scheme() == "https" && u.host_str().is_some_and(|h| crate::identity::same_site(home, h))
    }

    /// The site's own document for `page`, asked for as a browser's navigation asks, with this call's session. None when
    /// the site answers anything but a page. The request is held to every rule a step of the call is: for a route that
    /// came from another node, only an origin its graph names ([`Runner::in_scope`]) on its own site, over HTTPS, never
    /// once the site replaced the owner's session ([`Runner::ended`]), and an answer that replaces it ends the call
    /// rather than handing the page on.
    fn the_sites_page(&mut self, page: &str) -> Option<String> {
        let url = url::Url::parse(page).ok()?;
        if self.ended().is_some() || !self.in_scope(&url) || !self.on_the_routes_site(page) {
            return None;
        }
        let headers = crate::site::Site::browser_headers(url.host_str()?, "").into_iter().filter(|(k, _)| k != "cookie").collect();
        let asked = self.with_session_cookies(&Request { method: "GET".into(), url, exchange: usize::MAX, headers, body: None });
        let ex = self.transport.fetch(&asked).ok()?;
        self.keep_set_cookies(&ex);
        if self.ended().is_some() {
            return None;
        }
        let body = ex.response_body.filter(|_| ex.status == 200)?;
        let head = body.trim_start().get(..512.min(body.trim_start().len())).unwrap_or_default().to_ascii_lowercase();
        (head.starts_with("<!doctype html") || head.contains("<html")).then_some(body)
    }

    /// The jar as a browser holds it, for asking where each of its cookies goes ([`Sent::goes_to`]).
    fn held(&self) -> Option<Sent<'_>> {
        let (scheme, home) = self.home.as_ref()?;
        Some(Sent { scheme, home, jar: &self.jar, domains: &self.jar_domains, meta: &self.cookie_meta, not_cookies: &self.not_cookies })
    }

    /// Whether the jar's cookie `name` goes with a request to `url` in this call: where a browser would send it
    /// ([`Sent::goes_to`]: host or domain, path, a secure context, unexpired), at an origin a route that came from
    /// another node names, and only what such a route may carry ([`Runner::may_send`]).
    fn sends_cookie(&self, name: &str, url: &url::Url) -> bool {
        self.held().is_some_and(|h| h.goes_to(name, url)) && self.in_scope(url) && self.jar.get(name).is_some_and(|v| self.may_send(name, v))
    }

    /// One request the page's own code makes while the sandbox runs it, sent over `transport` with this call's session.
    /// It is held to the rule every step of the call is: for a route that came from another node, only an origin its
    /// graph names (the call's [`Within`], every redirect hop included, the same `in_scope` a step uses), and nothing
    /// once the site replaced the owner's session. The sandbox's own check (`sandbox::page_may_ask`, the page's own
    /// site) is the looser bound the node's own routes keep; a same-site host is not an origin the owner was shown.
    fn page_asks(&mut self, transport: &mut dyn Fetch, r: &Request) -> Result<Exchange, String> {
        if let Some(why) = self.ended() {
            return Err(why);
        }
        if !self.on_the_routes_site(r.url.as_str()) {
            return Err("the sandbox asked for a host off the route's site".to_string());
        }
        let with = self.with_session_cookies(r);
        // The one address the page named: a redirect is the answer, and the sandbox hands the page none.
        let ex = Held::send_once(transport, self.transport.within.as_ref(), &with).map_err(|e| e.to_string())?;
        self.keep_set_cookies(&ex);
        Ok(ex)
    }

    /// The session's cookies as a browser sends what it holds: to the session's own host whole, and down the site
    /// from it as far as each cookie's own `Domain` reaches — the walk and the site's own answers recorded that
    /// beside the value, so the clearance a site set for its whole site rides every step of a chain under that
    /// domain, and the browser those calls answer for never has to open. A walk records requests before Chrome
    /// attaches their cookies, so a route has no cookie fields for most of them, yet the site still checks them (an
    /// anti-forgery header is only good with its cookie). The jar's non-cookie values (header tokens, widget
    /// answers the route names) stay out of the cookie.
    ///
    /// Each cookie goes only where a browser would send it ([`Sent::goes_to`]): its host, or the hosts its recorded
    /// `Domain` reaches on the jar's own site; a path its recorded `Path` covers; never past the life its line gave
    /// it; and only on the scheme the jar was kept for, never in the clear ([`secure_context`]), where a Secure cookie
    /// never goes (the jar keeps no Secure flag, so every cookie is held to it). For a route that came from another
    /// node, a cookie of the jar a step's own cookie field drew in by name is held to the same rule: where it doesn't
    /// go, it is taken off.
    fn with_session_cookies(&self, req: &Request) -> Request {
        let mut req = req.clone();
        let at = req.headers.iter().position(|(k, _)| k.eq_ignore_ascii_case("cookie"));
        let mut pairs: Vec<String> = at.map(|i| req.headers[i].1.split(';').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()).unwrap_or_default();
        // For a route that came from another node, a pair carrying the jar's own value is the owner's cookie, however
        // the step came by it (its body names the cookie): it goes where the jar's cookie goes, and nowhere else. The
        // node's own route draws a cookie by name where its own walk saw the browser send it, and that word stands.
        let had = pairs.len();
        // The owner's cookie is one the owner's session held, or the jar held as the call began: a value the site handed
        // this call itself (a gateway's token issued to the request that lacked it, `replay::resigned`) is the call's.
        let began = self.began.borrow_mut().get_or_insert_with(|| self.jar.clone()).clone();
        if let Some(owner) = &self.owner {
            let theirs = |k: &str, v: &str| owner.get(k).or_else(|| began.get(k)).is_some_and(|j| j == v);
            pairs.retain(|p| match p.split_once('=') {
                Some((k, v)) if theirs(k.trim(), v.trim()) && !self.is_token(k.trim()) => self.sends_cookie(k.trim(), &req.url),
                _ => true,
            });
        }
        let held: HashSet<String> = pairs.iter().filter_map(|p| p.split_once('=').map(|(k, _)| k.trim().to_string())).collect();
        // A browser sends the cookies the request's path holds longest-path first, then oldest first, and a site that
        // binds a token to a request reads that order. The jar alone can't say it; the metadata beside it can.
        let mut mine: Vec<(&String, &String)> = self.jar.iter().filter(|(k, _)| !held.contains(*k) && self.sends_cookie(k, &req.url)).collect();
        let path_len = |k: &str| self.cookie_meta.get(k).map_or(1, |m| m.path.len());
        let order = |k: &str| self.cookie_meta.get(k).map_or(0, |m| m.order);
        mine.sort_by(|a, b| path_len(b.0).cmp(&path_len(a.0)).then(order(a.0).cmp(&order(b.0))).then(a.0.cmp(b.0)));
        if mine.is_empty() && pairs.len() == had {
            return req;
        }
        for (k, v) in mine {
            pairs.push(format!("{k}={v}"));
        }
        match (at, pairs.is_empty()) {
            (Some(i), true) => {
                req.headers.remove(i);
            }
            (Some(i), false) => req.headers[i].1 = pairs.join("; "),
            (None, false) => req.headers.push(("cookie".into(), pairs.join("; "))),
            (None, true) => {}
        }
        req
    }

    /// Whether a jar entry is a token the route names (a header or body value), never a cookie.
    fn is_token(&self, name: &str) -> bool {
        // The route names its tokens; a cookie may share their words (`_csrf` is the cookie a `csrf-token` header is
        // checked against), so names, not words, decide.
        self.not_cookies.contains(name) || name.ends_with("-response")
    }

    /// The cookies a page's script at `page` reads in `document.cookie`, as a browser shows them: those that go with a
    /// request to the page ([`Runner::sends_cookie`]) and are known not to be HttpOnly. A cookie whose HttpOnly the jar
    /// never learned is kept from the script, as an HttpOnly one is.
    fn page_cookies(&self, page: &url::Url) -> String {
        let mut shown: Vec<(&String, &String)> = self
            .jar
            .iter()
            .filter(|(k, _)| self.cookie_meta.get(*k).is_some_and(CookieMeta::shown_to_script) && self.sends_cookie(k, page))
            .collect();
        let path_len = |k: &str| self.cookie_meta.get(k).map_or(1, |m| m.path.len());
        let order = |k: &str| self.cookie_meta.get(k).map_or(0, |m| m.order);
        shown.sort_by(|a, b| path_len(b.0).cmp(&path_len(a.0)).then(order(a.0).cmp(&order(b.0))).then(a.0.cmp(b.0)));
        shown.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")
    }

}

impl Runner {
    /// The cookies an answer sets join the jar as a browser keeps them: everything set on the session's own host
    /// (a sign-in's session, set on its redirect too, which the transport hands on), and a cookie the site set for
    /// a domain from any host of it — when that domain reaches both the host that set it (or a browser would
    /// refuse the cookie) and this jar's own host (or it would never come back here), the cookie is the site's own
    /// and its reach is kept beside its value, so the calls after this one send it down the site. A host-only
    /// cookie set on another host is that host's session, not this jar's, and stays out; another site's cookie
    /// never joins. A cookie set empty, or set to expire, is taken out, and its recorded reach with it.
    ///
    /// For a route that came from another node, an answer that replaces or removes a cookie of the owner's session the
    /// request was sent with changes whose session the call runs in (a sign-in as someone else, a sign-out): none of
    /// its cookies are taken, and the call ends ([`Runner::replaced`]).
    fn keep_set_cookies(&mut self, ex: &Exchange) {
        let Some((_, home)) = self.home.as_ref() else { return };
        if let (Some(owner), Some(sent)) = (self.owner.as_ref(), self.held()) {
            if let Some(name) = sent.replaced_by(owner, ex) {
                if let Some(w) = &self.transport.within {
                    w.end(&name);
                }
                self.replaced.get_or_insert(name);
                return;
            }
        }
        keep_set_cookies_of(home, &mut self.jar, &mut self.jar_domains, &mut self.cookie_meta, ex);
    }

    /// Why `req` may not be sent, for a route that came from another node: it writes, and carries a value read from the
    /// answer to a request that carried the owner's session (their account's page, their address, a token of theirs),
    /// which the owner didn't allow for this call. Someone else's write sends the caller's values, its own constants and
    /// what session-less answers said; what the owner's session read stays with the owner.
    fn carries_what_the_owners_session_read(&self, req: &Request) -> Option<String> {
        if self.owner.is_none() || self.session_reads_approved {
            return None;
        }
        let step = self.steps.get(&req.exchange).filter(|s| crate::ledger::writes_as(s, true))?;
        let read = step.fields.iter().find_map(|f| match &f.class {
            Class::Derived { origin } if self.under_owner.contains(&origin.exchange) => Some((f.loc.clone(), origin.url.clone())),
            _ => None,
        })?;
        Some(format!(
            "this write ({} {}) would send, at {}, what {} answered under the owner's session: a route that came from another node sends that only when the owner allows the call",
            step.method,
            req.url.path(),
            read.0,
            read.1
        ))
    }

    /// The call's end, once an answer replaced the owner's session: said as the rule's refusal, so the route is not
    /// healed or retried on the session the site just changed.
    fn ended(&self) -> Option<String> {
        self.replaced.clone().or_else(|| self.transport.within.as_ref().and_then(Within::ended)).map(|name| {
            format!("the site replaced the session this call was sent with (its {name} cookie): a route that came from another node never changes whose session the owner's node runs in, so the call stops here")
        })
    }
}

/// [`Runner::may_send`] as one rule: anything for the node's own route (`owner` None); for a route that came from another
/// node, everything once the owner allowed it to act in their session, else only a value the owner's jar held, as it
/// held it, when the call began.
fn sendable(owner: Option<&HashMap<String, String>>, allowed: bool, name: &str, value: &str) -> bool {
    owner.is_none_or(|o| allowed || o.get(name).is_some_and(|v| v == value))
}

/// Whether `req` carries a value of the owner's session: a cookie of theirs in its cookie header, or a token of theirs
/// in the header named for it.
fn sends_the_owners_session(owner: &HashMap<String, String>, req: &Request) -> bool {
    req.headers.iter().any(|(k, v)| {
        if k.eq_ignore_ascii_case("cookie") {
            v.split(';').filter_map(|p| p.split_once('=')).any(|(n, v)| owner.get(n.trim()).is_some_and(|o| o == v.trim()))
        } else {
            owner.iter().any(|(n, o)| n.eq_ignore_ascii_case(k) && o == v)
        }
    })
}

/// The cookies of a jar a request was sent with, as [`Runner::with_session_cookies`] sends them: what an answer to it
/// replaces when it sets one of them again.
struct Sent<'a> {
    /// The scheme the jar was kept for: its cookies go on it alone, and only in a secure context.
    scheme: &'a str,
    home: &'a str,
    jar: &'a HashMap<String, String>,
    domains: &'a HashMap<String, String>,
    meta: &'a HashMap<String, CookieMeta>,
    not_cookies: &'a HashSet<String>,
}

impl Sent<'_> {
    /// Whether the jar's cookie `name` goes with a request to `url`, as a browser sends what it holds: the session's own
    /// host, or another host of its site the cookie's recorded `Domain` reaches; a path its recorded `Path` covers (a
    /// cookie whose path was never recorded is a root-path one); the scheme the jar was kept for and a secure context
    /// only; never after the life its line gave it; never a token that isn't a cookie. The one reader of where a jar
    /// cookie goes: the call's requests, the start page and a page's script ask it alike.
    fn goes_to(&self, name: &str, url: &url::Url) -> bool {
        let Some(host) = url.host_str() else { return false };
        let path = self.meta.get(name).map_or("/", |m| m.path.as_str());
        let on_path = crate::http::path_matches(if path.starts_with('/') { path } else { "/" }, url.path());
        let secure = url.scheme() == self.scheme && secure_context(url);
        self.jar.contains_key(name) && self.reaches(name, host) && on_path && secure
    }

    /// Whether the jar's cookie `name` is one a browser holds for `host`, whatever the path: the session's own host,
    /// or another host of its site its recorded `Domain` reaches, unexpired, and a cookie, not a token. What an answer
    /// from `host` setting the cookie again replaces.
    fn reaches(&self, name: &str, host: &str) -> bool {
        let token = self.not_cookies.contains(name) || name.ends_with("-response");
        let reaches = host.eq_ignore_ascii_case(self.home) || (crate::identity::same_site(self.home, host) && self.domains.get(name).is_some_and(|d| crate::mint::sent_to(d, host)));
        let alive = self.meta.get(name).is_none_or(|m| m.expires.is_none_or(|e| e > now_secs()));
        !token && reaches && alive
    }

    /// The first cookie of `owner`'s session the answer `ex` sets to another value or takes out, among those the request
    /// was sent with (the jar still holds the owner's value and sends it to the answering host), and that a browser
    /// would let the answer set. A cookie the call itself earned, or one the owner's jar doesn't hold, is the call's.
    fn replaced_by(&self, owner: &HashMap<String, String>, ex: &Exchange) -> Option<String> {
        let host = ex.url.host_str().unwrap_or_default();
        ex.cookie_changes_whole().into_iter().find_map(|change| {
            let was = owner.get(&change.name)?;
            if self.jar.get(&change.name) != Some(was) || !self.reaches(&change.name, host) {
                return None;
            }
            let applies = match &change.domain {
                Some(d) => crate::mint::sent_to(d, host) && crate::mint::sent_to(d, self.home),
                None => host.eq_ignore_ascii_case(self.home),
            };
            (applies && change.value.as_ref() != Some(was)).then(|| change.name.clone())
        })
    }
}

/// [`Runner::keep_set_cookies`] as one step, shared with the browserless re-mint ([`RouteClient::refresh_session`]):
/// the same rules keep a cookie whichever way the site handed it over.
///
/// The jar holds one cookie per name, where a browser can hold several of one name with different reaches or paths.
/// Its entry is always one line's value with that same line's reach, path and life, never a mix (`mint::keep_line`):
/// a line that sets the cookie the jar holds again (the same reach and path) replaces it; a line for another reach or
/// path replaces it only when it is narrower, and is otherwise not kept; HttpOnly is never loosened by either line. A
/// line that takes out a cookie takes out the jar's only when it names the same reach and path.
fn keep_set_cookies_of(home: &str, jar: &mut HashMap<String, String>, jar_domains: &mut HashMap<String, String>, meta: &mut HashMap<String, CookieMeta>, ex: &Exchange) {
    let host = ex.url.host_str().unwrap_or_default();
    let own = host.eq_ignore_ascii_case(home);
    for change in &ex.cookie_changes_whole() {
        let (name, value, domain) = (change.name.clone(), change.value.clone(), change.domain.clone());
        let reach = match domain {
            Some(d) => {
                if !crate::mint::sent_to(&d, host) || !crate::mint::sent_to(&d, home) {
                    continue; // a domain the host isn't in is refused, as a browser refuses it
                }
                // So is a public suffix: a domain off the host's own site would reach every site under it.
                let bare = d.trim_start_matches('.');
                if !bare.eq_ignore_ascii_case(host) && !crate::identity::same_site(bare, host) {
                    continue;
                }
                Some(d)
            }
            None if own => None,
            None => continue, // another host's own session is not this jar's
        };
        // The cookie the jar holds under the name, by its own line's reach and path (a record with no path is a root one).
        let held = jar.contains_key(&name).then(|| (jar_domains.get(&name).cloned(), meta.get(&name).map_or_else(root_path, |m| m.path.clone())));
        let same = held.as_ref().is_none_or(|(d, p)| crate::mint::same_scope(reach.as_deref(), &change.path, d.as_deref(), p));
        match value {
            Some(value) => {
                let narrower = held.as_ref().is_some_and(|(d, p)| crate::mint::narrower_than(reach.as_deref(), &change.path, d.as_deref(), p));
                if !same && !narrower {
                    // Another cookie of the name, reaching no less: the jar's stays, and only grows more hidden.
                    if change.http_only {
                        if let Some(m) = meta.get_mut(&name).filter(|m| m.http_only == Some(false)) {
                            m.http_only = Some(true);
                        }
                    }
                    continue;
                }
                let had = meta.get(&name).map(|m| m.http_only);
                let mut kept = CookieMeta::of(change, meta);
                if same && jar.get(&name) == Some(&value) {
                    // The same value set again: what was once hidden from a page's script stays hidden.
                    kept.http_only = kept_from_script(had.flatten(), had.is_some(), kept.http_only);
                } else if !same && had == Some(Some(true)) {
                    // A narrower cookie of the name takes the entry; the other line's HttpOnly still holds.
                    kept.http_only = Some(true);
                }
                jar.insert(name.clone(), value);
                meta.insert(name.clone(), kept);
                match reach {
                    Some(d) => {
                        jar_domains.insert(name, d);
                    }
                    None => {
                        jar_domains.remove(&name);
                    }
                }
            }
            None if same => {
                jar.remove(&name);
                jar_domains.remove(&name);
                meta.remove(&name);
            }
            None => {}
        }
    }
}

/// Notes one fallback of a call, once: the same step falling back on every retry is one thing to say.
fn said(fell_back: &std::sync::Mutex<Vec<String>>, what: String) {
    if let Ok(mut all) = fell_back.lock() {
        if !all.contains(&what) {
            all.push(what);
        }
    }
}

impl Runner {
    /// One request of the call: its session put on, every check it is held to made, the cookies its answer sets kept.
    /// `follow` says whether its redirects are followed (each hop held to the call's rule) or the redirect is the answer.
    fn send(&mut self, req: &Request, follow: bool) -> Result<Exchange, ReplayError> {
        // A session the site replaced, whether a step or the page's own code asked, ends the call before anything more
        // is sent under it.
        if let Some(why) = self.ended() {
            return Err(ReplayError::Refused(why));
        }
        if let Some(why) = self.carries_what_the_owners_session_read(req) {
            return Err(ReplayError::Refused(why));
        }
        // A route that came from another node goes nowhere but the origins its graph names (`origins_of`): the session it
        // may carry, its cookies and the tokens it names, reaches no other host, and no consent reaches past them.
        if !self.in_scope(&req.url) {
            return Err(ReplayError::Refused(format!("{} is not an origin the route names: a route that came from another node sends nothing anywhere else, another host of its site included", req.url.origin().ascii_serialization())));
        }
        let with_cookies = self.with_session_cookies(req);
        let req = &with_cookies;
        if self.owner.as_ref().is_some_and(|owner| sends_the_owners_session(owner, req)) {
            self.under_owner.insert(req.exchange);
        }
        let plain = if follow { self.transport.fetch(req)? } else { self.transport.fetch_unredirected(req)? };
        self.keep_set_cookies(&plain);
        // The request reached the site, so it may hold it: the call ends as one whose last step was sent.
        if let Some(why) = self.ended() {
            return Err(ReplayError::RefusedHop(why));
        }
        if plain.status == 403 && !self.refused_on_the_walk.contains(&req.exchange) {
            eprintln!("   [debug] step {} {} -> 403 (a wall): the browser runs it", req.exchange, req.url.path());
            // What the refused request looked like, by header name and in order: the shape a door reads. Values stay
            // out but for the ones that say which browser asks, which a door checks against the transport under them.
            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                let shape: Vec<String> = req
                    .headers
                    .iter()
                    .map(|(k, v)| if k.eq_ignore_ascii_case("user-agent") || k.to_ascii_lowercase().starts_with("sec-ch-ua") { format!("{k}={v}") } else { k.clone() })
                    .collect();
                eprintln!("   [debug] the refused request sent {shape:?}");
                // What the wall answered by: the vendor's own mark (a DataDome or Cloudflare header) and the page it
                // served, so a refusal is told apart from the site's own rule without naming a site here.
                let wall: Vec<String> = plain
                    .response_headers
                    .iter()
                    .filter(|(k, _)| matches!(k.to_ascii_lowercase().as_str(), "server" | "x-datadome" | "cf-ray" | "cf-mitigated" | "x-cache" | "x-datadome-cid"))
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect();
                let body_head: String = plain.response_body.as_deref().unwrap_or_default().chars().take(200).collect();
                eprintln!("   [debug] the 403 answered {wall:?} body={body_head:?}");
            }
        }
        if plain.status != 403 || self.refused_on_the_walk.contains(&req.exchange) {
            if plain.status >= 400 {
                eprintln!("   [debug] step {} {} -> {} ({} bytes sent)",
                    req.exchange, req.url.path(), plain.status,
                    req.body.as_ref().map_or(0, Vec::len));
            }
            return Ok(plain);
        }
        // The site walls this step: the browser runs it, in the site's own origin. Each request goes this way by itself:
        // the chunks of an upload share an exchange, and each has its own bytes to send. A browser that failed may have
        // sent the request first, so it fails as a request that may have left, never as one that couldn't be made.
        let allowed = self.on_the_routes_site(req.url.as_str());
        // A request the page itself made in the node's browser this run, refused as a copy: the page was answered,
        // and its answer is the call's. Nothing is sent again.
        let key = page_call_key(&req.method, req.url.as_str(), req.body.as_deref());
        let the_pages_own = the_pages_call(&self.signed.borrow(), &key).is_some();
        let Some(mint) = self.browser.as_mut() else { return Ok(plain) };
        if !allowed {
            return Ok(plain);
        }
        if the_pages_own {
            if let Some(answered) = mint.answered_on_page(&|method, url, body| page_call_key(method, url, body.map(str::as_bytes)) == key) {
                self.used_browser.store(true, std::sync::atomic::Ordering::Relaxed);
                self.reached.set(crate::rung::Rung::Browser);
                said(&self.fell_back, format!("{} refused a copy of the page's own request, so the answer the page got in the node's browser is the call's", req.url.path()));
                self.walled.insert(req.exchange);
                return Ok(answered);
            }
        }
        self.used_browser.store(true, std::sync::atomic::Ordering::Relaxed);
        self.reached.set(crate::rung::Rung::Browser);
        said(&self.fell_back, format!("{} answered 403 to a plain request, so the node's browser made that step", req.url.path()));
        let ex = mint.execute(req).map_err(|e| ReplayError::Transport(format!("browser step: {e}")))?;
        self.walled.insert(req.exchange);
        // The browser follows the site's redirects itself: where it landed is held to the call's rule, and an answer
        // from an address the route doesn't name is not handed back.
        if let Some(w) = &self.transport.within {
            w.admits(&ex.url).map_err(ReplayError::RefusedHop)?;
        }
        // The browser's answer is held to the same rule as the plain one's: it never replaces the owner's session.
        if let (Some(owner), Some(sent)) = (self.owner.as_ref(), self.held()) {
            if let Some(name) = sent.replaced_by(owner, &ex) {
                if let Some(w) = &self.transport.within {
                    w.end(&name);
                }
                self.replaced.get_or_insert(name);
                return Err(ReplayError::RefusedHop(self.ended().unwrap_or_default()));
            }
        }
        Ok(ex)
    }
}

impl Fetch for Runner {
    /// The request alone, its redirect the answer: sent as every request of the call is (its session, its checks, the
    /// cookies it is set kept), over the call's transport (`Held`), which holds its one address to the call's rule. A
    /// step whose redirect a later step reads (a sign-in's flow id in the address it hands over) is sent so.
    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.send(req, false)
    }

    fn allows(&self, req: &Request) -> Result<(), ReplayError> {
        self.transport.allows(req)
    }

    fn browser_made(&self, exchange: usize) -> bool {
        self.walled.contains(&exchange)
    }

    /// The page's own scripts, run again: booted at the route's page with the caller's values in its address, the
    /// page's code builds and signs the call, and the headers it sets are the answer. A route with no scripts (or a
    /// machine with no signing runtime) says so, and the step goes to the browser.
    fn environment(&self) -> crate::generated::Environment {
        crate::generated::Environment {
            fingerprint: self.fingerprint.clone(),
            storage: self.storage.clone(),
            page_url: self.page.clone(),
            html: self.page_html.clone(),
            answers: self.answers.clone(),
            scripts: self.scripts.iter().map(|s| (s.url.clone(), s.body.clone())).collect(),
        }
    }

    /// The page's own call for `req` (`signed_by_the_page`), kept only where it asks what `req` asks: each caller's
    /// value `req` carries is in the call the page made (`carries_the_values`). A page whose call asks another value
    /// (the page as walked, its address unable to carry this value; a visit of the browser's that read another
    /// visit's page) signs another request: its answer is that value's, whenever it runs, and the step is walled.
    fn sign_request(&mut self, req: &Request, inputs: &HashMap<String, String>) -> Option<crate::sandbox::Signed> {
        let signed = self.signed_by_the_page(req, inputs)?;
        match carries_the_values(req, inputs, &signed) {
            Ok(()) => Some(signed),
            Err(value) => {
                eprintln!("   [sign] the page's call at {} {} does not ask {value:?}, which this request asks: another value's call", req.method, req.url.path());
                said(&self.fell_back, "the page's own call asked another value than this request, so it was not sent".to_string());
                None
            }
        }
    }

    /// What the call fell back on, said where the reply carries it: a step the page's own code made nothing for, sent
    /// as the route builds it (`replay::run`'s read of [`Fetch::sign_request`]'s None).
    fn fell_back(&mut self, why: String) {
        said(&self.fell_back, why);
    }

    /// What the store holds of a session step's cookies, when it holds them all. A jar short of any leaves the step to
    /// run for real, and earn them: there is nothing to serve, and nothing to say the step answered.
    fn session_values(&mut self, exchange: usize) -> Option<Vec<(String, String)>> {
        let names = self.session_steps.get(&exchange)?;
        names.iter().map(|n| self.jar.get(n).map(|v| ("set-cookie".to_string(), format!("{n}={v}; Path=/")))).collect()
    }

    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.send(req, true)
    }
    /// A session value for a step to place anywhere but the cookie header (a header token, or wherever a body's hole
    /// asks). A route that came from another node places a cookie only in the cookie header ([`Self::minted_cookie`]):
    /// a name the jar knows as a cookie (a line set it, or a browser recorded its path or reach) is never handed to it
    /// here, so the owner's session never rides in a form, query, JSON field or header someone else's route chose. Its
    /// header tokens still go (audit 1118 M7).
    fn minted(&self, name: &str) -> Option<String> {
        if self.egress != crate::egress::Egress::Own && (self.cookie_meta.contains_key(name) || self.jar_domains.contains_key(name)) {
            return None;
        }
        self.jar.get(name).filter(|v| self.may_send(name, v)).cloned()
    }

    fn stored(&self, area: unbrowse_route::expr::Area, key: &str) -> Option<String> {
        let kept = match area {
            unbrowse_route::expr::Area::Local => &self.storage.local,
            unbrowse_route::expr::Area::Session => &self.storage.session,
        };
        kept.get(key).cloned()
    }

    /// A cookie from the jar goes to the jar's own host, and down its site wherever the cookie's recorded `Domain`
    /// reaches, as [`Runner::with_session_cookies`] sends them: a step that names the clearance finds it on the
    /// subdomain it sits on, so it never has to be walked. A step to any other host — another site, or a host
    /// built at call time — never draws the session's cookie by naming one.
    fn minted_cookie(&self, name: &str, host: Option<&str>) -> Option<String> {
        let (Some((_, home)), Some(to)) = (self.home.as_ref(), host) else { return None };
        // The session's own host always draws it; another host only where the cookie's recorded Domain reaches it,
        // on the jar's own site (`same_site`), and never a host built at call time.
        let reaches = crate::identity::same_site(home, to) && self.jar_domains.get(name).is_some_and(|d| crate::mint::sent_to(d, to));
        if !to.eq_ignore_ascii_case(home) && !reaches {
            return None;
        }
        // And for a route that came from another node, only a host one of its origins is on.
        if self.transport.within.as_ref().is_some_and(|w| !w.names_host(to)) {
            return None;
        }
        self.jar.get(name).filter(|v| self.may_send(name, v)).cloned()
    }
}

/// The steps that exist only to carry the session, by exchange, with the cookies they serve: everything downstream
/// takes from their answer is a cookie, so the store serves those values (fresh from the last mint) and the step never
/// touches the network, and an ads endpoint whose body the capture lost can't break the route. A step that carries the
/// caller's own value does more than that (`graph::reaches_the_answer`): skipped, the value would never reach the site.
/// So does a step the ledger marks, which is a write the route exists to make: `judged` as [`Ledger::of_route`]. So
/// does any write the node can send: the cookie it answers with is the state it made, and the jar's copy is the state
/// a previous call made. Only a write whose body the capture lost is left to the store, having no other way to run:
/// one that answered with a cookie before the route's last write, though the ledger marks it. Served from the store it
/// is never sent, so its mark stays unsent.
fn session_steps(graph: &Graph, judged: bool) -> HashMap<usize, Vec<String>> {
    let marked = Ledger::of_route(graph, judged);
    let last_write = graph.steps.iter().rposition(crate::ledger::writes);
    let mut steps: HashMap<usize, Vec<String>> = HashMap::new();
    for (n, step) in graph.steps.iter().enumerate() {
        let sendable_write = crate::ledger::writes(step) && !matches!(step.body, Some(crate::graph::Body::Other));
        let sets_the_session = crate::ledger::writes(step) && step.sets_cookie && last_write != Some(n);
        let commit = marked.marks.iter().any(|m| m.step == n + 1) && !sets_the_session;
        if sendable_write || crate::graph::carries_the_caller(step) || commit {
            continue;
        }
        let mut serves: Vec<String> = Vec::new();
        let mut only_session = true;
        for later in graph.steps.iter().skip(n + 1) {
            for f in &later.fields {
                if let crate::graph::Class::Derived { origin } = &f.class {
                    if origin.exchange == step.exchange {
                        match (&f.loc, &origin.at) {
                            (crate::slots::Loc::Cookie(name), crate::provenance::At::SetCookie { .. }) => serves.push(name.clone()),
                            _ => only_session = false,
                        }
                    }
                }
            }
        }
        if only_session && !serves.is_empty() {
            steps.insert(step.exchange, serves);
        }
    }
    steps
}

/// A heal's fresh session in the jar. Its tokens are the route's; its cookies are the ones the browser sends to the
/// walked root's host, so they are this jar's only when the root is the jar's own host: another host's cookies never
/// enter it, and so are never sent where the jar's are. The cookies' recorded reach (`domains`) is part of the
/// session and joins with the cookies it describes, never without them.
///
/// The walk's cookies are all the browser holds for the host, so a cookie it no longer holds leaves the jar, as
/// `mint::jar_with` has it: the route's own tokens (`not_cookies`) aren't cookies and stay. A walk that reports no
/// cookie at all says nothing either way.
fn merge_sighting(
    jar: &mut HashMap<String, String>,
    jar_host: Option<&str>,
    root: &str,
    session: crate::mint::MintedSession,
    not_cookies: &HashSet<String>,
    domains: &mut HashMap<String, String>,
) {
    let root_host = url::Url::parse(root).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()));
    // The walk's cookies stand for the jar's when it has any, or when its browser was asked and holds none: the site's
    // ending of a session is news as much as a new one.
    if root_host.is_some() && root_host.as_deref() == jar_host && (!session.cookies.is_empty() || session.judged) {
        jar.retain(|k, _| not_cookies.contains(k) || session.tokens.contains_key(k) || k.ends_with("-response"));
        // Each cookie the walk handed over comes with its own line's reach, the host alone when it named none: a value
        // never keeps the reach an older value of the name had.
        for name in session.cookies.keys() {
            match session.domains.get(name) {
                Some(d) => {
                    domains.insert(name.clone(), d.clone());
                }
                None => {
                    domains.remove(name);
                }
            }
        }
        jar.extend(session.cookies);
        // A cookie that left the jar leaves the record of how far it went.
        domains.retain(|k, _| jar.contains_key(k));
    }
    jar.extend(session.tokens);
}

/// One save at a time, process-wide: a save reads the jar, changes it and writes it back.
static JAR_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The jar to write when a client that read `loaded` holds `now` and the file holds `on_disk`: what the client changed
/// since it read, on top of the file. A session someone dropped since then (the file gone that was there) stays
/// dropped: None, nothing is written.
fn jar_after(on_disk: Option<HashMap<String, String>>, loaded: Option<&HashMap<String, String>>, now: &HashMap<String, String>) -> Option<HashMap<String, String>> {
    if loaded.is_some() && on_disk.is_none() {
        return None;
    }
    let mut jar = on_disk.unwrap_or_default();
    let was = |k: &String| loaded.and_then(|l| l.get(k));
    jar.extend(now.iter().filter(|(k, v)| was(k) != Some(*v)).map(|(k, v)| (k.clone(), v.clone())));
    if let Some(l) = loaded {
        jar.retain(|k, _| now.contains_key(k) || !l.contains_key(k));
    }
    Some(jar)
}

/// Whether the cookie a door issues is in the jar and still inside the life its line gave (`Max-Age`): a refusal then
/// is not the credential's absence, and a browser would earn the same cookie again for the same call. A cookie with no
/// expiry is a session cookie: alive while the jar is.
fn holds_the_credential(jar: &HashMap<String, String>, meta: &HashMap<String, CookieMeta>, door: &crate::graph::Door) -> bool {
    let Some(name) = door.credential.as_deref() else { return false };
    if !jar.contains_key(name) {
        return false;
    }
    match meta.get(name).and_then(|m| m.expires) {
        Some(at) => at > now_secs(),
        None => true,
    }
}

/// The route's own tokens: the jar entries its steps send anywhere but a cookie.
fn minted_tokens(graph: &Graph) -> HashSet<String> {
    graph
        .steps
        .iter()
        .flat_map(|s| &s.fields)
        .filter_map(|f| match &f.class {
            crate::graph::Class::Minted { name } if !matches!(f.loc, Loc::Cookie(_)) => Some(name.clone()),
            _ => None,
        })
        .collect()
}

/// Where the reach of a jar's cookies is kept, beside the jar itself: one file per jar, holding each cookie's
/// `Domain` when the site set it for more than one host. The suffix keeps it out of the jar's own name, so nothing
/// that reads `jars/<host>.json` ever reads this by mistake.
pub fn scope_path(dir: &std::path::Path, jar_name: &str) -> PathBuf {
    dir.join(format!("{jar_name}.json.scope"))
}

/// What the page had in front of it when the session was minted — its `localStorage` and `sessionStorage` — kept
/// beside the jar. A signing bridge boots the page's own scripts with it (see [`crate::sandbox::Storage`]).
pub fn storage_path(dir: &std::path::Path, jar_name: &str) -> PathBuf {
    dir.join(format!("{jar_name}.json.storage"))
}

/// What each cookie's line said about it beyond its value, kept beside the jar. A browser sends a request's cookies
/// longest-path first and then oldest first, and a site that binds a token to a request reads that order; the jar
/// alone (names and values) can't say it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CookieMeta {
    /// The path it goes to. A record written before paths were kept has none and reads as `/`, the widest: such a
    /// cookie goes to every path of its host until a line or a walk records its own (SECURITY.md, "What isn't
    /// defended").
    #[serde(default = "root_path")]
    pub path: String,
    /// When it runs out, in Unix seconds, from the line's `Max-Age`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    /// The client that earned it (`refusal::identity_of`), where one is known: a pass a source cleared a wall with is
    /// that client's. None for a cookie the site simply set, which is whoever's it was sent to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_to: Option<String>,
    /// When in this jar's life the cookie arrived: the tie-break among cookies of one path.
    #[serde(default)]
    pub order: u64,
    /// Whether the cookie is kept from a page's script (`HttpOnly`), as its line or the browser said. None where
    /// neither was seen (a jar written before this was kept): treated as HttpOnly, so a page's script never reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
}

impl CookieMeta {
    /// Whether a page's script may read the cookie (`document.cookie`): only when it is known not to be HttpOnly.
    pub fn shown_to_script(&self) -> bool {
        self.http_only == Some(false)
    }
}

/// Puts what a browser knew of each cookie the jar holds (its path, whether it is HttpOnly) into the jar's metadata. A
/// cookie new to the metadata goes after every one already there, as one just set does. `before` is the jar as it was
/// before these facts' values joined it: a cookie whose value didn't change keeps what was known of it, only ever more
/// hidden ([`kept_from_script`]).
fn note_facts(meta: &mut HashMap<String, CookieMeta>, facts: &HashMap<String, agent_browser_core::session::CookieFacts>, jar: &HashMap<String, String>, before: &HashMap<String, String>) {
    // A value that changed with nothing said of its line keeps nothing of the old value's line: its path and HttpOnly
    // are unknown (a root path, hidden from script), never another cookie's.
    meta.retain(|name, _| facts.contains_key(name) || before.get(name) == jar.get(name) || !jar.contains_key(name));
    for (name, f) in facts.iter().filter(|(k, _)| jar.contains_key(*k)) {
        let same = before.get(name).is_some() && before.get(name) == jar.get(name);
        let had = meta.get(name).map(|m| m.http_only);
        let next = meta.values().map(|m| m.order).max().unwrap_or(0) + 1;
        let m = meta.entry(name.clone()).or_insert_with(|| CookieMeta { path: root_path(), expires: None, order: next, http_only: None, bound_to: None });
        if f.path.starts_with('/') {
            m.path = f.path.clone();
        }
        m.http_only = if same { kept_from_script(had.flatten(), had.is_some(), Some(f.http_only)) } else { Some(f.http_only) };
        if !same {
            // A new value lives as long as its own line says.
            m.expires = f.expires;
        }
    }
}

/// What a cookie's HttpOnly is once a line or a browser says `said` of the same value the jar already held, when what
/// was known of it was `had` (`known`: whether there was any record at all). What was once hidden from a page's script
/// stays hidden for that value: a known HttpOnly stays so, and a value whose HttpOnly was never known stays unknown,
/// which is hidden too. Only a value known to be readable takes what the new word says. A new value is a new cookie, and
/// takes its own line's word, as a browser does.
fn kept_from_script(had: Option<bool>, known: bool, said: Option<bool>) -> Option<bool> {
    match (known, had) {
        (true, Some(false)) => said,
        (true, h) => h,
        (false, _) => None,
    }
}

/// Writes what a walk's browser knew of the cookies it handed the jar `jar_name` (their paths, which are HttpOnly)
/// beside the jar, in its metadata file: a call then sends each where the browser would, and a page's script is shown
/// only what the browser would show it.
pub fn note_cookie_facts(dir: &std::path::Path, jar_name: &str, facts: &HashMap<String, agent_browser_core::session::CookieFacts>, before: &HashMap<String, String>) {
    let path = meta_path(dir, jar_name);
    if facts.is_empty() || unbrowse_files::JAR.writable(&path).is_err() {
        return;
    }
    let jar: HashMap<String, String> = unbrowse_files::JAR.read_at(&dir.join(format!("{jar_name}.json"))).ok().flatten().unwrap_or_default();
    let mut meta: HashMap<String, CookieMeta> = unbrowse_files::JAR.read_at(&path).ok().flatten().unwrap_or_default();
    note_facts(&mut meta, facts, &jar, before);
    meta.retain(|k, _| jar.contains_key(k));
    if let Ok(json) = unbrowse_files::JAR.to_vec_pretty(&meta) {
        let _ = unbrowse_files::private::write(&path, &json);
    }
}

fn root_path() -> String {
    "/".to_string()
}

impl CookieMeta {
    /// The metadata a line gives a cookie it sets: its path, its expiry, and where in the jar's order it stands
    /// (after everything already there).
    fn of(change: &crate::trace::CookieChange, meta: &HashMap<String, CookieMeta>) -> Self {
        // A cookie set again keeps the place it first had: a browser updates a cookie's value and life in place,
        // it does not move it to the end of the order.
        let order = meta.get(&change.name).map_or_else(|| meta.values().map(|m| m.order).max().unwrap_or(0) + 1, |m| m.order);
        CookieMeta { path: change.path.clone(), expires: change.expires, order, http_only: Some(change.http_only), bound_to: None }
    }
}

/// What the page's own code saw when it fingerprinted the browser, kept beside the jar: a signing bridge puts it in
/// front of the page's scripts.
pub fn fingerprint_path(dir: &std::path::Path, jar_name: &str) -> PathBuf {
    dir.join(format!("{jar_name}.json.fp"))
}

/// Where a jar's cookie metadata is kept, beside the jar and its scope: `.json.meta`, a suffix that keeps it out of
/// the jar's own name.
pub fn meta_path(dir: &std::path::Path, jar_name: &str) -> PathBuf {
    dir.join(format!("{jar_name}.json.meta"))
}

/// The name a route's session jar is kept under: its target's host, and never its port. A cookie knows no port (a
/// browser sends a host's cookies to every port of it), and a walk keeps the session it earned under the host it
/// walked: a route on a named port reads that same jar, or its calls would never find what its own walk was given.
/// The hosts of `host`'s site that the session store keeps a jar for, `host` itself left out.
fn other_jars_of_the_site(dir: &std::path::Path, host: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json").map(String::from))
        .filter(|h| !h.eq_ignore_ascii_case(host) && !h.contains(".json") && crate::identity::same_site(h, host))
        .collect();
    out.sort();
    out
}

/// Whether a cookie `other`'s jar keeps with the recorded reach `domain` is sent to `host` too: set for a domain (the
/// recorded reach begins with a dot), and one both hosts are under, as a browser sends it.
fn reaches_another_host(domain: &str, other: &str, host: &str) -> bool {
    domain.starts_with('.') && crate::mint::sent_to(domain, other) && crate::mint::sent_to(domain, host)
}

pub fn jar_name(graph: &Graph) -> Option<String> {
    graph.steps.last().map(|s| {
        let authority = s.url.split('/').nth(2).unwrap_or("site");
        let scheme = s.url.split(':').next().unwrap_or("https");
        url::Url::parse(&format!("{scheme}://{authority}/")).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| authority.to_string())
    })
}

/// What a caller that asks the site as a route's own client does, without being one (the node's check of a route it
/// learned, over `lab::site::Live`), sends over and with: the transport a [`RouteClient`] of `graph` builds for a
/// call — Chrome-shaped, held to `egress` and to the node's local proxy where the route's host is pinned to it,
/// presenting the browser the session store's fingerprint sample names, or `walked` (the walk's own user agent) where
/// the store keeps no sample that names one — and the session it holds in `store`, by name: its cookies and the
/// tokens it keeps beside them. One reading of the session store for both.
pub fn as_its_client(graph: &Graph, store: &std::path::Path, egress: crate::egress::Egress, walked: Option<&str>) -> Result<(crate::http::ChromeFetch, HashMap<String, String>), ReplayError> {
    let host = jar_name(graph);
    let transport = presenting(host.as_deref(), store, egress, walked)?;
    let mut jar: HashMap<String, String> = host.as_deref().and_then(|h| unbrowse_files::JAR.read_at(&store.join(format!("{h}.json"))).ok().flatten()).unwrap_or_default();
    // What the page kept in its storage is the session's too: the lab's caller reads it from the same map, each value
    // under its store's name for it (`Area::held_as`), which no cookie's or header's name can be.
    let storage: crate::sandbox::Storage = host.as_deref().and_then(|h| unbrowse_files::JAR.read_at(&storage_path(store, h)).ok().flatten()).unwrap_or_default();
    jar.extend(storage.local.into_iter().map(|(k, v)| (unbrowse_route::expr::Area::Local.held_as(&k), v)));
    jar.extend(storage.session.into_iter().map(|(k, v)| (unbrowse_route::expr::Area::Session.held_as(&k), v)));
    Ok((transport, jar))
}

/// The transport a request to `host` goes out over, built as a route's own client builds it: Chrome-shaped, held to
/// `egress` and to the node's local proxy where `host` is pinned to it, presenting the browser the session store's
/// fingerprint sample names, or `walked` (the walk's own user agent) where the store keeps no sample that names one.
/// A request the node makes of a site a walk has seen (a probe of the site's own pages, a check of a route) asks
/// with the browser that walk presented, never with the transport's default, which matches it only by chance.
pub fn presenting(host: Option<&str>, store: &std::path::Path, egress: crate::egress::Egress, walked: Option<&str>) -> Result<crate::http::ChromeFetch, ReplayError> {
    let proxy = host.and_then(crate::proxy::pinned).and(crate::proxy::local_url());
    let fingerprint: serde_json::Value = host.and_then(|h| unbrowse_files::JAR.read_at(&fingerprint_path(store, h)).ok().flatten()).unwrap_or(serde_json::Value::Null);
    let named = fingerprint.get("ua").and_then(|u| u.as_str()).is_some_and(|u| !u.trim().is_empty());
    let transport = crate::http::ChromeFetch::held_to_proxy(egress, proxy.as_deref())?;
    Ok(match walked.filter(|_| !named) {
        Some(agent) => transport.as_sampled(&fingerprint).with_identity(agent),
        None => transport.as_sampled(&fingerprint),
    })
}

/// The origin (scheme, host and port) of a URL or a step's URL template, as text.
fn origin_of(url: &str) -> String {
    let mut parts = url.splitn(4, '/');
    let (scheme, _, authority) = (parts.next().unwrap_or_default(), parts.next(), parts.next().unwrap_or_default());
    match url::Url::parse(&format!("{scheme}//{authority}/")) {
        Ok(u) => u.origin().ascii_serialization(),
        Err(_) => format!("{scheme}//{authority}"),
    }
}

/// Whether a request goes where a browser sends a Secure cookie: over TLS, or to this machine itself.
/// The clock the cookie's expiry and a browser's own are read on.
fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

pub fn secure_context(url: &url::Url) -> bool {    if matches!(url.scheme(), "https" | "wss") {
        return true;
    }
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost") || d.to_ascii_lowercase().ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Whether a call in a heal's fresh walk is the route's target again: the same method, on the route's own origin,
/// at a path that still holds the route's distinctive fragment. A call on another host the page also made is never
/// it, however its path reads.
/// What signs a site in again: the session it earned, or None when it didn't.
pub type SignIn = Box<dyn FnMut() -> Option<HashMap<String, String>> + Send>;

/// A way the node clears a wall for a call (`RouteClient::with_clearer`): given the wall, the pass it earned, or None.
pub type Clearer = Box<dyn FnMut(&crate::refusal::Wall) -> Option<crate::refusal::Cleared> + Send>;

/// A source, as the agent is told of it.
fn said_source(source: crate::refusal::Source) -> &'static str {
    use crate::refusal::Source::*;
    match source {
        Wait => "waiting",
        Page => "the site's own page",
        Sandbox => "the check's own script, run in the sandbox",
        OwnerSession => "the owner's own browser session",
        Engine => "the node's engine running the page",
        SignIn => "the owner's saved sign-in",
        Solver => "the configured solver",
        Owner => "the owner",
    }
}

/// Whether an answer says the session is gone, rather than that the site moved: a refusal, a value only a session
/// holds, or a page that isn't the answer (a sign-in the site sent the call to). A challenge is the site checking the
/// caller, not the session: signing in again answers nothing, and it spends the owner's login.
fn session_gone(e: &ReplayError) -> bool {
    matches!(e, ReplayError::Failed { status: 401 | 403, .. } | ReplayError::MissingMinted(_) | ReplayError::NotAnAnswer { challenge: false, .. })
}

/// Whether a fresh walk of the route's page could mend this failure. A value the caller didn't give, a file it named
/// wrongly, a request or a redirect the call's rule refused and an address that can't be made are the same after any
/// walk, and a site answering 5xx is down rather than moved. 503 is the exception: it is how a door refuses
/// (`Trace::door`).
fn a_walk_can_mend(e: &ReplayError) -> bool {
    match e {
        ReplayError::MissingInput(_) | ReplayError::File { .. } | ReplayError::BreaksBody { .. } | ReplayError::BadUrl(_) | ReplayError::Refused(_) | ReplayError::RefusedHop(_) => false,
        // A walk can't mend a browser that failed, a network that failed, or a wall: a fresh sighting is the same
        // browser and the same wall. Those are reported, not re-learned. A step the page no longer makes is different:
        // a fresh walk finds the call the page makes now.
        ReplayError::Transport(_) | ReplayError::Http(_) | ReplayError::Door { .. } => false,
        ReplayError::Failed { status, .. } => *status < 500 || *status == 503,
        _ => true,
    }
}

/// Whether a failure says the site drifted: it answered, and not as it did when the route was learned. A step
/// refused as malformed or no longer there (a 4xx other than a session's 401 and 403, and other than 429, a site out
/// of asks), an answer that is none and is not a challenge, an answer in another shape, a value no longer where an
/// earlier answer had it. Not a wall, a door (a 503 is how one refuses), a challenge, a session that ended, a
/// transport that failed, a site out of asks or down, nor anything the caller or the call's rule got wrong.
fn a_drift(e: &ReplayError) -> bool {
    match e {
        ReplayError::Failed { status, .. } => (400..500).contains(status) && !matches!(status, 401 | 403 | 429),
        ReplayError::NotAnAnswer { challenge, .. } => !challenge,
        ReplayError::ShapeMismatch { .. } | ReplayError::SourceMissing { .. } => true,
        _ => false,
    }
}

#[cfg(test)]
mod apart_tests {
    use super::*;

    fn whole(at: &std::path::Path) -> Option<Graph> {
        serde_json::from_slice(&std::fs::read(at).ok()?).ok()
    }

    /// A graph read without its page's code (a listing's, UNB-139) writes none of it and takes it back from its file
    /// whenever it runs, made into a client directly or through a body set beside it.
    #[test]
    fn a_graph_read_apart_runs_with_its_page_code() {
        crate::graph::set_rejoin(whole);
        let dir = std::env::temp_dir().join(format!("unbrowse-apart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let at = dir.join("graph.json");
        let script = crate::signing::Script { url: "https://shop.example/app.js".into(), body: "function sign(){}".into() };
        let graph = Graph { scripts: vec![script.clone()], page_html: Some("<html>kept</html>".into()), ..Graph::default() };
        std::fs::write(&at, serde_json::to_vec(&graph).unwrap()).unwrap();

        let mut light = graph.clone();
        assert!(light.set_apart(&at));
        let said = serde_json::to_string(&light).unwrap();
        assert!(!said.contains("function sign") && !said.contains("kept"), "a graph read apart writes none of its code: {said}");

        let client = RouteClient::new(light.clone());
        assert_eq!(client.graph.scripts, vec![script.clone()], "a client runs with the page's code");
        assert_eq!(client.graph.page_html.as_deref(), Some("<html>kept</html>"));
        assert!(client.graph.apart.is_none());

        let beside = crate::body::skeleton_beside(&crate::body::from_graph(&light, "shop.example"), &light);
        assert_eq!(RouteClient::new(beside).graph.scripts, vec![script], "and so does one made from its body");

        let mut plain = Graph::default();
        assert!(!plain.set_apart(&at) && plain.apart.is_none(), "a graph with no code is left whole");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod heal_tests {
    use super::*;

    /// A drift is the site answering otherwise than it did: a step refused or gone, an answer that is none or of
    /// another shape, a value no longer where it was. A wall, a door, a challenge, a session, a transport, a site out
    /// of asks or down are not, and neither is what a caller or the call's rule got wrong.
    #[test]
    fn a_drift_is_the_site_answering_otherwise_and_never_a_wall_a_door_or_a_site_out_of_asks() {
        let failed = |status: u16| ReplayError::Failed { step: 1, url: "https://shop.example/api".into(), status, body: String::new() };
        let not_an_answer = |challenge: bool| ReplayError::NotAnAnswer { status: 200, why: "no answer".into(), challenge };
        for drift in [failed(400), failed(404), failed(410), failed(422), not_an_answer(false), ReplayError::ShapeMismatch { expected: Value::Null, got: Value::Null }, ReplayError::SourceMissing { step: 1, url: String::new(), loc: crate::slots::Loc::Url }] {
            assert!(a_drift(&drift), "{drift}");
        }
        let door = crate::graph::Door::answered(&Exchange { method: "GET".into(), url: "https://shop.example/".parse().unwrap(), request_headers: Vec::new(), request_body: None, status: 403, response_headers: Vec::new(), response_body: Some("<html>checking your browser</html>".into()), response_mime: "text/html".into(), resource_type: None, main_frame: Some(true) });
        let mut not = vec![failed(401), failed(403), failed(429), failed(500), failed(503), not_an_answer(true), ReplayError::Transport("EOF".into()), ReplayError::MissingInput("q".into()), ReplayError::Refused("rule".into()), ReplayError::MissingMinted("token".into()), ReplayError::NeedsBrowser { step: 1, url: String::new(), loc: crate::slots::Loc::Url }];
        not.extend(door.map(|door| ReplayError::Door { step: 1, url: String::new(), status: 403, door, wall: None }));
        for kept in not {
            assert!(!a_drift(&kept), "{kept}");
        }
    }

    /// A browser that failed, a network that failed, or a wall is not a drift a fresh walk mends: a walk would meet
    /// the same browser and the same wall. A step the page no longer makes is a walk's to find, and so is a value that
    /// moved.
    #[test]
    fn a_wall_or_a_failed_browser_is_not_a_walk_away() {
        assert!(!a_walk_can_mend(&ReplayError::Transport("browser step: EOF".into())));
        assert!(a_walk_can_mend(&ReplayError::NeedsBrowser { step: 1, url: "https://shop.example/".into(), loc: crate::slots::Loc::Url }));
        assert!(a_walk_can_mend(&ReplayError::SourceMissing { step: 1, url: "https://shop.example/".into(), loc: crate::slots::Loc::Url }));
        assert!(a_walk_can_mend(&ReplayError::Failed { step: 1, url: "https://shop.example/".into(), status: 422, body: String::new() }));
    }
}

/// Whether the target may be tried alone, on what the jar already holds. Not when the steps before it do something a
/// warm jar can't stand in for:
/// - an upload, or an id made up for the call: the target names a file the earlier steps send, under an id they make;
/// - a step that changes what the site holds, which skipped is a write the caller was told happened;
/// - a target that writes on a cookie an earlier write gave it: alone it falls back to the jar's copy, the state a
///   previous call left, and a checkout goes through on the last cart.
///
/// - a step before it that sends the caller's value on to the answer (a search the session keeps, read back by a
///   target that names nothing of it): alone, the target answers the search the session last held.
///
/// A step that sends a secret is a sign-in, the case this path exists for: a warm jar is what it would earn.
/// The route's page with the caller's values in its address: in each `{name}` it holds, and in each query value whose
/// key is an input's name (a page kept as the address it was walked on, `?acity=kul`, still says what the page asks
/// for in that key). Else a page whose code signs the call would sign the walk's search, not the caller's.
impl Runner {
    /// The call the page's own code makes for `req`: in the sandbox, else in the browser the node runs.
    fn signed_by_the_page(&mut self, req: &Request, inputs: &HashMap<String, String>) -> Option<crate::sandbox::Signed> {
        let Some(page) = self.page.as_deref() else { eprintln!("   [sign] no page on the route"); return None };
        if self.scripts.is_empty() { eprintln!("   [sign] no scripts on the route"); }
        let walked_page = page.to_string();
        let page = page_with(page, inputs);
        // A page opened for a value the walk never asked: the data the walk's page read is that page's (its own city,
        // its own query), and handing it back would have the page's code sign the walked value again. Ask the site for
        // what this page reads instead (trip.com's flight list answered the walked city for every value before this).
        let for_another_value = page != walked_page;
        let key = page_call_key(&req.method, req.url.as_str(), req.body.as_deref());
        if let Some(found) = the_pages_call(&self.signed.borrow(), &key) {
            return Some(found.clone());
        }
        // A page already booted at this address has already made the calls this run read: take this step's from that
        // run. A step it did *not* make may be one the walk's storage suppressed (its result cache): boot the page once
        // more with empty storage — what a browser opened fresh would see — before giving up on it.
        let mut fresh_only = false;
        if let Some(calls) = self.sandbox_pages.borrow().get(&page) {
            if let Some(found) = calls.get(&key) {
                return Some(found.clone());
            }
            if self.sandbox_retried.borrow().contains(&page) {
                return None;
            }
            fresh_only = true;
        }
        // A bundle simple enough for the sandbox is signed without opening a page — once: a bundle it could not sign
        // is not signable by it later either.
        if let Some(why) = crate::sandbox::unheld().filter(|_| !self.scripts.is_empty() && !self.sandbox_off.get()) {
            eprintln!("   [sign] {}: the sandbox is skipped", why.said());
            said(&self.fell_back, format!("{}, so the sandbox was skipped", why.said()));
            if let Ok(mut u) = self.unheld.lock() {
                *u = Some(why);
            }
            self.sandbox_off.set(true);
        }
        // The walk's page carries what the walked page was asked, written into its document (a search the server
        // rendered): booted at another value's address it signs the walked call again, and the caller is answered
        // with the walk's data. A page opened for another value is the site's own document for that address; when the
        // site won't hand one over, the browser reads the page.
        let sandbox = !self.scripts.is_empty() && !self.sandbox_off.get();
        let html = if !sandbox {
            None
        } else if for_another_value {
            let asked = self.the_sites_page(&page);
            if asked.is_none() {
                eprintln!("   [sign] the site did not hand over the page for this value: the sandbox is skipped");
                said(&self.fell_back, "the site did not hand over the page for this value, so the sandbox was skipped".to_string());
            }
            asked
        } else {
            Some(self.page_html.clone().unwrap_or_default())
        };
        if let Some(html) = html {
            let bundle: crate::sandbox::Bundle = self.scripts.iter().map(|s| (s.url.clone(), s.body.clone())).collect();
            // The page's own `document.cookie` is what a browser shows a script on that page: the jar's cookies that
            // go with a request to it (host or domain, path, unexpired, and only what this call may carry), and of
            // those only the ones known not to be HttpOnly (`Runner::page_cookies`). A consent cookie or a flag the
            // page reads before its data layer runs is there; a session cookie the browser keeps from script is not.
            let page_cookies = url::Url::parse(&page).map(|u| self.page_cookies(&u)).unwrap_or_default();
            let storage = self.storage.clone();
            let fingerprint = self.fingerprint.clone();
            // What the page's script asks for while it signs — a config, a chunk, a challenge key — is fetched by the
            // node, not by the sandbox, over a transport held to the rule for code that isn't the node's own whoever's
            // route this is (HTTPS, a public address checked where it connects, every redirect hop), and to the rule
            // every step of this call is held to ([`Runner::page_asks`]).
            let answers = if for_another_value { Vec::new() } else { self.answers.clone() };
            let targets = self.signing_targets.clone();
            let mut page_net = crate::http::ChromeFetch::held_to(crate::egress::Egress::Foreign).ok().map(|t| t.with_client_hints(crate::http::ClientHints::of(&fingerprint)));
            let mut bridge = |r: &Request, until: std::time::Instant| -> Result<Exchange, String> {
                let Some(transport) = page_net.as_mut() else { return Err("no transport for the page's own calls".to_string()) };
                transport.until(Some(until));
                self.page_asks(transport, r)
            };
            // The walk's storage is the page **after** it ran: its result caches (session/local storage) can make the
            // page decide it already has what this call asks for, so it makes no call. A browser opened fresh would;
            // so retry the page with empty storage before ever opening one. Cookies stay: they are the session, not a
            // cache. Only when the page still makes nothing does the browser run it.
            let has_storage = !storage.local.is_empty() || !storage.session.is_empty();
            let attempts: Vec<crate::sandbox::Storage> = if fresh_only {
                vec![crate::sandbox::Storage::default()]
            } else if has_storage {
                vec![storage.clone(), crate::sandbox::Storage::default()]
            } else {
                vec![storage.clone()]
            };
            let mut made_last: Option<HashMap<String, crate::sandbox::Signed>> = None;
            for (attempt, storage) in attempts.iter().enumerate() {
                match crate::sandbox::sign_page(&bundle, &page, &page_cookies, storage, &html, &fingerprint, &answers, Some(&mut bridge), &targets) {
                    Some(calls) => {
                        // One boot signs every step its page makes: keep them all, keyed as the route keys a step.
                        let mut made: HashMap<String, crate::sandbox::Signed> = HashMap::new();
                        for c in calls {
                            made.insert(page_call_key(&c.method, &c.url, c.body.as_deref()), c);
                        }
                        let found = the_pages_call(&made, &key).cloned();
                        made_last = Some(made);
                        if let Some(f) = found.as_ref() {
                            self.reach(f.by);
                            if attempt > 0 && std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                eprintln!("   [sign] the page needed fresh storage: signed on the retry");
                            }
                            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                let names: Vec<&str> = f.headers.iter().map(|(k, _)| k.as_str()).collect();
                                eprintln!("   [sign] sandbox signed {} {} with {:?}", req.method, req.url.path(), names);
                            }
                            if let Some(made) = made_last.take() {
                                self.sandbox_pages.borrow_mut().insert(page.clone(), made);
                            }
                            return found
                        }
                        eprintln!("   [sign] sandbox ran the page but made no call at {} {} (storage {})", req.method, req.url.path(), if attempt == 0 { "as walked" } else { "fresh" });
                    }
                    None => {
                        eprintln!("   [sign] sandbox made no matching call for {} {}", req.method, req.url.path());
                        self.sandbox_off.set(true);
                        made_last = None;
                        break;
                    }
                }
            }
            if fresh_only {
                self.sandbox_retried.borrow_mut().insert(page.clone());
            }
            if let Some(made) = made_last {
                self.sandbox_pages.borrow_mut().insert(page.clone(), made);
            }
        }
        // A plain read the page's own code made no call for is the route's to send: `Fetch::sign_request` already says
        // None here means the step goes out as the route builds it, and the site's answer says whether it needed the
        // page's values. Opening a browser instead answers a question the site was never asked, and a page's code that
        // writes only a reporting header (a trace id, a span) is no reason to load the page again: the route's own
        // request asks the site, and a refusal there is a failure the call reports.
        // Whether a step may go plainly is the write rule's question, not its method's (`ledger::writes`, the engine's
        // one reader of it): a request it names a read — the page sent it as it loaded, it answered with data and set
        // no cookie, or its path is a query's — asks and changes nothing, so it is sent as the route builds it even
        // when it is a POST, and the site's answer says whether it needed the page's signature (trip.com's flight list
        // answers a caller's cities without the page's tokens, and opening a browser for them answered nothing).
        let goes_plainly = self.steps.get(&req.exchange).map_or_else(
            || matches!(req.method.to_ascii_uppercase().as_str(), "GET" | "HEAD"),
            |step| !crate::ledger::writes(step),
        );
        if goes_plainly {
            eprintln!("   [sign] the page made no call at {} {}: a plain read goes as the route builds it", req.method, req.url.path());
            return None;
        }
        // Otherwise the page's own code signs it, in the browser the node runs: one page load per run, its calls kept
        // for every step after.
        if self.page_read.get() {
            eprintln!("   [sign] the page made no call at {} {}", req.method, req.url.path());
            return None;
        }
        if self.egress == crate::egress::Egress::Foreign && !self.on_the_routes_site(&page) {
            eprintln!("   [sign] the page is not on the route's site: a shared route opens no browser there");
            return None;
        }
        let Some(browser) = self.browser.as_ref() else { eprintln!("   [sign] no browser for the page bridge"); return None };
        self.used_browser.store(true, std::sync::atomic::Ordering::Relaxed);
        self.reach(crate::rung::Rung::Page);
        said(&self.fell_back, format!("the sandbox did not make the page's own call ({key}), so the node's browser opened the page to make it"));
        let made = browser.signed_page(&page);
        // The page has been read for this run whether or not it made the call asked about: asking it again would
        // load the same page and make the same calls, which is a visit's cost for no new answer.
        self.page_read.set(true);
        if made.is_empty() {
            return None;
        }
        // The browser keys a call by its method and path alone; here each is keyed as a step is, by its operation too.
        let made: HashMap<String, crate::sandbox::Signed> = made.into_iter().map(|(_, c)| (page_call_key(&c.method, &c.url, c.body.as_deref()), c)).collect();
        eprintln!("   [sign] the page made {} calls; {} one for {}", made.len(), if the_pages_call(&made, &key).is_some() { "including" } else { "none" }, key);
        *self.signed.borrow_mut() = made;
        the_pages_call(&self.signed.borrow(), &key).cloned()
    }
}

/// Whether `signed`, the call a page made, carries each caller's value (`inputs`, two characters or more) that `req`,
/// the request the route built for the caller, carries in its address or its body. Err, the first it lacks. One
/// reader for the question ([`crate::replay::carries_what_the_caller_asked`]): the page's call is held to it before it
/// stands for the route's request, and so is a step sent as the route builds it.
fn carries_the_values(req: &Request, inputs: &HashMap<String, String>, signed: &crate::sandbox::Signed) -> Result<(), String> {
    let ours = crate::replay::what_it_says(req.url.as_str(), req.body.as_deref());
    let theirs = crate::replay::what_it_says(&signed.url, signed.body.as_deref());
    let mut values: Vec<String> = inputs.values().map(|v| v.trim().to_lowercase()).filter(|v| v.chars().count() >= 2).collect();
    values.sort();
    match values.into_iter().find(|v| ours.contains(v.as_str()) && !theirs.contains(v.as_str())) {
        Some(v) => Err(v),
        None => Ok(()),
    }
}

fn page_with(page: &str, inputs: &HashMap<String, String>) -> String {
    let mut page = page.to_string();
    for (name, value) in inputs {
        page = page.replace(&format!("{{{name}}}"), value);
    }
    let Ok(mut u) = url::Url::parse(&page) else { return page };
    if !u.query_pairs().any(|(k, _)| inputs.contains_key(k.as_ref())) {
        return page;
    }
    let pairs: Vec<(String, String)> =
        u.query_pairs().map(|(k, v)| (k.to_string(), inputs.get(k.as_ref()).cloned().unwrap_or_else(|| v.into_owned()))).collect();
    u.query_pairs_mut().clear().extend_pairs(pairs);
    u.to_string()
}

fn target_may_run_alone(graph: &Graph, judged: bool) -> bool {
    use crate::graph::{Body, Class};
    let Some((target, before)) = graph.steps.split_last() else { return false };
    let signs_in = |s: &crate::graph::Step| s.fields.iter().any(|f| matches!(f.class, Class::Input { secret: true, .. }));
    let tied = graph.steps.iter().any(|s| matches!(s.body, Some(Body::Upload { .. })) || s.fields.iter().any(|f| matches!(f.class, Class::Fresh { .. })));
    let changes_the_site = before.iter().any(|s| crate::ledger::writes(s) && !s.sets_cookie && !signs_in(s));
    let writes_on_a_writes_cookie = (judged || crate::ledger::writes(target))
        && target.fields.iter().any(|f| match (&f.loc, &f.class) {
            (Loc::Cookie(_), Class::Derived { origin }) => before.iter().any(|s| s.exchange == origin.exchange && crate::ledger::writes(s) && !signs_in(s)),
            _ => false,
        });
    let asks_before = before.iter().filter(|s| !signs_in(s)).any(|s| {
        s.held.iter().map(|h| h.input.as_str()).chain(s.fields.iter().filter_map(|f| match &f.class {
            Class::Input { name, .. } => Some(name.as_str()),
            _ => None,
        }))
        .any(|name| crate::graph::reaches_the_answer(graph, name))
    });
    !before.is_empty() && !tied && !changes_the_site && !writes_on_a_writes_cookie && !asks_before
}

/// `page` with each piece of its path and each value of its query that is, whole, the walked value of one of the
/// route's inputs written as that input's place (`{name}`).
fn with_the_callers_values(page: &str, route: &Graph) -> String {
    let mut walked: Vec<(String, String)> = Vec::new();
    for step in &route.steps {
        for f in &step.fields {
            if let crate::graph::Class::Input { name, default: Some(value), secret: false, .. } = &f.class {
                walked.push((name.clone(), value.clone()));
            }
        }
        walked.extend(step.held.iter().map(|h| (h.input.clone(), h.sits.clone())));
    }
    walked.retain(|(_, v)| v.chars().count() >= 2 && !crate::slots::is_flag(v));
    let named = |text: &str| {
        let plain = percent_encoding::percent_decode_str(&text.replace('+', " ")).decode_utf8_lossy().into_owned();
        walked.iter().find(|(_, v)| v.eq_ignore_ascii_case(&plain)).map(|(name, _)| format!("{{{name}}}"))
    };
    let (head, fragment) = page.split_once('#').map_or((page, None), |(h, f)| (h, Some(f)));
    let (address, query) = head.split_once('?').map_or((head, None), |(a, q)| (a, Some(q)));
    let Some(from) = address.find("://").and_then(|at| address[at + 3..].find('/').map(|p| at + 3 + p)) else { return page.to_string() };
    let path: Vec<String> = address[from..].split('/').map(|piece| named(piece).unwrap_or_else(|| piece.to_string())).collect();
    let query = query.map(|q| q.split('&').map(|pair| match pair.split_once('=') {
        Some((k, v)) => format!("{k}={}", named(v).unwrap_or_else(|| v.to_string())),
        None => pair.to_string(),
    }).collect::<Vec<_>>().join("&"));
    format!("{}{}{}{}", &address[..from], path.join("/"), query.map(|q| format!("?{q}")).unwrap_or_default(), fragment.map(|f| format!("#{f}")).unwrap_or_default())
}

/// How one of the page's own calls is named, to find the call a step stands for among them: its method, its path,
/// and the values its query fixes that read as names (letters only: `operationName=SearchQuery`). A page that asks
/// one address for two operations makes two calls, and by method and path alone the step took whichever came last.
fn page_call_key(method: &str, address: &str, body: Option<&[u8]>) -> String {
    let Ok(u) = url::Url::parse(address) else { return format!("{} {address}", method.to_uppercase()) };
    let names_like = |v: &str| v.chars().count() >= 3 && v.chars().all(|c| c.is_alphabetic() || c == '_' || c == '.');
    let mut names: Vec<String> = u.query_pairs().filter(|(_, v)| names_like(v)).map(|(k, v)| format!("{k}={v}")).collect();
    // On an endpoint many operations share, the operation is named in the body: a value at its top that reads as a
    // name (`"operationName":"getReviews"`), as one in the query does. Two calls at one address that name two
    // operations are two calls.
    if let Some(serde_json::Value::Object(top)) = body.and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok()) {
        names.extend(top.iter().filter_map(|(k, v)| v.as_str().filter(|v| names_like(v)).map(|v| format!("{k}={v}"))));
    }
    names.sort();
    match names.is_empty() {
        true => format!("{} {}", method.to_uppercase(), u.path()),
        false => format!("{} {} [{}]", method.to_uppercase(), u.path(), names.join(",")),
    }
}

/// The page's call that `key` names: the one keyed the same, or, where the names differ (a setting the page chose
/// another value for), the only call the page made with that method at that path. Two or more leave nothing to
/// choose by, and none is taken.
fn the_pages_call<'m>(made: &'m HashMap<String, crate::sandbox::Signed>, key: &str) -> Option<&'m crate::sandbox::Signed> {
    let bare = |k: &str| k.split(" [").next().unwrap_or_default().to_string();
    made.get(key).or_else(|| {
        let mut at_its_path = made.iter().filter(|(k, _)| bare(k) == bare(key));
        match (at_its_path.next(), at_its_path.next()) {
            (Some((_, only)), None) => Some(only),
            _ => None,
        }
    })
}

fn heals_onto(ex: &Exchange, method: &str, frag: &str, origin: &str) -> bool {
    ex.method == method && origin_of(ex.url.as_str()) == origin && ex.url.path().contains(frag)
}

/// The chain a heal's fresh walk gives the route, or why it can't have one: the walk shows no target on the route's
/// `origin`, it has no place for the route's inputs, or it reaches a host the owner excluded.
fn rebuilt(old: &Graph, trace: crate::trace::Trace, method: &str, frag: &str, origin: Option<&str>, excluded: &[String]) -> Result<Graph, String> {
    // The same operation, where the route's call names one: a value its query fixes that reads as a name (letters, no
    // digits: `operationName=SearchQuery`) is the same in the call the repair takes. Another operation at the address
    // (a ticker beside the search) is not the route's call, and a chain rebuilt on it answers something else.
    let names: Vec<(String, String)> = old
        .steps
        .last()
        .into_iter()
        .flat_map(|s| &s.fields)
        .filter_map(|f| match (&f.loc, &f.class) {
            (Loc::Query(k), crate::graph::Class::Constant { value, .. } | crate::graph::Class::Unconfirmed { value }) => Some((k.clone(), value.clone())),
            _ => None,
        })
        .filter(|(_, v)| v.chars().count() >= 3 && v.chars().all(|c| c.is_alphabetic() || c == '_' || c == '.'))
        .collect();
    let same_operation = |ex: &Exchange| names.iter().all(|(k, v)| ex.url.query_pairs().find(|(q, _)| q == k).is_none_or(|(_, sent)| sent == v.as_str()));
    let mut g = crate::graph::build(std::slice::from_ref(&trace), |ex| origin.is_some_and(|o| heals_onto(ex, method, frag, o)) && same_operation(ex)).map_err(|e| format!("rebuild failed: {e}"))?;
    if !carry_inputs(old, &mut g) {
        return Err("the fresh sighting has no place for the route's inputs; keeping the old chain".into());
    }
    // The fresh walk's scripts name the values the page computes, as the walk that learned the route did: without them
    // a healed chain asks the browser for a signature it already has the producer of.
    let site = origin.and_then(|o| url::Url::parse(o).ok()).and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    // The page is the route's own, not the fresh chain's: a healed call still boots the page's scripts against the
    // page it was learned on (with the caller's values), which is what a signing bridge reads its state from.
    let seen = trace.exchanges.iter().rev().find(|e| e.is_main_document()).map(|e| e.url.to_string());
    g.page_origin = old.page_origin.clone().or_else(|| origin.map(|o| o.to_string()));
    // A page taken from the fresh walk is the walk's own example. The caller's values go back into it where the
    // example's stood, or every call after the repair opens the example's page and is answered with its results.
    g.page = old.page.clone().or_else(|| seen.map(|page| with_the_callers_values(&page, old)));
    crate::signing::discover(&mut g, &trace, &[], &crate::generated::Environment::default(), &[]);
    // A route that reads the page carries it whether or not a script signs: its next step takes a value from the
    // page's own answer (a meta, a config blob), and a route without the page fetches it live or asks for a browser.
    if !g.scripts.is_empty() || g.steps.iter().any(|s| s.reads_page) {
        // The data the fresh walk's page read, as the walk that learned the route kept it.
        crate::signing::record(&mut g, &trace, &site);
        g.page_html = crate::trace::page_html_of(&trace, &site);
    }
    // The wall the fresh walk met: the route keeps knowing what a refusal means.
    g.door = crate::graph::Door::met(&trace, &crate::identity::site_of(&site)).or(old.door.clone());
    let reaches = |s: &crate::graph::Step| crate::replay::step_host(&s.url).filter(|h| excluded.iter().any(|e| crate::identity::at_or_under(h, e)));
    if let Some(host) = g.steps.iter().find_map(reaches) {
        return Err(format!("the fresh chain reaches {host}, which the owner excluded; keeping the old chain"));
    }
    Ok(g)
}

/// A fresh sighting walks the page with its example values, so the rebuilt target sees the caller's inputs as
/// constants. The old route's inputs go back where they were in the target; without them a healed call would
/// answer the example's question (the default query) instead of the caller's. False when the new target has no
/// such place, so the heal is refused rather than answering something else.
fn carry_inputs(old: &Graph, new: &mut Graph) -> bool {
    let (Some(o), Some(n)) = (old.steps.last(), new.steps.last_mut()) else { return false };
    for f in o.fields.iter().filter(|f| matches!(f.class, crate::graph::Class::Input { .. })) {
        match n.fields.iter_mut().find(|nf| nf.loc == f.loc) {
            Some(nf) => nf.class = f.class.clone(),
            // A walk that didn't use a filter or turn a page doesn't send it, and the site still takes it: an optional
            // input goes back where it was.
            None if matches!(f.class, crate::graph::Class::Input { optional: true, .. }) => {
                if let crate::graph::Class::Input { name, .. } = &f.class {
                    crate::paging::place_optional(n, &f.loc, name, None);
                }
                if let Some(nf) = n.fields.iter_mut().find(|nf| nf.loc == f.loc) {
                    nf.class = f.class.clone();
                }
            }
            None => return false,
        }
    }
    // The caller's words held inside longer values go back too, where the fresh call still has those values.
    for h in &o.held {
        if n.fields.iter().any(|f| f.loc == h.loc) && !n.held.contains(h) {
            n.held.push(h.clone());
        }
    }
    // And the address is left open again wherever a piece of it is the caller's: the fresh walk wrote its own example
    // there, and a call that sent the example in its path answered the example for every value after the repair.
    let open: Vec<usize> = n
        .fields
        .iter()
        .filter(|f| matches!(f.class, crate::graph::Class::Input { .. }))
        .map(|f| &f.loc)
        .chain(n.held.iter().map(|h| &h.loc))
        .filter_map(|loc| if let Loc::Path(i) = loc { Some(*i) } else { None })
        .collect();
    if !open.is_empty() {
        let (head, tail) = match n.url.find(['?', '#']) {
            Some(at) => (n.url[..at].to_string(), n.url[at..].to_string()),
            None => (n.url.clone(), String::new()),
        };
        if let Some(from) = head.find("://").and_then(|at| head[at + 3..].find('/').map(|p| at + 3 + p)) {
            let pieces: Vec<String> = head[from + 1..].split('/').enumerate().map(|(i, p)| if open.contains(&i) { format!("{{path[{i}]}}") } else { p.to_string() }).collect();
            n.url = format!("{}/{}{tail}", &head[..from], pieces.join("/"));
        }
    }
    // What the walk read at a place the caller fills is the caller's now: a value only the page could make, or one seen
    // once, no longer stands there. The marker is recomputed from what is left, never from the old step's flag.
    let signed = n.page_signed || n.fields.iter().any(|f| matches!(f.class, crate::graph::Class::Script { .. } | crate::graph::Class::Computed));
    n.page_signed = signed;
    n.needs_browser = signed;
    new.provisional = new.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, crate::graph::Class::Unconfirmed { .. }));
    true
}

#[cfg(test)]
mod page_call_tests {
    use super::*;

    fn signed(body: &str) -> crate::sandbox::Signed {
        crate::sandbox::Signed { method: "POST".into(), url: "https://api.shop.example/graphql".into(), headers: Vec::new(), body: Some(body.as_bytes().to_vec()), modules: Vec::new(), values: Vec::new(), by: crate::rung::Rung::Bundle }
    }

    /// The page posts two operations to one endpoint: its ads and its reviews. Each is its own call, by the operation
    /// its body names: the step for the reviews takes the page's reviews call, never whichever came last, and a step
    /// whose operation the page did not make takes none of two others.
    #[test]
    fn on_an_endpoint_many_operations_share_a_call_is_told_by_its_body() {
        let made: HashMap<String, crate::sandbox::Signed> = [r#"{"operationName":"getAdsTargeting","query":"query getAdsTargeting { tags }"}"#, r#"{"operationName":"getReviews","query":"query getReviews($id: ID) { edges }"}"#]
            .into_iter()
            .map(|b| { let c = signed(b); (page_call_key(&c.method, &c.url, c.body.as_deref()), c) })
            .collect();
        assert_eq!(made.len(), 2, "two operations, two calls");
        let want = page_call_key("POST", "https://api.shop.example/graphql", Some(br#"{"operationName":"getReviews","variables":{"id":"9"}}"#));
        let got = the_pages_call(&made, &want).and_then(|c| c.body.clone()).map(|b| String::from_utf8(b).unwrap());
        assert!(got.is_some_and(|b| b.contains("getReviews")));
        let neither = page_call_key("POST", "https://api.shop.example/graphql", Some(br#"{"operationName":"getBasicGenres"}"#));
        assert!(the_pages_call(&made, &neither).is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::build;
    use crate::trace::{Exchange, Trace};

    /// A heal's walk used no filter, and the site still takes one: it goes back, and the heal isn't refused for it.
    #[test]
    fn a_heal_keeps_an_input_the_walk_left_out() {
        let page = |url: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(r#"{"items":[1]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let graph = |url: &str| build(&[Trace { exchanges: vec![page(url)], inputs: Vec::new() }], |_| true).unwrap();
        let mut old = graph("https://shop.example/api");
        crate::paging::place_optional(old.steps.last_mut().unwrap(), &Loc::Query("sort".into()), "sort", None);
        let mut new = graph("https://shop.example/api");
        assert!(carry_inputs(&old, &mut new));
        assert!(new.steps[0].fields.iter().any(|f| f.loc == Loc::Query("sort".into()) && matches!(f.class, crate::graph::Class::Input { optional: true, .. })));
    }

    /// A healed chain is rebuilt from a fresh sighting, and it still carries the route's page: a signing bridge is
    /// booted against the page the call was learned on (the caller's values in it), not against nothing. A route that
    /// predates the field gets the sighting's own page.
    #[test]
    fn a_heal_keeps_the_page_it_boots_the_scripts_on() {
        let api = Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/search".parse().unwrap(),
            request_headers: vec![("x-sig".into(), "1".into())],
            request_body: Some("{}".into()),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(r#"{"items":[1]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let doc = Exchange {
            method: "GET".into(),
            url: "https://shop.example/search".parse().unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some("<html><head></head></html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let trace = || Trace { exchanges: vec![doc.clone(), api.clone()], inputs: Vec::new() };
        let old = |page: Option<&str>| -> Graph {
            serde_json::from_value(serde_json::json!({
                "provisional": false,
                "page": page,
                "page_origin": "https://shop.example",
                "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/search", "fields": [], "needs_browser": true }]
            }))
            .unwrap()
        };
        let g = rebuilt(&old(Some("https://shop.example/search?q={q}")), trace(), "POST", "/api/search", Some("https://shop.example"), &[]).expect("a rebuilt chain");
        assert_eq!(g.page.as_deref(), Some("https://shop.example/search?q={q}"), "the route's page, with its inputs");
        assert_eq!(g.page_origin.as_deref(), Some("https://shop.example"));
        // A route saved before the page field existed still gets the page the sighting walked.
        let g = rebuilt(&old(None), trace(), "POST", "/api/search", Some("https://shop.example"), &[]).expect("a rebuilt chain");
        assert_eq!(g.page.as_deref(), Some("https://shop.example/search"));
    }

    /// The walk that exposed it: a shop search at `/tag/<word>/?q=<word>`. A call for a word the site had no page for
    /// was repaired from a fresh walk of the first word's page; the rebuilt route kept that word in its path and
    /// answered it for every word after. The address is left open again where a piece of it is the caller's.
    #[test]
    fn a_repair_leaves_the_address_open_where_the_caller_fills_it() {
        let ex = |url: &str| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(r#"{"items":[{"name":"a"}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let learned = Trace { exchanges: vec![ex("https://shop.example/tag/umbrella/?ajax=true&q=umbrella")], inputs: vec![crate::trace::Input::new("q", "umbrella")] };
        let old = build(&[learned], |_| true).unwrap();
        assert_eq!(old.steps[0].url, "https://shop.example/tag/{path[1]}/?ajax=true&q={q}");
        let fresh = Trace { exchanges: vec![ex("https://shop.example/tag/umbrella/?ajax=true&q=umbrella")], inputs: Vec::new() };
        let g = rebuilt(&old, fresh, "GET", "tag", Some("https://shop.example"), &[]).expect("a rebuilt chain");
        assert!(g.steps[0].url.starts_with("https://shop.example/tag/{path[1]}/"), "{}", g.steps[0].url);
    }

    /// The walk that exposed it: a news search repaired after its first trial had dropped the route's page. The
    /// repair took the fresh walk's page as it stood, so every word after opened the first word's page and was
    /// answered with its results. The caller's values go back into the page a repair takes from its walk.
    #[test]
    fn a_page_a_repair_takes_from_its_walk_is_left_open_for_the_caller() {
        let route: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://news.example/graphql?variables=%7B%7D", "needs_browser": false,
                "held": [{ "loc": { "in": "query", "key": "variables" }, "input": "search", "sits": "climate", "written": "json" }],
                "fields": [{ "loc": { "in": "query", "key": "lang" }, "class": "input", "name": "lang", "secret": false, "default": "english" }] }]
        }))
        .unwrap();
        assert_eq!(with_the_callers_values("https://news.example/search/climate", &route), "https://news.example/search/{search}");
        assert_eq!(with_the_callers_values("https://news.example/find?q=climate&lang=english&page=1#top", &route), "https://news.example/find?q={search}&lang={lang}&page=1#top");
        assert_eq!(with_the_callers_values("https://news.example/climate-desk/latest", &route), "https://news.example/climate-desk/latest");
    }

    /// A step is found among the page's own calls by its operation, not only its address; a call whose names differ
    /// is still taken where it is the only one the page made there.
    #[test]
    fn a_step_takes_the_pages_call_of_its_own_operation() {
        let signed = |url: &str| crate::sandbox::Signed { method: "GET".into(), url: url.into(), headers: Vec::new(), body: None, modules: Vec::new(), values: Vec::new(), by: crate::rung::Rung::Bundle };
        let made = |urls: &[&str]| urls.iter().map(|u| (page_call_key("GET", u, None), signed(u))).collect::<HashMap<_, _>>();
        let (search, ticker) = ("https://news.example/graphql?operationName=SearchQuery&variables=%7B%7D", "https://news.example/graphql?operationName=TickerQuery&variables=%7B%7D");
        let key = page_call_key("GET", search, None);
        assert_eq!(the_pages_call(&made(&[ticker, search]), &key).map(|c| c.url.as_str()), Some(search));
        assert!(the_pages_call(&made(&[ticker, "https://news.example/graphql?operationName=OtherQuery"]), &key).is_none(), "two others: nothing to choose by");
        assert_eq!(the_pages_call(&made(&["https://shop.example/api/list?sort=newest"]), &page_call_key("GET", "https://shop.example/api/list?sort=price", None)).map(|c| c.url.as_str()), Some("https://shop.example/api/list?sort=newest"));
    }

    /// The walk that exposed it: a news search at an address its page also asks for a ticker, each named in one query
    /// key. A repair that took whichever call it met last at that address rebuilt the route on the ticker, and the
    /// search answered the ticker. The repair takes the call of the operation the route names.
    #[test]
    fn a_repair_takes_the_call_of_the_operation_the_route_names() {
        let ex = |op: &str, body: &str| Exchange {
            method: "GET".into(),
            url: format!("https://news.example/graphql?operationName={op}&q=climate").parse().unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let old: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page_origin": "https://news.example",
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://news.example/graphql?operationName=SearchQuery&q={q}", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "query", "key": "operationName" }, "class": "unconfirmed", "value": "SearchQuery" },
                    { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "climate" }
                ] }]
        }))
        .unwrap();
        let walk = Trace { exchanges: vec![ex("SearchQuery", r#"{"data":{"posts":[{"title":"a"}]}}"#), ex("TickerQuery", r#"{"data":{"breaking":null}}"#)], inputs: vec![crate::trace::Input::new("q", "climate")] };
        let g = rebuilt(&old, walk, "GET", "graphql", Some("https://news.example"), &[]).expect("a rebuilt chain");
        assert!(g.steps.last().unwrap().url.contains("operationName=SearchQuery"), "{}", g.steps.last().unwrap().url);
    }

    /// The flags a graph carries say what its fields are: a place the caller fills is no longer one the page computes
    /// or one seen once.
    #[test]
    fn a_heal_leaves_no_flag_for_a_value_the_caller_now_fills() {        let g = |class: crate::graph::Class| -> Graph {
            let mut g: Graph = serde_json::from_value(serde_json::json!({ "provisional": true, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api", "fields": [], "needs_browser": true }
            ]}))
            .unwrap();
            g.steps[0].fields.push(crate::graph::Field { loc: Loc::Query("q".into()), class });
            g
        };
        let old = g(crate::graph::Class::Input { name: "q".into(), secret: false, default: None, optional: false });
        for walked in [crate::graph::Class::Computed, crate::graph::Class::Unconfirmed { value: "seen-once".into() }] {
            let mut new = g(walked);
            assert!(carry_inputs(&old, &mut new));
            assert!(!new.steps[0].needs_browser && !new.provisional);
        }
    }

    /// The route was checked against the owner's exclusions before the call, but a heal's chain is new: one that now
    /// takes a value from an excluded host is refused, and the route stays as it was.
    #[test]
    fn a_heal_never_takes_the_route_onto_a_host_the_owner_excluded() {
        let ex = |url: &str, headers: Vec<(String, String)>, body: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: headers,
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let walk = || Trace {
            exchanges: vec![
                ex("https://config.tracker.example/init", vec![], r#"{"token":"tok_8f3a2c91d7e4"}"#),
                ex("https://shop.example/api/items", vec![("x-token".into(), "tok_8f3a2c91d7e4".into())], r#"{"items":[1]}"#),
            ],
            inputs: Vec::new(),
        };
        let old = build(&[Trace { exchanges: vec![ex("https://shop.example/api/items", vec![], r#"{"items":[1]}"#)], inputs: Vec::new() }], |_| true).unwrap();
        let healed = |excluded: &[String]| rebuilt(&old, walk(), "GET", "items", Some("https://shop.example"), excluded);
        assert_eq!(healed(&[]).unwrap().steps.len(), 2, "the fixture's chain does reach the host");
        let refused = healed(&["tracker.example".to_string()]).unwrap_err();
        assert!(refused.contains("config.tracker.example"), "{refused}");
    }

    /// The builder's calls say what the client is, in any order: a browser named last still walks where it was told to,
    /// and in the root's profile.
    #[test]
    fn a_client_is_the_same_whatever_order_it_was_built_in() {
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let cdp = || Some("ws://127.0.0.1:9222".to_string());
        let late = RouteClient::new(g.clone()).with_cdp(cdp()).with_root("https://root.example/app", "GET", "list").with_browser("in-process");
        let early = RouteClient::new(g).with_browser("in-process").with_cdp(cdp()).with_root("https://root.example/app", "GET", "list");
        let (late, early) = (late.browser.unwrap(), early.browser.unwrap());
        assert_eq!(late.cdp_endpoint, early.cdp_endpoint);
        assert_eq!(late.profile, early.profile);
        assert_eq!(late._host, "root.example");
    }

    /// A route made from someone else's body is held to their rule from the start: a caller who forgets to say so
    /// doesn't run it as the node's own, and it gets no browser.
    #[test]
    fn a_foreign_step_makes_the_route_someone_elses_unless_told_otherwise() {
        let mut g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        assert_eq!(RouteClient::new(g.clone()).egress, crate::egress::Egress::Own);
        g.steps[0].foreign = true;
        let client = RouteClient::new(g).with_browser("in-process");
        assert_eq!(client.egress, crate::egress::Egress::Foreign);
        assert!(client.browser.is_none());
    }

    /// The owner's login is theirs: a route that came from another node never spends it, whatever a caller hands it.
    #[test]
    fn someone_elses_route_never_signs_in() {
        let g = Graph { steps: Vec::new(), provisional: false, page_origin: None, ..Graph::default() };
        let client = RouteClient::new(g.clone()).with_egress(crate::egress::Egress::Foreign).with_sign_in(Some(Box::new(|| None)));
        assert!(client.sign_in.is_none());
        assert!(RouteClient::new(g).with_sign_in(Some(Box::new(|| None))).sign_in.is_some());
    }

    /// The sign-in's own request, sent with no browser, spends the owner's login as the browser's sign-in does: a
    /// route that came from another node never takes it.
    #[test]
    fn someone_elses_route_never_signs_in_by_the_sign_ins_own_request() {
        let g = Graph { steps: Vec::new(), provisional: false, page_origin: None, ..Graph::default() };
        let client = RouteClient::new(g.clone()).with_egress(crate::egress::Egress::Foreign).with_plain_sign_in(Some(Box::new(|| None)));
        assert!(client.plain_sign_in.is_none());
        assert!(RouteClient::new(g).with_plain_sign_in(Some(Box::new(|| None))).plain_sign_in.is_some());
    }

    /// Only an answer that says the session is gone asks for a sign-in: a site that moved, or a bad value, isn't one.
    #[test]
    fn a_sign_in_is_for_a_session_gone() {
        let failed = |status| ReplayError::Failed { step: 0, url: String::new(), status, body: String::new() };
        assert!(session_gone(&failed(401)) && session_gone(&failed(403)));
        assert!(session_gone(&ReplayError::NotAnAnswer { status: 200, why: String::new(), challenge: false }));
        assert!(!session_gone(&failed(404)) && !session_gone(&failed(500)));
        assert!(!session_gone(&ReplayError::MissingInput("q".into())));
    }

    /// A challenge checks the caller, not the session: it never spends the owner's login.
    #[test]
    fn a_challenge_never_spends_the_owners_login() {
        assert!(!session_gone(&ReplayError::NotAnAnswer { status: 200, why: String::new(), challenge: true }));
    }

    /// A walk mends a site that moved. What the caller got wrong, what the rule refused, a site that is down, a
    /// browser that failed or a wall are the same after any walk: a fresh sighting meets the same browser and the
    /// same wall. A 503 is often a wall's own answer and stays a walk's to try; a 4xx is drift.
    #[test]
    fn a_walk_is_only_for_what_a_walk_can_mend() {
        let failed = |status| ReplayError::Failed { step: 1, url: String::new(), status, body: String::new() };
        for e in [ReplayError::MissingInput("q".into()), ReplayError::BadUrl("x".into()), ReplayError::Refused("x".into()), ReplayError::RefusedHop("x".into()), ReplayError::Transport("x".into()), failed(500), failed(502), failed(504)] {
            assert!(!a_walk_can_mend(&e), "{e}");
        }
        for e in [failed(403), failed(404), failed(422), failed(429), failed(503), ReplayError::NeedsBrowser { step: 1, url: String::new(), loc: crate::slots::Loc::Url }] {
            assert!(a_walk_can_mend(&e), "{e}");
        }
    }

    fn write_chain(first_method: &str, target_method: &str, cookie_from_first: bool, first_extra: serde_json::Value) -> Graph {
        let target_fields = if cookie_from_first {
            serde_json::json!([{ "loc": { "in": "cookie", "key": "sid" }, "class": "derived",
                "origin": { "exchange": 0, "url": "https://shop.example/api/cart", "at": { "from": "set_cookie", "name": "sid" } } }])
        } else {
            serde_json::json!([])
        };
        serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": first_method, "status": 200, "url": "https://shop.example/api/cart", "fields": first_extra, "needs_browser": false, "sets_cookie": true },
            { "exchange": 1, "method": target_method, "status": 200, "url": "https://shop.example/api/checkout", "fields": target_fields, "needs_browser": false }
        ]}))
        .unwrap()
    }

    /// Who the target leans on decides whether it may go alone. A write that lives on an earlier write's cookie never
    /// does; a sign-in's cookie is the warm jar's to stand in for; a read on any cookie reads what the jar has.
    #[test]
    fn a_target_runs_alone_only_on_what_a_warm_jar_can_stand_in_for() {
        let none = serde_json::json!([]);
        let secret = serde_json::json!([{ "loc": { "in": "json", "key": "/password" }, "class": "input", "name": "password", "secret": true, "default": null }]);
        assert!(!target_may_run_alone(&write_chain("POST", "POST", true, none.clone()), false), "a checkout on the last cart");
        assert!(target_may_run_alone(&write_chain("POST", "POST", true, secret), false), "a post on a signed-in session");
        assert!(target_may_run_alone(&write_chain("POST", "GET", true, none.clone()), false), "a read of what the jar's session holds");
        assert!(!target_may_run_alone(&write_chain("POST", "GET", true, none.clone()), true), "a target someone saw write is a write");
        let mut state = write_chain("POST", "GET", false, none);
        state.steps[0].sets_cookie = false;
        assert!(!target_may_run_alone(&state, false), "a vote before the results: skipped, it was never cast");
        // A search posted before a read that names nothing of it: alone, the read answers the session's last search.
        let city = serde_json::json!([{ "loc": { "in": "json", "key": "/to" }, "class": "constant", "value": "KUL" }]);
        let mut search = write_chain("POST", "POST", false, city);
        search.steps[0].held.push(crate::graph::Held { loc: Loc::Json("/to".into()), input: "acity".into(), sits: "KUL".into(), written: crate::graph::Written::Upper, inside: None });
        assert!(!target_may_run_alone(&search, false), "a search the session keeps is sent, not stood in for");
    }

    /// The page that signs a call is opened on the caller's search, whether its address was kept as a template or as
    /// the address it was walked on.
    #[test]
    fn the_signing_page_says_the_callers_values() {
        let asked: HashMap<String, String> = [("acity".to_string(), "tyo".to_string()), ("q".to_string(), "red shoes".to_string())].into();
        assert_eq!(page_with("https://air.example/fares?dcity=sin&acity=kul&n=1", &asked), "https://air.example/fares?dcity=sin&acity=tyo&n=1");
        assert_eq!(page_with("https://shop.example/s/{q}", &asked), "https://shop.example/s/red shoes");
        assert_eq!(page_with("https://air.example/fares?x=1", &asked), "https://air.example/fares?x=1");
    }

    /// The whole of it, against a site: a checkout whose cookie comes from the cart step runs the cart step, on a warm
    /// jar too, and doesn't go through on the cart the last call left.
    #[test]
    fn a_checkout_never_goes_through_on_the_last_carts_cookie() {
        let (port, hits) = site_counting(vec![("/api/cart", 200, "application/json", r#"{"ok":true}"#), ("/api/checkout", 200, "application/json", r#"{"ok":true}"#)]);
        let mut g = write_chain("POST", "POST", true, serde_json::json!([]));
        for s in &mut g.steps {
            s.url = s.url.replace("https://shop.example", &format!("http://127.0.0.1:{port}"));
        }
        let mut client = RouteClient::new(g);
        client.jar.insert("sid".into(), "the-last-cart".into());
        let (answer, _) = client.call_with_ledger(&HashMap::new());
        assert!(answer.is_ok(), "{answer:?}");
        assert_eq!(*hits.lock().unwrap(), ["/api/cart", "/api/checkout"]);
    }

    /// A heal walks the page with its example query; the caller's input goes back where the old route had it,
    /// so the healed call answers the caller's query, not the example's.
    #[test]
    fn a_heal_keeps_the_callers_inputs() {
        let search = |q: &str| Trace {
            exchanges: vec![Exchange {
                method: "GET".into(),
                url: format!("https://crates.example/api/v1/crates?q={q}").parse().unwrap(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some(r#"{"crates":[{"name":"x"}]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: Some("XHR".into()),
                main_frame: None,
            }],
            inputs: vec![],
        };
        let mut old = build(&[search("alloy")], |ex| ex.url.path().contains("crates")).unwrap();
        let q = old.steps.last_mut().unwrap().fields.iter_mut().find(|f| f.loc == Loc::Query("q".into())).unwrap();
        q.class = crate::graph::Class::Input { name: "q".into(), secret: false, default: Some("alloy".into()), optional: false };
        let mut healed = build(&[search("tauri")], |ex| ex.url.path().contains("crates")).unwrap();
        assert!(carry_inputs(&old, &mut healed));
        let f = healed.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Query("q".into())).unwrap();
        assert!(matches!(&f.class, crate::graph::Class::Input { name, .. } if name == "q"));
    }

    /// A chain: the page's Set-Cookie is the token the api derives, so the
    /// graph keeps both steps and the target's token field is Derived.
    fn chain_traces() -> Vec<Trace> {
        // An API exchange (not a page): pages belong to the mint, and a page's
        // exchanged values classify as minted rather than derived.
        let page = |tok: &str| Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/session".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), format!("x-token={tok}; Path=/"))],
            response_body: Some(r#"{"ok":true}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let api = |tok: &str| Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("x-token".into(), tok.into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[{"id":7}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        vec![
            Trace { exchanges: vec![page("tok_aaa_111111"), api("tok_aaa_111111")], inputs: vec![] },
            Trace { exchanges: vec![page("tok_bbb_222222"), api("tok_bbb_222222")], inputs: vec![] },
        ]
    }

    fn traces() -> Vec<Trace> {
        let page = Exchange {
            method: "GET".into(),
            url: "https://shop.example/app".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: None,
        };
        let api = |tok: &str| Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("x-token".into(), tok.into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[{"id":7}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        vec![
            Trace { exchanges: vec![page.clone(), api("tok_aaa_111111")], inputs: vec![] },
            Trace { exchanges: vec![page, api("tok_bbb_222222")], inputs: vec![] },
        ]
    }

    /// A session the site sets in an answer is the one the next call sends, as a browser keeps it: a demo bank's
    /// sign-in route signed in, and the calls after it still went out with the old session and were refused
    /// ("User login required", 2026-11-06).
    #[test]
    fn a_session_an_answer_sets_goes_with_the_next_call() {
        use crate::trace::{Exchange, Trace};
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let app = axum::Router::new().route(
                    "/api/me",
                    axum::routing::get(|headers: axum::http::HeaderMap| async move {
                        let signed_in = headers.get("cookie").and_then(|c| c.to_str().ok()).is_some_and(|c| c.contains("sid=fresh"));
                        let body = if signed_in { r#"{"me":"ada"}"# } else { r#"{"me":"guest"}"# };
                        ([("set-cookie", "sid=fresh; Path=/; HttpOnly"), ("content-type", "application/json")], body)
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                axum::serve(listener, app).await.unwrap();
            });
        });
        let base = format!("http://{}", rx.recv().unwrap());
        let me = Exchange {
            method: "GET".into(),
            url: format!("{base}/api/me").parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(r#"{"me":"ada"}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let g = build(&[Trace { exchanges: vec![me], inputs: vec![] }], |e| e.url.path() == "/api/me").unwrap();
        let mut client = RouteClient::new(g);
        assert_eq!(client.call(&HashMap::new()).unwrap()["me"], "guest", "the first call has no session yet");
        assert_eq!(client.call(&HashMap::new()).unwrap()["me"], "ada", "the second sends the session the first was given");
    }

    /// A route whose target answers with a piece of HTML (a results list a script drops into its page, served as
    /// text/html with no document around it) is answered with that piece read as a page, not failed for not being
    /// JSON: it was kept for what that HTML holds.
    #[test]
    fn a_piece_of_html_is_read_as_the_page_it_belongs_to() {
        use crate::trace::{Exchange, Trace};
        let fragment = r#"<ul class="results"><li><a href="/place/1">Lisbon, Portugal</a></li><li><a href="/place/2">Lisbon, Ohio</a></li></ul>"#;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let app = axum::Router::new().route("/search/results", axum::routing::get(move || async move { axum::response::Html(fragment) }));
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                axum::serve(listener, app).await.unwrap();
            });
        });
        let base = format!("http://{}", rx.recv().unwrap());
        let results = Exchange {
            method: "GET".into(),
            url: format!("{base}/search/results").parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
            response_body: Some(fragment.into()),
            response_mime: "text/html".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        assert!(crate::page::is_markup("text/html; charset=utf-8", fragment) && !crate::page::is_html(fragment));
        let g = build(&[Trace { exchanges: vec![results], inputs: vec![] }], |e| e.url.path() == "/search/results").unwrap();
        let answer = RouteClient::new(g).call(&HashMap::new()).expect("a piece of HTML is an answer");
        assert!(answer["text"].as_str().is_some_and(|t| t.contains("Lisbon, Portugal")), "{answer}");
        assert!(answer["links"].as_array().is_some_and(|l| l.len() == 2), "{answer}");
    }

    /// A route's minted values persist across calls through the session store:
    /// the first call can't run (no minted token anywhere), the second carries a
    /// stored one through, browserless, against a live local site.
    #[test]
    fn minted_values_carry_across_calls_via_the_store() {
        use crate::trace::{Exchange, Trace};
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let app = axum::Router::new()
                    .route("/app", axum::routing::get(|| async { axum::response::Html("<html>shop</html>") }))
                    .route("/api/p/list", axum::routing::get(|| async { axum::Json(serde_json::json!({ "items": [ { "id": 7 } ] })) }));
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                axum::serve(listener, app).await.unwrap();
            });
        });
        let addr = rx.recv().unwrap();
        let base = format!("http://{addr}");

        let page = Exchange {
            method: "GET".into(),
            url: format!("{base}/app").parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: None,
        };
        let api = |tok: &str| Exchange {
            method: "GET".into(),
            url: format!("{base}/api/p/list").parse().unwrap(),
            request_headers: vec![("x-token".into(), tok.into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[{"id":7}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        let g = build(
            &[Trace { exchanges: vec![page.clone(), api("tok_aaa_111111")], inputs: vec![] },
                Trace { exchanges: vec![page, api("tok_bbb_222222")], inputs: vec![] }],
            |e| e.url.path() == "/api/p/list",
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!("route-client-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // No stored session: the minted token is simply not sent, as a browser
        // omits a cookie it does not hold — so the site answers 401 and the call
        // fails with that, not with a missing-session error.
        let mut client = RouteClient::new(g.clone()).with_session_store(&dir);
        // The absent token is not sent, so the request still goes out: the
        // store decides what the session carries, never the replay.
        let sent = client.call(&HashMap::new());
        assert!(            !matches!(sent, Err(ReplayError::MissingMinted(_))),
            "a missing session value must not block the call: {sent:?}"
        );

        // The node's session store gains the token (as a mint would have): the
        // same call then runs browserless.
        std::fs::create_dir_all(&dir).unwrap();
        let host = addr.to_string();
        std::fs::write(
            dir.join(format!("{host}.json")),
            serde_json::to_string(&serde_json::json!({ "x-token": "tok_ccc_333333" })).unwrap(),
        )
        .unwrap();
        let mut client = RouteClient::new(g).with_session_store(&dir);
        let answer = client.call(&HashMap::new()).expect("the stored session carries");
        assert_eq!(answer["items"][0]["id"], 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A cookie an answer sets for a public suffix never joins the route's jar, the node's own route included: it would
    /// go with the next request to any other site under that suffix. One for the jar's own site still does.
    #[test]
    fn an_answer_cookie_for_a_public_suffix_never_joins_the_jar() {
        let mut r = runner("https://shop.co.uk/");
        let set = |line: &str| Exchange { method: "GET".into(), url: "https://shop.co.uk/".parse().unwrap(), request_headers: vec![], request_body: None, status: 200,
            response_headers: vec![("set-cookie".into(), line.into())], response_body: None, response_mime: String::new(), resource_type: None, main_frame: None };
        r.keep_set_cookies(&set("tossed=1; Domain=.co.uk; Path=/"));
        assert!(!r.jar.contains_key("tossed"), "a public suffix's cookie");
        r.keep_set_cookies(&set("wide=1; Domain=.shop.co.uk; Path=/"));
        assert!(r.jar.contains_key("wide"), "the site's own");
    }

    pub(super) fn runner(home: &str) -> Runner {
        Runner {
            began: Default::default(),
            owner: None,
            replaced: None,
            under_owner: HashSet::new(),
            steps: HashMap::new(),
            session_reads_approved: false,
            session_allowed: false,
            transport: Held { fetch: Box::new(HttpFetch::new().unwrap()), within: None },
            browser: None,
            jar: HashMap::from([("sid".to_string(), "host-only-secret".to_string()), ("x-csrf-token".to_string(), "t".to_string())]),
            jar_domains: HashMap::new(),
            cookie_meta: HashMap::new(),
            storage: Default::default(),
            session_steps: HashMap::new(),
            walled: HashSet::new(),
            refused_on_the_walk: HashSet::new(),
            home: url::Url::parse(home).ok().map(|u| (u.scheme().to_string(), u.host_str().unwrap().to_string())),
            not_cookies: HashSet::from(["x-csrf-token".to_string()]),
            page: None,
            scripts: Vec::new(),
            answers: Vec::new(),
            page_html: None,
            egress: crate::egress::Egress::Own,
            used_browser: Default::default(),
            reached: Default::default(),
            fell_back: Default::default(),
            unheld: Default::default(),
            fingerprint: serde_json::Value::Null,
            signed: std::cell::RefCell::new(HashMap::new()),
            page_read: std::cell::Cell::new(false),
            sandbox_off: std::cell::Cell::new(false),
            sandbox_pages: std::cell::RefCell::new(HashMap::new()),
            sandbox_retried: std::cell::RefCell::new(HashSet::new()),
            signing_targets: Vec::new(),
        }
    }

    fn get(url: &str) -> Request {
        Request { method: "GET".into(), url: url.parse().unwrap(), exchange: 0, headers: vec![], body: None }
    }

    /// The call a page made stands for a request only where it asks the caller's values the request asks: the walked
    /// page's call (its address unable to carry the new value), or another visit's, asks another value, and its
    /// answer is that value's however it runs (live: a search's second value answered with the first's records). A
    /// call that asks the value, its own way (form encoding, the page's own extra keys), is the request's.
    #[test]
    fn a_pages_call_that_asks_another_value_is_not_this_requests() {
        let signed = |url: &str| crate::sandbox::Signed { method: "GET".into(), url: url.into(), headers: Vec::new(), body: None, modules: Vec::new(), values: Vec::new(), by: crate::rung::Rung::Page };
        let req = get("https://lib.example/services/search?user_query=apollo%2013&hits_per_page=50&uid=R:1");
        let inputs = HashMap::from([("query".to_string(), "apollo 13".to_string()), ("hits_per_page".to_string(), "50".to_string())]);
        assert_eq!(carries_the_values(&req, &inputs, &signed("https://lib.example/services/search?user_query=apollo+11&hits_per_page=50&uid=R:2")), Err("apollo 13".into()));
        assert_eq!(carries_the_values(&req, &inputs, &signed("https://lib.example/services/search?user_query=apollo+13&hits_per_page=50&uid=R:2&aggregations=false")), Ok(()));
        let posted = Request { method: "POST".into(), url: "https://lib.example/graphql".parse().unwrap(), exchange: 0, headers: vec![], body: Some(br#"{"q":"apollo 13"}"#.to_vec()) };
        let page_posted = crate::sandbox::Signed { body: Some(br#"{"q":"apollo 11","op":"Search"}"#.to_vec()), ..signed("https://lib.example/graphql") };
        assert!(carries_the_values(&posted, &inputs, &page_posted).is_err(), "a body asking another value");
    }

    fn cookie(r: &Request) -> Option<&str> {
        r.headers.iter().find(|(k, _)| k == "cookie").map(|(_, v)| v.as_str())
    }

    /// The jar no longer knows which of its cookies were host-only or Secure, so it goes only where all of them
    /// would: its own host, on its own scheme, never in the clear. A sibling host, an http step and another site get
    /// none of it; the route's own tokens never ride as cookies.
    #[test]
    fn a_jar_goes_only_where_a_browser_would_send_all_of_it() {
        let r = runner("https://www.shop.example/");
        assert_eq!(cookie(&r.with_session_cookies(&get("https://www.shop.example/other/path"))), Some("sid=host-only-secret"));
        assert_eq!(cookie(&r.with_session_cookies(&get("https://api.shop.example/v1/items"))), None, "a sibling host");
        assert_eq!(cookie(&r.with_session_cookies(&get("http://www.shop.example/api/x"))), None, "another scheme, in the clear");
        assert_eq!(cookie(&r.with_session_cookies(&get("https://shop.other/"))), None, "another site");
        // A site served over plain http is reached in the clear only on this machine itself.
        let r = runner("http://shop.example/");
        assert_eq!(cookie(&r.with_session_cookies(&get("http://shop.example/api"))), None);
        let r = runner("http://127.0.0.1:8080/");
        assert_eq!(cookie(&r.with_session_cookies(&get("http://127.0.0.1:8080/api"))), Some("sid=host-only-secret"));
    }

    /// A step whose recorded cookie source no longer sets it takes the jar's copy only on the jar's own host: a step
    /// to a sibling, another site or a host built at call time never draws the session's cookie by naming it.
    #[test]
    fn a_derived_cookie_falls_back_to_the_jar_only_on_the_jars_host() {
        let r = runner("https://www.shop.example/");
        assert_eq!(r.minted_cookie("sid", Some("www.shop.example")).as_deref(), Some("host-only-secret"));
        assert_eq!(r.minted_cookie("sid", Some("WWW.Shop.Example")).as_deref(), Some("host-only-secret"));
        assert_eq!(r.minted_cookie("sid", Some("collect.attacker.example")), None, "another site");
        assert_eq!(r.minted_cookie("sid", Some("api.shop.example")), None, "a sibling host");
        assert_eq!(r.minted_cookie("sid", None), None, "a host built at call time");
    }

    /// The walk recorded how far each cookie the site set for its whole domain goes, and every step of the chain
    /// under that domain sends it: the clearance rides a step on the site's subdomain over plain HTTP, so the door
    /// never walls that step and the browser never has to open for it. A cookie set for the one host stays on that
    /// host; the clear, another site and the route's own tokens get nothing.
    #[test]
    fn a_clearance_the_walk_earned_carries_every_step_of_the_chain() {
        let mut r = runner("https://www.shop.example.com/");
        r.jar.insert("cf_clearance".to_string(), "site-wide-pass".to_string());
        r.jar_domains.insert("cf_clearance".to_string(), ".shop.example.com".to_string());

        let own_ask = r.with_session_cookies(&get("https://www.shop.example.com/search?q=dune"));
        let own = cookie(&own_ask).unwrap_or_default();
        assert!(own.contains("sid=host-only-secret") && own.contains("cf_clearance=site-wide-pass"), "the session's own host gets the jar whole: {own}");

        let step_ask = r.with_session_cookies(&get("https://api.shop.example.com/v1/items"));
        let step = cookie(&step_ask).unwrap_or_default();
        assert!(step.contains("cf_clearance=site-wide-pass"), "the clearance rides every step of the chain: {step:?}");
        assert!(!step.contains("sid="), "a cookie set for one host stays on that host: {step:?}");
        assert!(!step.contains("x-csrf-token"), "the route's own tokens never ride as cookies: {step:?}");

        let deep_ask = r.with_session_cookies(&get("https://cdn.img.shop.example.com/pic"));
        let deep = cookie(&deep_ask).unwrap_or_default();
        assert!(deep.contains("cf_clearance=site-wide-pass"), "anywhere under the recorded domain: {deep:?}");
        assert_eq!(cookie(&r.with_session_cookies(&get("https://shop.other.net/"))), None, "another site gets none of it");
        assert_eq!(cookie(&r.with_session_cookies(&get("http://api.shop.example.com/v1"))), None, "never in the clear");
    }

    /// A step that names a cookie finds it wherever the cookie's own recorded reach goes: on any host of the site
    /// when the site set it for the site's domain, on the jar's host alone when it set it for that host. Another
    /// site never draws it, nor a host built at call time.
    #[test]
    fn a_cookie_named_by_a_step_goes_where_its_recorded_reach_goes() {
        let mut r = runner("https://www.shop.example.com/");
        r.jar.insert("cf_clearance".to_string(), "site-wide-pass".to_string());
        r.jar_domains.insert("cf_clearance".to_string(), ".shop.example.com".to_string());
        assert_eq!(r.minted_cookie("cf_clearance", Some("api.shop.example.com")).as_deref(), Some("site-wide-pass"), "the clearance is on the subdomain too");
        assert_eq!(r.minted_cookie("sid", Some("www.shop.example.com")).as_deref(), Some("host-only-secret"));
        assert_eq!(r.minted_cookie("sid", Some("api.shop.example.com")), None, "a host-only cookie stays on its host");
        assert_eq!(r.minted_cookie("sid", Some("collect.attacker.net")), None, "another site");
        assert_eq!(r.minted_cookie("sid", None), None, "a host built at call time");
    }

    /// A route client on a page of `shop.example`, rooted at the page it was learned on, with a session in its jar:
    /// what a call that went stale re-mints before anything opens a browser.
    fn client_on_a_page() -> RouteClient {
        let api = Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/list".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let g = build(&[Trace { exchanges: vec![api], inputs: vec![] }], |_| true).unwrap();
        let mut c = RouteClient::new(g);
        c.root = Some("https://shop.example/search?q=lamp".into());
        c.target = Some(("GET".into(), "/api/list".into()));
        c.jar.insert("sid".to_string(), "old".to_string());
        c
    }

    /// A page that hands a session value back: the fetch sees the jar's cookie and answers with a new one.
    struct HandingBack(Option<u16>);
    impl Fetch for HandingBack {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let sent = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
            assert_eq!(sent, "sid=old", "the page is asked with the session the call holds");
            Ok(Exchange {
                method: "GET".into(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: self.0.unwrap_or(200),
                response_headers: vec![("set-cookie".into(), "sid=fresh; Path=/; Max-Age=3600".into())],
                response_body: Some("<html></html>".into()),
                response_mime: "text/html".into(),
                resource_type: Some("Document".into()),
                main_frame: Some(true),
            })
        }
    }

    /// A site whose page carries the search it was asked, written into the document by the server.
    struct RenderedSearch;
    impl Fetch for RenderedSearch {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let q = req.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.to_string());
            let (status, body) = match (req.url.path(), q) {
                ("/search", Some(q)) => (200, format!("<!doctype html><html><head><script>window.__SEARCH__ = {{ q: '{q}' }};</script></head><body></body></html>")),
                _ => (404, String::new()),
            };
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status,
                response_headers: vec![],
                response_body: Some(body),
                response_mime: "text/html".into(),
                resource_type: Some("Document".into()),
                main_frame: Some(true),
            })
        }
    }

    /// The walk's page holds the walked search in its document. Opened for another value, the sandbox boots the
    /// site's own document for that address, so the page signs the call the caller asked for and not the walk's.
    #[test]
    fn a_page_opened_for_another_value_boots_the_sites_document_for_it() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let mut r = runner("https://www.shop.example/");
        r.transport.fetch = Box::new(RenderedSearch);
        r.page = Some("https://www.shop.example/search?q={q}".to_string());
        r.page_html = Some("<!doctype html><html><head><script>window.__SEARCH__ = { q: 'walked' };</script></head><body></body></html>".to_string());
        r.scripts = vec![crate::signing::Script {
            url: "https://cdn.shop.example/app.js".into(),
            body: "fetch('/api/search', { method: 'POST', headers: { 'x-sig': 'sig-' + window.__SEARCH__.q }, body: JSON.stringify(window.__SEARCH__) });".into(),
        }];
        let asked = Request { method: "POST".into(), url: "https://www.shop.example/api/search".parse().unwrap(), exchange: 1, headers: vec![], body: None };
        let signed = r.sign_request(&asked, &HashMap::from([("q".to_string(), "asked".to_string())])).expect("the page's signed call");
        assert_eq!(signed.body.as_deref(), Some(br#"{"q":"asked"}"#.as_slice()), "{:?}", signed.body.as_deref().map(String::from_utf8_lossy));
        assert!(signed.headers.iter().any(|(k, v)| k == "x-sig" && v == "sig-asked"), "{:?}", signed.headers);

        // The walked value still boots the page the route carries: nothing is asked of the site for it.
        let mut r = runner("https://www.shop.example/");
        r.transport.fetch = Box::new(RenderedSearch);
        r.page = Some("https://www.shop.example/search?q=walked".to_string());
        r.page_html = Some("<!doctype html><html><head><script>window.__SEARCH__ = { q: 'carried' };</script></head><body></body></html>".to_string());
        r.scripts = vec![crate::signing::Script {
            url: "https://cdn.shop.example/app.js".into(),
            body: "fetch('/api/search', { method: 'POST', headers: {}, body: JSON.stringify(window.__SEARCH__) });".into(),
        }];
        let signed = r.sign_request(&asked, &HashMap::new()).expect("the page's signed call");
        assert_eq!(signed.body.as_deref(), Some(br#"{"q":"carried"}"#.as_slice()));
    }

    /// A call that falls back says so, with why, and says each thing once: a fallback that still answers is otherwise
    /// silent, and a route that only ever answers through one reads as healthy.
    #[test]
    fn a_fallback_is_said_with_its_reason_and_once() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let mut r = runner("https://www.shop.example/");
        r.transport.fetch = Box::new(RenderedSearch);
        // The site has no page at this address: nothing to boot for the new value.
        r.page = Some("https://www.shop.example/gone?q={q}".to_string());
        r.page_html = Some("<!doctype html><html><body></body></html>".to_string());
        r.scripts = vec![crate::signing::Script { url: "https://cdn.shop.example/app.js".into(), body: "1".into() }];
        let asked = Request { method: "POST".into(), url: "https://www.shop.example/api/search".parse().unwrap(), exchange: 1, headers: vec![], body: None };
        let inputs = HashMap::from([("q".to_string(), "asked".to_string())]);
        assert!(r.sign_request(&asked, &inputs).is_none(), "no page, and no browser to fall back on");
        assert!(r.sign_request(&asked, &inputs).is_none());
        let told = r.fell_back.lock().unwrap().clone();
        assert_eq!(told.len(), 1, "{told:?}");
        assert!(told[0].contains("did not hand over the page"), "{told:?}");
    }

    /// A site whose door is a page of script: without the pass it answers 403 and the page that computes the pass, from
    /// a script the page names; with it, the page.
    struct ScriptDoor;
    impl Fetch for ScriptDoor {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let sent = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
            let (status, mime, body) = match req.url.path() {
                "/door.js" => (200, "text/javascript", "window.answer = function (a, b) { return String(a * b); };".to_string()),
                _ if sent.contains("pass=42") => (200, "text/html", "<html><body><h1>Lamps</h1></body></html>".to_string()),
                _ => (403, "text/html", "<html><head><script src=\"/door.js\"></script></head><body><script>document.cookie = 'pass=' + window.answer(6, 7) + '; path=/';</script></body></html>".to_string()),
            };
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status,
                response_headers: vec![("content-type".into(), mime.into())],
                response_body: Some(body),
                response_mime: mime.into(),
                resource_type: Some("Document".into()),
                main_frame: Some(true),
            })
        }
    }

    /// A call that meets a door computes what a browser would do there: the door's page is run in the sandbox with the
    /// call's session, the script it names fetched over the call's transport, and the pass it writes joins the jar. No
    /// browser opens; the site's next answer says whether the pass is one. A door with no script to run earns nothing.
    #[test]
    fn a_door_that_is_a_page_of_script_is_computed_not_visited() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        crate::sandbox::DOOR_PASS_IN_TEST.set(Some(true));
        let mut c = client_on_a_page();
        assert!(c.browser.is_none(), "nothing here can open a browser");
        assert!(c.refresh_with(&mut ScriptDoor), "the door's own page earned its pass");
        assert_eq!(c.jar.get("pass").map(String::as_str), Some("42"));
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("old"), "the session it had is kept");
        assert!(c.fell_back().iter().any(|n| n.contains("run in the sandbox") && n.contains("pass")), "{:?}", c.fell_back());
        // With the pass the page answers, and there is nothing more to earn.
        let again = c.refresh_with(&mut ScriptDoor);
        assert!(!again, "the page answered and set nothing new");
    }

    /// A door's pass is held to the rules every step of the call is. For a route that came from another node: the page's
    /// scripts and calls reach only the origins the route names (a sibling host of the site is asked nothing, a script
    /// from it included); each request carries the cookies a browser would send it; the page's script reads only the
    /// cookies known not to be HttpOnly, on its own path; and an answer that replaces the owner's session ends the pass
    /// with nothing it earned kept.
    #[test]
    fn a_doors_pass_is_held_to_the_calls_rules() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        // The door pass is off by default (#562); this test holds the pass to its rules, so it turns it on, as the
        // test of a door computed in the sandbox does, instead of relying on one run before it on the same thread.
        crate::sandbox::DOOR_PASS_IN_TEST.set(Some(true));
        type Asked = std::rc::Rc<std::cell::RefCell<Vec<(String, Option<String>, Option<String>)>>>;
        struct Door(Asked);
        impl Fetch for Door {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                let cookie = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone());
                self.0.borrow_mut().push((req.url.to_string(), cookie, req.text().map(String::from)));
                let (status, mime, set, body) = match (req.url.host_str().unwrap_or_default(), req.url.path()) {
                    (_, "/door.js") => (200, "text/javascript", None, "window.go = function () { fetch('https://tenant.shop.example.com/collect', { method: 'POST', body: document.cookie }); return fetch('/report', { method: 'POST', body: document.cookie }); };".to_string()),
                    (_, "/sibling.js") => (200, "text/javascript", None, "window.sibling = true;".to_string()),
                    (_, "/report") => (200, "application/json", Some("sid=someone-elses; Path=/"), "{}".to_string()),
                    _ => (403, "text/html", None, "<html><head><script src=\"/door.js\"></script><script src=\"https://tenant.shop.example.com/sibling.js\"></script></head><body><script>go().then(function () { document.cookie = 'pass=42; path=/'; });</script></body></html>".to_string()),
                };
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status,
                    response_headers: [("content-type".to_string(), mime.to_string())].into_iter().chain(set.map(|c| ("set-cookie".to_string(), c.to_string()))).collect(),
                    response_body: Some(body),
                    response_mime: mime.into(),
                    resource_type: None,
                    main_frame: None,
                })
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
        }
        let asked: Asked = Default::default();
        let mut c = client_on_a_page();
        // On names the public internet lists: the sandbox itself refuses a page's call to any other.
        c.graph.steps[0].url = "https://shop.example.com/api/list".into();
        c.root = Some("https://shop.example.com/search?q=lamp".into());
        c.egress = crate::egress::Egress::Foreign;
        let meta = |path: &str, http_only: bool, order: u64| CookieMeta { path: path.into(), expires: None, order, http_only: Some(http_only), bound_to: None };
        c.jar = HashMap::from([("sid".to_string(), "old".to_string()), ("pref".to_string(), "dark".to_string()), ("admin".to_string(), "a".to_string())]);
        c.cookie_meta = HashMap::from([("sid".to_string(), meta("/", true, 1)), ("pref".to_string(), meta("/", false, 2)), ("admin".to_string(), meta("/admin", false, 3))]);
        let owner = c.jar.clone();
        let within = Within::new(["https://shop.example.com".to_string()], c.home(), owner.clone());
        let rule = DoorRule { within: Some(&within), owner: Some(&owner), material: true };
        let door = Door(asked.clone()).fetch(&get("https://shop.example.com/search?q=lamp")).unwrap();
        asked.borrow_mut().clear();
        let gained = c.compute_the_door(&mut Door(asked.clone()), &door, &rule);
        let asked = asked.borrow();
        assert!(asked.iter().all(|(u, _, _)| !u.contains("tenant.shop.example.com")), "a host the route doesn't name is asked nothing: {asked:?}");
        let script = asked.iter().find(|(u, _, _)| u.ends_with("/door.js")).expect("the door's own script");
        assert!(script.1.as_deref().is_some_and(|c| c.contains("sid=old") && c.contains("pref=dark") && !c.contains("admin=")), "the script is asked with the cookies a browser sends it: {script:?}");
        let report = asked.iter().find(|(u, _, _)| u.ends_with("/report")).unwrap_or_else(|| panic!("the page's own call: {asked:?}"));
        assert_eq!(report.2.as_deref(), Some("pref=dark"), "the page's script reads only what a browser shows it");
        assert!(!gained, "an answer that replaces the owner's session earns nothing");
        assert_eq!((c.jar.get("sid").map(String::as_str), c.jar.get("pass")), (Some("old"), None));
    }

    /// The same door with the door pass as a node has it unless its owner turned it on: the page is not run, the
    /// script it names is not even asked for, and the jar gains nothing.
    #[test]
    fn a_doors_page_is_not_run_on_a_call_unless_the_door_pass_is_turned_on() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        struct Asked(Vec<String>);
        impl Fetch for Asked {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.0.push(req.url.path().to_string());
                ScriptDoor.fetch(req)
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
        }
        crate::sandbox::DOOR_PASS_IN_TEST.set(Some(crate::sandbox::door_pass_on(None)));
        let mut c = client_on_a_page();
        let mut door = Asked(Vec::new());
        assert!(!c.refresh_with(&mut door), "the door's page ran with the door pass off");
        assert_eq!(c.jar.get("pass"), None, "{:?}", c.jar);
        assert!(!door.0.iter().any(|p| p == "/door.js"), "the door's script was asked for: {:?}", door.0);
    }

    /// The same page, answering with the cookie it was sent: nothing new.
    struct Same;
    impl Fetch for Same {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            Ok(Exchange {
                method: "GET".into(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![("set-cookie".into(), "sid=old; Path=/".into())],
                response_body: Some("<html></html>".into()),
                response_mime: "text/html".into(),
                resource_type: Some("Document".into()),
                main_frame: Some(true),
            })
        }
    }


    /// A shared route opens a browser only on its own site, and only when the owner allows it: its root is the
    /// contributor's URL, and the browser here is the owner's.
    #[test]
    fn a_shared_route_mints_only_on_its_own_site_and_only_when_allowed() {
        let foreign = client_on_a_page().with_egress(crate::egress::Egress::Foreign);
        assert!(foreign.on_the_routes_site("https://shop.example/x"), "its own site");
        assert!(!foreign.on_the_routes_site("http://shop.example/x"), "never in the clear");
        assert!(!foreign.on_the_routes_site("https://elsewhere.example/"), "another site");
        assert!(!foreign.used_browser());
        // The owner's setting off: no browser is attached to a shared route at all.
        let refused = client_on_a_page().with_egress(crate::egress::Egress::Foreign).with_browser("/bin/true");
        assert!(refused.browser.is_none());
        // On: a browser, and it may only open the route's own site.
        let allowed = client_on_a_page().with_egress(crate::egress::Egress::Foreign).with_shared_mint(true).with_browser("/bin/true");
        assert!(allowed.browser.is_some());
        assert!(allowed.on_the_routes_site("https://shop.example/x"));
    }

    /// A heal of a route that came from another node walks a page someone else named, so it never walks in the site's
    /// own profile, where the owner is signed in, nor in a browser the owner already has running: it walks in an empty
    /// profile of its own, private to the owner, gone with the client. The node's own route still heals in the site's
    /// profile and the running browser, whatever order the client was built in.
    #[test]
    fn a_strangers_heal_never_opens_the_owners_profile() {
        let owners = unbrowse_files::private::home().join("profiles").join("shop.example").to_string_lossy().into_owned();
        let cdp = || Some("ws://127.0.0.1:9222/devtools/browser/owners".to_string());
        let foreign = |c: RouteClient| c.with_egress(crate::egress::Egress::Foreign).with_shared_mint(true);
        for client in [
            foreign(client_on_a_page()).with_browser("/bin/true").with_cdp(cdp()).with_root("https://shop.example/", "GET", "list"),
            foreign(client_on_a_page()).with_cdp(cdp()).with_root("https://shop.example/", "GET", "list").with_browser("/bin/true"),
        ] {
            let b = client.browser.as_ref().expect("the owner lets it open a browser");
            let profile = b.profile.clone().unwrap_or_default();
            assert_ne!(profile, owners, "never the site's own profile");
            assert!(std::path::Path::new(&profile).is_dir() && std::fs::read_dir(&profile).unwrap().next().is_none(), "an empty profile of its own: {profile}");
            assert_eq!(b.cdp_endpoint, None, "never the browser the owner has running");
            drop(client);
            assert!(!std::path::Path::new(&profile).exists(), "thrown away with the client");
        }
        let own = client_on_a_page().with_browser("/bin/true").with_cdp(cdp()).with_root("https://shop.example/", "GET", "list");
        let b = own.browser.as_ref().unwrap();
        assert_eq!(b.profile.as_deref(), Some(owners.as_str()), "the node's own route heals in the site's profile");
        assert_eq!(b.cdp_endpoint, cdp());
    }

    /// The local proxy resolves names under the node's own rule, which the owner's "Reach private networks" loosens. A
    /// route that came from another node is held to public addresses whatever Settings say, so with that setting on it
    /// never goes through the proxy, where a public name could resolve inside the network unchecked by its rule.
    #[test]
    fn a_strangers_call_never_resolves_under_a_rule_weaker_than_its_own() {
        use crate::egress::Egress::{Foreign, Own};
        assert!(!resolves_under_its_own_rule(Foreign, true), "the owner's setting on: no proxy for someone else's route");
        assert!(resolves_under_its_own_rule(Foreign, false), "off: the proxy's rule refuses what its own does");
        assert!(resolves_under_its_own_rule(Own, true) && resolves_under_its_own_rule(Own, false));
    }

    /// What the node writes and reads back as it walks (a heal's walk log, a site's capture) sits in its own scratch
    /// folder, under its home and its owner's alone, never in the machine's shared temporary folder by a name another
    /// local user could make first and fill with a walk of their own.
    #[test]
    fn a_walk_the_node_reads_back_is_kept_where_only_the_owner_writes() {
        let scratch = unbrowse_files::private::scratch().unwrap();
        let heal = client_on_a_page().with_browser("/bin/true");
        let capture = &heal.browser.as_ref().unwrap().capture_dir;
        assert!(capture.starts_with(&scratch), "{}", capture.display());
        let site = crate::site::Site::new();
        assert!(site.capture_root.starts_with(unbrowse_files::private::home()), "{}", site.capture_root.display());
        assert!(!site.capture_root.starts_with(std::env::temp_dir()) || unbrowse_files::private::home().starts_with(std::env::temp_dir()));
    }

    /// A session that went stale is re-minted browserless: the route's page is fetched once over the call's own
    /// transport, with the jar's cookies, and the cookie the page hands back is the session from then on — no browser
    /// opens for a value the page itself re-issued.
    #[test]
    fn a_stale_session_is_refreshed_from_the_page_without_a_browser() {
        let mut c = client_on_a_page();
        let mut page = HandingBack(None);
        assert!(c.refresh_with(&mut page));
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("fresh"));
        assert!(c.jar_domains.is_empty(), "a host-only cookie has no reach to record");
    }

    /// Only news changes the session: a page that hands back what the jar already holds, or refuses to answer, leaves
    /// the jar as it was and says so — the walk stays the browser's to make.
    #[test]
    fn a_page_that_hands_back_nothing_new_leaves_the_jar_alone() {
        let mut c = client_on_a_page();
        assert!(!c.refresh_with(&mut Same));
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("old"));
        let mut c = client_on_a_page();
        assert!(!c.refresh_with(&mut HandingBack(Some(403))), "a refusal is the wall's");
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("old"));
    }

    /// A browser sends a request's cookies longest-path first, then oldest first, and drops the ones whose time ran
    /// out. The jar keeps what each line said beyond the value (`CookieMeta`) so a call goes out in that order: a site
    /// that binds a token to the request it came with reads it, and one that never checks sees a browser's request.
    #[test]
    fn cookies_go_out_in_the_order_a_browser_sends_them() {
        let mut r = runner("https://www.shop.example/");
        r.jar = jar_of(&[("a", "1"), ("b", "2"), ("c", "3"), ("old", "x")]);
        r.cookie_meta = HashMap::from([
            ("a".to_string(), CookieMeta { path: "/".into(), expires: None, order: 1, http_only: None, bound_to: None }),
            ("b".to_string(), CookieMeta { path: "/api".into(), expires: None, order: 2, http_only: None, bound_to: None }),
            ("c".to_string(), CookieMeta { path: "/api/v1".into(), expires: None, order: 3, http_only: None, bound_to: None }),
            ("old".to_string(), CookieMeta { path: "/".into(), expires: Some(1.0), order: 4, http_only: None, bound_to: None }),
        ]);
        let ask = r.with_session_cookies(&get("https://www.shop.example/api/v1/items"));
        let sent = cookie(&ask).unwrap_or_default();
        let names: Vec<&str> = sent.split("; ").map(|p| p.split('=').next().unwrap_or_default()).collect();
        assert_eq!(names, ["c", "b", "a"], "longest path first, then oldest; the expired cookie is gone: {sent}");
    }

    /// A cookie goes only where a browser would send it: its path covers the request's (`/admin` reaches `/admin/x`,
    /// never `/public` or `/administrator`), its life hasn't run out, and the host is its own. For a route that came
    /// from another node, a cookie its step names by its own field is held to the same rule.
    #[test]
    fn a_cookie_goes_only_to_the_paths_its_line_covers() {
        let meta = |path: &str, expires: Option<f64>, order: u64| CookieMeta { path: path.into(), expires, order, http_only: Some(true), bound_to: None };
        let mut r = runner("https://www.shop.example/");
        r.jar = jar_of(&[("sid", "s"), ("admin", "a"), ("old", "o")]);
        r.cookie_meta = HashMap::from([
            ("sid".to_string(), meta("/", None, 1)),
            ("admin".to_string(), meta("/admin", None, 2)),
            ("old".to_string(), meta("/", Some(1.0), 3)),
        ]);
        let sent = |r: &Runner, u: &str| cookie(&r.with_session_cookies(&get(u))).map(String::from);
        assert_eq!(sent(&r, "https://www.shop.example/public").as_deref(), Some("sid=s"), "a path the cookie's line doesn't cover");
        assert_eq!(sent(&r, "https://www.shop.example/administrator").as_deref(), Some("sid=s"), "a path that only starts with its text");
        assert_eq!(sent(&r, "https://www.shop.example/admin/users").as_deref(), Some("admin=a; sid=s"), "under its path, longest path first");
        // A stranger's step that names the owner's path-scoped cookie by its own field doesn't carry it off its path.
        r.owner = Some(r.jar.clone());
        r.session_allowed = true;
        let mut named = get("https://www.shop.example/public");
        named.headers.push(("cookie".into(), "admin=a; theirs=1".into()));
        assert_eq!(cookie(&r.with_session_cookies(&named)), Some("theirs=1; sid=s"));
    }

    /// The line that sets a cookie says whether a page's script may read it, and the jar keeps that beside the value;
    /// a jar written before that was kept reads every cookie as one whose HttpOnly is unknown.
    #[test]
    fn a_cookie_keeps_whether_its_line_said_httponly() {
        let mut r = runner("https://www.shop.example/");
        let set = |line: &str| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/account/login".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), line.into())],
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        r.keep_set_cookies(&set("session=1; Path=/; Secure; HttpOnly"));
        r.keep_set_cookies(&set("pref=dark; Path=/"));
        r.keep_set_cookies(&set("step=2"));
        assert_eq!(r.cookie_meta["session"].http_only, Some(true));
        assert_eq!(r.cookie_meta["pref"].http_only, Some(false));
        assert_eq!(r.cookie_meta["step"].path, "/account", "no Path: the folder of the address that set it");
        let old: HashMap<String, CookieMeta> = serde_json::from_str(r#"{"sid": {"path": "/", "order": 1}}"#).unwrap();
        assert_eq!(old["sid"].http_only, None, "an older record says nothing of HttpOnly");
        assert!(!old["sid"].shown_to_script(), "and is kept from a page's script");
    }

    /// An answer whose line ends a cookie by an Expires already past (earlier this year, with dashes) takes it out of the
    /// jar, as a browser does; a future Expires is the cookie's life, and the jar sends it no later.
    #[test]
    fn an_expires_already_past_takes_the_cookie_out_of_the_jar() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let year = 1970 + now / 31_556_952;
        let mut r = runner("https://www.shop.example/");
        let set = |line: String| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), line)],
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        r.keep_set_cookies(&set("sid=live; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT".into()));
        assert!(r.cookie_meta["sid"].expires.is_some_and(|e| e > now as f64));
        r.keep_set_cookies(&set(format!("sid=old; Path=/; Expires=Thu, 01-Jan-{year} 00:00:01 GMT")));
        assert!(!r.jar.contains_key("sid"), "{:?}", r.jar);
    }

    /// A heal's fresh session puts each value in the jar with its own reach: one the walk saw set for its host alone
    /// never keeps the domain the name's older value had, and a value that changed with nothing said of its line keeps
    /// nothing of the old line's path.
    #[test]
    fn a_healed_value_never_keeps_an_older_values_reach() {
        let mut jar = jar_of(&[("pass", "old")]);
        let mut domains = HashMap::from([("pass".to_string(), ".shop.example".to_string())]);
        let session = crate::mint::MintedSession { cookies: jar_of(&[("pass", "new")]), ..Default::default() };
        let before = jar.clone();
        merge_sighting(&mut jar, Some("shop.example"), "https://shop.example/", session, &HashSet::new(), &mut domains);
        assert_eq!((jar.get("pass").map(String::as_str), domains.get("pass")), (Some("new"), None));
        let mut meta = HashMap::from([("pass".to_string(), CookieMeta { path: "/admin".into(), expires: None, order: 1, http_only: Some(false), bound_to: None })]);
        note_facts(&mut meta, &HashMap::new(), &jar, &before);
        assert!(!meta.contains_key("pass"), "the old line's path and HttpOnly went with its value");
        // A walk whose browser was asked and holds nothing for the host: the site ended the session, and the jar's goes.
        let judged = crate::mint::MintedSession { judged: true, ..Default::default() };
        merge_sighting(&mut jar, Some("shop.example"), "https://shop.example/", judged, &HashSet::new(), &mut domains);
        assert!(!jar.contains_key("pass"), "{jar:?}");
    }

    /// The jar keeps one cookie per name, and the value it sends always goes only where its own line said: of two
    /// cookies of one name the narrower is kept with its own path or domain (on a tie the one held), so a request the
    /// kept line doesn't cover gets no cookie of that name, never the other line's value. HttpOnly is never loosened.
    #[test]
    fn a_cookie_value_goes_only_where_its_own_line_covers() {
        let answer = |lines: &[&str]| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: lines.iter().map(|l| ("set-cookie".to_string(), l.to_string())).collect(),
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        let sent = |r: &Runner, u: &str| cookie(&r.with_session_cookies(&get(u))).map(|c| c.split("; ").filter(|p| p.starts_with("pair=")).collect::<Vec<_>>().join(""));
        let fresh = || {
            let mut r = runner("https://www.shop.example/");
            r.jar.clear();
            r
        };
        // Disjoint paths of one length, set in one answer: the first is held, and goes to its own path alone.
        let mut r = fresh();
        r.keep_set_cookies(&answer(&["pair=foo; Path=/foo", "pair=bar; Path=/bar"]));
        assert_eq!((sent(&r, "https://www.shop.example/foo/x").as_deref(), sent(&r, "https://www.shop.example/bar/x").as_deref()), (Some("pair=foo"), None));
        // Paths that don't nest: the narrower is kept with its own path, whichever came first, across answers too.
        for order in [["pair=long; Path=/barbaz", "pair=short; Path=/foo"], ["pair=short; Path=/foo", "pair=long; Path=/barbaz"]] {
            let mut r = fresh();
            r.keep_set_cookies(&answer(&order[..1]));
            r.keep_set_cookies(&answer(&order[1..]));
            assert_eq!((sent(&r, "https://www.shop.example/barbaz").as_deref(), sent(&r, "https://www.shop.example/foo").as_deref()), (Some("pair=long"), None), "{order:?}");
        }
        // Two domains: the narrower domain's value with its own domain, so a host only the wider one reaches gets none.
        for order in [["pair=wide; Domain=.shop.example; Path=/", "pair=narrow; Domain=.www.shop.example; Path=/"], ["pair=narrow; Domain=.www.shop.example; Path=/", "pair=wide; Domain=.shop.example; Path=/"]] {
            let mut r = fresh();
            r.keep_set_cookies(&answer(&order));
            assert_eq!(r.jar.get("pair").map(String::as_str), Some("narrow"), "{order:?}");
            assert_eq!(r.jar_domains.get("pair").map(String::as_str), Some(".www.shop.example"));
            assert_eq!(sent(&r, "https://api.shop.example/x"), None, "{order:?}");
        }
        // Another line's HttpOnly still holds over the one kept; and taking out a cookie of another path leaves the jar's.
        let mut r = fresh();
        r.keep_set_cookies(&answer(&["pair=narrow; Path=/admin", "pair=wide; Path=/; HttpOnly"]));
        assert_eq!((r.jar.get("pair").map(String::as_str), r.cookie_meta["pair"].http_only), (Some("narrow"), Some(true)));
        r.keep_set_cookies(&answer(&["pair=; Path=/; Max-Age=0"]));
        assert_eq!(r.jar.get("pair").map(String::as_str), Some("narrow"));
    }

    /// What the node once knew to be hidden from a page's script stays hidden for that value: the site setting the same
    /// value again without HttpOnly, or a browser saying so of it, leaves it HttpOnly, and a value whose HttpOnly was
    /// never known stays unknown, which is hidden. A new value is a new cookie and takes its own line's word.
    #[test]
    fn a_cookie_once_hidden_from_script_stays_hidden_for_its_value() {
        let mut r = runner("https://www.shop.example/");
        let set = |line: &str| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), line.into())],
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        let page: url::Url = "https://www.shop.example/search".parse().unwrap();
        r.keep_set_cookies(&set("token=v1; Path=/; HttpOnly"));
        r.keep_set_cookies(&set("token=v1; Path=/"));
        assert_eq!(r.cookie_meta["token"].http_only, Some(true), "the same value set again stays hidden");
        assert!(!r.page_cookies(&page).contains("token="));
        r.keep_set_cookies(&set("token=v2; Path=/"));
        assert_eq!(r.cookie_meta["token"].http_only, Some(false), "a new value takes its own line's word");
        // A value the jar held with nothing known of it stays unknown when set again as it was.
        r.jar.insert("legacy".into(), "l".into());
        r.keep_set_cookies(&set("legacy=l; Path=/"));
        assert_eq!(r.cookie_meta["legacy"].http_only, None);
        assert!(!r.page_cookies(&page).contains("legacy="));
        // And a browser's word is held to the same rule.
        let mut meta = HashMap::from([("sid".to_string(), CookieMeta { path: "/".into(), expires: None, order: 1, http_only: Some(true), bound_to: None })]);
        let jar = jar_of(&[("sid", "s")]);
        let facts = HashMap::from([("sid".to_string(), agent_browser_core::session::CookieFacts { path: "/".into(), http_only: false, expires: None })]);
        note_facts(&mut meta, &facts, &jar, &jar);
        assert_eq!(meta["sid"].http_only, Some(true));
    }

    /// What a walk's browser knew of each cookie (its path, whether it is HttpOnly) is kept beside the jar, for the
    /// cookies the jar holds, and a cookie already recorded keeps its place in the order.
    #[test]
    fn a_walks_cookie_facts_are_kept_beside_the_jar() {
        let dir = std::env::temp_dir().join(format!("unbrowse-facts-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let jar = jar_of(&[("sid", "s"), ("pref", "p")]);
        std::fs::write(dir.join("www.shop.example.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        let fact = |path: &str, http_only: bool| agent_browser_core::session::CookieFacts { path: path.into(), http_only, expires: None };
        let facts = HashMap::from([("sid".to_string(), fact("/", true)), ("pref".to_string(), fact("/app", false)), ("gone".to_string(), fact("/", false))]);
        note_cookie_facts(&dir, "www.shop.example", &facts, &HashMap::new());
        let meta: HashMap<String, CookieMeta> = unbrowse_files::JAR.read_at(&meta_path(&dir, "www.shop.example")).unwrap().unwrap();
        assert_eq!((meta["sid"].http_only, meta["pref"].http_only, meta["pref"].path.as_str()), (Some(true), Some(false), "/app"));
        assert!(!meta.contains_key("gone"), "a cookie the jar doesn't hold has no record");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A page's script reads in `document.cookie` exactly what a browser shows a script on that page: the cookies that
    /// go with a request to it (host or domain, path, unexpired) and are known not to be HttpOnly. An HttpOnly session,
    /// a cookie whose HttpOnly was never recorded, one for another path, one that ran out and one for another host of
    /// the site are all kept from it.
    #[test]
    fn a_pages_script_sees_only_the_cookies_a_browser_shows_it() {
        let meta = |path: &str, expires: Option<f64>, order: u64, http_only: Option<bool>| CookieMeta { path: path.into(), expires, order, http_only, bound_to: None };
        let mut r = runner("https://www.shop.example/");
        r.jar = jar_of(&[("sid", "secret"), ("pref", "dark"), ("legacy", "l"), ("admin", "a"), ("old", "o"), ("wide", "w")]);
        r.jar_domains.insert("wide".into(), ".shop.example".into());
        r.cookie_meta = HashMap::from([
            ("sid".to_string(), meta("/", None, 1, Some(true))),
            ("pref".to_string(), meta("/", None, 2, Some(false))),
            ("admin".to_string(), meta("/admin", None, 4, Some(false))),
            ("old".to_string(), meta("/", Some(1.0), 5, Some(false))),
            ("wide".to_string(), meta("/", None, 6, Some(false))),
        ]);
        assert_eq!(r.page_cookies(&"https://www.shop.example/search?q=x".parse().unwrap()), "pref=dark; wide=w");
        assert_eq!(r.page_cookies(&"https://www.shop.example/admin/panel".parse().unwrap()), "admin=a; pref=dark; wide=w");
        assert_eq!(r.page_cookies(&"https://api.shop.example/".parse().unwrap()), "wide=w", "another host of the site sees only a cookie set for its domain");
        // A route that came from another node shows the page nothing it may not carry, and nothing off its origins.
        r.owner = Some(HashMap::new());
        assert_eq!(r.page_cookies(&"https://www.shop.example/search".parse().unwrap()), "");
    }

    /// The line that sets a cookie also says where it goes and how long it lives, and a cookie taken out takes its
    /// metadata with it: what a later call needs to send it the way the browser did.
    #[test]
    fn a_cookie_keeps_the_path_and_place_its_line_gave_it() {
        let mut r = runner("https://www.shop.example/");
        let set = |line: &str| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), line.into())],
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        r.keep_set_cookies(&set("first=1; Path=/; Max-Age=3600"));
        r.keep_set_cookies(&set("second=2; Path=/api"));
        assert_eq!(r.cookie_meta["first"].path, "/");
        assert!(r.cookie_meta["first"].expires.is_some(), "Max-Age is kept as a time");
        assert_eq!(r.cookie_meta["second"].path, "/api");
        assert!(r.cookie_meta["second"].order > r.cookie_meta["first"].order, "the order it arrived in");
        r.keep_set_cookies(&set("first=gone; Max-Age=0; Path=/"));
        assert!(!r.cookie_meta.contains_key("first"), "a cookie taken out takes its metadata with it");
    }

    /// A token the route names in a header, which the page itself states (a header of its own, or a `<meta>` in its
    /// head): the page's answer is the freshest copy, and the jar is where a step finds it. A value the page does not
    /// state is not invented.
    #[test]
    fn a_page_that_states_a_routes_token_hands_it_over() {
        use crate::graph::{Class, Field};
        let mut c = client_on_a_page();
        c.graph.steps[0].fields.push(Field { loc: Loc::Header("x-csrf-token".into()), class: Class::Minted { name: "x-csrf-token".into() } });
        c.graph.steps[0].fields.push(Field { loc: Loc::Header("x-build-id".into()), class: Class::Minted { name: "x-build-id".into() } });
        let ex = Exchange {
            method: "GET".into(),
            url: "https://shop.example/search".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("x-csrf-token".into(), "h-9".into())],
            response_body: Some(r#"<html><head><meta name="x-build-id" content="b-1"><meta name="other" content="no"></head></html>"#.into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let found: HashMap<String, String> = c.page_tokens(&ex).into_iter().collect();
        assert_eq!(found.get("x-csrf-token").map(String::as_str), Some("h-9"));
        assert_eq!(found.get("x-build-id").map(String::as_str), Some("b-1"));
        assert_eq!(found.len(), 2, "a token the page doesn't state is not made up");
    }

    fn jar_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// A save writes what its own run changed. What another call renewed since this one read stays, and what it took
    /// out stays out.
    #[test]
    fn a_save_writes_its_own_changes_over_the_jar_as_it_stands() {
        let loaded = jar_of(&[("sid", "old"), ("gone", "x"), ("kept", "1")]);
        let on_disk = jar_of(&[("sid", "renewed-elsewhere"), ("kept", "1")]);
        let now = jar_of(&[("sid", "old"), ("gone", "x"), ("kept", "1"), ("mine", "new")]);
        let after = jar_after(Some(on_disk), Some(&loaded), &now).unwrap();
        assert_eq!(after, jar_of(&[("sid", "renewed-elsewhere"), ("kept", "1"), ("mine", "new")]));
        // A cookie this run's site deleted goes, whoever else kept it.
        let now = jar_of(&[("sid", "old"), ("kept", "1")]);
        let on_disk = jar_of(&[("sid", "old"), ("gone", "x"), ("kept", "1")]);
        assert_eq!(jar_after(Some(on_disk), Some(&loaded), &now).unwrap(), jar_of(&[("sid", "old"), ("kept", "1")]));
        // A first session has no file to measure against.
        assert_eq!(jar_after(None, None, &jar_of(&[("sid", "first")])).unwrap(), jar_of(&[("sid", "first")]));
    }

    /// Dropping a session while a call runs is the owner signing out: the call's save doesn't bring it back.
    #[test]
    fn a_session_dropped_during_a_call_stays_dropped() {
        let dir = std::env::temp_dir().join(format!("route-client-forget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shop.example.json");
        std::fs::write(&path, r#"{"sid":"signed-in"}"#).unwrap();
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let mut client = RouteClient::new(g).with_session_store(&dir);
        assert_eq!(client.jar.get("sid").map(String::as_str), Some("signed-in"));
        std::fs::remove_file(&path).unwrap();
        client.jar.insert("renewed".into(), "by-the-run".into());
        client.save_jar();
        assert!(!path.exists(), "the owner signed out");
        assert!(client.jar.is_empty(), "the rest of the call doesn't send it either");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// How far each cookie goes is kept with the jar, file beside file: a later call of the same route loads both
    /// and sends the clearance down the site without walking it again. A reach recorded for a name the jar doesn't
    /// hold says nothing about anything sent, so it goes at load.
    #[test]
    fn where_each_cookie_goes_is_kept_with_the_jar_between_calls() {
        let dir = std::env::temp_dir().join(format!("route-client-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let mut first = RouteClient::new(g.clone()).with_session_store(&dir);
        first.jar.insert("cf_clearance".into(), "site-wide-pass".into());
        first.jar_domains.insert("cf_clearance".into(), ".shop.example".into());
        first.jar_domains.insert("ghost".into(), ".shop.example".into()); // no cookie of that name in the jar
        first.save_jar();

        let second = RouteClient::new(g).with_session_store(&dir);
        assert_eq!(second.jar_domains.get("cf_clearance").map(String::as_str), Some(".shop.example"), "the reach loaded beside the jar");
        assert!(!second.jar_domains.contains_key("ghost"), "a reach for a cookie the jar doesn't hold is dropped at load");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Each host has a jar of its own, and a cookie set for the domain is the browser's for every host under it: a
    /// sign-in on `auth.` sets the session the calls on `www.` send (the owner's Ticketmaster routes: `KP_UIDz-ssn` set
    /// on `auth.ticketmaster.com` for `.ticketmaster.com`, the search on `www.`). So a route on one host reads what
    /// another host's jar holds for the domain, without its own file taking a copy; what a call gives anew or takes
    /// away of such a cookie reaches the other jars it covers; and a host's own cookie, or one of another site, never
    /// moves.
    #[test]
    fn a_cookie_given_on_one_host_reaches_a_taker_on_another_host_its_domain_covers() {
        let dir = std::env::temp_dir().join(format!("route-client-hosts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let from = jar_name(&g).unwrap();
        let on = |host: &str| {
            let mut g = g.clone();
            g.steps.iter_mut().for_each(|s| s.url = s.url.replacen(&from, host, 1));
            g
        };
        let file = |host: &str| -> HashMap<String, String> { unbrowse_files::JAR.read_at(&dir.join(format!("{host}.json"))).ok().flatten().unwrap_or_default() };
        // The sign-in, on `auth.`: the session for the domain, and a cookie of its own.
        let mut auth = RouteClient::new(on("auth.shop.example")).with_session_store(&dir);
        assert_eq!(auth.host().as_deref(), Some("auth.shop.example"));
        auth.jar.insert("sid".into(), "signed-in".into());
        auth.jar_domains.insert("sid".into(), ".shop.example".into());
        auth.jar.insert("auth_step".into(), "auth-only".into());
        auth.save_jar();
        // Another site's jar, holding a cookie of the same name for its own domain.
        std::fs::write(dir.join("shop.other.json"), r#"{"v":1,"items":{"sid":"theirs"}}"#).unwrap();

        let mut www = RouteClient::new(on("www.shop.example")).with_session_store(&dir);
        assert_eq!(www.jar.get("sid").map(String::as_str), Some("signed-in"), "the session the domain's sign-in set");
        assert!(!www.jar.contains_key("auth_step"), "a cookie of auth.'s own stays there");
        www.jar.insert("pref".into(), "dark".into());
        www.save_jar();
        assert!(!file("www.shop.example").contains_key("sid"), "read from auth.'s jar, not copied into www.'s file");
        assert_eq!(www.jar.get("sid").map(String::as_str), Some("signed-in"), "and still in hand after the save");
        assert!(!file("auth.shop.example").contains_key("pref"), "a host-only cookie never moves");

        // The site renews the session in an answer to www.: auth.'s jar holds the new one too.
        www.jar.insert("sid".into(), "renewed".into());
        www.save_jar();
        assert_eq!(file("auth.shop.example").get("sid").map(String::as_str), Some("renewed"));
        assert_eq!(file("shop.other.json".trim_end_matches(".json")).get("sid").map(String::as_str), Some("theirs"), "another site's jar is never touched");
        // And takes it away: gone from every jar it reached.
        www.jar.remove("sid");
        www.save_jar();
        assert!(!file("auth.shop.example").contains_key("sid"), "auth: {:?}", file("auth.shop.example"));
        assert!(!file("www.shop.example").contains_key("sid"), "www: {:?}", file("www.shop.example"));
        assert!(!RouteClient::new(on("api.shop.example")).with_session_store(&dir).jar.contains_key("sid"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A site ends a cookie by setting it to expire, whatever value it leaves there: the jar lets it go.
    #[test]
    fn a_cookie_set_to_expire_leaves_the_jar() {
        let mut r = runner("https://www.shop.example/");
        let answer = |line: &str| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/signout".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), line.into())],
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        r.keep_set_cookies(&answer("sid=deleted; Max-Age=0; Path=/"));
        assert!(!r.jar.contains_key("sid"), "Max-Age=0");
        r.jar.insert("sid".into(), "x".into());
        r.keep_set_cookies(&answer("sid=deleted; expires=Thu, 01 Jan 1970 00:00:00 GMT"));
        assert!(!r.jar.contains_key("sid"), "an Expires already past");
        r.keep_set_cookies(&answer("sid=fresh; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT"));
        assert_eq!(r.jar.get("sid").map(String::as_str), Some("fresh"), "Max-Age wins over Expires");
    }

    /// The site sets a cookie for its whole domain in an answer from a subdomain: the jar keeps it with the reach
    /// the site's own line gave it, so the calls after this one send it down the site — a clearance renewed on any
    /// host of the site still carries the chain. A host-only cookie set on a subdomain is that host's and stays
    /// out; a `Domain` that doesn't cover the host that set it is refused, as a browser refuses it; and a cookie
    /// the site ends leaves with its reach.
    #[test]
    fn a_domain_cookie_set_on_a_subdomain_joins_the_session_where_the_browser_sends_it() {
        let mut r = runner("https://www.shop.example.com/");
        let answer = |url: &str, line: &str| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), line.into())],
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        r.keep_set_cookies(&answer("https://api.shop.example.com/v1", "cf_clearance=new-pass; Domain=shop.example.com; Path=/"));
        assert_eq!(r.jar.get("cf_clearance").map(String::as_str), Some("new-pass"));
        assert_eq!(r.jar_domains.get("cf_clearance").map(String::as_str), Some(".shop.example.com"), "the reach is kept beside the value");

        r.keep_set_cookies(&answer("https://api.shop.example.com/v1", "sid=api-session; Path=/"));
        assert_eq!(r.jar.get("sid").map(String::as_str), Some("host-only-secret"), "a host-only cookie set on another host never reaches this jar: its own value stands");

        r.keep_set_cookies(&answer("https://tracker.other.net/collect", "sid=x; Domain=shop.example.com; Path=/"));
        assert_eq!(r.jar.get("sid").map(String::as_str), Some("host-only-secret"), "a domain the host isn't in is refused, as a browser refuses it");

        r.keep_set_cookies(&answer("https://www.shop.example.com/signout", "cf_clearance=deleted; Max-Age=0; Domain=shop.example.com"));
        assert!(!r.jar.contains_key("cf_clearance") && !r.jar_domains.contains_key("cf_clearance"), "the cookie leaves with its reach");
    }

    /// A walk says everything the browser holds for the host: a cookie it no longer holds is gone from the jar, as it
    /// is from the mint's. The route's tokens aren't cookies, and a walk that reports no cookie says nothing.
    #[test]
    fn a_heal_lets_go_of_a_cookie_the_browser_no_longer_holds() {
        let session = |cookies: &[(&str, &str)]| crate::mint::MintedSession { cookies: jar_of(cookies), tokens: HashMap::new(), domains: HashMap::new(), ..Default::default() };
        let tokens = HashSet::from(["x-csrf-token".to_string()]);
        let mut jar = jar_of(&[("old_sid", "stale"), ("x-csrf-token", "t")]);
        let mut domains = HashMap::from([("old_sid".to_string(), ".shop.example".to_string())]);
        merge_sighting(&mut jar, Some("shop.example"), "https://shop.example/", session(&[("sid", "new")]), &tokens, &mut domains);
        assert_eq!(jar, jar_of(&[("sid", "new"), ("x-csrf-token", "t")]));
        assert!(domains.is_empty(), "the cookie that left left the record of how far it went");
        merge_sighting(&mut jar, Some("shop.example"), "https://shop.example/", session(&[]), &tokens, &mut domains);
        assert_eq!(jar, jar_of(&[("sid", "new"), ("x-csrf-token", "t")]), "a walk with no cookies takes nothing out");
    }

    /// A body someone else listed names the cookies it wants and the owner's jar fills them. The jar doesn't know which
    /// of them were host-only, so such a step draws one only on the jar's own host: a sibling the site check lets
    /// through gets none. The node's own walk saw the browser send it there, so its step still does.
    #[test]
    fn a_session_cookie_a_listed_body_names_goes_only_to_the_jars_host() {
        struct Sent(std::sync::Arc<std::sync::Mutex<Vec<Request>>>);
        impl Fetch for Sent {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.0.lock().unwrap().push(req.clone());
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 200,
                    response_headers: vec![],
                    response_body: Some(r#"{"ok":true}"#.into()),
                    response_mime: "application/json".into(),
                    resource_type: None,
                    main_frame: None,
                })
            }
        }
        let step = |exchange: usize, url: &str, foreign: bool| crate::graph::Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: "GET".into(),
            status: 200,
            url: url.into(),
            fields: vec![crate::graph::Field { loc: Loc::Cookie("sid".into()), class: crate::graph::Class::Minted { name: "sid".into() } }],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign,
            held: vec![],
            fallbacks: Vec::new(),
        };
        let sent_to_sibling = |foreign: bool| {
            let graph = Graph { steps: vec![step(0, "https://api.shop.example/v1/me", foreign), step(1, "https://www.shop.example/api", foreign)], provisional: false, page_origin: None, ..Graph::default() };
            let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut r = runner("https://www.shop.example/");
            r.transport.fetch = Box::new(Sent(log.clone()));
            crate::replay::replay(&graph, &HashMap::new(), &mut r).unwrap();
            let log = log.lock().unwrap();
            assert_eq!(cookie(&log[1]), Some("sid=host-only-secret"), "the jar's own host");
            cookie(&log[0]).map(String::from)
        };
        assert_eq!(sent_to_sibling(true), None, "someone else's step on a sibling host");
        assert_eq!(sent_to_sibling(false).as_deref(), Some("sid=host-only-secret"), "the node's own walk of the site");
    }
    /// A stand-in for a site that walls every plain request, and a browser, as a script, whose page's fetch answers 200
    /// or fails: it logs each request the browser was told to make.
    #[cfg(unix)]
    /// A credential the jar holds, still inside the life its line gave, is not what a refusal is about: the call does
    /// not open a browser to earn the same cookie again. One that lapsed (or is absent) is the visit's.
    #[test]
    fn a_live_credential_costs_no_browser() {
        let door = crate::graph::Door {
            kind: crate::graph::DoorKind::Akamai,
            statuses: crate::trace::REFUSED.to_vec(),
            credential: Some("_abck".into()),
            ttl: Some(3600),
            earn: crate::graph::Earn::Browser,
            at: None,
        };
        let mut jar = HashMap::from([("_abck".to_string(), "v".to_string())]);
        let mut meta = HashMap::from([("_abck".to_string(), CookieMeta { path: "/".into(), expires: Some(now_secs() + 600.0), order: 0, http_only: None, bound_to: None })]);
        assert!(holds_the_credential(&jar, &meta, &door), "alive");
        meta.get_mut("_abck").unwrap().expires = Some(now_secs() - 1.0);
        assert!(!holds_the_credential(&jar, &meta, &door), "lapsed");
        jar.clear();
        assert!(!holds_the_credential(&jar, &meta, &door), "absent");
        // A session cookie (no expiry) is alive while the jar is.
        jar.insert("_abck".into(), "v".into());
        meta.get_mut("_abck").unwrap().expires = None;
        assert!(holds_the_credential(&jar, &meta, &door), "a session cookie");
    }

    #[cfg(unix)]
    fn a_walled_site(answer: &str, name: &str) -> (Runner, std::path::PathBuf, std::sync::Arc<std::sync::Mutex<usize>>) {
        use std::os::unix::fs::PermissionsExt;
        struct Walls(std::sync::Arc<std::sync::Mutex<usize>>);
        impl Fetch for Walls {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                *self.0.lock().unwrap() += 1;
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 403,
                    response_headers: vec![],
                    response_body: None,
                    response_mime: String::new(),
                    resource_type: None,
                    main_frame: None,
                })
            }
        }
        let dir = std::env::temp_dir().join(format!("walled-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (program, log) = (dir.join("program"), dir.join("said.log"));
        std::fs::write(&program, format!("#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$*\" in *\"get url\"*) echo https://shop.example/ ;; *) echo '{answer}' ;; esac\n", log.display())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plain = std::sync::Arc::new(std::sync::Mutex::new(0));
        let mut r = runner("https://shop.example/");
        r.transport.fetch = Box::new(Walls(plain.clone()));
        r.browser = Some(BrowserMint {
            try_controls: false,
            frames: None,
            browser: program.to_string_lossy().into_owned(),
            cdp_endpoint: None,
            user_agent: None,
            capture_dir: dir.join("capture"),
            session: "walled".into(),
            profile: None,
            _host: "shop.example".into(),
            seed: Vec::new(),
        });
        (r, log, plain)
    }

    /// Whether a step may go plainly is the write rule's question, not its method's: a POST the page sent as it loaded,
    /// that answered with data and set no cookie, changes nothing (`ledger::writes`), so the page's own code making no
    /// call for it opens no browser — the route's own request asks the site, and the site's answer says whether it
    /// needed the page's signature. A POST that may change the site still asks the page, as before.
    #[cfg(unix)]
    #[test]
    fn a_page_signed_post_that_only_asks_opens_no_browser() {
        let step = |on_load: bool, sets_cookie: bool| crate::graph::Step {
            page_signed: true,
            page_producers: vec![crate::graph::PageProducer {
                loc: Loc::Header("x-canva-analytics".into()),
                producer: crate::signing::Producer { script: "https://shop.example/app.js".into(), at: 12, frame: false },
            }],
            exchange: 2,
            method: "POST".into(),
            status: 200,
            url: "https://shop.example/_ajax/tiles".into(),
            fields: vec![],
            body: None,
            response_shape: None,
            needs_browser: true,
            reads_page: false,
            sets_cookie,
            on_load,
            foreign: false,
            held: vec![],
            fallbacks: Vec::new(),
        };
        let posting = |url: &str| Request { method: "POST".into(), url: url.parse().unwrap(), exchange: 2, headers: vec![], body: Some(br#"{"query":"resume"}"#.to_vec()) };
        let (mut r, log, _) = a_walled_site("[200,\"application/json\",[],\"{}\"]", "plain-post");
        r.page = Some("https://shop.example/templates?query=resume".into());
        r.page_html = Some("<!doctype html><html><body>templates</body></html>".into());
        r.sandbox_off.set(true);
        r.steps.insert(2, step(true, false));
        assert!(r.sign_request(&posting("https://shop.example/_ajax/tiles"), &HashMap::new()).is_none(), "the route's own request is the step's");
        assert!(!log.exists(), "the browser was told nothing");
        assert!(!r.used_browser.load(std::sync::atomic::Ordering::Relaxed), "no browser ran");
        // The same request setting a cookie may have changed the site: the page's own code is what sends it.
        r.page_read.set(false);
        r.steps.insert(2, step(true, true));
        r.sign_request(&posting("https://shop.example/_ajax/tiles"), &HashMap::new());
        assert!(log.exists(), "the browser was told, for the write");
    }

    /// A plain read the page's own code makes no call for goes out as the route builds it: the browser is not opened,
    /// whatever the page's scripts sign, because `Fetch::sign_request`'s None on a GET already means the route's own
    /// request and the site's answer says whether the page's values were needed. A page whose only page-written value
    /// is a reporting header (`sentry-trace`) answered nothing cheaper through a browser.
    #[cfg(unix)]
    #[test]
    fn a_plain_read_the_page_makes_no_call_for_opens_no_browser() {
        let (mut r, log, _) = a_walled_site("[200,\"application/json\",[],\"{}\"]", "plain-read");
        r.page = Some("https://shop.example/search?q=apollo%2011".into());
        r.page_html = Some("<!doctype html><html><body>a search</body></html>".into());
        // The page's code is on the route, and it makes no call of its own: a script that defines a reporter.
        r.scripts = vec![crate::signing::Script { url: "https://shop.example/app.js".into(), body: "window.__ub_trace = 'x';".into() }];
        r.sandbox_off.set(true);
        let asked = get("https://shop.example/services/search/page_production/?user_query=apollo%2011");
        assert!(r.sign_request(&asked, &HashMap::new()).is_none(), "the route's own request is the step's");
        assert!(!log.exists(), "the browser was told nothing");
        assert!(!r.used_browser.load(std::sync::atomic::Ordering::Relaxed), "no browser ran");
    }

    /// The walk saw this step refused, so a refusal is what it answers. No browser opens for it, on any call.
    #[cfg(unix)]
    #[test]
    fn a_refusal_the_walk_saw_opens_no_browser() {
        let (mut r, log, _) = a_walled_site("[200,\"application/json\",[],\"{}\"]", "recorded");
        r.refused_on_the_walk.insert(0);
        assert_eq!(r.fetch(&get("https://shop.example/api/probe")).unwrap().status, 403);
        assert!(!log.exists(), "the browser was told nothing");
        assert!(r.walled.is_empty());
    }

    /// Every chunk of an upload is its own request under one exchange: each goes out, and none is answered with what
    /// the site said to the one before it.
    #[cfg(unix)]
    #[test]
    fn a_walled_step_sends_each_of_its_requests() {
        let (mut r, log, plain) = a_walled_site("[200,\"application/json\",[],\"{}\"]", "chunks");
        let chunk = |bytes: &str| Request { method: "POST".into(), url: "https://shop.example/up".parse().unwrap(), exchange: 0, headers: vec![], body: Some(bytes.as_bytes().to_vec()) };
        r.fetch(&chunk("first")).unwrap();
        r.fetch(&chunk("second")).unwrap();
        assert_eq!(*plain.lock().unwrap(), 2, "the second chunk went out too");
        let said = std::fs::read_to_string(log).unwrap();
        assert!(said.contains("first") && said.contains("second"), "{said}");
    }

    /// A browser that failed may have sent the request, so the failure is one a write can't be retried from, and it
    /// isn't an address that couldn't be made.
    #[cfg(unix)]
    #[test]
    fn a_browser_that_failed_says_so_as_a_request_that_may_have_left() {
        let (mut r, _, _) = a_walled_site("not json", "fails");
        let e = r.fetch(&get("https://shop.example/api/x")).unwrap_err();
        assert!(matches!(e, ReplayError::Transport(_)), "{e}");
    }


    fn session_step_route(step: impl FnOnce(&mut crate::graph::Step)) -> Graph {
        let plain = |exchange: usize, method: &str, url: &str| crate::graph::Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: method.into(),
            status: 200,
            url: url.into(),
            fields: vec![],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign: false,
            held: vec![],
            fallbacks: Vec::new(),
        };
        let mut first = plain(0, "POST", "https://shop.example/api/visitor");
        first.sets_cookie = true;
        step(&mut first);
        let mut target = plain(1, "GET", "https://shop.example/api/me");
        target.fields.push(crate::graph::Field {
            loc: Loc::Cookie("sid".into()),
            class: crate::graph::Class::Derived {
                origin: crate::provenance::Origin { exchange: 0, url: first.url.clone(), at: crate::provenance::At::SetCookie { name: "sid".into() }, wrap: None },
            },
        });
        Graph { steps: vec![first, plain(2, "POST", "https://shop.example/api/note"), target], provisional: false, page_origin: None, ..Graph::default() }
    }

    /// A step that only carries the session is the store's to answer, but only when the store holds what it carries. A
    /// fetched route starts on an empty jar: the step goes out and earns the cookie, and the ledger hears the site's
    /// own answer, never one the node made up.
    #[test]
    fn a_session_step_the_jar_cant_answer_goes_out() {
        struct Answers(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
        impl Fetch for Answers {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.0.lock().unwrap().push(req.url.path().to_string());
                let visitor = req.url.path().ends_with("visitor");
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: if visitor { 500 } else { 200 },
                    response_headers: if visitor { vec![("set-cookie".into(), "sid=earned; Path=/".into())] } else { vec![] },
                    response_body: Some(r#"{"ok":true}"#.into()),
                    response_mime: "application/json".into(),
                    resource_type: None,
                    main_frame: None,
                })
            }
        }
        let mut g = session_step_route(|_| {});
        g.steps.remove(1);
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut r = runner("https://shop.example/");
        r.jar.clear();
        r.transport.fetch = Box::new(Answers(sent.clone()));
        r.session_steps = HashMap::from([(0, vec!["sid".to_string()])]);
        let mut ledger = Ledger::of(&g);
        let run = crate::replay::replay_ledgered(&g, &HashMap::new(), &mut r, &mut ledger);
        assert_eq!(sent.lock().unwrap().first().map(String::as_str), Some("/api/visitor"), "the step reached the site");
        assert!(run.is_err(), "the site's own 500 fails the call: {run:?}");
        assert!(ledger.marks.iter().all(|m| m.state != crate::ledger::MarkState::Confirmed), "nothing the site didn't say: {:?}", ledger.marks);
    }

    /// For a route that came from another node, a cookie the site handed this call itself (a gateway's token issued to
    /// the request that lacked it) is the call's, not the owner's: the request signed again with it keeps it. Nothing
    /// else of the jar that the owner didn't hold as the call began is drawn in.
    #[test]
    fn a_token_the_site_handed_this_call_goes_with_a_shared_route() {
        let mut r = runner("https://shop.example/");
        r.owner = Some(HashMap::from([("sid".to_string(), "host-only-secret".to_string())]));
        // The call's first request goes out without the token.
        let first = Request { method: "GET".into(), url: "https://shop.example/h5/find/1.0/?t=0".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let _ = r.with_session_cookies(&first);
        // Its answer set the gateway's token in the jar, and another cookie beside it.
        r.jar.insert("_tk".into(), "9e107d9d372bb682_1794402700000".into());
        r.jar.insert("issued_aside".into(), "a1b2c3d4e5".into());
        let req = Request { method: "GET".into(), url: "https://shop.example/h5/find/1.0/?t=1".parse().unwrap(), exchange: 0, headers: vec![("cookie".into(), "_tk=9e107d9d372bb682_1794402700000".into())], body: None };
        let sent = r.with_session_cookies(&req);
        let cookie = sent.headers.iter().find(|(k, _)| k == "cookie").map(|(_, v)| v.clone()).unwrap_or_default();
        assert!(cookie.contains("_tk=9e107d9d372bb682_1794402700000"), "the call's own token rides the resend: {cookie}");
        assert!(!cookie.contains("issued_aside"), "a cookie of this call the request doesn't name is never drawn from the jar: {cookie}");
    }

    /// Half a session is no session: the step runs, and earns what the jar lacks.
    #[test]
    fn a_jar_holding_part_of_a_session_steps_cookies_doesnt_answer_it() {
        let mut r = runner("https://shop.example/");
        r.session_steps = HashMap::from([(0, vec!["sid".to_string(), "other".to_string()])]);
        assert_eq!(r.session_values(0), None);
        r.jar.insert("other".into(), "x".into());
        assert_eq!(r.session_values(0).map(|h| h.len()), Some(2));
    }

    /// A step does more than carry the session when it takes the caller's value, or when it is a write the route
    /// exists to make: the store can't stand in for either.
    #[test]
    fn a_step_with_the_callers_value_or_a_commit_is_never_the_stores_to_answer() {
        assert!(session_steps(&session_step_route(|s| s.method = "GET".into()), false).contains_key(&0), "a step that only sets the cookie");
        assert!(session_steps(&session_step_route(|s| s.body = Some(crate::graph::Body::Other)), false).contains_key(&0), "a probe whose body the capture lost");
        assert!(session_steps(&session_step_route(|_| {}), false).is_empty(), "a write the node can send makes its own state");
        let word = session_step_route(|s| s.fields.push(crate::graph::Field { loc: Loc::Json("/name".into()), class: crate::graph::Class::Input { name: "name".into(), secret: false, default: None, optional: false } }));
        assert!(session_steps(&word, false).is_empty(), "the caller's word has to reach the site");
        let mut commit = session_step_route(|s| s.sets_cookie = true);
        commit.steps.remove(1);
        assert!(session_steps(&commit, false).is_empty(), "the route's only write is its commit, cookie or no");
    }

    /// A heal's fresh session joins the jar only as far as it is the jar's: the cookies the browser sends to the
    /// walked root are another host's when the root is on another host, and stay out — and their recorded reach
    /// stays out with them.
    #[test]
    fn a_heal_never_puts_another_hosts_cookies_in_the_jar() {
        let session = || crate::mint::MintedSession {
            cookies: HashMap::from([("root_sid".to_string(), "dummy_a".to_string())]),
            tokens: HashMap::from([("x-csrf-token".to_string(), "t2".to_string())]),
            domains: HashMap::from([("root_sid".to_string(), ".shop.example".to_string())]),
            ..Default::default()
        };
        let mut jar = HashMap::new();
        let mut domains = HashMap::new();
        merge_sighting(&mut jar, Some("api.other.example"), "https://www.shop.example/", session(), &HashSet::new(), &mut domains);
        assert!(!jar.contains_key("root_sid"), "{jar:?}");
        assert_eq!(jar.get("x-csrf-token").map(String::as_str), Some("t2"));
        assert!(domains.is_empty(), "another host's reach never joins either");
        let mut jar = HashMap::new();
        let mut domains = HashMap::new();
        merge_sighting(&mut jar, Some("www.shop.example"), "https://www.shop.example/", session(), &HashSet::new(), &mut domains);
        assert_eq!(jar.get("root_sid").map(String::as_str), Some("dummy_a"));
        assert_eq!(domains.get("root_sid").map(String::as_str), Some(".shop.example"), "the reach joins with the cookie it describes");
    }

    /// A heal finds the route's target again on the route's own origin only: a call on another host whose path holds
    /// the same fragment (a beacon the page fires after the site's own call) is never taken for it.
    #[test]
    fn a_heal_never_moves_the_route_to_another_host() {
        let ex = |url: &str| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[1]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let origin = origin_of("https://a.example/p/{path[1]}/");
        assert_eq!(origin, "https://a.example");
        assert!(heals_onto(&ex("https://a.example/p/x/"), "GET", "p", &origin));
        assert!(!heals_onto(&ex("https://metrics.example/p/collect"), "GET", "p", &origin));
        assert!(!heals_onto(&ex("http://a.example/p/x/"), "GET", "p", &origin), "another scheme is another origin");
        assert!(!heals_onto(&ex("https://a.example:8443/p/x/"), "GET", "p", &origin));
        let trace = Trace { exchanges: vec![ex("https://a.example/p/x/"), ex("https://metrics.example/p/collect")], inputs: vec![] };
        let g = build(&[trace], |e| heals_onto(e, "GET", "p", &origin)).unwrap();
        assert_eq!(jar_name(&g).as_deref(), Some("a.example"));
    }

    /// A route on a named port keeps its session where its walk kept it: under the host. A cookie knows no port, and
    /// a jar named for one would never hold what the walk of that same site earned.
    #[test]
    fn a_route_on_a_named_port_reads_the_jar_its_walk_filled() {
        let on = |url: &str| -> Graph {
            serde_json::from_value(serde_json::json!({
                "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }],
                "provisional": false
            }))
            .unwrap()
        };
        assert_eq!(jar_name(&on("http://shop.example:8080/api/{path[1]}/search?q={q}")).as_deref(), Some("shop.example"));
        assert_eq!(jar_name(&on("https://shop.example/api/search")).as_deref(), Some("shop.example"));
        assert_eq!(jar_name(&on("http://127.0.0.1:36855/api/search")).as_deref(), Some("127.0.0.1"));
        assert_eq!(jar_name(&on("http://[::1]:9000/api/search")).as_deref(), Some("[::1]"));
    }

    /// Every client walks under its own capture: two heals running at once never share a log.
    #[test]
    fn each_heal_has_a_capture_of_its_own() {
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let a = RouteClient::new(g.clone()).with_browser("in-process").with_root("https://shop.example/app", "GET", "list");
        let b = RouteClient::new(g).with_browser("in-process").with_root("https://other.example/", "GET", "list");
        let (a, b) = (a.browser.unwrap(), b.browser.unwrap());
        assert_ne!(a.capture_dir, b.capture_dir);
        assert_ne!(a.session, b.session);
        assert!(a.profile.as_deref().is_some_and(|p| p.ends_with("profiles/shop.example")), "the root's own profile: {:?}", a.profile);
        assert!(b.profile.as_deref().is_some_and(|p| p.ends_with("profiles/other.example")));
    }

    /// A session jar, and the folder it is kept in, are the owner's alone.
    #[cfg(unix)]
    #[test]
    fn a_session_jar_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("route-client-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let mut client = RouteClient::new(g).with_session_store(&dir);
        client.jar.insert("sid".into(), "dummy".into());
        client.save_jar();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join("shop.example.json")), 0o600);
        assert_eq!(mode(&dir), 0o700, "a folder kept before is narrowed");
        unbrowse_files::private::write(&dir.join("new/inner.json"), b"{}").unwrap();
        assert_eq!(mode(&dir.join("new")), 0o700);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Target-first: a target whose fields are all minted answers without
    /// walking the chain; a target that derives from an earlier step falls
    /// back to the full chain (its minted-only attempt fails fast). A write
    /// target that may have been sent is never sent a second time by the chain.
    #[test]
    fn a_write_that_may_have_committed_is_not_retried() {
        // A write route: the session POST answers with a cookie, then the order POST is the commit.
        let session = Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/session".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), "sid=abc; Path=/".into())],
            response_body: Some(r#"{"ok":true}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let order = Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/orders".parse().unwrap(),
            request_headers: vec![],
            request_body: Some(r#"{"item":"lamp"}"#.into()),
            status: 201,
            response_headers: vec![],
            response_body: Some(r#"{"id":"o1"}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let g = build(&[Trace { exchanges: vec![session, order], inputs: vec![] }], |e| e.url.path() == "/api/orders").unwrap();
        assert!(chain_client_writes(&g), "the fixture route writes");
        let mut ledger = Ledger::of(&g);
        let commit = ledger.marks.last().expect("the route marks its commit").step;
        ledger.sending(commit);
        ledger.answered(commit, 502);
        assert_eq!(ledger.retry(true), Retry::CheckFirst, "a committed write is not healed");
        assert_eq!(ledger.effect(true), crate::ledger::Effect::MaybeCommitted);
        // The target alone is the same commit: a target-first run that may have sent it ends the call.
        let mut target_only = g.clone();
        let target = target_only.steps.pop().unwrap();
        target_only.steps = vec![target];
        let mut client = RouteClient::new(g.clone());
        let (answer, ledger) = client.call_with_ledger(&HashMap::new());
        assert!(answer.is_err(), "shop.example does not resolve: {answer:?}");
        assert!(ledger.possible_commit(), "the target POST may have reached the site");
        assert_eq!(ledger.retry(true), Retry::CheckFirst);
    }

    /// A walk that wrote twice: `first` (sending `first_body`) answered with a cookie, and `target` sent it back.
    fn two_writes(first: &str, first_body: &str, target: &str) -> Graph {
        let json = ("content-type".to_string(), "application/json".to_string());
        let ex = |path: &str, body: &str, set: Option<&str>, sent: Option<&str>| Exchange {
            method: "POST".into(),
            url: format!("https://shop.example{path}").parse().unwrap(),
            request_headers: sent.map(|c| vec![("cookie".to_string(), c.to_string()), json.clone()]).unwrap_or_else(|| vec![json.clone()]),
            request_body: Some(body.into()),
            status: 200,
            response_headers: set.map(|c| vec![("set-cookie".to_string(), format!("{c}; Path=/"))]).unwrap_or_default(),
            response_body: Some(r#"{"ok":true}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let sid = "sid=c4f9a1b2e7d34a60";
        let exchanges = vec![ex(first, first_body, Some(sid), None), ex(target, r#"{"note":"leave at the door"}"#, None, Some(sid))];
        build(&[Trace { exchanges, inputs: vec![] }], |e| e.url.path() == target).unwrap()
    }

    /// The site as a fake: what each path answers (a status, and a cookie it sets), and the paths it was sent, in order.
    struct Site(std::sync::Arc<std::sync::Mutex<Vec<String>>>, fn(&str) -> (u16, Option<&'static str>));
    impl Fetch for Site {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let path = req.url.path().to_string();
            self.0.lock().unwrap().push(path.clone());
            let (status, set) = (self.1)(&path);
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status,
                response_headers: set.map(|c| vec![("set-cookie".to_string(), format!("{c}; Path=/"))]).unwrap_or_default(),
                response_body: Some(r#"{"ok":true}"#.into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }
    }

    /// Runs `g` once against a site that answers as `answers` says, its target refused: the paths sent, and the ledger.
    fn run_refused(g: &Graph, answers: fn(&str) -> (u16, Option<&'static str>)) -> (Vec<String>, Ledger) {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut r = runner("https://shop.example/");
        r.jar.clear();
        r.transport.fetch = Box::new(Site(sent.clone(), answers));
        let mut ledger = Ledger::of(g);
        let run = crate::replay::replay_ledgered(g, &HashMap::new(), &mut r, &mut ledger);
        assert!(run.is_err(), "the target was refused: {run:?}");
        let sent = sent.lock().unwrap().clone();
        (sent, ledger)
    }

    /// A write that answered with a cookie and isn't the route's last write may be the site's state all the same: a
    /// cart line is often kept in a cookie. Once it went out it is a commit, so when a later step fails the call is
    /// never healed and run again, which would add the line a second time. Read from the step's own traffic: it
    /// wrote, the site answered with a cookie, and a later write followed.
    #[test]
    fn a_cookie_setting_write_mid_route_is_never_sent_again_on_a_heal() {
        let g = two_writes("/api/cart", r#"{"sku":"lamp","qty":1}"#, "/api/checkout");
        assert!(g.steps.len() == 2 && g.steps[0].sets_cookie && crate::ledger::writes(&g.steps[0]), "{:?}", g.steps);
        let (sent, ledger) = run_refused(&g, |path| if path == "/api/cart" { (200, Some("sid=s2")) } else { (422, None) });
        assert_eq!(sent, ["/api/cart", "/api/checkout"], "the cart line went out once");
        assert!(ledger.possible_commit(), "the site may hold the cart line: {:?}", ledger.marks);
        assert_ne!(ledger.retry(true), Retry::AsIs, "a heal would send the cart line again");
        assert_eq!(Ledger::of(&g).retry(true), Retry::AsIs, "before anything goes out, the call may run again");
    }

    /// The cost of that rule, which the owner accepted: a sign-in that is a write answering with a cookie, in the
    /// middle of a route, is a commit like any other, so a heal can't run it again when a later step is refused. Its
    /// traffic can't tell it from a cart line, and a cart line sent twice costs more than a failed call.
    #[test]
    fn a_sign_in_mid_route_is_not_run_again_by_a_heal() {
        let g = two_writes("/api/session", r#"{"user":"me"}"#, "/api/orders");
        assert!(g.steps.len() == 2 && g.steps[0].sets_cookie, "{:?}", g.steps);
        let (sent, ledger) = run_refused(&g, |path| if path == "/api/session" { (200, Some("sid=s2")) } else { (401, None) });
        assert_eq!(sent, ["/api/session", "/api/orders"]);
        assert_ne!(ledger.retry(true), Retry::AsIs, "the sign-in went out, so the call isn't healed");
    }

    /// A route this node didn't learn itself whose steps leave HTTPS or the public internet fails before any step is
    /// sent: neither the refused step nor the steps before it reach anything, the call says which rule, and the
    /// ledger shows nothing sent. Nor does such a route ever run in the browser.
    #[test]
    fn someone_elses_route_fails_before_anything_is_sent() {
        let session = Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/session".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("set-cookie".into(), "sid=abc; Path=/".into())],
            response_body: Some(r#"{"ok":true}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let order = Exchange { method: "POST".into(), url: "https://shop.example/api/orders".parse().unwrap(), status: 201, request_body: Some(r#"{"item":"lamp"}"#.into()), response_body: Some(r#"{"id":"o1"}"#.into()), response_headers: vec![], ..session.clone() };
        let mut g = build(&[Trace { exchanges: vec![session, order], inputs: vec![] }], |e| e.url.path() == "/api/orders").unwrap();
        // A setup step before the target, as a route with a sign-in has.
        let mut setup = g.steps[0].clone();
        setup.exchange = 0;
        setup.method = "GET".into();
        setup.fields.clear();
        setup.body = None;
        g.steps.insert(0, setup);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        for (first, last, rule) in [
            (format!("http://127.0.0.1:{port}/api/session"), "https://shop.example.com/api/orders".to_string(), "HTTPS only"),
            ("https://shop.example.com/api/session".to_string(), format!("https://127.0.0.1:{port}/api/orders"), "public"),
            ("https://shop.example.com/api/session".to_string(), "https://169.254.169.254/latest/meta-data".to_string(), "public"),
            ("https://shop.example.com/api/session".to_string(), "https://[::ffff:192.168.1.1]/api/orders".to_string(), "public"),
        ] {
            let mut g = g.clone();
            let n = g.steps.len();
            g.steps[0].url = first.clone();
            g.steps[n - 1].url = last.clone();
            let mut client = RouteClient::new(g).with_egress(crate::egress::Egress::Foreign).with_browser("in-process");
            assert!(client.browser.is_none(), "someone else's route never runs in the browser");
            let (answer, ledger) = client.call_with_ledger(&HashMap::new());
            let e = answer.unwrap_err();
            assert!(matches!(e, ReplayError::Refused(_)) && e.to_string().contains(rule), "{first} {last}: {e}");
            assert!(!ledger.possible_commit(), "nothing was sent: {first} {last}");
        }
        assert!(listener.accept().is_err(), "nothing reached this machine");
    }

    /// A route this node didn't learn itself to a public HTTPS host is held to the rule and passes it: the call goes
    /// out (the fixture host doesn't resolve, so it fails at the network, not at the rule).
    #[test]
    fn someone_elses_route_to_a_public_https_host_runs() {
        let mut g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        for s in &mut g.steps {
            s.url = s.url.replace("://shop.example/", "://shop.example.com/");
        }
        assert!(g.steps.iter().all(|s| s.url.starts_with("https://shop.example.com/")), "{:?}", g.steps.iter().map(|s| &s.url).collect::<Vec<_>>());
        let mut client = RouteClient::new(g).with_egress(crate::egress::Egress::Foreign);
        let (answer, _) = client.call_with_ledger(&HashMap::new());
        assert!(!matches!(answer, Err(ReplayError::Refused(_))), "{answer:?}");
    }

    /// Whether a graph writes, as the client reads it.
    fn chain_client_writes(g: &Graph) -> bool {
        route_writes(g)
    }

    /// Target-first: a target whose fields are all minted answers without
    /// walking the chain; a target that derives from an earlier step falls
    /// back to the full chain (its minted-only attempt fails fast).
    #[test]
    fn target_first_wins_when_minted_and_falls_back_when_derived() {
        // Win: the target's fields are minted, so a target-only graph answers
        // straight from the jar.
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let mut client = RouteClient::new(g.clone());
        client.jar.insert("x-token".into(), "tok_jar_999999".into());
        let mut target_only = g.clone();
        let target = target_only.steps.pop().unwrap();
        target_only.steps = vec![target];
        // The jar serves the minted token, so the request goes out — a
        // network error (shop.example does not resolve), not a missing-source
        // one: the fast path realized every field without the chain.
        match client.run_with(&target_only, None, &HashMap::new()).0 {
            Err(ReplayError::SourceMissing { .. }) => panic!("jar should have served the minted token"),
            other => assert!(other.is_err(), "shop.example must not resolve: {other:?}"),
        }

        // Fallback: the token derives from the page's Set-Cookie, so the
        // target alone fails fast and the full chain answers.
        let cg = build(&chain_traces(), |e| e.url.path() == "/api/p/list").unwrap();
        assert!(cg.steps.len() >= 2, "chain fixture should be multi-step");
        let mut chain_client = RouteClient::new(cg.clone());
        let mut target_only_chain = cg.clone();
        let target = target_only_chain.steps.pop().unwrap();
        target_only_chain.steps = vec![target];
        assert!(
            chain_client.run_with(&target_only_chain, None, &HashMap::new()).0.is_err(),
            "target-only must fail when the token derives from an earlier step"
        );
        // The full chain also gets past field realization (network error,
        // not a source error).
        match chain_client.run_with(&cg, None, &HashMap::new()).0 {
            Err(ReplayError::SourceMissing { .. }) => panic!("full chain must realize every field"),
            other => assert!(other.is_err(), "shop.example must not resolve: {other:?}"),
        }
    }

    /// A site on 127.0.0.1 answering each path with its status, type and body.
    fn site(pages: Vec<(&'static str, u16, &'static str, &'static str)>) -> u16 {
        site_counting(pages).0
    }

    /// [`site`], and the paths it was asked for, in order.
    #[allow(clippy::type_complexity)]
    fn site_counting(pages: Vec<(&'static str, u16, &'static str, &'static str)>) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead, Write};
        let hits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = hits.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = first.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
                seen.lock().unwrap().push(path.clone());
                let (status, kind, body) = pages.iter().find(|(p, ..)| *p == path).map(|(_, s, k, b)| (*s, *k, *b)).unwrap_or((404, "text/plain", ""));
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (port, hits)
    }

    fn one_read(url: &str) -> Graph {
        serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }
        ]}))
        .unwrap()
    }

    /// A read that comes back as a challenge served with 202 where the walk saw 200, or as an error the site said in
    /// its own words with 200, is a failed call that says what the site said; a feed or a text file the site serves as
    /// data is the answer, as text.
    #[test]
    fn a_read_gets_its_answer_or_fails_saying_what_the_site_said() {
        let port = site(vec![
            ("/html/", 202, "text/html", "<html><body><p>Unfortunately, bots use this site too.</p><p>Select all squares containing a duck</p></body></html>"),
            ("/data/v2/histoday", 200, "application/json", r#"{"Response":"Error","Message":"You need a valid auth key or api key to access this endpoint","HasWarning":false,"Type":1,"RateLimit":{},"Data":{}}"#),
            ("/rss/search", 200, "application/rss+xml; charset=utf-8", "<?xml version=\"1.0\"?><rss><channel><item><title>Seed round</title></item></channel></rss>"),
            ("/llms.txt", 200, "text/plain", "# Example\n> The docs, for agents.\n- [Intro](https://example.com/intro)"),
        ]);
        let call = |path: &str| RouteClient::new(one_read(&format!("http://127.0.0.1:{port}{path}"))).with_chrome_transport().call(&HashMap::new());
        match call("/html/") {
            Err(ReplayError::NotAnAnswer { status: 202, why, .. }) => assert!(why.contains("202") && why.contains("200"), "{why}"),
            other => panic!("a challenge is no answer: {other:?}"),
        }
        match call("/data/v2/histoday") {
            Err(ReplayError::NotAnAnswer { status: 200, why, .. }) => assert!(why.contains("valid auth key"), "{why}"),
            other => panic!("an error in the site's words is no answer: {other:?}"),
        }
        let feed = call("/rss/search").expect("a feed is an answer");
        assert_eq!(feed["content_type"], "application/rss+xml");
        assert!(feed["text"].as_str().unwrap().contains("Seed round"));
        let text = call("/llms.txt").expect("a text file is an answer");
        assert!(text["text"].as_str().unwrap().contains("for agents"));
    }

    /// Held (`holding_the_heal`), a failed call fails as it failed: the site is asked the call once, and nothing of
    /// the node's own follows it. Not held, the same refusal of a stale session has the route's page fetched again for
    /// a fresh one before anything else is tried.
    #[test]
    fn a_held_heal_walks_nothing() {
        let (port, hits) = site_counting(vec![("/api/search", 403, "application/json", r#"{"error":"no"}"#), ("/", 200, "text/html", "<html><body>Shop</body></html>")]);
        let client = |held: bool| {
            let c = RouteClient::new(one_read(&format!("http://127.0.0.1:{port}/api/search"))).with_root(&format!("http://127.0.0.1:{port}/"), "GET", "/api/search");
            if held { c.holding_the_heal() } else { c }
        };
        let (answer, _) = client(true).call_with_ledger(&HashMap::new());
        assert!(matches!(answer, Err(ReplayError::Failed { status: 403, .. })), "{answer:?}");
        assert_eq!(std::mem::take(&mut *hits.lock().unwrap()), ["/api/search"], "the call alone, asked once");
        let (answer, _) = client(false).call_with_ledger(&HashMap::new());
        assert!(answer.is_err());
        assert_eq!(*hits.lock().unwrap(), ["/api/search", "/"], "not held, the page is fetched again for a fresh session");
    }
}

/// A route that came from another node, run against a made-up shop (`shop.example`) whose owner's jar holds a session.
#[cfg(test)]
impl RouteClient {
    /// The owner's yes to the graph this client holds now, for a test.
    fn consented(self) -> Self {
        let digest = consent_digest("sha256:test-body", &self.graph);
        self.with_owner_consent("sha256:test-body", &digest)
    }
}

#[cfg(test)]
mod strangers_tests {
    use super::*;
    use std::sync::Mutex;

    /// One request the fake shop was sent: its path, and the cookie header it carried.
    type Seen = Vec<(String, String)>;

    /// A made-up shop: what each path answers (a status, and the `Set-Cookie` lines it sends), and what it was sent.
    struct Shop {
        seen: &'static Mutex<Seen>,
        answers: fn(&str) -> (u16, Vec<&'static str>),
    }

    impl Fetch for Shop {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let path = req.url.path().to_string();
            let cookie = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
            self.seen.lock().unwrap().push((path.clone(), cookie));
            let (status, set) = (self.answers)(&path);
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status,
                response_headers: set.into_iter().map(|c| ("set-cookie".to_string(), c.to_string())).collect(),
                response_body: Some(if path.starts_with("/api") { r#"{"items":[1]}"#.into() } else { "<html></html>".into() }),
                response_mime: if path.starts_with("/api") { "application/json" } else { "text/html" }.into(),
                resource_type: None,
                main_frame: None,
            })
        }
    }

    fn step(exchange: usize, path: &str, foreign: bool) -> crate::graph::Step {
        crate::graph::Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: "GET".into(),
            status: 200,
            url: format!("https://shop.example.com{path}"),
            fields: vec![],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign,
            held: vec![],
            fallbacks: Vec::new(),
        }
    }

    /// A route of two reads on the shop, someone else's (`foreign`) or the node's own: the second reads a value from the
    /// first's answer, so the chain runs whole.
    fn two_reads(foreign: bool) -> Graph {
        let mut list = step(1, "/api/list", foreign);
        let origin = crate::provenance::Origin { exchange: 0, url: "https://shop.example.com/api/me".into(), at: crate::provenance::At::Json { pointer: "/items/0".into() }, wrap: None };
        list.fields.push(crate::graph::Field { loc: Loc::Query("n".into()), class: crate::graph::Class::Derived { origin } });
        Graph { steps: vec![step(0, "/api/me", foreign), list], provisional: false, page_origin: None, ..Graph::default() }
    }

    /// The owner's jar for the shop, in a store of its own: the session the owner's own routes send.
    fn owners_store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("strangers-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let jar = HashMap::from([("sid".to_string(), "owners-session".to_string())]);
        std::fs::write(dir.join("shop.example.com.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        dir
    }

    /// Every file the store holds for the shop, by name, with its bytes.
    fn files(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap())).collect();
        out.sort();
        out
    }

    /// A value the owner's vault filled in goes only to the site it was checked against, on whatever graph the call
    /// actually sends: a chain rebuilt by a heal (which the caller's check never saw) that moves the input onto
    /// another host is refused with nothing sent, and the same input on the route's own site goes.
    #[test]
    fn a_heal_never_moves_a_vault_value_onto_another_host() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let carrying = |url: &str| {
            let mut pay = step(0, "/api/pay", false);
            pay.url = url.to_string();
            pay.fields.push(crate::graph::Field { loc: Loc::Query("pan".into()), class: Class::Input { name: "pan".into(), secret: true, default: None, optional: false } });
            Graph { steps: vec![pay], provisional: false, page_origin: None, ..Graph::default() }
        };
        let inputs = HashMap::from([("pan".to_string(), "4242424242424242".to_string())]);
        let mut client = RouteClient::new(carrying("https://shop.example.com/api/pay")).with_held_inputs(vec!["pan".into()], "shop.example.com");
        client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
        client.call(&inputs).expect("the route's own site takes it");
        assert_eq!(SEEN.lock().unwrap().len(), 1);
        // What a heal does: the chain is replaced by one rebuilt from a fresh walk, and run again with the same values.
        SEEN.lock().unwrap().clear();
        for elsewhere in ["https://collector.example.net/api/pay", "http://shop.example.com/api/pay"] {
            client.graph = carrying(elsewhere);
            let (answer, _) = client.run(&inputs);
            assert!(matches!(&answer, Err(ReplayError::Refused(why)) if why.contains("pan")), "{elsewhere}: {answer:?}");
        }
        assert!(SEEN.lock().unwrap().is_empty(), "nothing of a moved chain was sent: {:?}", SEEN.lock().unwrap());
    }

    /// While a checkout waits for the owner, no route sends anything, to any host: a write route, and a route of GETs
    /// to a host no hold names (a processor's `/confirm?order=…` commits on a GET), the node's own or another
    /// contributor's. Released, they go.
    #[test]
    fn while_a_checkout_waits_no_route_sends_anything_anywhere() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut post = step(0, "/api/order", false);
        post.method = "POST".into();
        let write = Graph { steps: vec![step(1, "/api/cart", false), post], provisional: false, page_origin: None, ..Graph::default() };
        let get = |foreign: bool| Graph { steps: vec![step(0, "/confirm", foreign)], provisional: false, page_origin: None, ..Graph::default() };
        crate::hold::wait_here(true);
        for graph in [write, get(false), get(true)] {
            let mut client = RouteClient::new(graph);
            client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
            let e = client.call(&HashMap::new()).unwrap_err();
            assert!(matches!(&e, ReplayError::Refused(why) if why.contains("waiting")), "{e:?}");
        }
        assert!(SEEN.lock().unwrap().is_empty(), "nothing was sent: {:?}", SEEN.lock().unwrap());
        crate::hold::wait_here(false);
        let mut read = RouteClient::new(get(false));
        read.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
        assert!(read.call(&HashMap::new()).is_ok(), "released, a route goes");
    }

    /// A shop behind a door: its calls answer 403 until a request carries the pass, and its own page hands the pass out
    /// to whoever asks for the page.
    struct Gated {
        seen: &'static Mutex<Seen>,
    }

    impl Fetch for Gated {
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let path = req.url.path().to_string();
            let cookie = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
            self.seen.lock().unwrap().push((path.clone(), cookie.clone()));
            let api = path.starts_with("/api");
            let (status, set) = match (api, cookie.contains("pass=fresh")) {
                (true, true) => (200, vec![]),
                (true, false) => (403, vec![]),
                (false, _) => (200, vec!["pass=fresh; Path=/"]),
            };
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status,
                response_headers: set.into_iter().map(|c| ("set-cookie".to_string(), c.to_string())).collect(),
                response_body: Some(if api && status == 200 { r#"{"items":[1]}"#.into() } else { "<html></html>".into() }),
                response_mime: if api && status == 200 { "application/json" } else { "text/html" }.into(),
                resource_type: None,
                main_frame: None,
            })
        }
    }

    /// A call refused at the site's door is mended where a door is mended: the route's page is asked again over the
    /// call's own wire, the pass it hands back joins the jar, and the chain runs again. It does not give up before the
    /// page was ever asked.
    #[test]
    fn a_door_refusal_reaches_its_own_mend() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut graph = two_reads(false);
        graph.door = Some(crate::graph::Door { kind: crate::graph::DoorKind::Unknown, statuses: vec![403, 429, 503], credential: Some("pass".into()), ttl: None, earn: crate::graph::Earn::Recompute, at: None });
        let mut client = RouteClient::new(graph);
        client.root = Some("https://shop.example.com/".into());
        client.target = Some(("GET".into(), "/api/list".into()));
        client.wire = Some(|| Box::new(Gated { seen: &SEEN }));
        let (answer, _) = client.call_with_ledger(&HashMap::new());
        let seen = SEEN.lock().unwrap().clone();
        assert!(seen.iter().any(|(p, _)| p == "/"), "the door's page was never asked: {seen:?}");
        assert!(answer.is_ok(), "the pass the page handed back opens the door: {answer:?}");
        assert!(seen.iter().any(|(p, c)| p == "/api/list" && c.contains("pass=fresh")), "the chain ran again with the pass: {seen:?}");
    }

    /// A shop whose calls answer with a check for a person (a page that is only the check's widget) until a request
    /// carries the pass. Its own page hands out nothing.
    struct Checked;

    impl Fetch for Checked {
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let path = req.url.path().to_string();
            let cookie = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
            let api = path.starts_with("/api");
            let (status, mime, body) = match (api, cookie.contains("cleared=yes")) {
                (true, true) => (200, "application/json", r#"{"items":[1]}"#),
                (true, false) => (403, "text/html", r#"<html><head><script src="/w.js"></script></head><body><div data-sitekey="k1"></div><p>Confirm you are a person.</p></body></html>"#),
                (false, _) => (200, "text/html", "<html></html>"),
            };
            Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status, response_headers: vec![], response_body: Some(body.into()), response_mime: mime.into(), resource_type: None, main_frame: None })
        }
    }

    /// What is tried against a door is read from what the door's answer was, in that order, and stops at the first
    /// thing that opens it: a check for a person asks for the owner's own browser session, then the solver, and the
    /// owner is never asked once the solver's pass opened the door. The pass joins the jar as this client's, with the
    /// life the source gave it. A source the node did not give (here, the engine) is passed over.
    #[test]
    fn what_clears_a_door_is_read_from_the_wall_and_tried_in_its_order() {
        use crate::refusal::{Cleared, Source};
        let asked: std::sync::Arc<Mutex<Vec<Source>>> = Default::default();
        let source = |which: Source, pass: Option<Cleared>| -> Clearer {
            let asked = asked.clone();
            Box::new(move |wall| {
                assert_eq!(wall, &crate::refusal::Wall::Person, "the clearer is told what the wall is");
                asked.lock().unwrap().push(which);
                pass.clone()
            })
        };
        let pass = Cleared { cookies: [("cleared".to_string(), "yes".to_string())].into(), ttl: Some(600), bound_to: None, by: Some(Source::Solver) };
        let mut graph = two_reads(false);
        graph.door = Some(crate::graph::Door { kind: crate::graph::DoorKind::Unknown, statuses: vec![403, 429, 503], credential: Some("cleared".into()), ttl: None, earn: crate::graph::Earn::BrowserOrOwner, at: None });
        let mut client = RouteClient::new(graph)
            .with_clearer(Source::Owner, source(Source::Owner, None))
            .with_clearer(Source::Solver, source(Source::Solver, Some(pass)))
            .with_clearer(Source::OwnerSession, source(Source::OwnerSession, None));
        client.root = Some("https://shop.example.com/".into());
        client.target = Some(("GET".into(), "/api/list".into()));
        client.wire = Some(|| Box::new(Checked));
        let me = client.identity();
        let (answer, _) = client.call_with_ledger(&HashMap::new());
        assert!(answer.is_ok(), "the solver's pass opens the door: {answer:?}");
        assert_eq!(*asked.lock().unwrap(), [Source::OwnerSession, Source::Solver], "in the wall's order, whatever order they were given in, and no further than what opened it");
        let meta = client.cookie_meta.get("cleared").expect("the pass is kept with its record");
        assert_eq!(meta.bound_to.as_deref(), Some(me.as_str()), "the pass is this client's");
        assert!(meta.expires.is_some_and(|at| at > now_secs() + 500.0 && at < now_secs() + 700.0), "with the life its source gave: {meta:?}");
        assert!(client.fell_back().iter().any(|n| n.contains("cleared by the configured solver")), "{:?}", client.fell_back());

        // Nothing clears it: the call fails as the door it met, having asked every source it was given, the owner last.
        asked.lock().unwrap().clear();
        let mut graph = two_reads(false);
        graph.door = Some(crate::graph::Door { kind: crate::graph::DoorKind::Unknown, statuses: vec![403, 429, 503], credential: None, ttl: None, earn: crate::graph::Earn::BrowserOrOwner, at: None });
        let mut client = RouteClient::new(graph).with_clearer(Source::Owner, source(Source::Owner, None)).with_clearer(Source::OwnerSession, source(Source::OwnerSession, None));
        client.root = Some("https://shop.example.com/".into());
        client.target = Some(("GET".into(), "/api/list".into()));
        client.wire = Some(|| Box::new(Checked));
        let (answer, _) = client.call_with_ledger(&HashMap::new());
        assert!(matches!(answer, Err(ReplayError::Door { wall: Some(crate::refusal::Wall::Person), .. })), "{answer:?}");
        assert_eq!(*asked.lock().unwrap(), [Source::OwnerSession, Source::Owner]);

        // A route that came from another node is cleared by nothing of the owner's.
        asked.lock().unwrap().clear();
        let stranger = RouteClient::new(two_reads(true)).with_clearer(Source::Owner, source(Source::Owner, None));
        assert!(stranger.clearers.is_empty());
    }

    /// A route that came from another node reads the owner's session and never writes it: a cookie its answers set,
    /// a cookie the browserless re-mint of its page sets, and what an earlier call of it earned are its call's alone.
    /// The store's files are byte for byte what they were, and the next call starts from the owner's session again.
    #[test]
    fn a_strangers_route_never_writes_the_owners_jar() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let dir = owners_store("jar");
        let before = files(&dir);
        let mut client = RouteClient::new(two_reads(true)).with_session_store(&dir).consented();
        client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |path| (200, if path == "/api/me" { vec!["cart=strangers-cart; Path=/"] } else { vec![] }) }));
        client.call(&HashMap::new()).expect("the shop answers");
        let seen = SEEN.lock().unwrap().clone();
        assert!(seen.iter().all(|(_, c)| c.contains("sid=owners-session")), "the owner's session is read: {seen:?}");
        assert!(seen.iter().any(|(p, c)| p == "/api/list" && c.contains("cart=strangers-cart")), "within the call, its own cookie rides on: {seen:?}");
        assert_eq!(files(&dir), before, "nothing the call set reached the owner's store");
        // The next call starts from the owner's session, not from what this one earned.
        SEEN.lock().unwrap().clear();
        client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
        client.call(&HashMap::new()).expect("the shop answers");
        assert!(SEEN.lock().unwrap().iter().all(|(_, c)| !c.contains("cart=")), "an earlier call's cookie is gone");

        // The browserless re-mint of the route's page: its cookies are the call's too.
        static AGAIN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut client = RouteClient::new(two_reads(true)).with_session_store(&dir).consented();
        client.root = Some("https://shop.example.com/".into());
        client.target = Some(("GET".into(), "/api/list".into()));
        client.wire = Some(|| Box::new(Shop { seen: &AGAIN, answers: |path| if path == "/" { (200, vec!["fresh=page-cookie; Path=/"]) } else { (401, vec![]) } }));
        let _ = client.call(&HashMap::new());
        assert!(AGAIN.lock().unwrap().iter().any(|(p, _)| p == "/"), "the page was fetched again for a stale session");
        assert_eq!(files(&dir), before, "the re-mint's cookie never reached the owner's store");

        // The node's own route, answered the same way, keeps what the site set: the rule is whose route it is.
        static OWN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut client = RouteClient::new(two_reads(false)).with_session_store(&dir);
        client.wire = Some(|| Box::new(Shop { seen: &OWN, answers: |path| (200, if path == "/api/me" { vec!["cart=owners-cart; Path=/"] } else { vec![] }) }));
        client.call(&HashMap::new()).expect("the shop answers");
        assert!(String::from_utf8(std::fs::read(dir.join("shop.example.com.json")).unwrap()).unwrap().contains("owners-cart"), "the node's own route keeps its session");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What a route that came from another node read under the owner's session (their account page, their address)
    /// never rides in its write unless the owner allowed the call: the write is refused before it is sent. The same
    /// route with no session of the owner's to read under, the owner's yes, or the node's own route sends it.
    #[test]
    fn a_shared_write_never_carries_what_the_owners_session_read() {
        let route = |foreign: bool| {
            let mut post = step(1, "/api/comments", foreign);
            post.method = "POST".into();
            let origin = crate::provenance::Origin { exchange: 0, url: "https://shop.example.com/api/me".into(), at: crate::provenance::At::Json { pointer: "/items/0".into() }, wrap: None };
            post.fields.push(crate::graph::Field { loc: Loc::Query("text".into()), class: crate::graph::Class::Derived { origin } });
            Graph { steps: vec![step(0, "/api/me", foreign), post], provisional: false, page_origin: None, ..Graph::default() }
        };
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let wire: fn() -> Box<dyn Fetch> = || Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) });
        let posted = |client: &mut RouteClient| {
            SEEN.lock().unwrap().clear();
            client.wire = Some(wire);
            let answer = client.call(&HashMap::new());
            (answer, SEEN.lock().unwrap().iter().any(|(p, _)| p == "/api/comments"))
        };
        let dir = owners_store("reads");
        let (answer, sent) = posted(&mut RouteClient::new(route(true)).with_session_store(&dir).consented());
        assert!(matches!(&answer, Err(ReplayError::Refused(why)) if why.contains("owner's session")), "{answer:?}");
        assert!(!sent, "the write was never sent");
        assert!(SEEN.lock().unwrap().iter().any(|(p, c)| p == "/api/me" && c.contains("sid=owners-session")), "the read ran under the owner's session");
        let (answer, sent) = posted(&mut RouteClient::new(route(true)).with_session_store(&dir).consented().with_session_reads_in_writes(true));
        assert!(answer.is_ok() && sent, "the owner allowed this call: {answer:?}");
        let (answer, sent) = posted(&mut RouteClient::new(route(false)).with_session_store(&dir));
        assert!(answer.is_ok() && sent, "the node's own route: {answer:?}");
        let _ = std::fs::remove_dir_all(&dir);
        // No session of the owner's to read under: what the read said is the site's public answer.
        let empty = std::env::temp_dir().join(format!("strangers-reads-none-{}", std::process::id()));
        let (answer, sent) = posted(&mut RouteClient::new(route(true)).with_session_store(&empty));
        assert!(answer.is_ok() && sent, "nothing of the owner's was read: {answer:?}");
    }

    /// A request's method is no evidence that it leaves the account alone: a GET can sign the owner out or unsubscribe
    /// them, and change nothing the answer shows. So a route that came from another node sends none of the owner's
    /// session until the owner allowed that route to act in it: the same GET reaches the site with no cookie of
    /// theirs, and with the owner's yes, or as the node's own route, it carries the session.
    #[test]
    fn a_shared_get_with_owner_cookies_requires_consent() {
        let logout = |foreign: bool| Graph { steps: vec![step(0, "/account/sign-out", foreign)], provisional: false, page_origin: None, ..Graph::default() };
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let sent = |client: RouteClient| {
            let mut client = client;
            SEEN.lock().unwrap().clear();
            client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
            let _ = client.call(&HashMap::new());
            let seen = SEEN.lock().unwrap().clone();
            assert!(seen.iter().any(|(p, _)| p == "/account/sign-out"), "the request went: {seen:?}");
            seen.iter().any(|(_, c)| c.contains("sid=owners-session"))
        };
        let dir = owners_store("consent");
        assert!(!sent(RouteClient::new(logout(true)).with_session_store(&dir)), "no consent: none of the owner's session");
        assert!(sent(RouteClient::new(logout(true)).with_session_store(&dir).consented()), "the owner allowed the route");
        assert!(sent(RouteClient::new(logout(false)).with_session_store(&dir)), "the node's own route");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The owner's yes is for the graph they were shown. A heal swaps in a chain rebuilt from a fresh walk, which a
    /// hostile page can shape, and runs it: that graph is checked at send time and is not the one consented to, so it
    /// goes with none of the owner's session, nor does the start page fetched for it. The consented graph, and its
    /// target alone, still carry the session. Nothing about the old yes travels with the client's flag: it is the
    /// graph's digest, measured by the node when each run starts.
    #[test]
    fn a_heal_never_replays_a_changed_shared_graph_under_old_consent() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let wire: fn() -> Box<dyn Fetch> = || Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) });
        let carried = |client: &mut RouteClient, graph: Option<Graph>| {
            SEEN.lock().unwrap().clear();
            client.wire = Some(wire);
            match graph {
                Some(g) => {
                    let _ = client.run_with(&g, None, &HashMap::new());
                }
                None => {
                    let _ = client.run(&HashMap::new());
                }
            }
            let seen = SEEN.lock().unwrap().clone();
            assert!(!seen.is_empty(), "requests went");
            seen.iter().any(|(_, c)| c.contains("sid=owners-session"))
        };
        let dir = owners_store("heal-consent");
        let mut client = RouteClient::new(two_reads(true)).with_session_store(&dir).consented();
        client.start_from_the_owners_session();
        assert!(carried(&mut client, None), "the consented graph carries the session");
        let mut target = client.graph.clone();
        let last = target.steps.pop().unwrap();
        target.steps = vec![last];
        assert!(client.owner_material_for(&target), "its target alone is part of what was shown");
        let mut other_target = target.clone();
        other_target.steps[0].url = "https://shop.example.com/api/elsewhere".into();
        assert!(!client.owner_material_for(&other_target), "a step that isn't the consented target is not");
        // What a heal does: the chain rebuilt from a fresh walk becomes the client's graph, and is run.
        let mut rebuilt = client.graph.clone();
        rebuilt.steps[0].url = "https://shop.example.com/account/close".into();
        client.graph = rebuilt.clone();
        assert!(!carried(&mut client, None), "a rebuilt graph runs with none of the owner's session");
        assert!(!carried(&mut client, Some(rebuilt)), "nor when it is handed to a run directly");
        // Its start page, fetched for it, goes without the session too.
        client.root = Some("https://shop.example.com/".into());
        SEEN.lock().unwrap().clear();
        let _ = client.refresh_with(wire().as_mut());
        assert!(SEEN.lock().unwrap().iter().all(|(_, c)| !c.contains("sid=owners-session")), "{:?}", SEEN.lock().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A value the caller hands a route another node listed (one read off the page's address included) goes to the
    /// route's own site and nowhere else, with or without the owner's yes and whether or not the owner holds a session:
    /// a step addressed to another site is refused before anything is sent.
    #[test]
    fn a_callers_value_never_leaves_a_strangers_route_for_another_site() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let graph = || {
            let mut off = step(0, "/collect", true);
            off.url = "https://collector.example.net/collect".into();
            off.fields.push(crate::graph::Field { loc: Loc::Query("q".into()), class: Class::Input { name: "q".into(), secret: false, default: None, optional: false } });
            // The next step reads the other site's answer, so the step can't be passed over as a side request.
            let mut list = step(1, "/api/list", true);
            let origin = crate::provenance::Origin { exchange: 0, url: "https://collector.example.net/collect".into(), at: crate::provenance::At::Json { pointer: "/items/0".into() }, wrap: None };
            list.fields.push(crate::graph::Field { loc: Loc::Query("n".into()), class: Class::Derived { origin } });
            Graph { steps: vec![off, list], provisional: false, page_origin: None, ..Graph::default() }
        };
        let dir = owners_store("callers-value");
        let empty = owners_store("callers-value-empty");
        let _ = std::fs::remove_dir_all(&empty);
        let inputs = HashMap::from([("q".to_string(), "token-from-the-page-address".to_string())]);
        for (case, mut client) in [RouteClient::new(graph()).with_session_store(&dir), RouteClient::new(graph()).with_session_store(&empty), RouteClient::new(graph()).with_session_store(&dir).consented()].into_iter().enumerate() {
            client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
            let answer = client.call(&inputs);
            assert!(matches!(&answer, Err(ReplayError::Refused(why)) if why.contains("not on the route's site") || why.contains("not an origin the route names")), "case {case}: {answer:?}");
        }
        assert!(SEEN.lock().unwrap().is_empty(), "nothing was sent anywhere: {:?}", SEEN.lock().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The owner's yes covers the route's own site and nothing past it: a step of a consented route that names another
    /// site (a graph that slipped by admission, a token it names by its header) is refused before anything is sent, and
    /// a cookie an answer sets for another site's domain never joins the call's session.
    #[test]
    fn consent_never_sends_the_session_off_the_routes_site() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let dir = owners_store("off-site");
        let mut off = step(0, "/collect", true);
        off.url = "https://collector.example.net/collect".into();
        off.fields.push(crate::graph::Field { loc: Loc::Header("x-session".into()), class: crate::graph::Class::Minted { name: "sid".into() } });
        let mut list = step(1, "/api/list", true);
        let origin = crate::provenance::Origin { exchange: 0, url: "https://collector.example.net/collect".into(), at: crate::provenance::At::Json { pointer: "/items/0".into() }, wrap: None };
        list.fields.push(crate::graph::Field { loc: Loc::Query("n".into()), class: crate::graph::Class::Derived { origin } });
        let graph = Graph { steps: vec![off, list], provisional: false, page_origin: None, ..Graph::default() };
        let mut client = RouteClient::new(graph).with_session_store(&dir).consented();
        client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |_| (200, vec![]) }));
        let answer = client.call(&HashMap::new());
        assert!(matches!(&answer, Err(ReplayError::Refused(why)) if why.contains("not an origin the route names")), "{answer:?}");
        assert!(SEEN.lock().unwrap().iter().all(|(p, _)| p != "/collect"), "nothing went to the other site");
        let mut r = super::tests::runner("https://shop.example.com/");
        r.owner = Some(HashMap::new());
        r.session_allowed = true;
        let ex = Exchange { method: "GET".into(), url: "https://shop.example.com/".parse().unwrap(), request_headers: vec![], request_body: None, status: 200,
            response_headers: vec![("set-cookie".into(), "other=1; Domain=.example.net; Path=/".into())], response_body: None, response_mime: String::new(), resource_type: None, main_frame: None };
        r.keep_set_cookies(&ex);
        assert!(!r.jar.contains_key("other"), "another site's cookie never joins");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The site's page for another value is asked as a step of the call is: a route that came from another node asks
    /// for it only at an origin its graph names, and an answer that replaces the owner's session ends the call there,
    /// with nothing it set kept and no page handed to the sandbox.
    #[test]
    fn a_page_asked_for_another_value_keeps_to_the_routes_origins_and_the_owners_session() {
        struct Pages {
            asked: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        }
        impl Fetch for Pages {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.asked.borrow_mut().push(req.url.to_string());
                Ok(Exchange {
                    method: "GET".into(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 200,
                    response_headers: vec![("set-cookie".into(), "sid=someone-elses; Path=/".into())],
                    response_body: Some("<!doctype html><html><body></body></html>".into()),
                    response_mime: "text/html".into(),
                    resource_type: Some("Document".into()),
                    main_frame: Some(true),
                })
            }
        }
        let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let mut r = super::tests::runner("https://www.shop.example.com/");
        r.egress = crate::egress::Egress::Foreign;
        r.owner = Some(r.jar.clone());
        r.transport.within = Some(Within::new(["https://www.shop.example.com".to_string()], r.home.clone(), r.owner.clone().unwrap_or_default()));
        r.transport.fetch = Box::new(Pages { asked: asked.clone() });
        assert_eq!(r.the_sites_page("https://tenant.shop.example.com/search?q=asked"), None, "a sibling host of the site is not an origin the route names");
        assert!(asked.borrow().is_empty(), "nothing is asked off the route's origins: {:?}", asked.borrow());
        assert_eq!(r.the_sites_page("https://www.shop.example.com/search?q=asked"), None, "an answer that replaces the owner's session hands on no page");
        assert_eq!(asked.borrow().len(), 1);
        assert_eq!(r.jar.get("sid").map(String::as_str), Some("host-only-secret"), "the session the call was sent with is kept");
        assert!(r.ended().is_some(), "the call ends where the site replaced the owner's session");
        assert_eq!(r.the_sites_page("https://www.shop.example.com/search?q=again"), None);
        assert_eq!(asked.borrow().len(), 1, "nothing more is asked once the call has ended");
    }

    /// The page's own code, run in the sandbox for a route that came from another node, asks only an origin the route's
    /// graph names, as every step of it does: a sibling host of the same site, which a page's script may hold the
    /// owner's material to post to, is refused with nothing sent, and a redirect from a named origin to one is not
    /// followed. The named origin is asked with the session. The node's own route keeps the page's own site.
    #[test]
    fn a_pages_code_asks_only_the_origins_the_route_names() {
        struct Pages {
            asked: std::rc::Rc<std::cell::RefCell<Vec<(String, Option<String>)>>>,
        }
        impl Fetch for Pages {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                let cookie = req.headers.iter().find(|(k, _)| k == "cookie").map(|(_, v)| v.clone());
                self.asked.borrow_mut().push((req.url.to_string(), cookie));
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some("{}".into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
        }
        let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let mut page_net = Pages { asked: asked.clone() };
        let post = |u: &str| Request { method: "POST".into(), url: u.parse().unwrap(), exchange: usize::MAX, headers: vec![], body: Some(b"stolen".to_vec()) };
        let mut r = super::tests::runner("https://www.shop.example.com/");
        r.egress = crate::egress::Egress::Foreign;
        r.owner = Some(r.jar.clone());
        r.session_allowed = true;
        r.transport.within = Some(Within::new(["https://www.shop.example.com".to_string()], r.home.clone(), r.owner.clone().unwrap_or_default()));
        let sibling = r.page_asks(&mut page_net, &post("https://tenant.shop.example.com/collect"));
        assert!(sibling.as_ref().is_err_and(|why| why.contains("not an origin the route names")), "{sibling:?}");
        assert!(asked.borrow().is_empty(), "nothing went to the sibling: {:?}", asked.borrow());
        let named = r.page_asks(&mut page_net, &post("https://www.shop.example.com/api/sign"));
        assert!(named.is_ok(), "{named:?}");
        assert_eq!(asked.borrow()[0].1.as_deref(), Some("sid=host-only-secret"), "the named origin is asked with the session");
        // The node's own route keeps the page's own site.
        let mut own = super::tests::runner("https://www.shop.example.com/");
        assert!(own.page_asks(&mut page_net, &post("https://tenant.shop.example.com/collect")).is_ok());
    }

    /// The owner's yes reaches the exact origins the route names, not its whole site: a sibling host of the same
    /// registrable domain may be someone else's. A request of a consented route to a sibling is refused, and a request
    /// there from anywhere in the run (the page's own code, through the bridge) gets no cookie of the jar, even one
    /// whose domain covers the sibling; the named origin still gets the session. Another port of the named host is
    /// another origin too.
    #[test]
    fn consent_reaches_only_the_origins_the_route_names() {
        let mut r = super::tests::runner("https://www.shop.example.com/");
        r.owner = Some(r.jar.clone());
        r.session_allowed = true;
        r.jar.insert("clearance".into(), "site-wide".into());
        r.jar_domains.insert("clearance".into(), ".shop.example.com".into());
        r.owner.as_mut().unwrap().insert("clearance".into(), "site-wide".into());
        r.transport.within = Some(Within::new(["https://www.shop.example.com".to_string()], r.home.clone(), r.owner.clone().unwrap_or_default()));
        let get = |u: &str| Request { method: "GET".into(), url: u.parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let cookie_of = |req: &Request| req.headers.iter().find(|(k, _)| k == "cookie").map(|(_, v)| v.clone());
        let named = r.with_session_cookies(&get("https://www.shop.example.com/api"));
        assert!(cookie_of(&named).is_some_and(|c| c.contains("sid=") && c.contains("clearance=")), "the named origin gets the session");
        assert_eq!(cookie_of(&r.with_session_cookies(&get("https://tenant.shop.example.com/x"))), None, "a sibling gets nothing, even a domain cookie that covers it");
        assert_eq!(cookie_of(&r.with_session_cookies(&get("https://www.shop.example.com:8443/x"))), None, "another port is another origin");
        assert_eq!(r.minted_cookie("clearance", Some("tenant.shop.example.com")), None);
        let refused = Fetch::fetch(&mut r, &get("https://tenant.shop.example.com/x"));
        assert!(matches!(&refused, Err(ReplayError::Refused(why)) if why.contains("not an origin the route names")), "{refused:?}");
        // The graph's own origins, scheme, host and port as each step is addressed.
        let g = Graph { steps: vec![step(0, "/a", true), { let mut s = step(1, "/b", true); s.url = "https://api.shop.example.com:8443/b".into(); s }], provisional: false, page_origin: None, ..Graph::default() };
        assert_eq!(origins_of(&g).unwrap().into_iter().collect::<Vec<_>>(), ["https://api.shop.example.com:8443", "https://shop.example.com"]);
    }

    /// A route that came from another node may sign in with values it fixes and get a session of its own, under a name
    /// the owner's jar never held. Without the owner's yes to the route, nothing the site set during the call goes out
    /// again: the step after the sign-in reaches the site with the caller's value and no cookie of that session, so the
    /// caller's value never lands in the route author's account. With the yes (the owner was told the route may keep a
    /// session of its own), or as the node's own route, the cookie rides on.
    #[test]
    fn a_foreign_created_session_never_receives_the_callers_values() {
        let route = |foreign: bool| {
            let mut sign_in = step(0, "/api/session", foreign);
            sign_in.method = "POST".into();
            sign_in.sets_cookie = true;
            sign_in.body = Some(crate::graph::Body::Json { template: serde_json::json!({ "user": "author", "password": "fixed" }), types: Default::default() });
            let mut note = step(1, "/api/notes", foreign);
            let origin = crate::provenance::Origin { exchange: 0, url: "https://shop.example.com/api/session".into(), at: crate::provenance::At::Json { pointer: "/items/0".into() }, wrap: None };
            note.fields.push(crate::graph::Field { loc: Loc::Query("n".into()), class: crate::graph::Class::Derived { origin } });
            note.fields.push(crate::graph::Field { loc: Loc::Query("text".into()), class: crate::graph::Class::Input { name: "text".into(), secret: false, default: None, optional: false } });
            Graph { steps: vec![sign_in, note], provisional: false, page_origin: None, ..Graph::default() }
        };
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let note_cookie = |client: RouteClient| {
            let mut client = client;
            SEEN.lock().unwrap().clear();
            // The fake site takes the fixed sign-in and answers with a session of the author's.
            client.wire = Some(|| Box::new(Shop { seen: &SEEN, answers: |path| (200, if path == "/api/session" { vec!["author_sid=authors-session; Path=/"] } else { vec![] }) }));
            let answer = client.call(&HashMap::from([("text".to_string(), "the caller's private note".to_string())]));
            assert!(answer.is_ok(), "{answer:?}");
            let seen = SEEN.lock().unwrap().clone();
            seen.iter().find(|(p, _)| p == "/api/notes").map(|(_, c)| c.clone()).expect("the note step went")
        };
        let dir = owners_store("created");
        let c = note_cookie(RouteClient::new(route(true)).with_session_store(&dir));
        assert!(!c.contains("author_sid"), "without the owner's yes the author's session never carries the caller's value: {c:?}");
        let empty = std::env::temp_dir().join(format!("strangers-created-none-{}", std::process::id()));
        assert!(!note_cookie(RouteClient::new(route(true)).with_session_store(&empty)).contains("author_sid"), "an owner with no session at all");
        assert!(note_cookie(RouteClient::new(route(true)).with_session_store(&dir).consented()).contains("author_sid"), "the owner allowed the route");
        assert!(note_cookie(RouteClient::new(route(false)).with_session_store(&dir)).contains("author_sid"), "the node's own route");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An answer that replaces or takes out a cookie of the owner's session the request carried changes whose session
    /// the call runs in: a sign-in as someone else, or a sign-out. A route that came from another node stops at that
    /// step, sends nothing after it, and the owner's jar is untouched. The node's own route takes the new session.
    #[test]
    fn a_strangers_route_that_replaces_the_session_it_was_sent_with_stops() {
        for (n, set) in ["sid=someone-elses; Path=/", "sid=; Path=/; Max-Age=0"].into_iter().enumerate() {
            static SEEN: [Mutex<Seen>; 2] = [Mutex::new(Vec::new()), Mutex::new(Vec::new())];
            static SET: Mutex<&str> = Mutex::new("");
            *SET.lock().unwrap() = set;
            let dir = owners_store(&format!("swap{n}"));
            let before = files(&dir);
            let mut client = RouteClient::new(two_reads(true)).with_session_store(&dir).consented();
            client.wire = Some(if n == 0 {
                || Box::new(Shop { seen: &SEEN[0], answers: |path| (200, if path == "/api/me" { vec![*SET.lock().unwrap()] } else { vec![] }) })
            } else {
                || Box::new(Shop { seen: &SEEN[1], answers: |path| (200, if path == "/api/me" { vec![*SET.lock().unwrap()] } else { vec![] }) })
            });
            let answer = client.call(&HashMap::new());
            assert!(matches!(&answer, Err(ReplayError::RefusedHop(why)) if why.contains("sid")), "{set}: the call stops: {answer:?}");
            let seen = SEEN[n].lock().unwrap().clone();
            assert!(seen.iter().all(|(p, _)| p != "/api/list"), "{set}: nothing is sent after the step: {seen:?}");
            assert!(seen.iter().any(|(p, c)| p == "/api/me" && c.contains("sid=owners-session")), "{set}: the step was sent with the owner's session: {seen:?}");
            assert_eq!(files(&dir), before, "{set}: the owner's jar is untouched");
            let _ = std::fs::remove_dir_all(&dir);
        }
        // The node's own route: the site's new session is the owner's, as it always was.
        static OWN: Mutex<Seen> = Mutex::new(Vec::new());
        let dir = owners_store("swap-own");
        let mut client = RouteClient::new(two_reads(false)).with_session_store(&dir);
        client.wire = Some(|| Box::new(Shop { seen: &OWN, answers: |path| (200, if path == "/api/me" { vec!["sid=rotated; Path=/"] } else { vec![] }) }));
        client.call(&HashMap::new()).expect("the node's own route takes the new session");
        assert!(OWN.lock().unwrap().iter().any(|(p, c)| p == "/api/list" && c.contains("sid=rotated")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every request the fake shop below was sent, whole: its address with the query, every header, and its body.
    static WHOLE: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// A shop that writes down all of every request, so a value anywhere in it is seen.
    struct Recorder;

    impl Fetch for Recorder {
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let headers: Vec<String> = req.headers.iter().map(|(k, v)| format!("{k}: {v}")).collect();
            let body = req.body.as_deref().map(String::from_utf8_lossy).unwrap_or_default();
            WHOLE.lock().unwrap().push(format!("{} | {} | {body}", req.url, headers.join(" | ")));
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some(r#"{"items":[1]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }
    }

    /// Audit 1118 M7 (16 Nov H5): a step of a route that came from another node puts the owner's session only where a
    /// browser sends it. One that places the owner's session cookie in a query, form or JSON field is refused before
    /// anything of the call is sent, with the owner's yes or without; the same cookie in the cookie header goes, and the
    /// node's own route that places it in a query still sends it there, as its own walk saw. A header of a stranger's
    /// step never draws a value the jar knows as a cookie, while a header token of the session still rides.
    #[test]
    fn a_strangers_step_carries_the_session_only_in_the_cookie_header() {
        let dir = owners_store("placed");
        // `sid` is a cookie (a line set it: its path is recorded); `x-csrf` is a token the session keeps for a header.
        let jar = HashMap::from([("sid".to_string(), "owners-session".to_string()), ("x-csrf".to_string(), "owners-token".to_string())]);
        std::fs::write(dir.join("shop.example.com.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        let meta = HashMap::from([("sid".to_string(), CookieMeta { path: "/".into(), expires: None, order: 1, http_only: Some(true), bound_to: None })]);
        std::fs::write(meta_path(&dir, "shop.example.com"), unbrowse_files::JAR.to_vec_pretty(&meta).unwrap()).unwrap();
        let placing = |foreign: bool, fields: Vec<(Loc, &str)>| {
            let mut s = step(0, "/api/search", foreign);
            s.fields = fields.into_iter().map(|(loc, name)| crate::graph::Field { loc, class: Class::Minted { name: name.into() } }).collect();
            Graph { steps: vec![s], provisional: false, page_origin: None, ..Graph::default() }
        };
        let call = |client: RouteClient| {
            let mut client = client;
            client.wire = Some(|| Box::new(Recorder));
            WHOLE.lock().unwrap().clear();
            let answer = client.call(&HashMap::new());
            (answer, WHOLE.lock().unwrap().clone())
        };
        for loc in [Loc::Query("q".into()), Loc::Form("q".into()), Loc::Json("/q".into())] {
            for consented in [false, true] {
                let client = RouteClient::new(placing(true, vec![(loc.clone(), "sid")])).with_session_store(&dir);
                let (answer, sent) = call(if consented { client.consented() } else { client });
                assert!(matches!(&answer, Err(ReplayError::Refused(why)) if why.contains("cookie header") && !why.contains("owners-session")), "{loc}: {answer:?}");
                assert!(sent.is_empty(), "{loc}: nothing of the call was sent: {sent:?}");
            }
        }
        // The cookie header is where a stranger's step may carry the session, with the owner's yes.
        let (answer, sent) = call(RouteClient::new(placing(true, vec![(Loc::Cookie("sid".into()), "sid")])).with_session_store(&dir).consented());
        assert!(answer.is_ok(), "{answer:?}");
        assert!(sent.iter().any(|r| r.contains("cookie: sid=owners-session")), "{sent:?}");
        // A header of a stranger's step: the session's header token goes, the jar's cookie never does.
        let (answer, sent) = call(RouteClient::new(placing(true, vec![(Loc::Header("x-sid".into()), "sid"), (Loc::Header("x-csrf".into()), "x-csrf")])).with_session_store(&dir).consented());
        assert!(answer.is_ok(), "{answer:?}");
        assert!(sent.iter().any(|r| r.contains("x-csrf: owners-token")), "the header token rides: {sent:?}");
        assert!(sent.iter().all(|r| !r.contains("owners-session")), "the cookie is never moved into a header: {sent:?}");
        // The node's own route places what its own walk saw the page place: unchanged.
        let (answer, sent) = call(RouteClient::new(placing(false, vec![(Loc::Query("q".into()), "sid")])).with_session_store(&dir));
        assert!(answer.is_ok(), "{answer:?}");
        assert!(sent.iter().any(|r| r.contains("q=owners-session")), "{sent:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// A session that stops answering: what a call does about it, with the site's own pages and no browser.
#[cfg(test)]
mod session_refresh_tests {
    use super::*;
    use crate::replay::fake_wire::Answer;
    use std::sync::Mutex;

    /// One request the fake shop was sent: its path, and the cookie header it carried.
    type Seen = Vec<(String, String)>;

    /// A made-up shop whose `/api/list` refuses a call that carries the old session. `refuses` is the status it
    /// answers with (0: a `200` that is the sign-in page, where the call was sent to). The shop's page `/` hands out
    /// a fresh session cookie, and `mends` is whether `/api/list` takes that cookie.
    struct Gate {
        seen: &'static Mutex<Seen>,
        refuses: u16,
        mends: bool,
    }

    impl Answer for Gate {
        fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let path = req.url.path().to_string();
            let cookie = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
            self.seen.lock().unwrap().push((path.clone(), cookie.clone()));
            let mut ex = Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: None, response_mime: "application/json".into(), resource_type: None, main_frame: None };
            match path.as_str() {
                "/" => {
                    ex.response_headers = vec![("set-cookie".into(), "sid=fresh; Path=/".into())];
                    ex.response_body = Some("<html></html>".into());
                    ex.response_mime = "text/html".into();
                }
                "/api/list" if !(self.mends && cookie.contains("sid=fresh")) => match self.refuses {
                    0 => {
                        ex.url = "https://shop.example.com/login?next=%2Fapi%2Flist".parse().unwrap();
                        ex.response_body = Some(r#"<html><form><input type="password" name="pw"></form></html>"#.into());
                        ex.response_mime = "text/html".into();
                    }
                    status => {
                        ex.status = status;
                        ex.response_body = Some(r#"{"error":"signed out"}"#.into());
                    }
                },
                _ => ex.response_body = Some(r#"{"items":[1]}"#.into()),
            }
            Ok(ex)
        }
    }

    fn step(exchange: usize, path: &str) -> crate::graph::Step {
        crate::graph::Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: "GET".into(),
            status: 200,
            url: format!("https://shop.example.com{path}"),
            fields: vec![],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign: false,
            held: vec![],
            fallbacks: Vec::new(),
        }
    }

    /// The route's two calls: `/api/me` (the one that knows the session), then `/api/list`, which reads a value off
    /// the first's answer. The client holds an old session and the page the route was learned on.
    fn client(wire: fn() -> Box<dyn Fetch>) -> RouteClient {
        client_at(wire, "")
    }

    /// [`client`], whose page address carries `tag`: one walk per address runs at a time, so tests that open a
    /// browser each take an address of their own.
    fn client_at(wire: fn() -> Box<dyn Fetch>, tag: &str) -> RouteClient {
        let mut list = step(1, "/api/list");
        let origin = crate::provenance::Origin { exchange: 0, url: "https://shop.example.com/api/me".into(), at: crate::provenance::At::Json { pointer: "/items/0".into() }, wrap: None };
        list.fields.push(crate::graph::Field { loc: Loc::Query("n".into()), class: Class::Derived { origin } });
        let graph = Graph { steps: vec![step(0, "/api/me"), list], provisional: false, page_origin: None, ..Graph::default() };
        let mut c = RouteClient::new(graph);
        c.root = Some(format!("https://shop.example.com/{tag}"));
        c.target = Some(("GET".into(), "/api/list".into()));
        c.jar.insert("sid".into(), "old".into());
        c.wire = Some(wire);
        c
    }

    fn paths(seen: &Mutex<Seen>) -> Vec<String> {
        seen.lock().unwrap().iter().map(|(p, _)| p.clone()).collect()
    }

    /// A call that gets a `401` or a `403` runs the route's own first call again once the site's page has handed back
    /// a fresh session: the auth call goes first in each run, the page is asked once between, and no browser opens.
    #[test]
    fn a_refused_call_asks_the_sites_page_for_a_session_and_runs_the_chain_once_more() {
        static R401: Mutex<Seen> = Mutex::new(Vec::new());
        static R403: Mutex<Seen> = Mutex::new(Vec::new());
        let mut a = client(|| Box::new(Gate { seen: &R401, refuses: 401, mends: true }));
        let mut b = client(|| Box::new(Gate { seen: &R403, refuses: 403, mends: true }));
        for (c, seen) in [(&mut a, &R401), (&mut b, &R403)] {
            let answer = c.call(&HashMap::new()).expect("the fresh session answers");
            assert_eq!(answer["items"][0], 1);
            assert!(!c.used_browser(), "the page re-issued the session: no browser");
            assert_eq!(c.jar.get("sid").map(String::as_str), Some("fresh"));
            let seen = paths(seen);
            let list = seen.iter().position(|p| p == "/api/list").expect("the target ran");
            assert_eq!(&seen[list - 1], "/api/me", "the call that knows the session goes first: {seen:?}");
            assert_eq!(&seen[list + 1..], ["/", "/api/me", "/api/list"], "the page once, then the whole chain once more: {seen:?}");
            assert_eq!(seen.iter().filter(|p| *p == "/").count(), 1);
        }
    }

    /// A refusal that the fresh session does not mend is retried once and no more: the chain runs twice, the page is
    /// asked once, and the call fails saying the site refused it (the session reads as gone, not as the site moved).
    #[test]
    fn a_call_refused_again_after_the_fresh_session_fails_after_one_retry() {
        static R401: Mutex<Seen> = Mutex::new(Vec::new());
        static R403: Mutex<Seen> = Mutex::new(Vec::new());
        let mut a = client(|| Box::new(Gate { seen: &R401, refuses: 401, mends: false }));
        let mut b = client(|| Box::new(Gate { seen: &R403, refuses: 403, mends: false }));
        for (c, seen, status) in [(&mut a, &R401, 401), (&mut b, &R403, 403)] {
            let e = c.call(&HashMap::new()).unwrap_err();
            assert!(matches!(&e, ReplayError::Failed { status: s, .. } if *s == status), "{e:?}");
            assert!(session_gone(&e), "the failure says the session is gone");
            assert!(!c.used_browser());
            assert_eq!(paths(seen).iter().filter(|p| *p == "/api/list").count(), 2, "one call and one retry: {:?}", paths(seen));
            assert_eq!(paths(seen).iter().filter(|p| *p == "/").count(), 1);
        }
    }

    /// A page that refuses to hand a session back (its own `403`) leaves the call as it failed: the jar keeps the old
    /// session, the chain does not run again, and no browser is opened without one configured.
    #[test]
    fn a_refresh_the_page_refuses_leaves_the_call_failed_and_the_session_as_it_was() {
        static WALLED: Mutex<Seen> = Mutex::new(Vec::new());
        /// The site's page answers `403` but sets a cookie beside it: a refused page's cookie is nobody's session.
        struct Walled;
        impl Answer for Walled {
            fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                WALLED.lock().unwrap().push((req.url.path().to_string(), String::new()));
                let page = req.url.path() == "/";
                let set = if page { vec![("set-cookie".to_string(), "sid=fresh; Path=/".to_string())] } else { vec![] };
                Ok(Exchange { method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: if page { 403 } else { 401 }, response_headers: set, response_body: Some("no".into()), response_mime: "text/plain".into(), resource_type: None, main_frame: None })
            }
        }
        let mut c = client(|| Box::new(Walled));
        let e = c.call(&HashMap::new()).unwrap_err();
        assert!(matches!(&e, ReplayError::Failed { status: 401, .. }), "the call's own failure, not the page's: {e:?}");
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("old"));
        assert!(!c.used_browser());
        assert_eq!(paths(&WALLED).iter().filter(|p| *p == "/api/me").count(), 1, "the chain was not run again: {:?}", paths(&WALLED));
        let mut c = client(|| Box::new(Walled));
        assert!(!c.refresh_with(&mut Walled), "the session is not refreshed");
    }

    /// With a way to sign in (a browser to open), a call sent to the sign-in page signs in and runs the chain once
    /// more, the auth call first in the run. A `401` is answered from the site's page first and never spends the
    /// sign-in. (A `403` with a browser configured goes to the browser as a wall: that is not this path.)
    #[test]
    fn a_call_sent_to_the_sign_in_page_signs_in_once_and_runs_the_chain_once_more() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static R401: Mutex<Seen> = Mutex::new(Vec::new());
        static LOGIN: Mutex<Seen> = Mutex::new(Vec::new());
        let signing_in = |wire: fn() -> Box<dyn Fetch>, signed_in: std::sync::Arc<AtomicUsize>| {
            let mut c = client_at(wire, "?walk=sign-in").with_browser("/bin/true");
            c.sign_in = Some(Box::new(move || {
                signed_in.fetch_add(1, Ordering::SeqCst);
                Some(HashMap::from([("sid".to_string(), "fresh".to_string())]))
            }));
            c
        };
        let counts = [std::sync::Arc::new(AtomicUsize::new(0)), std::sync::Arc::new(AtomicUsize::new(0))];
        let mut clients = [signing_in(|| Box::new(Gate { seen: &R401, refuses: 401, mends: true }), counts[0].clone()), signing_in(|| Box::new(Gate { seen: &LOGIN, refuses: 0, mends: true }), counts[1].clone())];
        for (n, c) in clients.iter_mut().enumerate() {
            let answer = c.call(&HashMap::new());
            let seen = paths([&R401, &LOGIN][n]);
            assert!(answer.is_ok(), "trigger {n}: {answer:?}");
            assert_eq!(seen.iter().filter(|p| *p == "/api/list").count(), 2, "trigger {n}: one call, one retry: {seen:?}");
            assert_eq!(&seen[seen.iter().rposition(|p| p == "/api/list").unwrap() - 1], "/api/me", "trigger {n}: the auth call goes first: {seen:?}");
            // The 401 is mended by the site's page; only the redirect to a login page reaches the sign-in.
            assert_eq!(counts[n].load(Ordering::SeqCst), n, "trigger {n}");
        }
    }

    /// A page of another scheme, or of another site, is never asked for a session; a sibling host of the site is.
    #[test]
    fn only_a_page_of_the_routes_own_site_and_scheme_is_asked_for_a_session() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        for root in ["http://shop.example.com/", "https://shop.attacker.net/"] {
            let mut c = client(|| Box::new(Gate { seen: &SEEN, refuses: 401, mends: true }));
            c.root = Some(root.into());
            assert!(!c.refresh_with(&mut Gate { seen: &SEEN, refuses: 401, mends: true }), "{root}");
            assert_eq!(c.jar.get("sid").map(String::as_str), Some("old"), "{root}");
        }
        assert!(SEEN.lock().unwrap().is_empty(), "nothing was asked: {:?}", SEEN.lock().unwrap());
        let mut c = client(|| Box::new(Gate { seen: &SEEN, refuses: 401, mends: true }));
        c.root = Some("https://www.shop.example.com/".into());
        // Another host of the site is asked, with only the cookies a recorded Domain reaches (this jar's is host-only),
        // and a host-only cookie it answers with is not the jar's.
        assert!(!c.refresh_with(&mut Gate { seen: &SEEN, refuses: 401, mends: true }));
        assert_eq!(*SEEN.lock().unwrap(), vec![("/".to_string(), String::new())], "a host-only cookie does not go to a sibling host");
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("old"));
    }

    /// A header token the route names is the session's when the page hands it over, in a header of its own name or in a
    /// `<meta>`; a page that hands back what the jar holds changes nothing.
    #[test]
    fn a_token_the_route_names_is_taken_from_the_sites_page() {
        struct Page(&'static str, Vec<(String, String)>);
        impl Answer for Page {
            fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Ok(Exchange { method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: self.1.clone(), response_body: Some(self.0.into()), response_mime: "text/html".into(), resource_type: None, main_frame: None })
            }
        }
        let mut c = client(|| unreachable!("no wire"));
        c.graph.steps[1].fields.push(crate::graph::Field { loc: Loc::Header("x-csrf".into()), class: Class::Minted { name: "x-csrf".into() } });
        assert!(c.refresh_with(&mut Page("<html></html>", vec![("X-CSRF".into(), " from-header ".into())])));
        assert_eq!(c.jar.get("x-csrf").map(String::as_str), Some("from-header"));
        assert!(!c.refresh_with(&mut Page("<html></html>", vec![("x-csrf".into(), "from-header".into())])), "the same token is no news");
        assert!(c.refresh_with(&mut Page(r#"<html><head><meta name="x-csrf" content="from-meta"></head></html>"#, vec![])));
        assert_eq!(c.jar.get("x-csrf").map(String::as_str), Some("from-meta"));
        assert!(!c.refresh_with(&mut Page(r#"<meta name="x-csrf" content="">"#, vec![])), "an empty token is none");
        assert_eq!(c.jar.get("x-csrf").map(String::as_str), Some("from-meta"));
    }

    /// A route that came from another node reads the owner's session and never changes whose it is: a page that
    /// answers with a new value for the owner's cookie is refused, and the jar is left as it was.
    #[test]
    fn a_page_that_replaces_the_owners_session_is_not_taken_for_a_shared_route() {
        let dir = std::env::temp_dir().join(format!("refresh-owner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let jar = HashMap::from([("sid".to_string(), "owners-session".to_string())]);
        std::fs::write(dir.join("shop.example.com.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        let mut c = client(|| unreachable!("no wire"));
        for s in &mut c.graph.steps {
            s.foreign = true;
        }
        let mut c = c.with_egress(crate::egress::Egress::Foreign).with_session_store(&dir).consented();
        c.start_from_the_owners_session();
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        struct Hijack;
        impl Answer for Hijack {
            fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                SEEN.lock().unwrap().push((req.url.path().to_string(), String::new()));
                Ok(Exchange { method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![("set-cookie".into(), "sid=hijacked; Path=/".into())], response_body: Some("<html></html>".into()), response_mime: "text/html".into(), resource_type: None, main_frame: None })
            }
        }
        assert!(!c.refresh_with(&mut Hijack));
        assert_eq!(SEEN.lock().unwrap().len(), 1, "the page was asked");
        assert_eq!(c.jar.get("sid").map(String::as_str), Some("owners-session"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A write the site refused for its session did not land: the session is mended from the page and the write goes
    /// again, once. A write the site answered with an error that may have landed (a `503`) is sent once and never
    /// again, and the page is not asked for a session.
    #[test]
    fn a_refused_write_goes_again_once_and_a_write_that_may_have_landed_does_not() {
        static REFUSED: Mutex<Seen> = Mutex::new(Vec::new());
        static MAYBE: Mutex<Seen> = Mutex::new(Vec::new());
        let mut a = client(|| Box::new(Gate { seen: &REFUSED, refuses: 401, mends: true }));
        let mut b = client_at(|| Box::new(Gate { seen: &MAYBE, refuses: 503, mends: true }), "?walk=write").with_browser("/bin/true");
        for c in [&mut a, &mut b] {
            c.graph.steps[1].method = "POST".into();
        }
        a.call(&HashMap::new()).expect("the write goes again on the mended session");
        let seen = paths(&REFUSED);
        assert_eq!(seen.iter().filter(|p| *p == "/api/list").count(), 2, "{seen:?}");
        assert_eq!(seen.iter().filter(|p| *p == "/").count(), 1, "{seen:?}");
        let e = b.call(&HashMap::new()).unwrap_err();
        assert!(matches!(&e, ReplayError::Failed { status: 503, .. }), "{e:?}");
        let seen = paths(&MAYBE);
        assert_eq!(seen.iter().filter(|p| *p == "/api/list").count(), 1, "the write went once: {seen:?}");
        assert!(!seen.iter().any(|p| p == "/"), "no session was asked for after a write that may have landed: {seen:?}");
        assert!(!b.used_browser(), "nor was a walk of the page made, which would send the write again");
    }

    /// A target that went on its own first, and may have written, ends the call there: the chain before it is not
    /// run to send it again.
    #[test]
    fn a_target_that_went_first_and_may_have_written_is_not_followed_by_the_chain() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut c = client(|| Box::new(Gate { seen: &SEEN, refuses: 500, mends: false }));
        c.graph.steps[1].method = "POST".into();
        c.graph.steps[1].fields.clear();
        let e = c.call(&HashMap::new()).unwrap_err();
        assert!(matches!(&e, ReplayError::Failed { status: 500, .. }), "{e:?}");
        assert_eq!(paths(&SEEN), ["/api/list"], "the target alone went, and nothing after it");
    }

    /// When the session cannot be mended from the page, a walk of the page is the node's browser's: it opens, and a
    /// walk that shows nothing leaves the call failed as it failed.
    #[test]
    fn a_walk_that_finds_nothing_leaves_the_call_failed_as_it_failed() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut c = client_at(|| Box::new(Gate { seen: &SEEN, refuses: 401, mends: false }), "?walk=nothing").with_browser("/bin/true");
        let e = c.call(&HashMap::new()).unwrap_err();
        assert!(matches!(&e, ReplayError::Failed { status: 401, .. }), "{e:?}");
        assert!(c.used_browser(), "the page was walked");
        assert!(c.fell_back().iter().any(|f| f.contains("browser walked the page again")), "{:?}", c.fell_back());
        assert!(c.healed().is_none());
    }

    /// One walk per page at a time: a call that fails while another walks the same page does not open a second
    /// browser, and fails as it failed.
    #[test]
    fn a_call_that_fails_while_its_page_is_being_walked_opens_no_browser() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut c = client_at(|| Box::new(Gate { seen: &SEEN, refuses: 401, mends: false }), "?walk=held").with_browser("/bin/true");
        let walking = HealGuard::take("https://shop.example.com/?walk=held").expect("nobody else walks it");
        let e = c.call(&HashMap::new()).unwrap_err();
        assert!(matches!(&e, ReplayError::Failed { status: 401, .. }), "{e:?}");
        assert!(!c.used_browser());
        drop(walking);
    }

    /// A route that came from another node mints only on its own site: a page of another site is never walked in the
    /// owner's browser, and the call fails as it failed.
    #[test]
    fn a_shared_route_never_walks_a_page_off_its_site() {
        static SEEN: Mutex<Seen> = Mutex::new(Vec::new());
        let mut c = client(|| Box::new(Gate { seen: &SEEN, refuses: 401, mends: false })).with_egress(crate::egress::Egress::Foreign).with_shared_mint(true).with_browser("/bin/true");
        assert!(c.browser.is_some(), "the owner allowed the route a browser of its own");
        c.root = Some("https://elsewhere.example.net/?walk=off-site".into());
        let e = c.call(&HashMap::new()).unwrap_err();
        assert!(matches!(&e, ReplayError::Failed { status: 401, .. } | ReplayError::Refused(_)), "{e:?}");
        assert!(!c.used_browser());
    }
}

/// What a client keeps of a session and how it reads one: the storage, fingerprint and tokens beside the jar, and the
/// transport the site is asked over.
#[cfg(test)]
mod client_state_tests {
    use super::*;
    use crate::replay::fake_wire::Answer;
    use std::sync::Mutex;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("client-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn step(exchange: usize, path: &str) -> crate::graph::Step {
        crate::graph::Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: "GET".into(),
            status: 200,
            url: format!("https://shop.example.com{path}"),
            fields: vec![],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign: false,
            held: vec![],
            fallbacks: Vec::new(),
        }
    }

    fn one_read() -> Graph {
        Graph { steps: vec![step(0, "/api/list")], provisional: false, page_origin: None, ..Graph::default() }
    }

    /// What the page kept in its storages and what its code saw of the browser go beside the jar after a walk, are
    /// there for the next call, and go when there is nothing to keep. A route that came from another node writes
    /// neither: its walk is its call's alone.
    #[test]
    fn a_walks_page_state_is_kept_beside_the_jar_for_the_nodes_own_route_only() {
        let dir = scratch("page-state");
        let mut c = RouteClient::new(one_read()).with_session_store(&dir);
        c.storage.local.insert("k".into(), "v".into());
        c.storage.session.insert("s".into(), "w".into());
        c.fingerprint = serde_json::json!({ "ua": "Browser/1" });
        c.save_storage();
        c.save_fingerprint();
        assert!(storage_path(&dir, "shop.example.com").exists());
        assert!(fingerprint_path(&dir, "shop.example.com").exists());
        let next = RouteClient::new(one_read()).with_session_store(&dir);
        assert_eq!(next.storage.local.get("k").map(String::as_str), Some("v"));
        assert_eq!(next.storage.session.get("s").map(String::as_str), Some("w"));
        assert_eq!(next.fingerprint["ua"], "Browser/1");
        c.storage = Default::default();
        c.fingerprint = Value::Null;
        c.save_storage();
        c.save_fingerprint();
        assert!(!storage_path(&dir, "shop.example.com").exists(), "an empty storage leaves no file");
        assert!(!fingerprint_path(&dir, "shop.example.com").exists(), "no fingerprint leaves no file");
        let strangers = scratch("page-state-foreign");
        let mut f = RouteClient::new(one_read()).with_egress(crate::egress::Egress::Foreign).with_session_store(&strangers);
        f.storage.local.insert("k".into(), "v".into());
        f.fingerprint = serde_json::json!({ "ua": "Browser/1" });
        f.save_storage();
        f.save_fingerprint();
        assert!(!storage_path(&strangers, "shop.example.com").exists() && !fingerprint_path(&strangers, "shop.example.com").exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&strangers);
    }

    /// A session the browser earned since the client read its jar joins the jar beside what it already holds.
    #[test]
    fn a_session_the_browser_earned_joins_the_jar_beside_what_it_holds() {
        let mut c = RouteClient::new(one_read());
        c.jar.insert("sid".into(), "old".into());
        c.jar.insert("keep".into(), "me".into());
        c.absorb(HashMap::from([("sid".to_string(), "fresh".to_string()), ("new".to_string(), "1".to_string())]));
        assert_eq!(c.jar, HashMap::from([("sid".to_string(), "fresh".to_string()), ("keep".to_string(), "me".to_string()), ("new".to_string(), "1".to_string())]));
    }

    /// A page is walked by one call at a time, and free again when that walk ends.
    #[test]
    fn a_page_is_walked_by_one_call_at_a_time() {
        let first = HealGuard::take("https://guarded.example/a").expect("nobody walks it");
        assert!(HealGuard::take("https://guarded.example/a").is_none(), "already walked");
        assert!(HealGuard::take("https://guarded.example/b").is_some(), "another page is free");
        drop(first);
        assert!(HealGuard::take("https://guarded.example/a").is_some(), "free again once the walk ended");
    }

    /// Where a browser sends a `Secure` cookie: over TLS, or to this machine itself, by name or by loopback address.
    #[test]
    fn a_secure_context_is_tls_or_this_machine() {
        for url in ["https://shop.example/", "wss://shop.example/", "http://localhost/", "http://api.localhost:8080/", "http://127.0.0.1:9/", "http://[::1]/"] {
            assert!(secure_context(&url.parse().unwrap()), "{url}");
        }
        for url in ["http://shop.example/", "http://10.0.0.5/", "ws://shop.example/", "http://notlocalhost/", "http://localhost.example/"] {
            assert!(!secure_context(&url.parse().unwrap()), "{url}");
        }
    }

    /// The route's own client's reading of the session store: its cookies, and its page's storages under the names
    /// the store keeps them by; and the transport presents the browser the store's fingerprint names.
    #[test]
    fn a_session_is_read_from_the_store_as_the_routes_own_client_reads_it() {
        let dir = scratch("as-its-client");
        let jar = HashMap::from([("sid".to_string(), "held".to_string())]);
        std::fs::write(dir.join("shop.example.com.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        let storage = crate::sandbox::Storage { local: HashMap::from([("k".to_string(), "l".to_string())]), session: HashMap::from([("k".to_string(), "s".to_string())]) };
        std::fs::write(storage_path(&dir, "shop.example.com"), unbrowse_files::JAR.to_vec_pretty(&storage).unwrap()).unwrap();
        let (_, held) = as_its_client(&one_read(), &dir, crate::egress::Egress::Own, None).unwrap();
        assert_eq!(held.get("sid").map(String::as_str), Some("held"));
        assert_eq!(held.get(&unbrowse_route::expr::Area::Local.held_as("k")).map(String::as_str), Some("l"));
        assert_eq!(held.get(&unbrowse_route::expr::Area::Session.held_as("k")).map(String::as_str), Some("s"));
        assert_eq!(held.len(), 3);
        // A store with nothing for the site gives a transport and an empty session.
        let (_, none) = as_its_client(&one_read(), &scratch("as-its-client-empty"), crate::egress::Egress::Own, Some("walked/1.0")).unwrap();
        assert!(none.is_empty());
        assert!(presenting(None, &dir, crate::egress::Egress::Own, Some("walked/1.0")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The page's scripts are booted with what the call holds: the fingerprint, the storages, the page and its html,
    /// each script by address; and a value the page kept is read from the storage it was kept in.
    #[test]
    fn the_pages_environment_is_what_the_call_holds_of_it() {
        let mut r = super::tests::runner("https://shop.example.com/");
        r.fingerprint = serde_json::json!({ "ua": "Browser/1" });
        r.storage.local.insert("k".into(), "in-local".into());
        r.storage.session.insert("k".into(), "in-session".into());
        r.page = Some("https://shop.example.com/search".into());
        r.page_html = Some("<html></html>".into());
        r.scripts = vec![crate::signing::Script { url: "https://cdn.shop.example.com/app.js".into(), body: "1".into() }];
        let env = r.environment();
        assert_eq!(env.fingerprint["ua"], "Browser/1");
        assert_eq!(env.storage, r.storage);
        assert_eq!(env.page_url.as_deref(), Some("https://shop.example.com/search"));
        assert_eq!(env.html.as_deref(), Some("<html></html>"));
        assert_eq!(env.scripts, vec![("https://cdn.shop.example.com/app.js".to_string(), "1".to_string())]);
        assert_eq!(r.stored(unbrowse_route::expr::Area::Local, "k").as_deref(), Some("in-local"));
        assert_eq!(r.stored(unbrowse_route::expr::Area::Session, "k").as_deref(), Some("in-session"));
        assert_eq!(r.stored(unbrowse_route::expr::Area::Local, "absent"), None);
    }

    /// Once the site replaced the owner's session, nothing more is sent under it: the next request is refused with
    /// the reason, before it leaves.
    #[test]
    fn nothing_is_sent_once_the_site_replaced_the_owners_session() {
        static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
        struct Wire;
        impl Answer for Wire {
            fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> { SEEN.lock().unwrap().push(req.url.to_string()); Err(ReplayError::Transport("sent".into())) }
        }
        let mut r = super::tests::runner("https://shop.example.com/");
        r.transport.fetch = Box::new(Wire);
        r.replaced = Some("sid".into());
        let e = r.fetch(&Request { method: "GET".into(), url: "https://shop.example.com/api/list".parse().unwrap(), exchange: 0, headers: vec![], body: None }).unwrap_err();
        assert!(matches!(&e, ReplayError::Refused(why) if why.contains("replaced the session") && why.contains("sid")), "{e:?}");
        assert!(SEEN.lock().unwrap().is_empty(), "nothing left the node");
    }

    /// The steps that only carry the session are served from the store: a step whose answer a later step reads only
    /// for a cookie it set is one, and a step whose answer a later step reads for anything else too is not.
    #[test]
    fn a_step_that_only_carries_a_cookie_is_served_from_the_store() {
        let chain = |also: serde_json::Value| -> Graph {
            let mut fields = vec![serde_json::json!({ "loc": { "in": "cookie", "key": "sid" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example.com/api/cart", "at": { "from": "set_cookie", "name": "sid" } } })];
            fields.extend(also.as_array().cloned().unwrap_or_default());
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example.com/api/cart", "fields": [], "needs_browser": false, "sets_cookie": true },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example.com/api/list", "needs_browser": false, "fields": fields }
            ]})).unwrap()
        };
        let served = session_steps(&chain(serde_json::json!([])), false);
        assert_eq!(served, HashMap::from([(0, vec!["sid".to_string()])]));
        let also_read = serde_json::json!([{ "loc": { "in": "query", "key": "n" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example.com/api/cart", "at": { "from": "json", "pointer": "/items/0" } } }]);
        let read = session_steps(&chain(also_read), false);
        assert!(read.is_empty(), "{read:?}");
    }

    /// Holds a vault value to the owner's site: a step that carries one goes over TLS to a host of that site or the
    /// call is not sent; the steps that carry none are not asked.
    #[test]
    fn a_vault_value_goes_only_to_the_owners_site_over_tls_and_the_other_steps_are_not_asked() {
        let carrying = |url: &str| {
            let mut pay = step(1, "/api/pay");
            pay.url = url.to_string();
            pay.fields.push(crate::graph::Field { loc: Loc::Query("pan".into()), class: Class::Input { name: "pan".into(), secret: true, default: None, optional: false } });
            Graph { steps: vec![step(0, "/api/me"), pay], provisional: false, page_origin: None, ..Graph::default() }
        };
        let held = vec!["pan".to_string()];
        let site = crate::identity::site_of("shop.example.com");
        assert_eq!(held_input_leaves(&carrying("https://pay.shop.example.com/api/pay"), &held, &site), None);
        assert_eq!(held_input_leaves(&carrying("https://pay.shop.example.com/api/pay"), &["other".to_string()], &site), None, "no such value");
        let leaked = held_input_leaves(&carrying("http://shop.example.com/api/pay"), &held, &site).expect("in the clear");
        assert!(leaked.contains("step 2") && leaked.contains("pan"), "{leaked}");
        assert!(held_input_leaves(&carrying("https://collector.example.net/api/pay"), &held, &site).is_some(), "another site");
    }

    /// A route that came from another node may open a browser only on its own site, over TLS; the node's own route
    /// anywhere its walk went.
    #[test]
    fn a_shared_routes_browser_goes_only_to_its_own_site_over_tls() {
        let own = RouteClient::new(one_read());
        assert!(own.on_the_routes_site("http://elsewhere.example.net/"));
        let shared = RouteClient::new(one_read()).with_egress(crate::egress::Egress::Foreign);
        assert!(shared.on_the_routes_site("https://www.shop.example.com/page"));
        assert!(!shared.on_the_routes_site("http://shop.example.com/page"), "not over TLS");
        assert!(!shared.on_the_routes_site("https://elsewhere.example.net/"), "another site");
        assert!(!shared.on_the_routes_site("not a url"));
    }

    /// How far each cookie of the jar goes is read back from beside it, for the cookies the jar still holds.
    #[test]
    fn how_far_a_cookie_goes_is_read_back_only_for_cookies_the_jar_holds() {
        let dir = scratch("scope");
        let jar = HashMap::from([("sid".to_string(), "1".to_string())]);
        std::fs::write(dir.join("shop.example.com.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        let scope = HashMap::from([("sid".to_string(), ".shop.example.com".to_string()), ("gone".to_string(), ".shop.example.com".to_string())]);
        std::fs::write(scope_path(&dir, "shop.example.com"), unbrowse_files::JAR.to_vec_pretty(&scope).unwrap()).unwrap();
        let c = RouteClient::new(one_read()).with_session_store(&dir);
        assert_eq!(c.jar_domains, HashMap::from([("sid".to_string(), ".shop.example.com".to_string())]));
        assert_eq!(c.loaded_scope.as_ref(), Some(&c.jar_domains));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A route that came from another node, allowed to act in the owner's session, sends the owner's cookie only where
    /// the jar's goes: a request that named it for another host goes without the cookie header at all.
    #[test]
    fn a_shared_request_to_another_host_goes_without_the_owners_cookie() {
        let mut r = super::tests::runner("https://www.shop.example.com/");
        r.owner = Some(HashMap::new());
        r.session_allowed = true;
        let req = |url: &str| Request { method: "GET".into(), url: url.parse().unwrap(), exchange: 0, headers: vec![("cookie".into(), "sid=host-only-secret".into())], body: None };
        let off = r.with_session_cookies(&req("https://collector.example.net/x"));
        assert!(off.headers.iter().all(|(k, _)| !k.eq_ignore_ascii_case("cookie")), "{:?}", off.headers);
        let home = r.with_session_cookies(&req("https://www.shop.example.com/x"));
        assert!(home.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("cookie") && v.contains("sid=host-only-secret")), "{:?}", home.headers);
    }

    /// A site's reply of a made-up kind, for any address.
    struct Reply(u16, &'static str, &'static str);
    impl Answer for Reply {
        fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            Ok(Exchange { method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: self.0, response_headers: vec![], response_body: Some(self.2.into()), response_mime: self.1.into(), resource_type: None, main_frame: None })
        }
    }

    /// A route of one read, learned on a page that said `walked` when it said anything.
    fn search_route(walked: Option<&str>) -> RouteClient {
        let mut g = Graph { steps: vec![step(0, "/search")], provisional: false, page_origin: None, ..Graph::default() };
        g.page_html = walked.map(String::from);
        RouteClient::new(g)
    }

    const HOLD: &str = "<html><head><title>One moment</title></head><body><p>please wait</p></body></html>";

    /// A reply that is neither data nor a page is a shape the route did not learn, and the call says what the site sent.
    #[test]
    fn a_reply_that_is_no_data_and_no_page_is_a_shape_the_route_did_not_learn() {
        let mut c = search_route(None);
        c.wire = Some(|| Box::new(Reply(200, "application/octet-stream", "\u{1}\u{2} nothing a reader reads")));
        let e = c.call(&HashMap::from([("q".to_string(), "zebra lamps".to_string())])).unwrap_err();
        assert!(matches!(&e, ReplayError::ShapeMismatch { got: Value::String(g), .. } if g.contains("nothing a reader reads")), "{e:?}");
    }

    /// A page that links nowhere and says nothing of what was asked is a check, not the page.
    #[test]
    fn a_page_that_says_nothing_of_what_was_asked_is_a_check_not_the_answer() {
        let mut c = search_route(None);
        c.wire = Some(|| Box::new(Reply(200, "text/html", HOLD)));
        let e = c.call(&HashMap::from([("q".to_string(), "zebra lamps".to_string())])).unwrap_err();
        assert!(matches!(&e, ReplayError::NotAnAnswer { challenge: true, .. }), "{e:?}");
    }

    /// The same page is the answer when the page the route was learned on said something too: the site is brief, not
    /// blocking.
    #[test]
    fn a_brief_page_is_the_answer_when_the_page_the_route_was_learned_on_said_something() {
        let mut c = search_route(Some(r#"<html><head><title>Lamps</title></head><body><a href="/p/1">Brass lamp</a></body></html>"#));
        c.wire = Some(|| Box::new(Reply(200, "text/html", HOLD)));
        let page = c.call(&HashMap::from([("q".to_string(), "zebra lamps".to_string())])).expect("a page that says something");
        assert_eq!(page["title"], "One moment");
    }

    /// A `404` page that says back what was asked is the site's empty answer, and says its status beside what it shows.
    #[test]
    fn a_404_page_that_says_back_what_was_asked_is_an_answer_with_its_status() {
        let mut c = search_route(None);
        c.wire = Some(|| Box::new(Reply(404, "text/html", "<html><head><title>No results</title></head><body>Nothing found for zebra lamps</body></html>")));
        let nothing = c.call(&HashMap::from([("q".to_string(), "zebra lamps".to_string())])).expect("nothing is what there is");
        assert_eq!(nothing["status"], 404);
    }

    /// A runner on a page of the shop whose script, when it runs, makes the calls `body` says.
    fn page_runner(body: &str) -> Runner {
        let mut r = super::tests::runner("https://www.shop.example/");
        r.page = Some("https://www.shop.example/search?q=walked".to_string());
        r.page_html = Some("<!doctype html><html><head></head><body></body></html>".to_string());
        r.scripts = vec![crate::signing::Script { url: "https://cdn.shop.example/app.js".into(), body: body.into() }];
        r
    }

    fn asked(path: &str) -> Request {
        Request { method: "POST".into(), url: format!("https://www.shop.example{path}").parse().unwrap(), exchange: 1, headers: vec![], body: None }
    }

    const TWO_CALLS: &str = "fetch('/api/a', { method: 'POST', headers: { 'x-sig': 'a' }, body: '{}' }); fetch('/api/b', { method: 'POST', headers: { 'x-sig': 'b' }, body: '{}' });";

    /// One boot of the page signs every call it makes: the steps after the first take theirs from the same boot, and
    /// the page's scripts are not run again for each.
    #[test]
    fn one_boot_of_the_page_signs_every_call_it_makes() {
        if !crate::sandbox::available() { return eprintln!("no signing runtime on this machine: the sandbox is skipped"); }
        let mut r = page_runner(TWO_CALLS);
        let first = r.sign_request(&asked("/api/a"), &HashMap::new()).expect("the page's call");
        assert!(first.headers.iter().any(|(k, v)| k == "x-sig" && v == "a"), "{:?}", first.headers);
        // Nothing left to run: the second call is read from the first boot.
        r.scripts.clear();
        r.sandbox_off.set(true);
        let second = r.sign_request(&asked("/api/b"), &HashMap::new()).expect("the same boot's other call");
        assert!(second.headers.iter().any(|(k, v)| k == "x-sig" && v == "b"), "{:?}", second.headers);
    }

    /// A page that made no call with the storage the walk left decides it already has what it needs: it is booted
    /// again with empty storage, as a browser opened fresh would be, before the call is given up on.
    #[test]
    fn a_page_that_made_no_call_on_the_walks_storage_is_booted_again_on_empty_storage() {
        if !crate::sandbox::available() { return eprintln!("no signing runtime on this machine: the sandbox is skipped"); }
        let mut r = page_runner("if (!localStorage.getItem('done')) { fetch('/api/a', { method: 'POST', headers: { 'x-sig': 'fresh' }, body: '{}' }); }");
        r.storage.local.insert("done".into(), "1".into());
        let signed = r.sign_request(&asked("/api/a"), &HashMap::new()).expect("signed on empty storage");
        assert!(signed.headers.iter().any(|(k, v)| k == "x-sig" && v == "fresh"), "{:?}", signed.headers);
    }

    /// A call the page never makes is not signed by another of its calls, and with no browser to open the page in,
    /// the step is left to fail as one that needs a browser.
    #[test]
    fn a_call_the_page_never_makes_is_not_signed_by_another() {
        if !crate::sandbox::available() { return eprintln!("no signing runtime on this machine: the sandbox is skipped"); }
        let mut r = page_runner(TWO_CALLS);
        assert!(r.sign_request(&asked("/api/elsewhere"), &HashMap::new()).is_none());
        assert!(!r.used_browser.load(std::sync::atomic::Ordering::Relaxed), "nothing to open the page in");
    }

    /// What was once hidden from a page's script stays hidden for the same value: only a value known to be readable
    /// takes what a line says now, and a value never recorded stays unknown.
    #[test]
    fn what_was_hidden_from_a_pages_script_stays_hidden_for_the_same_value() {
        assert_eq!(kept_from_script(Some(false), true, Some(true)), Some(true), "readable, now said hidden");
        assert_eq!(kept_from_script(Some(false), true, Some(false)), Some(false));
        assert_eq!(kept_from_script(Some(true), true, Some(false)), Some(true), "hidden stays hidden");
        assert_eq!(kept_from_script(None, true, Some(false)), None, "unknown stays unknown");
        assert_eq!(kept_from_script(None, false, Some(false)), None, "no record at all");
    }

    /// What a walk's browser knew of the cookies it handed the jar goes beside it, for the cookies the jar holds; a
    /// walk that knew nothing writes nothing.
    #[test]
    fn what_a_walk_knew_of_its_cookies_is_written_beside_the_jar_for_the_cookies_it_holds() {
        let dir = scratch("cookie-facts");
        let jar = HashMap::from([("sid".to_string(), "1".to_string())]);
        std::fs::write(dir.join("shop.example.com.json"), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        note_cookie_facts(&dir, "shop.example.com", &HashMap::new(), &HashMap::new());
        assert!(!meta_path(&dir, "shop.example.com").exists(), "nothing was known");
        let fact = |path: &str| agent_browser_core::session::CookieFacts { path: path.into(), http_only: true, expires: None };
        let facts = HashMap::from([("sid".to_string(), fact("/app")), ("stray".to_string(), fact("/"))]);
        note_cookie_facts(&dir, "shop.example.com", &facts, &HashMap::new());
        let meta: HashMap<String, CookieMeta> = unbrowse_files::JAR.read_at(&meta_path(&dir, "shop.example.com")).unwrap().unwrap();
        assert_eq!(meta.keys().collect::<Vec<_>>(), ["sid"], "only what the jar holds");
        assert_eq!(meta["sid"].path, "/app");
        assert_eq!(meta["sid"].http_only, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A route that came from another node reaches only the origins it names, through the plain fetch and the
    /// request check as through any other: another host is refused before anything is sent; the node's own route has
    /// no such bound.
    #[test]
    fn a_held_wire_refuses_what_the_route_does_not_name_before_it_sends() {
        let at = |url: &str| Request { method: "GET".into(), url: url.parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let within = Within::new(["https://shop.example.com".to_string()], Some(("https".into(), "shop.example.com".into())), HashMap::new());
        let mut held = Held { fetch: Box::new(Reply(200, "text/html", "<html></html>")), within: Some(within) };
        assert!(held.fetch_unredirected(&at("https://shop.example.com/x")).is_ok());
        assert!(matches!(held.fetch_unredirected(&at("https://collector.example.net/x")), Err(ReplayError::Refused(_))));
        assert!(held.allows(&at("https://shop.example.com/x")).is_ok());
        assert!(matches!(held.allows(&at("https://collector.example.net/x")), Err(ReplayError::Refused(_))));
        let mut free = Held { fetch: Box::new(Reply(200, "text/html", "<html></html>")), within: None };
        assert!(free.fetch_unredirected(&at("https://collector.example.net/x")).is_ok());
        assert!(free.allows(&at("https://collector.example.net/x")).is_ok());
    }
}
