//! A request to the node signed with a token that never leaves this process (`unbrowse_core::signed`), and its answer
//! taken only when the node signed it. The node's CLI (`owner_call`) and `unb` both send this way, so a process that
//! took the node's address, or relays it, gets one request it can't send again and no token, and can't hand back an
//! answer of its own.

use unbrowse_core::signed;

/// The node's signed answer.
pub struct Answer {
    pub status: u16,
    /// Read by `unb mcp` (the MCP session the node opens); the node's own CLI needs only the status and the body, and
    /// both programs build this file.
    #[allow(dead_code)]
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

/// Why a signed request came back with nothing to use.
#[derive(Debug)]
pub enum Failed {
    /// It never reached anything, or nothing answered: the `reqwest` error as it was.
    Send(reqwest::Error),
    /// Something answered, but not as the node signs: an answer of whatever holds the address, never used.
    NotTheNodes(String),
    /// A refusal the node didn't sign: the node refusing before it could tell whose the request was, or anything holding
    /// its address. Only its status is read; what is said is this client's own (`unsigned_refusal`).
    Refused(u16),
}

/// What a client says of a refusal the node didn't sign, by its status alone: its words may be anyone's, and are never
/// shown.
pub fn unsigned_refusal(status: u16) -> String {
    let said = match status {
        401 => "the node refused this request before it could tell whose it was: the key may be unknown, revoked or expired, or this machine's clock too far off (get a fresh key: `unbrowse connect`, or `unbrowse agent token`)",
        413 => "the request was larger than the node takes",
        421 => "the node takes requests at 127.0.0.1 or localhost on its own port only",
        503 => "the node isn't ready for this (starting, paused, or waiting for its key, or it couldn't record the request): try again shortly",
        _ => "the node refused this request",
    };
    format!("{said} (status {status}; the answer wasn't signed, so nothing it said is shown)")
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failed::Send(e) => write!(f, "{e}"),
            Failed::NotTheNodes(why) => write!(f, "{why}"),
            Failed::Refused(status) => write!(f, "{}", unsigned_refusal(*status)),
        }
    }
}

/// A fresh nonce: 16 random bytes, hex.
fn nonce() -> String {
    let mut n = [0u8; 16];
    getrandom::fill(&mut n).expect("the OS gives no randomness");
    hex::encode(n)
}

/// The one client every signed request goes through: it follows no redirect.
fn client() -> &'static reqwest::blocking::Client {
    static C: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).build().expect("client"))
}

/// A client for the node's unsigned routes (its proof, its health): it follows no redirect either.
#[allow(dead_code)]
pub fn plain(timeout: std::time::Duration) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(timeout).build().expect("client")
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Sends `body` (JSON, or nothing) to `url` as `method`, signed with `token`, with `extra` headers beside; `wait` bounds
/// the whole exchange. An answer is handed back only when the node signed it for this request, a refusal included. A
/// refusal it didn't sign comes back as `Refused` with its status alone.
///
/// It never follows a redirect: an answer that points elsewhere is the end of the exchange, so a signed request goes
/// only to the address it was signed for, and the signature names that address (`request_mac`'s authority).
pub fn send(
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<&[u8]>,
    extra: &[(&str, &str)],
    wait: Option<std::time::Duration>,
) -> Result<Answer, Failed> {
    let parsed = reqwest::Url::parse(url).map_err(|e| Failed::NotTheNodes(format!("{url} isn't an address: {e}")))?;
    let target = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_string(),
    };
    let bytes = body.unwrap_or_default();
    let (nonce, time) = (nonce(), now());
    let authority = signed::authority(parsed.host_str().unwrap_or_default(), parsed.port(), parsed.scheme() == "https");
    let sig = hex::encode(signed::request_mac(token, method.as_str(), &authority, &target, bytes, time, &nonce));
    let mut req = client()
        .request(method, parsed)
        .header(signed::KEY, hex::encode(unbrowse_core::token_key(token)))
        .header(signed::TIME, time.to_string())
        .header(signed::NONCE, &nonce)
        .header(signed::SIGNATURE, sig);
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    if let Some(body) = body {
        req = req.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_vec());
    }
    req = req.timeout(wait.unwrap_or(std::time::Duration::from_secs(330)));
    let res = req.send().map_err(Failed::Send)?;
    let (status, headers) = (res.status().as_u16(), res.headers().clone());
    if res.status().is_redirection() {
        return Err(Failed::NotTheNodes(format!("what answered at {url} pointed elsewhere (status {status}): a request to the node is never sent on")));
    }
    let body = res.bytes().map_err(Failed::Send)?.to_vec();
    let theirs = headers.get(signed::REPLY).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !signed::matches(&signed::reply_mac(token, status, &signed::body_hash(&body), &nonce), theirs) {
        if (200..300).contains(&status) {
            return Err(Failed::NotTheNodes(format!(
                "what answered at {url} didn't sign its answer as the node this token is for does (status {status}): nothing it said is used or shown"
            )));
        }
        return Err(Failed::Refused(status));
    }
    Ok(Answer { status, headers, body })
}
