//! Command timeouts: how long a CDP command may take before the caller gives up.

use std::time::Duration;

use serde_json::Value;

/// The read timeout for one command: its own timeout (or a drag's duration)
/// plus generous slack, floored at the daemon's own DevTools timeout plus that
/// slack — a page can take its time.
///
/// Unbrowse fork: the floor was 30s, the same as the daemon's DevTools command
/// timeout, so a script that ran that long lost the race: the client's socket
/// read gave up first with EAGAIN ("Resource temporarily unavailable", os error
/// 35 on macOS) instead of the daemon answering that the script timed out.
pub fn read_timeout_for(cmd: &Value) -> Duration {
    let mut op_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(0);
    if cmd.get("action").and_then(Value::as_str) == Some("mousemove") {
        op_ms = op_ms.max(cmd.get("duration").and_then(Value::as_u64).unwrap_or(0));
    }
    let floor = crate::cdp::client::COMMAND_TIMEOUT.as_millis() as u64 + SLACK_MS;
    Duration::from_millis(op_ms.saturating_add(SLACK_MS).max(floor))
}

/// How much longer than the daemon's own wait the client listens for its answer.
const SLACK_MS: u64 = 10_000;

#[cfg(test)]
mod tests {
    use super::*;

    /// A command the daemon gives up on answers before the client stops listening: a script that
    /// runs to the daemon's DevTools timeout is reported as timed out, never as a dead socket.
    #[test]
    fn the_daemon_answers_a_timed_out_command_before_the_client_gives_up() {
        let floor = read_timeout_for(&serde_json::json!({ "action": "evaluate" }));
        assert!(floor > crate::cdp::client::COMMAND_TIMEOUT, "{floor:?}");
        let long = read_timeout_for(&serde_json::json!({ "action": "evaluate", "timeout": 120_000 }));
        assert_eq!(long, Duration::from_millis(130_000));
    }
}
