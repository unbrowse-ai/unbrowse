//! Doing a goal on a page: the route that does it, here or on the network, or one learned from the page, with the
//! inputs the page's address gives it.

use super::*;
use crate::learn::Unlearned;
use crate::outcome::{Outcome, Said};

/// What an agent wants, done the fastest way there is: the route that does it, called; else the call the page makes
/// for it, learned from one walk of the page and called; else the page itself, open in the node's browser for the
/// agent to drive (`unbrowse_browse`), which learns from every step. A write that fails is answered as it failed and
/// never tried again another way: it may have landed. Every reply, answered or failed, names its outcome
/// (`outcome::stamp`): what was read where it was made, else what its own fields or its status say.
pub(crate) async fn do_goal_said(node: &Arc<Node>, a: &Agent, body: DoBody) -> Result<Value, Failed> {
    // `browser: never` holds for everything the ask does, the routes it calls as much as the pages it would walk.
    let shut = matches!(crate::browsers::Use::parse(&body.browser), Ok(crate::browsers::Use::Never));
    let mut r = call::with_the_browser_shut(shut, do_goal_unsaid(node, a, body)).await;
    crate::outcome::stamp("unbrowse_do", &mut r);
    r
}

/// The same, its failure as a status and words alone.
#[cfg(test)]
pub(crate) async fn do_goal(node: &Arc<Node>, a: &Agent, body: DoBody) -> Result<Value, Fail> {
    do_goal_said(node, a, body).await.map_err(Failed::plain)
}

async fn do_goal_unsaid(node: &Arc<Node>, a: &Agent, body: DoBody) -> Result<Value, Failed> {
    if store::load_settings().paused {
        return Err(Failed::new(StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED, Said::new(Outcome::Paused, "settings.paused")));
    }
    // The ask's time to its reply, as a reply the browser answered says it (`run::as_a_reply`).
    let ask_began = std::time::Instant::now();
    let goal = body.goal.trim().to_string();
    if goal.is_empty() {
        return Err(Failed::new(StatusCode::BAD_REQUEST, "say what you want in goal, e.g. 'search Hacker News stories'", Said::new(Outcome::BadRequest, "args")));
    }
    let browser = crate::browsers::Use::parse(&body.browser).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let url = body.url.trim().to_string();
    #[cfg(test)]
    if let Some(r) = slow::run(&url).await {
        return r;
    }
    super::asks::phase("routes");
    // A route of this site learned a moment ago is being held to a second walk: this ask waits for the verdict, so
    // it is answered by the route that stood. Bounded: an experiment that hangs holds no one for long.
    let waited = std::time::Instant::now();
    while learn::verifying(&url) && waited.elapsed() < call::VERDICT_WAIT {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let routes = store::load_routes();
    // A route learned on another page holds that page's item: it does this url only where the two differ in what the
    // route takes as inputs. Else the url's page is learned, and never answered with the other page's item.
    let found: Vec<&store::Route> =
        reads_only(routes_for(&routes, &goal, &url).into_iter().filter(|r| url.is_empty() || fits(r, &url)).collect(), &goal);
    // The goal a route was learned for, said with another value where that goal spelled the route's own (`search the
    // shop for lamps` learned, `search the shop for chairs` asked): the route's slot is the caller's to write into, and
    // the goal says what goes in it. Nothing is guessed: every other word of the two goals is the same.
    let mut body = body;
    let found = match found.is_empty() {
        true => {
            let said = said_with_another_value(&routes, &goal, &url);
            for (_, name, value) in &said {
                body.inputs.entry(name.clone()).or_insert(value.clone());
            }
            said.into_iter().map(|(route, ..)| route).collect()
        }
        false => found,
    };
    // If the route's goal differs, look for a read of the requested page. Its reply must hold this goal's fields.
    let try_page = found.is_empty() && !url.is_empty();
    let found = if try_page { page_routes(&routes, &goal, &url) } else { found };
    let reworded = try_page && !found.is_empty();
    // Else a route learned on another page of the same collection (`/prices/bitcoin` for `/prices/ethereum`) that
    // takes no input for the page: it answers only when its answer names this page's thing (a list of every coin
    // does; bitcoin's own price doesn't).
    let subject = learn::subject_of(&url, &goal);
    let sibling = found.is_empty() && !subject.is_empty() && unbrowse_learn::goal::only_reads(&goal);
    let found = if sibling { sibling_routes(&routes, &goal, &url) } else { found };
    let reworded = reworded || sibling;
    // Without a url, the names of the agent's inputs say which of the routes for the goal it means: those that take
    // every one of them.
    let found = match url.is_empty() && !body.inputs.is_empty() {
        true => takes_all(found, &body.inputs),
        false => found,
    };
    let sites: std::collections::BTreeSet<String> = found.iter().map(|r| route_origin_site(r)).collect();
    if sites.len() > 1 {
        let sites: Vec<String> = sites.into_iter().collect();
        return Err(Failed::new(StatusCode::CONFLICT, format!("routes on {} do that: give url, a page of the site you mean", sites.join(", ")), Said::new(Outcome::BadRequest, "args")));
    }
    // A read that failed even after its page was walked again is learned afresh below; the route that failed is said.
    // So is a route an agent judged wrong for this page (`unbrowse_judge`): it is passed over, and the page learned
    // afresh or opened for the agent's hands.
    let mut failed = found.iter().find_map(|r| r.wrong_for(&url).map(|w| json!({ "route_id": r.id, "error": format!("an agent judged its answer wrong for this page: {}", w.why) })));
    // The entry whose cached body was just tried, if one was: the network isn't asked for it again.
    let mut tried = Vec::new();
    // A stored route with no inputs cannot answer a different value in the
    // requested page's query, even if its HTTP call returns 200. Older walks
    // could save a redirect destination as a fixed path in this situation.
    // Each route that may answer, in turn: a read whose route failed tries the goal's next route for the page before
    // the page is walked again (two routes learned on two pages of a site can each answer the other's pages, or not).
    let mut tries: Vec<store::Route> = found
        .iter()
        .filter(|r| route_can_reuse_for_url(r, &url) && !(unbrowse_learn::goal::opens_with_a_read(&goal) && r.write) && r.wrong_for(&url).is_none())
        .map(|r| (*r).clone())
        .collect();
    // Of several routes that read the same thing, the one that asks least of the site goes first (`asks_least`): a
    // suggestions call learned while someone clicked about the page is newer than the results page's own route, and
    // being newer is no reason to be tried before it. The order found stands among equals.
    if unbrowse_learn::goal::only_reads(&goal) {
        tries.sort_by_key(asks_least);
    }
    // A read route whose answer was not taken comes back once, `browsed`, after the other stored reads.
    let mut queue: std::collections::VecDeque<(store::Route, bool)> = tries.into_iter().map(|r| (r, false)).collect();
    // What the first route the goal called said when its call failed: told with the browser's refusal, should the goal
    // end there (`tried_first`). A route passed over without a call (a value the ask doesn't give) is not one: for it
    // the agent gets the page.
    let mut refused_first: Option<String> = None;
    let mut page_call_failure = None;
    let mut n = 0;
    while let Some((route, browsed)) = queue.pop_front() {
        if !browsed {
            n += 1;
        }
        if n > 1 && !browsed && (route.write || !unbrowse_learn::goal::only_reads(&goal)) {
            continue;
        }
        // A route that needs a value this ask doesn't give can't be called for it. With a page to go to, the page is what
        // the agent gets: a sign-in learned once takes a username and a password, and asking for it again names neither.
        if let Some(name) = lacks_value(&route, &inputs_for(&route, &url, body.inputs.clone())).filter(|_| !url.is_empty()) {
            let why = format!("it needs a value for {name}, which this ask doesn't give: give it in inputs, or drive the page");
            failed = failed.or(Some(json!({ "route_id": route.id, "error": why })));
            continue;
        }
        tried.extend(route.fetched.as_ref().map(|f| f.entry_id.clone()));
        let inputs = inputs_for(&route, &url, body.inputs.clone());
        let fail = |e: Value| Some(json!({ "route_id": route.id, "error": e }));
        // A route whose answer never hears a value this page asks for would answer the walk's: the page is learned.
        let deaf = unreached(&route, &inputs);
        if !route.write && !url.is_empty() && !deaf.is_empty() {
            failed = failed.or(fail(json!(format!("its answer takes nothing from {}, so the page is learned", deaf.join(", ")))));
            continue;
        }
        // Calls first (`own_asks::calls_first`): a route learned from one sighting, asked a value it was not learned on,
        // is called for it, the agent's own ask. An answer that stands by the readers a confirming browse holds it to,
        // read whole (`confirm::by_its_call`), is served, and that call is the route's second sighting: the route stands
        // confirmed. One in doubt is served by the browser below. A route that is its own page's data (a JSON or a feed
        // address, `calls_the_page_itself`) keeps its failure when the call rules out browser confirmation. Learning
        // the same response again would discard the comparison with the original records.
        if learn::own_asks::confirms_by_use() && learn::own_asks::calls_first() && !url.is_empty() && !browsed && learn::confirm::served_by_the_browser(&route, &inputs) {
            let began = std::time::Instant::now();
            let called = call::do_call_with_whole(node, a, route.id.clone(), inputs.clone()).await;
            let (status, doubt) = match called {
                Ok((r, Some(whole))) if r["ok"].as_bool() == Some(true) => {
                    let mut reply = crate::run::as_a_reply(&route, &inputs, &body.fields, whole.clone(), began.elapsed().as_millis() as u64, r["browser"].as_bool() == Some(true));
                    for key in ["route_id", "replaced", "learned_again"] {
                        if let Some(value) = r.get(key) {
                            reply[key] = value.clone();
                        }
                    }
                    let ask = Asked { url: &url, goal: &goal, subject: &subject, reworded, sibling, given: &inputs };
                    let held = unanswered_from(&r, &route, &ask, Some(&whole)).map(|w| w.as_str().unwrap_or("its answer is not this page's").to_string());
                    if let Some(out) = empty_page_reply(&r, &route, &ask, Some(&whole), &body.fields, held.as_deref()) {
                        return Ok(out);
                    }
                    match held.map_or_else(|| learn::confirm::by_its_call(&route, &inputs, &whole.data), Err) {
                        Ok((place, said)) => {
                            let standing = store::update_route(&route.id, |r| {
                                r.provisional = false;
                                r.heard.said_back = Some(said.clone());
                                if place.is_some() && !r.heard.document_records {
                                    r.heard.records_at = place.clone();
                                }
                            })
                            .ok()
                            .flatten()
                            .unwrap_or_else(|| route.clone());
                            eprintln!("   [confirm] {}: agreed by its own call for the value, {} ms", route.id, began.elapsed().as_millis());
                            // The reply already made of the whole answer is this one: what the route is said to be
                            // now (confirmed, its records' place) is nothing a reply is shaped by.
                            let mut out = json!({ "how": "called", "route": route_json(&standing), "result": records_for_ask(reply, &standing, &ask, &body.fields, Some(&whole)) });
                            out["route"]["verdict"] = json!("agreed");
                            // What the call fell back on reaching this answer says is beside it, as a call's own reply
                            // says it: a step sent as the route builds it answered cheaper than the route says.
                            if let Some(notes) = r.get("notes") {
                                out["notes"] = notes.clone();
                            }
                            return Ok(out);
                        }
                        Err(why) => (StatusCode::UNPROCESSABLE_ENTITY, why),
                    }
                }
                Ok((r, None)) if r["ok"].as_bool() == Some(true) => (StatusCode::BAD_GATEWAY, "the call returned no data to confirm".to_string()),
                Ok((r, _)) => (StatusCode::BAD_GATEWAY, r["error"].as_str().unwrap_or("its call failed").to_string()),
                Err(failure) => failure,
            };
            eprintln!("   [confirm] {}: in doubt by its own call for the value: {doubt}", route.id);
            refused_first.get_or_insert_with(|| doubt.clone());
            if browser == crate::browsers::Use::Never && calls_the_page_itself(&route, &url) {
                let why = format!("its call for this value does not stand on its own: {doubt}");
                failed = failed.or_else(|| fail(json!(why)));
                page_call_failure.get_or_insert_with(|| Failed::new(status, why, Said::new(Outcome::CallFailed, "goal.page_call_in_doubt")));
                continue;
            }
            queue.push_back((route, true));
            continue;
        }
        // A route learned from one sighting, asked a value it was not learned on, with the switch on: the browser
        // serves the ask, a walk of this page for the value, and the route is called once beside it and compared
        // (`learn::confirm`). The reply is what the walk's own call answered for the value, never the first route's
        // answer nor a call of the route that stands, which is noted beside it. A walk that learns nothing passes the
        // route over.
        if learn::own_asks::confirms_by_use() && !url.is_empty() && (browsed || learn::confirm::served_by_the_browser(&route, &inputs)) {
            ready(node, crate::browsers::Need::Confirm, browser).await
                .map_err(|(status, why)| (status, tried_first(why, refused_first.as_deref())))?;
            let began = std::time::Instant::now();
            let (n, who, page, wanted, first, given) = (node.clone(), a.name.clone(), url.clone(), goal.clone(), route.clone(), inputs.clone());
            // The browser's walk for the value ends on the ask's stop flag, as a learn's does.
            let stop = super::mcp::ask_stop();
            super::asks::phase("confirm");
            let confirmed = tokio::task::spawn_blocking(move || unbrowse_learn::mint::stops_with(stop, || learn::confirm::confirm_by_use(&n.walks, &page, &wanted, &who, &first, &given, Some(&n)))).await;
            node.events.emit("activity", ());
            let confirmation = match confirmed {
                Ok(Ok(c)) => c,
                // The site turned this value away to another page: it has nothing for it. The route stands as it was,
                // and nothing that page loads is served.
                Ok(Err(Unlearned::Elsewhere(why))) => {
                    crate::run::served_by_the_browser(&route, false, began.elapsed().as_millis() as u64, Some(why.clone()));
                    let mut v = elsewhere(&why);
                    v["route"] = route_json(&route);
                    return Ok(v);
                }
                // The browser's walk for this value found nothing: the site answered and has nothing for it. The route
                // stands as it was.
                Ok(Err(Unlearned::Nothing(why))) => {
                    crate::run::served_by_the_browser(&route, false, began.elapsed().as_millis() as u64, Some(why.clone()));
                    let mut v = nothing(&why);
                    v["route"] = route_json(&route);
                    return Ok(v);
                }
                Ok(Err(why)) => {
                    let why = format!("the browser's walk for this value learned nothing: {why}");
                    crate::run::served_by_the_browser(&route, false, began.elapsed().as_millis() as u64, Some(why.clone()));
                    failed = failed.or(fail(json!(why)));
                    continue;
                }
                Err(e) => {
                    failed = failed.or(fail(json!(e.to_string())));
                    continue;
                }
            };
            let standing = confirmation.standing;
            // The browser's own answer for the value is the reply: the route that stands is noted beside it, and
            // called only where the walk made neither route's call.
            let given = inputs_for(&standing, &url, body.inputs.clone());
            let ask = Asked { url: &url, goal: &goal, subject: &subject, reworded, sibling, given: &given };
            let whole = confirmation.answer.as_ref();
            let answered = match whole {
                Some(answer) => {
                    crate::run::served_by_the_browser(&standing, true, began.elapsed().as_millis() as u64, None);
                    Ok(crate::run::as_a_reply(&standing, &given, &body.fields, answer.clone(), began.elapsed().as_millis() as u64, true))
                }
                None => do_call_fields(node, a, standing.id.clone(), given.clone(), body.fields.clone()).await,
            };
            match answered {
                Ok(r) => {
                    let mut reply = json!({ "how": "learned", "picked_by": "the browser, for this value", "route": route_json(&standing), "result": records_for_ask(r, &standing, &ask, &body.fields, whole) });
                    reply["route"]["verdict"] = json!(confirmation.verdict.word());
                    reply["route"]["why"] = json!(confirmation.verdict.why());
                    if standing.id != route.id {
                        reply["route"]["was"] = json!(route.id);
                    }
                    // The browser answered because this machine's runtime can't hold the route's page code: said beside
                    // the answer, typed, as a call's reply says it.
                    let page_code = standing.graph.steps.iter().any(|s| s.is_page_signed());
                    if let Some(held) = held_back_beside(page_code, unbrowse_learn::sandbox::unheld()) {
                        reply["held_back"] = held;
                    }
                    return Ok(reply);
                }
                Err((_, e)) => {
                    failed = failed.or(fail(json!(e)));
                    continue;
                }
            }
        }
        let asked = inputs.clone();
        let (mut called, mut whole) = call::with_call_answer(do_call_as_seen(node, a, route.id.clone(), inputs.clone(), body.fields.clone(), Some(route.write))).await;
        if came_back_empty(&called, &route, &url) && !learn::own_asks::held_at(learn::own_asks::Ask::Again, "api::goal::came_back_empty") {
            (called, whole) = call::with_call_answer(do_call_as_seen(node, a, route.id.clone(), inputs, body.fields.clone(), Some(route.write))).await;
        }
        let ask = Asked { url: &url, goal: &goal, subject: &subject, reworded, sibling, given: &asked };
        let this = match called {
            Ok(r) => match unanswered_from(&r, &route, &ask, whole.as_deref()) {
                None => {
                    // A route whose call found the site drifted was learned again from its plan, and answered by the new one.
                    let again = r.get("learned_again").and_then(|v| v.as_str()).and_then(store::load_route);
                    let (how, answered) = match &again {
                        Some(new) => ("learned", new),
                        None => ("called", &route),
                    };
                    return Ok(json!({ "how": how, "route": route_json(answered), "result": records_for_ask(r, answered, &ask, &body.fields, whole.as_deref()) }));
                }
                Some(why) => {
                    if let Some(out) = empty_page_reply(&r, &route, &ask, whole.as_deref(), &body.fields, why.as_str()) {
                        return Ok(out);
                    }
                    // An answer that lacks only what the goal asks of each result, for another value than the route's
                    // own, from a route that still gives it for its own, where the page asked for shows nothing for
                    // it either: a search that found nothing. It is the site's answer to this value, and the page is
                    // not walked again to learn from its empty page.
                    if !reworded && why.as_str() == Some(LACKS_THE_GOAL) {
                        let (held, given, wanted, page) = (route.clone(), asked.clone(), goal.clone(), url.clone());
                        let nothing = tokio::task::spawn_blocking(move || {
                            found_nothing_of_the_goal(&held, &given, &wanted, &mut crate::run::asked_plainly, &mut |values: &[String]| crate::learn::page_lists(&page, &wanted, values))
                        })
                        .await
                        .unwrap_or(false);
                        if nothing {
                            eprintln!("   [goal] {} {} found nothing for this value: its answer lacks only what the goal asks of each result, and the site still gives that for the value the route was learned on", route.method, route.site);
                            let mut reply = json!({ "how": "called", "route": route_json(&route), "result": own_records(r, &subject, &body.fields) });
                            Said::new(Outcome::AnsweredEmpty, "goal.found_nothing_of_the_goal").put(&mut reply);
                            return Ok(reply);
                        }
                    }
                    // No answer for this value from a route that hears its caller and still answers its own: the
                    // caller is told now, and the page is not walked again to learn the call it already has.
                    let (held, given, reply) = (route.clone(), asked.clone(), r.clone());
                    let told = tokio::task::spawn_blocking(move || nothing_for_this_value(&held, &given, &reply, &mut crate::run::asked_plainly)).await.ok().flatten();
                    match told {
                        Some(said) => {
                            let mut reply = json!({ "how": "called", "route": route_json(&route), "result": said });
                            Said::new(Outcome::AnsweredEmpty, "goal.nothing_for_this_value").put(&mut reply);
                            return Ok(reply);
                        }
                        None if learn::own_asks::confirms_by_use() && !url.is_empty() && !route.write && !browsed => {
                            // With the browser the one fallback (`UNBROWSE_CONFIRM_BY_USE`), a read whose answer was
                            // not taken is served by the browser, the route called beside it (`learn::confirm`): a
                            // walk that finds nothing there too leaves the route standing and answers with what the
                            // browser got, and one that finds what the route missed learns the route that stands.
                            let why = why.as_str().unwrap_or("it did not answer");
                            refused_first.get_or_insert_with(|| why.to_string());
                            eprintln!("   [goal] {} {} was called and its answer not taken: browser confirmation queued: {}", route.method, route.site, why.chars().take(200).collect::<String>());
                            queue.push_back((route, true));
                            continue;
                        }
                        None => {
                            // Said where the owner can read it: a called route's answer that is not taken is the
                            // reason the page is walked again, and nothing else records why.
                            eprintln!("   [goal] {} {} was called and its answer not taken: {}", route.method, route.site, why.as_str().unwrap_or("it did not answer").chars().take(200).collect::<String>());
                            fail(why)
                        }
                    }
                }
            },
            // A kept copy of a route its contributor delisted ran nothing and is gone: the goal goes on without it.
            Err((StatusCode::GONE, e)) if route.fetched.is_some() => fail(json!(e)),
            // So does a kept copy whose call its rule refused: it was set aside, and nothing was sent.
            Err((StatusCode::FORBIDDEN, e)) if route.fetched.is_some() => fail(json!(e)),
            Err(e) if ends_the_goal(&route, &url) => return Err(Failed::of_call(e)),
            Err((_, e)) => {
                refused_first = refused_first.or(Some(e.clone()));
                fail(json!(e))
            }
        };
        failed = failed.or(this);
    }
    if url.is_empty() {
        // No page was given to learn from: the call to make is a search for a page or a route that does it.
        let said = Said::new(Outcome::NoRoute, "routes").then("unbrowse_search", json!({ "query": goal }));
        return Err(Failed::new(StatusCode::NOT_FOUND, "no route does that yet: give url, a page that does it, and the node learns it", said));
    }
    // Other contributors' routes for the page's site come before the browser (R3.1). The node pays their fee itself,
    // with nothing to approve, up to the owner's per-fetch maximum; one over it is passed over, and the reply says so.
    super::asks::phase("network");
    let (answered, failures, skipped) = network_goal(node, a, &goal, &url, &body, &tried).await?;
    if let Some(mut answered) = answered {
        if let Some(f) = failed {
            answered["route_failed"] = f;
        }
        return Ok(answered);
    }
    if let Some(failure) = page_call_failure {
        return Err(failure);
    }
    let unpaid = payment_refused(&failures);
    if failed.is_none() {
        failed = failures.into_iter().next().map(|mut f| {
            f.as_object_mut().map(|o| o.remove("payment"));
            f
        });
    }
    let offers = skipped.offers();
    let skipped = skipped.said();
    if !store::load_settings().map_while_browsing {
        let mut why = "no route does that, and the owner has turned learning off".to_string();
        if let Some(s) = &skipped {
            why = format!("{why}. {}", s["why"].as_str().unwrap_or_default());
        }
        if let Some(u) = &unpaid {
            why = format!("{why}. {}", u["why"].as_str().unwrap_or_default());
        }
        return Err(Failed::new(StatusCode::FORBIDDEN, why, Said::new(Outcome::NoRoute, "settings.map_while_browsing")));
    }
    // A url that answers with data itself is its own route, learned with no browser; a refusal is said as the site
    // said it, and one the browser can't change ends here.
    super::asks::phase("plain");
    let (plain, refusal) = match learn_plain(&a.name, &url, &goal).await {
        learn::Plain::Route(route) => (Some(Ok((route, "the page itself, a plain request"))), None),
        learn::Plain::Refused(why) => return Err(Failed::new(StatusCode::BAD_GATEWAY, why, Said::new(Outcome::Refused, "plain.refused"))),
        learn::Plain::Page(refusal) => (None, refusal),
    };
    // The walk that taught the route, when a walk did: its own answer for the value is the first reply.
    let mut walked: Option<String> = None;
    let learned = match plain {
        Some(learned) => learned,
        None => {
            // Past here the page is walked: the browser, or `browser_missing` saying what it lacks. A route called before it
            // whose call failed is said with that, so an agent that can't let the browser in still hears why the route
            // didn't answer (a route from the network that signs in, on a node whose vault holds no login for the site).
            ready(node, crate::browsers::Need::Walk, browser).await.map_err(|(status, e)| (status, tried_first(e, refused_first.as_deref())))?;
            learn_page(node, &a.name, &url, &goal).await.map(|(route, by, walk)| {
                walked = Some(walk);
                (route, by)
            })
        }
    };
    // A walk that failed says what the site said to a plain request for the page, when it refused it.
    let learned = learned.map_err(|why| match &refusal {
        Some(said) if why.for_hands() => why.and(said),
        _ => why,
    });
    // A read-only goal that could only learn a write (e.g. a background admin POST) is not answered by it: the write
    // is dropped and the page handed to the browser, not reported as a route (#25).
    let learned = match learned {
        Ok((route, _)) if route.write && unbrowse_learn::goal::only_reads(&goal) => {
            let _ = store::drop_learned(&route.id);
            Err("the page's read goal only matched a write call, which a read is never answered by".into())
        }
        // Loading the page found the very call an agent judged wrong for it: what the agent wants takes clicks or
        // typing (another tab, a filter), so the page is handed over rather than answered with that call again.
        Ok((route, _)) if route.wrong_for(&url).is_some() => {
            let why = route.wrong_for(&url).map(|w| w.why.clone()).unwrap_or_default();
            Err(format!("loading the page only finds the call an agent judged wrong for it ({why}): drive the page to what you want, and the call your steps send becomes the route").into())
        }
        // Or a call an agent renamed to say it does something else: it isn't this goal's answer on any page.
        Ok((route, _)) if route.judged.named && unbrowse_learn::goal::words(&route.what) != unbrowse_learn::goal::words(&goal) => {
            Err(format!("loading the page only finds a call an agent said does something else (\"{}\"): drive the page to what you want, and the call your steps send becomes the route", route.what).into())
        }
        other => other,
    };
    // A route is kept for what it does with a value it wasn't learned on: one that answers a second value as it answered
    // the first takes nothing from it, and would answer every later ask with the walk's. The page is handed over.
    // A route just learned answers as a stored one does: the walk saw the call answer once, on the walk's terms, and
    // its answer to this ask is read the same way before anyone is told it worked. One whose answer isn't this page's
    // (a strip of featured cards beside the results) is judged wrong for the page, as an agent would, and the page is
    // walked once more: the learner passes that call over and keeps its next pick.
    let mut learned = learned;
    // Walks a page is given after its first, once it is judged wrong: more only wake a site's guard.
    let mut again = usize::from(!matches!(browser, crate::browsers::Use::Never));
    let learned = loop {
        let deafened = match learned {
            // The site was asked at learn time and answered the same for a word nobody searches for: where that word
            // is one the goal itself spells, the caller came for it and the route cannot hear it. An answer handed
            // back as learned would say nothing of the ask and look as if it had.
            Ok((route, _)) if unbrowse_learn::goal::only_reads(&goal) && !route.write && deaf_to_the_goal(&route, &goal).is_some() => {
                let name = deaf_to_the_goal(&route, &goal).unwrap_or_default();
                // Kept, judged wrong for the page, as an agent's verdict is (`rejected_calls`): a route dropped is
                // learned straight back by the next walk or the browsing that follows, and handed over as the answer.
                let judged = store::page_key(&url).map(|page| {
                    store::update_route(&route.id, |r| {
                        let kept: Vec<store::WrongPage> = r.judged.wrong.iter().filter(|w| !r.same_page(&w.page, &page)).cloned().collect();
                        r.judged.wrong = kept;
                        r.judged.wrong.push(store::WrongPage { page: page.clone(), why: format!("it answers the same whatever {name} is"), by: "the node".into(), at: store::now() });
                    })
                });
                if !matches!(judged, Some(Ok(Some(_)))) {
                    let _ = store::drop_learned(&route.id);
                }
                Err(format!("the page answers the same whatever {name} is, and that is what you asked for: its address does not hand the value to the page. Drive the page (type it where the page takes it), and the call your steps send becomes the route").into())
            }
            Ok((route, by)) if unbrowse_learn::goal::only_reads(&goal) && !route.write => match deaf_to(node, a, &route, &inputs_for(&route, &url, body.inputs.clone()), &url).await {
                Some(name) => {
                    let _ = store::drop_learned(&route.id);
                    Err(format!("the call the page makes answers the same whatever {name} is, so it can't do another value: drive the page").into())
                }
                None => Ok((route, by)),
            },
            other => other,
        };
        let mut not_this_page = None;
        let answered = match deafened {
            Ok((route, by)) => {
                let inputs = inputs_for(&route, &url, body.inputs.clone());
                let given = inputs.clone();
                let ask = Asked { url: &url, goal: &goal, subject: &subject, reworded: false, sibling: false, given: &given };
                // A read the walk answered: the walk's own answer for this value is the reply, read as the route reads
                // it, and the route's own first call confirms it behind the reply (`first_call_behind`), as a route of
                // one sighting is confirmed by use. The reply says the browser answered, for this value.
                let from_the_walk = walked
                    .as_deref()
                    .filter(|_| takes_the_walks_answer(&route))
                    .and_then(|w| learn::walks_answer(&node.walks, w, &route, &inputs))
                    .and_then(|whole| take_the_walks_answer(&route, &inputs, &body.fields, &whole, &ask, ask_began.elapsed().as_millis() as u64));
                if let Some(r) = from_the_walk {
                    first_call_behind(node, a, &route, &inputs, &body.fields, &url, &subject);
                    break Ok((route, BY_THE_WALK, r));
                }
                let (mut called, mut whole) = call::with_call_answer(do_call_as_seen(node, a, route.id.clone(), inputs.clone(), body.fields.clone(), Some(route.write))).await;
                if came_back_empty(&called, &route, &url) && !learn::own_asks::held_at(learn::own_asks::Ask::Again, "api::goal::came_back_empty") {
                    (called, whole) = call::with_call_answer(do_call_as_seen(node, a, route.id.clone(), inputs, body.fields.clone(), Some(route.write))).await;
                }
                match called {
                    Ok(r) => match unanswered_from(&r, &route, &ask, whole.as_deref()) {
                        None => Ok((route, by, r)),
                        Some(why) => {
                            let said = why.as_str().unwrap_or("its call failed").to_string();
                            if r["ok"].as_bool() == Some(true) {
                                eprintln!("   [goal] {} {} was called and its answer not taken: {}", route.method, route.site, said.chars().take(200).collect::<String>());
                                not_this_page = Some((route.id.clone(), said.clone()));
                            }
                            failed = failed.or(Some(json!({ "route_id": route.id, "error": why })));
                            Err(Unlearned::Hands(format!("the call the walk found doesn't answer on its own: {said}")))
                        }
                    },
                    Err(e) if ends_the_goal(&route, &url) => return Err(Failed::of_call(e)),
                    Err((_, e)) => {
                        failed = failed.or(Some(json!({ "route_id": route.id, "error": e })));
                        Err(Unlearned::Hands(format!("the call the walk found doesn't answer on its own: {e}")))
                    }
                }
            }
            Err(why) => Err(why),
        };
        let (Some((id, said)), true, Some(page)) = (not_this_page, again > 0, store::page_key(&url)) else { break answered };
        let judged = store::update_route(&id, |r| {
            let kept: Vec<store::WrongPage> = r.judged.wrong.iter().filter(|w| !r.same_page(&w.page, &page)).cloned().collect();
            r.judged.wrong = kept;
            r.judged.wrong.push(store::WrongPage { page: page.clone(), why: said.clone(), by: "the node".into(), at: store::now() });
        });
        if !matches!(judged, Ok(Some(_))) {
            break answered;
        }
        learned = loop {
            again -= 1;
            match learn_page(node, &a.name, &url, &goal).await.map(|(route, by, walk)| {
                walked = Some(walk);
                (route, by)
            }) {
                // The walk found the same call again: walk once more while walks are left, else nothing on the page
                // answers it.
                Ok((route, _)) if route.wrong_for(&url).is_some() => {
                    if again == 0 {
                        break Err(Unlearned::Hands(format!("the call the walk found doesn't answer on its own: {said}")));
                    }
                }
                other => break other,
            }
        };
    };
    let mut reply = match learned {
        Ok((route, by, r)) => {
            // A route that does the goal for the pages older ones were learned on too takes their place.
            let companions = walked.as_deref().map(|walk| node.walks.companions(walk, &route.id)).unwrap_or_default();
            for old in superseded(&routes, &goal, &url, &route, &companions) {
                let _ = store::retire_route_for(&old.id, &route.id);
            }
            let mut reply = json!({ "how": "learned", "picked_by": by, "route": route_json(&route), "result": own_records(r, &subject, &body.fields) });
            if !companions.is_empty() {
                reply["learned_routes"] = json!(companions);
            }
            reply
        }
        // Nothing done on the page changes these: the agent hears why, as for a plain request refused above.
        Err(Unlearned::Unwalkable(why)) => return Err(Failed::new(StatusCode::BAD_REQUEST, why, Said::new(Outcome::NotAllowed, "learn.unwalkable"))),
        Err(Unlearned::Gone(why)) => return Err(Failed::new(StatusCode::BAD_GATEWAY, why, Said::new(Outcome::Gone, "learn.gone"))),
        // The site turned the value away to another page: it has nothing for it, and no route is kept from that page.
        Err(Unlearned::Elsewhere(why)) => elsewhere(&why),
        // The site answered the page's ask and has nothing for the value: no route is kept from a walk that saw no
        // record.
        Err(Unlearned::Nothing(why)) => nothing(&why),
        // Only the page's own code reads the answer, and this machine runs none: no route, said as the sandbox's reader.
        Err(Unlearned::Runtime(why)) => unheld(&why, &url),
        // The agent gave up on this ask (cancelled it, or hung up): nothing more is opened for it.
        Err(why) if super::mcp::ask_stop().load(std::sync::atomic::Ordering::Relaxed) => return Err(stopped(&why, &url)),
        // Loading the page doesn't answer the goal by itself: it needs clicks or typing, a sign-in or a check stood in
        // the way, or the site's door held (`learn::stood_in_the_way`). The agent drives it from here, in the node's
        // browser, and every step it takes is learned from. A page in a batch just describes that next step.
        Err(why) if body.many => {
            let said = hands_said(&why, &goal, &url, None, false);
            let mut reply = json!({ "how": "browse", "why": why.to_string(),
                "note": "This page needs clicks or typing: ask unbrowse_do for it alone, with its url, and it opens in the node's browser." });
            said.put(&mut reply);
            reply
        }
        Err(why) if matches!(browser, crate::browsers::Use::Never) => {
            return Err(Failed::new(StatusCode::BAD_GATEWAY, why.to_string(), Said::new(Outcome::CallFailed, "goal.replay_only")));
        }
        Err(unlearned) => {
            let why = unlearned.to_string();
            // A browser that can't open the page either says so beside why it was opened, which is the part that helps.
            let said = |(status, e): Fail| (status, format!("{why}; and the page couldn't be opened: {e}"));
            ready(node, crate::browsers::Need::Hands, browser).await?;
            let opened = do_browse(node, a, vec!["open".into(), url.clone()], String::new(), goal.clone(), &body.session).await.map_err(said)?;
            let site = opened["site"].as_str().unwrap_or_default().to_string();
            // With each link's address: a page of results is read for its links as often as for its names (each event's
            // own page, not the search it was listed on), and without them the agent can only hand on the page itself.
            let page = do_browse(node, a, vec!["snapshot".into(), "-i".into(), "--urls".into()], site.clone(), String::new(), &body.session).await?;
            let mut reply = json!({ "how": "browse", "site": site, "page": page["output"], "why": why,
                    "note": "The page is open in the node's browser. Drive it with unbrowse_browse (click, fill, press): the call your steps send becomes a route, named in the reply's learned, and next time unbrowse_do calls it." });
            let owner = crate::hands::owner_reach(node.events.watchers(), crate::browsers::headless_only()) != "off";
            hands_said(&unlearned, &goal, &url, Some(&site), owner).put(&mut reply);
            reply
        }
    };
    // A first answer comes from one walk, and one walk ranks the page's calls by what they carry: it can land on a
    // call that completes what was typed, or one that answers with ids and no names. The second walk behind it
    // measures which call answers, and may put another in this route's place. The caller is told, so it can read
    // this answer for what it is and ask again; the id it was handed goes on working either way.
    if reply["how"] == "learned" && learn::verifying(&url) {
        reply["checking"] = json!("This answer came from one walk of the page. The node is walking it a second time to check which call answers, and a better one may take this route's place within a minute or two: ask again then if this is not what you wanted. The route id above keeps working.");
    }
    if let Some(f) = failed {
        reply["route_failed"] = f;
    }
    if let Some(s) = skipped {
        reply["network_skipped"] = s;
    }
    if let Some(o) = offers {
        reply["network_offers"] = o;
    }
    if let Some(u) = unpaid {
        reply["payment_refused"] = u;
    }
    Ok(reply)
}

/// What a page that wasn't answered by loading it came to, and the call to make next: the page itself, open in the
/// node's browser (`site`) or to be asked for alone; the site's check, for the agent's own eyes; the owner's sign-in,
/// where the owner can be asked (`owner`, as `unbrowse_whoami` says it); a door that held, nothing.
pub(super) fn hands_said(why: &Unlearned, goal: &str, url: &str, site: Option<&str>, owner: bool) -> Said {
    let (outcome, from) = why.outcome();
    let said = Said::new(outcome, from);
    match (outcome, site) {
        (Outcome::Challenge, _) => {
            let mut look = json!({ "action": "look", "url": url });
            if let Some(site) = site {
                look["site"] = json!(site);
            }
            said.then("unbrowse_challenge", look)
        }
        (Outcome::Refused, _) => said,
        (Outcome::NeedsPerson, Some(site)) if owner => {
            said.then("unbrowse_browse", json!({ "do": ["ask_owner", format!("sign in to {site}: it sent the page to its sign-in")], "site": site }))
        }
        // The page is open and needs the owner, and none can be asked: said, with no ask_owner to make.
        (Outcome::NeedsPerson, Some(_)) => Said::new(Outcome::OwnerUnavailable, "owner.reach"),
        (Outcome::NeedsPerson, None) => said,
        (_, Some(site)) => said.then("unbrowse_browse", json!({ "do": ["snapshot", "-i", "--urls"], "site": site })),
        // The page asked for alone, with the goal it was asked for: an ask with no goal (one stopped) has no call to
        // repeat as given.
        (_, None) if !goal.trim().is_empty() => said.then("unbrowse_do", json!({ "goal": goal, "url": url })),
        (_, None) => said,
    }
}

/// What an ask its agent gave up on answers: stopped, unless the walk had already read what stood in its way (a
/// check, a sign-in, a door), which is said as itself. Either way what the walk met stays in `why`, and nothing more
/// is opened for it.
pub(super) fn stopped(why: &Unlearned, url: &str) -> Failed {
    let stop = agent_browser_core::session::STOPPED;
    let said = match why {
        Unlearned::Door(..) | Unlearned::SignIn(..) | Unlearned::Check(..) => hands_said(why, "", url, None, false),
        _ => Said::new(Outcome::Stopped, "ask.stop"),
    };
    let mut failed = Failed::new(StatusCode::REQUEST_TIMEOUT, stop, said);
    failed.why = Some(why.to_string()).filter(|w| !w.ends_with(stop));
    failed
}

/// What one ask of the ladder is: what a route's answer is read against.
pub(super) struct Asked<'a> {
    pub(super) url: &'a str,
    pub(super) goal: &'a str,
    /// What the page is about (`learn::subject_of`).
    pub(super) subject: &'a [String],
    /// The route was found by its page, not its words.
    pub(super) reworded: bool,
    /// The route was found on another page of the same collection.
    pub(super) sibling: bool,
    /// The inputs the call was given.
    pub(super) given: &'a HashMap<String, String>,
}

/// Whether a read is worth one more call before anything else is tried: a page's own state sometimes ships without its
/// data (a cache that is filling). Not for a route whose fields an agent chose: an answer without them is the agent's
/// to judge (a search with no results), never a reason to learn the page again.
fn came_back_empty(called: &Result<Value, Fail>, route: &store::Route, url: &str) -> bool {
    matches!(called, Ok(r) if r["ok"].as_bool() == Some(true) && !route.write && !route.judged.fields && !url.is_empty() && !has_value(&r["data"]))
}

/// What a caller is told at once where a route gave no answer for the value asked, and the page is not to be walked
/// again for it: the route only reads and runs as plain calls; the site has shown it hears its caller (two values,
/// two answers), so it is not a route that answers its walked request alone; the caller asked another value than the
/// one it was learned on; the call failed with the site's "not found" for this value; and asked once more
/// for its own value the site still answers (`asks`). Then the site has nothing by this name, or will not answer this
/// one, and walking the page again would only learn the same call. Never `ok`: nothing was found. None where any of
/// that does not hold, and the page is learned as before.
pub(super) fn nothing_for_this_value(
    route: &store::Route,
    given: &HashMap<String, String>,
    reply: &Value,
    asks: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<Value>,
) -> Option<Value> {
    let walked = its_own_value(route, given)?;
    // Only the site's plain "not found" for this value (`ReplayError::Failed`, as it is written): an answer in another
    // shape, a door or a refusal may be the site walling new asks, and is healed and learned as before.
    let said = reply["error"].as_str().unwrap_or_default();
    if reply["ok"].as_bool() == Some(true) || !(said.contains(" answered 404") || said.contains(" answered 410")) {
        return None;
    }
    let own = asks(&route.graph, &walked)?;
    if !has_value(&own) || (!route.fields.is_empty() && unbrowse_learn::fields::frame_without_records(&own, &route.fields)) {
        return None;
    }
    let why: String = said.chars().take(160).collect();
    Some(json!({
        "ok": false,
        "data": Value::Null,
        "error": format!("the site says nothing is there for this value ({why}), and still answers the value this route was learned on. The page was not walked again"),
    }))
}

/// The value a route was learned on, where the site itself can be asked what an answer for another value means: the
/// route only reads and runs as plain calls; the site has shown it hears its caller (two values, two answers), so it
/// is not a route that answers its walked request alone; and the caller asked another value than that one. None
/// otherwise: there is nothing to hold the answer against.
pub(super) fn its_own_value(route: &store::Route, given: &HashMap<String, String>) -> Option<HashMap<String, String>> {
    if route.write || route.socket.is_some() || route.browser_assisted || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return None;
    }
    if !route.heard.probed || !route.heard.deaf.is_empty() {
        return None;
    }
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| Some((i.name.clone(), i.default.clone()?))).collect();
    walked.iter().any(|(name, was)| given.get(name).is_some_and(|now| now != was)).then_some(walked)
}

/// Whether an answer that lacks what the goal asks of each result (a price, a link) is the site finding nothing for
/// the caller's value: a search that found nothing has no price to show. It is, where the route may be held to its
/// own value (`its_own_value`) and, asked once more for that value, the site's answer holds what the goal asks
/// (`asks`). A route whose own answer has lost it too is the one at fault, and the failure stands. As
/// `run::found_nothing` reads an answer that left its list out. One plain ask, made only for such an answer.
///
/// And the page the caller named must not say otherwise (`page_lists`, one plain request for it, made last): a call
/// that answers only some of a page's results (Carousell's strip of certified products beside its listings) is empty
/// for a value the page lists dozens of. Its empty answer is the call's, not the site's, and taking it answered every
/// such search `ok` with nothing (UNB-165); the page is learned again, as it was before this shortcut.
pub(super) fn found_nothing_of_the_goal(
    route: &store::Route,
    given: &HashMap<String, String>,
    goal: &str,
    asks: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<Value>,
    page_lists: &mut impl FnMut(&[String]) -> bool,
) -> bool {
    let Some(walked) = its_own_value(route, given) else { return false };
    if !asks(&route.graph, &walked).is_some_and(|own| holds_goal(&own, goal)) {
        return false;
    }
    let asked: Vec<String> = given.iter().filter(|(name, now)| walked.get(*name).is_some_and(|was| was != *now)).map(|(_, now)| now.clone()).collect();
    !page_lists(&asked)
}

/// Whether `route`'s call is the page `url` itself: the same origin and the same path, piece by piece, a piece the route
/// fills from its caller standing for any. Such a page answers with data, and that data is the page.
pub(super) fn calls_the_page_itself(route: &store::Route, url: &str) -> bool {
    let (Some(step), Ok(page)) = (route.graph.steps.last(), url::Url::parse(url)) else { return false };
    let address = step.url.split('?').next().unwrap_or_default();
    let Ok(call) = url::Url::parse(&address.replace('{', "%7B").replace('}', "%7D")) else { return false };
    if page.origin() != call.origin() {
        return false;
    }
    let path = address.split_once("://").and_then(|(_, rest)| rest.find('/').map(|at| &rest[at..])).unwrap_or("/");
    if matches_document_path(page.path(), path) {
        return true;
    }
    // A document may have been learned at a canonical path that adds or removes a terminal slash. The original
    // opening URL and the recorded answer must establish that rule for this route's path and origin.
    let Ok(root) = url::Url::parse(&route.root) else { return false };
    route.heard.records_at.is_some() && root.origin() == call.origin()
        && route.graph.steps.len() == 1 && step.method == "GET"
        && root.path().ends_with('/') == page.path().ends_with('/') && root.path().ends_with('/') != path.ends_with('/')
        && matches_document_path(without_last_slash(root.path()), without_last_slash(path))
        && matches_document_path(without_last_slash(page.path()), without_last_slash(path))
}

fn matches_document_path(actual: &str, template: &str) -> bool {
    let (actual, template) = (actual.split('/'), template.split('/'));
    actual.clone().count() == template.clone().count()
        && actual.zip(template).all(|(a, b)| (!a.is_empty() && b.contains('{')) || percent_encoding::percent_decode_str(a).eq(percent_encoding::percent_decode_str(b)))
}

fn without_last_slash(path: &str) -> &str {
    path.strip_suffix('/').unwrap_or(path)
}

/// What `unanswered` says of an answer without what the goal asks for.
pub(super) const LACKS_THE_GOAL: &str = "its answer doesn't hold what this goal asks for";
pub(super) const MISSING_RECORDS: &str = "its answer holds no records where the browser saw this route's records";

/// A zero in a document's recorded result list can be pending or beside another list. It goes through the
/// completed-empty check before it can be served as an answer.
pub(super) fn document_list_unready(r: &Value, route: &store::Route, url: &str) -> bool {
    r.get("records").is_some_and(|n| n.is_null() || n.as_u64() == Some(0)) && calls_the_page_itself(route, url)
}

/// A native collection with its witnessed list present can answer zero without a document's completion flags.
pub(super) fn native_empty_collection(r: &Value, route: &store::Route, given: &HashMap<String, String>, answer: &crate::run::WholeAnswer) -> bool {
    !route.heard.document_records && answer.answered_with_data && r["records"].as_u64() == Some(0)
        && route.heard.records_at.as_deref().is_some_and(|place| learn::confirm::settled_empty_list(&answer.data, place))
        && !replay_answers_the_walk(route, given, &answer.data, &answer.data)
}

/// A page's own read declares that the query completed with zero results. Return the fields
/// that say so when the ordinary projection would surface only the page around them. A side request cannot stand
/// for the site's search, even when that request's own results are empty.
pub(super) fn empty_page_reply(r: &Value, route: &store::Route, ask: &Asked, whole: Option<&crate::run::WholeAnswer>, fields: &[String], why: Option<&str>) -> Option<Value> {
    if !matches!(why, Some(LACKS_THE_GOAL | MISSING_RECORDS))
        || r["ok"].as_bool() != Some(true)
        || route.write
        || !route.graph.steps.last().is_some_and(|s| s.method == "GET")
        || !calls_the_page_itself(route, ask.url) {
        return None;
    }
    let data = whole.map(|answer| &answer.data).unwrap_or(&r["data"]);
    let witness = match route.heard.records_at.as_deref() {
        Some(place) => Some(learn::confirm::stable_list_at(data, place)?),
        None if route.heard.document_records => return None,
        None => None,
    };
    let returned_empty_collection = whole.is_some_and(|answer| native_empty_collection(r, route, ask.given, answer));
    let mut changed = route.inputs.iter().filter(|i| !i.secret && !i.file).filter_map(|i| {
        let now = ask.given.get(&i.name)?;
        i.default.as_ref().is_some_and(|was| was != now).then_some(now.as_str())
    });
    let evidence = match changed.next() {
        _ if returned_empty_collection => Some(Vec::new()),
        Some(term) if changed.any(|v| v != term) => return None,
        Some(term) => unbrowse_learn::answer::empty_search_fields(data, term, witness),
        None if witness.is_some() => route.inputs.iter().filter(|i| !i.secret && !i.file)
            .filter_map(|i| ask.given.get(&i.name).or(i.default.as_ref()))
            .find_map(|term| unbrowse_learn::answer::empty_search_fields(data, term, witness)),
        None => None,
    }?;
    let mut result = r.clone();
    if !evidence.is_empty() {
        let mut wanted = fields.to_vec();
        wanted.extend(evidence);
        let view = crate::run::as_a_reply(route, ask.given, &wanted, data.clone().into(), 0, r["browser"] == true);
        let sent: Vec<&str> = ask.given.values().map(String::as_str).collect();
        let mut view = super::said_to_an_agent_who_sent(route, view, &sent);
        for key in ["data", "fields", "truncated"] {
            result[key] = view[key].take();
        }
    }
    result["records"] = json!(0);
    let mut reply = json!({ "how": "called", "route": route_json(route), "result": result });
    Said::new(Outcome::AnsweredEmpty, "goal.empty_page_search").put(&mut reply);
    Some(reply)
}

/// Why a route's result doesn't answer `ask`, or None when it does and the goal ends with it. A write's answer stands
/// however it went: it may have landed. With no page to go on to, so does any answer.
#[cfg(test)]
pub(super) fn unanswered(r: &Value, route: &store::Route, ask: &Asked) -> Option<Value> {
    unanswered_from(r, route, ask, None)
}

fn unanswered_from(r: &Value, route: &store::Route, ask: &Asked, whole: Option<&crate::run::WholeAnswer>) -> Option<Value> {
    if route.write {
        return None;
    }
    let data = whole.map(|answer| &answer.data).unwrap_or(&r["data"]);
    let ok = r["ok"].as_bool() == Some(true);
    let page = !ask.url.is_empty();
    if ok && page && not_this_page(data, ask.subject) {
        return Some(json!("it answered with another page"));
    }
    let held_goal = std::cell::OnceCell::new();
    let holds = || *held_goal.get_or_init(|| {
        let target = if route.heard.document_records {
            let Some(rows) = route.heard.records_at.as_deref().and_then(|place| learn::confirm::stable_list_at(data, place)) else { return false };
            rows
        } else {
            data
        };
        if holds_goal(target, ask.goal) {
            return true;
        }
        if let Some(links) = whole.and_then(|answer| answer.rendered_links.as_ref()).and_then(Value::as_array) {
            let fields = unbrowse_learn::goal::fields(ask.goal);
            if unbrowse_learn::goal::holding_with_rendered_links(target, links, &fields, &[], ask.goal).is_some() {
                return true;
            }
        }
        let Ok(base) = url::Url::parse(&route.root) else { return false };
        let (read, drawn) = unbrowse_learn::fields::with_markup_read_at(target.clone(), &base);
        !drawn.is_empty() && holds_goal(&read, ask.goal)
    });
    // A route found by its page, not its words, answers only when its answer holds what this goal asks for.
    if ok && ask.reworded && (!holds() || (ask.sibling && !learn::data_names(data, ask.subject))) {
        return Some(json!(LACKS_THE_GOAL));
    }
    // A page for one thing answered with a list of others (a ranking that holds this coin on one page and not on the
    // next) is not this page's answer. A page that is its own data is not a page for one thing: its address is the
    // call's (`calls_the_page_itself`), and its answer is the page whatever its address's words name.
    if ok && !ask.subject.is_empty() && records(data) && !learn::data_names(data, ask.subject) && !calls_the_page_itself(route, ask.url) {
        return Some(json!("its answer lists other things, never this page's"));
    }
    // An answer that says what the walk was asked and nothing of what this call asked answers the walk, whatever the
    // site's status says: some value of the walk's rode along where no input reaches it.
    // A route a confirming browse saw answer with records at a place answers without that place: no records for the
    // value asked (the page's title, its chrome, the session's earlier searches), whatever else it says.
    // Read by the call on its answer whole (`run::records_where_seen`), never on `data`: the reply's fields and its cut
    // may leave the place out of a right answer.
    if ok && page && (r.get("records").is_some_and(Value::is_null) || document_list_unready(r, route, ask.url)) {
        return Some(json!(MISSING_RECORDS));
    }
    if ok && page && replay_answers_the_walk(route, ask.given, data, data) {
        return Some(json!("it answered what the walk asked, not what this page asks"));
    }
    // A list that says not one word of what this call asks for (a strip of featured cards, fares with every place left
    // out) answers every search the same, and its caller can't tell it answers this one. A call that **sends** the
    // caller's value is asking it, even when its answer says the value only in its records' own words (a semantic
    // search): the caller can tell, because the request carried it.
    let sends = route.graph.steps.last().is_some_and(|s| {
        !s.held.is_empty()
            || s.fields.iter().any(|f| matches!(&f.class, unbrowse_learn::graph::Class::Input { .. } | unbrowse_learn::graph::Class::File { .. }))
    });
    // A page read whole that says it wants a person is the site's check, whatever its status: never an answer. Only
    // a short page: a long one that mentions the word among its results is a page about it.
    if ok && data.get("title").is_some() && data.get("text").and_then(Value::as_str).is_some_and(|t| t.chars().count() < 4000 && crate::challenge::wants_a_person(t)) {
        return Some(json!("the site answered with a page that asks for a person, not the page asked for"));
    }
    // A page read whole is held to it even where the route sends the value: a page for a search says the search
    // somewhere, in its title, its heading or its results, and one that says no word of it is another page the site
    // put in the way (a country to choose, a notice), read back as if it were the results.
    let a_page_read = data.get("text").is_some() && data.get("title").is_some();
    if ok && page && (!sends || a_page_read) && !learn::wants_one(ask.goal) && says_none_asked(data, ask.given, ask.url, &route.path) {
        return Some(json!("its answer never says a word of what this page asks for"));
    }
    // Held to what a learn is held to: an answer without what the goal asks for (a price, a link) is no answer.
    if ok && page && !route.judged.fields && !holds() {
        return Some(json!(LACKS_THE_GOAL));
    }
    // A read whose answer has no value at all (every field it hands back missing on this page) didn't answer it.
    if ok && !route.judged.fields && page && !has_value(data) {
        return Some(json!("it answered with no values for this page"));
    }
    (!ok && page).then(|| r["error"].clone())
}

/// `said`, with what a route called before it said when its call failed (`refused`) said after it.
fn tried_first(said: String, refused: Option<&str>) -> String {
    match refused.filter(|w| !w.is_empty()) {
        Some(why) => format!("{}. A route for it was tried first and didn't answer: {why}", said.trim_end_matches('.')),
        None => said,
    }
}

/// Whether a call of `route` that came back an error ends the goal, for the route that was first as for the one after
/// it. A write isn't tried another way: it may have landed. Nor is anything with no page to learn from. A read changed
/// nothing, so the goal goes on to the next route, the network and the page, and says what failed.
pub(super) fn ends_the_goal(route: &store::Route, url: &str) -> bool {
    route.write || url.is_empty()
}

/// What the agent is told when a route other contributors list would have done the goal but its fee couldn't be paid
/// (the agent's daily limit, or the balance it pays from): the node went on without it, and the owner can fix that.
pub(super) fn payment_refused(failures: &[Value]) -> Option<Value> {
    let f = failures.iter().find(|f| f["payment"] == true)?;
    let said = f["error"].as_str().unwrap_or_default();
    let why = format!("A route other contributors list does this, but its fee couldn't be paid ({said}), so the node went on without it. The owner can add funds or raise this agent's daily limit in the Unbrowse app, under Money.");
    Some(json!({ "entry_id": f["entry_id"], "error": said, "why": why }))
}

/// A sum of USDC as the agent's owner reads it: dollars, to the cent or finer where it has more.
fn dollars(x: f64) -> String {
    format!("${}", crate::money::usdc(x))
}

/// Why an entry at `fee` (USDC a fetch) is never paid for: it costs more than the owner's per-fetch maximum, and the
/// node never pays more (R3.3). None when it may be paid: at or under the maximum.
pub(super) fn over_max(fee: f64, max: f64) -> Option<String> {
    (fee > max + 1e-9).then(|| format!("it costs {} to fetch, over the owner's maximum of {} a fetch, and the node never pays more", dollars(fee), dollars(max)))
}

/// Why an entry at `fee` (USDC a fetch) is never paid for on this task: it costs more than the task's own budget for one
/// fetch (R3.3, `DoBody::budget_usdc`). None with no budget, or at or under it. A budget below zero is zero: only a
/// free entry, and one that isn't a number is none.
pub(super) fn over_budget(fee: f64, budget: Option<f64>) -> Option<String> {
    let b = task_budget(budget)?;
    (fee > b + 1e-9).then(|| format!("it costs {} to fetch, over this task's budget of {} a fetch", dollars(fee), dollars(b)))
}

/// A task's budget as the node holds it to: none when it isn't a number, and never below zero.
pub(super) fn task_budget(budget: Option<f64>) -> Option<f64> {
    budget.filter(|b| !b.is_nan()).map(|b| b.max(0.0))
}

/// The entries other contributors list that do the goal but cost more to fetch than the owner's maximum, or the task's
/// own budget (R3.3): passed over as if they weren't offered.
#[derive(Default)]
pub(super) struct Skipped {
    pub(super) max: f64,
    /// The task's budget for one fetch, when the agent gave one.
    pub(super) budget: Option<f64>,
    pub(super) entries: Vec<(String, f64)>,
    /// Listings for the site that other contributors describe in other words than the goal's: the node doesn't take
    /// one for the goal by guessing, the agent reads them and calls one that does it. Entry, description and fee.
    pub(super) others: Vec<(String, String, f64)>,
}

/// The most listings in other words the agent is shown at once.
const MOST_OFFERS: usize = 10;

impl Skipped {
    /// Whether the task's budget, not the owner's maximum, is what an entry is held to: it is the lower of the two.
    fn by_budget(&self) -> Option<f64> {
        task_budget(self.budget).filter(|b| *b < self.max)
    }

    /// Why an entry at `fee` is passed over (`over_max`, `over_budget`), if it is: the lower limit says.
    pub(super) fn over(&self, fee: f64) -> Option<String> {
        over_max(fee, self.max).or_else(|| over_budget(fee, self.budget))
    }

    /// What the agent is told about them, if there were any: which, at what fee, the limit they were over (the task's
    /// budget when it is the lower, else the owner's maximum), and who can raise it.
    pub(super) fn said(&self) -> Option<Value> {
        let cheapest = self.entries.iter().map(|(_, fee)| *fee).min_by(f64::total_cmp)?;
        let n = self.entries.len();
        let (whose, limit, then) = match self.by_budget() {
            Some(b) => ("this task's budget", b, "The agent can give the task a larger budget, up to the owner's maximum."),
            None => ("the owner's maximum", self.max, "The owner can raise the maximum (Settings, or unbrowse-node max-fetch <usdc>)."),
        };
        let why = format!(
            "{n} route{} other contributors list for this site do this, but the cheapest costs {} to fetch, over {whose} of {} a fetch: the node never pays more, so it didn't use {}. {then}",
            if n == 1 { "" } else { "s" },
            dollars(cheapest),
            dollars(limit),
            if n == 1 { "it" } else { "them" },
        );
        Some(json!({ "entries": self.entries.iter().map(|(id, fee)| json!({ "entry_id": id, "fee_usdc": fee })).collect::<Vec<_>>(), "max_fetch_usdc": self.max, "budget_usdc": task_budget(self.budget), "why": why }))
    }

    /// The site's listings in other words, for the agent to judge (R3.2): the node takes a listing for a goal only when
    /// it names the goal's words, and leaves the rest to the agent, who knows what it asked for.
    pub(super) fn offers(&self) -> Option<Value> {
        if self.others.is_empty() {
            return None;
        }
        let entries: Vec<Value> = self.others.iter().take(MOST_OFFERS).map(|(id, what, fee)| json!({ "entry_id": id, "what": what, "fee_usdc": fee })).collect();
        Some(json!({
            "entries": entries,
            "next": "Other contributors list these routes for this site in other words, so the node didn't take one for your goal. If one does what you asked, call it with unbrowse_call and its entry_id as the route_id: it is paid like any route, its fee only if the call passes, and from then on it answers here.",
        }))
    }
}

/// Tries the entries other contributors listed for `url`'s site that do `goal`, the route's default first
/// (`rank::reputation::order`): their listings name the goal's words, as a route of this node's must (`routes_for`), and
/// are signed and under a posted root. For a goal that only reads, a small share of picks tries an unverified entry
/// first (R3.4); an entry that ran and failed here goes last for two hours (R5.4). Each is fetched and run here
/// (`call_entry`), its fee paid by the node with nothing to approve. The first that passes answers; a write that failed
/// answers as it failed, and no other is tried, since it may have landed. An entry already tried from its cached body
/// (`tried`) or off the ranking is skipped, and one whose fee is over the owner's per-fetch maximum is passed over as if
/// it weren't offered (it comes back in `Skipped`). The failures come back so the agent hears what was tried before the
/// browser.
/// Whether a pick may explore an unverified entry (R3.4): only for a public read. Never for a goal that changes state
/// (R1.25), and never for a call that may carry the owner's session (`signed_in`): an unverified stranger's route is
/// never run in the owner's name. A failed line costs its payer nothing (`decide.failed-fetch-always-free`), so a failed
/// exploration of a public read costs it nothing.
pub(super) fn explores(writes: bool, signed_in: bool) -> bool {
    !writes && !signed_in
}

/// Whether a call for a goal on `url`'s site may be a signed-in call (R3.4): this node keeps a session for a host of
/// that site (a jar holding a value: what a call there sends, `run::call_with`), or an input signs in from the vault
/// (`vault::is_ref`). Read from what the node keeps, before any entry is fetched: which host a body calls is known only
/// from the body, so any host of the site counts.
pub(super) fn signed_in(url: &str, inputs: &HashMap<String, String>) -> bool {
    if inputs.values().any(|v| vault::is_ref(v.trim())) {
        return true;
    }
    let Some(site) = url::Url::parse(url).ok().and_then(|u| u.host_str().map(unbrowse_learn::identity::site_of)) else { return false };
    let Ok(jars) = std::fs::read_dir(store::jars_dir()) else { return false };
    jars.flatten().any(|f| {
        let name = f.file_name().to_string_lossy().into_owned();
        let Some(host) = name.strip_suffix(".json") else { return false };
        unbrowse_learn::identity::site_of(host) == site && !store::read_json::<HashMap<String, String>>(&f.path(), &unbrowse_files::JAR).is_empty()
    })
}

pub(super) async fn network_goal(node: &Arc<Node>, a: &Agent, goal: &str, url: &str, body: &DoBody, tried: &[String]) -> Result<(Option<Value>, Vec<Value>, Skipped), Fail> {
    let mut found = match tokio::time::timeout(NETWORK_WAIT_ALONE, crate::peers::find_signed(node, url)).await {
        Ok(Some((found, _))) => found,
        _ => vec![],
    };
    // The site's listings this node read before still count while they check against the chain: a contributor's node
    // may be away while others seed its bodies.
    for p in node.share.known_on(url) {
        if !found.iter().any(|v| v.proven.listing.route_id == p.listing.route_id) {
            if let Ok(v) = crate::listing::verify(&node.chain, &p).await {
                found.push(v);
            }
        }
    }
    // Every goal with a page asks here now, with nothing for the agent to say first: a node that knows no listing for
    // the site goes straight on to its browser, without asking the chain anything.
    if found.is_empty() {
        return Ok((None, Vec::new(), Skipped::default()));
    }
    let said = unbrowse_learn::goal::words(goal);
    let epoch = chain::current_epoch(&node.chain).await.unwrap_or(0);
    // The sites' own policies, read at most once an epoch (R4.17): a delisted site's entries and ones under its floor
    // are never called.
    let sites: Vec<String> = found.iter().map(|v| v.proven.listing.site.clone()).collect();
    crate::sitepolicy::refresh_all(&node.chain, sites).await;
    let usable = |v: &crate::listing::Verified| {
        let entry = v.entry();
        !tried.iter().any(|t| t.eq_ignore_ascii_case(&format!("{entry:#x}")))
            && node.share.off_until(entry, epoch).is_none()
            && node.share.refused(&v.proven.listing.content_id).is_none()
            && node.share.resting(&v.proven.listing.content_id).is_none()
    };
    let (candidates, others): (Vec<_>, Vec<_>) =
        found.into_iter().filter(|v| usable(v)).partition(|v| !said.is_empty() && unbrowse_learn::goal::words(&v.proven.listing.terms.description) == said);
    // A lister's words, as every reply shows them (`listed_text`): never as they came.
    let others: Vec<(String, String, f64)> = others.iter().map(|v| (format!("{:#x}", v.entry()), listed_text(&v.proven.listing.terms.description, 300), v.fee)).collect();
    let ranking = Ranking { standings: standings(&node.chain, STANDINGS_WAIT).await, off: Default::default() };
    let of = |v: &crate::listing::Verified| rank::reputation::Candidate {
        entry: v.entry(),
        contributor: v.contributor,
        site: unbrowse_learn::identity::site_of(&v.proven.listing.site),
        fee: v.fee,
    };
    let reads = explores(unbrowse_learn::goal::asks_a_change(goal), signed_in(url, &body.inputs));
    let pick = rank::reputation::order(&ranking.standings, candidates, of, reads, rank::reputation::draws(), |e| node.share.demoted(e));
    // `rank.pick`: with any entry ranked by its coin (`rank.score`, read from the chain and kept a minute), the pick
    // follows rank in proportion, keeping the exploration share for entries with no rank; the pass rate's order above
    // stands among those, and for every entry when none is ranked. The pass rate is still reported.
    let ids: Vec<alloy::primitives::B256> = pick.order.iter().map(|v| v.entry()).collect();
    let scores: std::collections::HashMap<alloy::primitives::B256, f64> =
        chain::coins::ranks(&node.chain, &ids, chain::coins::RANK_WAIT).await.into_iter().map(|(e, r)| (e, r.score)).collect();
    let pick = if scores.values().any(|s| *s > 0.0) {
        let (d0, d1) = rank::reputation::draws();
        let mut next = rank::coin::draw;
        rank::coin::order(&scores, pick.order, |v| v.entry(), reads, (d0, d1, &mut next), |e| node.share.demoted(e))
    } else {
        pick
    };
    let mut skipped = Skipped { max: store::load_settings().max_fetch(), budget: body.budget_usdc, others, ..Skipped::default() };
    let mut failures = Vec::new();
    for v in pick.order {
        let id = v.entry();
        let entry = format!("{id:#x}");
        // A listing over the owner's per-fetch maximum or this task's budget is filtered out (R3.3).
        if skipped.over(v.fee).is_some() {
            skipped.entries.push((entry, v.fee));
            continue;
        }
        if let Some(why) = crate::sitepolicy::refuses(&v.proven.listing.site, v.fee) {
            failures.push(json!({ "entry_id": entry, "error": why }));
            continue;
        }
        let listed_as = json!({ "site": listed_text(&v.proven.listing.site, 253), "what": listed_text(&v.proven.listing.terms.description, 300) });
        let held_to = ForGoal { reads_only: !unbrowse_learn::goal::asks_a_change(goal), budget: body.budget_usdc };
        match call_entry(node, a, &entry, body.inputs.clone(), url, held_to, body.fields.clone()).await {
            Ok(r) if !use_failed(&r) => {
                let reputation = reputation_json(&ranking, &entry);
                let mut reply = json!({ "how": "network", "entry": { "id": entry, "contributor": format!("{:#x}", v.contributor), "fee": v.fee, "credited": v.credited, "listed_as": listed_as, "reputation": reputation }, "result": r });
                if pick.explored == Some(id) {
                    reply["explored"] = json!(true);
                }
                return Ok((Some(reply), failures, skipped));
            }
            // A use that ran and failed demotes the entry in this node only (R5.4): a failure reaches shared
            // reputation only from a verified person.
            Ok(r) => {
                node.share.demote(id);
                failures.push(json!({ "entry_id": entry, "error": r["error"] }))
            }
            // A fee that couldn't be paid is about the agent's money, not the entry: it is marked so the reply says
            // so in plain words (`payment_refused`), not only among the entries tried.
            Err((StatusCode::PAYMENT_REQUIRED, e)) => failures.push(json!({ "entry_id": entry, "error": e, "payment": true })),
            // Any other refusal, a body fetched that couldn't answer the goal and never ran included (`call::refuse_unrun`:
            // a failed line, free), goes on to the next entry (R3.19).
            Err((_, e)) => failures.push(json!({ "entry_id": entry, "error": e })),
        }
    }
    Ok((None, failures, skipped))
}

/// What a reply served by the browser says beside its answer of the sandbox: for a route that needs the page's own
/// code (`needs_page_code`) on a machine whose runtime can't hold it (`unheld`), the sandbox reader's fact and next
/// steps (`outcome::held_back`); nothing otherwise.
pub(super) fn held_back_beside(needs_page_code: bool, unheld: Option<unbrowse_learn::sandbox::Unheld>) -> Option<Value> {
    unheld.filter(|_| needs_page_code).as_ref().map(crate::outcome::held_back)
}

/// The site whose page taught the route. Its API call may go to a different host (for example, an Algolia endpoint).
pub(super) fn route_origin_site(route: &store::Route) -> String {
    url::Url::parse(&route.root)
        .ok()
        .and_then(|u| u.host_str().map(unbrowse_learn::identity::site_of))
        .unwrap_or_else(|| unbrowse_learn::identity::site_of(&route.site))
}

pub(super) fn route_matches_site(route: &store::Route, site: &str) -> bool {
    route_origin_site(route) == site || unbrowse_learn::identity::site_of(&route.site) == site
}

/// How much a read's route asks of the site, least first: whether it needs the page's own browser, whether the walk
/// left values of it unsettled, and how many steps it takes. A plain, settled, one-step route is tried before any
/// other that reads the same thing.
pub(super) fn asks_least(r: &store::Route) -> (bool, bool, usize) {
    let needs_the_page = r.browser_assisted || r.graph.steps.iter().any(|s| s.is_page_signed() || s.needs_browser);
    (needs_the_page, r.graph.provisional, r.graph.steps.len())
}

/// The routes a route just learned for `goal` takes the place of: older ones that do the goal for pages it does too.
/// Keep each companion the same walk saved. Never retire a route with a place on the chain (its entry names it, and peers pay for it), one of the owner's own
/// (learned from their browsing, acting as them), or one an agent judged (`unbrowse_judge`: its name, its fields, or a
/// page it doesn't do, which the next learn of that page must still pass over): an agent's learn adds to those, it
/// never removes them.
pub(super) fn superseded<'a>(routes: &'a [store::Route], goal: &str, url: &str, new: &store::Route, companions: &[String]) -> Vec<&'a store::Route> {
    routes_for(routes, goal, url).into_iter()
        .filter(|r| r.id != new.id && !companions.contains(&r.id) && fits(new, &r.root) && !r.stands())
        .collect()
}

/// The routes that do `goal`: what each does says the same words, in any order and case, on the page's site or
/// the call's site when `url` is given. Never a guess: sharing only some words is not enough.
pub(super) fn routes_for<'a>(routes: &'a [store::Route], goal: &str, url: &str) -> Vec<&'a store::Route> {
    let said = unbrowse_learn::goal::words(goal);
    let site_of_url = |u: &str| url::Url::parse(u).ok().and_then(|u| u.host_str().map(unbrowse_learn::identity::site_of));
    let on = site_of_url(url);
    routes
        .iter()
        // A route made from another contributor's body is said by its call; the goal finds it by its listing's words.
        .filter(|r| !said.is_empty() && (unbrowse_learn::goal::words(&r.what) == said || r.asked.iter().any(|a| unbrowse_learn::goal::words(a) == said) || r.fetched.as_ref().is_some_and(|f| unbrowse_learn::goal::words(&f.listed_as) == said)))
        .filter(|r| on.as_ref().is_none_or(|s| route_matches_site(r, s)))
        .collect()
}

/// The route whose goal is `goal` but for one of its inputs' own values, with that input's name and the value `goal`
/// says in its place: the two goals read word for word the same before and after it, and say at least two words
/// besides. On the page the route was learned on when `url` is given (its host and path), never a route judged wrong
/// for a page, a write, or a secret.
/// Several may: one typed word leaves a page by more than one call (a search, and a lookup of a card for it), each
/// kept. For a goal that asks for a list, those whose walked answer listed records come first; each is still held to
/// its answer when called.
pub(super) fn said_with_another_value<'a>(routes: &'a [store::Route], goal: &str, url: &str) -> Vec<(&'a store::Route, String, String)> {
    fn lists(shape: &Value) -> bool {
        match shape {
            Value::Array(items) => items.iter().any(Value::is_object) || items.iter().any(lists),
            Value::Object(map) => map.values().any(lists),
            _ => false,
        }
    }
    let words = |t: &str| t.split_whitespace().map(str::to_lowercase).collect::<Vec<_>>();
    let asked: Vec<&str> = goal.split_whitespace().collect();
    let said = words(goal);
    let page = url::Url::parse(url).ok();
    let same_page = |r: &store::Route| match (&page, url::Url::parse(&r.root)) {
        (Some(u), Ok(root)) => u.host_str() == root.host_str() && u.path().trim_end_matches('/') == root.path().trim_end_matches('/'),
        (None, _) => true,
        _ => false,
    };
    let mut found: Vec<(&store::Route, String, String)> = routes.iter().filter(|r| !r.write && r.fetched.is_none() && r.judged.wrong.is_empty() && same_page(r)).filter_map(|r| {
        let what = words(&r.what);
        r.inputs.iter().filter(|i| !i.secret && !i.file).find_map(|i| {
            let own = words(i.default.as_deref()?);
            let at: Vec<usize> = (0..what.len().saturating_sub(own.len().saturating_sub(1))).filter(|&p| !own.is_empty() && what[p..p + own.len()] == own[..]).collect();
            let [at] = at[..] else { return None };
            let (before, after) = (&what[..at], &what[at + own.len()..]);
            let fits = before.len() + after.len() >= 2 && said.len() > before.len() + after.len() && said.starts_with(before) && said.ends_with(after);
            // Only a goal that says more than the words around the value has a value in their place to read.
            if !fits {
                return None;
            }
            let value = asked[before.len()..asked.len() - after.len()].join(" ");
            (!value.eq_ignore_ascii_case(i.default.as_deref()?)).then(|| (r, i.name.clone(), value))
        })
    }).collect();
    if !learn::wants_one(goal) {
        found.sort_by_key(|(r, ..)| !r.graph.steps.last().and_then(|s| s.response_shape.as_ref()).is_some_and(lists));
    }
    found
}

/// The routes learned on the page `url` names (`fits`), for a read goal worded another way: those whose goal shares
/// one of this goal's fields (`goal::fields`: "get live bitcoin price" and "get live coin price in USD" share price),
/// most shared first. Writes never answer a read, and a route an agent named (`unbrowse_judge`) is found by the
/// agent's words alone: a word it shares with this goal (the site's own name) says nothing against what the agent said.
/// A release query can name just the field in a noun phrase. The document at its URL can answer it, and the release
/// field will be checked on the reply. The page's other calls have no such tie to the ask.
pub(super) fn page_routes<'a>(routes: &'a [store::Route], goal: &str, url: &str) -> Vec<&'a store::Route> {
    use unbrowse_learn::goal::{self, Shape};

    let read = goal::only_reads(goal);
    let release = goal::fields(goal).iter().any(|field| field.shape == Shape::ReleaseVersion);
    let reads = if release { release_read(goal) } else { read };
    if !reads {
        return Vec::new();
    }
    let asked = asked_of(goal, url);
    let page = url::Url::parse(url).ok();
    let mut found: Vec<_> = routes
        .iter()
        .filter(|r| !r.write && r.fetched.is_none() && !r.judged.named && fits(r, url))
        .filter(|r| !release || page.as_ref().is_some_and(|page| url::Url::parse(&r.root).is_ok_and(|root| &root == page)))
        .filter_map(|r| {
            let step = r.graph.steps.last();
            let document = release && step.zip(page.as_ref()).is_some_and(|(step, page)| reads_document_at(step, page));
            if release && step.is_some_and(|step| step.reads_page) && !document {
                return None;
            }
            let shared = if read { goal::fields(&r.what).into_iter().filter(|f| asked.contains(&f.word)).count() } else { 0 };
            (document || shared > 0).then_some(((document, shared), r))
        })
        .collect();
    found.sort_by_key(|(priority, _)| std::cmp::Reverse(*priority));
    found.into_iter().map(|(_, r)| r).collect()
}

/// A document's GET must account for every requested query pair and send no extra ones. The browser reads fragment inputs.
fn reads_document_at(step: &unbrowse_learn::Step, page: &url::Url) -> bool {
    let query_count = step.url.split_once('?').map_or(0, |(_, query)| url::form_urlencoded::parse(query.as_bytes()).count());
    step.reads_page
        && step.method == "GET"
        && step.url.split_once("://").is_some_and(|(scheme, _)| scheme == page.scheme())
        && unbrowse_learn::trace::fragment_pairs(page).is_empty()
        && query_count == page.query_pairs().count()
        && call_inputs(step, page).is_some()
}

/// A release document can answer an explicit read or a noun phrase beginning with the release qualifier.
fn release_read(goal: &str) -> bool {
    let phrase = goal.trim_start_matches(|c: char| !c.is_alphanumeric());
    let phrase = match phrase.split_once(char::is_whitespace) {
        Some((intro, rest)) if intro.eq_ignore_ascii_case("please") || intro.eq_ignore_ascii_case("the") => rest.trim_start(),
        _ => phrase,
    };
    !unbrowse_learn::goal::asks_a_change(goal)
        && (unbrowse_learn::goal::opens_with_a_read(phrase)
            || phrase.split_whitespace().next().is_some_and(|word| matches!(word.to_ascii_lowercase().as_str(), "latest" | "current" | "published")))
}

/// The words of `goal` that ask for a field, without the site's own name: every goal on a site may name it ("search
/// Target products", "read redsky aggregations on target.com"), so it says nothing of what either asks for.
fn asked_of(goal: &str, url: &str) -> std::collections::BTreeSet<String> {
    let site = url::Url::parse(url).ok().and_then(|u| u.host_str().map(unbrowse_learn::identity::site_of)).unwrap_or_default();
    let name = site.split('.').next().unwrap_or_default().to_lowercase();
    unbrowse_learn::goal::fields(goal).into_iter().map(|f| f.word).filter(|w| name.is_empty() || *w != name).collect()
}

/// Routes learned on another page of the collection `url` is in (the same address but its last piece), taking no
/// input for that piece, for a read whose goal shares a field with theirs.
pub(super) fn sibling_routes<'a>(routes: &'a [store::Route], goal: &str, url: &str) -> Vec<&'a store::Route> {
    let Ok(u) = url::Url::parse(url) else { return Vec::new() };
    let parent = |u: &url::Url| -> Option<(String, String)> {
        let path = u.path().trim_end_matches('/');
        let (head, last) = path.rsplit_once('/')?;
        (!last.is_empty() && !head.is_empty()).then(|| (u.host_str().unwrap_or_default().to_string(), head.to_string()))
    };
    let Some(mine) = parent(&u) else { return Vec::new() };
    let asked = asked_of(goal, url);
    routes
        .iter()
        .filter(|r| !r.write && r.fetched.is_none() && !r.judged.named && r.inputs.is_empty())
        // A route that is its page (the page read whole) is that page's thing, whatever else its text mentions.
        .filter(|r| r.graph.steps.last().and_then(|s| url::Url::parse(&s.url.replace('{', "%7B").replace('}', "%7D")).ok()).is_none_or(|t| t.path().trim_end_matches('/') != url::Url::parse(&r.root).map(|u| u.path().trim_end_matches('/').to_string()).unwrap_or_default()))
        .filter(|r| url::Url::parse(&r.root).ok().as_ref().and_then(parent).as_ref() == Some(&mine))
        .filter(|r| unbrowse_learn::goal::fields(&r.what).into_iter().any(|f| asked.contains(&f.word)))
        .collect()
}

/// Whether a page the route read whole is another page than the one asked for: its title names none of what this page
/// is about (a route that followed `/prices/ethereum` to `/prices/ether` and reads ether's page for every coin).
pub(super) fn not_this_page(data: &Value, subject: &[String]) -> bool {
    let title = data.get("title").and_then(Value::as_str);
    match title {
        Some(t) if !subject.is_empty() && data.get("text").is_some() => !learn::data_names(&json!(t), subject),
        _ => false,
    }
}

/// A call's result for a page about one thing (`subject`): its lists cut to the records that name that thing, unless
/// the caller asked for the whole answer (`*`). A list of every coin, for bitcoin's page, is bitcoin's record.
pub(super) fn own_records(mut r: Value, subject: &[String], fields: &[String]) -> Value {
    if !subject.is_empty() && !fields.iter().any(|f| f == unbrowse_learn::fields::ALL) {
        if let Some(data) = r.get("data").filter(|d| !d.is_null()) {
            r["data"] = unbrowse_learn::fields::about(data, subject);
        }
    }
    r
}

pub(super) fn records_for_ask(mut reply: Value, route: &store::Route, ask: &Asked, fields: &[String], whole: Option<&crate::run::WholeAnswer>) -> Value {
    let asks_links = |goal| unbrowse_learn::goal::fields(goal).iter().any(|field| field.shape == unbrowse_learn::goal::Shape::Link);
    if let Some(whole) = whole.filter(|_| fields.is_empty() && !route.judged.fields && asks_links(ask.goal) && !asks_links(&route.what)) {
        let mut view_route = route.clone();
        view_route.what = ask.goal.to_string();
        view_route.fields.clear();
        let mut view = crate::run::as_a_reply(&view_route, ask.given, fields, whole.clone(),
            reply["ms"].as_u64().unwrap_or_default(), reply["browser"] == true);
        let sent: Vec<&str> = ask.given.values().map(String::as_str).collect();
        view = super::said_to_an_agent_who_sent(route, view, &sent);
        for field in ["data", "fields", "truncated"] {
            reply[field] = view[field].take();
        }
    }
    own_records(reply, ask.subject, fields)
}

/// The values a page's address asks for that say something by themselves: its query's values and its path's pieces,
/// decoded, of three characters or more with a letter in them, never a flag, a date or a number.
pub(super) fn page_values(url: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(url) else { return Vec::new() };
    let said = |v: &str| v.chars().count() >= 3 && v.chars().any(char::is_alphabetic) && !unbrowse_learn::slots::is_flag(v) && v.chars().filter(char::is_ascii_digit).count() * 2 < v.chars().count();
    let mut out: Vec<String> = unbrowse_learn::trace::asked_pairs(&u).into_iter().map(|(_, v)| v).filter(|v| said(v)).collect();
    let site = u.host_str().unwrap_or_default().to_lowercase();
    for p in u.path_segments().into_iter().flatten() {
        let p = percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned();
        // A piece the site names every page by (`search`, `homes`, `s`) is the site's own word, not the ask: only one a
        // query value or the goal could have chosen, with a space or a digit-free word not in the host.
        if said(&p) && (p.contains(' ') || p.contains('+')) && !site.contains(&p.to_lowercase()) {
            out.push(p.replace('+', " "));
        }
    }
    out.dedup();
    out
}

/// The inputs a route takes its caller's values by, each with a value to try it with: those holding one of the page's own
/// values, plain (not a flag, a date or a number) and reaching the answer, the longest first, at most two, each tried
/// with another value the page itself offers for it. An input the page offers nothing else for isn't tried.
fn second_values(route: &store::Route, given: &HashMap<String, String>, asked: &[String]) -> Vec<(String, String)> {
    let plain = |v: &str| !unbrowse_learn::slots::bound_by_key(v) && v.chars().filter(char::is_ascii_digit).count() * 2 < v.chars().count();
    let of_the_page = |v: &String| asked.is_empty() || asked.iter().any(|a| a.eq_ignore_ascii_case(v));
    let mut inputs: Vec<(&store::RouteInput, &String)> = route
        .inputs
        .iter()
        .filter(|i| !i.secret && !i.optional && unbrowse_learn::reaches_the_answer(&route.graph, &i.name))
        .filter_map(|i| given.get(&i.name).or(i.default.as_ref()).filter(|v| plain(v) && of_the_page(v)).map(|v| (i, v)))
        .collect();
    inputs.sort_by_key(|(_, v)| std::cmp::Reverse(v.chars().count()));
    let mut seen: Vec<String> = Vec::new();
    inputs
        .into_iter()
        .filter(|(_, v)| {
            let new = !seen.iter().any(|s| s.eq_ignore_ascii_case(v));
            seen.push(v.to_string());
            new
        })
        .take(2)
        .filter_map(|(i, was)| {
            // Only a value the page itself offers: a site answers one it can't place (a word that is no city) with its last
            // search, which reads exactly as a route that never hears the value (measured on a hotel search).
            i.options.iter().map(|o| o.value.clone()).find(|o| o != was && !o.to_lowercase().contains(&was.to_lowercase())).map(|v| (i.name.clone(), v))
        })
        .collect()
}

/// Whether two answers say the same thing, the words of the values asked for aside.
pub(super) fn same_answer(a: &Value, b: &Value, asked: &[&str]) -> bool {
    let words = |v: &Value| -> std::collections::BTreeSet<String> {
        let text = v.to_string().to_lowercase();
        let skip: Vec<String> = asked.iter().flat_map(|a| a.to_lowercase().split(|c: char| !c.is_alphanumeric()).map(String::from).collect::<Vec<_>>()).collect();
        text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 4 && !skip.iter().any(|s| s == w)).map(String::from).collect()
    };
    let (x, y) = (words(a), words(b));
    let both = x.intersection(&y).count();
    let all = x.union(&y).count();
    all > 0 && both * 100 >= all * 95
}

/// The input of `route` the site showed it does not hear (`Route::heard`) whose value the goal itself spells: the
/// word the caller came for. A value the goal never says (a page number, a locale) may go unheard and the page still
/// be the answer.
pub(super) fn deaf_to_the_goal(route: &store::Route, goal: &str) -> Option<String> {
    route.inputs.iter().find(|i| route.heard.deaf.contains(&i.name) && i.default.as_deref().is_some_and(|v| !unbrowse_learn::slots::is_flag(v) && unbrowse_learn::trace::carries_whole(goal, v))).map(|i| i.name.clone())
}

/// The input of `route` a second value changes nothing of, when a call with one answers as the first did and never says
/// it. The page's own values are tried, the longest first, up to two: a route is deaf only when it is deaf to each, since
/// a value the site reads as a setting (a locale) changes nothing either way. A call that fails says nothing: a site may
/// refuse a value that isn't one of its own.
async fn deaf_to(node: &Arc<Node>, a: &Agent, route: &store::Route, given: &HashMap<String, String>, url: &str) -> Option<String> {
    if learn::own_asks::held_at(learn::own_asks::Ask::PageValues, "api::goal::deaf_to") {
        return None;
    }
    let tries = second_values(route, given, &page_values(url));
    if tries.is_empty() {
        return None;
    }
    let first = do_call_as_seen(node, a, route.id.clone(), given.clone(), Vec::new(), Some(route.write)).await.ok().filter(|r| r["ok"].as_bool() == Some(true))?;
    let was_of = |n: &str| given.get(n).or(route.inputs.iter().find(|i| i.name == n).and_then(|i| i.default.as_ref())).cloned();
    for (name, value) in &tries {
        let was = was_of(name).unwrap_or_default();
        // The same value the page was asked for may ride in more than one place (a path piece and a query key): each moves.
        let mut other = given.clone();
        for i in &route.inputs {
            if i.name == *name || was_of(&i.name).is_some_and(|v| v.eq_ignore_ascii_case(&was)) {
                other.insert(i.name.clone(), value.clone());
            }
        }
        let second = do_call_as_seen(node, a, route.id.clone(), other.clone(), Vec::new(), Some(route.write)).await.ok().filter(|r| r["ok"].as_bool() == Some(true))?;
        let says_it = second["data"].to_string().to_lowercase().contains(&value.to_lowercase());
        let stale = answers_the_walk(route, &other, &second["data"], None);
        if !(stale || (!says_it && same_answer(&first["data"], &second["data"], &[&was, value]))) {
            return None;
        }
    }
    tries.into_iter().next().map(|(name, _)| name)
}

/// Whether `data` says none of the words (three letters or more, letters only) of the values a call was given and its
/// page's address asks for. Values with no such word (a date, a number, a code of two) say nothing either way, and when
/// none has one, nothing is said.
pub(super) fn says_none_asked(data: &Value, given: &HashMap<String, String>, url: &str, path: &str) -> bool {
    // A word the site names its pages or its call by (`search` in `/search/iphone 15/`, `/certified-search`) is the
    // site's, not the ask: its answers say it whatever was asked.
    let path = path.to_lowercase();
    let pieces: Vec<String> = url::Url::parse(url).ok().and_then(|u| u.path_segments().map(|s| s.map(str::to_lowercase).collect())).unwrap_or_default();
    // Each value's words, said together: a value is said where one string says more than half its words (`macbook air`
    // by `MacBook Air M1`, not by every `Air Purifier`; a sentence by a page that leaves out one code of it).
    let words_of = |v: &str, the_sites: &dyn Fn(&String) -> bool| -> Vec<String> {
        v.split(|c: char| !c.is_alphanumeric())
            .map(str::to_lowercase)
            .filter(|w| w.chars().count() >= 3 && w.chars().all(char::is_alphabetic))
            .filter(|w| !the_sites(w))
            .collect()
    };
    let in_the_call = |w: &String| path.contains(w.as_str());
    let names_the_page = |w: &String| in_the_call(w) || pieces.contains(w);
    let mut words: Vec<Vec<String>> = given.values().map(|v| words_of(v, &names_the_page)).filter(|ws| !ws.is_empty()).collect();
    // A piece of the page's address is the site's own word (`search`) only beside a value that says more: where the
    // caller's one word is itself a piece of the address (`/search/climate`), it is the ask, and the answer is held to
    // it. Without it the answer would be judged by the page's settings alone (`?searching=all_posts`), which no answer
    // says.
    if words.is_empty() {
        words = given.values().map(|v| words_of(v, &in_the_call)).filter(|ws| !ws.is_empty()).collect();
    }
    words.extend(page_values(url).iter().map(|v| words_of(v, &names_the_page)).filter(|ws| !ws.is_empty()));
    // An empty list says nothing either way: the site may hold nothing for the ask.
    fn lists(v: &Value) -> bool {
        match v {
            Value::Array(a) => !a.is_empty(),
            Value::Object(o) => o.values().any(lists),
            _ => false,
        }
    }
    if words.is_empty() || !lists(data) {
        return false;
    }
    // The ask said back whole (a page's record of what it was searched for) is the page repeating its address, not an
    // answer that says it. It counts when it is a record's, one that holds a number beside it (an item and its id or
    // price), or when three records of a list or more say it (places each in the city asked for). A word is said where
    // a word of the string starts with it (`hair` doesn't say `air`).
    let wholes: Vec<String> = given.values().cloned().chain(page_values(url)).map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty()).collect();
    let mut said = Vec::new();
    strings(data, false, &mut said);
    // Nor is the page's own address, as its links back to itself carry it (`…?st=headphones#top`): that is where the
    // ask was put, not something the page said of it.
    let asked_at = url::Url::parse(url).ok();
    let own_address = |s: &str| {
        s.starts_with("http") && url::Url::parse(s).ok().zip(asked_at.as_ref()).is_some_and(|(link, page)| link.host_str() == page.host_str() && link.path().eq_ignore_ascii_case(page.path()))
    };
    !said.into_iter().map(|(s, counted)| (s.trim().to_lowercase(), counted)).filter(|(s, _)| !own_address(s)).filter(|(s, counted)| *counted || !wholes.contains(s) || records_saying(data, s) >= 3).any(|(s, _)| {
        let tokens: Vec<&str> = s.split(|c: char| !c.is_alphanumeric()).collect();
        words.iter().any(|ws| 2 * ws.iter().filter(|w| tokens.iter().any(|t| t.starts_with(w.as_str()))).count() > ws.len())
    })
}

/// Every string value in `v`, never its keys, each with whether the object holding it also holds a number.
fn strings(v: &Value, numbered: bool, out: &mut Vec<(String, bool)>) {
    match v {
        Value::String(s) => out.push((s.clone(), numbered)),
        Value::Array(a) => a.iter().for_each(|x| strings(x, false, out)),
        Value::Object(o) => {
            let numbered = o.values().any(Value::is_number);
            o.values().for_each(|x| strings(x, numbered && x.is_string(), out))
        }
        _ => {}
    }
}

/// The most records of any one list in `v` that hold the string `s` (compared without case).
fn records_saying(v: &Value, s: &str) -> usize {
    fn holds(v: &Value, s: &str) -> bool {
        match v {
            Value::String(x) => x.trim().to_lowercase() == s,
            Value::Array(a) => a.iter().any(|x| holds(x, s)),
            Value::Object(o) => o.values().any(|x| holds(x, s)),
            _ => false,
        }
    }
    match v {
        Value::Array(a) => a.iter().filter(|x| holds(x, s)).count().max(a.iter().map(|x| records_saying(x, s)).max().unwrap_or(0)),
        Value::Object(o) => o.values().map(|x| records_saying(x, s)).max().unwrap_or(0),
        _ => 0,
    }
}

/// Whether `data` answers the walk rather than this call: an input was given a new value, the answer says the old one,
/// and it says no word of the new one. A value too short to say anything by itself is passed over.
pub(super) fn answers_the_walk(route: &store::Route, given: &HashMap<String, String>, data: &Value, query: Option<&str>) -> bool {
    let text = std::cell::OnceCell::new();
    let words = |v: &str| v.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_lowercase).collect::<Vec<_>>();
    // The result list's query label only identifies an input if precisely one public input had that recorded value.
    // A filter and a search can start with the same word, even though changing the filter leaves the label alone.
    let labelled = query.and_then(|query| {
        let mut matching = route.inputs.iter().filter(|i| !i.secret && !i.file && i.default.as_deref().is_some_and(|was| query.trim().eq_ignore_ascii_case(was.trim())));
        let input = matching.next()?;
        matching.next().is_none().then_some((input.name.as_str(), query))
    });
    route.inputs.iter().any(|i| {
        let (Some(was), Some(now)) = (i.default.as_deref(), given.get(&i.name)) else { return false };
        if was == now {
            return false;
        }
        if labelled.is_some_and(|(name, query)| {
            name == i.name && !query.trim().eq_ignore_ascii_case(now.trim())
        }) {
            return true;
        }
        let (old, new) = (words(was), words(now));
        let text = text.get_or_init(|| data.to_string().to_lowercase());
        !old.is_empty() && !new.is_empty() && old.iter().all(|w| text.contains(w.as_str())) && !new.iter().any(|w| text.contains(w.as_str()))
    })
}

/// Compare the witnessed list and its own query. Without a stable list use the reply's selected fields.
pub(super) fn replay_answers_the_walk(route: &store::Route, given: &HashMap<String, String>, data: &Value, projected: &Value) -> bool {
    let Some((rows, query)) = route.heard.records_at.as_deref().and_then(|place| learn::confirm::stable_list_with_query(data, place)) else {
        return answers_the_walk(route, given, projected, None);
    };
    answers_the_walk(route, given, rows, query)
}

/// Whether a call's data holds what `goal` asks for that has a look of its own (a price, a link, a day).
pub(super) fn holds_goal(data: &Value, goal: &str) -> bool {
    use unbrowse_learn::goal as read;
    let fields = read::fields(goal);
    let state = data.get("state").filter(|s| !s.is_null());
    let page = data.get("text").is_some() && data.get("title").is_some();
    let holds = |h: read::Holding| h.has_shapes() && h.has_record_fields(goal, &fields);
    if page {
        let rendered = read::page_holding(data, &fields, &[]);
        return (rendered.has_shapes() && read::has_rendered_links(data)) || holds(rendered) || state.is_some_and(|s| holds(read::holding_for_goal(s, &fields, &[], goal)));
    }
    holds(read::holding_for_goal(data, &fields, &[], goal))
}

/// The routes that may answer `goal`. A route made from another contributor's body that writes answers only a goal
/// that asks for a change in its own words (`asks_a_change`): the one rule the network's call path holds the same goal
/// to (`ForGoal::reads_only`), so a goal that names no change ("the posts on my page") runs no stranger's write here
/// either (audit 1118 M8). A route this node learned that writes is dropped when the goal only reads (#25).
pub(super) fn reads_only<'a>(found: Vec<&'a store::Route>, goal: &str) -> Vec<&'a store::Route> {
    let change = unbrowse_learn::goal::asks_a_change(goal);
    let only_reads = unbrowse_learn::goal::only_reads(goal);
    found.into_iter().filter(|r| !r.write || if r.fetched.is_some() { change } else { !only_reads }).collect()
}

/// What to call `route` with: the url's query values for the inputs they name (`?q=rust` gives `q`; a fragment written
/// as a query, `#q=rust`, counts the same), the url's path
/// segments where a step of the route takes an input from its own path (`/c/shoes/` gives the input that step reads
/// there), the values a url that is one of the route's own calls sets where that call takes inputs, then the agent's
/// own, which win.
pub(super) fn inputs_for(route: &store::Route, url: &str, given: HashMap<String, String>) -> HashMap<String, String> {
    let Ok(u) = url::Url::parse(url) else { return given };
    let mut inputs: HashMap<String, String> =
        unbrowse_learn::trace::asked_pairs(&u).into_iter().filter(|(k, _)| route.inputs.iter().any(|i| i.name == *k)).collect();
    inputs.extend(path_inputs(route, &u));
    if let Some(read) = route.graph.steps.iter().rev().find_map(|s| call_inputs(s, &u)) {
        inputs.extend(read);
    }
    inputs.extend(given);
    inputs
}

/// Whether `route` does `url`'s page: the page it was learned on, or the address of one of the route's own calls,
/// differing from it only where the route takes an input. Whatever the hosts: a route learned on one page holds that
/// page's item wherever its call goes, so a page that differs from it in a value the route doesn't take is another
/// page, and the route would answer it with the first page's data.
pub(super) fn fits(route: &store::Route, url: &str) -> bool {
    let (Ok(u), Ok(root)) = (url::Url::parse(url), url::Url::parse(&route.root)) else { return true };
    let same_path = |a: &url::Url, b: &url::Url| a.path().trim_end_matches('/') == b.path().trim_end_matches('/');
    let takes = |k: &str| route.inputs.iter().any(|i| i.name == k);
    // Every value the url's query sets is the page's own, or one the route takes: a route learned from `?search=planet`
    // that never bound it answers only planet (#23), and one that never sends `hitsPerPage` can't do a page that asks
    // for it.
    let asked_on_the_walk = unbrowse_learn::trace::asked_pairs(&root);
    let query_fits = unbrowse_learn::trace::asked_pairs(&u).iter().all(|(k, v)| v.is_empty() || takes(k) || asked_on_the_walk.iter().any(|(rk, rv)| rk == k && rv == v));
    let the_page = u.host_str() == root.host_str()
        && u.port_or_known_default() == root.port_or_known_default()
        && query_fits
        && (same_path(&u, &root) || !path_inputs(route, &u).is_empty());
    the_page || route.graph.steps.iter().any(|s| call_inputs(s, &u).is_some())
}

/// The inputs `url` sets when it is the address of `step`, one of the route's own calls: the same host and path, each
/// piece and query value the one the call sends wherever it takes no input, and no query key the call never sends. A
/// value the call fills from the session or an earlier answer is the call's own. None when it isn't that call's
/// address, or when it would set one input to two values.
pub(crate) fn call_inputs(step: &unbrowse_learn::Step, u: &url::Url) -> Option<HashMap<String, String>> {
    use unbrowse_learn::{slots::Loc, Class};
    let at = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")).ok()?;
    if at.host_str() != u.host_str() || at.port_or_known_default() != u.port_or_known_default() {
        return None;
    }
    let class = |loc: &Loc| step.fields.iter().find(|f| &f.loc == loc).map(|f| &f.class);
    let pieces = |x: &url::Url| -> Vec<String> {
        let mut v: Vec<String> =
            x.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default();
        if v.last().is_some_and(|l| l.is_empty()) {
            v.pop();
        }
        v
    };
    let (want, got) = (pieces(&at), pieces(u));
    if want.len() != got.len() {
        return None;
    }
    let mut read: HashMap<String, String> = HashMap::new();
    let mut take = |name: &String, v: String| match read.get(name) {
        Some(was) if *was != v => false,
        _ => {
            read.insert(name.clone(), v);
            true
        }
    };
    for (k, (w, g)) in want.iter().zip(&got).enumerate() {
        let fits = match class(&Loc::Path(k)) {
            Some(Class::Input { name, .. }) => take(name, g.clone()),
            Some(Class::Constant { value, .. } | Class::Unconfirmed { value }) => value == g,
            None => w == g,
            Some(_) => false,
        };
        if !fits {
            return None;
        }
    }
    for (k, v) in u.query_pairs() {
        let fits = match class(&Loc::Query(k.to_string())) {
            Some(Class::Input { name, .. }) => take(name, v.to_string()),
            Some(Class::Constant { value, .. } | Class::Unconfirmed { value }) => *value == v,
            // A value an answer, the session, the page, the file or each call makes fits whatever it is.
            Some(Class::Derived { .. } | Class::Minted { .. } | Class::Computed | Class::Script { .. } | Class::Recipe { .. } | Class::Generated { .. } | Class::Fresh { .. } | Class::CookieIn { .. } | Class::File { .. } | Class::Piece { .. }) => true,
            None => at.query_pairs().any(|(ak, av)| ak == k && av == v),
        };
        if !fits {
            return None;
        }
    }
    Some(read)
}

/// The inputs a route's step takes from its path, read from `url`'s path: a step on the url's host whose path has as
/// many segments, the same as the route's own page wherever the step takes no input. Else, when the route's calls go
/// to another host, the route's own page read the same way: its pieces that hold an input's value (`page_inputs`).
pub(super) fn path_inputs(route: &store::Route, url: &url::Url) -> HashMap<String, String> {
    use unbrowse_learn::{slots::Loc, Class};
    let pieces = |u: &url::Url| -> Vec<String> {
        u.path_segments()
            .map(|s| s.filter(|s| !s.is_empty()).map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()).collect())
            .unwrap_or_default()
    };
    let segments = pieces(url);
    let root = url::Url::parse(&route.root).ok().filter(|r| r.host_str() == url.host_str()).map(|r| pieces(&r));
    for step in &route.graph.steps {
        // A step's address carries its holes as `{q}`/`{path[1]}`, which a URL parser refuses: read them as their
        // percent-encoded form, as the call's own address reader does. Without this a path taken from the caller never
        // matched (foodnetwork re-learned on a browser for every value of its search).
        let Ok(at) = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")) else { continue };
        if at.host_str() != url.host_str() {
            continue;
        }
        let shape = pieces(&at);
        let mut taken: HashMap<usize, &String> = step
            .fields
            .iter()
            .filter_map(|f| match (&f.loc, &f.class) {
                (Loc::Path(k), Class::Input { name, .. }) => Some((*k, name)),
                _ => None,
            })
            .collect();
        // A piece the step writes the caller's value into (`held`) is that input's too: a page that writes one value in
        // two places (`/tag/lamps/?q=lamps`), or inside marks of its own (`/search/lamps-`), is the same page asked
        // another value when the piece has moved, and an address for it is called, not walked again. What the site
        // puts around the value stays as it was: a piece without those marks is another address.
        let marks = |k: usize, sits: &str| -> Option<(String, String)> {
            step.fields.iter().find(|f| f.loc == Loc::Path(k)).and_then(|f| match &f.class {
                Class::Constant { value, .. } | Class::Unconfirmed { value } => {
                    let (piece, sits) = (value.to_lowercase(), sits.to_lowercase());
                    (!sits.is_empty() && piece.matches(sits.as_str()).count() == 1).then(|| piece.split_once(sits.as_str()).map(|(before, after)| (before.to_string(), after.to_string()))).flatten()
                }
                _ => None,
            })
        };
        let mut around: HashMap<usize, (String, String)> = HashMap::new();
        for h in &step.held {
            if let Loc::Path(k) = h.loc {
                if let Some(m) = marks(k, &h.sits).filter(|_| !taken.contains_key(&k)) {
                    taken.insert(k, &h.input);
                    around.insert(k, m);
                }
            }
        }
        // The value a piece holds between the site's marks, where the piece has them and something between.
        let between = |k: usize, piece: &str| -> Option<String> {
            let (before, after) = around.get(&k)?;
            let low = piece.to_lowercase();
            (low.len() > before.len() + after.len() && low.starts_with(before.as_str()) && low.ends_with(after.as_str())).then(|| piece[before.len()..piece.len() - after.len()].to_string())
        };
        if around.keys().any(|k| segments.get(*k).is_none_or(|piece| between(*k, piece).is_none())) {
            continue;
        }
        // Where the step writes the value with dashes for its spaces, the piece is read back with spaces for its dashes.
        let dashed = |k: usize| step.held.iter().any(|h| h.loc == Loc::Path(k) && h.written == unbrowse_learn::Written::Dashed);
        // A piece the step fills from elsewhere (an earlier answer) is the one its page had.
        let fixed = |k: usize, want: &String| match (want.starts_with('{'), &root) {
            (false, _) => Some(want.clone()),
            (true, Some(r)) => r.get(k).cloned(),
            (true, None) => None,
        };
        let fits = shape.len() == segments.len()
            && shape.iter().enumerate().all(|(k, want)| taken.contains_key(&k) || fixed(k, want).is_some_and(|w| w == segments[k]));
        if !fits {
            continue;
        }
        let read: HashMap<String, String> = taken
            .iter()
            .map(|(k, name)| {
                let value = match between(*k, &segments[*k]) {
                    Some(inside) if dashed(*k) => inside.replace('-', " "),
                    Some(inside) => inside,
                    None => as_value(route, name, root.as_ref().and_then(|r| r.get(*k)), &segments[*k]),
                };
                ((*name).clone(), value)
            })
            .collect();
        if !read.is_empty() {
            return read;
        }
    }
    page_inputs(route, url, &segments)
}

/// A piece of the url's path, `now`, as the value of input `name`, whose piece on the route's own page was `was`: read
/// as a form writes it (`ramen+tokyo` is "ramen tokyo") where the route learned that piece so, its value the piece
/// with spaces for its pluses (`slots::plus_spaced`). Else as it is.
fn as_value(route: &store::Route, name: &str, was: Option<&String>, now: &str) -> String {
    let default = route.inputs.iter().find(|i| i.name == name).and_then(|i| i.default.as_deref());
    match (was, default) {
        (Some(w), Some(d)) if !w.eq_ignore_ascii_case(d) && unbrowse_learn::slots::piece_holds(w, d) => unbrowse_learn::slots::plus_spaced(now).unwrap_or_else(|| now.to_string()),
        _ => now.to_string(),
    }
}

/// The inputs `url`'s path sets on the route's own page: the same host, as many pieces, and every piece the page's
/// own wherever the page's piece isn't an input's value. Inputs named for the page's query are its query's, never
/// its path's. The k-th piece holding a value is the k-th input holding it, so `/firecrawl/firecrawl` reads two.
pub(super) fn page_inputs(route: &store::Route, url: &url::Url, segments: &[String]) -> HashMap<String, String> {
    let Some(root) = url::Url::parse(&route.root).ok().filter(|r| r.host_str() == url.host_str()) else { return HashMap::new() };
    let mine: Vec<String> =
        root.path_segments().map(|s| s.filter(|s| !s.is_empty()).map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default();
    if mine.len() != segments.len() || mine == segments {
        return HashMap::new();
    }
    let asked_by_query: Vec<String> = unbrowse_learn::trace::asked_pairs(&root).into_iter().map(|(k, _)| k).collect();
    let holding = |v: &str| route.inputs.iter().filter(|i| !asked_by_query.contains(&i.name) && i.default.as_deref().is_some_and(|d| unbrowse_learn::slots::piece_holds(v, d))).collect::<Vec<_>>();
    let mut read: HashMap<String, String> = HashMap::new();
    for (k, (was, now)) in mine.iter().zip(segments).enumerate() {
        let before = mine[..k].iter().filter(|p| p.eq_ignore_ascii_case(was)).count();
        match holding(was).get(before) {
            Some(i) => {
                let now = as_value(route, &i.name, Some(was), now);
                match read.get(&i.name) {
                    Some(v) if *v != now => return HashMap::new(),
                    _ => {
                        read.insert(i.name.clone(), now);
                    }
                }
            }
            None if was != now => return HashMap::new(),
            None => {}
        }
    }
    read
}

/// The inputs `given` sets to something other than the route's own value that can't change what it answers
/// (`reaches_the_answer`). A value that goes nowhere near the answer must never look as if it was asked.
pub(super) fn unreached(route: &store::Route, given: &HashMap<String, String>) -> Vec<String> {
    route
        .inputs
        .iter()
        .filter(|i| given.get(&i.name).is_some_and(|v| Some(v) != i.default.as_ref()))
        // By the graph, or by the site's own word when it was asked (`Route::heard`). One the body a call runs asks is
        // sent by it (`run::calls_the_body`).
        .filter(|i| !unbrowse_learn::reaches_the_answer(&route.graph, &i.name) || route.heard.deaf.contains(&i.name))
        .filter(|i| !(crate::run::calls_the_body() && route.body.as_ref().is_some_and(|b| b.asked().contains(&i.name.as_str()))))
        .map(|i| i.name.clone())
        .collect()
}

/// The agent's inputs by the route's own names. A name the route doesn't take, but under which one of its calls sends
/// an input (`query`, for a route whose input `q` goes out as `?query=`), is that input. Any other name is ignored,
/// and comes back to be said in the reply: a value the call never sends must never look as if it were used.
pub(super) fn bind_inputs(route: &store::Route, given: HashMap<String, String>) -> (HashMap<String, String>, Vec<String>) {
    use unbrowse_learn::{slots::Loc, Class};
    let takes = |n: &str| route.inputs.iter().any(|i| i.name == n);
    let sent_as = |key: &str| {
        route.graph.steps.iter().flat_map(|s| &s.fields).find_map(|f| match (&f.loc, &f.class) {
            (Loc::Query(k) | Loc::Form(k), Class::Input { name, .. }) if k == key => Some(name.clone()),
            (Loc::Json(p) | Loc::Part(_, p), Class::Input { name, .. }) if !p.is_empty() && p.rsplit('/').next() == Some(key) => Some(name.clone()),
            (Loc::Part(k, p), Class::Input { name, .. }) if p.is_empty() && k == key => Some(name.clone()),
            _ => None,
        })
    };
    let mut bound: HashMap<String, String> = given.iter().filter(|(k, _)| takes(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut ignored = Vec::new();
    for (k, v) in given.into_iter().filter(|(k, _)| !takes(k)) {
        match sent_as(&k).filter(|name| !bound.contains_key(name)) {
            Some(name) => {
                bound.insert(name, v);
            }
            // Kept beside the route's own, where nothing reads it, so a vault login named for no input is still
            // refused by name.
            None => {
                bound.insert(k.clone(), v);
                ignored.push(k);
            }
        }
    }
    ignored.sort();
    (bound, ignored)
}

/// The first input `route` must have that neither `given` nor the route itself holds a value for.
pub(super) fn lacks_value(route: &store::Route, given: &HashMap<String, String>) -> Option<String> {
    let (bound, _) = bind_inputs(route, given.clone());
    route.inputs.iter().find(|i| !i.optional && i.default.is_none() && !bound.contains_key(&i.name)).map(|i| i.name.clone())
}

/// The routes in `found` that take every input in `given`, by name or by the name one of their calls sends it under;
/// all of `found` when none does.
pub(super) fn takes_all<'a>(found: Vec<&'a store::Route>, given: &HashMap<String, String>) -> Vec<&'a store::Route> {
    let taking: Vec<&store::Route> = found.iter().copied().filter(|r| bind_inputs(r, given.clone()).1.is_empty()).collect();
    if taking.is_empty() {
        found
    } else {
        taking
    }
}

pub(super) fn route_can_reuse_for_url(route: &store::Route, url: &str) -> bool {
    let Ok(page) = url::Url::parse(url) else { return true };
    let has_query_value = unbrowse_learn::trace::asked_pairs(&page).iter().any(|(_, v)| !v.is_empty());
    !has_query_value || !route.inputs.is_empty()
        || (!route.write && url::Url::parse(&route.root).is_ok_and(|root| root == page)
            && route.graph.steps.last().is_some_and(|step| reads_document_at(step, &page)))
}

/// What a plain request for `url` says (`learn::learn_plain`): a route when the page answers with data itself.
pub(super) async fn learn_plain(who: &str, url: &str, goal: &str) -> learn::Plain {
    let (who, url, goal) = (who.to_string(), url.to_string(), goal.to_string());
    tokio::task::spawn_blocking(move || learn::learn_plain(&url, &goal, &who)).await.unwrap_or(learn::Plain::Page(None))
}

/// Learns the call on `url` that answers `goal`: the node's browser walks the page once, and the call is kept.
/// The calls a page made, for the agent to read before it picks: a walk (or the walk this session already made), its
/// candidates with their method, host, path, size and the top-level keys of the answer, and — with `pick` — the route
/// kept from one candidate, named `what`. The index is the candidate's own, as the view names it.
pub(super) async fn do_walk(node: &Arc<Node>, a: &Agent, url: String, goal: String, pick: Option<u64>, what: String, session: String) -> Result<Value, Fail> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "walk: url is the page to walk".into()));
    }
    let id = if session.trim().is_empty() { learn::walk_key(&url) } else { session.trim().to_string() };
    // A walk is blocking (the browser) and builds its own runtime: it runs off the async worker, as a learn does.
    let who = a.name.clone();
    let n = node.clone();
    let (url2, id2) = (url.clone(), id.clone());
    let view = tokio::task::spawn_blocking(move || match learn::view(&n.walks, &id2) {
        Some(v) => Ok(v),
        None => learn::walk_as(&n.walks, &url2, &id2, &who, &|_| {}),
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let mut out = json!({ "walk": view.walk, "url": view.url, "site": view.site, "candidates": view.candidates });
    if let Some(index) = pick {
        let what = if what.trim().is_empty() { goal.trim().to_string() } else { what.trim().to_string() };
        let who = a.name.clone();
        let n = node.clone();
        let walk = view.walk.clone();
        let route = tokio::task::spawn_blocking(move || learn::keep_candidate(&n.walks, &walk, index as usize, &what, &who))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        out["route"] = route_json(&route);
        // A call an agent picked is held to the site as one the node picked is, behind the reply: its ties laid
        // out for a proposer, and a call that does not hear its caller tried as the page's own (`learn::links`).
        if !cfg!(test) {
            let (n, walk, id, url, goal) = (node.clone(), view.walk.clone(), route.id.clone(), url.clone(), if goal.trim().is_empty() { route.what.clone() } else { goal.clone() });
            learn::verification_begins(&url);
            super::asks::spawn_behind("hold_picked", move || learn::hold_picked(&n.walks, &walk, &id, &url, &goal));
        }
    }
    Ok(out)
}

pub(super) async fn learn_page(node: &Arc<Node>, who: &str, url: &str, goal: &str) -> Result<(store::Route, &'static str, String), Unlearned> {
    super::asks::phase("walk");
    let (asked_by, page, wanted) = (who.to_string(), url.to_string(), goal.to_string());
    let (n, who, url, goal) = (node.clone(), who.to_string(), url.to_string(), goal.to_string());
    // The walk ends when the ask gives up on it (`mcp::ask_stop`): its request cancelled or dropped. The blocking task
    // outlives the request's future, so the future's end is passed in as a flag, and the profile it held goes back.
    let stop = super::mcp::ask_stop();
    let unanswered = super::mcp::StopsUnlessAnswered(Some(stop.clone()));
    let out = tokio::task::spawn_blocking(move || unbrowse_learn::mint::stops_with(stop, || {
        let events = n.events.clone();
        // Pictures are their own small event (the window fetches the bytes); the rest is the eye's.
        let eye = move |e: learn::Eye| match &e {
            learn::Eye::Frame(note) => events.emit("frame", note),
            _ => events.tell("eye", &e),
        };
        // `learn::save_learned` logs what became of the route: learned, or an old record that stood.
        learn::learn_goal_walked(&n.walks, &url, &goal, &who, &eye, Some(&n))
    }))
    .await
    .map_err(|e| Unlearned::Hands(e.to_string()))?;
    unanswered.answered();
    node.events.emit("activity", ());
    let (route, by, walk) = out?;
    // The route answers now. Behind the answer it is held to a second walk of the page (`learn::verify_learned`):
    // an ask is not kept waiting for an experiment, and the next ask of this site waits for its verdict. A held second
    // look starts no thread and marks no site, so no later ask waits for a verdict.
    if !cfg!(test) && !learn::own_asks::held_at(learn::own_asks::Ask::SecondLook, "api::goal::learn_page") {
        let (n, who, url, goal, first, second) = (node.clone(), asked_by, page, wanted, route.clone(), walk.clone());
        learn::verification_begins(&url);
        // Work of this ask behind its reply (`asks::spawn_behind`), its walks ending on the ask's stop flag.
        super::asks::spawn_behind("second_look", move || {
            // The first answer goes first. The route was learned for an ask that is being answered now, and a route
            // that runs through the site's one browser found it held by this second walk: the answer timed out behind
            // the experiment it was meant not to wait for. Bounded, so a route nobody calls is still checked.
            let asked = std::time::Instant::now();
            let called = |id: &str| store::load_route(id).is_none_or(|r| r.stats.calls > first.stats.calls);
            while !called(&first.id) && asked.elapsed() < std::time::Duration::from_secs(90) {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            learn::verify_learned(&n.walks, &url, &goal, &who, &second, &first, Some(&n))
        });
    }
    Ok((route, by, walk))
}

/// The reply a learn's first answer makes when the walk answered (`learn::walks_answer`, `whole` as the site sent it):
/// shaped as a call's (`run::as_a_reply`), with `records` counted on the whole answer where the route's records were
/// seen (`run::records_where_seen`), as a call's reply carries it, so `unanswered` reads it alike.
pub(super) fn walk_served(route: &store::Route, inputs: &HashMap<String, String>, fields: &[String], whole: &crate::run::WholeAnswer, ms: u64) -> Value {
    let mut r = crate::run::as_a_reply(route, inputs, fields, whole.clone(), ms, true);
    if let Some(records) = crate::run::records_where_seen(route, &whole.data) {
        r["records"] = json!(records);
    }
    r
}

/// A learn's first reply from the walk's own answer (`whole`, as the site sent it), when it answers the ask as a call's
/// answer would (`unanswered`): the reply (`walk_served`), and the route's first answer written whole as a call's
/// sighting is (`sighted::called`, as `run.rs` writes one): the answer a later value's own call is held against (calls
/// first, `confirm::by_its_call`). None, and nothing written, where it doesn't answer.
pub(super) fn take_the_walks_answer(route: &store::Route, inputs: &HashMap<String, String>, fields: &[String], whole: &crate::run::WholeAnswer, ask: &Asked, ms: u64) -> Option<Value> {
    let r = walk_served(route, inputs, fields, whole, ms);
    if unanswered_from(&r, route, ask, Some(whole)).is_some() {
        return None;
    }
    learn::sighted::called(route, &HashMap::new(), Some(&whole.data), true, 0, 0);
    Some(r)
}

/// Whether a learn's first reply may be the walk's own answer for the value: the route's call writes nothing, so the
/// site answered it in the walk as it answers the call. Read from the route's call, never from the goal's wording: "the
/// front page's stories" names no read word and reads all the same. A call that writes is made, as before.
pub(super) fn takes_the_walks_answer(route: &store::Route) -> bool {
    !route.write
}

/// Who answered a learn's first reply when the walk did: the browser, for the value asked (`picked_by`, as a
/// confirming browse's reply says it). The route stands on that one sighting until its own first call confirms it.
pub(super) const BY_THE_WALK: &str = "the browser, for this value";

/// The route's own first call, made behind the reply the walk answered (`learn::walks_answer`): its confirmation by
/// use. Work of the ask (`asks::spawn_behind`: bounded by its wall, ended with its stop flag). A route that does not
/// answer on its own (a failed call, or an answer that is not the page's, `unanswered`) is judged wrong for the page
/// where the next ask reads it (`first_call_judged`), so it is never served warm for it: the page is walked again.
fn first_call_behind(node: &Arc<Node>, a: &Agent, route: &store::Route, inputs: &HashMap<String, String>, fields: &[String], url: &str, subject: &[String]) -> std::thread::JoinHandle<()> {
    let (n, a, route, inputs, fields, url, subject) = (node.clone(), a.clone(), route.clone(), inputs.clone(), fields.to_vec(), url.to_string(), subject.to_vec());
    let rt = tokio::runtime::Handle::current();
    super::asks::spawn_behind("first_call", move || {
        if unbrowse_learn::mint::stop_flag().is_some_and(|s| s.load(std::sync::atomic::Ordering::Relaxed)) {
            return;
        }
        // Called as the read it was when the walk answered (`do_call_as_seen`): a second look that has since written a
        // body that changes the site under the route's name is not this route, and nothing is sent.
        let (called, whole) = rt.block_on(call::with_the_browser_shut(true, call::with_call_answer(do_call_as_seen(&n, &a, route.id.clone(), inputs.clone(), fields, Some(route.write)))));
        let ask = Asked { url: &url, goal: &route.what, subject: &subject, reworded: false, sibling: false, given: &inputs };
        let why = match &called {
            Ok(r) => unanswered_from(r, &route, &ask, whole.as_deref()).map(|w| w.as_str().unwrap_or("its answer is not the page's").to_string()),
            Err((_, e)) => Some(e.clone()),
        };
        eprintln!("   [confirm] {}: its first call, behind the reply: {}", route.id, why.as_deref().map_or("answered on its own".to_string(), |w| format!("didn't answer on its own: {w}")));
        first_call_judged(&route.id, &url, why.as_deref());
    })
}

/// Writes what the route's first call behind the reply came to where the next ask of the page reads it: a call that
/// didn't answer on its own (`why`) judges the route wrong for the page (`store::WrongPage`, by the node), so the
/// next ask is not served by it warm; one that answered leaves the route as it stands.
pub(super) fn first_call_judged(route_id: &str, url: &str, why: Option<&str>) {
    let (Some(why), Some(page)) = (why, store::page_key(url)) else { return };
    let _ = store::update_route(route_id, |r| {
        let kept: Vec<store::WrongPage> = r.judged.wrong.iter().filter(|w| !r.same_page(&w.page, &page)).cloned().collect();
        r.judged.wrong = kept;
        r.judged.wrong.push(store::WrongPage { page: page.clone(), why: format!("its first call didn't answer on its own: {why}"), by: "the node".into(), at: store::now() });
    });
}

/// The reply to a learn whose only reader of the answer is the page's own code, on a machine that runs none
/// (`Unlearned::Runtime`): no route, from the sandbox's reader (`sandbox.no_runtime`, `sandbox.lacks`, `sandbox.not_confined`), with what the
/// owner can do and what answers meanwhile: the page in the node's browser, whose own code reads it.
pub(super) fn unheld(why: &str, url: &str) -> Value {
    unheld_with(why, url, unbrowse_learn::sandbox::unheld())
}

/// [`unheld`], with the sandbox's reader's answer given.
pub(super) fn unheld_with(why: &str, url: &str, u: Option<unbrowse_learn::sandbox::Unheld>) -> Value {
    let mut v = json!({ "how": "unheld", "why": why });
    if let Some(u) = &u {
        v["held_back"] = crate::outcome::held_back_with(u, "the page's own code runs in the node's browser: open the page with unbrowse_browse and read it there");
    }
    let from = u.as_ref().map(crate::outcome::unheld_from).unwrap_or("sandbox.unheld");
    Said::new(Outcome::NoRoute, from).then("unbrowse_browse", json!({ "do": ["open", url] })).put(&mut v);
    v
}

/// The reply to a value the site turned away to another page (`Unlearned::Elsewhere`): the site has nothing for it.
/// Said as `answered_empty` from its own reader, `learn.elsewhere`, never `call.data`'s: an agent tells "the site sent
/// the browser elsewhere for this value" from "the site answered with an empty list" by `outcome_from` and `how`.
pub(super) fn elsewhere(why: &str) -> Value {
    let mut v = json!({ "how": "elsewhere", "why": why });
    let (outcome, from) = Unlearned::Elsewhere(why.to_string()).outcome();
    Said::new(outcome, from).put(&mut v);
    v
}

/// The reply to a walk whose own answer lists nothing for the value (`Unlearned::Nothing`): the site answered, with
/// nothing for it, and no route was kept. `answered_empty`, from `learn.nothing`.
pub(super) fn nothing(why: &str) -> Value {
    let mut v = json!({ "how": "nothing", "why": why });
    let (outcome, from) = Unlearned::Nothing(why.to_string()).outcome();
    Said::new(outcome, from).put(&mut v);
    v
}

/// Pages a test makes slow, as a walk is: a do of one of them works for as long as it is told (or, told no time, until
/// its ask's stop flag is set), saying it walks, and answers as a learned route would. Nothing is walked or opened.
#[cfg(test)]
pub(crate) mod slow {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    pub(crate) struct Slow {
        takes: Option<std::time::Duration>,
        /// What the walk found, when it found nothing for the value (`Unlearned::Nothing`): the reply is that.
        nothing: Option<String>,
        /// How many dos of the page started.
        pub(crate) started: AtomicUsize,
        /// Whether one saw its ask's stop flag set.
        pub(crate) stopped: AtomicBool,
        /// The asks each worked for.
        pub(crate) asks: std::sync::Mutex<Vec<String>>,
    }

    static PAGES: std::sync::Mutex<Vec<(String, Arc<Slow>)>> = std::sync::Mutex::new(Vec::new());

    /// Makes a do of `url` take `takes`, or until its ask gives up.
    pub(crate) fn make(url: &str, takes: Option<std::time::Duration>) -> Arc<Slow> {
        let slow = Arc::new(Slow { takes, ..Slow::default() });
        PAGES.locked().push((url.to_string(), slow.clone()));
        slow
    }

    /// Makes a do of `url` a walk that finds nothing for its value, said `why`.
    pub(crate) fn finds_nothing(url: &str, why: &str) -> Arc<Slow> {
        let slow = Arc::new(Slow { takes: Some(std::time::Duration::ZERO), nothing: Some(why.to_string()), ..Slow::default() });
        PAGES.locked().push((url.to_string(), slow.clone()));
        slow
    }

    pub(super) async fn run(url: &str) -> Option<Result<Value, Failed>> {
        let slow = PAGES.locked().iter().find(|(u, _)| u == url).map(|(_, s)| s.clone())?;
        slow.started.fetch_add(1, Ordering::SeqCst);
        slow.asks.locked().extend(crate::api::asks::current().map(|a| a.id.clone()));
        crate::api::asks::phase("walk");
        let stop = super::super::mcp::ask_stop();
        let began = std::time::Instant::now();
        while slow.takes.is_none_or(|t| began.elapsed() < t) {
            if stop.load(Ordering::Relaxed) {
                slow.stopped.store(true, Ordering::SeqCst);
                return Some(Err(Failed::new(StatusCode::REQUEST_TIMEOUT, "the walk stopped: its ask gave up", Said::new(Outcome::Stopped, "ask.stop"))));
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        if let Some(why) = &slow.nothing {
            return Some(Ok(super::nothing(why)));
        }
        Some(Ok(json!({ "how": "learned", "picked_by": "a test", "route": { "id": "slow" }, "result": { "ok": true, "data": { "items": [{ "name": "desk lamp" }] } } })))
    }
}

#[cfg(test)]
#[path = "goal_cov_tests.rs"]
mod goal_cov_tests;
