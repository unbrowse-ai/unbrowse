//! A page that asks for a person, as the agent's own eyes and hands: the node shows the page — a picture and what it
//! says — and the agent says what to do, one step at a time. The model is the agent's; the node calls none. The page's
//! own answer decides whether it passed: `asks` is read from the page after every step, never assumed.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use unbrowse_learn::cdp::client::CdpClient;
use unbrowse_learn::challenge::{self as page_act, Act, Page, Shot, State};

use crate::sync::Locked;

/// What was tried on each page, so the agent sees its own steps and can stop repeating one.
static SAID: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The most steps kept per page.
const SAID_MOST: usize = 40;

fn key_of(site: &str, session: &str) -> String {
    format!("{site}|{session}")
}

fn said(site: &str, session: &str) -> Vec<String> {
    SAID.locked().get(&key_of(site, session)).cloned().unwrap_or_default()
}

fn note(site: &str, session: &str, step: String) {
    let mut all = SAID.locked();
    let list = all.entry(key_of(site, session)).or_default();
    list.push(step);
    let n = list.len();
    if n > SAID_MOST {
        list.drain(..n - SAID_MOST);
    }
}

fn forget(site: &str, session: &str) {
    SAID.locked().remove(&key_of(site, session));
}

/// Shows the page: a picture of it, its address, its title, its readable text, and whether it still asks for a person.
pub fn look(who: &str, site: &str, session: &str, url: &str) -> Result<Value, String> {
    show(who, site, session, url, None, false)
}

/// Takes one step on the page and shows it again, so the agent sees what its step did.
pub fn act(who: &str, site: &str, session: &str, act: Act) -> Result<Value, String> {
    show(who, site, session, "", Some(act), false)
}

/// A hand step (click/drag/type/press) with no picture or page read after it: for beating a short challenge timer,
/// where the caller already holds the grid and only needs the clicks to land fast. The reply says what was done, not
/// what the page shows; a `look` afterwards reads the page.
pub fn act_quick(who: &str, site: &str, session: &str, act: Act) -> Result<Value, String> {
    show(who, site, session, "", Some(act), true)
}

/// Several hand steps over ONE browser attachment, no picture or page read between them: a captcha grid's clicks and
/// its Confirm land in a single fast call, inside a short WAF timer that a round-trip per click would outrun. The
/// reply says what was done; a `look` afterwards reads the page.
pub fn batch(who: &str, site: &str, session: &str, steps: Vec<Act>) -> Result<Value, String> {
    let site = if !site.trim().is_empty() {
        unbrowse_learn::identity::site_of(site.trim())
    } else {
        crate::browse::last_site(session).ok_or("no page is open: give url, or open one with unbrowse_browse")?
    };
    crate::browse::in_the_sites_turn(&site.clone(), format!("a challenge batch for {who}"), || {
        for a in &steps {
            crate::browse::page_policy(&site, session, &[a.command().to_string()])?;
        }
        let tab = crate::browse::tab_of(session);
        let cdp = crate::browse::cdp_of(&site).ok_or_else(|| format!("{site}'s browser isn't open: it opens when an agent browses the site"))?;
        let target = crate::browse::target_of(&site, &tab).ok_or("the session's tab isn't open in that browser")?;
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        let opened = rt.block_on(open(&cdp, &target))?;
        let mut page = CdpPage { rt, client: opened.client, session: opened.session, viewport: opened.viewport, url: opened.url, title: opened.title };
        let mut done = Vec::new();
        for a in &steps {
            match take(&mut page, a) {
                Ok(()) => { note(&site, session, a.said()); done.push(a.said()); }
                Err(e) => { note(&site, session, format!("{} failed: {e}", a.said())); done.push(format!("{} failed: {e}", a.said())); }
            }
        }
        Ok(json!({ "site": site, "said": done, "asks": Value::Null, "quick": true, "batched": steps.len() }))
    })
}

fn show(who: &str, site: &str, session: &str, url: &str, act: Option<Act>, quick: bool) -> Result<Value, String> {
    let site = if !url.trim().is_empty() {
        // The page to meet is opened in the session's own tab, as the agent would have opened it.
        crate::browse::act(&["open".to_string(), url.trim().to_string()], None, who, session)?;
        crate::browse::last_site(session).ok_or("the page didn't open")?
    } else if !site.trim().is_empty() {
        unbrowse_learn::identity::site_of(site.trim())
    } else {
        crate::browse::last_site(session).ok_or("no page is open: give url, or open one with unbrowse_browse")?
    };
    // The step, and the picture after it, are one turn of the site's browser: no card fill or agent command comes
    // between them, and the gates are read inside it, so a hold begun while it waited is seen.
    crate::browse::in_the_sites_turn(&site.clone(), format!("a challenge step for {who}"), || shown(who, &site, session, act, quick))
}

/// The browse commands a challenge call amounts to, for the one page policy (`browse::page_policy`) to judge: its step
/// (a click, a drag, typed text, a key), the picture it may take, and the page's words it reads back. A quick hand step
/// takes no picture and reads no words: only the step itself.
fn what_it_does(act: Option<&Act>, quick: bool) -> Vec<Vec<String>> {
    let mut all = Vec::new();
    if let Some(a) = act.filter(|a| !matches!(a, Act::Wait(_) | Act::Done)) {
        all.push(vec![a.command().to_string()]);
    }
    if !quick {
        all.push(vec!["screenshot".to_string()]);
        all.push(vec!["get".to_string(), "text".to_string(), "body".to_string()]);
    }
    all
}

fn shown(_who: &str, site: &str, session: &str, act: Option<Act>, quick: bool) -> Result<Value, String> {
    let site = site.to_string();
    // The step, the picture and the words read back each cross the same page policy `unbrowse_browse` does, before
    // anything reaches the page: the tab, the owner's hand-off, the pause, the exclusions, the card hold, and the secret
    // rules. A picture can't be scrubbed, so a page that may hold a secret the node filled or the owner typed gets no
    // picture taken, by the same test browse's `screenshot` meets; the words are scrubbed of every secret below.
    for args in what_it_does(act.as_ref(), quick) {
        crate::browse::page_policy(&site, session, &args)?;
    }
    let tab = crate::browse::tab_of(session);
    let cdp = crate::browse::cdp_of(&site).ok_or_else(|| format!("{site}'s browser isn't open: it opens when an agent browses the site"))?;
    let target = crate::browse::target_of(&site, &tab).ok_or("the session's tab isn't open in that browser")?;
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let opened = rt.block_on(open(&cdp, &target))?;
    let mut page = CdpPage { rt, client: opened.client, session: opened.session, viewport: opened.viewport, url: opened.url, title: opened.title };
    let done = matches!(act, Some(Act::Done));
    let hand = act.as_ref().is_some_and(|a| !matches!(a, Act::Wait(_) | Act::Done));
    // A page holding a secret has no picture taken: the page policy above refused it, and the node's own read of what
    // the page paints is asked again before the step and before the picture (a step may show it: the page's own "show
    // password"), a second guard (`browse::may_picture`). The steps themselves are hands, never the agent's code, so
    // they leave the tab fillable. A quick hand step skips the read: it only lands the click.
    if !quick {
        crate::browse::may_picture(&site, &tab, || page.shown(&site))?;
    }
    if let Some(act) = &act {
        match take(&mut page, act) {
            Ok(()) => note(&site, session, act.said()),
            Err(e) => note(&site, session, format!("{} failed: {e}", act.said())),
        }
    }
    if quick && hand {
        return Ok(json!({ "site": site, "said": said(&site, session), "asks": Value::Null, "quick": true }));
    }
    if done {
        page.settle(600);
    } else if act.is_none() {
        // A widget that inserts itself after load (a Turnstile, a late challenge frame) is in the state read a moment
        // later, so the page is given that moment before it is read.
        page.settle(500);
    }
    let state = page.state()?;
    // A picture only of a page the node judges to be asking for a person: the tool is for meeting a challenge, not a
    // camera on any page. A page that doesn't ask is answered with its words alone.
    let shot = if state.asks_a_person {
        crate::browse::may_picture(&site, &tab, || page.shown(&site))?;
        Some(page.shot()?)
    } else {
        None
    };
    let image = match &shot {
        Some(shot) => Some(save_shot(session, &shot.png)?),
        None => None,
    };
    let scrub = |t: String| crate::browse::scrubbed(&site, t);
    let mut reply = json!({
        "site": site,
        "url": scrub(state.url.clone()),
        "title": scrub(state.title.clone()),
        "text": scrub(state.text.chars().take(4000).collect::<String>()),
        "asks": state.asks_a_person,
        "image": image,
        "said": said(&site, session),
    });
    if let Some(shot) = &shot {
        reply["w"] = json!(shot.w);
        reply["h"] = json!(shot.h);
        reply["mime"] = json!("image/png");
    } else {
        reply["note"] = json!("The page doesn't ask for a person, so no picture was taken: read it with unbrowse_browse.");
    }
    if done && !state.asks_a_person {
        forget(&site, session);
    }
    // Whoever looked, a page that asks nobody is a door passed: a walk of the site need not wait out its rest.
    if !state.asks_a_person {
        crate::learn::the_door_was_met(&site);
    }
    Ok(reply)
}

/// Takes the step on the page.
fn take(page: &mut CdpPage, act: &Act) -> Result<(), String> {
    match act {
        Act::Click(x, y) => page.click(*x, *y)?,
        Act::Drag(from, to) => page.drag(*from, *to)?,
        Act::Hold(x, y, ms) => page.hold(*x, *y, *ms)?,
        Act::Type(text) => page.type_text(text)?,
        Act::Press(key) => page.press(key)?,
        Act::Wait(ms) => page.settle(*ms),
        // `done` says what the agent thinks; the page is read after it, and says whether it asked still.
        Act::Done => {}
    }
    Ok(())
}

/// Where the challenge tool keeps the pictures it takes: the node's own, under its home.
fn shots_dir() -> std::path::PathBuf {
    crate::store::home().join("shots")
}

/// The bytes of a picture this tool took, for a reply to carry: only a file in [`shots_dir`], by its real path. Any
/// other path a reply might name (a value a site put in an answer, a file of the owner's) is never read into one.
pub(crate) fn picture(path: &str) -> Option<Vec<u8>> {
    let dir = shots_dir().canonicalize().ok()?;
    let file = std::path::Path::new(path).canonicalize().ok()?;
    let ours = file.parent() == Some(dir.as_path())
        && file.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("challenge-") && n.ends_with(".png"))
        && std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file());
    ours.then(|| std::fs::read(&file).ok()).flatten()
}

/// The most pictures kept: one per session, the oldest let go beyond this. An agent that looks again and again
/// overwrites its own picture, and many sessions can't fill the owner's disk.
const SHOTS_MOST: usize = 16;

/// Where a picture of the page is kept for the agent to read, under the node's home: one file per session, written
/// whole and private before it takes the place of the last (a temporary file, owner-only, renamed over it), with the
/// pictures kept bounded ([`SHOTS_MOST`]) and stray temporary files cleared.
fn save_shot(session: &str, png: &[u8]) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let dir = shots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    forget_old_shots(&dir, SystemTime::now());
    let _ = unbrowse_core::keystore::keep_private(&dir);
    let name = hex::encode(&Sha256::digest(session.as_bytes())[..12]);
    let path = dir.join(format!("challenge-{name}.png"));
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let part = dir.join(format!(".challenge-{name}-{}-{stamp}.part", std::process::id()));
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let written = o.open(&part).and_then(|mut f| std::io::Write::write_all(&mut f, png));
    if let Err(e) = written.and_then(|()| std::fs::rename(&part, &path)) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{}: {e}", path.display()));
    }
    prune_shots(&dir, Some(&path));
    Ok(path.to_string_lossy().into_owned())
}

/// Keeps the pictures in `dir` to the newest [`SHOTS_MOST`] (`keep` among them), and clears temporary files a write
/// that didn't finish left behind.
fn prune_shots(dir: &std::path::Path, keep: Option<&std::path::Path>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut shots: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(".challenge-") && name.ends_with(".part") {
            // Another write's, still going, is a moment old: only one a minute old is left over.
            if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|d| d.as_secs() > 60)) {
                let _ = std::fs::remove_file(&path);
            }
        } else if name.starts_with("challenge-") && name.ends_with(".png") {
            let at = e.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
            shots.push((at, path));
        }
    }
    shots.sort_by_key(|s| std::cmp::Reverse(s.0));
    let mut kept = 0;
    for (_, path) in shots {
        if Some(path.as_path()) == keep || kept < SHOTS_MOST - usize::from(keep.is_some()) {
            if Some(path.as_path()) != keep {
                kept += 1;
            }
            continue;
        }
        let _ = std::fs::remove_file(&path);
    }
}

/// Clears what the last run of the node left of its pictures beyond the bound, at its start.
pub fn tidy_shots() {
    prune_shots(&shots_dir(), None);
}

/// How long a picture of a page is kept: long enough for the agent that asked for it to read it.
const SHOT_KEPT: std::time::Duration = std::time::Duration::from_secs(600);

/// Clears the pictures in `dir` older than `SHOT_KEPT`: each shows a signed-in page, and none has a use after the
/// agent has looked. MCP removes its own as it hands it over (`api::mcp`); this is for one read by its path.
// shortcut: runs when the next picture is taken, so the last ones stay until then; clear on a timer if that matters.
fn forget_old_shots(dir: &std::path::Path, now: SystemTime) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|at| now.duration_since(at).ok()).is_some_and(|age| age > SHOT_KEPT);
        if old && entry.file_name().to_string_lossy().starts_with("challenge-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// What the page is before the first step: the tab's line, its size, and where it is.
struct Opened {
    client: Arc<CdpClient>,
    session: String,
    viewport: View,
    url: String,
    title: String,
}

async fn open(ws: &str, target: &str) -> Result<Opened, String> {
    let client = Arc::new(CdpClient::connect(ws).await?);
    let attached = client.send_command("Target.attachToTarget", Some(json!({ "targetId": target, "flatten": true })), None).await?;
    let session = attached["sessionId"].as_str().ok_or("the browser didn't let the node attach")?.to_string();
    let _ = client.send_command("Page.enable", None, Some(&session)).await;
    let _ = client.send_command("Runtime.enable", None, Some(&session)).await;
    let viewport = layout(&client, &session).await;
    let (url, title) = where_it_is(&client, &session).await;
    Ok(Opened { client, session, viewport, url, title })
}

/// The part of the document the tab shows: where it sits in the document and its size, in CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct View {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// The tab's view read from the browser's layout: the visual viewport's place in the document (`pageX`, `pageY`) and its
/// size. A page scrolled to its form shows the form, not the document's top, so a picture clipped at the document's
/// origin is of a part nobody can see, blank, while the page still asks.
fn view_of(metrics: &Value) -> Option<View> {
    let v = metrics.get("cssVisualViewport")?;
    let w = v.get("clientWidth")?.as_f64()?;
    let h = v.get("clientHeight")?.as_f64()?;
    let x = v.get("pageX").and_then(|n| n.as_f64()).unwrap_or(0.0).max(0.0);
    let y = v.get("pageY").and_then(|n| n.as_f64()).unwrap_or(0.0).max(0.0);
    (w > 0.0 && h > 0.0).then_some(View { x, y, w, h })
}

/// The clip of a picture of what the tab shows: the view's own place in the document, at one image pixel per CSS
/// pixel, so a point in the picture is the point a click at the same place lands on (clicks are viewport pixels).
fn clip_of(view: View) -> Value {
    json!({ "x": view.x, "y": view.y, "width": view.w, "height": view.h, "scale": 1.0 })
}

async fn layout(client: &CdpClient, session: &str) -> View {
    client
        .send_command("Page.getLayoutMetrics", None, Some(session))
        .await
        .ok()
        .and_then(|m| view_of(&m))
        .unwrap_or(View { x: 0.0, y: 0.0, w: 1280.0, h: 800.0 })
}

async fn where_it_is(client: &CdpClient, session: &str) -> (String, String) {
    let said = client
        .send_command(
            "Runtime.evaluate",
            Some(json!({ "expression": "JSON.stringify({url:location.href,title:document.title})", "returnByValue": true })),
            Some(session),
        )
        .await
        .ok()
        .and_then(|v| v.pointer("/result/value").and_then(|x| x.as_str()).map(String::from));
    let v: Value = said.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    (
        v.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string(),
        v.get("title").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
    )
}

/// The page over the DevTools line: pictures, mouse and keys at CSS pixels, and the page's own markup to decide whether
/// it still asks for a person.
struct CdpPage {
    rt: tokio::runtime::Runtime,
    client: Arc<CdpClient>,
    session: String,
    viewport: View,
    url: String,
    title: String,
}

impl CdpPage {
    fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        self.rt.block_on(async { self.client.send_command(method, Some(params), Some(&self.session)).await })
    }

    /// The node's own read of what the page paints (`browse::shown_js`): `None` when the page wouldn't say.
    fn shown(&self, site: &str) -> Option<crate::browse::Shown> {
        let said = self.send("Runtime.evaluate", json!({ "expression": crate::browse::shown_js(site), "returnByValue": true })).ok()?;
        crate::browse::Shown::of(&said.pointer("/result/value")?.to_string())
    }
}

impl Page for CdpPage {
    fn shot(&mut self) -> Result<Shot, String> {
        // Read where the tab is at the moment of the picture: a step may have scrolled it (a focus, a click on a box
        // below the fold), and the picture is of what the tab shows now.
        if let Some(view) = self.send("Page.getLayoutMetrics", json!({})).ok().and_then(|m| view_of(&m)) {
            self.viewport = view;
        }
        let View { w, h, .. } = self.viewport;
        let said = self.send("Page.captureScreenshot", json!({ "format": "png", "clip": clip_of(self.viewport), "captureBeyondViewport": false }))?;
        let b64 = said.get("data").and_then(|d| d.as_str()).ok_or("the browser took no picture")?;
        let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).map_err(|e| e.to_string())?;
        Ok(Shot { png, w, h })
    }

    fn click(&mut self, x: f64, y: f64) -> Result<(), String> {
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }))?;
        self.send("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 }))?;
        // A press held for a moment, as a hand's is: widgets that time a gesture read an instant press as a script.
        std::thread::sleep(std::time::Duration::from_millis(40));
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1 }))?;
        self.settle(300);
        Ok(())
    }

    fn drag(&mut self, from: (f64, f64), to: (f64, f64)) -> Result<(), String> {
        let (x0, y0) = from;
        let (x1, y1) = to;
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x0, "y": y0 }))?;
        self.send("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1 }))?;
        // The move is stepped like a hand's: a slider reads the path, not only where it ended.
        for step in 1..=8u32 {
            let f = step as f64 / 8.0;
            let (x, y) = (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
            self.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1 }))?;
            std::thread::sleep(std::time::Duration::from_millis(24));
        }
        // Held at the end before letting go, as a hand does: a slider that reads the gesture is given one.
        std::thread::sleep(std::time::Duration::from_millis(150));
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x1, "y": y1, "button": "left", "buttons": 0, "clickCount": 1 }))?;
        self.settle(300);
        Ok(())
    }

    fn hold(&mut self, x: f64, y: f64, ms: u64) -> Result<(), String> {
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }))?;
        self.send("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 }))?;
        // Held for the time named: the button fills while it is pressed, and lets the page on once full.
        std::thread::sleep(std::time::Duration::from_millis(ms));
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1 }))?;
        self.settle(500);
        Ok(())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        self.send("Input.insertText", json!({ "text": text }))?;
        self.settle(200);
        Ok(())
    }

    fn press(&mut self, key: &str) -> Result<(), String> {
        let (code, vk, text) = match key {
            "Enter" => ("Enter", 13u32, Some("\r")),
            "Tab" => ("Tab", 9, None),
            "Escape" => ("Escape", 27, None),
            "Backspace" => ("Backspace", 8, None),
            other => return Err(format!("the node presses Enter, Tab, Escape or Backspace, not {other:?}")),
        };
        let mut down = json!({ "type": "rawKeyDown", "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk });
        if let Some(t) = text {
            down["type"] = json!("keyDown");
            down["text"] = json!(t);
            down["unmodifiedText"] = json!(t);
        }
        self.send("Input.dispatchKeyEvent", down)?;
        self.send("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk }))?;
        self.settle(300);
        Ok(())
    }

    fn state(&mut self) -> Result<State, String> {
        let said = self.send("Runtime.evaluate", json!({ "expression": READ_JS, "returnByValue": true }))?;
        let top = Read::of(said.pointer("/result/value").and_then(|v| v.as_str()).ok_or("the page said nothing")?)?;
        self.url = top.url.clone();
        self.title = top.title.clone();
        let frames = self.frames_of_the_site(&top.url);
        // The page's words, then each shown frame's: a check drawn in a frame says what it asks there, not on the page.
        let mut text = top.text.clone();
        for f in frames.iter().filter(|f| f.shown && !f.text.trim().is_empty()) {
            text.push('\n');
            text.push_str(&f.text);
        }
        Ok(State { url: self.url.clone(), title: self.title.clone(), text: text.chars().take(4000).collect(), asks_a_person: page_asks(&top, &frames) })
    }

    fn settle(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms.min(20_000)));
    }
}

impl CdpPage {
    /// Each frame of the page's own site, at any depth, read as the page is (`READ_JS`). A check is often drawn in a
    /// frame the site serves from another of its hosts over its page, and the page under it reads as a page of the
    /// site. Another site's frame runs apart from the page (its own process) and isn't read here: what it shows is
    /// judged by the frame of the site that holds it.
    fn frames_of_the_site(&self, page: &str) -> Vec<Read> {
        let Some(host) = url::Url::parse(page).ok().and_then(|u| u.host_str().map(String::from)) else { return Vec::new() };
        let Ok(tree) = self.send("Page.getFrameTree", json!({})) else { return Vec::new() };
        let mut ids = Vec::new();
        fn children(node: &Value, host: &str, out: &mut Vec<String>) {
            for child in node.get("childFrames").and_then(Value::as_array).into_iter().flatten() {
                let frame = &child["frame"];
                let ours = frame["url"].as_str().and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(String::from)).is_some_and(|h| unbrowse_learn::identity::same_site(&h, host));
                if let (true, Some(id)) = (ours, frame["id"].as_str()) {
                    out.push(id.to_string());
                }
                children(child, host, out);
            }
        }
        children(tree.get("frameTree").unwrap_or(&Value::Null), &host, &mut ids);
        ids.into_iter()
            .take(FRAMES_MOST)
            .filter_map(|id| {
                let world = self.send("Page.createIsolatedWorld", json!({ "frameId": id, "worldName": "unbrowse-challenge" })).ok()?;
                let context = world.get("executionContextId")?.as_i64()?;
                let said = self.send("Runtime.evaluate", json!({ "expression": READ_JS, "returnByValue": true, "contextId": context })).ok()?;
                Read::of(said.pointer("/result/value")?.as_str()?).ok()
            })
            .collect()
    }
}

/// The most frames of the site read per step: a page of the site frames a few of its own; more is not a check.
const FRAMES_MOST: usize = 12;

/// What a document says of itself, for the page and for each frame of its site: its address and title, its words, its
/// markup (its body when the whole is past the cap), whether a widget in it has answered (its `<widget>-response` field
/// holds a token), and whether it is shown: a frame with no room on screen (an empty or hidden one) shows nothing.
const READ_JS: &str = "JSON.stringify((()=>{const f=(document.documentElement&&document.documentElement.outerHTML)||'';const cut=f.length>300000;return {url:location.href,title:document.title,text:(document.body&&document.body.innerText||'').slice(0,4000),html:f.slice(0,300000),body:cut?((document.body&&document.body.outerHTML)||'').slice(0,300000):'',cut:cut,answered:[...document.querySelectorAll('input,textarea')].some(e=>/-response$/i.test(e.name||'')&&String(e.value||'').length>0),shown:innerWidth>=40&&innerHeight>=40&&document.visibilityState!=='hidden'}})())";

/// A document as `READ_JS` reads it.
#[derive(Clone, Debug, Default)]
struct Read {
    url: String,
    title: String,
    text: String,
    /// Its markup, or its body when the whole was past the cap (`page_or_body`).
    html: String,
    answered: bool,
    shown: bool,
}

impl Read {
    fn of(raw: &str) -> Result<Read, String> {
        let v: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let cut = v.get("cut").and_then(|c| c.as_bool()).unwrap_or(false);
        let (whole, body) = (s("html"), s("body"));
        Ok(Read {
            url: s("url"),
            title: s("title"),
            text: s("text"),
            html: page_act::page_or_body(&whole, &body, cut).to_string(),
            answered: v.get("answered").and_then(|a| a.as_bool()).unwrap_or(false),
            shown: v.get("shown").and_then(|a| a.as_bool()).unwrap_or(true),
        })
    }

    /// Whether this document, read alone, asks for a person: it is only a script and a check, shows a widget, or says
    /// in its own words that it wants one.
    fn asks(&self) -> bool {
        url::Url::parse(&self.url).is_ok_and(|at| page_act::asks_a_person(&self.html, &at)) || wants_a_person(&self.text)
    }

    /// The site's own word that the check was passed, on the page itself: a code challenge whose page stays put.
    fn says_passed(&self) -> bool {
        let lower = self.text.to_lowercase();
        ["验证成功", "verification successful", "captcha is passed", "challenge success"].iter().any(|w| lower.contains(w))
    }
}

/// Whether the page asks for a person: the page itself does, or a frame of its site shown over it does (a check drawn
/// in a frame the site serves from another of its hosts, on a page that reads as a page of the site under it). A
/// widget that has answered, in the page or a frame, or the site's word that the check passed, is the site saying it
/// no longer asks. A frame with no room on screen asks nobody: a script's own frame, a check not shown. The same
/// generic words and properties for every site, never a vendor's name; the agent's look settles it.
fn page_asks(top: &Read, frames: &[Read]) -> bool {
    let shown: Vec<&Read> = frames.iter().filter(|f| f.shown).collect();
    let answered = top.answered || shown.iter().any(|f| f.answered);
    let passed = top.says_passed() || shown.iter().any(|f| f.says_passed());
    !answered && !passed && (top.asks() || shown.iter().any(|f| f.asks()))
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    fn read(url: &str, html: &str, text: &str) -> Read {
        Read { url: url.into(), title: String::new(), text: text.into(), html: html.into(), answered: false, shown: true }
    }

    /// A page of the site, its own links all around, with a search that came back empty under a dialog: the dialog is a
    /// frame the site serves from another of its hosts, and the check (another site's frame) sits in that frame. Read
    /// alone, the page asks nobody; with its shown frame, it asks. The run that exposed it: a shop's search page on
    /// 2026-11-19, where `asks` said false on every step while the box and then the picture grid were on screen.
    #[test]
    fn a_check_in_a_shown_frame_of_the_site_is_the_page_asking() {
        let links: String = (1..=8).map(|i| format!("<a href=\"/c/{i}/\">c{i}</a>")).collect();
        let top = read("https://www.shop.example/tag/thing/?q=thing", &format!("<html><body><nav>{links}</nav><h1>Search No Result</h1><div><iframe src=\"https://guard.shop.example//h5/x/1.0/_____gate_____/hold?d=1\"></iframe></div></body></html>"), "Search No Result");
        assert!(!page_asks(&top, &[]), "read alone, the page is a page of the site");
        let frame = read(
            "https://guard.shop.example//h5/x/1.0/_____gate_____/hold?d=1",
            "<html><body><img src=/m.png><p>We need to check if you are a robot.</p><iframe src=\"https://widget.example/api2/anchor?k=1\"></iframe></body></html>",
            "We need to check if you are a robot.",
        );
        assert!(page_asks(&top, std::slice::from_ref(&frame)), "the shown frame of the site holds the check");
        // Answered in the frame, it asks no more.
        assert!(!page_asks(&top, &[Read { answered: true, ..frame.clone() }]));
        // The same frame with no room on screen asks nobody.
        assert!(!page_asks(&top, &[Read { shown: false, ..frame }]));
    }

    /// A frame of the site that is part of the page (its comments, its own links around) asks nobody: a frame is read
    /// as a page is, by the same properties.
    #[test]
    fn a_frame_of_the_site_that_is_a_page_asks_nobody() {
        let links: String = (1..=8).map(|i| format!("<a href=\"/p/{i}/\">p{i}</a>")).collect();
        let top = read("https://www.shop.example/item/1", &format!("<html><body><nav>{links}</nav><h1>A thing</h1></body></html>"), "A thing");
        let frame = read("https://reviews.shop.example/item/1", &format!("<html><body><nav>{links}</nav><p>Great thing</p><iframe src=\"https://ads.example/slot\"></iframe></body></html>"), "Great thing");
        assert!(!page_asks(&top, &[frame]));
    }
}

/// Whether a page says, in its own words, that it wants a person: a code to type, a box to tick, a slide. The words a
/// page uses for the ask, never a vendor's name. One reading, for the page an agent is shown and for the page a
/// route read back: a check handed over as a route's answer is a wrong success.
pub(crate) fn wants_a_person(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["captcha", "验证码", "完成验证", "您是真人", "verify you are human", "verify you're a human", "verify you’re a human", "confirm you’re human", "confirm you're human", "confirm you are human", "prove your humanity", "please slide to verify", "slide to verify", "i'm not a robot", "i am not a robot", "you are a robot", "you're a robot", "human verification", "security check", "unusual browser activity", "unusual traffic"]
        .iter()
        .any(|w| lower.contains(w))
}

#[cfg(test)]
mod hold_tests {
    use super::*;

    /// A DevTools endpoint with one page, keeping each mouse event it was sent and when.
    fn devtools() -> (String, Arc<Mutex<Vec<(Value, std::time::Instant)>>>) {
        let heard: Arc<Mutex<Vec<(Value, std::time::Instant)>>> = Arc::default();
        let kept = heard.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let kept = kept.clone();
                std::thread::spawn(move || {
                    let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else { return };
                    while let Ok(msg) = socket.read() {
                        let Ok(cmd) = serde_json::from_str::<Value>(msg.to_text().unwrap_or_default()) else { continue };
                        if cmd["method"] == "Input.dispatchMouseEvent" {
                            kept.locked().push((cmd["params"].clone(), std::time::Instant::now()));
                        }
                        let result = match cmd["method"].as_str() {
                            Some("Target.attachToTarget") => json!({ "sessionId": "S1" }),
                            _ => json!({}),
                        };
                        let _ = socket.send(tokio_tungstenite::tungstenite::Message::text(json!({ "id": cmd["id"], "result": result }).to_string()));
                    }
                });
            }
        });
        (format!("ws://127.0.0.1:{port}/devtools/browser/fake"), heard)
    }

    /// A hold presses where it is told and lets go only after the time named, at the same point: a button that fills
    /// while pressed sees one press, held, and one release.
    #[test]
    fn a_hold_is_one_press_let_go_after_its_time() {
        let (ws, heard) = devtools();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let opened = rt.block_on(open(&ws, "T1")).unwrap();
        let mut page = CdpPage { rt, client: opened.client, session: opened.session, viewport: opened.viewport, url: opened.url, title: opened.title };
        take(&mut page, &Act::Hold(664.0, 494.0, 700)).unwrap();
        let heard = heard.locked().clone();
        let kinds: Vec<&str> = heard.iter().map(|(p, _)| p["type"].as_str().unwrap_or_default()).collect();
        assert_eq!(kinds, ["mouseMoved", "mousePressed", "mouseReleased"]);
        assert!(heard.iter().all(|(p, _)| p["x"] == 664.0 && p["y"] == 494.0), "{heard:?}");
        assert!(heard[2].1.duration_since(heard[1].1) >= std::time::Duration::from_millis(700), "held for its time");
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;

    /// The run that exposed it: a sign-up form at document y 718 in a 632 px tab, scrolled to the form. The picture is
    /// of the part the tab shows, where the form is, not of the document's top.
    #[test]
    fn a_picture_is_of_what_the_tab_shows_not_the_document_top() {
        let metrics = json!({ "cssVisualViewport": { "pageX": 0.0, "pageY": 520.0, "clientWidth": 1280.0, "clientHeight": 632.0 } });
        let view = view_of(&metrics).unwrap();
        assert_eq!(view, View { x: 0.0, y: 520.0, w: 1280.0, h: 632.0 });
        let clip = clip_of(view);
        assert_eq!(clip["y"], 520.0);
        assert_eq!(clip["height"], 632.0);
        assert_eq!(clip["scale"], 1.0, "one image pixel per CSS pixel, so a point in the picture is where a click lands");
        // A page never scrolled is pictured from its top, as before.
        let top = view_of(&json!({ "cssVisualViewport": { "clientWidth": 800.0, "clientHeight": 600.0 } })).unwrap();
        assert_eq!((top.x, top.y), (0.0, 0.0));
        // A layout with no size is no view: the node falls back to its default size rather than a zero picture.
        assert!(view_of(&json!({ "cssVisualViewport": { "clientWidth": 0.0, "clientHeight": 600.0 } })).is_none());
    }
}

#[cfg(test)]
mod wants_tests {
    /// The walk that exposed it: a shop's check ("check the box to confirm you’re human") read back as a route's
    /// answer and handed over as ok. A results page that mentions none of it does not ask.
    #[test]
    fn a_page_that_says_it_wants_a_person_is_one_that_asks() {
        assert!(super::wants_a_person("We’re noticing unusual browser activity\nCheck the box to confirm you’re human."));
        assert!(!super::wants_a_person("1-48 of over 30,000 results for flask\nSort by: Featured"));
        assert!(super::wants_a_person("We need to check if you are a robot."));
    }

    /// A picture of a page is of a signed-in session. It is kept long enough for the agent that asked to read it, and
    /// the next one taken clears those older than that; nothing else in the folder is touched.
    #[test]
    fn a_picture_of_a_page_is_not_kept_past_its_use() {
        let home = crate::store::scratch_home("shots");
        let shot = std::path::PathBuf::from(super::save_shot("s", b"png").unwrap());
        let shots = shot.parent().unwrap();
        let other = shots.join("notes.txt");
        std::fs::write(&other, "kept").unwrap();
        let now = std::time::SystemTime::now();
        super::forget_old_shots(shots, now + super::SHOT_KEPT / 2);
        assert!(shot.exists(), "a picture still in use was cleared");
        super::forget_old_shots(shots, now + super::SHOT_KEPT * 2);
        assert!(!shot.exists(), "a picture past its use is still there");
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    /// The challenge tool's steps and pictures cross the rules every agent command does: where the owner's card sits,
    /// no click, key or picture reaches the page (a picture of a checkout is a read of the card), and nothing is asked of
    /// a browser first.
    /// While a checkout waits for the owner anywhere, the challenge tool takes no step and no look on any site: a step
    /// may commit an order, and a look reads the page with code the page defines.
    #[test]
    fn while_a_checkout_waits_a_challenge_takes_no_step_on_any_site() {
        let _home = crate::store::scratch_home("challenge-any-hold");
        crate::payhold::seal_for_tests();
        crate::payhold::begin("checkout-waiting.example", &[]).unwrap();
        for a in [Act::Click(10.0, 10.0), Act::Drag((1.0, 1.0), (50.0, 1.0)), Act::Hold(10.0, 10.0, 500), Act::Type("hello".into()), Act::Press("Enter".into())] {
            let why = act("agent", "unrelated.example", "s1", a).unwrap_err();
            assert!(why.contains("waiting for the owner"), "{why}");
        }
        let looked = look("agent", "unrelated.example", "s1", "").unwrap_err();
        assert!(looked.contains("waiting for the owner"), "a look runs page code too, and waits: {looked}");
        crate::payhold::release("checkout-waiting.example").unwrap();
    }

    /// The challenge tool crosses the one page policy `unbrowse_browse` does: an agent can't receive a picture of a page
    /// holding a secret, whether the node filled it from the vault or the owner typed it at a hand-off that has since
    /// ended, by a look, a step, a wait or done, and whatever the page says of itself (the refusal comes before the page
    /// is read, so a page that doesn't ask gets no picture either). Words read back say the secret as its name.
    #[test]
    fn an_agent_never_receives_a_picture_or_the_text_of_a_page_holding_a_secret() {
        crate::browse::hold_secret_for_test("vaulted.example", "Vault-Pass-77", "vault:vaulted.example:me", "document:V1", "https://vaulted.example/login");
        crate::browse::owner_typed("typed.example", "Owner-Code-4417", "https://typed.example/verify");
        for site in ["vaulted.example", "typed.example"] {
            let looks: Vec<Result<Value, String>> = vec![
                look("agent", site, "1:s", ""),
                act("agent", site, "1:s", Act::Click(5.0, 5.0)),
                act("agent", site, "1:s", Act::Wait(10)),
                act("agent", site, "1:s", Act::Done),
            ];
            for said in looks {
                let why = said.unwrap_err();
                assert!(why.contains("holds a secret") && why.contains("picture"), "{site}: {why}");
            }
        }
        let text = crate::browse::scrubbed("typed.example", "Your code is Owner-Code-4417, keep it".into());
        assert!(!text.contains("Owner-Code-4417") && text.contains(crate::hands::BY_OWNER), "{text}");
        let text = crate::browse::scrubbed("vaulted.example", "pw: Vault-Pass-77".into());
        assert!(!text.contains("Vault-Pass-77") && text.contains("vault:vaulted.example:me"), "{text}");
    }

    /// Pictures stay bounded: a session's every look overwrites its one picture (owner-only), many sessions keep at
    /// most the newest few, and a temporary file a write left behind is cleared.
    #[test]
    fn repeated_looks_keep_the_pictures_within_their_bound() {
        let _home = crate::store::scratch_home("challenge-shots");
        for _ in 0..50 {
            save_shot("1:agent", b"png-bytes").unwrap();
        }
        let count = || std::fs::read_dir(shots_dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".png")).count();
        assert_eq!(count(), 1, "one session's looks are one picture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let only = std::fs::read_dir(shots_dir()).unwrap().flatten().next().unwrap().path();
            assert_eq!(std::fs::metadata(&only).unwrap().permissions().mode() & 0o777, 0o600);
        }
        for n in 0..40 {
            save_shot(&format!("{n}:session"), b"png").unwrap();
        }
        assert!(count() <= SHOTS_MOST, "{} pictures", count());
        let newest = save_shot("41:session", b"png").unwrap();
        assert!(picture(&newest).is_some(), "the newest picture is kept and readable");
        std::fs::write(shots_dir().join(".challenge-x-1-1.part"), b"left").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        std::fs::File::options().write(true).open(shots_dir().join(".challenge-x-1-1.part")).unwrap().set_modified(old).unwrap();
        tidy_shots();
        assert!(!shots_dir().join(".challenge-x-1-1.part").exists(), "a write's leftover is cleared");
        assert!(count() <= SHOTS_MOST);
    }

    /// A look asks the page policy about each thing it does: its step, its picture and the words it reads back, as
    /// browse commands; a wait and done take no step of their own.
    #[test]
    fn a_challenge_call_is_judged_as_the_browse_commands_it_amounts_to() {
        let names = |a: Option<&Act>| what_it_does(a, false).into_iter().map(|c| c.join(" ")).collect::<Vec<_>>();
        assert_eq!(names(None), ["screenshot", "get text body"]);
        assert_eq!(names(Some(&Act::Click(1.0, 1.0))), ["click", "screenshot", "get text body"]);
        assert_eq!(names(Some(&Act::Wait(5))), ["screenshot", "get text body"]);
        assert_eq!(names(Some(&Act::Done)), ["screenshot", "get text body"]);
    }

    #[test]
    fn a_challenge_step_never_reaches_a_page_where_the_owners_card_sits() {
        let _home = crate::store::scratch_home("challenge-card-gate");
        crate::payhold::seal_for_tests();
        crate::payhold::begin("held.example", &[]).unwrap();
        for step in [None, Some(Act::Click(10.0, 10.0)), Some(Act::Type("4111".into())), Some(Act::Press("Enter".into())), Some(Act::Done)] {
            let said = match step {
                None => look("agent", "held.example", "s1", ""),
                Some(a) => act("agent", "held.example", "s1", a),
            };
            assert_eq!(said.unwrap_err(), crate::browse::CARD_IS_THE_OWNERS, "a step reached a page where the card sits");
        }
        crate::payhold::release("held.example").unwrap();
    }

    /// A reply's picture is read only when it is one this tool took: any other path a reply names, a file of the
    /// owner's or a site's, is never read into it.
    #[test]
    fn only_a_picture_the_node_took_is_read_into_a_reply() {
        let _home = crate::store::scratch_home("challenge-picture");
        let mine = save_shot("s1", b"\x89PNG").unwrap();
        assert_eq!(picture(&mine).as_deref(), Some(&b"\x89PNG"[..]));
        let elsewhere = crate::store::home().join("secret.png");
        std::fs::write(&elsewhere, b"owner's").unwrap();
        assert_eq!(picture(&elsewhere.to_string_lossy()), None, "a file outside the tool's own pictures");
        let named_like_one = crate::store::home().join("shots").join("challenge-x-1.png.link");
        std::fs::write(&named_like_one, b"x").unwrap();
        assert_eq!(picture(&named_like_one.to_string_lossy()), None);
        let link = crate::store::home().join("shots").join("challenge-link-1.png");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
            assert_eq!(picture(&link.to_string_lossy()), None, "a link in the folder to a file outside it");
        }
        assert_eq!(picture("/etc/hosts"), None);
    }
}
