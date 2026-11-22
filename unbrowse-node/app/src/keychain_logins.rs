//! Logins the owner saved in macOS's login keychain (Safari's and other apps' web passwords kept there), used where
//! the vault holds none and kept in the vault from then on (`vault.from-login-keychain`).
//!
//! The list is read without any password: a keychain item's server and account are open to this user's programs, so
//! listing them asks nothing. A password is read only when a login is about to be used (typed into its own site's page,
//! or sent by a route of this node's own to its own site), and macOS asks the owner once for that item ("Always Allow"
//! keeps it from asking again). The vault seals it under the node's key as it is used (`vault::secret_for`), so each
//! item is read from the keychain once: every later use is the vault's, and asks nothing. An item the owner refused is
//! not asked for again while the node runs, so a declined prompt never comes back on each call.
//!
//! Only web logins over https: the vault types a login only into an https page of its own site, so a login kept for
//! plain http, or for another protocol (a VNC server, a mail account), is no login the vault could use. Passwords kept
//! in the Passwords app (iCloud Keychain) are out of reach here: macOS keeps them from every program but Apple's own,
//! so those come in through the app's export (`unbrowse-node vault import`).

use zeroize::Zeroizing;

/// A web login the login keychain lists: the server it was saved for and its account.
#[derive(Clone, Debug, PartialEq)]
pub struct Saved {
    pub server: String,
    pub account: String,
}

/// Every https login the login keychain lists, with no password read.
pub fn listed() -> Vec<Saved> {
    let mut all = read_listed();
    all.retain(|s| crate::vault::Ref::parse(&format!("vault:{}:{}", s.server, s.account)).is_some_and(|r| r.site == s.server));
    all.sort_by(|a, b| (&a.server, &a.account).cmp(&(&b.server, &b.account)));
    all.dedup();
    all
}

/// The listed login for `account` on `site`: saved for that very server, or for another name of the same site
/// (`accounts.google.com` for `google.com`).
pub fn find(site: &str, account: &str) -> Option<Saved> {
    let wanted = unbrowse_learn::identity::site_of(site);
    let all: Vec<Saved> = listed().into_iter().filter(|s| s.account == account).collect();
    all.iter().find(|s| s.server == site).cloned().or_else(|| all.into_iter().find(|s| !wanted.is_empty() && unbrowse_learn::identity::site_of(&s.server) == wanted))
}

/// The logins refused this run, as (server, account): not asked for again until the node restarts.
static REFUSED: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// The password of `saved`, read from the login keychain: macOS asks the owner for it unless they chose Always Allow
/// for the node before. `None` when the keychain no longer holds it; `Err` when it couldn't be read, the owner's no
/// included, which holds for the rest of the run.
pub fn password(saved: &Saved) -> Result<Option<Zeroizing<String>>, String> {
    use crate::sync::Locked;
    let key = (saved.server.clone(), saved.account.clone());
    if REFUSED.locked().contains(&key) {
        return Err(format!("the owner didn't let the node read {} on {} from the login keychain; it isn't asked for again until the node restarts", saved.account, saved.server));
    }
    match read_password(saved) {
        Read::Found(p) => Ok(Some(p)),
        Read::Gone => Ok(None),
        Read::Refused(why) => {
            REFUSED.locked().push(key);
            Err(format!("the login keychain didn't give {} on {} ({why}); it isn't asked for again until the node restarts", saved.account, saved.server))
        }
        Read::Failed(why) => Err(format!("the login keychain couldn't be read ({why})")),
    }
}

/// What reading one password came to.
enum Read {
    Found(Zeroizing<String>),
    Gone,
    /// The owner said no, or cancelled.
    Refused(String),
    /// Anything else: a locked keychain with no screen to ask on, say. (Tests' keychain never fails so.)
    #[cfg_attr(test, allow(dead_code))]
    Failed(String),
}

#[cfg(all(target_os = "macos", not(test)))]
fn read_listed() -> Vec<Saved> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    let Ok(found) = ItemSearchOptions::new().class(ItemClass::internet_password()).load_attributes(true).limit(Limit::All).search() else {
        return Vec::new();
    };
    found
        .iter()
        .filter_map(|r| r.simplify_dict())
        .filter(|d| d.get("ptcl").is_some_and(|p| p == "htps"))
        .filter_map(|d| Some(Saved { server: d.get("srvr")?.trim().to_ascii_lowercase(), account: d.get("acct")?.trim().to_string() }))
        .filter(|s| !s.server.is_empty() && !s.account.is_empty())
        .collect()
}

#[cfg(all(target_os = "macos", not(test)))]
fn read_password(saved: &Saved) -> Read {
    use security_framework::os::macos::passwords::{find_internet_password, SecAuthenticationType, SecProtocolType};
    // errSecItemNotFound; errSecAuthFailed (the owner's Deny); errSecUserCanceled.
    const NOT_FOUND: i32 = -25300;
    const DENIED: i32 = -25293;
    const CANCELLED: i32 = -128;
    match find_internet_password(None, &saved.server, None, &saved.account, "", None, SecProtocolType::HTTPS, SecAuthenticationType::Any) {
        Ok((password, _item)) => match String::from_utf8(password.as_ref().to_vec()) {
            Ok(p) => Read::Found(Zeroizing::new(p)),
            Err(_) => Read::Failed("the password isn't text".into()),
        },
        Err(e) if e.code() == NOT_FOUND => Read::Gone,
        Err(e) if e.code() == DENIED || e.code() == CANCELLED => Read::Refused("the owner said no".into()),
        Err(e) => Read::Failed(e.to_string()),
    }
}

#[cfg(all(not(target_os = "macos"), not(test)))]
fn read_listed() -> Vec<Saved> {
    Vec::new()
}

#[cfg(all(not(target_os = "macos"), not(test)))]
fn read_password(_saved: &Saved) -> Read {
    Read::Gone
}

// Tests never touch the owner's keychain: they list and read what they put here.
#[cfg(test)]
thread_local! {
    static IN_TEST: std::cell::RefCell<Vec<(Saved, Option<String>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// For tests: the login keychain lists these logins, each with its password (`None`: the owner says no to it).
#[cfg(test)]
pub fn keep_in_test(logins: &[(&str, &str, Option<&str>)]) {
    IN_TEST.with(|t| *t.borrow_mut() = logins.iter().map(|(s, a, p)| (Saved { server: s.to_string(), account: a.to_string() }, p.map(str::to_string))).collect());
}

#[cfg(test)]
fn read_listed() -> Vec<Saved> {
    IN_TEST.with(|t| t.borrow().iter().map(|(s, _)| s.clone()).collect())
}

#[cfg(test)]
fn read_password(saved: &Saved) -> Read {
    IN_TEST.with(|t| match t.borrow().iter().find(|(s, _)| s == saved) {
        Some((_, Some(p))) => Read::Found(Zeroizing::new(p.clone())),
        Some((_, None)) => Read::Refused("the owner said no".into()),
        None => Read::Gone,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A login is found for its own server or another name of its site, by its exact account; a listed server that
    /// isn't a site's address (an IP and port, a bare name) lists nothing the vault could name.
    #[test]
    fn a_keychain_login_is_found_for_its_site() {
        keep_in_test(&[("accounts.google.com", "me@example.com", Some("pw-1")), ("github.com", "me", Some("pw-2")), ("intranet", "me", Some("pw-3"))]);
        assert_eq!(listed().len(), 2, "{:?}", listed());
        assert_eq!(find("google.com", "me@example.com").map(|s| s.server).as_deref(), Some("accounts.google.com"));
        assert_eq!(find("accounts.google.com", "me@example.com").map(|s| s.server).as_deref(), Some("accounts.google.com"));
        assert_eq!(find("github.com", "someone-else"), None);
        assert_eq!(find("gitlab.com", "me"), None);
    }

    /// A login the owner refused isn't asked for again this run, so a declined prompt doesn't come back on each call.
    #[test]
    fn a_refused_login_is_not_asked_for_again() {
        // A server of this test's own: the refusals are the process's, and other tests run beside this one.
        keep_in_test(&[("refused-once.example", "me", None)]);
        let saved = find("refused-once.example", "me").unwrap();
        assert!(password(&saved).unwrap_err().contains("said no"));
        IN_TEST.with(|t| t.borrow_mut()[0].1 = Some("now-allowed".into()));
        assert!(password(&saved).unwrap_err().contains("isn't asked for again"), "the refusal holds for the run");
    }
}
