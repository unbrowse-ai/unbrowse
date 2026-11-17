//! Unbrowse fork: features this build refuses.
//!
//! The Unbrowse node identifies itself to websites and never ships anything that defeats a
//! site's defences (Phase 1 spec §12). It also keeps the user's sessions and traffic on their
//! own machine. Upstream features that conflict with either are refused here, at the points
//! where they would take effect, so the upstream code stays untouched and rebases stay small.

const REASON: &str = "is disabled in the Unbrowse build: the node identifies itself to websites \
and keeps browsing on this machine";

/// Engines this build may launch. Obscura disguises itself as Chrome on Windows and fakes its
/// fingerprint, even without its stealth mode.
pub fn check_engine(engine: &str) -> Result<(), String> {
    match engine {
        "chrome" | "lightpanda" => Ok(()),
        "obscura" => Err(format!("The Obscura engine {REASON}. Use chrome or lightpanda.")),
        // Unknown engines keep upstream's own error.
        _ => Ok(()),
    }
}

/// Remote browser providers (Browserbase, Browserless, Browser Use, Kernel, AgentCore, and
/// plugin providers) run the browser on someone else's machine. iOS Safari is local and never
/// reaches this check.
pub fn check_provider(provider: &str) -> Result<(), String> {
    Err(format!("Remote browser provider '{provider}' {REASON}."))
}

/// Plugins that rewrite browser launch options are how stealth and captcha plugins attach.
pub fn check_launch_mutator(plugin: &str) -> Result<(), String> {
    Err(format!("Plugin '{plugin}' changes how the browser launches, which {REASON}."))
}

/// "human" input mode moves the pointer along eased curves to look like a person.
pub fn check_input_mode(mode: Option<&str>) -> Result<(), String> {
    match mode {
        Some("human") => Err(format!("Human-like input mode {REASON}. Use instant or smooth.")),
        _ => Ok(()),
    }
}

/// Checks a daemon command's input mode fields before it runs.
pub fn check_command(cmd: &serde_json::Value) -> Result<(), String> {
    for key in ["inputMode", "defaultInputMode"] {
        check_input_mode(cmd.get(key).and_then(serde_json::Value::as_str))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chrome_and_lightpanda_launch_obscura_does_not() {
        assert!(check_engine("chrome").is_ok());
        assert!(check_engine("lightpanda").is_ok());
        let err = check_engine("obscura").unwrap_err();
        assert!(err.contains("Obscura engine is disabled in the Unbrowse build"));
    }

    #[test]
    fn every_remote_provider_is_refused() {
        for p in ["browserbase", "browserless", "browser-use", "kernel", "agentcore", "my-plugin"] {
            assert!(check_provider(p).unwrap_err().contains(p));
        }
    }

    #[test]
    fn launch_mutating_plugins_are_refused() {
        assert!(check_launch_mutator("agent-browser-plugin-captcha").is_err());
    }

    #[test]
    fn human_input_is_refused_in_either_field() {
        assert!(check_command(&json!({"action": "click", "inputMode": "human"})).is_err());
        assert!(check_command(&json!({"action": "launch", "defaultInputMode": "human"})).is_err());
        assert!(check_command(&json!({"action": "click", "inputMode": "smooth"})).is_ok());
        assert!(check_command(&json!({"action": "click"})).is_ok());
    }
}
