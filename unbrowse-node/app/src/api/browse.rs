//! Browsing by hand: the node's browser driven a step at a time, and asking the owner when a page needs them.

use super::*;

/// One command in the node's browser, for an agent that has to act on a page by hand. The node learns from it
/// mechanically, off the agent's path (`learn::learn_auto`): a call that sent what was typed as soon as it lands,
/// and a page that was only read when the agent leaves it. Closing the browser ends the flow first, while the
/// browser still holds the session the route will run with.
/// The browser made ready for `need` as `how` allows (`browsers::ensure`), else the failure saying what it lacks.
pub(super) async fn ready(node: &Arc<Node>, need: crate::browsers::Need, how: crate::browsers::Use) -> Result<(), Fail> {
    // A public peer never opens a browser, for anyone (`gateway.calls-only`): what needs one needs the caller's own node.
    if crate::remote::public_home() || crate::remote::arrived_public() {
        return Err((StatusCode::FORBIDDEN, crate::remote::NEEDS_OWN_NODE.into()));
    }
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
            // The name ends at the first quote not escaped by a backslash before it.
            let end = after.char_indices().scan(false, |escaped, (i, c)| {
                let ends = c == '"' && !*escaped;
                *escaped = c == '\\' && !*escaped;
                Some((i, ends))
            });
            end.filter(|&(_, ends)| ends).map(|(i, _)| after[..i].replace("\\\"", "\"")).next().unwrap_or_default()
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

fn site_for_background_learn(result: Result<&str, &str>, stopped: bool, previous: impl FnOnce() -> Option<String>) -> Option<String> {
    match result {
        Ok(site) => Some(site.into()),
        Err(agent_browser_core::session::STOPPED) => None,
        Err(_) if stopped => None,
        Err(_) => previous(),
    }
}

pub(super) async fn do_browse(node: &Arc<Node>, a: &Agent, args: Vec<String>, site: String, goal: String, named: &str) -> Result<Value, Fail> {
    // A command whose words came as one item is the agent's to resend, said before any browser starts.
    if let Some(said) = crate::browse::words_run_together(&args) {
        return Err((StatusCode::BAD_REQUEST, said));
    }
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
    // A login the agent asks the owner for (`vault:ask:`) is in the vault before it is filled: asked of the owner in
    // their window when it isn't, then filled as the plain reference, so the rest of the step never sees the ask.
    let args = match ask_fill(&args) {
        Some((at, r)) => {
            ask_for_login(node, a, &args, &site, &session, &r).await?;
            let mut plain = args;
            plain[at] = r.name();
            plain
        }
        None => args,
    };
    let who = a.name.clone();
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let verb = args.first().cloned().unwrap_or_default();
    let closes = verb == "close";
    let leaves = matches!(verb.as_str(), "open" | "goto" | "navigate");
    // A command that acts on the page can send something, and the node learns from it after the reply, never before:
    // learning is secondary to the step. A route it made is named in the session's next reply (`browse::learned`).
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
    // The step ends on its ask's stop flag (`mint::stops_with`): a wait for the site's profile, a walk it starts.
    let stop = super::mcp::ask_stop();
    let command_stop = stop.clone();
    super::asks::phase("browse");
    let out = tokio::task::spawn_blocking(move || unbrowse_learn::mint::stops_with(command_stop, || {
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
        let leaving = (leaves || (learning && closes)).then(|| learn::leaving(&on, &session, started));
        if learning && (closes || leaves) {
            if let Some((r, sent)) = learn::learn_auto(&on, &session, Some(started), &who2, &eye2) {
                crate::browse::credit_learned(&on, &session, &r.id, sent);
            }
        }
        if unbrowse_learn::mint::asked_to_stop() {
            return Err(agent_browser_core::session::STOPPED.into());
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
        // Where the browsing log ends before the step: the step's own lines (the page it landed on, what a script
        // sent) are the ones after.
        let mark = crate::browse::log_mark(&on);
        // Whether the tab takes a vault fill before the step: a script that runs in it ends that, and the reply says so
        // before the agent finds out by a refused fill.
        let scripted_before = crate::browse::script_may_have_run(&on, crate::browse::Scope::Tab(&tab));
        let done = match (crate::browse::card_fill(&args), crate::browse::vault_fill(&args)) {
            (Some(_), _) => n.key().and_then(|keys| crate::browse::fill_card(&args, named, &who2, &session, keys)),
            (None, Some(_)) => n.key().and_then(|keys| crate::browse::fill_from_vault(&args, named, &who2, &session, keys, true)),
            (None, None) => crate::browse::act(&args, named, &who2, &session),
        };
        if let Some(leaving) = leaving {
            let reached = leaving.over(done.is_ok(), learning);
            if leaves && reached {
                // The command can stop after the tab already reached its new page. Record the goal before returning.
                crate::browse::set_goal(&on, &session, &goal);
                if done.is_err() {
                    crate::browse::browsed(&session, &on);
                }
            }
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
        // No learn here: the step's reply never waits for one (`learn_after` below runs it once the reply is out).
        // A click alone waits, and only for the page: what it set off lands once the site goes quiet, and the reply
        // says whether the click did anything (`browse::came_to`).
        if before.is_some() && done.is_ok() {
            crate::browse::settle(&on, std::time::Duration::from_millis(1000), std::time::Duration::from_secs(6));
        }
        // What the step came to, and the words naming the page it returned on when it waited past a door, read from
        // the step's own lines (those after `mark`).
        let came_of = |done: &Result<String, String>, mark: u64| -> (crate::browse::Came, Option<String>, Option<u16>) {
            // A navigation the browser never got the page for (no address, nothing listening) is a page that isn't
            // there, said as one, not a step that failed.
            let unreached = leaves && matches!(done, Err(e) if crate::browse::never_reached(e));
            let mut passed: Option<String> = None;
            let (came, status) = match done {
                Ok(_) if clicks || leaves => {
                    let asked = if leaves { args.get(1).map(String::as_str) } else { None };
                    // The document the tab shows, read from the step's lines; the page asked for when the tab shows
                    // none of the site's (the browser's own page for a site it couldn't reach). A click that loaded no
                    // page has none, and isn't waited on for one. A navigation is read until it lands on a page: past a
                    // door that only waits on its own code, and once its document is written (`browse::landed_settled`).
                    let read = || {
                        let after = crate::browse::look(&on, &tab);
                        let at = after.as_ref().map(|l| l.url.clone()).or_else(|| asked.map(String::from));
                        let landed = at.and_then(|at| match leaves {
                            true => crate::browse::landed_read(&on, mark, |lines| crate::browse::landed_in(lines, &at)),
                            false => crate::browse::landed_in(&crate::browse::lines_since(&on, mark), &at),
                        });
                        (after, landed)
                    };
                    let (after, landed, looks) = match leaves {
                        true => crate::browse::landed_settled(read, std::thread::sleep),
                        false => {
                            let (after, landed) = read();
                            (after, landed, 0)
                        }
                    };
                    // The program's words name the page it returned on: past a door, that was the door.
                    if looks > 0 {
                        passed = landed.as_ref().map(crate::browse::landed_said);
                    }
                    let status = landed.as_ref().map(|d| d.status);
                    (crate::browse::came_to_page(&verb2, asked, before.as_ref(), after.as_ref(), landed.as_ref()), status)
                }
                Err(_) if unreached => (crate::browse::Came::Gone { status: 0 }, Some(0)),
                _ => (crate::browse::Came::Done, None),
            };
            (came, passed, status)
        };
        let (mut came, mut passed, landed_status) = came_of(&done, mark);
        // A door that answered nothing, or refused while it decided, may be refusing a client with no window: the page
        // is opened once more in one, and the site says whether that was it. Once per site, never when the owner keeps
        // windows off, and the reply says which it was, with the answer it gave each way.
        let mut shown = None;
        if leaves && !closes && crate::browse::refused_a_client(landed_status) && !crate::browse::windowed(&on) && !crate::browsers::headless_only() {
            crate::browse::relaunch_in_a_window(&on);
            let mark2 = crate::browse::log_mark(&on);
            let again = crate::browse::act(&args, named, &who2, &session);
            let (c2, p2, s2) = came_of(&again, mark2);
            came = c2;
            passed = p2;
            shown = Some((landed_status, s2));
        }
        // A check at the very address asked for may be the page itself, an app whose first HTML is only a shell with
        // a check's widget in it (a help widget, a form further down): rendered, a working page shows its own
        // controls, where a check that stands in for the page shows little but its widget.
        if let (true, crate::browse::Came::Check { at }) = (leaves, &came) {
            if is_the_page_asked(args.get(1).map(String::as_str), at) {
                // An app draws its page after its shell loads: looked at a few times over a few seconds, not once.
                for look in 0..RENDER_LOOKS {
                    if look > 0 {
                        std::thread::sleep(RENDER_PAUSE);
                    }
                    let rendered = crate::browse::act(&["snapshot".to_string(), "-i".to_string()], named, &who2, &session).unwrap_or_default();
                    if renders_a_page_of_its_own(&rendered) {
                        came = crate::browse::Came::CarriesCheck { at: at.clone() };
                        break;
                    }
                }
            }
        }
        // A page opened onto the site's sign-in: the owner's own browser on this machine may be signed in to the site.
        // Its session is taken in and the page opened once more, so the owner isn't asked for what it already holds.
        let (mut done, mut mark) = (done, mark);
        if let (true, Some(at)) = (leaves && !card_held, signed_out_at(&came, args.get(1).map(String::as_str)).map(String::from)) {
            // The page's own host, not the site: a session cookie set for www.example.com is never sent to example.com,
            // so an import for the site alone finds none where the owner is signed in.
            let host = args.get(1).and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| on.clone());
            // Only on the owner's yes, asked in the node's window and naming this agent (`import::owner_lets`).
            match crate::import::when_signed_out(&host, &who2, |q| crate::import::ask_in_the_nodes_window(Some(&*n), q)) {
                Some(Ok(kept)) => {
                    eprintln!("   [browse] {on} sent the page to {at}; took in the owner's browser session ({} cookies) and opened it again", kept.cookies);
                    mark = crate::browse::log_mark(&on);
                    done = crate::browse::act(&args, named, &who2, &session);
                    (came, passed, _) = came_of(&done, mark);
                }
                Some(Err(none)) => eprintln!("   [browse] {on} sent the page to {at}; the owner's browser holds no session for it: {none}"),
                None => {}
            }
        }
        // A click that downloaded a file leaves the page as it was: it did what it was for.
        if let (true, crate::browse::Came::Unchanged, Ok(_)) = (clicks, &came, &done) {
            if let Some(name) = crate::browse::downloaded_in(&crate::browse::lines_since(&on, mark)) {
                came = crate::browse::Came::Done;
                done = Ok(format!("✓ Downloaded {name}: the browser saved it to its downloads folder"));
            }
        }
        let unreached = leaves && matches!(&done, Err(e) if crate::browse::never_reached(e));
        let done = match done {
            Err(e) if unreached => Ok(e),
            Ok(_) if passed.is_some() => Ok(passed.unwrap_or_default()),
            other => other,
        };
        // An eval's note on the requests a script sends is for one that sent some: read from the step's lines, looked
        // for as long as the browser program takes to write a finished request (`browse::script_sent`).
        let sent = done.is_ok() && crate::browse::runs_script(&args) && crate::browse::script_sent(&on, &tab, mark);
        let unfillable = no_fill_note(&args, scripted_before, done.is_ok()).is_some();
        // A login made by vault:new: is kept once the site accepted the sign-up, read after every step on the site.
        let kept = match n.key() {
            Ok(keys) => crate::browse::sign_ups_accepted(&on, |tab| crate::browse::asks_a_password(&on, tab), |r, who| crate::vault::keep_new(&crate::vault_keep(Ok(keys))?, r, who)),
            Err(_) => Vec::new(),
        };
        let waiting = crate::browse::sign_ups_waiting(&on);
        done.map(|text| (on, text, came, sent, unfillable, kept, waiting, shown))
    }))
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    node.events.emit("activity", ());
    // A command that timed out may still have done its work (a page that never goes quiet still loaded): the node
    // learns from what the browser did either way.
    let stopped = stop.load(std::sync::atomic::Ordering::Relaxed);
    let on = site_for_background_learn(out.as_ref().map(|(on, ..)| on.as_str()).map_err(String::as_str), stopped, || crate::browse::last_site(&session));
    if let (true, false, Some(on)) = (learning, closes, on) {
        let (n, session) = (node.clone(), session.clone());
        tokio::task::spawn_blocking(move || {
            // What the command set off lands in the log once it settles, and is learned from here, after the reply. A
            // page just opened set nothing off: it is learned when the agent leaves it, under the goal it was opened
            // for, and reported then.
            if !leaves {
                // One learn waits per session and site: steps that come faster than a learn takes are read together
                // by the one already waiting, and the last step is never the one skipped.
                if !learn_after(&on, &session) {
                    n.events.emit("activity", ());
                    return;
                }
                // The browser logs a finished request only once it has settled (most of a second, and the next event
                // after): a step that may send what was typed waits long enough to see it, a fill less.
                let sends = acts && !matches!(verb.as_str(), "fill" | "type") && crate::browse::typed_on(&on);
                let quiet = std::time::Duration::from_millis(if sends || !acts { 2000 } else { 1000 });
                crate::browse::settle(&on, quiet, std::time::Duration::from_secs(6));
                learn_starts(&on, &session);
                if let Some((r, sent)) = learn::learn_now(&on, &session, &who, &eye) {
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
    // A step the owner's pause stopped is the pause, not a step that failed.
    let (on, output, came, sent, unfillable, kept, waiting, shown) = out.map_err(|e| (if e == crate::outcome::PAUSED { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::UNPROCESSABLE_ENTITY }, e))?;
    let mut reply = json!({ "site": on, "output": output });
    // A step that landed elsewhere than asked, on a page that isn't there or asks for a person, or a click that
    // changed nothing, isn't done: the reply says where it landed, and what to do next.
    let owner = || crate::hands::owner_reach(node.events.watchers(), crate::browsers::headless_only()) != "off";
    if let Some(landed) = came_said(&came, &on, came != crate::browse::Came::Done && owner()) {
        reply["output"] = json!(landed.said);
        if landed.needs_owner {
            reply["needs_owner"] = json!(true);
        }
        landed.outcome.put(&mut reply);
    }
    // A fallback says so: the page was opened a second time in a window, and the reply names what each answer was.
    if let Some((before, after)) = shown {
        let note = match (came == crate::browse::Came::Done, before == after) {
            (true, _) => " (opened again in a window: the site refused this client without one)".to_string(),
            (false, true) => " (opened again in a window, and answered the same: a door refusing a client with no window is not what refused this one)".to_string(),
            (false, false) => format!(
                " (opened again in a window: the site answered {} without one and {} with one, so a door was refusing a client that shows no window)",
                before.map_or_else(|| "nothing".into(), |s| s.to_string()),
                after.map_or_else(|| "nothing".into(), |s| s.to_string())
            ),
        };
        if let Some(o) = reply["output"].as_str().map(str::to_string) {
            reply["output"] = json!(format!("{o}{note}"));
        }
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
    if let Some(note) = eval_note(&args_said, sent) {
        notes.push(note);
    }
    if unfillable {
        notes.push(NO_FILL_AFTER_A_SCRIPT);
    }
    if matches!(came, crate::browse::Came::CarriesCheck { .. }) {
        notes.push(CARRIES_A_CHECK);
    }
    let sign_up = sign_up_note(&kept, &waiting);
    if let Some(said) = &sign_up {
        notes.push(said.as_str());
    }
    // A page that needs a person may be one the agent can see and finish itself: say so before it asks the owner.
    if reply.get("needs_owner").and_then(|v| v.as_bool()) == Some(true) {
        if crate::solver::configured().is_some() {
            notes.push(SOLVER_CONFIGURED);
        }
        notes.push("Before ask_owner, try unbrowse_challenge: it shows you the page's check as a picture and takes your clicks one step at a time (look, click, drag, hold, type, press, solve, done). What the picture can't settle (a sign-in, a code only a person has) is the owner's.");
    }
    if !notes.is_empty() {
        reply["note"] = json!(notes.join(" "));
    }
    if closes {
        crate::browse::forget_learned(&on, &session);
    }
    Ok(reply)
}

/// What an open of a page that carries a check for a person among its own content says: it is the page, and the check
/// is met when it stands in the way, with unbrowse_challenge.
/// Said when a clearable check needs clearing and the owner configured a captcha solver: the node has a last
/// source for the wall beyond a person. The owner is still never asked to solve it.
pub(super) const SOLVER_CONFIGURED: &str = "A captcha solver is configured: unbrowse_challenge solve meets a checkbox, invisible or Turnstile check with it, no person needed.";

pub(super) const CARRIES_A_CHECK: &str = "This page carries a check for a person (a widget among its own fields): it is the page asked for. Fill and click as usual; when the check stands in the way (a submit stays disabled, or the check opens), meet it with unbrowse_challenge (solve first, else look, click, done) before ask_owner.";

/// The sessions with a learn waiting to start, by site: `learn_after` adds one, `learn_starts` takes it out as the
/// learn begins reading, so a step that comes while a learn runs queues the next and one that comes before it starts
/// is read by it.
static LEARN_WAITING: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// Whether this step is the one to run the learn after its reply: false when one already waits for the same session
/// on the same site, which will read this step's calls too.
fn learn_after(site: &str, session: &str) -> bool {
    let mut waiting = LEARN_WAITING.lock().unwrap_or_else(|p| p.into_inner());
    let key = (site.to_string(), session.to_string());
    if waiting.contains(&key) {
        return false;
    }
    waiting.push(key);
    true
}

/// The waiting learn begins: a step from here on queues another.
fn learn_starts(site: &str, session: &str) {
    LEARN_WAITING.lock().unwrap_or_else(|p| p.into_inner()).retain(|(s, w)| !(s == site && w == session));
}

/// What the reply to the first script in a tab says: the tab takes no vault fill from then on, and the order that keeps
/// one possible (`browse::no_secret_after_a_script`).
pub(super) const NO_FILL_AFTER_A_SCRIPT: &str = "Your script ran in this tab, so it takes no vault fill from now until it closes: what a script leaves on a page could hear what the node types. To fill a login, close this tab, open the page again and fill before any script; click, type and press run no code of yours, and so do unbrowse_challenge's steps for a human check, so the tab stays fillable.";

/// What a step on a site with a sign-up under way says of its new logins: the ones kept now the site accepted them,
/// and the ones not kept yet, so `unbrowse_logins` listing nothing for them is no surprise.
pub(super) fn sign_up_note(kept: &[String], waiting: &[String]) -> Option<String> {
    let mut said = Vec::new();
    if !kept.is_empty() {
        said.push(format!("The site accepted the sign-up: the vault keeps {} now.", kept.join(", ")));
    }
    if !waiting.is_empty() {
        said.push(format!("{} is kept once the site accepts the sign-up (a request that sent the password answered with success, and the page asks for no password), not before: until then vault:new: fills the same password again.", waiting.join(", ")));
    }
    (!said.is_empty()).then(|| said.join(" "))
}

/// The note on a step that ended the tab's fills: a script that ran (`ran`) in a tab no script had run in.
pub(super) fn no_fill_note(args: &[String], scripted_before: bool, ran: bool) -> Option<&'static str> {
    (crate::browse::runs_script(args) && !scripted_before && ran).then_some(NO_FILL_AFTER_A_SCRIPT)
}

/// What an `eval`'s reply says: the requests the agent's own script makes are never learned, and what is.
pub(super) const EVAL_NOTE: &str = "The requests your script makes (a fetch or an XHR of your own) are never learned: a call you wrote isn't the site's own. Drive the page instead (click, fill, press, select) and the call the site's page sends becomes a route.";

/// The note an eval's reply carries: that the requests its script sent are never learned, for a script that sent one
/// (`sent`, read from the step's lines of the browsing log). A script that sent nothing hears nothing of it.
pub(super) fn eval_note(args: &[String], sent: bool) -> Option<&'static str> {
    (crate::browse::runs_script(args) && sent).then_some(EVAL_NOTE)
}

/// What a step that didn't come to what it asked says: the words in place of the browser's, what it came to with the
/// call to make next, and whether the page needs the owner.
pub(super) struct Landed {
    pub(super) said: String,
    pub(super) outcome: crate::outcome::Said,
    pub(super) needs_owner: bool,
}

/// Whether `at` is the page `asked` named: the same host, path and query, whatever its fragment or a trailing slash.
fn is_the_page_asked(asked: Option<&str>, at: &str) -> bool {
    let (Some(a), Ok(b)) = (asked.and_then(|a| url::Url::parse(a).ok()), url::Url::parse(at)) else { return false };
    a.host_str() == b.host_str() && a.path().trim_end_matches('/') == b.path().trim_end_matches('/') && a.query() == b.query()
}

/// The controls a rendered page needs before it reads as a page of its own rather than a check standing in for one:
/// a check's own page has its widget and a button or two; a working page has its navigation, search and lists.
const A_PAGES_OWN_CONTROLS: usize = 12;

/// How many times, and how far apart, a check at the address asked for is looked at for a page of its own: an app's
/// shell draws the page a moment after it loads (Loom's library: a handful of controls at first, 34 a few seconds on).
const RENDER_LOOKS: usize = 6;
const RENDER_PAUSE: std::time::Duration = std::time::Duration::from_millis(800);

/// Whether a page's interactive snapshot (`snapshot -i`) shows a working page of its own: enough controls
/// ([`A_PAGES_OWN_CONTROLS`]) besides any frame a check sits in.
fn renders_a_page_of_its_own(snapshot: &str) -> bool {
    snapshot.lines().filter(|l| l.contains("[ref=") && !l.trim_start().starts_with("- Iframe")).count() >= A_PAGES_OWN_CONTROLS
}

/// Where a page opened onto the site's sign-in, when it did: a page the site sent it to naming it to come back to, or
/// another page that asks for a password, and also a check for a person the site sent it to that way (a sign-in form
/// with a captcha on it). Signed in, the owner's own session gets past both, so the check is no reason to stop first.
fn signed_out_at<'a>(came: &'a crate::browse::Came, asked: Option<&str>) -> Option<&'a str> {
    match came {
        crate::browse::Came::Walled { at } | crate::browse::Came::SignIn { at } => Some(at),
        crate::browse::Came::Check { at } => {
            let (asked, landed) = (url::Url::parse(asked?).ok()?, url::Url::parse(at).ok()?);
            unbrowse_learn::answer::detour(&asked, &landed).then_some(at.as_str())
        }
        _ => None,
    }
}

/// What the reply says when a step came to something other than done (`browse::came_to_page`): a page that isn't there
/// is gone, with nothing to do on it; a check for a person is the agent's to try (`unbrowse_challenge`); a sign-in, a
/// wall or a click that changed nothing needs the owner (`ask_owner`), where the owner can be asked (`can_ask`, as
/// `unbrowse_whoami`'s owner says it). Where they can't, no next names ask_owner: a sign-in or a wall is
/// `owner_unavailable`, and the words say to tell the user what the page needs.
pub(super) fn came_said(came: &crate::browse::Came, site: &str, can_ask: bool) -> Option<Landed> {
    use crate::browse::Came;
    use crate::outcome::{Outcome, Said};
    const NO_OWNER: &str = " The owner keeps windows off this node, so ask_owner is refused: tell the user what the page needs instead.";
    let owner = |said: String, outcome: Outcome, from: &'static str, ask: String| match can_ask {
        true => Landed { said, outcome: Said::new(outcome, from).then("unbrowse_browse", json!({ "do": ["ask_owner", ask], "site": site })), needs_owner: true },
        false => Landed {
            said: said + NO_OWNER,
            outcome: Said::new(if outcome == Outcome::NeedsPerson { Outcome::OwnerUnavailable } else { outcome }, "owner.reach"),
            needs_owner: true,
        },
    };
    Some(match came {
        Came::Done | Came::CarriesCheck { .. } => return None,
        // A click that changed nothing needs hands the agent hasn't got; a page sent to a sign-in or a check, a person.
        Came::Unchanged => owner(
            "The click changed nothing: the page is at the same address and shows the same as before. A control that does nothing usually needs a sign-in, so this page needs the owner: ask_owner, then take a snapshot and carry on. Don't click it again.".into(),
            Outcome::NeedsHands,
            "browse.came_to",
            format!("sign in to {site}: the page's controls do nothing signed out"),
        ),
        Came::Walled { at } => owner(
            format!("The site sent the page to {at} instead of the one asked for, naming it to come back to: a sign-in or a check. The page needs the owner: ask_owner, and the page is yours again once they are done."),
            Outcome::NeedsPerson,
            "browse.came_to",
            format!("sign in to {site}: it sent the page to its sign-in"),
        ),
        Came::SignIn { at } => owner(
            format!("The page landed on {at} instead of the one asked for, and it asks for a password: a sign-in. Fill it from the vault when unbrowse_logins lists a login for {site}; else the page needs the owner: ask_owner, and the page is yours again once they are done."),
            Outcome::NeedsPerson,
            "browse.landed.sign_in",
            format!("sign in to {site}: it sent the page to its sign-in"),
        ),
        Came::Check { at } => Landed {
            said: format!("The page landed on {at}, a check that asks for a person, not the page asked for. Try it yourself with unbrowse_challenge (look, then click, drag, hold, type, press, done); what the picture can't settle is the owner's: ask_owner."),
            outcome: Said::new(Outcome::Challenge, "browse.landed.check").then("unbrowse_challenge", json!({ "action": "look", "site": site })),
            needs_owner: false,
        },
        Came::Gone { status: 0 } => Landed {
            said: "The page didn't load: the browser's connection to the site failed, and it shows its own error page. That is the machine offline, an address that doesn't resolve, or the site cutting the connection, which is how some sites refuse a client they read as a robot (the other sites' pages still load). There is nothing on it to drive.".into(),
            outcome: Said::new(Outcome::Gone, "browse.landed.status"),
            needs_owner: false,
        },
        Came::Gone { status } => Landed {
            said: format!("The page answered {status}: the site's error page, not the page asked for. There is nothing on it to drive; check the address."),
            outcome: Said::new(Outcome::Gone, "browse.landed.status"),
            needs_owner: false,
        },
    })
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
        return Err((StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED.into()));
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

/// The `vault:ask:` login a command fills, if it is `fill <target> vault:ask:<site>:<account>`, and where it sits.
fn ask_fill(args: &[String]) -> Option<(usize, vault::Ref)> {
    (args.len() == 3 && args[0] == "fill").then(|| vault::ask_ref(&args[2]).map(|r| (2, r))).flatten()
}

/// Whether the vault can fill `r` now: it lists the login, or can read its password (`vault::secret_for`, which may
/// look further than the list).
fn vault_can_fill(n: &Node, r: &vault::Ref) -> bool {
    if vault::list().iter().any(|l| l.site == r.site && l.account == r.account) {
        return true;
    }
    n.key().and_then(|keys| crate::vault_keep(Ok(keys)).and_then(|keep| vault::secret_for(&keep, keys, r))).is_ok()
}

/// `fill <target> vault:ask:<site>:<account>` (`vault.ask-owner`): the login for an account that already exists, which
/// the vault doesn't hold. The owner is asked for it in their window, which opens its Add login form with the site and
/// account filled in; the password goes from that form into the vault and never passes through the agent, its
/// conversation or this reply. The ask is answered once the vault holds the login (`hands::login_added`), and the fill
/// then goes on as `vault:<site>:<account>`. Asked only on a page the login may be typed into, so the owner is never
/// asked for a password the node then refuses to type.
async fn ask_for_login(node: &Arc<Node>, a: &Agent, args: &[String], site: &str, session: &str, r: &vault::Ref) -> Result<(), Fail> {
    if store::load_settings().paused {
        return Err((StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED.into()));
    }
    let (named, args2, session2, r2, n) = (site.trim().to_string(), args.to_vec(), session.to_string(), r.clone(), node.clone());
    let asked = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        if vault_can_fill(&n, &r2) {
            return Ok(None);
        }
        let on = crate::browse::site(&args2, Some(named.as_str()).filter(|s| !s.is_empty()), &session2)?;
        let page = crate::browse::page_url(&on, Some(&crate::browse::tab_of(&session2))).ok_or("open the login page first")?;
        if !r2.fits_page(&page) {
            return Err(format!("{} is a login for {}, and this page isn't one it may be typed into (its own site, over https): open the sign-in page of {} first. The owner wasn't asked.", r2.name(), r2.site, r2.site));
        }
        // The owner's window shows the page of the session asking, under the ask.
        crate::browse::to_front(&on, &session2);
        Ok(Some(on))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let Some(on) = asked else { return Ok(()) };
    if crate::hands::asks().iter().any(|x| x.site == on) {
        return Err((StatusCode::CONFLICT, format!("{on}'s page is already waiting on the owner")));
    }
    let watching = node.events.clone();
    crate::hands::reach_owner(move || watching.watchers(), crate::hands::open_window, crate::hands::WINDOW_WAIT)
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    let why = format!("add the login for {} on {} to the vault", r.account, r.site);
    store::log_activity(&store::Activity {
        at: store::now(),
        who: a.name.clone(),
        site: on.clone(),
        what: format!("Asked you to {why}"),
        kind: "vault".into(),
        result: "waiting".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    let events = node.events.clone();
    let tab = crate::browse::tab_of(session);
    let login = crate::hands::Login { site: r.site.clone(), account: r.account.clone() };
    let answer = crate::hands::ask_login(&on, Some(&tab), &why, &a.name, std::time::Duration::from_secs(crate::hands::ASK_WAIT), login, |ask| {
        events.tell("hands", &json!({ "kind": "ask", "site": ask.site, "ask": ask }));
        events.emit("activity", ());
    })
    .await
    .ok_or((StatusCode::CONFLICT, format!("{on}'s page is already waiting on the owner")))?;
    match answer {
        crate::hands::Answer::Done if vault::list().iter().any(|l| l.site == r.site && l.account == r.account) => Ok(()),
        crate::hands::Answer::Done => Err((StatusCode::CONFLICT, format!("the owner answered, but the vault still has no login for {} on {}: nothing was filled. Tell the user.", r.account, r.site))),
        crate::hands::Answer::Declined => Err((StatusCode::FORBIDDEN, format!("the owner declined to add the login for {} on {}: don't ask again straight away, tell the user", r.account, r.site))),
        crate::hands::Answer::NoAnswer => {
            node.events.emit("hands", json!({ "kind": "lapsed", "site": on }));
            Err((StatusCode::REQUEST_TIMEOUT, format!("the owner didn't add the login for {} on {} in time, so nothing was filled: tell the user, and try again when they're there", r.account, r.site)))
        }
    }
}

/// `["ask_owner", what the agent needs]`: the page needs the owner (a sign-in the vault has no login for, a check only a
/// person can pass). The window shows them the site's page live, and they click and type on it themselves; the
/// agent's call waits until they give it back, or until its time is up. The agent hears how it went and where the
/// page is now, never what was typed. The session the owner earned stays in the site's profile.
pub(super) async fn ask_owner(node: &Arc<Node>, a: &Agent, args: &[String], site: &str, session: &str) -> Result<Value, Fail> {
    if store::load_settings().paused {
        return Err((StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED.into()));
    }
    let (why, wait) = crate::hands::parse_ask(args).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    // The owner's answer is waited for as long as the agent asked, behind a still-working reply (`api::asks`): the
    // agent's call is answered within the minute an MCP client waits, and the owner's wait isn't ended by the wall
    // other work behind a reply meets. A minute is added for the window to come up and the page to be read after.
    if let Some(ask) = super::asks::current() {
        ask.goes_on_for(wait + crate::hands::WINDOW_WAIT + std::time::Duration::from_secs(60));
    }
    super::asks::phase("owner");
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
    // UNB-147: with remote answers on (off by default), a device of the owner's that answers away from the machine
    // (the daemon hub's Telegram bot, calling `remote_answers` with `via`) reaches them too.
    let watching = node.events.clone();
    let away = crate::hands::away_there() && crate::owner_dialog::remote_answers(node.key().ok().map(|k| k as &dyn unbrowse_core::KeyStore)).on;
    crate::hands::reach_owner(move || watching.watchers() + usize::from(away), crate::hands::open_window, crate::hands::WINDOW_WAIT)
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
    let asked_at = std::time::Instant::now();
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
    Ok(json!({ "site": on, "output": output, "owner": answer, "url": url, "waited_s": asked_at.elapsed().as_secs().min(wait.as_secs()), "note": note }))
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
    quick: bool,
    steps: Vec<Value>,
) -> Result<Value, Fail> {
    ready(node, crate::browsers::Need::Hands, crate::browsers::Use::Auto).await?;
    let session = browse_session(a, &session);
    let who = a.name.clone();
    let (action, site, url) = (action.trim().to_string(), site.trim().to_string(), url.trim().to_string());
    // A batch of hand steps lands over one browser attachment (a captcha grid's clicks + Confirm inside a short timer).
    let mut batch_acts = Vec::new();
    for s in &steps {
        let g = |k: &str| s.get(k);
        let act = unbrowse_learn::challenge::Act::of(
            g("action").and_then(Value::as_str).unwrap_or("click"),
            g("x").and_then(Value::as_f64), g("y").and_then(Value::as_f64),
            g("to_x").and_then(Value::as_f64), g("to_y").and_then(Value::as_f64),
            g("text").and_then(Value::as_str), g("key").and_then(Value::as_str),
            g("ms").and_then(Value::as_u64),
        ).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        batch_acts.push(act);
    }
    // What the agent asked for, read before the browser: a step that names no point reaches no one.
    let act = if action == "look" || !batch_acts.is_empty() {
        None
    } else {
        Some(unbrowse_learn::challenge::Act::of(&action, x, y, to_x, to_y, text.as_deref(), key.as_deref(), ms).map_err(|e| (StatusCode::BAD_REQUEST, e))?)
    };
    let (sess, what) = (session.clone(), action.clone());
    let out = tokio::task::spawn_blocking(move || {
        if !batch_acts.is_empty() {
            return crate::challenge::batch(&who, &site, &sess, batch_acts);
        }
        match act {
            None => crate::challenge::look(&who, &site, &sess, &url),
            Some(act) if quick => crate::challenge::act_quick(&who, &site, &sess, act),
            Some(act) => crate::challenge::act(&who, &site, &sess, act),
        }
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

    #[test]
    fn a_cancelled_command_error_does_not_fall_back_to_the_last_site() {
        let previous = || Some("before.example".to_string());
        assert_eq!(site_for_background_learn(Err(agent_browser_core::session::STOPPED), false, previous), None);
        assert_eq!(site_for_background_learn(Err("the browser did not start"), true, previous), None);
        assert_eq!(site_for_background_learn(Err("the browser timed out"), false, previous).as_deref(), Some("before.example"));
        assert_eq!(site_for_background_learn(Ok("after.example"), false, previous).as_deref(), Some("after.example"));
        assert_eq!(site_for_background_learn(Ok("after.example"), true, previous).as_deref(), Some("after.example"));
    }

    /// Loom's library, opened signed in, was told "a check that asks for a person, not the page asked for": its first
    /// HTML is an app's shell with a check's widget in it. At the address asked, a page that renders its own controls
    /// is the page carrying a check; a check standing in for the page renders little but its widget, and stays a check.
    #[test]
    fn the_page_asked_for_that_renders_its_own_controls_is_the_page() {
        let asked = Some("https://www.loom.example/looms/videos");
        assert!(is_the_page_asked(asked, "https://www.loom.example/looms/videos/#top"));
        assert!(!is_the_page_asked(asked, "https://www.loom.example/login?redirect_after=%2Flooms%2Fvideos"));
        assert!(!is_the_page_asked(None, "https://www.loom.example/looms/videos"));
        let library: String = ["link \"Skip to content\"", "button \"Expand sidebar\"", "link \"Loom home\"", "combobox \"Search\"", "button \"Upgrade\"", "button \"Notifications\"", "heading \"Library Videos\"", "button \"Create new folder\"", "tab \"Videos\"", "tab \"Screenshots\"", "tab \"Archive\"", "checkbox \"Select all videos\"", "button \"Sort by\""]
            .iter().enumerate().map(|(i, l)| format!("  - {l} [ref=e{i}]\n")).collect();
        assert!(renders_a_page_of_its_own(&library));
        let interstitial = "- Iframe \"Widget containing a security challenge\" [ref=e1]\n  - checkbox \"Verify you are human\" [ref=e2]\n- link \"Privacy\" [ref=e3]\n";
        assert!(!renders_a_page_of_its_own(interstitial), "a check's own page is not a page of its own");
        assert!(!renders_a_page_of_its_own(""), "nothing rendered, nothing to go on");
    }

    /// A sign-in the site sent the page to takes in the owner's browser session, a captcha on its form or not; a check
    /// the page asked for itself, naming nothing to come back to, is a check and nothing else.
    #[test]
    fn a_sign_in_with_a_check_on_it_is_still_a_sign_in() {
        use crate::browse::Came;
        let asked = Some("https://www.loom.example/looms/videos");
        let walled = Came::Walled { at: "https://www.loom.example/login?next=%2Flooms%2Fvideos".into() };
        assert_eq!(signed_out_at(&walled, asked), Some("https://www.loom.example/login?next=%2Flooms%2Fvideos"));
        let checked = Came::Check { at: "https://www.loom.example/login?redirect_after=%2Flooms%2Fvideos".into() };
        assert_eq!(signed_out_at(&checked, asked), Some("https://www.loom.example/login?redirect_after=%2Flooms%2Fvideos"), "a sign-in carrying a captcha");
        let own = Came::Check { at: "https://www.loom.example/looms/videos".into() };
        assert_eq!(signed_out_at(&own, asked), None, "the page's own check names nothing to come back to");
        assert_eq!(signed_out_at(&checked, None), None, "no page asked, nothing to come back to");
        assert_eq!(signed_out_at(&Came::Done, asked), None);
        let real = Came::Check { at: "https://www.loom.com/login?redirect_after=%2Flooms%2Fvideos".into() };
        assert_eq!(signed_out_at(&real, Some("https://www.loom.com/looms/videos")), Some("https://www.loom.com/login?redirect_after=%2Flooms%2Fvideos"), "the live landing");
    }

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

#[cfg(test)]
#[path = "browse_cov_tests.rs"]
mod browse_cov_tests;
