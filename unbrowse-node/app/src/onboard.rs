//! `unbrowse-node onboard`: a new owner from nothing to signed in, on one terminal, with no window. Four steps, each
//! skipped when it is done already, so running it again picks up where it stopped:
//!
//! 1. **The node**: the one running here, or one it starts in the background (its own session, so closing this
//!    terminal leaves it running), its output in `node.log` in the node's home.
//! 2. **The owner passphrase**: the owner's yes on a machine with no screen, typed on a terminal. Needed there to link a
//!    wallet; offered where a dialog can ask instead.
//! 3. **The terms**: shown on request and acknowledged by typing `accept` (`accept_terms`); `--keep-off` keeps the node
//!    off the peer network, as the first-run screen's checkbox does.
//! 4. **The sign-in** (`login::sign_in`): the website, a wallet key file, or a wallet that signs elsewhere. While the
//!    node waits on the owner's yes, this answers it on the same terminal (`confirm_on_terminal`), so no second
//!    terminal is needed.
//!
//! `unbrowse-node onboard status` says where each step stands, and exits 0 only when the node runs and is signed in.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::{link, login, owner_dialog, store, terms, tty};

pub const USAGE: &str = "usage: unbrowse-node onboard [--keep-off] [--website | --key-file <path> | --wallet <address>]
                                set up this node and sign its owner in, on this terminal
       unbrowse-node onboard status   whether the node runs here and is signed in (exit 0 only when both)";

/// How many times a prompt is asked again after an answer it can't use, before it gives up.
const TRIES: usize = 3;

/// What the command line chose before anything was asked.
#[derive(Debug, PartialEq)]
struct Asked {
    keep_off: bool,
    way: Option<Chosen>,
}

/// A way to sign in named on the command line.
#[derive(Debug, PartialEq)]
enum Chosen {
    Website,
    KeyFile(PathBuf),
    Wallet(String),
}

/// The words after `onboard`, read; `Err` is the usage.
fn parse(args: &[&str]) -> Result<Asked, String> {
    let mut asked = Asked { keep_off: false, way: None };
    let mut rest = args;
    while let Some((first, after)) = rest.split_first() {
        let (way, after) = match (*first, after) {
            ("--keep-off", after) => {
                asked.keep_off = true;
                rest = after;
                continue;
            }
            ("--website", after) => (Chosen::Website, after),
            ("--key-file", [path, after @ ..]) => (Chosen::KeyFile(PathBuf::from(path)), after),
            ("--wallet", [owner, after @ ..]) => (Chosen::Wallet(owner.to_string()), after),
            _ => return Err(USAGE.into()),
        };
        if asked.way.replace(way).is_some() {
            return Err(format!("name one way to sign in, not two\n{USAGE}"));
        }
        rest = after;
    }
    Ok(asked)
}

/// `unbrowse-node onboard …`.
pub fn cli(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    if a == ["status"] {
        let (lines, signed_in) = status();
        for l in lines {
            println!("{l}");
        }
        return if signed_in { 0 } else { 1 };
    }
    let asked = match parse(&a) {
        Ok(asked) => asked,
        Err(usage) => {
            eprintln!("{usage}");
            return 2;
        }
    };
    match onboard(asked) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("\nonboarding stopped: {e}");
            eprintln!("what is done stays done: run `unbrowse-node onboard` again to carry on, and `unbrowse-node onboard status` to see where it stands");
            1
        }
    }
}

fn onboard(asked: Asked) -> Result<(), String> {
    tty::say("Setting up this Unbrowse node, with no window: 1 the node, 2 an owner passphrase, 3 the terms, 4 signing in.\n\n")?;
    node_step()?;
    passphrase_step()?;
    terms_step(asked.keep_off)?;
    sign_in_step(asked.way)?;
    println!();
    let (lines, signed_in) = status();
    for l in lines {
        println!("{l}");
    }
    if !signed_in {
        return Err("the node doesn't say it is signed in".into());
    }
    println!("\ndone: this node is signed in. `unbrowse-node onboard status` checks it any time.");
    Ok(())
}

// ---- 1. the node ----

fn node_step() -> Result<(), String> {
    let port = store::api_port();
    match crate::owner_ask("identity", json!({}), Duration::from_secs(20)) {
        Ok(_) => {
            println!("1/4 node: running on 127.0.0.1:{port}");
            Ok(())
        }
        Err(crate::Unanswered::NoNode(_)) => {
            let (pid, log) = start_node()?;
            println!("1/4 node: started on 127.0.0.1:{port} (pid {pid}), in the background; what it says goes to {}", log.display());
            Ok(())
        }
        Err(crate::Unanswered::Node(e)) => Err(format!("the node on 127.0.0.1:{port} didn't answer as its owner expects: {e}")),
    }
}

/// Starts this program as the node, in a session of its own with its output in `node.log`, and waits until it
/// answers its owner. Its process id and the log.
fn start_node() -> Result<(u32, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| format!("couldn't find this program to start the node with: {e}"))?;
    let home = store::home();
    std::fs::create_dir_all(&home).map_err(|e| format!("{}: {e}", home.display()))?;
    let log = home.join("node.log");
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| format!("{}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.stdin(std::process::Stdio::null()).stdout(out).stderr(err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches nothing of the parent's. A session of its own, so the
        // terminal closing (SIGHUP) or a Ctrl-C here never stops the node.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start the node: {e}"))?;
    let pid = child.id();
    tty::say(&format!("starting the node (pid {pid})…\n"))?;
    let until = Instant::now() + Duration::from_secs(180);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the node stopped as it started ({status}): what it said is in {}", log.display()));
        }
        if crate::owner_ask("identity", json!({}), Duration::from_secs(5)).is_ok() {
            return Ok((pid, log));
        }
        if Instant::now() > until {
            return Err(format!(
                "the node (pid {pid}) hasn't answered in 3 minutes: see {}, or start it yourself with `unbrowse-node` in another terminal",
                log.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

// ---- 2. the owner passphrase ----

fn passphrase_step() -> Result<(), String> {
    if owner_dialog::passphrase_file().exists() {
        println!("2/4 owner passphrase: set already");
        return Ok(());
    }
    let set = match owner_dialog::why_no_dialog() {
        Some(why) => {
            tty::say(&format!(
                "This machine can't show the node's dialogs ({why}), so the node asks for your yes with an owner passphrase typed on a terminal. Signing in needs one: set it now.\n"
            ))?;
            true
        }
        None => yes_no("Set an owner passphrase too, to say yes from a terminal when no screen is there (over SSH)? [y/N] ", false)?,
    };
    if !set {
        println!("2/4 owner passphrase: not set (`unbrowse-node passphrase` sets one later)");
        return Ok(());
    }
    let said = crate::root_store().and_then(|keys| crate::set_passphrase(keys.as_ref()))?;
    println!("2/4 owner passphrase: {said}");
    Ok(())
}

// ---- 3. the terms ----

fn terms_step(keep_off: bool) -> Result<(), String> {
    let s = store::load_settings();
    // An owner who kept the node off before keeps it off; `--keep-off` keeps it off now.
    let keep_off = keep_off || !s.peer_network;
    if s.terms_accepted.as_deref() == Some(terms::TERMS_VERSION) {
        let s = if keep_off && s.peer_network { crate::accept_terms(true)? } else { s };
        println!("3/4 terms {}: acknowledged already; {}", terms::TERMS_VERSION, terms::joining(&s));
        return Ok(());
    }
    tty::say(&format!(
        "\nThe Unbrowse terms and privacy notice, version {}. {}\n",
        terms::TERMS_VERSION,
        if keep_off {
            "Acknowledging them keeps this node off the peer network, as asked (`unbrowse-node network on` joins later)."
        } else {
            "Once you acknowledge them, the node joins the peer network (run this with --keep-off to keep it off)."
        }
    ))?;
    for _ in 0..TRIES * 2 {
        match tty::read_line("Type `accept` to acknowledge them, `show` to read them here, or press Enter to stop: ")?.trim().to_ascii_lowercase().as_str() {
            "accept" | "yes" | "y" => {
                let s = crate::accept_terms(keep_off)?;
                println!("3/4 terms {}: acknowledged; {}", terms::TERMS_VERSION, terms::joining(&s));
                return Ok(());
            }
            "show" => tty::say(&format!("\n{}\n", terms::full()))?,
            "" => return Err("the terms weren't acknowledged, so nothing was set up past them".into()),
            other => tty::say(&format!("{other:?} isn't one of accept, show or Enter.\n"))?,
        }
    }
    Err("no answer to the terms could be read".into())
}

// ---- 4. signing in ----

fn sign_in_step(chosen: Option<Chosen>) -> Result<(), String> {
    let st = crate::owner_call("link_status", json!({}))?;
    if let Some(owner) = st["owner"].as_str() {
        println!("4/4 signed in already as {owner}");
        return Ok(());
    }
    let way = match chosen {
        Some(Chosen::Website) => login::Way::Website,
        Some(Chosen::KeyFile(path)) => login::Way::Key(login::key_from_file(&expand(&path))?),
        Some(Chosen::Wallet(owner)) => login::Way::Message { owner: address(&owner)? },
        None => choose()?,
    };
    let done = match signed_in(way)? {
        // A wallet that signs elsewhere: the message shown, its signature pasted back, then linked.
        login::Done::ToSign { owner, message, nonce } => {
            tty::say(&format!("\nSign this message with {owner}, as a plain message (personal_sign), in your wallet:\n\n{message}\n\n"))?;
            let signature = asked_until("Paste the signature (0x…): ", signature)?;
            signed_in(login::Way::Signed { owner, nonce, signature })?
        }
        linked => linked,
    };
    match done {
        login::Done::Linked { owner } => {
            println!("4/4 signed in as {owner}");
            println!("{}", link::signed_in_note(store::load_settings().share_routes));
            Ok(())
        }
        login::Done::ToSign { .. } => Err("the node asked for a second signature".into()),
    }
}

/// The way to sign in, asked.
fn choose() -> Result<login::Way, String> {
    tty::say(
        "\nHow do you sign in?\n  1  email or Google, on the Unbrowse website (in this machine's browser, or its address to open on any device)\n  2  a wallet key kept in a file only you can read (chmod 600): signs here, and never leaves this machine\n  3  a wallet that signs elsewhere (a wallet app or a hardware wallet): you sign a message and paste the signature back\n",
    )?;
    let n = asked_until("Type 1, 2 or 3: ", |t| match t.trim() {
        n @ ("1" | "2" | "3") => Ok(n.to_string()),
        _ => Err("that isn't 1, 2 or 3".into()),
    })?;
    match n.as_str() {
        "1" => Ok(login::Way::Website),
        "2" => {
            let path = asked_until("The key file's path: ", |t| match t.trim() {
                "" => Err("no path typed".into()),
                p => login::key_from_file(&expand(Path::new(p))).map(|_| p.to_string()),
            })?;
            Ok(login::Way::Key(login::key_from_file(&expand(Path::new(&path)))?))
        }
        _ => Ok(login::Way::Message { owner: asked_until("The wallet's address (0x…): ", address)? }),
    }
}

/// The sign-in run in `way`, said as it goes. The node's questions waiting on the owner's yes meanwhile are answered on
/// this terminal: the prompts stay on this thread, and the sign-in, which waits on that yes, runs beside it.
fn signed_in(way: login::Way) -> Result<login::Done, String> {
    enum Heard {
        Step(login::Step),
        Ended(Result<login::Done, String>),
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let steps = tx.clone();
        let ended = login::sign_in(&crate::owner_call_within, way, &login::Waits::default(), &mut |s| {
            let _ = steps.send(Heard::Step(s));
        });
        let _ = tx.send(Heard::Ended(ended));
    });
    let answer = |cmd: &str, body: serde_json::Value| crate::owner_call_within(cmd, body, Duration::from_secs(owner_dialog::WAIT_SECS + 30));
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Heard::Step(login::Step::Page { url, opened })) => {
                println!("sign in with email or Google at {url}{}", if opened { " (opened in your browser)" } else { "" });
            }
            Ok(Heard::Step(login::Step::Waiting)) => println!("waiting for you to sign in on that page…"),
            Ok(Heard::Step(login::Step::Asking { owner })) => {
                println!("linking {owner}: the node asks for your yes, in its dialog, or here when it has no screen");
            }
            Ok(Heard::Ended(ended)) => return ended,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let waiting = answer("confirmations", json!({}))?;
                if waiting.as_array().is_some_and(|l| !l.is_empty()) {
                    let said = crate::confirm_on_terminal(1, &answer)?;
                    println!("{said}");
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("the sign-in stopped with no answer".into()),
        }
    }
}

// ---- status ----

/// Where each step stands, line by line, and whether the node runs here and is signed in.
fn status() -> (Vec<String>, bool) {
    let s = store::load_settings();
    let port = store::api_port();
    let mut lines = Vec::new();
    let node = crate::owner_ask("identity", json!({}), Duration::from_secs(20));
    lines.push(match &node {
        Ok(id) => format!("node: running on 127.0.0.1:{port}, its own wallet {}", id["address"].as_str().unwrap_or("?")),
        Err(crate::Unanswered::NoNode(_)) => "node: not running (`unbrowse-node onboard` starts it)".into(),
        Err(crate::Unanswered::Node(e)) => format!("node: on 127.0.0.1:{port}, but not answering: {e}"),
    });
    lines.push(match s.terms_accepted.as_deref() == Some(terms::TERMS_VERSION) {
        true => format!("terms {}: acknowledged", terms::TERMS_VERSION),
        false => format!("terms {}: not acknowledged", terms::TERMS_VERSION),
    });
    lines.push(format!("network: {}", terms::joining(&s)));
    lines.push(format!("owner passphrase: {}", if owner_dialog::passphrase_file().exists() { "set" } else { "not set" }));
    let owner = node.ok().and_then(|_| crate::owner_call("link_status", json!({})).ok()).and_then(|st| st["owner"].as_str().map(str::to_string));
    lines.push(match &owner {
        Some(o) => format!("signed in: yes, as {o}"),
        None => "signed in: no (`unbrowse-node onboard` signs you in)".into(),
    });
    (lines, owner.is_some())
}

// ---- reading what is typed ----

/// `prompt` asked until `check` takes the answer, or `TRIES` answers it refused, each said with why.
fn asked_until(prompt: &str, check: impl Fn(&str) -> Result<String, String>) -> Result<String, String> {
    for _ in 0..TRIES {
        let typed = tty::read_line(prompt)?;
        match check(&typed) {
            Ok(v) => return Ok(v),
            Err(e) => tty::say(&format!("{e}\n"))?,
        }
    }
    Err(format!("no usable answer after {TRIES} tries"))
}

/// A yes or a no; Enter alone is `default`.
fn yes_no(prompt: &str, default: bool) -> Result<bool, String> {
    let t = asked_until(prompt, |t| match t.trim().to_ascii_lowercase().as_str() {
        "" => Ok(if default { "y" } else { "n" }.into()),
        "y" | "yes" => Ok("y".into()),
        "n" | "no" => Ok("n".into()),
        _ => Err("type y or n".into()),
    })?;
    Ok(t == "y")
}

/// A wallet address as typed, checked: 0x and 40 hex digits.
fn address(typed: &str) -> Result<String, String> {
    let t = typed.trim();
    t.parse::<alloy::primitives::Address>().map(|a| a.to_checksum(None)).map_err(|_| format!("{t:?} isn't a wallet address (0x and 40 hex digits)"))
}

/// A wallet's signature as pasted, checked: 0x and 130 hex digits (65 bytes).
fn signature(typed: &str) -> Result<String, String> {
    let t = typed.trim();
    let hex = t.strip_prefix("0x").unwrap_or(t);
    if hex.len() == 130 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(format!("0x{hex}"))
    } else {
        Err("that isn't a wallet signature (0x and 130 hex digits)".into())
    }
}

/// `path` with a leading `~/` read as the user's home.
fn expand(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_line_names_at_most_one_way_and_may_keep_the_node_off() {
        assert_eq!(parse(&[]), Ok(Asked { keep_off: false, way: None }));
        assert_eq!(parse(&["--keep-off", "--website"]), Ok(Asked { keep_off: true, way: Some(Chosen::Website) }));
        assert_eq!(parse(&["--key-file", "k", "--keep-off"]), Ok(Asked { keep_off: true, way: Some(Chosen::KeyFile("k".into())) }));
        assert_eq!(parse(&["--wallet", "0xabc"]), Ok(Asked { keep_off: false, way: Some(Chosen::Wallet("0xabc".into())) }));
        assert!(parse(&["--website", "--key-file", "k"]).unwrap_err().contains("one way"));
        for bad in [&["--key-file"][..], &["--wallet"], &["now"], &["status", "--json"]] {
            assert_eq!(parse(bad), Err(USAGE.into()), "{bad:?}");
        }
    }

    #[test]
    fn an_address_or_a_signature_that_isnt_one_is_said_and_asked_again() {
        assert_eq!(address(" 0x52908400098527886e0f7030069857d2e4169ee7 ").unwrap(), "0x52908400098527886E0F7030069857D2E4169EE7");
        assert!(address("0x1234").unwrap_err().contains("isn't a wallet address"));
        let sig = format!("0x{}", "ab".repeat(65));
        assert_eq!(signature(&sig).unwrap(), sig);
        assert_eq!(signature(&"ab".repeat(65)).unwrap(), sig, "0x is optional");
        assert!(signature("0xzz").is_err());

        tty::test::type_in(&["0x12", "nope", "0x52908400098527886e0f7030069857d2e4169ee7"]);
        assert_eq!(asked_until("The wallet's address (0x…): ", address).unwrap(), "0x52908400098527886E0F7030069857D2E4169EE7");
        assert_eq!(tty::test::said().iter().filter(|l| l.contains("isn't a wallet address")).count(), 2, "{:?}", tty::test::said());
        tty::test::type_in(&["4", "x", ""]);
        assert!(asked_until("Type 1, 2 or 3: ", |_| Err::<String, _>("that isn't 1, 2 or 3".into())).unwrap_err().contains("3 tries"));
    }

    #[test]
    fn a_yes_or_no_takes_enter_as_its_default() {
        tty::test::type_in(&["", "maybe", "Y"]);
        assert!(!yes_no("? [y/N] ", false).unwrap());
        assert!(yes_no("? [y/N] ", false).unwrap());
        assert!(tty::test::said().iter().any(|l| l.contains("type y or n")));
    }
}
