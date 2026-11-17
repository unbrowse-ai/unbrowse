//! Files only their owner can open, and the secret a daemon's door takes.
//!
//! A Unix socket in a folder of the owner's is the owner's: nobody else can reach it. A loopback port (the daemon's door
//! on Windows) is anyone's on the machine, so a daemon there takes a command only with the secret it wrote, owner-only,
//! beside its port file.

#[cfg(any(windows, test))]
use std::fs::{File, OpenOptions};
#[cfg(any(windows, test))]
use std::io::{self, Write};
use std::path::Path;

use serde_json::Value;

/// The field a command carries its daemon's door key in.
pub const DOOR_KEY_FIELD: &str = "doorKey";

// Only a Windows door (a loopback port) needs a key file; a Unix socket is the owner's by its mode.
#[cfg(any(windows, test))]
/// Creates `path` afresh for its owner alone: 0600 on Unix, a protected DACL naming only the current user on Windows.
/// An earlier file is removed first, so one another account made is never reused with its permissions.
pub fn create(path: &Path) -> io::Result<File> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(windows)]
    if let Err(err) = windows_acl::restrict_to_owner(path) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(err);
    }
    Ok(file)
}

#[cfg(any(windows, test))]
/// Writes `contents` to `path` for its owner alone (see [`create`]).
pub fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    create(path)?.write_all(contents)
}

/// Makes the folder `dir` its owner's alone, when this process owns it: 0700 on Unix. Elsewhere the folder keeps the
/// ACL it inherits from the owner's profile.
pub fn narrow_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let ours = std::fs::metadata(dir).is_ok_and(|m| m.uid() == unsafe { libc::geteuid() });
        if ours {
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(any(windows, test))]
/// A fresh door key: 256 bits from the system's generator.
pub fn new_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("the OS random source is available");
    hex::encode(bytes)
}

#[cfg(windows)]
/// Reads a door key a daemon wrote, if it is one.
pub fn read_key(path: &Path) -> Option<String> {
    let key = std::fs::read_to_string(path).ok()?;
    let key = key.trim();
    (key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())).then(|| key.to_string())
}

fn constant_time_eq(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected.bytes().zip(provided.bytes()).fold(0u8, |d, (l, r)| d | (l ^ r)) == 0
}

/// Whether a command may run at a door that takes `key`: a door with no key (a Unix socket in the owner's folder)
/// takes any; one with a key takes only a command carrying it, compared in constant time. The key is taken off the
/// command either way, so it never reaches a handler or a log.
pub fn admit(cmd: &mut Value, key: Option<&str>) -> bool {
    let given = cmd.as_object_mut().and_then(|m| m.remove(DOOR_KEY_FIELD));
    match key {
        None => true,
        Some(key) => given.as_ref().and_then(Value::as_str).is_some_and(|given| constant_time_eq(key, given)),
    }
}

#[cfg(windows)]
mod windows_acl {
    use std::ffi::OsStr;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, GetLengthSid, GetTokenInformation, InitializeAcl, TokenUser, ACCESS_ALLOWED_ACE, ACL,
        ACL_REVISION, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn check(ok: i32) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Replaces the file's DACL with one entry, full access for the current user, and stops it inheriting any other.
    pub(super) fn restrict_to_owner(path: &Path) -> io::Result<()> {
        // SAFETY: every buffer below is sized by the API that fills it and outlives the calls that read it.
        unsafe {
            let mut token: HANDLE = 0;
            check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token))?;
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
            let mut user = vec![0u64; (len as usize).div_ceil(8)];
            let got = GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), len, &mut len);
            CloseHandle(token);
            check(got)?;
            let sid = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;
            let acl_len = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() + GetLengthSid(sid) as usize;
            let mut acl = vec![0u32; acl_len.div_ceil(4)];
            let acl_ptr = acl.as_mut_ptr() as *mut ACL;
            check(InitializeAcl(acl_ptr, (acl.len() * 4) as u32, ACL_REVISION))?;
            check(AddAccessAllowedAce(acl_ptr, ACL_REVISION, FILE_ALL_ACCESS, sid))?;
            let mut wide: Vec<u16> = OsStr::new(path).encode_wide().collect();
            wide.push(0);
            let status = SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl_ptr,
                null_mut(),
            );
            if status != ERROR_SUCCESS {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_daemon_door_refuses_a_command_without_its_secret() {
        let key = new_key();
        assert_eq!(key.len(), 64);
        assert_ne!(key, new_key());
        let mut none = json!({ "id": "1", "action": "eval", "script": "document.cookie" });
        assert!(!admit(&mut none, Some(&key)), "no key: refused");
        let mut wrong = json!({ "id": "1", "action": "eval", DOOR_KEY_FIELD: new_key() });
        assert!(!admit(&mut wrong, Some(&key)), "another key: refused");
        let mut short = json!({ "id": "1", "action": "eval", DOOR_KEY_FIELD: &key[..63] });
        assert!(!admit(&mut short, Some(&key)));
        let mut not_text = json!({ "id": "1", "action": "eval", DOOR_KEY_FIELD: 7 });
        assert!(!admit(&mut not_text, Some(&key)));
        let mut right = json!({ "id": "1", "action": "eval", DOOR_KEY_FIELD: key.clone() });
        assert!(admit(&mut right, Some(&key)));
        assert!(right.get(DOOR_KEY_FIELD).is_none(), "the key never reaches the handler");
        // A door with no key (a Unix socket in the owner's folder) is closed by its folder instead.
        let mut plain = json!({ "id": "1", "action": "url" });
        assert!(admit(&mut plain, None));
    }

    #[cfg(unix)]
    #[test]
    fn a_secret_file_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.key");
        // A file someone else left there, readable by all, is replaced, not reused.
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write(&path, b"secret").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "secret");
        let open = dir.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        narrow_dir(&open);
        assert_eq!(std::fs::metadata(&open).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
