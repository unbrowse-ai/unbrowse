//! Values the page's own code makes: the producer a walk recorded, and the bridge that runs it again.
//!
//! A site's anti-bot headers are computed by its scripts from the request and the page's session — an MD5 over the
//! request and a trace id, a `w-payload-source` from the site's cSign module, a `x-ctx-fvpc` from its fingerprint
//! script. The graph classes those fields `Computed` ("made by the page's own code; only a browser can produce it"),
//! and a step with one is run in the browser.
//!
//! The producer is in the walk: its scripts are captured, and the header it writes is named in one of them. This
//! module finds, for every computed field, the script and the place that writes it, and makes the field a
//! [`Class::Script`] carrying that producer. Replay then asks the transport for the value
//! ([`crate::replay::Fetch::sign_request`]): a transport with a signing bridge runs the producer — a sandbox, a page
//! kept warm — for any site, with no per-site code. A transport with no bridge answers `None`, and the call falls
//! back to the browser exactly as it did before.
//!
//! Nothing here knows a site's shape: a producer is whatever the walk's own code names.

use serde::{Deserialize, Serialize};

use crate::graph::{Class, Graph};
use crate::trace::Probe;
use crate::trace::Trace;
use crate::trace::Exchange;

/// Where a walk's own code writes a value: the script, and the place in it. Kept so a route can say what produces the
/// value, and so a stale producer is found again by re-walking the same page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Producer {
    /// The script the walk fetched.
    pub script: String,
    /// Where in that script the value's own key sits: the code around it writes the value.
    pub at: usize,
    /// The place is where the browser saw the call sent (a frame of its stack), not where the key is written: the
    /// key is spelled nowhere in the page's code. The code around it is the function that sent the call.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub frame: bool,
}

/// A script the page loaded, kept on the route so a signing bridge can run it: its address, and its source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Script {
    pub url: String,
    pub body: String,
}

/// An answer the walk's page got from a host of its own, kept on the route so the page's scripts can ask for it again
/// without a network at all: the data layer the page read, not the markup it painted. A bundle that boots from its
/// config (`getAppConfig.json`) finds the config the walk saw, and goes on to make the call it makes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    pub url: String,
    pub status: u16,
    pub mime: String,
    pub body: String,
}

/// How many of the page's own answers a route carries, and how much of them: the page's boot reads its config first,
/// and a route stays small enough to list and share.
const ANSWERS: usize = 40;
const ANSWERS_CAP: usize = 512 * 1024;
/// An answer a bundle boots from is a document of data, not a page: nothing above this is a config a script reads.
const ANSWER_MAX: usize = 256 * 1024;

/// How much of a page's scripts a route carries: its document's own scripts, in load order. A page's boot set is
/// everything its document names, not only the fragments that name a signature. Measured on Trip.com's results page:
/// 21 scripts, **7.8 MB** — `vendor`, `biz-common`, `list-ssr-gateway` and `list-main` are its entry bundles, and a
/// 4 MB cap cut exactly those, leaving the sandbox with three start-up calls and no flight list (0 errors, no call).
/// A route is bigger for it, and signs without a page.
const SCRIPTS_CAP: usize = 8_000_000;

/// Whether a probe's address is the step's call: a path alone (a page's own relative fetch) or a full address.
fn same_call(probe_url: &str, call: &url::Url) -> bool {
    let path = probe_url.split('?').next().unwrap_or_default();
    match url::Url::parse(probe_url) {
        Ok(u) => u.path() == call.path(),
        Err(_) => path == call.path(),
    }
}

/// The walk's exchange that carried a probe's value: the probe records a header and the value it wrote, so the call it
/// belongs to is found by that value, not by the path alone.
fn sighting<'a>(trace: &'a Trace, call: &Exchange, header: &str, probe: &Probe) -> Option<&'a Exchange> {
    trace.exchanges.iter().find(|e| {
        e.method.eq_ignore_ascii_case(&call.method)
            && e.url.path() == call.url.path()
            && e.request_headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(header) && v == &probe.value)
    })
}

/// The walk's sightings of one header on one call, as the contexts a generated program is fitted on and verified
/// against. Each probe's value names the exchange that carried it, so a sighting's cookies and body are its own —
/// not a neighbouring call's on the same path. Two sightings of the same context are kept only once.
fn samples_for(header: &str, call: &Exchange, trace: &Trace, probes: &[Probe], history: &[(Trace, Vec<Probe>)]) -> Vec<crate::generated::Sample> {
    let mut out: Vec<crate::generated::Sample> = Vec::new();
    let walks = std::iter::once((trace, probes)).chain(history.iter().map(|(t, p)| (t, p.as_slice())));
    for (t, ps) in walks {
    for probe in ps.iter().filter(|p| p.header.eq_ignore_ascii_case(header) && same_call(&p.url, &call.url)) {
        let Some(ex) = sighting(t, call, header, probe) else {
            continue;
        };
        let headers = ex
            .request_headers
            .iter()
            .filter(|(k, _)| !k.eq_ignore_ascii_case("cookie") && !k.eq_ignore_ascii_case(header))
            .cloned()
            .collect();
        let sample = crate::generated::Sample {
            method: ex.method.clone(),
            url: ex.url.to_string(),
            body: ex.request_body.clone(),
            cookies: ex.cookies(),
            headers,
            expected: probe.value.clone(),
            pre: (!probe.pre.is_empty()).then(|| probe.pre.clone()),
        };
        if !out.iter().any(|s| s.url == sample.url && s.body == sample.body && s.cookies == sample.cookies && s.expected == sample.expected) {
            out.push(sample);
        }
        // The evidence an agent reads has a size too; eight sightings of one call say what the shape is.
        if out.len() >= 8 {
            break;
        }
    }
    }
    out
}

/// The stack that sent `call`, from this walk or an earlier one of the page: the browser reports it with the request.
fn sent_from(call: &Exchange, probes: &[Probe], history: &[(Trace, Vec<Probe>)]) -> Vec<crate::trace::Frame> {
    std::iter::once(probes)
        .chain(history.iter().map(|(_, p)| p.as_slice()))
        .find_map(|ps| ps.iter().find(|p| !p.stack.is_empty() && same_call(&p.url, &call.url)))
        .map(|p| p.stack.clone())
        .unwrap_or_default()
}

/// Where the page's code writes `name`: the key as the site's code spells it, in quotes (`"x-traceid"` is not
/// `"x-trace-id"`). A page loads many scripts and more than one may spell a header's name: an allow-list, a logger,
/// another bundle's copy. With the stack that sent the call, the spelling in a script on that stack, nearest a frame
/// of it, is the one that wrote the value. Without a stack, the first spelling in the page's code, as before.
fn written_at(scripts: &[(&str, &str)], name: &str, stack: &[crate::trace::Frame]) -> Option<Producer> {
    let quote = |c: char| c == '"' || c == '\'' || c == '`';
    let spelled = |body: &str| -> Vec<usize> {
        body.match_indices(name).map(|(at, _)| at).filter(|&at| body[..at].chars().next_back().is_some_and(quote) && body[at + name.len()..].chars().next().is_some_and(quote)).collect()
    };
    let near = scripts
        .iter()
        .flat_map(|(url, body)| {
            let frames: Vec<usize> = stack.iter().filter(|f| f.script == *url).filter_map(|f| crate::slice::offset_at(body, f.line, f.column)).collect();
            let places = if frames.is_empty() { Vec::new() } else { spelled(body) };
            places.into_iter().filter_map(move |at| frames.iter().map(|f| f.abs_diff(at)).min().map(|far| (far, *url, at))).collect::<Vec<_>>()
        })
        .min_by_key(|(far, _, _)| *far);
    if let Some((_, url, at)) = near {
        return Some(Producer { script: url.to_string(), at, frame: false });
    }
    scripts.iter().find_map(|(url, body)| spelled(body).first().map(|&at| Producer { script: url.to_string(), at, frame: false }))
}

/// Where the call was sent from, when nothing in the page's code spells the value's key (a key built as the code runs,
/// or read from a table of strings): the innermost frame of the stack in a script the walk kept. The function around
/// it sent the call, and the code that made the value is what that function reaches.
fn sent_at(scripts: &[(&str, &str)], stack: &[crate::trace::Frame]) -> Option<Producer> {
    stack.iter().find_map(|f| {
        let (url, body) = scripts.iter().find(|(url, _)| *url == f.script)?;
        Some(Producer { script: url.to_string(), at: crate::slice::offset_at(body, f.line, f.column)?, frame: true })
    })
}

/// The code a generator reads: the write site and the definitions of the names it uses, picked out by `slice` — the
/// encoder a write site calls, the hash that encoder calls, wherever the walk fetched them. Nothing here names a site.
fn evidence_code(scripts: &[(&str, &str)], producer: &Producer) -> String {
    // The page's own module list first, then the slice: a generator sees which scripts the walk loaded as well as the
    // code the write site needs.
    let mut out = String::from("// the page's scripts:\n");
    for (url, _) in scripts {
        out.push_str(&format!("//   {url}\n"));
    }
    out.push_str(&crate::slice::of(scripts, producer).text());
    out
}

/// The scripts a walk fetched that could hold a producer: site code, not a stylesheet or an image.
fn scripts(trace: &Trace) -> impl Iterator<Item = (&str, &str)> {
    trace.exchanges.iter().filter_map(|e| {
        let body = e.response_body.as_deref().filter(|b| !b.is_empty())?;
        let script = e.resource_type.as_deref() == Some("Script") || e.response_mime.contains("javascript") || e.response_mime.contains("ecmascript");
        script.then(|| (e.url.as_str(), body))
    })
}

/// The name a computed field writes: a header's own name, or a query/body key. Only a header is a producer a script
/// names by itself (a site writes `headers["x-sig"]`); a body key is data the page shapes, not a signature.
fn named(loc: &crate::slots::Loc) -> Option<&str> {
    match loc {
        crate::slots::Loc::Header(name) => Some(name),
        _ => None,
    }
}

/// The page's document, as the walk saw it: the page's own account of which scripts it boots. The walk's last main
/// document on the page's origin is the page; a walk that met a wall first kept the page it was let through to.
fn page_document<'a>(trace: &'a Trace, origin: &str) -> Option<&'a str> {
    trace
        .exchanges
        .iter()
        .rev()
        .find(|e| e.is_main_document() && (origin.is_empty() || e.url.origin().ascii_serialization() == origin))
        .or_else(|| trace.exchanges.iter().rev().find(|e| e.is_main_document()))
        .and_then(|e| e.response_body.as_deref())
}

/// Whether the page's document names `url`: the script tag it wrote, or the path it wrote for its own bundle. A hash
/// in a bundle's name makes the path alone the page's own declaration, wherever a content host serves it from.
fn names(html: &str, url: &str) -> bool {
    if html.contains(url) {
        return true;
    }
    let path = url::Url::parse(url).ok().map(|u| u.path().to_string()).unwrap_or_default();
    path.len() > 8 && html.contains(path.as_str())
}

/// Every computed field the walk's scripts can produce, folded into the step's page producer. Returns how many were
/// found.
///
/// A value is made a page producer only when a script the page loaded names it: the producer is the code around that
/// name. The step becomes `page_signed` — the page's own request is its request — and the values the page writes are
/// evidence (`page_producers`), not fields the route sends.
pub fn discover(graph: &mut Graph, trace: &Trace, probes: &[Probe], env: &crate::generated::Environment, history: &[(Trace, Vec<Probe>)]) -> usize {
    let scripts: Vec<(&str, &str)> = scripts(trace).collect();
    if scripts.is_empty() {
        return 0;
    }
    // The page's own scripts are the runtime a generated program runs in: give the environment them, so a program can
    // call a global the page defines instead of reproducing it.
    let own;
    let env = if env.scripts.is_empty() {
        own = crate::generated::Environment { scripts: scripts.iter().map(|(u, b)| (u.to_string(), b.to_string())).collect(), ..env.clone() };
        &own
    } else {
        env
    };
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [sign] generative agent: {}", if crate::generated::enabled() { "configured" } else { "none" });
    }
    let mut found = 0;
    let mut kept: Vec<Script> = Vec::new();
    for step in &mut graph.steps {
        let mut page_producers: Vec<crate::graph::PageProducer> = Vec::new();
        let (step_method, step_url) = (step.method.clone(), step.url.clone());
        for field in &mut step.fields {
            // A value the page's code makes is either what the graph knows is computed, or one it saw once with no
            // source of its own (`Unconfirmed`): a signature is exactly that — a value that changed every walk.
            if !matches!(field.class, Class::Computed | Class::Unconfirmed { .. }) {
                continue;
            }
            // A header that says what the body is or what answer is wanted, written as a plain media type, coding or
            // language list, is the same on every call: the page's code writes it, but no code makes it up. It is no
            // reason to run the page, whatever script names it.
            if let (crate::slots::Loc::Header(name), Class::Unconfirmed { value }) = (&field.loc, &field.class) {
                if says_what_the_body_is(name, value) {
                    continue;
                }
            }
            // A value in the call's own address that reads as a hash: where the walks hold the call more than once,
            // its recipe is searched for among what the call itself carries, and kept when it rebuilds every sighting.
            if let crate::slots::Loc::Query(key) = &field.loc {
                if let Some(recipe) = searched(&step_method, &step_url, key, trace, history) {
                    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                        eprintln!("   [sign] recipe at query {key}, by search: {:?} over {} parts", recipe.algo, recipe.parts.len());
                    }
                    field.class = Class::Recipe { recipe };
                    found += 1;
                }
                continue;
            }
            let Some(name) = named(&field.loc) else { continue };
            // Before the page's code: the walk's own probe may have shown what its code computed. A recipe carries the
            // computation, not the code — no scripts, no bridge — and is kept only when the value checks out.
            // The step's call in the walk, by what it is: a step's index counts the graph's own trace, and the walk
            // may hold the same call among assets and pages (the scripts a route needs are assets).
            let path = url::Url::parse(&step.url).map(|u| u.path().to_string()).unwrap_or_else(|_| step.url.split('?').next().unwrap_or_default().to_string());
            let call = trace.exchanges.iter().find(|e| e.method == step.method && e.url.path() == path);
            let mut fitted = false;
            if let Some(ex) = call {
                // A probe may be from an earlier walk of the page: every walk's sighting is evidence, and the probe
                // names the call that carried its value, not just the path.
                let sighted = std::iter::once((trace, probes)).chain(history.iter().map(|(t, p)| (t, p.as_slice()))).find_map(|(t, ps)| {
                    ps.iter()
                        .find(|p| p.header.eq_ignore_ascii_case(name) && same_call(&p.url, &ex.url))
                        .and_then(|p| sighting(t, ex, name, p).map(|e| (e, p)))
                });
                if let Some((ex, probe)) = sighted {
                    let request = crate::replay::Request { method: ex.method.clone(), url: ex.url.clone(), exchange: step.exchange, headers: Vec::new(), body: None };
                    match fit(&probe.value, &probe.input, &request, ex.request_body.as_deref(), &ex.cookies(), crate::fresh::now_millis() as u64) {
                        Some(recipe) => {
                            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                eprintln!("   [sign] recipe at {name}: {:?} over {} parts", recipe.algo, recipe.parts.len());
                            }
                            field.class = Class::Recipe { recipe };
                            found += 1;
                            fitted = true;
                        }
                        None => {
                            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                eprintln!("   [sign] no recipe at {name}: input {} bytes, {} cookies ({}), body {}", probe.input.len(), ex.cookies().len(), ex.cookies().iter().take(4).map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(","), ex.request_body.as_deref().map(str::len).unwrap_or(0));
                            }
                        }
                    }
                }
            }
            if fitted {
                continue;
            }
            // Where the browser saw this call sent, when the walk recorded it: the search for what wrote the value
            // starts there, and falls back to the whole page's code.
            let stack = call.map(|ex| sent_from(ex, probes, history)).unwrap_or_default();
            let producer = written_at(&scripts, name, &stack).or_else(|| sent_at(&scripts, &stack));
            // A value no recipe fits: first the page's own code, lifted from the slice and run (no model), then — if
            // that doesn't run — an agent may write one from the walk's own sightings. The verifier decides what
            // ships; learn time only.
            if let Some(ex) = call {
                let samples = samples_for(name, ex, trace, probes, history);
                if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                    eprintln!("   [sign] {name}: {} sightings for a generated program", samples.len());
                }
                if !samples.is_empty() {
                    let mut shipped: Option<(String, bool, String)> = None;
                    // The slice is the page's own code; run it as it is. A program that reproduces ships; one that
                    // runs and differs is a candidate a call decides.
                    if let Some(p) = producer.as_ref() {
                        if let Some(program) = crate::slice::assemble(&scripts, p, name) {
                            match crate::generated::verify(&program, &samples, env) {
                                crate::generated::Verdict::Passed => shipped = Some((program, true, "the page's own code (slice)".into())),
                                crate::generated::Verdict::Differs => shipped = Some((program, false, "the page's own code (slice)".into())),
                                crate::generated::Verdict::Failed(why) => {
                                    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                        eprintln!("   [sign] the lifted code at {name} did not answer: {why}");
                                    }
                                }
                            }
                        }
                    }
                    if shipped.is_none() && crate::generated::enabled() {
                        let code = producer.as_ref().map(|p| evidence_code(&scripts, p)).filter(|c| !c.is_empty());
                        // A proposal the verifier rejects is repaired, not shipped: the agent is told what the
                        // verifier saw and asked again. A few tries, then the page's own code keeps the value.
                        let attempts: usize = std::env::var("UNBROWSE_GENERATE_ATTEMPTS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(3);
                        let who = crate::generated::who(&std::env::var("UNBROWSE_GENERATE_PROGRAM").unwrap_or_default());
                        let mut feedback: Option<String> = None;
                        // The agent is shown all but one sighting; the verifier still checks every one. A program that
                        // memorises what it was shown fails on the held-out sighting.
                        let shown = if samples.len() > 1 { &samples[..samples.len() - 1] } else { &samples[..] };
                        if samples.len() > 1 && std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                            eprintln!("   [sign] {name}: {} sighting(s) held out for the verifier", samples.len() - shown.len());
                        }
                        for _ in 0..attempts.max(1) {
                            let Some(program) = crate::generated::propose(name, shown, code.as_deref(), feedback.as_deref()) else { break };
                            match crate::generated::verify(&program, &samples, env) {
                                crate::generated::Verdict::Passed => {
                                    shipped = Some((program, true, who.clone()));
                                    break;
                                }
                                crate::generated::Verdict::Differs => {
                                    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                        eprintln!("   [sign] generated program at {name} runs but differs from the walk: a call decides");
                                    }
                                    shipped = Some((program, false, who.clone()));
                                    break;
                                }
                                crate::generated::Verdict::Failed(why) => {
                                    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                                        eprintln!("   [sign] no generated program at {name}: {why}");
                                        let shown: String = program.chars().take(2_000).collect();
                                        eprintln!("   [sign] it proposed: {shown}");
                                    }
                                    feedback = Some(why);
                                }
                            }
                        }
                    }
                    if let Some((program, exact, by)) = shipped {
                        // A program that still answers with no page scripts carries its producer's code itself, so the
                        // route needs none. One that names a global it did not inline keeps the script that defines it
                        // (the producer's script, for now) and the route runs that before the program.
                        let self_contained = !matches!(
                            crate::generated::verify(&program, &samples, &crate::generated::Environment { scripts: Vec::new(), ..env.clone() }),
                            crate::generated::Verdict::Failed(_)
                        );
                        let mut evidence_scripts: Vec<String> = Vec::new();
                        if !self_contained {
                            if let Some(p) = &producer {
                                evidence_scripts.push(p.script.clone());
                                if !kept.iter().any(|s| s.url == p.script) {
                                    if let Some((url, body)) = scripts.iter().find(|(u, _)| *u == p.script) {
                                        if kept.iter().map(|s| s.body.len()).sum::<usize>() + body.len() <= SCRIPTS_CAP {
                                            kept.push(Script { url: url.to_string(), body: body.to_string() });
                                        }
                                    }
                                }
                            }
                        }
                        let evidence = crate::generated::Evidence {
                            header: name.to_string(),
                            sightings: samples.len(),
                            producer: producer.clone(),
                            proposed_by: by,
                            evidence_hash: crate::generated::evidence_hash(name, &samples),
                            exact,
                            scripts: evidence_scripts,
                        };
                        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                            eprintln!("   [sign] generated program at {name}: {} sighting(s) {}", evidence.sightings, if exact { "reproduced" } else { "ran, values differ: a call decides" });
                        }
                        field.class = Class::Generated { program, evidence };
                        found += 1;
                        continue;
                    }
                }
            }
            let Some(producer) = producer else { continue };
            // The script that writes the value is what a signing bridge runs, so it rides on the route.
            if !kept.iter().any(|s| s.url == producer.script) {
                if let Some((url, body)) = scripts.iter().find(|(url, _)| *url == producer.script) {
                    if kept.iter().map(|s| s.body.len()).sum::<usize>() + body.len() <= SCRIPTS_CAP {
                        kept.push(Script { url: url.to_string(), body: body.to_string() });
                    }
                }
            }
            // The page's code writes this value into its own request. That is a producer for the **step**, not a
            // value the route sends: the page's request is the call, and a value it omits is simply not sent.
            page_producers.push(crate::graph::PageProducer { loc: field.loc.clone(), producer: producer.clone() });
            field.class = Class::Computed;
            found += 1;
        }
        // Routes learned before the step-level marker carry `Class::Script` fields; they are the same evidence.
        for f in step.fields.iter() {
            if let Class::Script { producer } = &f.class {
                if !page_producers.iter().any(|p| p.loc == f.loc) {
                    page_producers.push(crate::graph::PageProducer { loc: f.loc.clone(), producer: producer.clone() });
                }
            }
        }
        if !page_producers.is_empty() || step.fields.iter().any(|f| matches!(f.class, Class::Script { .. } | Class::Computed)) {
            // The page's code is needed only for a value it makes with no source the walk shows (a script or a computed
            // value). A producer whose header, body or query value is already a text/meta/JSON read from the page is
            // evidence, not a reason to boot the page: the carried page answers it, and the site's answer verifies it.
            // Only a field the route actually sends and cannot source needs the page. A producer whose loc has no field
            // (the walk's request did not carry that header) is evidence of the page's code, not a value to produce.
            let unsourced = step.fields.iter().any(|f| matches!(f.class, Class::Script { .. } | Class::Computed));
            if unsourced {
                step.page_signed = true;
                step.page_producers = page_producers;
            } else {
                step.page_signed = false;
                step.page_producers = Vec::new();
            }
            step.fields.retain(|f| !matches!(f.class, Class::Script { .. } | Class::Computed));
        }
        // A page-signed step is one no plain HTTP call can make; the page's producer is what makes it.
        step.needs_browser = step.is_page_signed();
    }
    // The page's own start-up: the scripts its document named, in the order the page loaded them, not only the
    // fragments that name a header. The app code that makes the call is what a producer lives in; a fragment alone
    // signs nothing. The document is the page's account of its own code, so this keeps a bundle a content host serves
    // (a CDN is where the site's own code lives) and drops a third party's. A chunk the entry loads later arrives
    // through the sandbox's own loader, over the runner line.
    let needs = graph.steps.iter().any(|s| s.is_page_signed())
        || graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(&f.class, Class::Generated { evidence, .. } if !evidence.scripts.is_empty()));
    if needs {
        let document = page_document(trace, graph.page_origin.as_deref().unwrap_or_default());
        // The page's code lives on the hosts its document names (its own, and the CDN its script tags point at). A
        // lazy chunk the document never names directly (`list-store.js`) is on one of those hosts; carry the walk's
        // scripts from there too, or the page's own loader cannot boot in the sandbox.
        let page_host = graph.page_origin.as_deref().and_then(|o| url::Url::parse(o).ok()).and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let code_hosts: std::collections::HashSet<String> = scripts
            .iter()
            .filter(|(u, _)| document.is_some_and(|html| names(html, u)))
            .filter_map(|(u, _)| url::Url::parse(u).ok().and_then(|x| x.host_str().map(String::from)))
            .collect();
        let mut bytes: usize = kept.iter().map(|s| s.body.len()).sum();
        let mut boot: Vec<Script> = Vec::new();
        for (url, body) in &scripts {
            if kept.iter().any(|s| s.url == *url) || boot.iter().any(|s| s.url == *url) {
                continue;
            }
            let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
            let page_code = !page_host.is_empty() && crate::identity::same_site(&host, &page_host);
            if !(page_code || code_hosts.contains(&host)) || bytes + body.len() > SCRIPTS_CAP {
                continue;
            }
            bytes += body.len();
            boot.push(Script { url: url.to_string(), body: body.to_string() });
        }
        let order = |u: &str| scripts.iter().position(|(x, _)| *x == u).unwrap_or(usize::MAX);
        kept.extend(boot);
        kept.sort_by_key(|s| order(&s.url));
    }
    graph.scripts.extend(kept);
    found
}

/// The hash a producer computes over the string its own code builds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Algo {
    Md5,
    Sha1,
    Sha256,
}

impl Algo {
    fn hash(self, text: &str) -> String {
        fn hex(bytes: impl AsRef<[u8]>) -> String {
            bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
        }
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
}

/// One piece of the string a producer hashes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "part", rename_all = "snake_case")]
pub enum Part {
    /// The call's own address, path and query, as the page read it.
    Path,
    /// The call's method, as the page read it.
    Method,
    /// The body the call sends, as text.
    Body,
    /// A session value, by cookie name: the jar's at call time.
    Cookie { name: String },
    /// A value the page read off the clock (a request id): `template` holds `{ms}`, `{s}` and `{dN}` (N random
    /// digits), and is rendered anew on every call.
    Fresh { template: String },
    /// A literal, kept as it was: an empty string (a page joins a present part with an absent one), or a constant the
    /// sending script holds (`fit_by_search_with`'s `constants`) — a value the site ships to everyone, verified like
    /// any part by rebuilding every other sighting, so a per-call value frozen into one sighting is never kept.
    Constant { value: String },
    /// A value the call's own address sends, by its key: the request's as it stands when the value is made, so a
    /// caller's word and the call's own time are hashed as they are sent.
    Query { key: String },
    /// One piece of a session value, by cookie name: the cookie split at `separator`, counted from zero. A site
    /// hands a token and its expiry over in one cookie and signs with the token alone.
    CookiePiece { name: String, separator: String, index: usize },
    /// A header the same call carries, by name: a page that signs over a clock reading it also sends in a sibling
    /// header (`x-ts`) hashes what that header carries, as the request stands when the signature is made.
    Header { name: String },
}

/// A producer expressed as what it is: a hash over a joined tuple of the call and the session, fitted from what the
/// page's own code built at the walk and verified against the value it wrote. It carries no page code: a few dozen
/// bytes, and the same recipe answers every call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recipe {
    pub algo: Algo,
    pub separator: String,
    pub parts: Vec<Part>,
}

/// What a part is worth on a call, or why it can't be.
fn part_value(part: &Part, request: &crate::replay::Request, body: Option<&str>, cookies: &[(String, String)], now_ms: u64, digits: &mut impl FnMut(usize) -> String) -> Option<String> {
    Some(match part {
        Part::Path => match request.url.query() {
            Some(q) => format!("{}?{q}", request.url.path()),
            None => request.url.path().to_string(),
        },
        Part::Method => request.method.to_uppercase(),
        Part::Body => body.unwrap_or_default().to_string(),
        // A cookie the session doesn't hold yet is signed over as nothing, as the page's own code signs before its
        // gateway has handed it the token (`replay::resigned` sends the call again once it has). The expression a body
        // carries reads it the same way (`Expr::Hash`).
        Part::Cookie { name } => cookies.iter().find(|(k, _)| k == name).or_else(|| cookies.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)))?.1.clone(),
        Part::Constant { value } => value.clone(),
        Part::Fresh { template } => render(template, now_ms, digits),
        Part::Query { key } => request.url.query_pairs().find(|(k, _)| k == key)?.1.into_owned(),
        Part::Header { name } => request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name) && !k.eq_ignore_ascii_case("cookie"))?.1.clone(),
        Part::CookiePiece { name, separator, index } => cookies.iter().find(|(k, _)| k == name)?.1.split(separator.as_str()).nth(*index)?.to_string(),
    })
}

/// A fresh template rendered for this call: the clock reading it held, and random digits where the page's own were.
fn render(template: &str, now_ms: u64, digits: &mut impl FnMut(usize) -> String) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        let Some(end) = rest[at..].find('}') else { break };
        let token = &rest[at + 1..at + end];
        match token {
            "ms" => out.push_str(&now_ms.to_string()),
            "s" => out.push_str(&(now_ms / 1000).to_string()),
            _ if token.starts_with('d') && token[1..].parse::<usize>().is_ok() => out.push_str(&digits(token[1..].parse().unwrap())),
            _ => out.push_str(&rest[at..at + end + 1]),
        }
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out
}

/// The recipe's value for a call: the parts joined and hashed.
/// The recipe for the value a step's call sends under `key` in its address, searched for over every sighting of
/// that call (and of its siblings at the same gateway) in this walk and the page's earlier ones (`fit_by_search`),
/// else beside its kin elsewhere on the site. None when nothing sighted a second value under `key`, or nothing the
/// calls carry makes them.
fn searched(method: &str, address: &str, key: &str, trace: &Trace, history: &[(Trace, Vec<Probe>)]) -> Option<Recipe> {
    type Seen = (String, crate::replay::Request, Option<String>, Vec<(String, String)>);
    let parsed = url::Url::parse(address).ok();
    let path = parsed.as_ref().map(|u| u.path().to_string()).unwrap_or_else(|| address.split('?').next().unwrap_or_default().to_string());
    let host = parsed.as_ref().and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    let keys_of = |u: &url::Url| u.query_pairs().map(|(k, _)| k.into_owned()).collect::<std::collections::BTreeSet<String>>();
    let keys = parsed.as_ref().map(keys_of).unwrap_or_default();
    // The same call, or a sibling of it the same code signed: a gateway that serves many operations at addresses of
    // their own (one path an operation) signs every one of them the same way, and its calls say so by their shape —
    // the same host, the same names in their address, the signed one among them. Each is a sighting of the one
    // producer; a recipe is kept only if it rebuilds every one of them, so a sibling that signs otherwise refutes it.
    let on_host = |e: &Exchange| host.as_deref().is_some_and(|h| e.url.host_str().is_some_and(|x| x.eq_ignore_ascii_case(h)));
    let sibling = |e: &Exchange| on_host(e) && keys.contains(key) && keys.len() >= 3 && keys_of(&e.url) == keys;
    // Each sighting: the value, the request as sent, its body and its cookies.
    let sighting_of = |e: &Exchange| -> Option<Seen> {
        let value = e.url.query_pairs().find(|(k, _)| k == key)?.1.into_owned();
        let request = crate::replay::Request { method: e.method.clone(), url: e.url.clone(), exchange: 0, headers: Vec::new(), body: None };
        Some((value, request, e.request_body.clone(), e.cookies()))
    };
    let calls: Vec<&Exchange> = std::iter::once(trace).chain(history.iter().map(|(t, _)| t)).flat_map(|t| t.exchanges.iter()).filter(|e| e.method == method).collect();
    let alike = |e: &Exchange| e.url.path() == path || sibling(e);
    let mut seen: Vec<Seen> = calls.iter().filter(|e| alike(e)).filter_map(|e| sighting_of(e)).collect();
    fn as_sightings<'a>(seen: &[&'a Seen]) -> Vec<Sighting<'a>> {
        seen.iter().map(|(value, request, body, cookies)| Sighting { value, request, body: body.as_deref(), cookies }).collect()
    }
    let distinct: std::collections::BTreeSet<&str> = seen.iter().map(|(v, ..)| v.as_str()).collect();
    if distinct.len() >= 2 {
        if let Some(recipe) = fit_by_search(&as_sightings(&seen.iter().collect::<Vec<_>>()), key) {
            return Some(recipe);
        }
        // A gateway's first calls go out before the session holds its token, signed over whatever the page's code had
        // in its place: they say nothing of a recipe over the token. The calls made once the session held every cookie
        // the fullest of them carries are sightings again; one alone is tried beside its kin, below.
        let names = |s: &Seen| s.3.iter().filter(|(_, v)| !v.is_empty()).map(|(k, _)| k.clone()).collect::<std::collections::BTreeSet<String>>();
        let fullest = seen.iter().map(names).max_by_key(|n| n.len()).unwrap_or_default();
        let lacking = |s: &Seen| !fullest.is_subset(&names(s));
        if !seen.iter().any(lacking) {
            return None;
        }
        seen.retain(|s| !lacking(s));
        let distinct: std::collections::BTreeSet<&str> = seen.iter().map(|(v, ..)| v.as_str()).collect();
        if distinct.len() >= 2 {
            return fit_by_search(&as_sightings(&seen.iter().collect::<Vec<_>>()), key);
        }
    }
    // The call alone, or always with the same value: its kin elsewhere on the site may be sightings of the same signer.
    // A gateway's operations differ in a name or two of their address, or sit on another of the site's hosts; what
    // they share is the signed value's place and shape. Each is tried beside the call, the likeliest first (the most
    // names in common), and a recipe is kept only if it rebuilds the call and that one, and every other kin it can be
    // computed for: kin that sign otherwise refute it, kin that carry none of its parts say nothing.
    let (target, value) = seen.first().map(|s| (s, s.0.as_str()))?;
    let shape = |v: &str| (v.len(), v.chars().all(|c| c.is_ascii_hexdigit()));
    let site = host.as_deref().map(crate::identity::site_of).filter(|s| !s.is_empty())?;
    let mut kin: Vec<(usize, Seen)> = calls
        .iter()
        .filter(|e| !alike(e) && e.url.host_str().is_some_and(|h| crate::identity::site_of(h) == site))
        .filter_map(|e| sighting_of(e).map(|s| (keys_of(&e.url).intersection(&keys).count(), s)))
        .filter(|(_, s)| s.0 != value && shape(&s.0) == shape(value))
        .collect();
    kin.sort_by_key(|k| std::cmp::Reverse(k.0));

    let rebuilds = |recipe: &Recipe, s: &Seen| match compute_with(recipe, &s.1, s.2.as_deref(), &s.3, 0, |_| String::new()) {
        Some(made) => made == s.0,
        None => true,
    };
    for (_, one) in kin.iter().take(MOST_KIN) {
        let Some(recipe) = fit_by_search(&as_sightings(&[target, one]), key) else { continue };
        if kin.iter().all(|(_, s)| rebuilds(&recipe, s)) {
            return Some(recipe);
        }
    }
    None
}

/// Whether a header is one that describes the body or the answer wanted (`content-type`, `accept`, their encodings and
/// languages) and its value reads as such a description: media types, codings or language tags, each with short
/// parameters, and no run of letters or digits long enough to be a token.
pub(crate) fn says_what_the_body_is(name: &str, value: &str) -> bool {
    const DESCRIBES: [&str; 6] = ["content-type", "content-encoding", "content-language", "accept", "accept-encoding", "accept-language"];
    if !DESCRIBES.iter().any(|h| name.eq_ignore_ascii_case(h)) || value.trim().is_empty() || value.len() > 256 {
        return false;
    }
    let token = |t: &str| !t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || "-+._*!#$&^`|~".contains(c));
    let longest_run = value.split(|c: char| !c.is_ascii_alphanumeric()).map(str::len).max().unwrap_or(0);
    longest_run <= 24
        && value.split(',').all(|item| {
            let mut pieces = item.split(';').map(str::trim);
            let head = pieces.next().unwrap_or_default();
            let described = match head.split_once('/') {
                Some((kind, sub)) => token(kind) && token(sub),
                None => token(head),
            };
            described && pieces.all(|p| p.split_once('=').is_some_and(|(k, v)| token(k.trim()) && token(v.trim().trim_matches('"'))))
        })
}

/// The most of a call's kin elsewhere on its site a signature's search is tried beside, one at a time.
const MOST_KIN: usize = 3;

/// One sighting of a value the page's code made: the value, and the request that carried it.
pub struct Sighting<'a> {
    pub value: &'a str,
    pub request: &'a crate::replay::Request,
    pub body: Option<&'a str>,
    pub cookies: &'a [(String, String)],
}

/// The most candidates a search hashes: enough for four parts of a busy call, and over in a moment.
const MOST_TRIED: usize = 6_000_000;
/// The most constants a sending script offers the search, and the longest each: a salt is short, and a script's own
/// literals are few that matter; the bound keeps the search over in a moment whatever the bundle's size.
const MOST_CONSTANTS: usize = 64;
const MOST_PART: usize = 64;

/// [`fit_by_search_with`] with no constants of the page's code: the search over what the call itself carries alone.
pub fn fit_by_search(sightings: &[Sighting<'_>], own: &str) -> Option<Recipe> {
    fit_by_search_with(sightings, own, &[])
}

/// A recipe for a value the page's code made, found by search where no probe saw what was hashed: the value is a
/// hash by its length, and what a page hashes into a signature is what the call itself carries (its query values,
/// its headers, its body, the pieces of its session's cookies) and the constants the page's own code holds
/// (`constants`: the string literals of the script that sent the call, a salt a site ships to everyone), joined by a
/// separator. Every ordered choice of two to four of those is hashed and held against the first sighting; one that
/// matches is kept only if it rebuilds every other sighting too, and there must be another: one sighting could be a
/// coincidence of parts. `own` is the key the value itself sits under, which a page cannot have hashed. Search
/// proposes; the walk's own values verify.
pub fn fit_by_search_with(sightings: &[Sighting<'_>], own: &str, constants: &[String]) -> Option<Recipe> {
    fit_by_search_by(sightings, own, constants, &|name, _| crate::slots::is_browser_header(name))
}

/// [`fit_by_search_with`], told which of the call's headers the browser wrote by itself (`browsers`, by name and
/// value; a walk's own reading of it is `slots::BrowsersOwn::wrote`): those are never a part a signature is over.
pub fn fit_by_search_by(sightings: &[Sighting<'_>], own: &str, constants: &[String], browsers: &dyn Fn(&str, &str) -> bool) -> Option<Recipe> {
    let (first, rest) = sightings.split_first()?;
    if rest.is_empty() || !first.value.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let algo = match first.value.len() {
        32 => Algo::Md5,
        40 => Algo::Sha1,
        64 => Algo::Sha256,
        _ => return None,
    };
    let upper = first.value.chars().any(|c| c.is_ascii_uppercase());
    if upper {
        return None;
    }
    // What the call carries, each with how a recipe names it.
    let mut held: Vec<(Part, String)> = first.request.url.query_pairs().filter(|(k, v)| k != own && !v.is_empty()).map(|(k, v)| (Part::Query { key: k.into_owned() }, v.into_owned())).collect();
    held.truncate(16);
    if let Some(body) = first.body.filter(|b| !b.is_empty()) {
        held.push((Part::Body, body.to_string()));
    }
    // A session's token as a page signs with it is the head of a cookie that carries its expiry after a separator, more
    // often than a whole cookie: the pieces go first, the whole cookies after, so a recipe over a few of the call's
    // values and one piece is reached long before the search's bound.
    let cookies: Vec<&(String, String)> = first.cookies.iter().filter(|(_, v)| v.len() >= 8).take(24).collect();
    for (name, value) in &cookies {
        for separator in ["_", ".", "|"] {
            if value.contains(separator) {
                held.push((Part::CookiePiece { name: name.clone(), separator: separator.into(), index: 0 }, value.split(separator).next().unwrap_or_default().to_string()));
            }
        }
    }
    for (name, value) in &cookies {
        held.push((Part::Cookie { name: name.clone() }, value.clone()));
    }
    // A sibling header the same call carries: a page that signs over a clock reading (`x-ts`) sends that reading in a
    // header of its own and hashes it from there. Not a header the browser writes by itself (its shape is the
    // browser's, the same for every call and never what a signature is over), and not the joined cookie header.
    for (name, value) in first.request.headers.iter().filter(|(k, v)| !k.eq_ignore_ascii_case("cookie") && !browsers(k, v) && (1..=256).contains(&v.len())).take(24) {
        held.push((Part::Header { name: name.clone() }, value.clone()));
    }
    // The constants the sending script holds, each as it is and split on the separators the search joins by: a page
    // writes a salt bundled with its delimiter (`":key"`, `"&sign="`), and the uniform-join search needs the piece
    // without the delimiter. A page ships the same constant to everyone, so it is kept as fixed text in the body.
    let mut consts: Vec<String> = Vec::new();
    for literal in constants {
        for piece in std::iter::once(literal.as_str()).chain(["&", "|", ":", "=", ","].iter().flat_map(|sep| literal.split(sep))) {
            if (1..=MOST_PART).contains(&piece.len()) && !consts.iter().any(|c| c == piece) {
                consts.push(piece.to_string());
            }
        }
    }
    consts.truncate(MOST_CONSTANTS);
    held.extend(consts.into_iter().map(|value| (Part::Constant { value: value.clone() }, value)));
    held.retain(|(_, v)| !v.is_empty());
    let mut tried = 0usize;
    let holds = |recipe: &Recipe| rest.iter().all(|s| compute_with(recipe, s.request, s.body, s.cookies, 0, |_| String::new()).as_deref() == Some(s.value));
    // Each count of parts, and within it every ordered choice by the furthest part it reaches: all the choices among
    // the first parts before any that reaches further, so the search's bound is spent on the likeliest first.
    for count in 2..=4usize.min(held.len()) {
        for top in count - 1..held.len() {
            let mut at = vec![0usize; count];
            loop {
                // No part twice: a page hashes each thing it carries once. And this round's choices reach `top`, and no further.
                if at.contains(&top) && (0..count).all(|i| (0..i).all(|j| at[i] != at[j])) {
                    for separator in ["&", "", "|", ":"] {
                        tried += 1;
                        let text = at.iter().map(|&i| held[i].1.as_str()).collect::<Vec<_>>().join(separator);
                        if algo.hash(&text) == first.value {
                            let recipe = Recipe { algo, separator: separator.to_string(), parts: at.iter().map(|&i| held[i].0.clone()).collect() };
                            if holds(&recipe) {
                                return Some(recipe);
                            }
                        }
                    }
                    if tried > MOST_TRIED {
                        return None;
                    }
                }
                // The next choice, as a number counted in base `top + 1`.
                let mut place = count;
                loop {
                    if place == 0 {
                        break;
                    }
                    place -= 1;
                    at[place] += 1;
                    if at[place] <= top {
                        break;
                    }
                    at[place] = 0;
                    if place == 0 {
                        place = usize::MAX;
                        break;
                    }
                }
                if place == usize::MAX {
                    break;
                }
            }
        }
    }
    None
}

pub fn compute_with(recipe: &Recipe, request: &crate::replay::Request, body: Option<&str>, cookies: &[(String, String)], now_ms: u64, mut digits: impl FnMut(usize) -> String) -> Option<String> {
    let parts: Option<Vec<String>> = recipe.parts.iter().map(|p| part_value(p, request, body, cookies, now_ms, &mut digits)).collect();
    Some(recipe.algo.hash(&parts?.join(&recipe.separator)))
}

/// The value a gateway's first call carries before the session holds the token it signs over: `compute_with` with each
/// cookie the recipe reads and the call lacks taken as nothing in its place, as a page's own code signs before it has
/// one. Only for that first call: a gateway that issues its own token answers it with the token, and the call is made
/// again over what it handed over (`replay::resigned`). Every other part the call lacks still makes no value.
pub fn compute_before_token(recipe: &Recipe, request: &crate::replay::Request, body: Option<&str>, cookies: &[(String, String)], now_ms: u64, digits: impl FnMut(usize) -> String) -> Option<String> {
    let mut held = cookies.to_vec();
    for part in &recipe.parts {
        // Found as `part_value` finds it: a whole cookie by name ignoring case as a second chance, a piece by name.
        let lacked = match part {
            Part::Cookie { name } => !held.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)),
            Part::CookiePiece { name, .. } => !held.iter().any(|(k, _)| k == name),
            _ => continue,
        };
        let (Part::Cookie { name } | Part::CookiePiece { name, .. }) = part else { continue };
        if lacked {
            held.push((name.clone(), String::new()));
        }
    }
    compute_with(recipe, request, body, &held, now_ms, digits)
}

/// The same, on the clock and a page's own random: what a call sends.
pub fn compute(recipe: &Recipe, request: &crate::replay::Request, body: Option<&str>, cookies: &[(String, String)]) -> Option<String> {
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
        ^ (std::process::id() as u64) << 32
        ^ COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut state = seed | 1;
    let mut digits = |n: usize| {
        (0..n)
            .map(|_| {
                state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
                char::from(b'0' + ((state >> 33) % 10) as u8)
            })
            .collect::<String>()
    };
    compute_with(recipe, request, body, cookies, crate::fresh::now_millis() as u64, &mut digits)
}

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A template for a value the page read off the clock: 13 digits near `now_ms` are the milliseconds, 10 near its
/// seconds are the seconds, and any other run is that many random digits. None when the value holds no such run.
fn fresh_template(piece: &str, now_ms: u64) -> Option<String> {
    let chars: Vec<char> = piece.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    let mut replaced = false;
    while at < chars.len() {
        if !chars[at].is_ascii_digit() {
            out.push(chars[at]);
            at += 1;
            continue;
        }
        let start = at;
        while at < chars.len() && chars[at].is_ascii_digit() {
            at += 1;
        }
        let run: String = chars[start..at].iter().collect();
        let near = |v: u64, now: u64| v.abs_diff(now) <= 120_000;
        if run.len() == 13 && run.parse::<u64>().is_ok_and(|v| near(v, now_ms)) {
            out.push_str("{ms}");
            replaced = true;
        } else if run.len() == 10 && run.parse::<u64>().is_ok_and(|v| near(v * 1000, now_ms)) {
            out.push_str("{s}");
            replaced = true;
        } else if run.len() >= 4 {
            out.push_str(&format!("{{d{}}}", run.len()));
            replaced = true;
        } else {
            out.push_str(&run);
        }
    }
    replaced.then_some(out)
}

/// Fit a value a page's code wrote to a recipe, from the string its own code built (`input`) and the call it signed.
/// The fit is exact: a part that is not the call's path, method or body, a cookie the call carried, an empty literal,
/// or a clock reading is not fitted at all — an unaccounted piece could be a per-call value that would freeze.
pub fn fit(value: &str, input: &str, request: &crate::replay::Request, body: Option<&str>, cookies: &[(String, String)], now_ms: u64) -> Option<Recipe> {
    let algo = [Algo::Md5, Algo::Sha1, Algo::Sha256].into_iter().find(|a| a.hash(input).eq_ignore_ascii_case(value))?;
    let path = match request.url.query() {
        Some(q) => format!("{}?{q}", request.url.path()),
        None => request.url.path().to_string(),
    };
    for separator in [";", "&", "|", ","] {
        let pieces: Vec<&str> = input.split(separator).collect();
        if pieces.len() < 2 {
            continue;
        }
        let mut parts = Vec::with_capacity(pieces.len());
        let mut fitted = true;
        for piece in pieces {
            let part = if piece == path {
                Part::Path
            } else if piece.eq_ignore_ascii_case(&request.method) {
                Part::Method
            } else if body.is_some_and(|b| b == piece) {
                Part::Body
            } else if let Some((name, _)) = cookies.iter().find(|(_, v)| v == piece) {
                Part::Cookie { name: name.clone() }
            } else if piece.is_empty() {
                Part::Constant { value: String::new() }
            } else if let Some(template) = fresh_template(piece, now_ms) {
                Part::Fresh { template }
            } else {
                fitted = false;
                break;
            };
            parts.push(part);
        }
        if fitted {
            return Some(Recipe { algo, separator: separator.to_string(), parts });
        }
    }
    None
}

/// What a compaction changed, for the owner's log: the scripts before and after, and whether the page still made the
/// call with the reduced set (it is only reduced when it did).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Compaction {
    pub before: usize,
    pub after: usize,
    pub before_bytes: usize,
    pub after_bytes: usize,
}

/// The scripts a route needs, measured rather than inferred: boot the page's own code with the full set, then drop
/// one script at a time and keep the drop only while the page still makes the call the route asks for. A script the
/// page's document names but its call does not need (`a locale table`, `a tracker`) goes; the ones `run` says the call
/// needs stay. `None` when the full set does not make the call in the sandbox at all (the route keeps it, and the
/// bridge runs the page as before).
///
/// The order is load order, reduced from the end: the last scripts a page loads are the ones it can most often do
/// without, and each drop is verified, so the set that remains is one the page's own code runs.
fn reduce_with(scripts: &[Script], run: &mut impl FnMut(&[Script]) -> bool) -> Option<Vec<Script>> {
    if scripts.len() < 2 || !run(scripts) {
        return None;
    }
    let mut kept: Vec<Script> = scripts.to_vec();
    // Drop whole groups first: a page carries its bundles and third-party tags together, and one boot proves a
    // group unnecessary. Halve the group until single scripts are tested, so the final proof is still one boot per
    // script that remains — but a page with many redundant tags does not pay one boot per tag to find that out.
    let mut batch = (kept.len() / 2).max(1);
    loop {
        let mut start = 0;
        while start < kept.len() && kept.len() > 1 {
            let end = (start + batch).min(kept.len());
            let candidate: Vec<Script> = kept.iter().enumerate().filter(|(n, _)| *n < start || *n >= end).map(|(_, s)| s.clone()).collect();
            if !candidate.is_empty() && run(&candidate) {
                if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                    for s in &kept[start..end] {
                        eprintln!("   [sign] dropped {} ({:.0} KB)", s.url, s.body.len() as f64 / 1024.0);
                    }
                }
                kept = candidate;
            } else {
                start = end;
            }
        }
        if batch == 1 {
            break;
        }
        batch = (batch / 2).max(1);
    }
    Some(kept)
}

/// Compact a route's scripts with the sandbox as the oracle (`reduce_with`): the page's own code is booted on the
/// route's page, its answers and the target step's address, and a script is dropped only while the page still makes
/// that call. Returns what changed, or None when nothing could be verified (no runtime, one script, or a page that
/// makes no such call without a browser).
pub fn compact(graph: &mut Graph, target: &crate::graph::Step) -> Option<Compaction> {
    let program = crate::sandbox::runtime()?;
    if graph.scripts.len() < 2 {
        return None;
    }
    let page = graph.steps.first().map(|s| s.url.split('?').next().unwrap_or(s.url.as_str()).to_string()).unwrap_or_default();
    let asked_url: url::Url = url::Url::parse(&target.url).or_else(|_| {
        // A template's hole (`{q}`) is not an address: the call's path is what the sandbox matches, so a path with a
        // hole is only asked for as the walk saw it. A path holding one keeps the full set (the oracle can't tell).
        let mut out = String::new();
        let mut in_hole = false;
        for c in target.url.chars() {
            match c {
                '{' => in_hole = true,
                '}' => in_hole = false,
                _ if !in_hole => out.push(c),
                _ => {}
            }
        }
        url::Url::parse(&out)
    }).ok()?;
    let asked = crate::replay::Request { method: target.method.clone(), url: asked_url, exchange: 0, headers: Vec::new(), body: None };
    let html = graph.page_html.clone().unwrap_or_default();
    let answers = graph.api.clone();
    let settle = crate::sandbox::settle_ms();
    let mut run = |set: &[Script]| {
        let bundle: crate::sandbox::Bundle = set.iter().map(|s| (s.url.clone(), s.body.clone())).collect();
        crate::sandbox::sign_in(Some(&program), settle, &bundle, &page, &asked, "", &crate::sandbox::Storage::default(), &html, &serde_json::Value::Null, &answers, None, false).is_some()
    };
    let before = graph.scripts.len();
    let before_bytes: usize = graph.scripts.iter().map(|s| s.body.len()).sum();
    let kept = reduce_with(&graph.scripts, &mut run)?;
    let after = kept.len();
    let after_bytes: usize = kept.iter().map(|s| s.body.len()).sum();
    if after < before {
        graph.scripts = kept;
    }
    Some(Compaction { before, after, before_bytes, after_bytes })
}

/// The data the page read while the walk ran it: the answers to its own calls, from hosts of its own site, that are
/// data rather than markup. A signing bridge answers these from the route — no network, no page to paint — so the
/// bundle's own start-up (`getAppConfig`, a locale table, a session's bootstrap) runs on what it read, and goes on to
/// make the call the route asks for. HTML is the fallback; this is the layer the call lives in.
///
/// Only a route that carries scripts keeps them: a route with no producer signs nothing, and needs no answers.
pub fn record(graph: &mut Graph, trace: &Trace, site: &str) -> usize {
    if graph.scripts.is_empty() || !graph.api.is_empty() {
        return 0;
    }
    graph.api = answers(trace, site);
    graph.api.len()
}

/// The data layer a page's code reads: its own calls' answers, in the walk's order, bounded. The same answers a
/// signing bridge boots a page on, and the same a generated program reads when it copies the page's code — the route
/// carries them either way.
pub fn answers(trace: &Trace, site: &str) -> Vec<Answer> {
    let mut found: Vec<Answer> = Vec::new();
    let mut total = 0;
    for e in &trace.exchanges {
        if found.len() >= ANSWERS || total >= ANSWERS_CAP {
            break;
        }
        let Some(body) = e.response_body.as_deref().filter(|b| !b.is_empty()) else { continue };
        if body.len() > ANSWER_MAX || !(200..300).contains(&e.status) {
            continue;
        }
        // Data a page's code reads: a call it made, answered with JSON. A document, an image or a stylesheet is not
        // what a bundle boots from, and the page's markup is carried separately (`page_html`), as the fallback.
        let asked_by_code = matches!(e.resource_type.as_deref(), Some("XHR") | Some("Fetch"));
        let data = e.response_mime.contains("json") || body.trim_start().starts_with('{') || body.trim_start().starts_with('[');
        if !(asked_by_code || e.response_mime.contains("json")) || !data {
            continue;
        }
        if let Some(host) = e.url.host_str() {
            if !site.is_empty() && !crate::identity::same_site(host, site) {
                continue;
            }
        }
        let url = e.url.as_str().to_string();
        if found.iter().any(|a| a.url == url) {
            continue;
        }
        if total + body.len() > ANSWERS_CAP {
            break;
        }
        total += body.len();
        found.push(Answer { url, status: e.status, mime: e.response_mime.clone(), body: body.to_string() });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A signature no probe saw the making of is found from the call's own parts: a hash over a piece of a session
    /// cookie, the call's time, its key and its data, proven on a second sighting with another time and other data.
    /// One sighting proves nothing, and a value that is no hash is not searched for.
    #[test]
    fn a_signature_is_fitted_from_what_the_call_itself_carries() {
        let made = |token: &str, t: &str, data: &str| Algo::Md5.hash(&format!("{token}&{t}&24677475&{data}"));
        let call = |t: &str, data: &str, sign: &str| crate::replay::Request {
            method: "GET".into(),
            url: url::Url::parse_with_params("https://api.shop.example/h5/find/1.0/", &[("jsv", "2.7.2"), ("appKey", "24677475"), ("t", t), ("sign", sign), ("api", "find"), ("data", data)]).unwrap(),
            exchange: 0,
            headers: Vec::new(),
            body: None,
        };
        let cookies = vec![("_tk".to_string(), "5f3a9c21e4d7b8a6_1794402700000".to_string()), ("lang".to_string(), "en-SG-long".to_string())];
        let (one, two) = (made("5f3a9c21e4d7b8a6", "1794402610160", r#"{"q":"lamps"}"#), made("5f3a9c21e4d7b8a6", "1794402629232", r#"{"q":"kettles"}"#));
        let (first, second) = (call("1794402610160", r#"{"q":"lamps"}"#, &one), call("1794402629232", r#"{"q":"kettles"}"#, &two));
        let sightings = [Sighting { value: &one, request: &first, body: None, cookies: &cookies }, Sighting { value: &two, request: &second, body: None, cookies: &cookies }];
        let recipe = fit_by_search(&sightings, "sign").expect("a recipe");
        assert_eq!(recipe.algo, Algo::Md5);
        assert_eq!(recipe.separator, "&");
        assert_eq!(recipe.parts, vec![Part::CookiePiece { name: "_tk".into(), separator: "_".into(), index: 0 }, Part::Query { key: "t".into() }, Part::Query { key: "appKey".into() }, Part::Query { key: "data".into() }]);
        // A third call, never seen: the recipe makes what the page would have.
        let third = call("1794402699999", r#"{"q":"sofas"}"#, "");
        assert_eq!(compute_with(&recipe, &third, None, &cookies, 0, |_| String::new()), Some(made("5f3a9c21e4d7b8a6", "1794402699999", r#"{"q":"sofas"}"#)));
        assert!(fit_by_search(&sightings[..1], "sign").is_none(), "one sighting proves nothing");
        let plain = [Sighting { value: "not-a-hash", request: &first, body: None, cookies: &cookies }, Sighting { value: "not-a-hash", request: &second, body: None, cookies: &cookies }];
        assert!(fit_by_search(&plain, "sign").is_none());
    }

    /// A call as busy as a real gateway's (fifteen values in its address, twenty cookies of a session) whose signature is
    /// over a piece of a cookie late in its session and three of its values: the search reaches it within its bound,
    /// because the few parts are tried together before any choice reaching further.
    #[test]
    fn a_signature_over_a_cookie_piece_is_found_on_a_busy_call() {
        let made = |token: &str, t: &str, data: &str| Algo::Md5.hash(&format!("{token}&{t}&24677475&{data}"));
        let call = |t: &str, data: &str, sign: &str| {
            let mut pairs: Vec<(String, String)> = vec![("jsv".into(), "2.7.5".into()), ("appKey".into(), "24677475".into()), ("t".into(), t.into()), ("sign".into(), sign.into()), ("api".into(), "shop.recommend".into()), ("v".into(), "1.0".into())];
            pairs.extend((0..9).map(|n| (format!("opt{n}"), format!("value-{n}"))));
            pairs.push(("data".into(), data.into()));
            crate::replay::Request { method: "GET".into(), url: url::Url::parse_with_params("https://api.shop.example/h5/recommend/1.0/", &pairs).unwrap(), exchange: 0, headers: Vec::new(), body: None }
        };
        let mut cookies: Vec<(String, String)> = (0..19).map(|n| (format!("c{n}"), format!("{n:02}a7f3e9b1c4d2e8f0_x"))).collect();
        cookies.push(("_tk".to_string(), "5f3a9c21e4d7b8a6_1794402700000".to_string()));
        let (one, two) = (made("5f3a9c21e4d7b8a6", "1794402610160", r#"{"q":"lamps"}"#), made("5f3a9c21e4d7b8a6", "1794402629232", r#"{"q":"kettles"}"#));
        let (first, second) = (call("1794402610160", r#"{"q":"lamps"}"#, &one), call("1794402629232", r#"{"q":"kettles"}"#, &two));
        let sightings = [Sighting { value: &one, request: &first, body: None, cookies: &cookies }, Sighting { value: &two, request: &second, body: None, cookies: &cookies }];
        let recipe = fit_by_search(&sightings, "sign").expect("a recipe within the bound");
        assert_eq!(recipe.parts, vec![Part::CookiePiece { name: "_tk".into(), separator: "_".into(), index: 0 }, Part::Query { key: "t".into() }, Part::Query { key: "appKey".into() }, Part::Query { key: "data".into() }]);
    }

    /// A gateway that serves each operation at an address of its own signs them all the same way: calls of one host
    /// whose addresses carry the same names, each seen once, are sightings of one producer, and the recipe is fitted
    /// over them and holds for every one. A sibling that signs another way refutes it, and calls of another shape are
    /// no sightings at all.
    /// A gateway's first calls go out before the session holds its token, signed over whatever the page's code had in
    /// its place (here the word a script writes for a value it lacks); the calls after carry the token. The first say
    /// nothing of the recipe: it is fitted from the calls that carry the token, the same operation's or, where that is
    /// seen once, its sibling operations'. Calls that all lack the token still give nothing.
    #[test]
    fn a_call_made_before_its_token_says_nothing_of_the_recipe() {
        let token = "5f3a9c21e4d7b8a6";
        let made = |tk: &str, t: &str, data: &str| Algo::Md5.hash(&format!("{tk}&{t}&24677475&{data}"));
        let call = |op: &str, t: &str, data: &str, tk: Option<&str>| Exchange {
            method: "GET".into(),
            url: url::Url::parse_with_params(
                &format!("https://api.shop.example/h5/{op}/1.0/"),
                &[("jsv", "2.7.5"), ("appKey", "24677475"), ("t", t), ("sign", &made(tk.unwrap_or("undefined"), t, data)), ("api", op), ("data", data)],
            )
            .unwrap(),
            request_headers: vec![("cookie".into(), match tk {
                Some(tk) => format!("_tk={tk}_1794402700000; _tk_enc=0123456789abcdef; lang=en-SG-long"),
                None => "lang=en-SG-long".into(),
            })],
            status: 200,
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            ..script("")
        };
        let piece = vec![Part::CookiePiece { name: "_tk".into(), separator: "_".into(), index: 0 }, Part::Query { key: "t".into() }, Part::Query { key: "appKey".into() }, Part::Query { key: "data".into() }];
        let before = call("shop.recommend", "1794402610160", r#"{"page":1}"#, None);
        // The same operation again, with the token.
        let trace = Trace { exchanges: vec![before.clone(), call("shop.recommend", "1794402629232", r#"{"page":1}"#, Some(token)), call("shop.recommend", "1794402631000", r#"{"page":2}"#, Some(token))], inputs: vec![] };
        let address = trace.exchanges[1].url.to_string();
        assert_eq!(searched("GET", &address, "sign", &trace, &[]).map(|r| r.parts), Some(piece.clone()), "from the calls that carry the token");
        // Seen once with the token: its sibling operations, called with it, are the other sightings.
        let trace = Trace { exchanges: vec![before.clone(), call("shop.recommend", "1794402629232", r#"{"page":1}"#, Some(token)), call("im.token", "1794402640000", r#"{"x":2}"#, Some(token))], inputs: vec![] };
        let address = trace.exchanges[1].url.to_string();
        assert_eq!(searched("GET", &address, "sign", &trace, &[]).map(|r| r.parts), Some(piece), "beside a sibling that carries it");
        // Every call without the token: nothing to fit a recipe over the token from.
        let none = Trace { exchanges: vec![before, call("shop.recommend", "1794402629232", r#"{"page":1}"#, None)], inputs: vec![] };
        assert!(searched("GET", none.exchanges[1].url.as_ref(), "sign", &none, &[]).is_none());
    }

    #[test]
    fn a_gateways_operations_are_sightings_of_one_signer() {
        let token = "5f3a9c21e4d7b8a6";
        let made = |t: &str, data: &str| Algo::Md5.hash(&format!("{token}&{t}&24677475&{data}"));
        let call = |op: &str, t: &str, data: &str, sign: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse_with_params(&format!("https://api.shop.example/h5/{op}/1.0/"), &[("jsv", "2.7.5"), ("appKey", "24677475"), ("t", t), ("sign", sign), ("api", op), ("data", data)]).unwrap(),
            request_headers: vec![("cookie".into(), format!("_tk={token}_1794402700000; lang=en-SG-long"))],
            status: 200,
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            ..script("")
        };
        let calls = [("user.get", "1794402610160", r#"{}"#), ("shop.recommend", "1794402629232", r#"{"page":1}"#), ("im.token", "1794402631000", r#"{"x":2}"#)];
        let trace = Trace { exchanges: calls.iter().map(|(op, t, d)| call(op, t, d, &made(t, d))).collect(), inputs: vec![] };
        let address = trace.exchanges[1].url.to_string();
        let recipe = searched("GET", &address, "sign", &trace, &[]).expect("the operations are sightings of one signer");
        assert_eq!(recipe.parts, vec![Part::CookiePiece { name: "_tk".into(), separator: "_".into(), index: 0 }, Part::Query { key: "t".into() }, Part::Query { key: "appKey".into() }, Part::Query { key: "data".into() }]);
        // One operation signed another way: no recipe holds for every sighting.
        let mut odd = trace.clone();
        odd.exchanges[2] = call("im.token", "1794402631000", r#"{"x":2}"#, &Algo::Md5.hash("something else"));
        assert!(searched("GET", &address, "sign", &odd, &[]).is_none(), "a sibling that signs otherwise refutes it");
        // Calls of another shape (other names in the address) are no sightings: the target alone proves nothing.
        let mut apart = trace.clone();
        for e in apart.exchanges.iter_mut().filter(|e| !e.url.path().contains("recommend")) {
            e.url.query_pairs_mut().append_pair("extra", "1");
        }
        // Calls of another shape still sign as one: tried beside the call as its kin, the recipe that rebuilds the call
        // and every kin is kept.
        assert_eq!(searched("GET", &address, "sign", &apart, &[]).map(|r| r.parts.len()), Some(4), "kin of another shape, signed the same way");
        // Kin that sign otherwise give no recipe, and kin on another site are no kin.
        let mut stranger = apart.clone();
        for e in stranger.exchanges.iter_mut().filter(|e| !e.url.path().contains("recommend")) {
            let _ = e.url.set_host(Some("api.elsewhere.example"));
        }
        assert!(searched("GET", &address, "sign", &stranger, &[]).is_none(), "another site's calls");
        let mut otherwise = apart.clone();
        for e in otherwise.exchanges.iter_mut().filter(|e| !e.url.path().contains("recommend")) {
            let pairs: Vec<(String, String)> = e.url.query_pairs().map(|(k, v)| if k == "sign" { (k.into_owned(), Algo::Md5.hash(&format!("{v}!"))) } else { (k.into_owned(), v.into_owned()) }).collect();
            e.url.query_pairs_mut().clear().extend_pairs(pairs);
        }
        assert!(searched("GET", &address, "sign", &otherwise, &[]).is_none(), "kin that sign otherwise");
    }

    /// A header the page hashes over a clock reading it sends in a sibling header and the query (the matrix's
    /// `signed-standard`): the signature is a value the call itself carries, one part in a header of its own, found
    /// from two sightings and rebuilt for a value never seen. The clock reading is a part like any the request
    /// carries; a header the browser writes by itself is never one.
    #[test]
    fn a_signature_over_a_clock_in_a_sibling_header_and_the_query_is_fitted() {
        let made = |ts: &str, q: &str| Algo::Sha256.hash(&format!("{ts}:{q}"));
        let call = |ts: &str, q: &str| crate::replay::Request {
            method: "GET".into(),
            url: url::Url::parse_with_params("https://shop.example/api/signed-standard/search", &[("q", q)]).unwrap(),
            exchange: 0,
            // x-ts is the clock reading the call carries; user-agent is the browser's own shape, never a part.
            headers: vec![("x-ts".into(), ts.into()), ("user-agent".into(), "Mozilla/5.0".into()), ("accept".into(), "*/*".into())],
            body: None,
        };
        let (one, two) = (made("1794402610160", "kettle"), made("1794402629232", "teapot"));
        let (first, second) = (call("1794402610160", "kettle"), call("1794402629232", "teapot"));
        let sightings = [Sighting { value: &one, request: &first, body: None, cookies: &[] }, Sighting { value: &two, request: &second, body: None, cookies: &[] }];
        let recipe = fit_by_search(&sightings, "").expect("a recipe over the clock header and the query");
        assert_eq!(recipe.algo, Algo::Sha256);
        assert_eq!(recipe.separator, ":");
        assert_eq!(recipe.parts, vec![Part::Header { name: "x-ts".into() }, Part::Query { key: "q".into() }]);
        // A third call, a value never seen, its own time: the recipe makes what the page would have.
        let third = call("1794402699999", "ladle");
        assert_eq!(compute_with(&recipe, &third, None, &[], 0, |_| String::new()), Some(made("1794402699999", "ladle")));
    }

    /// A signature over the clock, the query and a constant the sending script holds (a salt a page ships to
    /// everyone, the matrix's `signed-standard`): found when that constant is offered, and rebuilt for a value never
    /// seen. The constant is offered as the script wrote it (`":fixture-key"`) and split on the search's separators,
    /// so the uniform join finds the piece. A literal of another script is never a part: only the sender's is
    /// offered, as the recording names it.
    #[test]
    fn a_signature_over_the_clock_the_query_and_a_literal_of_the_sending_script_is_fitted() {
        let made = |ts: &str, q: &str| Algo::Sha256.hash(&format!("{ts}:{q}:fixture-key"));
        let call = |ts: &str, q: &str| crate::replay::Request {
            method: "GET".into(),
            url: url::Url::parse_with_params("https://shop.example/api/signed-standard/search", &[("q", q)]).unwrap(),
            exchange: 0,
            headers: vec![("x-ts".into(), ts.into()), ("user-agent".into(), "Mozilla/5.0".into())],
            body: None,
        };
        let (one, two) = (made("1794402610160", "kettle"), made("1794402629232", "teapot"));
        let (first, second) = (call("1794402610160", "kettle"), call("1794402629232", "teapot"));
        let sightings = [Sighting { value: &one, request: &first, body: None, cookies: &[] }, Sighting { value: &two, request: &second, body: None, cookies: &[] }];
        // The sender script's literals, as `slice::literals` reads them: the salt is bundled with its delimiter.
        let senders = vec!["SHA-256".to_string(), ":".to_string(), ":fixture-key".to_string()];
        assert!(fit_by_search(&sightings, "").is_none(), "without the script's constant, no request part makes it");
        let recipe = fit_by_search_with(&sightings, "", &senders).expect("a recipe over the clock, the query and the salt");
        assert_eq!(recipe.separator, ":");
        assert_eq!(recipe.parts, vec![Part::Header { name: "x-ts".into() }, Part::Query { key: "q".into() }, Part::Constant { value: "fixture-key".into() }]);
        let third = call("1794402699999", "ladle");
        assert_eq!(compute_with(&recipe, &third, None, &[], 0, |_| String::new()), Some(made("1794402699999", "ladle")));
        // A literal of another script (the salt lives only in the sender) is never offered, so it is never a part.
        let elsewhere = vec!["SHA-256".to_string(), "x-other".to_string()];
        assert!(fit_by_search_with(&sightings, "", &elsewhere).is_none(), "another script's literals do not make it");
    }

    /// Two scripts spell the header's name: one lists it among the headers a logger may read, the other writes it.
    /// With the stack that sent the call, the spelling in a script on that stack, nearest a frame, is the writer.
    /// Without a stack the first spelling stands, as before; and a key spelled nowhere starts at the stack itself.
    #[test]
    fn the_stack_that_sent_the_call_says_which_spelling_wrote_the_value() {
        let logger = r#"var allowed=["accept","x-sig","content-type"];function log(h){return allowed.filter(function(k){return h[k]})}"#;
        let app = r#"function pad(){return 1}function send(req){req.headers["x-sig"]=seal(req.body);return fetch(req.url,req)}"#;
        let scripts = vec![("https://cdn.example/logger.js", logger), ("https://cdn.example/app.js", app)];
        let frame = crate::trace::Frame { script: "https://cdn.example/app.js".into(), line: 0, column: app.find("fetch(").unwrap() as u32, function: "send".into() };
        let none = written_at(&scripts, "x-sig", &[]).expect("a spelling");
        assert_eq!(none.script, "https://cdn.example/logger.js", "with no stack, the first spelling in the page's code");
        let found = written_at(&scripts, "x-sig", std::slice::from_ref(&frame)).expect("a spelling");
        assert_eq!((found.script.as_str(), found.at, found.frame), ("https://cdn.example/app.js", app.find("x-sig").unwrap(), false));
        assert!(written_at(&scripts, "x-other", std::slice::from_ref(&frame)).is_none());
        let sent = sent_at(&scripts, std::slice::from_ref(&frame)).expect("the frame's place");
        assert_eq!((sent.script.as_str(), sent.at, sent.frame), ("https://cdn.example/app.js", app.find("fetch(").unwrap(), true));
        // A producer written before stacks were kept reads as a write site, and one is saved as it always was.
        assert_eq!(serde_json::to_value(&found).unwrap(), serde_json::json!({ "script": "https://cdn.example/app.js", "at": found.at }));
        assert!(!serde_json::from_value::<Producer>(serde_json::json!({ "script": "a", "at": 3 })).unwrap().frame);
    }
    use crate::graph::{Field, Step};
    use crate::slots::Loc;
    use crate::trace::Exchange;

    fn script(body: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: "https://cdn.example/app.js".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/javascript".into())],
            response_body: Some(body.into()),
            response_mime: "application/javascript".into(),
            resource_type: Some("Script".into()),
            main_frame: None,
        }
    }

    fn served(url: &str, body: &str) -> Exchange {
        Exchange { url: url.parse().unwrap(), ..script(body) }
    }

    fn document(url: &str, html: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "text/html".into())],
            response_body: Some(html.into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        }
    }

    fn step_with(class: Class, name: &str) -> Step {
        Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0,
            method: "POST".into(),
            status: 200,
            url: "https://shop.example/api/search".into(),
            needs_browser: true,
            response_shape: None,
            sets_cookie: false,
            on_load: true,
            foreign: false,
            held: vec![],
            reads_page: false,
            fields: vec![Field { loc: Loc::Header(name.into()), class }],
            body: None,
            fallbacks: Vec::new(),
        }
    }

    /// A route keeps only the scripts the page's own code needs to make its call: each drop is kept only when the
    /// page still makes it, so the reduced set is verified by execution. A page that makes no such call in the sandbox
    /// keeps the full set (the bridge runs it as before).
    #[test]
    fn a_route_keeps_only_the_scripts_its_page_needs_to_make_the_call() {
        let s = |n: &str| Script { url: format!("https://cdn.example/{n}.js"), body: n.into() };
        let all = vec![s("boot"), s("locale"), s("sign"), s("tracker")];
        let mut run = |set: &[Script]| set.iter().any(|x| x.body == "boot") && set.iter().any(|x| x.body == "sign");
        let kept = reduce_with(&all, &mut run).expect("the full set makes the call");
        assert_eq!(kept.iter().map(|s| s.body.as_str()).collect::<Vec<_>>(), vec!["boot", "sign"]);
        let mut never = |_: &[Script]| false;
        assert!(reduce_with(&all, &mut never).is_none(), "nothing verified, nothing dropped");
        assert!(reduce_with(&all[..1], &mut run).is_none(), "one script is already the whole set");
    }

    /// A group of scripts is proved unnecessary in one boot, not one boot per script: a page with many third-party
    /// tags does not pay a full page load per tag to find out they do nothing.
    #[test]
    fn compaction_proves_a_group_in_one_boot() {
        let all: Vec<Script> = (0..16).map(|n| Script { url: format!("https://cdn.example/{n}.js"), body: n.to_string() }).collect();
        let mut boots = 0;
        let mut run = |set: &[Script]| {
            boots += 1;
            set.iter().any(|x| x.body == "0") && set.iter().any(|x| x.body == "1")
        };
        let kept = reduce_with(&all, &mut run).expect("the full set makes the call");
        assert_eq!(kept.iter().map(|s| s.body.as_str()).collect::<Vec<_>>(), vec!["0", "1"]);
        assert!(boots < 16, "batches, not one boot per script: {boots}");
    }

    /// The Trip.com signature, fitted from the string the page's own code built (the concat probe, verified live: its
    /// md5 is the header): the call's path and method, a request id read off the clock, and two session cookies. The
    /// recipe carries no page code, and rebuilds the value for another call with a new id.
    #[test]
    fn a_signature_is_fitted_to_a_recipe_and_rebuilt() {
        let input = "/restapi/soa2/27015/FlightListSearchSSE;POST;-1794198118858-6909512;09034102311421493297;1794198116912.eb47A68Ul2Z6;;";
        let value = Algo::Md5.hash(input);
        let req = crate::replay::Request { method: "POST".into(), url: "https://sg.trip.com/restapi/soa2/27015/FlightListSearchSSE".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let cookies = vec![("GUID".to_string(), "09034102311421493297".to_string()), ("UBT_VID".to_string(), "1794198116912.eb47A68Ul2Z6".to_string())];
        let now = 1_794_198_119_000u64;
        let recipe = fit(&value, input, &req, None, &cookies, now).expect("a recipe");
        assert_eq!(recipe.algo, Algo::Md5);
        assert_eq!(recipe.separator, ";");
        assert_eq!(
            recipe.parts,
            vec![
                Part::Path,
                Part::Method,
                Part::Fresh { template: "-{ms}-{d7}".into() },
                Part::Cookie { name: "GUID".into() },
                Part::Cookie { name: "UBT_VID".into() },
                Part::Constant { value: String::new() },
                Part::Constant { value: String::new() },
            ]
        );
        let again = compute_with(&recipe, &req, None, &cookies, 1_794_198_200_000, |n| "1".repeat(n)).expect("a value");
        assert_eq!(again, Algo::Md5.hash("/restapi/soa2/27015/FlightListSearchSSE;POST;-1794198200000-1111111;09034102311421493297;1794198116912.eb47A68Ul2Z6;;"));
        // A piece that is nobody's known value is not fitted: it could be a per-call value frozen into the route.
        let loose = "/restapi/soa2/27015/FlightListSearchSSE;POST;something-else;09034102311421493297;1794198116912.eb47A68Ul2Z6;;";
        assert!(fit(&Algo::Md5.hash(loose), loose, &req, None, &cookies, now).is_none());
        // Nor is a value no hash of it: the fit is proven against the value, not assumed from the shape.
        assert!(fit("00000000000000000000000000000000", input, &req, None, &cookies, now).is_none());
    }

    /// The walk's own code names the header: the producer is found and the field becomes a script, so the step no
    /// longer needs a browser — and nothing here knows the site.
    #[test]
    fn a_header_the_pages_code_names_is_a_script_producer() {
        let body = r#"function add(t){var r=(0,n.md5)(t.body);t.headers["x-sig"]=window.sign(r)}"#;
        let trace = Trace { exchanges: vec![script(body)], inputs: vec![] };
        let mut graph = Graph { steps: vec![step_with(Class::Computed, "x-sig")], provisional: false, page_origin: None, ..Graph::default() };
        assert_eq!(discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]), 1);
        let step = &graph.steps[0];
        assert!(step.is_page_signed(), "the page's request is the step's");
        assert_eq!(step.page_producers.len(), 1, "{:?}", step.page_producers);
        let p = &step.page_producers[0];
        assert_eq!(p.producer.script, "https://cdn.example/app.js");
        assert_eq!(p.producer.at, body.find("x-sig").unwrap());
        assert!(p.loc == Loc::Header("x-sig".into()));
        assert!(step.fields.is_empty(), "a page-made value is not a field the route sends: {:?}", step.fields);
        assert!(step.needs_browser, "the step needs the page's producer");
        // The producer's own script rides on the route, so a signing bridge can run it without the walk.
        assert_eq!(graph.scripts.len(), 1);
        assert_eq!(graph.scripts[0].url, "https://cdn.example/app.js");
        assert!(graph.scripts[0].body.contains("x-sig"));
    }

    /// A header that only says what the body is (`content-type: application/x-www-form-urlencoded`), seen once, is no
    /// value the page makes up, whatever script names it: the step stays a plain call. A value in such a header that
    /// reads as a token, and a value the graph knows is computed, still go to the page.
    #[test]
    fn a_header_describing_the_body_never_needs_the_page() {
        let body = r#"function send(t){t.headers["content-type"]="application/x-www-form-urlencoded";t.headers["x-sig"]=window.sign(t)}"#;
        let trace = Trace { exchanges: vec![script(body)], inputs: vec![] };
        // As the graph builds it: a value seen once is no computed one, so the step doesn't need a browser yet.
        let plain_step = Step { needs_browser: false, ..step_with(Class::Unconfirmed { value: "application/x-www-form-urlencoded".into() }, "content-type") };
        let mut graph = Graph { steps: vec![plain_step], provisional: false, page_origin: None, ..Graph::default() };
        discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]);
        assert!(!graph.steps[0].is_page_signed(), "{:?}", graph.steps[0].page_producers);
        assert!(matches!(graph.steps[0].fields[0].class, Class::Unconfirmed { .. }), "left as it was");
        for plain in ["application/json; charset=utf-8", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "en-SG,en;q=0.9", "gzip, deflate, br"] {
            assert!(says_what_the_body_is(if plain.starts_with("en") { "accept-language" } else if plain.starts_with("gzip") { "accept-encoding" } else { "accept" }, plain), "{plain}");
        }
        assert!(!says_what_the_body_is("content-type", "application/json; sig=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), "a token in a parameter");
        assert!(!says_what_the_body_is("x-sig", "application/json"), "not a header that describes the body");
        let mut computed = Graph { steps: vec![step_with(Class::Computed, "content-type")], provisional: false, page_origin: None, ..Graph::default() };
        discover(&mut computed, &trace, &[], &crate::generated::Environment::default(), &[]);
        assert!(computed.steps[0].is_page_signed(), "a value the graph knows is computed still needs the page");
    }

    /// A probe's value names the exchange that carried it, so each sighting is read with its own cookies and body —
    /// not a neighbouring call's on the same path. That is the context a generated program is fitted on and verified
    /// against, and the produced header is never among its own inputs.
    #[test]
    fn a_sighting_is_read_with_its_own_cookies_and_body() {
        let ex = |sig: &str, sid: &str, body: &str| Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/search".parse().unwrap(),
            request_headers: vec![("x-sig".into(), sig.into()), ("cookie".into(), format!("sid={sid}")), ("content-type".into(), "application/json".into())],
            request_body: Some(body.into()),
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let trace = Trace { exchanges: vec![ex("s-1", "c-1", "{\"d\":1}"), ex("s-2", "c-2", "{\"d\":2}")], inputs: vec![] };
        let probes = vec![
            Probe { header: "x-sig".into(), value: "s-2".into(), url: "/api/search".into(), input: "two".into(), pre: String::new(), stack: Vec::new() },
            Probe { header: "x-sig".into(), value: "s-1".into(), url: "/api/search".into(), input: "one".into(), pre: String::new(), stack: Vec::new() },
        ];
        let samples = samples_for("x-sig", &trace.exchanges[0], &trace, &probes, &[]);
        assert_eq!(samples.len(), 2);
        let of = |sig: &str| samples.iter().find(|s| s.expected == sig).expect("a sighting");
        assert_eq!(of("s-1").cookies, vec![("sid".into(), "c-1".into())]);
        assert_eq!(of("s-1").body.as_deref(), Some("{\"d\":1}"));
        assert_eq!(of("s-2").cookies, vec![("sid".into(), "c-2".into())]);
        assert_eq!(of("s-2").body.as_deref(), Some("{\"d\":2}"));
        assert!(of("s-1").headers.iter().all(|(k, _)| k != "x-sig"), "a header is not its own input");
    }

    /// Two calls to one path are told apart by the header value the probe recorded: the probe is paired with the call
    /// that carried it, not with the first one on the path.
    #[test]
    fn a_probe_is_fitted_to_the_call_that_carried_it() {
        let ex = |sig: &str, body: &str, sid: &str| Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/search".parse().unwrap(),
            request_headers: vec![("x-sig".into(), sig.into()), ("cookie".into(), format!("sid={sid}"))],
            request_body: Some(body.into()),
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let trace = Trace { exchanges: vec![ex("s-1", "{\"d\":1}", "c-1"), ex("s-2", "{\"d\":2}", "c-2")], inputs: vec![] };
        let probe = Probe { header: "x-sig".into(), value: "s-2".into(), url: "/api/search".into(), input: "two".into(), pre: String::new(), stack: Vec::new() };
        let found = sighting(&trace, &trace.exchanges[0], "x-sig", &probe).expect("the call that carried it");
        assert_eq!(found.request_body.as_deref(), Some("{\"d\":2}"));
        assert_eq!(found.cookies(), vec![("sid".into(), "c-2".into())]);
    }

    /// A second walk of the page is evidence too: a header seen once in each walk gives the verifier two sightings,
    /// with each walk's own body and cookies.
    #[test]
    fn a_program_is_fitted_from_more_than_one_walk() {
        let ex = |sig: &str, body: &str, sid: &str| Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/search".parse().unwrap(),
            request_headers: vec![("x-sig".into(), sig.into()), ("cookie".into(), format!("sid={sid}"))],
            request_body: Some(body.into()),
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let now = Trace { exchanges: vec![ex("s-1", "{\"d\":1}", "c-1")], inputs: vec![] };
        let past = Trace { exchanges: vec![ex("s-2", "{\"d\":2}", "c-2")], inputs: vec![] };
        let probe = |v: &str| Probe { header: "x-sig".into(), value: v.into(), url: "/api/search".into(), input: v.into(), pre: String::new(), stack: Vec::new() };
        let samples = samples_for("x-sig", &now.exchanges[0], &now, &[probe("s-1")], &[(past.clone(), vec![probe("s-2")])]);
        assert_eq!(samples.len(), 2, "{samples:?}");
        let of = |v: &str| samples.iter().find(|s| s.expected == v).expect("a sighting");
        assert_eq!(of("s-1").body.as_deref(), Some("{\"d\":1}"));
        assert_eq!(of("s-2").body.as_deref(), Some("{\"d\":2}"));
        assert_eq!(of("s-2").cookies, vec![("sid".into(), "c-2".into())]);
    }

    /// The evidence a generator reads is the write site plus the code that makes the value: a write site that calls a
    /// separately loaded module names it, and the module's own definition is another script in the walk. Nothing here
    /// knows the site: the names come from the write site.
    #[test]
    fn the_evidence_carries_the_module_a_write_site_calls() {
        let site = r#"(function(){var t=this;t.headers["w-payload-source"]=window.c_sign.toString(md5(t.body))})()"#;
        let module = r#"function c_sign(t){return "1.0.9@102!"+t}"#;
        let scripts = vec![("https://cdn.example/app.js", site), ("https://cdn.example/csign.js", module)];
        let producer = Producer { script: "https://cdn.example/app.js".into(), at: site.find("w-payload-source").unwrap(), frame: false };
        let code = evidence_code(&scripts, &producer);
        assert!(code.contains("write site"), "{code}");
        assert!(code.contains("c_sign"), "the name the write site calls: {code}");
        assert!(code.contains("https://cdn.example/csign.js"), "the module's own script: {code}");
        assert!(code.contains("1.0.9@102!"), "the module's body: {code}");
    }

    /// A name only inside a longer word (`x-sig` in `x-signature`) is no producer, and neither is a computed field no
    /// script names: both stay computed, and the step still goes to the browser.
    #[test]
    fn a_name_that_is_not_the_code_name_is_no_producer() {
        let body = r#"var a={["x-signed"]:1};headers["other"]=2"#;
        let trace = Trace { exchanges: vec![script(body)], inputs: vec![] };
        let mut graph = Graph { steps: vec![step_with(Class::Computed, "x-sig")], provisional: false, page_origin: None, ..Graph::default() };
        assert_eq!(discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]), 0);
        assert!(graph.steps[0].is_page_signed(), "a value the walk couldn't place is still the page's");
        assert!(graph.steps[0].page_producers.is_empty(), "nothing names a producer");
        assert!(graph.steps[0].needs_browser);
    }

    /// A step whose only computed field is found becomes plain HTTP; one with another computed field still needs the
    /// browser. A script the walk never fetched produces nothing.
    #[test]
    fn only_a_step_with_nothing_left_to_compute_is_sent_plain() {
        let trace = Trace { exchanges: vec![script(r#"headers["x-sig"]="1";headers["x-other"]="2""#)], inputs: vec![] };
        let mut mixed = step_with(Class::Computed, "x-sig");
        mixed.fields.push(Field { loc: Loc::Header("x-other".into()), class: Class::Computed });
        let mut graph = Graph { steps: vec![mixed], provisional: false, page_origin: None, ..Graph::default() };
        assert_eq!(discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]), 2, "both headers are named");
        assert!(graph.steps[0].is_page_signed());
        assert_eq!(graph.steps[0].page_producers.len(), 2);
        assert!(graph.steps[0].fields.is_empty(), "both are the page's request, not its fields");
        assert!(graph.steps[0].needs_browser);

        let none = Trace { exchanges: vec![], inputs: vec![] };
        let mut graph = Graph { steps: vec![step_with(Class::Computed, "x-sig")], provisional: false, page_origin: None, ..Graph::default() };
        assert_eq!(discover(&mut graph, &none, &[], &crate::generated::Environment::default(), &[]), 0);
        assert!(graph.steps[0].needs_browser);
    }


    /// The data the page read rides on the route, beside its scripts, and the page's markup does not: a bundle boots
    /// from its own answers, so a call the page made for its config is kept and a document or an image is not.
    #[test]
    fn the_pages_own_data_answers_ride_on_the_route() {
        let json = Exchange {
            method: "POST".into(),
            url: "https://shop.example/restapi/getAppConfig.json".parse().unwrap(),
            request_headers: vec![],
            request_body: Some("{}".into()),
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(r#"{"sig":"1"}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let markup = Exchange {
            method: "GET".into(),
            url: "https://shop.example/chunk.html".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "text/html".into())],
            response_body: Some("<html><body>painted</body></html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let third = Exchange {
            method: "GET".into(),
            url: "https://ads.other.example/cfg.json".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(r#"{"ad":1}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = Trace { exchanges: vec![json, markup, third], inputs: vec![] };
        let mut graph = Graph {
            steps: vec![step_with(Class::Computed, "x-sig")],
            provisional: false,
            page_origin: Some("https://shop.example".into()),
            scripts: vec![Script { url: "https://cdn.shop.example/app.js".into(), body: "var a=1".into() }],
            ..Graph::default()
        };
        assert_eq!(record(&mut graph, &trace, "shop.example"), 1, "the page's own data, not markup, not a third party: {:?}", graph.api.iter().map(|a| &a.url).collect::<Vec<_>>());
        assert_eq!(graph.api[0].url, "https://shop.example/restapi/getAppConfig.json");
        assert_eq!(graph.api[0].body, r#"{"sig":"1"}"#);
    }

    /// The page's own document names the scripts it boots: those ride on the route in load order, wherever a content
    /// host serves them from, and a third party's do not. This is what a signing bridge runs to get the app's own
    /// start-up, which is the code that makes the call.
    #[test]
    fn the_pages_own_boot_scripts_ride_in_load_order_and_a_third_partys_do_not() {
        let html = r#"<html><head>
            <script src="https://cdn.shop-cdn.example/b.9f8e7d.js"></script>
            <script src="https://cdn.shop-cdn.example/a.1a2b3c.js"></script>
        </head></html>"#;
        let trace = Trace {
            exchanges: vec![
                document("https://shop.example/search", html),
                served("https://ads.tracker.example/t.js", "var ad=1"),
                served("https://cdn.shop-cdn.example/b.9f8e7d.js", "var b=1"),
                served("https://cdn.shop-cdn.example/a.1a2b3c.js", "var a=1"),
            ],
            inputs: vec![],
        };
        let mut graph = Graph {
            steps: vec![step_with(Class::Computed, "x-sig")],
            provisional: false,
            page_origin: Some("https://shop.example".into()),
            ..Graph::default()
        };
        discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]);
        let kept: Vec<&str> = graph.scripts.iter().map(|s| s.url.as_str()).collect();
        assert_eq!(kept, vec!["https://cdn.shop-cdn.example/b.9f8e7d.js", "https://cdn.shop-cdn.example/a.1a2b3c.js"], "the document names both, in the order the page loaded them");
    }

    /// A page that names no script cannot say which are its own: the sandbox carries only the producer the walk found,
    /// rather than guessing at a host.
    #[test]
    fn a_document_that_names_no_script_carries_only_the_producer() {
        let trace = Trace {
            exchanges: vec![
                document("https://shop.example/search", "<html><body>app</body></html>"),
                served("https://cdn.other.example/t.js", "var t=1"),
            ],
            inputs: vec![],
        };
        let mut graph = Graph {
            steps: vec![step_with(Class::Computed, "x-sig")],
            provisional: false,
            page_origin: Some("https://shop.example".into()),
            ..Graph::default()
        };
        discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]);
        assert!(graph.scripts.is_empty(), "{:?}", graph.scripts.iter().map(|s| &s.url).collect::<Vec<_>>());
    }

    /// A route carries a page's scripts up to its cap, in load order: the ones past it stay in the walk.
    #[test]
    fn the_boot_scripts_stop_at_the_routes_cap() {
        let big = "x".repeat(SCRIPTS_CAP / 2 + 9);
        let html = r#"<script src="/one.aaaaaaaa.js"></script><script src="/two.bbbbbbbb.js"></script>"#;
        let trace = Trace {
            exchanges: vec![
                document("https://shop.example/search", html),
                served("https://shop.example/one.aaaaaaaa.js", &big),
                served("https://shop.example/two.bbbbbbbb.js", &big),
            ],
            inputs: vec![],
        };
        let mut graph = Graph {
            steps: vec![step_with(Class::Computed, "x-sig")],
            provisional: false,
            page_origin: Some("https://shop.example".into()),
            ..Graph::default()
        };
        discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]);
        assert_eq!(graph.scripts.len(), 1, "the second would pass the cap");
        assert_eq!(graph.scripts[0].url, "https://shop.example/one.aaaaaaaa.js");
    }

    #[test]
    #[ignore]
    fn assemble_a_recorded_producer() {
        let Ok(path) = std::env::var("UNBROWSE_ROUTE") else { return };
        let Ok(header) = std::env::var("UNBROWSE_HEADER") else { return };
        let text = std::fs::read_to_string(&path).expect("a route file");
        let v: serde_json::Value = serde_json::from_str(&text).expect("route json");
        let graph: crate::Graph = serde_json::from_value(v.get("graph").cloned().unwrap_or(v)).expect("a graph");
        let scripts: Vec<(&str, &str)> = graph.scripts.iter().map(|s| (s.url.as_str(), s.body.as_str())).collect();
        let producer = graph.steps.iter().flat_map(|s| &s.fields).find_map(|f| match (&f.class, &f.loc) {
            (Class::Script { producer }, crate::slots::Loc::Header(k)) if k.eq_ignore_ascii_case(&header) => Some(producer.clone()),
            _ => None,
        }).expect("a script field for the header");
        match crate::slice::assemble(&scripts, &producer, &header) {
            Some(program) => println!("PROGRAM\n{program}"),
            None => println!("no program assembled"),
        }
    }

    #[test]
    #[ignore]
    fn verify_a_recorded_producer() {
        let (Ok(path), Ok(header), Ok(walk)) = (std::env::var("UNBROWSE_ROUTE"), std::env::var("UNBROWSE_HEADER"), std::env::var("UNBROWSE_WALK")) else { return };
        let text = std::fs::read_to_string(&path).expect("a route file");
        let v: serde_json::Value = serde_json::from_str(&text).expect("route json");
        let graph: crate::Graph = serde_json::from_value(v.get("graph").cloned().unwrap_or(v)).expect("a graph");
        let scripts: Vec<(&str, &str)> = graph.scripts.iter().map(|s| (s.url.as_str(), s.body.as_str())).collect();
        let producer = graph.steps.iter().flat_map(|s| &s.fields).find_map(|f| match (&f.class, &f.loc) {
            (Class::Script { producer }, crate::slots::Loc::Header(k)) if k.eq_ignore_ascii_case(&header) => Some(producer.clone()),
            _ => None,
        }).expect("a script field for the header");
        let program = crate::slice::assemble(&scripts, &producer, &header).expect("a program");
        let mut samples = Vec::new();
        for line in std::fs::read_to_string(&walk).expect("a walk").lines() {
            let Ok(e) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let Some(req) = e.get("entry").and_then(|x| x.get("request")) else { continue };
            let Some(url) = req.get("url").and_then(|u| u.as_str()) else { continue };
            let hs: Vec<(String, String)> = req.get("headers").and_then(|h| h.as_array()).into_iter().flatten().filter_map(|h| Some((h.get("name")?.as_str()?.to_string(), h.get("value")?.as_str()?.to_string()))).collect();
            let Some(expected) = hs.iter().find(|(k, _)| k.eq_ignore_ascii_case(&header)).map(|(_, v)| v.clone()) else { continue };
            let body = req.get("postData").and_then(|p| p.get("text")).and_then(|t| t.as_str()).map(String::from);
            let cookies: Vec<(String, String)> = req.get("cookies").and_then(|c| c.as_array()).into_iter().flatten().filter_map(|c| Some((c.get("name")?.as_str()?.to_string(), c.get("value")?.as_str()?.to_string()))).collect();
            let headers = hs.into_iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie") && !k.eq_ignore_ascii_case(&header)).collect();
            let sample = crate::generated::Sample { method: req.get("method").and_then(|m| m.as_str()).unwrap_or("POST").to_string(), url: url.to_string(), body, cookies, headers, expected, pre: None };
            if !samples.iter().any(|s: &crate::generated::Sample| s.url == sample.url && s.body == sample.body && s.cookies == sample.cookies && s.expected == sample.expected) {
                samples.push(sample);
            }
        }
        let env = crate::generated::Environment { page_url: graph.page.clone(), html: graph.page_html.clone(), ..Default::default() };
        let verdict = crate::generated::verify(&program, &samples, &env);
        println!("VERDICT {verdict:?} over {} samples", samples.len());
        if let Some(s) = samples.first() {
            let ctx = crate::generated::context_of(&s.method, &s.url, s.body.as_deref(), &s.cookies, &s.headers);
            match crate::sandbox::run_program_on_page(&program, &ctx, &env.fingerprint, &env.storage, env.page_url.as_deref().unwrap_or(""), env.html.as_deref().unwrap_or(""), &[], &[]) {
                Ok(got) => println!("GOT {:?}\nWANT {:?}", got, s.expected),
                Err(why) => println!("RUN FAILED {why}"),
            }
        }
    }

    #[test]
    #[ignore]
    fn read_a_recorded_global() {
        let (Ok(path), Ok(name)) = (std::env::var("UNBROWSE_ROUTE"), std::env::var("UNBROWSE_GLOBAL")) else { return };
        let text = std::fs::read_to_string(&path).expect("a route file");
        let v: serde_json::Value = serde_json::from_str(&text).expect("route json");
        let graph: crate::Graph = serde_json::from_value(v.get("graph").cloned().unwrap_or(v)).expect("a graph");
        let html = graph.page_html.clone().unwrap_or_default();
        let page = graph.page.clone().unwrap_or_default();
        let answers = graph.api.clone();
        let mut tries: Vec<(&str, Vec<(String, String)>)> = Vec::new();
        let one: Vec<(String, String)> = graph.scripts.iter().filter(|s| s.body.contains(&name) && !s.body.contains("x-ctx-fvpc")).map(|s| (s.url.clone(), s.body.clone())).collect();
        tries.push(("the scripts that name it", one));
        tries.push(("every script", graph.scripts.iter().map(|s| (s.url.clone(), s.body.clone())).collect()));
        for (what, bundle) in tries {
            let got = crate::sandbox::read_global(&name, &bundle, &page, "", &crate::sandbox::Storage::default(), &html, &serde_json::Value::Null, &answers, None);
            println!("{what}: {} scripts -> {:?}", bundle.len(), got.as_deref().map(|v| &v[..v.len().min(40)]));
        }
    }

    // ---- tests added for coverage of discovery, search, compute, fresh templates and compaction ----

    fn api_call(method: &str, url: &str, sig: Option<&str>, body: Option<&str>) -> Exchange {
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: sig.map(|s| vec![("x-sig".to_string(), s.to_string())]).unwrap_or_default(),
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        }
    }

    fn sig_probe(value: &str, input: &str) -> Probe {
        Probe { header: "x-sig".into(), value: value.into(), url: "/api/search".into(), input: input.into(), pre: String::new(), stack: Vec::new() }
    }

    fn plain_graph(step: Step) -> Graph {
        Graph { steps: vec![step], provisional: false, page_origin: None, ..Graph::default() }
    }

    /// The walk's own probe shows the string the page hashed: the field becomes a recipe (no page code, no browser),
    /// and the recipe makes the same value again for the same call.
    #[test]
    fn a_value_the_walk_saw_hashed_becomes_a_recipe_and_not_a_page_producer() {
        let input = "/api/search;POST";
        let value = Algo::Md5.hash(input);
        let trace = Trace { exchanges: vec![script(r#"headers["x-sig"]=1"#), api_call("POST", "https://shop.example/api/search", Some(&value), Some("{}"))], inputs: vec![] };
        let mut step = step_with(Class::Computed, "x-sig");
        step.needs_browser = false;
        let mut graph = plain_graph(step);
        assert_eq!(discover(&mut graph, &trace, &[sig_probe(&value, input)], &crate::generated::Environment::default(), &[]), 1);
        let step = &graph.steps[0];
        let Class::Recipe { recipe } = &step.fields[0].class else { panic!("a recipe, got {:?}", step.fields[0].class) };
        assert_eq!((recipe.algo, recipe.separator.as_str()), (Algo::Md5, ";"));
        assert_eq!(recipe.parts, vec![Part::Path, Part::Method]);
        assert!(step.page_producers.is_empty() && !step.is_page_signed(), "a recipe needs no page");
        assert!(graph.scripts.is_empty(), "a recipe carries no script");
        let again = crate::replay::Request { method: "POST".into(), url: "https://shop.example/api/search".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        assert_eq!(compute(recipe, &again, None, &[]), Some(value));
    }

    /// A probe that shows a string no known hash makes is no recipe, and the page's own code is still looked for:
    /// when the lifted code never answers, the step keeps the page as its producer, and the script rides on the route.
    #[test]
    fn a_probe_no_recipe_fits_and_code_that_never_answers_leave_the_page_as_the_producer() {
        let site = r#"var send=function(t,e){if(t.body==="never"){t.headers["x-sig"]="a"}}"#;
        let trace = Trace {
            exchanges: vec![script(site), api_call("POST", "https://shop.example/api/search", Some("v-one-1"), Some("{\"d\":1}")), api_call("POST", "https://shop.example/api/search", Some("v-two-2"), Some("{\"d\":2}"))],
            inputs: vec![],
        };
        let probes = [sig_probe("v-one-1", "not what was hashed"), sig_probe("v-two-2", "nor this")];
        let mut graph = plain_graph(step_with(Class::Computed, "x-sig"));
        assert_eq!(discover(&mut graph, &trace, &probes, &crate::generated::Environment::default(), &[]), 1);
        let step = &graph.steps[0];
        assert!(step.is_page_signed() && step.needs_browser);
        assert_eq!(step.page_producers.len(), 1);
        assert_eq!(step.page_producers[0].producer.script, "https://cdn.example/app.js");
        assert_eq!(step.page_producers[0].producer.at, site.find("x-sig").unwrap());
        assert!(step.fields.is_empty());
        assert_eq!(graph.scripts.len(), 1);
    }

    /// A route learned before the step-level marker carries a `Script` field: it is the same evidence, and is folded
    /// into the step's page producers and taken out of the fields the route sends.
    #[test]
    fn a_script_field_from_an_older_route_is_folded_into_the_steps_page_producers() {
        let old = Producer { script: "https://cdn.example/app.js".into(), at: 3, frame: false };
        let trace = Trace { exchanges: vec![script("var a=1")], inputs: vec![] };
        let mut graph = plain_graph(step_with(Class::Script { producer: old.clone() }, "x-old"));
        assert_eq!(discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]), 0, "nothing new is found");
        let step = &graph.steps[0];
        assert!(step.is_page_signed() && step.needs_browser);
        assert_eq!(step.page_producers.len(), 1);
        assert!(step.page_producers[0].loc == Loc::Header("x-old".into()));
        assert_eq!(step.page_producers[0].producer, old);
        assert!(step.fields.is_empty(), "the page makes it, the route does not send it");
    }

    /// The page's lifted code makes a value the walk saw twice: the program is shipped as reproducing it, carries its
    /// own code (no script rides on the route), names what made it, and answers a call it never saw.
    #[test]
    fn a_value_the_pages_lifted_code_reproduces_ships_as_a_program() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the lifted program is skipped");
            return;
        }
        let site = r#"var send=function(t,e){t.headers["x-sig"]="sig-"+t.body.length+":"+t.body}"#;
        let (b1, b2) = ("{\"q\":\"kettle\"}", "{\"q\":\"teapot-large\"}");
        let (v1, v2) = (format!("sig-{}:{b1}", b1.len()), format!("sig-{}:{b2}", b2.len()));
        let trace = Trace {
            exchanges: vec![script(site), api_call("POST", "https://shop.example/api/search", Some(&v1), Some(b1)), api_call("POST", "https://shop.example/api/search", Some(&v2), Some(b2))],
            inputs: vec![],
        };
        let probes = [sig_probe(&v1, "n/a"), sig_probe(&v2, "n/a")];
        let mut graph = plain_graph(step_with(Class::Computed, "x-sig"));
        graph.steps[0].needs_browser = false;
        assert_eq!(discover(&mut graph, &trace, &probes, &crate::generated::Environment::default(), &[]), 1);
        let step = &graph.steps[0];
        let Class::Generated { program, evidence } = &step.fields[0].class else { panic!("a program, got {:?}", step.fields[0].class) };
        assert!(evidence.exact, "both sightings were reproduced");
        assert_eq!((evidence.header.as_str(), evidence.sightings), ("x-sig", 2));
        assert_eq!(evidence.proposed_by, "the page's own code (slice)");
        assert_eq!(evidence.producer.as_ref().map(|p| p.script.as_str()), Some("https://cdn.example/app.js"));
        assert!(evidence.scripts.is_empty(), "a program that answers alone needs no script: {:?}", evidence.scripts);
        assert!(graph.scripts.is_empty());
        assert!(!step.is_page_signed());
        let ctx = serde_json::json!({ "body": "{\"q\":\"ladle\"}", "url": "https://shop.example/api/search" });
        assert_eq!(crate::sandbox::run_program(program, &ctx, &serde_json::Value::Null, &Default::default()).unwrap(), "sig-13:{\"q\":\"ladle\"}");
    }

    /// Lifted code that runs but makes other values than the walk saw is still kept, marked as not reproducing: a
    /// call decides, not the walk.
    #[test]
    fn lifted_code_that_runs_but_differs_from_the_walk_is_kept_as_not_exact() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the lifted program is skipped");
            return;
        }
        let site = r#"var send=function(t,e){t.headers["x-sig"]="sig-"+t.body.length}"#;
        let trace = Trace {
            exchanges: vec![script(site), api_call("POST", "https://shop.example/api/search", Some("other-first-1"), Some("{\"d\":1}")), api_call("POST", "https://shop.example/api/search", Some("other-second-2"), Some("{\"d\":22}"))],
            inputs: vec![],
        };
        let probes = [sig_probe("other-first-1", "n/a"), sig_probe("other-second-2", "n/a")];
        let mut graph = plain_graph(step_with(Class::Computed, "x-sig"));
        assert_eq!(discover(&mut graph, &trace, &probes, &crate::generated::Environment::default(), &[]), 1);
        let Class::Generated { evidence, .. } = &graph.steps[0].fields[0].class else { panic!("a program, got {:?}", graph.steps[0].fields[0].class) };
        assert!(!evidence.exact, "the walk's values were not reproduced");
        assert_eq!(evidence.sightings, 2);
    }

    /// A lifted program that calls a global the page's other script defines under a name built at run time is not
    /// self-contained: the route keeps the producer's script so the bridge runs it before the program.
    #[test]
    fn a_program_that_needs_a_global_the_page_defines_keeps_its_producers_script() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the lifted program is skipped");
            return;
        }
        let site = r#"var send=function(t,e){t.headers["x-sig"]="g-"+window.__mk(t.body)}"#;
        let maker = r#"window["__"+"mk"]=function(s){return "E"+s.length+s}"#;
        let (b1, b2) = ("{\"q\":\"kettle\"}", "{\"q\":\"teapot-large\"}");
        let (v1, v2) = (format!("g-E{}{b1}", b1.len()), format!("g-E{}{b2}", b2.len()));
        let trace = Trace {
            exchanges: vec![script(site), served("https://cdn.example/maker.js", maker), api_call("POST", "https://shop.example/api/search", Some(&v1), Some(b1)), api_call("POST", "https://shop.example/api/search", Some(&v2), Some(b2))],
            inputs: vec![],
        };
        let env = crate::generated::Environment {
            page_url: Some("https://shop.example/search".into()),
            html: Some("<html><head></head><body></body></html>".into()),
            scripts: vec![("https://cdn.example/app.js".into(), site.into()), ("https://cdn.example/maker.js".into(), maker.into())],
            ..Default::default()
        };
        let probes = [sig_probe(&v1, "n/a"), sig_probe(&v2, "n/a")];
        let mut graph = plain_graph(step_with(Class::Computed, "x-sig"));
        assert_eq!(discover(&mut graph, &trace, &probes, &env, &[]), 1);
        let Class::Generated { evidence, .. } = &graph.steps[0].fields[0].class else { panic!("a program, got {:?}", graph.steps[0].fields[0].class) };
        assert_eq!(evidence.scripts, vec!["https://cdn.example/app.js".to_string()], "the producer's script is what the program leans on");
        assert!(graph.scripts.iter().any(|s| s.url == "https://cdn.example/app.js"), "and it rides on the route");
        assert!(graph.steps[0].is_page_signed(), "a route that runs a page script is page-signed");
    }

    /// A value in the call's own address that the page hashed from what the call carries is found by search when the
    /// walks hold the call more than once, and the recipe makes the value for a call never seen.
    #[test]
    fn a_query_signature_is_searched_for_over_every_sighting_of_the_call() {
        let made = |t: &str, q: &str| Algo::Md5.hash(&format!("{t}&{q}"));
        let url = |t: &str, q: &str| format!("https://api.shop.example/h5/find?t={t}&q={q}&sign={}", made(t, q));
        let seen = [("1794402610160", "lamps"), ("1794402629232", "kettles"), ("1794402655001", "sofas")];
        let trace = Trace { exchanges: std::iter::once(script("var a=1")).chain(seen.iter().map(|(t, q)| served(&url(t, q), "{}"))).collect(), inputs: vec![] };
        let address = "https://api.shop.example/h5/find?t={t}&q={q}&sign={sign}";
        let recipe = searched("GET", address, "sign", &trace, &[]).expect("a recipe for the signature");
        let new = crate::replay::Request { method: "GET".into(), url: url("1794402699999", "ladles").parse().unwrap(), exchange: 0, headers: vec![], body: None };
        assert_eq!(compute_with(&recipe, &new, None, &[], 0, |_| String::new()), Some(made("1794402699999", "ladles")));

        // The same through discover: the query field becomes the recipe, found counts it, no page is needed.
        let mut step = step_with(Class::Computed, "unused");
        step.method = "GET".into();
        step.url = address.into();
        step.needs_browser = false;
        step.fields = vec![Field { loc: Loc::Query("sign".into()), class: Class::Computed }];
        let mut graph = plain_graph(step);
        assert_eq!(discover(&mut graph, &trace, &[], &crate::generated::Environment::default(), &[]), 1);
        assert!(matches!(&graph.steps[0].fields[0].class, Class::Recipe { recipe: r } if r.algo == Algo::Md5), "{:?}", graph.steps[0].fields[0].class);
        assert!(!graph.steps[0].is_page_signed());
    }

    /// A call seen once, or whose value never changes, gives a search nothing to prove a recipe by; and a value no
    /// hash of the call's parts makes is not made up. An earlier walk's sighting counts as another.
    #[test]
    fn a_query_value_seen_once_or_made_by_nothing_the_call_carries_has_no_recipe() {
        let made = |t: &str| Algo::Md5.hash(&format!("{t}&k"));
        let url = |t: &str, sign: &str| format!("https://api.shop.example/h5/find?t={t}&sign={sign}");
        let address = "https://api.shop.example/h5/find";
        let one = Trace { exchanges: vec![served(&url("111", &made("111")), "{}")], inputs: vec![] };
        assert!(searched("GET", address, "sign", &one, &[]).is_none(), "one sighting proves nothing");
        let same = Trace { exchanges: vec![served(&url("111", "abc"), "{}"), served(&url("222", "abc"), "{}")], inputs: vec![] };
        assert!(searched("GET", address, "sign", &same, &[]).is_none(), "a value that never changes is no signature");
        let random = Trace { exchanges: vec![served(&url("111", "0123456789abcdef0123456789abcdef"), "{}"), served(&url("222", "fedcba9876543210fedcba9876543210"), "{}")], inputs: vec![] };
        assert!(searched("GET", address, "sign", &random, &[]).is_none(), "nothing the call carries makes it");
        // A POST of the same path is another call.
        let both = |t: &str, q: &str| format!("https://api.shop.example/h5/find?t={t}&q={q}&sign={}", Algo::Md5.hash(&format!("{t}&{q}")));
        let mut other = served(&both("222", "teapots"), "{}");
        other.method = "POST".into();
        let held = Trace { exchanges: vec![served(&both("111", "lamps"), "{}"), other], inputs: vec![] };
        assert!(searched("GET", address, "sign", &held, &[]).is_none());
        // The earlier walk's call is read as a second sighting, and nothing made the values.
        let a = Trace { exchanges: vec![served(&url("111", "0123456789abcdef0123456789abcdef"), "{}")], inputs: vec![] };
        let b = Trace { exchanges: vec![served(&url("222", "fedcba9876543210fedcba9876543210"), "{}")], inputs: vec![] };
        assert!(searched("GET", address, "sign", &a, &[(b, vec![])]).is_none(), "two sightings were looked at, and nothing made them");
    }

    /// The stack that sent a call is read from this walk's probes first, then an earlier walk's; a probe of another
    /// call, or one that kept no stack, says nothing. A call nobody saw sent has an empty stack.
    #[test]
    fn the_stack_that_sent_a_call_is_read_from_the_walk_then_from_an_earlier_one() {
        let frame = |f: &str| crate::trace::Frame { script: "https://cdn.example/app.js".into(), line: 0, column: 1, function: f.into() };
        let call = api_call("POST", "https://shop.example/api/search", None, None);
        let on = |url: &str, stack: Vec<crate::trace::Frame>| Probe { header: String::new(), value: String::new(), url: url.into(), input: String::new(), pre: String::new(), stack };
        let now = [on("/api/search", vec![]), on("/api/other", vec![frame("other")]), on("/api/search", vec![frame("send")])];
        assert_eq!(sent_from(&call, &now, &[]), vec![frame("send")], "the probe of this call that kept a stack");
        let past = (Trace { exchanges: vec![], inputs: vec![] }, vec![on("https://shop.example/api/search?x=1", vec![frame("earlier")])]);
        assert_eq!(sent_from(&call, &now[..1], std::slice::from_ref(&past)), vec![frame("earlier")], "an earlier walk's stack stands when this one's has none");
        assert_eq!(sent_from(&call, &now, std::slice::from_ref(&past)), vec![frame("send")], "this walk first");
        assert!(sent_from(&call, &now[..2], &[]).is_empty(), "no stack for this call anywhere");
    }

    /// A clock reading a page hashed is a template, not a frozen value: thirteen digits near the clock are
    /// milliseconds, ten near it are seconds, and a long other run is random digits. Short numbers stay as written,
    /// and a value with no such run has no template.
    #[test]
    fn a_value_read_off_the_clock_is_made_a_template_and_a_plain_one_is_not() {
        let now = 1_794_198_119_000u64;
        assert_eq!(fresh_template("t-1794198118858-x", now).as_deref(), Some("t-{ms}-x"));
        assert_eq!(fresh_template("1794198118", now).as_deref(), Some("{s}"), "ten digits near the seconds");
        assert_eq!(fresh_template("v12-123456", now).as_deref(), Some("v12-{d6}"), "a short number stays, a long run is random");
        assert_eq!(fresh_template("1700000000000", now).as_deref(), Some("{d13}"), "thirteen digits far from the clock are only random");
        assert_eq!(fresh_template("a1b22c333", now), None, "short numbers are nothing to template");
        assert_eq!(fresh_template("plain", now), None);
    }

    /// A template is rendered for a call: `{ms}` and `{s}` are the clock, `{dN}` is N of the page's own random digits,
    /// and a brace that is no token is left as written.
    #[test]
    fn a_fresh_template_is_rendered_from_the_clock_and_random_digits() {
        let req = crate::replay::Request { method: "get".into(), url: "https://shop.example/api/search?q=a%20b".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let recipe = Recipe { algo: Algo::Sha1, separator: "|".into(), parts: vec![Part::Fresh { template: "{s}/{ms}/{d3}/{zz}/{d}".into() }, Part::Method, Part::Path, Part::Body] };
        let got = compute_with(&recipe, &req, Some("body"), &[], 1_794_198_119_876, |n| "7".repeat(n));
        assert_eq!(got, Some(Algo::Sha1.hash("1794198119/1794198119876/777/{zz}/{d}|GET|/api/search?q=a%20b|body")));
    }

    /// A part the call lacks (a cookie it did not send, a query key it has no value for) makes no value at all: a
    /// call's value is never made from a gap. A cookie is found by name ignoring case as a second chance.
    #[test]
    fn a_recipe_with_a_part_the_call_lacks_makes_no_value() {
        let req = crate::replay::Request { method: "GET".into(), url: "https://shop.example/api/search?q=kettle".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let jar = vec![("SID".to_string(), "abc".to_string())];
        let with = |part: Part| Recipe { algo: Algo::Md5, separator: "&".into(), parts: vec![part, Part::Query { key: "q".into() }] };
        assert_eq!(compute_with(&with(Part::Cookie { name: "sid".into() }), &req, None, &jar, 0, |_| String::new()), Some(Algo::Md5.hash("abc&kettle")), "the cookie by another case");
        assert_eq!(compute_with(&with(Part::Cookie { name: "sid".into() }), &req, None, &[], 0, |_| String::new()), None);
        assert_eq!(compute_with(&with(Part::Query { key: "nope".into() }), &req, None, &jar, 0, |_| String::new()), None);
        assert_eq!(compute_with(&with(Part::Header { name: "x-ts".into() }), &req, None, &jar, 0, |_| String::new()), None);
    }

    /// A gateway's first call, before the session holds the token its signature is over, is signed over nothing in the
    /// token's place, whole or as a piece, as the page's own code does; a token it holds is used as it is; and any
    /// other part the call lacks still makes no value.
    #[test]
    fn a_first_call_before_its_token_is_signed_over_nothing_in_its_place() {
        let req = crate::replay::Request { method: "GET".into(), url: "https://api.shop.example/h5/list?t=17&data=%7B%7D".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let piece = Part::CookiePiece { name: "_tk".into(), separator: "_".into(), index: 0 };
        let with = |part: Part| Recipe { algo: Algo::Md5, separator: "&".into(), parts: vec![part, Part::Query { key: "t".into() }, Part::Query { key: "data".into() }] };
        let none = |_: usize| String::new();
        assert_eq!(compute_with(&with(piece.clone()), &req, None, &[], 0, none), None, "the general rule holds: no value from a gap");
        assert_eq!(compute_before_token(&with(piece.clone()), &req, None, &[], 0, none), Some(Algo::Md5.hash("&17&{}")));
        assert_eq!(compute_before_token(&with(Part::Cookie { name: "_tk".into() }), &req, None, &[], 0, none), Some(Algo::Md5.hash("&17&{}")));
        let held = vec![("_tk".to_string(), "abc_999".to_string())];
        assert_eq!(compute_before_token(&with(piece.clone()), &req, None, &held, 0, none), Some(Algo::Md5.hash("abc&17&{}")), "a held token is used");
        assert_eq!(compute_before_token(&with(Part::Cookie { name: "_TK".into() }), &req, None, &held, 0, none), Some(Algo::Md5.hash("abc_999&17&{}")), "found ignoring case, not blanked");
        assert_eq!(compute_before_token(&with(Part::Query { key: "nope".into() }), &req, None, &[], 0, none), None, "only a cookie is taken as nothing");
    }

    /// What a call sends is made on the real clock and fresh random digits: a recipe of constants is the same value
    /// every time, one over `{ms}` is the hash of a reading taken during the call, and one over random digits differs
    /// from one call to the next. A recipe with a part the call lacks gives nothing.
    #[test]
    fn a_call_computes_its_value_on_the_clock_and_with_fresh_random_digits() {
        let req = crate::replay::Request { method: "POST".into(), url: "https://shop.example/api/search".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let fixed = Recipe { algo: Algo::Sha256, separator: ";".into(), parts: vec![Part::Method, Part::Constant { value: "salt".into() }] };
        assert_eq!(compute(&fixed, &req, None, &[]), Some(Algo::Sha256.hash("POST;salt")));

        let clock = Recipe { algo: Algo::Md5, separator: ";".into(), parts: vec![Part::Fresh { template: "{ms}".into() }] };
        let before = crate::fresh::now_millis();
        let got = compute(&clock, &req, None, &[]).expect("a value");
        let after = crate::fresh::now_millis();
        assert!((before..=after).any(|ms| Algo::Md5.hash(&ms.to_string()) == got), "the hash of a reading taken between {before} and {after}");

        let random = Recipe { algo: Algo::Md5, separator: ";".into(), parts: vec![Part::Fresh { template: "{d12}".into() }] };
        let (one, two) = (compute(&random, &req, None, &[]).unwrap(), compute(&random, &req, None, &[]).unwrap());
        assert_eq!(one.len(), 32);
        assert_ne!(one, two, "random digits are new every call");

        let lacking = Recipe { algo: Algo::Md5, separator: ";".into(), parts: vec![Part::Cookie { name: "sid".into() }] };
        assert_eq!(compute(&lacking, &req, None, &[]), None);
    }

    /// A page's scripts reduced with the sandbox as the judge: scripts the page's call does not need are dropped, the
    /// one that makes the call stays, and the route's script set is replaced by the reduced one.
    #[test]
    fn compaction_drops_the_scripts_the_page_does_not_need_to_make_its_call() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: compaction is skipped");
            return;
        }
        let s = |n: &str, body: &str| Script { url: format!("https://cdn.example/{n}.js"), body: body.into() };
        let boot = s("boot", "fetch('/api/search', { method: 'POST', headers: { 'x-sig': 's-1' }, body: '{}' });");
        let all = vec![s("locale", "var locale = { en: 1 };"), boot.clone(), s("tracker", "var tracker = function () { return 1; };")];
        let total: usize = all.iter().map(|x| x.body.len()).sum();
        let mut graph = Graph { steps: vec![step_with(Class::Computed, "x-sig")], scripts: all, page_html: Some("<html></html>".into()), ..Graph::default() };
        let target = graph.steps[0].clone();
        let c = compact(&mut graph, &target).expect("the page makes the call");
        assert_eq!((c.before, c.after), (3, 1));
        assert_eq!(c.before_bytes, total);
        assert_eq!(c.after_bytes, boot.body.len());
        assert_eq!(graph.scripts, vec![boot]);
    }

    /// A target address with a hole in it (`:{port}` is no port) is asked for as the walk saw it, hole removed; an
    /// address that is no address even then, and a page that makes no such call, leave the route's scripts alone.
    #[test]
    fn compaction_asks_for_a_templated_address_without_its_hole_and_keeps_all_when_nothing_is_proved() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: compaction is skipped");
            return;
        }
        let s = |n: &str, body: &str| Script { url: format!("https://cdn.example/{n}.js"), body: body.into() };
        let scripts = vec![s("boot", "fetch('/api/search', { method: 'POST', body: '{}' });"), s("locale", "var locale = 1;")];
        let mut graph = Graph { steps: vec![step_with(Class::Computed, "x-sig")], scripts: scripts.clone(), ..Graph::default() };
        let mut target = graph.steps[0].clone();
        target.url = "https://shop.example:{port}/api/search".into();
        let c = compact(&mut graph, &target).expect("the hole is dropped and the call found");
        assert_eq!((c.before, c.after), (2, 1));
        assert_eq!(graph.scripts, vec![scripts[0].clone()]);

        let mut graph = Graph { steps: vec![step_with(Class::Computed, "x-sig")], scripts: scripts.clone(), ..Graph::default() };
        target.url = "/api/{q}".into();
        assert!(compact(&mut graph, &target).is_none(), "not an address even without its hole");
        assert_eq!(graph.scripts, scripts);

        target.url = "https://shop.example/api/other".into();
        assert!(compact(&mut graph, &target).is_none(), "the page makes no such call: nothing proved, nothing dropped");
        assert_eq!(graph.scripts, scripts);

        graph.scripts.truncate(1);
        target.url = "https://shop.example/api/search".into();
        assert!(compact(&mut graph, &target).is_none(), "one script is already the whole set");
    }
}
