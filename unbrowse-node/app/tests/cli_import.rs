//! Imports in CLI mode: the `unbrowse-node` program run from a shell, with no window and no node running, in a home of
//! its own (`UNBROWSE_HOME`). Each kind of import is run as an owner would run it, and each checks the same two things:
//! what was imported is in the vault where the node reads it, and nothing secret is printed or written in the clear.
//!
//! A test build is a dev build, which keeps its root key in a file (`devnet/root.key`), so the vault seals its secrets
//! under that key and these tests never touch the system's keystore.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use base64::Engine;
use unbrowse_core::{FileStore, KeyStore, RootKey, Sealer};

/// A home for one test, with the root key a dev node keeps in a file.
fn home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("unbrowse-cli-import-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("devnet")).unwrap();
    std::fs::write(d.join("devnet/root.key"), "11".repeat(32)).unwrap();
    d
}

/// Runs `unbrowse-node <args>` in `home`, with `stdin` on its input.
fn node(home: &Path, args: &[&str], stdin: Option<&str>, passkeys: bool) -> Output {
    use std::io::Write;
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_unbrowse-node"));
    cmd.args(args).env("UNBROWSE_HOME", home).env("UNBROWSE_PASSKEYS", if passkeys { "1" } else { "0" });
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    if let Some(s) = stdin {
        input.write_all(s.as_bytes()).unwrap();
    }
    drop(input);
    child.wait_with_output().unwrap()
}

fn said(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

/// The sealer the node seals `kind` under, from the root key in `home`.
fn sealer(home: &Path, kind: &str) -> Sealer {
    let keys = FileStore::new(home.join("devnet/root.key"), None);
    assert!(keys.get().unwrap().is_some());
    Sealer::from_root(&RootKey::load(&keys).unwrap(), kind)
}

/// A stored password, opened from `vault.sealed.json` as the node opens it.
fn sealed_secret(home: &Path, slot: &str, site: &str, account: &str) -> Option<String> {
    let all: serde_json::Value = unbrowse_files::VAULT_SEALED.read_at(&home.join("vault.sealed.json")).ok()??;
    let name = format!("{slot}|{site}|{account}");
    let sealed = base64::engine::general_purpose::STANDARD.decode(all[&name].as_str()?).ok()?;
    let plain = sealer(home, "vault").open(format!("unbrowse/vault/v1|{name}").as_bytes(), &sealed).ok()?;
    String::from_utf8(plain.to_vec()).ok()
}

const PASSWORD_1: &str = "correct-horse-battery-1";
const PASSWORD_2: &str = "p,w \"quoted\" 2";
const PASSWORD_3: &str = "bitwarden-only-3";

/// Passwords: a browser's CSV from a file, a password manager's JSON from stdin. The logins land in the vault as
/// references, their passwords sealed (and one-time code key kept), and the shell sees counts and references only.
#[test]
fn passwords_import_from_the_cli() {
    let home = home("passwords");
    let csv = home.join("export.csv");
    std::fs::write(
        &csv,
        format!("name,url,username,password,totp\nGitHub,https://github.com/login,me,{PASSWORD_1},GEZDGNBV\nShop,https://www.shop.example/,me@x.example,\"{}\",\nApp,android://app,me,nope,\n", PASSWORD_2.replace('"', "\"\"")),
    )
    .unwrap();
    let o = node(&home, &["vault", "import", csv.to_str().unwrap()], None, false);
    let out = said(&o);
    assert!(o.status.success(), "{out}");
    assert!(out.contains("imported 2 logins (sealed in the vault under this node's key; 1 with a one-time code key); 0 already in the vault"), "{out}");
    assert!(out.contains("left out 1: no address on the web"), "{out}");
    assert!(out.contains(&format!("delete {} now", csv.display())), "{out}");

    let bitwarden = format!(
        r#"{{"encrypted":false,"items":[{{"type":1,"name":"Docs","login":{{"uris":[{{"uri":"https://docs.example/"}}],"username":"me","password":"{PASSWORD_3}","totp":null}}}},
            {{"type":1,"name":"GitHub again","login":{{"uris":[{{"uri":"https://github.com"}}],"username":"me","password":"other"}}}}]}}"#
    );
    let o = node(&home, &["vault", "import", "-"], Some(&bitwarden), false);
    let out2 = said(&o);
    assert!(o.status.success(), "{out2}");
    assert!(out2.contains("imported 1 logins") && out2.contains("1 already in the vault"), "{out2}");

    let list = said(&node(&home, &["vault", "list"], None, false));
    assert!(list.contains("vault:github.com:me\tstored\tvault:code:github.com:me"), "{list}");
    assert!(list.contains("vault:shop.example:me@x.example\tstored") && list.contains("vault:docs.example:me\tstored"), "{list}");

    for (secret, printed) in [(PASSWORD_1, &out), (PASSWORD_2, &out), (PASSWORD_3, &out2), ("GEZDGNBV", &out), (PASSWORD_1, &list)] {
        assert!(!printed.contains(secret), "a secret reached the shell: {printed}");
    }
    let disk = std::fs::read_to_string(home.join("vault.sealed.json")).unwrap() + &std::fs::read_to_string(home.join("vault.json")).unwrap();
    for secret in [PASSWORD_1, PASSWORD_2, PASSWORD_3, "GEZDGNBV"] {
        assert!(!disk.contains(secret), "a secret is on disk in the clear");
    }
    assert_eq!(sealed_secret(&home, "password", "github.com", "me").as_deref(), Some(PASSWORD_1), "the vault's own password is kept, not the second file's");
    assert_eq!(sealed_secret(&home, "password", "shop.example", "me@x.example").as_deref(), Some(PASSWORD_2));
    assert_eq!(sealed_secret(&home, "password", "docs.example", "me").as_deref(), Some(PASSWORD_3));
    assert_eq!(sealed_secret(&home, "code", "github.com", "me").as_deref(), Some("GEZDGNBV"));

    // A stored login added by hand from a shell goes the same way.
    let o = node(&home, &["vault", "add", "news.example", "me", "--stored"], Some("typed-in-secret\n"), false);
    assert!(o.status.success() && !said(&o).contains("typed-in-secret"), "{}", said(&o));
    assert_eq!(sealed_secret(&home, "password", "news.example", "me").as_deref(), Some("typed-in-secret"));

    let o = node(&home, &["vault", "import", "-"], Some("title,notes\nx,y\n"), false);
    assert!(!o.status.success() && said(&o).contains("isn't a password export"), "{}", said(&o));
    let _ = std::fs::remove_dir_all(&home);
}

const SID: &str = "sid-value-9f8e7d";
const CART: &str = "cart-value-1a2b";
const TRACKER: &str = "tracker-value-xyz";

/// Cookies: a cookies.txt names the host's cookies beside another site's. Only the host's become its session: the jar
/// calls send, and the node's browser profile for the host, which a later browse opens signed in. The shell sees a
/// count.
#[test]
fn cookies_import_from_the_cli() {
    let home = home("cookies");
    let file = home.join("cookies.txt");
    std::fs::write(
        &file,
        format!(
            "# Netscape HTTP Cookie File\n#HttpOnly_.shop.example\tTRUE\t/\tTRUE\t4102444800\tsid\t{SID}\nwww.shop.example\tFALSE\t/\tTRUE\t0\tcart\t{CART}\n.tracker.example\tTRUE\t/\tFALSE\t4102444800\ttrack\t{TRACKER}\n.shop.example\tTRUE\t/\tFALSE\t1000\told\tgone\n"
        ),
    )
    .unwrap();
    let o = node(&home, &["session", "import", "www.shop.example", "--from", file.to_str().unwrap()], None, false);
    let out = said(&o);
    assert!(o.status.success(), "{out}");
    assert!(out.contains("kept 2 cookies for www.shop.example: calls send them"), "{out}");
    assert!(out.contains(&format!("delete {} now", file.display())), "{out}");
    for v in [SID, CART, TRACKER] {
        assert!(!out.contains(v), "a cookie value reached the shell: {out}");
    }

    let jar: serde_json::Map<String, serde_json::Value> = unbrowse_files::JAR.read_at(&home.join("jars/www.shop.example.json")).unwrap().unwrap();
    assert_eq!(jar.get("sid").and_then(|v| v.as_str()), Some(SID));
    assert_eq!(jar.get("cart").and_then(|v| v.as_str()), Some(CART));
    assert_eq!(jar.len(), 2, "another site's cookie and an expired one are left out: {jar:?}");
    assert!(!home.join("jars/tracker.example.json").exists());

    let list = said(&node(&home, &["session", "list"], None, false));
    assert!(list.contains("www.shop.example\t2 cookies") && !list.contains(SID), "{list}");

    match agent_browser_core::cdp::chrome::find_chrome() {
        Some(_) => {
            assert!(out.contains("the node's browser opens the site signed in (1 profile)"), "{out}");
            let held = profile_cookies(&home.join("profiles/www.shop.example"));
            let find = |n: &str| held.iter().find(|c| c["name"] == n).cloned();
            let sid = find("sid").expect("the session cookie is in the site's browser profile");
            assert_eq!((sid["value"].as_str(), sid["domain"].as_str(), sid["httpOnly"].as_bool()), (Some(SID), Some(".shop.example"), Some(true)));
            let cart = find("cart").expect("the host's own cookie is in the profile");
            assert_eq!(cart["domain"].as_str(), Some("www.shop.example"), "it stays host-only");
            assert!(find("track").is_none() && find("old").is_none(), "nothing else reaches the profile: {held:?}");
        }
        None => eprintln!("no Chrome here: the browser profile half of this test didn't run"),
    }

    // A Cookie header on stdin is the host's alone; a file with nothing for the host is refused and keeps nothing.
    let o = node(&home, &["session", "import", "https://app.other.example/inbox", "--from", "-"], Some("Cookie: a=1; b=2\n"), false);
    assert!(o.status.success() && said(&o).contains("kept 2 cookies for app.other.example"), "{}", said(&o));
    let o = node(&home, &["session", "import", "nothing.example", "--from", file.to_str().unwrap()], None, false);
    assert!(!o.status.success() && said(&o).contains("no live cookie for nothing.example"), "{}", said(&o));
    assert!(!home.join("jars/nothing.example.json").exists());
    let o = node(&home, &["session", "import", "../jars", "--from", "-"], Some("a=1"), false);
    assert!(!o.status.success() && said(&o).contains("not a host"), "{}", said(&o));

    let o = node(&home, &["session", "forget", "app.other.example"], None, false);
    assert!(o.status.success() && !home.join("jars/app.other.example.json").exists(), "{}", said(&o));
    let _ = std::fs::remove_dir_all(&home);
}

/// The cookies a browser profile holds, read by opening it headless as the node's browser opens it.
fn profile_cookies(profile: &Path) -> Vec<serde_json::Value> {
    let options = agent_browser_core::cdp::chrome::LaunchOptions { headless: true, profile: Some(profile.display().to_string()), ..Default::default() };
    let mut chrome = agent_browser_core::cdp::chrome::launch_chrome(&options).expect("Chrome opens the profile");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let held = rt.block_on(async {
        let cdp = agent_browser_core::cdp::client::CdpClient::connect(&chrome.ws_url).await.unwrap();
        let r = cdp.send_command("Storage.getCookies", None, None).await.unwrap();
        let _ = cdp.send_command("Browser.close", None, None).await;
        r["cookies"].as_array().cloned().unwrap_or_default()
    });
    chrome.wait_or_kill(std::time::Duration::from_secs(10));
    held
}

/// A P-256 key made for these tests (PKCS#8, base64url), and a P-384 one the browser's authenticator can't sign with.
const P256_PKCS8: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQImqJmqdSbqyOcnAN-Ifwmczrin9qbfTxx-8Mo7AuGahRANCAAQG3gg1HpE2n-V5c6rNd6N1BgO0JVotAdG62MzBn2jNDyw5pXpVQ-_0NtIUtFS60OEkQ-LM6LNLrsk4UxnYMd3o";
const P384_PKCS8: &str = "MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDB4v35HV7wxW6ZEEp1ahHGe7Xtwo7UfmBP13l2WQqdSaPCBLhkZUiT7JPgP-wlQsOChZANiAASGejDzEZotO-aWDFAZSzKPhqnLhDOsOe2Se_iWOHRv1Di0ZlqxEiJRIdlPGyguLyDnbVPOFx6T91GNCFeu2t8lIKCGApAhmzRqD6rE-hUC4l-xUdUJfgnrcbRH_kJUt7E";
const CREDENTIAL: &str = "q83vASNFZ4mrze8BI0VniQ";

/// Passkeys: a Bitwarden JSON export holds a login and two passkeys, one on a curve the authenticator can't use.
/// While passkeys are off, nothing of a passkey is kept; on, the usable one is sealed in the vault and listed by site
/// and short name, the other is counted, and no credential id or key reaches the shell or the disk in the clear.
#[test]
fn passkeys_import_from_the_cli() {
    let home = home("passkeys");
    let passkey = |id: &str, key: &str, curve: &str| {
        serde_json::json!({ "credentialId": format!("b64.{id}"), "keyType": "public-key", "keyAlgorithm": "ECDSA", "keyCurve": curve,
            "keyValue": key, "rpId": "shop.example", "userHandle": "dXNlci0x", "userName": "me@x.example", "counter": "3", "discoverable": "true" })
    };
    let export = serde_json::json!({ "encrypted": false, "items": [
        { "type": 1, "name": "Shop", "login": { "uris": [{ "uri": "https://shop.example/" }], "username": "me@x.example", "password": PASSWORD_1,
            "fido2Credentials": [passkey(CREDENTIAL, P256_PKCS8, "P-256")] } },
        { "type": 1, "name": "Old key", "login": { "uris": [{ "uri": "https://shop.example/" }], "username": "other", "password": null,
            "fido2Credentials": [passkey("AAECAw", P384_PKCS8, "P-384")] } } ] })
    .to_string();
    let file = home.join("bitwarden.json");
    std::fs::write(&file, &export).unwrap();

    // Off: the passkey import refuses, and the vault import takes the login and says why it left the passkeys.
    let o = node(&home, &["passkey", "import", file.to_str().unwrap()], None, false);
    assert!(!o.status.success() && said(&o).contains("passkeys are off"), "{}", said(&o));
    let o = node(&home, &["vault", "import", file.to_str().unwrap()], None, false);
    let out = said(&o);
    assert!(o.status.success(), "{out}");
    assert!(out.contains("imported 1 logins") && out.contains("left out 2 passkeys: passkeys are off"), "{out}");
    assert!(unbrowse_files::PASSKEYS.read_at::<Vec<serde_json::Value>>(&home.join("passkeys.json")).unwrap().unwrap_or_default().is_empty());

    // On.
    let o = node(&home, &["passkey", "import", file.to_str().unwrap()], None, true);
    let out = said(&o);
    assert!(o.status.success(), "{out}");
    assert!(out.contains("imported 1 passkeys, sealed in the vault; 0 already in the vault"), "{out}");
    assert!(out.contains("on shop.example for me@x.example"), "{out}");
    assert!(out.contains("left out 1: not a P-256 key"), "{out}");
    let list = said(&node(&home, &["passkey", "list"], None, true));
    assert!(list.contains("\tshop.example\tme@x.example\tmanual\tnever used"), "an import is the owner's own: {list}");

    let std_key = base64::engine::general_purpose::STANDARD.encode(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(P256_PKCS8).unwrap());
    let disk = std::fs::read_to_string(home.join("passkeys.json")).unwrap();
    for secret in [CREDENTIAL, P256_PKCS8, &std_key[..40], "q83vASNFZ4mrze8BI0VniQ=="] {
        assert!(!out.contains(secret) && !list.contains(secret), "a credential reached the shell");
        assert!(!disk.contains(secret), "a credential is on disk in the clear");
    }

    // The same file again: the login and the passkey are both already kept.
    let o = node(&home, &["vault", "import", file.to_str().unwrap()], None, true);
    let out = said(&o);
    assert!(out.contains("1 already in the vault") && out.contains("imported 0 passkeys, sealed in the vault; 1 already in the vault"), "{out}");

    // A file with no passkey in it says plainly where passkeys can and can't come from.
    let o = node(&home, &["passkey", "import", "-"], Some("{\"items\":[]}"), true);
    assert!(!o.status.success() && said(&o).contains("iCloud Keychain, Google Password Manager, Windows Hello and security keys never let one out"), "{}", said(&o));
    let _ = std::fs::remove_dir_all(&home);
}
