//! Unbrowse fork: a value that belongs to one site goes only into a field of that site, made to hold it.
//!
//! The node fills a login from its vault, a one-time code or a card by sending `fill` with the `site` the
//! value belongs to and the kind of secret it is (`field`). The field's own document, read in an isolated
//! world the page's script can't reach, must be on that site, and the field must be one made for that kind
//! of secret. The value is then written into the checked element itself, never sent as keyboard input,
//! which lands wherever focus is when it arrives. An agent can't send either field: the CLI parses neither.

use serde_json::{json, Value};

use super::super::actions::DaemonState;
use super::super::cdp::client::CdpClient;
use super::super::cdp::types::{CallArgument, CallFunctionOnParams};
use super::super::element::{frame_owner_object_id, parse_ref, resolve_element_object_id};

/// Whether `cmd` is a fill this module answers: one bound to a site, or naming a kind of secret.
pub fn is_bound(cmd: &Value) -> bool {
    cmd.get("site").is_some() || cmd.get("field").is_some()
}

/// Fills a site-bound value. Says back that the field was checked and, for a card that went into a payment
/// provider's frame the checkout page holds, which origin that frame is.
pub async fn site_bound(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let selector = cmd.get("selector").and_then(Value::as_str).ok_or("Missing 'selector' parameter")?;
    let value = cmd.get("value").and_then(Value::as_str).ok_or("Missing 'value' parameter")?;
    // A kind this engine doesn't know fills nothing: a secret is never written into a field nobody checked.
    let kind = match cmd.get("field").and_then(Value::as_str) {
        Some(k) => Some(SecretField::parse(k).ok_or_else(|| format!("a secret of kind {k} goes into no field this browser knows: nothing was filled"))?),
        None => None,
    };
    let site = cmd.get("site").and_then(Value::as_str).ok_or("a secret's field is checked only with the site it belongs to: nothing was filled")?;
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let (client, page_session) = (&mgr.client, mgr.active_session_id()?.to_string());
    let (object_id, session) = resolve_element_object_id(client, &page_session, &state.ref_map, selector, &state.iframe_sessions).await?;
    // The frame the field was found in: a ref's own, else the frame `frame <sel>` selected for a selector.
    let frame_id = match parse_ref(selector) {
        Some(r) => state.ref_map.get(&r).and_then(|e| e.frame_id.clone()),
        None => state.active_frame_id.clone(),
    };
    let facts = element_facts(client, &session, &object_id, frame_id.as_deref()).await.unwrap_or_default();
    let origin = facts.origin.as_str();
    // A card's field may sit in a frame of another site's that the checkout page put there itself: a payment
    // provider's hosted field. The owner pays on the page they approved; the value goes only into that frame.
    let mut hosted_by = None;
    if !origin_on_site(origin, site) {
        let mut embedder_origin = String::new();
        if let (Some(SecretField::Card), Some(frame)) = (kind, frame_id.as_deref()) {
            // The frame's holder is looked for in the page's own session and each other frame's, never its own.
            let others = state.iframe_sessions.values().map(String::as_str).filter(|s| *s != session && *s != page_session);
            for candidate in std::iter::once(page_session.as_str()).chain(others) {
                if let Ok(owner) = frame_owner_object_id(client, candidate, frame).await {
                    embedder_origin = element_facts(client, candidate, &owner, None).await.map(|f| f.origin).unwrap_or_default();
                    break;
                }
            }
        }
        if let Err(why) = hosted_card_field(kind, &facts, &embedder_origin, site) {
            return Err(format!("the field is in a document from {origin}, not on {site}{why}: nothing was filled"));
        }
        hosted_by = Some(origin.to_string());
    }
    if let Some(kind) = kind {
        kind.takes(&facts).map_err(|why| format!("{why}: nothing was filled"))?;
    }
    // The login's other fields go in with it, into the same form of the same checked document: its account
    // name, and its one-time code where the form has a field marked for one.
    let mut beside = json!({});
    for (what, find) in [("username", USERNAME_FIELD), ("code", CODE_FIELD)] {
        if let Some(text) = cmd.get(what).and_then(Value::as_str) {
            beside[what] = json!(write_beside(client, &session, &object_id, find, text).await);
        }
    }
    write_into_element(client, &session, &object_id, value).await?;
    let mut said = json!({ "filled": selector, "field_checked": kind.is_some(), "beside": beside });
    if let Some(origin) = hosted_by {
        said["frame_origin"] = json!(origin);
    }
    if cmd.get("submit").and_then(Value::as_bool) == Some(true) {
        let mut secrets = vec![value];
        secrets.extend(cmd.get("code").and_then(Value::as_str));
        let (submitted, cleared) = submit_and_clear(client, &page_session, &session, &object_id, &secrets).await;
        said["submitted"] = json!(submitted);
        said["cleared"] = json!(cleared);
    }
    Ok(said)
}

/// Sets a field's value through its prototype's setter and says so to the page, as typing would.
const SET_VALUE: &str = "const set = (e, v) => { let p = Object.getPrototypeOf(e), d; \
    while (p && !(d = Object.getOwnPropertyDescriptor(p, 'value'))) p = Object.getPrototypeOf(p); \
    if (!d || !d.set) return false; d.set.call(e, v); \
    e.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: v ? 'insertText' : 'deleteContentBackward', data: v || null })); \
    e.dispatchEvent(new Event('change', { bubbles: true })); return true; };";

/// The form's fields a person could type in, the secret's own field aside: its form's, or with no form the document's.
const TYPEABLE: &str = "const all = [...((this.form || this.closest('form') || this.ownerDocument).querySelectorAll('input'))] \
    .filter((e) => e !== this && !e.disabled && !e.readOnly && e.getClientRects().length);";

/// The field an account's name goes in: one the form marks for it (`autocomplete` username or email), else the last
/// text, email or phone box before the password.
const USERNAME_FIELD: &str = "const plain = all.filter((e) => ['text', 'email', 'tel', ''].includes(String(e.getAttribute('type') || '').toLowerCase())); \
    const field = plain.find((e) => /username|email/.test(String(e.getAttribute('autocomplete') || '').toLowerCase())) \
      || plain.filter((e) => this.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING).pop();";

/// The field a one-time code goes in: only one the form marks for a code.
const CODE_FIELD: &str = "const field = all.find((e) => String(e.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).includes('one-time-code'));";

/// Writes `text` into the field `find` picks from the form of the element `object_id`. Says `filled`, `same` (it
/// held that already) or `none` (the form has no such field).
async fn write_beside(client: &CdpClient, session: &str, object_id: &str, find: &str, text: &str) -> &'static str {
    let function = format!("function(v) {{ {SET_VALUE} {TYPEABLE} {find} if (!field) return 'none'; if (field.value === v) return 'same'; return set(field, v) ? 'filled' : 'none'; }}");
    let params = json!({ "objectId": object_id, "functionDeclaration": function, "arguments": [{ "value": text }], "returnByValue": true });
    match client.send_command("Runtime.callFunctionOn", Some(params), Some(session)).await.ok().and_then(|r| r.pointer("/result/value")?.as_str().map(String::from)).as_deref() {
        Some("filled") => "filled",
        Some("same") => "same",
        _ => "none",
    }
}

/// How long a submitted form is given to take the page somewhere before what it still holds is cleared.
const SUBMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

/// Submits the form the secret's field is in, right away, then clears every field of the page that still holds one
/// of `secrets`: a sign-in that didn't go through, or a page that shows the password back, never leaves it in a page
/// the agent goes on driving. Answers whether the form was submitted and how many fields were cleared.
async fn submit_and_clear(client: &CdpClient, page_session: &str, session: &str, object_id: &str, secrets: &[&str]) -> (bool, u64) {
    // As a person pressing the form's own button would: its handlers and its checks run. A field in no form takes Enter.
    let submit = "function() { const f = this.form || this.closest('form'); if (!f) return 'none'; \
        const b = f.querySelector('button[type=submit], input[type=submit], button:not([type])'); \
        try { f.requestSubmit(b || undefined); } catch (e) { try { f.requestSubmit(); } catch (e2) { return 'none'; } } return 'form'; }";
    let call = |function: &str| json!({ "objectId": object_id, "functionDeclaration": function, "returnByValue": true, "userGesture": true });
    let how = client.send_command("Runtime.callFunctionOn", Some(call(submit)), Some(session)).await;
    let mut submitted = how.as_ref().ok().and_then(|r| r.pointer("/result/value")?.as_str()) == Some("form");
    if !submitted {
        submitted = super::super::interaction::press_key(client, session, "Enter").await.is_ok();
    }
    // The page has gone on once the field is no longer in it, holds nothing, or its document was replaced (the call fails).
    let still = "function() { return this.isConnected && this.value.length > 0; }";
    let until = std::time::Instant::now() + SUBMIT_WAIT;
    while std::time::Instant::now() < until {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let there = client.send_command("Runtime.callFunctionOn", Some(call(still)), Some(session)).await;
        if there.ok().and_then(|r| r.pointer("/result/value")?.as_bool()) != Some(true) {
            break;
        }
    }
    // The form's answer may be a new document, and one that shows the secret back in its field: it is given the
    // rest of the wait to finish loading, so what it holds is there to be found.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    while std::time::Instant::now() < until {
        let ready = client.send_command("Runtime.evaluate", Some(json!({ "expression": "document.readyState", "returnByValue": true })), Some(page_session)).await;
        if ready.ok().and_then(|r| r.pointer("/result/value")?.as_str().map(|s| s == "complete")) == Some(true) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    // Whatever document each session shows now, read in a world the page's script can't reach.
    let sweep = format!(
        "((secrets) => {{ {SET_VALUE} let n = 0; const walk = (root) => {{ for (const e of root.querySelectorAll('*')) {{ \
           if (e.shadowRoot) walk(e.shadowRoot); \
           if ((e.localName === 'input' || e.localName === 'textarea') && secrets.includes(e.value)) {{ if (set(e, '')) n++; e.removeAttribute('value'); e.defaultValue = ''; }} }} }}; \
           walk(document); return n; }})({})",
        json!(secrets)
    );
    let mut cleared = 0;
    let mut sessions = vec![page_session];
    if session != page_session {
        sessions.push(session);
    }
    for sid in sessions {
        let Ok(tree) = client.send_command_no_params("Page.getFrameTree", Some(sid)).await else { continue };
        let Some(frame) = tree.pointer("/frameTree/frame/id").and_then(Value::as_str) else { continue };
        let world = client.send_command("Page.createIsolatedWorld", Some(json!({ "frameId": frame, "worldName": "unbrowse-site-check" })), Some(sid)).await;
        let Some(context) = world.ok().and_then(|w| w["executionContextId"].as_i64()) else { continue };
        let swept = client.send_command("Runtime.evaluate", Some(json!({ "expression": sweep, "contextId": context, "returnByValue": true })), Some(sid)).await;
        cleared += swept.ok().and_then(|r| r.pointer("/result/value")?.as_u64()).unwrap_or(0);
    }
    (submitted, cleared)
}

/// Which document the active tab shows: its main frame's loader id, which a new load (a navigation, a
/// reload, a form sent) changes and nothing else does. A fragment, `history.pushState` or a page script
/// can't change or fake it, so a node holding something a page may hold asks this, not the address.
pub async fn document(state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let tree = mgr.client.send_command_no_params("Page.getFrameTree", Some(&session_id)).await?;
    let loader = tree["frameTree"]["frame"]["loaderId"].as_str().ok_or("the page has no document")?;
    Ok(json!({ "document": loader }))
}

/// Writes `value` into the element `object_id` names, through its own value setter, then tells the page with the
/// events typing would fire. The write is bound to that object: no other element, and no other frame, can receive
/// it. A field that is disabled, read-only or holds no text value gets nothing.
async fn write_into_element(
    client: &CdpClient,
    session: &str,
    object_id: &str,
    value: &str,
) -> Result<(), String> {
    let written = client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function(v) {
                    if (this.disabled || this.readOnly) return 'the field is not editable';
                    // The prototype's setter, not an instance override, so frameworks that track the
                    // value see the change.
                    let p = Object.getPrototypeOf(this), d;
                    while (p && !(d = Object.getOwnPropertyDescriptor(p, 'value'))) p = Object.getPrototypeOf(p);
                    if (!d || !d.set) return 'the field holds no text value';
                    this.focus();
                    d.set.call(this, v);
                    this.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
                    this.dispatchEvent(new Event('change', { bubbles: true }));
                    return this.value === v ? '' : 'the field did not take the value';
                }"#
                .to_string(),
                object_id: Some(object_id.to_string()),
                arguments: Some(vec![CallArgument {
                    value: Some(Value::String(value.to_string())),
                    object_id: None,
                }]),
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session),
        )
        .await?;
    if written.get("exceptionDetails").is_some() {
        return Err("the field could not be filled".into());
    }
    match written["result"]["value"].as_str() {
        Some("") => Ok(()),
        Some(why) => Err(format!("{why}: nothing was filled")),
        None => Err("the field could not be filled".into()),
    }
}

/// The origin of the document that holds an element: its origin, not its address, so a blank or srcdoc frame has its
/// creator's origin and a sandboxed frame has none ("null"), which is on no site.
///
/// It is read in an isolated world made for the purpose. In the page's own world the page decides what
/// `window.origin` and `ownerDocument` say (the first is replaceable, the second a prototype getter), so a frame could
/// claim any site it likes; an isolated world shares the DOM but none of the page's script. If the element turns out
/// not to be in the frame the world was made in, reading it fails, and an origin that can't be read is on no site.
async fn element_facts(client: &CdpClient, session: &str, object_id: &str, frame_id: Option<&str>) -> Result<FieldFacts, String> {
    let described = client.send_command("DOM.describeNode", Some(json!({ "objectId": object_id })), Some(session)).await?;
    let backend = described["node"]["backendNodeId"].as_i64().ok_or("the field has no node")?;
    let frame = match frame_id {
        Some(f) => f.to_string(),
        None => {
            let tree = client.send_command_no_params("Page.getFrameTree", Some(session)).await?;
            tree["frameTree"]["frame"]["id"].as_str().ok_or("the page has no frame")?.to_string()
        }
    };
    let world = client
        .send_command("Page.createIsolatedWorld", Some(json!({ "frameId": frame, "worldName": "unbrowse-site-check" })), Some(session))
        .await?;
    let context = world["executionContextId"].as_i64().ok_or("no isolated world")?;
    let node = client
        .send_command("DOM.resolveNode", Some(json!({ "backendNodeId": backend, "executionContextId": context })), Some(session))
        .await?;
    let isolated = node["object"]["objectId"].as_str().ok_or("the field isn't in that frame")?;
    let origin = client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": isolated,
                "functionDeclaration": "function() { return { origin: this.ownerDocument.defaultView.origin, tag: (this.localName || '').toLowerCase(), type: String(this.type || '').toLowerCase(), autocomplete: String(this.getAttribute('autocomplete') || '').toLowerCase(), editable: !!this.isContentEditable, max_length: typeof this.maxLength === 'number' ? this.maxLength : -1, secure: !!this.ownerDocument.defaultView.isSecureContext }; }",
                "returnByValue": true,
            })),
            Some(session),
        )
        .await?;
    if origin.get("exceptionDetails").is_some() {
        return Err("the field's origin couldn't be read".into());
    }
    let v = &origin["result"]["value"];
    let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    Ok(FieldFacts {
        origin: v["origin"].as_str().ok_or("the field's origin couldn't be read")?.to_string(),
        tag: text("tag"),
        kind: text("type"),
        autocomplete: text("autocomplete"),
        editable: v["editable"].as_bool().unwrap_or(true),
        max_length: v["max_length"].as_i64().unwrap_or(-1),
        secure: v["secure"].as_bool().unwrap_or(false),
    })
}

/// What a field is, read in the isolated world beside its origin: its element, its `type`, its `autocomplete`
/// tokens, whether it is free-form editable content, its `maxLength` (-1 for none), and whether its document is a
/// secure context (served over https, or from this machine, and so are all the frames around it).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldFacts {
    pub origin: String,
    pub tag: String,
    pub kind: String,
    pub autocomplete: String,
    pub editable: bool,
    pub max_length: i64,
    pub secure: bool,
}

/// Whether a card's value may go into a field whose document is on another site than the checkout's (`site`): a
/// payment provider's hosted field, which a checkout page holds in a frame of the provider's. It may when all of
/// these hold, read from the field and the frame themselves, never from what the page says of them:
///
/// - the value is a card's (a login or a code never leaves its own site's documents);
/// - the element holding the field's frame sits in a document on the checkout's site, so the checkout page put the
///   frame there itself (`embedder_origin`; a frame inside another site's frame, an ad's, gets nothing);
/// - the field is marked for a card (an `autocomplete` token `cc-…`): in another site's frame a short box is not
///   enough to say it is one;
/// - its document is a secure context, so what it is can't be swapped on the way.
///
/// Err says, after a comma, why this field is not such a field; nothing for a value that is not a card's.
pub fn hosted_card_field(kind: Option<SecretField>, field: &FieldFacts, embedder_origin: &str, site: &str) -> Result<(), String> {
    if kind != Some(SecretField::Card) {
        return Err(String::new());
    }
    if !origin_on_site(embedder_origin, site) {
        let by = if embedder_origin.is_empty() { "a document the node couldn't read" } else { embedder_origin };
        return Err(format!(", and its frame was put there by {by}, not by the checkout page"));
    }
    if !field.autocomplete.split_whitespace().any(|t| t.starts_with("cc-")) {
        return Err(", and in another site's frame a card goes only into a field marked for a card (autocomplete cc-…)".into());
    }
    if !field.secure {
        return Err(", and its frame didn't come over https".into());
    }
    Ok(())
}

/// The kind of secret a site-bound fill carries, which decides the fields it may go into. A secret goes only into a
/// field made to hold it: a password into a password field, so a comment box or a search field on the right site
/// never takes one and posts it; a one-time code into a short input or one the page marks for a code; a card's
/// value into an input, never free-form text or editable content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretField {
    Password,
    Code,
    Card,
}

impl SecretField {
    /// The kind a fill command names (`"field"`), if it names one this engine knows.
    pub fn parse(s: &str) -> Option<SecretField> {
        match s {
            "password" => Some(SecretField::Password),
            "code" => Some(SecretField::Code),
            "card" => Some(SecretField::Card),
            _ => None,
        }
    }

    /// Whether a field with these facts may take this kind of secret; Err says why not.
    pub fn takes(self, f: &FieldFacts) -> Result<(), String> {
        if f.tag != "input" || f.editable {
            let what = if f.editable { "piece of editable content" } else if f.tag.is_empty() { "thing with no element" } else { f.tag.as_str() };
            return Err(format!("the field is a {what}, not an input made for a secret"));
        }
        match self {
            SecretField::Password if f.kind == "password" => Ok(()),
            SecretField::Password => Err(format!("the field is an input of type {}, not a password field", if f.kind.is_empty() { "text" } else { f.kind.as_str() })),
            SecretField::Code => {
                let marked = f.autocomplete.split_whitespace().any(|t| t == "one-time-code");
                let short = (1..=12).contains(&f.max_length);
                match f.kind.as_str() {
                    "password" | "tel" | "number" => Ok(()),
                    "text" | "" if marked || short => Ok(()),
                    _ => Err("the field is neither marked for a one-time code nor short enough to be one".into()),
                }
            }
            // A card's number, security code or expiry goes only into a field made for one: one the page marks for a
            // card (an `autocomplete` token `cc-…`), or one too short for anything but such a value. A plain text box
            // (a search, a comment, a gift message) is neither, whatever page it is on.
            SecretField::Card => {
                let marked = f.autocomplete.split_whitespace().any(|t| t.starts_with("cc-"));
                let short = (1..=24).contains(&f.max_length);
                match f.kind.as_str() {
                    "text" | "" | "tel" | "number" | "password" | "month" if marked || short => Ok(()),
                    "text" | "" | "tel" | "number" | "password" | "month" => Err("the field is neither marked for a card (autocomplete cc-…) nor short enough to be a card's field".into()),
                    other => Err(format!("the field is an input of type {other}, not one a card's value goes into")),
                }
            }
        }
    }
}

/// Whether a serialized origin (`https://login.example.com`) is on `site`: the site's own host or a host under it.
/// A site given as an origin (`https://example.org:2083`) also pins the scheme and port the login was saved for.
/// An opaque origin (`null`) is on no site.
pub fn origin_on_site(origin: &str, site: &str) -> bool {
    let Ok(field) = url::Url::parse(origin) else { return false };
    let Some(host) = field.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    let site = site.trim();
    let site_host = if site.contains("://") {
        let Ok(login) = url::Url::parse(site) else { return false };
        if login.scheme() != field.scheme() || login.port_or_known_default() != field.port_or_known_default() {
            return false;
        }
        match login.host_str() {
            Some(h) => h.to_ascii_lowercase(),
            None => return false,
        }
    } else {
        site.trim_matches('.').to_ascii_lowercase()
    };
    !site_host.is_empty() && (host == site_host || host.ends_with(&format!(".{site_host}")))
}

#[cfg(test)]
mod origin_tests {
    use super::{hosted_card_field, origin_on_site, FieldFacts, SecretField};

    fn field(tag: &str, kind: &str, autocomplete: &str, editable: bool, max_length: i64) -> FieldFacts {
        FieldFacts { origin: "https://github.com".into(), tag: tag.into(), kind: kind.into(), autocomplete: autocomplete.into(), editable, max_length, secure: true }
    }

    /// A vault password goes only into a password field: a comment box, a search input or editable content on the
    /// login's own site takes nothing, so a page can't be made to post it.
    #[test]
    fn a_password_goes_only_into_a_password_field() {
        assert!(SecretField::Password.takes(&field("input", "password", "current-password", false, -1)).is_ok());
        assert!(SecretField::Password.takes(&field("input", "password", "", false, -1)).is_ok());
        for (what, f) in [
            ("a comment box", field("textarea", "textarea", "", false, -1)),
            ("a search input", field("input", "search", "", false, -1)),
            ("a text input", field("input", "text", "username", false, -1)),
            ("editable content", field("div", "", "", true, -1)),
            ("an input made editable content", field("input", "password", "", true, -1)),
            ("no element", field("", "", "", false, -1)),
        ] {
            assert!(SecretField::Password.takes(&f).is_err(), "{what}");
        }
    }

    /// A one-time code goes into a short input or one marked for a code, never free text; a card's value goes into
    /// an input, never a textarea or editable content.
    #[test]
    fn a_code_and_a_card_go_only_into_inputs_made_for_them() {
        assert!(SecretField::Code.takes(&field("input", "text", "one-time-code", false, -1)).is_ok());
        assert!(SecretField::Code.takes(&field("input", "text", "", false, 6)).is_ok());
        assert!(SecretField::Code.takes(&field("input", "tel", "", false, -1)).is_ok());
        assert!(SecretField::Code.takes(&field("input", "text", "", false, -1)).is_err(), "a free text input");
        assert!(SecretField::Code.takes(&field("textarea", "textarea", "one-time-code", false, -1)).is_err());
        assert!(SecretField::Code.takes(&field("input", "search", "", false, 6)).is_err());
        assert!(SecretField::Card.takes(&field("input", "text", "cc-number", false, 19)).is_ok());
        assert!(SecretField::Card.takes(&field("textarea", "textarea", "", false, -1)).is_err());
        assert!(SecretField::Card.takes(&field("div", "", "", true, -1)).is_err());
        assert_eq!(SecretField::parse("password"), Some(SecretField::Password));
        assert_eq!(SecretField::parse("anything else"), None);
    }

    /// External security review round 3, 2026-11-04. A card's value goes only into a field made for a card: one the
    /// page marks `cc-…`, or one too short to be anything else. A plain text box, on any page, takes none of it.
    #[test]
    fn a_card_goes_only_into_a_field_made_for_a_card() {
        for (kind, autocomplete, max) in [("text", "", -1), ("", "", -1), ("tel", "", -1), ("number", "", -1), ("password", "", -1), ("text", "name", 200), ("text", "off", -1)] {
            assert!(SecretField::Card.takes(&field("input", kind, autocomplete, false, max)).is_err(), "{kind} {autocomplete:?} {max}: a plain box");
        }
        for (kind, autocomplete, max) in [("text", "cc-number", -1), ("tel", "billing cc-csc", -1), ("text", "cc-exp", -1), ("month", "cc-exp", -1), ("text", "", 19), ("password", "", 4), ("tel", "", 7)] {
            assert!(SecretField::Card.takes(&field("input", kind, autocomplete, false, max)).is_ok(), "{kind} {autocomplete:?} {max}: a card's field");
        }
        assert!(SecretField::Card.takes(&field("input", "search", "cc-number", false, 19)).is_err());
    }

    /// UNB-119. A card goes into another site's frame only as a hosted field: the checkout page holds the frame, the
    /// field is marked for a card, and the frame came over https. A login or a code never does; nor does a frame
    /// another site's frame holds (an ad's), an unmarked box, or a frame served in the clear.
    #[test]
    fn a_card_goes_into_another_sites_frame_only_as_a_hosted_field() {
        let hosted = FieldFacts { origin: "https://js.pay.example".into(), ..field("input", "text", "cc-number", false, -1) };
        let card = Some(SecretField::Card);
        assert!(hosted_card_field(card, &hosted, "https://shop.example", "shop.example").is_ok());
        assert!(hosted_card_field(card, &hosted, "https://checkout.shop.example", "shop.example").is_ok(), "a page under the site");
        for (what, kind, facts, embedder) in [
            ("a login", Some(SecretField::Password), hosted.clone(), "https://shop.example"),
            ("a code", Some(SecretField::Code), hosted.clone(), "https://shop.example"),
            ("no kind", None, hosted.clone(), "https://shop.example"),
            ("held by another site's frame", card, hosted.clone(), "https://ads.example"),
            ("held by nothing the node read", card, hosted.clone(), ""),
            ("an unmarked box", card, FieldFacts { autocomplete: String::new(), max_length: 19, ..hosted.clone() }, "https://shop.example"),
            ("a frame in the clear", card, FieldFacts { secure: false, ..hosted.clone() }, "https://shop.example"),
        ] {
            assert!(hosted_card_field(kind, &facts, embedder, "shop.example").is_err(), "{what}");
        }
        let why = hosted_card_field(card, &hosted, "https://ads.example", "shop.example").unwrap_err();
        assert!(why.contains("https://ads.example"), "{why}");
        assert_eq!(hosted_card_field(None, &hosted, "", "shop.example").unwrap_err(), "", "a login's refusal says nothing more");
    }

    #[test]
    fn a_field_is_on_its_site_only_from_that_site_or_under_it() {
        assert!(origin_on_site("https://github.com", "github.com"));
        assert!(origin_on_site("https://example.org:2083", "https://example.org:2083"));
        assert!(origin_on_site("https://login.example.org:2083", "https://example.org:2083"));
        assert!(origin_on_site("https://login.github.com:8443", "github.com"));
        assert!(!origin_on_site("https://github.com.evil.example", "github.com"));
        assert!(!origin_on_site("https://notgithub.com", "github.com"));
        assert!(!origin_on_site("null", "github.com"), "a sandboxed frame is on no site");
        assert!(!origin_on_site("", "github.com"));
        assert!(!origin_on_site("https://github.com", ""));
    }

    #[test]
    fn a_login_given_as_an_origin_fills_only_its_scheme_and_port() {
        assert!(!origin_on_site("http://example.org:2083", "https://example.org:2083"));
        assert!(!origin_on_site("https://example.org", "https://example.org:2083"));
        assert!(!origin_on_site("https://example.org:8443", "https://example.org"));
        assert!(origin_on_site("https://example.org:443", "https://example.org"));
        assert!(!origin_on_site("https://example.org.evil.test", "https://example.org"));
        assert!(!origin_on_site("https://example.org", "not a url://"));
    }
}
