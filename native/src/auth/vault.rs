//! Encrypted local vault for API credentials
//!
//! Uses AES-256-GCM encryption with key stored in macOS Keychain.

use crate::types::*;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rand::RngCore;
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::PathBuf;

const KEYCHAIN_SERVICE: &str = "unbrowse-vault";
const KEYCHAIN_ACCOUNT: &str = "encryption-key";

/// Get or create the vault encryption key from macOS Keychain
fn get_vault_key() -> Result<[u8; 32]> {
    // Try to get existing key
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .map_err(|e| Error::from_reason(format!("Failed to run security command: {}", e)))?;

    if output.status.success() {
        let key_b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let key_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &key_b64
        ).map_err(|e| Error::from_reason(format!("Invalid key encoding: {}", e)))?;

        if key_bytes.len() != 32 {
            return Err(Error::from_reason("Invalid key length"));
        }

        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);
        return Ok(key);
    }

    // Generate new key
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let key_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &key);

    // Store in keychain
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", KEYCHAIN_ACCOUNT,
            "-w", &key_b64,
            "-U", // Update if exists
        ])
        .status()
        .map_err(|e| Error::from_reason(format!("Failed to store key: {}", e)))?;

    if !status.success() {
        return Err(Error::from_reason("Failed to store key in keychain"));
    }

    Ok(key)
}

/// Encrypt plaintext with AES-256-GCM
fn encrypt(plaintext: &str, key: &[u8; 32]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| Error::from_reason(format!("Invalid key: {}", e)))?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| Error::from_reason(format!("Encryption failed: {}", e)))?;

    // Pack: nonce (12) + ciphertext (includes 16-byte tag)
    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);

    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &packed))
}

/// Decrypt ciphertext with AES-256-GCM
fn decrypt(packed_b64: &str, key: &[u8; 32]) -> Result<String> {
    let packed = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, packed_b64)
        .map_err(|e| Error::from_reason(format!("Invalid base64: {}", e)))?;

    if packed.len() < 12 {
        return Err(Error::from_reason("Invalid encrypted data"));
    }

    let (nonce_bytes, ciphertext) = packed.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| Error::from_reason(format!("Invalid key: {}", e)))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| Error::from_reason(format!("Decryption failed: {}", e)))?;

    String::from_utf8(plaintext)
        .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {}", e)))
}

/// Get the vault database path
fn get_vault_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".openclaw").join("unbrowse").join("vault.db")
}

/// Initialize the vault database
fn init_vault_db(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS credentials (
            service TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| Error::from_reason(format!("Failed to create table: {}", e)))?;
    Ok(())
}

/// Store credentials in the vault
#[napi]
pub fn vault_store(
    service: String,
    base_url: String,
    auth_method: String,
    headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
) -> Result<()> {
    let key = get_vault_key()?;
    let vault_path = get_vault_path();

    // Ensure directory exists
    if let Some(parent) = vault_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::from_reason(format!("Failed to create vault dir: {}", e)))?;
    }

    let conn = Connection::open(&vault_path)
        .map_err(|e| Error::from_reason(format!("Failed to open vault: {}", e)))?;
    init_vault_db(&conn)?;

    let entry = VaultEntry {
        service: service.clone(),
        base_url,
        auth_method,
        headers,
        cookies,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    let json = serde_json::to_string(&entry)
        .map_err(|e| Error::from_reason(format!("Failed to serialize: {}", e)))?;
    let encrypted = encrypt(&json, &key)?;

    conn.execute(
        "INSERT OR REPLACE INTO credentials (service, data, updated_at) VALUES (?1, ?2, ?3)",
        params![service, encrypted, entry.updated_at],
    )
    .map_err(|e| Error::from_reason(format!("Failed to store: {}", e)))?;

    Ok(())
}

/// Get credentials from the vault
#[napi]
pub fn vault_get(service: String) -> Result<Option<VaultEntry>> {
    let key = get_vault_key()?;
    let vault_path = get_vault_path();

    if !vault_path.exists() {
        return Ok(None);
    }

    let conn = Connection::open(&vault_path)
        .map_err(|e| Error::from_reason(format!("Failed to open vault: {}", e)))?;

    let result: rusqlite::Result<String> = conn.query_row(
        "SELECT data FROM credentials WHERE service = ?1",
        params![service],
        |row| row.get(0),
    );

    match result {
        Ok(encrypted) => {
            let json = decrypt(&encrypted, &key)?;
            let entry: VaultEntry = serde_json::from_str(&json)
                .map_err(|e| Error::from_reason(format!("Failed to parse: {}", e)))?;
            Ok(Some(entry))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(Error::from_reason(format!("Query failed: {}", e))),
    }
}

/// List all services in the vault
#[napi]
pub fn vault_list() -> Result<Vec<String>> {
    let vault_path = get_vault_path();

    if !vault_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open(&vault_path)
        .map_err(|e| Error::from_reason(format!("Failed to open vault: {}", e)))?;

    let mut stmt = conn.prepare("SELECT service FROM credentials ORDER BY service")
        .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

    let services: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(services)
}

/// Delete credentials from the vault
#[napi]
pub fn vault_delete(service: String) -> Result<bool> {
    let vault_path = get_vault_path();

    if !vault_path.exists() {
        return Ok(false);
    }

    let conn = Connection::open(&vault_path)
        .map_err(|e| Error::from_reason(format!("Failed to open vault: {}", e)))?;

    let rows = conn.execute(
        "DELETE FROM credentials WHERE service = ?1",
        params![service],
    )
    .map_err(|e| Error::from_reason(format!("Delete failed: {}", e)))?;

    Ok(rows > 0)
}

/// Export vault entry as auth.json format
#[napi]
pub fn vault_export_auth_json(service: String) -> Result<Option<String>> {
    let entry = vault_get(service)?;

    match entry {
        Some(e) => {
            let auth = AuthJson {
                service: e.service,
                base_url: e.base_url,
                auth_method: e.auth_method,
                headers: if e.headers.is_empty() { None } else { Some(e.headers) },
                cookies: if e.cookies.is_empty() { None } else { Some(e.cookies) },
                context: None,
                refresh: None,
            };

            let json = serde_json::to_string_pretty(&auth)
                .map_err(|e| Error::from_reason(format!("Serialize failed: {}", e)))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}
