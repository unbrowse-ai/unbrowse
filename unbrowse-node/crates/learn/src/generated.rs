//! A producer the engine carries as a tiny program: proposed by an agent at learn time, verified against the walk's
//! own sightings, and run in a sandbox at call time.
//!
//! Some page code computes a header with a shape a fitted [`Recipe`](crate::signing::Recipe) cannot express: a
//! custom base64 alphabet, a second hashing stage, a rotation over values only the page's own module knows. The
//! graph's honest answer for those is [`Class::Script`](crate::graph::Class::Script) (the page's own code, run again)
//! or the browser. This module adds one more: a program written for the value, carried on the route as an opaque leaf.
//!
//! Nothing here trusts the generator. The evidence is the walk's own sightings; a program ships only when it
//! reproduces **every** sighting, survives a perturbed input it never saw, and carries none of the values it was
//! shown — a program that hardcodes a sighting is discarded. The verifier, not the model, decides. Generation happens
//! at learn time only (a command named by `UNBROWSE_GENERATE_PROGRAM` receives the evidence and answers the code);
//! a call runs the program, never a model. A program that fails at call time returns `NeedsBrowser`, never a guess.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// One sighting the walk recorded: the call as it stood, and the value the page's code wrote into `header`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub method: String,
    pub url: String,
    pub body: Option<String>,
    pub cookies: Vec<(String, String)>,
    /// The other request headers as sent, without the cookie header and without the one being produced.
    pub headers: Vec<(String, String)>,
    /// The value the page's own code wrote. Never carried on a route.
    pub expected: String,
    /// What that value was before the page encoded it, when the probe could see it (a `btoa` input). A hint for the
    /// generator, never carried on a route.
    pub pre: Option<String>,
}

/// What a route keeps of a generated producer: enough to audit it, and no sighting values (they are secrets).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    /// The header the program answers.
    pub header: String,
    /// How many of the walk's sightings the program reproduced.
    pub sightings: usize,
    /// Where the page's own code writes the value, when the walk found it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub producer: Option<crate::signing::Producer>,
    /// Who proposed the program, and a hash of the evidence it was given (so a route says what it was made from).
    pub proposed_by: String,
    pub evidence_hash: String,
    /// Whether the program reproduced the walk's own values. One that did not still ships when a call the site answers
    /// proves its value is accepted (`learn`'s trial); a shared route carries it as the browser's either way.
    #[serde(default = "reproduced")]
    pub exact: bool,
    /// The page scripts the program needs at call time, by URL: one that names a global the slice could not carry
    /// inline. Empty for a self-contained program, which is most of them — the slice brings the page's own code.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<String>,
}

fn reproduced() -> bool {
    true
}

/// The browser the page's own code saw, as the walk recorded it: the fingerprint sample and the two storages. A
/// program that copies page code reads the same navigator, screen, canvas and storage the page read, so its arithmetic
/// is the page's. This is the walk's, never a site's: the same environment is what the signing bridge boots scripts
/// with, and every site gets it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Environment {
    #[serde(default)]
    pub fingerprint: serde_json::Value,
    #[serde(default)]
    pub storage: crate::sandbox::Storage,
    /// The page the program's code was written for, and the markup and data answers the page read. A program that
    /// copies page code runs in the page-shaped sandbox when these are here: the same environment the page's own code
    /// ran in, which is what a lifted computation needs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
    /// The page's own scripts, in load order. They run before the program, so a global the page defines (a class, its
    /// own encoder) exists for a program that calls it — the page's runtime as an opaque leaf.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<crate::signing::Answer>,
}

/// Runs a program in the environment its code was written for: the page-shaped sandbox when the walk carried a page,
/// the minimal one otherwise. The same program, and the same recorded environment, is what the verifier uses.
fn call(program: &str, ctx: &serde_json::Value, env: &Environment) -> Result<String, String> {
    match (env.page_url.as_deref(), env.html.as_deref()) {
        (Some(page), Some(html)) => crate::sandbox::run_program_on_page(program, ctx, &env.fingerprint, &env.storage, page, html, &env.answers, &env.scripts),
        _ => crate::sandbox::run_program(program, ctx, &env.fingerprint, &env.storage),
    }
}

/// Whether a program may ship.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// It rebuilt every sighting, and still answers an input it never saw: no call is needed to trust it.
    Passed,
    /// It ran on every sighting but its values differ from the walk's — a page encoder seeded by the browser, say. Only
    /// a call the site answers can decide whether such a value is accepted, so the learner tries it.
    Differs,
    Failed(String),
}

/// Whether a generative agent is configured at all. Without one, nothing is generated and the route reaches for the
/// page's own code (`Class::Script`) as before.
pub fn enabled() -> bool {
    std::env::var("UNBROWSE_GENERATE_PROGRAM").ok().is_some_and(|v| !v.trim().is_empty())
}

/// The context a program is given for one call. The same shape is used to fit and to call, so a program verified on
/// the walk's sightings reads a call the same way.
pub fn context_of(method: &str, url: &str, body: Option<&str>, cookies: &[(String, String)], headers: &[(String, String)]) -> serde_json::Value {
    let parsed = url::Url::parse(url).ok();
    let cookie_map: serde_json::Map<String, serde_json::Value> = cookies.iter().map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone()))).collect();
    let header_map: serde_json::Map<String, serde_json::Value> = headers
        .iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("cookie"))
        .map(|(k, v)| (k.to_ascii_lowercase(), serde_json::Value::String(v.clone())))
        .collect();
    serde_json::json!({
        "method": method.to_uppercase(),
        "url": url,
        "path": parsed.as_ref().map(|u| u.path().to_string()).unwrap_or_default(),
        "pathname": parsed.as_ref().map(|u| u.path().to_string()).unwrap_or_default(),
        "search": parsed.as_ref().and_then(|u| u.query()).map(|q| format!("?{q}")).unwrap_or_default(),
        "host": parsed.as_ref().and_then(|u| u.host_str()).unwrap_or_default(),
        "origin": parsed.as_ref().map(|u| u.origin().ascii_serialization()).unwrap_or_default(),
        "body": body,
        "cookies": cookie_map,
        "headers": header_map,
        // The time the request says it was made, when it says one: a program that reads the clock is run at that
        // time, so a value the page mixed its clock into is rebuilt as the page built it.
        "sent_at": time_it_carries(url, body, headers),
    })
}

/// The moment a request carries as its own, in milliseconds: the one number in its address, body or headers that
/// reads as a time of this era (thirteen digits of milliseconds, or ten of seconds). A request that carries none,
/// or two that differ, says nothing: the clock is then the engine's own.
pub fn time_it_carries(url: &str, body: Option<&str>, headers: &[(String, String)]) -> Option<u64> {
    let text = format!("{url} {} {}", body.unwrap_or_default(), headers.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(" "));
    let mut millis: std::collections::BTreeSet<u64> = Default::default();
    let mut seconds: std::collections::BTreeSet<u64> = Default::default();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        // A run of digits on its own: not part of a longer number, a decimal or an id with letters.
        let alone = (start == 0 || !(bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'.')) && (i == bytes.len() || !(bytes[i].is_ascii_alphanumeric() || bytes[i] == b'.'));
        let Some(n) = alone.then(|| text[start..i].parse::<u64>().ok()).flatten() else { continue };
        match i - start {
            13 if (1_500_000_000_000..2_100_000_000_000).contains(&n) => {
                millis.insert(n);
            }
            10 if (1_500_000_000..2_100_000_000).contains(&n) => {
                seconds.insert(n);
            }
            _ => {}
        }
    }
    match (millis.len(), seconds.len()) {
        (1, _) => millis.first().copied(),
        (0, 1) => seconds.first().map(|s| s * 1000),
        _ => None,
    }
}

/// The context for one sighting.
pub fn sample_context(sample: &Sample) -> serde_json::Value {
    context_of(&sample.method, &sample.url, sample.body.as_deref(), &sample.cookies, &sample.headers)
}

/// Runs the program for one call, with the same context shape the samples used.
pub fn compute(program: &str, request: &crate::replay::Request, cookies: &[(String, String)], env: &Environment) -> Option<String> {
    let body = request.text();
    let headers: Vec<(String, String)> = request.headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie")).cloned().collect();
    call(program, &context_of(&request.method, request.url.as_str(), body, cookies, &headers), env).ok()
}

/// Runs a decoder over a reply the standard readers could not: `ctx.body` is the raw reply text, and the program
/// answers the decoded text (the page's own code unpacks a ciphered or obfuscated answer). The minimal sandbox, as a
/// decoder is a pure function of the reply; None when it did not run or answered nothing.
pub fn decode(program: &str, reply: &str, env: &Environment) -> Option<String> {
    let ctx = serde_json::json!({ "method": "GET", "url": "", "path": "", "search": "", "host": "", "origin": "", "body": reply, "cookies": {}, "headers": {} });
    crate::sandbox::run_program(program, &ctx, &env.fingerprint, &env.storage).ok().filter(|v| !v.is_empty())
}

/// Whether a decoder may ship: on every walk's reply it answers JSON that holds the word that walk was asked (what the
/// page then showed), the answers differ between walks (not a constant), and the raw reply does not already read as
/// that JSON by itself (the standard readers could not -- else this is no rung-2 decode). Two replies at least.
pub fn verify_decoder(program: &str, replies: &[(String, Vec<String>)], already: &dyn Fn(&str) -> bool, env: &Environment) -> bool {
    if replies.len() < 2 {
        return false;
    }
    let mut decoded: Vec<String> = Vec::new();
    for (reply, words) in replies {
        if already(reply) {
            return false;
        }
        let Some(out) = decode(program, reply, env) else { return false };
        if serde_json::from_str::<serde_json::Value>(&out).is_err() {
            return false;
        }
        let low = out.to_lowercase();
        if !words.iter().filter(|w| !w.is_empty()).all(|w| low.contains(&w.to_lowercase())) {
            return false;
        }
        decoded.push(out);
    }
    decoded.iter().any(|d| d != &decoded[0])
}

/// The `navigator` property a program read, as the key the sandbox's recorded browser answers it under. None for a
/// property the sandbox answers from no recording.
pub fn navigator_key(name: &str) -> Option<&'static str> {
    Some(match name {
        "userAgent" => "ua",
        "language" => "lang",
        "languages" => "langs",
        "platform" => "platform",
        "vendor" => "vendor",
        "hardwareConcurrency" => "cores",
        "maxTouchPoints" => "touch",
        _ => return None,
    })
}

/// The environment and the cookies a program runs with when its reads are fed (`route::Expr::ProgramReading`): each
/// read put where the page's own code finds it — a cookie in the jar `document.cookie` lists, a key in the store it
/// names, a property on `navigator`. A read fed nothing is taken away, as a page that lacked it would find nothing.
/// The one function both the learner (holding a program to each walk) and the caller (running it for a call) use, so
/// what was verified is what runs.
pub fn fed(env: &Environment, cookies: &[(String, String)], fed: &[(unbrowse_route::Reach, Option<String>)]) -> (Environment, Vec<(String, String)>) {
    use unbrowse_route::Reach;
    let mut env = env.clone();
    let mut cookies = cookies.to_vec();
    if !env.fingerprint.is_object() {
        env.fingerprint = serde_json::json!({});
    }
    for (read, value) in fed {
        match read {
            Reach::Cookie(name) => {
                cookies.retain(|(k, _)| k != name);
                if let Some(v) = value {
                    cookies.push((name.clone(), v.clone()));
                }
            }
            Reach::Local(key) | Reach::Session(key) => {
                let store = if matches!(read, Reach::Local(_)) { &mut env.storage.local } else { &mut env.storage.session };
                match value {
                    Some(v) => store.insert(key.clone(), v.clone()),
                    None => store.remove(key),
                };
            }
            Reach::Navigator(name) => {
                let (Some(key), Some(fp)) = (navigator_key(name), env.fingerprint.as_object_mut()) else { continue };
                match value {
                    // A list of languages is said as the header says it, one after another.
                    Some(v) if key == "langs" => fp.insert(key.into(), serde_json::json!(v.split(',').map(|l| l.split(';').next().unwrap_or_default().trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>())),
                    Some(v) => fp.insert(key.into(), serde_json::Value::String(v.clone())),
                    None => fp.remove(key),
                };
            }
        }
    }
    (env, cookies)
}

/// [`compute`], for a program whose reads are fed.
pub fn compute_reading(program: &str, request: &crate::replay::Request, cookies: &[(String, String)], env: &Environment, reads: &[(unbrowse_route::Reach, Option<String>)]) -> Option<String> {
    let (env, cookies) = fed(env, cookies, reads);
    compute(program, request, &cookies, &env)
}

/// What a program read of the page's world when run on one sighting: the sandbox's own names for each read
/// (`localStorage seed`, `document.cookie`, `navigator.userAgent`, `the clock`, …), the minimal sandbox's. Empty with
/// no runtime.
pub fn reads_of(program: &str, sample: &Sample, env: &Environment) -> Vec<String> {
    crate::sandbox::run_program_read(program, &sample_context(sample), &env.fingerprint, &env.storage).1.read
}

/// Whether a program embeds one of the values it was shown: the cheapest hardcode, and the one the gate must never
/// let through. A real producer may carry a constant prefix, but a whole value it reproduced is the answer, not a
/// computation of it.
fn hardcodes(program: &str, samples: &[Sample]) -> bool {
    samples.iter().any(|s| {
        let v = s.expected.trim();
        v.len() >= 8 && program.contains(v)
    })
}

/// A sighting's input with one value moved, for a run the program never saw: a program that only answers the exact
/// sightings it was shown fails here instead of at a caller's first different call. The expected value is unknown for
/// a perturbed input, so this asks only that the program still run and answer.
fn perturbed(sample: &Sample) -> Sample {
    let mut out = sample.clone();
    if let Ok(mut u) = url::Url::parse(&sample.url) {
        let path = u.path().to_string();
        let mut bytes = path.into_bytes();
        match bytes.iter().rposition(|b| b.is_ascii_digit()) {
            Some(i) => {
                bytes[i] = if bytes[i] == b'9' { b'8' } else { bytes[i] + 1 };
                u.set_path(&String::from_utf8_lossy(&bytes));
            }
            None => u.set_query(Some("ubrowse=1")),
        }
        out.url = u.to_string();
    } else {
        out.url = format!("{}?ubrowse=1", sample.url);
    }
    out
}

/// Whether a program may ship: it reproduces every sighting, doesn't carry a sighting's value, and still answers an
/// input it never saw. Two sightings minimum: one is a program that could be a constant.
pub fn verify(program: &str, samples: &[Sample], env: &Environment) -> Verdict {
    if program.trim().is_empty() {
        return Verdict::Failed("the agent proposed no program".into());
    }
    if samples.is_empty() {
        return Verdict::Failed("no sighting of the value to judge a program by".into());
    }
    // Two sightings are what proves a program; one is what a call can decide. A one-sighting program is never
    // `Passed` — it could be a constant — but it may still be a candidate.
    let proven = samples.len() >= 2;
    if hardcodes(program, samples) {
        return Verdict::Failed("the program carries a sighting's own value instead of computing it".into());
    }
    // A page-shaped environment boots the page's scripts once and evaluates every sample in that runtime; a minimal
    // environment runs the program per sample, where there is no page to boot.
    if let (Some(page), Some(html)) = (env.page_url.as_deref(), env.html.as_deref()) {
        let mut contexts: Vec<serde_json::Value> = samples.iter().map(sample_context).collect();
        contexts.push(sample_context(&perturbed(&samples[0])));
        return match crate::sandbox::run_program_on_page_many(program, &contexts, &env.fingerprint, &env.storage, page, html, &env.answers, &env.scripts) {
            Ok(values) if values.len() == contexts.len() => {
                let mut differs = false;
                for (n, sample) in samples.iter().enumerate() {
                    match values.get(n) {
                        Some(value) if value == &sample.expected => {}
                        Some(_) => differs = true,
                        None => return Verdict::Failed(format!("answered no value for sighting {} of {}", n + 1, samples.len())),
                    }
                }
                if values.last().is_none_or(|v| v.is_empty()) {
                    return Verdict::Failed("answered nothing on an input it never saw".into());
                }
                if differs || !proven {
                    Verdict::Differs
                } else {
                    Verdict::Passed
                }
            }
            Ok(_) => Verdict::Failed("the page sandbox answered fewer values than it was given".into()),
            Err(why) => Verdict::Failed(why),
        };
    }
    verify_each(program, samples, &vec![env.clone(); samples.len()])
}

/// [`verify`], with each sighting run in its own environment: a program whose reads of the page's world are fed
/// ([`fed`]) is held to each walk with what that walk's page had (its storage, its cookies, its browser), and to the
/// perturbed input with the first walk's. The same judge: every sighting reproduced, no sighting's value carried, an
/// input it never saw still answered. The minimal sandbox only; a page-shaped environment is one boot for all.
pub fn verify_each(program: &str, samples: &[Sample], envs: &[Environment]) -> Verdict {
    if program.trim().is_empty() {
        return Verdict::Failed("the agent proposed no program".into());
    }
    if samples.is_empty() || envs.len() != samples.len() {
        return Verdict::Failed("no sighting of the value to judge a program by".into());
    }
    let proven = samples.len() >= 2;
    if hardcodes(program, samples) {
        return Verdict::Failed("the program carries a sighting's own value instead of computing it".into());
    }
    let mut differs = false;
    for (n, (sample, env)) in samples.iter().zip(envs).enumerate() {
        match call(program, &sample_context(sample), env) {
            Ok(value) if value == sample.expected => {}
            Ok(_) => differs = true,
            Err(why) => return Verdict::Failed(format!("failed on sighting {} of {}: {why}", n + 1, samples.len())),
        }
    }
    match call(program, &sample_context(&perturbed(&samples[0])), &envs[0]) {
        Ok(value) if !value.is_empty() => {
            if differs || !proven {
                Verdict::Differs
            } else {
                Verdict::Passed
            }
        }
        Ok(_) => Verdict::Failed("answered nothing on an input it never saw".into()),
        Err(why) => Verdict::Failed(format!("failed on an input it never saw: {why}")),
    }
}

/// The evidence an agent is given: the interface, the sightings, and the page's own code around the place it writes
/// the value (when the walk found it). Only exchanged at learn time, never carried on a route.
#[derive(Serialize)]
struct Proposal<'a> {
    header: &'a str,
    instruction: &'a str,
    samples: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_code: Option<&'a str>,
    /// Why the previous program was rejected, when this is a retry: the agent is told what the verifier saw, so it
    /// repairs instead of repeating.
    #[serde(skip_serializing_if = "Option::is_none")]
    feedback: Option<&'a str>,
}

const INSTRUCTION: &str = "The site's own JavaScript computes the request header named in `header`. Write one \
self-contained JavaScript function `function sign(ctx)` that returns that header's value as a string. `ctx` is \
{ method, url, path, pathname, search, host, origin, body, cookies, headers }: cookies and headers are objects keyed \
by name, body is a string or null. Use only standard JavaScript, Math, JSON, TextEncoder/TextDecoder, atob/btoa, \
Buffer, and crypto.createHash/createHmac (e.g. crypto.createHash('md5').update(s).digest('hex')). The runtime provides `md5(text)`, `sha1(text)`, `sha256(text)`, `sha512(text)`, `hmacSha256(key, text)`, \
`base64(text)`, `base64url(text)` and `hex(text)`: the page's own module calls (`n.md5(x)`) are these. The page's own \
scripts have ALREADY RUN in the runtime: a global they define is available on `window` (for example \
`window.c_sign.toString(md5(ctx.body))`), so you can call the page's own code instead of copying it. There are NO \
other globals named md5, sha1, sha256, md5sum, hmac, CryptoJS, process, or fetch. You MAY also copy functions or \
module code from the page code verbatim and call them, including obfuscated code: you do not have to understand it, \
only make it run. The program runs with a page-shaped surface (window, document stubs, screen, navigator, location, localStorage, \
sessionStorage, atob/btoa, Buffer) and no network, filesystem, or timers. Do not use randomness. Answer ONLY the \
function's source, with no sentence before or after it and no markdown fence.";

/// What a sample's context shows an agent: the names and shapes, never a session secret. Cookies and credential
/// headers are replaced by their length; a program reads the real values at call time from `ctx`, so the generator
/// does not need them. The body, URL and expected value stay — they are what the computation is about.
fn shown_context(ctx: &serde_json::Value) -> serde_json::Value {
    let mut shown = ctx.clone();
    let mask = |v: &serde_json::Value| -> serde_json::Value {
        match v.as_str() {
            Some(s) if !s.is_empty() => serde_json::Value::String(format!("<redacted {} chars>", s.chars().count())),
            _ => serde_json::Value::String("<redacted>".into()),
        }
    };
    if let Some(cookies) = shown.get_mut("cookies").and_then(|c| c.as_object_mut()) {
        for v in cookies.values_mut() {
            *v = mask(v);
        }
    }
    if let Some(headers) = shown.get_mut("headers").and_then(|h| h.as_object_mut()) {
        let secret = ["authorization", "cookie", "token", "api-key", "apikey", "secret", "signature", "csrf", "xsrf"];
        for (k, v) in headers.iter_mut() {
            if secret.iter().any(|s| k.to_ascii_lowercase().contains(s)) {
                *v = mask(v);
            }
        }
    }
    shown
}

/// Asks the configured agent for a program. The command reads the evidence JSON on stdin and writes the code on
/// stdout. No agent configured, a refusal, or an empty answer is `None` — the route keeps the page's own code.
pub fn propose(header: &str, samples: &[Sample], page_code: Option<&str>, feedback: Option<&str>) -> Option<String> {
    let command = std::env::var("UNBROWSE_GENERATE_PROGRAM").ok().filter(|c| !c.trim().is_empty())?;
    let proposal = Proposal {
        header,
        instruction: INSTRUCTION,
        samples: samples
            .iter()
            .map(|s| {
                let mut shown = serde_json::json!({ "context": shown_context(&sample_context(s)), "expected": s.expected });
                if let Some(pre) = &s.pre {
                    shown["pre_encoded_from"] = serde_json::Value::String(pre.clone());
                }
                shown
            })
            .collect(),
        page_code,
        feedback,
    };
    let input = serde_json::to_string(&proposal).ok()?;
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [generated] asking `{command}` for {header} from {} sightings ({} bytes){}", samples.len(), input.len(), if feedback.is_some() { ", a retry" } else { "" });
    }
    let said = run_agent(&command, &input)?;
    let code = code_of(&said)?;
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [generated] {header}: {} bytes of program", code.len());
    }
    Some(code)
}

/// The hash of the evidence a program was proposed from, for a route to name what it was made from.
pub fn evidence_hash(header: &str, samples: &[Sample]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(header.as_bytes());
    for s in samples {
        h.update(s.method.as_bytes());
        h.update(s.url.as_bytes());
        h.update(s.body.as_deref().unwrap_or_default().as_bytes());
        h.update(s.expected.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The first line of a command, as its own name: a route says who proposed a program without carrying a whole
/// invocation's arguments.
pub fn who(command: &str) -> String {
    command.split_whitespace().next().unwrap_or(command).to_string()
}

/// Runs the agent command with `input` on stdin and answers its stdout. Bounded: an agent that hangs is killed, and
/// the route keeps the page's own code.
/// Runs a proposer's command with `input` on its stdin and hands back what it wrote, within the agent's budget.
pub fn run_agent(command: &str, input: &str) -> Option<String> {
    let budget = std::env::var("UNBROWSE_GENERATE_MS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(180_000u64);
    let mut child = Command::new("sh").arg("-c").arg(command).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let payload = input.to_string();
    // The write and the read run beside the wait: an agent that answers more than a pipe holds must not be read as a
    // hang, and one that never reads its stdin must not block us.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(payload.as_bytes());
    });
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut said = String::new();
        let _ = stdout.read_to_string(&mut said);
        said
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = writer.join();
                let said = reader.join().ok()?;
                return status.success().then_some(said);
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("   [generated] the agent ran past {budget}ms: the route keeps the page's own code");
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

/// The program in what an agent said: the code itself, or what a markdown fence holds (an agent that explains is
/// still read for its code). Prose before an unfenced program is cut off at the first line that starts it.
fn code_of(said: &str) -> Option<String> {
    let said = said.trim();
    if said.is_empty() {
        return None;
    }
    if let Some(start) = said.find("```") {
        let after = &said[start + 3..];
        let after = after.strip_prefix("javascript").or_else(|| after.strip_prefix("js")).unwrap_or(after);
        let after = after.trim_start_matches(['\n', '\r']);
        if let Some(end) = after.find("```") {
            let code = after[..end].trim();
            if !code.is_empty() {
                return Some(code.to_string());
            }
        }
    }
    let starts = ["function sign", "async function sign", "const sign", "let sign", "var sign", "sign =", "module.exports"];
    let at = starts.iter().filter_map(|m| said.find(m)).min();
    Some(at.map(|i| &said[i..]).unwrap_or(said).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A request that says when it was made is replayed at that time: a program that mixes the clock into its value
    /// rebuilds the walk's value, and reads the page's cookies as the request carried them. A request that carries
    /// no time, or two, leaves the clock to the engine.
    #[test]
    fn a_program_that_reads_the_clock_is_run_at_the_time_its_request_carries() {
        assert_eq!(time_it_carries("https://a.example/api?t=1794402610160&appKey=24677475", None, &[]), Some(1_794_402_610_160));
        assert_eq!(time_it_carries("https://a.example/api", Some(r#"{"ts":1794402610}"#), &[]), Some(1_794_402_610_000));
        assert_eq!(time_it_carries("https://a.example/api?t=1794402610160&u=1794402699999", None, &[]), None, "two times say nothing");
        assert_eq!(time_it_carries("https://a.example/api?id=17944026101601&v=3.14", None, &[]), None, "an id is no time");
        if !crate::sandbox::available() {
            return;
        }
        let program = "function sign(ctx) { var tk = (document.cookie.match(/tk=([^;]+)/) || [])[1]; return md5(tk + '&' + Date.now() + '&' + ctx.body); }";
        let ctx = context_of("POST", "https://a.example/api?t=1794402610160", Some("q=lamps"), &[("tk".into(), "s3cr3t".into())], &[]);
        let (answer, read) = crate::sandbox::run_program_read(program, &ctx, &serde_json::Value::Null, &Default::default());
        // The same hash of the same text with the time written out: what the page would have built at that moment.
        let written = "function sign(ctx) { return md5('s3cr3t&1794402610160&q=lamps'); }";
        let expected = crate::sandbox::run_program(written, &serde_json::json!({}), &serde_json::Value::Null, &Default::default()).expect("the engine hashes");
        assert_eq!(answer.as_deref(), Ok(expected.as_str()));
        assert!(read.unanswered.is_empty(), "the cookie the request carried answers the page's read: {:?}", read.unanswered);
    }

    /// A program's reads of the world are said back with its answer: the clock, randomness, storage, the browser,
    /// the document. A read nothing answered is named, and a program that then fails says so in its error.
    #[test]
    fn a_program_says_what_it_read_and_what_nothing_answered() {
        if !crate::sandbox::available() {
            return;
        }
        let storage: crate::sandbox::Storage = serde_json::from_value(serde_json::json!({ "local": { "deviceId": "d-7f3a" } })).unwrap_or_default();
        let program = "function sign(ctx) { var t = Date.now(); var r = Math.random(); return [localStorage.getItem('deviceId'), localStorage.getItem('visit'), navigator.userAgent, document.cookie, String(t > 0 && r < 1)].join('|'); }";
        let (answer, read) = crate::sandbox::run_program_read(program, &serde_json::json!({}), &serde_json::Value::Null, &storage);
        assert!(answer.as_deref().is_ok_and(|v| v.starts_with("d-7f3a||")), "{answer:?}");
        for what in ["the clock", "randomness", "localStorage deviceId", "localStorage visit", "navigator.userAgent", "document.cookie"] {
            assert!(read.read.iter().any(|r| r == what), "{what} in {:?}", read.read);
        }
        assert_eq!(read.unanswered, vec!["localStorage visit".to_string(), "document.cookie".to_string()]);
        let failing = "function sign(ctx) { return sessionStorage.getItem('token').slice(0, 4); }";
        let error = crate::sandbox::run_program(failing, &serde_json::json!({}), &serde_json::Value::Null, &Default::default()).unwrap_err();
        assert!(error.contains("sessionStorage token"), "the missing read is named: {error}");
    }

    fn sample(url: &str, body: Option<&str>, expected: &str) -> Sample {
        Sample {
            method: "POST".into(),
            url: url.into(),
            body: body.map(String::from),
            cookies: vec![("sid".into(), "c-1".into())],
            headers: vec![("x-trace".into(), "t-9".into())],
            expected: expected.into(),
            pre: None,
        }
    }

    fn runtime() -> bool {
        crate::sandbox::available()
    }

    /// A program that actually computes the value from the call passes; one that returns the sighting it was shown
    /// fails, whether it returns it plainly or carries it as a literal.
    #[test]
    fn a_correct_program_passes_and_a_hardcoded_one_fails() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the verifier is skipped");
            return;
        }
        let samples = vec![
            sample("https://shop.example/api/items?d=1", Some("{\"d\":1}"), "unused"),
            sample("https://shop.example/api/items?d=2", Some("{\"d\":2}"), "unused"),
        ];
        // A real producer: a hash over the path, the body and the session's cookie.
        let good = "function sign(ctx) { const s = ctx.path + '|' + (ctx.body || '') + '|' + (ctx.cookies.sid || ''); return 'sig-' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 4); }";
        let samples = samples
            .into_iter()
            .map(|s| {
                let v = format!("sig-{}", &sha(&format!("{}|{}|c-1", url::Url::parse(&s.url).unwrap().path(), s.body.clone().unwrap_or_default()))[..4]);
                Sample { expected: v, ..s }
            })
            .collect::<Vec<_>>();
        assert_eq!(verify(good, &samples, &Environment::default()), Verdict::Passed);
        // A program that runs and answers, but not with the walk's value, is a candidate only a call can decide.
        let plain = "function sign(ctx) { return 'sig-not-the-walks'; }";
        assert_eq!(verify(plain, &samples, &Environment::default()), Verdict::Differs);
        // One that carries a sighting's own value is never a candidate: that is the answer, not a computation.
        let carried = format!("function sign(ctx) {{ return '{}'; }}", samples[0].expected);
        assert!(matches!(verify(&carried, &samples, &Environment::default()), Verdict::Failed(_)));
        // One that does not run at all is no candidate either.
        assert!(matches!(verify("function sign(ctx) { throw new Error('no'); }", &samples, &Environment::default()), Verdict::Failed(_)));
    }

    fn sha(text: &str) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A program that only answers the exact sightings it was shown (a lookup keyed by URL) fails the perturbed run.
    #[test]
    fn a_program_that_only_answers_its_sightings_fails_on_a_new_input() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the verifier is skipped");
            return;
        }
        let samples = vec![
            sample("https://shop.example/a/x", None, "one"),
            sample("https://shop.example/a/y", None, "two"),
        ];
        let lookup = "function sign(ctx) { const t = { 'https://shop.example/a/x': 'one', 'https://shop.example/a/y': 'two' }; return t[ctx.url]; }";
        // It reproduces both sightings, but the perturbed URL is in neither table.
        assert!(matches!(verify(lookup, &samples, &Environment::default()), Verdict::Failed(_)));
    }

    /// A program that copies page code reads the browser the page saw: the walk's fingerprint and storage, not a
    /// made-up one. Nothing here names a site — the environment is the walk's.
    #[test]
    fn a_program_reads_the_browser_the_page_saw() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the environment test is skipped");
            return;
        }
        let env = Environment {
            fingerprint: serde_json::json!({ "ua": "WalkedUA/1.0", "screen": { "width": 1234 }, "cores": 12 }),
            storage: crate::sandbox::Storage { local: [("k".to_string(), "v".to_string())].into_iter().collect(), session: Default::default() },
            ..Default::default()
        };
        let program = "function sign(ctx) { return navigator.userAgent + '|' + screen.width + '|' + navigator.hardwareConcurrency + '|' + localStorage.getItem('k'); }";
        let value = crate::sandbox::run_program(program, &serde_json::json!({}), &env.fingerprint, &env.storage).expect("the program runs");
        assert_eq!(value, "WalkedUA/1.0|1234|12|v");
    }

    /// One sighting cannot prove a program — it could be a constant — so even one that reproduces it is only a
    /// candidate a call decides.
    #[test]
    fn one_sighting_is_a_candidate_never_a_proof() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the one-sighting test is skipped");
            return;
        }
        let sample = sample("https://shop.example/a/12345678", None, "x-12345678");
        let program = "function sign(ctx) { return 'x-' + ctx.path.split('/').pop(); }";
        assert_eq!(verify(program, std::slice::from_ref(&sample), &Environment::default()), Verdict::Differs);
        assert!(matches!(verify("function sign(ctx) { return 'x-12345678'; }", &[sample], &Environment::default()), Verdict::Failed(_)));
    }

    /// A program that copies page code runs in the page-shaped sandbox: the environment, the DOM surface and the
    /// recorded fingerprint the page's own code had. This is the same harness the page's scripts run in.
    /// The runtime's primitives are what a page's module calls: a program can name `md5` instead of a bundler
    /// import.
    #[test]
    fn a_program_can_name_the_runtimes_primitives() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the primitives test is skipped");
            return;
        }
        let program = "function sign(ctx) { return md5('ab') + '|' + base64('ab'); }";
        let value = crate::sandbox::run_program(program, &serde_json::json!({}), &serde_json::Value::Null, &Default::default()).expect("it runs");
        assert_eq!(value, "187ef4436122d1cc2f40dc2b92f0eba0|YWI=");
    }

    /// The page-shaped runtime carries the same primitives inside the program's scope, so a copied module's
    /// `n.md5(x)` can be written as `md5(x)`.
    #[test]
    fn a_page_shaped_program_has_the_primitives() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the page-shaped primitives test is skipped");
            return;
        }
        let program = "function sign(ctx) { return md5('ab'); }";
        let value = crate::sandbox::run_program_on_page(program, &serde_json::json!({}), &serde_json::Value::Null, &Default::default(), "https://shop.example/search", "<html></html>", &[], &[]).expect("it runs");
        assert_eq!(value, "187ef4436122d1cc2f40dc2b92f0eba0");
    }

    /// The page's own scripts run before the program: a global the page defines exists for it, so a program can call
    /// the page's runtime instead of reproducing it.
    /// The verifier boots the page once and evaluates every sample in it: both sighting values come from one runtime.
    #[test]
    fn a_page_shaped_verify_evaluates_every_sample_in_one_boot() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the page-shaped verify test is skipped");
            return;
        }
        let env = Environment {
            fingerprint: serde_json::Value::Null,
            storage: Default::default(),
            page_url: Some("https://shop.example/search".into()),
            html: Some("<html></html>".into()),
            answers: vec![],
            scripts: vec![("https://shop.example/page.js".into(), "(function(){window.pageGlobal=true})()".into())],
        };
        let samples = vec![
            sample("https://shop.example/api?d=1", Some("a"), "a"),
            sample("https://shop.example/api?d=2", Some("b"), "b"),
        ];
        let program = "function sign(ctx) { return ctx.body; }";
        assert_eq!(verify(program, &samples, &env), Verdict::Passed);
    }

    /// The page's own scripts have run, so a program can call the global they define — the page's encoder — instead
    /// of reproducing it. That is the producer for a body-bound header: page code, no browser.
    #[test]
    fn a_program_can_call_the_pages_own_encoder() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the page-encoder test is skipped");
            return;
        }
        let env = Environment {
            fingerprint: serde_json::Value::Null,
            storage: Default::default(),
            page_url: Some("https://shop.example/search".into()),
            html: Some("<html></html>".into()),
            answers: vec![],
            scripts: vec![(
                "https://shop.example/enc.js".into(),
                "(function(){window.enc={toString:function(s){return 'E'+s}}})()".into(),
            )],
        };
        let program = "function sign(ctx) { return window.enc.toString(ctx.body); }";
        let samples = vec![
            sample("https://shop.example/api?d=1", Some("a"), "Ea"),
            sample("https://shop.example/api?d=2", Some("b"), "Eb"),
        ];
        assert_eq!(verify(program, &samples, &env), Verdict::Passed);
    }

    #[test]
    fn the_pages_scripts_run_before_the_program() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the page-scripts test is skipped");
            return;
        }
        let scripts = vec![("https://shop.example/page.js".to_string(), "(function(){window.pageGlobal=function(){return 'g'}})()".to_string())];
        let program = "function sign(ctx) { return pageGlobal(); }";
        let value = crate::sandbox::run_program_on_page(program, &serde_json::json!({}), &serde_json::Value::Null, &Default::default(), "https://shop.example/search", "<html></html>", &[], &scripts).expect("it runs");
        assert_eq!(value, "g");
    }

    #[test]
    fn a_program_runs_in_the_page_shaped_sandbox() {
        if !runtime() {
            eprintln!("no signing runtime on this machine: the page-shaped test is skipped");
            return;
        }
        let env = Environment {
            fingerprint: serde_json::json!({ "ua": "WalkedUA/2.0" }),
            storage: Default::default(),
            page_url: Some("https://shop.example/search".into()),
            html: Some("<html><head></head><body></body></html>".into()),
            answers: vec![],
            scripts: vec![],
        };
        let program = "function sign(ctx) { return navigator.userAgent + '|' + (typeof document) + '|' + (typeof window); }";
        let value = crate::sandbox::run_program_on_page(program, &serde_json::json!({}), &env.fingerprint, &env.storage, env.page_url.as_deref().unwrap(), env.html.as_deref().unwrap(), &[], &[]).expect("the program runs");
        assert_eq!(value, "WalkedUA/2.0|object|object");
    }

    /// A generator sees cookie and credential-header names and shapes, never their values: the program reads the
    /// real ones at call time.
    #[test]
    fn a_generator_never_sees_a_session_secret() {
        let s = sample("https://shop.example/api?d=1", Some("{\"d\":1}"), "x");
        let mut ctx = sample_context(&s);
        ctx["cookies"]["sid"] = serde_json::json!("c-1-2-3-4");
        ctx["headers"]["authorization"] = serde_json::json!("Bearer super-secret");
        let shown = shown_context(&ctx);
        assert_eq!(shown["cookies"]["sid"], "<redacted 9 chars>");
        assert_eq!(shown["headers"]["authorization"], "<redacted 19 chars>");
        assert_eq!(shown["headers"]["x-trace"], "t-9", "a non-credential header stays");
        assert_eq!(shown["body"], "{\"d\":1}", "the body is what the computation is about");
    }

    #[test]
    fn the_context_is_the_call_as_the_page_saw_it() {
        let s = sample("https://shop.example/api/items?d=1", Some("{\"d\":1}"), "x");
        let ctx = sample_context(&s);
        assert_eq!(ctx["path"], "/api/items");
        assert_eq!(ctx["search"], "?d=1");
        assert_eq!(ctx["cookies"]["sid"], "c-1");
        assert_eq!(ctx["headers"]["x-trace"], "t-9");
        assert_eq!(ctx["body"], "{\"d\":1}");
        assert_eq!(ctx["method"], "POST");
    }
}
