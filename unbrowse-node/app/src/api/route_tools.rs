//! The node's own routes as MCP tools of their own, one per call (`decide.routes-as-tools`).
//!
//! A tool stands for the call a site answers, not for a route record (`tools.route-per-call`): the same call learned
//! under two goals is two routes, since a route's id hashes its whole body (R2.3), and is one tool here. Only routes the
//! node keeps and has seen answer become tools, never a listing fetched from the network (`tools.route-own-only`).
//! Calling one is calling `unbrowse_call` with the route it names at that moment (`tools.route-is-a-call`). They are
//! listed only to a client that asks for them when it connects (`tools.route-opt-in`), and to it only those its session
//! reached: the node adds them from the session's own urls, goals and calls, with no model (`tools.surfaced-by-session`).

use super::*;
use crate::store::Route;

/// How a client asks for route tools in the MCP address it connects to: `/mcp?routes=tools`.
pub(super) const ASKED_IN_ADDRESS: (&str, &str) = ("routes", "tools");
/// The same ask as a header, for a client that can set one and not its address.
pub(super) const ASKED_IN_HEADER: &str = "unbrowse-routes";

/// The longest a route tool's name runs, so a host's own prefix (`mcp__unbrowse__`) still fits a model's 64.
const NAME_MAX: usize = 48;
/// How much of what the route's goals said a tool's description carries.
const SAID_MAX: usize = 320;
/// How many of the call's other goals a description names.
const OTHER_GOALS: usize = 3;

/// Whether the client asked for route tools: by its address (`mcp` copies the query into this header) or a header.
pub(super) fn asked(headers: &HeaderMap) -> bool {
    headers.get(ASKED_IN_HEADER).and_then(|v| v.to_str().ok()).is_some_and(|v| v.trim().eq_ignore_ascii_case(ASKED_IN_ADDRESS.1))
}

/// Whether a request's query asks for route tools.
pub(super) fn asked_in(query: Option<&str>) -> bool {
    query.is_some_and(|q| url::form_urlencoded::parse(q.as_bytes()).any(|(k, v)| k == ASKED_IN_ADDRESS.0 && v.eq_ignore_ascii_case(ASKED_IN_ADDRESS.1)))
}

/// One place in a call's address: a fixed piece, or one the route fills from an input, whatever the input is named.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Piece {
    Fixed(String),
    Hole,
}

impl Piece {
    fn of(s: &str) -> Self {
        if s.contains('{') { Piece::Hole } else { Piece::Fixed(s.to_string()) }
    }
}

/// The call a route answers with: its host, method, path and query, each place a route fills from an input a hole.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Call {
    site: String,
    host: String,
    method: String,
    path: Vec<Piece>,
    query: Vec<(String, Piece)>,
}

impl Call {
    fn of(r: &Route) -> Self {
        // The host the call goes to: the last step's, which may be another host of the site (an API's).
        let host = r
            .graph
            .steps
            .last()
            .map(|s| s.url.as_str())
            .or(Some(r.root.as_str()))
            .and_then(|u| u.split_once("://").map(|(_, rest)| rest.split(['/', '?']).next().unwrap_or_default().to_ascii_lowercase()))
            .unwrap_or_default();
        let (path, query) = r.path.split_once('?').unwrap_or((r.path.as_str(), ""));
        let mut query: Vec<(String, Piece)> = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).map(|(k, v)| (k.to_string(), Piece::of(v))).collect();
        query.sort();
        Call { site: r.site.clone(), host, method: r.method.to_ascii_uppercase(), path: path.split('/').filter(|p| !p.is_empty()).map(Piece::of).collect(), query }
    }

    /// Whether `self` answers every call `other` does: the same call, with a hole wherever the two differ.
    fn covers(&self, other: &Call) -> bool {
        let fits = |mine: &Piece, theirs: &Piece| *mine == Piece::Hole || mine == theirs;
        self.site == other.site
            && self.host == other.host
            && self.method == other.method
            && self.path.len() == other.path.len()
            && self.query.len() == other.query.len()
            && self.path.iter().zip(&other.path).all(|(a, b)| fits(a, b))
            && self.query.iter().zip(&other.query).all(|((ka, a), (kb, b))| ka == kb && fits(a, b))
    }

    fn holes(&self) -> usize {
        self.path.iter().chain(self.query.iter().map(|(_, p)| p)).filter(|p| **p == Piece::Hole).count()
    }

    /// The tool's name, read from the call alone: the site and the fixed pieces of the path as an agent is `shown` it,
    /// then a short hash of the whole call, so two calls on one path stay two names and a route learned again keeps
    /// its tool's.
    fn name(&self, shown: &Call) -> String {
        // Lower-case letters and digits, one `_` between words.
        let word = |s: &str| s.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_ascii_lowercase).collect::<Vec<_>>().join("_");
        let site = word(self.site.trim_start_matches("www."));
        let fixed: Vec<String> = shown
            .path
            .iter()
            .filter_map(|p| match p {
                Piece::Fixed(s) => Some(word(s)),
                Piece::Hole => None,
            })
            .filter(|s| !s.is_empty())
            .collect();
        let tail = fixed[fixed.len().saturating_sub(3)..].join("_");
        let hash = {
            use sha2::Digest;
            let said = format!("{}|{}|{}|{:?}|{:?}", self.site, self.host, self.method, self.path, self.query);
            hex::encode(&sha2::Sha256::digest(said.as_bytes())[..3])
        };
        let mut head = if tail.is_empty() { site } else { format!("{site}__{tail}") };
        let room = NAME_MAX - hash.len() - 1;
        if head.len() > room {
            head.truncate(room);
        }
        format!("{}_{hash}", head.trim_end_matches('_'))
    }
}

/// One route tool: the call, the route that runs it now, and the goals every route of the call was learned for.
pub(super) struct RouteTool {
    pub name: String,
    pub route: Route,
    goals: Vec<String>,
    /// Every route whose call this tool answers, its own first.
    members: Vec<String>,
}

/// Whether a route may stand behind a tool: the node's own (not a listing fetched from the network) and seen answering.
fn eligible(r: &Route) -> bool {
    r.fetched.is_none() && r.stats.passed > 0
}

/// The node's route tools, one per call, from `routes`: each route goes to the most general route that covers its
/// call (most holes, then most passes, then the newest), and each such route is a tool.
fn of(routes: Vec<Route>) -> Vec<RouteTool> {
    let calls: Vec<(Call, Route)> = routes.into_iter().filter(eligible).map(|r| (Call::of(&r), r)).collect();
    let rank = |(c, r): &(Call, Route)| (c.holes(), r.stats.passed, r.learned_at);
    let mut tools: Vec<(usize, Vec<String>, Vec<String>)> = Vec::new();
    for (call, route) in &calls {
        let best = calls.iter().enumerate().filter(|(_, (c, _))| c.covers(call)).max_by_key(|(_, cr)| rank(cr)).map(|(i, _)| i).unwrap_or_default();
        let said = std::iter::once(route.what.clone()).chain(route.asked.iter().cloned());
        match tools.iter_mut().find(|(i, _, _)| *i == best) {
            Some((_, goals, members)) => {
                goals.extend(said);
                members.push(route.id.clone());
            }
            None => tools.push((best, said.collect(), vec![route.id.clone()])),
        }
    }
    let mut out: Vec<RouteTool> = tools
        .into_iter()
        .map(|(i, mut goals, mut members)| {
            let (call, route) = &calls[i];
            members.sort_by_key(|m| *m != route.id);
            let lead = route.what.clone();
            goals.retain(|g| !g.trim().is_empty());
            let mut seen = vec![unbrowse_learn::goal::words(&lead)];
            goals.retain(|g| {
                let w = unbrowse_learn::goal::words(g);
                let fresh = !seen.contains(&w);
                seen.push(w);
                fresh
            });
            goals.insert(0, lead);
            // Named by the call as an agent is shown it: a fixed piece the owner's own session gave never names a tool.
            let name = call.name(&Call::of(&route.shown_to_an_agent()));
            RouteTool { name, route: route.clone(), goals, members }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The node's route tools, from the routes it keeps now.
pub(super) fn kept() -> Vec<RouteTool> {
    of(crate::store::load_routes())
}

/// The route a tool's name stands for now, if it names one.
pub(super) fn route_for(name: &str) -> Option<Route> {
    kept().into_iter().find(|t| t.name == name).map(|t| t.route)
}

/// The most route tools one session is shown: past it, the one used longest ago leaves.
const SURFACED_MAX: usize = 20;
/// How many of the routes the node's search ranks first for a session's goal come into its set.
const BY_GOAL: usize = 3;
/// How many sessions' sets the node holds; past it, the one heard from longest ago is forgotten.
const SESSIONS_MAX: usize = 256;

/// Each MCP session's route tools, by name, with when each was last reached (a count that only grows).
static SURFACED: std::sync::Mutex<Vec<(String, Vec<(String, u64)>)>> = std::sync::Mutex::new(Vec::new());
static TICK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The MCP session a request belongs to (`Mcp-Session-Id`), if it names one.
pub(super) fn session_of(headers: &HeaderMap) -> Option<String> {
    headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The route tools `session` has reached, as they stand now: a name whose call no longer has a route drops out.
pub(super) fn surfaced(session: &str) -> Vec<RouteTool> {
    let names: Vec<String> = SURFACED.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|(s, _)| s == session).map(|(_, t)| t.iter().map(|(n, _)| n.clone()).collect()).unwrap_or_default();
    if names.is_empty() {
        return Vec::new();
    }
    kept().into_iter().filter(|t| names.contains(&t.name)).collect()
}

/// Every page address a call names: a string argument, or one in a list or object an argument holds, that is a web page.
fn pages_in(args: &Value) -> Vec<String> {
    fn walk(v: &Value, depth: usize, out: &mut Vec<String>) {
        match v {
            Value::String(s) if s.starts_with("http://") || s.starts_with("https://") => out.push(s.clone()),
            Value::Array(a) if depth > 0 => a.iter().for_each(|x| walk(x, depth - 1, out)),
            Value::Object(o) if depth > 0 => o.values().for_each(|x| walk(x, depth - 1, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(args, 3, &mut out);
    out
}

/// Every route a call ran or a reply names: the `route_id` it was asked with, and each `route.id` in its reply (a
/// batch's pages each carry theirs).
fn routes_in(args: &Value, reply: &Value) -> Vec<String> {
    fn walk(v: &Value, depth: usize, out: &mut Vec<String>) {
        match v {
            Value::Object(o) => {
                if let Some(id) = o.get("route").and_then(|r| r.get("id")).and_then(Value::as_str) {
                    out.push(id.to_string());
                }
                if depth > 0 {
                    o.values().for_each(|x| walk(x, depth - 1, out));
                }
            }
            Value::Array(a) if depth > 0 => a.iter().for_each(|x| walk(x, depth - 1, out)),
            _ => {}
        }
    }
    let mut out: Vec<String> = args.get("route_id").and_then(Value::as_str).map(String::from).into_iter().collect();
    walk(reply, 4, &mut out);
    out
}

/// The tools a call reached, from the node's `catalog`: those of each site whose page it named, the few the node's own
/// route search ranks first for its goal (`learn::search`), and the one each route it ran or learned stands under.
fn reached_by(catalog: &[RouteTool], args: &Value, reply: &Value, by_goal: &[String]) -> Vec<String> {
    let pages = pages_in(args);
    let routes = routes_in(args, reply);
    catalog
        .iter()
        .filter(|t| {
            t.members.iter().any(|m| routes.contains(m) || by_goal.contains(m))
                || pages.iter().any(|p| unbrowse_learn::identity::same_site(p, &t.route.site))
        })
        .map(|t| t.name.clone())
        .collect()
}

/// Adds to `session`'s set the tools a call with `args` that answered `reply` reached, and says which are new to it.
pub(super) fn reach(session: &str, args: &Value, reply: &Value) -> Vec<String> {
    let catalog = kept();
    if catalog.is_empty() {
        return Vec::new();
    }
    let goal = args.get("goal").and_then(Value::as_str).unwrap_or_default();
    let by_goal: Vec<String> = if goal.trim().is_empty() { Vec::new() } else { crate::learn::search(goal).into_iter().take(BY_GOAL).map(|r| r.id).collect() };
    note(session, reached_by(&catalog, args, reply, &by_goal))
}

/// Puts `names` into `session`'s set, the oldest leaving past [`SURFACED_MAX`], and answers the ones it lacked.
fn note(session: &str, names: Vec<String>) -> Vec<String> {
    if names.is_empty() {
        return names;
    }
    let mut all = SURFACED.lock().unwrap_or_else(|p| p.into_inner());
    let now = TICK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Some(i) = all.iter().position(|(s, _)| s == session) {
        let mine = all.remove(i);
        all.push(mine);
    } else {
        all.push((session.to_string(), Vec::new()));
        let over = all.len().saturating_sub(SESSIONS_MAX);
        all.drain(..over);
    }
    let set = &mut all.last_mut().expect("just pushed").1;
    let mut added = Vec::new();
    for n in names {
        match set.iter_mut().find(|(have, _)| *have == n) {
            Some(had) => had.1 = now,
            None => {
                set.push((n.clone(), now));
                added.push(n);
            }
        }
    }
    while set.len() > SURFACED_MAX {
        let oldest = set.iter().enumerate().min_by_key(|(_, (_, at))| *at).map(|(i, _)| i).unwrap_or_default();
        let gone = set.remove(oldest);
        added.retain(|n| *n != gone.0);
    }
    added
}

/// Where a tool call's JSON-RPC result names the route tools it brought its session.
pub(super) const ADDED_META: &str = "unbrowse/tools_added";
/// The notice a client reading a stream is sent before such an answer.
pub(super) const LIST_CHANGED: &str = r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#;

/// Whether a JSON-RPC answer brought its session route tools.
pub(super) fn added_by(answer: &Value) -> bool {
    answer.pointer(&format!("/result/_meta/{}", ADDED_META.replace('/', "~1"))).and_then(Value::as_array).is_some_and(|a| !a.is_empty())
}

/// `answer` as an event stream: the changed list, then the answer.
pub(super) fn told(answer: Value) -> axum::response::Response {
    use axum::response::sse::{Event, Sse};
    use axum::response::IntoResponse;
    let events = [Event::default().data(LIST_CHANGED), Event::default().data(answer.to_string())].map(Ok::<_, std::convert::Infallible>);
    Sse::new(futures_util::stream::iter(events)).into_response()
}

/// A tool's arguments as `unbrowse_call` takes them: its route, every argument but `fields` as an input, and `fields`.
pub(super) fn as_call(route: &Route, args: &Value) -> Value {
    let takes_fields = route.inputs.iter().any(|i| i.name == "fields");
    let mut inputs = serde_json::Map::new();
    let mut fields = Value::Null;
    for (k, v) in args.as_object().into_iter().flatten() {
        match k.as_str() {
            "fields" if !takes_fields => fields = v.clone(),
            // The browsing session `in_mcp_session` names is the call's, never an input of the site's.
            "session" if !route.inputs.iter().any(|i| i.name == "session") => {}
            _ => {
                inputs.insert(k.clone(), v.clone());
            }
        }
    }
    let mut call = json!({ "route_id": route.id, "inputs": inputs });
    if !fields.is_null() {
        call["fields"] = fields;
    }
    call
}

/// The MCP tool a route tool lists as: its goals as the description, the route's inputs (as an agent is shown them:
/// no secret's value, nothing the owner's own session gave), `fields` as in `unbrowse_call`, and whether it writes.
pub(super) fn listed(t: &RouteTool) -> Value {
    let shown = t.route.shown_to_an_agent();
    let mut said = t.goals[0].clone();
    let others: Vec<&str> = t.goals.iter().skip(1).take(OTHER_GOALS).map(String::as_str).collect();
    if !others.is_empty() {
        said.push_str(&format!(". Also asked as: {}", others.join("; ")));
    }
    if said.len() > SAID_MAX {
        let mut cut = SAID_MAX;
        while !said.is_char_boundary(cut) {
            cut -= 1;
        }
        said.truncate(cut);
        said.push('…');
    }
    let description = format!(
        "{said}. {} {} on {}; answers as unbrowse_call with this route ({}){}.",
        shown.method,
        shown.path,
        t.route.site,
        t.route.id,
        if t.route.write { "; changes the site" } else { "" }
    );
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for i in &shown.inputs {
        let mut about = Vec::new();
        if i.file {
            about.push("a file's path in the node's file root".to_string());
        }
        if let Some(d) = i.default.as_deref().filter(|_| !i.secret) {
            about.push(format!("walked as {d}"));
        }
        if !i.options.is_empty() {
            let named: Vec<String> = i.options.iter().take(8).map(|c| serde_json::to_value(c).ok().and_then(|v| v.get("value").and_then(Value::as_str).map(String::from)).unwrap_or_default()).filter(|s| !s.is_empty()).collect();
            if !named.is_empty() {
                about.push(format!("the page offered {}", named.join(", ")));
            }
        }
        let mut p = json!({ "type": "string" });
        if !about.is_empty() {
            p["description"] = json!(about.join("; "));
        }
        properties.insert(i.name.clone(), p);
        if !i.optional && i.default.is_none() {
            required.push(i.name.clone());
        }
    }
    if !properties.contains_key("fields") {
        properties.insert("fields".into(), json!({ "type": "array", "items": { "type": "string" }, "description": "As in unbrowse_call." }));
    }
    json!({
        "name": t.name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        "annotations": { "title": t.goals[0], "readOnlyHint": !t.route.write, "destructiveHint": t.route.write, "openWorldHint": true }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(id: &str, what: &str, path: &str, inputs: &[&str], passed: u64) -> Route {
        let mut r: Route = serde_json::from_value(json!({
            "id": id, "site": "shop.example", "what": what, "method": "GET", "path": path, "root": "https://shop.example/",
            "inputs": inputs.iter().map(|n| json!({ "name": n, "secret": false, "default": null })).collect::<Vec<_>>(),
            "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
            "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("https://shop.example{path}"), "needs_browser": false, "fields": [] }] }
        }))
        .unwrap();
        r.stats = crate::store::RouteStats { calls: passed, passed, ..Default::default() };
        r
    }

    /// The same call learned under several goals, and once with a fixed value where the others take an input, is one
    /// tool, run by the route that takes the input; a call on another path is a tool of its own.
    #[test]
    fn routes_that_are_one_call_are_one_tool() {
        let tools = of(vec![
            route("a", "items mentioning lamp", "/api/search?keyword={keyword}", &["keyword"], 1),
            route("b", "search the shop for desks", "/api/search?keyword={keyword}", &["keyword"], 3),
            route("c", "read the search results", "/api/search?keyword=desk", &[], 1),
            route("d", "the item's page", "/api/items/{path[2]}", &["item"], 1),
        ]);
        assert_eq!(tools.len(), 2, "{:?}", tools.iter().map(|t| (&t.name, &t.route.id)).collect::<Vec<_>>());
        let search = tools.iter().find(|t| t.route.path.starts_with("/api/search")).unwrap();
        assert_eq!(search.route.id, "b", "the most general, then the one that passed most");
        assert_eq!(search.goals.len(), 3, "every goal the call was learned for: {:?}", search.goals);
    }

    /// A tool is named by its call, never by a goal or a route id: the call learned again, under other words and
    /// another id, keeps its name, and another call on the same path is another name.
    #[test]
    fn a_route_tool_is_named_by_its_call_not_its_goal() {
        let first = of(vec![route("a", "items mentioning lamp", "/api/search?keyword={keyword}", &["keyword"], 1)]);
        let again = of(vec![route("z", "find desks", "/api/search?keyword={q}", &["q"], 1)]);
        let other = of(vec![route("y", "find desks", "/api/search?keyword={q}&page={page}", &["q", "page"], 1)]);
        assert_eq!(first[0].name, again[0].name);
        assert_ne!(first[0].name, other[0].name);
        assert!(first[0].name.starts_with("shop_example__api_search_"), "{}", first[0].name);
        assert!(first[0].name.len() <= NAME_MAX && first[0].name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "{}", first[0].name);
    }

    /// Only the node's own routes that have answered are tools: a route never seen answering is not, and neither is a
    /// listing fetched from the network, whose words are the lister's.
    #[test]
    fn only_own_routes_that_answered_are_tools() {
        let mut fetched = route("f", "a lister's words", "/api/listed", &[], 5);
        fetched.fetched = Some(crate::store::Fetched { entry_id: "0xe".into(), route_id: "f".into(), agent_id: "1".into(), content_id: "c".into(), listed_as: "a lister's words".into(), fetched_at: 1 });
        let tools = of(vec![route("n", "never answered", "/api/new", &[], 0), fetched, route("o", "answered", "/api/old", &[], 1)]);
        assert_eq!(tools.iter().map(|t| t.route.id.as_str()).collect::<Vec<_>>(), ["o"]);
    }

    /// A session reaches a site's tools by naming one of its pages, a route's tool by running it, and a goal's by the
    /// node's search; a page on another site reaches none, and the same tool is new to a session only once.
    #[test]
    fn a_session_reaches_the_tools_of_what_it_asked() {
        let mut other = route("o", "list the other shop", "/api/list", &[], 1);
        other.site = "other.example".into();
        let catalog = of(vec![route("a", "search the shop", "/api/search?keyword={keyword}", &["keyword"], 1), route("b", "an item", "/api/items/{path[2]}", &["item"], 1), other]);
        let names = |ids: &[&str]| catalog.iter().filter(|t| ids.iter().any(|i| t.members.contains(&i.to_string()))).map(|t| t.name.clone()).collect::<Vec<_>>();
        let by_page = reached_by(&catalog, &json!({ "goal": "x", "url": "https://www.shop.example/?q=lamp" }), &json!({}), &[]);
        assert_eq!(by_page, names(&["a", "b"]), "a page of the site brings its tools");
        let by_reply = reached_by(&catalog, &json!({ "goal": "x" }), &json!({ "how": "called", "route": { "id": "o" } }), &[]);
        assert_eq!(by_reply, names(&["o"]), "a route the reply ran brings its tool");
        assert_eq!(reached_by(&catalog, &json!({ "route_id": "b" }), &json!({}), &[]), names(&["b"]));
        assert_eq!(reached_by(&catalog, &json!({ "goal": "x" }), &json!({}), &["a".to_string()]), names(&["a"]), "the goal's search");
        assert!(reached_by(&catalog, &json!({ "url": "https://elsewhere.example/" }), &json!({}), &[]).is_empty());
        let session = "test-reaches";
        assert_eq!(note(session, names(&["a"])), names(&["a"]));
        assert!(note(session, names(&["a"])).is_empty(), "new only once");
    }

    /// A session's set stops at its cap: the tool reached longest ago leaves, and one just reached stays.
    #[test]
    fn a_sessions_set_keeps_the_most_recently_reached() {
        let session = "test-cap";
        let all: Vec<String> = (0..SURFACED_MAX + 5).map(|i| format!("tool_{i:02}")).collect();
        for n in &all {
            note(session, vec![n.clone()]);
        }
        note(session, vec![all[5].clone()]);
        note(session, vec!["tool_new".into()]);
        let held = SURFACED.lock().unwrap().iter().find(|(s, _)| s == session).map(|(_, t)| t.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()).unwrap();
        assert_eq!(held.len(), SURFACED_MAX);
        assert!(held.contains(&all[5]) && held.contains(&"tool_new".to_string()) && !held.contains(&all[0]) && !held.contains(&all[6]), "{held:?}");
    }

    /// A tool's arguments reach `unbrowse_call` as the route's inputs, with `fields` as its fields and the browsing
    /// session left out.
    #[test]
    fn a_route_tools_arguments_are_the_calls_inputs() {
        let r = route("a", "search", "/api/search?keyword={keyword}", &["keyword"], 1);
        let call = as_call(&r, &json!({ "keyword": "lamp", "fields": ["items[].name"], "session": "mcp:abc" }));
        assert_eq!(call, json!({ "route_id": "a", "inputs": { "keyword": "lamp" }, "fields": ["items[].name"] }));
        let listed = listed(&of(vec![r])[0]);
        assert_eq!(listed["inputSchema"]["required"], json!(["keyword"]));
        assert_eq!(listed["annotations"]["readOnlyHint"], json!(true));
    }
}
