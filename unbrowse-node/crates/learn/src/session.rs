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
    /// A fill that submitted its field's form itself (a vault login's one step, `fill` with `submit`): the fill is the
    /// step that sent it, with no click or key after it.
    pub submit: bool,
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
    Action { t: f64, action: String, selector: Option<String>, #[serde(default)] field: Option<String>, #[serde(default)] locator: Option<String>, value: Option<Value>, #[serde(default)] secret: bool, #[serde(default)] submit: bool },
    Exchange { t: f64, #[serde(rename = "resourceType", default)] resource_type: String, #[serde(default)] tab: Option<String>, entry: HarEntry },
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

    /// Whether the step hands over what was typed before it: Enter pressed, a click that chose no value of its own (a
    /// search button, a suggestion), or a fill that submitted its own form. A call the page made between a value's
    /// typing and the step that handed it over answered the field as it was typed (a suggestion), not the asking.
    pub fn submits(&self) -> bool {
        match self.kind.as_str() {
            "press" => self.value.as_deref().is_some_and(|k| k.eq_ignore_ascii_case("enter")),
            "click" => !self.gives_a_value(),
            _ => self.submit,
        }
    }
}

impl Session {
    pub fn from_log(log: &str) -> Result<Self, TraceError> {
        Self::from_lines(log.lines())
    }

    /// [`Self::from_log`] over the log's lines one at a time: a caller reading a long log holds the session it makes,
    /// never the whole text as well.
    pub fn from_lines<S: AsRef<str>>(lines: impl IntoIterator<Item = S>) -> Result<Self, TraceError> {
        let mut actions = Vec::new();
        let mut sockets = Vec::new();
        let mut exchanges: Vec<(f64, String, bool, Exchange)> = Vec::new();
        let mut probes: Vec<crate::trace::Probe> = Vec::new();
        for line in lines {
            let line = line.as_ref();
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Line>(line)? {
                Line::Action { t, action, selector, field, locator, value, secret, submit } => {
                    let value = value.and_then(|v| match v {
                        Value::String(s) => Some(s),
                        Value::Null => None,
                        Value::Array(items) => Some(items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")),
                        other => Some(other.to_string()),
                    });
                    actions.push(Action { t, kind: action, selector, field, locator, value, secret, submit });
                }
                Line::Exchange { t, resource_type, tab, entry } => {
                    if let Some(ex) = entry.into_exchange() {
                        exchanges.push((t, resource_type, tab.is_some(), ex));
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
        let known_tab_navigation = exchanges.iter().any(|(_, _, tab, ex)| {
            *tab && ex.resource_type.as_deref() == Some("Document")
                && ex.main_frame.unwrap_or_else(|| ex.request_header("sec-fetch-dest") == Some("document"))
        });
        let exchanges = exchanges.into_iter().map(|(_, _, tab, mut ex)| {
            // A browsing sidecar tags the page targets it owns. Once it has tagged a navigation, an unassigned
            // document cannot replace the page, unless its request independently identifies a navigation.
            if ex.main_frame.is_none() && ex.resource_type.as_deref() == Some("Document") {
                ex.main_frame = match ex.request_header("sec-fetch-dest") {
                    Some("document") => Some(true),
                    Some("iframe" | "frame" | "fencedframe") => Some(false),
                    _ if known_tab_navigation && !tab => Some(false),
                    _ => None,
                };
            }
            ex
        }).collect();
        let trace = Trace { exchanges, inputs };
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

    /// [`Self::only`], taking this session: what is dropped is freed, and what is kept is moved, not copied. A learn
    /// reads a page's whole flow; a copy of it would be held beside the original until both went.
    pub fn into_only(self, keep: impl Fn(f64) -> bool) -> Session {
        let Session { actions, sockets, trace, probes, times, resource_types } = self;
        let kept: Vec<bool> = (0..trace.exchanges.len()).map(|i| keep(times.get(i).copied().unwrap_or(0.0))).collect();
        let mut at = kept.iter();
        let exchanges = trace.exchanges.into_iter().filter(|_| at.next().copied().unwrap_or(false)).collect();
        Session {
            actions: actions.into_iter().filter(|a| keep(a.t)).collect(),
            sockets: sockets.into_iter().filter(|e| keep(e.t)).collect(),
            trace: Trace { exchanges, inputs: trace.inputs },
            probes,
            times: times.iter().zip(&kept).filter(|(_, k)| **k).map(|(t, _)| *t).collect(),
            resource_types: resource_types.into_iter().zip(&kept).filter(|(_, k)| **k).map(|(r, _)| r).collect(),
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

#[cfg(test)]
mod into_only_tests {
    use super::Session;

    fn log() -> String {
        let call = |t: f64, path: &str| serde_json::json!({ "type": "exchange", "t": t, "resourceType": if t < 3.0 { "Document" } else { "XHR" }, "entry": { "request": { "method": "GET", "url": format!("https://s.example{path}"), "headers": [] }, "response": { "status": 200, "headers": [], "content": { "mimeType": "application/json", "text": path } } } });
        [
            serde_json::json!({ "type": "action", "t": 1.0, "action": "navigate", "value": "https://s.example/a?q=one" }),
            call(1.5, "/a"),
            serde_json::json!({ "type": "socket", "t": 1.6, "id": "s1", "event": "open", "url": "wss://s.example/ws" }),
            serde_json::json!({ "type": "action", "t": 2.0, "action": "fill", "selector": "#q", "value": "two" }),
            call(2.5, "/api/two"),
            call(3.5, "/api/three"),
            serde_json::json!({ "type": "socket", "t": 3.6, "id": "s1", "event": "sent", "data": "x" }),
        ]
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n")
    }

    /// A session taken whole keeps what a copy of it would: the same steps, requests, frames, inputs and times, so a
    /// learn that moves its own steps out of what it read learns what it learned from the copy.
    #[test]
    fn a_session_taken_whole_keeps_what_its_copy_keeps() {
        let session = Session::from_log(&log()).unwrap();
        let keeps: [fn(f64) -> bool; 5] = [|t| t < 2.2, |t| t > 2.2, |_| true, |_| false, |t| (1.55..3.0).contains(&t)];
        for keep in keeps {
            let copied = session.only(keep);
            let taken = session.clone().into_only(keep);
            assert_eq!(format!("{:?}", taken.actions), format!("{:?}", copied.actions));
            assert_eq!(format!("{:?}", taken.sockets), format!("{:?}", copied.sockets));
            assert_eq!(taken.trace.exchanges.iter().map(|e| e.url.to_string()).collect::<Vec<_>>(), copied.trace.exchanges.iter().map(|e| e.url.to_string()).collect::<Vec<_>>());
            assert_eq!(format!("{:?}", taken.trace.inputs), format!("{:?}", copied.trace.inputs));
            assert_eq!((0..copied.trace.exchanges.len()).map(|i| (taken.time_of(i), taken.resource_types[i].clone())).collect::<Vec<_>>(), (0..copied.trace.exchanges.len()).map(|i| (copied.time_of(i), copied.resource_types[i].clone())).collect::<Vec<_>>());
            assert_eq!(taken.probes.len(), copied.probes.len());
        }
    }

    /// A log read a line at a time is the session the whole text makes.
    #[test]
    fn a_log_read_line_by_line_is_the_log_read_whole() {
        let text = log();
        let whole = Session::from_log(&text).unwrap();
        let lines = Session::from_lines(text.lines().map(String::from).chain(["".to_string(), "   ".to_string()])).unwrap();
        assert_eq!(format!("{:?}", lines.actions), format!("{:?}", whole.actions));
        assert_eq!(lines.trace.exchanges.len(), whole.trace.exchanges.len());
        assert_eq!(format!("{:?}", lines.trace.inputs), format!("{:?}", whole.trace.inputs));
    }
}

#[cfg(test)]
mod segment_tests {
    use super::Session;
    use serde_json::json;

    fn exchange(t: f64, kind: &str, url: &str) -> String {
        json!({"type": "exchange", "t": t, "resourceType": kind, "entry": {
            "request": {"method": "GET", "url": url, "headers": []},
            "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": "{}"}}}})
        .to_string()
    }

    #[test]
    fn an_unassigned_document_cannot_replace_the_page_the_browser_tab_loaded() {
        let document = |time, url: &str, tab: Option<&str>, destination: Option<&str>, frame: Option<bool>| {
            let mut line: serde_json::Value = serde_json::from_str(&exchange(time, "Document", url)).unwrap();
            line["entry"]["_resourceType"] = json!("Document");
            if let Some(tab) = tab { line["tab"] = json!(tab); }
            if let Some(dest) = destination {
                line["entry"]["request"]["headers"] = json!([{"name":"sec-fetch-dest","value":dest}]);
            }
            if let Some(frame) = frame { line["entry"]["_mainFrame"] = json!(frame); }
            line.to_string()
        };
        let lines = [
            document(1.0, "https://shop.example/find?q=desk", Some("tab1"), Some("document"), None),
            document(2.0, "https://embed.example/measure", None, None, None),
            document(3.0, "https://shop.example/sidebar", Some("tab1"), Some("iframe"), None),
            document(4.0, "https://shop.example/account", None, Some("document"), None),
            document(5.0, "https://shop.example/panel", Some("tab1"), Some("document"), Some(false)),
        ];
        let session = Session::from_lines(lines.iter()).unwrap();
        let pages: Vec<_> = session.trace.exchanges.iter().filter(|ex| ex.is_main_document()).map(|ex| ex.url.path()).collect();
        assert_eq!(pages, ["/find", "/account"]);

        let legacy = [
            document(1.0, "https://shop.example/find?q=desk", None, None, None),
            document(2.0, "https://shop.example/sidebar", Some("tab1"), Some("iframe"), None),
        ];
        let session = Session::from_lines(legacy.iter()).unwrap();
        assert!(session.trace.exchanges[0].is_main_document());
        assert!(!session.trace.exchanges[1].is_main_document());
    }

    /// Each request belongs to the last action before it, and the calls an action set off are its fetches and XHRs
    /// alone: the page's own load before any action belongs to none, and an image is no call.
    #[test]
    fn the_calls_an_action_set_off_are_its_own_fetches_after_it() {
        let lines = [
            exchange(0.5, "Document", "https://shop.example/"),
            json!({"type": "action", "t": 1.0, "action": "click", "selector": "#add"}).to_string(),
            exchange(1.5, "XHR", "https://shop.example/api/cart"),
            exchange(1.6, "Image", "https://shop.example/pixel.gif"),
            json!({"type": "action", "t": 3.0, "action": "click", "selector": "#checkout"}).to_string(),
            exchange(3.5, "Fetch", "https://shop.example/api/order"),
        ];
        let s = Session::from_lines(lines.iter()).unwrap();
        let path = |i: usize| s.trace.exchanges[i].url.path().to_string();
        let segments = s.segments();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].exchanges.iter().map(|&i| path(i)).collect::<Vec<_>>(), ["/api/cart", "/pixel.gif"]);
        assert_eq!(segments[1].exchanges.iter().map(|&i| path(i)).collect::<Vec<_>>(), ["/api/order"]);
        assert_eq!(s.candidates().into_iter().map(path).collect::<Vec<_>>(), ["/api/cart", "/api/order"], "the page and the image are no calls");
        assert_eq!(s.triggered_by("click", "#checkout").into_iter().map(path).collect::<Vec<_>>(), ["/api/order"]);
        assert_eq!(s.triggered_by("click", "#add").into_iter().map(path).collect::<Vec<_>>(), ["/api/cart"]);
        assert!(s.triggered_by("fill", "#checkout").is_empty(), "another kind of step on the same element set off nothing");
    }

    /// A step's value is read as the page took it: a list chosen (a multi-select) as its items joined, nothing as no
    /// value, a number as written. A sign probe is kept only when it names the header, its value and the input.
    #[test]
    fn a_steps_value_and_a_sign_probe_read_as_the_page_gave_them() {
        let lines = [
            json!({"type": "action", "t": 1.0, "action": "select", "selector": "#sizes", "value": ["S", "M"]}).to_string(),
            json!({"type": "action", "t": 2.0, "action": "click", "selector": "#go", "value": null}).to_string(),
            json!({"type": "action", "t": 3.0, "action": "fill", "selector": "#qty", "value": 3}).to_string(),
            json!({"type": "sign_probe", "probes": [["x-sig", "abc123", "https://shop.example/api", "q", "pre"], ["x-sig", "", "https://shop.example/api", "q"]]}).to_string(),
            json!({"type": "script", "scriptId": "1"}).to_string(),
            String::new(),
        ];
        let s = Session::from_lines(lines.iter()).unwrap();
        let values: Vec<Option<&str>> = s.actions.iter().map(|a| a.value.as_deref()).collect();
        assert_eq!(values, [Some("S,M"), None, Some("3")]);
        assert_eq!(s.probes.len(), 1, "a probe with no value is no probe");
        assert_eq!((s.probes[0].header.as_str(), s.probes[0].value.as_str(), s.probes[0].input.as_str(), s.probes[0].pre.as_str()), ("x-sig", "abc123", "q", "pre"));
    }
}
