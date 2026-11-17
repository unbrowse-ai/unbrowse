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
    show(who, site, session, url, None)
}

/// Takes one step on the page and shows it again, so the agent sees what its step did.
pub fn act(who: &str, site: &str, session: &str, act: Act) -> Result<Value, String> {
    show(who, site, session, "", Some(act))
}

fn show(who: &str, site: &str, session: &str, url: &str, act: Option<Act>) -> Result<Value, String> {
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
    crate::browse::in_the_sites_turn(&site.clone(), format!("a challenge step for {who}"), || shown(who, &site, session, act))
}

/// The browse commands a challenge call amounts to, for the one page policy (`browse::page_policy`) to judge: its step
/// (a click, a drag, typed text, a key), the picture it may take, and the page's words it reads back.
fn what_it_does(act: Option<&Act>) -> Vec<Vec<String>> {
    let mut all = Vec::new();
    if let Some(a) = act.filter(|a| !matches!(a, Act::Wait(_) | Act::Done)) {
        all.push(vec![a.command().to_string()]);
    }
    all.push(vec!["screenshot".to_string()]);
    all.push(vec!["get".to_string(), "text".to_string(), "body".to_string()]);
    all
}

fn shown(_who: &str, site: &str, session: &str, act: Option<Act>) -> Result<Value, String> {
    let site = site.to_string();
    // The step, the picture and the words read back each cross the same page policy `unbrowse_browse` does, before
    // anything reaches the page: the tab, the owner's hand-off, the pause, the exclusions, the card hold, and the secret
    // rules. A picture can't be scrubbed, so a page that may hold a secret the node filled or the owner typed gets no
    // picture taken, by the same test browse's `screenshot` meets; the words are scrubbed of every secret below.
    for args in what_it_does(act.as_ref()) {
        crate::browse::page_policy(&site, session, &args)?;
    }
    let tab = crate::browse::tab_of(session);
    let cdp = crate::browse::cdp_of(&site).ok_or_else(|| format!("{site}'s browser isn't open: it opens when an agent browses the site"))?;
    let target = crate::browse::target_of(&site, &tab).ok_or("the session's tab isn't open in that browser")?;
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let opened = rt.block_on(open(&cdp, &target))?;
    let mut page = CdpPage { rt, client: opened.client, session: opened.session, viewport: opened.viewport, url: opened.url, title: opened.title };
    let done = matches!(act, Some(Act::Done));
    if let Some(act) = &act {
        match take(&mut page, act) {
            Ok(()) => note(&site, session, act.said()),
            Err(e) => note(&site, session, format!("{} failed: {e}", act.said())),
        }
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
    let shot = if state.asks_a_person { Some(page.shot()?) } else { None };
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
    viewport: (f64, f64),
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

async fn layout(client: &CdpClient, session: &str) -> (f64, f64) {
    client
        .send_command("Page.getLayoutMetrics", None, Some(session))
        .await
        .ok()
        .and_then(|m| {
            let v = m.get("cssVisualViewport")?;
            Some((v.get("clientWidth")?.as_f64()?, v.get("clientHeight")?.as_f64()?))
        })
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
        .unwrap_or((1280.0, 800.0))
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
    viewport: (f64, f64),
    url: String,
    title: String,
}

impl CdpPage {
    fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        self.rt.block_on(async { self.client.send_command(method, Some(params), Some(&self.session)).await })
    }
}

impl Page for CdpPage {
    fn shot(&mut self) -> Result<Shot, String> {
        let (w, h) = self.viewport;
        let said = self.send(
            "Page.captureScreenshot",
            json!({ "format": "png", "clip": { "x": 0.0, "y": 0.0, "width": w, "height": h, "scale": 1.0 }, "captureBeyondViewport": false }),
        )?;
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
        let said = self.send(
            "Runtime.evaluate",
            json!({
                "expression": "JSON.stringify((()=>{const f=(document.documentElement&&document.documentElement.outerHTML)||'';const cut=f.length>300000;return {url:location.href,title:document.title,text:(document.body&&document.body.innerText||'').slice(0,4000),html:f.slice(0,300000),body:cut?((document.body&&document.body.outerHTML)||'').slice(0,300000):'',cut:cut,answered:[...document.querySelectorAll('input,textarea')].some(e=>/-response$/i.test(e.name||'')&&String(e.value||'').length>0)}})())",
                "returnByValue": true
            }),
        )?;
        let raw = said.pointer("/result/value").and_then(|v| v.as_str()).ok_or("the page said nothing")?;
        let v: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        self.url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
        self.title = v.get("title").and_then(|t| t.as_str()).unwrap_or_default().to_string();
        let html = {
            let whole = v.get("html").and_then(|h| h.as_str()).unwrap_or_default().to_string();
            let body = v.get("body").and_then(|h| h.as_str()).unwrap_or_default().to_string();
            let cut = v.get("cut").and_then(|c| c.as_bool()).unwrap_or(false);
            page_act::page_or_body(&whole, &body, cut).to_string()
        };
        let text = v.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string();
        let at = url::Url::parse(&self.url).ok();
        // A widget that has answered (its `<widget>-response` field holds a token) is the site's own word that the check
        // passed, wherever its frame still sits: the page is no longer asking, even before it navigates.
        let answered = v.get("answered").and_then(|a| a.as_bool()).unwrap_or(false);
        // A page that says, in its own words, that it wants a person: a code to type, a slide, a robot check. The same
        // generic words the test bank labels a challenge by, never a vendor's name; the agent's look settles it.
        let lower = text.to_lowercase();
        let says = |words: &[&str]| words.iter().any(|w| lower.contains(w));
        let cue = wants_a_person(&lower);
        // The site's own word that the check was passed, on the page itself: a code challenge whose page stays put.
        let passed = says(&["验证成功", "verification successful", "captcha is passed", "challenge success"]);
        let asks = !answered && !passed && (at.as_ref().is_some_and(|at| page_act::asks_a_person(&html, at)) || cue);
        Ok(State {
            url: self.url.clone(),
            title: self.title.clone(),
            text,
            asks_a_person: asks,
        })
    }

    fn settle(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms.min(20_000)));
    }
}

/// Whether a page says, in its own words, that it wants a person: a code to type, a box to tick, a slide. The words a
/// page uses for the ask, never a vendor's name. One reading, for the page an agent is shown and for the page a
/// route read back: a check handed over as a route's answer is a wrong success.
pub(crate) fn wants_a_person(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["captcha", "验证码", "完成验证", "您是真人", "verify you are human", "verify you're a human", "verify you’re a human", "confirm you’re human", "confirm you're human", "confirm you are human", "prove your humanity", "please slide to verify", "slide to verify", "i'm not a robot", "i am not a robot", "human verification", "security check", "unusual browser activity", "unusual traffic"]
        .iter()
        .any(|w| lower.contains(w))
}

#[cfg(test)]
mod wants_tests {
    /// The walk that exposed it: a shop's check ("check the box to confirm you’re human") read back as a route's
    /// answer and handed over as ok. A results page that mentions none of it does not ask.
    #[test]
    fn a_page_that_says_it_wants_a_person_is_one_that_asks() {
        assert!(super::wants_a_person("We’re noticing unusual browser activity\nCheck the box to confirm you’re human."));
        assert!(!super::wants_a_person("1-48 of over 30,000 results for flask\nSort by: Featured"));
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
        for a in [Act::Click(10.0, 10.0), Act::Drag((1.0, 1.0), (50.0, 1.0)), Act::Type("hello".into()), Act::Press("Enter".into())] {
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
        let names = |a: Option<&Act>| what_it_does(a).into_iter().map(|c| c.join(" ")).collect::<Vec<_>>();
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
