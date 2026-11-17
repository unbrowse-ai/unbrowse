//! Many pages at once (`unbrowse_do` with `pages`): each run side by side and answered compactly.

use super::*;

/// An answer as a reply of several pages shows it: no empty values, and a chain of objects with one key each
/// (`appContext.initialProps.ssrData.detail.priceInfo`) as its last key (`priceInfo`); the paths in fields stay whole.
pub(super) fn compact(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, x) in o {
                let x = compact(x);
                if x.is_null() || x.as_object().is_some_and(|m| m.is_empty()) || x.as_array().is_some_and(|a| a.is_empty()) {
                    continue;
                }
                out.insert(k.clone(), x);
            }
            // A wrapper of one key is its inside: keep the innermost key that holds more than one.
            while out.len() == 1 {
                let (k, x) = out.iter().next().map(|(k, x)| (k.clone(), x.clone())).expect("one key");
                match x {
                    Value::Object(inner) if inner.len() == 1 && inner.values().all(Value::is_object) => out = inner,
                    _ => {
                        let mut one = serde_json::Map::new();
                        one.insert(k, x);
                        out = one;
                        break;
                    }
                }
            }
            if out.is_empty() { Value::Null } else { Value::Object(out) }
        }
        Value::Array(a) => {
            let a: Vec<Value> = a.iter().map(compact).filter(|x| !x.is_null()).collect();
            if a.is_empty() { Value::Null } else { Value::Array(a) }
        }
        _ => v.clone(),
    }
}

/// Whether an answer holds a list of named records near its top (`learn::holds_records`).
pub(super) fn records(v: &Value) -> bool {
    crate::learn::holds_records(v)
}

/// Whether an answer holds any value: a string, number or bool somewhere in it.
pub(super) fn has_value(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Array(a) => a.iter().any(has_value),
        Value::Object(o) => o.values().any(has_value),
        _ => true,
    }
}

/// One page of several asked at once: its url, and the goal and inputs it has of its own, if any.
pub(super) struct Page {
    pub(super) url: String,
    goal: String,
    inputs: HashMap<String, String>,
}

/// `pages`: each a url, or `{url, goal, inputs}`.
pub(super) fn pages_arg(args: &Value) -> Vec<Page> {
    let pages = match decoded(args.get("pages")) {
        Some(Value::Array(a)) => a,
        // One page named on its own.
        Some(Value::String(url)) if !url.trim().is_empty() => vec![Value::String(url)],
        _ => return Vec::new(),
    };
    pages
        .iter()
        .filter_map(|p| match p {
            Value::String(url) => Some(Page { url: url.clone(), goal: String::new(), inputs: HashMap::new() }),
            Value::Object(_) => Some(Page { url: text_arg(p, "url"), goal: text_arg(p, "goal"), inputs: strings(p.get("inputs")) }),
            _ => None,
        })
        .filter(|p| !p.url.trim().is_empty())
        .collect()
}

/// Whether `pages` was given and none of it reads as a page.
pub(super) fn pages_unread(args: &Value) -> bool {
    pages_arg(args).is_empty() && decoded(args.get("pages")).is_some_and(|p| !(p.is_null() || p == json!([]) || p == json!("")))
}

/// The most pages one `unbrowse_do` takes.
pub(super) const MOST_PAGES: usize = 100;
/// How many of a route's other fields a reply of several pages lists: enough to choose from, small enough for 100 pages.
pub(super) const FIELDS_PER_ROUTE: usize = 6;
/// How many of one site's pages run at once.
pub(super) const AT_ONCE_PER_SITE: usize = 8;

/// Several pages at once, each done as `do_goal` does one. Sites run side by side. Within a site the first page goes
/// first, so a route it learns answers the rest of that site's pages (another coin's, item's or user's page) in one
/// call each, and those then run side by side. Each page's answer is cut to what an agent reads: how it went, its
/// time, its data or its error. The fields a route can add are said once per route, not once per page.
pub(super) async fn do_pages(node: &Arc<Node>, a: &Agent, body: DoBody, pages: Vec<Page>) -> Result<Value, Fail> {
    if pages.len() > MOST_PAGES {
        return Err((StatusCode::BAD_REQUEST, format!("{} pages: one call takes at most {MOST_PAGES}", pages.len())));
    }
    let started = std::time::Instant::now();
    let mut sites: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, p) in pages.iter().enumerate() {
        let site = url::Url::parse(p.url.trim()).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        match sites.iter_mut().find(|(s, _)| *s == site) {
            Some((_, at)) => at.push(i),
            None => sites.push((site, vec![i])),
        }
    }
    let bodies: Vec<DoBody> = pages
        .iter()
        .map(|p| DoBody {
            goal: if p.goal.trim().is_empty() { body.goal.clone() } else { p.goal.clone() },
            url: p.url.clone(),
            inputs: body.inputs.iter().chain(&p.inputs).map(|(k, v)| (k.clone(), v.clone())).collect(),
            session: body.session.clone(),
            browser: body.browser.clone(),
            fields: body.fields.clone(),
            many: true,
            budget_usdc: body.budget_usdc,
        })
        .collect();
    let mut bodies: Vec<Option<DoBody>> = bodies.into_iter().map(Some).collect();
    let sites: Vec<Vec<(usize, DoBody)>> =
        sites.into_iter().map(|(_, at)| at.into_iter().map(|i| (i, bodies[i].take().expect("each page once"))).collect()).collect();
    let (node, a) = (node.clone(), a.clone());
    let run = move |p: (usize, DoBody)| {
        let (node, a) = (node.clone(), a.clone());
        async move { page_run(&node, &a, p).await }
    };
    let done = pages_run(sites, ANSWER_WITHIN, &PAGES, run).await;
    let answered: std::collections::HashSet<usize> = done.iter().map(|(i, _)| *i).collect();
    let pending: Vec<&str> = (0..pages.len()).filter(|i| !answered.contains(i)).map(|i| pages[i].url.as_str()).collect();
    let mut done: Vec<(usize, Value)> = done.into_iter().map(|(i, (took, r))| (i, page_answer(&pages[i].url, took, r))).collect();
    done.sort_by_key(|(i, _)| *i);
    let mut fields = serde_json::Map::new();
    let mut count: std::collections::BTreeMap<String, usize> = Default::default();
    let answers: Vec<Value> = done
        .into_iter()
        .map(|(_, mut v)| {
            *count.entry(v["how"].as_str().unwrap_or_default().to_string()).or_default() += 1;
            if let (Some(id), Some(f)) = (v["route_id"].as_str().map(String::from), v.as_object_mut().and_then(|o| o.remove("fields"))) {
                fields.entry(id).or_insert(f);
            }
            v
        })
        .collect();
    let mut reply = json!({ "how": "pages", "ms": started.elapsed().as_millis() as u64, "count": count, "pages": answers, "fields": fields });
    if !pending.is_empty() {
        reply["pending"] = json!(pending);
        reply["next"] = json!("The pages in pending are still being learned, and go on after this reply: ask again with them (or all the pages) in a few seconds, and each one learned by then comes back at once.");
    }
    fit_pages(&mut reply);
    Ok(reply)
}

/// How much a reply of several pages carries, as an agent's client is shown it (indented JSON): what one answer may
/// carry, for all the pages together. Each page's answer is cut to `run::REPLY_BUDGET` on its own, so fourteen pages
/// were up to fourteen times that (209,051 characters), and a client refused the reply whole (Claude Code read 74 KB
/// in one go, and refused 87 KB).
pub(super) const PAGES_BUDGET: usize = 60 * 1024;

/// Room kept in `PAGES_BUDGET` for the note a cut page carries.
const NOTE_ROOM: usize = 900;

/// Cuts the pages' data so the whole reply fits `PAGES_BUDGET`: a page smaller than its share is left whole, and the
/// room it leaves goes to the bigger ones, each cut to the same size (its lists to their first records, its texts to
/// their start). A page cut here says so in its `truncated`, with what was kept of how much and how to get the rest:
/// asked for alone, a page carries up to `run::REPLY_BUDGET`.
pub(super) fn fit_pages(reply: &mut Value) {
    let pretty = |v: &Value| serde_json::to_string_pretty(v).map(|s| s.len()).unwrap_or(0);
    if pretty(reply) <= PAGES_BUDGET {
        return;
    }
    let Some(pages) = reply["pages"].as_array() else { return };
    let n = pages.len();
    let datas: Vec<Value> = pages.iter().map(|p| p["data"].clone()).collect();
    // A page's data as indented JSON, and as the plain JSON `fit_reply` measures.
    let sizes: Vec<(usize, usize)> = datas.iter().map(|d| if d.is_null() { (0, 0) } else { (pretty(d), serde_json::to_vec(d).map(|b| b.len()).unwrap_or(0)) }).collect();
    let rest = pretty(reply).saturating_sub(sizes.iter().map(|s| s.0).sum::<usize>());
    let room = PAGES_BUDGET.saturating_sub(rest + n * NOTE_ROOM);
    let original = reply.clone();
    // The room the pages' data is given, found by halving: the most whose reply, notes and all, still fits.
    let (mut lo, mut hi) = (0, room * 3);
    let mut best = None;
    for _ in 0..12 {
        let mid = (lo + hi) / 2;
        let mut tried = original.clone();
        cut_pages(&mut tried, &datas, &sizes, share_of(&sizes.iter().map(|s| s.0).collect::<Vec<_>>(), mid));
        if pretty(&tried) <= PAGES_BUDGET {
            best = Some(tried);
            lo = mid + 1;
        } else {
            hi = mid;
        }
        if hi <= lo {
            break;
        }
    }
    if let Some(fitted) = best {
        *reply = fitted;
    }
}

/// How many of a page's cuts a reply of several pages lists: the first, outermost ones say where its records were cut.
const CUTS_PER_PAGE: usize = 3;

/// Cuts each page's data that is over `share` (as indented JSON) to it, and says so in the page's `truncated`.
fn cut_pages(reply: &mut Value, datas: &[Value], sizes: &[(usize, usize)], share: usize) {
    let n = datas.len();
    let Some(pages) = reply["pages"].as_array_mut() else { return };
    for (i, page) in pages.iter_mut().enumerate() {
        let (shown, plain) = sizes[i];
        if shown <= share {
            continue;
        }
        // `fit_reply` counts plain JSON: the share in plain bytes, as this data's own indenting stretches it.
        let budget = share * plain / shown.max(1);
        let (kept, cut) = crate::run::fit_reply(datas[i].clone(), budget);
        let Some((kept_bytes, _, mut cuts, _)) = cut else { continue };
        cuts.truncate(CUTS_PER_PAGE);
        let url = page["url"].as_str().unwrap_or_default().to_string();
        let before = page.get("truncated").cloned().filter(|t| !t.is_null());
        let total = before.as_ref().and_then(|t| t["total_bytes"].as_u64()).map(|b| b as usize).unwrap_or(plain);
        let whole = before.as_ref().and_then(|t| t["whole"].as_str()).map(String::from);
        let note = format!(
            "This page's answer is {} KB; a reply of {n} pages carries {} KB of it, for room for the others: each list and text in cuts keeps only its first kept items or characters. Ask for this page alone (unbrowse_do with url {url}) for up to {} KB of it, or with fields for just the ones you need.{}",
            total.div_ceil(1024),
            kept_bytes.div_ceil(1024),
            crate::run::REPLY_BUDGET / 1024,
            whole.as_ref().map(|p| format!(" The whole answer is in {p} on the node's machine.")).unwrap_or_default()
        );
        page["data"] = kept;
        page["truncated"] = json!({ "kept_bytes": kept_bytes, "total_bytes": total, "cuts": cuts, "whole": whole, "note": note });
    }
}

/// The size each item may keep so all fit `room`: those under it keep all they have, and what they leave is shared
/// evenly by the rest.
fn share_of(sizes: &[usize], room: usize) -> usize {
    let mut sorted = sizes.to_vec();
    sorted.sort_unstable();
    let (mut left, mut n) = (room, sorted.len());
    for s in sorted {
        if s * n <= left {
            left -= s;
            n -= 1;
        } else {
            return left / n;
        }
    }
    usize::MAX
}

/// How long a call for several pages waits before it answers with the pages done so far: under the minute an MCP
/// client waits for a tool.
pub(super) const ANSWER_WITHIN: std::time::Duration = std::time::Duration::from_secs(40);

/// A page's outcome: how long it took, and its answer or why it has none.
pub(super) type Done = (std::time::Duration, Result<Value, Fail>);

/// The pages being done for calls of several, by goal and url, and the answers of those that finished after their
/// call had replied. A page asked again while it is still being learned is said to be pending, not walked a second
/// time; a page that finished after the reply answers the next ask with what it found, not with a second walk.
#[derive(Default)]
pub(super) struct Walks {
    walking: std::collections::HashSet<String>,
    late: HashMap<String, (std::time::Instant, Done)>,
}

/// What a page asked for now is given.
pub(super) enum Ask {
    /// The answer of a walk that finished after its call replied.
    Late(Done),
    /// Nothing yet: this call walks it.
    Walk,
    /// Another call is walking it.
    Pending,
}

/// How long a page's late answer is kept for the next ask: long enough to ask again, short enough not to go stale.
pub(super) const LATE_KEPT: std::time::Duration = std::time::Duration::from_secs(600);

impl Walks {
    pub(super) fn ask(&mut self, key: &str, now: std::time::Instant) -> Ask {
        self.late.retain(|_, (at, _)| now.duration_since(*at) < LATE_KEPT);
        if let Some((_, done)) = self.late.remove(key) {
            return Ask::Late(done);
        }
        if self.walking.insert(key.to_string()) {
            Ask::Walk
        } else {
            Ask::Pending
        }
    }

    /// A page's walk is over. Its answer, when its call no longer waits for it, is kept for the next ask.
    pub(super) fn over(&mut self, key: &str, unheard: Option<Done>, now: std::time::Instant) {
        if let Some(done) = unheard {
            self.late.insert(key.to_string(), (now, done));
        }
        self.walking.remove(key);
    }
}

pub(super) static PAGES: std::sync::LazyLock<std::sync::Mutex<Walks>> = std::sync::LazyLock::new(Default::default);

/// What makes two asks one page's walk: the same goal on the same page, with the same values, for the same session and
/// the same fields. A late answer goes to the next ask of this key, so an ask with other inputs is another page's.
pub(super) fn in_flight(page: &DoBody) -> String {
    let inputs: std::collections::BTreeMap<&String, &String> = page.inputs.iter().collect();
    // The task's budget too: an answer a route over it gave is no answer for a task that can't pay for it.
    format!("{}\n{}\n{inputs:?}\n{}\n{:?}\n{:?}", page.goal.trim().to_lowercase(), page.url.trim(), page.session, page.fields, page.budget_usdc)
}

/// The pages of one site's task. A panic in one ends the task with the rest not run: left marked as walking, each would
/// answer "pending" for as long as the node runs, with nothing walking it.
struct Unfinished {
    keys: Vec<String>,
    walks: &'static std::sync::Mutex<Walks>,
}

impl Drop for Unfinished {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let mut w = self.walks.locked();
            for key in &self.keys {
                w.walking.remove(key);
            }
        }
    }
}

/// The pages of several sites, each site's in a task of its own that outlives this call: a reply comes within
/// `within`, with the pages done by then; the rest go on, and an answer that comes after the reply is kept in
/// `walks` for the next ask. Within a site the first page goes first, then the rest side by side.
pub(super) async fn pages_run<R, F>(sites: Vec<Vec<(usize, DoBody)>>, within: std::time::Duration, walks: &'static std::sync::Mutex<Walks>, run: R) -> Vec<(usize, Done)>
where
    R: Fn((usize, DoBody)) -> F + Clone + Send + Sync + 'static,
    F: std::future::Future<Output = (usize, std::time::Duration, Result<Value, Fail>)> + Send + 'static,
{
    use futures_util::stream::{self, StreamExt};
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(usize, Done)>();
    let mut done: Vec<(usize, Done)> = Vec::new();
    let mut running = 0;
    for site in sites {
        let mut mine: Vec<(usize, DoBody)> = Vec::new();
        for (i, page) in site {
            let ask = walks.locked().ask(&in_flight(&page), std::time::Instant::now());
            match ask {
                Ask::Late(d) => done.push((i, d)),
                Ask::Walk => mine.push((i, page)),
                Ask::Pending => {}
            }
        }
        if mine.is_empty() {
            continue;
        }
        running += mine.len();
        let (tx, run) = (tx.clone(), run.clone());
        let unfinished = Unfinished { keys: mine.iter().map(|(_, p)| in_flight(p)).collect(), walks };
        tokio::spawn(async move {
            let _unfinished = unfinished;
            // Pages go on being walked after the call that asked has answered: a restart waits for them all the same.
            let _busy = crate::update::Busy::enter();
            let rest = mine.split_off(1);
            let first = mine.pop().expect("a site has a page");
            let one = |p: (usize, DoBody)| {
                let (tx, run) = (tx.clone(), run.clone());
                async move {
                    let key = in_flight(&p.1);
                    let (i, took, r) = run(p).await;
                    // Sent, or kept when the call has replied: under one lock, so no ask falls between the two.
                    let mut w = walks.locked();
                    let unheard = tx.send((i, (took, r))).err().map(|e| e.0 .1);
                    w.over(&key, unheard, std::time::Instant::now());
                }
            };
            one(first).await;
            stream::iter(rest.into_iter().map(one)).buffer_unordered(AT_ONCE_PER_SITE).collect::<Vec<()>>().await;
        });
    }
    drop(tx);
    let deadline = tokio::time::sleep(within);
    tokio::pin!(deadline);
    let mut heard = 0;
    while heard < running {
        tokio::select! {
            r = rx.recv() => match r {
                Some(r) => { done.push(r); heard += 1; }
                None => break,
            },
            _ = &mut deadline => break,
        }
    }
    // Closed under the lock: an answer sent before this is read now, one after it is kept for the next ask.
    {
        let _w = walks.locked();
        rx.close();
    }
    while let Ok(r) = rx.try_recv() {
        done.push(r);
    }
    done
}

/// One page of several, done as `do_goal` does it, and how long it took.
pub(super) async fn page_run(node: &Arc<Node>, a: &Agent, (i, body): (usize, DoBody)) -> (usize, std::time::Duration, Result<Value, Fail>) {
    let t = std::time::Instant::now();
    let r = Box::pin(do_goal(node, a, body)).await;
    (i, t.elapsed(), r)
}

/// One page's answer among several: `how`, its time, and its data, or why it has none.
pub(super) fn page_answer(url: &str, took: std::time::Duration, r: Result<Value, Fail>) -> Value {
    let ms = took.as_millis() as u64;
    let r = match r {
        Ok(r) => r,
        Err((_, e)) => return json!({ "url": url, "how": "error", "ms": ms, "ok": false, "error": e }),
    };
    let how = r["how"].as_str().unwrap_or_default().to_string();
    let mut out = json!({ "url": url, "how": how, "ms": ms });
    if let Some(id) = r["route"]["id"].as_str().or_else(|| r["entry"]["id"].as_str()) {
        out["route_id"] = json!(id);
    }
    if !r["route_failed"].is_null() {
        out["route_failed"] = r["route_failed"].clone();
    }
    match how.as_str() {
        "browse" => {
            out["ok"] = json!(false);
            out["why"] = r["why"].clone();
            out["next"] = r["next"].clone();
        }
        _ => {
            let res = &r["result"];
            out["ok"] = res["ok"].clone();
            out["data"] = compact(&res["data"]);
            if !res["error"].is_null() {
                out["error"] = res["error"].clone();
            }
            if !res["truncated"].is_null() {
                out["truncated"] = res["truncated"].clone();
            }
            if let Some(more) = res["fields"].get("more").and_then(|m| m.as_array()).filter(|m| !m.is_empty()) {
                out["fields"] = json!(more.iter().take(FIELDS_PER_ROUTE).collect::<Vec<_>>());
            }
        }
    }
    out
}

#[cfg(test)]
mod fit_tests {
    use super::*;

    /// A page of `records` records of about `each` bytes, answered by a route.
    fn page(url: &str, records: usize, each: usize, cut_before: bool) -> Value {
        let data: Vec<Value> = (0..records).map(|n| json!({ "title": format!("{url} item {n}"), "text": "x".repeat(each) })).collect();
        let mut p = json!({ "url": url, "how": "called", "ms": 300, "route_id": "r", "ok": true, "data": { "results": data } });
        if cut_before {
            p["truncated"] = json!({ "kept_bytes": 65000, "total_bytes": 400_000, "cuts": [], "whole": "/home/u/.unbrowse/answers/1-r.json", "note": "cut at 64 KB" });
        }
        p
    }

    /// Fourteen pages as the search cases answered them (two at a page's 64 KB, one at 56 KB, the rest 1 to 18 KB) come
    /// back in one reply under the budget. The small pages are whole; each big one keeps its first records, says it was
    /// cut, of how much, and how to get the rest, and one already cut keeps where its whole answer is.
    #[test]
    fn many_pages_fit_one_reply_and_each_cut_page_says_how_to_get_the_rest() {
        let sizes = [(14, 1000, false), (66, 1000, true), (56, 1000, false), (1, 200, false), (11, 1000, false), (4, 900, false), (17, 1000, false), (5, 900, false), (3, 800, false), (14, 1000, false), (17, 1000, false), (3, 800, false), (1, 800, false), (66, 1000, true)];
        let pages: Vec<Value> = sizes.iter().enumerate().map(|(i, (k, each, cut))| page(&format!("https://site{i}.example/search?q=lamp"), k * 1024 / each, *each, *cut)).collect();
        let small: Vec<Value> = pages.iter().map(|p| p["data"].clone()).collect();
        let mut reply = json!({ "how": "pages", "ms": 34000, "count": { "called": 14 }, "pages": pages, "fields": {} });
        assert!(serde_json::to_string_pretty(&reply).unwrap().len() > 3 * PAGES_BUDGET, "the case is over the budget");
        fit_pages(&mut reply);
        let shown = serde_json::to_string_pretty(&reply).unwrap().len();
        assert!(shown <= PAGES_BUDGET, "{shown} over {PAGES_BUDGET}");
        assert!(shown >= PAGES_BUDGET * 3 / 4, "the pages are given the room there is: {shown} of {PAGES_BUDGET}");
        let pages = reply["pages"].as_array().unwrap();
        assert_eq!(pages.len(), 14);
        for (i, p) in pages.iter().enumerate() {
            assert!(p["data"]["results"].as_array().is_some_and(|r| !r.is_empty()), "page {i} keeps records: {}", p["data"]);
        }
        assert_eq!(pages[3]["data"], small[3], "a small page is whole");
        assert!(pages[3]["truncated"].is_null());
        let big = &pages[2]["truncated"];
        assert_eq!(big["total_bytes"].as_u64().unwrap() as usize, serde_json::to_vec(&small[2]).unwrap().len());
        let note = big["note"].as_str().unwrap();
        assert!(note.contains("https://site2.example/search?q=lamp") && note.contains("alone"), "{note}");
        let before = &pages[1]["truncated"];
        assert_eq!(before["total_bytes"], 400_000);
        assert!(before["note"].as_str().unwrap().contains("/home/u/.unbrowse/answers/1-r.json"), "{before}");
    }

    /// A reply that fits is left as it is.
    #[test]
    fn a_reply_that_fits_is_untouched() {
        let mut reply = json!({ "how": "pages", "pages": [page("https://a.example/s?q=x", 5, 100, false)], "fields": {} });
        let before = reply.clone();
        fit_pages(&mut reply);
        assert_eq!(reply, before);
    }

    /// The pages reply saved from a real call, cut as a node would cut it, when UNB_PAGES_REPLY names one.
    #[test]
    fn a_saved_pages_reply_fits_when_named() {
        let Ok(path) = std::env::var("UNB_PAGES_REPLY") else { return };
        let mut reply: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let before = serde_json::to_string_pretty(&reply).unwrap().len();
        fit_pages(&mut reply);
        let after = serde_json::to_string_pretty(&reply).unwrap();
        println!("{path}: {before} characters before, {} after", after.len());
        for p in reply["pages"].as_array().unwrap() {
            println!("  {} kept {} of {} bytes", p["url"], p["truncated"]["kept_bytes"], p["truncated"]["total_bytes"]);
        }
        assert!(after.len() <= PAGES_BUDGET);
        std::fs::write(format!("{path}.fitted.json"), after).unwrap();
    }
}
