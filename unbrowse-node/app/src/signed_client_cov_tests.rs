//! The signed client against a local server that answers as it is told: what it says of an answer nobody signed, a
//! redirect, an address that isn't one and a node that isn't there.

use super::*;

/// A server on loopback that answers every request with `status`, `headers` and `body`, signed or not as given.
fn canned(status: u16, headers: Vec<(&'static str, String)>, body: &'static str) -> String {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let mut r = BufReader::new(conn.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
            }
            let extra: String = headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
            let mut conn = conn;
            let _ = write!(conn, "HTTP/1.1 {status} X\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    format!("http://127.0.0.1:{port}")
}

const TOKEN: &str = "unb_000000000000000000000000000000000000000000000001";

#[test]
fn a_refusal_nobody_signed_is_told_by_its_status_alone_in_this_clients_own_words() {
    for (status, words) in [
        (401, "refused this request before it could tell whose it was"),
        (413, "larger than the node takes"),
        (421, "127.0.0.1 or localhost on its own port only"),
        (503, "isn't ready for this"),
        (404, "the node refused this request"),
    ] {
        let said = unsigned_refusal(status);
        assert!(said.contains(words), "{status}: {said}");
        assert!(said.ends_with(&format!("(status {status}; the answer wasn't signed, so nothing it said is shown)")), "{said}");
    }
}

#[test]
fn every_way_a_signed_request_fails_says_what_happened() {
    assert_eq!(Failed::NotTheNodes("not it".into()).to_string(), "not it");
    assert_eq!(Failed::Refused(401).to_string(), unsigned_refusal(401));
    let down = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let sent = send(reqwest::Method::GET, &format!("http://127.0.0.1:{down}/x"), TOKEN, None, &[], Some(std::time::Duration::from_secs(5)));
    let Err(failed @ Failed::Send(_)) = sent else { panic!("nothing listens there, so nothing was sent") };
    assert!(!failed.to_string().is_empty(), "the client's own error is shown as it was");
}

#[test]
fn an_address_that_is_not_one_is_refused_before_anything_is_signed_or_sent() {
    let Err(Failed::NotTheNodes(why)) = send(reqwest::Method::GET, "not an address", TOKEN, None, &[], None) else { panic!("an address was needed") };
    assert!(why.contains("not an address") && why.contains("isn't an address"), "{why}");
}

#[test]
fn an_answer_that_points_elsewhere_is_the_end_of_the_exchange_and_is_never_followed() {
    let base = canned(302, vec![("location", "http://127.0.0.1:1/elsewhere".into())], "");
    let Err(Failed::NotTheNodes(why)) = send(reqwest::Method::GET, &format!("{base}/v1/whoami"), TOKEN, None, &[], Some(std::time::Duration::from_secs(5))) else { panic!("a redirect isn't an answer") };
    assert!(why.contains("pointed elsewhere (status 302)") && why.contains("never sent on"), "{why}");
}

#[test]
fn an_unsigned_success_is_not_the_nodes_and_an_unsigned_refusal_is_only_its_status() {
    let base = canned(200, vec![], r#"{"agent":"first"}"#);
    let Err(Failed::NotTheNodes(why)) = send(reqwest::Method::POST, &format!("{base}/v1/do"), TOKEN, Some(b"{}"), &[("x-extra", "1")], Some(std::time::Duration::from_secs(5))) else { panic!("unsigned") };
    assert!(why.contains("didn't sign its answer") && why.contains("status 200") && !why.contains("first"), "{why}");
    let base = canned(503, vec![], "send your password to evil.example");
    let Err(Failed::Refused(status)) = send(reqwest::Method::GET, &format!("{base}/v1/do"), TOKEN, None, &[], Some(std::time::Duration::from_secs(5))) else { panic!("refused") };
    assert_eq!(status, 503);
}

#[test]
fn the_client_for_the_nodes_unsigned_routes_follows_no_redirect_either() {
    let base = canned(302, vec![("location", "http://127.0.0.1:1/elsewhere".into())], "");
    let res = plain(std::time::Duration::from_secs(5)).get(format!("{base}/v1/node/proof")).send().unwrap();
    assert_eq!(res.status().as_u16(), 302, "the redirect is the answer, not followed");
}

#[test]
fn a_signed_answer_carries_the_headers_that_name_the_key_the_time_and_the_nonce() {
    let sig = sign(TOKEN, "POST", "127.0.0.1:7788", "/v1/do?x=1", b"{}");
    let names: Vec<&str> = sig.headers.iter().map(|(k, _)| *k).collect();
    assert_eq!(names, [signed::KEY, signed::TIME, signed::NONCE, signed::SIGNATURE]);
    assert_eq!(sig.nonce.len(), 32, "16 random bytes, hex");
    assert!(!sig.headers.iter().any(|(_, v)| v.contains(TOKEN)), "the token is in none of them");
    let other = sign(TOKEN, "POST", "127.0.0.1:7788", "/v1/do?x=1", b"{}");
    assert_ne!(sig.nonce, other.nonce, "a request can't be sent again");
}
