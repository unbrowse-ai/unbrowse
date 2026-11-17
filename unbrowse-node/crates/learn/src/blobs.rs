//! A site's scripts and wasm modules, kept once under their hash (`learn.reference`).
//!
//! A body is stored under the hex sha256 of its bytes, so a script parsed by a hundred walks is one file, and a route
//! can name the code it depends on by url and hash without carrying it. The hash is the body's identity: bytes put under
//! a hash they don't have are refused, and a stored file whose bytes no longer have its name's hash is refused when
//! read, so what is handed back is always the code that was recorded.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The hex sha256 of a body.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BlobError {
    /// The bytes don't have the hash they were put or found under.
    #[error("the bytes under {claimed} hash to {actual}")]
    Changed { claimed: String, actual: String },
    #[error("{0} is not a sha256")]
    NotAHash(String),
    #[error("blob store: {0}")]
    Io(String),
}

/// A store of bodies by hash, in a directory: `<dir>/<first two hex>/<hash>`.
#[derive(Clone, Debug)]
pub struct Blobs {
    dir: PathBuf,
}

impl Blobs {
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, sha: &str) -> Result<PathBuf, BlobError> {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Err(BlobError::NotAHash(sha.to_string()));
        }
        Ok(self.dir.join(&sha[..2]).join(sha))
    }

    /// Keeps `bytes` under their hash, once: a body already kept is not written again. Returns the hash.
    pub fn put(&self, bytes: &[u8]) -> Result<String, BlobError> {
        let sha = sha256_hex(bytes);
        self.put_as(&sha, bytes)?;
        Ok(sha)
    }

    /// Keeps `bytes` under `sha`, which must be their hash: bytes that changed since they were hashed are refused. A
    /// body already kept under it is left as it is (it is the same body); one whose file was changed is refused.
    pub fn put_as(&self, sha: &str, bytes: &[u8]) -> Result<(), BlobError> {
        let path = self.path(sha)?;
        let actual = sha256_hex(bytes);
        if actual != sha {
            return Err(BlobError::Changed { claimed: sha.to_string(), actual });
        }
        if path.exists() {
            return self.get(sha).map(|_| ());
        }
        let parent = path.parent().expect("a blob's path has its fan-out directory");
        std::fs::create_dir_all(parent).map_err(|e| BlobError::Io(e.to_string()))?;
        // Written whole beside it and moved into place: a reader never meets half a body under a hash.
        let tmp = parent.join(format!(".{sha}.{}", std::process::id()));
        std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &path)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            BlobError::Io(e.to_string())
        })
    }

    /// The body kept under `sha`: `None` when none is, refused when the file's bytes no longer have that hash.
    pub fn get(&self, sha: &str) -> Result<Option<Vec<u8>>, BlobError> {
        let path = self.path(sha)?;
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(BlobError::Io(e.to_string())),
        };
        let actual = sha256_hex(&bytes);
        if actual != sha {
            return Err(BlobError::Changed { claimed: sha.to_string(), actual });
        }
        Ok(Some(bytes))
    }

    pub fn has(&self, sha: &str) -> bool {
        self.path(sha).is_ok_and(|p| p.exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of its own for one test, gone when it drops.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("blobs-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn files_under(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .map(|d| d.flatten().map(|e| if e.path().is_dir() { files_under(&e.path()) } else { 1 }).sum())
            .unwrap_or(0)
    }

    #[test]
    fn a_script_is_stored_once_under_its_hash() {
        let dir = Scratch::new("once");
        let blobs = Blobs::at(dir.path());
        let script = b"function sign(t) { return t.length; }";
        let sha = blobs.put(script).unwrap();
        assert_eq!(sha, sha256_hex(script));
        assert_eq!(blobs.put(script).unwrap(), sha, "the same body has the same name");
        blobs.put_as(&sha, script).unwrap();
        assert_eq!(files_under(dir.path()), 1, "kept once, however often it is put");
        assert_eq!(blobs.get(&sha).unwrap().as_deref(), Some(&script[..]));
        assert!(blobs.has(&sha));
        // A wasm module is bytes like any other body.
        let module = [0x00u8, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let wasm = blobs.put(&module).unwrap();
        assert_eq!(blobs.get(&wasm).unwrap().as_deref(), Some(&module[..]));
        assert_eq!(files_under(dir.path()), 2);
        assert_eq!(blobs.get(&sha256_hex(b"never kept")).unwrap(), None);
    }

    #[test]
    fn a_blob_whose_bytes_changed_is_refused() {
        let dir = Scratch::new("changed");
        let blobs = Blobs::at(dir.path());
        let script = b"function sign(t) { return t.length; }";
        let sha = sha256_hex(script);
        // Bytes put under a hash they don't have.
        let changed = b"function sign(t) { return 0; }";
        assert!(matches!(blobs.put_as(&sha, changed), Err(BlobError::Changed { .. })));
        assert!(!blobs.has(&sha), "nothing is kept under a hash its bytes don't have");
        // A kept body whose file was changed afterwards.
        blobs.put(script).unwrap();
        std::fs::write(dir.path().join(&sha[..2]).join(&sha), changed).unwrap();
        assert_eq!(blobs.get(&sha), Err(BlobError::Changed { claimed: sha.clone(), actual: sha256_hex(changed) }));
        assert!(matches!(blobs.put_as(&sha, script), Err(BlobError::Changed { .. })), "a changed file is not taken as kept");
        // A name that is no hash names no file.
        assert!(matches!(blobs.get("../../etc/passwd"), Err(BlobError::NotAHash(_))));
    }
}
