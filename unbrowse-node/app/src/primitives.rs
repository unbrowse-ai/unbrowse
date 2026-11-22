//! The primitive matrix (`learn.matrix`): a local site with one page for each way a page moves a value or changes
//! state, and a runner that has the node learn a row from one walk of its page and then call it for another value.
//!
//! A row passes when the call answers for the new value, no browser ran for it, and nothing it did reached above the
//! row's ceiling (`learn.rung`). The runner goes through the node's own learner and caller (`learn::learn_goal`,
//! `run::call`), so a row that passes here is a page the node answers for an agent.
//!
//! The site names no real site. It is served on loopback, and every endpoint checks what it receives, so a row only
//! answers when each value was made right. The rows are in `primitives/matrix.json`; which of them pass today is in
//! `primitives/baseline.json`, written by `the_matrix_baseline_is_written`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{learn, run, store};

/// One row of the matrix (`primitives/matrix.json`).
#[derive(Clone, Debug, Deserialize)]
pub struct Row {
    pub id: String,
    pub family: String,
    pub page: String,
    /// The highest rung a call of the row may reach.
    pub ceiling: u8,
    /// Only a person can pass it: the node asks its owner, and never runs it headless.
    pub person: bool,
    /// The value the row's page is walked with, and the one its route is then called for, where the row is about a
    /// kind of value a word is not (a date): `kettle` and `teapot` otherwise.
    #[serde(default)]
    pub walked: Option<String>,
    #[serde(default)]
    pub called: Option<String>,
    /// The value of the same kind the row's route is called for third, after the confirming browse of `called` (arm B
    /// of the A/B of the node's own asks): `saucepan` otherwise.
    #[serde(default)]
    pub third: Option<String>,
    /// A value the site holds nothing for, asked between `called` and `third` (arm B): its confirming browse must not
    /// agree, and must put nothing in the standing route's place, so the third value is answered by the route that
    /// stood after `called` agreed.
    #[serde(default)]
    pub unknown: Option<String>,
    /// The row is about the first ask alone, as a fresh node serves it: the route one walk of the page keeps must be a
    /// call of the page's own site, with no second sighting to set it right.
    #[serde(default)]
    pub first: bool,
    /// What a `first` row asks for: `search items` otherwise.
    #[serde(default)]
    pub goal: Option<String>,
}

impl Row {
    /// The value the row is walked with.
    pub fn walked(&self) -> &str {
        self.walked.as_deref().unwrap_or(WALKED)
    }

    /// The value the row's route is called for.
    pub fn called(&self) -> &str {
        self.called.as_deref().unwrap_or(CALLED)
    }

    /// The value the row's route is called for third, its first warm call after the confirming browse.
    pub fn third(&self) -> &str {
        self.third.as_deref().unwrap_or(THIRD)
    }
}

/// The families every matrix has rows of.
pub const FAMILIES: [&str; 6] = ["sources", "transports", "codecs", "state", "contexts", "person"];

pub fn matrix() -> Vec<Row> {
    let file: Value = serde_json::from_str(include_str!("primitives/matrix.json")).expect("the matrix reads");
    serde_json::from_value(file["rows"].clone()).expect("the matrix's rows read")
}

fn row(id: &str) -> Row {
    matrix().into_iter().find(|r| r.id == id).unwrap_or_else(|| panic!("no row {id} in the matrix"))
}

/// What the site remembers between requests: what it issued, so it can refuse what it didn't.
#[derive(Default)]
struct Site {
    /// The form token each visitor's page was given.
    form_tokens: HashMap<String, String>,
    /// Tokens and passes the site handed out.
    issued: HashSet<String>,
    /// Sessions it started.
    sessions: HashSet<String>,
    /// The place each id it suggested names.
    places: HashMap<String, String>,
    made: u64,
}

type Db = Arc<Mutex<Site>>;

fn new_id(db: &Db, prefix: &str) -> String {
    let mut site = db.lock().expect("the site's state");
    site.made += 1;
    let seed = format!("{prefix}{}{:?}", site.made, std::time::SystemTime::now());
    format!("{prefix}{}", &hex::encode(Sha256::digest(seed.as_bytes()))[..16])
}

/// Whether the site holds nothing for a value: its catalogue has nothing under a word that begins `qzx` (the rows'
/// made-up word), whatever page asks.
fn nothing_for(q: &str) -> bool {
    q.to_lowercase().starts_with("qzx")
}

/// The records a search answers with. They say the value back, so an answer for another value is another answer.
fn records(q: &str) -> Vec<Value> {
    vec![json!({ "title": format!("{q} one"), "price": 12 }), json!({ "title": format!("{q} two"), "price": 34 }), json!({ "title": format!("{q} three"), "price": 56 })]
}

fn results(row: &str, q: &str) -> Value {
    json!({ "row": row, "query": q, "results": records(q) })
}

fn refuse(why: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": why }))).into_response()
}

fn head(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(String::from)
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let all = head(headers, "cookie")?;
    all.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
}

/// The site's own mixing function, as `/s/signed-own.js` writes it: no standard hash, so only the site's code makes it.
fn mix(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for c in s.encode_utf16() {
        h ^= u32::from(c);
        h = h.wrapping_mul(0x0100_0193);
        h ^= h >> 13;
    }
    format!("{h:08x}")
}

/// The word a posted protobuf message searches for: field 1, a text, beside field 2, the count 20. Read field by field,
/// as the wire format writes them; anything else is no message the page sends.
fn searched_for(b: &[u8]) -> Option<String> {
    let varint = |at: &mut usize| -> Option<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *b.get(*at)?;
            *at += 1;
            v |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    };
    let (mut at, mut word, mut count) = (0, None, None);
    while at < b.len() {
        let key = varint(&mut at)?;
        match (key >> 3, key & 7) {
            (1, 2) => {
                let len = varint(&mut at)? as usize;
                word = Some(String::from_utf8(b.get(at..at + len)?.to_vec()).ok()?);
                at += len;
            }
            (2, 0) => count = Some(varint(&mut at)?),
            _ => return None,
        }
    }
    (count == Some(20)).then_some(word).flatten()
}

/// The word a long posted message searches for: field 1 the word, field 2 the count 300, field 3 a note of 150 `n`s,
/// read by its wire format.
fn searched_for_long(b: &[u8]) -> Option<String> {
    let mut word = vec![0x0a];
    let at = 2 + *b.get(1)? as usize;
    word.extend(b.get(1..at)?);
    let tail: Vec<u8> = [0x10, 0xac, 0x02, 0x1a, 0x96, 0x01].into_iter().chain(std::iter::repeat_n(b'n', 150)).collect();
    (b.get(at..)? == tail.as_slice()).then(|| String::from_utf8(b.get(2..at)?.to_vec()).ok()).flatten()
}

/// A search's answer as MessagePack: maps, lists, texts and small counts, each in its narrowest form.
fn packed(v: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    fn go(v: &Value, out: &mut Vec<u8>) {
        match v {
            Value::Object(m) => {
                out.push(0x80 | m.len() as u8);
                for (k, v) in m {
                    go(&Value::String(k.clone()), out);
                    go(v, out);
                }
            }
            Value::Array(a) => {
                out.push(0x90 | a.len() as u8);
                a.iter().for_each(|v| go(v, out));
            }
            Value::String(s) if s.len() < 32 => {
                out.push(0xa0 | s.len() as u8);
                out.extend(s.as_bytes());
            }
            Value::String(s) => {
                out.extend([0xd9, s.len() as u8]);
                out.extend(s.as_bytes());
            }
            Value::Number(n) => match n.as_u64().unwrap_or_default() {
                small @ 0..=0x7f => out.push(small as u8),
                byte => out.extend([0xcc, byte as u8]),
            },
            _ => out.push(0xc0),
        }
    }
    go(v, &mut out);
    out
}

/// The places the `place-code` page's script ships, each with the code its search sends.
fn place_table() -> Vec<Value> {
    [("Lisbon", "LIS", "PT"), ("Oslo", "OSL", "NO"), ("Porto", "OPO", "PT"), ("Kettleby", "KTB", "GB"), ("Teapot Dome", "TPD", "US")]
        .iter()
        .map(|(name, code, country)| json!({ "name": name, "code": code, "country": country }))
        .collect()
}

/// A date written `dd/mm/yyyy`, as `yyyy-mm-dd`: None where it is not a real day written so.
fn dated(d: &str) -> Option<String> {
    let parts: Vec<&str> = d.split('/').collect();
    let [day, month, year] = parts[..] else { return None };
    if day.len() != 2 || month.len() != 2 || year.len() != 4 {
        return None;
    }
    let (day, month, year): (u32, u32, i32) = (day.parse().ok()?, month.parse().ok()?, year.parse().ok()?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    (1..=days).contains(&day).then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// The page's own proof-of-work search, as `/p/pow` runs it inline: read the challenge from the HTML, count up from
/// zero until SHA-256 of the challenge, a colon and the count opens with three zero hex digits, then send both. The
/// count is not the page's secret — the server checks the condition, so any count that meets it is accepted.
const SOLVE: &str = "fetch('/api/pow/challenge').then(json).then(async function (j) {\n       var c = j.challenge, enc2 = new TextEncoder();\n       for (var n = 0; ; n++) {\n         var buf = await crypto.subtle.digest('SHA-256', enc2.encode(c + ':' + n));\n         var hex2 = Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');\n         if (hex2.slice(0, 3) === '000') { fetch('/api/pow/search?q=' + enc(q) + '&c=' + enc(c) + '&n=' + n).then(json).then(show); break; }\n       }\n     });";

/// Whether a clock reading a request carries (milliseconds) is the present, give or take ten minutes.
fn now_ish(ts: &str) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i128).unwrap_or(0);
    ts.parse::<i128>().is_ok_and(|t| (now - t).abs() < 600_000)
}

/// A row's page: what any search page has (links to the rest of the site, a box to type in), a list for the results,
/// the helpers every row's script uses, and the row's own script. A page with a script, nothing to type in and no
/// link home is what a site's check for a person looks like (`page::a_door`), and these are pages.
fn page(title: &str, extra: &str, script: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>{extra}</head>\
         <body><nav><a href=\"/\">Home</a> <a href=\"/about\">About this shop</a></nav>\
         <h1>{title}</h1><form action=\"\" method=\"get\"><input type=\"search\" name=\"q\" id=\"q\"><button>Search</button></form>\
         <ul id=\"results\"></ul><script>\n\
         function show(data) {{ var ul = document.getElementById('results'); (data.results || []).forEach(function (r) {{ var li = document.createElement('li'); li.textContent = r.title + ' ' + r.price; ul.appendChild(li); }}); }}\n\
         function json(r) {{ return r.json(); }}\n\
         var q = new URLSearchParams(location.search).get('q') || '';\n\
         var enc = encodeURIComponent;\n{script}\n</script></body></html>"
    ))
}

async fn a_page(State(db): State<Db>, Path(id): Path<String>, Query(asked): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let simple = |title: &str, script: &str| page(title, "", script).into_response();
    match id.as_str() {
        "plain" => simple("Search items", "fetch('/api/plain/search?q=' + enc(q)).then(json).then(show);"),
        // A search the page asks its own API for, which tells the API the page's address for its logs: for a value the
        // site holds nothing for, the API answers its envelope alone (the ask said back and its cache's bookkeeping,
        // no results place at all). Asked first, on a fresh node.
        "first-unknown-api" => simple("Search items", "fetch('/api/first-unknown-api/search?q=' + enc(q) + '&page_url=' + enc(location.href)).then(json).then(show);"),
        "word-by-word" => simple("Search items", "fetch('/api/word-by-word/search?q=' + enc(q)).then(json).then(show);"),
        "one-record" => simple("Item", "fetch('/api/one-record/search?q=' + enc(q)).then(json).then(show);"),
        // A search page the server renders: results in its main part, a heading's word linking to the site's
        // categories, sponsors after its footer. For a value the site holds nothing for, it says so under its
        // headings and links only from that frame. Asked first, on a fresh node.
        "first-unknown-page" => {
            let q = asked.get("q").cloned().unwrap_or_default();
            let found: String = if nothing_for(&q) {
                format!("<div class=\"callout\"><p>There was nothing for '{q}'</p></div>")
            } else {
                records(&q).iter().map(|r| format!("<a class=\"card\" href=\"/item/{t}\"><h3>{t}</h3><p>{p} for the kitchen, from the shop's own range</p></a>", t = r["title"].as_str().unwrap_or_default(), p = r["price"])).collect()
            };
            let n = if nothing_for(&q) { 0 } else { 3 };
            Html(format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>Search items</title></head><body><a href=\"#content\">Skip to main content</a><nav><a href=\"/\">Home</a> <a href=\"/about\">About this shop</a></nav>\
                 <main id=\"content\"><div><h2>Filter by <a href=\"/categories\">category</a></h2><form><input type=\"checkbox\" id=\"c1\"><label for=\"c1\">Kettles</label><input type=\"checkbox\" id=\"c2\"><label for=\"c2\">Teapots</label></form></div>\
                 <div><h2>Search results</h2><form action=\"\" method=\"get\"><p><strong>{n}</strong> items for \"{q}\"</p><input type=\"search\" name=\"q\" id=\"q\"><button>Search</button></form>{found}</div></main>\
                 <footer><a href=\"/help\">Help</a> <a href=\"/returns\">Returns</a></footer><div class=\"sponsors\"><a href=\"http://localhost/sponsor-one\"><span>Sponsor One</span> <span>Gold sponsor</span></a> <a href=\"http://localhost/sponsor-two\"><span>Sponsor Two</span> <span>Silver sponsor</span></a></div><a href=\"/sitemap\">Site map</a><script>window.started = true;</script></body></html>"
            ))
            .into_response()
        }
        // A token the page's own HTML carries, good for this visitor only.
        "html-token" => {
            let visitor = cookie(&headers, "v").unwrap_or_else(|| new_id(&db, "v_"));
            let token = new_id(&db, "f_");
            db.lock().expect("the site's state").form_tokens.insert(visitor.clone(), token.clone());
            let body = page("Search items", &format!("<meta name=\"form-token\" content=\"{token}\">"), "var t = document.querySelector('meta[name=form-token]').content;\nfetch('/api/html-token/search?q=' + enc(q), { headers: { 'x-form-token': t } }).then(json).then(show);");
            ([(header::SET_COOKIE, format!("v={visitor}; Path=/"))], body).into_response()
        }
        // A token the page keeps in its storage: asked for once, read from storage after.
        "storage-token" => simple(
            "Search items",
            "function go(t) { fetch('/api/storage-token/search?q=' + enc(q), { headers: { 'x-token': t } }).then(json).then(show); }\n\
             var kept = localStorage.getItem('token');\n\
             if (kept) { go(kept); } else { fetch('/api/storage-token/issue', { method: 'POST' }).then(json).then(function (j) { localStorage.setItem('token', j.token); go(j.token); }); }",
        ),
        // The caller's value inside a longer value of the request: as JSON, and as that JSON encoded again.
        "packed-json" => simple("Search items", "fetch('/api/packed-json/search?variables=' + enc(JSON.stringify({ query: q, first: 3 }))).then(json).then(show);"),
        "packed-base64" => simple("Search items", "fetch('/api/packed-base64/search?v=' + enc(btoa(JSON.stringify({ query: q, first: 3 })))).then(json).then(show);"),
        // The caller's value is looked up first, and the answer's id is what the search sends.
        "lookup" => simple("Search places", "fetch('/api/lookup/suggest?q=' + enc(q)).then(json).then(function (s) { return fetch('/api/lookup/search?place=' + enc(s.places[0].id)); }).then(json).then(show);"),
        // A header the page makes from the clock and the value with a standard hash.
        "signed-standard" => simple(
            "Search items",
            "var ts = String(Date.now());\n\
             crypto.subtle.digest('SHA-256', new TextEncoder().encode(ts + ':' + q + ':fixture-key')).then(function (buf) {\n\
               var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');\n\
               return fetch('/api/signed-standard/search?q=' + enc(q), { headers: { 'x-ts': ts, 'x-sig': hex } });\n\
             }).then(json).then(show);",
        ),
        // The same, made by a function of the site's own that no standard operation is.
        "signed-own" => page("Search items", "<script src=\"/s/signed-own.js\"></script>", "searchSigned(q, show);").into_response(),
        // An answer the page decodes with its own code: the reply is ciphered (XORed, then base64), and only the
        // page's own `unpack` turns it back into the records. No standard reader reads it.
        "cipher-answer" => page("Search items", "<script src=\"/s/cipher.js\"></script>", "searchCipher(q, show);").into_response(),
        "post-json" => simple("Search items", "fetch('/api/post-json/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) }).then(json).then(show);"),
        // The results come as a stream of events.
        "events" => simple(
            "Search items",
            "fetch('/api/events/search?q=' + enc(q)).then(function (r) { return r.text(); }).then(function (text) {\n\
               show({ results: text.split('\\n').filter(function (l) { return l.indexOf('data: ') === 0; }).map(function (l) { return JSON.parse(l.slice(6)); }) });\n\
             });",
        ),
        // A value the page searches for rather than computes: a proof-of-work nonce. The page fetches a fresh
        // challenge, finds the least count whose SHA-256 after the challenge and a colon opens with three zeros, and
        // sends both. The server checks the condition, not which count the page found.
        "pow" => simple("Search items", SOLVE),
        // The answer is JSON, encoded again as text.
        "base64-answer" => simple("Search items", "fetch('/api/base64-answer/search?q=' + enc(q)).then(function (r) { return r.text(); }).then(function (t) { show(JSON.parse(atob(t))); });"),
        // The answer is one record a line.
        "json-lines" => simple(
            "Search items",
            "fetch('/api/json-lines/search?q=' + enc(q)).then(function (r) { return r.text(); }).then(function (t) { show({ results: t.split('\\n').filter(Boolean).map(function (l) { return JSON.parse(l); }) }); });",
        ),
        // The search answers only a session the page started.
        "session-cookie" => simple("Search items", "fetch('/api/session-cookie/start', { method: 'POST' }).then(function () { return fetch('/api/session-cookie/search?q=' + enc(q)); }).then(json).then(show);"),
        // The call is made by a frame of the page, and by a worker.
        "frame" => simple("Search items", "var f = document.createElement('iframe'); f.src = '/p/frame-inner?q=' + enc(q); document.body.appendChild(f);"),
        "frame-inner" => simple("Results", "fetch('/api/frame/search?q=' + enc(q)).then(json).then(show);"),
        "worker" => simple("Search items", "var w = new Worker('/s/worker.js'); w.onmessage = function (e) { show(e.data); }; w.postMessage(q);"),
        // Nothing is asked for until someone presses the button.
        "person-check" => page(
            "Search items",
            "",
            "document.body.insertAdjacentHTML('beforeend', '<button id=\"here\">I am here</button>');\n\
             document.getElementById('here').addEventListener('click', function () {\n\
               fetch('/api/person-check/pass', { method: 'POST' }).then(json).then(function (p) { return fetch('/api/person-check/search?q=' + enc(q), { headers: { 'x-pass': p.pass } }); }).then(json).then(show);\n\
             });",
        )
        .into_response(),
        // The results are in the page's own HTML, in its state, inside a list of one entry that wraps all of it, beside
        // a title and logging ids that say the search back. No call is made: the page is the route.
        // A value the site holds nothing for is answered with its results page all the same: the results state with an
        // empty list, beside the site's interface copy and its filters, the value named in the page's own words. The
        // route that answers is the results state; the copy is the page's for any value.
        "unknown-frame" => {
            let q = asked.get("q").cloned().unwrap_or_default();
            // Records that read as a site's do: long enough to be lines of their own once the value is struck out.
            let found: Vec<Value> = if nothing_for(&q) {
                Vec::new()
            } else {
                // Other things for another value, not the same names with the value swapped: a search for another
                // word finds other records.
                let kinds: [&str; 8] = match q.chars().next() {
                    Some('t') => ["one bone china with gold rim", "two loose leaf infuser glass", "three cast iron tetsubin", "four stoneware for six cups", "five clay yixing small", "six double walled thermal", "seven floral porcelain set", "eight travel with strainer"],
                    Some('s') => ["one nonstick with glass lid", "two copper core triple ply", "three milk pan with spout", "four stainless induction ready", "five enamelled cast iron", "six aluminium camping light", "seven ceramic coated green", "eight heavy base for sauces"],
                    _ => ["one enamel stovetop model", "two brushed steel classic", "three glass electric with light", "four copper camping edition", "five matte black gooseneck", "six cast iron heritage", "seven travel folding silicone", "eight smart temperature control"],
                };
                kinds
                    .iter()
                    .map(|k| json!({ "title": format!("{q} {k}"), "price": 12, "seller": "The shop's own range of things for the kitchen" }))
                    .collect()
            };
            let state = json!({ "search": { "query": q.clone(), "results": found.clone() },
                "filters": [{ "name": "Free returns" }, { "name": "In stock" }, { "name": "On sale today" }],
                "said": { "heading": format!("Results for {q}"), "crumb": format!("Home > Search > {q}"), "box": format!("You searched for {q}"), "share": format!("Share your search for {q}") } });
            // The site's interface copy, which says the value back on several lines whatever was found: for a value it
            // has nothing for, it is the page's largest blob, as the live page's was.
            let copy = json!({ "copyTags": { "heading": format!("Results for {q}"), "searching": format!("Searching {q} across the shop"), "popular": format!("Popular with people searching {q}"), "sort": format!("{q}: sort by price or rating"),
                "deals": "Deals for the weekend on things for the kitchen", "next": "Where are you going next with your kitchen?", "sign_in": "Sign in and save on your next order", "help": "Help with an order, a return or a delivery", "returns": "Returns are free for thirty days on every order" } });
            // The page lists what its state holds, as a results page does, under a heading that names the value.
            let listed: String = if nothing_for(&q) { "<li>Nothing matched your search.</li>".to_string() } else { found.iter().map(|r| format!("<li>{} {}</li>", r["title"].as_str().unwrap_or_default(), r["price"])).collect() };
            Html(format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>Search items</title></head><body><nav><a href=\"/\">Home</a> <a href=\"/about\">About this shop</a></nav>\
                 <h1>Results for {q}</h1><form action=\"\" method=\"get\"><input type=\"search\" name=\"q\" id=\"q\"><button>Search</button></form><ul id=\"results\">{listed}</ul>\
                 <script id=\"page-state\" type=\"application/json\">{state}</script><script id=\"page-copy\" type=\"application/json\">{copy}</script><script>window.started = true;</script></body></html>"
            ))
            .into_response()
        }
        // A value the site holds nothing for is sent to its front page, with a marker of its own and none of the value;
        // the front page loads its interface copy by a call of its own. Any other value is searched.
        "unknown-elsewhere" => {
            let q = asked.get("q").cloned().unwrap_or_default();
            if nothing_for(&q) {
                return (StatusCode::FOUND, [(header::LOCATION, "/p/unknown-home?label=gen1&error_unknown=q")]).into_response();
            }
            simple("Search items", "fetch('/api/unknown-elsewhere/search?q=' + enc(q)).then(json).then(show);")
        }
        // The page lists its records in its own document, and its script asks another host about the asked value:
        // that host's answer is a record about the subject, naming the goal's words only in its keys (`items_url`,
        // an address template). The page is the answer; the other host's call did not make what the page showed.
        // The same, where the other host's record names the value back as a field of its own, as a record about a
        // subject does.
        "foreign-subject" | "foreign-named" => {
            let q = asked.get("q").cloned().unwrap_or_default();
            // Other things for another value, as a search finds: not the same names with the value swapped.
            let kinds: [&str; 6] = match q.chars().next() {
                Some('t') => ["bone china with gold rim", "loose leaf infuser glass", "cast iron tetsubin", "stoneware for six cups", "clay yixing small", "floral porcelain set"],
                Some('s') => ["nonstick with glass lid", "copper core triple ply", "milk pan with spout", "stainless induction ready", "enamelled cast iron", "ceramic coated green"],
                _ => ["enamel stovetop model", "brushed steel classic", "glass electric with light", "copper camping edition", "matte black gooseneck", "cast iron heritage"],
            };
            let said = ["one", "two", "three", "four", "five", "six"];
            // A listing whose lines name the value (a search's), or, for `foreign-named`, lines that don't (a release
            // history: a version and a day), with the value named around them, in the heading, the summary and how to
            // get it.
            let listed: String = if id == "foreign-named" {
                (0..6).map(|n| format!("<li>version 3.{n}.0, released on day {} of the month</li>", 10 + n)).collect::<String>() + &format!("<p>Get {q} with the shop's own installer: install {q}</p>")
            } else {
                kinds.iter().zip(said).enumerate().map(|(n, (k, s))| format!("<li>{q} {s} {k} {}</li>", 10 + n)).collect()
            };
            Html(format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>Search items</title></head><body><nav><a href=\"/\">Home</a> <a href=\"/about\">About this shop</a></nav>\
                 <h1>Items for {q}</h1><form action=\"\" method=\"get\"><input type=\"search\" name=\"q\" id=\"q\"><button>Search</button></form><ul id=\"results\">{listed}</ul>\
                 <p><a href=\"http://localhost:{port}/code/{q}\">The code for {q}, elsewhere</a></p>{summary}\
                 <script>fetch('http://localhost:' + location.port + '/api/{id}/about?name=' + encodeURIComponent({qj})).then(function (r) {{ return r.json(); }}).then(function (d) {{ window.about = d; }});</script></body></html>",
                port = headers.get("host").and_then(|h| h.to_str().ok()).and_then(|h| h.rsplit(':').next()).unwrap_or_default(),
                qj = serde_json::to_string(&q).unwrap_or_default(),
                id = id,
                // The subject's one line of summary, which the other host's record carries too.
                summary = if id == "foreign-named" { "<p>Things for the kitchen, made to last a lifetime.</p><h2>Release history</h2>".to_string() } else { String::new() },
            ))
            .into_response()
        }
        "unknown-home" => page("Find your next thing", "", "fetch('/api/unknown-home/popular').then(json).then(function (c) { show({ results: c.popular }); });").into_response(),
        "wrapped-state" => {
            let q = asked.get("q").cloned().unwrap_or_default();
            let state = json!({ "clientData": [["Search:1", { "data": { "search": {
                "seo": { "pageTitle": format!("{q} in the shop"), "canonicalUrl": format!("/p/wrapped-state?q={q}"), "ogTitle": format!("Shop {q}"), "description": format!("Everything for {q}") },
                "logging": { "sectionId": format!("{q}-1"), "searchId": format!("s-{q}"), "sessionId": format!("u-{q}"), "context": format!("{q}|shop"), "federatedId": format!("f-{q}") },
                "input": {
                    "place": { "__typename": "PlaceInput", "text": q.clone(), "placeId": "p1" },
                    "dates": { "__typename": "DatesInput", "label": "Any week", "flexible": true },
                    "guests": { "__typename": "GuestsInput", "adults": 2, "children": 0 },
                    "ages": { "__typename": "AgesInput", "limit": 17, "note": "Ages 2 to 17" },
                    "pets": { "__typename": "PetsInput", "allowed": false, "fee": "none" }
                },
                "results": records(&q)
            } } }]] });
            let listed: String = records(&q).iter().map(|r| format!("<li>{} {}</li>", r["title"].as_str().unwrap_or_default(), r["price"])).collect();
            Html(format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>{q} in the shop</title></head><body><nav><a href=\"/\">Home</a> <a href=\"/about\">About this shop</a></nav>\
                 <h1>Search items</h1><form action=\"\" method=\"get\"><input type=\"search\" name=\"q\" id=\"q\"><button>Search</button></form><ul id=\"results\">{listed}</ul>\
                 <script id=\"page-state\" type=\"application/json\">{state}</script><script>window.started = true;</script></body></html>"
            ))
            .into_response()
        }
        // The caller's date, sent in the site's own written form: the page is asked `2026-03-04`, its call sends the day,
        // the month and the year with slashes.
        "date-format" => simple("Search dates", "var p = q.split('-');\nfetch('/api/date-format/search?d=' + enc(p[2] + '/' + p[1] + '/' + p[0])).then(json).then(show);"),
        // The caller's word turned into the site's code by a table the page's script ships: no call looks it up. The page
        // links to its other places, as a page of destinations does.
        "place-code" => page(
            "Search places",
            "<p>Also: <a href=\"/p/place-code?q=Oslo\">Oslo</a> <a href=\"/p/place-code?q=Porto\">Porto</a></p>",
            &format!("var PLACES = {};\nvar p = PLACES.find(function (r) {{ return r.name.toLowerCase() === q.toLowerCase(); }});\nif (p) {{ fetch('/api/place-code/search?place=' + enc(p.code)).then(json).then(show); }}", serde_json::to_string(&place_table()).unwrap_or_default()),
        )
        .into_response(),
        // The search is posted as a protobuf message with no schema the page names: field 1 the word, field 2 a count.
        "protobuf-search" => simple(
            "Search items",
            "var w = new TextEncoder().encode(q); var b = new Uint8Array(4 + w.length); b[0] = 0x0a; b[1] = w.length; b.set(w, 2); b[2 + w.length] = 0x10; b[3 + w.length] = 0x14;\n\
             fetch('/api/protobuf-search/search', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: b }).then(json).then(show);",
        ),
        // The same, as most messages are: a count of 300 and a note of 150 bytes, each written with bytes past 127, so the
        // body is no text.
        "protobuf-long" => simple(
            "Search items",
            "var w = new TextEncoder().encode(q), note = new TextEncoder().encode(new Array(151).join('n'));\n\
             var b = new Uint8Array(2 + w.length + 3 + 3 + note.length); var i = 0; b[i++] = 0x0a; b[i++] = w.length; b.set(w, i); i += w.length;\n\
             b[i++] = 0x10; b[i++] = 0xac; b[i++] = 0x02; b[i++] = 0x1a; b[i++] = 0x96; b[i++] = 0x01; b.set(note, i);\n\
             fetch('/api/protobuf-long/search', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: b }).then(json).then(show);",
        ),
        // The answer is MessagePack, which the page's own script unpacks.
        "msgpack-answer" => simple(
            "Search items",
            "function unpack(b) { var i = 0; var text = function (l) { var s = new TextDecoder().decode(b.subarray(i, i + l)); i += l; return s; };\n\
               function r() { var t = b[i++], n, o, a; if (t < 0x80) return t; if (t < 0x90) { o = {}; for (n = t & 15; n--;) { var k = r(); o[k] = r(); } return o; }\n\
                 if (t < 0xa0) { a = []; for (n = t & 15; n--;) a.push(r()); return a; } if (t < 0xc0) return text(t & 31); if (t === 0xd9) return text(b[i++]); if (t === 0xcc) return b[i++]; throw new Error('tag ' + t); }\n\
               return r(); }\n\
             fetch('/api/msgpack-answer/search?q=' + enc(q)).then(function (r) { return r.arrayBuffer(); }).then(function (buf) { show(unpack(new Uint8Array(buf))); });",
        ),
        // A header made by a function of the site's own that reads the page's world: a cookie the page was given, and
        // a seed it asked for once and keeps in its storage. Neither is sent as itself; both are mixed in.
        "signed-reads" => {
            let visitor = cookie(&headers, "vid").filter(|v| db.lock().expect("the site's state").issued.contains(v)).unwrap_or_else(|| {
                let v = new_id(&db, "v_");
                db.lock().expect("the site's state").issued.insert(v.clone());
                v
            });
            let body = page("Search items", "<script src=\"/s/signed-reads.js\"></script>", "searchReading(q, show);");
            ([(header::SET_COOKIE, format!("vid={visitor}; Path=/"))], body).into_response()
        }
        // The control: a page whose search answers for the walk's value whatever it is asked.
        "lies" => simple("Search items", "fetch('/api/lies/search?q=' + enc(q)).then(json).then(show);"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn a_script(Path(name): Path<String>) -> Response {
    let js = |body: &'static str| ([(header::CONTENT_TYPE, "application/javascript")], body).into_response();
    match name.as_str() {
        "signed-own.js" => js("(function () {\n\
             function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n\
             window.searchSigned = function (q, done) {\n\
               var ts = String(Date.now());\n\
               fetch('/api/signed-own/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q) + mix(q + '|' + ts) } }).then(function (r) { return r.json(); }).then(done);\n\
             };\n\
             })();\n"),
        "signed-reads.js" => js("(function () {\n\
             function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n\
             function vid() { var m = document.cookie.match(/(?:^|; )vid=([^;]*)/); return m ? m[1] : ''; }\n\
             function send(q, done) {\n\
               var ts = String(Date.now());\n\
               var seed = localStorage.getItem('seed') || '';\n\
               fetch('/api/signed-reads/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q + '|' + seed + '|' + vid()) } }).then(function (r) { return r.json(); }).then(done);\n\
             }\n\
             window.searchReading = function (q, done) {\n\
               if (localStorage.getItem('seed')) { send(q, done); return; }\n\
               fetch('/api/signed-reads/seed', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (j) { localStorage.setItem('seed', j.seed); send(q, done); });\n\
             };\n\
             })();\n"),
        "cipher.js" => js("(function () {\n\
             function unpack(t) {\n\
               var raw = atob(t), out = '';\n\
               for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a);\n\
               return JSON.parse(out);\n\
             }\n\
             window.searchCipher = function (q, done) {\n\
               fetch('/api/cipher-answer/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n\
             };\n\
             })();\n"),
        "worker.js" => js("onmessage = function (e) { fetch('/api/worker/search?q=' + encodeURIComponent(e.data)).then(function (r) { return r.json(); }).then(function (d) { postMessage(d); }); };\n"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// A row's search. Each row checks the one thing it is about, and refuses a request that got it wrong.
async fn search(State(db): State<Db>, Path(id): Path<String>, Query(asked): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let get = |k: &str| asked.get(k).cloned().unwrap_or_default();
    let q = get("q");
    let mut site = db.lock().expect("the site's state");
    match id.as_str() {
        "plain" | "frame" | "worker" | "unknown-elsewhere" => Json(results(&id, &q)).into_response(),
        // As the live API answers: its account of the request (the caller's own user agent said back with a mark, a
        // note in brackets for who asked), its cache's bookkeeping, and the records place, empty, beside counts of
        // nothing and a note in brackets where the routing would be.
        "first-unknown-api" if nothing_for(&q) => {
            let agent = head(&headers, "user-agent").unwrap_or_default();
            Json(json!({ "session_context": { "username": "(guest user)", "client_characterization": { "client_useragent": format!("{agent}:sua"), "client_ip": "203.0.113.7:sra" } },
                "request": { "client_request_parameters": { "client_url": get("page_url"), "user_query": q } },
                "caching": { "search": { "name": "PX-1x7o:XX-T:sr-Q:9ad9ba12+CS:some", "acceptable_names": ["PX-1x7o:XX-T:std-Q:9ad9ba12+CS:some"], "statsd_bucket": "search.cache.metadata.search_results", "utilization": { "hit": true } } },
                "response": { "header": { "succeeded": true, "query_time": 328, "forensics": { "routing": { "index_addressed": "(cannot determine without hits)" } } }, "body": { "hits": { "total": 0, "returned": 0, "hits": [] } }, "hit_schema": [] } }))
            .into_response()
        }
        "first-unknown-api" => Json(results(&id, &q)).into_response(),
        // A search that reads its value word by word: its records say the value's last word, one of them the value
        // whole, and nothing says the ask back.
        // One record for the value asked, an object and no list of records: the value said back as its code, its
        // owner, its shelf and its counts of its own, empty lists of its traits, and its handles keyed by name.
        "one-record" => {
            let id = hex::encode(Sha256::digest(q.as_bytes()));
            Json(json!({ "code": q, "kind": 0, "owner": { "id": format!("4{}", &id[..17]), "handle": "harbour", "avatar": &id[..32], "flags": 0 },
                "shelf": { "id": format!("5{}", &id[17..35]), "label": "Kilns", "level": 2, "traits": [] },
                "counts": { "held": 4211, "seen": 389, "badges": [] }, "handles": { format!("{q} two"): 1 } }))
            .into_response()
        }
        "word-by-word" => {
            let word = q.split_whitespace().last().unwrap_or_default().to_string();
            let kinds = ["kiln report", "glaze story", "market notes", "maker review", "studio diary", "fair guide", "price watch", "craft letter"];
            let mut rows: Vec<Value> = kinds.iter().enumerate().map(|(n, k)| json!({ "title": format!("{word} {k} {n}"), "price": 10 + n })).collect();
            rows.push(json!({ "title": format!("{q} two"), "price": 99 }));
            Json(json!({ "row": id, "results": rows })).into_response()
        }
        "lies" => Json(results(&id, "kettle")).into_response(),
        "html-token" => {
            let visitor = cookie(&headers, "v").unwrap_or_default();
            match (site.form_tokens.get(&visitor), head(&headers, "x-form-token")) {
                (Some(issued), Some(sent)) if *issued == sent => Json(results(&id, &q)).into_response(),
                _ => refuse("the form token is not this visitor's"),
            }
        }
        "storage-token" => match head(&headers, "x-token") {
            Some(t) if site.issued.contains(&t) => Json(results(&id, &q)).into_response(),
            _ => refuse("the token is not one the site issued"),
        },
        "packed-json" => match serde_json::from_str::<Value>(&get("variables")) {
            Ok(v) if v["query"].is_string() => Json(results(&id, v["query"].as_str().unwrap_or_default())).into_response(),
            _ => refuse("variables is not the JSON the page sends"),
        },
        "packed-base64" => {
            let read = base64::engine::general_purpose::STANDARD.decode(get("v")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            match read {
                Some(v) if v["query"].is_string() => Json(results(&id, v["query"].as_str().unwrap_or_default())).into_response(),
                _ => refuse("v is not the encoded JSON the page sends"),
            }
        }
        "lookup" => match site.places.get(&get("place")) {
            Some(name) => Json(results(&id, name)).into_response(),
            None => refuse("the place is not one the site suggested"),
        },
        "signed-standard" => {
            let (ts, sig) = (head(&headers, "x-ts").unwrap_or_default(), head(&headers, "x-sig").unwrap_or_default());
            if !now_ish(&ts) {
                return refuse("the clock reading is not the present");
            }
            if sig != hex::encode(Sha256::digest(format!("{ts}:{q}:fixture-key").as_bytes())) {
                return refuse("the signature is not of this request");
            }
            Json(results(&id, &q)).into_response()
        }
        "signed-own" => {
            let (ts, sig) = (head(&headers, "x-ts").unwrap_or_default(), head(&headers, "x-sig").unwrap_or_default());
            if !now_ish(&ts) {
                return refuse("the clock reading is not the present");
            }
            if sig != format!("{}{}", mix(&format!("{ts}|{q}")), mix(&format!("{q}|{ts}"))) {
                return refuse("the signature is not of this request");
            }
            Json(results(&id, &q)).into_response()
        }
        "signed-reads" => {
            let (ts, sig) = (head(&headers, "x-ts").unwrap_or_default(), head(&headers, "x-sig").unwrap_or_default());
            let visitor = cookie(&headers, "vid").unwrap_or_default();
            if !site.issued.contains(&visitor) {
                return refuse("no visitor the site gave a cookie to");
            }
            if !now_ish(&ts) {
                return refuse("the clock reading is not the present");
            }
            // The seed is never sent: the signature is good only when it was mixed with a seed the site issued.
            if !site.issued.iter().filter(|s| s.starts_with("sd_")).any(|seed| sig == mix(&format!("{ts}|{q}|{seed}|{visitor}"))) {
                return refuse("the signature is not of this request");
            }
            Json(results(&id, &q)).into_response()
        }
        "pow" => {
            let (challenge, nonce) = (get("c"), get("n"));
            // A challenge answers once: the page is handed a fresh one each load, so the nonce must be searched for
            // the challenge in front of it, never a nonce the walk already found for an older challenge.
            if !site.issued.remove(&challenge) {
                return refuse("the challenge is not one the site issued, or was already answered");
            }
            // Any count that meets the condition is one the site accepts: it checks the work, not the page's own count.
            let digest = hex::encode(Sha256::digest(format!("{challenge}:{nonce}").as_bytes()));
            if !nonce.bytes().all(|b| b.is_ascii_digit()) || !digest.starts_with("000") {
                return refuse("the nonce is not a proof of work for the challenge");
            }
            Json(results(&id, &q)).into_response()
        }
        "events" => {
            let body: String = records(&q).iter().map(|r| format!("data: {r}\n\n")).collect();
            ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
        }
        "base64-answer" => ([(header::CONTENT_TYPE, "text/plain")], base64::engine::general_purpose::STANDARD.encode(results(&id, &q).to_string())).into_response(),
        "cipher-answer" => {
            // The records, XORed with the key the page's own `unpack` knows, then base64: a reply only the site's
            // own code reads. A standard base64-of-JSON reader decodes it to bytes that are not JSON.
            let xored: Vec<u8> = results(&id, &q).to_string().bytes().map(|b| b ^ 0x5a).collect();
            ([(header::CONTENT_TYPE, "text/plain")], base64::engine::general_purpose::STANDARD.encode(xored)).into_response()
        }
        "json-lines" => {
            let body: String = records(&q).iter().map(|r| format!("{r}\n")).collect();
            ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
        }
        "session-cookie" => match cookie(&headers, "sid") {
            Some(sid) if site.sessions.contains(&sid) => Json(results(&id, &q)).into_response(),
            _ => refuse("no session the site started"),
        },
        // The date read as the page writes it, day first: a date written otherwise is another date, or none.
        "date-format" => match dated(&get("d")) {
            Some(iso) => Json(results(&id, &iso)).into_response(),
            None => refuse("d is not a day written day/month/year"),
        },
        // The code the page's table gives a place, answered as that place.
        "place-code" => match place_table().into_iter().find(|r| r["code"] == get("place")) {
            Some(r) => Json(results(&id, r["name"].as_str().unwrap_or_default())).into_response(),
            None => refuse("place is not a code of the site's"),
        },
        "msgpack-answer" => ([(header::CONTENT_TYPE, "application/x-msgpack")], packed(&results(&id, &q))).into_response(),
        "person-check" => match head(&headers, "x-pass") {
            Some(p) if site.issued.contains(&p) => Json(results(&id, &q)).into_response(),
            _ => refuse("nobody pressed the button"),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// What a row asks for before its search: a token, a pass, a session, a suggestion.
async fn asks(State(db): State<Db>, Path((id, what)): Path<(String, String)>, Query(asked): Query<HashMap<String, String>>) -> Response {
    match (id.as_str(), what.as_str()) {
        // The front page's own list: things popular on the site, the same whatever anyone asked.
        ("foreign-subject", "about") => {
            let name = asked.get("name").cloned().unwrap_or_default();
            let at = "http://localhost/api/foreign-subject";
            (
                [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
                Json(json!({ "id": 41, "full_name": format!("acme/{name}"), "items_url": format!("{at}/{name}/items{{/id}}"), "results_url": format!("{at}/{name}/results{{/id}}"), "search_url": format!("{at}/{name}/search{{?q}}"), "watchers_count": 5100, "default_branch": "main" })),
            )
                .into_response()
        }
        ("foreign-named", "about") => {
            let name = asked.get("name").cloned().unwrap_or_default();
            let at = "http://localhost/api/foreign-named";
            (
                [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
                Json(json!({ "id": 41, "name": name, "full_name": format!("acme/{name}"), "description": "Things for the kitchen, made to last a lifetime.", "topics": ["kitchen", "home"], "releases_url": format!("{at}/{name}/releases{{/id}}"), "items_url": format!("{at}/{name}/items{{/id}}"), "watchers_count": 5100, "default_branch": "main" })),
            )
                .into_response()
        }
        ("unknown-home", "popular") => Json(json!({ "popular": [{ "title": "Kettles for every kitchen", "price": 20 }, { "title": "Teapots of every size", "price": 15 }, { "title": "Saucepans and their lids", "price": 30 }, { "title": "Mugs with a thick wall", "price": 8 }] })).into_response(),
        ("storage-token", "issue") => {
            let token = new_id(&db, "t_");
            db.lock().expect("the site's state").issued.insert(token.clone());
            Json(json!({ "token": token })).into_response()
        }
        ("person-check", "pass") => {
            let pass = new_id(&db, "p_");
            db.lock().expect("the site's state").issued.insert(pass.clone());
            Json(json!({ "pass": pass })).into_response()
        }
        ("session-cookie", "start") => {
            let sid = new_id(&db, "s_");
            db.lock().expect("the site's state").sessions.insert(sid.clone());
            ([(header::SET_COOKIE, format!("sid={sid}; Path=/; HttpOnly"))], Json(json!({ "started": true }))).into_response()
        }
        ("signed-reads", "seed") => {
            let seed = new_id(&db, "sd_");
            db.lock().expect("the site's state").issued.insert(seed.clone());
            Json(json!({ "seed": seed })).into_response()
        }
        ("pow", "challenge") => {
            let challenge = new_id(&db, "ch_");
            db.lock().expect("the site's state").issued.insert(challenge.clone());
            Json(json!({ "challenge": challenge })).into_response()
        }
        ("lookup", "suggest") => {
            let name = asked.get("q").cloned().unwrap_or_default();
            let id = format!("pl_{}", &hex::encode(Sha256::digest(name.as_bytes()))[..12]);
            db.lock().expect("the site's state").places.insert(id.clone(), name.clone());
            Json(json!({ "places": [{ "id": id, "name": name }] })).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The one search that is posted: its value is in a JSON body.
async fn posted_search(Path(id): Path<String>, body: axum::body::Bytes) -> Response {
    if id == "protobuf-long" {
        return match searched_for_long(&body) {
            Some(q) => Json(results(&id, &q)).into_response(),
            None => refuse("the body is not the message the page sends"),
        };
    }
    if id == "protobuf-search" {
        return match searched_for(&body) {
            Some(q) => Json(results(&id, &q)).into_response(),
            None => refuse("the body is not the message the page sends"),
        };
    }
    match (id.as_str(), serde_json::from_slice::<Value>(&body)) {
        ("post-json", Ok(v)) if v["query"].is_string() => Json(results(&id, v["query"].as_str().unwrap_or_default())).into_response(),
        ("post-json", _) => refuse("the body is not the JSON the page sends"),
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

/// Serves the fixture site on a free loopback port from a background thread, and answers its address.
pub fn site() -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("a runtime for the fixture site");
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
            tx.send(listener.local_addr().expect("its address")).expect("the test waits for it");
            let app = Router::new()
                .route("/", get(|| async { Html("<!doctype html><html><head><title>A shop</title></head><body><h1>A shop</h1><p>Pots, pans and things to boil water in.</p><a href=\"/p/plain\">Search</a></body></html>") }))
                .route("/about", get(|| async { Html("<!doctype html><html><head><title>About this shop</title></head><body><h1>About this shop</h1><p>It sells nothing: it is a fixture.</p><a href=\"/\">Home</a></body></html>") }))
                .route("/p/{id}", get(a_page))
                .route("/s/{name}", get(a_script))
                .route("/api/{id}/search", get(search).post(posted_search))
                .route("/api/{id}/{what}", post(asks).get(asks))
                .with_state(Db::default());
            axum::serve(listener, app).await.expect("the fixture site serves");
        });
    });
    format!("http://{}", rx.recv().expect("the fixture site started"))
}

/// What a row's call did: whether it answered for the value, and what it cost.
#[derive(Debug)]
pub struct Ran {
    pub ok: bool,
    pub answer: Value,
    pub error: Option<String>,
    /// The highest rung the call reached, and whether a browser ran for it (`made.jsonl`).
    pub rung: u8,
    pub browser: bool,
    /// The rung of each step of the run that answered, in order, as `made.jsonl` writes them (the call's `steps`).
    pub steps: Vec<u8>,
}

impl Ran {
    /// The row passed: the call answered for `value`, with no browser, at or below the row's ceiling.
    pub fn passes(&self, row: &Row, value: &str) -> Result<(), String> {
        if !self.ok {
            return Err(format!("the call failed: {}", self.error.clone().unwrap_or_default()));
        }
        if !self.answer.to_string().contains(value) {
            return Err(format!("the answer says nothing of {value}"));
        }
        // Every search of the site answers with records named for the value (`records`): an answer that only says the
        // value back (a page's title, its form) holds none of them.
        if !self.answer.to_string().contains(&format!("{value} two")) {
            return Err(format!("the answer says {value} back but holds none of its records"));
        }
        if self.browser {
            return Err("a browser ran for the call".into());
        }
        if self.rung > row.ceiling {
            return Err(format!("the call reached rung {}, above its ceiling {}", self.rung, row.ceiling));
        }
        Ok(())
    }
}

/// The value a row is walked with, and the one it is then called for.
const WALKED: &str = "kettle";
const CALLED: &str = "teapot";
const THIRD: &str = "saucepan";

/// Has the node learn `row` from one walk of its page asked for `first`, then call the route it kept for `second`.
/// The home is the test's own scratch home, with the browser kept headless.
pub fn learn_then_call(base: &str, row: &Row, first: &str, second: &str) -> Result<Ran, String> {
    learn_then_call_with(base, row, first, second, None).map(|(ran, _)| ran)
}

/// The browser a row walks in: the Chrome for Testing the engine downloaded, named for this thread, and never the
/// browser its owner uses (`browsers::for_this_test`).
fn a_rows_browser() {
    crate::browsers::for_this_test(unbrowse_learn::mint::downloaded_chromium().map(|p| p.display().to_string()));
}

/// `learn_then_call`, and where `node` is given, as an ask of the node learns: with the node, and then held to its
/// second look (`learn::verify_learned`) before the call: the page walked for a second word the trial picks, the
/// pick made again from both walks (by example, where the switch is on), and the route that stands put to the site's
/// four tests. The call is made of the route that stands, which is handed back with what the call did.
pub fn learn_then_call_with(base: &str, row: &Row, first: &str, second: &str, node: Option<&crate::Node>) -> Result<(Ran, store::Route), String> {
    learn_then_call_costed(base, row, first, second, None, node, &mut Cost::default()).map(|(ran, route, _)| (ran, route))
}

/// What a row cost beside its verdict, for the A/B of the node's own asks (`learn_then_call_costed`,
/// `learn_then_confirm_costed`). What is not reached stays unset.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cost {
    /// The learn of the walked value, until its route was kept.
    pub ms_first: Option<u64>,
    /// Arm A: the second look, where there is one, and the call for the called value. Arm B: the confirming browse of
    /// the called value, its compare included.
    pub ms_second: Option<u64>,
    /// The third value's warm call.
    pub ms_third: Option<u64>,
    /// The page loads the learn made: the walks it holds at the end.
    pub walks: usize,
    /// The requests the harness's own calls sent (`http::sent_so_far`): arm A's calls for the called and third values,
    /// arm B's call beside the confirming browse and its call for the third value. Anything else sent is the node's own.
    pub harness_sent: u64,
}

/// `f`, its time in milliseconds put in `ms`.
fn timed<T>(ms: &mut Option<u64>, f: impl FnOnce() -> T) -> T {
    let began = std::time::Instant::now();
    let out = f();
    *ms = Some(began.elapsed().as_millis() as u64);
    out
}

/// `f`, a harness call: the requests it sent added to `cost.harness_sent`.
fn the_harnesss<T>(cost: &mut Cost, f: impl FnOnce() -> T) -> T {
    let before = unbrowse_learn::http::sent_so_far();
    let out = f();
    cost.harness_sent += unbrowse_learn::http::sent_so_far().saturating_sub(before);
    out
}

/// `learn_then_call_with`, what it cost put in `cost`; and where `third` is given, the route that stood called for it
/// after the called value, warm, as the harness's own call: what that call did, or why it left nothing to read.
#[allow(clippy::type_complexity)]
pub fn learn_then_call_costed(base: &str, row: &Row, first: &str, second: &str, third: Option<&str>, node: Option<&crate::Node>, cost: &mut Cost) -> Result<(Ran, store::Route, Option<Result<Ran, String>>), String> {
    let home = store::home();
    let mut settings = store::load_settings();
    settings.headless_only = true;
    store::save_settings(&settings)?;
    a_rows_browser();
    let walks = learn::Walks::default();
    let walked = |walks: &learn::Walks| walks.0.lock().map(|w| w.len()).unwrap_or_default();
    let url = format!("{base}{}?q={}", row.page, first.replace(' ', "+"));
    // With MATRIX_SEE set, what the learner saw of the walk is printed: each call, its score, the pick.
    let see = |e: learn::Eye| {
        if std::env::var_os("MATRIX_SEE").is_some() && !matches!(e, learn::Eye::Frame(_)) {
            eprintln!("   [walk] {}", serde_json::to_string(&e).unwrap_or_default());
        }
    };
    let learned = timed(&mut cost.ms_first, || learn::learn_goal_walked(&walks, &url, "search items", "You", &see, node));
    cost.walks = walked(&walks);
    let (route, _, walk) = learned.map_err(|e| format!("not learned: {e}"))?;
    let began = std::time::Instant::now();
    let route = match node {
        None => route,
        Some(node) => {
            learn::verification_begins(&url);
            learn::verify_learned(&walks, &url, "search items", "You", &walk, &route, Some(node));
            cost.walks = walked(&walks);
            store::load_route(&route.id).or_else(|| store::took_the_place_of(&route.id)).ok_or("the second look let the route go, and none took its place")?
        }
    };
    let input = route.inputs.iter().find(|i| i.default.as_deref() == Some(first)).map(|i| i.name.clone());
    let input = input.ok_or_else(|| format!("the route takes no input for the value: {:?}", route.inputs.iter().map(|i| (&i.name, &i.default)).collect::<Vec<_>>()))?;
    let before = run::made_log_in(&home).len();
    let called = the_harnesss(cost, || run::call(&route.id, &HashMap::from([(input.clone(), second.to_string())]), "You"));
    cost.ms_second = Some(began.elapsed().as_millis() as u64);
    let called = called?;
    let lines = run::made_log_in(&home);
    let line = lines.get(before..).and_then(|new| new.last()).ok_or("the call left no line in made.jsonl")?;
    let route = store::load_route(&route.id).unwrap_or(route);
    let ran = Ran { ok: called.ok, answer: called.data.unwrap_or(Value::Null), error: called.error, rung: line.rung.number(), browser: line.browser, steps: line.steps.iter().map(|r| r.number()).collect() };
    let third = third.map(|value| {
        let before = run::made_log_in(&home).len();
        let mut ms = None;
        let called = the_harnesss(cost, || timed(&mut ms, || run::call(&route.id, &HashMap::from([(input.clone(), value.to_string())]), "You")));
        cost.ms_third = ms;
        let called = called?;
        let lines = run::made_log_in(&home);
        let line = lines.get(before..).and_then(|new| new.last()).ok_or("the third value's call left no line in made.jsonl")?;
        Ok(Ran { ok: called.ok, answer: called.data.unwrap_or(Value::Null), error: called.error, rung: line.rung.number(), browser: line.browser, steps: line.steps.iter().map(|r| r.number()).collect() })
    });
    let route = store::load_route(&route.id).unwrap_or(route);
    Ok((ran, route, third))
}

/// What arm B of the A/B of the node's own asks made of a row (`learn_then_confirm_costed`).
#[derive(Debug)]
pub struct ArmB {
    /// What the confirming browse of the row's called value said of the route of one sighting.
    pub confirm: learn::confirm::Confirmed,
    /// What the confirming browse of the row's unknown value said, where the row has one (`Row::unknown`).
    pub unknown: Option<learn::confirm::Confirmed>,
    /// The first warm call, for the row's third value, of the route that stood after the confirming browse.
    pub third: Ran,
    /// The route that stood.
    pub route: store::Route,
    /// The walks the node made: the learn's and the confirming browse's, and nothing else.
    pub walks: usize,
    /// The calls `made.jsonl` holds after the learn that are not the harness's own two (the route called beside the
    /// confirming browse, and the third value's call), each by its route id: the node calling a site on its own.
    pub own: Vec<String>,
}

/// Arm B of the A/B of the node's own asks, for `row`: the route is learned from one walk of the row's page asked its
/// walked value, with no second look; the row's called value is then served by the browser with the route called
/// beside it (`learn::confirm::confirm_by_use`), whose walk is the learner's second; and the route that stands is
/// called for the row's third value, its first warm call. The node asks the site nothing between: the two walks and
/// the harness's two calls are all that is made.
/// What it cost is put in `cost`.
pub fn learn_then_confirm_costed(base: &str, row: &Row, cost: &mut Cost) -> Result<ArmB, String> {
    let home = store::home();
    let mut settings = store::load_settings();
    settings.headless_only = true;
    store::save_settings(&settings)?;
    a_rows_browser();
    let walks = learn::Walks::default();
    let goal = "search items";
    let page = |value: &str| format!("{base}{}?q={}", row.page, value.replace(' ', "+"));
    let walked = |walks: &learn::Walks| walks.0.lock().map(|w| w.len()).unwrap_or_default();
    let learned = timed(&mut cost.ms_first, || learn::learn_goal_walked(&walks, &page(row.walked()), goal, "You", &|_| {}, None));
    cost.walks = walked(&walks);
    let (route, _, _) = learned.map_err(|e| format!("not learned: {e}"))?;
    let before = run::made_log_in(&home).len();
    let input = route.inputs.iter().find(|i| i.default.as_deref() == Some(row.walked())).map(|i| i.name.clone());
    let input = input.ok_or_else(|| format!("the route takes no input for the value: {:?}", route.inputs.iter().map(|i| (&i.name, &i.default)).collect::<Vec<_>>()))?;
    let given = HashMap::from([(input.clone(), row.called().to_string())]);
    let confirmation = timed(&mut cost.ms_second, || learn::confirm::confirm_by_use(&walks, &page(row.called()), goal, "You", &route, &given, None));
    cost.walks = walked(&walks);
    // The site turned the called value away to another page: it has nothing for it, the route stands as it was, and
    // the verdict is that the browse could not tell (`api::goal` answers the agent `how: elsewhere`).
    let confirmation = match confirmation {
        Err(learn::Unlearned::Elsewhere(why) | learn::Unlearned::Nothing(why)) => {
            learn::confirm::Confirmation { verdict: learn::confirm::Confirmed::CannotTell { why }, standing: route.clone(), sent_beside: 0, answer: None }
        }
        other => other.map_err(|e| format!("the confirming browse learned nothing: {e}"))?,
    };
    cost.harness_sent += confirmation.sent_beside;
    let mut standing = confirmation.standing;
    let after_called = standing.id.clone();
    // A value the site holds nothing for, asked of the route that stood: its own confirming browse (`Row::unknown`).
    let unknown = match row.unknown.as_deref() {
        None => None,
        Some(u) => {
            let name = standing.inputs.iter().find(|i| i.default.as_deref() == Some(row.called())).or_else(|| standing.inputs.iter().find(|i| i.name == input)).map(|i| i.name.clone()).unwrap_or_else(|| input.clone());
            let asked = HashMap::from([(name, u.to_string())]);
            let seen = match learn::confirm::confirm_by_use(&walks, &page(u), goal, "You", &standing, &asked, None) {
                Err(learn::Unlearned::Elsewhere(why) | learn::Unlearned::Nothing(why)) => learn::confirm::Confirmation { verdict: learn::confirm::Confirmed::CannotTell { why }, standing: standing.clone(), sent_beside: 0, answer: None },
                other => other.map_err(|e| format!("the confirming browse of {u}, a value the site holds nothing for, did not say the site has nothing for it: {e}"))?,
            };
            cost.harness_sent += seen.sent_beside;
            standing = seen.standing;
            Some(seen.verdict)
        }
    };
    // The route that stood was learned on the called value: its input for it, else the first route's by name.
    let third_input = standing.inputs.iter().find(|i| i.default.as_deref() == Some(row.called())).or_else(|| standing.inputs.iter().find(|i| i.name == input)).map(|i| i.name.clone());
    let third_input = third_input.ok_or_else(|| format!("the route that stood takes no input for the value: {:?}", standing.inputs.iter().map(|i| (&i.name, &i.default)).collect::<Vec<_>>()))?;
    let mut ms = None;
    let called = the_harnesss(cost, || timed(&mut ms, || run::call(&standing.id, &HashMap::from([(third_input, row.third().to_string())]), "You")));
    cost.ms_third = ms;
    let called = called?;
    let lines = run::made_log_in(&home);
    let after = lines.get(before..).unwrap_or_default();
    let line = after.last().filter(|l| l.route == standing.id).ok_or("the third value's call left no line in made.jsonl")?;
    // The harness made two calls (three with an unknown value's browse): any line past those, or of a route neither
    // learned nor standing, the node made on its own.
    let made = 2 + usize::from(unknown.is_some());
    let ours = [route.id.as_str(), after_called.as_str(), standing.id.as_str()];
    let own: Vec<String> = after.iter().enumerate().filter(|(n, l)| *n + made < after.len() || !ours.contains(&l.route.as_str())).map(|(_, l)| l.route.clone()).collect();
    let walked = walks.0.lock().map(|w| w.len()).unwrap_or_default();
    let third = Ran { ok: called.ok, answer: called.data.unwrap_or(Value::Null), error: called.error, rung: line.rung.number(), browser: line.browser, steps: line.steps.iter().map(|r| r.number()).collect() };
    let route = store::load_route(&standing.id).unwrap_or(standing);
    Ok(ArmB { confirm: confirmation.verdict, unknown, third, route, walks: walked, own })
}

/// Runs one row in a scratch home of its own and says whether it passed, and why not.
pub fn run_row(base: &str, row: &Row) -> Result<(), String> {
    store::scratch_home(&format!("matrix-{}", row.id));
    if row.person {
        // A row only a person passes: the node must not come back with an answer it made up, nor keep a route.
        let walks = learn::Walks::default();
        let mut settings = store::load_settings();
        settings.headless_only = true;
        store::save_settings(&settings)?;
        a_rows_browser();
        return match learn::learn_goal(&walks, &format!("{base}{}?q={WALKED}", row.page), "search items") {
            Err(learn::Unlearned::Loading | learn::Unlearned::Hands(_) | learn::Unlearned::Door(..) | learn::Unlearned::SignIn(..) | learn::Unlearned::Check(..)) => Ok(()),
            Err(other) => Err(format!("it was refused for another reason: {other}")),
            Ok((route, _)) => Err(format!("the node kept a route ({} {}) for a page only a person passes", route.method, route.path)),
        };
    }
    if row.first {
        let walks = learn::Walks::default();
        let mut settings = store::load_settings();
        settings.headless_only = true;
        store::save_settings(&settings)?;
        a_rows_browser();
        let page = format!("{base}{}?q={}", row.page, row.walked());
        let (route, _, _) = learn::learn_goal_walked(&walks, &page, row.goal.as_deref().unwrap_or("search items"), "You", &|_| {}, None).map_err(|e| format!("not learned: {e}"))?;
        let own = url::Url::parse(&page).ok().and_then(|u| u.host_str().map(unbrowse_learn::identity::site_of)).unwrap_or_default();
        return if unbrowse_learn::identity::site_of(&route.site) == own { Ok(()) } else { Err(format!("the first ask kept {} {}{}, a call to another site, over the page's own", route.method, route.site, route.path)) };
    }
    if nothing_for(row.walked()) {
        // A value the site holds nothing for, asked first on a fresh node: the learn keeps no route, and says the site
        // has nothing for it.
        let walks = learn::Walks::default();
        let mut settings = store::load_settings();
        settings.headless_only = true;
        store::save_settings(&settings)?;
        a_rows_browser();
        let learned = learn::learn_goal_walked(&walks, &format!("{base}{}?q={}", row.page, row.walked()), "search items", "You", &|_| {}, None);
        let kept = store::load_routes();
        return match learned {
            Err(learn::Unlearned::Nothing(_)) if kept.is_empty() => Ok(()),
            Err(learn::Unlearned::Nothing(_)) => Err(format!("it said the site has nothing for the value, and kept {} route(s) all the same", kept.len())),
            Err(other) => Err(format!("it kept no route, for another reason: {other}")),
            Ok((route, _, _)) => Err(format!("the node kept a route ({} {}) from a walk that saw no record", route.method, route.path)),
        };
    }
    learn_then_call(base, row, row.walked(), row.called())?.passes(row, row.called())
}

/// Every row of `family`, run: the rows that did not pass, each with why.
pub fn failures(family: Option<&str>) -> Vec<(String, String)> {
    let base = site();
    matrix().iter().filter(|r| family.is_none_or(|f| r.family == f)).filter_map(|r| run_row(&base, r).err().map(|why| (r.id.clone(), why))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none_fail(family: Option<&str>) {
        let failed = failures(family);
        assert!(failed.is_empty(), "{} row(s) did not pass:\n{}", failed.len(), failed.iter().map(|(id, why)| format!("  {id}: {why}")).collect::<Vec<_>>().join("\n"));
    }

    /// The matrix has a row for every family, no two rows share an id, and the site serves each row's page.
    #[test]
    fn the_matrix_lists_every_family_and_each_rows_page_exists() {
        let rows = matrix();
        for family in FAMILIES {
            assert!(rows.iter().any(|r| r.family == family), "no row of {family}");
        }
        let ids: HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), rows.len(), "two rows share an id");
        let base = site();
        let http = reqwest::blocking::Client::new();
        for r in &rows {
            assert!(FAMILIES.contains(&r.family.as_str()), "row {} is of no family: {}", r.id, r.family);
            assert!(r.ceiling <= 5 && r.person == (r.family == "person"), "row {}", r.id);
            let page = http.get(format!("{base}{}?q=kettle", r.page)).send().unwrap_or_else(|e| panic!("row {}: {e}", r.id));
            assert_eq!(page.status(), 200, "row {}'s page {}", r.id, r.page);
            assert!(page.text().unwrap_or_default().contains("<script"), "row {}'s page has no script", r.id);
        }
    }

    /// The site checks what it is sent: a search that leaves out what its row is about is refused, so a row cannot
    /// pass by sending less than the page does.
    #[test]
    fn the_site_refuses_a_search_that_got_its_row_wrong() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        for id in ["html-token", "storage-token", "packed-json", "packed-base64", "lookup", "signed-standard", "signed-own", "session-cookie", "person-check"] {
            let bare = http.get(format!("{base}/api/{id}/search?q=kettle&place=nowhere&v=x&variables=x")).send().unwrap();
            assert_eq!(bare.status(), 403, "row {id} answered a search that sent nothing it checks");
        }
        let posted = http.post(format!("{base}/api/post-json/search")).header("content-type", "application/json").body(r#"{"query":"kettle"}"#).send().unwrap();
        assert_eq!(posted.status(), 200, "the posted search answers");
        assert!(posted.text().unwrap().contains("kettle one"));
        // And answers one that got it right: the standard signature, made here as the page makes it.
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
        let sig = hex::encode(Sha256::digest(format!("{ts}:kettle:fixture-key").as_bytes()));
        let signed = http.get(format!("{base}/api/signed-standard/search?q=kettle")).header("x-ts", &ts).header("x-sig", sig).send().unwrap();
        assert_eq!(signed.status(), 200);
        assert!(signed.text().unwrap().contains("kettle one"));
    }

    /// The date row's site answers only a day written day first, and answers it as the date it names: the date as
    /// the caller wrote it, or with the day and the month the other way round, is refused or is another date.
    #[test]
    fn the_site_answers_a_date_only_as_the_page_writes_it() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        let ask = |d: &str| http.get(format!("{base}/api/date-format/search?d={d}")).send().unwrap();
        assert_eq!(ask("2026-03-04").status(), 403);
        assert_eq!(ask("03%2F25%2F2026").status(), 403, "no twenty-fifth month");
        assert!(ask("04%2F03%2F2026").text().unwrap().contains("2026-03-04 two"));
        assert!(ask("03%2F04%2F2026").text().unwrap().contains("2026-04-03 two"), "the other way round is another date");
    }

    /// The place row's site answers a code of its own table, as that place, and refuses a place's name.
    #[test]
    fn the_site_answers_a_place_only_by_its_code() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        assert_eq!(http.get(format!("{base}/api/place-code/search?place=Oslo")).send().unwrap().status(), 403);
        assert!(http.get(format!("{base}/api/place-code/search?place=OSL")).send().unwrap().text().unwrap().contains("Oslo two"));
    }

    /// Each row's third value is of the kind its other two are, and the site answers it as it answers them: every
    /// row's page serves it, a word is searched as any word is, a date written day first, a place by its table's code.
    #[test]
    fn the_site_answers_each_rows_third_value() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        for r in matrix().iter().filter(|r| !r.person) {
            assert_ne!(r.third(), r.walked(), "row {}", r.id);
            assert_ne!(r.third(), r.called(), "row {}", r.id);
            assert_eq!(http.get(format!("{base}{}?q={}", r.page, r.third())).send().unwrap().status(), 200, "row {}'s page for its third value", r.id);
        }
        let said = |path: &str| http.get(format!("{base}{path}")).send().unwrap().text().unwrap();
        assert!(said(&format!("/api/plain/search?q={}", row("plain").third())).contains(&format!("{} two", row("plain").third())));
        assert_eq!(row("date-format").third(), "2026-06-21");
        assert!(said("/api/date-format/search?d=21%2F06%2F2026").contains("2026-06-21 two"));
        let place = row("place-code");
        let code = place_table().into_iter().find(|p| p["name"] == place.third()).map(|p| p["code"].as_str().unwrap_or_default().to_string()).expect("the third place is in the page's table");
        assert!(said(&format!("/api/place-code/search?place={code}")).contains(&format!("{} two", place.third())));
    }

    /// The binary rows' site reads a posted message only as the page writes it, and answers MessagePack.
    #[test]
    fn the_binary_rows_site_reads_and_writes_its_bytes() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        let post = |b: Vec<u8>| http.post(format!("{base}/api/protobuf-search/search")).header("content-type", "application/x-protobuf").body(b).send().unwrap();
        let mut message = vec![0x0a, 6];
        message.extend(b"kettle");
        message.extend([0x10, 0x14]);
        assert!(post(message.clone()).text().unwrap().contains("kettle two"));
        let last = message.len() - 1;
        message[last] = 0x15;
        assert_eq!(post(message).status(), 403, "another count is another message");
        let answer = http.get(format!("{base}/api/msgpack-answer/search?q=kettle")).send().unwrap();
        assert_eq!(answer.headers()["content-type"], "application/x-msgpack");
        let bytes = answer.bytes().unwrap();
        assert_eq!(bytes[0], 0x83, "a map of three");
        assert!(bytes.windows(10).any(|w| w == b"kettle two"));
    }

    /// The rows of a value only the site's own code makes check what they are about: a search without it is refused,
    /// and one made as the page makes it answers.
    #[test]
    fn the_site_refuses_a_search_its_own_code_did_not_make() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
        // signed-reads: a visitor's cookie and a seed the site issued, mixed in as the page's function mixes them.
        let page = http.get(format!("{base}/p/signed-reads?q=kettle")).send().unwrap();
        let vid = page.headers().get("set-cookie").and_then(|v| v.to_str().ok()).and_then(|c| c.split(';').next()).and_then(|c| c.strip_prefix("vid=")).expect("the page gives a visitor cookie").to_string();
        let seed: Value = http.post(format!("{base}/api/signed-reads/seed")).send().unwrap().json().unwrap();
        let seed = seed["seed"].as_str().unwrap().to_string();
        let ask = |sig: &str| http.get(format!("{base}/api/signed-reads/search?q=kettle")).header("cookie", format!("vid={vid}")).header("x-ts", &ts).header("x-sig", sig).send().unwrap().status();
        assert_eq!(ask(&mix(&format!("{ts}|kettle|{seed}|{vid}"))), 200, "signed as the page signs");
        assert_eq!(ask(&mix(&format!("{ts}|kettle||{vid}"))), 403, "signed without the stored seed");
        assert_eq!(ask(&mix(&format!("{ts}|kettle|{seed}|"))), 403, "signed without the cookie");
    }

    /// The proof-of-work row: the site hands a challenge, and answers only a nonce whose hash of the challenge and it
    /// opens with the zeros it asks. Any such nonce is accepted (the condition is the check), and one that does not
    /// meet it, or a challenge the site never issued, is refused.
    #[test]
    fn the_site_refuses_a_proof_of_work_that_is_not_one() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        // A fresh challenge from the site's own endpoint, each one answering once.
        let fresh = || {
            let j: Value = http.get(format!("{base}/api/pow/challenge")).send().unwrap().json().unwrap();
            j["challenge"].as_str().expect("the site issues a challenge").to_string()
        };
        let work = |c: &str| (0u64..).find(|n| hex::encode(Sha256::digest(format!("{c}:{n}").as_bytes())).starts_with("000")).unwrap();
        let ask = |c: &str, n: String| http.get(format!("{base}/api/pow/search?q=kettle&c={c}&n={n}")).send().unwrap().status();
        let (c1, c2) = (fresh(), fresh());
        assert_eq!(ask(&c1, work(&c1).to_string()), 200, "a nonce that is a proof of work answers");
        assert_eq!(ask(&c1, work(&c1).to_string()), 403, "a challenge already answered is refused: it answers once");
        assert_eq!(ask(&c2, (work(&c2) + 1).to_string()), 403, "a count that does not meet the condition is refused");
        assert_eq!(ask("ch_nothing", "0".into()), 403, "a challenge the site never issued is refused");
    }

    /// The ciphered-answer row: the reply is base64 of XORed JSON, which no standard reader reads as JSON, and the
    /// records come back only when the site's own XOR is undone. The server check is the fixture's own encoding.
    #[test]
    fn the_cipher_answer_reply_is_not_json_until_the_sites_own_code_unpacks_it() {
        let base = site();
        let http = reqwest::blocking::Client::new();
        let raw = http.get(format!("{base}/api/cipher-answer/search?q=kettle")).send().unwrap().text().unwrap();
        // A standard base64-of-JSON reader decodes it to bytes that are not JSON.
        let bytes = base64::engine::general_purpose::STANDARD.decode(raw.trim()).expect("it is base64");
        assert!(serde_json::from_slice::<Value>(&bytes).is_err(), "the decoded bytes are not JSON by themselves");
        // Undo the XOR the page's own unpack does: now it is the records, saying the word back.
        let unpacked: String = bytes.iter().map(|b| (b ^ 0x5a) as char).collect();
        let v: Value = serde_json::from_str(&unpacked).expect("the site's own code reads it as JSON");
        assert_eq!(v["results"][0]["title"], "kettle one");
    }

    /// The site serves each script its pages load, as JavaScript, and answers nothing for a page, a script, a search or an
    /// ask it has no row for, nor a posted search of a row that is not posted.
    #[test]
    fn the_site_serves_its_scripts_and_answers_nothing_it_has_no_row_for() {
        let (base, http) = (site(), reqwest::blocking::Client::new());
        for (name, defines) in [("signed-own.js", "window.searchSigned"), ("signed-reads.js", "window.searchReading"), ("cipher.js", "window.searchCipher"), ("worker.js", "onmessage")] {
            let script = http.get(format!("{base}/s/{name}")).send().unwrap();
            assert_eq!(script.status(), 200, "{name}");
            assert_eq!(script.headers()["content-type"], "application/javascript", "{name}");
            assert!(script.text().unwrap().contains(defines), "{name} is the script that defines {defines}");
        }
        for path in ["/s/nothing.js", "/p/nothing", "/api/nothing/search", "/api/nothing/anything"] {
            assert_eq!(http.get(format!("{base}{path}")).send().unwrap().status(), 404, "{path}");
        }
        assert_eq!(http.post(format!("{base}/api/nothing/anything")).send().unwrap().status(), 404);
        assert_eq!(http.post(format!("{base}/api/plain/search")).body("{}").send().unwrap().status(), 405, "a row that is not posted answers no post");
    }

    /// The searches the site answers whoever asks, each as its row is about: the value said back in the records, the
    /// envelope a value it holds nothing for gets, one record and no list, a search read word by word, and the control
    /// that answers for the walk's value whatever it is asked.
    #[test]
    fn the_sites_open_searches_answer_for_the_value_asked() {
        let (base, http) = (site(), reqwest::blocking::Client::new());
        let get = |path: &str| -> Value { http.get(format!("{base}{path}")).send().unwrap().json().unwrap() };
        for id in ["plain", "frame", "worker", "unknown-elsewhere"] {
            let said = get(&format!("/api/{id}/search?q=teapot"));
            assert_eq!((said["row"].as_str(), said["query"].as_str(), said["results"][1]["title"].as_str()), (Some(id), Some("teapot"), Some("teapot two")), "{id}");
        }
        assert_eq!(get("/api/lies/search?q=teapot")["results"][0]["title"], "kettle one", "the control answers for the walk's value, whatever it is asked");
        let envelope: Value = http.get(format!("{base}/api/first-unknown-api/search?q=qzxkettle&page_url=http%3A%2F%2Fshop.example%2Fp")).header("user-agent", "probe/1").send().unwrap().json().unwrap();
        assert_eq!(envelope["session_context"]["client_characterization"]["client_useragent"], "probe/1:sua", "the caller's own user agent said back with a mark");
        assert_eq!(envelope["request"]["client_request_parameters"]["client_url"], "http://shop.example/p");
        assert_eq!(envelope["request"]["client_request_parameters"]["user_query"], "qzxkettle");
        assert_eq!(envelope["response"]["body"]["hits"]["hits"], json!([]), "a value it holds nothing for has no records");
        let found = get("/api/first-unknown-api/search?q=teapot");
        assert_eq!((found["results"][1]["title"].as_str(), found.get("response")), (Some("teapot two"), None), "a value it holds something for gets records, not the envelope");
        let one = get("/api/one-record/search?q=teapot");
        let digest = hex::encode(Sha256::digest(b"teapot"));
        assert_eq!((one["code"].as_str(), one.get("results")), (Some("teapot"), None), "one record, no list");
        assert_eq!(one["owner"]["avatar"], digest[..32]);
        assert_eq!((one["owner"]["id"].as_str(), one["shelf"]["id"].as_str()), (Some(format!("4{}", &digest[..17]).as_str()), Some(format!("5{}", &digest[17..35]).as_str())));
        assert_eq!(one["handles"]["teapot two"], 1);
        let words = get("/api/word-by-word/search?q=red%20teapot");
        let rows = words["results"].as_array().unwrap();
        assert_eq!(rows.len(), 9);
        assert_eq!(rows[0]["title"], "teapot kiln report 0", "the records say the value's last word");
        assert!(rows[..8].iter().all(|r| !r["title"].as_str().unwrap().contains("red teapot")), "and not the value whole");
        assert_eq!((rows[8]["title"].as_str(), rows[8]["price"].as_u64()), (Some("red teapot two"), Some(99)), "but one record does");
    }

    /// A search made as its row's page makes it answers, and one that is not, or is stale, is refused with the reason: a
    /// form token of this visitor's, a token the site issued, the value inside JSON or inside base64 of it, a place the
    /// site suggested, a signature of the request, a session the site started, a pass a button gave.
    #[test]
    fn the_site_answers_a_search_made_as_its_page_makes_it_and_refuses_the_rest() {
        let (base, http) = (site(), reqwest::blocking::Client::new());
        let said = |r: reqwest::blocking::Response| (r.status().as_u16(), r.text().unwrap());
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
        let cookie_of = |r: &reqwest::blocking::Response, name: &str| r.headers().get("set-cookie").and_then(|v| v.to_str().ok()).and_then(|c| c.split(';').next()).and_then(|c| c.strip_prefix(&format!("{name}="))).map(String::from).expect("the site sets a cookie");
        let page = http.get(format!("{base}/p/html-token?q=teapot")).send().unwrap();
        let visitor = cookie_of(&page, "v");
        let html = page.text().unwrap();
        let token = html.split("name=\"form-token\" content=\"").nth(1).and_then(|r| r.split('"').next()).expect("the page carries its token").to_string();
        let form = |v: &str, t: &str| said(http.get(format!("{base}/api/html-token/search?q=teapot")).header("cookie", format!("v={v}")).header("x-form-token", t).send().unwrap());
        assert!(form(&visitor, &token).1.contains("teapot two"));
        assert_eq!(form(&visitor, "f_another").0, 403, "not the token the page was given");
        assert_eq!(form("another-visitor", &token).0, 403, "not this visitor's");
        let issued: Value = http.post(format!("{base}/api/storage-token/issue")).send().unwrap().json().unwrap();
        let stored = |t: &str| said(http.get(format!("{base}/api/storage-token/search?q=teapot")).header("x-token", t).send().unwrap());
        assert!(stored(issued["token"].as_str().unwrap()).1.contains("teapot two"));
        assert_eq!(stored("t_made-up").0, 403);
        let packed_in = |id: &str, key: &str, value: &str| said(http.get(format!("{base}/api/{id}/search")).query(&[(key, value)]).send().unwrap());
        let json_of = |q: &Value| q.to_string();
        assert!(packed_in("packed-json", "variables", &json_of(&json!({ "query": "teapot", "first": 3 }))).1.contains("teapot two"));
        assert_eq!(packed_in("packed-json", "variables", &json_of(&json!({ "query": 3 }))).0, 403, "a query that is no text is no search");
        assert_eq!(packed_in("packed-json", "variables", "not json").0, 403);
        let encoded = |q: &Value| base64::engine::general_purpose::STANDARD.encode(q.to_string());
        assert!(packed_in("packed-base64", "v", &encoded(&json!({ "query": "teapot", "first": 3 }))).1.contains("teapot two"));
        assert_eq!(packed_in("packed-base64", "v", &encoded(&json!({ "query": 3 }))).0, 403);
        assert_eq!(packed_in("packed-base64", "v", "!!!").0, 403);
        let suggested: Value = http.get(format!("{base}/api/lookup/suggest?q=Oslo")).send().unwrap().json().unwrap();
        let place = suggested["places"][0]["id"].as_str().unwrap();
        assert!(packed_in("lookup", "place", place).1.contains("Oslo two"), "the id the site suggested names the place it suggested");
        assert_eq!(packed_in("lookup", "place", "pl_nothing").0, 403);
        let signed = |id: &str, ts: &str, sig: &str| said(http.get(format!("{base}/api/{id}/search?q=teapot")).header("x-ts", ts).header("x-sig", sig).send().unwrap());
        let own = |ts: &str| format!("{}{}", mix(&format!("{ts}|teapot")), mix(&format!("teapot|{ts}")));
        assert!(signed("signed-own", &ts, &own(&ts)).1.contains("teapot two"), "signed with the site's own mixing function");
        assert!(signed("signed-own", "1", &own("1")).1.contains("clock reading"), "a signature of a clock that is not the present");
        assert!(signed("signed-own", &ts, "0000").1.contains("signature is not of this request"));
        let stale_standard = hex::encode(Sha256::digest(b"1:teapot:fixture-key"));
        assert!(signed("signed-standard", "1", &stale_standard).1.contains("clock reading"));
        let visited = http.get(format!("{base}/p/signed-reads?q=teapot")).send().unwrap();
        let vid = cookie_of(&visited, "vid");
        let reads = |cookie: &str, ts: &str| said(http.get(format!("{base}/api/signed-reads/search?q=teapot")).header("cookie", cookie).header("x-ts", ts).header("x-sig", "x").send().unwrap()).1;
        assert!(reads("vid=nobody", &ts).contains("no visitor the site gave a cookie to"));
        assert!(reads(&format!("vid={vid}"), "1").contains("clock reading"));
        assert!(reads(&format!("vid={vid}"), &ts).contains("signature is not of this request"));
        let started = http.post(format!("{base}/api/session-cookie/start")).send().unwrap();
        let sid = cookie_of(&started, "sid");
        let in_session = |sid: &str| said(http.get(format!("{base}/api/session-cookie/search?q=teapot")).header("cookie", format!("sid={sid}")).send().unwrap());
        assert!(in_session(&sid).1.contains("teapot two"));
        assert_eq!(in_session("s_made-up").0, 403, "a session the site never started");
        let pass: Value = http.post(format!("{base}/api/person-check/pass")).send().unwrap().json().unwrap();
        let passed = |p: Option<&str>| said(p.into_iter().fold(http.get(format!("{base}/api/person-check/search?q=teapot")), |r, p| r.header("x-pass", p)).send().unwrap());
        assert!(passed(pass["pass"].as_str()).1.contains("teapot two"));
        assert_eq!(passed(None).0, 403, "nobody pressed the button");
        assert_eq!(passed(Some("p_made-up")).0, 403);
    }

    /// The answers a row reads in its own form: server events, base64 of the records, one JSON record to a line; and what
    /// the pages of the rows about another host's record, and of the front page, ask the site for.
    #[test]
    fn the_site_answers_in_the_form_a_row_is_about_and_what_its_pages_ask_for() {
        let (base, http) = (site(), reqwest::blocking::Client::new());
        let title_of = |line: &str| serde_json::from_str::<Value>(line).unwrap()["title"].as_str().unwrap().to_string();
        let events = http.get(format!("{base}/api/events/search?q=teapot")).send().unwrap();
        assert_eq!(events.headers()["content-type"], "text/event-stream");
        let body = events.text().unwrap();
        let sent: Vec<String> = body.split("\n\n").filter(|e| !e.is_empty()).map(|e| title_of(e.strip_prefix("data: ").expect("an event is a data line"))).collect();
        assert_eq!(sent, ["teapot one", "teapot two", "teapot three"]);
        let based = http.get(format!("{base}/api/base64-answer/search?q=teapot")).send().unwrap();
        assert_eq!(based.headers()["content-type"], "text/plain");
        let decoded = base64::engine::general_purpose::STANDARD.decode(based.text().unwrap()).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&decoded).unwrap()["results"][1]["title"], "teapot two");
        let lines = http.get(format!("{base}/api/json-lines/search?q=teapot")).send().unwrap();
        assert_eq!(lines.headers()["content-type"], "application/x-ndjson");
        let lines: Vec<String> = lines.text().unwrap().lines().map(title_of).collect();
        assert_eq!(lines, ["teapot one", "teapot two", "teapot three"]);
        let popular: Value = http.get(format!("{base}/api/unknown-home/popular")).send().unwrap().json().unwrap();
        assert_eq!((popular["popular"].as_array().map(Vec::len), popular["popular"][0]["title"].as_str()), (Some(4), Some("Kettles for every kitchen")));
        let subject = http.get(format!("{base}/api/foreign-subject/about?name=teapot")).send().unwrap();
        assert_eq!(subject.headers()["access-control-allow-origin"], "*", "another page's script may read it");
        let subject: Value = subject.json().unwrap();
        assert_eq!((subject["full_name"].as_str(), subject["search_url"].as_str(), subject["watchers_count"].as_u64()), (Some("acme/teapot"), Some("http://localhost/api/foreign-subject/teapot/search{?q}"), Some(5100)));
        let named: Value = http.get(format!("{base}/api/foreign-named/about?name=teapot")).send().unwrap().json().unwrap();
        assert_eq!((named["name"].as_str(), named["topics"].clone(), named["releases_url"].as_str()), (Some("teapot"), json!(["kitchen", "home"]), Some("http://localhost/api/foreign-named/teapot/releases{/id}")));
    }

    /// A posted search is read as its page writes it: a long protobuf message by its wire format, and a JSON body only
    /// when it holds a text to search for.
    #[test]
    fn the_site_reads_a_posted_search_only_as_its_page_writes_it() {
        let (base, http) = (site(), reqwest::blocking::Client::new());
        let long = |word: &str, note: usize| {
            let mut m = vec![0x0a, word.len() as u8];
            m.extend(word.as_bytes());
            m.extend([0x10, 0xac, 0x02, 0x1a, 0x96, 0x01]);
            m.extend(std::iter::repeat_n(b'n', note));
            m
        };
        let post = |id: &str, ct: &str, body: Vec<u8>| http.post(format!("{base}/api/{id}/search")).header("content-type", ct).body(body).send().unwrap();
        let ok = post("protobuf-long", "application/x-protobuf", long("teapot", 150));
        assert_eq!(ok.status(), 200);
        assert!(ok.text().unwrap().contains("teapot two"));
        assert_eq!(post("protobuf-long", "application/x-protobuf", long("teapot", 149)).status(), 403, "another note is another message");
        assert_eq!(post("post-json", "application/json", br#"{"query":5}"#.to_vec()).status(), 403, "a query that is no text");
        assert_eq!(post("post-json", "application/json", b"query=teapot".to_vec()).status(), 403, "a body that is no JSON");
        assert_eq!(post("protobuf-search", "application/x-protobuf", b"teapot".to_vec()).status(), 403);
    }

    /// The messages the binary rows post read as the wire format writes them, field by field: a message with the wrong
    /// count, a stranger's field, a word cut short or not text, or no word, is no message the page sends.
    #[test]
    fn a_posted_message_is_read_only_as_its_page_writes_it() {
        let word = |w: &[u8], tail: &[u8]| {
            let mut m = vec![0x0a, w.len() as u8];
            m.extend(w);
            m.extend(tail);
            m
        };
        assert_eq!(searched_for(&word(b"teapot", &[0x10, 0x14])).as_deref(), Some("teapot"));
        assert_eq!(searched_for(&[0x10, 0x14, 0x0a, 0x01, b'a']).as_deref(), Some("a"), "the fields in either order");
        assert_eq!(searched_for(&word(b"teapot", &[])), None, "no count");
        assert_eq!(searched_for(&word(b"teapot", &[0x10, 0x15])), None, "another count");
        assert_eq!(searched_for(&[0x10, 0x14]), None, "no word");
        assert_eq!(searched_for(&word(b"teapot", &[0x10, 0x14, 0x18, 0x01])), None, "a field the page does not write");
        assert_eq!(searched_for(&[0x0a, 0x09, b'a', b'b']), None, "a word cut short");
        assert_eq!(searched_for(&[0x0a]), None, "a length that is not there");
        assert_eq!(searched_for(&word(&[0xff, 0xfe], &[0x10, 0x14])), None, "a word that is not text");
        assert_eq!(searched_for(&[0x80; 11]), None, "a number that never ends");
        let tail: Vec<u8> = [0x10, 0xac, 0x02, 0x1a, 0x96, 0x01].into_iter().chain(std::iter::repeat_n(b'n', 150)).collect();
        assert_eq!(searched_for_long(&word(b"teapot", &tail)).as_deref(), Some("teapot"));
        assert_eq!(searched_for_long(&word(b"teapot", &tail[..tail.len() - 1])), None, "a note one short");
        let mut other = tail.clone();
        other[1] = 0xad;
        assert_eq!(searched_for_long(&word(b"teapot", &other)), None, "a count that is another count");
        assert_eq!(searched_for_long(&word(&[0xff, 0xfe], &tail)), None, "a word that is not text");
        assert_eq!(searched_for_long(&[0x0a, 0x09, b'a']), None, "a word cut short");
        assert_eq!(searched_for_long(&[]), None);
    }

    /// MessagePack in its narrowest form: a text of 32 bytes or more takes a length byte, a count past 127 a byte of its
    /// own, a small one is itself, and what the format has no narrow form for is nil.
    #[test]
    fn a_search_answer_is_packed_in_the_narrowest_form() {
        let long = "x".repeat(40);
        let bytes = packed(&json!([{ "t": long, "n": 200, "s": 5, "z": null }, "ab"]));
        assert_eq!(bytes[0], 0x92, "a list of two");
        assert_eq!(bytes[1], 0x84, "a map of four");
        let has = |part: &[u8]| bytes.windows(part.len()).any(|w| w == part);
        assert!(has(&[&[0xd9, 40][..], long.as_bytes()].concat()), "a long text by its length");
        assert!(has(&[0xcc, 200]), "a count past 127 in a byte of its own");
        assert!(has(&[0xa1, b's', 5]), "a small count is itself");
        assert!(has(&[0xa1, b'z', 0xc0]), "nil");
        assert!(bytes.ends_with(&[0xa2, b'a', b'b']), "a short text by its length in the tag");
    }

    /// A date is read day first, as the page writes it: a real day of its month, in a leap year or not, and nothing
    /// that is not written two digits, two digits, four.
    #[test]
    fn a_date_is_a_real_day_written_day_month_year() {
        assert_eq!(dated("04/03/2026").as_deref(), Some("2026-03-04"));
        assert_eq!(dated("29/02/2024").as_deref(), Some("2024-02-29"), "a leap year");
        assert_eq!(dated("29/02/2000").as_deref(), Some("2000-02-29"), "a leap century");
        assert_eq!((dated("29/02/2023"), dated("29/02/1900")), (None, None), "not leap");
        assert_eq!(dated("30/04/2026").as_deref(), Some("2026-04-30"));
        assert_eq!(dated("31/04/2026"), None, "April has thirty");
        assert_eq!(dated("31/12/2026").as_deref(), Some("2026-12-31"));
        assert_eq!((dated("00/01/2026"), dated("01/13/2026"), dated("01/00/2026")), (None, None, None));
        for odd in ["1/03/2026", "01/3/2026", "01/03/26", "ab/03/2026", "01-03-2026", "01/02/03/2026", ""] {
            assert_eq!(dated(odd), None, "{odd:?}");
        }
    }

    /// A row passes only when the call answered for the value, with the records the site holds for it, no browser ran, and
    /// it reached no rung above the row's ceiling: each way it did not is said.
    #[test]
    fn a_row_passes_only_when_its_call_answered_for_the_value_within_its_ceiling() {
        let r = Row { ceiling: 1, ..row("plain") };
        let ran = |change: &dyn Fn(&mut Ran)| {
            let mut ran = Ran { ok: true, answer: json!({ "results": [{ "title": "teapot one" }, { "title": "teapot two" }] }), error: None, rung: 1, browser: false, steps: vec![1] };
            change(&mut ran);
            ran
        };
        assert_eq!(ran(&|_| {}).passes(&r, "teapot"), Ok(()), "at its ceiling is within it");
        assert_eq!(ran(&|r| { r.ok = false; r.error = Some("boom".into()) }).passes(&r, "teapot"), Err("the call failed: boom".into()));
        assert_eq!(ran(&|r| r.ok = false).passes(&r, "teapot"), Err("the call failed: ".into()));
        assert_eq!(ran(&|r| r.answer = json!({ "results": [] })).passes(&r, "teapot"), Err("the answer says nothing of teapot".into()));
        assert_eq!(ran(&|r| r.answer = json!({ "title": "teapot" })).passes(&r, "teapot"), Err("the answer says teapot back but holds none of its records".into()));
        assert_eq!(ran(&|r| r.browser = true).passes(&r, "teapot"), Err("a browser ran for the call".into()));
        assert_eq!(ran(&|r| r.rung = 2).passes(&r, "teapot"), Err("the call reached rung 2, above its ceiling 1".into()));
    }

    /// What a step took is put where the caller asked, and what the step answered is handed back.
    #[test]
    fn a_timed_step_notes_how_long_it_took_and_hands_back_its_answer() {
        let mut ms = None;
        let out = timed(&mut ms, || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            7
        });
        assert_eq!(out, 7);
        assert!(ms.is_some_and(|m| m >= 20), "{ms:?}");
    }

    /// The plainest row: the caller's value goes straight into the call's address. Learned from one walk of the page,
    /// the route answers for another value with no browser, at the first rung.
    #[test]
    #[ignore = "walks a page in a real browser"]
    fn a_plain_call_row_answers_with_the_browser_off() {
        store::scratch_home("matrix-plain");
        let base = site();
        let row = row("plain");
        let ran = learn_then_call(&base, &row, WALKED, CALLED).unwrap_or_else(|e| panic!("{e}"));
        ran.passes(&row, CALLED).unwrap_or_else(|e| panic!("{e}: {ran:?}"));
        assert!(!ran.answer.to_string().contains(WALKED), "the answer is for the new value, not the walk's: {}", ran.answer);
    }

    /// What the node logs of a row's call is what the bank's census counts: the plain row's calls show up there at the
    /// first rung, all answered with no browser. The census is the bank's own program, run on this node's home.
    #[test]
    #[ignore = "walks a page in a real browser, and runs the bank's census"]
    fn a_fixture_call_shows_up_in_the_census_at_its_rung() {
        let home = store::scratch_home("matrix-census");
        let base = site();
        learn_then_call(&base, &row("plain"), WALKED, CALLED).unwrap_or_else(|e| panic!("{e}"));
        let logged = run::made_log_in(&home).len();
        assert!(logged >= 1);
        let bank = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-banks/popular-sites/run_bank.py");
        let out = home.join("census.json");
        let ran = std::process::Command::new("python3").arg(&bank).args(["census", "--node-home"]).arg(&home).arg("--census").arg(&out).output().expect("python3 runs the census");
        assert!(ran.status.success(), "{}{}", String::from_utf8_lossy(&ran.stdout), String::from_utf8_lossy(&ran.stderr));
        let census: Value = serde_json::from_slice(&std::fs::read(&out).expect("the census file")).expect("the census as JSON");
        assert_eq!(census["calls"], json!(logged), "every logged call is counted");
        assert_eq!(census["by_rung"]["0"], json!(logged), "{census}");
        assert_eq!(census["browserless_answered"], json!(logged), "{census}");
        assert_eq!(census["browser_calls"], json!([]));
    }

    /// The control for every row: a page whose search answers for the walk's value whatever it is asked is learned and
    /// called like any other, and the matrix fails it, because the answer says nothing of the value asked.
    #[test]
    #[ignore = "walks a page in a real browser"]
    fn a_row_whose_page_lies_fails_the_matrix() {
        store::scratch_home("matrix-lies");
        let base = site();
        let lies = Row { id: "lies".into(), family: "sources".into(), page: "/p/lies".into(), ceiling: 0, person: false, walked: None, called: None, third: None, unknown: None, first: false, goal: None };
        let ran = learn_then_call(&base, &lies, WALKED, CALLED).unwrap_or_else(|e| panic!("the lying page is still learned and called: {e}"));
        assert!(ran.ok, "the lying page's call answers: {ran:?}");
        let verdict = ran.passes(&lies, CALLED);
        assert_eq!(verdict, Err(format!("the answer says nothing of {CALLED}")), "{ran:?}");
    }

    /// Which rows pass today, written beside the matrix before anything is fixed for them: the honest starting point,
    /// and what a later change is measured against.
    #[test]
    #[ignore = "walks every row's page in a real browser"]
    fn the_matrix_baseline_is_written() {
        let base = site();
        let mut rows = serde_json::Map::new();
        for r in matrix() {
            let verdict = match run_row(&base, &r) {
                Ok(()) => "pass".to_string(),
                Err(why) => format!("fail: {}", why.chars().take(200).collect::<String>()),
            };
            eprintln!("  {:16} {verdict}", r.id);
            rows.insert(r.id.clone(), Value::String(verdict));
        }
        let passed = rows.values().filter(|v| v.as_str() == Some("pass")).count();
        let out = json!({ "about": "Which rows of the matrix passed when the_matrix_baseline_is_written last ran.", "passed": passed, "rows": rows });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/primitives/baseline.json");
        std::fs::write(&path, serde_json::to_string_pretty(&out).expect("the baseline as JSON") + "\n").expect("the baseline is written");
        assert!(passed >= 1, "not even the plain row passed");
    }

    #[test]
    #[ignore = "walks every row's page in a real browser"]
    fn every_row_of_the_matrix_answers_within_its_ceiling() {
        none_fail(None);
    }

    #[test]
    #[ignore = "walks the family's pages in a real browser"]
    fn every_sources_row_answers_within_its_ceiling() {
        none_fail(Some("sources"));
    }

    #[test]
    #[ignore = "walks the family's pages in a real browser"]
    fn every_transports_row_answers_within_its_ceiling() {
        none_fail(Some("transports"));
    }

    #[test]
    #[ignore = "walks the family's pages in a real browser"]
    fn every_codecs_row_answers_within_its_ceiling() {
        none_fail(Some("codecs"));
    }

    #[test]
    #[ignore = "walks the family's pages in a real browser"]
    fn every_state_row_answers_within_its_ceiling() {
        none_fail(Some("state"));
    }

    #[test]
    #[ignore = "walks the family's pages in a real browser"]
    fn every_contexts_row_answers_within_its_ceiling() {
        none_fail(Some("contexts"));
    }

    /// A row only a person passes is never answered by the node alone: it says the page needs hands, and keeps no route.
    #[test]
    #[ignore = "walks the family's pages in a real browser"]
    fn every_person_row_asks_the_owner_and_never_runs_headless() {
        none_fail(Some("person"));
    }
}

#[cfg(test)]
mod one_row {
    use super::*;

    /// Every row through the learner the switch names (`learn::learns_by_example`), each in a scratch home of its
    /// own: with the switch off as the matrix has always run, one walk and a call; with it on, or `MATRIX_SECOND_LOOK`
    /// set, as an ask of the node learns, with the node and its second look, which is where a learn by example gets
    /// its second walk. Each row's verdict, the rung its call reached and what was kept are written, a line each, to
    /// `MATRIX_TABLE`; what the engine's readers said of the row goes to the log after a `== row` line. With
    /// `MATRIX_ARM=b`, each row runs as arm B of the A/B of the node's own asks (`arm_b_line`); unset, as it always has.
    #[test]
    #[ignore = "walks every row's page in a real browser; writes its table to MATRIX_TABLE"]
    fn the_matrix_through_the_learner_the_switch_names() {
        let Some(table) = std::env::var_os("MATRIX_TABLE") else { return };
        // `MATRIX_ARM=b`: each row as arm B of the A/B of the node's own asks runs it (`arm_b_line`).
        // Arm B is the node's default (15 November); `MATRIX_ARM=a` with `UNBROWSE_ARM_A=1` runs the old node.
        let arm_b = !std::env::var("MATRIX_ARM").is_ok_and(|a| a.trim().eq_ignore_ascii_case("a")) && learn::own_asks::confirms_by_use();
        let second_look = !arm_b && (learn::learns_by_example() || std::env::var_os("MATRIX_SECOND_LOOK").is_some());
        // Every request the node sends has a line in the sent log (`UNBROWSE_SENT_LOG`), which a process reads once:
        // one log for the run, beside the table unless one is named, and a row's are the lines it added.
        let sent_log = std::env::var_os("UNBROWSE_SENT_LOG").filter(|p| !p.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| {
            let log = std::path::PathBuf::from(format!("{}.sent.jsonl", table.to_string_lossy()));
            let _ = std::fs::remove_file(&log);
            std::env::set_var("UNBROWSE_SENT_LOG", &log);
            log
        });
        // Each browser the run launches is said on the log as the node says it (`browser {"launched"…}`), so a row's
        // launches are the lines after its `== row` line; the records are kept beside the table.
        let _ = agent_browser_core::cdp::launched::keep_records_in(std::path::Path::new(&format!("{}.launches", table.to_string_lossy())));
        let base = site();
        let mut lines = Vec::new();
        for r in matrix().into_iter().filter(|r| std::env::var("MATRIX_ROWS").map_or(true, |only| only.split(',').any(|id| id == r.id))) {
            eprintln!("== row {} (by example {}, second look {second_look})", r.id, learn::learns_by_example());
            let sent_before = lines_in(&sent_log);
            let mut cost = Cost::default();
            // A row only a person passes, or one walked with a value the site holds nothing for, is judged by what
            // the learn keeps (`run_row`): no route.
            let mut line = if r.person || r.first || nothing_for(r.walked()) {
                json!({ "row": r.id, "family": r.family, "ceiling": r.ceiling, "verdict": match run_row(&base, &r) { Ok(()) => "pass".to_string(), Err(why) => format!("fail: {why}") } })
            } else if arm_b {
                store::scratch_home(&format!("matrix-{}", r.id));
                arm_b_line(&base, &r, &mut cost)
            } else {
                store::scratch_home(&format!("matrix-{}", r.id));
                let node = second_look.then(|| crate::testchain::node("matrix"));
                match learn_then_call_costed(&base, &r, r.walked(), r.called(), Some(r.third()), node.as_deref(), &mut cost) {
                    Err(why) => json!({ "row": r.id, "family": r.family, "ceiling": r.ceiling, "verdict": format!("fail: {why}") }),
                    Ok((ran, route, third)) => {
                        let verdict = match ran.passes(&r, r.called()) {
                            Ok(()) => "pass".to_string(),
                            Err(why) => format!("fail: {why}"),
                        };
                        let steps: Vec<String> = route.graph.steps.iter().map(|s| format!("{} {}", s.method, s.url.split('?').next().unwrap_or_default())).collect();
                        let body = route.body.as_ref().map(|b| json!({ "steps": b.steps.len(), "slots": b.slots.iter().map(|s| s.name.clone()).collect::<Vec<_>>(), "said_as_a_graph": unbrowse_learn::body::to_graph(b).is_ok(), "plan": b.plan.as_ref().map(|p| p.page.clone()) }));
                        let over_scripts: Vec<String> = route.body.as_ref().map(|b| b.tests.iter().flat_map(|t| t.over_scripts.clone()).collect()).unwrap_or_default();
                        // The third value's warm call, beside the verdict, which stays the called value's.
                        let third = match third.unwrap_or_else(|| Err("not called".into())).and_then(|t| t.passes(&r, r.third())) {
                            Ok(()) => "pass".to_string(),
                            Err(why) => format!("fail: {why}"),
                        };
                        json!({ "row": r.id, "family": r.family, "ceiling": r.ceiling, "verdict": verdict, "third": third, "rung": ran.rung, "made_steps": ran.steps, "browser": ran.browser, "error": ran.error, "steps": steps, "inputs": route.inputs.iter().map(|i| i.name.clone()).collect::<Vec<_>>(), "body": body, "over_scripts": over_scripts, "checked": route.checked.as_ref().map(|c| c.tests.clone()) })
                    }
                }
            };
            let sent = lines_in(&sent_log).saturating_sub(sent_before);
            let made = run::made_log_in(&store::home()).len();
            costed(&mut line, if arm_b { "b" } else { "a" }, &cost, sent, made);
            eprintln!("== verdict {}: {}", r.id, line["verdict"]);
            lines.push(line.to_string());
        }
        std::fs::write(&table, lines.join("\n") + "\n").expect("the table is written");
    }

    /// A row's line of the table as arm B runs it (`learn_then_confirm_costed`): the confirming browse's verdict, the third
    /// value's warm call, the walks made and any call the node made on its own, beside the fields every line has.
    /// It passes only where the browse agreed, the third call passed, two walks were made and nothing else was called.
    /// The lines of a file, none where there is no file.
    fn lines_in(path: &std::path::Path) -> usize {
        std::fs::read_to_string(path).map(|t| t.lines().count()).unwrap_or_default()
    }

    /// A row's line, with what it cost beside its verdict, the same in both arms: `arm` (`a` or `b`); `ms_first`,
    /// `ms_second`, `ms_third` (`Cost`); `walks`, the page loads; `sent`, the requests the node sent during the row
    /// (its lines of the sent log), and of them `sent_harness`, the harness's own calls', and `own_n`, the rest:
    /// the node asking the site on its own; and `made`, the lines `made.jsonl` holds for the row. A field the line
    /// already has (arm B's `own`, its list of calls) is left as it is.
    fn costed(line: &mut Value, arm: &str, cost: &Cost, sent: usize, made: usize) {
        line["arm"] = json!(arm);
        line["ms_first"] = json!(cost.ms_first);
        line["ms_second"] = json!(cost.ms_second);
        line["ms_third"] = json!(cost.ms_third);
        line["walks"] = json!(cost.walks);
        line["sent"] = json!(sent);
        line["sent_harness"] = json!(cost.harness_sent);
        line["own_n"] = json!((sent as u64).saturating_sub(cost.harness_sent));
        line["made"] = json!(made);
    }

    /// A row's cost is said the same in both arms, the node's own sends told apart from the harness's: what the
    /// sent log holds past the harness's calls is the node's own, and a field the line had stays as it was.
    #[test]
    fn a_rows_line_counts_the_nodes_own_sends_apart_from_the_harnesss() {
        let cost = Cost { ms_first: Some(1200), ms_second: Some(800), ms_third: Some(40), walks: 2, harness_sent: 3 };
        let mut line = json!({ "row": "plain", "verdict": "pass", "own": ["r1"] });
        costed(&mut line, "b", &cost, 5, 4);
        assert_eq!(line, json!({ "row": "plain", "verdict": "pass", "own": ["r1"], "arm": "b", "ms_first": 1200, "ms_second": 800, "ms_third": 40, "walks": 2, "sent": 5, "sent_harness": 3, "own_n": 2, "made": 4 }));
        let mut unreached = json!({ "row": "plain", "verdict": "fail: not learned" });
        costed(&mut unreached, "a", &Cost::default(), 0, 0);
        assert_eq!((unreached["ms_second"].clone(), unreached["own_n"].clone()), (Value::Null, json!(0)), "what was not reached stays unset");
        let dir = std::env::temp_dir().join(format!("matrix-lines-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("sent.jsonl");
        assert_eq!(lines_in(&log), 0, "no log, no lines");
        std::fs::write(&log, "{}\n{}\n{}\n").unwrap();
        assert_eq!(lines_in(&log), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn arm_b_line(base: &str, r: &Row, cost: &mut Cost) -> Value {
        use learn::own_asks::{held, Ask};
        let held: Vec<&str> = Ask::EVERY.into_iter().filter(|&a| held(a)).map(Ask::family).collect();
        let mut line = json!({ "row": r.id, "family": r.family, "ceiling": r.ceiling, "arm": "b", "held": held });
        let ran = match learn_then_confirm_costed(base, r, cost) {
            Ok(ran) => ran,
            Err(why) => {
                line["verdict"] = json!(format!("fail: {why}"));
                return line;
            }
        };
        let third = ran.third.passes(r, r.third());
        let walks = 2 + usize::from(r.unknown.is_some());
        let quiet = match (ran.walks, ran.own.is_empty()) {
            (n, true) if n == walks => Ok(()),
            (n, false) if n == walks => Err(format!("the node called the site on its own: {}", ran.own.join(", "))),
            (n, _) => Err(format!("{n} walks were made, not the learn's and the confirming browses' {walks}")),
        };
        // A value the site holds nothing for confirms nothing: a browse of it that agreed agreed on nothing.
        if let (Some(u), Some(learn::confirm::Confirmed::Agreed)) = (r.unknown.as_deref(), &ran.unknown) {
            line["verdict"] = json!(format!("fail: the confirming browse agreed on {u}, which the site holds nothing for"));
            line["unknown"] = json!({ "value": u, "verdict": "agreed" });
            line["third"] = json!(match ran.third.passes(r, r.third()) { Ok(()) => "pass".to_string(), Err(why) => format!("fail: {why}") });
            return line;
        }
        line["verdict"] = json!(match (&ran.confirm, &third, &quiet) {
            (learn::confirm::Confirmed::Agreed, Ok(()), Ok(())) => "pass".to_string(),
            // The walks could not tell two writings of the value apart: the route stands unconfirmed, and is not counted
            // wrong. Its third value, where that parts the writings, still says whether the route answers.
            (learn::confirm::Confirmed::CannotTell { why }, Ok(()), Ok(())) => format!("unconfirmed: {why}"),
            (learn::confirm::Confirmed::Agreed | learn::confirm::Confirmed::CannotTell { .. }, Ok(()), Err(why)) => format!("fail: {why}"),
            (learn::confirm::Confirmed::Agreed | learn::confirm::Confirmed::CannotTell { .. }, Err(why), _) => format!("fail: the third value: {why}"),
            (other, _, _) => format!("fail: the confirming browse {}", other.said()),
        });
        line["confirm"] = json!({ "verdict": ran.confirm.word(), "why": ran.confirm.why() });
        if let (Some(u), Some(v)) = (r.unknown.as_deref(), &ran.unknown) {
            line["unknown"] = json!({ "value": u, "verdict": v.word(), "why": v.why() });
        }
        line["third"] = json!(match &third {
            Ok(()) => "pass".to_string(),
            Err(why) => format!("fail: {why}"),
        });
        line["walks"] = json!(ran.walks);
        line["own"] = json!(ran.own);
        let route = &ran.route;
        line["rung"] = json!(ran.third.rung);
        line["made_steps"] = json!(ran.third.steps);
        line["browser"] = json!(ran.third.browser);
        line["error"] = json!(ran.third.error);
        line["steps"] = json!(route.graph.steps.iter().map(|s| format!("{} {}", s.method, s.url.split('?').next().unwrap_or_default())).collect::<Vec<_>>());
        line["inputs"] = json!(route.inputs.iter().map(|i| i.name.clone()).collect::<Vec<_>>());
        line["body"] = json!(route.body.as_ref().map(|b| json!({ "steps": b.steps.len(), "slots": b.slots.iter().map(|s| s.name.clone()).collect::<Vec<_>>(), "said_as_a_graph": unbrowse_learn::body::to_graph(b).is_ok(), "plan": b.plan.as_ref().map(|p| p.page.clone()) })));
        line["over_scripts"] = json!(route.body.as_ref().map(|b| b.tests.iter().flat_map(|t| t.over_scripts.clone()).collect::<Vec<_>>()).unwrap_or_default());
        line["checked"] = json!(route.checked.as_ref().map(|c| c.tests.clone()));
        line
    }

    /// What the walk's recording holds for a row's signing header (`MATRIX_ROW`, default `signed-own`): each probe
    /// the page's code left (the header it set, the string it built just before, and the stack of scripts that sent
    /// the call), and each script the walk fetched, by the SHA-256 of its body. This is the evidence a cut function
    /// would be read from; it builds nothing. Printed.
    #[test]
    #[ignore = "walks a page in a real browser to read its recording"]
    fn what_the_recording_holds_for_a_signing_header() {
        store::scratch_home("matrix-recording");
        let row = row(&std::env::var("MATRIX_ROW").unwrap_or_else(|_| "signed-own".into()));
        let base = site();
        let mut settings = store::load_settings();
        settings.headless_only = true;
        store::save_settings(&settings).unwrap();
        a_rows_browser();
        let walks = learn::Walks::default();
        let url = format!("{base}{}?q={WALKED}", row.page);
        let id = learn::walk_key(&url);
        learn::walk_as(&walks, &url, &id, "You", &|_| {}).unwrap_or_else(|e| panic!("{e}"));
        let guard = walks.0.lock().expect("the walks");
        let walk = guard.get(&id).expect("the walk");
        eprintln!("== probes of {}", row.id);
        for p in &walk.probes {
            if !p.header.is_empty() {
                eprintln!("  header {}={} (built from {:?}, pre {:?})", p.header, p.value.chars().take(24).collect::<String>(), p.input.chars().take(80).collect::<String>(), p.pre.chars().take(80).collect::<String>());
            }
            if !p.stack.is_empty() {
                eprintln!("  call {} sent by:", p.url.split('?').next().unwrap_or_default());
                for f in &p.stack {
                    eprintln!("      {} {}:{} {}", f.function, f.script.split('/').next_back().unwrap_or_default(), f.line, f.column);
                }
            }
        }
        eprintln!("== scripts the walk fetched");
        for e in walk.trace.exchanges.iter().filter(|e| e.resource_type.as_deref() == Some("Script") || e.url.path().ends_with(".js")) {
            let body = e.response_body.as_deref().unwrap_or_default();
            let sha = hex::encode(Sha256::digest(body.as_bytes()));
            eprintln!("  {} sha256:{} {} bytes", e.url.path(), &sha[..16], body.len());
            eprintln!("      {}", body.lines().find(|l| l.contains("mix") || l.contains("fetch")).unwrap_or("").trim().chars().take(140).collect::<String>());
        }
    }

    /// Runs the row named by `MATRIX_ROW`, saying what the node logged: for working on one row at a time.
    #[test]
    #[ignore = "walks a page in a real browser; names its row in MATRIX_ROW"]
    fn the_named_row() {
        let Ok(id) = std::env::var("MATRIX_ROW") else { return };
        let base = site();
        let verdict = run_row(&base, &row(&id));
        eprintln!("row {id}: {verdict:?}");
        verdict.unwrap_or_else(|e| panic!("{e}"));
    }
}
