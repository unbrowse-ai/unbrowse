//! The owner's yes, asked by the node itself: in a native dialog on this machine's screen, or, on a node with no screen,
//! with the owner passphrase typed on a terminal.
//!
//! The owner's token (`owner.token`) is a file this user's other programs can read, so a command that holds it proves
//! only that it runs as this user, not that the owner is there. A command that hands out a secret the node can never
//! take back (the recovery phrase, a vault password, a backup of the key), puts a new key in the node's place, lets an
//! agent key spend more, or keeps a wallet a website handed the node to pay out to, waits instead on the owner's yes:
//!
//! - **A screen.** A dialog the node opens itself. Nothing sent over HTTP answers it, so holding the token, or
//!   answering for the website, is not enough.
//! - **No screen** (a server, a session over SSH). The node waits on the owner passphrase, which the owner set on a
//!   terminal (`unbrowse-node passphrase`) and types on one again (`unbrowse-node confirm`). The node keeps only its slow
//!   hash, sealed with the node's root key (`unbrowse_core::owner_pass`), so a program that holds the token and can
//!   write the owner's files still can't answer: it doesn't know the passphrase and can't seal one of its own. Wrong
//!   guesses decline the question after [`TRIES_PER_QUESTION`] and lock every question for [`LOCK_SECS`] after
//!   [`TRIES_BEFORE_LOCK`] in a row. With no passphrase set, the node refuses and says how to set one.
//!
//! **One exception, card payments, and only when the owner chose it.** A card payment an agent waits on
//! (`hands::payment_waiting`) is normally approved here too. The owner may let the owner SDK approve it instead
//! (`payment_approver` set to `sdk`, by `unbrowse-node vault card approver sdk` or the owner command of that name): then
//! `hands_give_back` with done, naming the payment's ask, approves that one payment with no dialog, for an owner who
//! answers on another device through a program of their own (the daemon hub's Telegram bot). Turning that on waits on
//! the owner's yes here, every time; the choice is kept sealed with the node's key (`owner.payment-approver`), not in the
//! settings file, so editing that file or saving a stale copy of it never turns it on. Its limit is this module's own:
//! with it on, any program running as this user that reads the owner token can approve a payment an agent waits on,
//! one at a time and each logged in the owner's activity. Nothing else here changes: the recovery phrase, vault
//! passwords, spending caps and wallets still wait on the dialog.
//!
//! Why a passphrase and not a second device: the node has no channel to an owner device it trusts. The sign-in relay
//! is the site's (whoever serves it answers for it), and a linked wallet is optional and confirmed through this same
//! yes. A passphrase in the owner's head needs nothing paired and works on any node with a terminal.
//!
//! What this does not stop: a program running as the same user that can press buttons in other programs' windows (an
//! X11 session lets any client do it; macOS needs it granted Accessibility first), reads what the owner types on the
//! terminal, or reads the node's key where its store lets this user's programs read it (`root.key`, on a Linux machine
//! without a working keyring, or a Linux Secret Service collection). Closing those needs the agents to run as another
//! OS user than the node.

use std::sync::Mutex;

use serde::Serialize;
use unbrowse_core::owner_pass::Record;
use unbrowse_core::{KeyStore, RootKey};

use crate::store;

/// How long the owner has to answer, in a dialog or on a terminal, before it counts as no.
#[cfg(not(test))]
pub const WAIT_SECS: u64 = 120;
#[cfg(test)]
pub const WAIT_SECS: u64 = 20;

/// Wrong passphrases one question takes before it counts as no.
pub const TRIES_PER_QUESTION: u32 = 3;
/// Wrong passphrases in a row, over any questions, before the node takes none for [`LOCK_SECS`].
pub const TRIES_BEFORE_LOCK: u32 = 5;
pub const LOCK_SECS: u64 = 15 * 60;

/// Asks the owner `question`, and answers Ok only on their yes. `keys` is the node's key store, which seals the
/// passphrase a node with no screen waits on; `None` while the node can't read its key yet. Blocks until the owner
/// answers or [`WAIT_SECS`] pass, off the async runtime's threads. The question is shown as plain text (`plain`) with
/// the request's own id, which the terminal's `confirm` shows too, so two questions never look the same.
pub async fn ask(keys: Option<&(dyn KeyStore + Send + Sync)>, question: String) -> Result<(), String> {
    let id = request_id()?;
    let question = worded(&question, &id);
    let passphrase = keys.map(|k| passphrase(k));
    let why = match show(question.clone()).await {
        Shown::Answered(r) => return r,
        Shown::Not(why) => why,
    };
    let record = match passphrase {
        Some(Ok(Some(r))) => r,
        Some(Ok(None)) => return Err(unshown(&why, NO_PASSPHRASE)),
        Some(Err(e)) => return Err(unshown(&why, &e)),
        None => return Err(unshown(&why, "the node can't read its key yet, which seals the owner passphrase")),
    };
    wait_for_terminal(id, record, question).await
}

/// [`ask`], from a shell's command (no async runtime): with no screen, the owner types the passphrase on this
/// process's own terminal.
pub fn ask_blocking(keys: &dyn KeyStore, question: &str) -> Result<(), String> {
    let question = worded(question, &request_id()?);
    let record = passphrase(keys);
    let why = match show_now(&question) {
        Shown::Answered(r) => return r,
        Shown::Not(why) => why,
    };
    let record = match record {
        Ok(Some(r)) => r,
        Ok(None) => return Err(unshown(&why, NO_PASSPHRASE)),
        Err(e) => return Err(unshown(&why, &e)),
    };
    crate::tty::say(&format!("\n{question}\n"))?;
    for _ in 0..TRIES_PER_QUESTION {
        let typed = crate::tty::read_secret("Type the owner passphrase to allow it, or press Enter to refuse: ")?;
        if typed.is_empty() {
            return Err(declined());
        }
        match check(&record, &typed)? {
            true => return Ok(()),
            false => crate::tty::say("That isn't the owner passphrase.\n")?,
        }
    }
    Err(declined())
}

/// The owner's yes where there is nothing yet to check a passphrase against (setting the first one): the dialog, or,
/// with no screen, a code this process shows on its own terminal and the owner types back there. A program that only
/// pushes keys into the owner's terminal blind can't type a code it never saw; one that runs this inside a terminal of
/// its own making can (`tty` says what a terminal check can't tell).
pub fn ask_present(question: &str) -> Result<(), String> {
    let question = worded(question, &request_id()?);
    let why = match show_now(&question) {
        Shown::Answered(r) => return r,
        Shown::Not(why) => why,
    };
    let code = present_code()?;
    crate::tty::say(&format!("\n{question}\n(No dialog: {why}.)\n"))?;
    let typed = crate::tty::read_line(&format!("Type {code} to allow it, or press Enter to refuse: "))?;
    if typed.trim().eq_ignore_ascii_case(&code) {
        Ok(())
    } else {
        Err(declined())
    }
}

/// A fresh id for one question, shown with it and listed by `confirmations`.
fn request_id() -> Result<String, String> {
    let mut raw = [0u8; 8];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    Ok(hex::encode(raw))
}

/// The code `ask_present` shows: letters and digits no one misreads. A test's is fixed.
fn present_code() -> Result<String, String> {
    if cfg!(test) {
        return Ok("TESTCODE".into());
    }
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut raw = [0u8; 6];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    Ok(raw.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect())
}

/// The question as the owner is shown it: plain text, then the request's id.
fn worded(question: &str, id: &str) -> String {
    format!("{}\n\nRequest {id}", plain(question).trim_end())
}

/// `text` with nothing in it that shows other than it reads: control characters (a carriage return or an escape that
/// rewrites what came before) and invisible formatting (right-to-left overrides and isolates, zero-width characters,
/// tags) are dropped, a tab is a space, and a line break is kept. A site's or an agent's words in a question (a login's
/// name, an agent key's name) can't turn it around.
pub fn plain(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\n' => Some('\n'),
            '\t' => Some(' '),
            c if c.is_control() || hidden(c) => None,
            c => Some(c),
        })
        .collect()
}

/// Characters that change how text around them shows, or show as nothing.
fn hidden(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x2028..=0x202E
        | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0x0600..=0x0605 | 0x06DD | 0x070F
        | 0x08E2 | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

const NO_PASSPHRASE: &str = "and no owner passphrase is set: run `unbrowse-node passphrase` on this machine's terminal to set one, then `unbrowse-node confirm` there when the node asks";

enum Shown {
    /// The dialog was shown, and this is what the owner said.
    Answered(Result<(), String>),
    /// No dialog could be shown, for this reason.
    Not(String),
}

async fn show(question: String) -> Shown {
    #[cfg(test)]
    {
        show_now(&question)
    }
    #[cfg(not(test))]
    {
        tokio::task::spawn_blocking(move || show_now(&question)).await.unwrap_or_else(|e| Shown::Answered(Err(format!("the dialog failed ({e}), which counts as no: nothing was done"))))
    }
}

fn show_now(question: &str) -> Shown {
    #[cfg(test)]
    {
        test_answer(question)
    }
    #[cfg(not(test))]
    {
        dialog(question)
    }
}

#[cfg(test)]
thread_local! {
    static ANSWER: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
    static ASKED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// How the owner answers the dialogs a test's code asks on this thread: yes, no, or no dialog at all (`None`, the
/// default: a test has no screen).
#[cfg(test)]
pub fn answer_in_test(yes: Option<bool>) {
    ANSWER.with(|a| a.set(yes));
}

/// The questions asked on this thread so far, oldest first.
#[cfg(test)]
pub fn asked_in_test() -> Vec<String> {
    ASKED.with(|a| a.borrow().clone())
}

#[cfg(test)]
fn test_answer(question: &str) -> Shown {
    ASKED.with(|a| a.borrow_mut().push(question.to_string()));
    match ANSWER.with(|a| a.get()) {
        Some(true) => Shown::Answered(Ok(())),
        Some(false) => Shown::Answered(Err(declined())),
        None => Shown::Not("a test shows no dialog".into()),
    }
}

fn declined() -> String {
    "the owner said no (in the dialog on this machine's screen, or on its terminal), or didn't answer in time: nothing was done".into()
}

fn unshown(why: &str, then: &str) -> String {
    format!("this needs the owner's yes in a dialog on this machine's screen, and the node couldn't show one ({why}), {then}: nothing was done")
}

// ---- who approves a card payment ----

/// The label the payment approver's seal is made under, so a seal for any other record never passes for it.
const APPROVER_SEAL: &str = "payment-approver";

/// Who approves a card payment an agent waits on (`hands::payment_waiting`). `dialog`, the default: the owner's yes in
/// this module's dialog, or by passphrase. `sdk`: the owner command that gives the page back with done, naming the ask
/// (`hands_give_back` with `ask`), approves it with no dialog: what an owner who is away from the machine answers
/// through, in a program of their own that holds the owner token and asks them on another device (the daemon hub's
/// Telegram bot, behind its own flag). It covers card payments only; everything else here still waits on the dialog.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PaymentApprover {
    /// `dialog` or `sdk`.
    pub approver: &'static str,
    /// When the owner turned `sdk` on, for `sdk`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

#[derive(serde::Deserialize, Serialize)]
struct ApproverRecord {
    approver: String,
    since: u64,
    mac: String,
}

/// Where the payment approver is kept: beside the owner passphrase, sealed with the node's key, not in `settings.json`,
/// so a save of the settings from a window's stale read, or a hand edit of that file, never turns it on.
pub fn approver_file() -> std::path::PathBuf {
    store::home().join("owner.payment-approver")
}

fn approver_text(since: u64) -> String {
    format!("sdk {since}")
}

/// Who approves a card payment now. Anything but a record this node's key sealed for `sdk` (none, unreadable, edited,
/// sealed by another key, or no key to check it with) is the dialog.
pub fn payment_approver(keys: Option<&dyn KeyStore>) -> PaymentApprover {
    let dialog = PaymentApprover { approver: "dialog", since: None };
    let Some(keys) = keys else { return dialog };
    let Ok(text) = std::fs::read_to_string(approver_file()) else { return dialog };
    let Ok(r) = serde_json::from_str::<ApproverRecord>(&text) else { return dialog };
    let Ok(root) = RootKey::load(keys) else { return dialog };
    if r.approver == "sdk" && unbrowse_core::owner_pass::sealed_text(&root, APPROVER_SEAL, &approver_text(r.since), &r.mac) {
        PaymentApprover { approver: "sdk", since: Some(r.since) }
    } else {
        dialog
    }
}

/// Whether the owner command naming the ask approves a waiting card payment without the dialog.
pub fn sdk_approves_payments(keys: Option<&dyn KeyStore>) -> bool {
    payment_approver(keys).approver == "sdk"
}

/// Sets who approves a card payment: `sdk` or `dialog`. Only the owner reaches this, on their yes for `sdk`
/// (`commands::asks_the_owner`, and the shell's `vault card approver sdk`, which asks the same); going back to the dialog
/// asks nothing, since it only makes the node ask more.
pub fn set_payment_approver(keys: &dyn KeyStore, approver: &str, who: &str) -> Result<PaymentApprover, String> {
    match approver {
        "sdk" => {
            let since = store::now();
            let root = RootKey::load(keys).map_err(|e| e.to_string())?;
            let mac = unbrowse_core::owner_pass::seal_text(&root, APPROVER_SEAL, &approver_text(since));
            let text = serde_json::to_string(&ApproverRecord { approver: "sdk".into(), since, mac }).map_err(|e| e.to_string())?;
            let path = approver_file();
            unbrowse_files::private::write(&path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        "dialog" => match std::fs::remove_file(approver_file()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", approver_file().display())),
        },
        other => return Err(format!("{}: who approves a card payment is sdk or dialog", plain(other).chars().take(40).collect::<String>())),
    }
    let now = payment_approver(Some(keys));
    store::log_activity(&store::Activity {
        at: store::now(),
        who: who.into(),
        site: String::new(),
        what: if now.approver == "sdk" {
            "Let the owner SDK approve card payments without the dialog (an answer from Telegram, say)".into()
        } else {
            "Card payments are approved in the dialog again".into()
        },
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(now)
}

// ---- the owner passphrase ----

/// Where the owner passphrase's sealed hash is kept: beside the owner's token, readable by the owner's user only.
pub fn passphrase_file() -> std::path::PathBuf {
    store::home().join("owner.passphrase")
}

/// Where wrong passphrases are counted, so restarting the node doesn't reset the count.
fn tries_file() -> std::path::PathBuf {
    store::home().join("owner.passphrase.tries")
}

/// The owner passphrase as this node keeps it, once its key is known to have sealed it; `None` when none is set. A
/// record this node's key didn't seal is refused, never trusted.
pub fn passphrase(keys: &dyn KeyStore) -> Result<Option<Record>, String> {
    let path = passphrase_file();
    unbrowse_core::keystore::keep_private(&path).map_err(|e| e.to_string())?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let record: Record = serde_json::from_str(&text).map_err(|e| format!("{} isn't an owner passphrase: {e}", path.display()))?;
    let root = RootKey::load(keys).map_err(|e| e.to_string())?;
    record.sealed_by(&root).map_err(|e| format!("{e}: set it again with `unbrowse-node passphrase`"))?;
    Ok(Some(record))
}

/// Keeps `record` as the owner passphrase, readable by this user only. A count of wrong tries goes beside it first, so
/// `check` can read a count that is gone as one taken away. A count already there stays: setting a passphrase lifts no
/// lock.
pub fn keep_passphrase(record: &Record) -> Result<(), String> {
    if !tries_file().exists() {
        keep_tries(&Tries::default())?;
    }
    let path = passphrase_file();
    let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    let part = path.with_extension("passphrase.part");
    let _ = std::fs::remove_file(&part);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let mut f = open.open(&part).map_err(|e| format!("{}: {e}", part.display()))?;
    std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&part, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    unbrowse_core::keystore::keep_private(&path).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize, Serialize, Default)]
struct Tries {
    wrong: u32,
    locked_until: u64,
}

fn keep_tries(tries: &Tries) -> Result<(), String> {
    let path = tries_file();
    unbrowse_files::private::write(&path, serde_json::to_string(tries).unwrap_or_default().as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

/// One passphrase check at a time, so guesses can't run side by side.
static CHECKING: Mutex<()> = Mutex::new(());

/// Whether `typed` is the owner passphrase `record` keeps, counting a wrong one. Refused, without checking, while
/// wrong ones have locked it. Slow on purpose.
pub fn check(record: &Record, typed: &str) -> Result<bool, String> {
    check_waiting(record, typed, store::MONEY_LOCK_WAIT)
}

/// `check`, waiting at most `wait` for the count's lock. The node and a shell's command each check passphrases and
/// write the count back, so the count is read, the guess checked and the count written under a lock every process
/// takes: guesses made side by side in several processes each count, and take turns at the slow hash. A lock not
/// taken in time checks nothing.
fn check_waiting(record: &Record, typed: &str, wait: std::time::Duration) -> Result<bool, String> {
    let _one = CHECKING.lock().unwrap_or_else(|p| p.into_inner());
    let path = tries_file();
    let _file = store::hold_money_file(&path, wait).map_err(|e| format!("the count of wrong owner passphrases is held by another process ({e}): nothing was checked"))?;
    let now = store::now();
    // A passphrase is set with its count beside it (`keep_passphrase`), so a count gone or spoiled was taken away: it
    // counts as locked, and that lock is written, so it runs out instead of starting over at every check. Neither
    // deleting nor spoiling the file lifts a lock, and a program guessing gains nothing by it.
    let mut tries: Tries = match std::fs::read(&path).ok().and_then(|t| serde_json::from_slice(&t).ok()) {
        Some(t) => t,
        None => {
            let locked = Tries { wrong: 0, locked_until: now + LOCK_SECS };
            keep_tries(&locked)?;
            locked
        }
    };
    if tries.locked_until > now {
        return Err(format!(
            "too many wrong owner passphrases: the node takes none for {} more minutes",
            (tries.locked_until - now).div_ceil(60)
        ));
    }
    let right = record.opens(typed).map_err(|e| e.to_string())?;
    if right {
        tries = Tries::default();
    } else {
        tries.wrong += 1;
        if tries.wrong >= TRIES_BEFORE_LOCK {
            tries = Tries { wrong: 0, locked_until: now + LOCK_SECS };
        }
    }
    keep_tries(&tries)?;
    Ok(right)
}

// ---- questions waiting on the terminal ----

/// A question a node with no screen is waiting on the owner's passphrase for.
struct Waiting {
    id: String,
    question: String,
    until: u64,
    record: Record,
    wrong: u32,
    answer: Option<tokio::sync::oneshot::Sender<bool>>,
}

static WAITING: Mutex<Vec<Waiting>> = Mutex::new(Vec::new());

fn waiting() -> std::sync::MutexGuard<'static, Vec<Waiting>> {
    WAITING.lock().unwrap_or_else(|p| p.into_inner())
}

/// A question waiting on the owner, as `confirmations` lists it: what `unbrowse-node confirm` shows.
#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Confirmation {
    pub id: String,
    pub question: String,
    pub seconds_left: u64,
}

async fn wait_for_terminal(id: String, record: Record, question: String) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    waiting().push(Waiting { id: id.clone(), question: question.clone(), until: store::now() + WAIT_SECS, record, wrong: 0, answer: Some(tx) });
    eprintln!("Unbrowse is waiting for the owner's yes: {question}\nThis machine shows no dialog: run `unbrowse-node confirm` on its terminal within {} minutes to answer.", WAIT_SECS / 60);
    let said = tokio::time::timeout(std::time::Duration::from_secs(WAIT_SECS), rx).await;
    waiting().retain(|w| w.id != id);
    match said {
        Ok(Ok(true)) => Ok(()),
        _ => Err(declined()),
    }
}

/// `confirmations`: the questions waiting on the owner's passphrase now.
pub fn confirmations() -> Vec<Confirmation> {
    let now = store::now();
    waiting()
        .iter()
        .filter(|w| w.answer.is_some() && w.until > now)
        .map(|w| Confirmation { id: w.id.clone(), question: w.question.clone(), seconds_left: w.until - now })
        .collect()
}

/// `confirm`: the owner's answer to the question `id`, with the owner passphrase to allow it, or none to refuse it.
/// A wrong passphrase leaves it waiting, up to [`TRIES_PER_QUESTION`] of them.
pub async fn confirm(id: String, passphrase: Option<String>) -> Result<String, String> {
    let gone = || format!("nothing waits on the owner under {id}: it was answered, or its {} minutes ran out", WAIT_SECS / 60);
    let Some(typed) = passphrase.filter(|p| !p.is_empty()).map(zeroize::Zeroizing::new) else {
        let tx = waiting().iter_mut().find(|w| w.id == id).and_then(|w| w.answer.take()).ok_or_else(gone)?;
        let _ = tx.send(false);
        return Ok("refused".into());
    };
    let record = waiting().iter().find(|w| w.id == id && w.answer.is_some()).map(|w| w.record.clone()).ok_or_else(gone)?;
    let right = tokio::task::spawn_blocking(move || check(&record, &typed)).await.map_err(|e| e.to_string())??;
    let mut all = waiting();
    let w = all.iter_mut().find(|w| w.id == id && w.answer.is_some()).ok_or_else(gone)?;
    if right {
        // The wait can run out as the answer comes: a yes no one heard allowed nothing, and the owner must not read
        // that it did.
        return match w.answer.take().map(|tx| tx.send(true)) {
            Some(Ok(())) => Ok("allowed".into()),
            _ => Err(gone()),
        };
    }
    w.wrong += 1;
    if w.wrong >= TRIES_PER_QUESTION {
        let _ = w.answer.take().map(|tx| tx.send(false));
        return Err(format!("that isn't the owner passphrase, {TRIES_PER_QUESTION} times: the question was refused"));
    }
    Err(format!("that isn't the owner passphrase: {} more tries for this question", TRIES_PER_QUESTION - w.wrong))
}

// ---- the dialog, on this OS ----
//
// Whether a dialog can be shown is read from the session the node runs in (macOS: whether it has the window server;
// Windows: whether its window station is the visible one; Linux: whether it was given a display), before anything is
// started. Once a dialog program is started, whatever it ends with is the owner's answer: a dialog that is killed,
// crashes or says something unexpected is a no, never a reason to fall back on the passphrase. Each program is run
// from where the OS installs it (never looked up on PATH, which this user's programs can put a program of their own
// ahead on), with an environment of its own (never the caller's, which could load code into it).

/// The dialog programs the node runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Program {
    Osascript,
    PowerShell,
    Zenity,
    Kdialog,
}

/// Where each dialog program may be, in the order tried, for the OS `os` (`std::env::consts::OS`); `system` is
/// Windows' system folder. Every path is absolute.
fn places(os: &str, system: &std::path::Path) -> Vec<(Program, std::path::PathBuf)> {
    use std::path::PathBuf;
    match os {
        "macos" => vec![(Program::Osascript, PathBuf::from("/usr/bin/osascript"))],
        "windows" => vec![(Program::PowerShell, system.join("WindowsPowerShell").join("v1.0").join("powershell.exe"))],
        // The OS's own folders only: /usr/local and a home's bin are writable by more than the system's packages.
        _ => [(Program::Zenity, "zenity"), (Program::Kdialog, "kdialog")]
            .into_iter()
            .flat_map(|(p, name)| ["/usr/bin", "/bin", "/run/current-system/sw/bin"].into_iter().map(move |d| (p, PathBuf::from(d).join(name))))
            .collect(),
    }
}

/// What a dialog program's end says: the owner's answer, always, once it was started. `code` is its exit code (`None`:
/// killed by a signal).
fn judged(p: Program, code: Option<i32>, stdout: &str, stderr: &str) -> Shown {
    Shown::Answered(answer_of(p, code, stdout, stderr))
}

fn answer_of(p: Program, code: Option<i32>, stdout: &str, stderr: &str) -> Result<(), String> {
    let allowed = match p {
        // osascript ends with "-128" on Cancel; "gave up:true" is the wait running out.
        Program::Osascript => code == Some(0) && stdout.contains("button returned:Allow") && !stdout.contains("gave up:true"),
        Program::PowerShell => code == Some(0) && stdout.trim() == "OK",
        // 0 is Allow; 1 Cancel, 5 the wait running out.
        Program::Zenity | Program::Kdialog => code == Some(0),
    };
    if allowed {
        return Ok(());
    }
    let answered = match p {
        Program::Osascript => code == Some(0) || stderr.contains("-128"),
        Program::PowerShell => code == Some(0),
        Program::Zenity => matches!(code, Some(1 | 5)),
        Program::Kdialog => code == Some(1),
    };
    if answered {
        Err(declined())
    } else {
        Err(format!(
            "the dialog ended without the owner's answer ({}), which counts as no: nothing was done",
            match code {
                Some(c) => format!("exit {c}{}", if stderr.trim().is_empty() { String::new() } else { format!(": {}", stderr.trim()) }),
                None => "it was killed".into(),
            }
        ))
    }
}

/// The dialog: answered when it was shown, or why it couldn't be.
#[cfg(not(test))]
fn dialog(question: &str) -> Shown {
    if let Err(why) = screen() {
        return Shown::Not(why);
    }
    let system = system_folder();
    let Some((program, path)) = places(std::env::consts::OS, &system).into_iter().find(|(_, path)| trusted(path)) else {
        return Shown::Not(match std::env::consts::OS {
            "macos" => "/usr/bin/osascript isn't there".into(),
            "windows" => "Windows PowerShell isn't in the system folder".into(),
            _ => "neither zenity nor kdialog is installed in the system's own folders".into(),
        });
    };
    let mut c = std::process::Command::new(&path);
    c.env_clear().stdin(std::process::Stdio::null());
    for k in ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SystemRoot", "windir", "USERPROFILE", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    match program {
        Program::Osascript => {
            // The question goes in as an argument, never as script text.
            c.args([
                "-e",
                "on run argv",
                "-e",
                &format!("display dialog (item 1 of argv) with title \"Unbrowse\" buttons {{\"Cancel\", \"Allow\"}} default button \"Cancel\" cancel button \"Cancel\" with icon caution giving up after {WAIT_SECS}"),
                "-e",
                "end run",
                question,
            ]);
        }
        Program::PowerShell => {
            // Modules from the system's own folder only: PSModulePath is this user's to change.
            c.env("PSModulePath", system.join("WindowsPowerShell").join("v1.0").join("Modules")).env("UNBROWSE_ASK", question).args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:UNBROWSE_ASK, 'Unbrowse', 'OKCancel', 'Warning', 'Button2')",
            ]);
        }
        Program::Zenity => {
            // zenity reads its text as markup.
            let marked = question.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            c.args(["--question", "--title=Unbrowse", "--ok-label=Allow", "--cancel-label=Cancel", "--default-cancel", &format!("--timeout={WAIT_SECS}"), &format!("--text={marked}")]);
        }
        Program::Kdialog => {
            c.args(["--title", "Unbrowse", "--warningcontinuecancel", question, "--continue-label", "Allow"]);
        }
    }
    match within_the_wait(c) {
        Ok(Some(out)) => judged(program, out.status.code(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr)),
        Ok(None) => Shown::Answered(Err(declined())),
        Err(e) => Shown::Answered(Err(format!("the dialog couldn't start ({e}), which counts as no: nothing was done"))),
    }
}

/// Runs a dialog program for at most [`WAIT_SECS`]: osascript and zenity give up by themselves, but Windows'
/// message box and kdialog have no wait of their own, so a dialog nobody answers is closed here and counts as no.
/// `None` when the wait ran out.
#[cfg(not(test))]
fn within_the_wait(mut c: std::process::Command) -> std::io::Result<Option<std::process::Output>> {
    let mut child = c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(WAIT_SECS);
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map(Some);
        }
        if std::time::Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Whether the program at `path` is the system's: there, and (on macOS and Linux) a file only root can change, in a
/// folder only root can change.
#[cfg(not(test))]
fn trusted(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let root_only = |p: &std::path::Path| std::fs::metadata(p).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0);
        root_only(path) && path.parent().is_some_and(root_only)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Windows' system folder, from Windows itself (never `SystemRoot`, which the caller's environment sets).
#[cfg(not(test))]
fn system_folder() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        let mut buf = [0u16; 260];
        // SAFETY: the buffer is as long as the length passed; the call writes at most that many characters.
        let n = unsafe { windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if n > 0 && n < buf.len() {
            return std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]));
        }
        std::path::PathBuf::from(r"C:\Windows\System32")
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::new()
    }
}

/// Whether this process's session can show a dialog, or why not.
#[cfg(not(test))]
fn screen() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "Security", kind = "framework")]
        extern "C" {
            fn SessionGetInfo(session: u32, id: *mut u32, attributes: *mut u32) -> i32;
        }
        const CALLER_SECURITY_SESSION: u32 = u32::MAX;
        const SESSION_HAS_GRAPHIC_ACCESS: u32 = 0x0010;
        let (mut id, mut attributes) = (0u32, 0u32);
        // SAFETY: both out-pointers are to live locals.
        let status = unsafe { SessionGetInfo(CALLER_SECURITY_SESSION, &mut id, &mut attributes) };
        if status != 0 {
            return Err(format!("macOS couldn't say what session the node runs in ({status})"));
        }
        if attributes & SESSION_HAS_GRAPHIC_ACCESS == 0 {
            return Err("the node runs in a session with no screen (over SSH, or as a service)".into());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::StationsAndDesktops::{GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS};
        const WSF_VISIBLE: u32 = 1;
        // SAFETY: the station handle is this process's own and is not closed; `flags` is as long as the length passed.
        unsafe {
            let station = GetProcessWindowStation();
            let mut flags: USEROBJECTFLAGS = std::mem::zeroed();
            let mut needed = 0u32;
            if station == 0 || GetUserObjectInformationW(station, UOI_FLAGS, &mut flags as *mut _ as *mut core::ffi::c_void, std::mem::size_of::<USEROBJECTFLAGS>() as u32, &mut needed) == 0 {
                return Err("Windows couldn't say whether the node's session has a desktop".into());
            }
            if flags.dwFlags & WSF_VISIBLE == 0 {
                return Err("the node runs in a session with no desktop (a service)".into());
            }
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err("no DISPLAY or WAYLAND_DISPLAY in the node's environment".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owners_record() -> Record {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        Record::new_with(&RootKey::load(&keys).unwrap(), "the owner's own words", 10).unwrap()
    }

    /// The count of wrong passphrases is what the lock stands on, so taking it away must not open the door: a program
    /// guessing could delete it after every guess. A passphrase once set always has one.
    #[test]
    fn deleting_the_count_of_wrong_passphrases_never_lifts_the_lock() {
        let _home = store::scratch_home("tries-gone");
        let record = owners_record();
        keep_passphrase(&record).unwrap();
        for _ in 0..TRIES_BEFORE_LOCK {
            assert_eq!(check(&record, "a guess at them"), Ok(false));
        }
        assert!(check(&record, "the owner's own words").unwrap_err().contains("too many wrong"));
        std::fs::remove_file(tries_file()).unwrap();
        assert!(check(&record, "the owner's own words").unwrap_err().contains("too many wrong"), "the file went, and the lock stays");
    }

    /// Every process counts its guesses into one count: a check takes the count's lock across processes from the read
    /// to the write, and one that can't take it checks nothing and counts nothing, so guesses made side by side in
    /// several processes can't each read the same count and write back one wrong each.
    #[test]
    fn guesses_from_several_processes_each_count() {
        let _home = store::scratch_home("tries-locked");
        let record = owners_record();
        keep_passphrase(&record).unwrap();
        assert_eq!(check(&record, "a guess at them"), Ok(false));
        let other = store::hold_money_file(&tries_file(), store::MONEY_LOCK_WAIT).unwrap();
        let before = std::fs::read(tries_file()).unwrap();
        assert!(check_waiting(&record, "the owner's own words", std::time::Duration::from_millis(50)).is_err_and(|e| e.contains("another process")));
        assert_eq!(std::fs::read(tries_file()).unwrap(), before, "nothing counted, nothing reset");
        drop(other);
        let kept: Tries = serde_json::from_slice(&before).unwrap();
        assert_eq!(kept.wrong, 1);
        assert_eq!(check(&record, "the owner's own words"), Ok(true));
    }

    /// Setting a passphrase again keeps the count as it is, so a lock running stays running.
    #[test]
    fn setting_a_passphrase_starts_a_count_and_keeps_one_already_there() {
        let _home = store::scratch_home("tries-set");
        let record = owners_record();
        keep_passphrase(&record).unwrap();
        assert_eq!(check(&record, "the owner's own words"), Ok(true), "a passphrase just set takes its owner's words");
        for _ in 0..TRIES_BEFORE_LOCK {
            assert_eq!(check(&record, "a guess at them"), Ok(false));
        }
        keep_passphrase(&record).unwrap();
        assert!(check(&record, "the owner's own words").is_err());
    }

    /// A lock read from a file that doesn't read is written down, so it runs out. Left unwritten it would restart at
    /// every check, and the one way out would be to delete the file.
    #[test]
    fn a_spoiled_count_locks_for_a_while_not_for_good() {
        let _home = store::scratch_home("tries-spoiled");
        let record = owners_record();
        keep_passphrase(&record).unwrap();
        std::fs::write(tries_file(), "not a count").unwrap();
        assert!(check(&record, "the owner's own words").unwrap_err().contains("too many wrong"));
        let kept: Tries = serde_json::from_slice(&std::fs::read(tries_file()).unwrap()).expect("written whole again");
        assert!(kept.locked_until > store::now());
        std::fs::write(tries_file(), serde_json::to_string(&Tries { wrong: 0, locked_until: store::now() - 1 }).unwrap()).unwrap();
        assert_eq!(check(&record, "the owner's own words"), Ok(true), "and it ran out");
    }

    /// The passphrase can be right and the question gone: its wait ran out as the answer came. The owner is told what
    /// happened, never that something was allowed that no one heard.
    #[test]
    fn a_yes_no_one_waits_for_is_never_called_allowed() {
        let home = store::scratch_home("confirm-gone");
        let record = owners_record();
        keep_passphrase(&record).unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(rx);
        waiting().push(Waiting { id: "no-one-left".into(), question: "a question".into(), until: store::now() + 60, record, wrong: 0, answer: Some(tx) });
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().on_thread_start(move || store::use_home(&home)).build().unwrap();
        let said = rt.block_on(confirm("no-one-left".into(), Some("the owner's own words".into())));
        waiting().retain(|w| w.id != "no-one-left");
        assert!(said.is_err(), "{said:?}");
    }

    /// External security review round 3, 2026-11-04. A dialog program that was started and then killed, crashed or
    /// ended in a way it never does for a real answer is the owner's no, never "couldn't show one": that would fall
    /// back on the owner passphrase, which a program that kills the dialog may know or have set.
    #[test]
    fn a_dialog_that_was_killed_or_failed_is_a_no_never_a_fallback() {
        for p in [Program::Osascript, Program::PowerShell, Program::Zenity, Program::Kdialog] {
            for (code, out, err) in [(None, "", ""), (Some(-1), "", ""), (Some(70), "", "connection invalid"), (Some(255), "", "")] {
                assert!(matches!(judged(p, code, out, err), Shown::Answered(Err(_))), "{p:?} ended {code:?}: a no, never a fallback");
            }
        }
        assert!(matches!(judged(Program::Zenity, Some(0), "", ""), Shown::Answered(Ok(()))));
        assert!(matches!(judged(Program::Osascript, Some(0), "button returned:Allow, gave up:false", ""), Shown::Answered(Ok(()))));
        assert!(matches!(judged(Program::Osascript, Some(0), "button returned:Allow, gave up:true", ""), Shown::Answered(Err(_))), "the wait ran out");
        assert!(answer_of(Program::Osascript, Some(1), "", "execution error: User canceled. (-128)").unwrap_err().contains("said no"));
        assert!(matches!(judged(Program::PowerShell, Some(0), "OK\r\n", ""), Shown::Answered(Ok(()))));
        assert!(matches!(judged(Program::PowerShell, Some(0), "Cancel", ""), Shown::Answered(Err(_))));
        assert!(answer_of(Program::Zenity, None, "", "").unwrap_err().contains("killed"));
    }

    /// External security review round 3, 2026-11-04. The node runs each dialog program from the system's own folders,
    /// never one found on PATH, where this user's programs can put a fake that answers yes.
    #[test]
    fn dialog_programs_come_from_the_systems_folders_never_from_path() {
        let system = std::path::Path::new(r"C:\Windows\System32");
        for os in ["macos", "windows", "linux", "freebsd"] {
            let found = places(os, system);
            assert!(!found.is_empty(), "{os}");
            for (_, path) in &found {
                let shown = path.to_string_lossy().replace('\\', "/");
                assert!(shown.starts_with('/') || shown.starts_with("C:/"), "{os}: {shown} is a full path");
                assert!(!shown.contains("/usr/local/") && !shown.contains("/home/") && !shown.contains("/Users/"), "{os}: {shown} is the system's");
            }
        }
        assert_eq!(places("macos", system)[0].1, std::path::Path::new("/usr/bin/osascript"));
    }

    /// External security review round 3, 2026-11-04. A question shows what it says: control characters and
    /// right-to-left or invisible formatting in a site's or an agent's words are dropped; and each question carries its
    /// own request id, so two that read alike still look different.
    #[test]
    fn a_question_is_plain_text_and_two_alike_still_differ() {
        crate::owner_dialog::answer_in_test(Some(false));
        let sly = "Show the password for me\u{202E}moc.elpmaxe\u{202C} on a.example?\r\x1b[2K\u{200B}\u{2066}x\u{2069}";
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for _ in 0..2 {
            assert!(rt.block_on(ask(None, sly.into())).is_err());
        }
        let asked = asked_in_test();
        assert_eq!(asked.len(), 2);
        for q in &asked {
            assert!(q.chars().all(|c| c == '\n' || !(c.is_control() || hidden(c))), "{q:?}");
            assert!(q.contains("moc.elpmaxe on a.example?"), "{q:?}");
            assert!(q.contains("Request "), "{q:?}");
        }
        assert_ne!(asked[0], asked[1], "the same question twice shows two ids");
        assert_eq!(plain("a\tb\nc\u{7f}\u{feff}"), "a b\nc");
    }
}
