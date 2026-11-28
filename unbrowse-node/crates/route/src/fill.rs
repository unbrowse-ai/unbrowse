//! How a step's holes become a request.
//!
//! Each hole takes the first of its ways that is ready. A way that reads the request it is part of (a signature
//! over the address and the body) waits until the rest is built, and is then written into it. Nothing here is sent:
//! the node sends what this builds, and tells the [`World`] what came back.

use serde_json::Value;

use crate::body::{Form, Hole, Place, Step};
use crate::expr::{Cx, Outcome, Sent, Stuck, Why, World, ADDRESS};

/// A step's request, built for one call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Built {
    pub method: String,
    pub url: url::Url,
    /// The headers in the order they go, with the session's cookies joined as one `cookie` header.
    pub headers: Vec<(String, String)>,
    /// The body as text. None for a step with no body, and for an upload, whose bytes are the caller's file.
    pub body: Option<String>,
    /// The rung of the way that filled each hole (`learn.rung`), for the holes that sent something.
    pub made: Vec<(Place, u8)>,
    /// Which of each hole's ways filled it, counted from zero: where a refused call goes on from (`start_below`).
    pub ways: Vec<(Place, usize)>,
}

impl Built {
    /// A part of this request, as a signature over it reads it.
    pub fn part(&self, part: &Sent) -> Option<String> {
        match part {
            Sent::Path => Some(match self.url.query() {
                Some(q) => format!("{}?{q}", self.url.path()),
                None => self.url.path().to_string(),
            }),
            Sent::Method => Some(self.method.to_uppercase()),
            Sent::Body => Some(self.body.clone().unwrap_or_default()),
            Sent::Query(key) => self.url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()),
            Sent::Cookie(name) => {
                let cookies = self.cookies();
                cookies.iter().find(|(k, _)| k == name).or_else(|| cookies.iter().find(|(k, _)| k.eq_ignore_ascii_case(name))).map(|(_, v)| v.clone())
            }
            Sent::Header(name) => self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name) && !k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()),
            Sent::Origin => Some(self.url.origin().ascii_serialization()),
            Sent::Host => self.url.host_str().map(String::from),
            Sent::Pathname => Some(self.url.path().to_string()),
            Sent::Address => Some(self.url.to_string()),
            Sent::Search => Some(self.url.query().map(|q| format!("?{q}")).unwrap_or_default()),
        }
    }

    /// The cookies the request carries, by name, exactly as it sends them.
    pub fn cookies(&self) -> Vec<(String, String)> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .map(|(_, v)| v.split(';').filter_map(|p| p.split_once('=')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect())
            .unwrap_or_default()
    }

    /// This request with each of `names` among its cookies, empty where it carries none of that name: what a signature
    /// over a cookie the session doesn't hold yet reads.
    pub fn with_blank_cookies(&self, names: &[String]) -> Built {
        let mut cookies = self.cookies();
        for name in names {
            if !cookies.iter().any(|(k, _)| k == name) {
                cookies.push((name.clone(), String::new()));
            }
        }
        let mut built = self.clone();
        built.headers.retain(|(k, _)| !k.eq_ignore_ascii_case("cookie"));
        built.headers.push(("cookie".into(), cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")));
        built
    }

    /// The highest rung any of its holes needed.
    pub fn rung(&self) -> u8 {
        self.made.iter().map(|(_, rung)| *rung).max().unwrap_or(0)
    }
}

/// The host a step's address names, in small letters. None when the address builds its host for each call.
pub fn host_of(address: &str) -> Option<String> {
    let authority = address.split_once("://")?.1.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['{', '}']) {
        return None;
    }
    url::Url::parse(&address.replace('{', "%7B").replace('}', "%7D")).ok()?.host_str().map(str::to_ascii_lowercase)
}

/// A request with everything written but what is made over the request itself.
#[derive(Clone, Debug)]
pub struct Draft<'s> {
    pub built: Built,
    /// The holes that wait for the request, each with the first of its ways that reads it.
    waiting: Vec<(&'s Hole, usize)>,
    host: Option<String>,
}

/// Builds `step`'s request for one call.
pub fn request(step: &Step, world: &mut dyn World) -> Result<Built, Stuck> {
    start(step, world)?.finish(world)
}

/// Builds `step`'s request up to the values made over the request itself.
pub fn start<'s>(step: &'s Step, world: &mut dyn World) -> Result<Draft<'s>, Stuck> {
    start_below(step, world, &|_| 0)
}

/// [`start`], with each hole's ways tried from the one `from` names on: a call the site refused is built again with a
/// value made per call one way down (`learn.rung`, `route.value-dag`).
pub fn start_below<'s>(step: &'s Step, world: &mut dyn World, from: &dyn Fn(&Place) -> usize) -> Result<Draft<'s>, Stuck> {
    let host = host_of(&step.url);
    // What each hole sends, in the holes' order; the holes an unset optional slot leaves out; the holes that wait.
    let mut values: Vec<(Place, String)> = Vec::new();
    let mut unset: Vec<&Place> = Vec::new();
    let mut made: Vec<(Place, u8)> = Vec::new();
    let mut ways: Vec<(Place, usize)> = Vec::new();
    let mut waiting: Vec<(&Hole, usize)> = Vec::new();
    for hole in &step.holes {
        let mut first: Option<Why> = None;
        let mut filled = false;
        for (n, way) in hole.ways.iter().enumerate().skip(from(&hole.at)) {
            if way.expr.reads_the_request() {
                waiting.push((hole, n));
                filled = true;
                break;
            }
            match way.expr.eval(&mut Cx { world: &mut *world, host: host.as_deref(), sent: None }) {
                Ok(Outcome::Is(value)) => {
                    values.push((hole.at.clone(), value));
                    made.push((hole.at.clone(), way.rung.max(way.expr.least_rung())));
                    ways.push((hole.at.clone(), n));
                }
                Ok(Outcome::Unset) => unset.push(&hole.at),
                Ok(Outcome::Absent) => {}
                Err(why) => {
                    first.get_or_insert(why);
                    continue;
                }
            }
            filled = true;
            break;
        }
        if !filled {
            return Err(Stuck { at: Some(hole.at.clone()), why: first.unwrap_or(Why::Needs(5)) });
        }
    }

    let url = address(step, &values)?;
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut cookies: Vec<String> = Vec::new();
    for (place, value) in &values {
        match place {
            Place::Header(name) => headers.push((name.clone(), value.clone())),
            Place::Cookie(name) => cookies.push(format!("{name}={value}")),
            _ => {}
        }
    }
    if !cookies.is_empty() {
        headers.push(("cookie".into(), cookies.join("; ")));
    }
    if let Some(caller) = &step.script {
        as_a_script(step, &url, caller.origin.as_deref(), &mut headers, world);
    }
    let body = match &step.body {
        Some(Form::Upload { .. }) => None,
        _ => body(step, &values, &unset)?,
    };
    // The ways that read the request, cheapest first: an expression over it, then a program given it.
    waiting.sort_by_key(|(hole, n)| hole.ways[*n].rung);
    Ok(Draft { built: Built { method: step.method.clone(), url, headers, body, made, ways }, waiting, host })
}

impl Draft<'_> {
    /// Writes what is made over the request into it.
    pub fn finish(self, world: &mut dyn World) -> Result<Built, Stuck> {
        self.finish_keeping(world).map_err(|(stuck, _)| stuck)
    }

    /// [`Draft::finish`], keeping the request as far as it was built when a value made over it could not be: a caller
    /// that names the request in what it says of the failure names it as it then stood.
    pub fn finish_keeping(self, world: &mut dyn World) -> Result<Built, (Stuck, Built)> {
        let Draft { mut built, waiting, host } = self;
        for (hole, from) in waiting {
            let mut first: Option<Why> = None;
            let mut done = false;
            for (n, way) in hole.ways.iter().enumerate().skip(from) {
                match way.expr.eval(&mut Cx { world: &mut *world, host: host.as_deref(), sent: Some(&built) }) {
                    Ok(Outcome::Is(value)) => {
                        match &hole.at {
                            Place::Header(name) => {
                                built.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
                                built.headers.push((name.clone(), value));
                            }
                            // Written last, after the address's other values as they are sent.
                            Place::Query(key) => {
                                let others: Vec<(String, String)> = built.url.query_pairs().filter(|(k, _)| k != key).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                                built.url.query_pairs_mut().clear().extend_pairs(others).append_pair(key, &value);
                            }
                            // A value made over the request and sent in its body would change what it was made over.
                            _ => return Err((Stuck { at: Some(hole.at.clone()), why: Why::Needs(5) }, built)),
                        }
                        built.made.push((hole.at.clone(), way.rung.max(way.expr.least_rung())));
                        built.ways.push((hole.at.clone(), n));
                    }
                    Ok(_) => {}
                    Err(why) => {
                        first.get_or_insert(why);
                        continue;
                    }
                }
                done = true;
                break;
            }
            if !done {
                return Err((Stuck { at: Some(hole.at.clone()), why: first.unwrap_or(Why::Needs(5)) }, built));
            }
        }
        Ok(built)
    }
}

/// The step's address for these values.
fn address(step: &Step, values: &[(Place, String)]) -> Result<url::Url, Stuck> {
    let bad = |why: String| Stuck { at: None, why: Why::BadUrl(why) };
    // An address an earlier reply handed over is taken whole, on the step's own origin only: a reply that names
    // another origin would send the step, and a file it uploads, somewhere the route never went.
    if let Some((_, handed)) = values.iter().find(|(place, _)| *place == Place::Url) {
        let to = url::Url::parse(handed.trim()).map_err(|e| bad(format!("{handed}: {e}")))?;
        let own = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")).map_err(|e| bad(format!("{}: {e}", step.url)))?;
        if to.origin() != own.origin() {
            return Err(Stuck { at: Some(Place::Url), why: Why::OtherOrigin { own: own.origin().ascii_serialization(), to: to.origin().ascii_serialization() } });
        }
        return Ok(to);
    }
    let mut path = step.url.split('?').next().unwrap_or_default().to_string();
    for (place, value) in values {
        if let Place::Path(i) = place {
            let piece = percent_encoding::utf8_percent_encode(value, ADDRESS).to_string();
            path = path.replace(&format!("{{path[{i}]}}"), &piece);
        }
    }
    let mut url = url::Url::parse(&path).map_err(|e| bad(format!("{}: {e}", step.url)))?;
    let query: Vec<(&str, &str)> = values.iter().filter_map(|(place, v)| if let Place::Query(k) = place { Some((k.as_str(), v.as_str())) } else { None }).collect();
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

/// The headers a page's script sends with a call and a page asked for as a page does not: what it accepts, that it
/// is a fetch, and the page it comes from. A header the step sets itself stands.
fn as_a_script(step: &Step, url: &url::Url, page: Option<&str>, headers: &mut Vec<(String, String)>, world: &dyn World) {
    let own = url.origin().ascii_serialization();
    let origin = page.map(String::from).unwrap_or_else(|| own.clone());
    let fetch_site = if origin == own {
        "same-origin"
    } else if world.same_site(&origin, &own) {
        "same-site"
    } else {
        "cross-site"
    };
    let mut add = |k: &str, v: String| {
        if !headers.iter().any(|(h, _)| h.eq_ignore_ascii_case(k)) {
            headers.push((k.to_string(), v));
        }
    };
    add("accept", "application/json, text/plain, */*".into());
    add("sec-fetch-dest", "empty".into());
    add("sec-fetch-mode", "cors".into());
    add("sec-fetch-site", fetch_site.into());
    add("referer", format!("{origin}/"));
    if step.method != "GET" {
        add("origin", origin);
    }
}

/// Writes each value at its pointer where the template is empty there, as the kind of leaf the walk sent.
fn fill_json<'a>(body: &mut Value, types: &std::collections::BTreeMap<String, String>, values: impl Iterator<Item = (&'a str, &'a String)>) {
    for (pointer, value) in values {
        if let Some(leaf) = body.pointer_mut(pointer) {
            if leaf.is_null() {
                *leaf = match types.get(pointer).map(String::as_str) {
                    Some("number") => serde_json::from_str(value).unwrap_or(Value::String(value.clone())),
                    Some("bool") => Value::Bool(value == "true"),
                    _ => Value::String(value.clone()),
                };
            }
        }
    }
}

/// Takes the key at `pointer` out of a JSON body.
fn remove_pointer(body: &mut Value, pointer: &str) {
    let (parent, key) = pointer.rsplit_once('/').unwrap_or(("", pointer));
    if let Some(Value::Object(o)) = body.pointer_mut(parent) {
        o.remove(&key.replace("~1", "/").replace("~0", "~"));
    }
}

/// The first leaf the walk sent a value at that this call could not make, where it sits in a list.
fn gap_in_a_list(body: &Value, types: &std::collections::BTreeMap<String, String>) -> Option<String> {
    types.keys().find(|pointer| {
        let parent = pointer.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        body.pointer(pointer).is_some_and(Value::is_null) && matches!(body.pointer(parent), Some(Value::Array(_)))
    }).cloned()
}

/// The step's body for these values.
fn body(step: &Step, values: &[(Place, String)], unset: &[&Place]) -> Result<Option<String>, Stuck> {
    let over = |place: &Place| step.holes.iter().any(|h| h.over && h.at == *place);
    match &step.body {
        None => Ok(None),
        Some(Form::Other) | Some(Form::Upload { .. }) => Err(Stuck { at: None, why: Why::Body }),
        Some(Form::Fields { fields }) => {
            let mut out = url::form_urlencoded::Serializer::new(String::new());
            for (name, fixed) in fields {
                let place = Place::Form(name.clone());
                let value = || values.iter().find(|(p, _)| *p == place).map(|(_, v)| v.clone());
                // What the field's hole gives is what is sent: a caller's value, a value an earlier reply gave. The
                // form's own text is what the walk sent, and stands only where the hole gives nothing (an optional
                // slot left unset sends the walk's value).
                let given = value().or_else(|| fixed.clone());
                if given.is_none() && unset.contains(&&place) {
                    continue;
                }
                out.append_pair(name, &given.unwrap_or_default());
            }
            Ok(Some(out.finish()))
        }
        Some(Form::Json { template, types, follows }) => {
            let mut body = template.clone();
            fill_json(&mut body, types, values.iter().filter_map(|(place, v)| if let Place::Json(p) = place { Some((p.as_str(), v)) } else { None }));
            for (place, v) in values.iter().filter(|(place, _)| over(place)) {
                if let Place::Json(p) = place {
                    if let Some(leaf) = body.pointer_mut(p) {
                        *leaf = Value::String(v.clone());
                    }
                }
            }
            // A key the caller left unset goes unsent: `null` is a value to a site, and not the one the walk sent.
            for place in unset {
                if let Place::Json(pointer) = place {
                    remove_pointer(&mut body, pointer);
                }
            }
            // A list that follows a list in an earlier reply ends where that one ended.
            for parent in follows {
                if let Some(Value::Array(items)) = body.pointer_mut(parent) {
                    while items.len() > 1 && items.last().is_some_and(Value::is_null) {
                        items.pop();
                    }
                }
            }
            if let Some(pointer) = gap_in_a_list(&body, types) {
                return Err(Stuck { at: Some(Place::Json(pointer)), why: Why::Gap });
            }
            Ok(Some(body.to_string()))
        }
        Some(Form::Wire { codec, template }) => {
            let mut tree = template.clone();
            for (place, v) in values {
                if let Place::Json(p) = place {
                    if let Some(leaf) = tree.pointer_mut(p) {
                        *leaf = Value::String(v.clone());
                    }
                }
            }
            // Bytes that are no text are carried marked (`wire::carried`), and each transport sends the bytes.
            let bytes = crate::wire::close(*codec, &tree).ok_or(Stuck { at: None, why: Why::Body })?;
            Ok(Some(crate::wire::carried(&bytes)))
        }
        Some(Form::Multipart { boundary, parts }) => {
            let mut out = String::new();
            for part in parts {
                let text = match (&part.text, &part.json) {
                    (Some(text), _) => text.clone(),
                    (None, Some(template)) => {
                        let mut json = template.clone();
                        let mine = values.iter().filter_map(|(place, v)| match place {
                            Place::Part(name, pointer) if name == &part.name && !pointer.is_empty() => Some((pointer.as_str(), v)),
                            _ => None,
                        });
                        fill_json(&mut json, &part.types, mine);
                        json.to_string()
                    }
                    (None, None) => values.iter().find(|(place, _)| matches!(place, Place::Part(name, pointer) if name == &part.name && pointer.is_empty())).map(|(_, v)| v.clone()).unwrap_or_default(),
                };
                // The boundary is the body's framing: a value that holds it would close its part and open others
                // the route never had.
                if text.contains(&format!("--{boundary}")) {
                    return Err(Stuck { at: None, why: Why::Breaks { part: part.name.clone() } });
                }
                out.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"", part.name));
                if let Some(f) = &part.filename {
                    out.push_str(&format!("; filename=\"{f}\""));
                }
                out.push_str("\r\n");
                if let Some(t) = &part.content_type {
                    out.push_str(&format!("Content-Type: {t}\r\n"));
                }
                out.push_str(&format!("\r\n{text}\r\n"));
            }
            out.push_str(&format!("--{boundary}--\r\n"));
            Ok(Some(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::{Form, Part};
    use crate::expr::tests::Desk;
    use crate::expr::Expr;
    use serde_json::json;

    /// A world with only what the caller wrote.
    fn said(pairs: &[(&str, &str)]) -> Desk {
        Desk::saying(pairs)
    }

    fn hole(at: Place, slot: &str) -> Hole {
        Hole { at, ways: vec![crate::body::Way { rung: 0, expr: Expr::Slot { name: slot.into(), or: None, optional: false } }], over: false, open: false }
    }

    fn post(body: Form, holes: Vec<Hole>) -> Step {
        Step { id: "send".into(), method: "POST".into(), url: "https://shop.example/api/send".into(), holes, body: Some(body), expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None }
    }

    fn part(name: &str) -> Part {
        Part { name: name.into(), filename: None, content_type: None, text: None, json: None, types: Default::default() }
    }

    /// A value the page's own script makes is a way of its own (`route.value-dag`, `learn.reference`): one function of
    /// that script, called with what the page handed it (the request's origin, its path, its method as it is sent), and
    /// run by the world, which holds the page. After it, the value the first learn's request carried, sent only where
    /// no way before it made one: a world that runs no page code still sends what the page sent. The function counts
    /// at rung 2, the recalled value at 0, and the hole reads back as it was written: data, never code (`R2.7`).
    #[test]
    fn a_function_of_the_pages_own_script_is_a_way_its_world_runs() {
        let made: Expr = serde_json::from_value(json!({ "op": "function", "module": "100", "export": "kc", "args": [
            { "op": "sent", "part": { "of": "origin" } }, { "op": "sent", "part": { "of": "pathname" } }, { "op": "sent", "part": { "of": "method" } },
        ] }))
        .expect("a function is an expression");
        let recalled: Expr = serde_json::from_value(json!({ "op": "recalled", "was": "walked-sig" })).expect("a recalled value is an expression");
        let sig = Hole { at: Place::Header("x-sig".into()), ways: vec![crate::body::Way { rung: 2, expr: made }, crate::body::Way { rung: 0, expr: recalled }], over: false, open: false };
        let step = Step { id: "s".into(), method: "GET".into(), url: "https://shop.example/api/search".into(), holes: vec![hole(Place::Query("q".into()), "q"), sig.clone()], body: None, expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None };

        let mut page = said(&[("q", "lamp")]).running_page_code();
        let built = request(&step, &mut page).expect("the page's function makes the value");
        assert_eq!(built.part(&Sent::Header("x-sig".into())).as_deref(), Some("100.kc(https://shop.example,/api/search,GET)"), "called with the request as it is sent, not the walk's");
        assert_eq!(built.rung(), 2);

        let built = request(&step, &mut said(&[("q", "lamp")])).expect("a world with no page code still builds the request");
        assert_eq!(built.part(&Sent::Header("x-sig".into())).as_deref(), Some("walked-sig"), "the first learn's value, recalled");
        assert_eq!(built.rung(), 0);

        let text = serde_json::to_string(&sig).unwrap();
        assert_eq!(serde_json::from_str::<Hole>(&text).unwrap(), sig, "the hole reads back as it was written");
    }

    /// A multipart body is written part by part on its own boundary: a part's fixed text as walked, a JSON part with the
    /// caller's value at its leaf as the kind the walk sent, a part the caller fills whole, a file's name and type.
    #[test]
    fn a_multipart_body_is_written_part_by_part_with_the_callers_values() {
        let body = Form::Multipart {
            boundary: "XB".into(),
            parts: vec![
                Part { text: Some("fixed".into()), ..part("kind") },
                Part { json: Some(json!({ "n": null, "keep": 1 })), types: [("/n".to_string(), "number".to_string())].into(), ..part("meta") },
                Part { filename: Some("a.txt".into()), content_type: Some("text/plain".into()), ..part("note") },
            ],
        };
        let step = post(body, vec![hole(Place::Part("meta".into(), "/n".into()), "count"), hole(Place::Part("note".into(), String::new()), "note")]);
        let built = request(&step, &mut said(&[("count", "42"), ("note", "hello")])).expect("builds");
        assert_eq!(
            built.body.as_deref(),
            Some(concat!(
                "--XB\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nfixed\r\n",
                "--XB\r\nContent-Disposition: form-data; name=\"meta\"\r\n\r\n{\"n\":42,\"keep\":1}\r\n",
                "--XB\r\nContent-Disposition: form-data; name=\"note\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n",
                "--XB--\r\n"
            ))
        );
        // A value that holds the boundary would close its part and open another.
        let e = request(&step, &mut said(&[("count", "1"), ("note", "x\r\n--XB\r\nContent-Disposition: form-data; name=\"evil\"")])).unwrap_err();
        assert_eq!(e.why, Why::Breaks { part: "note".into() });
        // A part nobody fills is empty.
        let none = request(&post(Form::Multipart { boundary: "B".into(), parts: vec![part("blank")] }, vec![]), &mut said(&[])).unwrap();
        assert!(none.body.unwrap().contains("name=\"blank\"\r\n\r\n\r\n--B--"));
    }

    /// A binary body is written by filling the leaves of the tree the walk's bytes opened as and encoding it again: a
    /// text body goes as text, bytes that are no text go marked, and a tree the codec cannot write stops the call.
    #[test]
    fn a_binary_body_is_filled_at_its_leaves_and_encoded_again() {
        let wire = |template: serde_json::Value| Form::Wire { codec: crate::wire::Codec::Protobuf, template };
        let step = post(wire(json!([{ "n": 1, "text": null }, { "n": 2, "int": 7 }])), vec![hole(Place::Json("/0/text".into()), "q")]);
        let built = request(&step, &mut said(&[("q", "kettle")])).expect("builds");
        let bytes = crate::wire::bytes_of(built.body.as_deref().unwrap());
        assert_eq!(bytes, [&[0x0a, 6][..], b"kettle", &[0x10, 7]].concat());
        // A leaf that is no text is carried marked.
        let raw = post(wire(json!([{ "n": 1, "int": 300 }])), vec![]);
        let carried = request(&raw, &mut said(&[])).unwrap().body.unwrap();
        assert!(carried.starts_with(crate::wire::BYTES_MARK), "0xac alone is no text");
        assert_eq!(crate::wire::bytes_of(&carried), [0x08, 0xac, 0x02]);
        // A value the field cannot hold: a number field given words.
        let number = post(wire(json!([{ "n": 2, "int": null }])), vec![hole(Place::Json("/0/int".into()), "q")]);
        assert_eq!(request(&number, &mut said(&[("q", "many")])).unwrap_err().why, Why::Body);
    }

    /// A body this node cannot build stops the call and says so; a file upload is built around, never with its bytes.
    #[test]
    fn a_body_that_is_no_kind_this_node_builds_stops_the_call() {
        let other = post(Form::Other, vec![]);
        assert_eq!(request(&other, &mut said(&[])).unwrap_err(), Stuck { at: None, why: Why::Body });
        let upload = post(Form::Upload { slot: "file".into(), protocol: json!({}), content_type: None }, vec![]);
        assert_eq!(request(&upload, &mut said(&[])).unwrap().body, None);
        assert_eq!(request(&post(Form::Json { template: json!({}), types: Default::default(), follows: vec![] }, vec![]), &mut said(&[])).unwrap().body.as_deref(), Some("{}"));
    }

    /// A form's field the caller left unset is not sent, a field a caller fills is sent as they wrote it, and a field
    /// of the walk's own text keeps it.
    #[test]
    fn a_form_sends_the_callers_field_the_walks_text_or_nothing() {
        let step = post(
            Form::Fields { fields: vec![("q".into(), Some("walked".into())), ("sort".into(), Some("new".into())), ("page".into(), None)] },
            vec![hole(Place::Form("q".into()), "q"), Hole { at: Place::Form("page".into()), ways: vec![crate::body::Way { rung: 0, expr: Expr::Slot { name: "p".into(), or: None, optional: true } }], over: false, open: false }],
        );
        let built = request(&step, &mut said(&[("q", "a b&c")])).unwrap();
        assert_eq!(built.body.as_deref(), Some("q=a+b%26c&sort=new"));
    }

    /// The host a step's address names is its own in small letters, and none where the address builds it at call time.
    #[test]
    fn a_steps_host_is_the_one_its_address_names() {
        assert_eq!(host_of("https://API.Shop.example/a?b=1#c").as_deref(), Some("api.shop.example"));
        assert_eq!(host_of("https://{host}/a"), None);
        assert_eq!(host_of("/relative"), None);
        assert_eq!(host_of("https:///nohost"), None);
        assert_eq!(host_of("https://shop.example{path[0]}/a").as_deref(), None);
    }

    /// A JSON body's leaf a hole fills is written as the kind the walk sent (a number, a flag, a text), and a fixed leaf
    /// keeps its own value and kind.
    #[test]
    fn a_leaf_a_hole_gives_is_written_as_the_kind_the_walk_sent() {
        let step = post(
            Form::Json { template: json!({ "n": null, "b": null, "s": null, "keep": 5 }), types: [("/n".to_string(), "number".to_string()), ("/b".to_string(), "bool".to_string())].into(), follows: vec![] },
            vec![hole(Place::Json("/n".into()), "n"), hole(Place::Json("/b".into()), "b"), hole(Place::Json("/s".into()), "s"), hole(Place::Json("/keep".into()), "k")],
        );
        let built = request(&step, &mut said(&[("n", "12"), ("b", "true"), ("s", "12"), ("k", "9")])).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(built.body.as_deref().unwrap()).unwrap(), json!({ "n": 12, "b": true, "s": "12", "keep": 5 }), "a fixed leaf keeps its value and its kind");
    }

    /// A built request exposes its origin, host, pathname, full address, and search (with or without query) to expressions.
    #[test]
    fn a_built_request_exposes_its_url_parts() {
        let built = Built { method: "GET".into(), url: "https://api.shop.example/v1/items?q=lamp&p=2".parse().unwrap(), headers: vec![], body: None, made: vec![], ways: vec![] };
        assert_eq!(built.part(&Sent::Origin).as_deref(), Some("https://api.shop.example"));
        assert_eq!(built.part(&Sent::Host).as_deref(), Some("api.shop.example"));
        assert_eq!(built.part(&Sent::Pathname).as_deref(), Some("/v1/items"));
        assert_eq!(built.part(&Sent::Address).as_deref(), Some("https://api.shop.example/v1/items?q=lamp&p=2"));
        assert_eq!(built.part(&Sent::Search).as_deref(), Some("?q=lamp&p=2"));

        let plain = Built { url: "https://api.shop.example/v1/items".parse().unwrap(), ..built };
        assert_eq!(plain.part(&Sent::Search).as_deref(), Some(""));
    }
}
