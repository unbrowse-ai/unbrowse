//! The Unbrowse node's core. Everything that touches key material lives here; the UI only
//! ever receives public values such as the wallet address.

pub mod backup;
pub mod code;
pub mod derive;
pub mod identity;
pub mod keystore;
pub mod owner_pass;
pub mod recovery;
pub mod sealed;
pub mod seed;
pub mod signed;
pub mod vault;

pub use backup::BackupError;
pub use code::CodeKey;
pub use derive::{node_proof, token_key, AgentKey, RootKey};
pub use identity::{load_or_create, Address, Identity, IdentityError};
pub use recovery::{RecoveryError, Restored};
pub use sealed::{SealError, Sealer};
pub use keystore::{FileStore, KeyStore, KeychainStore, KeystoreError, MemoryStore, Remembered};
pub use vault::{Card, CardField};
