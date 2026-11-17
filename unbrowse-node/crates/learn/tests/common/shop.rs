//! A test shop that needs every kind of value route learning has to handle:
//! a static key in its JS, a cookie and CSRF token from the first page, a guest token from
//! an API call, a session cookie from login, a product ID and cart ID carried between
//! steps, typed input, and a signature the page computes in JS.
//!
//! Every endpoint checks what it receives, so a flow only succeeds when each value was
//! passed through correctly.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

pub const API_KEY: &str = "pk_fixture_7f3a9c21";

#[derive(Default)]
struct Shop {
    csrf_by_visitor: HashMap<String, String>,
    guest_tokens: HashSet<String>,
    sessions: HashMap<String, String>,
    products: HashSet<String>,
    carts: HashMap<String, String>,
}

type Db = Arc<Mutex<Shop>>;

fn id(prefix: &str) -> String {
    format!("{prefix}{:016x}", rand::random::<u64>())
}

/// FNV-1a, 32-bit, the same as the page's JS.
pub fn fnv(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.encode_utf16() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').map(str::trim).find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn hdr(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name)?.to_str().ok().map(str::to_string)
}

fn deny(why: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": why }))).into_response()
}

/// Checks the visitor cookie and its CSRF token, and the session if `need_session`.
fn check(db: &Shop, headers: &HeaderMap, need_session: bool) -> Result<(), Response> {
    let visitor = cookie(headers, "visitor").ok_or_else(|| deny("no visitor cookie"))?;
    let csrf = db.csrf_by_visitor.get(&visitor).ok_or_else(|| deny("unknown visitor"))?;
    if hdr(headers, "x-csrf").as_ref() != Some(csrf) {
        return Err(deny("bad csrf"));
    }
    if need_session {
        let sid = cookie(headers, "sid").ok_or_else(|| deny("not signed in"))?;
        if !db.sessions.contains_key(&sid) {
            return Err(deny("unknown session"));
        }
    }
    Ok(())
}

async fn index(State(db): State<Db>) -> Response {
    let visitor = id("v_");
    let csrf = id("csrf_");
    db.lock().unwrap().csrf_by_visitor.insert(visitor.clone(), csrf.clone());
    let html = format!(
        r#"<!doctype html><html><head><meta name="csrf" content="{csrf}"><title>Fixture shop</title></head>
<body>
<input id="user"> <input id="pass" type="password"> <button id="login">Sign in</button> <span id="who"></span>
<input id="q"> <button id="search">Search</button>
<ul id="results"></ul>
<span id="cart"></span>
<input id="note"> <button id="checkout">Place order</button>
<span id="order"></span>
<script src="/app.js"></script>
</body></html>"#
    );
    let mut res = Html(html).into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, format!("visitor={visitor}; Path=/").parse().unwrap());
    res
}

const APP_JS: &str = r#"
const API_KEY = "pk_fixture_7f3a9c21";
const csrf = document.querySelector('meta[name="csrf"]').content;
let guestToken = null, cartId = null;

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const base = () => ({ "x-csrf": csrf, "content-type": "application/json" });

fetch("/api/guest", { method: "POST", headers: { "x-api-key": API_KEY } })
  .then(r => r.json()).then(j => { guestToken = j.guestToken; });

document.getElementById("login").onclick = async () => {
  const r = await fetch("/api/login", { method: "POST", headers: base(),
    body: JSON.stringify({ user: user.value, password: pass.value }) });
  const j = await r.json();
  document.getElementById("who").textContent = j.user || "";
};

document.getElementById("search").onclick = async () => {
  const r = await fetch("/api/search?q=" + encodeURIComponent(q.value), { headers: {
    ...base(), "x-api-key": API_KEY, "authorization": "Bearer " + guestToken } });
  const j = await r.json();
  results.innerHTML = "";
  for (const p of j.results) {
    const li = document.createElement("li");
    li.innerHTML = `${p.name} <button class="add" data-id="${p.id}">Add</button>`;
    results.appendChild(li);
  }
  for (const b of document.querySelectorAll(".add")) b.onclick = async () => {
    const r = await fetch("/api/cart", { method: "POST", headers: base(),
      body: JSON.stringify({ productId: b.dataset.id }) });
    cartId = (await r.json()).cartId;
    document.getElementById("cart").textContent = cartId;
  };
};

document.getElementById("checkout").onclick = async () => {
  const ts = String(Date.now());
  const r = await fetch(`/api/cart/${cartId}/checkout`, { method: "POST",
    headers: { ...base(), "x-ts": ts, "x-sig": fnv(cartId + ts) },
    body: JSON.stringify({ note: note.value }) });
  const j = await r.json();
  document.getElementById("order").textContent = j.status || j.error;
};
"#;

async fn app_js() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/javascript")], APP_JS)
}

async fn guest(State(db): State<Db>, headers: HeaderMap) -> Response {
    if hdr(&headers, "x-api-key").as_deref() != Some(API_KEY) {
        return deny("bad api key");
    }
    let token = id("g_");
    db.lock().unwrap().guest_tokens.insert(token.clone());
    Json(json!({ "guestToken": token })).into_response()
}

async fn login(State(db): State<Db>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut db = db.lock().unwrap();
    if let Err(r) = check(&db, &headers, false) {
        return r;
    }
    let user = body["user"].as_str().unwrap_or_default().to_string();
    if user.is_empty() || body["password"].as_str() != Some(&format!("pw-{user}")) {
        return deny("wrong password");
    }
    let sid = id("s_");
    db.sessions.insert(sid.clone(), user.clone());
    let mut res = Json(json!({ "ok": true, "user": user })).into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, format!("sid={sid}; Path=/; HttpOnly").parse().unwrap());
    res
}

async fn search(State(db): State<Db>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let mut db = db.lock().unwrap();
    if let Err(r) = check(&db, &headers, true) {
        return r;
    }
    if hdr(&headers, "x-api-key").as_deref() != Some(API_KEY) {
        return deny("bad api key");
    }
    let bearer = hdr(&headers, "authorization").unwrap_or_default();
    if !db.guest_tokens.contains(bearer.trim_start_matches("Bearer ")) {
        return deny("bad guest token");
    }
    let q = q.get("q").cloned().unwrap_or_default();
    let results: Vec<Value> = (1..=2)
        .map(|n| {
            let pid = id("p_");
            db.products.insert(pid.clone());
            json!({ "id": pid, "name": format!("{q} {n}") })
        })
        .collect();
    Json(json!({ "results": results })).into_response()
}

async fn add_to_cart(State(db): State<Db>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut db = db.lock().unwrap();
    if let Err(r) = check(&db, &headers, true) {
        return r;
    }
    let pid = body["productId"].as_str().unwrap_or_default().to_string();
    if !db.products.contains(&pid) {
        return deny("unknown product");
    }
    let cart = id("c_");
    db.carts.insert(cart.clone(), pid);
    Json(json!({ "cartId": cart })).into_response()
}

async fn checkout(State(db): State<Db>, headers: HeaderMap, Path(cart): Path<String>, Json(body): Json<Value>) -> Response {
    let db = db.lock().unwrap();
    if let Err(r) = check(&db, &headers, true) {
        return r;
    }
    if !db.carts.contains_key(&cart) {
        return deny("unknown cart");
    }
    let ts = hdr(&headers, "x-ts").unwrap_or_default();
    if hdr(&headers, "x-sig") != Some(fnv(&format!("{cart}{ts}"))) {
        return deny("bad signature");
    }
    Json(json!({ "orderId": id("o_"), "status": "placed", "note": body["note"] })).into_response()
}

/// Serves the shop on a free localhost port from a background thread; returns its base URL.
pub fn start() -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            let app = Router::new()
                .route("/", get(index))
                .route("/app.js", get(app_js))
                .route("/api/guest", post(guest))
                .route("/api/login", post(login))
                .route("/api/search", get(search))
                .route("/api/cart", post(add_to_cart))
                .route("/api/cart/{cart}/checkout", post(checkout))
                .with_state(Db::default());
            axum::serve(listener, app).await.unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}
