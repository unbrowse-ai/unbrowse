//! Passkey paths that need no browser: export reading edges, import refusals, guard bookkeeping, the DevTools address.

use super::*;

const P256_PKCS8: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQImqJmqdSbqyOcnAN-Ifwmczrin9qbfTxx-8Mo7AuGahRANCAAQG3gg1HpE2n-V5c6rNd6N1BgO0JVotAdG62MzBn2jNDyw5pXpVQ-_0NtIUtFS60OEkQ-LM6LNLrsk4UxnYMd3o";
const P384_PKCS8: &str = "MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDB4v35HV7wxW6ZEEp1ahHGe7Xtwo7UfmBP13l2WQqdSaPCBLhkZUiT7JPgP-wlQsOChZANiAASGejDzEZotO-aWDFAZSzKPhqnLhDOsOe2Se_iWOHRv1Di0ZlqxEiJRIdlPGyguLyDnbVPOFx6T91GNCFeu2t8lIKCGApAhmzRqD6rE-hUC4l-xUdUJfgnrcbRH_kJUt7E";
const P256_SEC1_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIECJqiZqnUm6sjnJwDfiH8JnM64p/am308cfvDKOwLhmoAoGCCqGSM49\nAwEHoUQDQgAEBt4INR6RNp/leXOqzXejdQYDtCVaLQHRutjMwZ9ozQ8sOaV6VUPv\n9DbSFLRUutDhJEPizOizS67JOFMZ2DHd6A==\n-----END EC PRIVATE KEY-----\n";

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("unbrowse-passkey-cov-{name}-{}-{}", std::process::id(), now_ms()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn root() -> unbrowse_core::MemoryStore {
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    keys
}

/// A Bitwarden export with one passkey per `(rp, credential id, key)`.
fn bitwarden(each: &[(&str, &str, &str)]) -> String {
    let creds: Vec<Value> = each
        .iter()
        .map(|(rp, id, key)| {
            json!({ "credentialId": id, "keyType": "public-key", "keyAlgorithm": "ECDSA", "keyCurve": "P-256", "keyValue": key, "rpId": rp,
                "userHandle": "dXNlci0x", "userName": "me", "counter": "1", "discoverable": "true" })
        })
        .collect();
    json!({ "encrypted": false, "items": [{ "type": 1, "name": "Demo", "login": { "fido2Credentials": creds } }] }).to_string()
}

fn guard(site: &str, at: &str, armed: Option<(u64, How)>) -> Arc<Guard> {
    Arc::new(Guard { site: site.into(), at: at.into(), armed: Mutex::new(armed), alive: AtomicBool::new(true), up: AtomicBool::new(true), bare: false })
}

fn forget(g: &Arc<Guard>) {
    g.alive.store(false, Ordering::SeqCst);
    GUARDS.locked().retain(|x| !Arc::ptr_eq(x, g));
}

/// A server on 127.0.0.1 that answers every request as Chrome answers `/json/version`.
fn devtools_site() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        for mut conn in listener.incoming().flatten() {
            let mut buf = [0u8; 2048];
            let _ = conn.read(&mut buf);
            let body = format!(r#"{{"webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/browser/abc"}}"#);
            let _ = write!(conn, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    port
}

#[test]
fn every_way_a_passkey_came_into_the_vault_has_its_own_name() {
    assert_eq!([How::Auto.name(), How::Manual.name(), How::Phone.name()], ["auto", "manual", "phone"]);
}

#[test]
fn an_import_is_refused_while_passkeys_are_off_and_keeps_nothing() {
    let (dir, keys) = (temp("import-off"), root());
    let off = store::Settings { passkeys: false, ..Default::default() };
    store::write_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS, &off).unwrap();
    let text = bitwarden(&[("shop.example", "b64.AQIDBA", P256_PKCS8)]);
    assert_eq!(import_in(&dir, &sealer(&keys).unwrap(), &text, "You").unwrap_err(), OFF);
    assert!(list_in(&dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_encrypted_export_is_refused_and_counts_no_passkey() {
    let (dir, keys) = (temp("import-encrypted"), root());
    let text = r#"{"encrypted":true,"encKeyValidation_DO_NOT_EDIT":"2.x","data":"2.y"}"#;
    let said = import_in(&dir, &sealer(&keys).unwrap(), text, "You").unwrap_err();
    assert!(said.contains("encrypted"), "{said}");
    assert_eq!(count_in(text), 0);
    // Its fields would read as a passkey, were it not said to be encrypted.
    let sealed = bitwarden(&[("shop.example", "b64.AQIDBA", P256_PKCS8)]).replace(r#""encrypted":false"#, r#""encrypted":true"#);
    assert_eq!(count_in(&sealed), 0);
    assert!(read_export(&sealed).0.is_empty());
    assert!(import_in(&dir, &sealer(&keys).unwrap(), &sealed, "You").unwrap_err().contains("encrypted"));
    assert_eq!(count_in(r#"{"passwordProtected":true,"items":[]}"#), 0);
    assert!(list_in(&dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_with_no_passkey_in_it_imports_nothing() {
    let (dir, keys) = (temp("import-none"), root());
    let said = import_in(&dir, &sealer(&keys).unwrap(), r#"{"items":[{"login":{"username":"me"}}]}"#, "You").unwrap_err();
    assert_eq!(said, NONE_IN_FILE);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_passkey_listed_twice_in_one_export_is_read_once() {
    let text = bitwarden(&[("shop.example", "b64.AQIDBA", P256_PKCS8), ("shop.example", "b64.AQIDBA", P256_PKCS8), ("shop.example", "b64.BQYHCA", P256_PKCS8)]);
    let (found, skipped) = read_export(&text);
    assert_eq!(found.len(), 2, "the same credential id is one passkey");
    assert!(skipped.is_empty());
    assert_eq!(count_in(&text), 2);
}

#[test]
fn passkeys_left_out_for_one_reason_are_counted_under_that_reason() {
    let text = bitwarden(&[("a.example", "b64.AQIDBA", P384_PKCS8), ("b.example", "b64.BQYHCA", P384_PKCS8), ("c.example", "b64.CQoLDA", P384_PKCS8)]);
    let (found, skipped) = read_export(&text);
    assert!(found.is_empty());
    assert_eq!(skipped, [(UNSUPPORTED.to_string(), 3)]);
    assert_eq!(count_in(&text), 3, "left out or not, the file holds three");
}

#[test]
fn passkeys_on_a_site_the_owner_said_never_to_are_skipped_together_not_kept() {
    let (dir, keys) = (temp("import-never"), root());
    let sealer = sealer(&keys).unwrap();
    set_never_in(&dir, "shop.example", true).unwrap();
    let text = bitwarden(&[("shop.example", "b64.AQIDBA", P256_PKCS8), ("login.shop.example", "b64.BQYHCA", P256_PKCS8), ("fine.example", "b64.CQoLDA", P256_PKCS8)]);
    let done = import_in(&dir, &sealer, &text, "You").unwrap();
    assert_eq!(done.added.len(), 1);
    assert_eq!(done.added[0].site, "fine.example");
    assert_eq!(done.skipped.len(), 1, "both never-sites are one reason: {:?}", done.skipped);
    assert_eq!(done.skipped[0].1, 2);
    assert!(done.skipped[0].0.contains("said never"));
    assert_eq!(list_in(&dir).len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_passkey_for_no_site_is_left_out_not_kept() {
    for rp in ["intranet", "", "https:///"] {
        let (found, skipped) = read_export(&bitwarden(&[(rp, "b64.AQIDBA", P256_PKCS8)]));
        assert!(found.is_empty(), "{rp:?}");
        assert_eq!(skipped, [("it names no site".to_string(), 1)], "{rp:?}");
    }
    let (found, _) = read_export(&bitwarden(&[("localhost", "b64.AQIDBA", P256_PKCS8)]));
    assert_eq!(found.len(), 1, "localhost is a site");
}

#[test]
fn a_key_or_id_that_does_not_read_is_left_out_and_said() {
    for (id, key) in [("b64.AQIDBA", ""), ("", P256_PKCS8), ("b64.", P256_PKCS8), ("!!!", P256_PKCS8)] {
        let (found, skipped) = read_export(&bitwarden(&[("shop.example", id, key)]));
        assert!(found.is_empty(), "{id:?} {key:?}");
        assert_eq!(skipped, [("its key or id doesn't read".to_string(), 1)], "{id:?} {key:?}");
    }
}

#[test]
fn a_credential_id_is_read_as_b64_dot_a_uuid_or_plain_base64() {
    assert_eq!(&**bitwarden_id("b64.AQIDBA").unwrap(), &[1, 2, 3, 4]);
    assert_eq!(&**bitwarden_id("AQIDBA").unwrap(), &[1, 2, 3, 4], "plain base64url");
    assert_eq!(&**bitwarden_id("AQID+A==").unwrap(), &[1, 2, 3, 0xf8], "plain base64, padded");
    let uuid = bitwarden_id("0f8fad5b-d9cb-469f-a165-70867728950e").unwrap();
    assert_eq!(uuid.len(), 16);
    // Thirty-two characters that are not hex are base64, not a UUID.
    let not_hex = "ghijklmnopqrstuvwxyzghijklmnopqr";
    assert_eq!(bitwarden_id(not_hex).map(|b| b.len()), Some(24));
    assert!(bitwarden_id("").is_none());
}

#[test]
fn a_pem_that_is_not_a_private_key_reads_as_none() {
    let body = STD.encode(&*b64(P256_PKCS8).unwrap());
    assert!(pem(&format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n")).is_none());
    assert!(pem(&format!("-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----\n")).is_some());
    assert!(pem("no armor at all").is_none());
    // A SEC1 key that names no P-256 curve cannot be wrapped for one.
    let other = STD.encode([0x30u8, 0x03, 0x02, 0x01, 0x01]);
    assert!(pem(&format!("-----BEGIN EC PRIVATE KEY-----\n{other}\n-----END EC PRIVATE KEY-----\n")).is_none());
}

#[test]
fn a_der_length_is_written_in_the_form_its_size_needs() {
    assert_eq!(der_len(0x30, 5), [0x30, 5]);
    assert_eq!(der_len(0x30, 0x7f), [0x30, 0x7f]);
    assert_eq!(der_len(0x04, 0x80), [0x04, 0x81, 0x80]);
    assert_eq!(der_len(0x04, 0xff), [0x04, 0x81, 0xff]);
    assert_eq!(der_len(0x30, 0x0102), [0x30, 0x82, 0x01, 0x02]);
}

#[test]
fn a_sec1_key_longer_than_a_byte_can_count_is_wrapped_with_a_two_byte_length() {
    let der = b64(P256_SEC1_PEM.lines().filter(|l| !l.starts_with("-----")).collect::<String>().as_str()).unwrap();
    let mut long = der.to_vec();
    long.extend(std::iter::repeat_n(0u8, 300));
    let text = format!("-----BEGIN EC PRIVATE KEY-----\n{}\n-----END EC PRIVATE KEY-----\n", STD.encode(&long));
    let wrapped = pem(&text).unwrap();
    assert_eq!(wrapped[..2], [0x30, 0x82]);
    assert_eq!(((wrapped[2] as usize) << 8) | wrapped[3] as usize, wrapped.len() - 4, "the outer length counts what follows it");
    assert!(p256(&wrapped));
}

#[test]
fn a_guard_whose_enrolment_ran_out_holds_no_script_back() {
    let site = "expired-enrol.example";
    let past = now_ms().saturating_sub(60_000);
    let (expired, unarmed) = (guard(site, "node", Some((past, How::Manual))), guard(site, "node", None));
    GUARDS.locked().extend([expired.clone(), unarmed.clone()]);
    let home = temp("scripts-expired");
    assert!(!holds_scripts_in(&home, site), "nothing is armed past its time, and the vault holds nothing");
    let live = guard(site, "node", Some((now_ms() + 60_000, How::Manual)));
    GUARDS.locked().push(live.clone());
    assert!(holds_scripts_in(&home, site), "an enrolment still waiting holds the scripts back");
    for g in [&expired, &unarmed, &live] {
        forget(g);
    }
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_guard_already_watching_is_the_one_a_second_caller_gets() {
    let (dir, keys) = (temp("watch-again"), root());
    let site = "watched-already.example";
    let g = guard(site, "node", None);
    GUARDS.locked().push(g.clone());
    let again = watch(site, &Browser::Node, None, sealer(&keys).unwrap(), dir.clone()).expect("the watcher is up");
    assert!(Arc::ptr_eq(&g, &again), "no second authenticator is started");
    assert_eq!(GUARDS.locked().iter().filter(|x| x.site == site).count(), 1);
    g.up.store(false, Ordering::SeqCst);
    g.alive.store(false, Ordering::SeqCst);
    assert!(once_up(g.clone()).err().unwrap().contains("didn't answer"), "a watcher that went away is not waited for");
    forget(&g);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_owner_enrolling_on_a_site_they_said_never_to_is_refused_through_the_public_door() {
    let home = store::scratch_home("passkey-public-enrol");
    let keys = root();
    set_never_in(&home, "example.com", true).unwrap();
    let nowhere = Browser::At("ws://127.0.0.1:9/devtools/browser/none".into());
    assert!(enrol("example.com", &nowhere, 5, &keys).unwrap_err().contains("the owner said never"));
    assert!(use_in("example.com", &nowhere, &keys).unwrap_err().contains("the owner said never"));
    assert!(signed_in(SignIn::Owner, "example.com", &keys).is_none());
    // Where the owner allows it but the node's browser is not running, a sign-in arms nothing either.
    assert!(signed_in(SignIn::Owner, "down.example", &keys).is_none());
    assert!(signed_in(SignIn::Agent, "down.example", &keys).is_none());
    assert!(guard_of("down.example", "node").is_none());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_site_with_no_passkey_in_the_vault_is_not_held() {
    let (dir, keys) = (temp("hold-none"), root());
    let nowhere = Browser::At("ws://127.0.0.1:9/devtools/browser/none".into());
    let said = hold("example.com", &nowhere, &keys, dir.clone()).unwrap_err();
    assert_eq!(said, "the vault holds no passkey for example.com: enrol one first");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_nodes_own_browser_is_not_watched_while_it_is_not_running() {
    let (dir, keys) = (temp("hold-node-down"), root());
    let sealer = sealer(&keys).unwrap();
    let credential = json!({ "credentialId": STD.encode(b"id-0123456789abcdef"), "isResidentCredential": true, "rpId": "down.example",
        "privateKey": STD.encode(b"key-0123456789abcdef-key-0123456789abcdef"), "userHandle": STD.encode(b"u"), "signCount": 0, "userName": "me" });
    keep(&dir, &sealer, &Secret::from_cdp(&credential).unwrap(), How::Manual).unwrap();
    let said = hold("down.example", &Browser::Node, &keys, dir.clone()).unwrap_err();
    assert_eq!(said, "open down.example in the node's browser and sign in first: its browser isn't running");
    assert!(enrol_in("down.example", &Browser::Node, 5, &keys, dir.clone()).unwrap_err().contains("its browser isn't running"));
    assert!(guard_of("down.example", "node").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_devtools_address_is_found_for_a_port_a_host_and_port_or_a_ws_url() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let port = devtools_site();
    let want = format!("ws://127.0.0.1:{port}/devtools/browser/abc");
    assert_eq!(rt.block_on(devtools(&port.to_string())).unwrap(), want, "a bare port");
    assert_eq!(rt.block_on(devtools(&format!("127.0.0.1:{port}"))).unwrap(), want, "host and port");
    assert_eq!(rt.block_on(devtools(&format!(" http://localhost:{port} "))).unwrap(), want.replace("127.0.0.1", "localhost"), "an http address");
    assert_eq!(rt.block_on(devtools("ws://127.0.0.1:1/devtools/browser/x")).unwrap(), "ws://127.0.0.1:1/devtools/browser/x", "a ws address stands as given");
}

#[test]
fn a_devtools_address_that_is_neither_http_nor_ws_or_names_no_port_is_refused() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for bad in ["ftp://127.0.0.1:9", "http://127.0.0.1", "http://", "ws://[::1"] {
        let said = rt.block_on(devtools(bad)).unwrap_err();
        assert!(said.contains("isn't a DevTools address on this machine"), "{bad}: {said}");
    }
    let said = rt.block_on(devtools("http://example.com:9222")).unwrap_err();
    assert!(said.contains("another machine"), "{said}");
}
