//! An agent's word on a route, from reading its answers (`unbrowse_judge`): a page it doesn't do, what its answer
//! really is, and which of the answer's fields are the answer. The agent that drives a page knows what it asked for and
//! can tell an empty list, a suggestion box or the wrong tab from it; the node keeps what the agent says rather than
//! match words to guess it, and the next `unbrowse_do` acts on it.

use super::*;

/// The longest name an agent gives a route, and the most fields and pages it keeps of what agents said.
const LONGEST_NAME: usize = 200;
const MOST_FIELDS: usize = 64;
const MOST_WRONG_PAGES: usize = 200;
/// The most values an agent wires in one call.
const MOST_LINKS: usize = 200;

/// A route as the agent wires it (`unbrowse_judge` with `links`): the agent read the route's values
/// (`unbrowse_inspect`) and its answers, and says of some what they are, in the words a proposer uses. It is a
/// proposal: the node applies it to the route's graph, checks it against the walk the route was learned from, and
/// asks the site, as walked and for a second value. Kept only when both answer and the second answer is its own;
/// otherwise nothing changes and the reply says why. Never for a route that writes.
pub(super) async fn do_wire(node: &Arc<Node>, a: &Agent, args: &Value) -> Result<Value, Fail> {
    let id = text_arg(args, "route_id");
    let route = store::load_route(&id).ok_or((StatusCode::NOT_FOUND, "no such route on this node: wire a route by the id an unbrowse_do or unbrowse_call reply named".to_string()))?;
    if route.listing.is_some() || route.fetched.is_some() {
        return Err((StatusCode::CONFLICT, "this route is another node's or is listed on the network as it is: its values are not rewired here".into()));
    }
    let said: Vec<(usize, String, String)> = args
        .get("links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| Some((l.get("step")?.as_u64()? as usize, l.get("at")?.as_str()?.trim().to_string(), l.get("is")?.as_str()?.trim().to_string())))
        .collect();
    let given = args.get("links").and_then(Value::as_array).map_or(0, Vec::len);
    if said.is_empty() || said.len() != given {
        return Err((StatusCode::BAD_REQUEST, "links is a list of {step, at, is}: the step as unbrowse_inspect numbers it, the value's place as unbrowse_inspect names it (at), and what it is".into()));
    }
    if said.len() > MOST_LINKS {
        return Err((StatusCode::BAD_REQUEST, format!("links takes at most {MOST_LINKS} values")));
    }
    let word = text_arg(args, "word").trim().to_string();
    let (n, before) = (node.clone(), (route.graph.steps.len(), route.graph.steps.iter().any(|s| s.is_page_signed())));
    let wired = tokio::task::spawn_blocking(move || learn::wired_by_an_agent(&n.walks, route, &said, Some(word.as_str()).filter(|w| !w.is_empty())))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|why| (StatusCode::CONFLICT, format!("{why}. Nothing was changed.")))?;
    let plain = !wired.graph.steps.iter().any(|s| s.is_page_signed());
    let note = format!("wired {given} value(s): {} step(s) where there were {}, {}", wired.graph.steps.len(), before.0, if plain { "all plain" } else { "a step still the page's to make" });
    store::log_activity(&store::Activity { at: store::now(), who: a.name.clone(), site: wired.site.clone(), what: format!("Wired {}", wired.what), kind: "judge".into(), result: "right".into(), ms: None, unb: None, tx: None, note: Some(note.clone()) });
    Ok(json!({
        "route": route_json(&wired),
        "judged": {
            "wrong_pages": wired.judged.wrong.iter().map(|w| json!({ "page": w.page, "why": w.why })).collect::<Vec<_>>(),
            "named": wired.judged.named,
            "fields": if wired.judged.fields { wired.fields.clone() } else { Vec::new() },
            "writes": wired.judged.writes,
        },
        "next": format!("Kept, on the site's word: {note}. The site answered the route as walked and for the second value with an answer of its own. Call it with unbrowse_call; read its values again with unbrowse_inspect."),
    }))
}

pub(super) fn do_judge(a: &Agent, args: &Value) -> Result<Value, Fail> {
    let id = text_arg(args, "route_id");
    let wrong = match text_arg(args, "verdict").as_str() {
        "wrong" => true,
        "right" => false,
        _ => return Err((StatusCode::BAD_REQUEST, "verdict is right or wrong".into())),
    };
    let url = text_arg(args, "url").trim().to_string();
    let why = text_arg(args, "why").trim().to_string();
    let what = text_arg(args, "what").split_whitespace().collect::<Vec<_>>().join(" ");
    let fields = list_arg(args, "fields");
    // Whether calling the route changes the site, as the agent saw it (R1.25): true marks it a write, false takes back
    // an earlier mark. A call the node's own rule counts as a write stays one either way.
    let writes = args.get("writes").and_then(Value::as_bool);
    // A route a newer one replaced answered the agent all the same, so it can still be judged.
    // It comes back only once the verdict is one the node keeps: a refused one leaves it retired.
    let route = store::load_route(&id)
        .or_else(|| store::load_retired(&id))
        .ok_or((StatusCode::NOT_FOUND, "no such route on this node: judge a route by the id an unbrowse_do or unbrowse_call reply named".to_string()))?;
    let page = match url.is_empty() {
        true => None,
        false => Some(store::page_key(&url).ok_or((StatusCode::BAD_REQUEST, "url isn't a page's address".to_string()))?),
    };
    if wrong && page.is_none() && what.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "say which page its answer was wrong for (url), or what its answer really is (what)".into()));
    }
    if wrong && page.is_some() && why.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "say why its answer was wrong for the page (why): the owner reads it".into()));
    }
    if what.chars().count() > LONGEST_NAME {
        return Err((StatusCode::BAD_REQUEST, format!("what is at most {LONGEST_NAME} characters")));
    }
    if fields.len() > MOST_FIELDS {
        return Err((StatusCode::BAD_REQUEST, format!("fields keeps at most {MOST_FIELDS} paths")));
    }
    // A path the route's answer doesn't have would empty every later answer, and the page would be learned again: it is
    // refused, by the shape the route's call answered with when it was learned. A route with no recorded shape (a page
    // read) takes the paths as given.
    if let Some(shape) = route.graph.steps.last().and_then(|s| s.response_shape.as_ref()).filter(|s| s.is_object() && !fields.iter().any(|f| f == unbrowse_learn::fields::ALL)) {
        let known = unbrowse_learn::fields::paths(shape);
        let holds = |f: &str| known.iter().any(|k| k.path == f || [".", "[]", "{}"].iter().any(|m| k.path.starts_with(&format!("{f}{m}"))));
        let missing: Vec<&str> = fields.iter().map(String::as_str).filter(|f| !holds(f)).collect();
        if !missing.is_empty() {
            let some: Vec<&str> = known.iter().take(4).map(|k| k.path.as_str()).collect();
            return Err((StatusCode::BAD_REQUEST, format!("the route's answer has no {}: give paths as the call's result names them (result.fields.returned and fields.more), such as {}", missing.join(", "), some.join(", "))));
        }
    }
    // A route on the network is named by its listing, which peers read: renaming it here would say one thing on this
    // node and another there.
    if !what.is_empty() && (route.listing.is_some() || route.fetched.is_some()) {
        return Err((StatusCode::CONFLICT, "this route is named by its listing on the network, so it isn't renamed here: judge the page wrong (url) instead, or report it with unbrowse_report".into()));
    }
    let by = a.name.clone();
    if store::load_route(&id).is_none() {
        let _ = store::restore_retired(&id);
    }
    let judged = store::update_route(&id, |r| {
        if let Some(page) = &page {
            let kept: Vec<store::WrongPage> = r.judged.wrong.iter().filter(|w| !r.same_page(&w.page, page)).cloned().collect();
            r.judged.wrong = kept;
            if wrong {
                r.judged.wrong.push(store::WrongPage { page: page.clone(), why: why.clone(), by: by.clone(), at: store::now() });
                let over = r.judged.wrong.len().saturating_sub(MOST_WRONG_PAGES);
                r.judged.wrong.drain(..over);
            }
        }
        if !what.is_empty() {
            r.what = what.clone();
            r.asked.clear();
            r.judged.named = true;
        }
        if !fields.is_empty() {
            r.fields = fields.clone();
            r.judged.fields = true;
        }
        if let Some(w) = writes {
            r.judged.writes = w;
            // The label the route is read back with (`store::relabel`), so a fetched route keeps every step's word.
            r.write = store::route_writes(r) || w;
        }
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
    .ok_or((StatusCode::NOT_FOUND, "the route was deleted meanwhile".to_string()))?;
    let mut said = Vec::new();
    if let Some(page) = &page {
        said.push(if wrong { format!("wrong for {page}: {why}") } else { format!("right for {page}") });
    }
    if !what.is_empty() {
        said.push(format!("renamed from \"{}\"", route.what));
    }
    if !fields.is_empty() {
        said.push(format!("{} default fields", fields.len()));
    }
    match writes {
        Some(true) => said.push("changes the site: a write from now on".into()),
        Some(false) => said.push("doesn't change the site".into()),
        None => {}
    }
    store::log_activity(&store::Activity {
        at: store::now(),
        who: a.name.clone(),
        site: judged.site.clone(),
        what: format!("Judged {}", judged.what),
        kind: "judge".into(),
        result: if wrong { "wrong" } else { "right" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(said.join("; ")),
    });
    let next = match (wrong, &page) {
        (true, Some(_)) => "unbrowse_do with your goal and this url now passes the route over: the node learns the page afresh, or opens it for your hands when loading it isn't enough. Drive it to what you want, and the call your steps send becomes the route.",
        (true, None) => "Kept: the route goes by its new name, so a goal in its old words no longer finds it. Give unbrowse_do a url to learn the route that does your goal.",
        (false, _) => "Kept: later calls of the route hand back these fields by default, and a page judged right is the route's again.",
    };
    Ok(json!({
        "route": route_json(&judged),
        "judged": {
            "wrong_pages": judged.judged.wrong.iter().map(|w| json!({ "page": w.page, "why": w.why })).collect::<Vec<_>>(),
            "named": judged.judged.named,
            "fields": if judged.judged.fields { judged.fields.clone() } else { Vec::new() },
            "writes": judged.judged.writes,
        },
        "next": next,
    }))
}
