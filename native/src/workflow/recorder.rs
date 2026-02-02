//! Workflow session recording

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;
use std::sync::Mutex;

/// Recorded session data
#[napi(object)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RecordedSession {
    pub id: String,
    pub started_at: String,
    #[napi(ts_type = "string | undefined")]
    pub ended_at: Option<String>,
    pub steps: Vec<RecordedStep>,
    pub domains: Vec<String>,
}

/// Single recorded step
#[napi(object)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RecordedStep {
    pub step_type: String, // "navigation" | "api_call" | "action"
    pub timestamp: String,
    #[napi(ts_type = "string | undefined")]
    pub url: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub method: Option<String>,
    #[napi(ts_type = "number | undefined")]
    pub status: Option<i32>,
    #[napi(ts_type = "string | undefined")]
    pub action: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub selector: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub value: Option<String>,
}

// Global session state
static CURRENT_SESSION: Mutex<Option<RecordedSession>> = Mutex::new(None);

fn get_recordings_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".openclaw").join("workflow-recordings")
}

/// Start a new recording session
#[napi]
pub fn recording_start() -> Result<String> {
    let mut session_guard = CURRENT_SESSION.lock().unwrap();

    if session_guard.is_some() {
        return Err(Error::from_reason("A recording session is already active"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let session = RecordedSession {
        id: id.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        ended_at: None,
        steps: Vec::new(),
        domains: Vec::new(),
    };

    *session_guard = Some(session);
    Ok(id)
}

/// Stop the current recording session
#[napi]
pub fn recording_stop() -> Result<Option<RecordedSession>> {
    let mut session_guard = CURRENT_SESSION.lock().unwrap();

    match session_guard.take() {
        Some(mut session) => {
            session.ended_at = Some(chrono::Utc::now().to_rfc3339());

            // Save to file
            let dir = get_recordings_dir();
            std::fs::create_dir_all(&dir)
                .map_err(|e| Error::from_reason(format!("Failed to create recordings dir: {}", e)))?;

            let filename = format!(
                "session-{}-{}.json",
                chrono::Utc::now().format("%Y%m%d-%H%M%S"),
                &session.id[..8]
            );
            let path = dir.join(&filename);

            let json = serde_json::to_string_pretty(&session)
                .map_err(|e| Error::from_reason(format!("Failed to serialize session: {}", e)))?;
            std::fs::write(&path, &json)
                .map_err(|e| Error::from_reason(format!("Failed to save session: {}", e)))?;

            Ok(Some(session))
        }
        None => Ok(None),
    }
}

/// Record a navigation event
#[napi]
pub fn recording_navigation(url: String) -> Result<()> {
    let mut session_guard = CURRENT_SESSION.lock().unwrap();

    if let Some(ref mut session) = *session_guard {
        // Extract domain
        if let Ok(parsed) = url::Url::parse(&url) {
            if let Some(host) = parsed.host_str() {
                if !session.domains.contains(&host.to_string()) {
                    session.domains.push(host.to_string());
                }
            }
        }

        session.steps.push(RecordedStep {
            step_type: "navigation".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            url: Some(url),
            method: None,
            status: None,
            action: None,
            selector: None,
            value: None,
        });
    }

    Ok(())
}

/// Record an API call
#[napi]
pub fn recording_api_call(url: String, method: String, status: i32) -> Result<()> {
    let mut session_guard = CURRENT_SESSION.lock().unwrap();

    if let Some(ref mut session) = *session_guard {
        session.steps.push(RecordedStep {
            step_type: "api_call".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            url: Some(url),
            method: Some(method),
            status: Some(status),
            action: None,
            selector: None,
            value: None,
        });
    }

    Ok(())
}

/// Record a browser action
#[napi]
pub fn recording_action(action: String, selector: Option<String>, value: Option<String>) -> Result<()> {
    let mut session_guard = CURRENT_SESSION.lock().unwrap();

    if let Some(ref mut session) = *session_guard {
        session.steps.push(RecordedStep {
            step_type: "action".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            url: None,
            method: None,
            status: None,
            action: Some(action),
            selector,
            value,
        });
    }

    Ok(())
}

/// Check if a recording is active
#[napi]
pub fn recording_is_active() -> bool {
    CURRENT_SESSION.lock().unwrap().is_some()
}

/// Get current session info
#[napi]
pub fn recording_current() -> Option<RecordedSession> {
    CURRENT_SESSION.lock().unwrap().clone()
}

/// List all recorded sessions
#[napi]
pub fn recording_list() -> Result<Vec<String>> {
    let dir = get_recordings_dir();

    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| Error::from_reason(format!("Failed to read recordings dir: {}", e)))?;

    let mut sessions: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.ends_with(".json") {
                sessions.push(name.to_string());
            }
        }
    }

    sessions.sort();
    sessions.reverse(); // Most recent first
    Ok(sessions)
}

/// Load a recorded session by filename
#[napi]
pub fn recording_load(filename: String) -> Result<RecordedSession> {
    let dir = get_recordings_dir();
    let path = dir.join(&filename);

    if !path.exists() {
        return Err(Error::from_reason(format!("Session not found: {}", filename)));
    }

    let json = std::fs::read_to_string(&path)
        .map_err(|e| Error::from_reason(format!("Failed to read session: {}", e)))?;

    let session: RecordedSession = serde_json::from_str(&json)
        .map_err(|e| Error::from_reason(format!("Failed to parse session: {}", e)))?;

    Ok(session)
}
