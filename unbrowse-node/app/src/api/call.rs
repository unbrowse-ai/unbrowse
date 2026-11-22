//! Calling a route: running it, billing the use, and calling an entry another node listed.

use super::*;

/// A route's values, for an agent to read before it calls or changes it: each step, each field's class and where the
/// value comes from, whether a step needs a browser, the scripts it carries, and the graph's own description. Nothing
/// is called and nothing is paid; no value is revealed, only its class and where it came from.
pub(super) fn do_inspect(route_id: String) -> Result<Value, Fail> {
    use unbrowse_learn::graph::Class;
    let mut kept = store::load_route(&route_id).ok_or((StatusCode::NOT_FOUND, "no such route: search, or say what you want with unbrowse_do".into()))?;
    // What the route carries for its signing bridge is shown too: its page's code, read back from its file.
    kept.graph.rejoined();
    // Shown as an agent is shown a kept route: nothing the owner's own session gave the page, whole or in an address.
    let route = kept.shown_to_an_agent();
    let class = |c: &Class| -> &'static str {
        match c {
            Class::Input { .. } => "input",
            Class::Constant { .. } => "constant",
            Class::Derived { .. } => "derived",
            Class::Piece { .. } => "piece",
            Class::Computed => "computed",
            Class::Script { .. } => "script",
            Class::Recipe { .. } => "recipe",
            Class::Generated { .. } => "generated",
            Class::Minted { .. } => "minted",
            Class::Unconfirmed { .. } => "unconfirmed",
            Class::Fresh { .. } => "fresh",
            Class::File { .. } => "file",
            Class::CookieIn { .. } => "cookie_in",
        }
    };
    let mut steps = Vec::new();
    for (n, s) in route.graph.steps.iter().enumerate() {
        let fields: Vec<Value> = s
            .fields
            .iter()
            .map(|f| {
                let mut v = json!({ "loc": f.loc, "at": learn::place_of(&f.loc), "class": class(&f.class) });
                match &f.class {
                    Class::Input { name, secret, optional, .. } => v["input"] = json!({ "name": name, "secret": secret, "optional": optional }),
                    Class::Minted { name } => v["name"] = json!(name),
                    Class::Derived { origin } => v["from_exchange"] = json!(origin.exchange),
                    Class::Script { producer } => v["producer"] = json!({ "script": producer.script, "at": producer.at }),
                    Class::Recipe { recipe } => v["recipe"] = json!({ "algo": recipe.algo, "parts": recipe.parts.len() }),
                    Class::Generated { program, evidence } => {
                        v["evidence"] = json!(evidence);
                        v["program_bytes"] = json!(program.len());
                    }
                    Class::Unconfirmed { .. } => v["provisional"] = json!(true),
                    _ => {}
                }
                v
            })
            .collect();
        steps.push(json!({ "step": n + 1, "method": s.method, "url": s.url, "needs_browser": s.needs_browser, "page_signed": s.is_page_signed(), "fields": fields, "page_producers": s.page_producers.iter().map(|p| json!({ "loc": p.loc, "at": learn::place_of(&p.loc), "producer": p.producer })).collect::<Vec<_>>() }));
    }
    Ok(said_to_an_agent(&kept, json!({
        "route": {
            "id": route.id,
            "site": route.site,
            "what": route.what,
            "method": route.method,
            "path": route.path,
            "steps": route.steps,
            "inputs": route.inputs.iter().map(|i| json!({ "name": i.name, "kind": i.kind(), "secret": i.secret, "optional": i.optional })).collect::<Vec<_>>(),
        },
        "browser": route.graph.steps.iter().any(|s| s.needs_browser || s.is_page_signed()),
        "page_signed_steps": route.graph.steps.iter().filter(|s| s.is_page_signed()).count(),
        "carried_page": unbrowse_learn::replay::page_is_carried(&route.graph),
        "page_reads": unbrowse_learn::replay::page_reads(&route.graph),
        "plain_trial": route.plain_trial,
        "scripts": { "count": route.graph.scripts.len(), "bytes": route.graph.scripts.iter().map(|s| s.body.len()).sum::<usize>() },
        "steps": steps,
        "describe": route.graph.describe(),
    })))
}

/// The longest a caller waits for the node's second look at a site before its own ask goes ahead.
pub(crate) const VERDICT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Whether a call of `route` may need the site's one browser, which a second look may be holding: the page signs
/// it, or a step of it is the browser's to make.
pub(super) fn waits_for_the_browser(route: &store::Route) -> bool {
    route.browser_assisted || route.graph.steps.iter().any(|s| s.is_page_signed() || s.needs_browser)
}

tokio::task_local! {
    /// Whether the ask this task answers said `browser: never` ([`with_the_browser_shut`]).
    static BROWSER_SHUT: bool;
}

/// `work`, every route call it makes holding to `shut`: an ask that said `browser: never` opens no browser for any
/// call it makes (`run::with_the_browser_shut`), whichever path reaches the call.
pub(crate) async fn with_the_browser_shut<F: std::future::Future>(shut: bool, work: F) -> F::Output {
    BROWSER_SHUT.scope(shut, work).await
}

fn browser_shut() -> bool {
    BROWSER_SHUT.try_with(|s| *s).unwrap_or(false)
}

/// A route called by an agent straight after it was learned: the node is still holding that route to a second walk,
/// in the site's one browser. The call waits for the verdict, as a goal for the page does, so it runs the route
/// that stood, and a repair it may need finds the browser free and not a page half loaded under another walk.
pub(crate) async fn do_call_when_settled(node: &Arc<Node>, a: &Agent, id: String, inputs: HashMap<String, String>, fields: Vec<String>) -> Result<Value, Fail> {
    // Only a route that needs the site's browser waits for it, and not for long: one that answers over plain calls
    // runs beside the second look, and an id the second look replaces is answered by the route that took its place
    // (`standing_for`). A caller held five minutes for the node's own checking was held for nothing it needed.
    if let Some(route) = store::load_route(&id).filter(waits_for_the_browser) {
        let waited = std::time::Instant::now();
        while crate::learn::verifying(&route.root) && waited.elapsed() < VERDICT_WAIT {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    let asked = inputs.clone();
    let mut called = do_call_fields(node, a, id.clone(), inputs, fields).await;
    // An answer that says the walked value and no word of the one this call gave answered the walk, whatever the
    // site's status says: handed back as ok, the caller reads another search's results as its own. A read only.
    if let (Ok(reply), Some(route)) = (called.as_mut(), store::load_route(&id).filter(|r| !r.write)) {
        // A page that asks for a person, read back as the answer, is the site's check and not what was called for.
        let a_check = reply["data"].get("title").is_some() && reply["data"].get("text").and_then(Value::as_str).is_some_and(|t| t.chars().count() < 4000 && crate::challenge::wants_a_person(t));
        if reply["ok"].as_bool() == Some(true) && a_check {
            reply["ok"] = json!(false);
            reply["error"] = json!("the site answered with a page that asks for a person, not the page asked for");
            let page = json!({ "action": "look", "site": route.site, "url": route.root });
            crate::outcome::Said::new(crate::outcome::Outcome::Challenge, "call.asks_a_person").then("unbrowse_challenge", page).put(reply);
        } else if reply["ok"].as_bool() == Some(true) && goal::answers_the_walk(&route, &asked, &reply["data"]) {
            reply["ok"] = json!(false);
            reply["error"] = json!("it answered what the route was learned on, not what this call asked: the value did not reach the site");
            crate::outcome::Said::new(crate::outcome::Outcome::CallFailed, "call.answers_the_walk").put(reply);
        }
    }
    called
}

/// Calls route `id`, or another contributor's entry by its id, at once: nothing waits for the owner. A network entry
/// whose body this node fetched before runs from that copy, with no new payment (R3.12); else its body is fetched and
/// its fee paid by the node, within the key's cap and the owner's per-fetch maximum (`call_entry`).
#[cfg(test)]
pub(crate) async fn do_call(node: &Arc<Node>, a: &Agent, id: String, inputs: HashMap<String, String>) -> Result<Value, Fail> {
    do_call_fields(node, a, id, inputs, Vec::new()).await
}

/// The same, handing back `fields` of the answer besides the route's defaults (`*` for the whole of it).
pub(crate) async fn do_call_fields(node: &Arc<Node>, a: &Agent, id: String, inputs: HashMap<String, String>, fields: Vec<String>) -> Result<Value, Fail> {
    do_call_as_seen(node, a, id, inputs, fields, None).await
}

/// The same, for a caller that chose the route by what it was when it looked (`seen_write`: whether it changed the
/// site then). A route is kept under its call's name, and a learn behind an answer may write another body under that
/// name (`learn::verify_learned`): a route seen as a read that changes the site by the time it is loaded to run is
/// not the route that was chosen, and is not sent. The check is made on the very record the call runs.
pub(crate) async fn do_call_as_seen(node: &Arc<Node>, a: &Agent, id: String, inputs: HashMap<String, String>, fields: Vec<String>, seen_write: Option<bool>) -> Result<Value, Fail> {
    if store::load_settings().paused {
        return Err((StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED.into()));
    }
    // The record loaded here is the one the vault is checked against and the call runs.
    let route = store::load_route(&id).or_else(|| is_network_entry(&id).then(|| share::cached(&id)).flatten());
    // An id the node handed out and then replaced (a second look found the better call) still does what it did:
    // the route that took its place answers, and the reply names it.
    let (route, now) = match route {
        None => match standing_for(&id, &inputs) {
            Some(r) => {
                let now = r.id.clone();
                (Some(r), Some(now))
            }
            None => (None, None),
        },
        some => (some, None),
    };
    if seen_write == Some(false) && route.as_ref().is_some_and(|r| r.write) {
        return Err((StatusCode::CONFLICT, "the route changed since it was chosen: it read then, and now it changes the site. Nothing was sent; ask again".into()));
    }
    if route.is_none() && !is_network_entry(&id) {
        return Err((StatusCode::NOT_FOUND, "no such route: search, or say what you want with unbrowse_do".into()));
    }
    let entry = entry_called(&id, route.as_ref());
    let asked: Vec<String> = inputs.values().cloned().collect();
    let called = match route {
        // A body this node keeps runs free.
        // An agent's call runs the route without what the owner's own session gave it (`Route::usable_by_an_agent`): the
        // agent supplies such a value itself, or the call is refused for want of it, and a route that still carries
        // such a value anywhere else is refused by name. What comes back, answer or error,
        // crosses `said_to_an_agent` too: a fixed part of an address the call still sends may hold the owner's value.
        Some(route) => {
            let sent: Vec<String> = inputs.values().cloned().collect();
            let theirs: Vec<&str> = sent.iter().map(String::as_str).collect();
            let said = |v: Value| super::said_to_an_agent_who_sent(&route, v, &theirs);
            // A route that still carries what the owner's session gave where the agent's value can't go is refused by
            // the place it sits (`Route::callable_by_an_agent`): the agent walks the page itself.
            let usable = route.callable_by_an_agent().map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, said(Value::String(e)).as_str().unwrap_or_default().to_string()))?;
            // A kept body of another identity's entry, while the owner has an open bounty for its site and no counting
            // line on the entry since it was posted, is paid for once, as a fetch, so the bounty can be confirmed
            // (`autobounty::line_due`, `coin.bounty-confirm`). Only a call the agent-safe path would run as it is.
            let due = bounty_line(node, a, entry, &route, &usable);
            let free = |inputs: HashMap<String, String>, fields: Vec<String>| async move {
                match run_route(node, a, usable, inputs, None, fields).await {
                    Ok(v) => Ok(said(v)),
                    Err((code, e)) => Err((code, said(Value::String(e)).as_str().unwrap_or_default().to_string())),
                }
            };
            let Some((e, bounty)) = due else { return named_now(finish(node, entry, free(inputs, fields).await), now.as_deref(), &id, &asked) };
            match call_entry(node, a, &format!("{e:#x}"), inputs.clone(), "", ForGoal::default(), fields.clone()).await {
                // A paid try that couldn't start (the fee over the owner's maximum or the key's cap, no node serving the
                // body, the chain unread) sent nothing: the call runs free, as it would have.
                Err((StatusCode::PAYMENT_REQUIRED | StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE, _)) => free(inputs, fields).await,
                paid => {
                    if paid.as_ref().is_ok_and(|r| !use_failed(r)) {
                        store::log_activity(&store::Activity {
                            at: store::now(),
                            who: a.name.clone(),
                            site: route.site.clone(),
                            what: format!("Paid for a call of entry {:.10}…, whose body this node keeps", format!("{e:#x}").trim_start_matches("0x")),
                            kind: "network".into(),
                            result: "passed".into(),
                            ms: None,
                            unb: None,
                            tx: None,
                            note: Some(format!("Paid so your bounty {bounty} for its site can be confirmed: confirming needs a paid call of yours on the entry since you posted it. Later calls run from the kept body, free")),
                        });
                        node.events.emit("activity", ());
                    }
                    paid
                }
            }
        }
        None => call_entry(node, a, &id, inputs, "", ForGoal::default(), fields).await,
    };
    named_now(finish(node, entry, called), now.as_deref(), &id, &asked)
}

/// A call's answer, once a use that ran and failed has demoted the entry in this node only (R5.4), as one a goal picked
/// does.
fn finish(node: &Node, entry: Option<alloy::primitives::FixedBytes<32>>, called: Result<Value, Fail>) -> Result<Value, Fail> {
    if let (Some(entry), Ok(answer)) = (entry, &called) {
        if use_failed(answer) {
            node.share.demote(entry);
        }
    }
    called
}

/// A call's answer under the route that took the place of the one asked for (`now`, `id` the one asked for), saying so.
/// An answer that lists nothing for the values asked (`asked`) says so (`outcome::answered_with`).
fn named_now(called: Result<Value, Fail>, now: Option<&str>, id: &str, asked: &[String]) -> Result<Value, Fail> {
    let called = called.map(|mut answer| {
        crate::outcome::answered_with(&mut answer, asked);
        answer
    });
    match (called, now) {
        (Ok(mut answer), Some(now)) => {
            if let Some(o) = answer.as_object_mut() {
                o.insert("route_id".into(), json!(now));
                o.insert("replaced".into(), json!(id));
            }
            Ok(answer)
        }
        (called, _) => called,
    }
}

/// The route that answers a call to retired route `id` with `inputs`: the one that took its place, where it only
/// reads and takes every value the caller sent. A route that writes is never called under another's id, and a
/// caller's value the newer route has no place for means the caller is asking for something it doesn't do.
pub(super) fn standing_for(id: &str, inputs: &HashMap<String, String>) -> Option<store::Route> {
    store::took_the_place_of(id).filter(|r| !store::route_writes(r) && inputs.keys().all(|k| r.inputs.iter().any(|i| &i.name == k)))
}

/// The entry a call of the kept `route` must pay for so the owner's bounty can be confirmed, and that bounty
/// (`autobounty::line_due`): only a body kept from another identity's entry (`entry`), run as it is kept (`usable`, the
/// agent-safe route, changes nothing), by a key paying from the owner's own deposit. Read from what the node keeps,
/// never the chain, so it never holds a call up.
fn bounty_line(node: &Node, a: &Agent, entry: Option<alloy::primitives::FixedBytes<32>>, route: &store::Route, usable: &store::Route) -> Option<(alloy::primitives::FixedBytes<32>, u64)> {
    let e = entry.filter(|_| route.fetched.is_some())?;
    if serde_json::to_value(route).ok()? != serde_json::to_value(usable).ok()? {
        return None;
    }
    let me = chain::owner_address(node.keys.as_ref()).ok()?;
    crate::autobounty::line_due(e, me, a.pays_from().unwrap_or(me)).map(|b| (e, b))
}

/// What a goal holds a call of another contributor's entry to: whether the goal only reads, so a route that writes
/// doesn't answer it (`reads_only`), and the most the task pays to fetch one listing (`budget`, R3.3), beside the owner's
/// per-fetch maximum. An agent's call that names an entry (`unbrowse_call`) is held to neither.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ForGoal {
    pub reads_only: bool,
    pub budget: Option<f64>,
}

/// Why a route made from another contributor's body can't answer this goal, so it isn't run: it writes and the goal
/// only reads (`reads_only`, #25), or it does another page than `page` (`fits`). The signed listing says neither, so
/// each is known only from the body (or from a body this node knows already).
pub(super) fn cannot_answer(route: &store::Route, reads_only: bool, page: &str) -> Option<String> {
    if reads_only && route.write {
        return Some("the entry's route writes, and the goal only reads".into());
    }
    (!page.is_empty() && !fits(route, page)).then(|| format!("the entry's route does another page ({}), not this one", listed_text(&route.root, 200)))
}

/// What a body fetched and not run makes ([`cannot_answer`]). Nothing ran, so the use didn't pass (R3.17): its line is
/// failed (R3.19), free to the payer (`decide.failed-fetch-always-free`), written and sent as every failed line is
/// (`bill`). A failed line is never claimed, by this node or by the server, so nothing is charged, no coin is bought for
/// the payer and nobody is checked. The body isn't kept (a kept body is never paid for again, R3.12, and this one wasn't
/// paid for): what its route does is remembered instead (`Share::note_unrun`), so the next goal it can't answer doesn't
/// fetch it again. The route didn't fail either: nothing is demoted, counted or reported as a failed use. The answer is a
/// refusal the goal steps past to its next entry (R3.19).
async fn refuse_unrun(node: &Arc<Node>, a: &Agent, u: &mut Use, route: &store::Route, why: &str) -> Fail {
    let entry = format!("{:#x}", u.entry);
    let billed = bill(node, a, u, false).await;
    sut_always!(
        billed.as_ref().is_ok_and(|(line, _)| !line.passed && line.entry == Some(u.entry)) || billed.is_err(),
        "a fetched body that wasn't run is never a passed line",
        &serde_json::json!({ "entry": entry })
    );
    sut_reachable!("a fetched body that couldn't answer its goal made a failed line and didn't run", &serde_json::json!({ "entry": entry }));
    node.share.note_unrun(u.entry, route);
    let note = match &billed {
        Ok((_, said)) => said.clone(),
        Err((_, e)) => Some(format!("Its failed line wasn't written ({e}).")),
    };
    store::log_activity(&store::Activity {
        at: store::now(),
        who: a.name.clone(),
        site: route.site.clone(),
        what: format!("Fetched another contributor's route (entry {:.10}…), which can't answer this goal, so it didn't run", entry.trim_start_matches("0x")),
        kind: "network".into(),
        result: "failed".into(),
        ms: None,
        unb: Some(0.0),
        tx: None,
        note: Some(format!("{why}: nothing was paid, and the body isn't kept{}", note.as_ref().map(|n| format!(". {n}")).unwrap_or_default())),
    });
    node.events.emit("activity", ());
    (StatusCode::CONFLICT, format!("{why}: nothing ran, and nothing was paid (its fetch is a failed line, free){}", note.map(|n| format!(". {n}")).unwrap_or_default()))
}

/// Whether a use that came back ran and failed: neither passed, nor possibly committed.
pub(super) fn use_failed(answer: &Value) -> bool {
    answer["ok"].as_bool() != Some(true) && answer["possible_commit"].as_bool() != Some(true)
}

/// The network entry a call to `id` uses: the one a kept copy was fetched from, or `id` itself when it names one. A
/// route this node learned has none.
fn entry_called(id: &str, route: Option<&store::Route>) -> Option<alloy::primitives::FixedBytes<32>> {
    match route {
        Some(r) => r.fetched.as_ref().and_then(|f| f.entry_id.parse().ok()),
        None => is_network_entry(id).then(|| id.parse().ok()).flatten(),
    }
}

/// The use of another contributor's entry this call pays for: its line names the node that served the body, in the
/// place the call reserved under the cap and the deposit before it fetched the body, and the body is kept only once
/// that line passed.
pub(super) struct Use {
    entry: alloy::primitives::FixedBytes<32>,
    contributor: alloy::primitives::Address,
    server: Option<alloy::primitives::Address>,
    /// The peer that served the body: its receipt goes there over the peer network when its node isn't on this machine.
    server_peer: Option<unbrowse_net::PeerId>,
    epoch: u64,
    held: Option<chain::Reserved>,
    body: Vec<u8>,
}

/// Writes the line of a use that was served, passed or failed, and sends it to the contributor's node to keep and
/// claim: a failed line pays nobody and costs the payer nothing, and goes so the server holds the stream's lines whole
/// (`network::contradicts`). A receipt that doesn't arrive is said in the note: this node's own claim pays it.
pub(super) async fn bill(node: &Arc<Node>, a: &Agent, u: &mut Use, passed: bool) -> Result<(chain::Receipt, Option<String>), Fail> {
    let held = u.held.take().ok_or((StatusCode::INTERNAL_SERVER_ERROR, "the use's line was written already".into()))?;
    let line = held.network_line(u.entry, u.server, passed).map_err(|m| (StatusCode::PAYMENT_REQUIRED, m))?;
    let mut note = None;
    // To the node that served the body, which keeps and claims it (R3.22); the contributor's own when none is named.
    let to = u.server.unwrap_or(u.contributor);
    let mut sent = network::send_receipt(&node.chain, node.keys.as_ref(), a.index, u.epoch, line.index, &format!("{to:#x}")).await;
    if sent.is_err() && to != u.contributor {
        sent = network::send_receipt(&node.chain, node.keys.as_ref(), a.index, u.epoch, line.index, &format!("{:#x}", u.contributor)).await;
    }
    // A node on another machine has no endpoint here: the line goes to the peer that served the body, over the peer
    // network, which keeps it to claim as its own (`watchtower::Watch`). A node too old to know the line for its own
    // holds it as a watchtower, which claims it before the window closes.
    if sent.is_err() {
        if let (Some(peer), Some(net)) = (u.server_peer, node.net.get()) {
            sent = network::hand_receipt(&node.chain, node.keys.as_ref(), net, peer, a.index, u.epoch, line.index).await;
        }
    }
    if let Err(e) = sent {
        note = Some(format!("The receipt didn't reach the contributor's node ({e}); this node's next claim pays it."));
    }
    Ok((line, note))
}

/// Calls another contributor's entry (R3.9–R3.12, R7.9): its body is fetched from a node that holds it, paid for with
/// a voucher within the agent key's cap, checked against the content identifier its signed listing names, kept, and
/// run here as a route of this node's, under this node's own session (`run_route`). The site never hears from the
/// node that served the body, and nothing the call sends or gets back passes through it. A try no node serves a body
/// for is a failed use of the entry: its line pays nothing and the entry is set aside (R7.11). `page` is the page the
/// agent named, whose query fills the route's inputs; `goal` is what the goal holds the call to ([`ForGoal`]).
pub(crate) async fn call_entry(node: &Arc<Node>, a: &Agent, entry_hex: &str, given: HashMap<String, String>, page: &str, goal: ForGoal, fields: Vec<String>) -> Result<Value, Fail> {
    let reads_only = goal.reads_only;
    let entry: alloy::primitives::FixedBytes<32> = entry_hex.parse().map_err(|_| (StatusCode::BAD_REQUEST, "bad entry id".into()))?;
    // A body whose route this node knows answers no goal it can't (`cannot_answer`), said before the chain is read or
    // anything is fetched or paid: a kept body (never paid for again, R3.12), or one fetched before for a goal it
    // couldn't answer and not kept (`Share::unrun`). A route learned on another page holds that page's item, and one
    // that writes answers no read.
    let known = share::cached(entry_hex).map(|r| (r, "its body is kept here, for a goal it answers")).or_else(|| node.share.unrun(entry).map(|r| (r, "its body was fetched before, and isn't kept")));
    if let Some((r, had)) = known {
        if let Some(why) = cannot_answer(&r, reads_only, page) {
            return Err((StatusCode::CONFLICT, format!("{why}: nothing ran, and nothing was fetched or paid ({had})")));
        }
    }
    // The chain holds the entry once a claim has shown a listing of its body (R2.18); until then it holds nothing, and
    // the signed listing alone says whose it is (`share::listing_of`, below). A credited entry must be live.
    if let Some((_, ev)) = chain::entry_by_hash(&node.chain, entry).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))? {
        if !ev.live {
            return Err((StatusCode::NOT_FOUND, "entry has been delisted".into()));
        }
    }
    // One no claim has put on the chain is withdrawn by its contributor's signature (R2.16, `share::on_change`).
    if node.share.withdrawn(entry) {
        return Err((StatusCode::NOT_FOUND, "entry has been delisted: its contributor signed its withdrawal".into()));
    }
    // A body kept from this fetch runs from the copy for a while on this answer (`share::still_listed`).
    node.share.saw_live(entry, std::time::Instant::now());
    let epoch = chain::current_epoch(&node.chain).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    if let Some(back) = node.share.off_until(entry, epoch) {
        return Err((StatusCode::SERVICE_UNAVAILABLE, format!("no node served this entry's body lately, so it is off the ranking until epoch {back}: use another route for the site, or learn one with unbrowse_do")));
    }
    let listed = share::listing_of(node, entry).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let contributor = listed.contributor;
    // A body this node already found goes where a route it didn't learn itself may not is never paid for again.
    if let Some(why) = node.share.refused(&listed.proven.listing.content_id).or_else(|| node.share.resting(&listed.proven.listing.content_id)) {
        return Err((StatusCode::FORBIDDEN, format!("this entry's body is set aside, so nothing was paid and nothing reached the site: {why}")));
    }
    // The last word before paying: the fee as the chain has it now, the one the voucher would be signed for, is never
    // paid past the owner's per-fetch maximum (R3.3).
    if let Some(why) = over_max(listed.fee, store::load_settings().max_fetch()) {
        return Err((StatusCode::PAYMENT_REQUIRED, format!("this node won't fetch that route: {why}. Use another route for the site, or learn one from its page with unbrowse_do; the owner can raise the maximum (Settings, or unbrowse-node max-fetch <usdc>)")));
    }
    // Nor past the task's own budget for one fetch (R3.3), the agent's word, which only lowers the owner's maximum.
    if let Some(why) = over_budget(listed.fee, goal.budget) {
        return Err((StatusCode::CONFLICT, format!("this node won't fetch that route for this task: {why}. Use another route for the site, or give the task a larger budget, up to the owner's maximum")));
    }
    // The site's own policy (R4.17): a delisted site's routes aren't called, nor an entry under its floor.
    let _ = crate::sitepolicy::refresh(&node.chain, &listed.proven.listing.site).await;
    if let Some(why) = crate::sitepolicy::refuses(&listed.proven.listing.site, listed.fee) {
        return Err((StatusCode::FORBIDDEN, format!("this node won't fetch that route: {why}. Use another route for the site, or learn one from its page with unbrowse_do")));
    }

    // The fee goes on the agent's running voucher, within the key's cap and the deposit, only if the use passes. Its
    // place is taken now, before the body is fetched or the site hears anything: a call the cap or the deposit can't
    // cover is refused here, and calls running at once can't both take the last room.
    let (spent, cap) = chain::agent_spend(&node.chain, node.keys.as_ref(), a.index, epoch)
        .await
        .map_err(|_| (StatusCode::PAYMENT_REQUIRED, "this agent can't pay for routes yet: the node is still setting up its payments, or needs funds (the owner adds them in the Unbrowse app, under Money)".into()))?;
    if cap <= 0.0 {
        return Err((StatusCode::PAYMENT_REQUIRED, "this agent has no daily limit set, so it pays for nothing: the owner sets one in the Unbrowse app, under Money".into()));
    }
    // The deposit the key draws on: the owner's wallet's once it granted the key (spec §76.1), else the node's own.
    let me = chain::payer_of(node.keys.as_ref(), a.index, epoch).map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    // A key its payer revoked, or whose grant ran out, keeps its epoch's cap, so the checks here pass it, and every
    // provider then refuses it (`network::verify_body_voucher`). That says nothing about the entry: left to the fetch,
    // it would set an innocent entry off the ranking for up to 32 epochs, across restarts, and write a failed line
    // naming it. The chain says so now, as a provider would, before any entry is tried.
    let key = chain::agent_signer(node.keys.as_ref(), a.index).map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?.address();
    chain::check_agent(&node.chain, me, key).await.map_err(|e| (StatusCode::PAYMENT_REQUIRED, format!("this agent can't pay for routes: {e}. Nothing was paid and no node was asked; the owner renews or grants the key in the Unbrowse app, under Money")))?;
    let deposit = chain::spendable_usdc(&node.chain, me).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let held = chain::reserve(a.index, epoch, listed.fee, spent, cap, deposit).map_err(|m| (StatusCode::PAYMENT_REQUIRED, m))?;
    // The deposit above was this payer's. Its place is seen by a change of payer from here on (`chain::moving_payer`), so
    // one made before it is seen now, and the call stands on the payer its line will name or doesn't go.
    if chain::payer_of(node.keys.as_ref(), a.index, epoch).ok() != Some(me) {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "this agent's key moved to another payer as the call began: nothing was paid and nothing reached the site, so call again".into()));
    }

    let got = match share::fetch(node, a.index, &listed).await {
        Ok(g) => g,
        // The listed body was served and goes where a route this node didn't learn itself may not: the call is never
        // made, so it makes no line, and the body is set aside (R2.28). The place under the cap is given back.
        Err(share::NoBody { why, refused: true, .. }) => {
            store::log_activity(&store::Activity {
                at: store::now(),
                who: a.name.clone(),
                site: listed.proven.listing.site.clone(),
                what: format!("Set aside the body of entry {:.10}…", entry_hex.trim_start_matches("0x")),
                kind: "network".into(),
                result: "refused".into(),
                ms: None,
                unb: Some(0.0),
                tx: None,
                note: Some(why.clone()),
            });
            node.events.emit("activity", ());
            return Err((StatusCode::FORBIDDEN, format!("this route's body is another contributor's and goes where the node never runs one, so nothing was paid and nothing reached the site: {why}")));
        }
        Err(share::NoBody { why, dark, .. }) => {
            // An entry none of whose providers serves its body is set aside (R7.11, R7.20); the caller's own failure
            // isn't the entry's and doesn't.
            if dark {
                share::tried(node, entry, epoch, false);
                // A failed fetch of the entry, counted off the chain; no route ran, so there is no shape to report.
                crate::telemetry::failed_use(true, None, "no_body");
            }
            let line = held.network_line(entry, None, false);
            store::log_activity(&store::Activity {
                at: store::now(),
                who: a.name.clone(),
                site: listed.proven.listing.site.clone(),
                what: format!("No node served the body of entry {:.10}…", entry_hex.trim_start_matches("0x")),
                kind: "network".into(),
                result: "failed".into(),
                ms: None,
                unb: Some(0.0),
                tx: None,
                note: Some(match line {
                    Ok(_) => why.clone(),
                    Err(e) => format!("{why}; the failed line wasn't written: {e}"),
                }),
            });
            node.events.emit("activity", ());
            return Err((StatusCode::BAD_GATEWAY, format!("no node served this route's body, so nothing reached the site ({why})")));
        }
    };
    share::tried(node, entry, epoch, true);
    let inputs = inputs_for(&got.route, page, given);
    let mut paying = Use { entry, contributor, server: got.server, server_peer: got.server_peer, epoch, held: Some(held), body: got.body };
    // A route that can't answer this goal isn't run, and its fetch is a failed line, free (`refuse_unrun`).
    if let Some(why) = cannot_answer(&got.route, reads_only, page) {
        return Err(refuse_unrun(node, a, &mut paying, &got.route, &why).await);
    }
    // The paid network write gate: a route that writes runs paid only for a goal that asks for a change.
    sut_always_or_unreachable!(
        !(reads_only && got.route.write),
        "a network route that writes never runs for a goal that only reads",
        &serde_json::json!({ "entry": entry_hex, "write": got.route.write, "reads_only": reads_only })
    );
    sut_sometimes!(got.route.write, "a network route that writes was fetched and run for a goal that asks for a change", &serde_json::json!({ "entry": entry_hex }));
    run_route(node, a, got.route, inputs, Some(paying), fields).await
}

/// Runs a route on this node, under the owner's session and the checks every call gets: the owner's exclusions, the
/// egress rule, the vault's binding of each login to its own site, and, for a route made from another contributor's
/// body, `share::bound` and the rule someone else's route runs under (`share::egress`: HTTPS and the public internet
/// only, on every request). A route this node learned itself is free to the node's own agents, listed or not: no
/// voucher, no line, nothing held under the cap (R3.12, R3.34). Only a body fetched from another node is paid, once,
/// on the fetch: `paying` is that use, whose body was just fetched for this call. Its line, passed or failed, names the
/// node that served it, and a passed one goes to the contributor. A fetched route run again from the cache pays
/// nothing; one that fails is let go, so the next call fetches the entry afresh. A call the rule refused was never
/// made: it makes no line, and its body is set aside.
pub(super) async fn run_route(node: &Arc<Node>, a: &Agent, route: store::Route, inputs: HashMap<String, String>, paying: Option<Use>, fields: Vec<String>) -> Result<Value, Fail> {
    let id = route.id.clone();
    let (inputs, mut ignored) = bind_inputs(&route, inputs);
    // A value that never reaches the answer is said the same way: the call would answer what the walk asked.
    ignored.extend(unreached(&route, &inputs));
    ignored.sort();
    ignored.dedup();
    // A body run from the copy this node keeps runs only while its contributor still lists it; one just fetched was
    // checked live on the way in.
    if paying.is_none() {
        share::still_listed(node, &route).await.map_err(not_run)?;
        // Delisting reaches kept copies: a kept route that writes runs only on the chain's fresh word that its entry
        // is live, and a read one within `LIVE_FOR` of it (or while the chain can't be read).
        sut_always_or_unreachable!(
            route.fetched.as_ref().and_then(|f| f.entry_id.parse().ok()).is_none_or(|e| !route.write || node.share.live_lately(e, std::time::Instant::now())),
            "a kept route that writes runs only on a fresh answer that its entry is live",
            &serde_json::json!({ "route": route.id, "write": route.write })
        );
    }
    // A body kept before a rule was added, or set aside since, runs on no path: nothing is sent, and the copy goes.
    if paying.is_none() {
        if let Err(why) = share::may_run_kept(node, &route) {
            share::drop_cached(node, &route).await;
            return Err((StatusCode::FORBIDDEN, format!("this route is another contributor's and no longer passes the checks a fetched body passes, so nothing reached the site: {why}. Use another route for the site, or learn one with unbrowse_do")));
        }
    }
    let notes = input_notes(&route, &inputs);
    let mut paying = paying;
    // A host the check refuses is never sent anything, so the try makes no line (R2.28).
    share::bound(&route).map_err(|e| (StatusCode::FORBIDDEN, e))?;
    // A host the owner excluded is never sent anything, its robots.txt included: refused here as the call itself
    // refuses it (`run::call_with`), before the site's rules below are read.
    if let Some(host) = store::excluded_host(&route, &store::load_settings().excluded) {
        return Err((StatusCode::FORBIDDEN, format!("{host} is excluded in Settings: the node doesn't call it or walk it")));
    }
    // Read only once every check above passed, so a route nothing has judged yet sends nothing anywhere. A route whose
    // site opted out for Unbrowse (R4.32) is out of this node's live set: it isn't called, and it didn't fail. Nothing
    // is paid and no line written (the place a fetch took is given back as `paying` goes), nothing is demoted, counted
    // or reported. A body fetched for this call rests, so a goal doesn't fetch it again at once.
    if let Some(why) = crate::optout::refuses_async(&route).await {
        if let (Some(_), Some(f)) = (&paying, &route.fetched) {
            node.share.rest(&f.content_id, &why);
        }
        store::log_activity(&store::Activity {
            at: store::now(),
            who: a.name.clone(),
            site: route.site.clone(),
            what: format!("Didn't call {}: the site opted out of Unbrowse", route.what),
            kind: "call".into(),
            result: "refused".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some(why.clone()),
        });
        node.events.emit("activity", ());
        return Err((StatusCode::FORBIDDEN, why));
    }
    // A route reads on over a secret never: its next page is worked out from the value sent, so a count over a code,
    // a PIN or a card number the vault fills would hand back the secret plus one. Refused before the vault is opened
    // or the owner is asked, with nothing sent.
    pages_over_no_secret(&route, &inputs)?;
    let keys = node.key().map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    let keep = crate::vault_keep(Ok(keys as &dyn unbrowse_core::KeyStore)).map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    let cards = vault::cards_in(&route, &inputs);
    if !cards.is_empty() {
        vault::check_cards(&route, &inputs, store::load_settings().keep_card_codes).map_err(|e| (StatusCode::FORBIDDEN, e))?;
        // A card route always waits for the owner: the generic route graph does not bind a charge amount and currency
        // to the outgoing request, and no approval carries over to the next call.
        approve_route_payment(node, a, &route, &inputs, &cards).await?;
    }
    // The vault's passwords for the route's site, so an answer that shows one says its name (`run::call_with`).
    crate::browse::know_vault(&unbrowse_learn::identity::site_of(&route.site), keys).map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    let inputs = vault::fill_inputs(&keep, keys, &route, &inputs, !cards.is_empty(), store::load_settings().keep_card_codes)
        .map_err(|e| (StatusCode::FORBIDDEN, e))?;
    let who = a.name.clone();
    let started = run::CallEvent::start(&route, &a.name, Some(a.index));
    node.events.tell("call", &started);
    let frames = heal_frames(node, &id);
    let run = route.clone();
    let opener = node.clone();
    // A call that heals by walking its page again ends that walk on its ask's stop flag.
    let stop = super::mcp::ask_stop();
    // An ask that said `browser: never` holds every call it makes to that, on the thread the call runs on.
    let shut = browser_shut();
    let r = tokio::task::spawn_blocking(move || unbrowse_learn::mint::stops_with(stop, || run::with_the_browser_shut(shut, || run::call_watched(run, &inputs, &who, Some(frames), &fields, Some(opener)))))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
        .and_then(|r| r.map_err(|e| (StatusCode::BAD_REQUEST, e)));
    let r = match r {
        Ok(r) => r,
        Err(e) => {
            node.events.tell("call", &started.failed());
            return Err(e);
        }
    };
    // A request the rule refused was never sent, so the call was never made: no line, passed or failed, and the body
    // is set aside so the entry is skipped (R2.28). The place the fetch took under the cap is given back.
    if let (Some(why), Some(f)) = (&r.refused, &route.fetched) {
        // Refused for where this network sent it, the kept copy stays, paid for and sound.
        if !share::refused_for_what_it_says(&route) {
            node.share.rest(&f.content_id, why);
            node.events.tell("call", &started.end(&r, None));
            return Err((StatusCode::FORBIDDEN, format!("this route is another contributor's, and the call wasn't made: {why}. This network sent it somewhere the node won't send one, so it rests a while: use another route for the site, or learn one with unbrowse_do")));
        }
        node.share.set_aside(&f.content_id, why);
        if paying.is_none() {
            share::drop_cached(node, &route).await;
        }
        node.events.tell("call", &started.end(&r, None));
        return Err((StatusCode::FORBIDDEN, format!("this route is another contributor's, and the call wasn't made: {why}. It is set aside: use another route for the site, or learn one with unbrowse_do")));
    }
    // A use that ran and failed, as `use_failed` judges its answer, is counted and reported off the chain
    // (`decide.failures-reported-off-chain`), each channel as its own switch allows.
    if !r.ok && !r.possible_commit {
        crate::report::failed_use(&route, paying.is_some(), r.ms, r.variant.as_deref());
        // A failed line never reaches the chain, so the payer's own report is what takes its stake out of the
        // route's rank (`rank.counted-stake`). Sent in the background: the call's answer never waits on it.
        if let Some(f) = &route.fetched {
            report_failed_stake(node, a, &f.entry_id);
        }
    }
    let mut paid = None;
    let mut note = None;
    let mut unbilled = None;
    if let Some(u) = paying.as_mut() {
        // The caller judged the call itself, from what it received: the line passes only on that. Only then is the
        // body kept: it is one its use paid for. A body whose use failed was never kept, so the next call fetches it
        // afresh.
        // The call has run by now, so what it did stands whatever becomes of its line: answered as a failed payment, the
        // goal would go on to the next entry and a write that landed here would run there too. A line that couldn't be
        // written bills nothing, keeps nothing, and is said.
        match bill(node, a, u, r.ok).await {
            Ok((line, said)) => {
                // A failed line carries its fee in the voucher but is never charged: the call says it paid nothing.
                paid = Some(if line.passed { line.amount } else { 0.0 });
                note = said;
                if r.ok {
                    sut_always!(
                        line.passed && line.entry == Some(u.entry),
                        "a fetched body is kept only with a passed line written for its use",
                        &serde_json::json!({ "entry": format!("{:#x}", u.entry), "passed": line.passed, "index": line.index })
                    );
                    if let Err(e) = share::keep(node, &route, &u.body).await {
                        note = Some(format!("The body wasn't kept ({e}); the next call fetches it again."));
                    }
                }
            }
            Err((_, why)) => {
                paid = Some(0.0);
                unbilled = Some(format!("the call ran, and its line couldn't be written ({why}): nothing was billed for it, and its body wasn't kept"));
                note = unbilled.clone();
            }
        }
    } else if route.fetched.is_some() && !r.ok {
        share::drop_cached(node, &route).await;
    }
    if let (Some(u), Some(f)) = (&paying, &route.fetched) {
        store::log_activity(&store::Activity {
            at: store::now(),
            who: a.name.clone(),
            site: route.site.clone(),
            what: format!("Used another contributor's route (entry {:.10}…), its body served by {}", f.entry_id.trim_start_matches("0x"), u.server.map(|s| format!("{s:#x}")).unwrap_or_else(|| "a node".into())),
            kind: "network".into(),
            result: if r.ok { "passed" } else { "failed" }.into(),
            ms: Some(r.ms),
            unb: paid,
            tx: None,
            note,
        });
    }
    node.events.tell("call", &started.end(&r, paid));
    node.events.emit("activity", ());
    let mut out = json!({ "ok": r.ok, "ms": r.ms, "data": r.data, "error": r.error, "paid_usdc": paid, "paid_unb": paid, "possible_commit": r.possible_commit, "retry": r.retry, "truncated": r.truncated, "fields": r.fields, "browser": r.browser });
    if let Some(more) = &r.more {
        out["more"] = json!(more);
    }
    // Where the route's records were seen, how many this answer holds there, read on the answer whole
    // (`run::records_where_seen`): null for an answer without that place. A caller judging the answer reads this,
    // never the place in `data`, which holds only the fields the reply chose and may be cut.
    if let Some(n) = r.records {
        out["records"] = json!(n);
    }
    if let Some(why) = unbilled {
        out["payment_note"] = json!(why);
    }
    if !ignored.is_empty() {
        out["ignored_inputs"] = json!(ignored);
        out["inputs"] = json!(route.inputs.iter().map(|i| i.name.clone()).collect::<Vec<_>>());
    }
    let sends = also_sends(&route);
    if !sends.is_empty() {
        out["also_sends"] = json!(sends);
    }
    // What the call fell back on, and why, beside the notes on its inputs: an answer that came through the browser, a
    // skipped sandbox or a second walk is right and slow, and nothing else in the reply says which.
    let notes: Vec<String> = notes.into_iter().chain(r.fell_back.iter().cloned()).collect();
    if !notes.is_empty() {
        out["notes"] = json!(notes);
    }
    // The sandbox ran none of the page's code: the reply names its reader, the fact and the next steps, typed; a call
    // that failed for it says it as its outcome's cause.
    if let Some(u) = &r.unheld {
        out["held_back"] = crate::outcome::held_back(u);
        if !r.ok {
            crate::outcome::unheld_said(u).put(&mut out);
        }
    }
    if let Some(f) = &route.fetched {
        out["network"] = json!({
            "entry_id": f.entry_id,
            "content_id": f.content_id,
            "contributor": paying.as_ref().map(|u| format!("{:#x}", u.contributor)),
            "served_by": paying.as_ref().and_then(|u| u.server).map(|s| format!("{s:#x}")),
            "cached": paying.is_none(),
            "listed_as": listed_text(&f.listed_as, 300),
            "ran_on": "this node, under its own session: the node that served the body never sees the call",
        });
    }
    Ok(out)
}

/// After a failed call on another contributor's route, clears its payer's latest-passed flag on the entry when the
/// payer holds counted stake there (`chain::coins::report_failed`), at most once an epoch for each entry and payer. Only
/// a payer whose key this node holds can report: a call paid from the owner's linked wallet (spec §76.1) is said and
/// left, since that wallet's key isn't here. A report that couldn't be sent isn't tried again that epoch.
fn report_failed_stake(node: &Arc<Node>, a: &Agent, entry_id: &str) {
    let Ok(entry) = entry_id.parse::<alloy::primitives::B256>() else { return };
    let (node, index) = (node.clone(), a.index);
    tokio::spawn(async move {
        let Ok(epoch) = chain::current_epoch(&node.chain).await else { return };
        let (Ok(payer), Ok(me)) = (chain::payer_of(node.keys.as_ref(), index, epoch), chain::owner_address(node.keys.as_ref())) else { return };
        if !chain::coins::first_report(entry, payer, epoch) {
            return;
        }
        if payer != me {
            eprintln!("coins: a call on entry {entry:#x} failed; its payer {payer:#x} is the owner's wallet, whose key this node doesn't hold, so its stake there still counts until that wallet reports it");
            return;
        }
        match chain::coins::report_failed(&node.chain, node.keys.as_ref(), entry).await {
            Ok(Some(_)) => node.events.emit("activity", ()),
            Ok(None) => {}
            Err(e) => eprintln!("coins: reporting a failed call on entry {entry:#x}: {e}"),
        }
    });
}

/// What the caller should know of how its values went out. A value with a space in a piece of the address reaches the
/// site as `%20`, and a site that writes such pieces its own way (`gluten-free`) finds nothing, with nothing to say why.
pub(super) fn input_notes(route: &store::Route, given: &HashMap<String, String>) -> Vec<String> {
    use unbrowse_learn::{slots::Loc, Class};
    let in_path = |name: &str| route.graph.steps.iter().flat_map(|s| &s.fields).find_map(|f| match (&f.loc, &f.class) {
        (Loc::Path(_), Class::Input { name: n, default, .. }) if n == name => Some(default.clone()),
        _ => None,
    });
    let mut notes = Vec::new();
    for name in given.iter().filter(|(_, v)| v.contains(char::is_whitespace)).map(|(k, _)| k) {
        let Some(walked) = in_path(name) else { continue };
        let form = walked.filter(|w| w.contains(['-', '_', '+'])).map(|w| format!(": this site wrote it as `{w}`, so write the words the same way")).unwrap_or_default();
        notes.push(format!("{name} goes into the address as a piece of its path, and a site may find nothing for a space there{form}"));
    }
    notes.sort();
    notes
}

/// What an agent hears when a route made from another contributor's body didn't run from the kept copy: a delisted
/// one is gone (the goal goes on to other routes and the page), one whose check couldn't be made is for later.
pub(crate) fn not_run(n: share::NotRun) -> Fail {
    let status = match n {
        share::NotRun::Delisted => StatusCode::GONE,
        share::NotRun::Unchecked(_) => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, n.why())
}

/// Where a call's heal (the site's page walked again, if the site has drifted) shows its pictures: walk `heal-…`.
pub fn heal_frames(node: &Arc<Node>, route: &str) -> unbrowse_learn::screencast::FrameSink {
    let events = node.events.clone();
    let walk = format!("heal-{}-{}", route.chars().take(8).collect::<String>(), store::now());
    node.walks.1.follow(&walk, move |note| events.emit("frame", note))
}

/// Refuses a call of a route that reads on to its next page with a secret: an input the route says is one, or one
/// this call fills from the vault (a value naming a login, a code or a card), or whose default does. The next page is
/// worked out from the value sent (`Paging::next`), so a count over it hands the secret back plus one.
fn pages_over_no_secret(route: &store::Route, inputs: &HashMap<String, String>) -> Result<(), Fail> {
    let Some(p) = &route.paging else { return Ok(()) };
    let input = p.input();
    let filled = inputs.get(input).or_else(|| route.inputs.iter().find(|i| i.name == input).and_then(|i| i.default.as_ref())).is_some_and(|v| vault::is_ref(v));
    if p.over_secret(&route.graph) || filled {
        return Err((StatusCode::FORBIDDEN, format!("this route reads on to its next page with {input}, a secret the vault fills: the next page would say it, so the call wasn't made and nothing reached the site. Give {input} a plain value, or use a route that reads on with a page number or a token the site hands over")));
    }
    Ok(())
}

/// A route's generic graph does not bind a charge amount and currency to the request it will send. Therefore every card
/// route call asks the owner; a separate caller-supplied amount can never authorize it through a limit.
async fn approve_route_payment(node: &Arc<Node>, a: &Agent, route: &store::Route, inputs: &HashMap<String, String>, cards: &[vault::CardRef]) -> Result<(), Fail> {
    let shown = cards.iter().map(|c| c.shown()).collect::<Result<Vec<_>, _>>().map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let mut sent: Vec<String> = route
        .inputs
        .iter()
        .filter(|i| !i.secret)
        .filter_map(|i| inputs.get(&i.name).or(i.default.as_ref()).map(|v| format!("{}: {}", i.name, listed_text(v, 80))))
        .collect();
    sent.sort();
    let pay = crate::hands::Pay { card: shown.join(", "), merchant: route.site.clone(), route: Some(listed_text(&route.what, 160)), inputs: sent, over: Some("the route graph does not bind a charge amount and currency to the request sent".into()), amount: None };
    super::browse::ask_to_pay(node, a, &route.site, None, pay).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Audit 1118 H4 (16 Nov H8): a call whose route reads on with a secret is refused before the vault is opened: an
    /// input the route marks secret, or one the caller names a vault login, code or card for. A plain page number still
    /// pages.
    #[test]
    fn a_call_never_reads_on_over_a_secret() {
        let route = |secret: bool| {
            let mut r = store::Route::from_graph("r".into(), "codes".into(), "https://bank.example/".into(), serde_json::from_value(serde_json::json!({
                "provisional": false,
                "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://bank.example/api/codes", "needs_browser": false, "sets_cookie": false, "fields": [
                    { "loc": { "in": "query", "key": "pin" }, "class": "input", "name": "pin", "secret": secret },
                ] }],
            })).unwrap()).unwrap();
            r.paging = Some(unbrowse_learn::paging::Paging::Count { input: "pin".into(), step: 1 });
            r
        };
        let given = |v: &str| HashMap::from([("pin".to_string(), v.to_string())]);
        let e = pages_over_no_secret(&route(true), &HashMap::new()).unwrap_err();
        assert_eq!(e.0, StatusCode::FORBIDDEN);
        assert!(e.1.contains("next page") && e.1.contains("nothing reached the site"), "{}", e.1);
        assert!(pages_over_no_secret(&route(false), &given("vault:code:bank.example:me")).is_err(), "a vault code in a plain input");
        assert!(pages_over_no_secret(&route(false), &given("vault:bank.example:me")).is_err(), "a vault login");
        pages_over_no_secret(&route(false), &given("3")).unwrap();
        let mut unpaged = route(true);
        unpaged.paging = None;
        pages_over_no_secret(&unpaged, &HashMap::new()).unwrap();
    }

    /// A site that opts out for Unbrowse in its own /robots.txt is never called (R4.32): the call is refused before
    /// anything reaches the site, no line is written, the place the fetch took is given back, and nothing counts it a
    /// failure (no demotion, no `route_failed`/`fetch_failed`, no report). The robots file is a real one, served by the
    /// test site; its other paths stay callable.
    #[test]
    fn a_site_that_opts_out_is_not_called_and_nothing_is_paid() {
        use std::io::{BufRead, Write};
        let home = store::scratch_home("opted-out-call");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = site.local_addr().unwrap().port();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let heard = seen.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                heard.locked().push(first.trim().to_string());
                let body = if first.contains("/robots.txt") { "User-agent: *\nDisallow: /\n\nUser-agent: Unbrowse\nDisallow: /private\nAllow: /private/open" } else { r#"{"items":[1]}"# };
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        crate::optout::READ_IN_TESTS.locked().push(format!("http://127.0.0.1:{port}"));
        let route = |id: &str, path: &str| -> store::Route {
            let r: store::Route = serde_json::from_value(json!({
                "id": id, "site": "127.0.0.1", "what": "list the lamps", "method": "GET", "path": path,
                "root": format!("http://127.0.0.1:{port}/"), "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
                "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}{path}"), "needs_browser": false, "fields": [] }] }
            }))
            .unwrap();
            store::save_route(&r).unwrap();
            r
        };
        let node = crate::testchain::node("opted-out");
        let (agent, _) = crate::agents::create(node.keys.as_ref(), "agent", 100.0, 30, 0).unwrap();
        let entry = alloy::primitives::FixedBytes::repeat_byte(0x0e);
        // Places under the cap are the process's: an epoch no other test reserves in.
        const OWN_EPOCH: u64 = 913_713;
        let held = chain::reserve(agent.index, OWN_EPOCH, 1.0, 0.0, 1.0, 100.0).unwrap();
        let paying = Use { entry, contributor: Default::default(), server: None, server_peer: None, epoch: OWN_EPOCH, held: Some(held), body: Vec::new() };
        let (status, why) = rt.block_on(run_route(&node, &agent, route("opted-out-paid", "/private/items"), HashMap::new(), Some(paying), Vec::new())).expect_err("refused");
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(why.contains("127.0.0.1's robots rules ask Unbrowse not to call /private/items"), "{why}");
        assert_eq!(seen.locked().as_slice(), ["GET /robots.txt HTTP/1.1"], "only the robots file was read");
        assert!(chain::receipts(agent.index, OWN_EPOCH).unwrap().is_empty(), "no line");
        chain::reserve(agent.index, OWN_EPOCH, 1.0, 0.0, 1.0, 100.0).expect("the whole cap is free again: the place was given back");
        assert!(!node.share.demoted(entry), "not a failure of the entry");
        assert!(crate::report::FAILED_USES.locked().iter().all(|(r, ..)| r != "opted-out-paid"), "not counted or reported");
        // The rest of the site, the `*` group's disallow included, is called; the Allow inside the named group too.
        for (id, path) in [("opted-out-open", "/private/open/items"), ("opted-out-other", "/items")] {
            let r = rt.block_on(run_route(&node, &agent, route(id, path), HashMap::new(), None, Vec::new())).expect("called");
            assert_eq!(r["ok"], true, "{id}: {r}");
        }
        assert_eq!(seen.locked().iter().filter(|l| l.contains("robots")).count(), 1, "the file was read once");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A route that names a host the owner excluded is refused before any robots.txt is read, someone else's included:
    /// nothing at all goes to the excluded host, nor to the route's other hosts.
    #[test]
    fn a_route_naming_an_excluded_host_reads_no_robots_file() {
        let home = store::scratch_home("opted-out-excluded");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        store::save_settings(&store::Settings { excluded: vec!["shut.excluded-call.example".into()], ..store::load_settings() }).unwrap();
        let graph: unbrowse_learn::Graph = serde_json::from_value(json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://open.excluded-call.example/page", "needs_browser": false, "fields": [] },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://shut.excluded-call.example/api", "needs_browser": false, "fields": [] }
        ] }))
        .unwrap();
        let route = store::Route::from_graph("excluded-call".into(), "list".into(), "https://open.excluded-call.example/page".into(), graph).unwrap();
        let node = crate::testchain::node("excluded-call");
        let (agent, _) = crate::agents::create(node.keys.as_ref(), "agent", 100.0, 30, 0).unwrap();
        let (status, why) = rt.block_on(run_route(&node, &agent, route, HashMap::new(), None, Vec::new())).expect_err("excluded");
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(why.contains("excluded in Settings"), "{why}");
        assert!(!crate::optout::ASKED.locked().iter().any(|(o, _)| o.contains("excluded-call")), "no robots.txt read");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Every agent's route use goes through `run_route`, and one that ran and failed is counted off the chain there
    /// (`decide.failures-reported-off-chain`), whatever the tool's own reply then says (a goal that goes on to the next
    /// entry or the browser answers its tool call as done): a route this node keeps as `route_failed`, a paid fetch as
    /// `fetch_failed`, each with its failure's class. One the site answered is not counted.
    #[test]
    fn a_failed_route_use_is_counted_on_both_paths() {
        use std::io::{BufRead, Write};
        let home = store::scratch_home("failed-use-counted");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = site.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let (status, body) = if first.contains("/fine") { ("200 OK", r#"{"items":[1,2]}"#) } else { ("500 Internal Server Error", r#"{"error":"DUMMY-SITE-WORDS"}"#) };
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let route = |id: &str, path: &str| -> store::Route {
            let r: store::Route = serde_json::from_value(json!({
                "id": id, "site": "127.0.0.1", "what": "list the lamps", "method": "GET", "path": path,
                "root": format!("http://127.0.0.1:{port}/"), "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
                "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}{path}"), "needs_browser": false, "fields": [] }] }
            }))
            .unwrap();
            store::save_route(&r).unwrap();
            r
        };
        let node = crate::testchain::node("failed-use");
        let (agent, _) = crate::agents::create(node.keys.as_ref(), "agent", 100.0, 30, 0).unwrap();
        let counted = |id: &str| crate::report::FAILED_USES.locked().iter().filter(|(r, ..)| r == id).map(|(_, e, c, rep)| (*e, *c, *rep)).collect::<Vec<_>>();

        let kept = route("failed-use-kept", "/broken");
        let r = rt.block_on(run_route(&node, &agent, kept, HashMap::new(), None, Vec::new())).expect("the call ran");
        assert!(use_failed(&r), "{r}");
        assert_eq!(counted("failed-use-kept"), [("route_failed", "step_status", false)], "a route of the node's own: counted, and reported only after a walk");

        let held = chain::reserve(agent.index, 7, 0.01, 0.0, 100.0, 100.0).unwrap();
        let paying = Use { entry: Default::default(), contributor: Default::default(), server: None, server_peer: None, epoch: 7, held: Some(held), body: Vec::new() };
        let fetched = route("failed-use-paid", "/broken");
        let r = rt.block_on(run_route(&node, &agent, fetched, HashMap::new(), Some(paying), Vec::new())).expect("the call ran");
        assert!(use_failed(&r), "{r}");
        assert_eq!(counted("failed-use-paid"), [("fetch_failed", "step_status", false)]);

        let fine = route("failed-use-fine", "/fine");
        let r = rt.block_on(run_route(&node, &agent, fine, HashMap::new(), None, Vec::new())).expect("the call ran");
        assert_eq!(r["ok"], true, "{r}");
        assert!(counted("failed-use-fine").is_empty(), "a passed use isn't counted");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A read goal that meets a route that writes, fetched from another node, pays nothing, buys nothing and checks
    /// nobody (R3.17, R3.19): nothing ran, so the use didn't pass, and its line is failed. A claim carries passed lines
    /// only (`chain::claim`; a server claims only the passed lines it keeps), so with none the payer's stream sends
    /// nothing: no fetch leg buys a coin for the payer and no line notes a check. The place under the cap is given back,
    /// the body isn't kept, the entry isn't demoted or reported failed, and the next read goal meeting it is told so
    /// before the chain is read or anything fetched; a goal that asks for a change is not stopped by it. A body that does
    /// another page is the same class: it can't answer the goal either.
    #[test]
    fn a_read_goal_that_meets_a_write_body_pays_nothing_buys_nothing_and_checks_nobody() {
        let home = store::scratch_home("unrun-write");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let node = crate::testchain::node("unrun-write");
        let (agent, _) = crate::agents::create(node.keys.as_ref(), "agent", 100.0, 30, 0).unwrap();
        // Places under the cap are the process's: an epoch no other test reserves in.
        const OWN_EPOCH: u64 = 913_801;
        let entry = chain::test_entry("unrun-write");
        let mut writes: store::Route = serde_json::from_value(json!({
            "id": "unrun-write", "site": "shop.example", "what": "order a lamp", "method": "POST", "path": "/api/order",
            "root": "https://shop.example/lamps", "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": true, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/order", "needs_browser": false, "fields": [] }] }
        }))
        .unwrap();
        writes.fetched = Some(store::Fetched { entry_id: format!("{entry:#x}"), route_id: writes.id.clone(), agent_id: "0x0c".into(), content_id: chain::test_content("unrun-write"), listed_as: "order a lamp".into(), fetched_at: 1 });
        assert!(cannot_answer(&writes, false, "").is_none(), "a goal that asks for a change runs it");
        let why = cannot_answer(&writes, true, "").expect("a route that writes answers no read");
        let held = chain::reserve(agent.index, OWN_EPOCH, 0.25, 0.0, 0.25, 100.0).unwrap();
        let mut paying = Use {
            entry,
            contributor: alloy::primitives::Address::repeat_byte(0xc0),
            server: Some(alloy::primitives::Address::repeat_byte(0x5e)),
            server_peer: None,
            epoch: OWN_EPOCH,
            held: Some(held),
            body: b"{}".to_vec(),
        };
        let (status, said) = rt.block_on(refuse_unrun(&node, &agent, &mut paying, &writes, &why));
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("writes, and the goal only reads: nothing ran, and nothing was paid"), "{said}");
        // One line, failed: nothing a claim carries, so nothing is charged, no coin bought and nobody checked.
        let lines = chain::receipts(agent.index, OWN_EPOCH).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(!lines[0].passed && lines[0].entry == Some(entry), "{:?}", lines[0]);
        assert_eq!(chain::signed_unclaimed(OWN_EPOCH), 0.0, "nothing signed for the payer to pay");
        chain::reserve(agent.index, OWN_EPOCH, 0.25, 0.0, 0.25, 100.0).expect("the whole cap is free again: the place was given back");
        assert!(share::cached(&format!("{entry:#x}")).is_none(), "the body isn't kept");
        assert!(!node.share.demoted(entry), "not a failure of the entry");
        assert!(crate::report::FAILED_USES.locked().iter().all(|(r, ..)| r != "unrun-write"), "not counted or reported as a failed use");
        // The next read goal meeting the entry is refused before anything is fetched or paid; a change isn't.
        let (status, again) = rt.block_on(call_entry(&node, &agent, &format!("{entry:#x}"), HashMap::new(), "", ForGoal { reads_only: true, budget: None }, Vec::new())).expect_err("refused");
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(again.contains("nothing was fetched or paid (its body was fetched before, and isn't kept)"), "{again}");
        assert_eq!(chain::receipts(agent.index, OWN_EPOCH).unwrap().len(), 1, "no new line");
        let change = rt.block_on(call_entry(&node, &agent, &format!("{entry:#x}"), HashMap::new(), "", ForGoal::default(), Vec::new()));
        assert!(change.as_ref().err().is_none_or(|e| e.0 != StatusCode::CONFLICT), "a goal that asks for a change goes on: {change:?}");
        // A route that does another page can't answer a goal for this one, whether or not it writes.
        let mut other = writes.clone();
        other.write = false;
        assert!(cannot_answer(&other, true, "https://shop.example/chairs").is_some_and(|w| w.contains("does another page")));
        assert!(cannot_answer(&other, true, "https://shop.example/lamps").is_none(), "its own page");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A use's line is written after its call ran. A write that landed and then couldn't be billed used to be answered as
    /// a fee that couldn't be paid, which the goal reads as nothing done: it tried the next entry, and the write ran twice.
    /// The call's result stands, with the line said to be missing, so the goal stops here.
    #[test]
    fn a_line_that_cant_be_written_never_takes_back_a_call_that_ran() {
        use std::io::{BufRead, Write};
        let home = store::scratch_home("unbilled-write");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = site.local_addr().unwrap().port();
        let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = writes.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = r#"{"ordered":true}"#;
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let route: store::Route = serde_json::from_value(json!({
            "id": "order", "site": "127.0.0.1", "what": "order a lamp", "method": "GET", "path": "/order",
            "root": format!("http://127.0.0.1:{port}/"), "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/order"), "needs_browser": false, "fields": [] }] }
        }))
        .unwrap();
        store::save_route(&route).unwrap();
        let node = crate::testchain::node("unbilled");
        let (agent, _) = crate::agents::create(node.keys.as_ref(), "agent", 100.0, 30, 0).unwrap();
        let held = chain::reserve(agent.index, 7, 0.01, 0.0, 100.0, 100.0).unwrap();
        // The receipt file doesn't read: the one thing that can refuse a line whose place was reserved.
        let file = chain::dir().join("receipts").join(format!("{}-7.json", agent.index));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "not a ledger").unwrap();
        let paying = Use { entry: Default::default(), contributor: Default::default(), server: None, server_peer: None, epoch: 7, held: Some(held), body: Vec::new() };
        let r = rt.block_on(run_route(&node, &agent, route, HashMap::new(), Some(paying), Vec::new())).expect("the call ran, so it is answered as it went");
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(r["paid_usdc"], 0.0);
        assert!(r["payment_note"].as_str().is_some_and(|n| n.contains("nothing was billed")), "{r}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
