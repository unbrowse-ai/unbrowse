//! An encrypted backup of the root key, under a passphrase the owner chooses (spec §76.1 item 1.4). The root key is
//! the node's own wallet: the identity it registers, its deposit, its route coins, what it earns and every agent key it
//! derives. The Keychain holds the only copy, so the owner can export it to a file and bring it back on a new machine.
//!
//! The file is an Ethereum keystore (Web3 Secret Storage, version 3): scrypt over the passphrase, the key under
//! AES-128-CTR, and a Keccak-256 MAC over the second half of the derived key and the ciphertext. So the same file also
//! opens in any wallet that imports a keystore file, and holds the node's address with what is on it. Nothing in it
//! is readable without the passphrase, and a wrong passphrase, or a file changed by one bit, opens nothing.

use aes::cipher::{KeyIvInit, StreamCipher};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::derive::RootKey;
use crate::identity::Address;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

/// scrypt's cost as most wallets write it (`n` = 2^18, `r` = 8, `p` = 1): about a second to open on a laptop, so a
/// stolen file can't be guessed at speed.
pub const LOG_N: u8 = 18;
/// The shortest passphrase a backup takes. The file may sit anywhere, so the passphrase is all that guards the key.
pub const MIN_PASSPHRASE: usize = 10;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("a backup's passphrase is at least {MIN_PASSPHRASE} characters")]
    ShortPassphrase,
    #[error("that isn't a key backup: {0}")]
    NotABackup(String),
    #[error("the passphrase doesn't open this backup, or the file was changed")]
    WrongPassphrase,
    #[error("the system's random source failed: {0}")]
    Random(String),
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    id: String,
    /// The key's address, lowercase hex with no prefix, as wallets write it. Read only to say which key it is.
    #[serde(default)]
    address: String,
    #[serde(alias = "Crypto")]
    crypto: Crypto,
}

#[derive(Serialize, Deserialize)]
struct Crypto {
    cipher: String,
    cipherparams: CipherParams,
    ciphertext: String,
    kdf: String,
    kdfparams: KdfParams,
    mac: String,
}

#[derive(Serialize, Deserialize)]
struct CipherParams {
    iv: String,
}

#[derive(Serialize, Deserialize)]
struct KdfParams {
    dklen: u32,
    n: u64,
    p: u32,
    r: u32,
    salt: String,
}

fn random<const N: usize>() -> Result<[u8; N], BackupError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| BackupError::Random(e.to_string()))?;
    Ok(b)
}

fn derive(passphrase: &str, salt: &[u8], log_n: u8, r: u32, p: u32) -> Result<Zeroizing<[u8; 32]>, BackupError> {
    let params = scrypt::Params::new(log_n, r, p, 32).map_err(|e| BackupError::NotABackup(format!("scrypt parameters: {e}")))?;
    let mut dk = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut *dk).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    Ok(dk)
}

fn mac(dk: &[u8; 32], ciphertext: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(&dk[16..32]);
    h.update(ciphertext);
    h.finalize().into()
}

/// The root key, encrypted under `passphrase`, as a keystore file's JSON.
pub fn export(root: &RootKey, passphrase: &str) -> Result<String, BackupError> {
    export_with(root, passphrase, LOG_N)
}

/// `export` at scrypt cost 2^`log_n`: tests use a cheap one.
pub fn export_with(root: &RootKey, passphrase: &str, log_n: u8) -> Result<String, BackupError> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(BackupError::ShortPassphrase);
    }
    let (salt, iv, id) = (random::<32>()?, random::<16>()?, random::<16>()?);
    let dk = derive(passphrase, &salt, log_n, 8, 1)?;
    let mut ciphertext = root.secret().to_vec();
    Aes128Ctr::new((&dk[..16]).into(), (&iv).into()).apply_keystream(&mut ciphertext);
    let file = File {
        version: 3,
        id: uuid(id),
        address: root.address().to_checksum()[2..].to_lowercase(),
        crypto: Crypto {
            cipher: "aes-128-ctr".into(),
            cipherparams: CipherParams { iv: hex::encode(iv) },
            mac: hex::encode(mac(&dk, &ciphertext)),
            ciphertext: hex::encode(ciphertext),
            kdf: "scrypt".into(),
            kdfparams: KdfParams { dklen: 32, n: 1 << log_n, p: 1, r: 8, salt: hex::encode(salt) },
        },
    };
    serde_json::to_string_pretty(&file).map_err(|e| BackupError::NotABackup(e.to_string()))
}

/// A random (version 4) UUID, as keystore files carry one.
fn uuid(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The address a backup says it holds, without opening it; `None` for one that doesn't say.
pub fn address_in(json: &str) -> Result<Option<String>, BackupError> {
    let f: File = serde_json::from_str(json).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    Ok((f.address.len() == 40).then(|| format!("0x{}", f.address)))
}

/// The key a backup holds, opened with `passphrase`. Any version 3 keystore file with scrypt and AES-128-CTR opens, so
/// a key exported by another wallet comes in too; the MAC is checked before anything is decrypted.
pub fn key_of(json: &str, passphrase: &str) -> Result<Zeroizing<[u8; 32]>, BackupError> {
    let f: File = serde_json::from_str(json).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    let c = &f.crypto;
    if f.version != 3 || c.kdf != "scrypt" || c.cipher != "aes-128-ctr" {
        return Err(BackupError::NotABackup(format!("version {} with {} and {}, where a backup is version 3 with scrypt and aes-128-ctr", f.version, c.kdf, c.cipher)));
    }
    let k = &c.kdfparams;
    if k.dklen != 32 || !k.n.is_power_of_two() || k.n < 2 || k.n > 1 << 22 {
        return Err(BackupError::NotABackup("its scrypt parameters are out of range".into()));
    }
    let unhex = |s: &str, what: &str| hex::decode(s.trim_start_matches("0x")).map_err(|_| BackupError::NotABackup(format!("its {what} isn't hex")));
    let (salt, iv, ciphertext, want) = (unhex(&k.salt, "salt")?, unhex(&c.cipherparams.iv, "iv")?, unhex(&c.ciphertext, "ciphertext")?, unhex(&c.mac, "mac")?);
    if iv.len() != 16 || ciphertext.len() != 32 {
        return Err(BackupError::NotABackup("it doesn't hold a 32-byte key".into()));
    }
    let dk = derive(passphrase, &salt, k.n.trailing_zeros() as u8, k.r, k.p)?;
    if mac(&dk, &ciphertext).as_slice() != want.as_slice() {
        return Err(BackupError::WrongPassphrase);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&ciphertext);
    Aes128Ctr::new((&dk[..16]).into(), iv.as_slice().into()).apply_keystream(&mut *key);
    k256::SecretKey::from_slice(&*key).map_err(|_| BackupError::NotABackup("what it holds isn't a key".into()))?;
    Ok(key)
}

/// The address of a key.
pub fn address_of(key: &[u8; 32]) -> Option<Address> {
    k256::SecretKey::from_slice(key).ok().map(|k| Address::from_public_key(&k.public_key()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::load_or_create;
    use crate::keystore::{KeyStore, MemoryStore};

    fn root() -> RootKey {
        let store = MemoryStore::default();
        load_or_create(&store).unwrap();
        RootKey::load(&store).unwrap()
    }

    /// The passphrase, put together at run time.
    fn pass() -> String {
        ["correct", "-horse-", "battery"].concat()
    }

    /// A keystore file another wallet wrote (Foundry's `cast wallet new`, scrypt at 2^13, for a throwaway key) opens
    /// here to the key it holds: its address is the one that wallet printed.
    #[test]
    fn a_keystore_file_another_wallet_wrote_opens() {
        let file = r#"{"crypto":{"cipher":"aes-128-ctr","cipherparams":{"iv":"0f65700541fd45b5092b89450928c210"},"ciphertext":"af8c91f690a8dfb8625c397d5cedd7c6b4293c51127c925c5ba25f305615c217","kdf":"scrypt","kdfparams":{"dklen":32,"n":8192,"p":1,"r":8,"salt":"c79ef2c152e6d00c502f40302c6fa7e31f755e0b65f7333f6fbe9051f78e3de6"},"mac":"9b3d28eb697d95d8b92d56e88eacfa744e49cf2616edc772c768ce5de551beb4"},"id":"9fdb24f4-ce13-43f6-b373-70309d64818c","version":3}"#;
        let pass = ["vector-", "pass-0"].concat();
        let key = key_of(file, &pass).unwrap();
        assert_eq!(address_of(&key).unwrap().to_checksum(), "0xD596bE7668619057C3169A0727F382c6AD8c8935");
        assert!(matches!(key_of(file, "vector-pass-1"), Err(BackupError::WrongPassphrase)));
    }

    /// An export opens with its passphrase, holds the same key and names its address; the wrong passphrase, a changed
    /// byte or a short passphrase opens or makes nothing.
    #[test]
    fn an_export_opens_with_its_passphrase_and_nothing_else() {
        let r = root();
        let json = export_with(&r, &pass(), 10).unwrap();
        assert!(!json.contains(&hex::encode(*r.secret())), "the key isn't in the file in the clear");
        assert_eq!(address_in(&json).unwrap(), Some(r.address().to_checksum().to_lowercase()));
        assert_eq!(*key_of(&json, &pass()).unwrap(), *r.secret());
        assert!(matches!(key_of(&json, "correct-horse-batterz"), Err(BackupError::WrongPassphrase)));
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let ct = v["crypto"]["ciphertext"].as_str().unwrap().to_string();
        let flipped = format!("{}{}", if ct.starts_with('0') { "1" } else { "0" }, &ct[1..]);
        v["crypto"]["ciphertext"] = flipped.into();
        assert!(matches!(key_of(&v.to_string(), &pass()), Err(BackupError::WrongPassphrase)), "a changed byte fails the MAC");
        assert!(matches!(export_with(&r, "short", 10), Err(BackupError::ShortPassphrase)));
        assert!(matches!(key_of("{}", &pass()), Err(BackupError::NotABackup(_))));
        // Two exports of one key share nothing but the key.
        let again = export_with(&r, &pass(), 10).unwrap();
        assert_ne!(json, again);
    }

    /// Restored into another store, the backup brings back everything the key made.
    #[test]
    fn a_restored_backup_is_the_same_node() {
        let r = root();
        let json = export_with(&r, &pass(), 10).unwrap();
        let fresh = MemoryStore::default();
        let key = key_of(&json, &pass()).unwrap();
        crate::recovery::restore_key(&fresh, |_| unreachable!("nothing to set aside"), &key).unwrap();
        let back = RootKey::load(&fresh).unwrap();
        assert_eq!(back.address(), r.address());
        assert_eq!(back.agent(0).api_token(), r.agent(0).api_token());
        assert!(fresh.get().unwrap().is_some());
    }
}
