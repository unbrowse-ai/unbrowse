use std::collections::HashMap;

use serde_json::{json, Value};

use super::cdp::client::CdpClient;
use super::cdp::types::*;
use super::element::{
    active_frame, frame_owner_in, parse_ref, resolve_element_center, resolve_element_object_id, session_viewport_offset,
    RefMap,
};

/// Outcome of a click. `dialog_opened` is true if a JavaScript dialog opened
/// mid-sequence (the page is then blocked until `dialog accept`/`dismiss`).
/// `pending_release` is set only when the dialog opened after mousePressed but
/// before mouseReleased: the button is logically held until the caller
/// dispatches the release (done once the dialog is resolved), otherwise the
/// next click would register as a drag or double-click.
#[derive(Default)]
pub struct ClickResult {
    /// Final pointer position in the top-level page viewport, including dialogs.
    pub position: (f64, f64),
    pub dialog_opened: bool,
    pub pending_release: Option<PendingRelease>,
    pub x: f64,
    pub y: f64,
    pub button_pressed: bool,
}

pub struct PendingRelease {
    pub session_id: String,
    pub x: f64,
    pub y: f64,
    pub button: String,
}

pub async fn click(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    button: &str,
    click_count: i32,
    iframe_sessions: &HashMap<String, String>,
) -> Result<ClickResult, String> {
    let (x, y, effective_session_id) = resolve_element_center(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;
    // A click-triggered dialog can fire on the frame's own session (OOPIF) or
    // on the top-level page session; both count as "ours". A dialog on any
    // other session belongs to a background tab and must not abort this click.
    let offset =
        session_viewport_offset(client, session_id, &effective_session_id, iframe_sessions).await?;
    let mut result = dispatch_click(
        client,
        &effective_session_id,
        &[effective_session_id.as_str(), session_id],
        x,
        y,
        button,
        click_count,
    )
    .await?;
    // Compute before dispatch: a click may navigate or open a blocking dialog.
    result.position = (x + offset.0, y + offset.1);
    (result.x, result.y) = result.position;
    Ok(result)
}

pub async fn dblclick(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<ClickResult, String> {
    click(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        "left",
        2,
        iframe_sessions,
    )
    .await
}

pub async fn hover(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(f64, f64), String> {
    let (x, y, effective_session_id) = resolve_element_center(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;
    let offset =
        session_viewport_offset(client, session_id, &effective_session_id, iframe_sessions).await?;
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchMouseEvent",
            &DispatchMouseEventParams {
                event_type: "mouseMoved".to_string(),
                x,
                y,
                button: None,
                buttons: None,
                click_count: None,
                delta_x: None,
                delta_y: None,
                modifiers: None,
            },
            Some(&effective_session_id),
        )
        .await?;
    Ok((x + offset.0, y + offset.1))
}

/// Fills `value` into the element. With `on_site`, only if the element's own document, the frame it sits in and
/// not the page around it, is on that site (the site itself or a host under it, and the scheme and port when the
/// site is given as an origin): a value meant for one site never goes into another site's frame embedded in its
/// page. A site-bound value is written into the checked element itself, never sent as keyboard input, which lands
/// wherever focus is when it arrives.
#[allow(clippy::too_many_arguments)]
pub async fn fill(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    value: &str,
    iframe_sessions: &HashMap<String, String>,
    on_site: Option<&str>,
    kind: Option<SecretField>,
) -> Result<Option<String>, String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    if let Some(site) = on_site {
        // The frame the field was found in: a ref's own, else the frame `frame <sel>` selected for a selector.
        let frame_id = match parse_ref(selector_or_ref) {
            Some(r) => ref_map.get(&r).and_then(|e| e.frame_id.clone()),
            None => active_frame(),
        };
        let facts = element_facts(client, &effective_session_id, &object_id, frame_id.as_deref())
            .await
            .unwrap_or_default();
        let origin = facts.origin.as_str();
        // A card's field may sit in a frame of another site's that the checkout page put there itself: a payment
        // provider's hosted field. The owner pays on the page they approved; the value goes only into that frame.
        let mut hosted_by = None;
        if !origin_on_site(origin, site) {
            let embedder = match (kind, frame_id.as_deref()) {
                (Some(SecretField::Card), Some(frame)) => {
                    frame_owner_in(client, session_id, &effective_session_id, frame, iframe_sessions).await.ok()
                }
                _ => None,
            };
            let embedder_origin = match &embedder {
                Some((owner_session, owner_object)) => {
                    element_facts(client, owner_session, owner_object, None).await.map(|f| f.origin).unwrap_or_default()
                }
                None => String::new(),
            };
            if let Err(why) = hosted_card_field(kind, &facts, &embedder_origin, site) {
                return Err(format!(
                    "the field is in a document from {origin}, not on {site}{why}: nothing was filled"
                ));
            }
            hosted_by = Some(origin.to_string());
        }
        if let Some(kind) = kind {
            if let Err(why) = kind.takes(&facts) {
                return Err(format!("{why}: nothing was filled"));
            }
        }
        write_into_element(client, &effective_session_id, &object_id, value).await?;
        return Ok(hosted_by);
    }

    // Focus the element
    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { this.focus(); }".to_string(),
                object_id: Some(object_id.clone()),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    // Clear it and type the value with a person's keys, so the page hears what typing makes (keydown, beforeinput,
    // input, keyup): a framework that binds a field's model or its totals to any of them sees the new value.
    // Keyboard input is dispatched at page level, so it takes the parent session_id.
    clear_by_keys(client, session_id, &effective_session_id, &object_id).await?;
    type_text_into_active_context(client, session_id, value, None).await?;

    Ok(None)
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

#[allow(clippy::too_many_arguments)]
pub async fn type_text(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    text: &str,
    clear: bool,
    delay_ms: Option<u64>,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    // Focus
    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { this.focus(); }".to_string(),
                object_id: Some(object_id.clone()),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    if clear {
        clear_by_keys(client, session_id, &effective_session_id, &object_id).await?;
    }

    type_text_into_active_context(client, session_id, text, delay_ms).await
}

/// Selects what the focused field `object_id` holds and deletes it with Backspace, as a person clears a field. A field
/// whose text survives the key (a page that refuses it) is cleared through its own value setter, with the input event
/// deleting makes.
async fn clear_by_keys(
    client: &CdpClient,
    session_id: &str,
    effective_session_id: &str,
    object_id: &str,
) -> Result<(), String> {
    let held = client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    if (typeof this.select === 'function') { try { this.select(); } catch (e) {} }
                    else if (this.isContentEditable) {
                        const r = document.createRange();
                        r.selectNodeContents(this);
                        const s = getSelection();
                        s.removeAllRanges();
                        s.addRange(r);
                    }
                    return !!('value' in this ? this.value : this.textContent);
                }"#
                .to_string(),
                object_id: Some(object_id.to_string()),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(effective_session_id),
        )
        .await?;
    if held["result"]["value"].as_bool() != Some(true) {
        return Ok(());
    }
    press_key(client, session_id, "Backspace").await?;
    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    if (!('value' in this) || this.value === '') return;
                    let p = Object.getPrototypeOf(this), d;
                    while (p && !(d = Object.getOwnPropertyDescriptor(p, 'value'))) p = Object.getPrototypeOf(p);
                    if (d && d.set) d.set.call(this, ''); else this.value = '';
                    this.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
                }"#
                .to_string(),
                object_id: Some(object_id.to_string()),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(effective_session_id),
        )
        .await?;
    Ok(())
}

/// Types `text` into whatever has focus, one key per character as a person types: each key's keyDown carries its
/// text, so the page sees keydown, keypress, beforeinput, input and keyup, the events frameworks bind a field's model
/// and its handlers to. A character with no key on a US layout (`char_to_key_info` gives it no code) is inserted as
/// text (`Input.insertText`), which makes beforeinput and input only.
pub async fn type_text_into_active_context(
    client: &CdpClient,
    session_id: &str,
    text: &str,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    let delay = delay_ms.unwrap_or(0);

    for ch in text.chars() {
        let (key, code, key_code) = char_to_key_info(ch);
        if key_code == 0 {
            client
                .send_command_typed::<_, Value>(
                    "Input.insertText",
                    &InsertTextParams {
                        text: ch.to_string(),
                    },
                    Some(session_id),
                )
                .await?;
        } else {
            let text_str = key_text(&key);
            client
                .send_command_typed::<_, Value>(
                    "Input.dispatchKeyEvent",
                    &DispatchKeyEventParams {
                        event_type: "keyDown".to_string(),
                        key: Some(key.clone()),
                        code: Some(code.clone()),
                        text: text_str.clone(),
                        unmodified_text: text_str,
                        windows_virtual_key_code: Some(key_code),
                        native_virtual_key_code: Some(key_code),
                        modifiers: None,
                    },
                    Some(session_id),
                )
                .await?;

            client
                .send_command_typed::<_, Value>(
                    "Input.dispatchKeyEvent",
                    &DispatchKeyEventParams {
                        event_type: "keyUp".to_string(),
                        key: Some(key),
                        code: Some(code),
                        text: None,
                        unmodified_text: None,
                        windows_virtual_key_code: Some(key_code),
                        native_virtual_key_code: Some(key_code),
                        modifiers: None,
                    },
                    Some(session_id),
                )
                .await?;
        }

        if delay > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
        }
    }

    Ok(())
}

pub async fn press_key(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    press_key_with_modifiers(client, session_id, key, None).await
}

/// Dispatch a keyDown+keyUp sequence for `key` with an optional CDP modifier bitmask.
///
/// Modifier values follow the CDP `Input.dispatchKeyEvent` spec:
/// 1 = Alt, 2 = Control, 4 = Meta (Cmd), 8 = Shift.
///
/// Callers that need a platform-appropriate modifier (e.g. Cmd on macOS,
/// Ctrl elsewhere) must choose the value themselves -- see `cfg!(target_os)`.
pub async fn press_key_with_modifiers(
    client: &CdpClient,
    session_id: &str,
    key: &str,
    modifiers: Option<i32>,
) -> Result<(), String> {
    let (key_name, code, key_code) = named_key_info(key);

    // Suppress text insertion when Control (2) or Meta (4) modifiers are active,
    // since these are command chords (e.g. Ctrl+A = select-all), not text input.
    let has_command_modifier = modifiers.is_some_and(|m| m & (2 | 4) != 0);
    let text = if has_command_modifier {
        None
    } else {
        key_text(&key_name)
    };

    client
        .send_command_typed::<_, Value>(
            "Input.dispatchKeyEvent",
            &DispatchKeyEventParams {
                event_type: "keyDown".to_string(),
                key: Some(key_name.clone()),
                code: Some(code.clone()),
                text: text.clone(),
                unmodified_text: text.clone(),
                windows_virtual_key_code: Some(key_code),
                native_virtual_key_code: Some(key_code),
                modifiers,
            },
            Some(session_id),
        )
        .await?;

    client
        .send_command_typed::<_, Value>(
            "Input.dispatchKeyEvent",
            &DispatchKeyEventParams {
                event_type: "keyUp".to_string(),
                key: Some(key_name),
                code: Some(code),
                text: None,
                unmodified_text: None,
                windows_virtual_key_code: Some(key_code),
                native_virtual_key_code: Some(key_code),
                modifiers,
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

pub async fn scroll(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: Option<&str>,
    delta_x: f64,
    delta_y: f64,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    if let Some(sel) = selector_or_ref {
        let (object_id, effective_session_id) =
            resolve_element_object_id(client, session_id, ref_map, sel, iframe_sessions).await?;
        let js = "function(dx, dy) { this.scrollBy(dx, dy); }".to_string();
        client
            .send_command_typed::<_, Value>(
                "Runtime.callFunctionOn",
                &CallFunctionOnParams {
                    function_declaration: js,
                    object_id: Some(object_id),
                    arguments: Some(vec![
                        CallArgument {
                            value: Some(serde_json::json!(delta_x)),
                            object_id: None,
                        },
                        CallArgument {
                            value: Some(serde_json::json!(delta_y)),
                            object_id: None,
                        },
                    ]),
                    return_by_value: Some(true),
                    await_promise: Some(false),
                },
                Some(&effective_session_id),
            )
            .await?;
    } else {
        let js = format!("window.scrollBy({}, {})", delta_x, delta_y);
        client
            .send_command_typed::<_, Value>(
                "Runtime.evaluate",
                &EvaluateParams {
                    expression: js,
                    return_by_value: Some(true),
                    await_promise: Some(false),
                },
                Some(session_id),
            )
            .await?;
    }
    Ok(())
}

pub async fn select_option(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    values: &[String],
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    // Matching nothing must be an error, not a silent success: an agent that
    // selects a misspelled option otherwise sees "Done", and only discovers
    // the page state is wrong after more commands. List what was available.
    let js = r#"function(vals) {
            const normalize = (value) => String(value ?? '')
                .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            const options = Array.from(this.options);
            const wanted = new Set();
            for (const value of vals) {
                let matches = options.filter((opt) =>
                    value === opt.value ||
                    value === opt.label.trim() ||
                    value === opt.textContent.trim()
                );
                if (matches.length === 0) {
                    const normalizedValue = normalize(value);
                    matches = options.filter((opt) =>
                        normalize(opt.label) === normalizedValue
                    );
                    if (matches.length > 1) {
                        return { error: 'Multiple options matched ' + JSON.stringify(value) + ' after whitespace normalization' };
                    }
                }
                if (matches.length === 0) {
                    const available = options.map(o => o.value + ' ("' + normalize(o.label) + '")').join(', ');
                    return { error: 'No option matched ' + JSON.stringify(vals) + '. Available options: ' + available };
                }
                for (const opt of matches) wanted.add(opt);
            }
            if (wanted.size === 0) {
                const available = options.map(o => o.value + ' ("' + normalize(o.label) + '")').join(', ');
                return { error: 'No option matched ' + JSON.stringify(vals) + '. Available options: ' + available };
            }
            for (const opt of options) opt.selected = wanted.has(opt);
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { matched: wanted.size };
        }"#
    .to_string();

    let result = client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js,
                object_id: Some(object_id),
                arguments: Some(vec![CallArgument {
                    value: Some(serde_json::json!(values)),
                    object_id: None,
                }]),
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    if let Some(error) = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.get("error"))
        .and_then(|e| e.as_str())
    {
        return Err(error.to_string());
    }

    Ok(())
}

pub async fn check(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<Option<(f64, f64)>, String> {
    let mut position = None;
    let is_checked = super::element::is_element_checked(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;
    if !is_checked {
        let result = click(
            client,
            session_id,
            ref_map,
            selector_or_ref,
            "left",
            1,
            iframe_sessions,
        )
        .await?;
        position = Some(result.position);

        // Verify the click changed the state (Playwright parity: _setChecked re-checks).
        // If the coordinate-based click missed (e.g. hidden input, overlay), retry
        // with a JS .click() on the element and its associated input.
        if !click_took(client, session_id, ref_map, selector_or_ref, iframe_sessions, true).await {
            js_click_checkbox(
                client,
                session_id,
                ref_map,
                selector_or_ref,
                iframe_sessions,
            )
            .await?;
        }
    }
    Ok(position)
}

pub async fn uncheck(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<Option<(f64, f64)>, String> {
    let mut position = None;
    let is_checked = super::element::is_element_checked(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;
    if is_checked {
        let result = click(
            client,
            session_id,
            ref_map,
            selector_or_ref,
            "left",
            1,
            iframe_sessions,
        )
        .await?;
        position = Some(result.position);

        // Same verify-and-retry as check().
        if !click_took(client, session_id, ref_map, selector_or_ref, iframe_sessions, false).await {
            js_click_checkbox(
                client,
                session_id,
                ref_map,
                selector_or_ref,
                iframe_sessions,
            )
            .await?;
        }
    }
    Ok(position)
}

/// How long a control gets to show a click took before it counts as missed. A second click on a control that was only
/// slow undoes the first, so this waits out a framework's round trip; a real miss costs this much once.
const CLICK_SETTLE_MS: u64 = 500;

/// Whether a click on a checkbox or radio left it `want`, given a moment to say so. A control that can no longer be read
/// took the click: the page moved on, or it was replaced, and there is nothing left to click again.
async fn click_took(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
    want: bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(CLICK_SETTLE_MS);
    loop {
        match super::element::is_element_checked(client, session_id, ref_map, selector_or_ref, iframe_sessions).await {
            Ok(checked) if checked == want => return true,
            Err(_) => return true,
            Ok(_) if tokio::time::Instant::now() >= deadline => return false,
            Ok(_) => tokio::time::sleep(tokio::time::Duration::from_millis(50)).await,
        }
    }
}

/// Fallback for when the coordinate-based CDP click did not toggle the
/// checkbox/radio state. This mirrors how Playwright dispatches clicks
/// through the DOM rather than via raw Input.dispatchMouseEvent coordinates.
///
/// Uses the same follow-label resolution as `is_element_checked`:
/// 1. If the element is a native input → `.click()` it directly.
/// 2. If the element is inside a `<label>` → `.click()` the label's `.control`.
/// 3. If the element has a nested `<input>` → `.click()` that input.
/// 4. Otherwise → `.click()` the element itself (handles ARIA role controls).
async fn js_click_checkbox(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    let js = r#"function() {
            var el = this;
            var tag = el.tagName && el.tagName.toUpperCase();
            // 1. Native input — click it directly
            if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                el.click();
                return;
            }
            // 2. Follow label → control association
            var label = tag === 'LABEL' ? el : (el.closest && el.closest('label'));
            if (label && label.tagName && label.tagName.toUpperCase() === 'LABEL' && label.control) {
                label.control.click();
                return;
            }
            // 3. Nested native input
            var input = el.querySelector && el.querySelector('input[type="checkbox"], input[type="radio"]');
            if (input) {
                input.click();
                return;
            }
            // 4. ARIA role control — click the element itself
            el.click();
        }"#;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js.to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn focus(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { this.focus(); }".to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn clear(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.focus();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                    this.dispatchEvent(new Event('change', { bubbles: true }));
                }"#
                .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn select_all(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.focus();
                    if (typeof this.select === 'function') {
                        this.select();
                    } else {
                        const range = document.createRange();
                        range.selectNodeContents(this);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                }"#
                .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn scroll_into_view(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration:
                    "function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }"
                        .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn dispatch_event(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    event_type: &str,
    event_init: Option<&Value>,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    let init_json = event_init
        .map(|v| serde_json::to_string(v).unwrap_or("{}".to_string()))
        .unwrap_or_else(|| "{ bubbles: true }".to_string());

    let js = format!(
        "function() {{ this.dispatchEvent(new Event({}, {})); }}",
        serde_json::to_string(event_type).unwrap_or_default(),
        init_json
    );

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js,
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn highlight(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (object_id, effective_session_id) = resolve_element_object_id(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.style.outline = '2px solid red';
                    this.style.outlineOffset = '2px';
                    const el = this;
                    setTimeout(() => {
                        el.style.outline = '';
                        el.style.outlineOffset = '';
                    }, 3000);
                }"#
                .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

pub async fn tap_touch(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
) -> Result<(), String> {
    let (x, y, effective_session_id) = resolve_element_center(
        client,
        session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;

    client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(serde_json::json!({
                "type": "touchStart",
                "touchPoints": [{ "x": x, "y": y }],
            })),
            Some(&effective_session_id),
        )
        .await?;

    client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(serde_json::json!({
                "type": "touchEnd",
                "touchPoints": [],
            })),
            Some(&effective_session_id),
        )
        .await?;

    Ok(())
}

/// Dispatches one mouse event and waits for the browser to ack it, but
/// returns Ok(true) if a JavaScript dialog opens first. A synchronous dialog
/// (confirm/prompt/alert in the event handler) blocks the renderer's main
/// thread, so the input ack cannot arrive until the dialog is resolved;
/// without this the command hangs until the client read timeout and the agent
/// never sees the pending-dialog warning.
pub(super) async fn dispatch_mouse_or_dialog(
    client: &CdpClient,
    session_id: &str,
    accept_sessions: &[&str],
    params: &DispatchMouseEventParams,
) -> Result<bool, String> {
    use tokio::sync::broadcast::error::RecvError;

    // Subscribe before sending so the dialog event cannot slip past us.
    let mut events = client.subscribe();
    let send =
        client.send_command_typed::<_, Value>("Input.dispatchMouseEvent", params, Some(session_id));
    tokio::pin!(send);
    loop {
        tokio::select! {
            res = &mut send => {
                res?;
                return Ok(false);
            }
            event = events.recv() => {
                match event {
                    Ok(e) if e.method == "Page.javascriptDialogOpening" => {
                        // Only a dialog on this click's frame/page session
                        // aborts it; a background-tab dialog must not. A
                        // session-less event has no flat session and is
                        // treated as the top-level page (i.e. ours).
                        let ours = match e.session_id.as_deref() {
                            Some(sid) => accept_sessions.contains(&sid),
                            None => true,
                        };
                        if ours {
                            return Ok(true);
                        }
                        continue;
                    }
                    Ok(_) => continue,
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => {
                        (&mut send).await?;
                        return Ok(false);
                    }
                }
            }
        }
    }
}

async fn dispatch_click(
    client: &CdpClient,
    session_id: &str,
    accept_sessions: &[&str],
    x: f64,
    y: f64,
    button: &str,
    click_count: i32,
) -> Result<ClickResult, String> {
    // Move
    if dispatch_mouse_or_dialog(
        client,
        session_id,
        accept_sessions,
        &DispatchMouseEventParams {
            event_type: "mouseMoved".to_string(),
            x,
            y,
            button: None,
            buttons: None,
            click_count: None,
            delta_x: None,
            delta_y: None,
            modifiers: None,
        },
    )
    .await?
    {
        // No button was pressed yet, nothing to release.
        return Ok(ClickResult {
            position: (x, y),
            dialog_opened: true,
            pending_release: None,
            x,
            y,
            button_pressed: false,
        });
    }

    let button_value = match button {
        "right" => 2,
        "middle" => 4,
        _ => 1,
    };

    // Press
    if dispatch_mouse_or_dialog(
        client,
        session_id,
        accept_sessions,
        &DispatchMouseEventParams {
            event_type: "mousePressed".to_string(),
            x,
            y,
            button: Some(button.to_string()),
            buttons: Some(button_value),
            click_count: Some(click_count),
            delta_x: None,
            delta_y: None,
            modifiers: None,
        },
    )
    .await?
    {
        // Dialog opened from the mousedown handler: the button is held and the
        // release will never arrive on its own. Hand the caller what it needs
        // to release once the dialog is resolved.
        return Ok(ClickResult {
            position: (x, y),
            dialog_opened: true,
            pending_release: Some(PendingRelease {
                session_id: session_id.to_string(),
                x,
                y,
                button: button.to_string(),
            }),
            x,
            y,
            button_pressed: true,
        });
    }

    // Release. A dialog here fired from the click/mouseup handler, which runs
    // after the button is already up, so there is nothing left to release.
    let dialog_opened = dispatch_mouse_or_dialog(
        client,
        session_id,
        accept_sessions,
        &DispatchMouseEventParams {
            event_type: "mouseReleased".to_string(),
            x,
            y,
            button: Some(button.to_string()),
            buttons: Some(0),
            click_count: Some(click_count),
            delta_x: None,
            delta_y: None,
            modifiers: None,
        },
    )
    .await?;
    Ok(ClickResult {
        position: (x, y),
        dialog_opened,
        pending_release: None,
        x,
        y,
        button_pressed: true,
    })
}

/// Best-effort mouseReleased to clear a button left logically down when a
/// dialog opened mid-click. Called after the dialog is resolved.
pub async fn dispatch_pending_release(
    client: &CdpClient,
    release: &PendingRelease,
) -> Result<(), String> {
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchMouseEvent",
            &DispatchMouseEventParams {
                event_type: "mouseReleased".to_string(),
                x: release.x,
                y: release.y,
                button: Some(release.button.clone()),
                buttons: Some(0),
                click_count: Some(1),
                delta_x: None,
                delta_y: None,
                modifiers: None,
            },
            Some(&release.session_id),
        )
        .await?;
    Ok(())
}

fn char_to_key_info(ch: char) -> (String, String, i32) {
    match ch {
        '\n' | '\r' => ("Enter".to_string(), "Enter".to_string(), 13),
        '\t' => ("Tab".to_string(), "Tab".to_string(), 9),
        ' ' => (" ".to_string(), "Space".to_string(), 32),
        _ => {
            let key = ch.to_string();
            if ch.is_ascii_alphabetic() {
                // For letters the Windows VK code equals the uppercase ASCII value.
                let upper = ch.to_ascii_uppercase();
                let code = format!("Key{}", upper);
                let key_code = upper as i32;
                (key, code, key_code)
            } else if ch.is_ascii_digit() {
                let code = format!("Digit{}", ch);
                let key_code = ch as i32;
                (key, code, key_code)
            } else {
                let (code, key_code) = punctuation_key_info(ch);
                (key, code.to_string(), key_code)
            }
        }
    }
}

/// Return the DOM `KeyboardEvent.code` value and Windows virtual-key code for
/// a punctuation / symbol character assuming a US keyboard layout.
///
/// The Windows virtual-key codes (VK_OEM_*) differ from ASCII values for
/// punctuation.  Using the raw ASCII code would misidentify characters – e.g.
/// '.' (ASCII 46) collides with VK_DELETE (0x2E = 46), causing the period to
/// be swallowed.
fn punctuation_key_info(ch: char) -> (&'static str, i32) {
    match ch {
        // VK_OEM_1 (0xBA = 186) — ";:" key on US layout
        ';' | ':' => ("Semicolon", 186),
        // VK_OEM_PLUS (0xBB = 187) — "=+" key
        '=' | '+' => ("Equal", 187),
        // VK_OEM_COMMA (0xBC = 188) — ",<" key
        ',' | '<' => ("Comma", 188),
        // VK_OEM_MINUS (0xBD = 189) — "-_" key
        '-' | '_' => ("Minus", 189),
        // VK_OEM_PERIOD (0xBE = 190) — ".>" key
        '.' | '>' => ("Period", 190),
        // VK_OEM_2 (0xBF = 191) — "/?" key
        '/' | '?' => ("Slash", 191),
        // VK_OEM_3 (0xC0 = 192) — "`~" key
        '`' | '~' => ("Backquote", 192),
        // VK_OEM_4 (0xDB = 219) — "[{" key
        '[' | '{' => ("BracketLeft", 219),
        // VK_OEM_5 (0xDC = 220) — "\\|" key
        '\\' | '|' => ("Backslash", 220),
        // VK_OEM_6 (0xDD = 221) — "]}" key
        ']' | '}' => ("BracketRight", 221),
        // VK_OEM_7 (0xDE = 222) — "'\""" key
        '\'' | '"' => ("Quote", 222),
        _ => ("", 0),
    }
}

/// Return the `text` value that CDP `Input.dispatchKeyEvent` needs on the
/// `keyDown` event so that Chrome performs the default action for the key.
/// For example Enter needs `"\r"` to actually submit a form, and Tab needs
/// `"\t"` to move focus.  Non-printable / navigation keys return `None`.
fn key_text(key_name: &str) -> Option<String> {
    match key_name {
        "Enter" => Some("\r".to_string()),
        "Tab" => Some("\t".to_string()),
        " " => Some(" ".to_string()),
        _ => {
            // Single printable characters carry themselves as text.
            if key_name.len() == 1 {
                Some(key_name.to_string())
            } else {
                None
            }
        }
    }
}

fn named_key_info(key: &str) -> (String, String, i32) {
    match key.to_lowercase().as_str() {
        "enter" | "return" => ("Enter".to_string(), "Enter".to_string(), 13),
        "tab" => ("Tab".to_string(), "Tab".to_string(), 9),
        "escape" | "esc" => ("Escape".to_string(), "Escape".to_string(), 27),
        "backspace" => ("Backspace".to_string(), "Backspace".to_string(), 8),
        "delete" => ("Delete".to_string(), "Delete".to_string(), 46),
        "arrowup" | "up" => ("ArrowUp".to_string(), "ArrowUp".to_string(), 38),
        "arrowdown" | "down" => ("ArrowDown".to_string(), "ArrowDown".to_string(), 40),
        "arrowleft" | "left" => ("ArrowLeft".to_string(), "ArrowLeft".to_string(), 37),
        "arrowright" | "right" => ("ArrowRight".to_string(), "ArrowRight".to_string(), 39),
        "home" => ("Home".to_string(), "Home".to_string(), 36),
        "end" => ("End".to_string(), "End".to_string(), 35),
        "pageup" => ("PageUp".to_string(), "PageUp".to_string(), 33),
        "pagedown" => ("PageDown".to_string(), "PageDown".to_string(), 34),
        "space" | " " => (" ".to_string(), "Space".to_string(), 32),
        _ => {
            if key.len() == 1 {
                let ch = key.chars().next().unwrap();
                char_to_key_info(ch)
            } else {
                (key.to_string(), key.to_string(), 0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that `char_to_key_info` returns the correct (key, code,
    /// windowsVirtualKeyCode) triple for every character in Playwright's
    /// USKeyboardLayout.  The expected values below are taken verbatim from
    /// playwright-core/lib/server/usKeyboardLayout.js so that any drift from
    /// Playwright's behaviour is caught immediately.
    #[test]
    fn test_char_to_key_info_matches_playwright_layout() {
        // (character, expected_code, expected_vk_code)
        let cases: &[(char, &str, i32)] = &[
            // Letters – VK code must equal the uppercase ASCII value.
            ('a', "KeyA", 65),
            ('z', "KeyZ", 90),
            ('A', "KeyA", 65),
            // Digits
            ('0', "Digit0", 48),
            ('9', "Digit9", 57),
            // Punctuation – these are the values from Playwright's layout.
            // The bug that prompted this test sent '.' as VK 46 (= VK_DELETE).
            ('.', "Period", 190),
            (',', "Comma", 188),
            ('/', "Slash", 191),
            (';', "Semicolon", 186),
            ('\'', "Quote", 222),
            ('[', "BracketLeft", 219),
            (']', "BracketRight", 221),
            ('\\', "Backslash", 220),
            ('`', "Backquote", 192),
            ('-', "Minus", 189),
            ('=', "Equal", 187),
            // Shifted variants produced by the same physical keys.
            ('>', "Period", 190),
            ('<', "Comma", 188),
            ('?', "Slash", 191),
            (':', "Semicolon", 186),
            ('"', "Quote", 222),
            ('{', "BracketLeft", 219),
            ('}', "BracketRight", 221),
            ('|', "Backslash", 220),
            ('~', "Backquote", 192),
            ('_', "Minus", 189),
            ('+', "Equal", 187),
            // Whitespace / control
            (' ', "Space", 32),
            ('\n', "Enter", 13),
            ('\t', "Tab", 9),
        ];

        for &(ch, expected_code, expected_vk) in cases {
            let (key, code, vk) = char_to_key_info(ch);
            assert_eq!(
                code, expected_code,
                "char {:?}: expected code {:?}, got {:?}",
                ch, expected_code, code
            );
            assert_eq!(
                vk, expected_vk,
                "char {:?}: expected VK {}, got {} (ASCII would be {})",
                ch, expected_vk, vk, ch as i32
            );
            // key should be the character itself (except control chars).
            if !ch.is_control() {
                assert_eq!(key, ch.to_string(), "char {:?}: key mismatch", ch);
            }
        }
    }

    /// Regression test: period must NEVER map to VK 46 (VK_DELETE).
    #[test]
    fn test_period_is_not_vk_delete() {
        let (_, _, vk) = char_to_key_info('.');
        assert_ne!(
            vk, 46,
            "Period must not use VK code 46 (VK_DELETE); expected 190 (VK_OEM_PERIOD)"
        );
        assert_eq!(vk, 190);
    }

    /// Characters outside the US keyboard layout should return (key, "", 0)
    /// so that `type_text` falls back to `Input.insertText`.
    #[test]
    fn test_unmapped_chars_return_zero_keycode() {
        for ch in ['@', '#', '$', '%', '^', '&', '*', '(', ')', '€', '£', '你'] {
            let (key, code, vk) = char_to_key_info(ch);
            assert_eq!(
                code, "",
                "char {:?}: unmapped char should have empty code, got {:?}",
                ch, code
            );
            assert_eq!(
                vk, 0,
                "char {:?}: unmapped char should have VK 0, got {}",
                ch, vk
            );
            assert_eq!(key, ch.to_string());
        }
    }

    #[test]
    fn test_key_text_returns_correct_text_for_special_keys() {
        assert_eq!(key_text("Enter"), Some("\r".to_string()));
        assert_eq!(key_text("Tab"), Some("\t".to_string()));
        assert_eq!(key_text(" "), Some(" ".to_string()));
        // Single printable characters carry themselves.
        assert_eq!(key_text("a"), Some("a".to_string()));
        assert_eq!(key_text("Z"), Some("Z".to_string()));
        // Non-printable named keys return None.
        assert_eq!(key_text("Escape"), None);
        assert_eq!(key_text("ArrowUp"), None);
        assert_eq!(key_text("Backspace"), None);
        assert_eq!(key_text("Delete"), None);
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
