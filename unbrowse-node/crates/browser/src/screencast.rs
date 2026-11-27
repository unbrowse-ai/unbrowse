//! Pictures of a walk: what the browser shows while it walks, for someone
//! watching. Chrome's own screencast (`Page.startScreencast`) hands over
//! frames as the page paints, in [`FORMAT`]; this keeps a few a second, small, and one more
//! taken when the walk settles, so the last picture is the page as it ended.
//!
//! Only pixels leave here: never a URL, a header or a cookie.

use std::time::{Duration, Instant};

use base64::Engine;

use crate::cdp::client::CdpClient;

/// One picture of the page, as Chrome encoded it ([`FORMAT`]; the field keeps its old name).
#[derive(Clone, Debug)]
pub struct Frame {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Taken as the walk ended: the page as it settled.
    pub settled: bool,
}

/// Where a walk's pictures go.
pub type FrameSink = std::sync::mpsc::Sender<Frame>;

/// The fewest milliseconds between two pictures passed on (about three a second).
pub const EVERY_MS: u64 = 300;
/// The widest picture, in pixels: enough to see a page, small enough to pass around.
pub const MAX_WIDTH: u32 = 640;
const QUALITY: u32 = 55;

/// What a picture is encoded as: one the owner's window on this machine can draw. The window on a Mac decodes any
/// image (ImageIO), so it gets the smaller JPEG; elsewhere it decodes PNG itself and nothing else, so it gets PNG.
pub const FORMAT: &str = if cfg!(target_os = "macos") { "jpeg" } else { "png" };

/// Chrome's settings for one picture in [`FORMAT`]: a JPEG's quality, nothing for a PNG.
pub fn encoding(quality: u32) -> serde_json::Value {
    match FORMAT {
        "jpeg" => serde_json::json!({ "format": "jpeg", "quality": quality }),
        f => serde_json::json!({ "format": f }),
    }
}

/// A walk's screencast: started on the page's session, fed the session's raw
/// messages, and ended with one settled picture.
pub struct Screencast {
    sink: FrameSink,
    last: Option<Instant>,
    /// A frame that came too soon after the last, passed on once it is due (the page may not paint again).
    held: Option<Frame>,
    /// When the last frame acknowledged was painted: a frame seen twice (by `pump`, then by the walk's own loop)
    /// is taken once.
    acked: f64,
    /// Its own line to the browser while the walk waits at a door, before the walk's loop reads messages.
    early: Option<tokio::sync::broadcast::Receiver<crate::cdp::client::RawCdpMessage>>,
}

impl Screencast {
    /// Starts Chrome's screencast on `session_id`; None if Chrome refuses.
    pub async fn start(client: &CdpClient, session_id: &str, sink: FrameSink) -> Option<Self> {
        client
            .send_command(
                "Page.startScreencast",
                Some({
                    let mut p = encoding(QUALITY);
                    p["maxWidth"] = MAX_WIDTH.into();
                    p["maxHeight"] = MAX_WIDTH.into();
                    p["everyNthFrame"] = 1.into();
                    p
                }),
                Some(session_id),
            )
            .await
            .ok()?;
        let early = Some(client.subscribe_raw());
        Some(Screencast { sink, last: None, held: None, acked: 0.0, early })
    }

    /// Takes pictures for `wait` while the walk waits at the door (a challenge paints too).
    pub async fn pump(&mut self, client: &CdpClient, session_id: &str, wait: Duration) {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            self.tick();
            let Some(rx) = self.early.as_mut() else { return tokio::time::sleep_until(deadline).await };
            let got = match tokio::time::timeout_at(deadline.min(tokio::time::Instant::now() + Duration::from_millis(EVERY_MS)), rx.recv()).await {
                Err(_) if tokio::time::Instant::now() < deadline => continue,
                Err(_) => return,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(_)) => return tokio::time::sleep_until(deadline).await,
                Ok(Ok(m)) => m,
            };
            if got.text.contains("\"Page.screencastFrame\"") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&got.text) {
                    self.take(client, session_id, &v).await;
                }
            }
        }
    }

    /// The door is passed: the walk's own loop reads the frames from here on.
    pub fn stop_pumping(&mut self) {
        self.early = None;
    }

    /// Takes one message from the browser. A screencast frame is acknowledged
    /// (Chrome sends the next only then) and passed on if one is due; returns
    /// whether the message was a frame.
    pub async fn take(&mut self, client: &CdpClient, session_id: &str, msg: &serde_json::Value) -> bool {
        if msg.get("method").and_then(|m| m.as_str()) != Some("Page.screencastFrame") {
            return false;
        }
        // Chrome's `sessionId` names the screencast, not the frame: a frame is told apart by when it was painted.
        let painted = msg.pointer("/params/metadata/timestamp").and_then(|t| t.as_f64()).unwrap_or(0.0);
        if painted > 0.0 && painted <= self.acked {
            return true;
        }
        self.acked = painted;
        if let Some(ack) = msg.pointer("/params/sessionId").and_then(|s| s.as_u64()) {
            // Not awaited for its answer's sake: the ack only lets the next frame come.
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                client.send_command("Page.screencastFrameAck", Some(serde_json::json!({ "sessionId": ack })), Some(session_id)),
            )
            .await;
        }
        if let Some(f) = frame_of(msg) {
            self.held = Some(f);
        }
        self.tick();
        true
    }

    /// Passes on the held frame if one is due: called for every message the walk reads, so the last picture of
    /// a burst of paints still goes out a moment later.
    pub fn tick(&mut self) {
        let now = Instant::now();
        if self.held.is_some() && due(self.last, now) {
            self.last = Some(now);
            let _ = self.sink.send(self.held.take().expect("held"));
        }
    }

    /// Stops the screencast and passes on one picture of the page as it settled.
    pub async fn settle(self, client: &CdpClient, session_id: &str) {
        let _ = tokio::time::timeout(Duration::from_secs(2), client.send_command("Page.stopScreencast", None, Some(session_id))).await;
        // The viewport, scaled to the screencast's width: the poster is the same size as the frames before it.
        let metrics = tokio::time::timeout(Duration::from_secs(2), client.send_command("Page.getLayoutMetrics", None, Some(session_id))).await;
        let mut params = encoding(QUALITY);
        params["optimizeForSpeed"] = true.into();
        if let Ok(Ok(m)) = metrics {
            let dim = |k: &str| m.pointer(&format!("/cssVisualViewport/{k}")).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let (w, h) = (dim("clientWidth"), dim("clientHeight"));
            if w > 0.0 && h > 0.0 {
                let scale = (MAX_WIDTH as f64 / w).min(1.0);
                params["clip"] = serde_json::json!({ "x": dim("pageX"), "y": dim("pageY"), "width": w, "height": h, "scale": scale });
            }
        }
        let shot = tokio::time::timeout(Duration::from_secs(3), client.send_command("Page.captureScreenshot", Some(params), Some(session_id))).await;
        let Ok(Ok(v)) = shot else { return };
        let Some(jpeg) = v.get("data").and_then(|d| d.as_str()).and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()) else {
            return;
        };
        // A full-size screenshot: its size is read from the picture itself.
        let (width, height) = picture_size(&jpeg).unwrap_or((0, 0));
        let _ = self.sink.send(Frame { jpeg, width, height, settled: true });
    }
}

/// Whether a frame is due, the last having gone at `last`.
pub fn due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|l| now.duration_since(l) >= Duration::from_millis(EVERY_MS))
}

/// The picture in a `Page.screencastFrame` message.
pub fn frame_of(msg: &serde_json::Value) -> Option<Frame> {
    let data = msg.pointer("/params/data")?.as_str()?;
    let jpeg = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    let (width, height) = picture_size(&jpeg).unwrap_or_else(|| {
        let m = |k: &str| msg.pointer(&format!("/params/metadata/{k}")).and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
        (m("deviceWidth"), m("deviceHeight"))
    });
    Some(Frame { jpeg, width, height, settled: false })
}

/// A picture's pixel size, read from a PNG's header or a JPEG's first start-of-frame marker.
pub fn picture_size(b: &[u8]) -> Option<(u32, u32)> {
    png_size(b).or_else(|| jpeg_size(b))
}

/// A PNG's pixel size, from its IHDR chunk.
pub fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..8)? != b"\x89PNG\r\n\x1a\n" || b.get(12..16)? != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(b.get(16..20)?.try_into().ok()?);
    let h = u32::from_be_bytes(b.get(20..24)?.try_into().ok()?);
    Some((w, h))
}

/// A JPEG's pixel size, from its first start-of-frame marker.
pub fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest JPEG header that names a size: SOI, an APP0 to skip, SOF0.
    fn tiny_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0xFF, 0xD9]);
        b
    }

    #[test]
    fn a_frame_is_its_pixels_and_their_size() {
        let jpeg = tiny_jpeg(640, 400);
        let msg = serde_json::json!({
            "method": "Page.screencastFrame",
            "params": { "data": base64::engine::general_purpose::STANDARD.encode(&jpeg), "sessionId": 7,
                        "metadata": { "deviceWidth": 1280, "deviceHeight": 800 } },
        });
        let f = frame_of(&msg).unwrap();
        assert_eq!((f.width, f.height), (640, 400));
        assert_eq!(f.jpeg, jpeg);
        assert!(!f.settled);
        assert_eq!(jpeg_size(b"not a jpeg"), None);
    }

    /// The window off a Mac draws PNG and nothing else: a picture it is sent must be one, or it shows nothing.
    #[test]
    fn a_picture_is_in_a_format_the_window_on_this_machine_draws() {
        assert_eq!(FORMAT, if cfg!(target_os = "macos") { "jpeg" } else { "png" });
        assert_eq!(encoding(55)["format"], FORMAT);
        assert_eq!(encoding(55).get("quality").is_some(), FORMAT == "jpeg", "only a JPEG has a quality");
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&400u32.to_be_bytes());
        let msg = serde_json::json!({
            "method": "Page.screencastFrame",
            "params": { "data": base64::engine::general_purpose::STANDARD.encode(&png), "sessionId": 7,
                        "metadata": { "deviceWidth": 1280, "deviceHeight": 800 } },
        });
        assert_eq!(frame_of(&msg).map(|f| (f.width, f.height)), Some((640, 400)), "a PNG frame's size is its own");
        assert_eq!(picture_size(&tiny_jpeg(320, 200)), Some((320, 200)));
        assert_eq!(png_size(b"not a png"), None);
    }

    #[test]
    fn a_frame_that_comes_too_soon_waits_and_still_goes() {
        let (sink, got) = std::sync::mpsc::channel();
        let f = Frame { jpeg: vec![1], width: 1, height: 1, settled: false };
        let mut cast = Screencast { sink, last: Some(Instant::now()), held: Some(f), acked: 0.0, early: None };
        cast.tick();
        assert!(got.try_recv().is_err(), "too soon after the last");
        cast.last = Some(Instant::now() - Duration::from_millis(EVERY_MS));
        cast.tick();
        assert_eq!(got.try_recv().unwrap().jpeg, vec![1]);
        assert!(cast.held.is_none());
    }

    #[test]
    fn frames_are_kept_a_few_a_second() {
        let t0 = Instant::now();
        assert!(due(None, t0));
        assert!(!due(Some(t0), t0 + Duration::from_millis(EVERY_MS - 1)));
        assert!(due(Some(t0), t0 + Duration::from_millis(EVERY_MS)));
    }

    // ---- a browser on a local socket, driven by the test ----

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
    use tokio_tungstenite::tungstenite::Message;

    struct FakeBrowser {
        client: CdpClient,
        /// Every command the browser was sent, as (method, params, sessionId).
        seen: UnboundedReceiver<(String, Value, Option<String>)>,
        push: UnboundedSender<String>,
    }

    /// A browser answering each command with `reply(method)`: a result, or an error message.
    async fn fake_browser(reply: fn(&str) -> Result<Value, String>) -> FakeBrowser {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (seen_tx, seen) = unbounded_channel();
        let (push, mut push_rx) = unbounded_channel::<String>();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            loop {
                tokio::select! {
                    msg = ws.next() => {
                        let Some(Ok(Message::Text(text))) = msg else { break };
                        let cmd: Value = serde_json::from_str(&text).unwrap();
                        let method = cmd["method"].as_str().unwrap().to_string();
                        let _ = seen_tx.send((method.clone(), cmd["params"].clone(), cmd["sessionId"].as_str().map(String::from)));
                        let answer = match reply(&method) {
                            Err(message) if message == "silent" => continue,
                            Ok(result) => json!({"id": cmd["id"], "result": result}),
                            Err(message) => json!({"id": cmd["id"], "error": {"code": -32000, "message": message}}),
                        };
                        if ws.send(Message::Text(answer.to_string())).await.is_err() { break }
                    }
                    Some(text) = push_rx.recv() => {
                        if ws.send(Message::Text(text)).await.is_err() { break }
                    }
                }
            }
        });
        FakeBrowser { client: CdpClient::connect(&url).await.unwrap(), seen, push }
    }

    fn accept_all(_: &str) -> Result<Value, String> {
        Ok(json!({}))
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&w.to_be_bytes());
        png.extend_from_slice(&h.to_be_bytes());
        png
    }

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    fn frame_msg(data: &[u8], ack: u64, timestamp: f64) -> Value {
        json!({"method": "Page.screencastFrame",
               "params": {"data": b64(data), "sessionId": ack, "metadata": {"timestamp": timestamp, "deviceWidth": 10, "deviceHeight": 20}}})
    }

    fn cast_to(sink: FrameSink) -> Screencast {
        Screencast { sink, last: None, held: None, acked: 0.0, early: None }
    }

    async fn next_seen(b: &mut FakeBrowser) -> (String, Value, Option<String>) {
        tokio::time::timeout(Duration::from_secs(10), b.seen.recv()).await.expect("the browser was sent a command").expect("line open")
    }

    #[tokio::test]
    async fn a_screencast_starts_small_on_the_walks_session() {
        let mut b = fake_browser(accept_all).await;
        let (sink, _got) = std::sync::mpsc::channel();
        let cast = Screencast::start(&b.client, "S1", sink).await;
        assert!(cast.is_some_and(|c| c.early.is_some() && c.held.is_none()));
        let (method, p, session) = next_seen(&mut b).await;
        assert_eq!(method, "Page.startScreencast");
        assert_eq!(session.as_deref(), Some("S1"));
        assert_eq!((p["maxWidth"].as_u64(), p["maxHeight"].as_u64(), p["everyNthFrame"].as_u64()), (Some(640), Some(640), Some(1)));
        assert_eq!(p["format"], FORMAT);
    }

    #[tokio::test]
    async fn a_browser_that_refuses_the_screencast_gives_none() {
        let b = fake_browser(|_| Err("no screencast".into())).await;
        let (sink, _got) = std::sync::mpsc::channel();
        assert!(Screencast::start(&b.client, "S1", sink).await.is_none());
    }

    #[tokio::test]
    async fn a_message_that_is_not_a_frame_is_left_alone() {
        let mut b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = cast_to(sink);
        assert!(!cast.take(&b.client, "S1", &json!({"method": "Page.loadEventFired"})).await);
        assert!(!cast.take(&b.client, "S1", &json!({"id": 3, "result": {}})).await);
        assert!(got.try_recv().is_err());
        assert!(tokio::time::timeout(Duration::from_millis(100), b.seen.recv()).await.is_err(), "nothing acknowledged");
    }

    #[tokio::test]
    async fn a_frame_is_acknowledged_so_the_next_comes_and_is_passed_on() {
        let mut b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = cast_to(sink);
        assert!(cast.take(&b.client, "S1", &frame_msg(&png(30, 40), 9, 5.0)).await);
        let (method, p, session) = next_seen(&mut b).await;
        assert_eq!((method.as_str(), p["sessionId"].as_u64(), session.as_deref()), ("Page.screencastFrameAck", Some(9), Some("S1")));
        let f = got.try_recv().expect("the first frame is due at once");
        assert_eq!((f.width, f.height, f.settled), (30, 40, false));
        assert_eq!(cast.acked, 5.0);
    }

    #[tokio::test]
    async fn a_frame_seen_twice_is_taken_once() {
        let mut b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = cast_to(sink);
        assert!(cast.take(&b.client, "S1", &frame_msg(&png(1, 1), 1, 7.0)).await);
        next_seen(&mut b).await;
        got.try_recv().unwrap();
        cast.last = None;
        assert!(cast.take(&b.client, "S1", &frame_msg(&png(2, 2), 2, 7.0)).await, "still a frame");
        assert!(got.try_recv().is_err(), "the repeat was not passed on");
        assert!(tokio::time::timeout(Duration::from_millis(100), b.seen.recv()).await.is_err(), "nor acknowledged");
        assert!(cast.held.is_none());
    }

    #[tokio::test]
    async fn a_frame_that_cannot_be_decoded_is_dropped_but_still_acknowledged() {
        let mut b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = cast_to(sink);
        let bad = json!({"method": "Page.screencastFrame", "params": {"data": "***", "sessionId": 4}});
        assert!(cast.take(&b.client, "S1", &bad).await);
        assert_eq!(next_seen(&mut b).await.0, "Page.screencastFrameAck");
        assert!(got.try_recv().is_err());
    }

    #[test]
    fn a_frame_whose_picture_has_no_size_takes_the_size_chrome_reported() {
        let msg = frame_msg(b"opaque bytes", 1, 1.0);
        let f = frame_of(&msg).unwrap();
        assert_eq!((f.width, f.height), (10, 20));
        assert!(frame_of(&json!({"params": {}})).is_none());
        assert!(frame_of(&json!({"params": {"data": 5}})).is_none());
        assert!(frame_of(&json!({"params": {"data": "***"}})).is_none());
    }

    #[test]
    fn a_picture_header_that_is_cut_short_or_wrong_names_no_size() {
        assert_eq!(png_size(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dXXXX\x00\x00\x00\x01\x00\x00\x00\x01"), None, "no IHDR");
        assert_eq!(png_size(&png(3, 4)[..20]), None, "cut inside the width");
        assert_eq!(png_size(&png(3, 4)[..22]), None, "cut inside the height");
        assert_eq!(png_size(&png(3, 4)), Some((3, 4)));
        assert_eq!(jpeg_size(&[0xFF, 0xD8]), None, "no frame marker");
        // A DHT (C4) segment is skipped over, not read as a frame.
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xC4, 0x00, 0x04, 0x00, 0x00];
        j.extend_from_slice(&tiny_jpeg(50, 60)[2..]);
        assert_eq!(jpeg_size(&j), Some((50, 60)));
        // Bytes between markers are stepped over one at a time.
        let mut k = vec![0xFF, 0xD8, 0x00, 0x00];
        k.extend_from_slice(&tiny_jpeg(7, 8)[2..]);
        assert_eq!(jpeg_size(&k), Some((7, 8)));
        // A segment is skipped by its own length: bytes inside it, a stray FF among them, are not markers.
        let mut m = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x06, 0x00, 0x00, 0x00, 0xFF];
        m.extend_from_slice(&tiny_jpeg(70, 80)[8..]);
        assert_eq!(jpeg_size(&m), Some((70, 80)));
        assert!(!due(Some(Instant::now()), Instant::now()));
    }

    fn settle_replies(method: &str) -> Result<Value, String> {
        match method {
            "Page.getLayoutMetrics" => Ok(json!({"cssVisualViewport": {"clientWidth": 1280.0, "clientHeight": 800.0, "pageX": 3.0, "pageY": 9.0}})),
            "Page.captureScreenshot" => Ok(json!({"data": b64(&png(640, 400))})),
            _ => Ok(json!({})),
        }
    }

    #[tokio::test]
    async fn a_settled_walk_ends_the_cast_and_sends_one_last_picture_at_the_frames_size() {
        let mut b = fake_browser(settle_replies).await;
        let (sink, got) = std::sync::mpsc::channel();
        cast_to(sink).settle(&b.client, "S1").await;
        assert_eq!(next_seen(&mut b).await.0, "Page.stopScreencast");
        assert_eq!(next_seen(&mut b).await.0, "Page.getLayoutMetrics");
        let (method, p, session) = next_seen(&mut b).await;
        assert_eq!((method.as_str(), session.as_deref()), ("Page.captureScreenshot", Some("S1")));
        assert_eq!(p["optimizeForSpeed"], true);
        assert_eq!(p["clip"], json!({"x": 3.0, "y": 9.0, "width": 1280.0, "height": 800.0, "scale": 0.5}));
        let f = got.try_recv().expect("the settled picture");
        assert!(f.settled);
        assert_eq!((f.width, f.height), (640, 400));
    }

    #[tokio::test]
    async fn a_page_narrower_than_the_cast_is_not_scaled_up() {
        let mut b = fake_browser(|m| match m {
            "Page.getLayoutMetrics" => Ok(json!({"cssVisualViewport": {"clientWidth": 320.0, "clientHeight": 200.0}})),
            _ => Ok(json!({"data": b64(&png(320, 200))})),
        })
        .await;
        let (sink, _got) = std::sync::mpsc::channel();
        cast_to(sink).settle(&b.client, "S1").await;
        next_seen(&mut b).await;
        next_seen(&mut b).await;
        let (_, p, _) = next_seen(&mut b).await;
        assert_eq!(p["clip"]["scale"], 1.0);
    }

    #[tokio::test]
    async fn a_settle_with_no_viewport_takes_the_whole_page_unclipped() {
        let mut b = fake_browser(|m| match m {
            "Page.getLayoutMetrics" => Err("no metrics".into()),
            "Page.captureScreenshot" => Ok(json!({"data": b64(b"opaque")})),
            _ => Ok(json!({})),
        })
        .await;
        let (sink, got) = std::sync::mpsc::channel();
        cast_to(sink).settle(&b.client, "S1").await;
        next_seen(&mut b).await;
        next_seen(&mut b).await;
        let (_, p, _) = next_seen(&mut b).await;
        assert!(p.get("clip").is_none());
        let f = got.try_recv().unwrap();
        assert_eq!((f.jpeg.as_slice(), f.width, f.height, f.settled), (&b"opaque"[..], 0, 0, true));
    }

    #[tokio::test]
    async fn a_zero_sized_viewport_is_not_clipped_to() {
        let mut b = fake_browser(|m| match m {
            "Page.getLayoutMetrics" => Ok(json!({"cssVisualViewport": {"clientWidth": 0.0, "clientHeight": 800.0}})),
            _ => Ok(json!({"data": b64(&png(1, 1))})),
        })
        .await;
        let (sink, _got) = std::sync::mpsc::channel();
        cast_to(sink).settle(&b.client, "S1").await;
        next_seen(&mut b).await;
        next_seen(&mut b).await;
        assert!(next_seen(&mut b).await.1.get("clip").is_none());
    }

    #[tokio::test]
    async fn a_walk_whose_screenshot_fails_or_is_not_an_image_sends_no_settled_picture() {
        for reply in [
            (|m: &str| if m == "Page.captureScreenshot" { Err("no".to_string()) } else { Ok(json!({})) }) as fn(&str) -> Result<Value, String>,
            |m: &str| if m == "Page.captureScreenshot" { Ok(json!({"data": "***"})) } else { Ok(json!({})) },
            |m: &str| if m == "Page.captureScreenshot" { Ok(json!({})) } else { Ok(json!({})) },
        ] {
            let b = fake_browser(reply).await;
            let (sink, got) = std::sync::mpsc::channel();
            cast_to(sink).settle(&b.client, "S1").await;
            assert!(got.try_recv().is_err());
        }
    }

    #[tokio::test]
    async fn pumping_takes_the_frames_painted_while_the_walk_waits_and_stops_at_the_deadline() {
        let mut b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = Screencast::start(&b.client, "S1", sink).await.unwrap();
        next_seen(&mut b).await;
        b.push.send(json!({"method": "Page.loadEventFired", "params": {}}).to_string()).unwrap();
        b.push.send("not json but \"Page.screencastFrame\"".to_string()).unwrap();
        b.push.send(frame_msg(&png(11, 12), 3, 2.0).to_string()).unwrap();
        let started = Instant::now();
        cast.pump(&b.client, "S1", Duration::from_millis(700)).await;
        assert!(started.elapsed() >= Duration::from_millis(700), "waited out the time");
        assert_eq!(next_seen(&mut b).await.0, "Page.screencastFrameAck");
        let f = got.try_recv().expect("the painted frame was passed on");
        assert_eq!((f.width, f.height), (11, 12));
    }

    #[tokio::test]
    async fn pumping_once_the_walk_reads_for_itself_just_waits() {
        let b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = Screencast::start(&b.client, "S1", sink).await.unwrap();
        cast.stop_pumping();
        assert!(cast.early.is_none());
        b.push.send(frame_msg(&png(1, 1), 1, 1.0).to_string()).unwrap();
        let started = Instant::now();
        cast.pump(&b.client, "S1", Duration::from_millis(300)).await;
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(got.try_recv().is_err(), "no frame is read while the walk reads for itself");
    }

    #[tokio::test]
    async fn pumping_a_closed_line_still_waits_out_the_time() {
        let b = fake_browser(accept_all).await;
        let (sink, _got) = std::sync::mpsc::channel();
        let mut cast = Screencast::start(&b.client, "S1", sink).await.unwrap();
        b.client.close().await;
        let started = Instant::now();
        cast.pump(&b.client, "S1", Duration::from_millis(300)).await;
        assert!(started.elapsed() >= Duration::from_millis(300));
    }

    #[tokio::test]
    async fn a_frame_is_still_passed_on_when_the_browser_never_answers_its_acknowledgement() {
        let b = fake_browser(|m| if m == "Page.screencastFrameAck" { Err("silent".into()) } else { Ok(json!({})) }).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = cast_to(sink);
        let started = Instant::now();
        assert!(cast.take(&b.client, "S1", &frame_msg(&png(5, 6), 1, 1.0)).await);
        assert!(started.elapsed() >= Duration::from_secs(2), "the ack was waited for, but only so long");
        assert_eq!(got.try_recv().map(|f| (f.width, f.height)).ok(), Some((5, 6)));
    }

    #[tokio::test]
    async fn pumping_after_a_flood_the_buffer_dropped_carries_on_and_takes_the_next_frame() {
        let mut b = fake_browser(accept_all).await;
        let (sink, got) = std::sync::mpsc::channel();
        let mut cast = Screencast::start(&b.client, "S1", sink).await.unwrap();
        next_seen(&mut b).await;
        for i in 0..5000 {
            b.push.send(json!({"method": "Noise.event", "params": {"i": i}}).to_string()).unwrap();
        }
        b.push.send(frame_msg(&png(8, 9), 2, 3.0).to_string()).unwrap();
        // Let all of it arrive before anyone reads: the buffer overflows, the reader is told it fell behind.
        tokio::time::sleep(Duration::from_millis(800)).await;
        cast.pump(&b.client, "S1", Duration::from_millis(1500)).await;
        assert_eq!(got.try_recv().map(|f| (f.width, f.height)).ok(), Some((8, 9)));
    }
}
