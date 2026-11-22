//! Signing the owner in with no window: one flow over the node's owner commands, which the shell's `sign-in` runs and
//! any other front end can (a script, an onboarding). The window sends the same owner commands itself (`link_start`,
//! `link_status`, `link_message`, `link_wallet`), so a sign-in started here and one started there end the same way: a
//! link the node checked and sealed (`link`). Nothing here draws on a screen, and nothing here keeps state: the node
//! holds the sign-in under way, and this only asks it and says what happened.
//!
//! Three ways in:
//! - **The website** (email or Google, `Way::Website`): the node opens its sign-in page in this machine's browser when
//!   it can; with no browser the page's address is said, to open on any device, and this waits on what the owner signs.
//! - **A wallet signed elsewhere** (`Way::Message`, then `Way::Signed`): the message to sign and its nonce, then the
//!   signature brought back.
//! - **A wallet key the owner keeps in a file** (`Way::Key`, `key_from_file`): signed in this process, so the sign-in
//!   needs no other device. The key never reaches the node: it is sent only the signature, as from any wallet. The key
//!   signs only the node's own sign-in message for this node, rebuilt here (`link::message`): a node that asked it to
//!   sign anything else is refused before anything is signed.
//!
//! Linking a wallet the owner names still waits on the owner's yes (`commands::asks_the_owner`): a dialog where the
//! machine has a screen, else the owner passphrase typed on a terminal (`unbrowse-node confirm`). Joining the network
//! never needed a sign-in (spec §86); this only adds the owner's wallet.

use std::path::Path;
use std::time::{Duration, Instant};

use alloy::signers::local::PrivateKeySigner;
use serde_json::{json, Value};

/// The node's owner commands, however this process reaches them: the running node's port from a shell
/// (`owner_call_within`), or the node itself in a test.
pub trait Owner {
    /// `cmd` with `args`, waiting up to `wait` for the answer.
    fn call(&self, cmd: &str, args: Value, wait: Duration) -> Result<Value, String>;
}

impl<F: Fn(&str, Value, Duration) -> Result<Value, String>> Owner for F {
    fn call(&self, cmd: &str, args: Value, wait: Duration) -> Result<Value, String> {
        self(cmd, args, wait)
    }
}

/// How the owner signs in.
pub enum Way {
    /// On the website, with email or Google.
    Website,
    /// With a wallet of the owner's own that signs elsewhere: the message it signs, and nothing linked yet.
    Message { owner: String },
    /// What that wallet signed of the message, under the nonce the node drew.
    Signed { owner: String, nonce: String, signature: String },
    /// With a wallet key this process holds, which signs here.
    Key(PrivateKeySigner),
}

/// What the sign-in is doing, said as it happens, for the caller to show.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// The website's sign-in page, and whether the node opened it in this machine's browser.
    Page { url: String, opened: bool },
    /// The node waits on what the owner signs on the page.
    Waiting,
    /// The node asks the owner's yes before it links `owner`: in its dialog, or on a terminal with no screen.
    Asking { owner: String },
}

/// How a sign-in ended, when it didn't fail.
#[derive(Debug, PartialEq)]
pub enum Done {
    /// `owner` is linked to this node.
    Linked { owner: String },
    /// The message `owner`'s wallet signs, and its nonce: `Way::Signed` with the signature links it.
    ToSign { owner: String, message: String, nonce: String },
}

/// How long each part of a sign-in waits.
pub struct Waits {
    /// The owner, on the website's page.
    pub page: Duration,
    /// Between two looks at whether the page was signed.
    pub every: Duration,
    /// Any command that asks no one.
    pub call: Duration,
    /// The node's link of a wallet, which waits on the owner's yes as long as the node asks it.
    pub yes: Duration,
}

impl Default for Waits {
    fn default() -> Self {
        Waits {
            page: Duration::from_secs(15 * 60),
            every: Duration::from_secs(2),
            call: Duration::from_secs(60),
            yes: Duration::from_secs(crate::owner_dialog::WAIT_SECS + 30),
        }
    }
}

/// Signs the owner in `way`, through `node`, telling `say` each step. Ok only once the node says the wallet is linked
/// (or, for `Way::Message`, with what to sign); a refusal, a wrong signature, a no from the owner or a wait that ran
/// out is the node's own reason, and nothing is linked.
pub fn sign_in(node: &dyn Owner, way: Way, waits: &Waits, say: &mut dyn FnMut(Step)) -> Result<Done, String> {
    match way {
        Way::Website => website(node, waits, say),
        Way::Message { owner } => {
            let (owner, message, nonce) = drawn(node, &owner, waits)?;
            Ok(Done::ToSign { owner, message, nonce })
        }
        Way::Signed { owner, nonce, signature } => link(node, &owner, &nonce, &signature, waits, say),
        Way::Key(key) => {
            use alloy::signers::SignerSync;
            let me = text(&node.call("identity", json!({}), waits.call)?, "address")?;
            let (owner, message, nonce) = drawn(node, &key.address().to_checksum(None), waits)?;
            if message != crate::link::message(&me, &owner, &nonce) {
                return Err("the node asked the wallet to sign something other than its sign-in for this node, so nothing was signed".into());
            }
            let signature = key.sign_message_sync(message.as_bytes()).map_err(|e| format!("the wallet key couldn't sign: {e}"))?;
            link(node, &owner, &nonce, &format!("0x{}", hex::encode(signature.as_bytes())), waits, say)
        }
    }
}

/// The website's sign-in: the page opened (or its address said), then the node asked until the owner has signed there,
/// the node says why not, or the wait runs out.
fn website(node: &dyn Owner, waits: &Waits, say: &mut dyn FnMut(Step)) -> Result<Done, String> {
    let started = node.call("link_start", json!({}), waits.call)?;
    say(Step::Page { url: text(&started, "url")?, opened: started["opened"] == true });
    say(Step::Waiting);
    let since = Instant::now();
    while since.elapsed() < waits.page {
        std::thread::sleep(waits.every);
        let st = node.call("link_status", json!({}), waits.call)?;
        if let Some(e) = st["error"].as_str() {
            return Err(e.to_string());
        }
        if let Some(owner) = finished(&st) {
            return Ok(Done::Linked { owner: owner.to_string() });
        }
        if st["waiting"] != true {
            return Err("the sign-in ended with no wallet linked (another one may have taken over): run `unbrowse-node sign-in` again".into());
        }
    }
    let minutes = waits.page.as_secs().div_ceil(60).max(1);
    let minutes = if minutes == 1 { "1 minute".to_string() } else { format!("{minutes} minutes") };
    Err(format!("the sign-in wasn't finished in {minutes}; run `unbrowse-node sign-in` again"))
}

/// The wallet a website sign-in under way has linked, once it has: until it ends, `owner` is the link from before.
pub fn finished(status: &Value) -> Option<&str> {
    (status["waiting"] != true).then(|| status["owner"].as_str()).flatten()
}

/// The node's sign-in message for `owner`'s wallet: the wallet as the node writes it, the message, and the nonce.
fn drawn(node: &dyn Owner, owner: &str, waits: &Waits) -> Result<(String, String, String), String> {
    let m = node.call("link_message", json!({ "owner": owner }), waits.call)?;
    Ok((m["owner"].as_str().unwrap_or(owner).to_string(), text(&m, "message")?, text(&m, "nonce")?))
}

/// Links `owner` with what its wallet signed, once the node has the owner's yes. Ok only for that wallet.
fn link(node: &dyn Owner, owner: &str, nonce: &str, signature: &str, waits: &Waits, say: &mut dyn FnMut(Step)) -> Result<Done, String> {
    say(Step::Asking { owner: owner.to_string() });
    let st = node.call("link_wallet", json!({ "owner": owner, "nonce": nonce, "signature": signature }), waits.yes)?;
    match st["owner"].as_str() {
        Some(linked) if linked.eq_ignore_ascii_case(owner) => Ok(Done::Linked { owner: linked.to_string() }),
        Some(other) => Err(format!("the node linked {other}, not {owner}")),
        None => Err("the node answered with no wallet linked".into()),
    }
}

fn text(v: &Value, k: &str) -> Result<String, String> {
    v[k].as_str().map(str::to_string).ok_or_else(|| format!("the node's answer has no {k}"))
}

/// A wallet key kept in a file the owner made: one line, the private key in hex (`0x` optional). The file must be the
/// owner's alone (no one else may read it), as ssh asks of a key, and what it holds is never said back.
pub fn key_from_file(path: &Path) -> Result<PrivateKeySigner, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?.permissions().mode();
        if mode & 0o077 != 0 {
            return Err(format!("{} can be read by others: make it yours alone (`chmod 600 {}`) before it signs anything", path.display(), path.display()));
        }
    }
    let held = zeroize::Zeroizing::new(std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?);
    key_from(&held).map_err(|e| format!("{}: {e}", path.display()))
}

/// A wallet key from its hex text (`0x` optional, space around it ignored). The text is never said back.
pub fn key_from(text: &str) -> Result<PrivateKeySigner, String> {
    let hex = text.trim();
    let hex = hex.strip_prefix("0x").unwrap_or(hex);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("that isn't a wallet key: one line of 64 hex characters (a private key, 0x optional)".into());
    }
    hex.parse::<PrivateKeySigner>().map_err(|_| "that isn't a wallet key this node can sign with".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{link, owner_dialog, store};
    use alloy::signers::SignerSync;
    use std::cell::RefCell;
    use std::sync::Arc;

    /// Waits a test can sit out.
    fn quick() -> Waits {
        Waits { page: Duration::from_millis(300), every: Duration::from_millis(10), call: Duration::from_secs(5), yes: Duration::from_secs(5) }
    }

    /// A node of the test's own with no window, in a scratch home, and a way to its owner commands as the shell's
    /// `owner_call` reaches the running node's: every command through the same `owner` door, its dialog included.
    fn headless(name: &str) -> (tokio::runtime::Runtime, Arc<crate::Node>) {
        store::scratch_home(name);
        let node = crate::testchain::node(name);
        link::set_node(&crate::identity(&node).unwrap().address);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        (rt, node)
    }

    fn door<'a>(rt: &'a tokio::runtime::Runtime, node: &'a Arc<crate::Node>, sent: &'a RefCell<Vec<String>>) -> impl Fn(&str, Value, Duration) -> Result<Value, String> + 'a {
        move |cmd, args, _| {
            sent.borrow_mut().push(cmd.to_string());
            rt.block_on(crate::owner(node, cmd, args)).map_err(|e| match e {
                crate::OwnerError::Failed(m) => m,
                crate::OwnerError::Unknown => format!("{cmd} is unknown"),
            })
        }
    }

    #[test]
    fn a_wallet_key_signs_the_owner_in_end_to_end_with_no_window() {
        let _one = link::SIGN_IN_TESTS.blocking_lock();
        let (rt, node) = headless("login-key");
        let sent = RefCell::new(Vec::new());
        let key = PrivateKeySigner::random();
        let wallet = key.address().to_checksum(None);
        owner_dialog::answer_in_test(Some(true));
        let said = RefCell::new(Vec::new());
        let done = sign_in(&door(&rt, &node, &sent), Way::Key(key), &quick(), &mut |s| said.borrow_mut().push(s)).unwrap();
        assert_eq!(done, Done::Linked { owner: wallet.clone() });
        assert_eq!(*said.borrow(), [Step::Asking { owner: wallet.clone() }]);
        assert_eq!(*sent.borrow(), ["identity", "link_message", "link_wallet"]);
        let kept = link::signed_in(&node).expect("the node keeps the link");
        assert_eq!(kept.owner, wallet);
        assert!(link::is_sealed(node.key().unwrap(), &kept), "sealed by the node, as a link from the window is");
        assert!(owner_dialog::asked_in_test().iter().any(|q| q.contains(&wallet)), "the owner was asked about this wallet");
        let st = rt.block_on(crate::owner(&node, "link_status", json!({}))).ok().unwrap();
        assert_eq!(st["owner"], json!(wallet), "the window's own status reads the same link");
    }

    #[test]
    fn a_wallet_signed_elsewhere_signs_in_in_two_steps() {
        let _one = link::SIGN_IN_TESTS.blocking_lock();
        let (rt, node) = headless("login-two-steps");
        let sent = RefCell::new(Vec::new());
        let key = PrivateKeySigner::random();
        let wallet = key.address().to_checksum(None);
        owner_dialog::answer_in_test(Some(true));
        let door = door(&rt, &node, &sent);
        let Done::ToSign { owner, message, nonce } = sign_in(&door, Way::Message { owner: wallet.to_lowercase() }, &quick(), &mut |_| {}).unwrap() else { panic!("a message to sign") };
        assert_eq!(owner, wallet, "the wallet as the node writes it");
        assert!(link::signed_in(&node).is_none(), "nothing linked before it is signed");
        let signature = format!("0x{}", hex::encode(key.sign_message_sync(message.as_bytes()).unwrap().as_bytes()));
        assert_eq!(sign_in(&door, Way::Signed { owner, nonce, signature }, &quick(), &mut |_| {}).unwrap(), Done::Linked { owner: wallet.clone() });
        assert_eq!(link::signed_in(&node).unwrap().owner, wallet);
    }

    #[test]
    fn a_failed_headless_sign_in_links_nothing_and_says_why() {
        let _one = link::SIGN_IN_TESTS.blocking_lock();
        let (rt, node) = headless("login-fails");
        let sent = RefCell::new(Vec::new());
        let door = door(&rt, &node, &sent);

        // The owner says no.
        owner_dialog::answer_in_test(Some(false));
        let e = sign_in(&door, Way::Key(PrivateKeySigner::random()), &quick(), &mut |_| {}).unwrap_err();
        assert!(e.contains("said no"), "{e}");
        // No screen, and no owner passphrase to type on a terminal.
        owner_dialog::answer_in_test(None);
        let e = sign_in(&door, Way::Key(PrivateKeySigner::random()), &quick(), &mut |_| {}).unwrap_err();
        assert!(e.contains("passphrase"), "{e}");
        // A signature from another wallet than the one named, with the owner's yes.
        owner_dialog::answer_in_test(Some(true));
        let (named, thief) = (PrivateKeySigner::random(), PrivateKeySigner::random());
        let Done::ToSign { owner, message, nonce } = sign_in(&door, Way::Message { owner: named.address().to_string() }, &quick(), &mut |_| {}).unwrap() else { panic!() };
        let signature = format!("0x{}", hex::encode(thief.sign_message_sync(message.as_bytes()).unwrap().as_bytes()));
        assert!(sign_in(&door, Way::Signed { owner: owner.clone(), nonce: nonce.clone(), signature: signature.clone() }, &quick(), &mut |_| {}).is_err(), "another wallet's signature");
        // A nonce the node never drew.
        let right = format!("0x{}", hex::encode(named.sign_message_sync(message.as_bytes()).unwrap().as_bytes()));
        assert!(sign_in(&door, Way::Signed { owner, nonce: "00".into(), signature: right }, &quick(), &mut |_| {}).is_err(), "a nonce the node never drew");
        assert!(link::signed_in(&node).is_none(), "no wallet was linked");
        assert!(rt.block_on(crate::owner(&node, "link_status", json!({}))).ok().unwrap()["owner"].is_null());
    }

    /// A node that stands in for the running one, answering `link_message` with `message` and recording what it's sent.
    struct Asked {
        sent: RefCell<Vec<(String, Value)>>,
        answer: Box<dyn Fn(&str, usize) -> Result<Value, String>>,
    }

    impl Owner for Asked {
        fn call(&self, cmd: &str, args: Value, _: Duration) -> Result<Value, String> {
            let n = self.sent.borrow().iter().filter(|(c, _)| c == cmd).count();
            self.sent.borrow_mut().push((cmd.to_string(), args));
            (self.answer)(cmd, n)
        }
    }

    #[test]
    fn a_wallet_key_never_signs_what_isnt_this_nodes_sign_in() {
        let key = PrivateKeySigner::random();
        let wallet = key.address().to_checksum(None);
        let node = Asked {
            sent: RefCell::new(Vec::new()),
            answer: Box::new(move |cmd, _| match cmd {
                "identity" => Ok(json!({ "address": "0x1111111111111111111111111111111111111111" })),
                // A message for another node: what a site that wants the wallet's signature for itself would send.
                "link_message" => Ok(json!({ "owner": wallet, "nonce": "ab", "message": link::message("0x2222222222222222222222222222222222222222", &wallet, "ab") })),
                _ => Ok(json!({ "owner": wallet })),
            }),
        };
        let e = sign_in(&node, Way::Key(key), &quick(), &mut |_| {}).unwrap_err();
        assert!(e.contains("nothing was signed"), "{e}");
        assert!(!node.sent.borrow().iter().any(|(c, _)| c == "link_wallet"), "no signature was sent");
    }

    #[test]
    fn the_website_sign_in_ends_when_the_node_says_the_wallet_is_linked() {
        let node = Asked {
            sent: RefCell::new(Vec::new()),
            answer: Box::new(|cmd, n| match cmd {
                "link_start" => Ok(json!({ "url": "https://unbrowse.ai/link?n=1", "opened": false })),
                // The wallet linked before stays in `owner` while the new page is open.
                "link_status" if n < 2 => Ok(json!({ "owner": "0xold", "waiting": true, "error": null })),
                "link_status" => Ok(json!({ "owner": "0xnew", "waiting": false, "error": null })),
                _ => Err("unexpected".into()),
            }),
        };
        let said = RefCell::new(Vec::new());
        // The page is signed on the third look, so the wait for it is long: a busy machine's sleeps never end it first.
        let waits = Waits { page: Duration::from_secs(60), ..quick() };
        let done = sign_in(&node, Way::Website, &waits, &mut |s| said.borrow_mut().push(s)).unwrap();
        assert_eq!(done, Done::Linked { owner: "0xnew".into() });
        assert_eq!(*said.borrow(), [Step::Page { url: "https://unbrowse.ai/link?n=1".into(), opened: false }, Step::Waiting]);
    }

    #[test]
    fn the_website_sign_in_fails_on_the_nodes_reason_an_end_with_no_wallet_or_the_wait() {
        let answering = |status: Value| Asked {
            sent: RefCell::new(Vec::new()),
            answer: Box::new(move |cmd, _| match cmd {
                "link_start" => Ok(json!({ "url": "https://unbrowse.ai/link", "opened": true })),
                _ => Ok(status.clone()),
            }),
        };
        let e = sign_in(&answering(json!({ "owner": null, "waiting": false, "error": "you didn't confirm the wallet" })), Way::Website, &quick(), &mut |_| {}).unwrap_err();
        assert_eq!(e, "you didn't confirm the wallet");
        let e = sign_in(&answering(json!({ "owner": null, "waiting": false, "error": null })), Way::Website, &quick(), &mut |_| {}).unwrap_err();
        assert!(e.contains("no wallet linked"), "{e}");
        let e = sign_in(&answering(json!({ "owner": null, "waiting": true, "error": null })), Way::Website, &quick(), &mut |_| {}).unwrap_err();
        assert!(e.contains("wasn't finished in 1 minute;"), "{e}");
        let down = Asked { sent: RefCell::new(Vec::new()), answer: Box::new(|_, _| Err("start the node first (`unbrowse-node` or the app)".into())) };
        assert!(sign_in(&down, Way::Website, &quick(), &mut |_| {}).unwrap_err().contains("start the node"));
    }

    /// A sign-in started on a node already linked: the old wallet is in `owner` the whole time the new page is open, and
    /// reading it as success said "linked" for a wallet the owner was replacing.
    #[test]
    fn a_link_from_before_is_not_the_sign_in_under_way() {
        let status = |owner: Option<&str>, waiting: bool| json!({ "owner": owner, "waiting": waiting, "error": null });
        assert_eq!(finished(&status(Some("0xold"), true)), None);
        assert_eq!(finished(&status(Some("0xnew"), false)), Some("0xnew"));
        assert_eq!(finished(&status(None, true)), None);
        assert_eq!(finished(&status(None, false)), None);
    }

    #[test]
    fn a_key_file_is_read_only_when_it_is_the_owners_alone_and_never_said_back() {
        let dir = store::scratch_home("login-keyfile");
        let key = PrivateKeySigner::random();
        let hex = hex::encode(key.to_bytes());
        let path = dir.join("owner.key");
        std::fs::write(&path, format!("0x{hex}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(key_from_file(&path).unwrap_err().contains("chmod 600"));
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(key_from_file(&path).unwrap().address(), key.address());
        assert_eq!(key_from(&hex).unwrap().address(), key.address(), "0x optional");
        for bad in ["", "nope", &hex[..60], &format!("{hex}00"), &format!("zz{}", &hex[2..])] {
            let e = key_from(bad).unwrap_err();
            assert!(bad.len() < 8 || !e.contains(bad), "the text is never said back: {e}");
        }
        assert!(key_from_file(&dir.join("missing.key")).is_err());
    }
}
