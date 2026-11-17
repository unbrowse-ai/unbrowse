use serde_json::{json, Value};
use std::path::PathBuf;

use super::cdp::client::CdpClient;

const MAX_PROFILE_EVENTS: usize = 5_000_000;

const DEFAULT_PROFILER_CATEGORIES: &[&str] = &[
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-devtools.timeline.stack",
    "v8.execute",
    "disabled-by-default-v8.cpu_profiler",
    "disabled-by-default-v8.cpu_profiler.hires",
    "v8",
    "disabled-by-default-v8.runtime_stats",
    "blink",
    "blink.user_timing",
    "latencyInfo",
    "renderer.scheduler",
    "sequence_manager",
    "toplevel",
];

/// What a stop waits for, delivered whole however fast it comes.
const TRACE_EVENTS: &[&str] = &["Tracing.dataCollected", "Tracing.tracingComplete"];

/// Said instead of saving what came so far as if it were the whole trace.
const BROWSER_WENT_AWAY: &str = "The browser went away before the trace finished: nothing was saved";

pub struct TracingState {
    pub active: bool,
    pub events: Vec<Value>,
    pub events_dropped: bool,
}

impl Default for TracingState {
    fn default() -> Self {
        Self::new()
    }
}

impl TracingState {
    pub fn new() -> Self {
        Self {
            active: false,
            events: Vec::new(),
            events_dropped: false,
        }
    }
}

pub async fn trace_start(
    client: &CdpClient,
    session_id: &str,
    tracing_state: &mut TracingState,
) -> Result<Value, String> {
    if tracing_state.active {
        return Err("Tracing already active".to_string());
    }

    client
        .send_command(
            "Tracing.start",
            Some(json!({
                "traceConfig": {
                    "recordMode": "recordContinuously",
                },
                "transferMode": "ReturnAsStream",
            })),
            Some(session_id),
        )
        .await?;

    tracing_state.active = true;
    tracing_state.events.clear();
    tracing_state.events_dropped = false;

    Ok(json!({ "started": true }))
}

pub async fn trace_stop(
    client: &CdpClient,
    session_id: &str,
    tracing_state: &mut TracingState,
    path: Option<&str>,
) -> Result<Value, String> {
    if !tracing_state.active {
        return Err("No tracing in progress".to_string());
    }

    // Subscribe to events before stopping. Every event, not the broadcast: a trace is the one reader that must not fall
    // behind, and one that did read that as the trace being over.
    let mut rx = client.subscribe_methods(TRACE_EVENTS);

    client
        .send_command_no_params("Tracing.end", Some(session_id))
        .await?;

    // Collect trace data with timeout
    let mut trace_events: Vec<Value> = Vec::new();

    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(30);

    let stream_handle = loop {
        let result = tokio::time::timeout_at(deadline, rx.recv()).await;

        match result {
            Ok(Some(event)) => {
                if event.session_id.as_deref() != Some(session_id) {
                    continue;
                }
                match event.method.as_str() {
                    "Tracing.dataCollected" => {
                        if let Some(arr) = event.params.get("value").and_then(|v| v.as_array()) {
                            trace_events.extend(arr.iter().cloned());
                        }
                    }
                    "Tracing.tracingComplete" => {
                        break event.params.get("stream").and_then(|v| v.as_str()).map(String::from);
                    }
                    _ => {}
                }
            }
            Ok(None) => return Err(BROWSER_WENT_AWAY.to_string()),
            Err(_) => {
                return Err("Tracing stop timed out after 30s".to_string());
            }
        }
    };

    // If ReturnAsStream mode was used, read trace data from the IO stream
    if let Some(handle) = stream_handle {
        if trace_events.is_empty() {
            let stream_data = read_io_stream(client, session_id, &handle).await?;
            if let Ok(parsed) = serde_json::from_str::<Value>(&stream_data) {
                if let Some(events) = parsed.get("traceEvents").and_then(|v| v.as_array()) {
                    trace_events.extend(events.iter().cloned());
                }
            } else {
                // Try parsing as newline-delimited JSON
                for line in stream_data.lines() {
                    if let Ok(val) = serde_json::from_str::<Value>(line) {
                        if let Some(events) = val.get("traceEvents").and_then(|v| v.as_array()) {
                            trace_events.extend(events.iter().cloned());
                        } else {
                            trace_events.push(val);
                        }
                    }
                }
            }
        }
        // Close the IO stream
        let _ = client
            .send_command(
                "IO.close",
                Some(json!({ "handle": handle })),
                Some(session_id),
            )
            .await;
    }

    tracing_state.active = false;

    let save_path = match path {
        Some(p) => p.to_string(),
        None => {
            let dir = get_traces_dir();
            let _ = std::fs::create_dir_all(&dir);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            dir.join(format!("trace-{}.json", timestamp))
                .to_string_lossy()
                .to_string()
        }
    };

    let trace_json = json!({ "traceEvents": trace_events });
    let json_str = serde_json::to_string(&trace_json)
        .map_err(|e| format!("Failed to serialize trace: {}", e))?;
    std::fs::write(&save_path, json_str)
        .map_err(|e| format!("Failed to write trace to {}: {}", save_path, e))?;

    Ok(json!({ "path": save_path, "eventCount": trace_events.len() }))
}

pub async fn profiler_start(
    client: &CdpClient,
    session_id: &str,
    tracing_state: &mut TracingState,
    categories: Option<Vec<String>>,
) -> Result<Value, String> {
    if tracing_state.active {
        return Err("Profiling/tracing already active".to_string());
    }

    let cats: Vec<String> = categories.unwrap_or_else(|| {
        DEFAULT_PROFILER_CATEGORIES
            .iter()
            .map(|s| s.to_string())
            .collect()
    });

    client
        .send_command(
            "Tracing.start",
            Some(json!({
                "traceConfig": {
                    "includedCategories": cats,
                    "enableSampling": true,
                },
                "transferMode": "ReportEvents",
            })),
            Some(session_id),
        )
        .await?;

    tracing_state.active = true;
    tracing_state.events.clear();
    tracing_state.events_dropped = false;

    Ok(json!({ "started": true }))
}

pub async fn profiler_stop(
    client: &CdpClient,
    session_id: &str,
    tracing_state: &mut TracingState,
    path: Option<&str>,
) -> Result<Value, String> {
    if !tracing_state.active {
        return Err("No profiling in progress".to_string());
    }

    let mut rx = client.subscribe_methods(TRACE_EVENTS);

    client
        .send_command_no_params("Tracing.end", Some(session_id))
        .await?;

    let mut events: Vec<Value> = Vec::new();
    let mut dropped = false;
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(30);

    loop {
        let result = tokio::time::timeout_at(deadline, rx.recv()).await;

        match result {
            Ok(Some(event)) => {
                if event.session_id.as_deref() != Some(session_id) {
                    continue;
                }
                match event.method.as_str() {
                    "Tracing.dataCollected" => {
                        if let Some(arr) = event.params.get("value").and_then(|v| v.as_array()) {
                            if events.len() + arr.len() > MAX_PROFILE_EVENTS {
                                dropped = true;
                            } else {
                                events.extend(arr.iter().cloned());
                            }
                        }
                    }
                    "Tracing.tracingComplete" => {
                        break;
                    }
                    _ => {}
                }
            }
            Ok(None) => return Err(BROWSER_WENT_AWAY.to_string()),
            Err(_) => {
                return Err("Profiler stop timed out after 30s".to_string());
            }
        }
    }

    tracing_state.active = false;

    let save_path = match path {
        Some(p) => p.to_string(),
        None => {
            let dir = get_profiles_dir();
            let _ = std::fs::create_dir_all(&dir);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            dir.join(format!("profile-{}.json", timestamp))
                .to_string_lossy()
                .to_string()
        }
    };

    let clock_domain = get_clock_domain();
    let mut profile = json!({ "traceEvents": events });
    if let Some(cd) = clock_domain {
        profile
            .as_object_mut()
            .unwrap()
            .insert("metadata".to_string(), json!({ "clock-domain": cd }));
    }

    let json_str = serde_json::to_string(&profile)
        .map_err(|e| format!("Failed to serialize profile: {}", e))?;
    std::fs::write(&save_path, json_str)
        .map_err(|e| format!("Failed to write profile to {}: {}", save_path, e))?;

    let event_count = events.len();
    let mut result = json!({ "path": save_path, "eventCount": event_count });
    if dropped {
        result.as_object_mut().unwrap().insert(
            "warning".to_string(),
            Value::String(format!(
                "Events exceeded {} limit; some dropped",
                MAX_PROFILE_EVENTS
            )),
        );
    }

    Ok(result)
}

/// Read all data from a CDP IO stream handle.
async fn read_io_stream(
    client: &CdpClient,
    session_id: &str,
    handle: &str,
) -> Result<String, String> {
    let mut data = String::new();
    loop {
        let result = client
            .send_command(
                "IO.read",
                Some(json!({
                    "handle": handle,
                    "size": 1024 * 1024,
                })),
                Some(session_id),
            )
            .await?;

        if let Some(chunk) = result.get("data").and_then(|v| v.as_str()) {
            data.push_str(chunk);
        }

        let eof = result.get("eof").and_then(|v| v.as_bool()).unwrap_or(true);
        if eof {
            break;
        }
    }
    Ok(data)
}

fn get_clock_domain() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("LINUX_CLOCK_MONOTONIC")
    } else if cfg!(target_os = "macos") {
        Some("MAC_MACH_ABSOLUTE_TIME")
    } else {
        None
    }
}

fn get_traces_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".agent-browser").join("tmp").join("traces")
    } else {
        std::env::temp_dir().join("agent-browser").join("traces")
    }
}

fn get_profiles_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".agent-browser").join("tmp").join("profiles")
    } else {
        std::env::temp_dir().join("agent-browser").join("profiles")
    }
}

#[cfg(test)]
mod lossless_collection {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    /// A browser that answers `Tracing.end` with more events at once than the broadcast channel holds, then completes.
    async fn browser_flooding_trace_events(count: usize) -> (std::sync::Arc<CdpClient>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                let Ok(text) = message.to_text() else { continue };
                let request: Value = serde_json::from_str(text).unwrap();
                let _ = ws.send(Message::Text(json!({ "id": request["id"], "result": {} }).to_string())).await;
                if request["method"] == "Tracing.end" {
                    let event = |method: &str, params: Value| {
                        Message::Text(json!({ "method": method, "params": params, "sessionId": "s" }).to_string())
                    };
                    for n in 0..count {
                        let _ = ws.feed(event("Tracing.dataCollected", json!({ "value": [{ "n": n }] }))).await;
                    }
                    let _ = ws.feed(event("Tracing.tracingComplete", json!({}))).await;
                    let _ = ws.flush().await;
                }
            }
        });
        (std::sync::Arc::new(CdpClient::connect(&url).await.unwrap()), server)
    }

    /// Falling behind the event stream read as the trace being over: a truncated file, saved as whole.
    #[tokio::test]
    async fn a_trace_keeps_every_event_however_fast_they_come() {
        const EVENTS: usize = 20_000;
        let (client, server) = browser_flooding_trace_events(EVENTS).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.json");
        let mut state = TracingState::new();
        state.active = true;
        let answer = trace_stop(&client, "s", &mut state, path.to_str()).await.unwrap();
        server.abort();
        assert_eq!(answer["eventCount"], EVENTS, "{answer}");
    }
}
