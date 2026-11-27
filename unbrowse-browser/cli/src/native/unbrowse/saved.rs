//! Saved states by their names, as `state --help` documents them (UNB-208).
//!
//! The parser sends `state clear <session>` as `sessionName`, `state rename <old> <new>` as `oldName`/`newName`, and
//! `state show <file>` with the bare file name, but upstream's `dispatch_state_command` reads only `path` and `name`:
//! upstream 0.43.0 deletes every saved state for `clear <session>`, fails every `rename` ("Missing 'path'
//! parameter"), and reads `show`'s file from the working folder. This answers those three forms in the states
//! folder; any other command goes on to upstream's dispatch unchanged.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::native::state::{get_sessions_dir, state_rename, state_show};

/// The answer to a state command that names a saved state, or `None` for upstream's dispatch to answer.
pub fn by_name(cmd: &Value) -> Option<Result<Value, String>> {
    let field = |key: &str| cmd.get(key).and_then(Value::as_str);
    match field("action")? {
        "state_clear" if field("path").is_none() && cmd.get("all").and_then(Value::as_bool) != Some(true) => {
            field("sessionName").map(|session| Ok(clear_session(&get_sessions_dir(), session)))
        }
        "state_rename" if field("path").is_none() => {
            let (old, new) = (field("oldName")?, field("newName")?);
            let dir = get_sessions_dir();
            let old_path = saved_file(&dir, old).unwrap_or_else(|| dir.join(format!("{old}.json")));
            Some(state_rename(&old_path.to_string_lossy(), new))
        }
        "state_show" => {
            let path = field("path")?;
            let in_folder = Path::new(path).components().count() == 1 && !Path::new(path).exists();
            let file = in_folder.then(|| saved_file(&get_sessions_dir(), path)).flatten()?;
            Some(state_show(&file.to_string_lossy()))
        }
        _ => None,
    }
}

/// The saved state called `name` in `dir`: the file itself, or `name` with a state file's ending.
fn saved_file(dir: &Path, name: &str) -> Option<PathBuf> {
    ["", ".json", ".json.enc"].iter().map(|ending| dir.join(format!("{name}{ending}"))).find(|p| p.is_file())
}

/// Deletes the saved states of `session` (`<session>-<name>.json`, encrypted or not, and their previous copies).
fn clear_session(dir: &Path, session: &str) -> Value {
    let prefix = format!("{session}-");
    let mut deleted = 0;
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let state = [".json", ".json.enc", ".json.previous", ".json.enc.previous"].iter().any(|e| name.ends_with(e));
        if state && name.starts_with(&prefix) && std::fs::remove_file(entry.path()).is_ok() {
            deleted += 1;
        }
    }
    json!({ "deleted": deleted, "session": session })
}
