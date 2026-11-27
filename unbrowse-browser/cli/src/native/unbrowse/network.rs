//! A response's body, read once Chrome has it (UNB-208).
//!
//! Upstream's `responsebody` asks for the body as soon as the matching response's headers arrive
//! (`Network.responseReceived`). Chrome holds no body until the request finishes loading, so the ask fails with "No
//! data found for resource with given identifier" for any response whose body comes after its headers (every one,
//! in Chrome 157 against a local server). This waits for the request to finish, or fail, first.

use tokio::sync::broadcast::{error::RecvError, Receiver};
use tokio::time::Instant;

use crate::native::cdp::types::CdpEvent;

/// Waits on `events` until `request_id` in `session_id` has finished loading or failed, or `deadline` passes.
pub async fn loaded(events: &mut Receiver<CdpEvent>, session_id: &str, request_id: &str, deadline: Instant) {
    loop {
        let event = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(event)) => event,
            Ok(Err(RecvError::Lagged(_))) => continue,
            Ok(Err(RecvError::Closed)) | Err(_) => return,
        };
        let finished = matches!(event.method.as_str(), "Network.loadingFinished" | "Network.loadingFailed");
        if finished
            && event.session_id.as_deref() == Some(session_id)
            && event.params.get("requestId").and_then(|v| v.as_str()) == Some(request_id)
        {
            return;
        }
    }
}
