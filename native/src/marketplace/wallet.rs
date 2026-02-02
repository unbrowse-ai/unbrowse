//! Solana wallet management for x402 payments

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rand::RngCore;
use std::path::PathBuf;

/// Wallet data structure
#[napi(object)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Wallet {
    pub pubkey: String,
    pub created_at: String,
}

/// Get wallet file path
fn get_wallet_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".openclaw").join("unbrowse").join("wallet.json")
}

/// Get keypair file path (secret key)
fn get_keypair_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".openclaw").join("unbrowse").join("keypair.json")
}

/// Create a new wallet
#[napi]
pub fn wallet_create() -> Result<Wallet> {
    let wallet_path = get_wallet_path();
    let keypair_path = get_keypair_path();

    // Check if wallet already exists
    if wallet_path.exists() {
        return Err(Error::from_reason(
            "Wallet already exists. Use wallet_get to retrieve it.",
        ));
    }

    // Ensure directory exists
    if let Some(parent) = wallet_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::from_reason(format!("Failed to create wallet dir: {}", e)))?;
    }

    // Generate new keypair
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    let signing_key = SigningKey::from_bytes(&secret);
    let verifying_key = signing_key.verifying_key();

    // Encode pubkey as base58
    let pubkey = bs58::encode(verifying_key.as_bytes()).into_string();

    // Save keypair (as JSON array of bytes, similar to Solana CLI)
    let keypair_bytes: Vec<u8> = [secret.to_vec(), verifying_key.as_bytes().to_vec()].concat();
    let keypair_json = serde_json::to_string(&keypair_bytes)
        .map_err(|e| Error::from_reason(format!("Failed to serialize keypair: {}", e)))?;
    std::fs::write(&keypair_path, &keypair_json)
        .map_err(|e| Error::from_reason(format!("Failed to save keypair: {}", e)))?;

    // Set restrictive permissions on keypair file
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&keypair_path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&keypair_path, perms)?;
    }

    let wallet = Wallet {
        pubkey: pubkey.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    // Save wallet info
    let wallet_json = serde_json::to_string_pretty(&wallet)
        .map_err(|e| Error::from_reason(format!("Failed to serialize wallet: {}", e)))?;
    std::fs::write(&wallet_path, &wallet_json)
        .map_err(|e| Error::from_reason(format!("Failed to save wallet: {}", e)))?;

    Ok(wallet)
}

/// Get existing wallet
#[napi]
pub fn wallet_get() -> Result<Option<Wallet>> {
    let wallet_path = get_wallet_path();

    if !wallet_path.exists() {
        return Ok(None);
    }

    let wallet_json = std::fs::read_to_string(&wallet_path)
        .map_err(|e| Error::from_reason(format!("Failed to read wallet: {}", e)))?;

    let wallet: Wallet = serde_json::from_str(&wallet_json)
        .map_err(|e| Error::from_reason(format!("Failed to parse wallet: {}", e)))?;

    Ok(Some(wallet))
}

/// Get or create wallet
#[napi]
pub fn wallet_get_or_create() -> Result<Wallet> {
    match wallet_get()? {
        Some(wallet) => Ok(wallet),
        None => wallet_create(),
    }
}

/// Load signing key from keypair file
fn load_signing_key() -> Result<SigningKey> {
    let keypair_path = get_keypair_path();

    if !keypair_path.exists() {
        return Err(Error::from_reason("Wallet not found. Use wallet_create first."));
    }

    let keypair_json = std::fs::read_to_string(&keypair_path)
        .map_err(|e| Error::from_reason(format!("Failed to read keypair: {}", e)))?;

    let keypair_bytes: Vec<u8> = serde_json::from_str(&keypair_json)
        .map_err(|e| Error::from_reason(format!("Failed to parse keypair: {}", e)))?;

    if keypair_bytes.len() < 32 {
        return Err(Error::from_reason("Invalid keypair format"));
    }

    let mut secret = [0u8; 32];
    secret.copy_from_slice(&keypair_bytes[..32]);

    Ok(SigningKey::from_bytes(&secret))
}

/// Sign a message with the wallet
#[napi]
pub fn wallet_sign(message: String) -> Result<String> {
    let signing_key = load_signing_key()?;
    let signature = signing_key.sign(message.as_bytes());
    Ok(bs58::encode(signature.to_bytes()).into_string())
}

/// Sign an x402 payment request
#[napi]
pub fn wallet_sign_payment(
    skill_id: String,
    price_usdc: f64,
    recipient: String,
) -> Result<String> {
    let signing_key = load_signing_key()?;
    let pubkey = bs58::encode(signing_key.verifying_key().as_bytes()).into_string();

    // Create payment message
    let timestamp = chrono::Utc::now().timestamp();
    let message = format!(
        "x402:{}:{}:{}:{}:{}",
        skill_id, price_usdc, recipient, pubkey, timestamp
    );

    let signature = signing_key.sign(message.as_bytes());
    let sig_b58 = bs58::encode(signature.to_bytes()).into_string();

    // Return combined header value
    Ok(format!(
        "pubkey={};sig={};ts={};amount={};recipient={}",
        pubkey, sig_b58, timestamp, price_usdc, recipient
    ))
}

/// Verify a signature
#[napi]
pub fn wallet_verify(message: String, signature: String, pubkey: String) -> Result<bool> {
    let sig_bytes = bs58::decode(&signature)
        .into_vec()
        .map_err(|e| Error::from_reason(format!("Invalid signature encoding: {}", e)))?;

    let pubkey_bytes = bs58::decode(&pubkey)
        .into_vec()
        .map_err(|e| Error::from_reason(format!("Invalid pubkey encoding: {}", e)))?;

    if sig_bytes.len() != 64 || pubkey_bytes.len() != 32 {
        return Ok(false);
    }

    let sig_array: [u8; 64] = sig_bytes.try_into().unwrap();
    let pubkey_array: [u8; 32] = pubkey_bytes.try_into().unwrap();

    let signature = ed25519_dalek::Signature::from_bytes(&sig_array);
    let verifying_key = VerifyingKey::from_bytes(&pubkey_array)
        .map_err(|e| Error::from_reason(format!("Invalid pubkey: {}", e)))?;

    Ok(verifying_key.verify_strict(message.as_bytes(), &signature).is_ok())
}

/// Export wallet pubkey
#[napi]
pub fn wallet_pubkey() -> Result<Option<String>> {
    Ok(wallet_get()?.map(|w| w.pubkey))
}

/// Delete wallet (use with caution!)
#[napi]
pub fn wallet_delete() -> Result<bool> {
    let wallet_path = get_wallet_path();
    let keypair_path = get_keypair_path();

    let mut deleted = false;

    if wallet_path.exists() {
        std::fs::remove_file(&wallet_path)
            .map_err(|e| Error::from_reason(format!("Failed to delete wallet: {}", e)))?;
        deleted = true;
    }

    if keypair_path.exists() {
        std::fs::remove_file(&keypair_path)
            .map_err(|e| Error::from_reason(format!("Failed to delete keypair: {}", e)))?;
        deleted = true;
    }

    Ok(deleted)
}
