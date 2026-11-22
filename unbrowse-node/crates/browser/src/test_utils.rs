use std::sync::{Mutex, MutexGuard};

/// Global mutex shared across all test modules to prevent parallel tests from
/// interfering with each other when mutating environment variables.
pub static ENV_MUTEX: Mutex<()> = Mutex::new(());

/// The runtime browser: every launch made without a profile goes to one browser per mode on the machine
/// (`cdp::chrome::runtime_dir_for_mode`). A test that launches it, or points it somewhere else, holds this to its end,
/// so two tests of one parallel run never ask for it at once. The second would be refused ("already open in a running
/// browser"): in CI one test's browser held it and 130-odd launches of the others were refused, and the tests passed
/// regardless (UNB-208). An async lock, held across the test's awaits.
pub static RUNTIME_BROWSER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// RAII guard that locks [`ENV_MUTEX`] and restores environment variables on drop.
pub struct EnvGuard<'a> {
    _lock: MutexGuard<'a, ()>,
    vars: Vec<(String, Option<String>)>,
}

impl<'a> EnvGuard<'a> {
    pub fn new(var_names: &[&str]) -> Self {
        let lock = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let vars = var_names
            .iter()
            .map(|&name| (name.to_string(), std::env::var(name).ok()))
            .collect();
        Self { _lock: lock, vars }
    }

    pub fn set(&self, name: &str, value: &str) {
        debug_assert!(
            self.vars.iter().any(|(n, _)| n == name),
            "EnvGuard::set called with unregistered var: {name}"
        );
        std::env::set_var(name, value);
    }

    pub fn remove(&self, name: &str) {
        debug_assert!(
            self.vars.iter().any(|(n, _)| n == name),
            "EnvGuard::remove called with unregistered var: {name}"
        );
        std::env::remove_var(name);
    }
}

impl Drop for EnvGuard<'_> {
    fn drop(&mut self) {
        for (name, value) in &self.vars {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }
}
