//! Browsing by hand: the node's browser driven a step at a time, and asking the owner when a page needs them.

use super::*;

/// One command in the node's browser, for an agent that has to act on a page by hand. The node learns from it
/// mechanically, off the agent's path (`learn::learn_auto`): a call that sent what was typed as soon as it lands,
/// and a page that was only read when the agent leaves it. Closing the browser ends the flow first, while the
/// browser still holds the session the route will run with.
/// The browser made ready for `need` as `how` allows (`browsers::ensure`), else the failure saying what it lacks.
pub(super) async fn ready(node: &Arc<Node>, need: crate::browsers::Need, how: crate::browsers::Use) -> Result<(), Fail> {
    let n = node.clone();
    tokio::task::spawn_blocking(move || crate::browsers::ensure(&n, need, how)).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.map_err(browser_missing)
}

/// The page as actions, not text: each interactive element the browser's own snapshot names, with its stable ref, role,
/// accessible name, state and the commands it takes. Nothing is clicked and nothing is paid; a page that isn't open is
/// the same browser_missing a browse command would give.
pub(super) async fn do_observe(node: &Arc<Node>, a: &Agent, site: String, session: String, goal: String) -> Result<Value, Fail> {
    let reply = do_browse(node, a, vec!["snapshot".into(), "-i".into()], site.clone(), goal, &session).await?;
    let text = reply.get("output").and_then(|o| o.as_str()).unwrap_or_default();
    Ok(json!({
        "site": reply.get("site").cloned().unwrap_or(json!(site)),
        "elements": parse_snapshot(text),
    }))
}

/// The interactive elements in a snapshot (`- button "Go" [disabled, ref=e2]`): the ref the browser hands out, the role,
/// the accessible name, its state and what it takes. A line without a ref is text, not an action.
pub(crate) fn parse_snapshot(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_start().strip_prefix("- ").unwrap_or(line.trim_start());
        if line.is_empty() {
            continue;
        }
        let first = line.split_whitespace().next().unwrap_or("");
        let role = first.trim_end_matches(':');
        let name = {
            let after = line.find('"').map(|i| &line[i + 1..]).unwrap_or_default();
            after.find('"').map(|i| after[..i].replace("\\\"", "\"")).unwrap_or_default()
        };
        // The first bracket group is the element's own: a later one describes what it does (`clickable [cursor:pointer]`).
        let attrs = line.find('[').and_then(|open| line[open..].find(']').map(|close| &line[open + 1..open + close])).map(parse_attrs).unwrap_or_default();
        let Some(reference) = attrs.get("ref").cloned() else { continue };
        let mut v = json!({ "ref": reference, "role": role, "name": name, "actions": actions_for(role) });
        if let Some(value) = attrs.get("disabled") {
            v["disabled"] = json!(value != "false");
        }
        if let Some(value) = attrs.get("checked") {
            v["checked"] = json!(value != "false");
        }
        if let Some(value) = attrs.get("value") {
            v["value"] = json!(value);
        }
        out.push(v);
    }
    out
}

fn parse_attrs(body: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for part in body.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (k, v) = part.split_once('=').unwrap_or((part, "true"));
        let v = v.trim().trim_matches('"').trim_matches('\'');
        out.insert(k.trim().to_ascii_lowercase(), v.to_string());
    }
    out
}

/// What a role takes: the commands an agent can send at its ref.
fn actions_for(role: &str) -> Vec<&'static str> {
    match role {
        "textbox" | "searchbox" | "combobox" | "spinbutton" => vec!["fill", "type"],
        "checkbox" | "radio" | "switch" => vec!["check", "uncheck"],
        "select" | "listbox" => vec!["select"],
        "file" | "button-file" => vec!["upload"],
        "button" | "link" | "menuitem" | "tab" | "option" | "treeitem" => vec!["click"],
        _ => vec!["click"],
    }
}

pub(super) async fn do_browse(node: &Arc<Node>, a: &Agent, args: Vec<String>, site: String, goal: String, named: &str) -> Result<Value, Fail> {
    // Every command runs in the node's browser: none here is `browser_missing`, after fetching it when the owner lets
    // the node.
    ready(node, crate::browsers::Need::Hands, crate::browsers::Use::Auto).await?;
    let session = browse_session(a, named);
    if args.first().map(String::as_str) == Some("ask_owner") {
        return ask_owner(node, a, &args, &site, &session).await;
    }
    // A card goes into a checkout only once the owner approved paying with it there (`approve_checkout`); the
    // browser's own fill refuses one they haven't (`browse::fill_card`).
    if let Some(card) = crate::browse::card_fill(&args) {
        approve_checkout(node, a, &args, &site, &session, &card).await?;
    }
    let who = a.name.clone();
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let verb = args.first().cloned().unwrap_or_default();
    let closes = verb == "close";
    let leaves = matches!(verb.as_str(), "open" | "goto" | "navigate");
    // A command that acts on the page can send something: the reply waits for what it set off and for the learn, so
    // a route it made is named in this very reply and the agent can call it from the next step.
    let acts = matches!(verb.as_str(), "click" | "dblclick" | "press" | "fill" | "type" | "select" | "check" | "uncheck" | "upload");
    let learning = store::load_settings().map_while_browsing;
    let eye = {
        let events = node.events.clone();
        move |e: learn::Eye| match &e {
            learn::Eye::Frame(note) => events.emit("frame", note),
            _ => events.tell("eye", &e),
        }
    };
    let (who2, eye2, goal2, verb2, session2) = (who.clone(), eye.clone(), goal.clone(), verb.clone(), session.clone());
    let args_said = args.clone();
    let opened_for = goal.trim().to_string();
    let n = node.clone();
    let out = tokio::task::spawn_blocking(move || {
        let (goal, session) = (goal2, session2);
        let named = Some(site.as_str()).filter(|s| !s.is_empty());
        let on = crate::browse::site(&args, named, &session)?;
        // A site a card sits in is refused here, before the node does anything of its own in its pages (its passkey
        // guard, a look before a click): what `act` would refuse sets nothing off first. A card's own approved fill
        // goes on, held to the measurement (`browse::fill_card`).
        if crate::browse::card_fill(&args).is_none() {
            crate::browse::refuse_where_a_card_sits(&on, &args)?;
        }
        let card_held = crate::browse::site_holds_a_card(&on);
        // A goal names the flow it was given in. One given with a page to open is that page's: the flow being left
        // keeps its own, and is learned under it below.
        if !goal.trim().is_empty() && !leaves {
            crate::browse::set_goal(&on, &session, &goal);
        }
        // The flow being left (a tab closing, another page opening) is learned before the reply, so the reply names
        // what it learned: the agent judges it (`unbrowse_judge`) before a goal calls it.
        let leaving = (learning && (closes || leaves)).then(|| learn::leaving(&on, &session, started));
        if learning && (closes || leaves) {
            if let Some((r, sent)) = learn::learn_auto(&on, &session, Some(started), &who2, &eye2) {
                crate::browse::credit_learned(&on, &session, &r.id, sent);
            }
        }
        if closes {
            crate::browse::set_goal(&on, &session, "");
        }
        // From here, a call the browser sends is this session's step's, until another session's command starts.
        crate::browse::note_acted(&on, &session, started);
        // A site with a passkey in the vault gets the node's authenticator before the page can ask for it, and again
        // once a command has started its browser.
        if let Ok(keys) = n.key() {
            // The node's passkey guard is script it puts in the site's pages: none goes into a site a card sits in.
            if !card_held {
                crate::passkey::on_browse(&on, keys);
            }
            // A page may show a vault password before any is filled: the reply hides it all the same.
            crate::browse::know_vault(&on, keys)?;
        }
        // What the tab showed before a click, to tell after it whether the click did anything (`browse::came_to`).
        let tab = crate::browse::tab_of(&session);
        let clicks = matches!(verb2.as_str(), "click" | "dblclick");
        let before = if clicks { crate::browse::look(&on, &tab) } else { None };
        let done = match (crate::browse::card_fill(&args), crate::browse::vault_fill(&args)) {
            (Some(_), _) => n.key().and_then(|keys| crate::browse::fill_card(&args, named, &who2, &session, keys)),
            (None, Some(_)) => n.key().and_then(|keys| crate::browse::fill_from_vault(&args, named, &who2, &session, keys)),
            (None, None) => crate::browse::act(&args, named, &who2, &session),
        };
        if let Some(leaving) = leaving {
            leaving.over(done.is_ok());
        }
        if let (Ok(_), Ok(keys), false) = (&done, n.key(), card_held) {
            crate::passkey::on_browse(&on, keys);
            // A vault login filled is an *agent's* sign-in, and a passkey one could make would be a credential
            // stronger than the agent's own key: this arms nothing (`passkey::SignIn`). The owner's own sign-in
            // (`ask_owner`) is what enrols one, and `passkey enrol <site>` arms it by hand.
            if crate::browse::vault_fill(&args).is_some() {
                crate::passkey::signed_in(crate::passkey::SignIn::Agent, &on, keys);
            }
        }
        // Closing writes the calls the page never read the answers of: what the browsing made is read once more with them.
        if learning && closes && done.is_ok() {
            learn::note_setups(&on);
        }
        if learning && acts && done.is_ok() {
            // The browser logs a finished request only once it has settled (most of a second, and the next event
            // after): a click that may send what was typed waits long enough to see it, a fill less.
            let sends = !matches!(verb2.as_str(), "fill" | "type") && crate::browse::typed_on(&on);
            let quiet = std::time::Duration::from_millis(if sends { 2000 } else { 1000 });
            crate::browse::settle(&on, quiet, std::time::Duration::from_secs(6));
            if let Some((r, sent)) = learn::learn_now(&on, &session, &who2, &eye2) {
                crate::browse::credit_learned(&on, &session, &r.id, sent);
            }
        } else if before.is_some() && done.is_ok() {
            // What a click set off lands once the page goes quiet: the learn above waited for it; without one, this does.
            crate::browse::settle(&on, std::time::Duration::from_millis(1000), std::time::Duration::from_secs(6));
        }
        let came_now = || {
            let after = crate::browse::look(&on, &tab);
            crate::browse::came_to(&verb2, if leaves { args.get(1).map(String::as_str) } else { None }, before.as_ref(), after.as_ref())
        };
        let mut came = match &done {
            Ok(_) if clicks || leaves => came_now(),
            _ => crate::browse::Came::Done,
        };
        // A page opened onto the site's sign-in: the owner's own browser on this machine may be signed in to the site.
        // Its session is taken in and the page opened once more, so the owner isn't asked for what it already holds.
        let mut done = done;
        if let (true, crate::browse::Came::Walled { at }) = (leaves && !card_held, &came) {
            match crate::import::when_signed_out(&on) {
                Some(Ok(kept)) => {
                    eprintln!("   [browse] {on} sent the page to {at}; took in the owner's browser session ({} cookies) and opened it again", kept.cookies);
                    done = crate::browse::act(&args, named, &who2, &session);
                    came = if done.is_ok() { came_now() } else { crate::browse::Came::Done };
                }
                Some(Err(none)) => eprintln!("   [browse] {on} sent the page to {at}; the owner's browser holds no session for it: {none}"),
                None => {}
            }
        }
        done.map(|text| (on, text, came))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    node.events.emit("activity", ());
    // A command that timed out may still have done its work (a page that never goes quiet still loaded): the node
    // learns from what the browser did either way.
    let on = match &out {
        Ok((on, _, _)) => Some(on.clone()),
        Err(_) => crate::browse::last_site(&session),
    };
    if let (true, Some(on)) = (leaves && !learning, &on) {
        crate::browse::set_goal(on, &session, &goal);
    }
    if let (true, false, Some(on)) = (learning, closes, on) {
        let (n, session) = (node.clone(), session.clone());
        tokio::task::spawn_blocking(move || {
            if leaves {
                crate::browse::set_goal(&on, &session, &goal);
            }
            // What the command set off lands in the log once it settles. A command that acts on the page was learned
            // from before its reply; this catches what landed later still. A page just opened set nothing off: it is
            // learned when the agent leaves it, under the goal it was opened for, and reported then.
            if !leaves {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if let Some((r, sent)) = learn::learn_auto(&on, &session, None, &who, &eye) {
                    crate::browse::credit_learned(&on, &session, &r.id, sent);
                }
                // The browser is the truth for the session: what a step did to it (signed in, signed out, chose a
                // country) is what the site's routes run with from now on. A route that still read a members' page
                // after its browser had signed out was running on a copy the browser no longer held.
                let site = unbrowse_learn::identity::site_of(&on);
                let hosts: std::collections::BTreeSet<String> = store::load_routes().into_iter().map(|r| r.site).filter(|h| unbrowse_learn::identity::site_of(h) == site).collect();
                for host in hosts {
                    learn::refresh_jar(&host, &on);
                }
                // And what the node itself said of the site's routes before the step is said of a site that has
                // since been acted on: those routes get another try (`store::forget_node_verdicts`).
                store::forget_node_verdicts(&site);
            }
            n.events.emit("activity", ());
        });
    }
    let (on, output, came) = out.map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let mut reply = json!({ "site": on, "output": output });
    // A step that landed elsewhere than asked, or a click that changed nothing, isn't done: the page needs the owner.
    if let Some((said, ask)) = needs_owner(&came, &on) {
        reply["output"] = json!(said);
        reply["needs_owner"] = json!(true);
        reply["next"] = json!(["ask_owner", ask]);
    }
    // What this browsing has learned so far, and a route that already does what the page was opened for: from here the
    // agent calls the route, no more clicking through that flow.
    let routes = store::load_routes();
    let brief = |r: &store::Route| {
        let mut b = json!({ "route_id": r.id, "what": r.what, "inputs": r.inputs.iter().map(|i| &i.name).collect::<Vec<_>>(), "write": r.write });
        let files: Vec<&String> = r.inputs.iter().filter(|i| i.file).map(|i| &i.name).collect();
        if !files.is_empty() {
            b["file_inputs"] = json!(files);
        }
        b
    };
    // A route judged wrong for a page (by an agent, or by the node when the site showed it deaf to what was asked) is
    // never handed over as what the browsing learned or as the route for its goal.
    let routes: Vec<store::Route> = routes.into_iter().filter(|r| r.judged.wrong.is_empty()).collect();
    let learned: Vec<Value> = crate::browse::learned(&on, &session).iter().filter_map(|id| routes.iter().find(|r| &r.id == id)).map(brief).collect();
    let site = unbrowse_learn::identity::site_of(&on);
    let for_goal = Some(opened_for.as_str())
        .filter(|g| leaves && !g.is_empty())
        .and_then(|g| routes.iter().find(|r| route_matches_site(r, &site) && r.what.trim().eq_ignore_ascii_case(g)));
    if !learned.is_empty() {
        reply["learned"] = json!(learned);
    }
    if let Some(r) = for_goal {
        reply["route_for_goal"] = brief(r);
    }
    let mut notes: Vec<&str> = Vec::new();
    if !learned.is_empty() || for_goal.is_some() {
        notes.push("A route does this now: call it with unbrowse_call (route_id, inputs) instead of clicking through the flow again. Ask first when write is true.");
    }
    if crate::browse::runs_script(&args_said) {
        notes.push(EVAL_NOTE);
    }
    // A page that needs a person may be one the agent can see and finish itself: say so before it asks the owner.
    if reply.get("needs_owner").and_then(|v| v.as_bool()) == Some(true) {
        notes.push("Before ask_owner, try unbrowse_challenge: it shows you the page's check as a picture and takes your clicks one step at a time (look, click, drag, type, press, done). What the picture can't settle (a sign-in, a code only a person has) is the owner's.");
    }
    if !notes.is_empty() {
        reply["note"] = json!(notes.join(" "));
    }
    if closes {
        crate::browse::forget_learned(&on, &session);
    }
    Ok(reply)
}

/// What an `eval`'s reply says: the requests the agent's own script makes are never learned, and what is.
pub(super) const EVAL_NOTE: &str = "The requests your script makes (a fetch or an XHR of your own) are never learned: a call you wrote isn't the site's own. Drive the page instead (click, fill, press, select) and the call the site's page sends becomes a route.";

/// What the reply says, and what to ask the owner, when a step came to something the owner must do (`browse::came_to`).
fn needs_owner(came: &crate::browse::Came, site: &str) -> Option<(String, String)> {
    match came {
        crate::browse::Came::Done => None,
        crate::browse::Came::Unchanged => Some((
            "The click changed nothing: the page is at the same address and shows the same as before. A control that does nothing usually needs a sign-in, so this page needs the owner: ask_owner, then take a snapshot and carry on. Don't click it again.".into(),
            format!("sign in to {site}: the page's controls do nothing signed out"),
        )),
        crate::browse::Came::Walled { at } => Some((
            format!("The site sent the page to {at} instead of the one asked for, naming it to come back to: a sign-in or a check. The page needs the owner: ask_owner, and the page is yours again once they are done."),
            format!("sign in to {site}: it sent the page to its sign-in"),
        )),
    }
}

/// The browsing session an agent's command belongs to: its key, and the session it runs in (`session`: the MCP
/// session its client opened, else one it names, e.g. one per SDK client). Each session has its own tab in a site's
/// browser (`browse::tab_of`), so agents browsing the same site at once each read and drive their own page, even two
/// sharing one key; a key's commands that name no session share one tab, as before sessions.
pub(super) fn browse_session(a: &Agent, named: &str) -> String {
    format!("{}:{}", a.index, named.trim())
}

/// Asks the owner to approve paying with a card from the vault, and waits for their answer: the window shows them
/// the card, the site it goes to and, for a page, the page itself live, where they read the amount. Ok once they
/// approve; the agent hears a refusal or a lapse as the call's error, never the card.
pub(super) async fn ask_to_pay(node: &Arc<Node>, a: &Agent, on: &str, session: Option<&str>, pay: crate::hands::Pay) -> Result<(), Fail> {
    if store::load_settings().paused {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "the node is paused by its owner".into()));
    }
    if crate::hands::asks().iter().any(|x| x.site == on) {
        return Err((StatusCode::CONFLICT, format!("{on} is already waiting on the owner")));
    }
    let why = format!("approve paying with {} on {}", pay.card, pay.merchant);
    let (card, merchant) = (pay.card.clone(), pay.merchant.clone());
    store::log_activity(&store::Activity {
        at: store::now(),
        who: a.name.clone(),
        site: on.to_string(),
        what: format!("Asked you to {why}"),
        kind: "vault".into(),
        result: "waiting".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    let events = node.events.clone();
    // The window shows the checkout of the session asking, whichever session acts on the site meanwhile.
    let tab = session.map(crate::browse::tab_of);
    let answer = crate::hands::ask(on, tab.as_deref(), &why, &a.name, std::time::Duration::from_secs(crate::hands::ASK_WAIT), Some(pay), |ask| {
        events.tell("hands", &json!({ "kind": "ask", "site": ask.site, "ask": ask }));
        events.emit("activity", ());
    })
    .await;
    match answer {
        crate::hands::Answer::Done => Ok(()),
        crate::hands::Answer::Declined => Err((StatusCode::FORBIDDEN, format!("the owner declined paying with {card} on {merchant}: don't try the card again for this, tell the user"))),
        crate::hands::Answer::NoAnswer => {
            node.events.emit("hands", json!({ "kind": "lapsed", "site": on }));
            Err((StatusCode::REQUEST_TIMEOUT, format!("the owner didn't answer whether to pay with {card} on {merchant}, so nothing was filled: tell the user, and try again when they're there")))
        }
    }
}

/// The owner's yes to paying with `card` on the checkout page the agent's tab shows, asked once per page for one fill
/// sequence: a yes covers the card's fields in that document (`browse::card_approved_here`). What the owner is shown is
/// bound as the browser measures it over its own protocol (`checkout::measure`), never by script in the page: read once
/// the tab is locked and before they are asked, and again after, and every fill and the hand-off are held to it. From
/// the moment the owner is asked until they say the checkout is finished or dismissed, the site is held (`payhold`), and once
/// the card is in, the page is the owner's to submit.
async fn approve_checkout(node: &Arc<Node>, a: &Agent, args: &[String], site: &str, session: &str, card: &vault::CardRef) -> Result<(), Fail> {
    let (named, args2, session2, label) = (site.trim().to_string(), args.to_vec(), session.to_string(), card.label.clone());
    let asked = tokio::task::spawn_blocking(move || -> Result<Option<Checkout>, String> {
        let browser = crate::browse::site(&args2, Some(named.as_str()).filter(|s| !s.is_empty()), &session2)?;
        // The owner reads the amount and the order on this page: one an agent's script ran in is never shown to them,
        // nor held, nor measured.
        crate::browse::unscripted_for_a_card(&browser, &crate::browse::tab_of(&session2))?;
        let (on, page, measured) = crate::browse::checkout_of(&browser, &session2)?;
        // From the moment the owner is asked about a card for this site, the site and every host its checkout names
        // are held (`payhold`): nothing an agent sets off reaches them until the owner says the checkout is finished
        // or dismissed.
        let begins = crate::payhold::of(&browser).is_none();
        crate::browse::hold_checkout(&browser, &measured)?;
        // A hold that begins pauses every other page the agent has open in the node's browsers (`quiet`): their timers
        // and workers send nothing while the owner pays. The checkout's own tab is the owner's and stays live.
        if begins {
            let keep = crate::browse::target_of(&browser, &crate::browse::tab_of(&session2));
            for failed in crate::quiet::quiet(keep.as_deref()) {
                crate::payhold::warn(&browser, &format!("the node couldn't pause one of the agent's other pages or workers ({failed}); it connects nowhere while the checkout waits all the same"));
            }
        }
        // The owner already said yes to this card on this very page: its other fields ask nothing.
        if crate::browse::card_approved_here(&on, &label, &session2, &measured.document) {
            return Ok(None);
        }
        // The owner's window shows the checkout of the session asking.
        crate::browse::to_front(&browser, &session2);
        Ok(Some(Checkout { browser, on, page, measured }))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    match asked {
        None => Ok(()),
        Some(checkout) => ask_and_check(node, a, session, card, checkout).await,
    }
}

/// The checkout page a card approval is asked for, as the browser measured it before the owner was asked.
struct Checkout {
    browser: String,
    on: String,
    page: String,
    measured: crate::checkout::Measured,
}

/// The owner's answer on `checkout`, and the check that the page is still the one they were shown.
async fn ask_and_check(node: &Arc<Node>, a: &Agent, session: &str, card: &vault::CardRef, checkout: Checkout) -> Result<(), Fail> {
    let shown = card.shown().map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let held = crate::payhold::of(&checkout.browser).map(|h| crate::payhold::shown(&h)).unwrap_or_else(|| checkout.browser.clone());
    let over = Some(format!("the node can't vouch for the amount or the order this page shows: read them on the page. One yes covers filling this card here, now. Held for this checkout: {held}. From now until you say it is finished or dismissed, the agent can't act on these, no route reaches them, and the node changes nothing anywhere; the final look and the pay click are yours"));
    let answered = ask_to_pay(node, a, &checkout.browser, Some(session), crate::hands::Pay { card: shown, merchant: checkout.on.clone(), route: None, inputs: Vec::new(), over, amount: None }).await;
    // The owner's own "no" to the card dismisses the checkout; no answer leaves it held for them to finish or dismiss.
    if matches!(&answered, Err((StatusCode::FORBIDDEN, _))) {
        let _ = crate::payhold::release(&checkout.browser);
    }
    answered?;
    let (browser2, session2) = (checkout.browser.clone(), session.to_string());
    let (on, page, after) = tokio::task::spawn_blocking(move || crate::browse::checkout_of(&browser2, &session2))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    crate::checkout::same_order(&checkout.measured, &after, &[]).map_err(|e| (StatusCode::CONFLICT, format!("{e}: ask the owner again")))?;
    if on != checkout.on || page != checkout.page {
        return Err((StatusCode::CONFLICT, "the checkout moved while the owner decided: ask them again".into()));
    }
    crate::browse::approve_card(&checkout.browser, &checkout.on, &card.label, session, checkout.measured);
    Ok(())
}

/// `["ask_owner", what the agent needs]`: the page needs the owner (a sign-in the vault has no login for, a check only a
/// person can pass). The window shows them the site's page live, and they click and type on it themselves; the
/// agent's call waits until they give it back, or until its time is up. The agent hears how it went and where the
/// page is now, never what was typed. The session the owner earned stays in the site's profile.
pub(super) async fn ask_owner(node: &Arc<Node>, a: &Agent, args: &[String], site: &str, session: &str) -> Result<Value, Fail> {
    if store::load_settings().paused {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "the node is paused by its owner".into()));
    }
    let (why, wait) = crate::hands::parse_ask(args).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let (named, session2) = (site.trim().to_string(), session.to_string());
    let (on, held) = tokio::task::spawn_blocking(move || -> Result<(String, Option<String>), String> {
        let on = crate::browse::site(&["snapshot".to_string()], Some(named.as_str()).filter(|s| !s.is_empty()), &session2)?;
        crate::browse::cdp_of(&on).ok_or_else(|| format!("{on}'s browser isn't open: open the page that needs the owner first ([\"open\", \"https://…\"]), then ask_owner"))?;
        // A script the agent ran there could hear what the owner types: such a page never goes to the owner.
        if crate::browse::script_may_have_run(&on, crate::browse::Scope::Tab(&crate::browse::tab_of(&session2))) {
            return Err(crate::browse::SCRIPTED_FOR_THE_OWNER.to_string());
        }
        // A held checkout goes to the owner with what the node could and couldn't check of it, measured again now: the
        // final look and the pay click are theirs, and so is the end of the hold.
        let held = crate::browse::hand_over_note(&on, &session2);
        // The owner's window shows the page of the session asking, not whichever tab acted last.
        crate::browse::to_front(&on, &session2);
        Ok((on, held))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    if crate::hands::asks().iter().any(|x| x.site == on) {
        return Err((StatusCode::CONFLICT, format!("{on}'s page is already waiting on the owner")));
    }
    // The ask must reach the owner: a window watching the node shows it. With none, one is opened; when none comes,
    // the agent hears so now, not after a wait nobody can answer.
    let watching = node.events.clone();
    crate::hands::reach_owner(move || watching.watchers(), crate::hands::open_window, crate::hands::WINDOW_WAIT)
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    store::log_activity(&store::Activity {
        at: store::now(),
        who: a.name.clone(),
        site: on.clone(),
        what: format!("Asked you to take over the page: {why}"),
        kind: "hands".into(),
        result: "waiting".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    let events = node.events.clone();
    // The window shows the asking session's page while the ask waits, whichever session acts on the site meanwhile.
    let tab = crate::browse::tab_of(session);
    let why = match &held {
        Some(note) => format!("{why}. {note} Done says the checkout is finished and gives the site back to the agent; Can't do it keeps it held until you dismiss it."),
        None => why,
    };
    // What the owner had typed by hand on the site before the hand-over: a passkey is kept after it only if they typed
    // a secret during it, their own sign-in.
    let typed_before = crate::browse::owner_secrets_typed(&on);
    let answer = crate::hands::ask_alone(&on, Some(&tab), &why, &a.name, wait, |ask| {
        events.tell("hands", &json!({ "kind": "ask", "site": ask.site, "ask": ask }));
        events.emit("activity", ());
    })
    .await
    .ok_or((StatusCode::CONFLICT, format!("{on}'s page is already waiting on the owner")))?;
    let (s2, tab) = (on.clone(), crate::browse::tab_of(session));
    let url = tokio::task::spawn_blocking(move || crate::browse::page_url(&s2, Some(&tab))).await.ok().flatten().unwrap_or_default();
    // The owner just signed in by hand, on the page itself: a passkey the site offers to make next is theirs to keep.
    // This is the one place an enrolment arms itself, because it is the one sign-in that is the owner's own act. A
    // vault login an *agent* filled arms nothing (`passkey::signed_in`): a passkey signs in as the owner with no
    // password and no second factor, so an agent that could make one would hold a credential stronger than its key.
    // And a Done is a sign-in only when the owner typed a secret during the hand-over (a password, a code): an agent
    // can ask the owner for anything (a click, a check to solve), and the page it gets back must not keep the next
    // passkey the agent has the site make.
    if answer == crate::hands::Answer::Done {
        if let (true, Ok(keys)) = (crate::browse::owner_signed_in_since(&on, typed_before), node.key()) {
            crate::passkey::signed_in(crate::passkey::SignIn::Owner, &on, keys);
        }
        // The owner's own "done" on a held checkout's hand-off says it is finished: the one release besides their
        // finish or dismiss in the window (`checkout_release`).
        if held.is_some() {
            let _ = crate::payhold::release(&on);
        }
    }
    let (output, note) = match answer {
        crate::hands::Answer::Done => (
            "The owner did it on the page and gave it back.",
            "The page is yours again, in the same profile, signed in if the owner signed in. Take a snapshot (snapshot -i) and carry on. Nothing the owner typed is shown to you. If a login should be kept for next time, the owner can save it to the vault; then you sign in with its vault: reference.",
        ),
        crate::hands::Answer::Declined => ("The owner gave the page back without doing it.", "Don't ask again for the same thing straight away: tell the user what you needed."),
        crate::hands::Answer::NoAnswer => {
            node.events.emit("hands", json!({ "kind": "lapsed", "site": on }));
            ("The owner didn't answer in time.", "The page is as it was. Ask again later, or tell the user what you need them to do.")
        }
    };
    Ok(json!({ "site": on, "output": output, "owner": answer, "url": url, "waited_s": wait.as_secs(), "note": note }))
}


/// Shows a page that asks for a person and takes one step on it, as the agent says: the picture and the page's own
/// answer come back every time, so the agent sees what its step did. `look` only shows the page; a page given as `url`
/// is opened in the session first.
#[allow(clippy::too_many_arguments)]
pub(super) async fn do_challenge(
    node: &Arc<Node>,
    a: &Agent,
    action: String,
    site: String,
    session: String,
    url: String,
    x: Option<f64>,
    y: Option<f64>,
    to_x: Option<f64>,
    to_y: Option<f64>,
    text: Option<String>,
    key: Option<String>,
    ms: Option<u64>,
) -> Result<Value, Fail> {
    ready(node, crate::browsers::Need::Hands, crate::browsers::Use::Auto).await?;
    let session = browse_session(a, &session);
    let who = a.name.clone();
    let (action, site, url) = (action.trim().to_string(), site.trim().to_string(), url.trim().to_string());
    // What the agent asked for, read before the browser: a step that names no point reaches no one.
    let act = if action == "look" {
        None
    } else {
        Some(unbrowse_learn::challenge::Act::of(&action, x, y, to_x, to_y, text.as_deref(), key.as_deref(), ms).map_err(|e| (StatusCode::BAD_REQUEST, e))?)
    };
    let (sess, what) = (session.clone(), action.clone());
    let out = tokio::task::spawn_blocking(move || match act {
        None => crate::challenge::look(&who, &site, &sess, &url),
        Some(act) => crate::challenge::act(&who, &site, &sess, act),
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let out = out.map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let asks = out.get("asks").and_then(|v| v.as_bool()).unwrap_or(true);
    let said_site = out
        .get("url")
        .and_then(|u| u.as_str())
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(unbrowse_learn::identity::site_of))
        .unwrap_or_default();
    node.events.emit("activity", ());
    store::log_activity(&store::Activity {
        at: store::now(),
        who: a.name.clone(),
        site: said_site,
        what: if action == "look" { "Showed a page that asks for a person".to_string() } else { format!("Took a step on a page that asks for a person: {what}") },
        kind: "challenge".into(),
        result: if asks { "waiting" } else { "done" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(out)
}

#[cfg(test)]
mod observe_tests {
    use super::*;

    /// A snapshot line is an action: its ref, role, name, state and what it takes. A line with no ref is text.
    #[test]
    fn an_observed_page_is_actions_not_text() {
        let text = "- textbox \"Search\" [required, ref=e1]\n- button \"Go\" [disabled, ref=e2]\n- checkbox \"Remember\" [checked=true, ref=e3]\n- heading \"Flights\"";
        let els = parse_snapshot(text);
        assert_eq!(els.len(), 3, "{els:?}");
        assert_eq!(els[0]["ref"], "e1");
        assert_eq!(els[0]["role"], "textbox");
        assert_eq!(els[0]["name"], "Search");
        assert_eq!(els[0]["actions"], json!(["fill", "type"]));
        assert_eq!(els[1]["disabled"], true);
        assert_eq!(els[1]["actions"], json!(["click"]));
        assert_eq!(els[2]["checked"], true);
        assert_eq!(els[2]["actions"], json!(["check", "uncheck"]));
        let nested = parse_snapshot("- LabelText \"Stories\" [ref=e4] clickable [cursor:pointer, onclick]");
        assert_eq!(nested[0]["ref"], "e4", "{nested:?}");
        assert_eq!(nested[0]["role"], "LabelText");
        assert_eq!(nested[0]["name"], "Stories");
    }
}
