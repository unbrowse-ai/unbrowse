//! Unbrowse fork: what the daemon can answer while a command holds its state (a script given minutes, a
//! slow page). The node's own housekeeping must not wait behind an agent's command: a value it asks the
//! capture to forget is queued and named before anything else is written, and the tab list and DevTools
//! address are answered as they were after the last command.

use serde_json::{json, Value};

#[derive(Default)]
pub struct WhileBusy {
    seen: std::sync::Mutex<Option<(Vec<Value>, String)>>,
    forgets: std::sync::Mutex<Vec<String>>,
}

impl WhileBusy {
    /// Notes the tabs and DevTools address the browser has now (none when it isn't running).
    pub fn seen(&self, seen: Option<(Vec<Value>, String)>) {
        if let Ok(mut s) = self.seen.lock() {
            *s = seen;
        }
    }

    /// The answer to `cmd` while another command holds the state, when it has one without it.
    pub fn answer(&self, cmd: &Value) -> Option<Value> {
        let id = cmd.get("id").and_then(Value::as_str).unwrap_or_default();
        let ok = |data: Value| json!({ "id": id, "success": true, "data": data });
        match cmd.get("action").and_then(Value::as_str)? {
            "capture_forget" => {
                let Some(value) = cmd.get("value").and_then(Value::as_str) else {
                    return Some(json!({ "id": id, "success": false, "error": "capture_forget needs a value" }));
                };
                self.forgets.lock().ok()?.push(value.to_string());
                Some(ok(json!({ "named": null, "queued": true })))
            }
            "tab_list" => {
                let (tabs, _) = self.seen.lock().ok()?.clone()?;
                Some(ok(json!({ "tabs": tabs, "busy": true })))
            }
            "cdp_url" => {
                let (_, url) = self.seen.lock().ok()?.clone()?;
                Some(ok(json!({ "cdpUrl": url })))
            }
            _ => None,
        }
    }

    /// The values queued to forget, taken.
    pub fn take_forgets(&self) -> Vec<String> {
        self.forgets.lock().map(|mut f| std::mem::take(&mut *f)).unwrap_or_default()
    }
}

/// The answer to `cmd` when another command holds `state` and the question is one that needn't wait.
pub fn while_held(state: &std::sync::Arc<tokio::sync::Mutex<super::super::actions::DaemonState>>, cmd: &Value) -> Option<Value> {
    // The handle is kept outside the lock so it can be read while the lock is held.
    static HANDLES: std::sync::Mutex<Vec<(usize, std::sync::Arc<WhileBusy>)>> = std::sync::Mutex::new(Vec::new());
    let key = std::sync::Arc::as_ptr(state) as usize;
    match state.try_lock() {
        Ok(held) => {
            let mut handles = HANDLES.lock().ok()?;
            if !handles.iter().any(|(k, _)| *k == key) {
                handles.push((key, held.unbrowse.busy.clone()));
            }
            None
        }
        Err(_) => HANDLES.lock().ok()?.iter().find(|(k, _)| *k == key).and_then(|(_, busy)| busy.answer(cmd)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A value to forget is taken at once and named later; the tab list and DevTools address are the last ones noted.
    #[test]
    fn the_nodes_questions_are_answered_while_a_command_runs() {
        let busy = WhileBusy::default();
        assert!(busy.answer(&json!({ "action": "tab_list" })).is_none(), "nothing noted yet");
        busy.seen(Some((vec![json!({ "label": "a" })], "ws://127.0.0.1:1/devtools".into())));
        assert_eq!(busy.answer(&json!({ "id": "1", "action": "tab_list" })).unwrap()["data"]["tabs"][0]["label"], "a");
        assert_eq!(busy.answer(&json!({ "action": "cdp_url" })).unwrap()["data"]["cdpUrl"], "ws://127.0.0.1:1/devtools");
        assert_eq!(busy.answer(&json!({ "action": "capture_forget", "value": "123456" })).unwrap()["data"]["queued"], true);
        assert_eq!(busy.take_forgets(), ["123456"]);
        assert!(busy.answer(&json!({ "action": "click" })).is_none(), "a page command waits its turn");
    }
}
