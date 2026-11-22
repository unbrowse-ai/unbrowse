//! The expressions a way may be. The list is closed: a body that names anything else does not read, so a node never
//! runs part of a body it only half understands.
//!
//! An expression has sources (a fixed text, a slot, a cookie, a place in an earlier reply, the clock) and operations
//! over them (join, slice, write a certain way, hash). Each is generic and is data: none names a site, and a body
//! made of them carries no code. The one exception is [`Expr::Program`], a program written for one value, which is
//! the route's private data, runs only where the node says a site's code may run (`learn.isolate`) and is never
//! shared.

use serde::{Deserialize, Serialize};

use crate::body::Place;
use crate::fill::Built;

/// How one value of a request is made.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Expr {
    // Sources.
    /// A fixed text: the same for every caller and every call.
    Text { is: String },
    /// What the caller wrote in a slot. With nothing written it is `or`, what the walk sent here; with neither, an
    /// `optional` use goes unsent (a filter the walk never set) and any other stops the call.
    Slot {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        or: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        optional: bool,
    },
    /// What the caller wrote in a slot, and nothing in its place: a piece of their value cannot be cut from a value
    /// they did not give.
    Given { name: String },
    /// A value of the session, by cookie name. A jar that does not hold it sends nothing, as a browser omits a
    /// cookie it does not have. `here`: only a cookie the step's own host would be sent.
    Cookie {
        name: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        here: bool,
    },
    /// A value the page keeps in its storage, by key.
    Stored { area: Area, key: String },
    /// A place in an earlier step's reply.
    Read { step: String, at: At },
    /// A place in the item of a list in an earlier step's reply that fits: `list` is where the list sits in the
    /// reply's JSON (a pointer), `fits` what the item must hold, `take` the place inside the item that is sent (a
    /// pointer; empty for the item itself, when it is a text). The first item that fits, in the list's order, as a
    /// page's own code takes the first match of its list, and the list's order is the site's own ranking. No item that
    /// fits stops the call, as a value a reply was to hold and did not.
    Pick { step: String, list: String, fits: Fits, take: String },
    /// An id the page made up from the clock: read anew for each call, and the same in every step of that call.
    Fresh { id: String, clock: Clock },
    /// A text written from the clock and from chance: `{ms}` and `{s}` are the time now, `{dN}` is N random digits.
    Stamp { form: String },
    /// A fact about the file the caller names in a slot.
    File { slot: String, fact: FileFact },
    /// A part of this same request as it is sent: what a signature is made over.
    Sent { part: Sent },
    /// Nothing is sent here. With `after`, only once that step has been answered: a value its reply was to hold and
    /// did not is left out, where one never asked for is a call that cannot be made.
    Nothing {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
    },

    // Operations.
    /// The parts one after another, `with` between them.
    Join {
        parts: Vec<Expr>,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        with: String,
    },
    /// `len` characters of a value, from character `from`.
    Slice { of: Box<Expr>, from: usize, len: usize },
    /// The value `of` makes, or `or` where it makes none: a session's cookie written into a longer value is the
    /// caller's own, and a jar that holds none writes nothing in its place (a page's code that has no id yet).
    Else { of: Box<Expr>, or: String },
    /// The value split at `split`, and the piece at `index`, counted from zero.
    Piece { of: Box<Expr>, split: String, index: usize },
    /// The value written the way its place writes it.
    Written { of: Box<Expr>, how: How },
    /// The value encoded again.
    Wrapped { of: Box<Expr>, how: Wrap },
    /// The text an encoded value holds.
    Unwrapped { of: Box<Expr>, how: Wrap },
    /// A longer value with `now` where the walk's `was` stood whole. With `inside`, the longer value is a text encoded
    /// again: `now` goes into the text and the text is encoded back. A `now` the caller did not give leaves the value
    /// as it is. So does a value read from an earlier reply that already says `now`: the site wrote it for this
    /// call. The walk's own text is never left for saying `now` somewhere else (a key of the JSON the word rides
    /// in): the caller's word goes where the walk's stood.
    Swap {
        within: Box<Expr>,
        was: String,
        now: Box<Expr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inside: Option<Wrap>,
    },
    /// A digest of the value, in small hexadecimal.
    Hash { algo: Algo, of: Box<Expr> },
    /// A keyed digest of the value, in small hexadecimal.
    Hmac { algo: Algo, key: Box<Expr>, of: Box<Expr> },

    // Functions.
    /// A program written for this one value and proved on the walk's own sightings (`learn.derivation`). It is given
    /// the request as it stands. The route's private data: a body that holds one is never shared.
    Program {
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        evidence: Option<serde_json::Value>,
    },

    // Operations added after the first list. An older node does not read a body that holds one, and the route stands
    // as its graph there (`store::Route::body`).
    /// The value read as a date, a time or a number written one way (`read`), and written another (`write`): the
    /// caller's value in the site's format (`format`). A value that does not read so stops the call: the site would
    /// be sent another date than the caller's.
    Format { of: Box<Expr>, read: crate::format::Pattern, write: crate::format::Pattern },
    /// A place in the record of a table the site's own script ships that fits, as [`Expr::Pick`] takes an item of a
    /// reply's list: the caller says a city, and the request sends its code. `rows` is the table as the script holds
    /// it, kept as fixed data (the site ships it to everyone, as a digest's constant), and the script's hash is on the
    /// step's test, so a deploy that changes it is seen. The first record that fits, in the table's order; none that
    /// fits stops the call, as a word the site does not list.
    Lookup { rows: Vec<serde_json::Value>, fits: Fits, take: String },
    /// A program of the site's own whose reads of the page's world are holes of their own: each thing it read when it
    /// ran in the page (a cookie, a stored key, the browser's name) is made by its own expression at call time from a
    /// source the node holds, and handed to the program as the page would have had it. So the program reads what the
    /// node's session holds, and a read the node cannot answer is known before the program runs. Private, as
    /// [`Expr::Program`] is.
    ProgramReading {
        source: String,
        reads: Vec<Feed>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        evidence: Option<serde_json::Value>,
    },

    // Searches.
    /// A value the page searched for rather than made (a proof of work): the least count from zero, in decimal, such
    /// that the `algo` digest of `before`, the count and `after` starts with `zeros` zero hexadecimal digits. Any such
    /// count is one the condition accepts, so the evaluator finds its own; the work is bounded ([`most_tries`]), and a
    /// search past the bound needs the page's own code (rung 2).
    Solve {
        algo: Algo,
        before: Box<Expr>,
        #[serde(default = "nothing_text", skip_serializing_if = "is_nothing_text")]
        after: Box<Expr>,
        zeros: u32,
    },
}

fn nothing_text() -> Box<Expr> {
    Box::new(Expr::text(""))
}

fn is_nothing_text(e: &Expr) -> bool {
    matches!(e, Expr::Text { is } if is.is_empty())
}

/// The most zeros a search is held to: past six hexadecimal digits the work is more than a call waits for.
pub const MOST_ZEROS: u32 = 6;

/// How many counts a search for `zeros` leading zeros tries before it stops: 64 times the number it takes on average,
/// so a search fails by chance once in e^64.
pub fn most_tries(zeros: u32) -> u64 {
    16u64.saturating_pow(zeros.min(MOST_ZEROS)).saturating_mul(64)
}

/// How many zero hexadecimal digits `digest` opens with.
pub fn leading_zeros(digest: &str) -> u32 {
    digest.chars().take_while(|c| *c == '0').count() as u32
}

/// The least count from zero whose digest, between `before` and `after`, opens with `zeros` zeros, within
/// [`most_tries`]. None past the bound, or for more zeros than [`MOST_ZEROS`].
pub fn solve(algo: Algo, before: &str, after: &str, zeros: u32) -> Option<u64> {
    if zeros > MOST_ZEROS {
        return None;
    }
    (0..most_tries(zeros)).find(|n| leading_zeros(&algo.hash(&format!("{before}{n}{after}"))) >= zeros)
}

/// One read a program makes of the page's world, and the expression that answers it at call time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Feed {
    pub read: Reach,
    pub from: Expr,
}

/// What of the page's world a program reads. The list is closed: a read the evaluator does not know refuses the body.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "of", content = "key", rename_all = "snake_case")]
pub enum Reach {
    /// A cookie of the page's, by name, as `document.cookie` lists it.
    Cookie(String),
    /// A key of the page's local storage.
    Local(String),
    /// A key of the page's session storage.
    Session(String),
    /// A property of the browser's `navigator`, by name.
    Navigator(String),
}

impl std::fmt::Display for Reach {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reach::Cookie(name) => write!(f, "the cookie {name}"),
            Reach::Local(key) => write!(f, "localStorage {key}"),
            Reach::Session(key) => write!(f, "sessionStorage {key}"),
            Reach::Navigator(name) => write!(f, "navigator.{name}"),
        }
    }
}

/// What an item of a list must hold to be picked. The list is closed: a condition this evaluator does not know
/// refuses the body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "when", rename_all = "snake_case", deny_unknown_fields)]
pub enum Fits {
    /// The item's field at `at` (a pointer inside the item) is, as text, the value of `is`.
    Equals { at: String, is: Box<Expr> },
    /// The item's field at `at` holds the value of `is`, case aside. An empty value holds nothing.
    Holds { at: String, is: Box<Expr> },
}

impl Fits {
    /// The expression the item's field is held to.
    pub fn is(&self) -> &Expr {
        match self {
            Fits::Equals { is, .. } | Fits::Holds { is, .. } => is,
        }
    }

    /// Whether `item` fits, given what `is` came to.
    fn fits(&self, item: &serde_json::Value, wanted: &str) -> bool {
        let (at, holds) = match self {
            Fits::Equals { at, .. } => (at, false),
            Fits::Holds { at, .. } => (at, true),
        };
        match item.pointer(at).and_then(text_of) {
            Some(field) if holds => !wanted.is_empty() && field.to_lowercase().contains(&wanted.to_lowercase()),
            Some(field) => field == wanted,
            None => false,
        }
    }
}

/// A leaf of JSON as the text a request sends of it. A list or an object is no one text.
fn text_of(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Which of a page's two stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Area {
    Local,
    Session,
}

impl Area {
    /// The name a session's map of held values keeps `key` of this store under, beside the cookies and the headers
    /// the session keeps by their own names: `localStorage:<key>` or `sessionStorage:<key>`. A cookie's name and a
    /// header's name are tokens, which hold no `:`, so no cookie or header is ever read for a stored value.
    pub fn held_as(self, key: &str) -> String {
        match self {
            Area::Local => format!("localStorage:{key}"),
            Area::Session => format!("sessionStorage:{key}"),
        }
    }
}

/// Where in a reply a value is found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum At {
    Json { pointer: String },
    Header { name: String },
    /// The `key` value of the query of the address the `name` header hands over (a redirect's `location`).
    HeaderQuery { name: String, key: String },
    SetCookie { name: String },
    /// In text such as a page: after the `nth` occurrence of `before`, counted from zero, up to `after`.
    Text {
        before: String,
        after: String,
        #[serde(default)]
        nth: usize,
    },
}

/// Which reading of the clock an id is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Clock {
    /// Milliseconds since 1970, 13 digits.
    Millis,
    /// Seconds since 1970, 10 digits.
    Seconds,
    /// No clock at all: an id drawn at random, written as a UUID is.
    Random,
}

/// A fact about a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileFact {
    /// Its length in bytes, as decimal text.
    Size,
    /// Its name, without the folder.
    Name,
}

/// A part of the request being built.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "of", content = "key", rename_all = "snake_case")]
pub enum Sent {
    /// The path, and the query after it where there is one.
    Path,
    /// The method, in capitals.
    Method,
    /// The body as text; empty with no body.
    Body,
    /// A value of the query, by key.
    Query(String),
    /// A cookie the request carries, by name.
    Cookie(String),
    /// A header the request carries, by name: a page that signs over a clock reading it also sends in a header
    /// (`x-ts`) hashes what that header carries, so the signature reads it off the request being built.
    Header(String),
}

/// How a value is written where it sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum How {
    /// As it is.
    Plain,
    /// As the inside of a JSON string.
    Json,
    /// Percent-encoded, as an address writes it.
    Percent,
    /// Percent-encoded, with a plus for each space.
    Plus,
    /// In capitals.
    Upper,
    /// In small letters.
    Lower,
    /// Its words joined by dashes.
    Dashed,
}

/// What an address carries as itself; everything else is percent-encoded.
pub(crate) const ADDRESS: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

impl How {
    pub fn write(self, value: &str) -> String {
        match self {
            How::Plain => value.to_string(),
            How::Json => serde_json::to_string(value).ok().and_then(|s| Some(s.strip_prefix('"')?.strip_suffix('"')?.to_string())).unwrap_or_default(),
            How::Percent => percent_encoding::utf8_percent_encode(value, ADDRESS).to_string(),
            How::Plus => percent_encoding::utf8_percent_encode(value, ADDRESS).to_string().replace("%20", "+"),
            How::Upper => value.to_uppercase(),
            How::Lower => value.to_lowercase(),
            How::Dashed => value.split_whitespace().collect::<Vec<_>>().join("-"),
        }
    }
}

/// How a text is encoded again: base64 in either alphabet, padded or not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wrap {
    Base64,
    Base64NoPad,
    Base64Url,
    Base64UrlNoPad,
}

impl Wrap {
    fn engine(self) -> base64::engine::GeneralPurpose {
        use base64::engine::general_purpose as b64;
        match self {
            Wrap::Base64 => b64::STANDARD,
            Wrap::Base64NoPad => b64::STANDARD_NO_PAD,
            Wrap::Base64Url => b64::URL_SAFE,
            Wrap::Base64UrlNoPad => b64::URL_SAFE_NO_PAD,
        }
    }

    /// The text `value` holds, when it is a text encoded this way.
    pub fn open(self, value: &str) -> Option<String> {
        use base64::Engine;
        String::from_utf8(self.engine().decode(value).ok()?).ok()
    }

    /// `text` encoded this way.
    pub fn close(self, text: &str) -> String {
        use base64::Engine;
        self.engine().encode(text)
    }
}

/// A digest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Algo {
    Md5,
    Sha1,
    Sha256,
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

impl Algo {
    /// The digest of `text`, in small hexadecimal.
    pub fn hash(self, text: &str) -> String {
        match self {
            Algo::Md5 => {
                use md5::{Digest, Md5};
                hex(Md5::digest(text.as_bytes()))
            }
            Algo::Sha1 => {
                use sha1::{Digest, Sha1};
                hex(Sha1::digest(text.as_bytes()))
            }
            Algo::Sha256 => {
                use sha2::{Digest, Sha256};
                hex(Sha256::digest(text.as_bytes()))
            }
        }
    }

    /// The digest of `text` keyed with `key`, in small hexadecimal.
    pub fn keyed(self, key: &str, text: &str) -> String {
        use hmac::{Hmac, Mac};
        // A key of any length is a key: the construction hashes a long one down itself.
        match self {
            Algo::Md5 => {
                let mut mac = Hmac::<md5::Md5>::new_from_slice(key.as_bytes()).expect("a key of any length");
                mac.update(text.as_bytes());
                hex(mac.finalize().into_bytes())
            }
            Algo::Sha1 => {
                let mut mac = Hmac::<sha1::Sha1>::new_from_slice(key.as_bytes()).expect("a key of any length");
                mac.update(text.as_bytes());
                hex(mac.finalize().into_bytes())
            }
            Algo::Sha256 => {
                let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes()).expect("a key of any length");
                mac.update(text.as_bytes());
                hex(mac.finalize().into_bytes())
            }
        }
    }
}

/// Where `part` stands whole in `value`: with no letter or digit against either end, so `dress` is not found in
/// `address`.
fn stands_in(value: &str, part: &str) -> Vec<usize> {
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    value.match_indices(part).map(|(at, _)| at).filter(|&at| !word(value[..at].chars().next_back()) && !word(value[at + part.len()..].chars().next())).collect()
}

/// Whether `part` stands whole somewhere in `value` as a word of its own: no letter, digit or `_` against either end,
/// so `search` stands in `{"q":"search"}` and in `search params`, never in the key `search_params`. A learner asks this
/// before it takes a longer literal for a caller's value spliced into fixed text: a value that only turns up inside a
/// longer word (a key name, an identifier) is a coincidence of letters, not where the caller's value goes.
pub fn stands_as_a_word(value: &str, part: &str) -> bool {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    !part.is_empty() && value.match_indices(part).any(|(at, _)| !word(value[..at].chars().next_back()) && !word(value[at + part.len()..].chars().next()))
}

/// `value` with `now` wherever `part` stands whole. A part that stands whole nowhere but occurs once is that one
/// occurrence: a word a learner placed and the site bore out.
pub fn swapped(value: &str, part: &str, now: &str) -> String {
    if part.is_empty() {
        return value.to_string();
    }
    if stands_in(value, part).is_empty() && value.matches(part).count() == 1 {
        return value.replacen(part, now, 1);
    }
    let mut out = String::with_capacity(value.len());
    let mut from = 0;
    for at in stands_in(value, part) {
        out.push_str(&value[from..at]);
        out.push_str(now);
        from = at + part.len();
    }
    out.push_str(&value[from..]);
    out
}

/// A stamp's form written for this call: `{ms}` and `{s}` from the clock, `{dN}` as N digits of chance. Anything
/// else in braces stays as it is.
pub fn stamped(form: &str, now_ms: u64, digits: &mut dyn FnMut(usize) -> String) -> String {
    let mut out = String::new();
    let mut rest = form;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        let Some(end) = rest[at..].find('}') else {
            rest = &rest[at..];
            break;
        };
        let token = &rest[at + 1..at + end];
        match token {
            "ms" => out.push_str(&now_ms.to_string()),
            "s" => out.push_str(&(now_ms / 1000).to_string()),
            _ if token.starts_with('d') && token[1..].parse::<usize>().is_ok() => out.push_str(&digits(token[1..].parse().unwrap_or(0))),
            _ => out.push_str(&rest[at..at + end + 1]),
        }
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out
}

/// Everything outside a body that filling it needs. The node answers each with the reader it already has for that
/// question; this crate never reads a reply, a jar or a clock itself.
pub trait World {
    /// What the caller wrote in the slot `name`.
    fn slot(&self, name: &str) -> Option<String>;
    /// A value of the session, by cookie name.
    fn cookie(&self, name: &str) -> Option<String>;
    /// A cookie by name, only where a browser would send it to `host`: the step's own host, which is None when its
    /// address builds the host for each call, and no jar's cookie goes there.
    fn cookie_for(&self, name: &str, host: Option<&str>) -> Option<String> {
        host?;
        self.cookie(name)
    }
    /// A value the page keeps in its storage.
    fn stored(&self, _area: Area, _key: &str) -> Option<String> {
        None
    }
    /// The value at a place of the reply to an earlier step of this call. None when the step has no reply yet or
    /// its reply does not hold the place.
    fn read(&self, step: &str, at: &At) -> Option<String>;
    /// The list at `pointer` in the JSON of the reply to an earlier step of this call. None when the step has no reply
    /// yet, or its reply holds no list there. A world that reads no lists has none.
    fn list(&self, _step: &str, _pointer: &str) -> Option<Vec<serde_json::Value>> {
        None
    }
    /// Whether a step of this call has been answered.
    fn answered(&self, step: &str) -> bool;
    /// A new reading of the clock for the id the walk sent as `id`: one for each id, the same every time it is
    /// asked in one call.
    fn fresh(&mut self, id: &str, clock: Clock) -> String;
    /// Milliseconds since 1970.
    fn now_ms(&self) -> u64;
    /// `n` random digits.
    fn digits(&mut self, n: usize) -> String;
    /// A fact about the file the caller named.
    fn file(&self, named: &str, fact: FileFact) -> Result<String, String>;
    /// Whether two origins are one site.
    fn same_site(&self, a: &str, b: &str) -> bool;
    /// The value a program makes for the request as it stands. None from a world that runs no programs, or when the
    /// program failed: the step is then made a rung down.
    fn program(&mut self, _source: &str, _sent: &Built) -> Option<String> {
        None
    }
    /// The value a program makes for the request as it stands, given what each of its reads came to (None: the page
    /// would have found nothing there). None from a world that runs no programs.
    fn program_reading(&mut self, _source: &str, _sent: &Built, _fed: &[(Reach, Option<String>)]) -> Option<String> {
        None
    }
}

/// What an expression came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A value to send.
    Is(String),
    /// The caller left an optional slot unset: the place goes unsent, key and all.
    Unset,
    /// There is nothing to send here, and the request stands as its template has it.
    Absent,
}

/// Why a way could not fill its hole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Why {
    /// The caller must write this slot.
    Slot(String),
    /// A step's reply did not hold the value, or the step has not been answered.
    Source { step: String },
    /// The value is too short for the piece taken of it.
    Short,
    /// It reads this request, which is not built yet.
    Unbuilt,
    /// It reads a part of this request that the request does not carry.
    NotSent(String),
    /// The caller's file could not be read.
    File { slot: String, reason: String },
    /// The value is not a text encoded the way the body says.
    NotWrapped,
    /// It needs a maker of this rung (`learn.rung`), and nothing here makes it.
    Needs(u8),
    /// The step's body is one this crate cannot build.
    Body,
    /// A value holds the body's own boundary, and would break the body apart.
    Breaks { part: String },
    /// The address does not read as one.
    BadUrl(String),
    /// An earlier reply handed the step an address on another origin.
    OtherOrigin { own: String, to: String },
    /// A value the request holds in a list could not be made: a list with a gap is another request.
    Gap,
    /// The value does not read as the date, the time or the number its way reads.
    Unread(String),
    /// No record of the table the site ships fits the value.
    NotListed(String),
}

/// A hole that could not be filled, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stuck {
    /// The hole, when it is one hole's.
    pub at: Option<Place>,
    pub why: Why,
}

impl std::fmt::Display for Stuck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(at) = &self.at {
            write!(f, "{at}: ")?;
        }
        match &self.why {
            Why::Slot(name) => write!(f, "the caller must give {name}"),
            Why::Source { step } => write!(f, "step {step}'s reply does not hold it"),
            Why::Short => write!(f, "the value is too short for the piece taken of it"),
            Why::Unbuilt => write!(f, "it reads the request before the request is built"),
            Why::NotSent(part) => write!(f, "it reads {part}, which the request does not carry"),
            Why::File { slot, reason } => write!(f, "the file given as {slot}: {reason}"),
            Why::NotWrapped => write!(f, "the value is not a text encoded as the body says"),
            Why::Needs(rung) => write!(f, "it needs a maker of rung {rung}"),
            Why::Body => write!(f, "the step's body cannot be built"),
            Why::Breaks { part } => write!(f, "a value in part {part} holds the body's own boundary"),
            Why::BadUrl(why) => write!(f, "the address does not read: {why}"),
            Why::OtherOrigin { own, to } => write!(f, "an earlier reply handed {own} over to {to}, another origin: the node does not send it there"),
            Why::Gap => write!(f, "a value in a list could not be made, and a list with a gap is another request"),
            Why::NotListed(value) => write!(f, "the site's own table lists nothing that fits {value:?}"),
            Why::Unread(value) => write!(f, "{value:?} does not read as the date, the time or the number the way reads"),
        }
    }
}

impl std::error::Error for Stuck {}

/// What an expression is evaluated against.
pub struct Cx<'a> {
    pub world: &'a mut dyn World,
    /// The host of the step being built, where its address names one.
    pub host: Option<&'a str>,
    /// The request as built so far: what [`Expr::Sent`] and [`Expr::Program`] read. None while it is being built.
    pub sent: Option<&'a Built>,
}

impl Expr {
    /// A fixed text.
    /// The least rung a value made this way is counted at (`learn.rung`), whatever rung its way was written with:
    /// the site's format of the caller's value is the walk's (0); a table the site ships and a count it searched for
    /// are standard operations (1); a program of the site's own, fed or not, runs in the sandbox (2). The filler
    /// counts each place at its way's rung or this, whichever is higher (`Built::rung`), so the one counter of rungs
    /// says what a new operation cost however the learner wrote its way.
    pub fn least_rung(&self) -> u8 {
        self.all()
            .into_iter()
            .map(|e| match e {
                Expr::Lookup { .. } | Expr::Solve { .. } => 1,
                Expr::Program { .. } | Expr::ProgramReading { .. } => 2,
                _ => 0,
            })
            .max()
            .unwrap_or(0)
    }

    pub fn text(is: impl Into<String>) -> Expr {
        Expr::Text { is: is.into() }
    }

    /// This expression and every expression inside it, outermost first.
    pub fn all(&self) -> Vec<&Expr> {
        let mut out = Vec::new();
        self.gather(true, &mut out);
        out
    }

    /// This expression and every expression inside it whose value the request carries as it is, outermost first:
    /// what a digest is made over is not among them, only the digest. A reading of the clock in the clear can be
    /// held to being one; under a digest it is either the very reading hashed or the digest is another.
    pub fn in_the_clear(&self) -> Vec<&Expr> {
        let mut out = Vec::new();
        self.gather(false, &mut out);
        out
    }

    fn gather<'a>(&'a self, into_digests: bool, out: &mut Vec<&'a Expr>) {
        out.push(self);
        match self {
            Expr::Join { parts, .. } => parts.iter().for_each(|p| p.gather(into_digests, out)),
            Expr::Slice { of, .. } | Expr::Else { of, .. } | Expr::Piece { of, .. } | Expr::Written { of, .. } | Expr::Wrapped { of, .. } | Expr::Unwrapped { of, .. } | Expr::Format { of, .. } => of.gather(into_digests, out),
            Expr::Swap { within, now, .. } => {
                within.gather(into_digests, out);
                now.gather(into_digests, out);
            }
            Expr::Hash { of, .. } if into_digests => of.gather(into_digests, out),
            // What an item is held to is no part of what is sent.
            Expr::Pick { fits, .. } | Expr::Lookup { fits, .. } if into_digests => fits.is().gather(into_digests, out),
            Expr::Hmac { key, of, .. } if into_digests => {
                key.gather(into_digests, out);
                of.gather(into_digests, out);
            }
            Expr::Solve { before, after, .. } if into_digests => {
                before.gather(into_digests, out);
                after.gather(into_digests, out);
            }
            // What a program reads is handed to it, not sent.
            Expr::ProgramReading { reads, .. } if into_digests => reads.iter().for_each(|f| f.from.gather(into_digests, out)),
            _ => {}
        }
    }

    /// The expression with each step it reads named as `rename` says: the same ways, read from the same replies, where
    /// a body's steps are named otherwise (by another numbering of one walk's calls).
    pub fn with_steps_renamed(&self, rename: &dyn Fn(&str) -> String) -> Expr {
        let mut renamed = self.clone();
        renamed.rename_steps(rename);
        renamed
    }

    fn rename_steps(&mut self, rename: &dyn Fn(&str) -> String) {
        match self {
            Expr::Read { step, .. } | Expr::Nothing { after: Some(step) } => *step = rename(step),
            Expr::Pick { step, fits, .. } => {
                *step = rename(step);
                match fits {
                    Fits::Equals { is, .. } | Fits::Holds { is, .. } => is.rename_steps(rename),
                }
            }
            Expr::Lookup { fits: Fits::Equals { is, .. } | Fits::Holds { is, .. }, .. } => is.rename_steps(rename),
            Expr::Join { parts, .. } => parts.iter_mut().for_each(|p| p.rename_steps(rename)),
            Expr::Slice { of, .. } | Expr::Else { of, .. } | Expr::Piece { of, .. } | Expr::Written { of, .. } | Expr::Wrapped { of, .. } | Expr::Unwrapped { of, .. } | Expr::Hash { of, .. } | Expr::Format { of, .. } => of.rename_steps(rename),
            Expr::Swap { within, now, .. } => {
                within.rename_steps(rename);
                now.rename_steps(rename);
            }
            Expr::Hmac { key, of, .. } => {
                key.rename_steps(rename);
                of.rename_steps(rename);
            }
            Expr::ProgramReading { reads, .. } => reads.iter_mut().for_each(|f| f.from.rename_steps(rename)),
            Expr::Solve { before, after, .. } => {
                before.rename_steps(rename);
                after.rename_steps(rename);
            }
            _ => {}
        }
    }

    /// The expression with each slot it reads named as `rename` says, where it says anything: the same ways, filled
    /// from the caller's value under its new name.
    pub fn with_slots_renamed(&self, rename: &dyn Fn(&str) -> Option<String>) -> Expr {
        let mut renamed = self.clone();
        renamed.each_slot(&mut |e| {
            if let Expr::Slot { name, .. } | Expr::Given { name } | Expr::File { slot: name, .. } = e {
                if let Some(new) = rename(name) {
                    *name = new;
                }
            }
        });
        renamed
    }

    /// The expression with no value of the walk kept for a slot `keeps_none` names: a secret's slot sends what the
    /// caller gives, and nothing in its place.
    pub fn with_no_walked_value_for(&self, keeps_none: &dyn Fn(&str) -> bool) -> Expr {
        let mut kept = self.clone();
        kept.each_slot(&mut |e| {
            if let Expr::Slot { name, or, .. } = e {
                if keeps_none(name) {
                    *or = None;
                }
            }
        });
        kept
    }

    /// Calls `f` on every slot this expression reads (`Slot`, `Given`, `File`), wherever it sits.
    fn each_slot(&mut self, f: &mut dyn FnMut(&mut Expr)) {
        match self {
            Expr::Slot { .. } | Expr::Given { .. } | Expr::File { .. } => f(self),
            Expr::Pick { fits: Fits::Equals { is, .. } | Fits::Holds { is, .. }, .. } | Expr::Lookup { fits: Fits::Equals { is, .. } | Fits::Holds { is, .. }, .. } => is.each_slot(f),
            Expr::Join { parts, .. } => parts.iter_mut().for_each(|p| p.each_slot(f)),
            Expr::Slice { of, .. } | Expr::Else { of, .. } | Expr::Piece { of, .. } | Expr::Written { of, .. } | Expr::Wrapped { of, .. } | Expr::Unwrapped { of, .. } | Expr::Hash { of, .. } | Expr::Format { of, .. } => of.each_slot(f),
            Expr::Swap { within, now, .. } => {
                within.each_slot(f);
                now.each_slot(f);
            }
            Expr::Hmac { key, of, .. } => {
                key.each_slot(f);
                of.each_slot(f);
            }
            Expr::ProgramReading { reads, .. } => reads.iter_mut().for_each(|r| r.from.each_slot(f)),
            Expr::Solve { before, after, .. } => {
                before.each_slot(f);
                after.each_slot(f);
            }
            _ => {}
        }
    }

    /// The earlier steps this expression needs answered.
    pub fn reads(&self) -> Vec<&str> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                Expr::Read { step, .. } | Expr::Pick { step, .. } | Expr::Nothing { after: Some(step) } => Some(step.as_str()),
                _ => None,
            })
            .collect()
    }

    /// The slots this expression reads.
    pub fn slots(&self) -> Vec<&str> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                Expr::Slot { name, .. } | Expr::Given { name } => Some(name.as_str()),
                Expr::File { slot, .. } => Some(slot.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Whether the expression reads the request it is part of, so it can only be worked out once the rest is built.
    pub fn reads_the_request(&self) -> bool {
        self.all().into_iter().any(|e| matches!(e, Expr::Sent { .. } | Expr::Program { .. } | Expr::ProgramReading { .. }))
    }

    /// Whether the expression holds a program.
    pub fn holds_code(&self) -> bool {
        self.all().into_iter().any(|e| matches!(e, Expr::Program { .. } | Expr::ProgramReading { .. }))
    }

    /// Works the expression out.
    pub fn eval(&self, cx: &mut Cx<'_>) -> Result<Outcome, Why> {
        use Outcome::{Absent, Is, Unset};
        Ok(match self {
            Expr::Text { is } => Is(is.clone()),
            Expr::Slot { name, or, optional } => match cx.world.slot(name).or_else(|| or.clone()) {
                Some(v) => Is(v),
                None if *optional => Unset,
                None => return Err(Why::Slot(name.clone())),
            },
            Expr::Given { name } => Is(cx.world.slot(name).ok_or_else(|| Why::Slot(name.clone()))?),
            Expr::Cookie { name, here } => match if *here { cx.world.cookie_for(name, cx.host) } else { cx.world.cookie(name) } {
                Some(v) => Is(v),
                None => Absent,
            },
            Expr::Stored { area, key } => match cx.world.stored(*area, key) {
                Some(v) => Is(v),
                None => Absent,
            },
            Expr::Read { step, at } => Is(cx.world.read(step, at).ok_or_else(|| Why::Source { step: step.clone() })?),
            Expr::Pick { step, list, fits, take } => {
                let items = cx.world.list(step, list).ok_or_else(|| Why::Source { step: step.clone() })?;
                let wanted = match fits.is().eval(cx)? {
                    Is(v) => v,
                    other => return Ok(other),
                };
                let item = items.iter().find(|item| fits.fits(item, &wanted)).ok_or_else(|| Why::Source { step: step.clone() })?;
                let taken = if take.is_empty() { Some(item) } else { item.pointer(take) };
                Is(taken.and_then(text_of).ok_or(Why::Short)?)
            }
            Expr::Fresh { id, clock } => Is(cx.world.fresh(id, *clock)),
            Expr::Stamp { form } => {
                let now = cx.world.now_ms();
                let world = &mut *cx.world;
                Is(stamped(form, now, &mut |n| world.digits(n)))
            }
            Expr::File { slot, fact } => {
                let named = cx.world.slot(slot).ok_or_else(|| Why::Slot(slot.clone()))?;
                Is(cx.world.file(&named, *fact).map_err(|reason| Why::File { slot: slot.clone(), reason })?)
            }
            Expr::Sent { part } => {
                let sent = cx.sent.ok_or(Why::Unbuilt)?;
                Is(sent.part(part).ok_or_else(|| Why::NotSent(format!("{part:?}")))?)
            }
            Expr::Nothing { after: None } => Absent,
            Expr::Nothing { after: Some(step) } => {
                if cx.world.answered(step) {
                    Absent
                } else {
                    return Err(Why::Source { step: step.clone() });
                }
            }
            Expr::Join { parts, with } => {
                let mut out: Vec<String> = Vec::with_capacity(parts.len());
                for part in parts {
                    match part.eval(cx)? {
                        Is(v) => out.push(v),
                        // A whole with a part missing is not sent in pieces.
                        other => return Ok(other),
                    }
                }
                Is(out.join(with))
            }
            Expr::Else { of, or } => match of.eval(cx)? {
                Absent => Is(or.clone()),
                other => other,
            },
            Expr::Slice { of, from, len } => match of.eval(cx)? {
                Is(v) => {
                    let piece: String = v.chars().skip(*from).take(*len).collect();
                    if piece.chars().count() < *len {
                        return Err(Why::Short);
                    }
                    Is(piece)
                }
                other => other,
            },
            Expr::Piece { of, split, index } => match of.eval(cx)? {
                Is(v) => Is(v.split(split.as_str()).nth(*index).ok_or(Why::Short)?.to_string()),
                other => other,
            },
            Expr::Written { of, how } => match of.eval(cx)? {
                Is(v) => Is(how.write(&v)),
                other => other,
            },
            Expr::Wrapped { of, how } => match of.eval(cx)? {
                Is(v) => Is(how.close(&v)),
                other => other,
            },
            Expr::Unwrapped { of, how } => match of.eval(cx)? {
                Is(v) => Is(how.open(&v).ok_or(Why::NotWrapped)?),
                other => other,
            },
            Expr::Swap { within, was, now, inside } => {
                let value = match within.eval(cx)? {
                    Is(value) => value,
                    other => return Ok(other),
                };
                let now = match now.eval(cx) {
                    Ok(Is(now)) => now,
                    // The caller gave nothing to put there: the value goes as it is.
                    Ok(_) | Err(Why::Slot(_)) => return Ok(Is(value)),
                    Err(why) => return Err(why),
                };
                // Only a value this call read from a reply may say `now` already.
                let fresh = !within.reads().is_empty();
                let said = |text: &str| fresh && text.contains(&now);
                match inside {
                    Some(wrap) => match wrap.open(&value).filter(|text| !said(text)) {
                        Some(text) => Is(wrap.close(&swapped(&text, was, &now))),
                        None => Is(value),
                    },
                    None if !said(&value) => Is(swapped(&value, was, &now)),
                    None => Is(value),
                }
            }
            Expr::Hash { algo, of } => {
                // A digest over a cookie the request doesn't carry yet is over nothing in its place, as a page's own code
                // signs before its session holds the token: a gateway that issues its own token answers that call with
                // it, and the node signs again with what it handed over. Only inside a digest: a cookie read for its
                // own value is still missing.
                let absent: Vec<String> = match cx.sent {
                    Some(built) => of
                        .all()
                        .into_iter()
                        .filter_map(|e| match e {
                            Expr::Sent { part: Sent::Cookie(name) } if built.part(&Sent::Cookie(name.clone())).is_none() => Some(name.clone()),
                            _ => None,
                        })
                        .collect(),
                    None => Vec::new(),
                };
                let blank = cx.sent.filter(|_| !absent.is_empty()).map(|built| built.with_blank_cookies(&absent));
                let made = match &blank {
                    Some(built) => of.eval(&mut Cx { world: &mut *cx.world, host: cx.host, sent: Some(built) })?,
                    None => of.eval(cx)?,
                };
                match made {
                    Is(v) => Is(algo.hash(&v)),
                    other => other,
                }
            }
            Expr::Hmac { algo, key, of } => match (key.eval(cx)?, of.eval(cx)?) {
                (Is(k), Is(v)) => Is(algo.keyed(&k, &v)),
                (Is(_), other) | (other, _) => other,
            },
            Expr::Program { source, .. } => {
                let sent = cx.sent.ok_or(Why::Unbuilt)?;
                Is(cx.world.program(source, sent).ok_or(Why::Needs(2))?)
            }
            Expr::Lookup { rows, fits, take } => {
                let wanted = match fits.is().eval(cx)? {
                    Is(v) => v,
                    other => return Ok(other),
                };
                let row = rows.iter().find(|row| fits.fits(row, &wanted)).ok_or_else(|| Why::NotListed(wanted.chars().take(40).collect()))?;
                let taken = if take.is_empty() { Some(row) } else { row.pointer(take) };
                Is(taken.and_then(text_of).ok_or(Why::Short)?)
            }
            Expr::Format { of, read, write } => match of.eval(cx)? {
                Is(v) => Is(crate::format::reformat(&v, read, write).ok_or_else(|| Why::Unread(v.chars().take(40).collect()))?),
                other => other,
            },
            Expr::ProgramReading { source, reads, .. } => {
                let sent = cx.sent.ok_or(Why::Unbuilt)?;
                let mut fed = Vec::with_capacity(reads.len());
                for feed in reads {
                    let mut inner = Cx { world: &mut *cx.world, host: cx.host, sent: Some(sent) };
                    fed.push((feed.read.clone(), match feed.from.eval(&mut inner)? {
                        Is(v) => Some(v),
                        Unset | Absent => None,
                    }));
                }
                Is(cx.world.program_reading(source, sent, &fed).ok_or(Why::Needs(2))?)
            }
            Expr::Solve { algo, before, after, zeros } => match (before.eval(cx)?, after.eval(cx)?) {
                (Is(b), Is(a)) => Is(solve(*algo, &b, &a, *zeros).ok_or(Why::Needs(2))?.to_string()),
                (Is(_), other) | (other, _) => other,
            },
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    /// A world that answers from tables a test fills in, and, like the node's default world, runs no program and holds
    /// no storage or list until a test gives it one. `fill`'s tests use it too.
    #[derive(Default)]
    pub(crate) struct Desk {
        slots: HashMap<String, String>,
        jar: HashMap<String, String>,
        lists: HashMap<(String, String), Vec<serde_json::Value>>,
        answered: Vec<String>,
        program: Option<String>,
    }

    impl Desk {
        /// A desk that knows only what the caller wrote.
        pub(crate) fn saying(pairs: &[(&str, &str)]) -> Desk {
            Desk { slots: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), ..Desk::default() }
        }
    }

    impl World for Desk {
        fn slot(&self, name: &str) -> Option<String> {
            self.slots.get(name).cloned()
        }
        fn cookie(&self, name: &str) -> Option<String> {
            self.jar.get(name).cloned()
        }
        fn read(&self, _step: &str, _at: &At) -> Option<String> {
            None
        }
        fn answered(&self, step: &str) -> bool {
            self.answered.iter().any(|s| s == step)
        }
        fn fresh(&mut self, _id: &str, _clock: Clock) -> String {
            "id".into()
        }
        fn now_ms(&self) -> u64 {
            1_700_000_000_000
        }
        fn digits(&mut self, n: usize) -> String {
            "4".repeat(n)
        }
        fn file(&self, named: &str, _fact: FileFact) -> Result<String, String> {
            Err(format!("{named} is unreadable"))
        }
        fn same_site(&self, a: &str, b: &str) -> bool {
            a == b
        }
        fn list(&self, step: &str, pointer: &str) -> Option<Vec<serde_json::Value>> {
            self.lists.get(&(step.to_string(), pointer.to_string())).cloned()
        }
        fn program(&mut self, _source: &str, _sent: &Built) -> Option<String> {
            self.program.clone()
        }
    }

    fn expr(v: serde_json::Value) -> Expr {
        serde_json::from_value(v).expect("an expression")
    }

    fn eval(e: &Expr, world: &mut Desk) -> Result<Outcome, Why> {
        e.eval(&mut Cx { world, host: None, sent: None })
    }

    fn says(e: &Expr, world: &mut Desk) -> String {
        match eval(e, world) {
            Ok(Outcome::Is(v)) => v,
            other => panic!("{other:?}"),
        }
    }

    /// An expression that reads a step, a slot and a list in every shape an expression nests them, so a rename that
    /// skips one shape leaves a name behind.
    fn nested() -> Expr {
        let read = |step: &str| json!({ "op": "read", "step": step, "at": { "from": "json", "pointer": "/x" } });
        let slot = |name: &str| json!({ "op": "slot", "name": name });
        expr(json!({ "op": "join", "parts": [
            read("a"),
            { "op": "slice", "of": slot("s1"), "from": 0, "len": 1 },
            { "op": "piece", "of": slot("s2"), "split": ",", "index": 0 },
            { "op": "swap", "within": read("b"), "was": "w", "now": slot("s3") },
            { "op": "hmac", "algo": "sha1", "key": read("c"), "of": slot("s4") },
            { "op": "solve", "algo": "md5", "before": read("d"), "after": slot("s5"), "zeros": 1 },
            { "op": "program_reading", "source": "return 1", "reads": [{ "read": { "of": "cookie", "key": "k" }, "from": read("e") },
                                                                        { "read": { "of": "local", "key": "k" }, "from": slot("s6") }] },
            { "op": "pick", "step": "f", "list": "/l", "fits": { "when": "equals", "at": "/id", "is": read("g") }, "take": "" },
            { "op": "lookup", "rows": [], "fits": { "when": "holds", "at": "/id", "is": slot("s7") }, "take": "" },
            { "op": "nothing", "after": "h" },
            { "op": "hash", "algo": "md5", "of": slot("s8") },
            { "op": "format", "of": slot("s9"), "read": { "as": "time", "form": "{yyyy}" }, "write": { "as": "time", "form": "{yy}" } },
            { "op": "written", "of": slot("s10"), "how": "upper" },
            { "op": "wrapped", "of": slot("s11"), "how": "base64" },
            { "op": "unwrapped", "of": slot("s12"), "how": "base64" },
            { "op": "file", "slot": "s13", "fact": "name" },
        ] }))
    }

    /// Steps and slots renamed reach into every shape an expression nests, and only the names asked for change, so a
    /// body whose steps are numbered otherwise still reads from the replies it read from.
    #[test]
    fn every_nested_read_and_slot_is_renamed_where_it_sits() {
        let e = nested();
        let mut steps = e.reads();
        steps.sort_unstable();
        assert_eq!(steps, ["a", "b", "c", "d", "e", "f", "g", "h"]);
        let moved = e.with_steps_renamed(&|s| format!("{s}2"));
        let mut now = moved.reads();
        now.sort_unstable();
        assert_eq!(now, ["a2", "b2", "c2", "d2", "e2", "f2", "g2", "h2"]);
        assert_eq!(e.reads().len(), 8, "the original is left as it was");

        let mut slots = e.slots();
        slots.sort_unstable();
        assert_eq!(slots, ["s1", "s10", "s11", "s12", "s13", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
        let renamed = e.with_slots_renamed(&|n| (n != "s1").then(|| format!("{n}_x")));
        let mut now = renamed.slots();
        now.sort_unstable();
        assert_eq!(now, ["s1", "s10_x", "s11_x", "s12_x", "s13_x", "s2_x", "s3_x", "s4_x", "s5_x", "s6_x", "s7_x", "s8_x", "s9_x"]);
        let files: Vec<&Expr> = renamed.all().into_iter().filter(|e| matches!(e, Expr::File { .. })).collect();
        assert!(matches!(files[0], Expr::File { slot, .. } if slot == "s13_x"), "a file's slot is a slot");
    }

    /// A secret's slot keeps nothing of what the walk sent, wherever the slot sits; another slot keeps its word.
    #[test]
    fn a_secrets_walked_value_is_dropped_wherever_its_slot_sits() {
        let e = expr(json!({ "op": "join", "parts": [
            { "op": "slot", "name": "pw", "or": "hunter2" },
            { "op": "swap", "within": { "op": "text", "is": "t" }, "was": "t", "now": { "op": "slot", "name": "pw", "or": "hunter2" } },
            { "op": "hash", "algo": "md5", "of": { "op": "slot", "name": "q", "or": "lamp" } },
        ] }));
        let kept = e.with_no_walked_value_for(&|n| n == "pw");
        let walked: Vec<Option<String>> = kept.all().into_iter().filter_map(|e| match e { Expr::Slot { or, .. } => Some(or.clone()), _ => None }).collect();
        assert_eq!(walked, [None, None, Some("lamp".to_string())]);
        assert!(!serde_json::to_string(&kept).unwrap().contains("hunter2"));
    }

    /// A program is the route's private code, and the expression says so wherever it sits: bare, inside a digest, a
    /// join, a pick's condition or a fed program's own reads. An expression of plain operations never does.
    #[test]
    fn an_expression_with_a_program_inside_says_it_holds_code() {
        let program = json!({ "op": "program", "source": "return 1" });
        let fed = json!({ "op": "program_reading", "source": "return 2", "reads": [] });
        for held in [
            program.clone(),
            fed.clone(),
            json!({ "op": "hash", "algo": "md5", "of": program.clone() }),
            json!({ "op": "join", "parts": [{ "op": "text", "is": "a" }, fed.clone()] }),
            json!({ "op": "pick", "step": "s", "list": "/l", "fits": { "when": "equals", "at": "/id", "is": program.clone() }, "take": "" }),
        ] {
            assert!(expr(held.clone()).holds_code(), "{held}");
        }
        assert!(nested().holds_code(), "the nested one holds a fed program");
        assert!(!expr(json!({ "op": "hash", "algo": "sha1", "of": { "op": "text", "is": "a" } })).holds_code());
    }

    /// Every reason a hole could not be filled says it in words an agent can act on, naming what was missing.
    #[test]
    fn every_reason_a_hole_could_not_be_filled_is_said_in_words() {
        let at = Some(Place::Query("q".into()));
        let said = |why: Why| Stuck { at: at.clone(), why }.to_string();
        let cases = [
            (Why::Slot("q".into()), "the caller must give q"),
            (Why::Source { step: "s1".into() }, "step s1's reply does not hold it"),
            (Why::Short, "too short"),
            (Why::Unbuilt, "before the request is built"),
            (Why::NotSent("Path".into()), "it reads Path, which the request does not carry"),
            (Why::File { slot: "f".into(), reason: "gone".into() }, "the file given as f: gone"),
            (Why::NotWrapped, "not a text encoded"),
            (Why::Needs(2), "a maker of rung 2"),
            (Why::Body, "the step's body cannot be built"),
            (Why::Breaks { part: "body".into() }, "a value in part body holds the body's own boundary"),
            (Why::BadUrl("empty".into()), "the address does not read: empty"),
            (Why::OtherOrigin { own: "a.example".into(), to: "b.example".into() }, "handed a.example over to b.example"),
            (Why::Gap, "a list with a gap"),
            (Why::NotListed("Oslo".into()), "lists nothing that fits \"Oslo\""),
            (Why::Unread("x".into()), "\"x\" does not read as the date"),
        ];
        for (why, wants) in cases {
            let text = said(why.clone());
            assert!(text.starts_with("query q: ") && text.contains(wants), "{why:?}: {text}");
        }
        assert_eq!(Stuck { at: None, why: Why::Gap }.to_string(), "a value in a list could not be made, and a list with a gap is another request");
    }

    /// What a program reads of the page is named for a person the way the page would name it.
    #[test]
    fn what_a_program_reads_of_the_page_is_named_plainly() {
        assert_eq!(Reach::Cookie("sid".into()).to_string(), "the cookie sid");
        assert_eq!(Reach::Local("k".into()).to_string(), "localStorage k");
        assert_eq!(Reach::Session("k".into()).to_string(), "sessionStorage k");
        assert_eq!(Reach::Navigator("language".into()).to_string(), "navigator.language");
    }

    /// A world that says nothing more than it must reads no list, no storage and no program, and sends a cookie only to
    /// a host the step names: a pick has nothing to pick from, a program has no maker, a stored value is nowhere.
    #[test]
    fn a_world_that_says_little_holds_no_list_no_storage_and_no_program() {
        struct Bare;
        impl World for Bare {
            fn slot(&self, _: &str) -> Option<String> { None }
            fn cookie(&self, name: &str) -> Option<String> { Some(format!("{name}=jar")) }
            fn read(&self, _: &str, _: &At) -> Option<String> { None }
            fn answered(&self, _: &str) -> bool { false }
            fn fresh(&mut self, _: &str, _: Clock) -> String { String::new() }
            fn now_ms(&self) -> u64 { 0 }
            fn digits(&mut self, n: usize) -> String { "0".repeat(n) }
            fn file(&self, _: &str, _: FileFact) -> Result<String, String> { Err(String::new()) }
            fn same_site(&self, _: &str, _: &str) -> bool { false }
        }
        let mut world = Bare;
        assert_eq!(world.cookie_for("sid", Some("shop.example")).as_deref(), Some("sid=jar"));
        assert_eq!(world.cookie_for("sid", None), None, "a host built at call time gets no jar's cookie");
        assert_eq!(world.stored(Area::Local, "k"), None);
        assert_eq!(world.list("s", "/l"), None);
        let built = Built { method: "GET".into(), url: "https://shop.example/a".parse().unwrap(), headers: vec![], body: None, made: vec![] };
        assert_eq!(world.program("return 1", &built), None);
        assert_eq!(world.program_reading("return 1", &built, &[]), None);
        // So an expression that needs one of them stops, and says it needs a maker.
        let mut cx = Cx { world: &mut world, host: None, sent: Some(&built) };
        assert_eq!(expr(json!({ "op": "program", "source": "return 1" })).eval(&mut cx), Err(Why::Needs(2)));
        assert_eq!(expr(json!({ "op": "program_reading", "source": "return 1", "reads": [{ "read": { "of": "navigator", "key": "language" }, "from": { "op": "text", "is": "en" } }] })).eval(&mut cx), Err(Why::Needs(2)));
        assert_eq!(expr(json!({ "op": "pick", "step": "s", "list": "/l", "fits": { "when": "equals", "at": "/id", "is": { "op": "text", "is": "1" } }, "take": "" })).eval(&mut cx), Err(Why::Source { step: "s".into() }));
    }

    /// A list's item is picked by what its field says, as text whatever the leaf's kind: an equal number or flag, a
    /// held word in any case; an item whose field is a list or object, or is missing, never fits.
    #[test]
    fn a_pick_reads_numbers_and_flags_as_the_text_a_request_sends() {
        let mut desk = Desk::default();
        desk.lists.insert(("s".into(), "/l".into()), vec![
            json!({ "id": { "no": 1 }, "n": "x" }),
            json!({ "id": 7, "n": "Seven", "ok": true, "v": 2.5 }),
            json!({ "n": "Eight", "id": 8 }),
        ]);
        let pick = |when: &str, at: &str, is: &str, take: &str| expr(json!({ "op": "pick", "step": "s", "list": "/l", "fits": { "when": when, "at": at, "is": { "op": "text", "is": is } }, "take": take }));
        assert_eq!(says(&pick("equals", "/id", "7", "/n"), &mut desk), "Seven");
        assert_eq!(says(&pick("equals", "/ok", "true", "/id"), &mut desk), "7");
        assert_eq!(says(&pick("holds", "/n", "EIGHT", "/id"), &mut desk), "8");
        assert_eq!(eval(&pick("equals", "/id", "8", ""), &mut desk), Err(Why::Short), "an item that is an object is no one text");
        desk.lists.insert(("s".into(), "/t".into()), vec![json!("a"), json!("bb")]);
        let word = expr(json!({ "op": "pick", "step": "s", "list": "/t", "fits": { "when": "equals", "at": "", "is": { "op": "text", "is": "bb" } }, "take": "" }));
        assert_eq!(says(&word, &mut desk), "bb", "an item that is a text is its own text");
        assert_eq!(eval(&pick("holds", "/n", "", "/id"), &mut desk), Err(Why::Source { step: "s".into() }), "an empty word holds nothing");
        assert_eq!(eval(&pick("equals", "/id", "1", "/n"), &mut desk), Err(Why::Source { step: "s".into() }), "an object is no one text");
        assert_eq!(eval(&pick("equals", "/id", "7", "/missing"), &mut desk), Err(Why::Short));
        assert_eq!(eval(&pick("equals", "/nope", "7", "/n"), &mut desk), Err(Why::Source { step: "s".into() }));
        assert_eq!(says(&pick("equals", "/id", "7", "/v"), &mut desk), "2.5");
    }

    /// A table the site ships gives the first row that fits; a word it lists nowhere stops the call and names the word.
    #[test]
    fn a_table_lookup_names_the_word_the_site_does_not_list() {
        let table = |is: &str| expr(json!({ "op": "lookup", "rows": [{ "city": "Oslo", "code": "OSL" }, { "city": "Bergen", "code": "BGO" }],
            "fits": { "when": "equals", "at": "/city", "is": { "op": "text", "is": is } }, "take": "/code" }));
        let mut desk = Desk::default();
        assert_eq!(says(&table("Bergen"), &mut desk), "BGO");
        let long = "x".repeat(60);
        assert_eq!(eval(&table(&long), &mut desk), Err(Why::NotListed("x".repeat(40))), "a long word is cut in the message");
    }

    /// Operations carry what is missing upward unchanged: a part the caller left unset leaves the whole unset, and a
    /// value that can't be cut as asked says so, so no call goes out with half a value.
    #[test]
    fn an_operation_over_a_missing_value_is_missing_and_one_over_a_short_value_stops() {
        let unset = json!({ "op": "slot", "name": "opt", "optional": true });
        let mut desk = Desk::default();
        for op in [
            json!({ "op": "slice", "of": unset.clone(), "from": 0, "len": 1 }),
            json!({ "op": "piece", "of": unset.clone(), "split": ",", "index": 0 }),
            json!({ "op": "written", "of": unset.clone(), "how": "json" }),
            json!({ "op": "wrapped", "of": unset.clone(), "how": "base64" }),
            json!({ "op": "unwrapped", "of": unset.clone(), "how": "base64" }),
            json!({ "op": "hash", "algo": "md5", "of": unset.clone() }),
            json!({ "op": "format", "of": unset.clone(), "read": { "as": "time", "form": "{yyyy}" }, "write": { "as": "time", "form": "{yy}" } }),
            json!({ "op": "hmac", "algo": "md5", "key": { "op": "text", "is": "k" }, "of": unset.clone() }),
            json!({ "op": "hmac", "algo": "md5", "key": unset.clone(), "of": { "op": "text", "is": "k" } }),
            json!({ "op": "solve", "algo": "md5", "before": unset.clone(), "after": { "op": "text", "is": "" }, "zeros": 1 }),
            json!({ "op": "solve", "algo": "md5", "before": { "op": "text", "is": "" }, "after": unset.clone(), "zeros": 1 }),
            json!({ "op": "swap", "within": unset.clone(), "was": "a", "now": { "op": "text", "is": "b" } }),
            json!({ "op": "join", "parts": [{ "op": "text", "is": "a" }, unset.clone()] }),
        ] {
            assert_eq!(eval(&expr(op.clone()), &mut desk), Ok(Outcome::Unset), "{op}");
        }
        let text = |s: &str| json!({ "op": "text", "is": s });
        assert_eq!(eval(&expr(json!({ "op": "slice", "of": text("ab"), "from": 1, "len": 5 })), &mut desk), Err(Why::Short));
        assert_eq!(eval(&expr(json!({ "op": "piece", "of": text("a,b"), "split": ",", "index": 2 })), &mut desk), Err(Why::Short));
        assert_eq!(eval(&expr(json!({ "op": "unwrapped", "of": text("not base64!"), "how": "base64" })), &mut desk), Err(Why::NotWrapped));
        assert_eq!(eval(&expr(json!({ "op": "format", "of": text("soon"), "read": { "as": "time", "form": "{yyyy}" }, "write": { "as": "time", "form": "{yy}" } })), &mut desk), Err(Why::Unread("soon".into())));
        assert_eq!(eval(&expr(json!({ "op": "solve", "algo": "md5", "before": text(""), "after": text(""), "zeros": 7 })), &mut desk), Err(Why::Needs(2)), "more work than a call waits for");
    }

    /// Values are made as a site makes them: wrapped and unwrapped base64, a keyed digest, a search for leading zeros,
    /// a date said in another form, a stamp from the clock and chance, a file the caller named.
    #[test]
    fn values_are_made_the_way_a_page_makes_them() {
        let text = |s: &str| json!({ "op": "text", "is": s });
        let mut desk = Desk::default();
        assert_eq!(says(&expr(json!({ "op": "wrapped", "of": text("hi"), "how": "base64_url_no_pad" })), &mut desk), "aGk");
        assert_eq!(says(&expr(json!({ "op": "unwrapped", "of": text("aGk="), "how": "base64" })), &mut desk), "hi");
        assert_eq!(says(&expr(json!({ "op": "hmac", "algo": "sha256", "key": text("k"), "of": text("v") })), &mut desk), Algo::Sha256.keyed("k", "v"));
        assert_eq!(Algo::Sha256.keyed("k", "v").len(), 64);
        assert_eq!(Algo::Md5.keyed("k", "v").len(), 32);
        assert_eq!(Algo::Sha1.keyed("k", "v").len(), 40);
        let found = says(&expr(json!({ "op": "solve", "algo": "sha1", "before": text("ab"), "after": text("cd"), "zeros": 1 })), &mut desk);
        let n: u64 = found.parse().unwrap();
        assert!(leading_zeros(&Algo::Sha1.hash(&format!("ab{n}cd"))) >= 1);
        assert!((0..n).all(|m| leading_zeros(&Algo::Sha1.hash(&format!("ab{m}cd"))) < 1), "the least count");
        assert_eq!(says(&expr(json!({ "op": "format", "of": text("2026"), "read": { "as": "time", "form": "{yyyy}" }, "write": { "as": "time", "form": "{yy}" } })), &mut desk), "26");
        assert_eq!(says(&expr(json!({ "op": "stamp", "form": "{s}-{d3}-{x}" })), &mut desk), "1700000000-444-{x}");
        assert_eq!(says(&expr(json!({ "op": "fresh", "id": "a", "clock": "millis" })), &mut desk), "id");
        assert_eq!(eval(&expr(json!({ "op": "file", "slot": "up", "fact": "size" })), &mut desk), Err(Why::Slot("up".into())));
        desk.slots.insert("up".into(), "/tmp/a.txt".into());
        assert_eq!(eval(&expr(json!({ "op": "file", "slot": "up", "fact": "size" })), &mut desk), Err(Why::File { slot: "up".into(), reason: "/tmp/a.txt is unreadable".into() }));
        assert_eq!(eval(&expr(json!({ "op": "given", "name": "nobody" })), &mut desk), Err(Why::Slot("nobody".into())));
        assert_eq!(eval(&expr(json!({ "op": "stored", "area": "local", "key": "k" })), &mut desk), Ok(Outcome::Absent));
        assert_eq!(eval(&expr(json!({ "op": "cookie", "name": "sid" })), &mut desk), Ok(Outcome::Absent));
        assert_eq!(eval(&expr(json!({ "op": "nothing", "after": "s1" })), &mut desk), Err(Why::Source { step: "s1".into() }));
        desk.answered.push("s1".into());
        assert_eq!(eval(&expr(json!({ "op": "nothing", "after": "s1" })), &mut desk), Ok(Outcome::Absent));
        assert_eq!(eval(&expr(json!({ "op": "sent", "part": { "of": "path" } })), &mut desk), Err(Why::Unbuilt));
    }

    /// A word the walk sent is replaced by the caller's where it stands whole, never inside a longer word; a word that
    /// stands only inside another is replaced only when it is the one place it occurs, and an empty one replaces nothing.
    #[test]
    fn a_word_is_swapped_where_it_stands_whole_and_a_stamp_keeps_what_it_does_not_know() {
        assert_eq!(swapped("address addressed", "dress", "x"), "address addressed", "a word inside longer words, twice, is nowhere the walk's stood");
        assert_eq!(swapped("a red b red", "red", "blue"), "a blue b blue");
        assert_eq!(swapped("one address", "dress", "x"), "one adx", "the one place a word occurs is where the walk's stood");
        assert_eq!(swapped("keep", "", "x"), "keep");
        assert!(stands_as_a_word("{\"q\":\"search\"}", "search") && !stands_as_a_word("search_params", "search") && !stands_as_a_word("a", ""));
        let mut digits = |n: usize| "9".repeat(n);
        assert_eq!(stamped("t{ms}|{s}|{d2}|{dx}", 5000, &mut digits), "t5000|5|99|{dx}");
    }

    /// A stamp whose last brace is never closed keeps the text after its last token once, as it was written.
    #[test]
    fn a_stamp_with_an_unclosed_brace_keeps_the_text_once() {
        let mut digits = |n: usize| "9".repeat(n);
        assert_eq!(stamped("t{ms}|{open", 5000, &mut digits), "t5000|{open");
        assert_eq!(stamped("a{b", 5000, &mut digits), "a{b");
    }

    /// A body names only the expressions this node knows: one that names another does not read, and one with a
    /// field it does not know does not either, so nothing half understood ever runs.
    #[test]
    fn an_expression_this_node_does_not_know_does_not_read() {
        assert!(serde_json::from_value::<Expr>(json!({ "op": "eval", "code": "1+1" })).is_err());
        assert!(serde_json::from_value::<Expr>(json!({ "op": "text", "is": "a", "run": "rm -rf" })).is_err());
        assert!(serde_json::from_value::<Fits>(json!({ "when": "matches", "at": "/a", "is": { "op": "text", "is": "a" } })).is_err());
    }
}
