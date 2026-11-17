//! Uploads in a walk: requests that send a file's bytes, read from the protocol their headers speak.
//!
//! A recording never holds a file's bytes (the browser records no binary body), so a replay can't send them again
//! from the recording. What the walk does show is how the file went: in chunks to one address, each announcing where
//! it starts and how long the whole file is, with status probes between them. That run of requests is one step of
//! the route, and the bytes come from a file the caller passes.

use serde::{Deserialize, Serialize};

use crate::trace::{Exchange, Input, Trace};

/// How an upload step sends its file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Protocol {
    /// A byte stream that announces, on each chunk, where the chunk starts (`offset`) and how long the whole file is
    /// (`x-entity-length`), all to one address (Facebook's rupload). A chunk the server is still waiting past answers
    /// 206. `chunk` is the walk's chunk size, or `None` when the walk sent the file in one request.
    Rupload { chunk: Option<u64> },
    /// A resumable session (Google's): an earlier step opens it and is answered with the session's address, and the
    /// file goes there in chunks, each saying `x-goog-upload-command: upload` (the last `upload, finalize`) and where
    /// it starts (`x-goog-upload-offset`).
    GoogleResumable { chunk: Option<u64> },
    /// The whole file as the request's body.
    Single,
}

impl Protocol {
    /// The headers the protocol sets on each chunk, which the replay makes for the file it sends.
    pub fn sets(&self, header: &str) -> bool {
        let h = header.to_ascii_lowercase();
        match self {
            Protocol::Rupload { .. } => h == "offset" || h == "x-entity-length",
            Protocol::GoogleResumable { .. } => h == "x-goog-upload-command" || h == "x-goog-upload-offset",
            Protocol::Single => false,
        }
    }

    pub fn chunk(&self) -> Option<u64> {
        match self {
            Protocol::Rupload { chunk } | Protocol::GoogleResumable { chunk } => *chunk,
            Protocol::Single => None,
        }
    }
}

/// What a value says about the file the caller passes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileFact {
    /// Its length in bytes, as decimal text.
    Size,
    /// Its file name, without the folder.
    Name,
}

/// Whether a header speaks an upload protocol: how the call is made, not what a page said, so its value is route
/// data unless it carries the file's own facts or an id made for the call.
pub fn protocol_header(header: &str) -> bool {
    let h = header.to_ascii_lowercase();
    h == "offset" || h.starts_with("x-entity-") || h.starts_with("x-goog-upload-")
}

/// One upload in a walk: the requests that sent one file, and what they show about it.
#[derive(Clone, Debug)]
pub(crate) struct Run {
    /// Every exchange of the run: the chunks, and the status probes and preflights to the same address among them.
    pub members: Vec<usize>,
    /// The last chunk: its answer is the one later steps read.
    pub last: usize,
    pub protocol: Protocol,
    /// The whole file's length.
    pub size: u64,
    pub content_type: Option<String>,
    /// The file's name, when the protocol says it.
    pub file_name: Option<String>,
}

fn content_length(ex: &Exchange) -> Option<u64> {
    ex.request_header("content-length").and_then(|v| v.trim().parse().ok())
}

fn number(ex: &Exchange, header: &str) -> Option<u64> {
    ex.request_header(header).and_then(|v| v.trim().parse().ok())
}

/// The protocol a request's headers speak, if it sends a chunk of a file.
fn speaks(ex: &Exchange) -> Option<Protocol> {
    if !matches!(ex.method.as_str(), "POST" | "PUT") {
        return None;
    }
    if ex.request_header("offset").is_some() && ex.request_header("x-entity-length").is_some() {
        return Some(Protocol::Rupload { chunk: None });
    }
    let command = ex.request_header("x-goog-upload-command").unwrap_or_default().to_ascii_lowercase();
    if command.split(',').any(|c| c.trim() == "upload") {
        return Some(Protocol::GoogleResumable { chunk: None });
    }
    None
}

fn address(ex: &Exchange) -> String {
    let mut u = ex.url.clone();
    u.set_fragment(None);
    u.to_string()
}

/// The uploads in a walk, in the order their last chunks went. A POST or PUT that speaks no protocol and recorded no
/// body is an upload too when its length is that of a file the walk was given (`inputs` holding its path).
pub(crate) fn runs(t: &Trace, inputs: &[Input]) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (i, ex) in t.exchanges.iter().enumerate() {
        let Some(kind) = speaks(ex) else { continue };
        let at = address(ex);
        if seen.contains(&at) {
            continue;
        }
        seen.push(at.clone());
        let same = |e: &Exchange| address(e) == at;
        let chunks: Vec<usize> = (i..t.exchanges.len()).filter(|&j| same(&t.exchanges[j]) && speaks(&t.exchanges[j]).is_some()).collect();
        let last = *chunks.last().unwrap_or(&i);
        let start = (0..=i).find(|&j| same(&t.exchanges[j])).unwrap_or(i);
        let members = (start..=last)
            .filter(|&j| same(&t.exchanges[j]) && (chunks.contains(&j) || matches!(t.exchanges[j].method.as_str(), "OPTIONS" | "GET" | "HEAD")))
            .collect();
        let chunk = (chunks.len() > 1).then(|| content_length(&t.exchanges[chunks[0]])).flatten();
        let end = &t.exchanges[last];
        let (protocol, size, file_name) = match kind {
            Protocol::Rupload { .. } => (Protocol::Rupload { chunk }, number(end, "x-entity-length"), None),
            _ => (
                Protocol::GoogleResumable { chunk },
                number(end, "x-goog-upload-offset").zip(content_length(end)).map(|(o, l)| o + l),
                end.request_header("x-goog-upload-file-name").map(String::from),
            ),
        };
        let content_type = end.request_header("content-type").map(String::from);
        out.push(Run { members, last, protocol, size: size.unwrap_or_default(), content_type, file_name });
    }
    // A body the recording lost whose length is a file the walk was given.
    let sizes: Vec<u64> = inputs.iter().filter_map(|inp| crate::files::size_of(&inp.value)).filter(|&s| s > 0).collect();
    if !sizes.is_empty() {
        for (i, ex) in t.exchanges.iter().enumerate() {
            let claimed = out.iter().any(|r| r.members.contains(&i));
            let len = content_length(ex).filter(|l| *l > 0);
            if claimed || speaks(ex).is_some() || ex.request_body.is_some() || !matches!(ex.method.as_str(), "POST" | "PUT") {
                continue;
            }
            if let Some(len) = len.filter(|l| sizes.contains(l)) {
                let at = address(ex);
                let members = (0..=i).filter(|&j| j == i || (address(&t.exchanges[j]) == at && t.exchanges[j].method == "OPTIONS")).collect();
                out.push(Run { members, last: i, protocol: Protocol::Single, size: len, content_type: ex.request_header("content-type").map(String::from), file_name: None });
            }
        }
    }
    out.sort_by_key(|r| r.last);
    out
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use crate::graph::{build, Body, Class, Graph};
    use crate::provenance::At;
    use crate::replay::{replay, Fetch, ReplayError, Request};
    use crate::slots::Loc;
    use crate::trace::{Exchange, Input, Trace};

    use super::{FileFact, Protocol};

    /// The walk's clock: the date its answers carry, and the upload id the page read off it then.
    const DATE: &str = "Fri, 30 Oct 2026 18:09:54 GMT";
    const ID: &str = "1793383794019";

    #[allow(clippy::too_many_arguments)]
    fn ex(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>, status: u16, answer_headers: &[(&str, &str)], answer: &str, mime: &str) -> Exchange {
        let mut response_headers: Vec<(String, String)> = answer_headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        response_headers.push(("date".into(), DATE.into()));
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: body.map(String::from),
            status,
            response_headers,
            response_body: (!answer.is_empty()).then(|| answer.to_string()),
            response_mime: mime.into(),
            resource_type: Some(if method == "OPTIONS" { "Preflight" } else { "XHR" }.into()),
            main_frame: Some(true),
        }
    }

    /// A reel posted the way the walk of a photo site did it: the video in chunks of 10,000 bytes to one address,
    /// with a status probe before each, then the cover in one request, then the call that publishes both under the
    /// upload id the page read off the clock.
    fn rupload_walk() -> Trace {
        let video = format!("https://up.photos.example/rupload_video/fb_uploader_{ID}");
        let cover = format!("https://up.photos.example/rupload_photo/fb_uploader_{ID}");
        let name = format!("fb_uploader_{ID}");
        let params = format!(r#"{{"is_clips_video":"1","media_type":2,"upload_id":"{ID}","upload_media_duration_ms":20000}}"#);
        let chunk = |offset: &str, len: &str, status: u16, answer: &str| {
            ex("POST", &video, &[("offset", offset), ("x-entity-length", "25000"), ("x-entity-name", &name), ("x-rupload-params", &params), ("content-length", len)], None, status, &[], answer, "application/json")
        };
        let probe = |offset: u64| ex("GET", &video, &[], None, 200, &[], &format!(r#"{{"offset":{offset}}}"#), "application/json");
        let partial = r#"{"debug_info":{"retriable":true,"type":"PartialRequestError"}}"#;
        Trace {
            exchanges: vec![
                ex("OPTIONS", &video, &[], None, 200, &[], "", ""),
                probe(0),
                chunk("0", "10000", 206, partial),
                probe(10000),
                chunk("10000", "10000", 206, partial),
                probe(20000),
                chunk("20000", "5000", 200, r#"{"media_id":3581928648639055,"status":"ok"}"#),
                ex("OPTIONS", &cover, &[], None, 200, &[], "", ""),
                ex(
                    "POST",
                    &cover,
                    &[("content-type", "image/jpeg"), ("offset", "0"), ("x-entity-length", "3000"), ("x-entity-name", &name), ("x-entity-type", "image/jpeg"), ("x-rupload-params", &format!(r#"{{"media_type":2,"upload_id":"{ID}"}}"#)), ("content-length", "3000")],
                    None,
                    200,
                    &[],
                    &format!(r#"{{"upload_id":"{ID}","status":"ok"}}"#),
                    "application/json",
                ),
                ex(
                    "POST",
                    "https://www.photos.example/api/v1/media/configure_to_clips/",
                    &[("content-type", "application/x-www-form-urlencoded")],
                    Some(&format!("caption=a+cat+at+midnight&upload_id={ID}&clips_share_preview_to_feed=1")),
                    200,
                    &[],
                    r#"{"media":{"id":"4019517101184670378","code":"DfIMYHYuFqq"},"status":"ok"}"#,
                    "application/json",
                ),
            ],
            inputs: vec![Input::new("caption", "a cat at midnight")],
        }
    }

    /// A video posted over a resumable session the way the walk of a video site did it: a start that names the file
    /// and its size and is answered with the session's address, the file in chunks of 100,000 bytes there, then the
    /// call that makes the video from the resource the start's answer named.
    fn resumable_walk() -> Trace {
        let session = "https://upload.video.example/?authuser=0&upload_id=AFy3sg1oZdRwS03-nrOJhfRCz7ghi2XwK2bHtpDzDTtoPC4NKw4kQ&upload_protocol=resumable";
        let start = "https://upload.video.example/upload/studio?authuser=0";
        let chunk = |command: &str, offset: &str, len: &str, status: &str| {
            ex(
                "POST",
                session,
                &[("content-type", "application/x-www-form-urlencoded;charset=utf-8"), ("x-goog-upload-command", command), ("x-goog-upload-file-name", "the-quiet-room-final.mp4"), ("x-goog-upload-offset", offset), ("content-length", len)],
                None,
                200,
                &[("x-goog-upload-status", status)],
                "<html><body>upload</body></html>",
                "text/html",
            )
        };
        Trace {
            exchanges: vec![
                ex("OPTIONS", start, &[], None, 200, &[], "", ""),
                ex(
                    "POST",
                    start,
                    &[
                        ("content-type", "application/x-www-form-urlencoded;charset=UTF-8"),
                        ("x-goog-upload-command", "start"),
                        ("x-goog-upload-file-name", "the-quiet-room-final.mp4"),
                        ("x-goog-upload-header-content-length", "250000"),
                        ("x-goog-upload-protocol", "resumable"),
                    ],
                    Some(r#"{"frontendUploadId":"innertube_studio:63B2544C-C0D7:0"}"#),
                    200,
                    &[("x-goog-upload-url", session), ("x-goog-upload-header-scotty-resource-id", "ABUX7uApjHKUnoHqkEkzO605Mpk"), ("x-goog-upload-status", "active")],
                    "",
                    "",
                ),
                ex("OPTIONS", session, &[], None, 200, &[], "", ""),
                chunk("upload", "0", "100000", "active"),
                ex("OPTIONS", session, &[], None, 200, &[], "", ""),
                chunk("upload", "100000", "100000", "active"),
                chunk("upload, finalize", "200000", "50000", "final"),
                ex(
                    "POST",
                    "https://studio.video.example/youtubei/v1/upload/createvideo",
                    &[("content-type", "application/json")],
                    Some(r#"{"resourceId":{"scottyResourceId":{"id":"ABUX7uApjHKUnoHqkEkzO605Mpk"}},"title":"The quiet room"}"#),
                    200,
                    &[],
                    r#"{"videoId":"eH8JdttKIdA","contents":{"title":"The quiet room"}}"#,
                    "application/json",
                ),
            ],
            inputs: vec![Input::new("title", "The quiet room")],
        }
    }

    fn field(g: &Graph, step: usize, loc: Loc) -> &Class {
        &g.steps[step].fields.iter().find(|f| f.loc == loc).unwrap_or_else(|| panic!("no {loc} in step {step}: {:?}", g.steps[step].fields)).class
    }

    fn header(req: &Request, name: &str) -> Option<String> {
        req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }

    /// A folder of its own for one test's files, the file root its site reads from.
    fn root(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("unbrowse-upload-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(dir.join("root")).unwrap();
        dir.canonicalize().unwrap()
    }

    fn bytes(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    /// A site that answers each request with what `answer` makes of it, remembering what it was sent.
    struct Site<F: FnMut(&Request) -> (u16, Vec<(String, String)>, String)> {
        root: PathBuf,
        seen: Vec<Request>,
        answer: F,
    }

    impl<F: FnMut(&Request) -> (u16, Vec<(String, String)>, String)> Fetch for Site<F> {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.seen.push(req.clone());
            let (status, response_headers, body) = (self.answer)(req);
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: req.headers.clone(),
                request_body: req.body.as_deref().map(unbrowse_route::wire::carried),
                status,
                response_headers,
                response_body: Some(body),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }

        fn file_root(&self) -> PathBuf {
            self.root.join("root")
        }
    }

    #[test]
    fn a_run_of_chunks_and_probes_to_one_address_is_one_upload_step() {
        let g = build(&[rupload_walk()], |e| e.url.path().contains("configure")).unwrap();
        println!("{}", g.describe());
        assert_eq!(g.steps.len(), 3, "the video, the cover, the publishing call");
        assert_eq!(g.steps.iter().map(|s| s.method.as_str()).collect::<Vec<_>>(), ["POST", "POST", "POST"], "no probe or preflight is a step");
        match &g.steps[0].body {
            Some(Body::Upload { input, protocol, .. }) => {
                assert_eq!(input, "file");
                assert_eq!(protocol, &Protocol::Rupload { chunk: Some(10000) });
            }
            other => panic!("the video is an upload, not {other:?}"),
        }
        match &g.steps[1].body {
            Some(Body::Upload { input, protocol, content_type }) => {
                assert_eq!(input, "file_2", "the cover is a second file");
                assert_eq!(protocol, &Protocol::Rupload { chunk: None }, "sent in one request");
                assert_eq!(content_type.as_deref(), Some("image/jpeg"));
            }
            other => panic!("the cover is an upload, not {other:?}"),
        }
        assert_eq!(g.steps[0].status, 200, "the last chunk's answer is the step's");
        for step in &g.steps[..2] {
            assert!(!step.fields.iter().any(|f| matches!(&f.loc, Loc::Header(h) if h == "offset" || h == "x-entity-length")), "the protocol sets each chunk's place and the file's length");
        }
        assert!(!g.provisional, "{}", g.describe());
    }

    #[test]
    fn an_upload_id_the_page_read_off_the_clock_is_made_anew() {
        let g = build(&[rupload_walk()], |e| e.url.path().contains("configure")).unwrap();
        let fresh = |c: &Class| matches!(c, Class::Fresh { id, .. } if id == ID);
        assert!(fresh(field(&g, 0, Loc::Path(1))), "in the upload's address");
        assert!(fresh(field(&g, 0, Loc::Header("x-entity-name".into()))));
        assert!(fresh(field(&g, 0, Loc::Header("x-rupload-params".into()))), "inside the JSON a header carries");
        assert!(fresh(field(&g, 1, Loc::Path(1))));
        assert!(fresh(field(&g, 2, Loc::Form("upload_id".into()))), "in the publishing call, though the cover's answer echoed it");
        assert!(matches!(field(&g, 1, Loc::Header("x-entity-type".into())), Class::Constant { .. }), "an upload protocol's header is route data");
        assert!(matches!(field(&g, 2, Loc::Form("caption".into())), Class::Input { name, .. } if name == "caption"));

        // A number shaped like a clock reading sent in one place only, or one an earlier answer gave, is not one.
        let mut once = rupload_walk();
        once.exchanges.truncate(7);
        let g = build(&[once], |e| e.method == "POST").unwrap();
        assert!(g.steps.iter().flat_map(|s| &s.fields).all(|f| !matches!(f.class, Class::Fresh { .. })), "one place is not a tie between steps");
        // A server's token that embeds the second it was issued, and a page's timestamp from minutes before the upload,
        // are sent to many addresses too, yet the page did not make them for the call.
        let mut older = rupload_walk();
        for e in older.exchanges.iter_mut().filter(|e| e.method == "POST") {
            e.request_headers.push(("x-token".into(), "NAfxQ2c9:17:1793383584".into()));
            e.request_headers.push(("x-spin-t".into(), "1793383590".into()));
        }
        let g = build(&[older], |e| e.url.path().contains("configure")).unwrap();
        for h in ["x-token", "x-spin-t"] {
            assert!(!matches!(field(&g, 2, Loc::Header(h.into())), Class::Fresh { .. }), "{h}");
        }
        assert!(matches!(field(&g, 2, Loc::Form("upload_id".into())), Class::Fresh { .. }), "the upload's own id still is");
        let mut given = rupload_walk();
        given.exchanges.insert(0, ex("GET", "https://www.photos.example/api/v1/session/", &[], None, 200, &[], &format!(r#"{{"upload_id":"{ID}"}}"#), "application/json"));
        let g = build(&[given], |e| e.url.path().contains("configure")).unwrap();
        assert!(g.steps.iter().flat_map(|s| &s.fields).all(|f| !matches!(f.class, Class::Fresh { .. })), "a value the site handed out is the site's");
    }

    #[test]
    fn a_resumable_session_starts_as_its_own_step_and_the_upload_goes_where_its_answer_says() {
        let g = build(&[resumable_walk()], |e| e.url.path().ends_with("createvideo")).unwrap();
        println!("{}", g.describe());
        assert_eq!(g.steps.len(), 3, "the start, the upload, the call that makes the video");
        assert!(g.steps[0].url.contains("/upload/studio"));
        assert!(matches!(field(&g, 0, Loc::Header("x-goog-upload-header-content-length".into())), Class::File { name, of: FileFact::Size } if name == "file"));
        assert!(matches!(field(&g, 0, Loc::Header("x-goog-upload-file-name".into())), Class::File { name, of: FileFact::Name } if name == "file"));
        assert!(matches!(field(&g, 0, Loc::Header("x-goog-upload-protocol".into())), Class::Constant { .. }));
        assert!(matches!(&g.steps[1].body, Some(Body::Upload { input, protocol: Protocol::GoogleResumable { chunk: Some(100000) }, .. }) if input == "file"));
        assert!(matches!(field(&g, 1, Loc::Url), Class::Derived { origin } if origin.exchange == g.steps[0].exchange && origin.at == At::Header { name: "x-goog-upload-url".into() }));
        assert!(!g.steps[1].fields.iter().any(|f| matches!(f.loc, Loc::Query(_))), "the session's address is taken whole");
        assert!(matches!(field(&g, 1, Loc::Header("x-goog-upload-file-name".into())), Class::File { of: FileFact::Name, .. }));
        assert!(matches!(field(&g, 2, Loc::Json("/resourceId/scottyResourceId/id".into())), Class::Derived { origin } if origin.at == At::Header { name: "x-goog-upload-header-scotty-resource-id".into() }));
    }

    #[test]
    fn a_replay_sends_the_new_files_bytes_in_chunks_under_a_new_upload_id() {
        let g = build(&[rupload_walk()], |e| e.url.path().contains("configure")).unwrap();
        let dir = root("rupload");
        let (video, cover) = (bytes(23456, 7), bytes(1234, 99));
        std::fs::write(dir.join("root/new-reel.mp4"), &video).unwrap();
        std::fs::write(dir.join("root/new-cover.jpg"), &cover).unwrap();
        let mut site = Site {
            root: dir.clone(),
            seen: vec![],
            answer: |req: &Request| {
                let path = req.url.path().to_string();
                let id = path.rsplit('_').next().unwrap_or_default().to_string();
                if path.contains("rupload_video") {
                    let end = header(req, "offset").unwrap().parse::<usize>().unwrap() + req.body.as_ref().unwrap().len();
                    if end < header(req, "x-entity-length").unwrap().parse::<usize>().unwrap() {
                        return (206, vec![], r#"{"debug_info":{"type":"PartialRequestError"}}"#.into());
                    }
                    return (200, vec![], r#"{"media_id":1,"status":"ok"}"#.into());
                }
                if path.contains("rupload_photo") {
                    return (200, vec![], format!(r#"{{"upload_id":"{id}","status":"ok"}}"#));
                }
                (200, vec![], r#"{"media":{"id":"m2","code":"xyz"},"status":"ok"}"#.into())
            },
        };
        let inputs: HashMap<String, String> = [("file", "new-reel.mp4"), ("file_2", "new-cover.jpg"), ("caption", "a dog at dawn")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        let run = replay(&g, &inputs, &mut site).unwrap();
        assert_eq!(run.target.status, 200);

        let seen = &site.seen;
        assert_eq!(seen.len(), 5, "three chunks of the video, the cover, the publishing call");
        let new_id = seen[0].url.path().rsplit('_').next().unwrap().to_string();
        assert_eq!(new_id.len(), 13);
        assert_ne!(new_id, ID, "a new upload id on every call");
        let chunks = &seen[..3];
        assert_eq!(chunks.iter().map(|r| header(r, "offset").unwrap()).collect::<Vec<_>>(), ["0", "10000", "20000"]);
        assert!(chunks.iter().all(|r| header(r, "x-entity-length").as_deref() == Some("23456")), "the new file's length");
        assert_eq!(chunks.iter().map(|r| r.body.as_ref().unwrap().len()).collect::<Vec<_>>(), [10000, 10000, 3456]);
        assert_eq!(chunks.iter().flat_map(|r| r.body.clone().unwrap()).collect::<Vec<u8>>(), video, "the new file's bytes, in order");
        assert_eq!(seen[3].body.as_deref(), Some(cover.as_slice()));
        assert_eq!(header(&seen[3], "x-entity-length").as_deref(), Some("1234"));
        for r in &seen[..4] {
            assert!(r.url.path().ends_with(&format!("fb_uploader_{new_id}")), "{}", r.url);
            assert_eq!(header(r, "x-entity-name"), Some(format!("fb_uploader_{new_id}")));
            assert!(header(r, "x-rupload-params").unwrap().contains(&format!(r#""upload_id":"{new_id}""#)));
        }
        let form = seen[4].text().unwrap();
        assert!(form.contains(&format!("upload_id={new_id}")) && form.contains("caption=a+dog+at+dawn"), "{form}");
        assert!(!seen.iter().any(|r| format!("{:?}{}", r.headers, r.url).contains(ID)), "the walk's id is sent nowhere");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The chunks a site took stay taken: a later chunk it refuses never says nothing was sent, so the upload isn't
    /// run again as it was.
    #[test]
    fn a_chunk_refused_part_way_never_says_the_upload_was_not_sent() {
        let g = build(&[rupload_walk()], |e| e.url.path().contains("configure")).unwrap();
        let dir = root("rupload-part");
        std::fs::write(dir.join("root/new-reel.mp4"), bytes(23456, 7)).unwrap();
        std::fs::write(dir.join("root/new-cover.jpg"), bytes(1234, 99)).unwrap();
        let mut site = Site {
            root: dir.clone(),
            seen: vec![],
            answer: |req: &Request| match header(req, "offset").as_deref() {
                Some("0") => (206, vec![], "{}".to_string()),
                _ => (400, vec![], "{}".to_string()),
            },
        };
        let inputs: HashMap<String, String> = [("file", "new-reel.mp4"), ("file_2", "new-cover.jpg"), ("caption", "a dog at dawn")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        let mut ledger = crate::ledger::Ledger::of(&g);
        assert!(crate::replay::replay_ledgered(&g, &inputs, &mut site, &mut ledger).is_err());
        assert_eq!(site.seen.len(), 2, "the first chunk taken, the second refused");
        assert!(ledger.possible_commit(), "{:?}", ledger.marks);
        assert_ne!(ledger.retry(true), crate::ledger::Retry::AsIs);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The target is the route's last step, and everything reads it as that. An upload the walk made after it, even one
    /// the target's own answer opened, isn't part of what it answers.
    #[test]
    fn a_route_ends_at_its_target_whatever_the_walk_did_after_it() {
        let g = build(&[resumable_walk()], |e| e.url.path().ends_with("/upload/studio")).unwrap();
        assert!(g.steps.last().is_some_and(|s| s.url.contains("/upload/studio")), "{:?}", g.steps.iter().map(|s| &s.url).collect::<Vec<_>>());
    }

    #[test]
    fn a_replay_opens_a_new_session_and_uploads_where_its_answer_says() {
        let g = build(&[resumable_walk()], |e| e.url.path().ends_with("createvideo")).unwrap();
        let dir = root("resumable");
        let video = bytes(230000, 3);
        std::fs::write(dir.join("root/holiday.mp4"), &video).unwrap();
        let session = "https://upload.video.example/?authuser=0&upload_id=NEWSESSION42&upload_protocol=resumable";
        let mut site = Site {
            root: dir.clone(),
            seen: vec![],
            answer: |req: &Request| match req.url.path() {
                "/upload/studio" => (200, vec![("x-goog-upload-url".into(), session.into()), ("x-goog-upload-header-scotty-resource-id".into(), "RES_new_789".into())], String::new()),
                "/" => (200, vec![("x-goog-upload-status".into(), "active".into())], "<html></html>".into()),
                _ => (200, vec![], r#"{"videoId":"new","contents":{"title":"x"}}"#.into()),
            },
        };
        let inputs: HashMap<String, String> = [("file".to_string(), "holiday.mp4".to_string())].into_iter().collect();
        replay(&g, &inputs, &mut site).unwrap();
        let seen = &site.seen;
        assert_eq!(seen.len(), 5, "the start, three chunks, the call that makes the video");
        assert_eq!(header(&seen[0], "x-goog-upload-header-content-length").as_deref(), Some("230000"), "the new file's size");
        assert_eq!(header(&seen[0], "x-goog-upload-file-name").as_deref(), Some("holiday.mp4"), "the new file's name");
        assert_eq!(header(&seen[0], "x-goog-upload-command").as_deref(), Some("start"));
        let chunks = &seen[1..4];
        assert!(chunks.iter().all(|r| r.url.as_str() == session), "the session the new start opened");
        assert_eq!(chunks.iter().map(|r| header(r, "x-goog-upload-command").unwrap()).collect::<Vec<_>>(), ["upload", "upload", "upload, finalize"]);
        assert_eq!(chunks.iter().map(|r| header(r, "x-goog-upload-offset").unwrap()).collect::<Vec<_>>(), ["0", "100000", "200000"]);
        assert_eq!(chunks.iter().flat_map(|r| r.body.clone().unwrap()).collect::<Vec<u8>>(), video);
        assert!(chunks.iter().all(|r| header(r, "x-goog-upload-file-name").as_deref() == Some("holiday.mp4")));
        assert!(seen[4].text().unwrap().contains("RES_new_789"), "the resource the new start named");

        // An answer that hands the upload to another origin is never followed: the file stays here.
        let mut elsewhere = Site {
            root: dir.clone(),
            seen: vec![],
            answer: |req: &Request| match req.url.path() {
                "/upload/studio" => (200, vec![("x-goog-upload-url".into(), "https://sink.attacker.example/?upload_id=1".into())], String::new()),
                _ => (200, vec![], "{}".into()),
            },
        };
        assert!(matches!(replay(&g, &inputs, &mut elsewhere), Err(ReplayError::Transport(_))));
        assert_eq!(elsewhere.seen.len(), 1, "no byte of the file went anywhere");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_outside_the_file_root_is_never_read() {
        let g = build(&[rupload_walk()], |e| e.url.path().contains("configure")).unwrap();
        let dir = root("outside");
        std::fs::write(dir.join("private.mp4"), bytes(20000, 1)).unwrap();
        std::fs::write(dir.join("root/new-cover.jpg"), bytes(100, 1)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("private.mp4"), dir.join("root/linked.mp4")).unwrap();
        let mut names = vec![dir.join("private.mp4").to_string_lossy().into_owned(), "../private.mp4".to_string(), "/etc/passwd".to_string()];
        if cfg!(unix) {
            names.push("linked.mp4".into());
        }
        for name in names {
            let mut site = Site { root: dir.clone(), seen: vec![], answer: |_: &Request| (200, vec![], "{}".to_string()) };
            let inputs: HashMap<String, String> = [("file", name.as_str()), ("file_2", "new-cover.jpg")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
            let r = replay(&g, &inputs, &mut site);
            assert!(matches!(&r, Err(ReplayError::File { input, .. }) if input == "file"), "{name}: {:?}", r.err());
            assert!(site.seen.is_empty(), "{name}: nothing was sent");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
