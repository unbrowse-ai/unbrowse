//! More tests of the updater (`update.rs`): the paths its first test module leaves out. Registries are servers on
//! 127.0.0.1 that the test starts; nothing here reaches the real npm.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use std::io::Write;
use std::sync::Arc;

/// Tests that set `UNBROWSE_REGISTRY` or read the status run one at a time.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner())
}

const NOW: u64 = 1_800_000_000;
const DAY: u64 = 86_400;

fn test_key(seed: u8) -> (SigningKey, String) {
    let k = SigningKey::from_bytes(&[seed; 32]);
    let public = hex::encode(k.verifying_key().to_bytes());
    (k, public)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("unbrowse-update-cov-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn archive(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
    let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    for (path, data, kind) in entries {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(*kind);
        h.set_size(data.len() as u64);
        h.set_mode(if kind.is_dir() { 0o755 } else { 0o644 });
        h.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
        h.set_cksum();
        b.append(&h, *data).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap()
}

fn tgz(files: &[(&str, &[u8])]) -> Vec<u8> {
    let entries: Vec<_> = files.iter().map(|(p, d)| (*p, *d, tar::EntryType::Regular)).collect();
    archive(&entries)
}

/// A tarball that is one header claiming `size` bytes for `path`, and no data: what a hostile package says it holds.
fn claims(path: &str, size: u64) -> Vec<u8> {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Regular);
    h.set_size(size);
    h.set_mode(0o644);
    h.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
    h.set_cksum();
    let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    z.write_all(h.as_bytes()).unwrap();
    z.finish().unwrap()
}

fn sign(signed: &Value, keys: &[&SigningKey]) -> Vec<u8> {
    let bytes = canonical(signed);
    let sigs: Vec<Value> = keys
        .iter()
        .map(|k| json!({ "keyid": hex::encode(k.verifying_key().to_bytes()), "sig": hex::encode(k.sign(&bytes).to_bytes()) }))
        .collect();
    serde_json::to_vec_pretty(&json!({ "signed": signed, "signatures": sigs })).unwrap()
}

fn role(keys: &[&str], threshold: usize) -> Value {
    json!({ "keys": keys, "threshold": threshold })
}

fn targets_json(version: u64, stable: &str, releases: Value) -> Value {
    json!({ "_type": "targets", "version": version, "expires": NOW + 365 * DAY, "min_version": "13.0.0", "releases": releases,
        "channels": { "stable": stable, "canary": null }, "canary_share": 0, "halt": null })
}

fn timestamp_json(version: u64, expires: u64, targets: &[u8]) -> Value {
    let t: Value = serde_json::from_slice(targets).unwrap();
    json!({ "_type": "timestamp", "version": version, "expires": expires,
        "targets": { "version": t["signed"]["version"], "sha256": hex::encode(Sha256::digest(targets)) } })
}

type Files = BTreeMap<String, Vec<u8>>;

fn metadata(targets: &Value, k: &SigningKey) -> Files {
    let t = sign(targets, &[k]);
    let ts = sign(&timestamp_json(1, NOW + DAY, &t), &[k]);
    [("targets.json".to_string(), t), ("timestamp.json".to_string(), ts)].into()
}

fn reader(files: &Files) -> impl Fn(&str) -> Result<Option<Vec<u8>>, String> + '_ {
    move |p| Ok(files.get(p).cloned())
}

fn metadata_package(files: &Files) -> Vec<u8> {
    let paths: Vec<(String, Vec<u8>)> = files.iter().map(|(p, b)| (format!("package/{p}"), b.clone())).collect();
    let files: Vec<(&str, &[u8])> = paths.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
    tgz(&files)
}

fn stable(now: u64) -> Place {
    Place { chosen: None, seed: Some("0xabc".into()), now }
}

/// A registry on 127.0.0.1 serving `packages` (name, version, tarball) as npm does; `latest` is the last version listed.
fn serve(packages: Vec<(&'static str, &'static str, Vec<u8>)>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let b = base.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_string();
            let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
            let mut body = Vec::new();
            if let Some(i) = path.strip_prefix("/t/") {
                body = packages[i.parse::<usize>().unwrap()].2.clone();
            } else {
                for (i, (name, version, tgz)) in packages.iter().enumerate() {
                    if path == format!("/{}/latest", escaped(name)) {
                        body = format!(r#"{{"version":"{version}"}}"#).into_bytes();
                    } else if path == format!("/{}/{version}", escaped(name)) {
                        body = format!(r#"{{"dist":{{"tarball":"{b}/t/{i}","integrity":"{}"}}}}"#, integrity(tgz)).into_bytes();
                    }
                }
            }
            let status = if body.is_empty() { "404 Not Found" } else { "200 OK" };
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = s.write_all(&body);
        }
    });
    base
}

/// A site on 127.0.0.1 that answers every request with `body` and counts the requests it hears.
fn counting_site(body: Vec<u8>) -> (String, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let heard = Arc::new(AtomicUsize::new(0));
    let h = heard.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            h.fetch_add(1, Ordering::SeqCst);
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = s.write_all(&body);
        }
    });
    (base, heard)
}

fn bare_node() -> Arc<crate::Node> {
    Arc::new(crate::Node {
        keys: Box::new(unbrowse_core::MemoryStore::default()),
        identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: "0x1234abcd".into(), created: true }))),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: crate::chain::Chain::default(),
        chain_error: Mutex::new(None),
        events: crate::api::Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    })
}

fn root_with(version: u64, expires: Value, roles: Value) -> Value {
    json!({ "_type": "root", "version": version, "expires": expires, "roles": roles })
}

#[test]
fn metadata_of_another_role_is_not_read_as_the_one_asked_for() {
    let (k, public) = test_key(1);
    let root = root_with(
        1,
        json!(NOW + DAY),
        json!({ "root": role(&[&public], 1), "targets": role(&[&public], 1), "timestamp": role(&[&public], 1) }),
    );
    let file = sign(&root, &[&k]);
    let err = read_signed::<Timestamp>(&file, "timestamp").map(|_| ()).unwrap_err();
    assert!(err.contains("another role's"), "{err}");
    assert!(read_signed::<Root>(&file, "root").is_ok());
}

#[test]
fn no_release_is_made_while_the_offline_keys_are_unset_and_key_lists_are_judged_one_by_one() {
    assert!(!release_offline_keys_valid());
    let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
    assert!(role_keys_valid(&[&a, &b], 2));
    assert!(!role_keys_valid(&[&a], 2), "too few keys");
    assert!(!role_keys_valid(&[&a, &a], 2), "a key twice");
    assert!(!role_keys_valid(&[&a, RELEASE_KEY], 2), "the online release key is never an offline key");
    assert!(!role_keys_valid(&[&a, &"A".repeat(64)], 2), "hex in upper case isn't the form keys are kept in");
    assert!(!role_keys_valid(&[&a, "abc"], 2), "a short key");
    assert!(roles_disjoint(&[&a, &b], &[&c]));
    assert!(!roles_disjoint(&[&a, &b], &[&c, &b]), "a key in two roles");
}

#[test]
fn a_node_with_offline_root_keys_starts_from_the_offline_root_and_not_the_online_key() {
    let (a, b) = ("a".repeat(64), "b".repeat(64));
    let online = "c".repeat(64);
    let root = builtin_root_with_roles(&online, &[&a, &b]);
    assert_eq!(root.version, 2);
    assert_eq!(root.roles.root.keys, vec![a.clone(), b.clone()]);
    assert_eq!(root.roles.root.threshold, 2);
    assert!(!root.roles.root.keys.contains(&online));
    assert!(root.expires < u64::MAX, "an offline root expires");
    // None given: the online key is every role, as the first root says.
    let first = builtin_root_with_roles(&online, &[]);
    assert_eq!(first.version, 1);
    assert_eq!(first.roles.targets.keys, vec![online]);
}

#[test]
fn a_successor_root_must_expire_and_keep_targets_and_timestamp_keys_apart() {
    let (release, release_pub) = test_key(1);
    let (r1, r1p) = test_key(2);
    let (r2, r2p) = test_key(3);
    let (_, tkp) = test_key(4);
    let (_, skp) = test_key(5);
    let trusted = builtin_root_of(&release_pub);
    let signed_by_all = |root: &Value| sign(root, &[&release, &r1, &r2]);

    let never_expires = root_with(
        2,
        json!(u64::MAX),
        json!({ "root": role(&[&r1p, &r2p], 2), "targets": role(&[&tkp], 1), "timestamp": role(&[&skp], 1) }),
    );
    let err = next_root(&trusted, &signed_by_all(&never_expires)).unwrap_err();
    assert!(err.contains("must expire"), "{err}");

    let shared = root_with(
        2,
        json!(NOW + DAY),
        json!({ "root": role(&[&r1p, &r2p], 2), "targets": role(&[&tkp], 1), "timestamp": role(&[&tkp], 1) }),
    );
    let err = next_root(&trusted, &signed_by_all(&shared)).unwrap_err();
    assert!(err.contains("separate keys"), "{err}");

    let fine = root_with(
        2,
        json!(NOW + DAY),
        json!({ "root": role(&[&r1p, &r2p], 2), "targets": role(&[&tkp], 1), "timestamp": role(&[&skp], 1) }),
    );
    assert_eq!(next_root(&trusted, &signed_by_all(&fine)).unwrap().version, 2);
}

#[test]
fn a_root_that_has_expired_ends_the_check() {
    let (release, release_pub) = test_key(1);
    let (r1, r1p) = test_key(2);
    let (r2, r2p) = test_key(3);
    let (tk, tkp) = test_key(4);
    let builtin = builtin_root_of(&release_pub);
    let home = scratch("root-expired");
    let t = targets_json(1, "13.2.0", json!({}));
    let mut files = metadata(&t, &tk);
    let root2 = root_with(
        2,
        json!(NOW + 365 * DAY),
        json!({ "root": role(&[&r1p, &r2p], 2), "targets": role(&[&tkp], 1), "timestamp": role(&[&tkp], 1) }),
    );
    // Targets and timestamp share a key in this root, which a successor may not do: use separate ones.
    let (sk, skp) = test_key(5);
    let root2 = {
        let mut r = root2;
        r["roles"]["timestamp"] = role(&[&skp], 1);
        r
    };
    files.insert("root/2.root.json".into(), sign(&root2, &[&release, &r1, &r2]));
    let ts = sign(&timestamp_json(1, NOW + DAY, &files["targets.json"]), &[&sk]);
    files.insert("timestamp.json".into(), ts);
    check_metadata(&builtin, &reader(&files), &home, NOW).expect("current while the root is");
    let err = check_metadata(&builtin, &reader(&files), &home, NOW + 400 * DAY).unwrap_err();
    assert!(err.contains("root 2 has expired"), "{err}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_timestamp_naming_other_targets_than_the_ones_given_is_refused() {
    let (k, public) = test_key(1);
    let builtin = builtin_root_of(&public);
    let home = scratch("ts-version");
    let t = sign(&targets_json(1, "13.2.0", json!({})), &[&k]);
    let mut ts = timestamp_json(1, NOW + DAY, &t);
    ts["targets"]["version"] = json!(2);
    let files: Files = [("targets.json".to_string(), t), ("timestamp.json".to_string(), sign(&ts, &[&k]))].into();
    let err = check_metadata(&builtin, &reader(&files), &home, NOW).unwrap_err();
    assert!(err.contains("names targets 2, but these are 1"), "{err}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_registry_that_has_no_metadata_package_is_an_error_and_nothing_is_unpacked() {
    let home = scratch("no-metadata");
    let (_, public) = test_key(1);
    let reg = serve(vec![]);
    let err = check(&reg, &builtin_root_of(&public), "13.1.0", "linux-x64", &home.join("versions"), &stable(NOW)).map(|_| ()).unwrap_err();
    assert!(err.contains("404"), "{err}");
    assert!(!home.join("versions").join("current").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_channel_naming_a_release_the_metadata_does_not_hold_is_an_error() {
    let home = scratch("no-release");
    let (k, public) = test_key(1);
    let files = metadata(&targets_json(1, "13.2.0", json!({})), &k);
    let reg = serve(vec![(METADATA_PACKAGE, "1.0.1", metadata_package(&files))]);
    let err = check(&reg, &builtin_root_of(&public), "13.1.0", "linux-x64", &home.join("versions"), &stable(NOW)).map(|_| ()).unwrap_err();
    assert!(err.contains("names 13.2.0 for stable but has no release of it"), "{err}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_package_with_no_node_in_it_is_refused_and_not_made_current() {
    let home = scratch("no-node");
    let versions = home.join("versions");
    let (k, public) = test_key(1);
    let pkg = tgz(&[("package/README", b"nothing to run")]);
    let entry = json!({ "platforms": { "linux-x64": { "name": "@unbrowse/linux-x64", "integrity": integrity(&pkg) } } });
    let files = metadata(&targets_json(1, "13.2.0", json!({ "13.2.0": entry })), &k);
    let reg = serve(vec![
        (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
        ("@unbrowse/linux-x64", "13.2.0", pkg),
    ]);
    let err = check(&reg, &builtin_root_of(&public), "13.1.0", "linux-x64", &versions, &stable(NOW)).map(|_| ()).unwrap_err();
    assert!(err.contains("@unbrowse/linux-x64 13.2.0 has no node in it"), "{err}");
    assert!(!versions.join("13.2.0").exists());
    assert!(!versions.join("current").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_release_unpacked_and_waiting_on_a_restart_is_not_unpacked_over_again() {
    let home = scratch("waiting");
    let versions = home.join("versions");
    let (k, public) = test_key(1);
    let pkg = tgz(&[("package/bin/unbrowse-node", b"the new node")]);
    let entry = json!({ "platforms": { "linux-x64": { "name": "@unbrowse/linux-x64", "integrity": integrity(&pkg) } } });
    let files = metadata(&targets_json(1, "13.2.0", json!({ "13.2.0": entry })), &k);
    let reg = serve(vec![
        (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
        ("@unbrowse/linux-x64", "13.2.0", pkg),
    ]);
    let builtin = builtin_root_of(&public);
    let (v, dir) = check(&reg, &builtin, "13.1.0", "linux-x64", &versions, &stable(NOW)).unwrap().unpacked.expect("fetched");
    assert_eq!(v, "13.2.0");
    // Something the second check would delete if it unpacked the release afresh.
    std::fs::write(dir.join("kept-by-the-first-unpack"), b"x").unwrap();
    let again = check(&reg, &builtin, "13.1.0", "linux-x64", &versions, &stable(NOW)).unwrap();
    assert_eq!(again.unpacked.as_ref().map(|(v, _)| v.as_str()), Some("13.2.0"));
    assert_eq!(again.want.as_deref(), Some("13.2.0"));
    assert!(dir.join("kept-by-the-first-unpack").exists(), "the second check unpacked over the first");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_answer_longer_than_the_most_asked_for_is_refused() {
    let (site, _) = counting_site(vec![b'x'; 20]);
    let client = reqwest::blocking::Client::new();
    assert_eq!(get(&client, &site, 20).unwrap().len(), 20);
    let err = get(&client, &site, 10).unwrap_err();
    assert!(err.contains("larger than any release"), "{err}");
}

#[test]
fn a_version_the_registry_does_not_know_is_not_fetched() {
    let reg = serve(vec![]);
    let client = reqwest::blocking::Client::new();
    let err = tarball(&client, &reg, "@unbrowse/linux-x64", "13.2.0", None).unwrap_err();
    assert!(err.contains("404"), "{err}");
}

#[test]
fn a_package_that_claims_more_than_any_release_holds_is_refused_before_it_is_read() {
    let too_big = claims("package/targets.json", 3 << 30);
    let err = find_file(&too_big, "targets.json").unwrap_err();
    assert!(err.contains("larger than any release"), "{err}");
    let home = scratch("unpack-big");
    let err = unpack(&too_big, &home).unwrap_err();
    assert!(err.contains("larger than any release"), "{err}");
    assert!(!home.join("targets.json").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_metadata_file_larger_than_any_metadata_is_refused() {
    let big = tgz(&[("package/targets.json", &vec![b'a'; MAX_MANIFEST as usize + 1])]);
    let err = find_file(&big, "targets.json").unwrap_err();
    assert!(err.contains("larger than any metadata"), "{err}");
    let fits = tgz(&[("package/targets.json", &vec![b'a'; MAX_MANIFEST as usize])]);
    assert_eq!(find_file(&fits, "targets.json").unwrap().unwrap().len(), MAX_MANIFEST as usize);
    assert_eq!(find_file(&fits, "timestamp.json").unwrap(), None);
}

#[test]
fn only_what_is_inside_package_is_unpacked() {
    let home = scratch("unpack-skip");
    let into = home.join("unpacked");
    let tgz = archive(&[
        ("elsewhere/file", b"not in the package", tar::EntryType::Regular),
        ("package/", b"", tar::EntryType::Directory),
        ("package/bin/", b"", tar::EntryType::Directory),
        ("package/bin/node", b"the node", tar::EntryType::Regular),
    ]);
    unpack(&tgz, &into).unwrap();
    assert_eq!(std::fs::read(into.join("bin/node")).unwrap(), b"the node");
    assert!(!into.join("elsewhere").exists());
    assert!(!into.join("file").exists());
    assert!(!home.join("elsewhere").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_failed_note_of_how_a_release_is_doing_never_stops_the_node() {
    let dir = scratch("notes-fail");
    let trial = Trial { version: "13.2.0".into(), starts: 1, reached: Vec::new() };
    std::fs::write(dir.join(TRIAL), serde_json::to_string(&trial).unwrap()).unwrap();
    std::fs::write(dir.join(CURRENT), "13.2.0").unwrap();
    // A folder where the half-written copy goes: nothing can be written there.
    for name in ["trial.part", "gave-up.part", "proved.part"] {
        std::fs::create_dir(dir.join(name)).unwrap();
    }

    // The start goes through, though its count can't be kept.
    assert!(about_to_start(&dir, "13.2.0"));
    // How far it got can't be kept: the trial stays as it was.
    note_reached(&dir, "13.2.0", "it listened");
    let kept: Trial = serde_json::from_str(&word_in(&dir, TRIAL).unwrap()).unwrap();
    assert!(kept.reached.is_empty());
    // Staying up can't be kept: no `proved`, and the trial is over all the same.
    prove(&dir, "13.2.0");
    assert!(word_in(&dir, PROVED).is_none());
    assert!(word_in(&dir, TRIAL).is_none());
    // Giving up can't be kept in `gave-up`: it still stops running the release.
    give_up(&dir, "13.2.0");
    assert!(word_in(&dir, GAVE_UP).is_none());
    assert!(word_in(&dir, CURRENT).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// `answers` on a script just written: a fork in another test thread can hold the file open a moment longer
/// (ETXTBSY), so that one error is tried again.
#[cfg(unix)]
fn answers_of(exe: &Path) -> Result<(), String> {
    for _ in 0..50 {
        match answers(exe) {
            Err(e) if e.contains("busy") => std::thread::sleep(Duration::from_millis(100)),
            r => return r,
        }
    }
    answers(exe)
}

#[cfg(unix)]
#[test]
fn a_release_that_starts_and_never_answers_is_stopped_and_refused() {
    let dir = scratch("answers-silent");
    let exe = script(&dir, "silent", "exec sleep 300");
    let started = std::time::Instant::now();
    let err = answers_of(&exe).unwrap_err();
    assert!(err.contains("didn't answer"), "{err}");
    assert!(started.elapsed() >= ANSWERS_WITHIN, "it gave up before its time");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_release_that_answers_help_is_one_that_starts() {
    let dir = scratch("answers-ok");
    assert!(answers_of(&script(&dir, "good", "exit 0")).is_ok());
    let err = answers_of(&script(&dir, "bad", "exit 3")).unwrap_err();
    assert!(err.contains("ended with"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_restart_into_a_release_that_does_not_start_leaves_the_node_where_it_is_and_gives_it_up() {
    let _one = one_at_a_time();
    let home = store::scratch_home("u-restart-missing");
    let versions = home.join("versions");
    std::fs::create_dir_all(&versions).unwrap();
    std::fs::write(versions.join(CURRENT), "99.0.0").unwrap();
    let node = bare_node();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    restart_when_idle(&node, rt.handle(), home.join("no-such-program"), "99.0.0".into());
    assert_eq!(word_in(&versions, GAVE_UP).as_deref(), Some("99.0.0"));
    assert!(word_in(&versions, CURRENT).is_none(), "the release it failed to start is no longer the next start's");
}

#[cfg(unix)]
#[test]
fn a_restart_into_a_release_that_used_up_its_starts_stays_put() {
    let _one = one_at_a_time();
    let home = store::scratch_home("u-restart-starts");
    let versions = home.join("versions");
    std::fs::create_dir_all(&versions).unwrap();
    std::fs::write(versions.join(CURRENT), "99.0.0").unwrap();
    let trial = Trial { version: "99.0.0".into(), starts: STARTS_ALLOWED, reached: vec!["it listened on port 7788".into()] };
    std::fs::write(versions.join(TRIAL), serde_json::to_string(&trial).unwrap()).unwrap();
    let exe = script(&home, "unbrowse-node", "exit 0");
    let node = bare_node();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    // The release answers `--help` (the script is tried first, so a fresh one that is still busy doesn't count): it is
    // the starts it has had that stop the restart.
    answers_of(&exe).unwrap();
    restart_when_idle(&node, rt.handle(), exe.clone(), "99.0.0".into());
    assert_eq!(word_in(&versions, GAVE_UP).as_deref(), Some("99.0.0"));
    assert!(word_in(&versions, TRIAL).is_none());
}

#[test]
fn a_nodes_place_in_a_rollout_is_its_owners_channel_and_its_identity() {
    let _home = store::scratch_home("u-place");
    let mut settings = store::load_settings();
    settings.update_channel = Some("canary".into());
    store::save_settings(&settings).unwrap();
    let node = bare_node();

    let p = place(None);
    assert_eq!(p.chosen, Some(Channel::Canary));
    assert_eq!(p.seed, None, "no node, no place in the draw");
    let p = place(Some(&node));
    assert_eq!(p.seed.as_deref(), Some("0x1234abcd"));

    *node.identity.write().unwrap() = None;
    assert_eq!(place(Some(&node)).seed, None, "the key isn't open yet");
    *node.identity.write().unwrap() = Some(Err("the keychain refused".into()));
    assert_eq!(place(Some(&node)).seed, None, "no identity, no draw");

    settings.update_channel = Some("nonsense".into());
    store::save_settings(&settings).unwrap();
    assert_eq!(place(None).chosen, None, "a channel nobody knows is no choice");
}

#[test]
fn a_build_from_source_never_updates_itself_nor_fetches_a_release_browser() {
    if released() {
        return;
    }
    let node = bare_node();
    let err = update_now(&node).map(|_| ()).unwrap_err();
    assert!(err.contains("built from source"), "{err}");
    let err = browser_package().unwrap_err();
    assert!(err.contains("no release holds its browser"), "{err}");
}

#[test]
fn a_build_from_source_starts_no_checks_when_the_updater_runs() {
    if released() || platform().is_none() {
        return;
    }
    let _one = one_at_a_time();
    let _home = store::scratch_home("u-run");
    let (site, heard) = counting_site(b"{}".to_vec());
    std::env::set_var("UNBROWSE_REGISTRY", &site);
    let node = bare_node();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async { run(node) });
    std::thread::sleep(Duration::from_millis(700));
    std::env::remove_var("UNBROWSE_REGISTRY");
    assert_eq!(heard.load(Ordering::SeqCst), 0, "a node that doesn't update itself asked the registry");
}

#[test]
fn a_browser_beside_the_node_or_the_release_already_held_is_kept_as_it_is() {
    let _one = one_at_a_time();
    let home = store::scratch_home("u-carry");
    let dir = home.join("versions/13.2.0");
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(dir.join("bin/unbrowse-node"), b"the new node").unwrap();
    let nowhere = "http://127.0.0.1:1";
    let targets: Targets = serde_json::from_value(targets_json(1, "13.2.0", json!({ "13.2.0": { "platforms": {} } }))).unwrap();

    // The release carries its browser beside its node: nothing is fetched or copied.
    let beside = dir.join("bin").join(crate::browsers::program_file());
    std::fs::write(&beside, b"its own browser").unwrap();
    carry_browser(nowhere, &targets, "13.2.0", "linux-x64", &dir);
    assert!(!crate::browsers::addon_program().exists());
    std::fs::remove_file(&beside).unwrap();

    // The add-on is already this release's: left alone.
    let src = home.join(crate::browsers::program_file());
    std::fs::write(&src, b"13.2.0's browser").unwrap();
    crate::browsers::put_program(&src, "13.2.0").unwrap();
    carry_browser(nowhere, &targets, "13.2.0", "linux-x64", &dir);
    assert_eq!(std::fs::read(crate::browsers::addon_program()).unwrap(), b"13.2.0's browser");
    assert_eq!(crate::browsers::addon_version().as_deref(), Some("13.2.0"));
}

#[test]
fn after_the_transition_a_release_the_metadata_has_no_browser_for_gets_none() {
    let (_, targets_a) = test_key(2);
    let (_, targets_b) = test_key(3);
    let (_, timestamp) = test_key(4);
    let (ta, tb, ts) = (test_key(2).0, test_key(3).0, test_key(4).0);
    let offline = builtin_root_with_roles_and_roles(&["a".repeat(64).as_str(), "b".repeat(64).as_str()], &[&targets_a, &targets_b], &[&timestamp]);
    let home = scratch("offline-no-browser");
    // A release the metadata names with no browser for this machine.
    let t = sign(&targets_json(1, "13.2.0", json!({ "13.2.0": { "platforms": {} } })), &[&ta, &tb]);
    let stamp = sign(&timestamp_json(1, NOW + DAY, &t), &[&ts]);
    let files: Files = [("targets.json".to_string(), t), ("timestamp.json".to_string(), stamp)].into();
    let reg = serve(vec![(METADATA_PACKAGE, "1.0.1", metadata_package(&files))]);
    let err = browser_tarball(&reg, &offline, RELEASE_KEY, "13.2.0", "linux-x64", &home, NOW).unwrap_err();
    assert!(err.contains("requires browser metadata signed by its targets role"), "{err}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_manifest_of_another_release_than_the_one_asked_for_gives_no_browser() {
    let home = scratch("manifest-other");
    let (k, public) = test_key(1);
    let m = serde_json::to_vec(&json!({ "version": "13.0.0", "min_version": "13.0.0", "platforms": {}, "browsers": {} })).unwrap();
    let sig = hex::encode(k.sign(&m).to_bytes());
    let pkg = tgz(&[("package/manifest.json", &m), ("package/manifest.sig", sig.as_bytes())]);
    let reg = serve(vec![("unbrowse", "13.1.0", pkg)]);
    let err = browser_tarball(&reg, &builtin_root_of(&public), &public, "13.1.0", "linux-x64", &home, NOW).unwrap_err();
    assert!(err.contains("carries the manifest of 13.0.0"), "{err}");
    let _ = std::fs::remove_dir_all(&home);
}
