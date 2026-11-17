//! DOM snapshot: the JS injected into an isolated world to index visible interactive
//! elements and gate actions through epoch, visibility, occlusion, and unsafe-word checks.

use serde::{Deserialize, Serialize};

pub const SNAPSHOT_JS: &str = include_str!("snapshot.js");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotElement {
    pub index: u64,
    pub role: String,
    pub name: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub elements: Vec<SnapshotElement>,
    pub visible_text: String,
    pub epoch: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("snapshot JSON missing or malformed")]
    Invalid,
}

pub fn parse_snapshot(json: &serde_json::Value) -> Result<Snapshot, SnapshotError> {
    let obj = json.as_object().ok_or(SnapshotError::Invalid)?;
    let epoch = obj
        .get("epoch")
        .and_then(|v| v.as_str())
        .ok_or(SnapshotError::Invalid)?
        .to_owned();
    let visible_text = obj
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or(SnapshotError::Invalid)?
        .to_owned();
    let raw_elements = obj
        .get("elements")
        .and_then(|v| v.as_array())
        .ok_or(SnapshotError::Invalid)?;
    let mut elements = Vec::with_capacity(raw_elements.len());
    for el in raw_elements {
        let index = el
            .get("index")
            .and_then(|v| v.as_u64())
            .filter(|i| *i > 0)
            .ok_or(SnapshotError::Invalid)?;
        let role = el
            .get("role")
            .and_then(|v| v.as_str())
            .ok_or(SnapshotError::Invalid)?
            .to_owned();
        let name = el
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or(SnapshotError::Invalid)?
            .to_owned();
        let tag = el.get("tag").and_then(|v| v.as_str()).map(String::from);
        let text = el.get("text").and_then(|v| v.as_str()).map(String::from);
        elements.push(SnapshotElement {
            index,
            role,
            name,
            tag,
            text,
        });
    }
    Ok(Snapshot {
        elements,
        visible_text,
        epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_is_embedded() {
        assert!(SNAPSHOT_JS.contains("__unbrowseSnapshot"));
        assert!(SNAPSHOT_JS.contains("__unbrowseAct"));
    }

    #[test]
    fn parse_valid_snapshot() {
        let json = json!({
            "epoch": "123:0.5",
            "url": "https://example.com",
            "title": "Test",
            "text": "Hello world",
            "elements": [
                {"index": 1, "role": "link", "name": "Next"},
                {"index": 2, "role": "button", "name": "Details", "tag": "BUTTON", "text": "Details text"}
            ]
        });
        let snap = parse_snapshot(&json).unwrap();
        assert_eq!(snap.epoch, "123:0.5");
        assert_eq!(snap.visible_text, "Hello world");
        assert_eq!(snap.elements.len(), 2);
        assert_eq!(snap.elements[0].index, 1);
        assert_eq!(snap.elements[0].role, "link");
        assert_eq!(snap.elements[0].name, "Next");
        assert!(snap.elements[0].tag.is_none());
        assert_eq!(snap.elements[1].tag.as_deref(), Some("BUTTON"));
    }

    #[test]
    fn parse_rejects_missing_epoch() {
        let json = json!({"text": "hi", "elements": []});
        assert!(parse_snapshot(&json).is_err());
    }

    #[test]
    fn parse_rejects_zero_index() {
        let json = json!({
            "epoch": "1:0", "text": "hi",
            "elements": [{"index": 0, "role": "link", "name": "Bad"}]
        });
        assert!(parse_snapshot(&json).is_err());
    }

    #[test]
    fn parse_rejects_non_object() {
        assert!(parse_snapshot(&json!("string")).is_err());
        assert!(parse_snapshot(&json!(null)).is_err());
    }
}
