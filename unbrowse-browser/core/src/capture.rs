//! Passive capture: one JSON-lines file per session while the browser browses.
//!
//! When capture is configured, each finished request is written as a HAR 1.2
//! entry (cookies included) and each page-driving action with the values it
//! typed. Nothing has to be started or stopped; the node reads the log.
//!
//! A secret never reaches the log: a value typed into a password or code field,
//! or a login the node filled from its vault, is written as its name instead,
//! in the action and in every request that sends it. The learner still sees
//! where it went, and the file, readable by anything running as this user,
//! holds no password. Only this user can read the file.
//!
//! The secrets a log is naming outlive the process that met them only sealed: with a [`Sealer`] (the CLI's holds the
//! engine's at-rest key), the list is kept beside the log as ciphertext, read back when the log opens again, and wiped
//! when the session ends ([`CaptureLog::end`]). Without one, the list lives in memory, as it did before.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub const CAPTURE_DIR_ENV: &str = "UNBROWSE_CAPTURE_DIR";

/// A finished request waits this long before it is written: Chrome can report
/// the headers a request sent (its cookies) after the response has finished.
pub const SETTLE: Duration = Duration::from_millis(750);

/// Actions worth logging: the ones that drive a page.
pub const LOGGED_ACTIONS: &[&str] = &[
    "navigate", "click", "dblclick", "fill", "type", "press", "keyboard", "select", "check",
    "uncheck",
];

/// Seals and opens the list of secrets a log keeps across a restart. Core holds no key and no cipher: the caller brings
/// the key material it already encrypts at rest with, so there is one key scheme, not two. `open` answers `None` for
/// bytes it didn't seal (another key, a damaged file), and the list is then started again.
pub trait Sealer: Send + Sync {
    fn seal(&self, plain: &[u8]) -> Option<Vec<u8>>;
    fn open(&self, sealed: &[u8]) -> Option<Vec<u8>>;
}

pub struct CaptureLog {
    file: File,
    /// Finished requests waiting to settle, by request ID.
    pending: Vec<(String, Instant)>,
    /// Secrets typed in this session, each with the name the log says instead.
    secrets: Vec<(String, String)>,
    /// How many secrets have been named, replaced or not, and the file beside the log that keeps the count.
    named: usize,
    count: PathBuf,
    path: PathBuf,
    /// Where the sealed list of secrets is kept, and what seals it; `None`: the list is kept in memory only.
    kept: PathBuf,
    sealer: Option<Box<dyn Sealer>>,
    /// The file that says this log replaces a secret with its name (`<session>.redacts`), written when the first one is
    /// named, before it is written anywhere: a later process resumes the log only with the sealed list of them.
    redacts: PathBuf,
    /// A line failed to reach the file: the log is no longer a whole record of what it was given.
    failed: bool,
}

impl CaptureLog {
    /// Opens (or appends to) the session's log inside `dir`, its secrets kept in memory only.
    pub fn open_in(dir: &Path, session: &str) -> Option<Self> {
        Self::open_in_sealed(dir, session, None)
    }

    /// Opens (or appends to) the session's log inside `dir`. With a `sealer`, the secrets an earlier process named in
    /// this log are read back from their sealed file, so a restart goes on naming them, and each new one is sealed
    /// there too (ENGINE-10.2): the list itself is never written in the clear.
    pub fn open_in_sealed(dir: &Path, session: &str, sealer: Option<Box<dyn Sealer>>) -> Option<Self> {
        std::fs::create_dir_all(dir).ok()?;
        // The logs hold the traffic of signed-in sessions: their folder is the owner's alone, as each log is.
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if std::fs::metadata(dir).is_ok_and(|m| m.uid() == unsafe { libc::geteuid() }) {
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        let name: String = session
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let mut open = OpenOptions::new();
        open.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        let path = dir.join(format!("{name}.jsonl"));
        // Settled before it is opened: the rewrite replaces the file, and a handle opened first would write to the
        // one it replaced. A log settled once keeps its count of names beside it, and isn't read again.
        let count = dir.join(format!("{name}.named"));
        // Names an earlier process left in the log, read before this open settles anything: a name this open gives a
        // value it found as typed is one it holds the value of.
        let unrecoverable = log_has_unrecoverable_secret_names(&path);
        // Whether this open replaced a value in the file itself: from then on only the sealed list can say it again.
        let mut replaced_now = false;
        let (mut secrets, mut named) = match std::fs::read_to_string(&count).ok().and_then(|n| n.trim().parse().ok()) {
            Some(n) if !unrecoverable => (Vec::new(), n),
            Some(_) if sealer.is_none() => return None,
            Some(n) => (Vec::new(), n),
            None => {
                let (secrets, n, settled) = settle_past(&path);
                // The count says this log is settled, so it goes down only once it is: a rewrite that failed leaves a
                // password in the file, and the next open must try again.
                if settled {
                    let _ = std::fs::write(&count, n.to_string());
                }
                replaced_now = settled && !secrets.is_empty();
                (secrets, n)
            }
        };
        let kept = dir.join(format!("{name}.secrets"));
        // Whether an earlier process named a secret in this log, whatever line it went into (an action, or a request or
        // answer it was forgotten from): the log is resumed only with the sealed list of what it names, or those values
        // would be written as they are from here on.
        let redacts = dir.join(format!("{name}.redacts"));
        let named_before = redacts.exists();
        if let Some(sealer) = sealer.as_deref() {
            let Some(kept_secrets) = read_kept(&kept, sealer) else { return None };
            if kept_secrets.is_empty() && (named_before || unrecoverable) {
                return None;
            }
            for (value, name) in kept_secrets {
                named = named.max(used_names(&name));
                if !secrets.iter().any(|(v, _)| *v == value) {
                    secrets.push((value, name));
                }
            }
        } else if kept.exists() || named_before || unrecoverable {
            // A missing or unavailable key must never turn an already-redacted session into a new unredacted capture.
            return None;
        }
        let file = open.open(&path).ok()?;
        // A log made before logs were this user's alone becomes so.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        let log = Self { file, pending: Vec::new(), secrets, named, count, path, kept, sealer, redacts, failed: false };
        // What an older log settled as it opened is named in the file from now on: marked as any secret named here is.
        // One the rewrite couldn't take out is still in the file, and the next open finds it there again.
        if replaced_now {
            let _ = create_private(&log.redacts).and_then(|mut f| f.write_all(b"1\n"));
        }
        // What an older log settled, or another handle kept, is sealed beside it from now on.
        log.keep_sealed();
        Some(log)
    }

    /// The session's log inside the configured capture directory
    /// (`UNBROWSE_CAPTURE_DIR`), if capture is on.
    pub fn open(session: &str) -> Option<Self> {
        Self::open_sealed(session, None)
    }

    /// [`Self::open`], with the secrets sealed beside the log by `sealer` ([`Self::open_in_sealed`]).
    pub fn open_sealed(session: &str, sealer: Option<Box<dyn Sealer>>) -> Option<Self> {
        let dir = PathBuf::from(std::env::var_os(CAPTURE_DIR_ENV)?);
        Self::open_in_sealed(&dir, session, sealer)
    }

    /// The session this log belongs to has ended: its sealed list of secrets is wiped, since no later process of
    /// that session will write to the log. This handle goes on naming what it knows, in memory only.
    pub fn end(&mut self) {
        self.sealer = None;
        let _ = std::fs::remove_file(&self.kept);
        // Ended on purpose, the list goes with the mark that a later process needs it. A process that stops without
        // ending (a crash, a restart) leaves both.
        let _ = std::fs::remove_file(&self.redacts);
    }

    /// Seals the secrets this log is naming beside it, together with any another handle on the log sealed there.
    /// Only ciphertext is written, through a private file moved into place, so the file is never part-written.
    fn keep_sealed(&self) {
        let Some(sealer) = self.sealer.as_deref() else { return };
        if self.secrets.is_empty() {
            return;
        }
        let Some(mut all) = read_kept(&self.kept, sealer) else { return };
        for pair in &self.secrets {
            if !all.iter().any(|(v, _)| *v == pair.0) {
                all.push(pair.clone());
            }
        }
        let Ok(plain) = serde_json::to_vec(&all) else { return };
        let Some(sealed) = sealer.seal(&plain) else { return };
        let tmp = self.kept.with_extension("secrets.sealing");
        let written = create_private(&tmp).and_then(|mut f| f.write_all(&sealed).and_then(|()| f.sync_all()));
        if written.and_then(|()| std::fs::rename(&tmp, &self.kept)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// The configured capture directory, if capture is on.
    pub fn configured_dir() -> Option<PathBuf> {
        std::env::var_os(CAPTURE_DIR_ENV).map(PathBuf::from)
    }

    pub fn write(&mut self, mut line: Value) {
        if !self.secrets.is_empty() {
            scrub_line(&mut line, &self.secrets);
        }
        self.follow_a_rewrite();
        if writeln!(self.file, "{line}").is_err() {
            self.failed = true;
        }
    }

    /// Whether a line failed to reach the file since the log was opened: then it is not a whole record.
    pub fn failed(&self) -> bool {
        self.failed
    }

    /// A rewrite puts a new file in the log's place, and another process can have the log open: the daemon and a walk
    /// write the same one. What this handle wrote from then on went into the old file, which nobody can read.
    #[cfg(unix)]
    fn follow_a_rewrite(&mut self) {
        use std::os::unix::fs::MetadataExt;
        let same = |a: &std::fs::Metadata, b: &std::fs::Metadata| (a.dev(), a.ino()) == (b.dev(), b.ino());
        let moved = matches!(
            (self.file.metadata(), std::fs::metadata(&self.path)),
            (Ok(ours), Ok(there)) if !same(&ours, &there)
        );
        if moved {
            if let Ok(file) = OpenOptions::new().append(true).open(&self.path) {
                self.file = file;
            }
        }
    }

    /// The file can't be replaced while it is open here, so no handle is left behind.
    #[cfg(not(unix))]
    fn follow_a_rewrite(&mut self) {}

    /// Keeps `value` out of the log from now on: it is written as `name`, or as
    /// the name it already has, or as `secret:<n>`. Returns the name. A value of
    /// a few characters is too short to tell from anything else a page sends,
    /// so one nobody named is named but not replaced. One the node names (a card's
    /// three-digit code, given with its reference) is a secret whatever its length,
    /// and is replaced where it stands on its own: not inside a longer number or word.
    pub fn keep_secret(&mut self, value: &str, name: Option<&str>) -> String {
        if let Some((_, named)) = self.secrets.iter().find(|(v, _)| v == value) {
            return named.clone();
        }
        self.named += 1;
        let _ = std::fs::write(&self.count, self.named.to_string());
        let named = name.map(String::from).unwrap_or_else(|| format!("secret:{}", self.named));
        if !value.is_empty() && (value.chars().count() >= MIN_SECRET || name.is_some()) {
            // Marked before the value is named anywhere: a process that resumes this log finds the mark, and won't
            // write without the list.
            let _ = create_private(&self.redacts).and_then(|mut f| f.write_all(b"1\n"));
            self.secrets.push((value.to_string(), named.clone()));
            self.keep_sealed();
        }
        named
    }

    /// A finished request: settle briefly (Chrome may report the request's
    /// cookies after the response finished), then write.
    pub fn queue(&mut self, request_id: &str) {
        if !self.pending.iter().any(|(id, _)| id == request_id) {
            self.pending.push((request_id.to_string(), Instant::now()));
        }
    }

    /// Request IDs ready to be written: settled since they were queued.
    pub fn settled(&mut self) -> Vec<String> {
        let now = Instant::now();
        let mut out = Vec::new();
        self.pending.retain(|(id, at)| {
            if now.duration_since(*at) >= SETTLE {
                out.push(id.clone());
                false
            } else {
                true
            }
        });
        out
    }

    /// Pending request IDs regardless of settle time (for a final flush).
    pub fn drain_pending(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending).into_iter().map(|(id, _)| id).collect()
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

/// Brings a log written before now up to date as it opens: a secret an action marked but the log still holds as
/// typed (written by an older engine) is named, in that action and in the requests that sent it, and the file is
/// rewritten. Returns the secrets it named, to keep naming them this session, how many names the log has used,
/// so a new one never repeats an old one, and whether the file now holds none as typed. A log can run to
/// gigabytes, so it is read a line at a time, and only a line that can hold a secret is parsed.
fn settle_past(path: &Path) -> (Vec<(String, String)>, usize, bool) {
    use std::io::{BufRead, BufReader};
    let lines = || File::open(path).ok().map(|f| BufReader::new(f).lines().map_while(Result::ok));
    let Some(all) = lines() else { return (Vec::new(), 0, true) };
    let (mut named, mut secrets) = (0, Vec::<(String, String)>::new());
    for line in all {
        named = named.max(used_names(&line));
        if !(line.contains("\"type\":\"action\"") && line.contains("\"secret\":true")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(value) = v.get("value").and_then(Value::as_str) else { continue };
        let is_name = value.starts_with("secret:") || value.starts_with("vault:");
        if !is_name && value.chars().count() >= MIN_SECRET && !secrets.iter().any(|(s, _)| s == value) {
            secrets.push((value.to_string(), String::new()));
        }
    }
    if secrets.is_empty() {
        return (secrets, named, true);
    }
    for (_, name) in secrets.iter_mut() {
        named += 1;
        *name = format!("secret:{named}");
    }
    let settled = rewrite(path, &secrets).is_ok();
    (secrets, named, settled)
}

/// The secrets sealed at `kept`, each with its name. Missing files mean an empty list; unreadable or unopenable files
/// are errors so a caller cannot resume without the redaction names.
fn read_kept(kept: &Path, sealer: &dyn Sealer) -> Option<Vec<(String, String)>> {
    let sealed = match std::fs::read(kept) {
        Ok(sealed) => sealed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let plain = sealer.open(&sealed)?;
    serde_json::from_slice::<Vec<(String, String)>>(&plain).ok()
}

/// True when an earlier pass already replaced a secret value with its name, leaving no source value to reconstruct if
/// the sealed secret list cannot be opened.
fn log_has_unrecoverable_secret_names(path: &Path) -> bool {
    use std::io::{BufRead, BufReader};
    let Ok(file) = File::open(path) else { return false };
    BufReader::new(file).lines().map_while(Result::ok).any(|line| {
        if !line.contains("\"type\":\"action\"") || !line.contains("\"secret\":true") {
            return false;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else { return false };
        value.get("value").and_then(Value::as_str).is_some_and(|v| v.starts_with("secret:") || v.starts_with("vault:"))
    })
}

/// A file only this user can read from its first byte: what is written to it is a copy of the log.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut open = OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let file = open.open(path)?;
    // A file an earlier try left keeps the mode it had through an open.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Rewrites the log with each of `secrets` said as its name, a line at a time, and replaces the file.
fn rewrite(path: &Path, secrets: &[(String, String)]) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader, BufWriter};
    let forms: Vec<String> = secrets.iter().flat_map(|(s, n)| forms(s, n)).map(|(f, _)| f).collect();
    let tmp = path.with_extension("jsonl.settling");
    let written = (|| -> std::io::Result<()> {
        let mut out = BufWriter::new(create_private(&tmp)?);
        for line in BufReader::new(File::open(path)?).lines() {
            let line = line?;
            let holds = forms.iter().any(|f| !f.is_empty() && line.contains(f.as_str()))
                || secrets.iter().any(|(s, _)| is_card_shaped(s) && (holds_digits_of(&line, s) || carries_digits(&line, s)));
            match serde_json::from_str::<Value>(&line) {
                Ok(mut v) if holds => {
                    scrub_line(&mut v, secrets);
                    writeln!(out, "{v}")?;
                }
                _ => writeln!(out, "{line}")?,
            }
        }
        out.flush()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path)
}

/// The highest `secret:<n>` a line says.
fn used_names(text: &str) -> usize {
    text.match_indices("secret:").filter_map(|(i, _)| text[i + 7..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).max().unwrap_or(0)
}

impl CaptureLog {
    /// Names `value` from now on and in everything the log already holds: for a value found to be secret after it
    /// was written (the learner sees a site only checks a code that was typed into a plain field). Returns its name.
    /// Whoever asks has said this value is a secret, so a short one is replaced too, where it stands on its own.
    pub fn forget(&mut self, value: &str) -> String {
        let name = self.keep_secret(value, Some(&format!("secret:{}", self.named + 1)));
        let Some((_, named)) = self.secrets.iter().find(|(v, _)| v == value).cloned() else { return name };
        let _ = self.file.flush();
        if rewrite(&self.path, &[(value.to_string(), named)]).is_ok() {
            if let Ok(f) = OpenOptions::new().append(true).open(&self.path) {
                self.file = f;
            }
        }
        name
    }
}

/// The shortest value kept out of the log by replacing it.
const MIN_SECRET: usize = 4;

/// Replaces each secret in the line with its name: as typed, and as a request
/// carries it (form-encoded, percent-encoded, or inside a JSON body). A
/// response is left whole: a site doesn't say a password back, and its answer
/// is the walk's data.
fn scrub(v: &mut Value, secrets: &[(String, String)]) {
    match v {
        Value::String(s) => {
            for (secret, name) in secrets {
                let short = secret.chars().count() < MIN_SECRET;
                for (form, named) in forms(secret, name) {
                    if !form.is_empty() && s.contains(&form) {
                        *s = if short { replace_standalone(s, &form, &named) } else { s.replace(&form, &named) };
                    }
                }
                if is_card_shaped(secret) && holds_digits_of(s, secret) {
                    *s = replace_digit_runs(s, secret, name);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| scrub(x, secrets)),
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                if k != "response" {
                    scrub(x, secrets);
                }
            }
        }
        _ => {}
    }
}

/// `text` with each `from` that stands on its own (no letter or digit just before or after it) said as `to`: a short
/// secret such as a card's code, kept out of the log without renaming the same digits inside a longer number.
fn replace_standalone(text: &str, from: &str, to: &str) -> String {
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(i) = text[at..].find(from) {
        let start = at + i;
        let end = start + from.len();
        out.push_str(&text[at..start]);
        if word(text[..start].chars().next_back()) || word(text[end..].chars().next()) {
            out.push_str(from);
        } else {
            out.push_str(to);
        }
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

/// Whether a secret is a run of digits as long as a card number (13 to 19): one a page may send back grouped, with
/// spaces, dashes or dots between its digits, so it is matched as its digits in order, however they are separated.
fn is_card_shaped(secret: &str) -> bool {
    (13..=19).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_digit())
}

/// What may stand between two digits of a grouped number: one separator, as typed or as a request encodes it.
const DIGIT_SEPARATORS: &[&str] = &["%20", "%2D", "%2d", "%2E", "%2e", "%C2%A0", "%c2%a0", "\\u00a0", "\\u0020", " ", "-", ".", "+", "\u{a0}"];

/// The end of `digits` said at `at` in `text`, each digit in order with at most one separator before the next, or
/// `None` when they aren't said there.
fn digit_run_at(text: &[u8], at: usize, digits: &[u8]) -> Option<usize> {
    let mut j = at;
    for (k, d) in digits.iter().enumerate() {
        if k > 0 {
            if let Some(sep) = DIGIT_SEPARATORS.iter().find(|sep| text[j..].starts_with(sep.as_bytes())) {
                j += sep.len();
            }
        }
        if text.get(j) != Some(d) {
            return None;
        }
        j += 1;
    }
    Some(j)
}

/// Whether `text` says the card-shaped `secret`'s digits on their own anywhere, grouped or not.
fn holds_digits_of(text: &str, secret: &str) -> bool {
    let (t, d) = (text.as_bytes(), secret.as_bytes());
    (0..t.len()).any(|i| t[i] == d[0] && (i == 0 || !t[i - 1].is_ascii_digit()) && digit_run_at(t, i, d).is_some_and(|end| !t.get(end).is_some_and(u8::is_ascii_digit)))
}

/// `text` with every place it says `secret`'s digits on their own, grouped or not, said as `name`.
fn replace_digit_runs(text: &str, secret: &str, name: &str) -> String {
    let (t, d) = (text.as_bytes(), secret.as_bytes());
    let mut out: Vec<u8> = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        if t[i] == d[0] && (i == 0 || !t[i - 1].is_ascii_digit()) {
            if let Some(end) = digit_run_at(t, i, d).filter(|end| !t.get(*end).is_some_and(u8::is_ascii_digit)) {
                out.extend_from_slice(name.as_bytes());
                i = end;
                continue;
            }
        }
        out.push(t[i]);
        i += 1;
    }
    // Only whole ASCII runs (and whole separators) were cut, so what is left is the text's own UTF-8.
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// A line said with each secret as its name ([`scrub`]), and then, for a card-shaped secret, wherever its digits are
/// still carried: in a string that says them under an encoding or with any characters between them (base64, hex,
/// percent, `\\u` and HTML escapes, full-width digits, `4242..4242//4242`), that whole string is the card's name; and
/// where the page split the number across the line's strings (two fields of a body, an address and a body), every run
/// of digits in each string of the line is. A checkout request that carries a card loses its other numbers with it;
/// nothing of the card stays.
fn scrub_line(v: &mut Value, secrets: &[(String, String)]) {
    scrub(v, secrets);
    for (secret, name) in secrets.iter().filter(|(s, _)| is_card_shaped(s)) {
        name_carriers(v, secret, name);
        let mut digits = String::new();
        each_string(v, &mut |s| digits.push_str(&digits_in(s)));
        if digits.contains(secret.as_str()) {
            each_string_mut(v, &mut |s| *s = replace_all_digit_runs(s, name));
        }
    }
}

/// Every string of a line a request carries (never the response, which is the walk's data).
fn each_string(v: &Value, f: &mut dyn FnMut(&str)) {
    match v {
        Value::String(s) => f(s),
        Value::Array(a) => a.iter().for_each(|x| each_string(x, f)),
        Value::Object(m) => m.iter().filter(|(k, _)| *k != "response").for_each(|(_, x)| each_string(x, f)),
        _ => {}
    }
}

fn each_string_mut(v: &mut Value, f: &mut dyn FnMut(&mut String)) {
    match v {
        Value::String(s) => f(s),
        Value::Array(a) => a.iter_mut().for_each(|x| each_string_mut(x, f)),
        Value::Object(m) => m.iter_mut().filter(|(k, _)| *k != "response").for_each(|(_, x)| each_string_mut(x, f)),
        _ => {}
    }
}

/// Says as `name` every string of `v` that carries `secret`'s digits on its own ([`carries_digits`]).
fn name_carriers(v: &mut Value, secret: &str, name: &str) {
    each_string_mut(v, &mut |s| {
        if s.as_str() != name && carries_digits(s, secret) {
            *s = name.to_string();
        }
    });
}

/// The ASCII digit a character writes, if it writes one: an ASCII digit, a full-width one (U+FF10..), or one of the
/// mathematical digit styles (U+1D7CE..). Other scripts' digits are not read: see `SECURITY.md`.
fn digit_of(c: char) -> Option<char> {
    let cp = c as u32;
    let value = match cp {
        0x30..=0x39 => cp - 0x30,
        0xFF10..=0xFF19 => cp - 0xFF10,
        0x1D7CE..=0x1D7FF => (cp - 0x1D7CE) % 10,
        _ => return None,
    };
    char::from_digit(value, 10)
}

/// The digits `text` writes, in order, whatever stands between them.
fn digits_in(text: &str) -> String {
    text.chars().filter_map(digit_of).collect()
}

/// `text` with every run of digits (as [`digit_of`] reads them) said as `name`.
fn replace_all_digit_runs(text: &str, name: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if digit_of(c).is_some() {
            if !in_run {
                out.push_str(name);
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

/// The ways a string may carry text: as itself; percent-decoded; with `\\uXXXX` escapes and HTML numeric entities
/// decoded; and every run of base64 (16 characters or more) or hex (26 or more) in it decoded.
fn decodings(text: &str) -> Vec<String> {
    use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
    use base64::Engine;
    let mut out = vec![text.to_string()];
    out.push(percent_decoded(text));
    out.push(unescape(text));
    let runs = |keep: fn(char) -> bool, shortest: usize| -> Vec<String> {
        let mut found = Vec::new();
        let mut cur = String::new();
        for c in text.chars().chain(std::iter::once('\0')) {
            if keep(c) {
                cur.push(c);
            } else {
                if cur.len() >= shortest {
                    found.push(std::mem::take(&mut cur));
                }
                cur.clear();
            }
        }
        found
    };
    // A run of base64 ends at its padding; it may start a character or three into a word (`tokenNDI0…`), so it is
    // read from each of the four places a group of four can start.
    for run in runs(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'), 16) {
        for skip in 0..4 {
            let Some(at) = run.get(skip..) else { continue };
            let at = &at[..at.len() - at.len() % 4 + if at.len() % 4 >= 2 { at.len() % 4 } else { 0 }];
            for engine in [&STANDARD_NO_PAD, &URL_SAFE_NO_PAD] {
                if let Ok(bytes) = engine.decode(at) {
                    out.push(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
        }
    }
    for run in runs(|c| c.is_ascii_hexdigit(), 26) {
        let even = &run[..run.len() & !1];
        let bytes: Option<Vec<u8>> = (0..even.len()).step_by(2).map(|i| u8::from_str_radix(&even[i..i + 2], 16).ok()).collect();
        if let Some(bytes) = bytes {
            out.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    out
}

/// `text` with each `%XX` said as the byte it writes.
fn percent_decoded(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |x: u8| (x as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `text` with `\\uXXXX` escapes and HTML numeric entities (`&#52;`, `&#x34;`) said as the characters they write.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        let (hex, len) = if rest.starts_with("\\u") && rest.len() >= 6 {
            (u32::from_str_radix(&rest[2..6], 16).ok(), 6)
        } else if let Some(entity) = rest.strip_prefix("&#").and_then(|r| r.find(';').filter(|&e| e <= 8).map(|e| &r[..e])) {
            let value = match entity.strip_prefix(['x', 'X']) {
                Some(h) => u32::from_str_radix(h, 16).ok(),
                None => entity.parse().ok(),
            };
            (value, entity.len() + 3)
        } else {
            (None, 0)
        };
        match hex.and_then(char::from_u32) {
            Some(ch) => {
                out.push(ch);
                rest = &rest[len..];
            }
            None => {
                out.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    out
}

/// Whether `text`, under any of its [`decodings`], writes the card-shaped `secret`'s digits in order with nothing
/// but other characters between them.
fn carries_digits(text: &str, secret: &str) -> bool {
    text.chars().filter_map(digit_of).count() + text.len() / 2 >= secret.len() && decodings(text).iter().any(|d| digits_in(d).contains(secret))
}

/// A secret and its name the ways a request writes them.
fn forms(secret: &str, name: &str) -> Vec<(String, String)> {
    let form = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let json = |s: &str| {
        let q = Value::String(s.to_string()).to_string();
        q[1..q.len() - 1].to_string()
    };
    let mut out = vec![(secret.to_string(), name.to_string())];
    // A card's number the page regrouped (fours, or four-six-rest, with a space, a dash or a dot): its forms too, so
    // whatever reads the forms (the rewrite's look at each line, the plain replace) knows it by its groupings beside the
    // digit-sequence match ([`scrub_line`]).
    let mut written = vec![secret.to_string()];
    if is_card_shaped(secret) {
        written.extend(card_groupings(secret));
    }
    for w in &written {
        for (a, b) in [(w.clone(), name.to_string()), (form(w), form(name)), (form(w).replace('+', "%20"), form(name).replace('+', "%20")), (json(w), json(name))] {
            if !out.iter().any(|(x, _)| *x == a) {
                out.push((a, b));
            }
        }
    }
    out
}

/// The ways a page writes a card number in groups: in fours, and as four, six and the rest, each with a space, a dash
/// or a dot between the groups. Derived from the number's length, not from any issuer.
fn card_groupings(number: &str) -> Vec<String> {
    let cut = |sizes: &[usize]| {
        let mut parts = Vec::new();
        let mut at = 0;
        for &n in sizes.iter().chain(std::iter::repeat(&4)) {
            if at >= number.len() {
                break;
            }
            let end = (at + n).min(number.len());
            parts.push(&number[at..end]);
            at = end;
            if sizes.len() == 2 && parts.len() == 2 {
                parts.push(&number[at..]);
                break;
            }
        }
        parts
    };
    let mut all = Vec::new();
    for parts in [cut(&[4]), cut(&[4, 6])] {
        for sep in [" ", "-", "."] {
            let g = parts.join(sep);
            if g != number && !all.contains(&g) {
                all.push(g);
            }
        }
    }
    all
}

pub fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log() -> (CaptureLog, PathBuf) {
        let dir = std::env::temp_dir().join(format!("capture-secrets-{}-{}", std::process::id(), now_secs()));
        (CaptureLog::open_in(&dir, "s").unwrap(), dir.join("s.jsonl"))
    }

    /// The file holds the name wherever the password went: in the action, in a
    /// form body, in a JSON body, in a URL. The answer the site gave is left as it was.
    #[test]
    fn a_secret_is_written_as_its_name_wherever_it_goes() {
        let (mut log, path) = log();
        let pw = "p@ss word\"1";
        assert_eq!(log.keep_secret(pw, Some("vault:example.com:me")), "vault:example.com:me");
        assert_eq!(log.keep_secret("hunter22", None), "secret:2");
        assert_eq!(log.keep_secret("hunter22", None), "secret:2", "a secret keeps its name");
        let form: String = url::form_urlencoded::byte_serialize(pw.as_bytes()).collect();
        log.write(serde_json::json!({ "type": "action", "action": "fill", "value": pw }));
        log.write(serde_json::json!({ "type": "exchange", "entry": {
            "request": { "url": format!("https://example.com/login?pw={form}"),
                         "postData": { "text": format!("user=me&password={form}&code=hunter22") } },
            "response": { "content": { "text": "hunter22 is in the answer" } } } }));
        log.write(serde_json::json!({ "type": "exchange", "entry": {
            "request": { "postData": { "text": serde_json::json!({ "password": pw }).to_string() } } } }));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("p@ss") && !text.contains("p%40ss"), "{text}");
        assert!(text.contains("vault:example.com:me") && text.contains("vault%3Aexample.com%3Ame"));
        assert!(text.contains("code=secret:2"));
        assert!(text.contains("hunter22 is in the answer"), "the response is the walk's data");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    /// A capture log holds a signed-in session's traffic: it is the owner's alone, 0600, in a folder that is too, even
    /// one an earlier version made open to all.
    #[cfg(unix)]
    #[test]
    fn a_capture_log_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("browse");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut log = CaptureLog::open_in(&dir, "site").unwrap();
        log.write(serde_json::json!({ "type": "action", "action": "open" }));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("site.jsonl")), 0o600);
    }

    /// A log an older engine wrote, with a password as typed, holds only its name once it opens again, and the
    /// names go on from the last one it used.
    #[test]
    fn a_past_log_is_settled_when_it_opens() {
        let dir = std::env::temp_dir().join(format!("capture-past-{}-{}", std::process::id(), now_secs()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let old = [
            // A name an older engine used, in a line it can't be recovered from: the names go on after it.
            serde_json::json!({ "type": "exchange", "entry": { "request": { "url": "https://x.example/?t=secret:1" } } }),
            serde_json::json!({ "type": "action", "action": "fill", "value": "hunter2-old", "secret": true }),
            serde_json::json!({ "type": "action", "action": "fill", "value": "a search", "secret": false }),
            serde_json::json!({ "type": "exchange", "entry": { "request": { "postData": { "text": "q=a+search&pw=hunter2-old" } } } }),
        ];
        std::fs::write(&path, old.iter().map(|v| format!("{v}\n")).collect::<String>()).unwrap();
        let mut log = CaptureLog::open_in(&dir, "s").unwrap();
        assert_eq!(log.keep_secret("a new one", None), "secret:3", "names go on from the log's last");
        log.write(serde_json::json!({ "type": "exchange", "entry": { "request": { "url": "https://x.example/?pw=hunter2-old" } } }));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("hunter2-old"), "{text}");
        assert!(text.contains("pw=secret:2") && text.contains("q=a+search"), "{text}");
        assert_eq!(text.lines().count(), 5, "nothing lost, the new line kept");
    }

    /// A value found secret after it was written (a code typed into a plain field) leaves the whole log, and the
    /// log keeps going to the same file.
    #[test]
    fn a_value_found_secret_later_leaves_the_log() {
        let (mut log, path) = log();
        log.write(serde_json::json!({ "type": "action", "action": "fill", "value": "553201", "secret": false }));
        log.write(serde_json::json!({ "type": "exchange", "entry": { "request": { "postData": { "text": "code=553201" } },
                                                                       "response": { "content": { "text": "ok" } } } }));
        assert_eq!(log.forget("553201"), "secret:1");
        log.write(serde_json::json!({ "type": "exchange", "entry": { "request": { "url": "https://x.example/?c=553201" } } }));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("553201"), "{text}");
        assert_eq!(text.matches("secret:1").count(), 3, "{text}");
    }

    /// A card's three-digit code the node names is kept out of the log wherever it stands on its own, as typed and as a
    /// request sends it, while the same digits inside a longer number or word stay as they were.
    #[test]
    fn a_named_three_digit_code_never_reaches_the_log() {
        let (mut log, path) = log();
        assert_eq!(log.keep_secret("737", Some("vault:card:visa:cvv")), "vault:card:visa:cvv");
        log.write(serde_json::json!({ "type": "action", "action": "fill", "value": "737" }));
        log.write(serde_json::json!({ "type": "exchange", "entry": { "request": {
            "url": "https://pay.example/charge?order=17370&cvc=737",
            "postData": { "text": serde_json::json!({ "cvc": "737", "sku": "a737b" }).to_string() } } } }));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("cvc=737") && !text.contains(r#"\"cvc\":\"737\""#) && !text.contains(r#""value":"737""#), "{text}");
        assert!(text.contains("order=17370") && text.contains("a737b"), "the digits inside other values stay: {text}");
        assert!(text.contains("cvc=vault:card:visa:cvv"), "{text}");
    }

    /// A short value is named, but too short to replace without hiding what else a page sends.
    /// A password the first open couldn't rewrite out of a log stays a job to do: the next open tries again.
    #[test]
    fn a_log_that_couldnt_be_settled_is_settled_by_the_next_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, "{\"type\":\"action\",\"secret\":true,\"value\":\"hunter22\"}\n").unwrap();
        // A folder where the rewrite's temporary file goes: the rewrite can't start.
        let blocked = path.with_extension("jsonl.settling");
        std::fs::create_dir(&blocked).unwrap();
        drop(CaptureLog::open_in(dir.path(), "s").unwrap());
        assert!(std::fs::read_to_string(&path).unwrap().contains("hunter22"));

        std::fs::remove_dir(&blocked).unwrap();
        drop(CaptureLog::open_in(dir.path(), "s").unwrap());
        assert!(!std::fs::read_to_string(&path).unwrap().contains("hunter22"), "the password stayed in the log");
    }

    /// The copy a rewrite makes is the whole log, so it is this user's alone before anything is written to it, even
    /// over a file an earlier try left readable.
    #[cfg(unix)]
    #[test]
    fn a_rewrites_copy_is_private_from_its_first_byte() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("s.jsonl.settling");
        std::fs::write(&tmp, "left by an earlier try").unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();
        let file = create_private(&tmp).unwrap();
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(file.metadata().unwrap().len(), 0);
    }

    /// A short value found to be secret later is replaced, not only given a name that nothing in the log says.
    /// A rewrite replaces the file, and the daemon and a walk can both have it open: a handle on the old one would write
    /// on into a file nobody reads.
    #[test]
    fn a_line_written_after_a_rewrite_reaches_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let mut rewriting = CaptureLog::open_in(dir.path(), "s").unwrap();
        let mut other = CaptureLog::open_in(dir.path(), "s").unwrap();
        rewriting.write(serde_json::json!({ "typed": "hunter22secret" }));
        rewriting.forget("hunter22secret");
        other.write(serde_json::json!({ "said": "after the rewrite" }));
        let log = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        assert!(log.contains("after the rewrite"), "{log}");
        assert!(!log.contains("hunter22secret"), "{log}");
    }

    #[test]
    fn a_short_value_found_secret_later_leaves_the_log() {
        let (mut log, path) = log();
        log.write(serde_json::json!({ "type": "action", "action": "fill", "value": "735" }));
        log.write(serde_json::json!({ "type": "action", "action": "fill", "value": "order 17350" }));
        let name = log.forget("735");
        log.write(serde_json::json!({ "type": "action", "action": "fill", "value": "735" }));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"735\""), "{text}");
        assert_eq!(text.matches(&name).count(), 2, "{text}");
        assert!(text.contains("order 17350"), "the same digits inside a longer number stay: {text}");
    }

    /// A stand-in for the CLI's AES-GCM: a keyed byte stream, so a test can tell sealed bytes from plain ones and a
    /// wrong key from the right one without a cipher in core.
    struct Keyed(u8);

    impl Sealer for Keyed {
        fn seal(&self, plain: &[u8]) -> Option<Vec<u8>> {
            let mut out = vec![self.0];
            out.extend(plain.iter().enumerate().map(|(i, b)| b ^ self.0.wrapping_add(i as u8)));
            Some(out)
        }
        fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
            let (key, body) = sealed.split_first()?;
            (*key == self.0).then(|| body.iter().enumerate().map(|(i, b)| b ^ self.0.wrapping_add(i as u8)).collect())
        }
    }

    /// A log whose secrets were named only in requests and answers (a value the node asked it to forget, never an
    /// action marked secret) is resumed only with its sealed list, as one with secret actions is: without it the next
    /// process would write those values as they are.
    #[test]
    fn a_capture_with_only_forgotten_values_refuses_to_resume_without_its_list() {
        let dir = tempfile::tempdir().unwrap();
        let mut before = sealed(dir.path());
        before.forget("Owner-Typed-77");
        before.write(serde_json::json!({ "type": "request", "url": "https://shop.example/login", "body": "pw=Owner-Typed-77" }));
        drop(before);
        let log = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        assert!(!log.contains("Owner-Typed-77") && !log.contains("\"type\":\"action\""), "{log}");
        // With the list it resumes and goes on naming the value.
        let mut again = sealed(dir.path());
        again.write(serde_json::json!({ "type": "request", "body": "pw=Owner-Typed-77" }));
        drop(again);
        assert!(!std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap().contains("Owner-Typed-77"));
        // Without it, sealed or not, it doesn't.
        std::fs::remove_file(dir.path().join("s.secrets")).unwrap();
        assert!(CaptureLog::open_in_sealed(dir.path(), "s", Some(Box::new(Keyed(0x5a)))).is_none());
        assert!(CaptureLog::open_in(dir.path(), "s").is_none());
        // A session ended on purpose drops its list and the mark with it.
        let other = tempfile::tempdir().unwrap();
        let mut ended = sealed(other.path());
        ended.forget("Owner-Typed-78");
        ended.end();
        drop(ended);
        assert!(CaptureLog::open_in_sealed(other.path(), "s", Some(Box::new(Keyed(0x5a)))).is_some());
    }

    /// A card number goes out of the record however the page groups it before sending: spaced, dashed or dotted in
    /// fours, as 4-6-5, or as a request encodes the space.
    #[test]
    fn a_card_number_is_named_in_the_capture_however_it_is_grouped() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = CaptureLog::open_in(dir.path(), "s").unwrap();
        log.keep_secret("378282246310005", Some("vault:card:amex:number"));
        log.keep_secret("4242424242424242", Some("vault:card:visa:number"));
        for body in [
            "pan=4242 4242 4242 4242",
            "pan=4242-4242-4242-4242",
            "pan=4242.4242.4242.4242",
            "pan=4242+4242+4242+4242",
            "pan=4242%204242%204242%204242",
            r#"{"pan":"3782 822463 10005"}"#,
            "pan=3782-822463-10005&x=1",
        ] {
            log.write(serde_json::json!({ "type": "request", "body": body }));
        }
        let text = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        for digits in ["4242 4242", "4242-4242", "4242.4242", "4242+4242", "4242%204242", "822463", "3782"] {
            assert!(!text.contains(digits), "{digits}: {text}");
        }
        // Named as the reference, or as its form-encoding where the page form-encoded the number.
        let named = |card: &str| text.lines().filter(|l| l.contains(&format!("vault:card:{card}:number")) || l.contains(&format!("vault%3Acard%3A{card}%3Anumber"))).count();
        assert_eq!(named("visa"), 5, "{text}");
        assert_eq!(named("amex"), 2, "{text}");
    }

    /// A card number a page transforms before sending leaves the record all the same: encoded (base64, hex, percent,
    /// `\u` and HTML escapes), written in full-width digits, split by any characters, or split across the fields of
    /// one request (two values of a body, the address and the body). A request without it keeps its numbers.
    #[test]
    fn capture_redacts_transformed_card_values() {
        use base64::Engine;
        let pan = "4242424242424242";
        let b64 = base64::engine::general_purpose::STANDARD.encode(pan);
        let hex: String = pan.bytes().map(|b| format!("{b:02x}")).collect();
        let pct: String = pan.bytes().map(|b| format!("%{b:02X}")).collect();
        let uni: String = pan.chars().map(|c| format!("\\u{:04x}", c as u32)).collect();
        let html: String = pan.chars().map(|c| format!("&#{};", c as u32)).collect();
        let wide: String = pan.chars().map(|c| char::from_u32(0xFF10 + c.to_digit(10).unwrap()).unwrap()).collect();
        let bodies = [
            format!("token={b64}"),
            format!("{{\"p\":\"{hex}\"}}"),
            format!("pan={pct}"),
            format!("{{\"p\":\"{uni}\"}}"),
            format!("<v>{html}</v>"),
            format!("pan={wide}"),
            "pan=4242..4242//4242__4242".to_string(),
            r#"{"first":"42424242","second":"42424242"}"#.to_string(),
        ];
        let dir = tempfile::tempdir().unwrap();
        let mut log = CaptureLog::open_in(dir.path(), "s").unwrap();
        log.keep_secret(pan, Some("vault:card:visa:number"));
        for body in &bodies {
            log.write(serde_json::json!({ "type": "request", "url": "https://pay.example/charge?n=12", "body": body }));
        }
        // Split between the address and the body of one request.
        log.write(serde_json::json!({ "type": "request", "url": "https://pay.example/charge?a=42424242", "body": "b=42424242" }));
        log.write(serde_json::json!({ "type": "request", "url": "https://pay.example/cart?n=12", "body": "qty=3" }));
        drop(log);
        let text = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        for (n, line) in text.lines().enumerate().take(bodies.len() + 1) {
            let digits: String = line.chars().filter_map(super::digit_of).collect();
            assert!(!digits.contains(pan), "line {n} still carries the card: {line}");
            for leak in [b64.as_str(), hex.as_str(), pct.as_str(), wide.as_str(), "42424242"] {
                assert!(!line.contains(leak), "line {n}: {line}");
            }
            assert!(line.contains("vault:card:visa:number"), "line {n}: {line}");
        }
        let last = text.lines().last().unwrap();
        assert!(last.contains("qty=3") && last.contains("n=12"), "a request without the card keeps its numbers: {last}");
    }

    /// A card number a page regrouped and sent before the log knew it as a secret leaves the local walk log once it is
    /// named: the rewrite finds the line by the number's forms (every grouping of it) and names it, however it is
    /// grouped. Nothing of the digits stays in the file.
    #[test]
    fn the_local_walk_log_never_keeps_a_regrouped_card_number() {
        let pan = "378282246310005";
        let forms_of: Vec<String> = super::forms(pan, "vault:card:amex:number").into_iter().map(|(f, _)| f).collect();
        for grouped in ["3782 822463 10005", "3782-822463-10005", "3782.8224.6310.005", "3782+822463+10005"] {
            assert!(forms_of.iter().any(|f| f == grouped), "{grouped}: {forms_of:?}");
        }
        let dir = tempfile::tempdir().unwrap();
        let mut log = CaptureLog::open_in(dir.path(), "s").unwrap();
        for body in ["pan=3782 822463 10005", "pan=3782-8224-6310-005", "{\"pan\":\"3782.822463.10005\"}", "pan=3782%20822463%2010005"] {
            log.write(serde_json::json!({ "type": "request", "body": body }));
        }
        log.keep_secret(pan, Some("vault:card:amex:number"));
        log.forget(pan);
        drop(log);
        let text = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        let digits: String = text.chars().filter_map(super::digit_of).collect();
        assert!(!digits.contains(pan), "{text}");
        for leak in ["822463", "8224", "10005"] {
            assert!(!text.contains(leak), "{leak}: {text}");
        }
        let named = text.lines().filter(|l| l.contains("vault:card:amex:number") || l.contains("vault%3Acard%3Aamex%3Anumber") || l.contains("secret:")).count();
        assert_eq!(named, 4, "every line names it: {text}");
    }

    fn sealed(dir: &Path) -> CaptureLog {
        CaptureLog::open_in_sealed(dir, "s", Some(Box::new(Keyed(0x5a)))).unwrap()
    }

    /// A password typed before the daemon restarts is still named in what the log is sent after it: the new process
    /// reads the list back from its sealed file.
    #[test]
    fn a_secret_sent_before_a_restart_is_scrubbed_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut before = sealed(dir.path());
        assert_eq!(before.keep_secret("hunter2-before", None), "secret:1");
        before.write(serde_json::json!({ "type": "action", "action": "fill", "value": "secret:1", "secret": true }));
        // The process goes without ending the session: a crash, or a daemon idling out.
        drop(before);

        let mut after = sealed(dir.path());
        after.write(serde_json::json!({ "type": "exchange", "entry": { "request": {
            "postData": { "text": "user=me&password=hunter2-before" } } } }));
        assert_eq!(after.keep_secret("another-one", None), "secret:2", "names go on from the last one kept");
        let text = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        assert!(!text.contains("hunter2-before"), "{text}");
        assert!(text.contains("password=secret:1"), "{text}");
    }

    /// The kept list is ciphertext, this user's alone, and only its key opens it.
    #[test]
    fn the_kept_secrets_file_holds_no_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = sealed(dir.path());
        log.keep_secret("hunter2-sealed", Some("vault:example.com:me"));
        let kept = std::fs::read(dir.path().join("s.secrets")).unwrap();
        let text = String::from_utf8_lossy(&kept);
        assert!(!text.contains("hunter2-sealed") && !text.contains("vault:example.com"), "{text}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("s.secrets")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(Keyed(0x11).open(&kept).is_none(), "another key opens nothing");
        assert!(CaptureLog::open_in_sealed(dir.path(), "s", Some(Box::new(Keyed(0x11)))).is_none(), "a wrong key cannot start a capture without its redaction list");
        assert!(CaptureLog::open_in(dir.path(), "s").is_none(), "a capture with prior secrets cannot resume without a sealer");
        assert!(!dir.path().join("s.secrets.sealing").exists());
    }

    #[test]
    fn a_capture_refuses_to_resume_when_its_sealed_redaction_list_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut before = sealed(dir.path());
        before.keep_secret("hunter2-missing", None);
        before.write(serde_json::json!({ "type": "action", "action": "fill", "value": "secret:1", "secret": true }));
        drop(before);
        std::fs::remove_file(dir.path().join("s.secrets")).unwrap();
        assert!(CaptureLog::open_in_sealed(dir.path(), "s", Some(Box::new(Keyed(0x5a)))).is_none());
    }

    /// The session ending wipes the kept list, and a later open of its log starts with none.
    #[test]
    fn ending_the_session_removes_the_kept_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = sealed(dir.path());
        log.keep_secret("hunter2-ended", None);
        assert!(dir.path().join("s.secrets").exists());
        log.end();
        assert!(!dir.path().join("s.secrets").exists());
        drop(log);
        assert!(sealed(dir.path()).secrets.is_empty());
    }

    #[test]
    fn a_short_value_is_named_but_not_replaced() {
        let (mut log, path) = log();
        assert_eq!(log.keep_secret("12", None), "secret:1");
        assert_eq!(log.keep_secret("longer one", None), "secret:2", "names never repeat");
        log.write(serde_json::json!({ "type": "action", "value": "page 12" }));
        assert!(std::fs::read_to_string(&path).unwrap().contains("page 12"));
    }
}
