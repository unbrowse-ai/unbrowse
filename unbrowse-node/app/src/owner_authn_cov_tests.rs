//! Coverage for the owner's own authenticator: how a page's request is read, what the owner is shown, and the
//! credential the page gets back, all against a software key and no browser.

use super::tests::SoftKey;
use super::*;
use std::collections::BTreeMap;

fn payload(kind: &str, origin: &str, pk: Value) -> Value {
    json!({ "kind": kind, "origin": origin, "top": true, "publicKey": pk })
}

fn create_pk() -> Value {
    json!({
        "challenge": "AAEC",
        "rp": { "id": "example.com", "name": "Example" },
        "user": { "id": "AQID", "name": "me@example.com", "displayName": "Me" },
        "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
    })
}

fn create_ask() -> Ask {
    Ask::from_page("https://login.example.com/", &payload("create", "https://login.example.com", create_pk())).unwrap()
}

fn cancel() -> AtomicBool {
    AtomicBool::new(false)
}

/// A `Ui` that keeps what it is told.
fn listening() -> (Ui, Arc<Mutex<Vec<ToPage>>>) {
    let heard: Arc<Mutex<Vec<ToPage>>> = Arc::new(Mutex::new(Vec::new()));
    let h = heard.clone();
    (Ui::new(move |m| h.lock().unwrap().push(m)), heard)
}

fn statuses(heard: &Arc<Mutex<Vec<ToPage>>>) -> Vec<String> {
    heard.lock().unwrap().iter().filter_map(|m| if let ToPage::Status(s) = m { Some(s.clone()) } else { None }).collect()
}

#[test]
fn a_request_with_defaults_left_out_is_read_as_the_spec_fills_them_in() {
    let mut pk = json!({
        "challenge": "AAEC",
        "extensions": { "prf": {} },
        "hints": ["security-key"],
        "attestationFormats": ["packed"],
        "excludeCredentials": [{ "id": "AQ", "transports": ["usb", "bogus", "hybrid"] }, { "type": null, "id": "Ag" }],
        "authenticatorSelection": { "residentKey": "required" },
        "rp": {},
        "user": { "id": "AQID" },
        "pubKeyCredParams": [],
        "attestation": "enterprise",
    });
    spec_defaults(&mut pk);
    for gone in ["extensions", "hints", "attestationFormats", "attestation"] {
        assert!(pk.get(gone).is_none(), "{gone} stays out: {pk}");
    }
    assert_eq!(pk["excludeCredentials"][0]["type"], json!("public-key"));
    assert_eq!(pk["excludeCredentials"][0]["transports"], json!(["usb", "hybrid"]), "a transport no client knows is dropped");
    assert_eq!(pk["excludeCredentials"][1]["type"], json!("public-key"), "a null type is the default too");
    assert_eq!(pk["authenticatorSelection"]["requireResidentKey"], json!(true), "residentKey required means a resident key is required");
    assert_eq!(pk["authenticatorSelection"]["userVerification"], json!("preferred"));
    assert_eq!(pk["rp"]["name"], json!(""));
    assert_eq!(pk["user"]["name"], json!(""));
    assert_eq!(pk["user"]["displayName"], json!(""));
    assert_eq!(pk["pubKeyCredParams"], json!([{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }]));
}

#[test]
fn a_request_that_names_what_it_wants_keeps_it() {
    let mut pk = json!({
        "authenticatorSelection": { "residentKey": "discouraged", "requireResidentKey": true, "userVerification": "required" },
        "rp": { "name": "Shop" },
        "user": { "id": "AQ", "name": "a", "displayName": "A" },
        "pubKeyCredParams": [{ "type": "public-key", "alg": -8 }],
        "attestation": "direct",
    });
    spec_defaults(&mut pk);
    assert_eq!(pk["authenticatorSelection"]["requireResidentKey"], json!(true));
    assert_eq!(pk["authenticatorSelection"]["userVerification"], json!("required"));
    assert_eq!(pk["rp"]["name"], json!("Shop"));
    assert_eq!(pk["user"]["name"], json!("a"));
    assert_eq!(pk["pubKeyCredParams"], json!([{ "type": "public-key", "alg": -8 }]));
    assert_eq!(pk["attestation"], json!("direct"));
    // Not an object at all: nothing to fill in, nothing breaks.
    let mut not_object = json!("x");
    spec_defaults(&mut not_object);
    assert_eq!(not_object, json!("x"));
}

#[test]
fn a_page_that_asks_for_a_new_passkey_gets_one_for_its_own_site() {
    let ask = create_ask();
    assert_eq!(ask.kind, Kind::Create);
    assert_eq!(ask.create.as_ref().unwrap().rp.id, "example.com");
    assert!(ask.get.is_none());
    let cd: Value = serde_json::from_slice(&ask.client_data()).unwrap();
    assert_eq!(cd["type"], json!("webauthn.create"));
    assert_eq!(cd["origin"], json!("https://login.example.com"));
    assert_eq!(cd["challenge"], json!("AAEC"));
    // The relying party defaults to the page's host when the page names none.
    let mut pk = create_pk();
    pk["rp"] = json!({ "name": "Example" });
    let ask = Ask::from_page("https://login.example.com/", &payload("create", "https://login.example.com", pk)).unwrap();
    assert_eq!(ask.create.unwrap().rp.id, "login.example.com");
}

#[test]
fn a_page_cannot_make_a_passkey_for_another_site() {
    let mut pk = create_pk();
    pk["rp"]["id"] = json!("evil.example");
    let r = Ask::from_page("https://login.example.com/", &payload("create", "https://login.example.com", pk)).unwrap_err();
    assert_eq!(r.name, "SecurityError");
    assert!(r.message.contains("evil.example"), "{}", r.message);
}

#[test]
fn a_request_the_node_cannot_read_is_refused_in_the_pages_own_words() {
    let at = "https://login.example.com";
    let page = "https://login.example.com/";
    let r = Ask::from_page("not a url", &payload("get", at, json!({}))).unwrap_err();
    assert_eq!((r.name, r.message.as_str()), ("SecurityError", "the page has no address the node can read"));
    let r = Ask::from_page("data:text/html,hi", &payload("get", "null", json!({}))).unwrap_err();
    assert_eq!(r.message, "the page has an opaque origin");
    let r = Ask::from_page(page, &payload("get", at, json!("nope"))).unwrap_err();
    assert_eq!(r.name, "NotSupportedError");
    assert!(r.message.contains("publicKey"));
    let r = Ask::from_page(page, &payload("sign", at, json!({ "challenge": "AAEC" }))).unwrap_err();
    assert_eq!((r.name, r.message.as_str()), ("NotSupportedError", "neither get nor create"));
    // A challenge that isn't bytes can't be read as options.
    let r = Ask::from_page(page, &payload("get", at, json!({ "challenge": 7 }))).unwrap_err();
    assert_eq!(r.name, "NotSupportedError");
    assert!(r.message.starts_with("the request's options can't be read"), "{}", r.message);
    let mut bad = create_pk();
    bad["user"] = json!("me");
    let r = Ask::from_page(page, &payload("create", at, bad)).unwrap_err();
    assert!(r.message.starts_with("the request's options can't be read"), "{}", r.message);
}

#[test]
fn a_wait_is_the_pages_own_timeout_held_between_the_least_and_the_most() {
    let wait_for = |timeout: Option<u64>| {
        let mut pk = json!({ "challenge": "AAEC" });
        if let Some(t) = timeout {
            pk["timeout"] = json!(t);
        }
        Ask::from_page("http://localhost:8080/", &payload("get", "http://localhost:8080", pk)).unwrap().wait
    };
    assert_eq!(wait_for(None), Duration::from_secs(180));
    assert_eq!(wait_for(Some(1_000)), Duration::from_secs(120));
    assert_eq!(wait_for(Some(200_000)), Duration::from_secs(200));
    assert_eq!(wait_for(Some(9_000_000)), Duration::from_secs(300));
}

#[test]
fn a_sign_in_with_no_credentials_named_asks_for_any_and_prefers_verification() {
    let ask = Ask::from_page("http://localhost:8080/", &payload("get", "http://localhost:8080", json!({ "challenge": "AAEC", "allowCredentials": null, "userVerification": null }))).unwrap();
    let g = ask.get.unwrap();
    assert!(g.allow_credentials.is_empty());
    assert_eq!(g.rp_id, "localhost");
    assert_eq!(serde_json::to_value(g.user_verification).unwrap(), json!("preferred"));
}

#[test]
fn a_page_without_https_or_on_a_local_address_is_told_so() {
    // A local http page may ask, any other http page may not, and no other scheme is a page at all.
    assert!(secure(&Url::parse("http://127.0.0.1:9/").unwrap()));
    assert!(secure(&Url::parse("http://app.localhost/").unwrap()));
    assert!(!secure(&Url::parse("http://example.com/").unwrap()));
    assert!(!secure(&Url::parse("ftp://example.com/").unwrap()));
    let r = Ask::from_page("https://login.example.com/", &json!({ "kind": "get", "origin": "https://login.example.com", "top": true, "publicKey": null })).unwrap_err();
    assert_eq!(r.name, "NotSupportedError");
}

#[test]
fn the_site_in_the_log_is_the_registrable_one_or_else_the_host() {
    let a = Ask::from_page("https://www.npmjs.com/", &payload("get", "https://www.npmjs.com", json!({ "challenge": "AAEC" }))).unwrap();
    assert_eq!(a.site(), "npmjs.com");
    let local = Ask::from_page("http://localhost:8080/", &payload("get", "http://localhost:8080", json!({ "challenge": "AAEC" }))).unwrap();
    assert_eq!(local.site(), if site_of("localhost").is_empty() { "localhost".to_string() } else { site_of("localhost") });
    let mut bare = local.clone();
    bare.host = String::new();
    assert_eq!(bare.site(), "", "no host, no site");
    bare.get = None;
    assert!(bare.challenge().is_empty(), "a request with nothing asked has no challenge");
}

fn cose_p256(x: &[u8], y: &[u8]) -> serde_cbor_2::Value {
    use serde_cbor_2::Value as C;
    C::Map(BTreeMap::from([
        (C::Integer(1), C::Integer(2)),
        (C::Integer(3), C::Integer(-7)),
        (C::Integer(-1), C::Integer(1)),
        (C::Integer(-2), C::Bytes(x.to_vec())),
        (C::Integer(-3), C::Bytes(y.to_vec())),
    ]))
}

fn cose_ed25519(x: &[u8]) -> serde_cbor_2::Value {
    use serde_cbor_2::Value as C;
    C::Map(BTreeMap::from([(C::Integer(1), C::Integer(1)), (C::Integer(3), C::Integer(-8)), (C::Integer(-1), C::Integer(6)), (C::Integer(-2), C::Bytes(x.to_vec()))]))
}

/// An attestation object around authenticator data with `cose` as its credential public key.
fn attestation(flags: u8, cred_id: &[u8], cose: &serde_cbor_2::Value) -> (Vec<u8>, Vec<u8>) {
    use serde_cbor_2::Value as C;
    let mut auth = vec![7u8; 32];
    auth.push(flags);
    auth.extend_from_slice(&[0, 0, 0, 1]);
    auth.extend_from_slice(&[0u8; 16]);
    auth.extend_from_slice(&(cred_id.len() as u16).to_be_bytes());
    auth.extend_from_slice(cred_id);
    auth.extend(serde_cbor_2::to_vec(cose).unwrap());
    let object = C::Map(BTreeMap::from([(C::Text("fmt".into()), C::Text("none".into())), (C::Text("authData".into()), C::Bytes(auth.clone()))]));
    (serde_cbor_2::to_vec(&object).unwrap(), auth)
}

#[test]
fn a_new_credentials_public_key_is_read_from_its_attestation() {
    let (x, y) = ([1u8; 32], [2u8; 32]);
    let (object, auth) = attestation(0x41, &[9, 9, 9], &cose_p256(&x, &y));
    let (got_auth, key) = read_attestation(&object);
    assert_eq!(got_auth, Some(auth));
    let (der, alg) = key.expect("a P-256 key");
    assert_eq!(alg, -7);
    assert_eq!(der.len(), 91);
    assert_eq!(&der[..26], hex_bytes("3059301306072a8648ce3d020106082a8648ce3d030107034200").as_slice());
    assert_eq!(der[26], 4);
    assert_eq!(&der[27..59], &x);
    assert_eq!(&der[59..], &y);

    let (object, _) = attestation(0x41, &[1], &cose_ed25519(&[5u8; 32]));
    let (_, key) = read_attestation(&object);
    let (der, alg) = key.expect("an Ed25519 key");
    assert_eq!(alg, -8);
    assert_eq!(&der[..12], hex_bytes("302a300506032b6570032100").as_slice());
    assert_eq!(&der[12..], &[5u8; 32]);
}

#[test]
fn an_attestation_without_a_usable_key_still_gives_back_its_authenticator_data() {
    // No attested-data flag, a key of the wrong size, a key of another kind, a key that is cut short: no key, but the data stays.
    for (flags, cose) in [
        (0x01, cose_p256(&[1u8; 32], &[2u8; 32])),
        (0x41, cose_p256(&[1u8; 31], &[2u8; 32])),
        (0x41, cose_p256(&[1u8; 32], &[2u8; 31])),
        (0x41, cose_ed25519(&[5u8; 31])),
        (0x41, serde_cbor_2::Value::Map(BTreeMap::from([(serde_cbor_2::Value::Integer(1), serde_cbor_2::Value::Integer(3)), (serde_cbor_2::Value::Integer(3), serde_cbor_2::Value::Integer(-257))]))),
        (0x41, serde_cbor_2::Value::Text("not a map".into())),
        (0x41, serde_cbor_2::Value::Map(BTreeMap::from([(serde_cbor_2::Value::Integer(1), serde_cbor_2::Value::Integer(2)), (serde_cbor_2::Value::Integer(3), serde_cbor_2::Value::Integer(-7))]))),
    ] {
        let (object, auth) = attestation(flags, &[3], &cose);
        let (got, key) = read_attestation(&object);
        assert_eq!(got, Some(auth));
        assert!(key.is_none(), "flags {flags:#x}: {key:?}");
    }
    // Authenticator data too short to hold a key at all.
    use serde_cbor_2::Value as C;
    let short = serde_cbor_2::to_vec(&C::Map(BTreeMap::from([(C::Text("authData".into()), C::Bytes(vec![0u8; 40]))]))).unwrap();
    assert_eq!(read_attestation(&short), (Some(vec![0u8; 40]), None));
    // An id length that runs off the end.
    let mut auth = vec![0u8; 55];
    auth[32] = 0x40;
    auth[53] = 0xff;
    let off = serde_cbor_2::to_vec(&C::Map(BTreeMap::from([(C::Text("authData".into()), C::Bytes(auth.clone()))]))).unwrap();
    assert_eq!(read_attestation(&off), (Some(auth), None));
}

#[test]
fn an_attestation_that_is_not_one_gives_nothing() {
    use serde_cbor_2::Value as C;
    assert_eq!(read_attestation(b"\xff\xff"), (None, None));
    assert_eq!(read_attestation(&serde_cbor_2::to_vec(&C::Text("x".into())).unwrap()), (None, None));
    let no_data = serde_cbor_2::to_vec(&C::Map(BTreeMap::from([(C::Text("fmt".into()), C::Text("none".into()))]))).unwrap();
    assert_eq!(read_attestation(&no_data), (None, None));
    let wrong = serde_cbor_2::to_vec(&C::Map(BTreeMap::from([(C::Text("authData".into()), C::Text("x".into()))]))).unwrap();
    assert_eq!(read_attestation(&wrong), (None, None));
}

#[test]
fn the_owners_key_makes_a_passkey_the_page_can_read_and_signs_in_with_it() {
    let key = SoftKey::new();
    let (ui, heard) = listening();
    let ask = create_ask();
    let cd = ask.client_data();
    let hash = Sha256::digest(&cd).to_vec();
    let made = key.sign(&ask, hash, &ui, &cancel()).unwrap();
    let credential = answer(&made, &cd);
    assert_eq!(credential["type"], json!("public-key"));
    assert_eq!(credential["authenticatorAttachment"], json!("cross-platform"));
    assert_eq!(credential["response"]["clientDataJSON"], json!(B64.encode(&cd)));
    assert_eq!(credential["response"]["publicKeyAlgorithm"], json!(-7));
    let spki = B64.decode(credential["response"]["publicKey"].as_str().unwrap()).unwrap();
    assert_eq!(spki.len(), 91, "a P-256 SubjectPublicKeyInfo");
    assert!(credential["response"]["authenticatorData"].is_string());
    assert!(credential["response"]["attestationObject"].is_string());
    assert!(credential["response"]["transports"].is_array());
    assert_eq!(statuses(&heard), vec!["Touch your security key".to_string()]);

    // Sign in with it: the page gets what a browser's PublicKeyCredential.toJSON gives.
    let id = credential["id"].as_str().unwrap().to_string();
    let get = Ask::from_page("https://login.example.com/", &payload("get", "https://login.example.com", json!({ "challenge": "AwQF", "rpId": "example.com", "allowCredentials": [{ "type": "public-key", "id": id }] }))).unwrap();
    let cd = get.client_data();
    let signed = key.sign(&get, Sha256::digest(&cd).to_vec(), &ui, &cancel()).unwrap();
    let got = answer(&signed, &cd);
    assert_eq!(got["id"], json!(id));
    assert_eq!(got["rawId"], credential["rawId"]);
    assert_eq!(got["response"]["clientDataJSON"], json!(B64.encode(&cd)));
    assert!(!got["response"]["signature"].as_str().unwrap().is_empty());
    assert!(got["response"]["authenticatorData"].is_string());
    assert!(got["response"].get("userHandle").is_some());
}

#[test]
fn a_key_that_does_not_hold_the_credential_is_a_refusal_not_a_crash() {
    let key = SoftKey::new();
    let (ui, _) = listening();
    let get = Ask::from_page("https://login.example.com/", &payload("get", "https://login.example.com", json!({ "challenge": "AwQF", "rpId": "example.com", "allowCredentials": [{ "type": "public-key", "id": "AQID" }] }))).unwrap();
    let r = match key.sign(&get, vec![0; 32], &ui, &cancel()) {
        Ok(_) => panic!("a key with no such credential signed"),
        Err(r) => r,
    };
    assert_eq!(r.name, "NotAllowedError");
    assert!(r.message.starts_with("the authenticator refused"), "{}", r.message);
}

#[test]
fn a_request_with_nothing_asked_is_not_sent_to_the_key() {
    let mut ask = create_ask();
    ask.create = None;
    let mut t = webauthn_authenticator_rs::softtoken::SoftToken::new(true).unwrap().0;
    let r = match sign_with(&mut t, &ask, vec![0; 32]) {
        Ok(_) => panic!("nothing asked, something signed"),
        Err(r) => r,
    };
    assert_eq!((r.name, r.message.as_str()), ("NotSupportedError", "nothing asked"));
}

#[test]
fn what_the_page_hears_is_in_the_form_its_guard_reads() {
    let refused = Refusal::not_allowed("no");
    assert_eq!(ToPage::Refused(refused).to_json(), json!({ "error": "no", "name": "NotAllowedError" }));
    assert_eq!(ToPage::Status("hi".into()).to_json(), json!({ "status": "hi" }));
    assert_eq!(ToPage::Approved.to_json(), json!({ "approved": true }));
    assert_eq!(ToPage::Done(json!({ "id": "x" })).to_json(), json!({ "credential": { "id": "x" } }));
    assert_eq!(ToPage::Qr { url: "FIDO:/1".into(), svg: "<svg/>".into() }.to_json(), json!({ "qr": "FIDO:/1", "svg": "<svg/>" }));
    assert_eq!(Refusal::security("s").name, "SecurityError");
    assert_eq!(Refusal::not_supported("s").name, "NotSupportedError");
}

#[test]
fn the_qr_the_owner_scans_is_drawn_as_an_svg() {
    let svg = qr_svg("FIDO:/1234567890");
    assert!(svg.contains("<svg"), "{svg}");
    assert_eq!(qr_svg(&"x".repeat(4000)), "", "an address no QR can hold draws nothing");
}

#[test]
fn what_the_owners_authenticator_says_reaches_the_page_as_status_lines() {
    use webauthn_authenticator_rs::types::{CableRequestType, CableState};
    use webauthn_authenticator_rs::ui::UiCallback;
    let (ui, heard) = listening();
    assert_eq!(ui.request_pin(), None, "the node can't take a PIN yet");
    ui.request_touch();
    ui.processing();
    ui.fingerprint_enrollment_feedback(1, None);
    ui.cable_qr_code(CableRequestType::GetAssertion, "FIDO:/abc".into());
    ui.dismiss_qr_code();
    for s in [CableState::ConnectingToTunnelServer, CableState::WaitingForAuthenticatorResponse, CableState::Handshaking] {
        ui.cable_status_update(s);
    }
    assert_eq!(
        statuses(&heard),
        vec!["Touch your security key", "Working…", "Connecting to your phone…", "Connecting to your phone…", "Approve on your phone", "Working…"]
    );
    let all = heard.lock().unwrap();
    assert!(matches!(&all[2], ToPage::Qr { url, svg } if url == "FIDO:/abc" && svg.contains("<svg")));
    assert_eq!(format!("{ui:?}"), "Ui");
}
