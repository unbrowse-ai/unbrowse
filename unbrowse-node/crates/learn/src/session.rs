//! A passively captured browsing session: the log the browser sidecar writes while the agent
//! browses, with "Map while browsing" on. One JSON object per line, either an agent action or
//! a finished request (a HAR 1.2 entry).

use serde::Deserialize;
use serde_json::Value;

use crate::trace::{Exchange, HarEntry, Input, Trace, TraceError};

/// Something the agent did to the page.
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    /// Seconds since the Unix epoch.
    pub t: f64,
    /// `navigate`, `click`, `fill`, `type`, `press`, `select`, ...
    pub kind: String,
    pub selector: Option<String>,
    /// The field's own identity (its name, id, aria-label, label or placeholder),
    /// as the sidecar read it from the page. Preferred over `selector` for naming
    /// an input: routes say "Search Wikipedia", not "#e29".
    pub field: Option<String>,
    /// A selector the browser found unique for the element when the step was taken: unlike `selector`, which names a
    /// snapshot's ref, it can find the element again on a later visit. None when nothing about it holds.
    pub locator: Option<String>,
    /// What was typed, selected, pressed or navigated to.
    pub value: Option<String>,
    /// Typed into a password or one-time-code field.
    pub secret: bool,
}

/// The requests one action set off, until the next action.
#[derive(Clone, Debug)]
pub struct Segment {
    pub action: Action,
    /// Indexes into the session's trace.
    pub exchanges: Vec<usize>,
}

/// Something a page's socket did: opened (with its address), shook hands (with its headers), sent or received a
/// frame, or closed.
#[derive(Clone, Debug, PartialEq)]
pub struct SocketEvent {
    pub t: f64,
    /// The socket, as Chrome names it.
    pub id: String,
    /// `open`, `handshake`, `accepted`, `sent`, `received` or `closed`.
    pub kind: String,
    pub url: Option<String>,
    pub headers: Vec<(String, String)>,
    /// 1 for text, 2 for binary (base64).
    pub opcode: u64,
    pub data: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub actions: Vec<Action>,
    /// What the page's sockets did, in order.
    pub sockets: Vec<SocketEvent>,
    /// Requests in the order they started.
    pub trace: Trace,
    /// What the page's own code built when it signed, if the walk probed it (`UNBROWSE_SIGN_PROBE=1`): a recipe is
    /// fitted from it at learn time.
    pub probes: Vec<crate::trace::Probe>,
    /// Start time of each request in `trace`, and its CDP resource type.
    times: Vec<f64>,
    resource_types: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Line {
    Action { t: f64, action: String, selector: Option<String>, #[serde(default)] field: Option<String>, #[serde(default)] locator: Option<String>, value: Option<Value>, #[serde(default)] secret: bool },
    Exchange { t: f64, #[serde(rename = "resourceType", default)] resource_type: String, entry: HarEntry },
    SignProbe {
        #[serde(default)]
        probes: Vec<Vec<String>>,
    },
    /// A script the page parsed, and an origin's storage at a moment of the walk (`learn.record`): read by the
    /// recording ([`crate::recording::Recording`]), not by the session's trace.
    Script {},
    OriginStorage {},
    Socket {
        t: f64,
        id: String,
        event: String,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        headers: Option<serde_json::Map<String, Value>>,
        #[serde(default)]
        opcode: Option<u64>,
        #[serde(default)]
        data: Option<String>,
    },
}

impl Action {
    /// Whether the step gives the page a value of the caller's: text typed or an option selected, or a choice made by
    /// a click that the capture logged with the name and the value its form sends (a radio, a box). The one reading
    /// of it: a session's inputs and every part of the learner that asks what the agent supplied read it here, so a
    /// kind of step one of them counts is one all of them count.
    pub fn gives_a_value(&self) -> bool {
        match self.kind.as_str() {
            "fill" | "type" | "select" => true,
            // A choice has a name and something to send; a click logged with neither, or with an empty value, is a step.
            "click" | "check" => self.field.as_deref().is_some_and(|f| !f.is_empty()) && self.value.as_deref().is_some_and(|v| !v.is_empty()),
            _ => false,
        }
    }
}

impl Session {
    pub fn from_log(log: &str) -> Result<Self, TraceError> {
        let mut actions = Vec::new();
        let mut sockets = Vec::new();
        let mut exchanges: Vec<(f64, String, Exchange)> = Vec::new();
        let mut probes: Vec<crate::trace::Probe> = Vec::new();
        for line in log.lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str::<Line>(line)? {
                Line::Action { t, action, selector, field, locator, value, secret } => {
                    let value = value.and_then(|v| match v {
                        Value::String(s) => Some(s),
                        Value::Null => None,
                        Value::Array(items) => Some(items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")),
                        other => Some(other.to_string()),
                    });
                    actions.push(Action { t, kind: action, selector, field, locator, value, secret });
                }
                Line::Exchange { t, resource_type, entry } => {
                    if let Some(ex) = entry.into_exchange() {
                        exchanges.push((t, resource_type, ex));
                    }
                }
                Line::Script {} | Line::OriginStorage {} => {}
                Line::SignProbe { probes: said } => {
                    for p in said {
                        let at = |n: usize| p.get(n).cloned().unwrap_or_default();
                        let probe = crate::trace::Probe { header: at(0), value: at(1), url: at(2), input: at(3), pre: at(4), stack: Vec::new() };
                        if !probe.header.is_empty() && !probe.value.is_empty() && !probe.input.is_empty() {
                            probes.push(probe);
                        }
                    }
                }
                Line::Socket { t, id, event, url, headers, opcode, data } => {
                    let headers = headers
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(k, v)| (k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string())))
                        .collect();
                    sockets.push(SocketEvent { t, id, kind: event, url, headers, opcode: opcode.unwrap_or(1), data });
                }
            }
        }
        actions.sort_by(|a, b| a.t.total_cmp(&b.t));
        sockets.sort_by(|a: &SocketEvent, b: &SocketEvent| a.t.total_cmp(&b.t));
        exchanges.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut inputs: Vec<Input> = Vec::new();
        for a in &actions {
            match a.kind.as_str() {
                // What the agent typed or chose (`Action::gives_a_value`): a field the caller supplies, named after
                // the field itself when the sidecar could read it, else its selector. A click on anything but a
                // choice carries no value, and is a step.
                _ if a.gives_a_value() => {
                    if let Some(value) = a.value.clone() {
                        let name = a.field.clone().or_else(|| a.selector.clone());
                        if let Some(name) = name {
                            push_input(&mut inputs, Input { name, value, secret: a.secret });
                        }
                    }
                }
                // Where the agent navigated: the URL is the agent's own choice, so every
                // path segment and query value is a parameter, named like the template
                // slot it fills (`path[2]`, `adults`). Structural segments it repeats
                // across sightings stay constants when the two traces align.
                "navigate" => {
                    let Some(url) = a.value.as_deref() else { continue };
                    let Ok(u) = url::Url::parse(url) else { continue };
                    for (i, seg) in u.path_segments().into_iter().flatten().enumerate() {
                        if !seg.is_empty() {
                            push_input(&mut inputs, Input {
                                name: format!("path[{i}]"),
                                value: seg.to_string(),
                                secret: false,
                            });
                        }
                    }
                    for (k, v) in u.query_pairs() {
                        push_input(&mut inputs, Input {
                            name: k.to_string(),
                            value: v.to_string(),
                            secret: false,
                        });
                    }
                }
                _ => {}
            }
        }
        let times = exchanges.iter().map(|e| e.0).collect();
        let resource_types = exchanges.iter().map(|e| e.1.clone()).collect();
        let trace = Trace { exchanges: exchanges.into_iter().map(|e| e.2).collect(), inputs };
        Ok(Self { actions, sockets, trace, probes, times, resource_types })
    }

    /// When request `i` of the trace started, in seconds since the Unix epoch.
    pub fn time_of(&self, i: usize) -> f64 {
        self.times.get(i).copied().unwrap_or(0.0)
    }

    /// This session with only what happened at the times `keep` says: one browser serves several browsing sessions of a
    /// site and keeps one log, so what each did can only be told apart by when.
    pub fn only(&self, keep: impl Fn(f64) -> bool) -> Session {
        let kept: Vec<usize> = (0..self.trace.exchanges.len()).filter(|&i| keep(self.time_of(i))).collect();
        Session {
            actions: self.actions.iter().filter(|a| keep(a.t)).cloned().collect(),
            sockets: self.sockets.iter().filter(|e| keep(e.t)).cloned().collect(),
            trace: Trace { exchanges: kept.iter().map(|&i| self.trace.exchanges[i].clone()).collect(), inputs: self.trace.inputs.clone() },
            probes: self.probes.clone(),
            times: kept.iter().map(|&i| self.times[i]).collect(),
            resource_types: kept.iter().map(|&i| self.resource_types[i].clone()).collect(),
        }
    }

    /// Each action with the requests that started after it and before the next action.
    pub fn segments(&self) -> Vec<Segment> {
        let mut segments: Vec<Segment> =
            self.actions.iter().map(|a| Segment { action: a.clone(), exchanges: Vec::new() }).collect();
        for (i, t) in self.times.iter().enumerate() {
            if let Some(owner) = self.actions.iter().rposition(|a| a.t <= *t) {
                segments[owner].exchanges.push(i);
            }
        }
        segments
    }

    /// Requests that are candidate routes: API calls (fetch or XHR) the page made in response
    /// to an action.
    pub fn candidates(&self) -> Vec<usize> {
        self.segments()
            .into_iter()
            .flat_map(|s| s.exchanges)
            .filter(|&i| matches!(self.resource_types[i].as_str(), "Fetch" | "XHR"))
            .collect()
    }

    /// The API calls one action set off, such as clicking "Place order".
    pub fn triggered_by(&self, kind: &str, selector: &str) -> Vec<usize> {
        let candidates = self.candidates();
        self.segments()
            .into_iter()
            .filter(|s| s.action.kind == kind && s.action.selector.as_deref() == Some(selector))
            .flat_map(|s| s.exchanges)
            .filter(|i| candidates.contains(i))
            .collect()
    }
}

/// Adds an input unless the same name and value is already there: a repeated
/// navigation to the same shape of URL must not duplicate its segments.
fn push_input(inputs: &mut Vec<Input>, input: Input) {
    if !inputs.iter().any(|i| i.name == input.name && i.value == input.value) {
        inputs.push(input);
    }
}

#[cfg(test)]
mod choice_tests {
    use super::Session;

    /// A choice made by a click is the caller's value: a radio or a box the capture logged with the name and the
    /// value its form sends is an input, as a typed field is. A click that carries neither (a button, a link) is a
    /// step. An order form's size and topping were sent as first chosen for every later order.
    #[test]
    fn a_choice_made_by_a_click_is_the_callers_value() {
        let log = [
            r#"{"type":"action","t":1.0,"action":"fill","selector":"@e1","field":"custname","value":"Ada","secret":false}"#,
            r#"{"type":"action","t":2.0,"action":"click","selector":"@e2","field":"size","value":"medium","secret":false}"#,
            r#"{"type":"action","t":3.0,"action":"check","selector":"@e3","field":"topping","value":"bacon","secret":false}"#,
            r#"{"type":"action","t":4.0,"action":"click","selector":"@e4","field":null,"value":null,"secret":false}"#,
            r#"{"type":"action","t":5.0,"action":"click","selector":"@e5","field":"Send","value":"","secret":false}"#,
        ]
        .join("\n");
        let session = Session::from_log(&log).unwrap();
        let said: Vec<(&str, &str)> = session.trace.inputs.iter().map(|i| (i.name.as_str(), i.value.as_str())).collect();
        assert_eq!(said, [("custname", "Ada"), ("size", "medium"), ("topping", "bacon")]);
    }
}
