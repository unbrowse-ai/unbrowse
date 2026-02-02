//! Credential providers - macOS Keychain, 1Password CLI, local vault

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::process::Command;

/// Lookup credentials from macOS Keychain
#[napi]
pub fn lookup_keychain(domain: String) -> Option<LoginCredential> {
    // Try with and without www prefix
    let domains = vec![domain.clone(), format!("www.{}", domain)];

    for d in domains {
        let output = Command::new("security")
            .args(["find-internet-password", "-s", &d, "-g"])
            .output();

        if let Ok(out) = output {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);

                // Extract account (username) from stdout
                let username = stdout
                    .lines()
                    .find(|line| line.contains("\"acct\""))
                    .and_then(|line| {
                        // Format: "acct"<blob>="username"
                        line.split('=').nth(1).map(|s| s.trim().trim_matches('"').to_string())
                    });

                // Extract password from stderr (security outputs password to stderr)
                let password = stderr
                    .lines()
                    .find(|line| line.starts_with("password:"))
                    .and_then(|line| {
                        // Format: password: "thepassword" or password: 0x...
                        let value = line.strip_prefix("password: ")?;
                        if value.starts_with('"') {
                            Some(value.trim_matches('"').to_string())
                        } else if value.starts_with("0x") {
                            // Hex-encoded password
                            let hex = value.strip_prefix("0x")?;
                            let bytes: Vec<u8> = (0..hex.len())
                                .step_by(2)
                                .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
                                .collect();
                            String::from_utf8(bytes).ok()
                        } else {
                            Some(value.to_string())
                        }
                    });

                if let (Some(u), Some(p)) = (username, password) {
                    return Some(LoginCredential {
                        username: u,
                        password: p,
                        source: Some("keychain".to_string()),
                    });
                }
            }
        }
    }

    None
}

/// Lookup credentials from 1Password CLI
#[napi]
pub fn lookup_1password(domain: String) -> Option<LoginCredential> {
    // Check if op CLI is available
    let check = Command::new("op")
        .args(["--version"])
        .output();

    if check.is_err() || !check.unwrap().status.success() {
        return None;
    }

    // Search for items matching the domain
    let search = Command::new("op")
        .args(["item", "list", "--format=json"])
        .output();

    let items: Vec<serde_json::Value> = match search {
        Ok(out) if out.status.success() => {
            serde_json::from_slice(&out.stdout).unwrap_or_default()
        }
        _ => return None,
    };

    // Find item matching domain
    let matching_item = items.iter().find(|item| {
        let urls = item.get("urls").and_then(|u| u.as_array());
        if let Some(urls) = urls {
            urls.iter().any(|url| {
                url.get("href")
                    .and_then(|h| h.as_str())
                    .map(|h| h.contains(&domain))
                    .unwrap_or(false)
            })
        } else {
            // Fallback to title matching
            item.get("title")
                .and_then(|t| t.as_str())
                .map(|t| t.to_lowercase().contains(&domain.to_lowercase()))
                .unwrap_or(false)
        }
    });

    let item_id = matching_item?.get("id")?.as_str()?;

    // Get full item details
    let get_item = Command::new("op")
        .args(["item", "get", item_id, "--format=json"])
        .output();

    let item: serde_json::Value = match get_item {
        Ok(out) if out.status.success() => {
            serde_json::from_slice(&out.stdout).ok()?
        }
        _ => return None,
    };

    // Extract username and password from fields
    let fields = item.get("fields")?.as_array()?;

    let username = fields.iter().find_map(|f| {
        let id = f.get("id").and_then(|i| i.as_str()).unwrap_or("");
        let label = f.get("label").and_then(|l| l.as_str()).unwrap_or("");
        if id == "username" || label.to_lowercase() == "username" || label.to_lowercase() == "email" {
            f.get("value").and_then(|v| v.as_str()).map(String::from)
        } else {
            None
        }
    });

    let password = fields.iter().find_map(|f| {
        let id = f.get("id").and_then(|i| i.as_str()).unwrap_or("");
        let label = f.get("label").and_then(|l| l.as_str()).unwrap_or("");
        if id == "password" || label.to_lowercase() == "password" {
            f.get("value").and_then(|v| v.as_str()).map(String::from)
        } else {
            None
        }
    });

    if let (Some(u), Some(p)) = (username, password) {
        Some(LoginCredential {
            username: u,
            password: p,
            source: Some("1password".to_string()),
        })
    } else {
        None
    }
}

/// Lookup credentials from any available source
#[napi]
pub fn lookup_credentials(domain: String) -> Option<LoginCredential> {
    // Try keychain first (fastest)
    if let Some(cred) = lookup_keychain(domain.clone()) {
        return Some(cred);
    }

    // Try 1Password
    if let Some(cred) = lookup_1password(domain.clone()) {
        return Some(cred);
    }

    // TODO: Add vault lookup when vault module is ready

    None
}

/// Build form field mappings for login
#[napi]
pub fn build_form_fields(credential: LoginCredential) -> std::collections::HashMap<String, String> {
    let mut fields = std::collections::HashMap::new();

    // Common username field names
    let username_fields = ["username", "email", "login", "user", "userid", "user_id"];
    for field in username_fields {
        fields.insert(field.to_string(), credential.username.clone());
    }

    // Common password field names
    let password_fields = ["password", "pass", "passwd", "pwd"];
    for field in password_fields {
        fields.insert(field.to_string(), credential.password.clone());
    }

    fields
}
