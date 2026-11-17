use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;

/// Result of a policy check for an action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyResult {
    /// Action is allowed.
    Allow,
    /// Action is blocked with the given reason.
    Deny(String),
    /// Action requires confirmation before proceeding.
    RequiresConfirmation,
}

/// Policy configuration loaded from a JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionPolicy {
    #[serde(skip)]
    path: PathBuf,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    allow: Option<Vec<String>>,
    #[serde(default)]
    deny: Option<Vec<String>>,
    #[serde(default)]
    confirm: Option<Vec<String>>,
    /// Why the policy file can't be used, while it can't: every action is denied until it can.
    #[serde(skip)]
    unusable: Option<String>,
}

/// Confirmation categories parsed from AGENT_BROWSER_CONFIRM_ACTIONS.
#[derive(Debug, Clone)]
pub struct ConfirmActions {
    pub categories: HashSet<String>,
}

impl ConfirmActions {
    pub fn from_env() -> Option<Self> {
        let val = env::var("AGENT_BROWSER_CONFIRM_ACTIONS").ok()?;
        if val.is_empty() {
            return None;
        }
        let categories: HashSet<String> = val
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        if categories.is_empty() {
            None
        } else {
            Some(Self { categories })
        }
    }

    pub fn requires_confirmation(&self, action: &str) -> bool {
        self.categories.contains(action)
    }
}

impl ActionPolicy {
    /// Load policy from a JSON file at the given path.
    pub fn load(path: &str) -> Result<Self, String> {
        let path_buf = PathBuf::from(path);
        let contents = fs::read_to_string(&path_buf)
            .map_err(|e| format!("Failed to read policy file: {}", e))?;
        let mut policy: ActionPolicy =
            serde_json::from_str(&contents).map_err(|e| format!("Invalid policy JSON: {}", e))?;
        policy.path = path_buf;
        Ok(policy)
    }

    /// Load policy if AGENT_BROWSER_ACTION_POLICY env var is set.
    /// Falls back to AGENT_BROWSER_POLICY for backwards compatibility.
    pub fn load_if_exists() -> Option<Self> {
        let path = env::var("AGENT_BROWSER_ACTION_POLICY")
            .or_else(|_| env::var("AGENT_BROWSER_POLICY"))
            .ok()
            .filter(|path| !path.trim().is_empty())?;
        // A policy the owner named but that cannot be read denies every
        // action until it can be: a missing or broken file never fails open.
        Some(Self::load(&path).unwrap_or_else(|why| Self::unusable(PathBuf::from(&path), why)))
    }

    /// The policy in force while the file at `path` can't be used.
    fn unusable(path: PathBuf, why: String) -> Self {
        Self { path, default: Some("deny".to_string()), allow: None, deny: None, confirm: None, unusable: Some(why) }
    }

    /// Whether the owner's `confirm` or `deny` may answer the gate. An answer is the way out of a confirmation, not a
    /// page action, so an allow list that doesn't name it can't strand the question: only a deny that names it refuses
    /// it. The command it approves is checked again when it runs, so a confirm under a broken file still runs nothing.
    pub fn check_answer(&self, action: &str) -> PolicyResult {
        match self.deny.iter().flatten().any(|a| a == action) {
            true => PolicyResult::Deny(format!("Action '{}' is denied by policy", action)),
            false => PolicyResult::Allow,
        }
    }

    /// Check whether an action is allowed, denied, or requires confirmation.
    pub fn check(&self, action: &str) -> PolicyResult {
        if let Some(why) = &self.unusable {
            return PolicyResult::Deny(format!("the policy file can't be used, so everything is denied until it can: {why}"));
        }
        if let Some(deny) = &self.deny {
            if deny.iter().any(|a| a == action) {
                return PolicyResult::Deny(format!("Action '{}' is denied by policy", action));
            }
        }

        if let Some(confirm) = &self.confirm {
            if confirm.iter().any(|a| a == action) {
                return PolicyResult::RequiresConfirmation;
            }
        }

        if let Some(allow) = &self.allow {
            if !allow.is_empty() && !allow.iter().any(|a| a == action) {
                let is_default_deny = self
                    .default
                    .as_deref()
                    .map(|d| d.eq_ignore_ascii_case("deny"))
                    .unwrap_or(true);
                if is_default_deny {
                    return PolicyResult::Deny(format!(
                        "Action '{}' is not in the allow list",
                        action
                    ));
                }
            }
        } else if let Some(ref default) = self.default {
            if default.eq_ignore_ascii_case("deny") {
                return PolicyResult::Deny(format!(
                    "Action '{}' denied: default policy is deny",
                    action
                ));
            }
        }

        PolicyResult::Allow
    }

    /// Reload policy from the file. Re-reads the JSON and updates the policy. A file that can't be read or parsed denies
    /// everything until it can: the owner was changing it, so the old, perhaps looser, policy is no longer what they meant.
    pub fn reload(&mut self) -> Result<(), String> {
        let read = fs::read_to_string(&self.path)
            .map_err(|e| format!("Failed to read policy file: {}", e))
            .and_then(|contents| serde_json::from_str::<ActionPolicy>(&contents).map_err(|e| format!("Invalid policy JSON: {}", e)));
        match read {
            Ok(mut policy) => {
                policy.path = self.path.clone();
                *self = policy;
                Ok(())
            }
            Err(why) => {
                *self = Self::unusable(self.path.clone(), why.clone());
                Err(why)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::EnvGuard;

    #[test]
    fn a_named_policy_that_cannot_be_read_denies() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_ACTION_POLICY", "AGENT_BROWSER_POLICY"]);
        guard.set("AGENT_BROWSER_ACTION_POLICY", "/nonexistent/policy.json");
        let policy = ActionPolicy::load_if_exists().expect("a named policy is in force");
        assert!(matches!(policy.check("click"), PolicyResult::Deny(_)));
        guard.set("AGENT_BROWSER_ACTION_POLICY", "");
        guard.remove("AGENT_BROWSER_POLICY");
        assert!(ActionPolicy::load_if_exists().is_none());
    }

    /// The owner breaks the file while editing it: everything is denied, not left to the old policy, and mending the
    /// file brings its rules back.
    #[test]
    fn a_policy_that_stops_reading_denies_until_it_is_mended() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        fs::write(&path, r#"{"default":"allow"}"#).unwrap();
        let mut policy = ActionPolicy::load(path.to_str().unwrap()).unwrap();
        assert_eq!(policy.check("click"), PolicyResult::Allow);

        fs::write(&path, r#"{"default":"allow","deny":["click""#).unwrap();
        assert!(policy.reload().is_err());
        assert!(matches!(policy.check("click"), PolicyResult::Deny(_)), "a broken file keeps nothing");
        assert_eq!(policy.check_answer("deny"), PolicyResult::Allow, "the owner can still say no");

        fs::remove_file(&path).unwrap();
        assert!(policy.reload().is_err());
        assert!(matches!(policy.check("click"), PolicyResult::Deny(_)), "nor does a missing one");

        fs::write(&path, r#"{"default":"allow"}"#).unwrap();
        policy.reload().unwrap();
        assert_eq!(policy.check("click"), PolicyResult::Allow);
    }

    /// An allow list says which page actions may run. It can't leave a question nobody may answer, but a deny that
    /// names the answer is the owner's word.
    #[test]
    fn an_answer_is_refused_only_by_a_deny_that_names_it() {
        let policy: ActionPolicy = serde_json::from_str(r#"{"allow":["click"],"confirm":["navigate"]}"#).unwrap();
        assert_eq!(policy.check_answer("confirm"), PolicyResult::Allow);
        let policy: ActionPolicy = serde_json::from_str(r#"{"deny":["confirm"]}"#).unwrap();
        assert!(matches!(policy.check_answer("confirm"), PolicyResult::Deny(_)));
    }

    #[test]
    fn test_policy_allow_whitelist() {
        let json = r#"{"allow": ["click", "type"], "deny": [], "confirm": []}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("click"), PolicyResult::Allow);
        assert_eq!(policy.check("type"), PolicyResult::Allow);
        assert!(matches!(policy.check("navigate"), PolicyResult::Deny(_)));
    }

    #[test]
    fn test_policy_deny() {
        let json = r#"{"allow": [], "deny": ["delete"], "confirm": []}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert!(matches!(policy.check("delete"), PolicyResult::Deny(_)));
    }

    #[test]
    fn test_policy_confirm() {
        let json = r#"{"allow": [], "deny": [], "confirm": ["submit"]}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("submit"), PolicyResult::RequiresConfirmation);
    }

    #[test]
    fn test_policy_deny_takes_precedence() {
        let json = r#"{"allow": ["danger"], "deny": ["danger"], "confirm": []}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert!(matches!(policy.check("danger"), PolicyResult::Deny(_)));
    }

    #[test]
    fn test_policy_confirm_takes_precedence_over_allow() {
        let json = r#"{"allow": ["submit"], "deny": [], "confirm": ["submit"]}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("submit"), PolicyResult::RequiresConfirmation);
    }

    #[test]
    fn test_policy_empty_allow_allows_all() {
        let json = r#"{"allow": [], "deny": [], "confirm": []}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("anything"), PolicyResult::Allow);
    }

    #[test]
    fn test_policy_missing_allow_allows_all() {
        let json = r#"{"deny": []}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("anything"), PolicyResult::Allow);
    }

    #[test]
    fn test_policy_default_allow() {
        let json = r#"{"default": "allow", "deny": ["navigate"]}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("click"), PolicyResult::Allow);
        assert!(matches!(policy.check("navigate"), PolicyResult::Deny(_)));
    }

    #[test]
    fn test_policy_default_deny() {
        let json = r#"{"default": "deny", "allow": ["click"]}"#;
        let policy: ActionPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.check("click"), PolicyResult::Allow);
        assert!(matches!(policy.check("navigate"), PolicyResult::Deny(_)));
    }

    #[test]
    fn test_confirm_actions_from_env() {
        let _guard = EnvGuard::new(&["AGENT_BROWSER_CONFIRM_ACTIONS"]);
        _guard.set("AGENT_BROWSER_CONFIRM_ACTIONS", "navigate,click,fill");
        let ca = ConfirmActions::from_env().unwrap();
        assert!(ca.requires_confirmation("navigate"));
        assert!(ca.requires_confirmation("click"));
        assert!(ca.requires_confirmation("fill"));
        assert!(!ca.requires_confirmation("screenshot"));
    }
}
