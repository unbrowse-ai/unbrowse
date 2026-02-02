//! Unbrowse Native - Complete Rust implementation
//!
//! Reverse-engineer internal APIs from any website.
//! This native module provides all core functionality:
//!
//! - HAR parsing and API endpoint extraction
//! - Auth detection and credential management
//! - Skill generation (SKILL.md, auth.json, api.ts)
//! - Browser control and network capture
//! - Marketplace integration with x402 payments
//! - Workflow recording, learning, and execution

pub mod types;
pub mod parser;
pub mod auth;
pub mod skill;
pub mod browser;
pub mod marketplace;
pub mod workflow;

// Re-export all public items for direct access
pub use types::*;
pub use parser::*;
pub use auth::*;
pub use skill::*;
pub use browser::*;
pub use marketplace::*;
pub use workflow::*;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Get the native module version
#[napi]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Check if native module is available
#[napi]
pub fn is_native() -> bool {
    true
}

/// Get module info
#[napi]
pub fn get_module_info() -> serde_json::Value {
    serde_json::json!({
        "name": "unbrowse-native",
        "version": env!("CARGO_PKG_VERSION"),
        "features": [
            "har_parsing",
            "auth_detection",
            "skill_generation",
            "browser_control",
            "marketplace",
            "workflow",
            "vault",
            "chrome_cookies",
            "credential_providers",
        ],
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}
