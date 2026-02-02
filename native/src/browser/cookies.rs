//! Chrome cookie decryption - reads cookies directly from Chrome's SQLite database

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes128Gcm, Nonce,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pbkdf2::pbkdf2_hmac;
use sha1::Sha1;
use crate::types::HarCookie;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

const PBKDF2_ITERATIONS: u32 = 1003;
const PBKDF2_SALT: &[u8] = b"saltysalt";
const KEY_LENGTH: usize = 16;

/// Get Chrome's Safe Storage key from macOS Keychain
fn get_chrome_safe_storage_key() -> Result<Vec<u8>> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Chrome Safe Storage",
            "-w",
        ])
        .output()
        .map_err(|e| Error::from_reason(format!("Failed to get Chrome key: {}", e)))?;

    if !output.status.success() {
        return Err(Error::from_reason("Chrome Safe Storage key not found in Keychain"));
    }

    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Derive the actual encryption key using PBKDF2
    let mut key = vec![0u8; KEY_LENGTH];
    pbkdf2_hmac::<Sha1>(
        password.as_bytes(),
        PBKDF2_SALT,
        PBKDF2_ITERATIONS,
        &mut key,
    );

    Ok(key)
}

/// Decrypt a Chrome cookie value
fn decrypt_cookie_value(encrypted: &[u8], key: &[u8]) -> Option<String> {
    // Chrome v10 format: "v10" + 12-byte nonce + ciphertext + 16-byte tag
    if encrypted.len() < 3 {
        return None;
    }

    // Check for v10 prefix
    if &encrypted[..3] == b"v10" {
        let encrypted = &encrypted[3..];
        if encrypted.len() < 12 + 16 {
            return None;
        }

        let nonce = &encrypted[..12];
        let ciphertext_with_tag = &encrypted[12..];

        let cipher = Aes128Gcm::new_from_slice(key).ok()?;
        let nonce = Nonce::from_slice(nonce);

        let plaintext = cipher.decrypt(nonce, ciphertext_with_tag).ok()?;
        String::from_utf8(plaintext).ok()
    } else {
        // Try plain UTF-8 (unencrypted cookie)
        String::from_utf8(encrypted.to_vec()).ok()
    }
}

/// Get Chrome cookies database path
fn get_chrome_cookies_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("Library")
        .join("Application Support")
        .join("Google")
        .join("Chrome")
        .join("Default")
        .join("Cookies")
}

/// Check if Chrome cookies are available
#[napi]
pub fn chrome_cookies_available() -> bool {
    get_chrome_cookies_path().exists() && get_chrome_safe_storage_key().is_ok()
}

/// Read Chrome cookies for a domain
#[napi]
pub fn read_chrome_cookies(domain: String) -> Result<HashMap<String, String>> {
    let db_path = get_chrome_cookies_path();

    if !db_path.exists() {
        return Err(Error::from_reason("Chrome cookies database not found"));
    }

    // Get encryption key
    let key = get_chrome_safe_storage_key()?;

    // Copy database to temp location (Chrome locks it)
    let temp_path = std::env::temp_dir().join(format!("chrome_cookies_{}.db", std::process::id()));
    std::fs::copy(&db_path, &temp_path)
        .map_err(|e| Error::from_reason(format!("Failed to copy cookies db: {}", e)))?;

    // Open database
    let conn = rusqlite::Connection::open(&temp_path)
        .map_err(|e| Error::from_reason(format!("Failed to open cookies db: {}", e)))?;

    // Query cookies for domain (including subdomains)
    let mut stmt = conn
        .prepare(
            "SELECT name, encrypted_value, value FROM cookies
             WHERE host_key LIKE ?1 OR host_key LIKE ?2",
        )
        .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

    let domain_pattern = format!("%{}", domain);
    let dot_domain_pattern = format!(".{}", domain);

    let rows = stmt
        .query_map([&domain_pattern, &dot_domain_pattern], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2).unwrap_or_default(),
            ))
        })
        .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

    let mut cookies: HashMap<String, String> = HashMap::new();

    for row in rows.flatten() {
        let (name, encrypted_value, plain_value) = row;

        // Try encrypted value first, fall back to plain value
        let value = if !encrypted_value.is_empty() {
            decrypt_cookie_value(&encrypted_value, &key).unwrap_or(plain_value)
        } else {
            plain_value
        };

        if !value.is_empty() {
            cookies.insert(name, value);
        }
    }

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

    Ok(cookies)
}

/// Read Chrome cookies with full metadata
#[napi]
pub fn read_chrome_cookies_full(domain: String) -> Result<Vec<HarCookie>> {
    use crate::types::HarCookie;

    let db_path = get_chrome_cookies_path();

    if !db_path.exists() {
        return Err(Error::from_reason("Chrome cookies database not found"));
    }

    let key = get_chrome_safe_storage_key()?;

    let temp_path = std::env::temp_dir().join(format!("chrome_cookies_{}.db", std::process::id()));
    std::fs::copy(&db_path, &temp_path)
        .map_err(|e| Error::from_reason(format!("Failed to copy cookies db: {}", e)))?;

    let conn = rusqlite::Connection::open(&temp_path)
        .map_err(|e| Error::from_reason(format!("Failed to open cookies db: {}", e)))?;

    let mut stmt = conn
        .prepare(
            "SELECT name, encrypted_value, value, host_key, path, expires_utc, is_httponly, is_secure
             FROM cookies WHERE host_key LIKE ?1 OR host_key LIKE ?2",
        )
        .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

    let domain_pattern = format!("%{}", domain);
    let dot_domain_pattern = format!(".{}", domain);

    let rows = stmt
        .query_map([&domain_pattern, &dot_domain_pattern], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2).unwrap_or_default(),
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5).unwrap_or(0),
                row.get::<_, bool>(6).unwrap_or(false),
                row.get::<_, bool>(7).unwrap_or(false),
            ))
        })
        .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

    let mut cookies: Vec<HarCookie> = Vec::new();

    for row in rows.flatten() {
        let (name, encrypted_value, plain_value, host_key, path, expires_utc, http_only, secure) =
            row;

        let value = if !encrypted_value.is_empty() {
            decrypt_cookie_value(&encrypted_value, &key).unwrap_or(plain_value)
        } else {
            plain_value
        };

        if !value.is_empty() {
            // Convert Chrome timestamp to ISO string
            // Chrome uses microseconds since 1601-01-01
            let expires = if expires_utc > 0 {
                let secs_since_1601 = expires_utc / 1_000_000;
                let secs_since_1970 = secs_since_1601 - 11644473600;
                chrono::DateTime::from_timestamp(secs_since_1970, 0)
                    .map(|dt| dt.to_rfc3339())
            } else {
                None
            };

            cookies.push(HarCookie {
                name,
                value,
                domain: Some(host_key),
                path: Some(path),
                expires,
                http_only: Some(http_only),
                secure: Some(secure),
            });
        }
    }

    let _ = std::fs::remove_file(&temp_path);

    Ok(cookies)
}
