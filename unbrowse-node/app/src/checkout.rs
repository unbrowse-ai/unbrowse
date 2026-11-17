//! A checkout page as the browser itself knows it: measured by the node over the browser's own protocol, never by
//! script in the page.
//!
//! An owner's yes to paying with a card is bound to what they were shown: the document the tab holds and the state of
//! its form. Both are read here from the browser's DevTools protocol (`Page.getFrameTree` for the main frame's own id
//! and loader id, `DOMSnapshot.captureSnapshot` for every control's live value, choice and attributes), in the
//! renderer's own terms: nothing the page's script defines (a replaced `JSON.stringify`, a getter, a prototype) takes
//! part, no event is sent to the page, and no script runs in it. A frame from another origin runs in a process of its
//! own: it is attached to and measured the same way, so the form inside an embedded checkout counts too. The digest
//! is taken here, in the node.
//!
//! What is compared ([`same_order`]) is the order as the owner approved it: every control but the card's own fields
//! must read exactly as it did. A card's field is a control the node itself filled from the card ([`filled_by`]): one
//! the browser let only a card input take (number, expiry, code), or one the page marks as a card's own
//! (`autocomplete="cc-…"`), that went from empty to the value typed. Any other control that changed fails.

use std::collections::HashSet;
use std::time::Duration;

use agent_browser_core::cdp::client::CdpClient;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// One form control as the browser reads it: where it is, what it is, and what it holds, the value kept only as a
/// keyed digest ([`mark`]), never itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Control {
    /// The frame the control is in, by the browser's id for it.
    pub frame: String,
    pub tag: String,
    /// The attributes that decide what the form sends and where: kind, name, id, form, action, method, target, state.
    pub attrs: Vec<(String, String)>,
    /// The live value, and the same as a card field would compare it ([`norm`]), each as a [`mark`].
    pub value: [u8; 32],
    pub value_norm: [u8; 32],
    pub empty: bool,
    pub checked: bool,
    pub selected: bool,
    /// Whether the browser lays the control out where it can be seen: it has a box, and isn't hidden or transparent.
    pub visible: bool,
}

/// A checkout page as the browser knows it now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Measured {
    /// The browser's own name for the document the tab shows: its main frame's loader id, which only a new load changes.
    pub document: String,
    /// The main frame's id, which stays with the tab.
    pub frame: String,
    /// The address the browser says the main frame is at.
    pub url: String,
    /// Every control of every frame of the page, in document order.
    pub controls: Vec<Control>,
    /// The addresses of the frames of other origins the page holds (a payment provider's, say), as the browser
    /// attached them: the sites a payment on this page may be sent through.
    pub frames: Vec<String>,
    /// The origin of every frame in the page's frame tree, the page's own first, then sorted: how many frames, and
    /// from where.
    pub frame_tree: Vec<String>,
}

/// An address as the owner's checkout is bound to it: without its fragment, which the page changes without loading
/// anything.
fn canonical(url: &str) -> &str {
    url.split('#').next().unwrap_or_default()
}

/// The origin of `url`, as the frame tree is bound to it.
fn origin(url: &str) -> String {
    url::Url::parse(url).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| url.to_string())
}

/// The key the node's digests of field values are made with, made fresh for each run of the node and never written
/// anywhere: a value's digest says nothing of the value to anyone who can't ask this process.
fn key() -> &'static [u8; 32] {
    static KEY: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let mut k = [0u8; 32];
        getrandom::fill(&mut k).expect("the system's randomness");
        k
    })
}

/// The node's keyed digest of `value`.
pub fn mark(value: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(key());
    h.update(value.as_bytes());
    h.finalize().into()
}

/// A value as a card's field is compared: its digits when it has any (a number the page spaces out, an expiry it
/// writes `12 / 28`), else its letters and digits in lower case (a name).
/// A value is first folded to its compatibility form (NFKC: full-width and other compatibility digits become ASCII).
pub fn norm(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let folded: String = value.nfkc().collect();
    let digits: String = folded.chars().filter(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        return digits;
    }
    folded.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The mark a card field's value leaves in the controls once it is typed: what [`same_order`] lets an empty field
/// become.
pub fn card_mark(value: &str) -> [u8; 32] {
    mark(&norm(value))
}

/// The attributes kept of a control: those that decide what its form sends, and where.
const KEPT: &[&str] = &[
    "autocomplete", "type", "name", "id", "form", "action", "method", "enctype", "target", "formaction", "formmethod", "formenctype", "formtarget", "hidden",
    "disabled", "readonly", "required", "multiple", "inert",
];

/// The controls of one `DOMSnapshot.captureSnapshot` answer, every document in it, in order.
pub fn controls_of(snapshot: &Value) -> Vec<Control> {
    let strings: Vec<&str> = snapshot["strings"].as_array().map(|a| a.iter().map(|s| s.as_str().unwrap_or_default()).collect()).unwrap_or_default();
    let s = |i: &Value| i.as_i64().and_then(|i| usize::try_from(i).ok()).and_then(|i| strings.get(i).copied()).unwrap_or_default();
    let mut out = Vec::new();
    for doc in snapshot["documents"].as_array().into_iter().flatten() {
        let frame = s(&doc["frameId"]).to_string();
        let nodes = &doc["nodes"];
        let names = nodes["nodeName"].as_array().cloned().unwrap_or_default();
        let rare_string = |field: &str, i: usize| -> Option<String> {
            let idx = nodes[field]["index"].as_array()?;
            let at = idx.iter().position(|x| x.as_u64() == Some(i as u64))?;
            Some(s(&nodes[field]["value"][at]).to_string())
        };
        let rare_bool = |field: &str, i: usize| nodes[field]["index"].as_array().is_some_and(|idx| idx.iter().any(|x| x.as_u64() == Some(i as u64)));
        // The layout the browser made: a node with a box, and its `visibility` and `opacity` (asked for in that order).
        let layout = &doc["layout"];
        let shown = |i: usize| -> bool {
            let Some(at) = layout["nodeIndex"].as_array().and_then(|idx| idx.iter().position(|x| x.as_u64() == Some(i as u64))) else { return false };
            let style = &layout["styles"][at];
            let visibility = s(&style[0]);
            let opacity: f64 = s(&style[1]).parse().unwrap_or(1.0);
            !matches!(visibility, "hidden" | "collapse") && opacity > 0.0
        };
        for (i, n) in names.iter().enumerate() {
            let tag = s(n).to_ascii_uppercase();
            if !matches!(tag.as_str(), "FORM" | "INPUT" | "SELECT" | "OPTION" | "TEXTAREA" | "BUTTON") {
                continue;
            }
            let raw: Vec<&str> = nodes["attributes"][i].as_array().map(|a| a.iter().map(&s).collect()).unwrap_or_default();
            let mut attrs: Vec<(String, String)> = raw
                .chunks(2)
                .filter_map(|kv| {
                    let k = kv.first()?.to_ascii_lowercase();
                    // An option's and a button's own value is what they submit; an input's is its live value, below.
                    let keep = KEPT.contains(&k.as_str()) || (k == "value" && matches!(tag.as_str(), "OPTION" | "BUTTON"));
                    keep.then(|| (k, kv.get(1).copied().unwrap_or_default().to_string()))
                })
                .collect();
            attrs.sort();
            let value = rare_string("inputValue", i).or_else(|| rare_string("textValue", i)).unwrap_or_default();
            out.push(Control {
                frame: frame.clone(),
                tag,
                attrs,
                value: mark(&value),
                value_norm: card_mark(&value),
                empty: value.is_empty(),
                checked: rare_bool("inputChecked", i),
                selected: rare_bool("optionSelected", i),
                visible: shown(i),
            });
        }
    }
    out
}

/// Whether the page reads `now` as the owner approved it in `approved`, the card's own fields aside: the same
/// document, the same controls in the same frames with the same attributes, choices and values. A field may differ
/// only by going from empty to a value whose mark is in `card` (one the node typed from the card the owner approved).
/// Says what changed, never a value.
pub fn same_order(approved: &Measured, now: &Measured, card: &[CardControl]) -> Result<(), String> {
    if approved.document != now.document || approved.frame != now.frame {
        return Err("the checkout loaded again since the owner approved the card".into());
    }
    if canonical(&approved.url) != canonical(&now.url) {
        return Err("the checkout's address changed since the owner approved the card".into());
    }
    if approved.frame_tree != now.frame_tree {
        return Err("the checkout's frames changed since the owner approved the card (one added, removed, or from another origin)".into());
    }
    if approved.controls.len() != now.controls.len() {
        return Err("the checkout's form gained or lost fields since the owner approved the card".into());
    }
    let card: HashSet<(usize, &[u8; 32])> = card.iter().map(|c| (c.index, &c.mark)).collect();
    for (n, (a, b)) in approved.controls.iter().zip(&now.controls).enumerate() {
        if a.frame != b.frame || a.tag != b.tag || a.attrs != b.attrs {
            return Err(format!("field {} of the checkout ({}) is another field than the owner was shown", n + 1, b.tag.to_ascii_lowercase()));
        }
        if a.visible != b.visible {
            return Err(format!("a field of the checkout (field {}) was shown or hidden since the owner approved the card", n + 1));
        }
        if a.checked != b.checked || a.selected != b.selected {
            return Err(format!("a choice on the checkout (field {}) changed since the owner approved the card", n + 1));
        }
        if a.value != b.value && !(a.empty && card.contains(&(n, &b.value_norm))) {
            return Err(format!("a value on the checkout (field {}) changed since the owner approved the card", n + 1));
        }
    }
    Ok(())
}

/// A control the node filled from a card: its place among the page's controls, and the mark of what went in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardControl {
    pub index: usize,
    pub mark: [u8; 32],
}

/// The controls one fill of `value` made a card's field, read from the page measured `before` and `after` it: each
/// control that went from empty to `value` and is one a card's value may sit in, because the browser took the fill
/// only into an input made for a card (`made_for_a_card`, the number, expiry and code) or because the page marks it a
/// card's own (`autocomplete="cc-…"`). Another control that changed is no card's field, and the next comparison fails
/// on it.
pub fn filled_by(before: &Measured, after: &Measured, value: &str, made_for_a_card: bool) -> Vec<CardControl> {
    if before.document != after.document || before.controls.len() != after.controls.len() {
        return Vec::new();
    }
    let mark = card_mark(value);
    before
        .controls
        .iter()
        .zip(&after.controls)
        .enumerate()
        .filter(|(_, (b, a))| b.value != a.value && b.empty && a.value_norm == mark)
        .filter(|(_, (_, a))| made_for_a_card || a.attrs.iter().any(|(k, v)| k == "autocomplete" && v.split_whitespace().any(|t| t.to_ascii_lowercase().starts_with("cc-"))))
        .map(|(index, _)| CardControl { index, mark })
        .collect()
}

/// How long the node waits for the browser to attach the frames that run in processes of their own.
const FRAMES_WAIT: Duration = Duration::from_millis(400);
/// How deep frames inside frames are followed.
const FRAMES_DEEPEST: usize = 4;

/// The checkout `target` of the browser at `ws` shows, as the browser knows it.
pub async fn measure_at(ws: &str, target: &str) -> Result<Measured, String> {
    let cdp = CdpClient::connect(ws).await.map_err(|e| format!("couldn't reach the browser's DevTools: {e}"))?;
    let out = measure_with(&cdp, target).await;
    cdp.close().await;
    out
}

async fn measure_with(cdp: &CdpClient, target: &str) -> Result<Measured, String> {
    let attached = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": target, "flatten": true })), None).await?;
    let session = attached["sessionId"].as_str().ok_or("the browser didn't attach to the checkout's tab")?.to_string();
    let measured = async {
        let tree = cdp.send_command("Page.getFrameTree", None, Some(&session)).await?;
        let frame = &tree["frameTree"]["frame"];
        let frame_tree = frame_tree_of(&tree["frameTree"]);
        let document = frame["loaderId"].as_str().filter(|d| !d.is_empty()).ok_or("the browser can't name the checkout's document")?;
        let mut controls = Vec::new();
        let mut events = cdp.subscribe();
        let mut sessions = vec![(session.clone(), 0usize)];
        let mut children = Vec::new();
        let mut attaching: Vec<String> = Vec::new();
        let mut frames: Vec<String> = Vec::new();
        let mut at = 0;
        while at < sessions.len() {
            let (s, depth) = sessions[at].clone();
            at += 1;
            let snap = cdp.send_command("DOMSnapshot.captureSnapshot", Some(json!({ "computedStyles": ["visibility", "opacity"] })), Some(&s)).await?;
            controls.extend(controls_of(&snap));
            if depth >= FRAMES_DEEPEST {
                continue;
            }
            // The frames this one holds that run in a process of their own: attached, measured, and let go.
            cdp.send_command("Target.setAutoAttach", Some(json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true })), Some(&s)).await?;
            let until = tokio::time::Instant::now() + FRAMES_WAIT;
            while let Ok(Ok(e)) = tokio::time::timeout_at(until, events.recv()).await {
                if e.method == "Target.attachedToTarget" && e.session_id.as_deref() == Some(s.as_str()) {
                    if let Some(url) = e.params["targetInfo"]["url"].as_str() {
                        frames.push(url.to_string());
                    }
                    if let Some(child) = e.params["sessionId"].as_str() {
                        children.push(child.to_string());
                        sessions.push((child.to_string(), depth + 1));
                    }
                }
            }
            attaching.push(s);
        }
        // The page's own frame tree leaves out the frames running in a process of their own: each attached one adds its
        // own tree, so the bound tree has every frame of the page.
        let mut frame_tree = frame_tree;
        let mut others: Vec<String> = frame_tree.split_off(1);
        for child in &children {
            if let Ok(t) = cdp.send_command("Page.getFrameTree", None, Some(child)).await {
                others.extend(frame_tree_of(&t["frameTree"]));
            }
        }
        others.sort();
        frame_tree.extend(others);
        // Turning auto-attach off lets the frames go, so it is turned off only once every one of them is measured.
        for s in attaching.iter().rev() {
            let _ = cdp.send_command("Target.setAutoAttach", Some(json!({ "autoAttach": false, "waitForDebuggerOnStart": false, "flatten": true })), Some(s)).await;
        }
        for child in &children {
            let _ = cdp.send_command("Target.detachFromTarget", Some(json!({ "sessionId": child })), None).await;
        }
        Ok::<_, String>(Measured {
            document: format!("document:{document}"),
            frame: frame["id"].as_str().unwrap_or_default().to_string(),
            url: frame["url"].as_str().unwrap_or_default().to_string(),
            controls,
            frames,
            frame_tree,
        })
    }
    .await;
    let _ = cdp.send_command("Target.detachFromTarget", Some(json!({ "sessionId": session })), None).await;
    measured
}

/// The origins of every frame in a `Page.getFrameTree` answer: the page's own first, the rest sorted.
pub fn frame_tree_of(tree: &Value) -> Vec<String> {
    fn walk(node: &Value, out: &mut Vec<String>) {
        for child in node["childFrames"].as_array().into_iter().flatten() {
            out.push(origin(child["frame"]["url"].as_str().unwrap_or_default()));
            walk(child, out);
        }
    }
    let mut rest = Vec::new();
    walk(tree, &mut rest);
    rest.sort();
    let mut all = vec![origin(tree["frame"]["url"].as_str().unwrap_or_default())];
    all.extend(rest);
    all
}

/// The checkout `tab` of `site`'s browser shows, as the browser knows it. Blocking. Fails closed: a browser whose
/// DevTools or tab can't be reached gets no card.
pub fn measure(site: &str, tab: &str) -> Result<Measured, String> {
    let ws = crate::browse::cdp_of(site).ok_or("the node can't reach the checkout's browser over its DevTools, so it fills no card there")?;
    let target = crate::browse::target_of(site, tab).ok_or("the node can't find the checkout's tab in its browser")?;
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(measure_at(&ws, &target))
}

/// A measured checkout for tests elsewhere: one form with a hidden amount and an empty card field, in `document`.
#[cfg(test)]
pub(crate) fn fixture(document: &str, amount: &str, pan: &str) -> Measured {
    let control = |tag: &str, name: &str, value: &str| Control {
        frame: "F1".into(),
        tag: tag.into(),
        attrs: vec![("name".into(), name.into())],
        value: mark(value),
        value_norm: card_mark(value),
        empty: value.is_empty(),
        checked: false,
        selected: false,
        visible: true,
    };
    Measured {
        document: document.into(),
        frame: "F1".into(),
        url: "https://pay.example/checkout".into(),
        controls: vec![control("INPUT", "amount", amount), control("INPUT", "pan", pan), control("INPUT", "exp", "")],
        frames: vec!["https://js.provider.example/elements".into()],
        frame_tree: vec!["https://pay.example".into(), "https://js.provider.example".into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(docs: Value) -> Value {
        // A tiny captureSnapshot answer: its own string table, one document per frame.
        let mut strings: Vec<String> = Vec::new();
        let mut id = |s: &str| -> usize {
            if let Some(i) = strings.iter().position(|x| x == s) {
                return i;
            }
            strings.push(s.to_string());
            strings.len() - 1
        };
        let mut documents = Vec::new();
        for d in docs.as_array().unwrap() {
            let mut names = Vec::new();
            let mut attrs = Vec::new();
            let (mut vi, mut vv, mut checked) = (Vec::new(), Vec::new(), Vec::new());
            for (i, n) in d["nodes"].as_array().unwrap().iter().enumerate() {
                names.push(id(n["tag"].as_str().unwrap()));
                let a: Vec<usize> = n["attrs"].as_array().map(|a| a.iter().map(|x| id(x.as_str().unwrap())).collect()).unwrap_or_default();
                attrs.push(a);
                if let Some(v) = n["value"].as_str() {
                    vi.push(i);
                    vv.push(id(v));
                }
                if n["checked"] == json!(true) {
                    checked.push(i);
                }
            }
            documents.push(json!({ "frameId": id(d["frame"].as_str().unwrap()), "nodes": {
                "nodeName": names, "attributes": attrs, "inputValue": { "index": vi, "value": vv }, "inputChecked": { "index": checked } } }));
        }
        json!({ "documents": documents, "strings": strings })
    }

    fn page(amount: &str, pan: &str, action: &str) -> Measured {
        let snap = snapshot(json!([
            { "frame": "F1", "nodes": [
                { "tag": "FORM", "attrs": ["action", action, "method", "post"] },
                { "tag": "INPUT", "attrs": ["type", "hidden", "name", "amount"], "value": amount },
                { "tag": "INPUT", "attrs": ["name", "pan", "autocomplete", "cc-number"], "value": pan },
                { "tag": "BUTTON", "attrs": ["type", "submit"] },
            ] },
            { "frame": "F2", "nodes": [ { "tag": "INPUT", "attrs": ["name", "tip"], "value": "0" } ] },
        ]));
        Measured { document: "document:L1".into(), frame: "F1".into(), url: "https://pay.example/checkout".into(), controls: controls_of(&snap), frames: Vec::new(), frame_tree: vec!["https://pay.example".into()] }
    }

    /// The order is what the owner approved, measured from the browser's own snapshot: a card field going from empty to
    /// the card's own value (however the page spaces it) is the fill; any other change (an amount, an action, a field
    /// in another frame, a new load) is a swap, and is caught. Nothing the page's script does takes part: the digest is
    /// the node's, of values the renderer reports.
    #[test]
    fn checkout_digest_ignores_page_overrides_and_detects_form_swap() {
        let approved = page("10.00", "", "/pay");
        let typed = [CardControl { index: 2, mark: card_mark("4242424242424242") }];
        assert_eq!(same_order(&approved, &page("10.00", "", "/pay"), &[]), Ok(()));
        assert_eq!(same_order(&approved, &page("10.00", "4242 4242 4242 4242", "/pay"), &typed), Ok(()), "the card typed, as the page formats it");
        assert!(same_order(&approved, &page("990.00", "4242424242424242", "/pay"), &typed).is_err(), "the amount changed");
        assert!(same_order(&approved, &page("10.00", "4242424242424242", "https://elsewhere.example/pay"), &typed).is_err(), "the form sends elsewhere");
        assert!(same_order(&approved, &page("10.00", "5555555555554444", "/pay"), &typed).is_err(), "another number than the node typed");
        let mut other_frame = page("10.00", "", "/pay");
        other_frame.controls.last_mut().unwrap().value = mark("5");
        assert!(same_order(&approved, &other_frame, &[]).is_err(), "a value in a frame of another origin");
        let mut reloaded = page("10.00", "", "/pay");
        reloaded.document = "document:L2".into();
        assert!(same_order(&approved, &reloaded, &[]).is_err(), "the page loaded again");
        // An amount that was set can't become "the card": only an empty field takes the card.
        let filled_amount = page("4242424242424242", "", "/pay");
        assert!(same_order(&page("10.00", "", "/pay"), &filled_amount, &typed).is_err());
        // A card's value in a field the node didn't fill it into (an empty tip box given the card's year) is no card.
        let mut empty_amount = page("", "", "/pay");
        assert_eq!(same_order(&empty_amount.clone(), &empty_amount, &[]), Ok(()));
        empty_amount.controls[1].value = mark("4242424242424242");
        empty_amount.controls[1].value_norm = card_mark("4242424242424242");
        assert!(same_order(&page("", "", "/pay"), &empty_amount, &typed).is_err(), "the card's value in another field");
        // What comes back says which field, never what it held.
        let why = same_order(&approved, &page("990.00", "", "/pay"), &[]).unwrap_err();
        assert!(!why.contains("990") && !why.contains("10.00"), "{why}");
    }

    /// What the owner approved is bound beyond the controls: the page's address (a same-document `pushState` to another
    /// order is caught; a fragment isn't an order), its frame tree (a frame added, removed or from another origin), and
    /// which controls are shown.
    #[test]
    fn the_approval_binds_the_address_the_frames_and_what_is_shown() {
        let approved = page("10.00", "", "/pay");
        let mut moved = approved.clone();
        moved.url = "https://pay.example/checkout?order=2".into();
        assert!(same_order(&approved, &moved, &[]).unwrap_err().contains("address"));
        let mut fragment = approved.clone();
        fragment.url = "https://pay.example/checkout#review".into();
        assert_eq!(same_order(&approved, &fragment, &[]), Ok(()));
        let mut framed = approved.clone();
        framed.frame_tree.push("https://other-pay.example".into());
        assert!(same_order(&approved, &framed, &[]).unwrap_err().contains("frames"));
        let mut hidden = approved.clone();
        hidden.controls[1].visible = !hidden.controls[1].visible;
        assert!(same_order(&approved, &hidden, &[]).unwrap_err().contains("shown or hidden"));
        let tree = json!({ "frame": { "url": "https://pay.example/checkout" }, "childFrames": [
            { "frame": { "url": "https://z.example/a" }, "childFrames": [ { "frame": { "url": "https://a.example/b" } } ] },
        ] });
        assert_eq!(frame_tree_of(&tree), ["https://pay.example", "https://a.example", "https://z.example"]);
    }

    /// Between two card fields, nothing else on the checkout may change: the expiry goes in only while every other
    /// control reads as the owner approved it.
    #[test]
    fn card_approval_rejects_non_card_form_mutation_between_fields() {
        let approved = page("10.00", "", "/pay");
        let after_number = page("10.00", "4242424242424242", "/pay");
        let typed = filled_by(&approved, &after_number, "4242424242424242", true);
        assert_eq!(typed.len(), 1, "the number went into its one field");
        assert_eq!(same_order(&approved, &after_number, &typed), Ok(()));
        // A value the page doesn't mark as a card's, filled where the browser didn't hold it to a card input: no card.
        assert!(!filled_by(&page("10.00", "", "/pay"), &page("10.00", "2028", "/pay"), "2028", false).is_empty(), "the field marks itself cc-number");
        let mut tip_before = page("10.00", "", "/pay");
        let mut tip_after = page("10.00", "", "/pay");
        for m in [&mut tip_before, &mut tip_after] {
            m.controls[2].attrs.retain(|(k, _)| k != "autocomplete");
        }
        tip_after.controls[2].value = mark("2028");
        tip_after.controls[2].value_norm = card_mark("2028");
        assert!(filled_by(&tip_before, &tip_after, "2028", false).is_empty(), "a year typed into a box the page doesn't call a card's");
        assert!(same_order(&tip_before, &tip_after, &filled_by(&tip_before, &tip_after, "2028", false)).is_err());
        let script_changed_it = page("12.00", "4242424242424242", "/pay");
        assert!(same_order(&approved, &script_changed_it, &typed).is_err());
    }

    /// A live checkout in the real browser, measured by the node over the browser's own protocol. The page replaces
    /// every global a page-side digest would lean on and arms focus, hover and scroll handlers that change the order and
    /// submit it; it holds a frame from another origin (its own process) with a field of its own. The measurement sees
    /// the controls of both, catches a hidden amount the page's script changes and a value changed inside the other
    /// origin's frame, takes the card typed as the fill, and fires none of the page's handlers itself; a focus sent to
    /// the page does fire them, which is why no such command reaches a page a card is in (`browse::card_safe`).
    #[test]
    #[ignore = "drives Chrome: cargo test -p unbrowse-node-app a_live_checkout -- --ignored"]
    fn a_live_checkout_is_measured_by_the_browser_not_the_page() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let checkout = format!(
            r#"<!doctype html><html><body>
<form id="f" action="/pay" method="post">
  <input type="hidden" name="amount" value="10.00">
  <input name="pan" id="pan" autocomplete="cc-number" value="">
  <button type="submit">Pay</button>
</form>
<iframe id="tipframe" src="http://localhost:{port}/frame" width="200" height="50"></iframe>
<div style="height:3000px"></div>
<script>
  window.fired = 0;
  const realSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const swap = () => {{ window.fired++; realSet.call(document.querySelector('[name=amount]'), '990.00'); }};
  document.getElementById('pan').addEventListener('focus', swap);
  document.getElementById('pan').addEventListener('mouseover', swap);
  window.addEventListener('scroll', swap);
  // Everything a digest computed in the page would trust, replaced.
  JSON.stringify = () => 'constant';
  Array.from = () => [];
  Math.imul = () => 0;
  Object.defineProperty(HTMLInputElement.prototype, 'value', {{ get() {{ return 'forged'; }}, set(v) {{}} }});
</script></body></html>"#
        );
        let frame = r#"<!doctype html><html><body><input name="tip" id="tip" value="0"></body></html>"#.to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.starts_with("GET /frame") { frame.clone() } else { checkout.clone() };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let path = agent_browser_core::cdp::chrome::find_chrome().expect("Chrome, or Chrome for Testing from `agent-browser install`");
        let profile = std::env::temp_dir().join(format!("checkout-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let mut child = std::process::Command::new(path)
            .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--site-per-process"])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut ws = None;
        for _ in 0..150 {
            if let Some((p, path)) = agent_browser_core::cdp::chrome::read_devtools_active_port(&profile) {
                ws = Some(format!("ws://127.0.0.1:{p}{path}"));
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let ws = ws.expect("Chrome opened its DevTools");
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let result = rt.block_on(async {
            let cdp = CdpClient::connect(&ws).await?;
            let t = cdp.send_command("Target.createTarget", Some(json!({ "url": format!("http://127.0.0.1:{port}/checkout") })), None).await?;
            let target = t["targetId"].as_str().unwrap().to_string();
            let s = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": target, "flatten": true })), None).await?;
            let page = s["sessionId"].as_str().unwrap().to_string();
            let eval = |session: String, expr: &'static str| {
                let cdp = &cdp;
                async move { cdp.send_command("Runtime.evaluate", Some(json!({ "expression": expr, "returnByValue": true })), Some(&session)).await.map(|r| r["result"]["value"].clone()) }
            };
            for _ in 0..100 {
                if eval(page.clone(), "document.readyState === 'complete' && !!document.getElementById('tipframe').contentWindow").await? == json!(true) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
            let approved = measure_at(&ws, &target).await?;
            let names: Vec<String> = approved.controls.iter().flat_map(|c| c.attrs.iter().filter(|(k, _)| k == "name").map(|(_, v)| v.clone())).collect();
            assert!(names.contains(&"amount".to_string()) && names.contains(&"pan".to_string()), "the page's controls: {names:?}");
            assert!(names.contains(&"tip".to_string()), "the other origin's frame is measured too: {names:?}");
            assert!(approved.frames.iter().any(|f| f.starts_with("http://localhost")), "and named: {:?}", approved.frames);
            assert!(approved.document.starts_with("document:") && approved.url.contains("/checkout"));
            assert_eq!(eval(page.clone(), "window.fired").await?, json!(0), "measuring fired none of the page's handlers");
            assert_eq!(approved.frame_tree.len(), 2, "the page and its one frame: {:?}", approved.frame_tree);
            // A same-document move to another order's address, a field hidden, a frame added: each caught.
            eval(page.clone(), "history.pushState({}, '', '/checkout?order=2'); true").await?;
            assert!(same_order(&approved, &measure_at(&ws, &target).await?, &[]).unwrap_err().contains("address"));
            eval(page.clone(), "history.pushState({}, '', '/checkout'); document.querySelector('[name=pan]').style.visibility = 'hidden'; true").await?;
            assert!(same_order(&approved, &measure_at(&ws, &target).await?, &[]).unwrap_err().contains("shown or hidden"));
            eval(page.clone(), "document.querySelector('[name=pan]').style.visibility = ''; const f = document.createElement('iframe'); f.id = 'extra'; f.src = 'about:blank'; document.body.appendChild(f); true").await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(same_order(&approved, &measure_at(&ws, &target).await?, &[]).unwrap_err().contains("frames"));
            eval(page.clone(), "document.getElementById('extra').remove(); true").await?;
            assert_eq!(same_order(&approved, &measure_at(&ws, &target).await?, &[]), Ok(()), "back as approved");
            // The page's own script changes the hidden amount: caught, though every global a page-side digest uses lies.
            eval(page.clone(), "document.querySelector('[name=amount]').setAttribute('value', '990.00'); true").await?;
            let swapped = measure_at(&ws, &target).await?;
            assert!(same_order(&approved, &swapped, &[]).is_err(), "the amount the page changed is caught");
            eval(page.clone(), "document.querySelector('[name=amount]').setAttribute('value', '10.00'); true").await?;
            let back = measure_at(&ws, &target).await?;
            assert_eq!(same_order(&approved, &back, &[]), Ok(()), "as approved again");
            // The node types the card (here, the browser's own input, as the fill does): the fill, not a swap.
            cdp.send_command("DOM.enable", None, Some(&page)).await?;
            let doc = cdp.send_command("DOM.getDocument", None, Some(&page)).await?;
            let pan = cdp.send_command("DOM.querySelector", Some(json!({ "nodeId": doc["root"]["nodeId"], "selector": "#pan" })), Some(&page)).await?;
            let fired_before = eval(page.clone(), "window.fired").await?;
            // A focus sent to the page runs its handler, which changes the order: the reason no such command reaches it.
            cdp.send_command("DOM.focus", Some(json!({ "nodeId": pan["nodeId"] })), Some(&page)).await?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert_ne!(eval(page.clone(), "window.fired").await?, fired_before, "a focus runs the page's handler");
            cdp.send_command("Input.insertText", Some(json!({ "text": "4242 4242 4242 4242" })), Some(&page)).await?;
            let typed = measure_at(&ws, &target).await?;
            let pan_at = approved.controls.iter().position(|c| c.attrs.iter().any(|(k, v)| k == "name" && v == "pan")).unwrap();
            let mark = [CardControl { index: pan_at, mark: card_mark("4242424242424242") }];
            assert!(same_order(&approved, &typed, &mark).is_err(), "the focus handler's amount change is caught beside the card");
            // A value inside the other origin's frame, changed by that frame's own script: caught.
            let targets = cdp.send_command("Target.getTargets", None, None).await?;
            let frame_target = targets["targetInfos"].as_array().unwrap().iter().find(|t| t["type"] == "iframe").map(|t| t["targetId"].as_str().unwrap().to_string());
            let frame_target = frame_target.ok_or("the other origin's frame runs in a process of its own (--site-per-process)".to_string())?;
            let fs = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": frame_target, "flatten": true })), None).await?;
            let fsession = fs["sessionId"].as_str().unwrap().to_string();
            eval(fsession, "document.getElementById('tip').value = '50'; true").await?;
            let tipped = measure_at(&ws, &target).await?;
            let before_tip = typed;
            assert!(same_order(&before_tip, &tipped, &[]).is_err(), "a value in the other origin's frame is caught");
            // Another load of the page is another document.
            cdp.send_command("Page.reload", None, Some(&page)).await?;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let reloaded = measure_at(&ws, &target).await?;
            assert_ne!(reloaded.document, approved.document, "a reload is another document");
            cdp.close().await;
            Ok::<_, String>(())
        });
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&profile);
        result.unwrap();
    }

    /// The node's digest of a value is keyed: the same value marks the same within a run, and a mark of a card's
    /// digits is no hash anyone could test card numbers against.
    #[test]
    fn a_card_mark_is_keyed_and_normalised() {
        assert_eq!(card_mark("4242 4242 4242 4242"), card_mark("4242-4242-4242-4242"));
        assert_eq!(card_mark("12 / 28"), card_mark("1228"));
        assert_eq!(card_mark("Ada Lovelace"), card_mark("ada lovelace"));
        assert_ne!(card_mark("4242424242424242").to_vec(), Sha256::digest(b"4242424242424242").to_vec());
        assert_eq!(norm("４２４２"), "4242", "full-width digits are digits");
    }
}
