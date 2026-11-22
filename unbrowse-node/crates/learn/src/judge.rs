//! The judgment layer: TypeSafe Jev (System One) answers the learner's small
//! structured decisions, so passive learning needs no LLM tokens.
//!
//! The mechanical pipeline already classifies values (Constant / Derived /
//! Minted / Computed / Input) from the passive capture with zero judgment. The
//! decisions left are the ones that used to need either a caller's
//! specification or an LLM pass over a whole capture — tens of thousands of
//! tokens per judgment. Jev answers each in one small request with typed
//! output and calibrated probabilities:
//!
//! | Judgment | Primitive | Replaces |
//! |---|---|---|
//! | goal-request selection | Choice over the exchange table | the caller's target substring, or an LLM pass |
//! | exchange relevance (route or noise) | Noul fan-out, one request | heuristic filters and their misses |
//! | origin disambiguation | Choice over provenance candidates | text-marker misfires |
//! | real content or block page | Noul on the response shape | retry-vs-heal guessing |
//!
//! Confidence gates every judgment: a low-confidence answer falls back to the
//! deterministic rule (spec FR-27b: answer by rule first where a rule is
//! exact). The endpoint is configurable so a local Jev-family model (Jev, Clef,
//! Clef Flash) serves the calls when installed; the hosted endpoint otherwise.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One judgment the learner needs. Each variant carries exactly the structured
/// state Jev decides over — never a raw capture dump.
#[derive(Clone, Debug)]
pub enum Judgment<'a> {
    /// Which exchange in the table is the goal request for `goal`.
    /// Candidates are pre-filtered (same-site, API-shaped) so the Choice is
    /// over a small set, and the answer's confidence gates the fallback.
    GoalRequest {
        goal: &'a str,
        candidates: &'a [ExchangeRow],
    },
    /// Is this exchange part of the route (or noise: analytics, telemetry,
    /// consent, assets)? Answered as a Noul fan-out: one request, every
    /// exchange judged at once.
    Relevant { rows: &'a [ExchangeRow] },
    /// Which candidate origin is the real source of a value?
    Origin { value: &'a str, candidates: &'a [String] },
}

/// One exchange as the judge sees it: a compact table row, not a dump.
///
/// Names alone mislead (`data, extensions` is every GraphQL answer, `ROOT_QUERY` every Apollo page), so the row also
/// says what the node read of the answer, as facts and never as its content: how big it is, how many records its
/// longest list holds, which of the goal's own field words it holds, and whether it says back what the page was asked
/// for. None of these carries a value the site sent.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ExchangeRow {
    pub index: usize,
    pub method: String,
    pub host: String,
    pub path: String,
    pub mime: String,
    pub resource_type: String,
    pub status: u16,
    /// POST body keys or GET query keys, capped: what the request carries.
    pub carries: Vec<String>,
    /// Response top-level keys, capped: what it answers.
    pub answers: Vec<String>,
    /// The answer's shape with no value in it (`results[48].title:str`): what its records are made of.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shape: Vec<String>,
    /// The size of the answer's data, in bytes (a page's is its embedded state, not its markup).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub bytes: usize,
    /// How many records the answer's longest list holds (1 for a single object, 0 for none).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub records: usize,
    /// The goal's own field words the answer's records hold (`price`, `name`): the goal's words, never the site's values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holds: Vec<String>,
    /// The answer says back the value the page was asked for (the search, the city).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub says_back: bool,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl ExchangeRow {
    /// The row in words, for a choice's option: what it is, what it answers with, and what the node read of that.
    fn said(&self) -> String {
        let mut s = format!("#{} {} {} on {} answers with {}", self.index, self.method, self.path, self.host, self.answers.join(", "));
        if self.bytes > 0 {
            s.push_str(&format!("; {} bytes of data", self.bytes));
        }
        if self.records > 0 {
            s.push_str(&format!("; {} records", self.records));
        }
        if !self.holds.is_empty() {
            s.push_str(&format!("; its records hold {}", self.holds.join(", ")));
        }
        if self.says_back {
            s.push_str("; it says back what the page was asked for");
        }
        if !self.carries.is_empty() {
            s.push_str(&format!("; it sends {}", self.carries.join(", ")));
        }
        if !self.shape.is_empty() {
            s.push_str(&format!("; shaped {}", self.shape.join(", ")));
        }
        s
    }
}

/// The most a row says of a request's names, or of an answer's shape.
const MOST_NAMES: usize = 12;
const MOST_SHAPE: usize = 16;

/// What a call sends, by name: its query's keys and the keys its body sends, never their values. A body's list places
/// name nothing, so a key under one reads as the key alone.
pub fn carried_names(e: &crate::trace::Exchange) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for s in crate::slots::slots(e) {
        let name = match &s.loc {
            crate::slots::Loc::Query(k) | crate::slots::Loc::Form(k) => k.clone(),
            crate::slots::Loc::Json(p) => p.rsplit('/').find(|p| !p.is_empty() && !p.bytes().all(|b| b.is_ascii_digit())).unwrap_or_default().to_string(),
            _ => continue,
        };
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
        if names.len() == MOST_NAMES {
            break;
        }
    }
    names
}

/// An answer's shape as lines of `path:type`, a list's length in its brackets and its first record standing for it:
/// the longest lists first, so what the row can hold is the records. Keys only: a key that reads as data (an id, a
/// value the site keyed its map by) is left out, as is every value.
pub fn shape_of(v: &serde_json::Value) -> Vec<String> {
    use serde_json::Value;
    fn named(k: &str) -> bool {
        let digits = k.bytes().filter(u8::is_ascii_digit).count();
        !k.is_empty() && k.len() <= 32 && digits * 3 < k.len().max(1) && k.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
    }
    fn walk(v: &Value, path: String, weight: usize, depth: usize, out: &mut Vec<(usize, String)>) {
        match v {
            Value::Array(a) => {
                let path = format!("{path}[{}]", a.len());
                match a.first() {
                    Some(first) if depth < 6 => walk(first, path, weight.max(a.len()), depth + 1, out),
                    _ => out.push((weight, path)),
                }
            }
            Value::Object(o) if depth < 6 => {
                for (k, x) in o.iter().filter(|(k, _)| named(k)).take(24) {
                    walk(x, if path.is_empty() { k.clone() } else { format!("{path}.{k}") }, weight, depth + 1, out);
                }
            }
            Value::Object(_) => out.push((weight, format!("{path}:object"))),
            Value::String(_) => out.push((weight, format!("{path}:str"))),
            Value::Number(_) => out.push((weight, format!("{path}:num"))),
            Value::Bool(_) => out.push((weight, format!("{path}:bool"))),
            Value::Null => {}
        }
    }
    let mut lines = Vec::new();
    walk(v, String::new(), 0, 0, &mut lines);
    lines.sort_by_key(|l| std::cmp::Reverse(l.0));
    lines.into_iter().take(MOST_SHAPE).map(|(_, l)| l).collect()
}

/// A judge's answer: the picked candidate (or yes/no), with Jev's calibrated
/// probability and confidence.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Answer {
    pub picked: Option<usize>,
    pub yes: Option<bool>,
    pub probability: f32,
    pub confidence: f32,
}

impl Answer {
    /// The judgment is trusted when both probability and confidence clear
    /// their bars; otherwise the caller keeps its deterministic rule.
    pub fn trusted(&self, probability_bar: f32, confidence_bar: f32) -> bool {
        self.probability >= probability_bar && self.confidence >= confidence_bar
    }
}

/// Answers judgments. The trait keeps the learner testable: a [`FixedJudge`]
/// for tests, a [`TypesafeJudge`] for live calls.
pub trait Judge {
    fn ask(&self, judgment: Judgment<'_>) -> Option<Answer>;
}

/// The deterministic fallback and test double: no model, fixed answers.
pub struct FixedJudge(pub Option<Answer>);

impl Judge for FixedJudge {
    fn ask(&self, _judgment: Judgment<'_>) -> Option<Answer> {
        self.0.clone()
    }
}

/// The TypeSafe (System One / Jev) endpoint. One HTTP request per judgment
/// batch; answers are typed, so the learner never parses generated prose.
pub struct TypesafeJudge {
    /// Base URL: `https://api.typesafe.ai` hosted, or a local Jev endpoint.
    pub api_base: String,
    /// Model name: `jev-1.13`, or a local family member (Clef, Clef Flash).
    pub model: String,
    pub api_key: Option<String>,
    pub client: reqwest::blocking::Client,
    /// Confidence bars: below these, the deterministic rule decides.
    pub probability_bar: f32,
    pub confidence_bar: f32,
}

impl TypesafeJudge {
    pub fn new(api_key: &str) -> Self {
        Self {
            api_base: std::env::var("TYPESAFE_API_BASE")
                .unwrap_or_else(|_| "https://gateway.codegraff.com".into()),
            model: std::env::var("TYPESAFE_MODEL").unwrap_or_else(|_| "clef".into()),
            api_key: Some(api_key.to_string()),
            client: crate::tls::blocking().build().expect("a client"),
            probability_bar: 0.7,
            confidence_bar: 0.5,
        }
    }
}

#[derive(Serialize)]
struct SystemOneRequest {
    model: String,
    state: serde_json::Value,
    questions: serde_json::Value,
}

#[derive(Deserialize)]
struct SystemOneResult {
    answers: HashMap<String, AnswerJson>,
}

#[derive(Deserialize)]
struct AnswerJson {
    /// Never read: the answer must carry it, so one without it doesn't parse.
    #[serde(rename = "type")]
    #[allow(dead_code)]
    kind: String,
    choice: Option<String>,
    probabilities: Option<HashMap<String, serde_json::Value>>,
    confidence: Option<f64>,
    noul: Option<f64>,
}

impl TypesafeJudge {
    /// A goal request among many candidates: probabilities spread thin over a
    /// wide Choice, so confidence reads low even when the pick is right. The
    /// two-stage pattern (skill-suggestion cookbook): one Noul fan-out asks
    /// each candidate "is this plausibly the goal?", the top eight go to a
    /// tight Choice whose confidence means something.
    fn ask_goal_two_stage(&self, goal: &str, candidates: &[ExchangeRow]) -> Option<Answer> {
        // The gateway refuses very wide fan-outs (a 130+ question request
        // 503s while 50 answers fine), so the noul stage runs in chunks of
        // fifty and the scores merge: three requests cover a full capture.
        let mut scored: Vec<(usize, f64)> = Vec::new();
        for chunk in candidates.chunks(50) {
            let state = serde_json::json!({ "exchanges": chunk, "goal": goal });
            let mut qmap = serde_json::Map::new();
            for c in chunk {
                qmap.insert(
                    format!("p{}", c.index),
                    serde_json::json!({
                        "type": "noul",
                        "instructions": format!("Could exchange #{} {} {} on {} be the goal request for: {}?", c.index, c.method, c.path, c.host, goal),
                    }),
                );
            }
            let req = SystemOneRequest {
                model: self.model.clone(),
                state,
                questions: serde_json::Value::Object(qmap),
            };
            let res = self.post(&req)?;
            for (id, a) in res.answers {
                if let Ok(idx) = id.trim_start_matches('p').parse::<usize>() {
                    scored.push((idx, a.noul.unwrap_or(0.0)));
                }
            }
        }
        // Rank by p(yes), keep the top eight for the re-check.
        scored.sort_by(|x, y| y.1.total_cmp(&x.1));
        let shortlist: Vec<&ExchangeRow> = scored
            .iter()
            .take(8)
            .filter_map(|(idx, _)| candidates.iter().find(|c| c.index == *idx))
            .collect();
        if shortlist.is_empty() {
            return None;
        }
        let criteria: serde_json::Map<String, serde_json::Value> = shortlist.iter().map(|c| (c.index.to_string(), serde_json::json!(c.said()))).collect();
        let req = SystemOneRequest {
            model: self.model.clone(),
            state: serde_json::json!({ "exchanges": shortlist, "goal": goal }),
            questions: serde_json::Value::Object(serde_json::Map::from_iter([(
                "goal".to_string(),
                serde_json::json!({
                    "type": "choice",
                    "instructions": format!("Which exchange is the goal request for: {goal}?"),
                    "criteria": criteria,
                }),
            )])),
        };
        let res = self.post(&req)?;
        let a = res.answers.get("goal")?;
        let picked = a.choice.as_ref()?;
        let picked_idx = picked.parse::<usize>().ok()?;
        // Only an exchange on the shortlist is an answer.
        if !shortlist.iter().any(|c| c.index == picked_idx) {
            return None;
        }
        // Duplicate sightings of the same route split the Choice's probability
        // mass (the same endpoint walked three times scores 0.34+0.29+0.16).
        // What "trusted" means is the mass on the picked route: sum every
        // shortlist entry that shares its method and path.
        let picked_route = shortlist
            .iter()
            .find(|c| c.index == picked_idx)
            .map(|c| (c.method.clone(), c.path.clone()));
        // The Choice's per-run probabilities jitter (the same route scored
        // 0.73 one run, 0.48 the next); the fan-out's per-exchange nouls are
        // the stable signal (the goal route's sightings score 0.8-0.95 every
        // run). Trust rides on the fan-out: the picked route's mean noul is
        // the probability, and its margin over the best other route's mean is
        // the confidence. The Choice's own answer stays as the argmax pick.
        let fanout: std::collections::HashMap<usize, f64> = scored.iter().cloned().collect();
        let route_mean = |route: &(String, String)| -> f64 {
            let hits: Vec<f64> = shortlist
                .iter()
                .filter(|c| &(c.method.clone(), c.path.clone()) == route)
                .filter_map(|c| fanout.get(&c.index).copied())
                .collect();
            if hits.is_empty() { 0.0 } else { hits.iter().sum::<f64>() / hits.len() as f64 }
        };
        let picked_mean = picked_route.as_ref().map(route_mean).unwrap_or(0.0) as f32;
        let best_other = shortlist
            .iter()
            .map(|c| (c.method.clone(), c.path.clone()))
            .filter(|r| picked_route.as_ref() != Some(r))
            .map(|r| route_mean(&r))
            .fold(0.0_f64, f64::max) as f32;
        Some(Answer {
            picked: Some(picked_idx),
            yes: None,
            probability: picked_mean,
            confidence: picked_mean - best_other,
        })
    }
}

thread_local! {
    /// How many requests this thread has sent to a model: what a call is measured against (`learn.proposer`: no call
    /// asks a model). A judge's requests are blocking, so they are counted on the thread that asked.
    static REQUESTS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The requests this thread has sent to a model so far. The difference across a piece of work is what it asked.
pub fn requests_made() -> u64 {
    REQUESTS.with(|n| n.get())
}

impl TypesafeJudge {
    /// One request to the endpoint, and its answers. An answer that can't be read (the endpoint refused, or answered
    /// in another shape: an answer without its `type`) is no answer, and the rule decides; the node's log says why, so
    /// an endpoint that answers in another shape is found from the log, not from the source.
    fn post(&self, req: &SystemOneRequest) -> Option<SystemOneResult> {
        let mut builder = self.client.post(format!("{}/v1/systemone", self.api_base)).json(req);
        if let Some(key) = &self.api_key {
            builder = builder.bearer_auth(key);
        }
        let said = |why: String| eprintln!("judge: the decision model's answer was no answer, so the rule decides: {why}");
        REQUESTS.with(|n| n.set(n.get() + 1));
        let res = match builder.send().and_then(|r| r.error_for_status()) {
            Ok(r) => r,
            Err(e) => {
                said(e.to_string());
                return None;
            }
        };
        let text = match res.text() {
            Ok(t) => t,
            Err(e) => {
                said(e.to_string());
                return None;
            }
        };
        match serde_json::from_str::<SystemOneResult>(&text) {
            Ok(r) => Some(r),
            Err(e) => {
                said(format!("{e} (each answer is {{type, choice, probabilities, confidence, noul}})"));
                None
            }
        }
    }

    /// Which pieces of a walked URL are the caller's values (a search term in the path, an id) and which are the
    /// site's fixed route: one noul fan-out, a probability per piece. A string the caller would change to get a
    /// different answer for `goal` becomes an input; the rest stays constant.
    pub fn ask_inputs(&self, goal: &str, url: &str, pieces: &[String]) -> Option<Vec<f64>> {
        // No piece, no question.
        if pieces.is_empty() {
            return None;
        }
        // The pieces are the path's, and they are what is asked about; the query's values are not, and stay here.
        let url = names_only(url);
        let url = url.as_str();
        let mut qmap = serde_json::Map::new();
        for (i, p) in pieces.iter().enumerate() {
            qmap.insert(
                format!("p{i}"),
                serde_json::json!({
                    "type": "noul",
                    "instructions": format!("In the URL {url}, is the piece \"{p}\" a value the caller would change to get a different answer for: {goal}? (A search term, a name or an id is; the site's own words for its pages are not.)"),
                }),
            );
        }
        let req = SystemOneRequest {
            model: self.model.clone(),
            state: serde_json::json!({ "goal": goal, "url": url, "pieces": pieces }),
            questions: serde_json::Value::Object(qmap),
        };
        let res = self.post(&req)?;
        Some((0..pieces.len()).map(|i| res.answers.get(&format!("p{i}")).and_then(|a| a.noul).unwrap_or(0.0)).collect())
    }
}

/// A path or URL as the model may see it: its query's names, never their values. The values a page's calls send are
/// the session's (ids, signatures, tokens the site issued); the names say what the call carries, which is all a
/// judgment needs.
pub fn names_only(path: &str) -> String {
    let Some((head, query)) = path.split_once('?') else { return path.to_string() };
    let (query, _) = query.split_once('#').unwrap_or((query, ""));
    let names: Vec<String> = url::form_urlencoded::parse(query.as_bytes()).map(|(k, _)| k.into_owned()).collect();
    if names.is_empty() {
        return head.to_string();
    }
    format!("{head}?{}", names.join("&"))
}

/// The rows as the model sees them: each path with its query's names only.
fn without_values(rows: &[ExchangeRow]) -> Vec<ExchangeRow> {
    rows.iter().map(|r| ExchangeRow { path: names_only(&r.path), ..r.clone() }).collect()
}

impl Judge for TypesafeJudge {
    fn ask(&self, judgment: Judgment<'_>) -> Option<Answer> {
        // Nothing to choose from or judge is no question: it isn't sent.
        match &judgment {
            Judgment::GoalRequest { candidates: rows, .. } | Judgment::Relevant { rows } if rows.is_empty() => return None,
            Judgment::Origin { candidates: [], .. } => return None,
            _ => {}
        }
        // Nothing the walk's calls sent goes to the model but the names of what they carry.
        let clean: Vec<ExchangeRow>;
        let judgment = match judgment {
            Judgment::GoalRequest { goal, candidates } => {
                clean = without_values(candidates);
                Judgment::GoalRequest { goal, candidates: &clean }
            }
            Judgment::Relevant { rows } => {
                clean = without_values(rows);
                Judgment::Relevant { rows: &clean }
            }
            other => other,
        };
        // The Codegraff System One dialect: questions are a map keyed by id,
        // each {type, instructions, criteria}; the answer's `choice` names the
        // criteria key and `probabilities` carries one per option.
        if let Judgment::GoalRequest { goal, candidates } = &judgment {
            if candidates.len() > 12 {
                return self.ask_goal_two_stage(goal, candidates);
            }
        }
        let (state, questions) = match judgment {
            Judgment::GoalRequest { goal, candidates } => {
                let state = serde_json::json!({ "exchanges": candidates });
                let criteria: serde_json::Map<String, serde_json::Value> = candidates.iter().map(|c| (c.index.to_string(), serde_json::json!(c.said()))).collect();
                (
                    state,
                    vec![("goal".to_string(), serde_json::json!({
                        "type": "choice",
                        "instructions": format!("Which exchange is the goal request for: {goal}?"),
                        "criteria": criteria,
                    }))],
                )
            }
            Judgment::Relevant { rows } => {
                let state = serde_json::json!({ "exchanges": rows });
                let qs: Vec<(String, serde_json::Value)> = rows
                    .iter()
                    .map(|r| {
                        (
                            format!("rel-{}", r.index),
                            serde_json::json!({
                                "type": "noul",
                                "instructions": format!("Is exchange #{} {} {} part of the website's own route (not analytics, telemetry, consent, or an asset)?", r.index, r.method, r.path),
                            }),
                        )
                    })
                    .collect();
                (state, qs)
            }
            Judgment::Origin { value, candidates } => (
                serde_json::json!({ "value": value, "candidates": candidates }),
                vec![("origin".to_string(), serde_json::json!({
                    "type": "choice",
                    "instructions": "Which candidate response really produced this value?",
                    "criteria": candidates.iter().enumerate().map(|(i, c)| (i.to_string(), serde_json::json!(c))).collect::<serde_json::Map<String, serde_json::Value>>(),
                }))],
            ),
        };
        let offered: Vec<String> = questions
            .iter()
            .filter_map(|(_, q)| q.get("criteria").and_then(|c| c.as_object()))
            .flat_map(|c| c.keys().cloned())
            .collect();
        let mut qmap = serde_json::Map::new();
        for (id, q) in questions {
            qmap.insert(id, q);
        }
        let req = SystemOneRequest {
            model: self.model.clone(),
            state,
            questions: serde_json::Value::Object(qmap),
        };
        let res = self.post(&req)?;
        let (kind, a) = match judgment {
            Judgment::GoalRequest { .. } | Judgment::Origin { .. } => ("choice", res.answers.get("goal").or_else(|| res.answers.get("origin"))?),
            _ => ("noul", res.answers.values().next()?),
        };
        if kind == "choice" {
            let picked = a.choice.as_ref()?;
            // The answer names one of the options offered, or it is no answer: a choice outside them picks nothing.
            if !offered.contains(picked) {
                return None;
            }
            let probability = a
                .probabilities
                .as_ref()
                .and_then(|p| p.get(picked).and_then(|v| v.as_f64()))
                .unwrap_or(0.0) as f32;
            Some(Answer {
                picked: picked.parse::<usize>().ok(),
                yes: None,
                probability,
                confidence: a.confidence.unwrap_or(0.0) as f32,
            })
        } else {
            let p_yes = a.noul.unwrap_or(0.0) as f32;
            Some(Answer {
                picked: None,
                yes: Some(p_yes > 0.5),
                probability: p_yes,
                confidence: (p_yes - 0.5).abs() * 2.0,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The model reads an answer's shape and a request's names, never a value: the longest list first, its first record
    /// standing for it, and a key that reads as data (an id the site keyed its map by) left out.
    #[test]
    fn a_row_says_shape_and_names_never_values() {
        let v = serde_json::json!({"results": [{"title": "Tokyo hotel", "price": 120}, {"title": "b", "price": 9}], "ok": true, "a1b2c3d4e5": {"x": 1}});
        let shape = shape_of(&v);
        assert_eq!(shape[0], "results[2].title:str", "{shape:?}");
        assert!(shape.contains(&"results[2].price:num".to_string()), "{shape:?}");
        assert!(!shape.iter().any(|l| l.contains("Tokyo") || l.contains("a1b2c3d4e5")), "{shape:?}");
        let mut e = crate::trace::Exchange {
            method: "POST".into(),
            url: url::Url::parse("https://stay.example/graphql?lang=en").unwrap(),
            request_headers: vec![("content-type".into(), "application/json".into())],
            request_body: Some(r#"{"variables":{"input":{"dest":"Tokyo","rooms":[{"adults":2}]}}}"#.into()),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let names = carried_names(&e);
        for n in ["lang", "dest", "adults"] {
            assert!(names.contains(&n.to_string()), "{names:?}");
        }
        assert!(!names.iter().any(|n| n.contains("Tokyo")), "{names:?}");
        e.request_body = None;
        assert_eq!(carried_names(&e), vec!["lang".to_string()]);
    }

    fn rows() -> Vec<ExchangeRow> {
        vec![
            ExchangeRow {
                index: 0,
                method: "GET".into(),
                host: "shop.example".into(),
                path: "/app".into(),
                mime: "text/html".into(),
                resource_type: "Document".into(),
                status: 200,
                carries: vec![],
                answers: vec!["csrf".into()],
                ..Default::default()
            },
            ExchangeRow {
                index: 1,
                method: "POST".into(),
                host: "shop.example".into(),
                path: "/api/p/list".into(),
                mime: "application/json".into(),
                resource_type: "XHR".into(),
                status: 200,
                carries: vec!["query".into()],
                answers: vec!["items".into()],
                ..Default::default()
            },
        ]
    }

    #[test]
    fn fixed_judge_passes_through() {
        let j = FixedJudge(Some(Answer { picked: Some(1), yes: None, probability: 0.9, confidence: 0.8 }));
        let a = j.ask(Judgment::GoalRequest { goal: "list products", candidates: &rows() }).unwrap();
        assert_eq!(a.picked, Some(1));
        assert!(a.trusted(0.7, 0.5));
    }

    #[test]
    fn low_confidence_is_not_trusted() {
        let j = FixedJudge(Some(Answer { picked: Some(0), yes: None, probability: 0.6, confidence: 0.4 }));
        let a = j.ask(Judgment::GoalRequest { goal: "list products", candidates: &rows() }).unwrap();
        assert!(!a.trusted(0.7, 0.5), "below the bars the deterministic rule decides");
    }

    /// The model sees what a call carries by name, never the values the page sent.
    #[test]
    fn a_query_reaches_the_model_by_its_names_only() {
        assert_eq!(names_only("/api/items?q=dummy&sig=DUMMYSIG123"), "/api/items?q&sig");
        assert_eq!(names_only("https://shop.example/search?q=lamp#top"), "https://shop.example/search?q");
        assert_eq!(names_only("/api/items"), "/api/items");
        let rows = without_values(&[ExchangeRow { path: "/api/p/list?token=SECRET123".into(), ..rows()[1].clone() }]);
        assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET123"));
    }

    /// A model answer naming an option it was not offered is no answer. A loopback stands in for the gateway.
    #[test]
    fn a_choice_outside_the_offered_options_picks_nothing() {
        use std::io::{Read, Write};
        let serve = |body: &'static str| {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let at = l.local_addr().unwrap();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let mut buf = vec![0u8; 65536];
                    let _ = s.read(&mut buf);
                    let _ = write!(s, "HTTP/1.1 200 OK
content-type: application/json
content-length: {}
connection: close

{body}", body.len());
                }
            });
            at
        };
        let judge = |at: std::net::SocketAddr| TypesafeJudge {
            api_base: format!("http://{at}"),
            model: "test".into(),
            api_key: None,
            client: crate::tls::blocking().build().unwrap(),
            probability_bar: 0.7,
            confidence_bar: 0.5,
        };
        let outside = serve(r#"{"answers":{"goal":{"type":"choice","choice":"9999","probabilities":{"9999":0.99},"confidence":0.99}}}"#);
        assert!(judge(outside).ask(Judgment::GoalRequest { goal: "list products", candidates: &rows() }).is_none());
        let offered = serve(r#"{"answers":{"goal":{"type":"choice","choice":"1","probabilities":{"1":0.9},"confidence":0.8}}}"#);
        let a = judge(offered).ask(Judgment::GoalRequest { goal: "list products", candidates: &rows() }).unwrap();
        assert_eq!(a.picked, Some(1));
    }

    /// A loopback gateway that answers each request with `body`, counting the requests it was sent.
    fn gateway(body: &'static str) -> (TypesafeJudge, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap();
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = asked.clone();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = vec![0u8; 65536];
                let _ = s.read(&mut buf);
                let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let judge = TypesafeJudge {
            api_base: format!("http://{at}"),
            model: "test".into(),
            api_key: None,
            client: crate::tls::blocking().build().unwrap(),
            probability_bar: 0.7,
            confidence_bar: 0.5,
        };
        (judge, asked)
    }

    /// Nothing to choose from, or no piece to judge, is no question: nothing is sent to the model.
    #[test]
    fn an_empty_question_is_never_sent() {
        let (judge, asked) = gateway(r#"{"answers":{}}"#);
        assert!(judge.ask(Judgment::GoalRequest { goal: "search stays", candidates: &[] }).is_none());
        assert!(judge.ask(Judgment::Relevant { rows: &[] }).is_none());
        assert!(judge.ask(Judgment::Origin { value: "x", candidates: &[] }).is_none());
        assert!(judge.ask_inputs("search stays", "https://stay.example/s/homes", &[]).is_none());
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// An answer in another shape (one without its `type`) is no answer: the rule decides, as with no model at all.
    #[test]
    fn an_answer_without_its_type_is_no_answer() {
        let (judge, asked) = gateway(r#"{"answers":{"goal":{"choice":"1","probabilities":{"1":0.9},"confidence":0.9}}}"#);
        assert!(judge.ask(Judgment::GoalRequest { goal: "list products", candidates: &rows() }).is_none());
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Names alone can't tell two `data, extensions` answers apart: the model is told what the node read of each, as
    /// facts (its size, its records, the goal's words they hold, whether it says back what was asked), never a value.
    #[test]
    fn the_model_is_told_what_each_answer_holds_never_its_values() {
        let hotels = ExchangeRow { index: 7, answers: vec!["data".into(), "extensions".into()], bytes: 48_000, records: 25, holds: vec!["price".into(), "name".into()], says_back: true, ..rows()[1].clone() };
        let menu = ExchangeRow { index: 8, answers: vec!["data".into(), "extensions".into()], bytes: 900, ..rows()[1].clone() };
        let said = hotels.said();
        assert!(said.contains("25 records") && said.contains("price, name") && said.contains("says back"), "{said}");
        assert!(!menu.said().contains("records") && !menu.said().contains("says back"), "{}", menu.said());
        let sent = serde_json::to_string(&without_values(&[hotels, menu])).unwrap();
        assert!(sent.contains("\"records\":25") && !sent.contains("\"says_back\":false"), "{sent}");
    }

    #[test]
    fn no_judge_is_none() {
        let j = FixedJudge(None);
        assert!(j.ask(Judgment::Relevant { rows: &rows() }).is_none());
    }

    /// A loopback gateway that answers each request with `status` and `body`, keeping every request body it was sent.
    fn heard_gateway(status: u16, body: String) -> (TypesafeJudge, std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        answering_gateway(status, move |_| body.clone())
    }

    /// The same, answering each request as `answer` reads it: a gateway answers the questions it was asked.
    fn answering_gateway(status: u16, answer: impl Fn(&serde_json::Value) -> String + Send + 'static) -> (TypesafeJudge, std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap();
        let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let keep = heard.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut sent = vec![0u8; length];
                let _ = r.read_exact(&mut sent);
                let sent: serde_json::Value = serde_json::from_slice(&sent).unwrap_or_default();
                let body = answer(&sent);
                keep.lock().unwrap().push(sent);
                let mut s = s;
                let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let judge = TypesafeJudge {
            api_base: format!("http://{at}"),
            model: "test".into(),
            api_key: Some("dummy-key".into()),
            client: crate::tls::blocking().build().unwrap(),
            probability_bar: 0.7,
            confidence_bar: 0.5,
        };
        (judge, heard)
    }

    /// Sixty candidates, the same search route seen at #5 and #17 among fifty-eight other calls.
    fn wide() -> Vec<ExchangeRow> {
        (0..60)
            .map(|i| {
                let path = if i == 5 || i == 17 { "/api/search?q=lamp-SECRET".to_string() } else { format!("/api/other{i}?t=SECRET{i}") };
                ExchangeRow { index: i, path, ..rows()[1].clone() }
            })
            .collect()
    }

    /// A goal question over more than twelve calls is asked in two stages: a fan-out per call in requests of at most
    /// fifty, then a choice over the eight that scored highest. The answer is trusted by the fan-out: the picked
    /// route's mean score is its probability, and its lead over the best other route its confidence.
    #[test]
    fn a_wide_goal_question_is_asked_in_two_stages_and_trusted_by_its_fanout() {
        let (judge, heard) = answering_gateway(200, |asked| {
            let mut answers = serde_json::Map::new();
            for id in asked["questions"].as_object().map(|q| q.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
                let answer = match id.as_str() {
                    "goal" => serde_json::json!({"type": "choice", "choice": "17", "probabilities": {"17": 0.4}, "confidence": 0.2}),
                    "p5" => serde_json::json!({"type": "noul", "noul": 0.9}),
                    "p17" => serde_json::json!({"type": "noul", "noul": 0.8}),
                    "p3" => serde_json::json!({"type": "noul", "noul": 0.3}),
                    _ => serde_json::json!({"type": "noul", "noul": 0.1}),
                };
                answers.insert(id, answer);
            }
            serde_json::json!({ "answers": answers }).to_string()
        });
        let before = requests_made();
        let a = judge.ask(Judgment::GoalRequest { goal: "search lamps", candidates: &wide() }).expect("an answer");
        assert_eq!(a.picked, Some(17));
        assert!((a.probability - 0.85).abs() < 1e-4, "the route's mean fan-out score: {}", a.probability);
        assert!((a.confidence - 0.55).abs() < 1e-4, "its lead over the next route: {}", a.confidence);
        assert!(a.trusted(judge.probability_bar, judge.confidence_bar));
        assert_eq!(requests_made() - before, 3, "fifty, ten, then the choice");
        let heard = heard.lock().unwrap();
        let questions: Vec<usize> = heard.iter().map(|r| r["questions"].as_object().map_or(0, |q| q.len())).collect();
        assert_eq!(questions, vec![50, 10, 1]);
        assert_eq!(heard[2]["questions"]["goal"]["criteria"].as_object().unwrap().len(), 8, "the eight best go to the choice");
        let sent = serde_json::to_string(&*heard).unwrap();
        assert!(!sent.contains("SECRET"), "no value a call sent reaches the model");
    }

    /// The choice may only name a call the fan-out put on the shortlist; and with no scores at all there is no
    /// shortlist and no choice is asked.
    #[test]
    fn a_wide_goal_answer_off_the_shortlist_or_unscored_is_no_answer() {
        let mut answers = serde_json::Map::new();
        for i in 0..60 {
            answers.insert(format!("p{i}"), serde_json::json!({"type": "noul", "noul": if i < 8 { 0.9 } else { 0.1 }}));
        }
        answers.insert("goal".into(), serde_json::json!({"type": "choice", "choice": "42"}));
        let (judge, _) = heard_gateway(200, serde_json::json!({ "answers": answers }).to_string());
        assert!(judge.ask(Judgment::GoalRequest { goal: "search lamps", candidates: &wide() }).is_none(), "#42 was not shortlisted");
        let (judge, heard) = heard_gateway(200, r#"{"answers":{}}"#.to_string());
        assert!(judge.ask(Judgment::GoalRequest { goal: "search lamps", candidates: &wide() }).is_none());
        assert_eq!(heard.lock().unwrap().len(), 2, "two fan-out requests, no choice");
    }

    /// Whether a call is part of the route is a yes or no read from one score: over a half is yes, and how far it
    /// stands from a half is how sure it is.
    #[test]
    fn a_relevance_score_is_a_yes_or_no_and_how_sure() {
        let (judge, heard) = heard_gateway(200, r#"{"answers":{"rel-1":{"type":"noul","noul":0.8}}}"#.to_string());
        let a = judge.ask(Judgment::Relevant { rows: &rows() }).unwrap();
        assert_eq!((a.picked, a.yes), (None, Some(true)));
        assert!((a.probability - 0.8).abs() < 1e-6 && (a.confidence - 0.6).abs() < 1e-6, "{a:?}");
        let sent = &heard.lock().unwrap()[0];
        assert_eq!(sent["questions"].as_object().unwrap().len(), 2, "one question per call");
        assert_eq!(sent["questions"]["rel-1"]["type"], "noul");
        let (judge, _) = heard_gateway(200, r#"{"answers":{"rel-0":{"type":"noul","noul":0.2}}}"#.to_string());
        let a = judge.ask(Judgment::Relevant { rows: &rows() }).unwrap();
        assert_eq!(a.yes, Some(false));
        assert!((a.confidence - 0.6).abs() < 1e-6);
    }

    /// Which earlier answer made a value is a choice among the candidates offered, by their place in the list.
    #[test]
    fn an_origin_is_chosen_among_the_candidates_offered() {
        let candidates = ["GET /api/session -> token".to_string(), "GET /app -> csrf".to_string()];
        let (judge, heard) = heard_gateway(200, r#"{"answers":{"origin":{"type":"choice","choice":"1","probabilities":{"0":0.1,"1":0.85},"confidence":0.7}}}"#.to_string());
        let a = judge.ask(Judgment::Origin { value: "tok", candidates: &candidates }).unwrap();
        assert_eq!(a.picked, Some(1));
        assert!((a.probability - 0.85).abs() < 1e-6 && (a.confidence - 0.7).abs() < 1e-6, "{a:?}");
        let sent = &heard.lock().unwrap()[0];
        assert_eq!(sent["questions"]["origin"]["criteria"]["0"], candidates[0]);
        assert_eq!(sent["model"], "test");
    }

    /// Each piece of a walked address gets its own score; the address reaches the model with its query's names, not
    /// their values; a piece the model left unscored reads as the site's own (0).
    #[test]
    fn each_piece_of_an_address_is_scored_and_its_query_values_stay_here() {
        let (judge, heard) = heard_gateway(200, r#"{"answers":{"p0":{"type":"noul","noul":0.05},"p1":{"type":"noul","noul":0.92}}}"#.to_string());
        let pieces = ["s".to_string(), "tokyo".to_string(), "homes".to_string()];
        let scores = judge.ask_inputs("stays in tokyo", "https://stay.example/s/tokyo/homes?checkin=2026-12-01&adults=2", &pieces).unwrap();
        assert_eq!(scores, vec![0.05, 0.92, 0.0]);
        let sent = &heard.lock().unwrap()[0];
        assert_eq!(sent["state"]["url"], "https://stay.example/s/tokyo/homes?checkin&adults");
        assert!(!sent.to_string().contains("2026-12-01"));
    }

    /// An endpoint that refuses, or answers with no answers to read, gives no answer: the rule decides.
    #[test]
    fn a_refusing_or_unreadable_endpoint_gives_no_answer() {
        let (judge, heard) = heard_gateway(503, r#"{"error":"busy"}"#.to_string());
        assert!(judge.ask(Judgment::Relevant { rows: &rows() }).is_none());
        assert!(judge.ask_inputs("x", "https://shop.example/a", &["a".to_string()]).is_none());
        assert_eq!(heard.lock().unwrap().len(), 2, "each was asked once");
        let (judge, _) = heard_gateway(200, "not json".to_string());
        assert!(judge.ask(Judgment::Origin { value: "v", candidates: &["a".to_string()] }).is_none());
        let (judge, _) = heard_gateway(200, r#"{"answers":{"goal":{"type":"choice"}}}"#.to_string());
        assert!(judge.ask(Judgment::GoalRequest { goal: "list products", candidates: &rows() }).is_none(), "a choice that names nothing");
    }
}
